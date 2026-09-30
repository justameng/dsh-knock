/**
 * DSH 体验赠金 · 全服务器版后端（宝塔部署）
 *
 * 设计目标：访客只用浏览器（手机或电脑），不下载、不安装任何东西。
 *
 * 为什么需要「复制粘贴回调地址」这一步：
 *   平台的 auth_init 只接受 http://127.0.0.1:PORT/... 或 http://localhost:PORT/...
 *   作为 redirect_uri（实测：任何域名、内网 IP、自定义 scheme 一律 50005 拒绝）。
 *   手机浏览器无法监听回环端口，所以授权后必然跳到一个打不开的地址。
 *   好在平台不校验该地址是否可达 —— 用户把地址栏里那条完整 URL 复制回本页，
 *   服务器用事先存好的 code_verifier 完成兑换。这是 OAuth 的手动回调流程。
 *
 * 令牌处理：只在内存与数据库会话中存活数秒，读完余额立即主动 logout 注销，绝不写入日志。
 *
 * 接口：
 *   POST /api/activate    { code, device_id }        核销激活码
 *   POST /api/start       { ticket, device_id }      发起授权，返回平台授权链接
 *   POST /api/status      { session_id }             轮询状态
 *   POST /api/callback    { session_id, callback_url } 提交回调地址，兑换并读取余额
 *   POST /api/cancel      { session_id }             取消并撤销授权
 *   GET  /api/config                                 公开配置
 *   POST /admin/codes     { count, batch, note }     生成激活码（需管理令牌）
 *   GET  /admin/codes                                列出激活码（需管理令牌）
 *   GET  /admin/stats                                统计（需管理令牌）
 *   POST /admin/revoke    { code }                   作废（需管理令牌）
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { config } from './config.mjs'
import { Store, maskCode, normalizeCode } from './store.mjs'
import { parseCallbackInput } from './callback-url.mjs'
import {
  authInit, authExchange, authCancel, logout, readAccount, checkBrowserUrl, PlatformError,
  isTestDoubleActive, authorizeUrlOf, AUTHORIZE_PATH, AUTHORIZED_PATH,
} from './platform.mjs'
import { clientIp, inspectIpHeaders } from './client-ip.mjs'

const store = new Store(config.dbFile)

/**
 * 测试替身注入：设置 DSH_BONUS_TEST_DOUBLE=<模块路径> 时加载它，
 * 让平台调用走替身而不打真实接口。生产环境永远不设置这个变量。
 */
if (process.env.DSH_BONUS_TEST_DOUBLE) {
  const { pathToFileURL } = await import('node:url')
  const { __setTestDouble } = await import('./platform.mjs')
  // Windows 盘符路径不能直接给 import()，必须先转成 file:// URL。
  const mod = await import(pathToFileURL(process.env.DSH_BONUS_TEST_DOUBLE).href)
  __setTestDouble(mod.default ?? mod)
  console.log(`[test] 已注入平台替身：${process.env.DSH_BONUS_TEST_DOUBLE}`)
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const MAX_BODY_BYTES = 16 * 1024
const CALLBACK_PORT = 1455
/** 单次批量删除的上限。node:sqlite 同步执行，批量过大阻塞事件循环。 */
const MAX_DELETE_BATCH = 500
/** 明细表保留天数。超期记录由 sweeper 清理，避免数据库无界增长。 */
const RETENTION_DAYS = 30

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`)

/** 部署模式的中文说明，用于启动横幅。 */
const MODE_LABELS = {
  edgeone: 'EdgeOne 加速（优先 EO-Connecting-IP）',
  cloudflare: 'Cloudflare 加速（优先 CF-Connecting-IP）',
  nginx: 'Nginx 反代（X-Forwarded-For）',
  auto: '自动识别 CDN（两家的专有头都试）',
  direct: '直连（只用 socket 地址）',
}

/* ────────────────────────── HTTP 工具 ────────────────────────── */

function corsHeaders(origin) {
  if (origin === undefined || !config.allowedOrigins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    // 管理后台会带 authorization 头，预检必须放行，否则浏览器直接拦掉请求。
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

function send(response, status, body, origin) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // 接口不该被任何页面嵌入。配合前端的 frame-ancestors 一起防点击劫持。
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...corsHeaders(origin),
  }).end(`${JSON.stringify(body)}\n`)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function adminAuthorized(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  return constantTimeEqual(header.slice(7).trim(), config.adminToken)
}

/** 设备标识：只接受 UUID 形态，避免被塞进任意长字符串。 */
const deviceIdOf = (value) => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null)

const REASON_TEXT = {
  not_found: '激活码不存在，请检查是否输错。',
  revoked: '这个激活码已被作废。',
  already_used: '这个激活码已经用过了，一人一码。',
  expired: '激活码已过期，请重新获取。',
  bound_elsewhere: '这个激活码已经绑定到另一台设备了。',
  device_limit: `这台设备已经领取过 ${config.maxPerDevice} 次，不再重复发放。`,
  ip_limit: '当前网络领取次数已达上限，请换一个网络或明天再试。',
  device_mismatch: '凭据与当前设备不匹配。',
  not_active: '凭据状态异常，请重新核销激活码。',
  invalid_device: '设备标识格式不正确。',
  invalid_code: '激活码格式不正确。',
  rate_limited: '操作过于频繁，请稍后再试。',
  session_not_found: '这个授权会话不存在或已过期，请重新发起。',
  session_expired: '这次授权等待太久了，已经失效，请重新发起。',
  session_done: '这次授权已经完成过了。',
  callback_unparsable: '没有从这段地址里找到授权码（code）。请复制浏览器地址栏里的完整地址。',
  state_mismatch: '授权校验失败（state 不匹配）。请重新发起授权，不要混用多次授权的地址。',
  already_exchanging: '正在兑换中，请稍候。',
}

const reasonText = (reason) => REASON_TEXT[reason] ?? '请求未被接受。'

/* ────────────────────────── 限流 ────────────────────────── */

/**
 * 按 IP 限流。
 *
 * 统计该 IP 在窗口内的**全部**请求流水（核销与发起授权共用同一个配额池）——
 * 这两类都是可以被滥用的入口：核销可被用来枚举激活码，
 * 发起授权会消耗平台资源。共用一个池子比各配一套更难绕过。
 *
 * 注意：计数来自 attempts 表，所以本函数必须在 recordAttempt 之前调用，
 * 否则当次请求会被算进自己的配额里。
 */
function startLimited(ip) {
  if (store.countAttempts(ip, MINUTE) >= config.maxStartsPerIpPerMinute) {
    return { limited: true, retry_after: 60, message: `每分钟最多 ${config.maxStartsPerIpPerMinute} 次，请稍后再试。` }
  }
  if (store.countAttempts(ip, HOUR) >= config.maxStartsPerIpPerHour) {
    return { limited: true, retry_after: 3600, message: `每小时最多 ${config.maxStartsPerIpPerHour} 次，请稍后再试。` }
  }
  return { limited: false }
}

/**
 * 兑换去重表。key = session_id，value = 该会话正在进行的兑换 Promise。
 *
 * 并发语义（重要）：
 *   同一会话的 N 个并发提交 **共享同一次平台调用**，然后都拿到同一个结果。
 *   不是「只允许 1 个、其余拒绝」——那是偷懒，会让用户在网络重试时看到无意义报错。
 *   不同会话之间完全独立：各自的 verifier / state / code 在创建时就已绑定，
 *   结果按 session_id 落库，A 会话的结果不可能写进 B 会话。
 *
 * 表项在兑换结束后立即删除，避免长期占用内存；已完成的结果从数据库读。
 */
const inFlight = new Map()

/* ────────────────────────── 业务处理 ────────────────────────── */

/** 激活码功能是否启用。关闭后前台跳过该环节，服务端也拒绝相关接口。 */
const codeRequired = () => siteSettings().code_required

async function handleActivate(request, response, ip, origin) {
  if (!codeRequired()) {
    send(response, 403, { ok: false, error: 'code_disabled', message: '本站已关闭激活码校验，无需核销。' }, origin)
    return
  }

  // 核销也必须限流：否则可以无限次尝试激活码，
  // 配合状态码差异做枚举，或用错误请求填充 attempts 表。
  const limited = startLimited(ip)
  if (limited.limited) {
    store.recordAttempt(ip, null, 'rate_limited')
    send(response, 429, { ok: false, error: 'rate_limited', message: limited.message, retry_after: limited.retry_after }, origin)
    return
  }

  const body = await readJson(request)
  const deviceId = deviceIdOf(body.device_id)
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (deviceId === null) {
    send(response, 400, { ok: false, error: 'invalid_device', message: reasonText('invalid_device') }, origin)
    return
  }
  if (code.length === 0) {
    send(response, 400, { ok: false, error: 'invalid_code', message: reasonText('invalid_code') }, origin)
    return
  }
  const result = store.activate({ code, deviceId, ip, limits: config })
  store.recordAttempt(ip, deviceId, result.ok ? 'activated' : result.reason)
  log(`activate ip=${ip} code=${maskCode(normalizeCode(code))} → ${result.reason}`)
  if (!result.ok) {
    // 统一用 403 返回，不区分「不存在」与「已被占用」。
    // 曾经 not_found 返回 404、其余 403，攻击者据此可枚举出哪些激活码存在，
    // 再配合无限流接口批量试探。状态码一致后枚举不再有反馈。
    send(response, 403, {
      ok: false, error: result.reason, message: reasonText(result.reason),
    }, origin)
    return
  }
  send(response, 200, {
    ok: true,
    ticket: result.ticket,
    code_masked: maskCode(normalizeCode(code)),
    reused: result.reason === 'reused',
  }, origin)
}

/** 发起授权：服务器保存 verifier/state，返回平台授权链接。 */
async function handleStart(request, response, ip, origin) {
  const limited = startLimited(ip)
  if (limited.limited) {
    store.recordAttempt(ip, null, 'rate_limited')
    send(response, 429, { ok: false, error: 'rate_limited', message: limited.message, retry_after: limited.retry_after }, origin)
    return
  }

  const body = await readJson(request)
  const deviceId = deviceIdOf(body.device_id)
  if (deviceId === null) {
    send(response, 400, { ok: false, error: 'invalid_device', message: reasonText('invalid_device') }, origin)
    return
  }

  /**
   * 凭据校验。
   *
   * 关闭激活码时跳过校验，但**仍然要求 device_id**——
   * 它是配额与并发去重的键，去掉会让限流失效。
   * 此时 code 用一个占位值，仅用于记录，不参与业务判断。
   */
  let sessionCode = ''
  if (codeRequired()) {
    const verdict = store.verifyTicket({ ticket: body.ticket, deviceId })
    if (!verdict.ok) {
      store.recordAttempt(ip, deviceId, verdict.reason)
      send(response, 403, { ok: false, error: verdict.reason, message: reasonText(verdict.reason) }, origin)
      return
    }
    sessionCode = verdict.code
  } else {
    // 关闭卡密时，仍按「每设备 N 次」限制，避免无限领取
    const device = store.deviceActivations(deviceId)
    if (device >= config.maxPerDevice) {
      store.recordAttempt(ip, deviceId, 'device_limit')
      send(response, 403, { ok: false, error: 'device_limit', message: reasonText('device_limit') }, origin)
      return
    }
    sessionCode = `NOCODE-${deviceId.slice(0, 8)}`
  }

  // 按设备串行化：同一设备并发发起时，「查已有会话」与「新建会话」必须在同一个临界区内，
  // 否则并发请求都会看到「没有会话」而各建一个，产生多个僵尸授权。
  let outcome
  try {
    outcome = await serializeByDevice(deviceId, () => startOrReuseSession({ deviceId, ip, code: sessionCode }))
  } catch (error) {
    store.recordAttempt(ip, deviceId, `init_${error?.kind ?? 'error'}`)
    const reason = error instanceof PlatformError ? error.detail : String(error?.message ?? error)
    log(`auth_init 失败 ip=${ip}：${reason}`)
    // 平台限流要单独识别：这不是我们的问题，且用户等一会儿就能成功。
    // 判定由 platform.mjs 完成（error.rateLimited），这里不做字符串比较。
    const rateLimited = error instanceof PlatformError && error.rateLimited
    send(response, rateLimited ? 429 : 502, {
      ok: false,
      error: rateLimited ? 'platform_rate_limited' : 'platform_unavailable',
      message: rateLimited ? '平台正在限流，请等一两分钟后再试。' : '暂时无法连接平台，请稍后重试。',
      detail: reason,
    }, origin)
    return
  }

  send(response, 200, {
    ok: true,
    session_id: outcome.id,
    authorize_url: outcome.authorizeUrl,
    expires_at: outcome.expiresAt,
    callback_uri: outcome.redirectUri,
    reused: outcome.reused,
  }, origin)
}

/** 按设备串行化：同一设备的操作排队执行，不同设备互不阻塞。 */
const deviceGates = new Map()

async function serializeByDevice(deviceId, task) {
  const previous = deviceGates.get(deviceId) ?? Promise.resolve()
  const current = previous.then(task, task)
  // 无论成败都要放行后续任务，否则一次失败会把该设备永久卡住。
  const guard = current.then(() => undefined, () => undefined)
  deviceGates.set(deviceId, guard)
  guard.then(() => {
    // 队列已空则清理，避免 Map 无限增长。
    if (deviceGates.get(deviceId) === guard) deviceGates.delete(deviceId)
  })
  return current
}

/**
 * 在临界区内：已有等待中的会话就复用，否则新建一个。
 * @returns {Promise<{id: string, authorizeUrl: string, expiresAt: number, redirectUri: string, reused: boolean}>}
 */
async function startOrReuseSession({ deviceId, ip, code }) {
  const existing = store.latestWaitingSession(deviceId)
  if (existing !== null && existing.authorize_id !== null) {
    return {
      id: existing.id,
      authorizeUrl: authorizeUrlOf(existing.authorize_id),
      expiresAt: Number(existing.expires_at),
      redirectUri: existing.redirect_uri,
      reused: true,
    }
  }

  const verifier = randomBytes(32).toString('base64url')
  const stateToken = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`

  let init
  try {
    init = await authInit({ codeChallenge: challenge, state: stateToken, redirectUri })
  } catch (error) {
    // 只抛出，由调用方统一记录 attempts 并发送错误响应。
    // 这里若也记一次，同一故障会在流水里写两条，污染统计。
    throw error
  }

  const authorizeUrl = checkBrowserUrl(init?.authorize_url, AUTHORIZE_PATH, 'auth_init')

  /**
   * 会话有效期取「我们的配置」与「平台返回的 expires_in」中的较小值。
   *
   * 平台签发的授权码实际只有 600 秒有效。如果只按我们的配置给 20 分钟，
   * 页面倒计时会显示 20 分钟，但用户在 12 分钟时提交会失败——
   * 倒计时在骗人。取较小值才能让页面显示的时间与真实限制一致。
   */
  const platformExpiresMs = Number(init?.expires_in ?? 0) > 0
    ? Number(init.expires_in) * 1000
    : config.sessionTtlMs
  const ttlMs = Math.min(config.sessionTtlMs, platformExpiresMs)

  const session = store.createSession({
    code,
    deviceId,
    ip,
    verifier,
    stateToken,
    authorizeId: init?.authorize_id,
    redirectUri,
    ttlMs,
  })
  store.recordAttempt(ip, deviceId, 'started')
  log(`start ip=${ip} session=${session.id.slice(0, 8)} authorize_id=${String(init?.authorize_id).slice(0, 8)}… 有效期 ${Math.round(ttlMs / 1000)} 秒`)

  return {
    id: session.id,
    authorizeUrl: authorizeUrl.href,
    expiresAt: session.expires_at,
    redirectUri,
    reused: false,
  }
}

/** 提交回调地址 → 兑换令牌 → 读余额 → 立即注销令牌。 */
async function handleCallback(request, response, ip, origin) {
  const body = await readJson(request)
  const session = store.getSession(body.session_id)
  if (session === null) {
    send(response, 404, { ok: false, error: 'session_not_found', message: reasonText('session_not_found') }, origin)
    return
  }

  // 会话属于创建它的设备。别人拿到 session_id 也不能代你提交回调，
  // 否则可以抢兑消耗掉你的授权码。不匹配时按「不存在」处理。
  const ownerId = deviceIdOf(body.device_id)
  if (ownerId === null || session.device_id !== ownerId) {
    log(`callback 设备不匹配 session=${session.id.slice(0, 8)}`)
    send(response, 404, { ok: false, error: 'session_not_found', message: reasonText('session_not_found') }, origin)
    return
  }

  // 已完成：直接把结果还回去（幂等，重复提交不报错）。
  if (session.phase === 'done') {
    const settled = store.sessionResult(session.id)
    send(response, 200, { ok: true, result: settled?.result ?? null, replayed: true }, origin)
    return
  }
  // 已失败或已过期：明确告知，让用户重新发起。
  // 注意：这里刻意不把内部 detail（如 INVALID_CODE、平台响应正文片段）
  // 返回给前端——那是排障信息，会进日志和后台，不该展示给终端用户。
  if (session.phase === 'failed' || session.phase === 'expired' || session.phase === 'cancelled') {
    send(response, 410, {
      ok: false,
      error: session.phase === 'cancelled' ? 'session_expired' : session.phase,
      message: reasonText('session_expired'),
    }, origin)
    return
  }
  if (Number(session.expires_at) <= Date.now()) {
    store.finishSession(session.id, { phase: 'expired', error: { kind: 'timeout', detail: '等待回调超时' } })
    send(response, 410, { ok: false, error: 'session_expired', message: reasonText('session_expired') }, origin)
    return
  }

  const parsed = parseCallbackInput(body.callback_url)
  if (parsed.code === null) {
    send(response, 400, { ok: false, error: 'callback_unparsable', message: reasonText('callback_unparsable') }, origin)
    return
  }
  // state 必须与发起时一致。
  //
  // 这里刻意**不允许 state 缺失**：曾经写成「parsed.state !== null 才校验」，
  // 结果用户只要提交一个不含 state 的地址（例如只复制了 ?code=xxx），
  // 就能整段跳过 CSRF 校验。state 是防 CSRF 的核心，缺了必须拒绝。
  if (parsed.state === null || !constantTimeEqual(parsed.state, session.state_token)) {
    log(`callback state 校验失败 session=${session.id.slice(0, 8)} 缺失=${parsed.state === null}`)
    send(response, 400, { ok: false, error: 'state_mismatch', message: reasonText('state_mismatch') }, origin)
    return
  }

  // 并发去重：同一会话已有兑换在跑，就复用它，而不是拒绝这个请求。
  // 注意顺序：必须先登记再启动。异步函数体在首个 await 之前是同步执行的，
  // 若先调用再 set，并发请求会看到空表，去重就失效了。
  let exchange = inFlight.get(session.id)
  const shared = exchange !== undefined
  if (!shared) {
    store.markExchanging(session.id)
    exchange = exchangeSession(session, parsed.code, ip)
    inFlight.set(session.id, exchange)
    const cleanup = () => {
      // 只清理自己那一条，避免把后一轮的覆盖掉。
      if (inFlight.get(session.id) === exchange) inFlight.delete(session.id)
    }
    exchange.then(cleanup, cleanup)
  } else {
    log(`callback 复用进行中的兑换 session=${session.id.slice(0, 8)}`)
  }

  const outcome = await exchange
  if (outcome.ok) {
    send(response, 200, { ok: true, result: outcome.result, completion_url: outcome.completionUrl, shared }, origin)
  } else {
    send(response, outcome.status, {
      ok: false, error: outcome.error, message: outcome.message, detail: outcome.detail,
    }, origin)
  }
}

/**
 * 真正执行一次兑换。同一个会话的并发请求共享这一个 Promise 的结果。
 * @returns {Promise<{ok: true, result: object, completionUrl: string}
 *   | {ok: false, status: number, error: string, message: string, detail?: string}>}
 */
async function exchangeSession(session, code, ip) {
  let token = null
  try {
    const exchanged = await authExchange({
      code,
      codeVerifier: session.verifier,
      redirectUri: session.redirect_uri,
      deviceId: session.device_id,
      deviceModel: `${platform()}-${arch()}`,
      osVersion: `${platform()} ${release()}`,
    })
    token = exchanged?.token
    if (typeof token !== 'string' || token.length === 0) {
      throw new PlatformError('protocol', 'auth_exchange', '响应缺少 token')
    }
    const completion = checkBrowserUrl(exchanged?.authorized_url, AUTHORIZED_PATH, 'auth_exchange')

    const result = await readAccount(token)
    store.markUsed(session.code)
    store.recordRedemption({ code: session.code, deviceId: session.device_id, ip: session.ip, result })
    // 关闭激活码时没有核销这一步，设备与 IP 计数就成了唯一额度依据，必须在这里累加。
    // 开启激活码时这两个计数已由核销流程记过，不能重复加。
    if (!codeRequired()) store.bumpDevice(session.device_id, session.ip)
    store.finishSession(session.id, { phase: 'done', result })
    // hit 为 null 表示钱包没读到，不代表失败——兑换本身已成功。
    const hitText = result.hit === null ? '未知（余额未读到）' : String(result.hit)
    log(`done session=${session.id.slice(0, 8)} ip=${ip} hit=${hitText}`)
    return { ok: true, result, completionUrl: completion.href }
  } catch (error) {
    const detail = error instanceof PlatformError ? error.detail : String(error?.message ?? error)
    const kind = error?.kind ?? 'unexpected'
    store.finishSession(session.id, {
      phase: 'failed',
      error: { kind, stage: error?.stage ?? 'callback', detail },
    })
    log(`callback 失败 session=${session.id.slice(0, 8)}：${detail}`)
    // 风控挑战：不是用户的问题，也不是授权码的问题，让用户稍后重试即可。
    // 与业务失败区分状态码：503 表示「服务暂时不可用」，400 表示「这个授权码不行」。
    const wafBlocked = kind === 'waf'
    return {
      ok: false,
      status: wafBlocked ? 503 : 400,
      error: wafBlocked ? 'platform_waf' : 'exchange_failed',
      message: wafBlocked
        ? '平台风控暂时拦截了这次请求，授权码未被消耗。请稍等片刻后重新提交。'
        : '兑换失败，可能是授权码已使用或已过期。请重新发起授权。',
      detail,
    }
  } finally {
    // 无论成败，立刻注销令牌——不让一个活着的令牌多停留一秒。
    if (token !== null && config.revokeAfterRead) {
      void logout(token).catch(() => undefined)
    }
  }
}

async function handleStatus(request, response, origin) {
  const body = await readJson(request)
  const session = store.getSession(body.session_id)
  if (session === null) {
    send(response, 404, { ok: false, error: 'session_not_found', message: reasonText('session_not_found') }, origin)
    return
  }
  // 会话属于创建它的设备。device_id 不匹配时不区分「不存在」与「不属于你」，
  // 统一按不存在处理，避免暴露「这个 session_id 是有效的」。
  const deviceId = deviceIdOf(body.device_id)
  if (deviceId === null || session.device_id !== deviceId) {
    send(response, 404, { ok: false, error: 'session_not_found', message: reasonText('session_not_found') }, origin)
    return
  }
  const payload = {
    ok: true,
    session_id: session.id,
    phase: session.phase,
    expires_at: Number(session.expires_at),
  }
  if (session.result !== null) payload.result = JSON.parse(session.result)
  if (session.error !== null) payload.error = JSON.parse(session.error)

  /**
   * 测试专用字段：下发 state 与 authorize_id，供自动化脚本构造回调地址。
   *
   * 安全边界（重要）：这两个字段是 CSRF 防护的核心凭据，泄露给任意
   * 知道 session_id 的人就能绕过 state 校验。因此：
   *   1. 只在启用平台替身（即测试环境）时下发；
   *   2. 即便显式设置了 DSH_BONUS_EXPOSE_TEST_FIELDS，也要求同时启用替身，
   *      避免生产环境误设该变量造成凭据泄露。
   * 换句话说：生产环境无论怎么配，都不会走到这里。
   */
  const testDoubleOn = isTestDoubleActive()
  if (testDoubleOn) {
    payload.__state = session.state_token
    payload.__authorize_id = session.authorize_id
  }
  send(response, 200, payload, origin)
}

async function handleCancel(request, response, origin) {
  const body = await readJson(request)
  const session = store.getSession(body.session_id)
  if (session === null) {
    send(response, 200, { ok: true }, origin)
    return
  }
  // 只有会话的创建设备能取消它，否则别人可以打断你的授权流程。
  // 不匹配时静默返回成功——不暴露会话是否存在。
  const ownerId = deviceIdOf(body.device_id)
  if (ownerId === null || session.device_id !== ownerId) {
    send(response, 200, { ok: true }, origin)
    return
  }

  // 已完成的会话不能被取消改写，否则用户的成功结果会被抹掉。
  // 兑换中的会话也不打断——它已经在调平台了，此时取消只会让状态混乱。
  if (session.phase === 'done' || session.phase === 'exchanging') {
    log(`cancel 忽略：会话处于 ${session.phase} session=${session.id.slice(0, 8)}`)
    send(response, 200, { ok: true, ignored: true, phase: session.phase }, origin)
    return
  }
  if (session.phase === 'waiting' && session.authorize_id !== null) {
    try {
      await authCancel({ authorizeId: session.authorize_id, codeVerifier: session.verifier })
    } catch { /* 取消失败不影响本地状态 */ }
  }
  store.finishSession(session.id, { phase: 'cancelled', error: { kind: 'cancelled', detail: '用户取消' } })
  // 取消后把激活码放回未使用，用户还能重来。
  if (session.phase === 'waiting') store.release({ ticket: session.code, deviceId: session.device_id })
  log(`cancel session=${session.id.slice(0, 8)}`)
  send(response, 200, { ok: true }, origin)
}

/**
 * 公开配置：前台用它渲染文案与说明。
 *
 * 注意 code_required 是**功能开关**，不是文案：
 * 关掉后前台整个跳过激活码环节，服务端也拒绝需要凭据的接口。
 */
function siteSettings() {
  const stored = store.allSettings()
  return {
    site_name: stored.site_name ?? config.site.siteName,
    site_url: stored.site_url ?? config.site.siteUrl,
    code_source: stored.code_source ?? config.site.codeSource,
    bonus_validity: stored.bonus_validity ?? config.site.bonusValidity,
    tutorial: stored.tutorial === undefined ? defaultTutorial() : stored.tutorial,

    // 激活码开关。'false' 表示关闭（localStorage 存的是字符串）
    code_required: stored.code_required !== 'false',

    // 公告弹窗。开启后前台加载时弹出，可带跳转按钮。
    announce_enabled: stored.announce_enabled === 'true',
    announce_title: stored.announce_title ?? '',
    announce: stored.announce ?? '',
    announce_link_text: stored.announce_link_text ?? '',
    announce_link_url: stored.announce_link_url ?? '',
    // 公告弹窗频率：every=每次访问，daily=每天一次，once=只看一次
    announce_frequency: stored.announce_frequency ?? 'daily',
  }
}

/** 默认领取教程。管理后台可覆盖。 */
function defaultTutorial() {
  return [
    '点击「阅读协议并开始」，把协议读到底后点「同意并继续」。',
    '填入激活码。激活码来自群友专属渠道，一人一码。',
    '点「打开官方授权页」，在 DeepSeek 官方页面用你自己的账号登录，并点击「授权」。',
    '授权后浏览器会跳到一个打不开的页面，这是正常的——平台只允许 127.0.0.1 回调地址。',
    '点地址栏，全选复制整条地址（一定包含 code=），回到本页粘贴提交。',
    '页面显示赠金余额即为领取成功，赠金有效期 7 天，请尽快使用。',
  ].join('\n')
}

async function handlePublic(request, response, url, ip, origin) {
  if (request.method === 'GET' && url.pathname === '/api/config') {
    send(response, 200, {
      ok: true,
      service: 'dsh-bonus-server',
      callback_uri: `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`,
      session_ttl_minutes: Math.round(config.sessionTtlMs / MINUTE),
      max_per_device: config.maxPerDevice,
      max_per_ip_day: config.maxPerIpPerDay,
      site: siteSettings(),
    }, origin)
    return
  }

  /**
   * IP 诊断。部署后用它确认 CDN 实际把真实 IP 放在哪个头里。
   *
   * 不猜，实测：浏览器或 curl 打开这个地址，看 headers 里哪个字段
   * 等于你当前的公网 IP，那个就是该采信的头。
   *
   * 安全考量：这个接口会回显「程序实际采信了哪个 IP」，等于告诉攻击者
   * 限流能否被绕过。因此：
   *   - 默认关闭，需显式设置 DSH_BONUS_ENABLE_WHOAMI=true 才开放；
   *   - 开放时只回显解析结果，不回显全部候选头（避免暴露完整伪造面）。
   */
  if (request.method === 'GET' && url.pathname === '/api/whoami') {
    if (process.env.DSH_BONUS_ENABLE_WHOAMI !== 'true') {
      send(response, 404, { ok: false, error: 'not_found', message: '没有这个接口。' }, origin)
      return
    }
    const detail = inspectIpHeaders(request)
    send(response, 200, {
      ok: true,
      deploy_mode: config.deployMode,
      trust_proxy: config.trustProxy,
      socket: detail.socket,
      resolved: detail.resolved,
      note: 'resolved 是程序实际采用的 IP。它应当等于你的公网 IP，而不是 CDN 节点或内网地址。',
    }, origin)
    return
  }

  if (request.method !== 'POST') {
    send(response, 404, { ok: false, error: 'not_found', message: '没有这个接口。' }, origin)
    return
  }
  switch (url.pathname) {
    case '/api/activate': return handleActivate(request, response, ip, origin)
    case '/api/start': return handleStart(request, response, ip, origin)
    case '/api/callback': return handleCallback(request, response, ip, origin)
    case '/api/status': return handleStatus(request, response, origin)
    case '/api/cancel': return handleCancel(request, response, origin)
    case '/api/quota': return handleQuota(request, response, ip, origin)
    default:
      send(response, 404, { ok: false, error: 'not_found', message: '没有这个接口。' }, origin)
  }
}

/**
 * 查这台设备还能不能领。
 *
 * 前端一进页面就调用，用于**提前**告知用户额度已用尽——
 * 而不是等他填完激活码才拒绝。
 *
 * 之前没有这个接口，用户点「重新获取链接」后被退回到核销步骤，
 * 填了新码又被拒「这台设备已经领取过」，反复折腾却始终不知道
 * 问题根本不在激活码上。
 *
 * 只回布尔与剩余次数，不回显任何账号信息。
 */
async function handleQuota(request, response, ip, origin) {
  const body = await readJson(request)
  const deviceId = deviceIdOf(body.device_id)
  if (deviceId === null) {
    send(response, 400, { ok: false, error: 'invalid_device', message: reasonText('invalid_device') }, origin)
    return
  }

  const deviceUsed = store.deviceActivations(deviceId)
  const ipUsed = store.ipActivations(ip)

  // 关闭激活码时，额度只看设备与 IP；开启时还要有可用凭据。
  const deviceLeft = Math.max(0, config.maxPerDevice - deviceUsed)
  const ipLeft = Math.max(0, config.maxPerIpPerDay - ipUsed)
  const allowed = deviceLeft > 0 && ipLeft > 0

  let reason = null
  if (deviceLeft <= 0) reason = 'device_limit'
  else if (ipLeft <= 0) reason = 'ip_limit'

  send(response, 200, {
    ok: true,
    allowed,
    reason,
    message: reason === null ? '' : reasonText(reason),
    device_left: deviceLeft,
    ip_left: ipLeft,
    code_required: siteSettings().code_required,
  }, origin)
}

/* ────────────────────────── 管理后台接口 ────────────────────────── */

/** 管理后台的只读查询接口。 */
async function handleAdminGet(request, response, url, ip, origin) {
  const params = url.searchParams
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 500)
  const offset = Math.max(Number(params.get('offset')) || 0, 0)

  switch (url.pathname) {
    case '/admin/overview': {
      const dashboard = store.dashboard()
      dashboard.quota = {
        max_per_device: config.maxPerDevice,
        max_per_ip_day: config.maxPerIpPerDay,
        max_starts_per_minute: config.maxStartsPerIpPerMinute,
        max_starts_per_hour: config.maxStartsPerIpPerHour,
      }
      dashboard.deploy = {
        mode: config.deployMode,
        trust_proxy: config.trustProxy,
        data_dir: config.dataDir,
        revoke_after_read: config.revokeAfterRead,
        session_ttl_minutes: Math.round(config.sessionTtlMs / MINUTE),
      }
      send(response, 200, {
        ok: true,
        dashboard,
        daily: store.dailyRedemptions(14),
        outcomes: store.outcomeBreakdown(7),
      }, origin)
      return
    }
    case '/admin/codes': {
      send(response, 200, {
        ok: true,
        codes: store.list({
          state: params.get('state'),
          batch: params.get('batch'),
          limit,
          offset,
        }),
        stats: store.stats(),
      }, origin)
      return
    }
    case '/admin/redemptions': {
      send(response, 200, {
        ok: true,
        redemptions: store.redemptionList({
          limit,
          offset,
          ip: params.get('ip'),
          code: params.get('code'),
        }),
      }, origin)
      return
    }
    case '/admin/sessions': {
      send(response, 200, {
        ok: true,
        sessions: store.sessionList({ limit, offset, phase: params.get('phase') }),
      }, origin)
      return
    }
    case '/admin/devices': {
      send(response, 200, { ok: true, devices: store.deviceList({ limit, offset }) }, origin)
      return
    }
    case '/admin/attempts': {
      send(response, 200, { ok: true, attempts: store.attemptList({ limit, offset }) }, origin)
      return
    }
    case '/admin/ip-quota': {
      // IP 每日额度用量。用户报「网络次数已达上限」时用它查证。
      send(response, 200, {
        ok: true,
        quota: store.ipDayList({ limit, offset, day: params.get('day') }),
        limits: {
          max_per_ip_day: config.maxPerIpPerDay,
          max_per_device: config.maxPerDevice,
        },
      }, origin)
      return
    }
    case '/admin/audit': {
      send(response, 200, { ok: true, audit: store.auditList({ limit, offset }) }, origin)
      return
    }
    case '/admin/settings': {
      send(response, 200, { ok: true, site: siteSettings() }, origin)
      return
    }
    case '/admin/stats': {
      send(response, 200, { ok: true, stats: store.stats() }, origin)
      return
    }
    default:
      send(response, 404, { ok: false, error: 'not_found' }, origin)
  }
}

/** 管理后台的写操作接口。 */
async function handleAdminPost(request, response, url, ip, origin) {
  const body = await readJson(request)
  const actor = 'admin'

  switch (url.pathname) {
    case '/admin/codes': {
      const count = Math.min(Math.max(Number(body.count) || 1, 1), 500)
      const codes = store.generate({
        count,
        batch: typeof body.batch === 'string' ? body.batch.slice(0, 64) : null,
        note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
        codeTtlMs: config.codeTtlMs,
      })
      store.audit({ actor, action: 'code.generate', target: body.batch ?? null, detail: `生成 ${codes.length} 个`, ip })
      log(`admin 生成 ${codes.length} 个激活码 batch=${body.batch ?? '-'}`)
      send(response, 200, { ok: true, count: codes.length, codes }, origin)
      return
    }
    case '/admin/revoke': {
      const revoked = store.revoke(body.code)
      store.audit({ actor, action: 'code.revoke', target: maskCode(normalizeCode(body.code ?? '')), detail: revoked ? '成功' : '未命中', ip })
      send(response, revoked ? 200 : 404, {
        ok: revoked, message: revoked ? '已作废。' : '找不到这个激活码，或它已是终态。',
      }, origin)
      return
    }
    case '/admin/revoke-batch': {
      const list = Array.isArray(body.codes) ? body.codes.filter((c) => typeof c === 'string') : []
      if (list.length === 0) {
        send(response, 400, { ok: false, message: '没有提供要作废的激活码。' }, origin)
        return
      }
      const count = store.revokeMany(list)
      store.audit({ actor, action: 'code.revoke_batch', detail: `作废 ${count}/${list.length}`, ip })
      send(response, 200, { ok: true, revoked: count, total: list.length }, origin)
      return
    }
    case '/admin/purge': {
      const state = String(body.state ?? '')
      if (!['unused', 'revoked', 'used'].includes(state)) {
        send(response, 400, { ok: false, message: '只能清理 unused / revoked / used 三种状态。' }, origin)
        return
      }
      const count = store.purgeByState(state)
      store.audit({ actor, action: 'code.purge', target: state, detail: `删除 ${count} 条`, ip })
      log(`admin 清理 ${state} 激活码 ${count} 条`)
      send(response, 200, { ok: true, purged: count }, origin)
      return
    }
    case '/admin/records/delete': {
      // 删除单条或多条明细记录。table 由白名单校验，不接受任意表名。
      const table = String(body.table ?? '')
      const ids = Array.isArray(body.ids) ? body.ids : (body.id === undefined ? [] : [body.id])
      if (ids.length === 0) {
        send(response, 400, { ok: false, message: '没有指定要删除的记录。' }, origin)
        return
      }
      // 数量上限：node:sqlite 是同步执行，一次删太多会阻塞事件循环，
      // 期间所有请求（含正在等待回调的用户）都会卡住。
      if (ids.length > MAX_DELETE_BATCH) {
        send(response, 400, {
          ok: false,
          message: `一次最多删除 ${MAX_DELETE_BATCH} 条，请分批操作。`,
        }, origin)
        return
      }
      let deleted
      try {
        deleted = store.deleteRecords(table, ids)
      } catch (error) {
        send(response, 400, { ok: false, message: String(error?.message ?? error) }, origin)
        return
      }
      store.audit({ actor, action: 'record.delete', target: table, detail: `删除 ${deleted} 条`, ip })
      log(`admin 删除 ${table} 记录 ${deleted} 条`)
      send(response, 200, { ok: true, deleted }, origin)
      return
    }
    case '/admin/records/purge': {
      // 清空某张明细表。codes 不在白名单内——激活码只能按状态清理。
      const table = String(body.table ?? '')
      let purged
      try {
        purged = store.purgeTable(table)
      } catch (error) {
        send(response, 400, { ok: false, message: String(error?.message ?? error) }, origin)
        return
      }
      store.audit({ actor, action: 'record.purge', target: table, detail: `清空 ${purged} 条`, ip })
      log(`admin 清空 ${table} ${purged} 条`)
      send(response, 200, { ok: true, purged }, origin)
      return
    }
    case '/admin/reset-ip': {
      // 重置 IP 额度。三种粒度：单个 IP+日期、单个 IP 全部、全部清空。
      const targetIp = typeof body.ip === 'string' ? body.ip.trim() : ''
      const day = typeof body.day === 'string' && body.day !== '' ? body.day : null

      if (body.all === true) {
        const cleared = store.resetAllIpQuota()
        store.audit({ actor, action: 'quota.reset_ip', target: '全部', detail: `清除 ${cleared} 条`, ip })
        log(`admin 清空全部 IP 额度 ${cleared} 条`)
        send(response, 200, { ok: true, cleared }, origin)
        return
      }

      if (targetIp === '') {
        send(response, 400, { ok: false, message: '需要指定要重置的 IP，或用 all:true 清空全部。' }, origin)
        return
      }

      const cleared = store.resetIpQuota(targetIp, day)
      store.audit({
        actor, action: 'quota.reset_ip',
        target: day === null ? targetIp : `${targetIp}@${day}`,
        detail: `清除 ${cleared} 条`, ip,
      })
      log(`admin 重置 IP 额度 ${targetIp}${day === null ? '' : ` @${day}`} → ${cleared} 条`)
      send(response, 200, { ok: true, cleared }, origin)
      return
    }
    case '/admin/reset-device': {
      // 重置设备额度，让这台设备能重新领取。
      const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
      if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
        send(response, 400, { ok: false, message: '设备标识格式不正确。' }, origin)
        return
      }
      const cleared = store.resetDeviceQuota(deviceId)
      store.audit({ actor, action: 'quota.reset_device', target: `${deviceId.slice(0, 8)}…`, detail: `清除 ${cleared} 条`, ip })
      log(`admin 重置设备额度 ${deviceId.slice(0, 8)}… → ${cleared} 条`)
      send(response, 200, { ok: true, cleared }, origin)
      return
    }
    case '/admin/settings': {
      const allowed = [
        'site_name', 'site_url', 'code_source', 'bonus_validity', 'tutorial',
        'code_required',
        'announce_enabled', 'announce_title', 'announce',
        'announce_link_text', 'announce_link_url', 'announce_frequency',
      ]
      // 两轮处理：先全量校验，再统一写库。
      // 曾经把校验和写入放在同一个循环里，导致只要有一个字段非法，
      // 前面已写的字段已经落库并对前台生效，而响应却是 400「保存失败」——
      // 用户以为没保存，实际部分配置已生效（包括激活码开关）。
      const pending = []
      const rejected = []
      for (const key of allowed) {
        if (typeof body[key] !== 'string') continue
        const value = body[key].slice(0, 8000)

        // 跳转链接必须是 http(s)。否则可能被写入 javascript: 之类的伪协议，
        // 用户点公告按钮时会执行脚本。前端也校验，但服务端才是最终关口。
        if ((key === 'announce_link_url' || key === 'site_url') && value.trim() !== '') {
          if (!/^https?:\/\//i.test(value.trim())) {
            rejected.push(key)
            continue
          }
        }

        pending.push([key, value])
      }

      if (rejected.length > 0) {
        send(response, 400, {
          ok: false,
          message: `以下字段必须以 http:// 或 https:// 开头：${rejected.join('、')}`,
        }, origin)
        return
      }

      const changed = []
      for (const [key, value] of pending) {
        store.setSetting(key, value)
        changed.push(key)
      }

      store.audit({ actor, action: 'settings.update', detail: changed.join(',') || '无变更', ip })
      log(`admin 更新配置：${changed.join(',') || '无变更'}`)
      send(response, 200, { ok: true, changed, site: siteSettings() }, origin)
      return
    }
    default:
      send(response, 404, { ok: false, error: 'not_found' }, origin)
  }
}


async function handleAdmin(request, response, url, ip, origin) {
  if (!adminAuthorized(request)) {
    // 不提示「令牌错误」的细节，避免给爆破者反馈。
    store.audit({ actor: 'anonymous', action: 'admin.unauthorized', target: url.pathname, ip })
    send(response, 401, { ok: false, error: 'unauthorized', message: '需要管理令牌。' }, origin)
    return
  }
  if (request.method === 'GET') return handleAdminGet(request, response, url, ip, origin)
  if (request.method === 'POST') return handleAdminPost(request, response, url, ip, origin)
  send(response, 405, { ok: false, error: 'method_not_allowed' }, origin)
}

/* ────────────────────────── 启动 ────────────────────────── */

const server = createServer((request, response) => {
  const rawOrigin = request.headers.origin
  const origin = typeof rawOrigin === 'string' ? rawOrigin : undefined
  const ip = clientIp(request, config)

  let url
  try { url = new URL(request.url ?? '/', `http://${config.host}:${config.port}`) } catch {
    response.writeHead(400).end()
    return
  }

  if (request.method === 'OPTIONS') {
    const headers = corsHeaders(origin)
    if (Object.keys(headers).length === 0) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('origin not allowed\n')
      return
    }
    response.writeHead(204, headers).end()
    return
  }

  const route = url.pathname.startsWith('/admin/') ? handleAdmin : handlePublic
  void route(request, response, url, ip, origin).catch((error) => {
    log(`请求处理失败 ${request.method} ${url.pathname}：${error?.message ?? error}`)
    if (!response.headersSent) {
      send(response, 400, { ok: false, error: 'bad_request', message: '请求格式不正确。' }, origin)
    }
  })
})

/**
 * 定期清理。
 *
 * 三件事：
 *   1. 把过期的等待会话标记 expired，并撤销平台侧授权（防僵尸授权）；
 *   2. 删除终态会话与超期的流水/审计记录，避免数据库无界增长；
 *   3. 记一条日志便于观察。
 *
 * 之前只做第 1 件，导致 done/failed 会话与 attempts 永久堆积——
 * 而 attempts 无鉴权无限流可写，等于给攻击者留了填满磁盘的入口。
 */
const sweeper = setInterval(() => {
  const stale = store.expireStaleSessions()
  for (const session of stale) {
    if (session.authorize_id !== null) {
      void authCancel({ authorizeId: session.authorize_id, codeVerifier: session.verifier }).catch(() => undefined)
    }
  }
  if (stale.length > 0) log(`清理了 ${stale.length} 个过期授权会话`)

  try {
    const pruned = store.pruneOldRecords(RETENTION_DAYS)
    if (pruned.total > 0) {
      log(`清理超期记录（保留 ${RETENTION_DAYS} 天）：会话 ${pruned.sessions} · 流水 ${pruned.attempts} · 审计 ${pruned.audit}`)
    }
  } catch (error) {
    log(`清理超期记录失败：${error?.message ?? error}`)
  }
}, 60 * 1000)
sweeper.unref?.()

server.listen(config.port, config.host, () => {
  console.log('')
  console.log('  DSH 体验赠金 · 领取站后端')
  console.log(`  监听        : http://${config.host}:${config.port}`)
  console.log(`  数据目录    : ${config.dataDir}`)
  console.log(`  站点        : ${siteSettings().site_name} (${siteSettings().site_url})`)
  console.log(`  允许的来源  : ${config.allowedOrigins.length === 0 ? '（仅同源；跨域部署必须设置 DSH_BONUS_ALLOWED_ORIGINS）' : config.allowedOrigins.join(', ')}`)
  console.log(`  部署模式    : ${MODE_LABELS[config.deployMode] ?? config.deployMode}${config.trustProxy ? '' : '（已关闭代理头信任）'}`)
  console.log(`  回调地址    : http://127.0.0.1:${CALLBACK_PORT}/oauth/callback（用户需复制此地址回网页）`)
  console.log(`  会话有效期  : ${Math.round(config.sessionTtlMs / MINUTE)} 分钟`)
  console.log(`  配额        : 每设备 ${config.maxPerDevice} 次 · 每 IP 每天 ${config.maxPerIpPerDay} 次 · 每分钟 ${config.maxStartsPerIpPerMinute} 次`)
  console.log(`  读后注销    : ${config.revokeAfterRead ? '是（推荐）' : '否'}`)
  console.log('')
  if (config.trustProxy) {
    console.log(`  [!] 请务必让源站只接受 CDN 回源（防火墙放行 CDN IP 段，或开启回源鉴权），`)
    console.log(`      否则真实 IP 头可被伪造，限流会被绕过。`)
    console.log('')
    console.log(`  部署后访问 /api/whoami 可实测 CDN 把真实 IP 放在哪个头：`)
    console.log(`      curl https://你的域名/api/whoami`)
    console.log('')
  }
  if (config.adminTokenGenerated) {
    // 只在「本次启动才生成」时打印一次，因为这是用户唯一一次看到它的机会。
    // 之后重启不会重复打印（文件已存在，adminTokenGenerated 为 false）。
    console.log('  [!] 未设置 DSH_BONUS_ADMIN_TOKEN，已随机生成并保存到：')
    console.log(`      ${join(config.dataDir, 'admin-token.txt')}`)
    console.log('')
    console.log(`      令牌：${config.adminToken}`)
    console.log('')
    console.log('      请立刻复制保存，并尽快改用环境变量 DSH_BONUS_ADMIN_TOKEN 指定，')
    console.log('      避免明文令牌留在进程日志里。')
  } else {
    // 刻意不打印令牌：pm2 会把 stdout 持久化到日志文件，
    // 明文令牌留在日志里等于把后台钥匙放在半公开的位置。
    console.log('  管理令牌    : 已配置（来自环境变量或 data/admin-token.txt，不在此打印）')
  }
  console.log('')
  console.log('  生成 10 个激活码：')
  console.log(`    curl -X POST http://127.0.0.1:${config.port}/admin/codes \\`)
  console.log('      -H "authorization: Bearer <你的管理令牌>" \\')
  console.log('      -H "content-type: application/json" -d \'{"count":10,"batch":"first"}\'')
  console.log('')
})

const shutdown = () => {
  log('正在退出…')
  clearInterval(sweeper)
  server.closeAllConnections()
  server.close(() => { store.close(); process.exit(0) })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
