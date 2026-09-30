/**
 * CF 真实 IP 提取测试。
 *
 *   node tests/client-ip.mjs
 *
 * 这是限流能否正确工作的前提：取错了会「全部访客算成同一个 IP」，
 * 于是第一个人领完所有人被拒；或者采信可伪造的头，限流形同虚设。
 */
import { clientIp, isIpLiteral, normalizeIp, inspectIpHeaders } from '../server/client-ip.mjs'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 构造一个假的请求对象。 */
const req = (headers, socketAddress = '10.0.0.1') => ({
  headers,
  socket: { remoteAddress: socketAddress },
})

console.log('\n[1] 字面量校验')
check('合法 IPv4', isIpLiteral('1.2.3.4'))
check('合法 IPv6', isIpLiteral('2001:db8::1'))
check('IPv4 越界被拒', !isIpLiteral('256.1.1.1'))
check('空串被拒', !isIpLiteral(''))
check('注入尝试被拒', !isIpLiteral('1.2.3.4, 5.6.7.8'))
check('超长串被拒', !isIpLiteral('1'.repeat(50)))

console.log('\n[2] 归一化')
check('IPv4-mapped 还原', normalizeIp('::ffff:1.2.3.4') === '1.2.3.4', normalizeIp('::ffff:1.2.3.4'))
check('大写 IPv6 转小写', normalizeIp('2001:DB8::1') === '2001:db8::1')
check('空值返回 unknown', normalizeIp('') === 'unknown')
check('非字符串返回 unknown', normalizeIp(null) === 'unknown')

console.log('\n[3] cloudflare 模式')
const cf = { deployMode: 'cloudflare', trustProxy: true }
check('优先采信 CF-Connecting-IP',
  clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.9' }), cf) === '203.0.113.5')
check('CF 头非法时退回 XFF',
  clientIp(req({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.9' }), cf) === '198.51.100.9')
// 关键安全断言：XFF 必须取**最后一段**，不是第一段。
// Nginx 的 $proxy_add_x_forwarded_for 是「追加」语义——客户端伪造的值
// 被原样保留在前面，我们自己的反代把真实对端追加到末尾。
// 取第一段等于采信攻击者随便填的字符串，限流会被直接绕过。
check('XFF 多段取最后一段（由我们的反代写入）',
  clientIp(req({ 'x-forwarded-for': '203.0.113.7, 172.16.0.1, 10.0.0.1' }), cf) === '10.0.0.1')
check('XFF 伪造前置值不影响结果',
  clientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }), cf) === '198.51.100.9')
check('XFF 末段非法则向前找合法段',
  clientIp(req({ 'x-forwarded-for': '203.0.113.8, garbage' }), cf) === '203.0.113.8')
check('两者都缺时退回 X-Real-IP',
  clientIp(req({ 'x-real-ip': '203.0.113.9' }), cf) === '203.0.113.9')
check('全缺时退回 socket 地址',
  clientIp(req({}), cf) === '10.0.0.1')
check('不同访客得到不同 IP（关键：不能全算成 CF 节点）',
  clientIp(req({ 'cf-connecting-ip': '203.0.113.1' }), cf)
  !== clientIp(req({ 'cf-connecting-ip': '203.0.113.2' }), cf))

console.log('\n[4] edgeone 模式（腾讯云 EdgeOne）')
const eo = { deployMode: 'edgeone', trustProxy: true }
check('优先采信 EO-Connecting-IP',
  clientIp(req({ 'eo-connecting-ip': '203.0.113.11', 'x-forwarded-for': '198.51.100.9' }), eo) === '203.0.113.11')
check('EO 头非法时退回 XFF',
  clientIp(req({ 'eo-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.9' }), eo) === '198.51.100.9')
check('EO 模式忽略 CF 头',
  clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '203.0.113.12' }), eo) === '203.0.113.12')
check('EO 模式全缺时退回 socket',
  clientIp(req({}, '10.0.0.7'), eo) === '10.0.0.7')
check('不同访客得到不同 IP',
  clientIp(req({ 'eo-connecting-ip': '203.0.113.21' }), eo)
  !== clientIp(req({ 'eo-connecting-ip': '203.0.113.22' }), eo))

console.log('\n[5] auto 模式（不确定用哪家 CDN）')
const auto = { deployMode: 'auto', trustProxy: true }
check('EO 头优先于 CF 头',
  clientIp(req({ 'eo-connecting-ip': '203.0.113.31', 'cf-connecting-ip': '203.0.113.32' }), auto) === '203.0.113.31')
check('只有 CF 头时也能取到',
  clientIp(req({ 'cf-connecting-ip': '203.0.113.33' }), auto) === '203.0.113.33')
check('只有 XFF 时回退到 XFF（取末段）',
  clientIp(req({ 'x-forwarded-for': '203.0.113.34, 10.0.0.1' }), auto) === '10.0.0.1')
check('全缺时退回 socket', clientIp(req({}, '10.0.0.9'), auto) === '10.0.0.9')

console.log('\n[6] inspectIpHeaders 诊断')
const diag = inspectIpHeaders(req({
  'eo-connecting-ip': '203.0.113.41',
  'cf-connecting-ip': '203.0.113.42',
  'x-forwarded-for': '203.0.113.43',
}, '10.0.0.11'))
check('列出 EO 头', diag.headers['eo-connecting-ip'] === '203.0.113.41')
check('列出 CF 头', diag.headers['cf-connecting-ip'] === '203.0.113.42')
check('列出 XFF 头', diag.headers['x-forwarded-for'] === '203.0.113.43')
check('给出 socket 地址', diag.socket === '10.0.0.11')
check('auto 下解析优先 EO', diag.resolved === '203.0.113.41', diag.resolved)
const diagEmpty = inspectIpHeaders(req({}, '10.0.0.12'))
check('无头时 headers 为空对象', Object.keys(diagEmpty.headers).length === 0)
check('无头时 resolved 为 socket', diagEmpty.resolved === '10.0.0.12')

console.log('\n[7] nginx 模式')
const nginx = { deployMode: 'nginx', trustProxy: true }
check('采信 XFF 最后一段（反代写入的对端地址）',
  clientIp(req({ 'x-forwarded-for': '203.0.113.7, 172.16.0.1' }), nginx) === '172.16.0.1')
check('nginx 模式忽略 CDN 专有头（非 CDN 环境可伪造）',
  clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '203.0.113.7' }), nginx) === '203.0.113.7')
check('nginx 模式忽略 EO 头',
  clientIp(req({ 'eo-connecting-ip': '2.2.2.2', 'x-forwarded-for': '203.0.113.8' }), nginx) === '203.0.113.8')

console.log('\n[8] direct 模式')
const direct = { deployMode: 'direct', trustProxy: true }
check('只用 socket 地址',
  clientIp(req({ 'cf-connecting-ip': '1.1.1.1', 'eo-connecting-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, '192.168.1.5'), direct) === '192.168.1.5')

console.log('\n[9] trustProxy 关闭')
const off = { deployMode: 'edgeone', trustProxy: false }
check('关闭后一律用 socket 地址',
  clientIp(req({ 'eo-connecting-ip': '1.1.1.1' }, '192.168.1.5'), off) === '192.168.1.5')

console.log('\n[10] 数组型头（Node 对重复头会给数组）')
check('XFF 是数组时不崩',
  typeof clientIp(req({ 'x-forwarded-for': ['203.0.113.1', '172.16.0.1'] }), auto) === 'string')
check('EO 头是数组时取第一个',
  clientIp(req({ 'eo-connecting-ip': ['203.0.113.51', '10.0.0.1'] }), eo) === '203.0.113.51')

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
