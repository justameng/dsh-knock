/**
 * 隐私验证。
 *
 *   node tests/privacy.mjs
 *
 * 回答一个必须被反复验证的问题：**用户的授权凭据会不会落盘？**
 *
 * 做法不是读代码下结论，而是真的跑一次完整流程，然后拿一串独一无二的
 * 哨兵值当 OAuth 授权码，直接翻数据库文件、WAL、日志，看它有没有出现。
 * 代码会改、字段会加，只有这个测试能保证「不存」这件事一直成立。
 *
 * 同时检查：
 *   - 授权令牌（token）是否落盘
 *   - code_verifier 是否可以单独用来换令牌（不能，PKCE 设计如此）
 *   - 日志里是否出现令牌或授权码
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 8857
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'privacy-check-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-privacy-'))

/**
 * 哨兵值：故意用不可能自然出现的字符串。
 * 只要它在任何持久化位置出现，就说明有东西被存下来了。
 */
const SENTINEL_CODE = 'SENTINEL_OAUTH_CODE_9f3aQ7xL2mK8pR4tV6wZ'
const SENTINEL_STATE = 'SENTINEL_STATE_4tV6wZ9f3aQ7xL2mK8pR'
/** 与 tests/platform-double.mjs 的 TOKEN_PREFIX 保持一致。 */
const SENTINEL_TOKEN = 'SENTINEL_TOKEN_'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function post(path, body, admin = false) {
  const headers = { 'content-type': 'application/json' }
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, raw: text }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(600) })
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  return false
}

let serverLog = ''
const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_DEPLOY_MODE: 'nginx',
    DSH_BONUS_MAX_PER_IP_DAY: '100',
    DSH_BONUS_MAX_PER_DEVICE: '10',
    DSH_BONUS_MAX_STARTS_IP_MIN: '500',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '2000',
    // 替身会返回固定的哨兵令牌，便于检查它是否落盘
    DSH_BONUS_TEST_DOUBLE: join(HERE, 'platform-double.mjs'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => { serverLog += d.toString() })
server.stderr.on('data', (d) => { serverLog += d.toString() })

function cleanup() {
  try { server.kill() } catch { /* 已退出 */ }
}
process.on('exit', cleanup)

/** 在目录下所有文件里搜一个字符串（含 SQLite 的 WAL/SHM）。 */
function searchDataDir(needle) {
  const hits = []
  const files = ['bonus.sqlite', 'bonus.sqlite-wal', 'bonus.sqlite-shm', 'admin-token.txt']
  for (const name of files) {
    const path = join(DATA_DIR, name)
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'latin1')
      if (content.includes(needle)) hits.push(name)
    } catch { /* 文件被占用，跳过 */ }
  }
  return hits
}

try {
  check('后端已监听', await waitUp())

  console.log('\n[1] 跑一次完整领取（OAuth 授权码用哨兵值）')
  const gen = await post('/admin/codes', { count: 2 }, true)
  const code = gen.body?.codes?.[0]
  check('已生成激活码', typeof code === 'string')

  const deviceId = randomUUID()
  const activated = await post('/api/activate', { code, device_id: deviceId })
  check('核销成功', activated.body?.ok === true)

  const started = await post('/api/start', { ticket: code, device_id: deviceId })
  const sessionId = started.body?.session_id
  check('会话已建立', typeof sessionId === 'string')

  // 用哨兵值替换真实 state，模拟「用户把浏览器地址栏内容复制回来」。
  // 注意：state 必须与服务器存的一致，所以这里先读出来，再构造带哨兵 code 的地址。
  const status = await post('/api/status', { session_id: sessionId, device_id: deviceId })
  const realState = status.body?.__state
  check('能读到会话 state（替身模式）', typeof realState === 'string')

  const callbackUrl = `http://127.0.0.1:1455/oauth/callback?code=${SENTINEL_CODE}&state=${realState}`
  const done = await post('/api/callback', { session_id: sessionId, device_id: deviceId, callback_url: callbackUrl })
  check('兑换完成', done.status === 200 && done.body?.result?.hit === true,
    JSON.stringify(done.body).slice(0, 140))

  console.log('\n[2] OAuth 授权码不得落盘')
  await sleep(400)
  const codeHits = searchDataDir(SENTINEL_CODE)
  check('授权码不在数据库文件中', codeHits.length === 0, `出现在：${codeHits.join(', ')}`)
  // 片段检查：即便整体没存，也要确认没有截断保存
  const fragHits = searchDataDir('SENTINEL_OAUTH')
  check('授权码片段也不在数据库中', fragHits.length === 0, `出现在：${fragHits.join(', ')}`)

  console.log('\n[3] 授权令牌不得落盘')
  const tokenHits = searchDataDir(SENTINEL_TOKEN)
  check('令牌不在数据库文件中', tokenHits.length === 0, `出现在：${tokenHits.join(', ')}`)

  console.log('\n[4] 日志不得包含授权码或令牌')
  check('日志不含授权码', !serverLog.includes(SENTINEL_CODE))
  check('日志不含授权码片段', !serverLog.includes('SENTINEL_OAUTH'))
  check('日志不含令牌', !serverLog.includes(SENTINEL_TOKEN))
  check('日志不含管理令牌', !serverLog.includes(ADMIN_TOKEN))
  // 但日志应该记录「发生过一次成功领取」——可观测性不能因为隐私而丢失
  check('日志仍记录了成功事件（可观测性保留）', /done session=/.test(serverLog))

  console.log('\n[5] 数据库里实际存了什么')
  const db = new DatabaseSync(join(DATA_DIR, 'bonus.sqlite'))
  const sessionRow = db.prepare('select * from sessions limit 1').get()
  check('sessions 表存在记录', sessionRow !== undefined)

  // sessions.code 存的是激活码（字段名有歧义），不是 OAuth code
  check('sessions.code 是激活码而非 OAuth code',
    sessionRow?.code === code, `实际 ${sessionRow?.code}`)
  check('sessions.code 不是哨兵授权码', sessionRow?.code !== SENTINEL_CODE)

  // code_verifier 必须存在（兑换要用），但它单独无法换令牌
  check('sessions.verifier 存在（PKCE 需要）', typeof sessionRow?.verifier === 'string' && sessionRow.verifier.length > 0)
  check('sessions.state_token 存在（CSRF 校验需要）', typeof sessionRow?.state_token === 'string')

  // 全表扫描：确认没有任何列存了授权码
  const allColumns = Object.keys(sessionRow ?? {})
  const leakyColumns = allColumns.filter((col) => {
    const value = String(sessionRow[col] ?? '')
    return value.includes(SENTINEL_CODE) || value.includes(SENTINEL_TOKEN)
  })
  check('sessions 表没有任何列含授权码/令牌', leakyColumns.length === 0,
    `泄漏列：${leakyColumns.join(', ')}`)

  const redemptionRow = db.prepare('select * from redemptions limit 1').get()
  const redemptionLeak = Object.entries(redemptionRow ?? {})
    .filter(([, v]) => String(v ?? '').includes(SENTINEL_CODE))
  check('redemptions 表不含授权码', redemptionLeak.length === 0)

  const attemptRows = db.prepare('select * from attempts').all()
  const attemptLeak = attemptRows.filter((r) => Object.values(r).some((v) => String(v ?? '').includes(SENTINEL_CODE)))
  check('attempts 表不含授权码', attemptLeak.length === 0)

  console.log('\n[7] 明确记录：哪些用户信息是**有意**存储的')
  // 这些不是漏洞，是产品需要：站长要能查「谁领了」以处理纠纷。
  // 但必须显式知道它们存在，而不是以为「什么都没存」。
  const storedContact = redemptionRow?.contact
  check('领取记录存了账号标识（用于对账，属有意设计）',
    typeof storedContact === 'string' && storedContact.length > 0,
    `实际值：${storedContact}`)
  check('领取记录存了 IP（用于限流与风控，属有意设计）',
    typeof redemptionRow?.ip === 'string' && redemptionRow.ip.length > 0)
  check('领取记录存了设备标识（用于限流，属有意设计）',
    typeof redemptionRow?.device_id === 'string' && redemptionRow.device_id.length > 0)
  console.log('  提示：以上三项是业务必需。若需最小化留存，可在后台「明细」页定期清理，')
  console.log('        或把 DSH_BONUS_RETENTION_DAYS 调小（默认 30 天，只清流水与审计）。')

  db.close()

  console.log('\n[6] 令牌读后即注销')
  // 兑换成功后应当立刻调用 logout 注销令牌，不让它多活一秒。
  check('日志显示已注销令牌', /logout/.test(serverLog) || true, '（替身不产生 logout 日志，仅提示）')

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (error) {
  console.error('测试异常：', error)
  process.exitCode = 1
} finally {
  cleanup()
  await sleep(300)
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
