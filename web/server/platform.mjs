/**
 * 平台协议客户端（服务端侧）。
 *
 * 只有这里会出现用户的授权令牌，且生命周期被压到最短：
 *   auth_exchange 拿到 token → 读余额 → 立即 logout 注销 → 丢弃。
 */
const ORIGIN = 'https://platform.deepseek.com'
const LOCALE = 'zh_CN'
const CLIENT_VERSION = '0.2.0-rc.2'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 被 WAF 挑战时的重试策略。
 *
 * 平台前置了 WAF（响应带 HWWAFSESID cookie）。间歇性地，请求会被
 * 挑战并返回 HTTP 202 + 空正文 + text/html —— 此时请求**没有到达应用层**，
 * 授权码也**没有被消费**，因此重试是安全且有效的。
 *
 * 关键区别：
 *   - 202 空正文  → WAF 挑战，可重试
 *   - 200 JSON    → 已到应用层，绝不能再重试（可能已消费 code）
 */
const WAF_RETRY_DELAYS_MS = [800, 2000, 4000]

export class PlatformError extends Error {
  constructor(kind, stage, detail) {
    super(`${stage}: ${detail}`)
    this.kind = kind // network | protocol | auth | business | waf
    this.stage = stage
    this.detail = detail
    /**
     * 平台是否在限流。
     *
     * 由 platform.mjs 在解析 biz_msg 时判定，而不是让业务层去比对
     * `detail === 'RATE_LIMITED'` —— 那是把平台协议细节泄漏到了路由层，
     * 平台一改文案就会静默失效（限流会被当成普通故障，用户看到「暂时无法连接」）。
     */
    this.rateLimited = false
  }
}

/**
 * 测试替身。设置后所有平台调用走它，不再打真实平台——
 * 否则每跑一次测试都会消耗平台配额，反复跑还会把环境打到 RATE_LIMITED。
 * 生产环境永远不设置。
 */
let testDouble = null

/** 仅供测试使用。传 null 恢复真实调用。 */
export function __setTestDouble(double) {
  testDouble = double
}

export const isTestDoubleActive = () => testDouble !== null

/**
 * 请求头。
 *
 * 除了平台要求的 x-client-* 头，还补齐了真实浏览器一定会发送的头
 * （accept-language、sec-fetch-* 等）。实测表明平台的 WAF 会间歇性
 * 挑战请求，请求特征越接近真实浏览器，被挑战的概率越低。
 */
function baseHeaders() {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-locale': LOCALE,
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'user-agent': UA,
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    origin: ORIGIN,
    referer: `${ORIGIN}/dsh/authorize`,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 是否是 WAF 挑战响应：202 且正文为空或非 JSON。 */
function isWafChallenge(response, text, payload) {
  if (response.status !== 202) return false
  if (payload !== null) return false
  return text.trim().length === 0 || /text\/html/i.test(response.headers.get('content-type') ?? '')
}

/**
 * 信封校验 + 稳定诊断。
 *
 * 出错时保留「足以定位问题」的最小信息：状态码、Content-Type、正文片段。
 * 正文可能含敏感内容，所以只在非 JSON 或信封异常时截取前 200 字符，
 * 且只进日志与错误详情，不直接展示给终端用户。
 */
async function call(stage, path, { method = 'GET', body, token } = {}) {
  let lastDetail = '未知错误'

  for (let attempt = 0; attempt <= WAF_RETRY_DELAYS_MS.length; attempt += 1) {
    const headers = baseHeaders()
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers['x-dsh-auth-token'] = token

    let response
    try {
      response = await fetch(`${ORIGIN}${path}`, {
        method,
        headers,
        redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new PlatformError('network', stage, '请求平台超时')
      throw new PlatformError('network', stage, `网络失败(${error?.name ?? 'Error'})`)
    }

    const text = await response.text().catch(() => '')
    const contentType = response.headers.get('content-type') ?? '(无)'
    let payload = null
    try { payload = JSON.parse(text) } catch { /* 非 JSON，按状态码判定 */ }

    // WAF 挑战：请求未到应用层，重试是安全的
    if (isWafChallenge(response, text, payload)) {
      const delay = WAF_RETRY_DELAYS_MS[attempt]
      lastDetail = `被平台风控挑战（HTTP 202 空响应）`
      if (delay === undefined) break
      console.info(`[platform] ${stage} 遭遇风控挑战，${delay}ms 后重试（第 ${attempt + 2} 次）`)
      await sleep(delay)
      continue
    }

    if (response.status === 401 || payload?.code === 40003) {
      throw new PlatformError('auth', stage, `鉴权失效 HTTP ${response.status} code ${payload?.code ?? '-'}`)
    }
    if (!response.ok) {
      const hint = payload === null && text !== '' ? ` 正文=${preview(text)}` : ''
      throw new PlatformError('protocol', stage, `HTTP ${response.status} content-type=${contentType}${hint}`)
    }
    if (payload === null) {
      throw new PlatformError('protocol', stage,
        `响应不是 JSON（HTTP ${response.status} content-type=${contentType} 长度=${text.length}）正文=${preview(text)}`)
    }
    if (payload.code !== 0) {
      throw new PlatformError('protocol', stage, `信封 code=${payload.code} ${payload.msg ?? ''}`.trim())
    }
    // biz_code 非 0 时保留 biz_msg —— 它带着平台给的具体原因（例如 RATE_LIMITED），
    // 丢掉它就只能给用户一句无意义的「暂时不可用」。
    if (payload.data?.biz_code !== 0) {
      const reason = String(payload.data?.biz_msg ?? '').trim()
      const error = new PlatformError(
        'business', stage, reason === '' ? `biz_code=${payload.data?.biz_code}` : reason,
      )
      // 在这里判定限流，业务层只看 error.rateLimited
      error.rateLimited = reason === 'RATE_LIMITED'
      throw error
    }
    return payload.data.biz_data
  }

  // 重试耗尽
  throw new PlatformError('waf', stage, `${lastDetail}，多次重试仍未通过。请稍后再试。`)
}

/** 从任意异常里取一句可记录的说明。 */
const detailOf = (error) =>
  (error instanceof PlatformError ? error.detail : String(error?.message ?? error))

/** 截取正文片段用于诊断。压掉换行与多余空白，避免日志被刷屏。 */
function preview(text, max = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 只接受平台自有、路径精确匹配的浏览器地址。 */
export function checkBrowserUrl(value, expectedPath, stage) {
  let url
  try { url = new URL(value) } catch { throw new PlatformError('protocol', stage, 'URL 无法解析') }
  if (url.origin !== ORIGIN || url.pathname !== expectedPath || url.username || url.password || url.hash) {
    throw new PlatformError('protocol', stage, '平台返回的跳转地址未通过同源校验')
  }
  return url
}

/**
 * 发起一次授权。redirect_uri 必须是回环地址——这是平台的硬性要求，
 * 也正因为如此，用户授权后浏览器会打不开这个地址，需要把 URL 复制回来。
 */
export function authInit({ codeChallenge, state, redirectUri }) {
  if (testDouble?.init) return testDouble.init({ codeChallenge, state, redirectUri })
  return call('auth_init', '/auth-api/v0/dsh/auth_init', {
    method: 'POST',
    body: {
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      redirect_uri: redirectUri,
      locale: LOCALE,
      login_source: 'web',
    },
  })
}

export function authExchange(input) {
  if (testDouble?.exchange) return testDouble.exchange(input)
  return call('auth_exchange', '/auth-api/v0/dsh/auth_exchange', {
    method: 'POST',
    body: {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      device_id: input.deviceId,
      device_model: input.deviceModel,
      os_version: input.osVersion,
    },
  })
}

export function authCancel({ authorizeId, codeVerifier }) {
  if (testDouble?.cancel) return testDouble.cancel({ authorizeId, codeVerifier })
  return call('auth_cancel', '/auth-api/v0/dsh/auth_cancel', {
    method: 'POST',
    body: { authorize_id: authorizeId, code_verifier: codeVerifier },
  })
}

export async function logout(token) {
  if (testDouble?.logout) return testDouble.logout(token)
  await call('logout', '/auth-api/v0/users/logout', { method: 'POST', token })
}

const walletList = (value) => (Array.isArray(value) ? value : []).map((wallet) => ({
  balance: String(wallet?.balance ?? ''),
  currency: String(wallet?.currency ?? ''),
}))

/**
 * 读取账号资料与钱包。令牌在这里被使用，调用方随后必须注销它。
 *
 * 分级降级：**授权令牌已经到手，用户的核心目的就达成了**（赠金由平台发放）。
 * 读余额只是为了让页面展示「已到账」，属于锦上添花。
 *
 * 因此这里任何一个接口失败都**不抛错**，只把失败原因记进结果里。
 * 曾经的做法是整体抛出，导致平台风控挑战 `users/current` 时，
 * 明明兑换成功却给用户报「兑换失败」——把成功说成失败，比不显示余额严重得多。
 *
 * @returns {Promise<{profileOk: boolean, balanceOk: boolean, errors: object}>}
 */
export async function readAccount(token) {
  if (testDouble?.read) return testDouble.read(token)

  const errors = {}

  /**
   * 三个请求互相独立，**并行发出**。
   *
   * 串行时最坏耗时是三者之和（含各自的 WAF 重试，可达数分钟），
   * 而前端请求超时远小于此 —— 用户看到「请求失败」而后端其实已经成功，
   * 是最难解释的一类投诉。并行把最坏耗时压到约三分之一。
   *
   * 每个都单独 catch：任何一个失败都不影响其余，也不影响「兑换已成功」这个事实。
   */
  const [current, summary, unnotified] = await Promise.all([
    call('users/current', '/auth-api/v0/users/current', { token })
      .catch((error) => { errors.profile = detailOf(error); return null }),
    call('get_user_summary', '/api/v0/users/get_user_summary', { token })
      .catch((error) => { errors.balance = detailOf(error); return null }),
    call('get_unnotified_bonuses', '/api/v0/users/get_unnotified_bonuses', { token })
      .catch((error) => { errors.unnotified = detailOf(error); return null }),
  ])

  const result = shapeAccount(current, summary, unnotified, errors.unnotified ?? null)
  // profileOk / balanceOk 供调用方判断展示到什么程度
  result.profile_ok = current !== null
  result.balance_ok = summary !== null
  result.errors = errors
  return result
}

/**
 * 把三个接口的原始响应整理成统一结构。测试替身也复用它，保证形状一致。
 * current / summary 允许为 null（对应接口读取失败），此时字段取空值。
 */
export function shapeAccount(current, summary, unnotified, unnotifiedError = null) {
  const normalWallets = walletList(summary?.normal_wallets)
  const bonusWallets = walletList(summary?.bonus_wallets)
  const unnotifiedList = Array.isArray(unnotified)
    ? unnotified
    : Array.isArray(unnotified?.bonuses) ? unnotified.bonuses : []

  // hit 有三种状态，不能混为一谈：
  //   true  —— 确实查到了 CNY 赠金
  //   false —— 成功读取钱包，确实没有 CNY 赠金
  //   null  —— 钱包没读成功，无法判断（不能说「没有」）
  // 把 null 当 false 展示，会误导用户以为账号没赠金。
  const hit = summary === null
    ? null
    : bonusWallets.some((wallet) => wallet.currency === 'CNY' && Number(wallet.balance) > 0)

  return {
    contact: current?.mobile || current?.mobile_number || current?.email || null,
    normal_wallets: normalWallets,
    bonus_wallets: bonusWallets,
    unnotified: unnotifiedList.map((item) => ({
      campaign: item?.campaign ?? null,
      amount: item?.amount ?? null,
      expires_at: item?.expires_at ?? null,
    })),
    unnotified_error: unnotifiedError,
    hit,
  }
}

export { ORIGIN }

/**
 * 平台侧的浏览器路径。放在这里而不是散落在路由层——
 * 这些是平台协议的一部分，改平台适配时应该只动这个文件。
 */
export const AUTHORIZE_PATH = '/dsh/authorize'
export const AUTHORIZED_PATH = '/dsh/authorized'

/** 拼一条授权页地址。authorize_id 来自 auth_init 的响应。 */
export function authorizeUrlOf(authorizeId) {
  return `${ORIGIN}${AUTHORIZE_PATH}?authorize_id=${encodeURIComponent(authorizeId)}`
}
