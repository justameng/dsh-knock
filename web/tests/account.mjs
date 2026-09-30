/**
 * 账号读取链路验证：用你本地已有的授权令牌，真跑一遍余额解析。
 *
 *   node tests/account.mjs
 *
 * 只读三个平台接口，不打印令牌本身。用来证明「兑换后读余额」那段代码的解析是对的。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = 'https://platform.deepseek.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const candidates = [
  join(process.cwd(), '.dsh-bonus', 'credentials.json'),
  join(homedir(), '.dsh-bonus', 'credentials.json'),
]
const file = candidates.find((path) => { try { readFileSync(path); return true } catch { return false } })
if (file === undefined) {
  console.log('没找到凭据文件，跳过（先跑一次 dsh-bonus-login.mjs）。')
  process.exit(0)
}
const token = JSON.parse(readFileSync(file, 'utf8'))?.token
if (typeof token !== 'string' || token.length === 0) {
  console.log('凭据文件里没有 token，跳过。')
  process.exit(0)
}
console.log(`凭据文件：${file}`)
console.log(`令牌指纹：${token.slice(0, 6)}…(len=${token.length})（不打印全文）\n`)

const headers = {
  'x-client-bundle-id': '',
  'x-client-platform': 'web',
  'x-client-version': '0.2.0-rc.2',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  'user-agent': UA,
  accept: 'application/json',
  'x-dsh-auth-token': token,
}

async function call(path) {
  const response = await fetch(`${ORIGIN}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: response.status, payload }
}

let failed = 0
const expect = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const current = await call('/auth-api/v0/users/current')
expect('users/current 信封合法', current.status === 200 && current.payload?.code === 0
  && current.payload?.data?.biz_code === 0, `HTTP ${current.status} code=${current.payload?.code} biz=${current.payload?.data?.biz_code}`)
const contact = current.payload?.data?.biz_data?.mobile
  ?? current.payload?.data?.biz_data?.mobile_number
  ?? current.payload?.data?.biz_data?.email
expect('能取到账号标识', typeof contact === 'string' && contact.length > 0)
console.log(`      账号标识：${contact ?? '(未返回)'}`)

const summary = await call('/api/v0/users/get_user_summary')
expect('get_user_summary 信封合法', summary.status === 200 && summary.payload?.code === 0
  && summary.payload?.data?.biz_code === 0, `HTTP ${summary.status} code=${summary.payload?.code}`)
const biz = summary.payload?.data?.biz_data ?? {}
const normal = Array.isArray(biz.normal_wallets) ? biz.normal_wallets : []
const bonus = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets : []
expect('normal_wallets 是数组', Array.isArray(biz.normal_wallets), typeof biz.normal_wallets)
expect('bonus_wallets 是数组', Array.isArray(biz.bonus_wallets), typeof biz.bonus_wallets)
console.log(`      充值余额：${normal.map((w) => `${w.balance} ${w.currency}`).join(' | ') || '（空）'}`)
console.log(`      赠金余额：${bonus.map((w) => `${w.balance} ${w.currency}`).join(' | ') || '（空）'}`)

const hit = bonus.some((wallet) => wallet?.currency === 'CNY' && Number(wallet?.balance) > 0)
console.log(`      判定结果：${hit ? '赠金已到账' : '没有 CNY 赠金'}`)

const unnotified = await call('/api/v0/users/get_unnotified_bonuses')
expect('get_unnotified_bonuses 可读或明确不可用', unnotified.status === 200 || unnotified.status === 404,
  `HTTP ${unnotified.status}`)
if (unnotified.status === 200) {
  const list = unnotified.payload?.data?.biz_data
  const items = Array.isArray(list) ? list : Array.isArray(list?.bonuses) ? list.bonuses : []
  console.log(`      未通知赠金：${items.length === 0 ? '（无）' : items.map((i) => `${i?.campaign ?? '-'}/${i?.amount ?? '-'}`).join(', ')}`)
}

console.log(`\n${failed === 0 ? '账号读取链路全部通过。' : `${failed} 项失败。`}`)
process.exitCode = failed === 0 ? 0 : 1
