/**
 * 真实访客 IP 提取。
 *
 * 这是限流能否正确工作的前提。取错了会出两种事故：
 *   1. 全部访客算成同一个 IP（CDN 边缘节点或反代本机）→ 第一个人领完，所有人被拒。
 *   2. 采信了客户端伪造的头 → 攻击者随便换 IP 绕过限流。
 *
 * 各 CDN / 反代回源时放置真实 IP 的头部并不统一：
 *   Cloudflare    → CF-Connecting-IP（CF 强制覆盖，客户端无法伪造）
 *   EdgeOne(腾讯) → EO-Connecting-IP，同时会填 X-Forwarded-For
 *   通用反代      → X-Forwarded-For 第一段（最靠近客户端）
 *
 * 因此按「优先可信头 → 逐级回退」的顺序取，而不是只认一个。
 * 前提：源站只允许 CDN 回源。若源站对公网直接开放，
 * 任何人都能伪造这些头绕过限流。务必在防火墙限制回源 IP 段。
 */

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6 = /^[0-9a-f:]+$/i

/** 是否是一个看起来合法的 IP 字面量。 */
export function isIpLiteral(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45) return false
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255)
  return IPV6.test(value) && value.includes(':')
}

/**
 * 取 X-Forwarded-For 里**最后一个**合法 IP。
 *
 * 为什么是最后一个而不是第一个：
 * Nginx 的 `$proxy_add_x_forwarded_for` 是「追加」语义——它把客户端传来的
 * XFF 原样保留在前面，再把自己的 $remote_addr 追加到末尾。也就是说：
 *   XFF = <客户端伪造的值>, <真实对端>
 * 取第一段等于直接采信攻击者随便填的字符串。
 * 取最后一段拿到的才是离我们最近、由我们自己的反代写入的那个地址。
 *
 * 若整条链都不可信，最终还有 socket 地址兜底（见 clientIp）。
 */
function lastForwarded(value) {
  if (typeof value !== 'string') return null
  const parts = value.split(',')
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i].trim()
    if (isIpLiteral(candidate)) return candidate
  }
  return null
}

/**
 * 归一化：IPv6 转小写，IPv4-mapped IPv6（::ffff:1.2.3.4）还原成 IPv4，
 * 避免同一个访客因表示形式不同被算成两个 IP。
 */
export function normalizeIp(value) {
  if (typeof value !== 'string') return 'unknown'
  let ip = value.trim().toLowerCase()
  if (ip.startsWith('::ffff:') && IPV4.test(ip.slice(7))) ip = ip.slice(7)
  return ip === '' ? 'unknown' : ip
}

/** 从请求头里安全地取一个字符串（重复头会是数组）。 */
function header(request, name) {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}

/** 各部署模式下采信的头，按优先级排列。 */
const HEADER_CHAIN = {
  // EdgeOne：优先 EO-Connecting-IP，其次通用头
  edgeone: ['eo-connecting-ip', 'x-forwarded-for', 'x-real-ip'],
  // Cloudflare：优先 CF-Connecting-IP
  cloudflare: ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'],
  // 通用反代（宝塔 Nginx 直连）
  nginx: ['x-forwarded-for', 'x-real-ip'],
  // 直连：不采信任何头，只用 socket 地址
  direct: [],
  // 自动：把两家的专有头都试一遍，适合不确定用哪家 CDN 时
  auto: ['eo-connecting-ip', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'],
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {{deployMode: string, trustProxy: boolean}} options
 * @returns {string} 归一化后的访客 IP。
 */
export function clientIp(request, options) {
  const socketIp = normalizeIp(request.socket?.remoteAddress)
  if (!options.trustProxy) return socketIp

  const chain = HEADER_CHAIN[options.deployMode] ?? HEADER_CHAIN.auto
  for (const name of chain) {
    const raw = header(request, name)
    if (raw === null) continue
    // XFF 是多段列表，取最后一段（由我们自己的反代写入的那个）
    const candidate = name === 'x-forwarded-for' ? lastForwarded(raw) : raw.trim()
    if (candidate !== null && isIpLiteral(candidate)) return normalizeIp(candidate)
  }
  return socketIp
}

/**
 * 诊断用：列出本次请求里所有可能承载真实 IP 的头及其取值。
 * 部署时用它确认 CDN 实际用的是哪个头，避免猜错导致限流失效。
 */
export function inspectIpHeaders(request) {
  const names = ['eo-connecting-ip', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip', 'x-client-ip']
  const found = {}
  for (const name of names) {
    const value = header(request, name)
    if (value !== null && value !== '') found[name] = value
  }
  return {
    socket: normalizeIp(request.socket?.remoteAddress),
    headers: found,
    resolved: clientIp(request, { deployMode: 'auto', trustProxy: true }),
  }
}
