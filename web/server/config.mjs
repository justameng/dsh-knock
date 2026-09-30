/**
 * 后端配置。全部来自环境变量，没有硬编码密钥。
 *
 * 架构前提（实测结论，决定了本服务的形态）：
 *   平台的 auth_init 只接受 http://127.0.0.1:PORT/... 或 http://localhost:PORT/...
 *   作为 redirect_uri —— 任何域名、内网 IP、自定义 scheme 一律 50005 拒绝。
 *   手机浏览器监听不了回环端口，所以回调必然落在「打不开的地址」上，
 *   由用户把地址栏里的完整 URL 复制回网页，服务器用事先存好的 code_verifier 兑换。
 *
 * 这意味着服务器会短暂持有用户的授权令牌。这是本架构无法回避的信任成本，
 * 已用三件事压到最低：令牌只在内存存活数秒、读完余额立即主动注销、绝不落盘。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const str = (value, fallback) => {
  const text = String(value ?? '').trim()
  return text === '' ? fallback : text
}

const DATA_DIR = resolve(process.env.DSH_BONUS_DATA_DIR ?? join(process.cwd(), 'data'))
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

/**
 * 管理令牌。没配置就生成一个并落盘，避免「默认空令牌」这种灾难。
 */
function adminToken() {
  const fromEnv = process.env.DSH_BONUS_ADMIN_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length >= 16) return { token: fromEnv, generated: false }
  const file = join(DATA_DIR, 'admin-token.txt')
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim()
    if (stored.length >= 16) return { token: stored, generated: false }
  }
  const token = randomBytes(24).toString('base64url')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return { token, generated: true }
}

const admin = adminToken()

/**
 * 部署模式，决定信任哪些请求头来取真实访客 IP。
 *
 *   edgeone    —— 腾讯云 EdgeOne 加速。优先采信 EO-Connecting-IP。
 *   cloudflare —— Cloudflare 加速。优先采信 CF-Connecting-IP。
 *   nginx      —— 宝塔 Nginx 直接反代。采信 X-Forwarded-For。
 *   auto       —— 不确定用哪家 CDN 时用它：两家的专有头都试，逐级回退。
 *   direct     —— 直连，只用 socket 地址。
 *
 * 安全提示：这些头客户端都能伪造。仅当源站**只允许 CDN 回源**时才是可信的。
 * 生产环境请把源站防火墙设为只放行 CDN 的 IP 段，或开启回源鉴权。
 */
const deployMode = str(process.env.DSH_BONUS_DEPLOY_MODE, 'auto').toLowerCase()

export const config = {
  port: num(process.env.PORT, 8788),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: DATA_DIR,
  dbFile: join(DATA_DIR, 'bonus.sqlite'),
  adminToken: admin.token,
  adminTokenGenerated: admin.generated,

  deployMode,
  /** 兼容旧变量：显式设为 false 时退回不信任任何代理头。 */
  trustProxy: process.env.DSH_BONUS_TRUST_PROXY !== 'false',

  // 前端站点来源，用于 CORS。多个用逗号分隔；留空表示只服务同源。
  allowedOrigins: (process.env.DSH_BONUS_ALLOWED_ORIGINS ?? '')
    .split(',').map((item) => item.trim()).filter(Boolean),

  /**
   * 配额。
   *
   * maxPerIpPerDay 默认 1：走 CF 之后每个真实访客都有独立 IP（CF-Connecting-IP），
   * 一人一次是可行的。但要注意：家庭宽带重播、手机基站切换会换 IP，
   * 同一人理论上可以换 IP 再领一次——这是摩擦，不是安全边界。
   * 真正的守门人是激活码（服务端一次性凭证）。
   */
  maxPerDevice: num(process.env.DSH_BONUS_MAX_PER_DEVICE, 1),
  maxPerIpPerDay: num(process.env.DSH_BONUS_MAX_PER_IP_DAY, 1),
  maxStartsPerIpPerMinute: num(process.env.DSH_BONUS_MAX_STARTS_IP_MIN, 6),
  maxStartsPerIpPerHour: num(process.env.DSH_BONUS_MAX_STARTS_IP_HOUR, 30),

  /**
   * 授权会话的有效期上限（分钟）。
   *
   * 实际生效值取「本配置」与「平台返回的 expires_in」中的较小值——
   * 平台签发的授权码只有 600 秒有效，配大了会让页面倒计时显示的时间
   * 超过真实可用时间，用户在最后一刻提交才发现过期。
   *
   * 默认 8 分钟：比平台的 10 分钟略短，留出提交和网络往返的缓冲。
   */
  sessionTtlMs: num(process.env.DSH_BONUS_SESSION_TTL_MIN, 8) * 60 * 1000,
  // 激活码本身的有效期（生成后多久未使用即失效），0 表示永不过期。
  codeTtlMs: num(process.env.DSH_BONUS_CODE_TTL_DAYS, 0) * 24 * 60 * 60 * 1000,

  /**
   * 读到余额后是否立即主动注销令牌。
   * 默认开启：这样即便服务器被攻破，也拿不到一个还活着的令牌。
   */
  revokeAfterRead: process.env.DSH_BONUS_REVOKE_AFTER_READ !== 'false',

  /**
   * 站点文案。管理后台可以直接改，会落盘到 data/site-text.json。
   * 这里只是初始默认值。
   */
  site: {
    siteName: str(process.env.DSH_BONUS_SITE_NAME, '小学生公益站'),
    siteUrl: str(process.env.DSH_BONUS_SITE_URL, 'https://example.com'),
    codeSource: str(process.env.DSH_BONUS_CODE_SOURCE, '群友专属渠道'),
    bonusValidity: str(process.env.DSH_BONUS_BONUS_VALIDITY, '7 天'),
    // 领取教程，管理后台可编辑；前台按行渲染成步骤。
    tutorial: null,
  },
}

export { str }
