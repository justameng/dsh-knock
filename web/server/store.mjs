/**
 * 存储层。基于 node:sqlite（Node 22+ 内置），零外部依赖。
 *
 * 表结构：
 *   codes     激活码。unused → active（已绑定设备）→ used（已领取）
 *   sessions  一次授权尝试。持有 code_verifier 与 state，等用户把回调 URL 交回来
 *   devices   按 device_id 累计领取次数
 *   ip_days   按 IP + 日期累计领取次数
 *   attempts  尝试流水，用于分钟/小时级限流与审计
 *
 * 所有「检查 + 扣减」都在 begin immediate 事务里。SQLite 的写锁天然串行，
 * 并发的核销或领取不会出现两个人同时拿走同一个码的情况。
 *
 * 注意：sessions 里存着 code_verifier。它本身不能单独换令牌（还需要用户的 code），
 * 且会话有效期很短。这是「服务器代收回调」这一架构无法回避的信任成本。
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉 I/O/0/1，避免手抄歧义
const CODE_SEGMENTS = 4
const CODE_SEGMENT_LEN = 4

/** 生成形如 DSH9-K3M7-P2QX-8TRA 的激活码。 */
export function generateCode() {
  const bytes = randomBytes(CODE_SEGMENTS * CODE_SEGMENT_LEN)
  const segments = []
  for (let segment = 0; segment < CODE_SEGMENTS; segment += 1) {
    let text = ''
    for (let index = 0; index < CODE_SEGMENT_LEN; index += 1) {
      text += CODE_ALPHABET[bytes[segment * CODE_SEGMENT_LEN + index] % CODE_ALPHABET.length]
    }
    segments.push(text)
  }
  return segments.join('-')
}

/** 用户可能带空格、小写、全角连字符，统一成标准形态。 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return ''
  return input.trim().toUpperCase()
    .replace(/[\s\u2010-\u2015\uFF0D_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export const maskCode = (code) => (typeof code === 'string' && code.length > 4
  ? `${code.slice(0, 4)}****${code.slice(-4)}`
  : '****')

const DAY_MS = 24 * 60 * 60 * 1000
const dayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10)

/**
 * 判定「兑换中卡死」的基准时长（8 分钟，与默认会话有效期一致）。
 * 实际阈值取其两倍——正常兑换几秒到几分钟就结束，
 * 超过 16 分钟还停在 exchanging，只可能是进程重启把内存里的兑换丢了。
 */
const SESSION_STUCK_MS = 8 * 60 * 1000

/**
 * 允许通过后台动态操作的表白名单。
 *
 * 用 Set 而不是普通对象：`{a:1}['constructor']` 会取到 Object.prototype 上的
 * 函数（虽然不等于 1、恰好挡住，但写法脆弱）。Set 只认显式加入的键，
 * 不存在原型链误命中的可能。
 */
const MUTABLE_TABLES = new Set(['redemptions', 'sessions', 'devices', 'attempts', 'audit'])

/** 各表的主键列名。 */
const TABLE_KEY = { devices: 'device_id' }

export class Store {
  #db

  /** 事务嵌套标记。声明在类顶部，确保构造函数里调用事务时已初始化。 */
  #inTransaction = false

  constructor(file) {
    this.#db = new DatabaseSync(file)
    this.#db.exec('pragma journal_mode = wal')
    this.#db.exec('pragma busy_timeout = 5000')
    this.#migrate()
    this.#applyMigrations()
  }

  /**
   * 版本化迁移。
   *
   * `create table if not exists` 只能建新表，**改不了已存在的表**——
   * 老库不会因为改了建表语句就补上新列或去掉约束。
   * 这里用 pragma user_version 记录已应用的版本，按序号依次执行。
   *
   * 加迁移的规矩：只追加，不改已发布的那几条，否则老库和新库会走出不同结构。
   */
  #applyMigrations() {
    const current = Number(this.#db.prepare('pragma user_version').get()?.user_version ?? 0)

    const migrations = [
      {
        version: 1,
        // v1：redemptions.hit 从 `not null default 0` 改为可空。
        // 三态语义（1/0/NULL）需要 NULL 可写，否则平台风控导致读余额失败时
        // 插入直接抛错，而那时码已经烧了、兑换已经成功——必然触发的路径。
        // SQLite 不支持 drop not null，只能重建表再搬数据。
        run: () => {
          const columns = this.#db.prepare('pragma table_info(redemptions)').all()
          const hitColumn = columns.find((c) => c.name === 'hit')
          // 已经可空就跳过（新库走 create table 时就是可空的）
          if (hitColumn === undefined || hitColumn.notnull === 0) return

          this.#transaction(() => {
            this.#db.exec(`
              create table redemptions_new (
                id          integer primary key autoincrement,
                code        text,
                device_id   text not null,
                ip          text not null,
                contact     text,
                bonus_cny   text,
                normal_cny  text,
                hit         integer,
                campaign    text,
                at          integer not null
              );
              insert into redemptions_new (id, code, device_id, ip, contact, bonus_cny, normal_cny, hit, campaign, at)
                select id, code, device_id, ip, contact, bonus_cny, normal_cny, hit, campaign, at from redemptions;
              drop table redemptions;
              alter table redemptions_new rename to redemptions;
              create index if not exists redemptions_at_idx on redemptions(at);
              create index if not exists redemptions_code_idx on redemptions(code);
              create index if not exists redemptions_ip_idx on redemptions(ip, at);
            `)
          })
          console.log('[store] 迁移 v1：redemptions.hit 已改为可空')
        },
      },
      {
        version: 2,
        // v2：补几个高频查询的索引。
        // 实测这些查询原本都是全表扫描 + 临时 B 树排序。
        run: () => {
          this.#db.exec(`
            create index if not exists ip_days_day_idx on ip_days(day);
            create index if not exists devices_last_seen_idx on devices(last_seen);
            create index if not exists sessions_device_phase_idx on sessions(device_id, phase, created_at);
          `)
        },
      },
    ]

    for (const migration of migrations) {
      if (migration.version <= current) continue
      try {
        migration.run()
        this.#db.exec(`pragma user_version = ${migration.version}`)
      } catch (error) {
        console.error(`[store] 迁移 v${migration.version} 失败：${error?.message ?? error}`)
        throw error
      }
    }
  }

  #migrate() {
    this.#db.exec(`
      create table if not exists codes (
        code         text primary key,
        batch        text,
        note         text,
        created_at   integer not null,
        expires_at   integer,
        state        text not null default 'unused',
        bound_device text,
        bound_ip     text,
        bound_at     integer,
        used_at      integer,
        revoked_at   integer
      );
      create index if not exists codes_state_idx on codes(state);

      create table if not exists sessions (
        id            text primary key,
        code          text not null,
        device_id     text not null,
        ip            text not null,
        verifier      text not null,
        state_token   text not null,
        authorize_id  text,
        redirect_uri  text not null,
        phase         text not null,
        created_at    integer not null,
        expires_at    integer not null,
        result        text,
        error         text
      );
      create index if not exists sessions_phase_idx on sessions(phase, expires_at);

      create table if not exists devices (
        device_id   text primary key,
        first_seen  integer not null,
        last_seen   integer not null,
        activations integer not null default 0
      );

      create table if not exists ip_days (
        ip          text not null,
        day         text not null,
        activations integer not null default 0,
        primary key (ip, day)
      );

      create table if not exists attempts (
        id        integer primary key autoincrement,
        ip        text not null,
        device_id text,
        at        integer not null,
        outcome   text not null
      );
      create index if not exists attempts_ip_at_idx on attempts(ip, at);
      create index if not exists attempts_at_idx on attempts(at);

      -- 领取记录：一次成功领取一行，管理后台的主要数据来源。
      --
      -- hit 必须可空，三态语义：
      --   1    = 查到赠金
      --   0    = 确认没有赠金
      --   NULL = 钱包未读到，无法判断
      -- 曾经声明为 not null default 0，导致「平台风控挑战导致读余额失败」时
      -- 插入直接抛错——而那时兑换已经成功、激活码已经烧掉，用户既拿不到
      -- 记录也看到「兑换失败」，三重损失。这是必然触发的路径，不是边缘情况。
      create table if not exists redemptions (
        id          integer primary key autoincrement,
        code        text,
        device_id   text not null,
        ip          text not null,
        contact     text,
        bonus_cny   text,
        normal_cny  text,
        hit         integer,
        campaign    text,
        at          integer not null
      );
      create index if not exists redemptions_at_idx on redemptions(at);
      create index if not exists redemptions_code_idx on redemptions(code);
      create index if not exists redemptions_ip_idx on redemptions(ip, at);

      -- 审计日志：管理操作与关键业务事件。
      create table if not exists audit (
        id      integer primary key autoincrement,
        at      integer not null,
        actor   text not null,
        action  text not null,
        target  text,
        detail  text,
        ip      text
      );
      create index if not exists audit_at_idx on audit(at);

      -- 站点文案，管理后台可改。key-value 存储，避免频繁改表。
      create table if not exists settings (
        key   text primary key,
        value text not null
      );
    `)
  }

  /**
   * 事务包装。
   *
   * SQLite 不支持嵌套 BEGIN —— 在事务里再开事务会直接报错。
   * 这里用深度标记做保护：已在事务中时直接执行，不再开新事务
   * （复用外层事务，语义上更接近「加入当前事务」）。
   *
   * 当前所有调用点都各自独立、没有嵌套，但这类 bug 一旦出现很难定位，
   * 加一层保护比事后排查划算。
   */
  #transaction(work) {
    if (this.#inTransaction) return work()

    this.#db.exec('begin immediate')
    this.#inTransaction = true
    try {
      const result = work()
      this.#db.exec('commit')
      return result
    } catch (error) {
      try { this.#db.exec('rollback') } catch { /* 已经回滚 */ }
      throw error
    } finally {
      this.#inTransaction = false
    }
  }

  /* ── 管理侧 ── */

  generate({ count = 1, batch = null, note = null, codeTtlMs = 0 } = {}) {
    const now = Date.now()
    const expiresAt = codeTtlMs > 0 ? now + codeTtlMs : null
    return this.#transaction(() => {
      const insert = this.#db.prepare(`
        insert into codes (code, batch, note, created_at, expires_at, state)
        values (?, ?, ?, ?, ?, 'unused')
      `)
      const created = []
      for (let index = 0; index < count; index += 1) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const code = generateCode()
          try { insert.run(code, batch, note, now, expiresAt); created.push(code); break } catch (error) {
            if (attempt === 4) throw error
          }
        }
      }
      return created
    })
  }

  revoke(code) {
    const result = this.#db.prepare(`
      update codes set state = 'revoked', revoked_at = ?
      where code = ? and state in ('unused', 'active')
    `).run(Date.now(), normalizeCode(code))
    return result.changes > 0
  }

  list({ state = null, batch = null, limit = 100, offset = 0 } = {}) {
    const clauses = []
    const params = []
    if (state !== null) { clauses.push('state = ?'); params.push(state) }
    if (batch !== null) { clauses.push('batch = ?'); params.push(batch) }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
    return this.#db.prepare(`
      select code, batch, note, created_at, expires_at, state, bound_ip, bound_at, used_at
      from codes ${where} order by created_at desc limit ? offset ?
    `).all(...params, limit, offset)
  }

  stats() {
    const byState = this.#db.prepare('select state, count(*) as n from codes group by state').all()
    const counts = { unused: 0, active: 0, used: 0, revoked: 0 }
    for (const row of byState) counts[row.state] = Number(row.n)
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    const today = dayKey(Date.now())
    const activationsToday = Number(this.#db.prepare(
      'select coalesce(sum(activations), 0) as n from ip_days where day = ?').get(today).n)
    return { total, ...counts, activations_today: activationsToday }
  }

  /* ── 限流流水 ── */

  recordAttempt(ip, deviceId, outcome) {
    this.#db.prepare('insert into attempts (ip, device_id, at, outcome) values (?, ?, ?, ?)')
      .run(ip, deviceId ?? null, Date.now(), outcome)
  }

  countAttempts(ip, windowMs) {
    return Number(this.#db.prepare('select count(*) as n from attempts where ip = ? and at >= ?')
      .get(ip, Date.now() - windowMs).n)
  }

  /* ── 激活码核销 ── */

  /**
   * 核销激活码：绑定到设备并签发凭据。
   * 同一个码 + 同一台设备重复核销是幂等的（返回同一张凭据），
   * 这样用户刷新页面不会把自己的码烧掉。
   */
  activate({ code, deviceId, ip, limits }) {
    const normalized = normalizeCode(code)
    return this.#transaction(() => {
      const now = Date.now()
      const row = this.#db.prepare('select * from codes where code = ?').get(normalized)
      if (row === undefined) return { ok: false, reason: 'not_found' }
      if (row.state === 'revoked') return { ok: false, reason: 'revoked' }
      if (row.state === 'used') return { ok: false, reason: 'already_used' }
      if (row.expires_at !== null && now > row.expires_at) return { ok: false, reason: 'expired' }
      if (row.state === 'active') {
        if (row.bound_device !== deviceId) return { ok: false, reason: 'bound_elsewhere' }
        return { ok: true, reason: 'reused', ticket: row.code }
      }

      const device = this.#db.prepare('select * from devices where device_id = ?').get(deviceId)
      if ((device?.activations ?? 0) >= limits.maxPerDevice) return { ok: false, reason: 'device_limit' }

      const day = dayKey(now)
      const ipDay = this.#db.prepare('select * from ip_days where ip = ? and day = ?').get(ip, day)
      if ((ipDay?.activations ?? 0) >= limits.maxPerIpPerDay) return { ok: false, reason: 'ip_limit' }

      this.#db.prepare(`
        update codes set state = 'active', bound_device = ?, bound_ip = ?, bound_at = ?
        where code = ? and state = 'unused'
      `).run(deviceId, ip, now, normalized)

      this.#db.prepare(`
        insert into devices (device_id, first_seen, last_seen, activations) values (?, ?, ?, 1)
        on conflict(device_id) do update set last_seen = ?, activations = activations + 1
      `).run(deviceId, now, now, now)

      this.#db.prepare(`
        insert into ip_days (ip, day, activations) values (?, ?, 1)
        on conflict(ip, day) do update set activations = activations + 1
      `).run(ip, day)

      return { ok: true, reason: 'activated', ticket: normalized }
    })
  }

  /**
   * 凭据是否可用：必须是这个码、绑定在这台设备上、处于 active、且未过期。
   *
   * 过期校验必须和 `activate` 保持一致——只在核销时查过期是不够的：
   * 用户核销后拖到码过期再来取链接，仍会被放行，codeTtlMs 形同虚设。
   */
  verifyTicket({ ticket, deviceId }) {
    const row = this.#db.prepare('select * from codes where code = ?').get(normalizeCode(ticket ?? ''))
    if (row === undefined) return { ok: false, reason: 'not_found' }
    if (row.state === 'revoked') return { ok: false, reason: 'revoked' }
    if (row.state === 'used') return { ok: false, reason: 'already_used' }
    if (row.state !== 'active') return { ok: false, reason: 'not_active' }
    if (row.expires_at !== null && Date.now() > Number(row.expires_at)) {
      return { ok: false, reason: 'expired' }
    }
    if (row.bound_device !== deviceId) return { ok: false, reason: 'device_mismatch' }
    return { ok: true, reason: 'valid', code: row.code }
  }

  /**
   * 把激活码置为已使用。
   *
   * 带 `state = 'active'` 守卫，因此天然幂等：同一个码第二次调用不会再改动。
   * 返回是否真的发生了状态迁移——调用方据此判断「这次是不是我消费的」，
   * 避免并发下同一个码被兑换两次却都算成功。
   *
   * @returns {boolean} 本次调用是否完成了状态迁移。
   */
  markUsed(code) {
    const result = this.#db.prepare(
      "update codes set state = 'used', used_at = ? where code = ? and state = 'active'",
    ).run(Date.now(), normalizeCode(code))
    return Number(result.changes) > 0
  }

  /**
   * 释放一个尚未使用的绑定，让码回到 unused。
   *
   * 必须**同时回滚核销时累加的额度计数**（devices / ip_days）。
   * 否则用户「核销 → 取消 → 重新核销」几轮就把自己的设备额度耗尽，
   * 一次都没领到却被判「这台设备已经领取过 N 次」——永久锁死。
   *
   * 只回滚「未使用」的绑定：已 markUsed 的码说明确实领取成功了，不能退额度。
   */
  release({ ticket, deviceId }) {
    const normalized = normalizeCode(ticket ?? '')
    return this.#transaction(() => {
      const row = this.#db.prepare('select * from codes where code = ?').get(normalized)
      if (row === undefined || row.state !== 'active' || row.bound_device !== deviceId) {
        return { ok: false }
      }

      const changed = this.#db.prepare(`
        update codes set state = 'unused', bound_device = null, bound_ip = null, bound_at = null
        where code = ? and state = 'active'
      `).run(normalized)
      if (Number(changed.changes) === 0) return { ok: false }

      // 回滚设备计数，避免用户被自己的取消耗尽额度
      this.#db.prepare(`
        update devices set activations = max(activations - 1, 0) where device_id = ?
      `).run(deviceId)

      // 回滚 IP 当日计数（仅当记录还在）
      if (typeof row.bound_ip === 'string' && row.bound_at !== null) {
        const day = dayKey(Number(row.bound_at))
        this.#db.prepare(`
          update ip_days set activations = max(activations - 1, 0) where ip = ? and day = ?
        `).run(row.bound_ip, day)
      }

      return { ok: true }
    })
  }

  /* ── 授权会话 ── */

  createSession({ code, deviceId, ip, verifier, stateToken, authorizeId, redirectUri, ttlMs }) {
    const now = Date.now()
    const id = randomUUID()
    this.#db.prepare(`
      insert into sessions (id, code, device_id, ip, verifier, state_token, authorize_id, redirect_uri, phase, created_at, expires_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `).run(id, normalizeCode(code), deviceId, ip, verifier, stateToken, authorizeId ?? null, redirectUri, now, now + ttlMs)
    return { id, expires_at: now + ttlMs }
  }

  getSession(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    return this.#db.prepare('select * from sessions where id = ?').get(id) ?? null
  }

  /**
   * 取这台设备最近一个仍在进行中的会话，用于用户刷新页面后续接。
   *
   * `exchanging` 也必须算「进行中」：兑换要调用平台，耗时数百毫秒到数秒。
   * 若只查 `waiting`，用户在兑换期间点「重新获取链接」就会新建第二个会话，
   * 两个会话并行兑换 → 同一设备/同一码产生两条领取记录，绕过 maxPerDevice。
   */
  latestWaitingSession(deviceId) {
    return this.#db.prepare(`
      select * from sessions
      where device_id = ? and phase in ('waiting', 'exchanging') and expires_at > ?
      order by created_at desc limit 1
    `).get(deviceId, Date.now()) ?? null
  }

  /**
   * 标记会话进入兑换中。这只是给状态查询看的提示，**不用于抢锁**——
   * 并发去重由 index.mjs 的 in-flight 表完成，那里保证「同会话共享一次兑换」。
   */
  markExchanging(id) {
    this.#db.prepare("update sessions set phase = 'exchanging' where id = ? and phase = 'waiting'").run(id)
  }

  /**
   * 写入会话终态。
   *
   * 带守卫：**已完成（done）的会话不允许再被改写**。
   * 否则用户领成功后点一下「取消」，兑换结果就被 cancelled 覆盖，
   * 回来刷新看到的是失败态，与「已完成即幂等返回」的设计直接冲突。
   *
   * @returns {boolean} 是否写入成功（false 表示会话已是 done，未改写）。
   */
  finishSession(id, { phase, result = null, error = null }) {
    const updated = this.#db.prepare(`
      update sessions set phase = ?, result = ?, error = ?
      where id = ? and phase != 'done'
    `).run(phase, result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), id)
    return Number(updated.changes) > 0
  }

  /** 读取会话已完成的结果，供并发请求复用。 */
  sessionResult(id) {
    const row = this.#db.prepare('select phase, result, error from sessions where id = ?').get(id)
    if (row === undefined) return null
    return {
      phase: row.phase,
      result: row.result === null ? null : JSON.parse(row.result),
      error: row.error === null ? null : JSON.parse(row.error),
    }
  }

  /**
   * 把卡住的会话标为终态，并返回需要撤销平台授权的那些。
   *
   * 两类都要处理：
   *   waiting    —— 用户始终没把回调地址交回来，等到 TTL 过期。
   *   exchanging —— 兑换进行中但进程崩了 / 被 kill。
   *
   * 第二类曾经被漏掉，后果很严重：会话既不能 cancel（phase 不是 waiting）、
   * 也不会 expire、更不会被 prune（不在终态列表里），永久卡在库里；
   * 而 latestWaitingSession 把 exchanging 算作「进行中」，用户刷新页面
   * 会被塞回这个僵尸会话，点提交永远失败。
   *
   * 判定依据是 created_at 而不是 expires_at：exchanging 的兑换可能确实
   * 还在跑（正常耗时几秒到几分钟），给足宽限时间（TTL 的两倍）再判死。
   */
  expireStaleSessions() {
    const now = Date.now()
    const stale = this.#db.prepare(`
      select id, authorize_id, verifier from sessions
      where phase = 'waiting' and expires_at <= ?
    `).all(now)

    if (stale.length > 0) {
      this.#db.prepare("update sessions set phase = 'expired', error = ? where phase = 'waiting' and expires_at <= ?")
        .run(JSON.stringify({ kind: 'timeout', detail: '等待回调超时' }), now)
    }

    // 兑换中卡死的会话：超过两倍 TTL 仍未结束，只可能是进程重启导致。
    // 此时内存里的 inFlight 已经没了，没有任何机制能推进它。
    // 先查出来再改——这样能拿到它们的 authorize_id 去撤销平台授权，
    // 而不是靠事后用 error 字段做字符串匹配（那样一旦改文案就失效）。
    const stuckCutoff = now - 2 * SESSION_STUCK_MS
    const stuck = this.#db.prepare(`
      select id, authorize_id, verifier from sessions
      where phase = 'exchanging' and created_at <= ?
    `).all(stuckCutoff)

    if (stuck.length > 0) {
      this.#db.prepare("update sessions set phase = 'failed', error = ? where phase = 'exchanging' and created_at <= ?")
        .run(JSON.stringify({ kind: 'stuck', detail: '兑换未完成（进程重启）' }), stuckCutoff)
      return [...stale, ...stuck]
    }

    return stale
  }

  /**
   * 清理超期记录。
   *
   * 三类：
   *   - 终态会话（done/failed/expired/cancelled）：超过保留期直接删。
   *     注意 exchanging 不删——那是进行中的兑换，可能是进程崩溃残留，
   *     由 expireStaleSessions 之外的逻辑处理，贸然删除会丢结果。
   *   - attempts 流水：排障用，留够时间即可。
   *   - audit 审计：同上。
   *
   * redemptions（领取记录）与 codes（激活码）**永不自动删除**：
   * 前者是业务结果，后者是已发放的凭证。
   *
   * @param {number} days 保留天数
   * @returns {{sessions: number, attempts: number, audit: number, total: number}}
   */
  pruneOldRecords(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    let sessions = 0
    let attempts = 0
    let audit = 0

    this.#transaction(() => {
      sessions = Number(this.#db.prepare(`
        delete from sessions
        where phase in ('done', 'failed', 'expired', 'cancelled') and created_at < ?
      `).run(cutoff).changes)

      attempts = Number(this.#db.prepare('delete from attempts where at < ?').run(cutoff).changes)
      audit = Number(this.#db.prepare('delete from audit where at < ?').run(cutoff).changes)
    })

    return { sessions, attempts, audit, total: sessions + attempts + audit }
  }

  /* ── 领取记录与审计 ── */

  /**
   * 记录一次成功领取。
   *
   * hit 字段三态：1 = 查到赠金，0 = 确认没有赠金，NULL = 钱包未读到（无法判断）。
   * 不能把 NULL 存成 0——那会把「未知」记成「确认没有」，污染后台统计。
   */
  recordRedemption({ code, deviceId, ip, result }) {
    const bonus = (result?.bonus_wallets ?? []).find((w) => w.currency === 'CNY')
    const normal = (result?.normal_wallets ?? []).find((w) => w.currency === 'CNY')
    const campaign = (result?.unnotified ?? []).map((item) => item?.campaign).filter(Boolean).join(',') || null
    const hit = result?.hit === true ? 1 : result?.hit === false ? 0 : null
    this.#db.prepare(`
      insert into redemptions (code, device_id, ip, contact, bonus_cny, normal_cny, hit, campaign, at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizeCode(code), deviceId, ip,
      result?.contact ?? null,
      bonus?.balance ?? null,
      normal?.balance ?? null,
      hit,
      campaign,
      Date.now(),
    )
  }

  audit({ actor, action, target = null, detail = null, ip = null }) {
    this.#db.prepare('insert into audit (at, actor, action, target, detail, ip) values (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), actor, action, target, detail === null ? null : String(detail).slice(0, 500), ip)
  }

  auditList({ limit = 100, offset = 0 } = {}) {
    return this.#db.prepare('select * from audit order by at desc limit ? offset ?').all(limit, offset)
  }

  /* ── 管理后台统计 ── */

  /** 仪表盘用的详细统计。 */
  dashboard() {
    const now = Date.now()
    const dayStart = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
    const hourAgo = now - 60 * 60 * 1000

    const byState = this.#db.prepare('select state, count(*) as n from codes group by state').all()
    const codeCounts = { unused: 0, active: 0, used: 0, revoked: 0 }
    for (const row of byState) codeCounts[row.state] = Number(row.n)
    const totalCodes = Object.values(codeCounts).reduce((sum, value) => sum + value, 0)

    const one = (sql, ...params) => Number(this.#db.prepare(sql).get(...params)?.n ?? 0)

    return {
      codes: {
        total: totalCodes,
        unused: codeCounts.unused,
        active: codeCounts.active,
        used: codeCounts.used,
        revoked: codeCounts.revoked,
        used_rate: totalCodes === 0 ? 0 : Number(((codeCounts.used / totalCodes) * 100).toFixed(1)),
      },
      redemption: {
        total: one('select count(*) as n from redemptions'),
        today: one('select count(*) as n from redemptions where at >= ?', dayStart),
        last_hour: one('select count(*) as n from redemptions where at >= ?', hourAgo),
        hit: one('select count(*) as n from redemptions where hit = 1'),
        miss: one('select count(*) as n from redemptions where hit = 0'),
      },
      traffic: {
        devices: one('select count(*) as n from devices'),
        ips_today: one('select count(distinct ip) as n from redemptions where at >= ?', dayStart),
        attempts_today: one('select count(*) as n from attempts where at >= ?', dayStart),
        sessions_waiting: one("select count(*) as n from sessions where phase = 'waiting' and expires_at > ?", now),
      },
      quota: {
        max_per_device: null,   // 由 index.mjs 填入（来自 config）
        max_per_ip_day: null,
      },
    }
  }

  /** 按天统计领取量，用于后台趋势。 */
  dailyRedemptions(days = 14) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = this.#db.prepare(`
      select substr(datetime(at / 1000, 'unixepoch'), 1, 10) as day, count(*) as n
      from redemptions where at >= ? group by day order by day desc
    `).all(since)
    return rows.map((row) => ({ day: row.day, count: Number(row.n) }))
  }

  /** 领取记录列表（后台明细）。 */
  redemptionList({ limit = 50, offset = 0, ip = null, code = null } = {}) {
    const clauses = []
    const params = []
    if (ip !== null) { clauses.push('ip = ?'); params.push(ip) }
    if (code !== null) { clauses.push('code = ?'); params.push(normalizeCode(code)) }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
    return this.#db.prepare(`
      select * from redemptions ${where} order by at desc limit ? offset ?
    `).all(...params, limit, offset)
  }

  /** 会话明细（后台排障用）。 */
  sessionList({ limit = 50, offset = 0, phase = null } = {}) {
    const where = phase === null ? '' : 'where phase = ?'
    const params = phase === null ? [] : [phase]
    return this.#db.prepare(`
      select id, code, device_id, ip, authorize_id, phase, created_at, expires_at, error
      from sessions ${where} order by created_at desc limit ? offset ?
    `).all(...params, limit, offset)
  }

  /** 设备明细。 */
  deviceList({ limit = 50, offset = 0 } = {}) {
    return this.#db.prepare(`
      select * from devices order by last_seen desc limit ? offset ?
    `).all(limit, offset)
  }

  /** 尝试流水（后台排障用，含被拒原因）。 */
  attemptList({ limit = 100, offset = 0 } = {}) {
    return this.#db.prepare(`
      select * from attempts order by at desc limit ? offset ?
    `).all(limit, offset)
  }

  /* ── IP 每日额度 ── */

  /**
   * 列出 IP 每日额度用量。
   *
   * 用户遇到「当前网络领取次数已达上限」时，站长需要能看到是哪个 IP、
   * 用了几次、什么时候用的，才能判断是正常用户被误伤还是真的滥用。
   */
  ipDayList({ limit = 200, offset = 0, day = null } = {}) {
    const where = day === null ? '' : 'where day = ?'
    const params = day === null ? [] : [day]
    return this.#db.prepare(`
      select ip, day, activations from ip_days ${where}
      order by day desc, activations desc limit ? offset ?
    `).all(...params, limit, offset)
  }

  /** 重置指定 IP 在某一天的额度。传 day 为 null 表示重置该 IP 的所有记录。 */
  resetIpQuota(ip, day = null) {
    if (day === null) {
      const result = this.#db.prepare('delete from ip_days where ip = ?').run(ip)
      return Number(result.changes)
    }
    const result = this.#db.prepare('delete from ip_days where ip = ? and day = ?').run(ip, day)
    return Number(result.changes)
  }

  /** 清空全部 IP 额度记录。 */
  resetAllIpQuota() {
    const result = this.#db.prepare('delete from ip_days').run()
    return Number(result.changes)
  }

  /** 读取某台设备的累计领取次数。 */
  deviceActivations(deviceId) {
    const row = this.#db.prepare('select activations from devices where device_id = ?').get(deviceId)
    return Number(row?.activations ?? 0)
  }

  /** 读取某个 IP 当天的领取次数。 */
  ipActivations(ip) {
    const row = this.#db.prepare('select activations from ip_days where ip = ? and day = ?')
      .get(ip, dayKey(Date.now()))
    return Number(row?.activations ?? 0)
  }

  /**
   * 记一次领取：设备计数与 IP 当日计数一起累加。
   *
   * 关闭激活码时没有核销环节，这两个计数就是唯一的额度依据。
   * 曾经只累加 devices，导致 ip_days 完全为空——IP 额度永不触发，
   * 后台「今日领取」也恒为 0。两个计数必须一起维护。
   */
  bumpDevice(deviceId, ip = null) {
    const now = Date.now()
    this.#transaction(() => {
      this.#db.prepare(`
        insert into devices (device_id, first_seen, last_seen, activations) values (?, ?, ?, 1)
        on conflict(device_id) do update set last_seen = ?, activations = activations + 1
      `).run(deviceId, now, now, now)

      if (ip !== null) {
        const day = dayKey(now)
        this.#db.prepare(`
          insert into ip_days (ip, day, activations) values (?, ?, 1)
          on conflict(ip, day) do update set activations = activations + 1
        `).run(ip, day)
      }
    })
  }

  /** 重置某台设备的领取计数（用于「让这个用户重来一次」）。 */
  resetDeviceQuota(deviceId) {
    const result = this.#db.prepare('delete from devices where device_id = ?').run(deviceId)
    return Number(result.changes)
  }

  /** 各拒绝原因的分布，用于发现异常。 */
  outcomeBreakdown(days = 7) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    return this.#db.prepare(`
      select outcome, count(*) as n from attempts where at >= ? group by outcome order by n desc
    `).all(since).map((row) => ({ outcome: row.outcome, count: Number(row.n) }))
  }

  /** 批量作废。返回实际作废数量。 */
  revokeMany(codes) {
    let count = 0
    this.#transaction(() => {
      const stmt = this.#db.prepare(`
        update codes set state = 'revoked', revoked_at = ?
        where code = ? and state in ('unused', 'active')
      `)
      for (const code of codes) {
        count += Number(stmt.run(Date.now(), normalizeCode(code)).changes)
      }
    })
    return count
  }

  /** 删除指定状态的激活码（清理用）。 */
  purgeByState(state) {
    const result = this.#db.prepare('delete from codes where state = ?').run(state)
    return Number(result.changes)
  }

  /**
   * 清空某张明细表。用于后台的「清空」操作。
   *
   * 只允许清空这些辅助记录表；codes 表不在此列——
   * 激活码是业务凭证，误删会导致已发出的码失效，只能按状态清理。
   */
  purgeTable(table) {
    if (!MUTABLE_TABLES.has(table)) throw new Error(`不允许清空表 ${table}`)
    const result = this.#db.prepare(`delete from ${table}`).run()
    return Number(result.changes)
  }

  /** 批量删除明细记录。 */
  deleteRecords(table, ids) {
    if (!MUTABLE_TABLES.has(table)) throw new Error(`不允许删除表 ${table}`)
    const key = TABLE_KEY[table] ?? 'id'
    let count = 0
    this.#transaction(() => {
      const stmt = this.#db.prepare(`delete from ${table} where ${key} = ?`)
      for (const id of ids) count += Number(stmt.run(id).changes)
    })
    return count
  }

  /* ── 设置 ── */

  setSetting(key, value) {
    this.#db.prepare(`
      insert into settings (key, value) values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, String(value))
  }

  allSettings() {
    const rows = this.#db.prepare('select key, value from settings').all()
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  }

  close() { this.#db.close() }
}

export { DAY_MS, dayKey }
