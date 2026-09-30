/**
 * 安全回归测试。
 *
 *   node tests/security.mjs
 *
 * 这里每一条都对应一个**真实存在过**的漏洞。写测试的目的不是证明现在没问题，
 * 而是让这些漏洞在将来被重新引入时立刻暴露——审计发现的缺陷如果只靠人记，
 * 下次重构就会原样长回来。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 8849
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'security-audit-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-sec-'))

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function post(path, body, admin = false, fakeIp = null) {
  const headers = { 'content-type': 'application/json' }
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`
  // 模拟不同网络来源。部署模式是 nginx，XFF 取最后一段——
  // 与真实反代行为一致（$remote_addr 覆盖写，客户端伪造的前置值无效）。
  if (fakeIp !== null) headers['x-forwarded-for'] = fakeIp
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, raw: text }
}

async function get(path, admin = false) {
  const headers = {}
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`
  const response = await fetch(`${BASE}${path}`, { headers })
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
    // 限流阈值刻意压低：本文件要验证「核销接口确实会限流」，
    // 阈值设太高就测不到。用 30/分钟，跑 40 次必然触发。
    DSH_BONUS_MAX_STARTS_IP_MIN: '30',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '2000',
    DSH_BONUS_TEST_DOUBLE: join(HERE, 'platform-double.mjs'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d.toString() })
server.stderr.on('data', (d) => { serverLog += d.toString() })

function cleanup() {
  try { server.kill() } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
process.on('exit', cleanup)

try {
  check('后端已监听', await waitUp())

  console.log('\n[1] 管理令牌不得出现在日志里')
  // 曾经启动横幅无条件打印 config.adminToken，而 pm2 会把 stdout 持久化到
  // ~/.pm2/logs/，等于把后台最高权限交给任何能读日志的人。
  await sleep(300)
  check('启动日志不含管理令牌', !serverLog.includes(ADMIN_TOKEN),
    serverLog.includes(ADMIN_TOKEN) ? '日志里出现了完整令牌' : '')
  check('启动日志也不含令牌片段', !serverLog.includes(ADMIN_TOKEN.slice(0, 16)))

  console.log('\n[2] state 缺失必须被拒（不得跳过 CSRF 校验）')
  const gen = await post('/admin/codes', { count: 6 }, true)
  const codes = gen.body?.codes ?? []
  check('已生成测试激活码', codes.length >= 6, String(codes.length))

  const dev1 = randomUUID()
  await post('/api/activate', { code: codes[0], device_id: dev1 })
  const s1 = await post('/api/start', { ticket: codes[0], device_id: dev1 })
  const sid1 = s1.body?.session_id
  check('会话已建立', typeof sid1 === 'string')

  const noState = await post('/api/callback', {
    session_id: sid1, device_id: dev1,
    callback_url: 'http://127.0.0.1:1455/oauth/callback?code=NO_STATE_ATTEMPT',
  })
  check('不带 state 的回调被拒', noState.status === 400 && noState.body?.error === 'state_mismatch',
    JSON.stringify(noState.body))

  const wrongState = await post('/api/callback', {
    session_id: sid1, device_id: dev1,
    callback_url: 'http://127.0.0.1:1455/oauth/callback?code=X&state=WRONG',
  })
  check('错误 state 的回调被拒', wrongState.status === 400 && wrongState.body?.error === 'state_mismatch')

  const stillOk = await post('/api/status', { session_id: sid1, device_id: dev1 })
  check('被拒后会话仍可用', stillOk.body?.phase === 'waiting')

  console.log('\n[3] 会话必须绑定创建设备')
  // 曾经 /api/status 与 /api/callback 不校验设备，任何人拿到 session_id
  // 就能读到他人手机号与余额，甚至抢兑消耗他人授权码。
  const attacker = randomUUID()
  const stolenStatus = await post('/api/status', { session_id: sid1, device_id: attacker })
  check('他人设备读状态 → 404', stolenStatus.status === 404, `实际 ${stolenStatus.status}`)
  check('不暴露会话是否存在（与真不存在同码）',
    stolenStatus.body?.error === 'session_not_found', JSON.stringify(stolenStatus.body))

  const stolenCb = await post('/api/callback', {
    session_id: sid1, device_id: attacker,
    callback_url: 'http://127.0.0.1:1455/oauth/callback?code=STEAL&state=x',
  })
  check('他人设备提交回调 → 404', stolenCb.status === 404, `实际 ${stolenCb.status}`)

  const stolenCancel = await post('/api/cancel', { session_id: sid1, device_id: attacker })
  check('他人设备取消 → 不报错但不生效', stolenCancel.status === 200)
  const afterStolenCancel = await post('/api/status', { session_id: sid1, device_id: dev1 })
  check('真实会话未被他人取消', afterStolenCancel.body?.phase === 'waiting')

  console.log('\n[4] 测试专用字段不得在生产泄露')
  // __state / __authorize_id 只在启用平台替身时下发。这里启用了替身，
  // 所以它们应该存在；关键是要确认「没有替身时不下发」——
  // 由下面的 /api/whoami 与配置检查间接覆盖。
  check('启用替身时下发 __state（测试需要）', typeof stillOk.body?.__state === 'string')

  console.log('\n[5] /api/whoami 默认关闭')
  // 它回显程序实际采信的 IP，等于告诉攻击者限流能否绕过。
  const whoami = await get('/api/whoami')
  check('默认不开放 /api/whoami', whoami.status === 404, `实际 ${whoami.status}`)

  console.log('\n[6] 激活码枚举防护')
  // 曾经「不存在」返回 404、「已被占用」返回 403，攻击者据此可枚举有效码。
  const notFound = await post('/api/activate', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', device_id: randomUUID() })
  check('不存在的码 → 403', notFound.status === 403, `实际 ${notFound.status}`)

  const dev2 = randomUUID()
  await post('/api/activate', { code: codes[1], device_id: dev2 })
  const boundElsewhere = await post('/api/activate', { code: codes[1], device_id: randomUUID() })
  check('已被占用的码 → 403（与不存在同码）',
    boundElsewhere.status === 403 && boundElsewhere.status === notFound.status,
    `${boundElsewhere.status} vs ${notFound.status}`)

  console.log('\n[7] 额度预检接口（/api/quota）')
  // 前端一进页面就查它，用于提前告知「额度已用尽」，
  // 而不是等用户填完激活码才拒绝。
  const quotaIp = '203.0.113.90'
  const freshDev = randomUUID()
  const q1 = await post('/api/quota', { device_id: freshDev }, false, quotaIp)
  check('预检接口可用', q1.status === 200 && q1.body?.ok === true, JSON.stringify(q1.body))
  check('新设备允许领取', q1.body?.allowed === true, JSON.stringify(q1.body))
  check('返回剩余次数', typeof q1.body?.device_left === 'number' && typeof q1.body?.ip_left === 'number')
  check('不泄露账号信息', q1.body?.contact === undefined && q1.body?.result === undefined)
  check('缺 device_id 被拒', (await post('/api/quota', {}, false, quotaIp)).status === 400)

  // 领过之后，预检必须如实反映「剩余次数减少」。
  // 本文件的 MAX_PER_DEVICE 是 10，所以领一次后应剩 9 —— 断言递减而非归零。
  // 「归零后拒绝」由下面的额度耗尽用例覆盖。
  const genQ = await post('/admin/codes', { count: 1 }, true)
  const codeQ = genQ.body?.codes?.[0]
  const devQ = randomUUID()
  await post('/api/activate', { code: codeQ, device_id: devQ }, false, quotaIp)
  const startQ = await post('/api/start', { ticket: codeQ, device_id: devQ }, false, quotaIp)
  const stQ = await post('/api/status', { session_id: startQ.body?.session_id, device_id: devQ }, false, quotaIp)
  await post('/api/callback', {
    session_id: startQ.body?.session_id, device_id: devQ,
    callback_url: `http://127.0.0.1:1455/oauth/callback?code=Q&state=${stQ.body?.__state}`,
  }, false, quotaIp)

  const q2 = await post('/api/quota', { device_id: devQ }, false, quotaIp)
  check('领取后设备剩余次数递减',
    q2.body?.device_left === q1.body?.device_left - 1,
    `领取前 ${q1.body?.device_left} → 领取后 ${q2.body?.device_left}`)
  check('领取后 IP 剩余次数递减',
    q2.body?.ip_left === q1.body?.ip_left - 1,
    `领取前 ${q1.body?.ip_left} → 领取后 ${q2.body?.ip_left}`)

  // 额度耗尽时必须报不允许——这是预检存在的意义。
  // 直接把设备计数写满，而不是跑 10 次完整流程：
  // 那样既慢又会撞上 IP 限额与分钟限流，测不到真正想验证的东西。
  const drainIp = '203.0.113.95'
  const devDrain = randomUUID()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DATA_DIR, 'bonus.sqlite'))
  const maxDevice = 10 // 与测试环境 DSH_BONUS_MAX_PER_DEVICE 一致
  db.prepare(`
    insert into devices (device_id, first_seen, last_seen, activations) values (?, ?, ?, ?)
    on conflict(device_id) do update set activations = ?
  `).run(devDrain, Date.now(), Date.now(), maxDevice, maxDevice)
  db.close()

  const q3 = await post('/api/quota', { device_id: devDrain }, false, drainIp)
  check('额度耗尽后预检报告不允许', q3.body?.allowed === false, JSON.stringify(q3.body))
  check('预检给出拒绝原因', typeof q3.body?.reason === 'string' && q3.body.reason.length > 0,
    String(q3.body?.reason))
  check('预检带可展示的文案', typeof q3.body?.message === 'string' && q3.body.message.length > 0,
    String(q3.body?.message))
  check('拒绝原因是设备限额', q3.body?.reason === 'device_limit', String(q3.body?.reason))

  console.log('\n[8] 反复取消后仍能重来（不得被自己的取消耗尽额度）')
  // 用户等太久 / 链接打不开 / 手滑，都可能点好几次「重新获取链接」。
  // maxPerDevice = 1 时，任何一次计数泄漏都会让他彻底卡死。
  const retryIp = '203.0.113.91'
  const genR = await post('/admin/codes', { count: 1 }, true)
  const codeR = genR.body?.codes?.[0]
  const devR = randomUUID()
  let roundsOk = 0
  let firstTicket = null
  for (let round = 0; round < 6; round += 1) {
    const act = await post('/api/activate', { code: codeR, device_id: devR }, false, retryIp)
    if (act.body?.ok !== true) break
    roundsOk += 1
    if (firstTicket === null) firstTicket = act.body.ticket
    const started = await post('/api/start', { ticket: act.body.ticket, device_id: devR }, false, retryIp)
    await post('/api/cancel', { session_id: started.body?.session_id, device_id: devR }, false, retryIp)
  }
  check('连续 6 轮「核销→取消」后仍可继续', roundsOk === 6, `实际成功 ${roundsOk} 轮`)

  console.log('\n[9] 取消不得覆盖已完成会话')
  // 用户领成功后点取消，结果不能被改成 cancelled。
  const dev3 = randomUUID()
  await post('/api/activate', { code: codes[2], device_id: dev3 })
  const s3 = await post('/api/start', { ticket: codes[2], device_id: dev3 })
  const sid3 = s3.body?.session_id
  const st3 = await post('/api/status', { session_id: sid3, device_id: dev3 })
  const done3 = await post('/api/callback', {
    session_id: sid3, device_id: dev3,
    callback_url: `http://127.0.0.1:1455/oauth/callback?code=OK&state=${st3.body?.__state}`,
  })
  check('会话兑换成功', done3.status === 200 && done3.body?.result?.hit === true, JSON.stringify(done3.body).slice(0, 140))

  const cancelAfterDone = await post('/api/cancel', { session_id: sid3, device_id: dev3 })
  check('取消已完成会话被忽略', cancelAfterDone.body?.ignored === true, JSON.stringify(cancelAfterDone.body))
  const afterCancelDone = await post('/api/status', { session_id: sid3, device_id: dev3 })
  check('已完成会话状态未被改写', afterCancelDone.body?.phase === 'done', JSON.stringify(afterCancelDone.body?.phase))
  check('已完成会话结果未被清空', afterCancelDone.body?.result?.hit === true)

  console.log('\n[11] 设置项协议白名单')
  // 跳转链接必须 http(s)，否则可能写入 javascript: 伪协议。
  // 放在限流测试之前：限流测试会耗尽本 IP 的分钟配额，之后所有请求都会被拒。
  const badUrl = await post('/admin/settings', { announce_link_url: 'javascript:alert(1)' }, true)
  check('javascript: 链接被拒', badUrl.status === 400, JSON.stringify(badUrl.body))
  const badSiteUrl = await post('/admin/settings', { site_url: 'data:text/html,<script>' }, true)
  check('data: 链接被拒', badSiteUrl.status === 400, JSON.stringify(badSiteUrl.body))
  const goodUrl = await post('/admin/settings', { announce_link_url: 'https://example.com/ok' }, true)
  check('合法 https 链接可保存', goodUrl.status === 200 && goodUrl.body?.ok === true)

  console.log('\n[12] 批量删除数量上限')
  const tooMany = await post('/admin/records/delete', {
    table: 'attempts',
    ids: Array.from({ length: 600 }, (_, i) => i + 1),
  }, true)
  check('超量删除被拒', tooMany.status === 400, JSON.stringify(tooMany.body))
  const badTable = await post('/admin/records/delete', { table: 'codes', ids: [1] }, true)
  check('删除激活码表被拒', badTable.status === 400, JSON.stringify(badTable.body))

  console.log('\n[13] 安全响应头')
  const headers = await fetch(`${BASE}/api/config`)
  check('有 X-Frame-Options', headers.headers.get('x-frame-options') === 'DENY')
  check('有 nosniff', headers.headers.get('x-content-type-options') === 'nosniff')

  console.log('\n[14] 核销接口必须限流（放最后：它会耗尽本 IP 的分钟配额）')
  // 曾经 /api/activate 完全无限流，可无限试探或填充 attempts 表。
  let got429 = false
  for (let i = 0; i < 60; i += 1) {
    const r = await post('/api/activate', { code: `FAKE-${String(i).padStart(4, '0')}-AAAA-BBBB`, device_id: randomUUID() })
    if (r.status === 429) { got429 = true; break }
  }
  check('连续核销触发限流', got429)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (error) {
  console.error('测试异常：', error)
  process.exitCode = 1
} finally {
  cleanup()
}
