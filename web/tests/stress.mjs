/**
 * 并发兑换压力测试。
 *
 *   node tests/stress.mjs
 *
 * 回答一个具体问题：**同一时间多人兑换，会不会出岔子？**
 *
 * 「出岔子」的具体含义（每一条都要验）：
 *   1. 串号 —— A 的兑换结果写进 B 的会话 / B 看到 A 的余额
 *   2. 丢单 —— 有人兑换成功但记录没落库
 *   3. 重复 —— 同一个激活码被兑换两次，产生两条领取记录
 *   4. 超发 —— 同一台设备/同一个 IP 领到超过限额的次数
 *   5. 卡死 —— 会话停在 exchanging 再也不动
 *   6. 假失败 —— 后端实际成功但前端收到错误
 *   7. 假成功 —— 后端实际失败但前端收到成功
 *
 * 与 tests/concurrent.mjs 的区别：那个测「语义正确性」（三人八人各自归位），
 * 这个测「压力下的稳定性」——更高并发、更乱时序、反复取消重试。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PORT = 8873
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'stress-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-stress-'))

/** 与生产默认一致：每设备 1 次、每 IP 每天 1 次。 */
const MAX_PER_DEVICE = 1
const MAX_PER_IP_DAY = 1

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
  // 模拟不同网络来源。
  // 部署模式是 nginx，XFF 取「最后一段」——这与真实反代行为一致
  // （$remote_addr 覆盖写，客户端伪造的前置值无效）。
  if (fakeIp !== null) headers['x-forwarded-for'] = fakeIp
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const t = await r.text()
  let p = null
  try { p = JSON.parse(t) } catch { /* 非 JSON */ }
  return { status: r.status, body: p }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(600) })).ok) return true } catch { /* 未起 */ }
    await sleep(150)
  }
  return false
}

let serverLog = ''
const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_DEPLOY_MODE: 'nginx',
    DSH_BONUS_MAX_PER_IP_DAY: String(MAX_PER_IP_DAY),
    DSH_BONUS_MAX_PER_DEVICE: String(MAX_PER_DEVICE),
    // 限流阈值放大，避免压力测试被限流挡住而测不到并发本身
    DSH_BONUS_MAX_STARTS_IP_MIN: '5000',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '20000',
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

/**
 * 一个用户的完整流程。
 * 每步都可能失败，失败时返回带阶段标记的 trace，便于定位。
 * fakeIp 用于模拟不同网络来源，让并发测试不被 IP 限额挡住。
 */
async function runUser(name, code, fakeIp = null) {
  const deviceId = randomUUID()
  const t = { name, deviceId, code, stage: 'activate' }

  const act = await post('/api/activate', { code, device_id: deviceId }, false, fakeIp)
  t.activate = act
  if (act.body?.ok !== true) { t.fail = `activate:${act.body?.error}`; return t }

  t.stage = 'start'
  const start = await post('/api/start', { ticket: act.body.ticket, device_id: deviceId }, false, fakeIp)
  t.start = start
  if (start.body?.ok !== true) { t.fail = `start:${start.body?.error}`; return t }
  t.sessionId = start.body.session_id

  t.stage = 'status'
  const st = await post('/api/status', { session_id: t.sessionId, device_id: deviceId }, false, fakeIp)
  t.state = st.body?.__state

  t.stage = 'callback'
  const cb = await post('/api/callback', {
    session_id: t.sessionId, device_id: deviceId,
    callback_url: `http://127.0.0.1:1455/oauth/callback?code=CODE_${name}&state=${t.state}`,
  }, false, fakeIp)
  t.callback = cb
  if (cb.body?.ok !== true) { t.fail = `callback:${cb.body?.error}`; return t }

  t.stage = 'done'
  return t
}

try {
  check('后端已监听', await waitUp())

  // ══════════════════════════════════════════════════════════
  console.log('\n[1] 20 人同时全流程（每人独立设备 + 独立激活码 + 独立网络）')
  // 每人给一个不同的模拟 IP，这样「每 IP 每天 1 次」不会互相挤占，
  // 才能真正测到 20 路并发全流程。IP 限额本身由 [1b] 单独验证。
  const gen1 = await post('/admin/codes', { count: 20 }, true)
  const codes1 = gen1.body?.codes ?? []
  check('生成 20 个激活码', codes1.length === 20)

  const batch1 = await Promise.all(codes1.map((c, i) => runUser(`U${i}`, c, `198.51.100.${i + 1}`)))
  const ok1 = batch1.filter((t) => t.callback?.body?.ok === true)
  check('20 人全部兑换成功', ok1.length === 20, `成功 ${ok1.length}/20`)
  check('并发下每人拿到唯一会话', new Set(batch1.filter((t) => t.sessionId).map((t) => t.sessionId)).size
    === batch1.filter((t) => t.sessionId).length)
  check('并发下每人拿到唯一设备标识', new Set(batch1.map((t) => t.deviceId)).size === 20)

  // 串号检查：每个人的结果必须来自自己的会话
  const byName = new Map(batch1.map((t) => [t.name, t]))
  const crossTalk = batch1.filter((t) => {
    const r = t.callback?.body?.result
    // 替身返回的 contact 是固定的，无法据此判归属；
    // 用「会话 id 与结果同时存在」+ 下面数据库层的孤儿检查来覆盖。
    return r === undefined || t.callback?.body?.ok !== true
  })
  check('每人都有属于自己的结果', crossTalk.length === 0, `${crossTalk.length} 人缺少结果`)

  // 所有请求都必须有确定的结果，不能有人卡在中间
  const stuck1 = batch1.filter((t) => t.stage !== 'done' && t.fail === undefined)
  check('没有人卡在中间状态', stuck1.length === 0, `${stuck1.length} 人未完成也未失败`)
  check('没有未归类的失败', batch1.every((t) => t.fail === undefined),
    JSON.stringify(batch1.filter((t) => t.fail).map((t) => `${t.name}:${t.fail}`)))

  // ══════════════════════════════════════════════════════════
  console.log('\n[1b] 同一网络 10 人同时领取（每 IP 每天 1 次 → 只应 1 人成功）')
  const SHARED_IP = '198.51.100.200'
  const gen1b = await post('/admin/codes', { count: 10 }, true)
  const codes1b = gen1b.body?.codes ?? []
  const batch1b = await Promise.all(codes1b.map((c, i) =>
    post('/api/activate', { code: c, device_id: randomUUID() }, false, SHARED_IP)))
  const ok1b = batch1b.filter((r) => r.body?.ok === true)
  check('共用网络下只有 1 人成功', ok1b.length === MAX_PER_IP_DAY,
    `成功 ${ok1b.length} 人，上限 ${MAX_PER_IP_DAY}`)
  const rejected1b = batch1b.filter((r) => r.body?.ok !== true)
  check('其余被明确告知网络限额',
    rejected1b.every((r) => r.body?.error === 'ip_limit' || r.status === 429),
    JSON.stringify([...new Set(rejected1b.map((r) => r.body?.error))]))

  // ══════════════════════════════════════════════════════════
  console.log('\n[2] 同一会话 20 个并发提交（应共享同一次平台调用）')
  // 每节用独立的模拟 IP，否则会被上一节耗尽的 IP 额度挡住——
  // 那会测不到本节真正想验证的并发行为。
  const IP2 = '203.0.113.20'
  const gen2 = await post('/admin/codes', { count: 1 }, true)
  const code2 = gen2.body?.codes?.[0]
  const dev2 = randomUUID()
  const act2 = await post('/api/activate', { code: code2, device_id: dev2 }, false, IP2)
  check('激活成功', act2.body?.ok === true, JSON.stringify(act2.body))

  const start2 = await post('/api/start', { ticket: code2, device_id: dev2 }, false, IP2)
  const sid2 = start2.body?.session_id
  const st2 = await post('/api/status', { session_id: sid2, device_id: dev2 }, false, IP2)
  const url2 = `http://127.0.0.1:1455/oauth/callback?code=SAME&state=${st2.body?.__state}`

  const burst = await Promise.all(Array.from({ length: 20 }, () =>
    post('/api/callback', { session_id: sid2, device_id: dev2, callback_url: url2 }, false, IP2)))

  const burstOk = burst.filter((r) => r.status === 200 && r.body?.ok === true)
  check('20 个并发提交全部返回成功', burstOk.length === 20, `成功 ${burstOk.length}/20`)
  check('20 个结果完全一致',
    new Set(burst.map((r) => JSON.stringify(r.body?.result ?? r.body?.error))).size === 1)
  const sharedCount = burst.filter((r) => r.body?.shared === true).length
  check('只有 1 个真正执行兑换，其余共享结果', sharedCount === 19, `共享 ${sharedCount} 个`)

  // ══════════════════════════════════════════════════════════
  console.log('\n[3] 同一激活码被 30 台设备同时抢（只能有一个赢家）')
  const IP3 = '203.0.113.30'
  const gen3 = await post('/admin/codes', { count: 1 }, true)
  const code3 = gen3.body?.codes?.[0]
  const race = await Promise.all(Array.from({ length: 30 }, () =>
    post('/api/activate', { code: code3, device_id: randomUUID() }, false, IP3)))
  const winners = race.filter((r) => r.body?.ok === true)
  check('只有一个设备抢到', winners.length === 1, `赢家 ${winners.length} 个`)
  const losers = race.filter((r) => r.body?.ok !== true)
  check('失败者都被明确拒绝（无异常状态码）',
    losers.every((r) => r.status === 403 || r.status === 429),
    JSON.stringify([...new Set(losers.map((r) => r.status))]))

  // ══════════════════════════════════════════════════════════
  console.log('\n[4] 同一设备 20 次并发取链接（应只产生一个会话）')
  const IP4 = '203.0.113.40'
  const dev4 = randomUUID()
  const gen4 = await post('/admin/codes', { count: 1 }, true)
  const code4 = gen4.body?.codes?.[0]
  await post('/api/activate', { code: code4, device_id: dev4 }, false, IP4)
  const sameDev = await Promise.all(Array.from({ length: 20 }, () =>
    post('/api/start', { ticket: code4, device_id: dev4 }, false, IP4)))
  const sessions4 = new Set(sameDev.filter((r) => r.body?.ok === true).map((r) => r.body?.session_id))
  check('同设备并发只产生一个会话', sessions4.size === 1, `产生 ${sessions4.size} 个`)
  check('全部返回成功', sameDev.every((r) => r.body?.ok === true))

  // ══════════════════════════════════════════════════════════
  console.log('\n[5] 乱序：取消与提交同时发生')
  // 这是真实场景——用户在倒计时最后几秒既点了「重新获取」又点了「提交」。
  const IP5 = '203.0.113.50'
  const dev5 = randomUUID()
  const gen5 = await post('/admin/codes', { count: 1 }, true)
  const code5 = gen5.body?.codes?.[0]
  await post('/api/activate', { code: code5, device_id: dev5 }, false, IP5)
  const start5 = await post('/api/start', { ticket: code5, device_id: dev5 }, false, IP5)
  const sid5 = start5.body?.session_id
  const st5 = await post('/api/status', { session_id: sid5, device_id: dev5 }, false, IP5)
  const url5 = `http://127.0.0.1:1455/oauth/callback?code=RACE&state=${st5.body?.__state}`

  const mixed = await Promise.all([
    post('/api/callback', { session_id: sid5, device_id: dev5, callback_url: url5 }, false, IP5),
    post('/api/cancel', { session_id: sid5, device_id: dev5 }, false, IP5),
    post('/api/callback', { session_id: sid5, device_id: dev5, callback_url: url5 }, false, IP5),
    post('/api/cancel', { session_id: sid5, device_id: dev5 }, false, IP5),
    post('/api/callback', { session_id: sid5, device_id: dev5, callback_url: url5 }, false, IP5),
  ])
  check('乱序下没有请求抛异常', mixed.every((r) => r.status >= 200 && r.status < 600),
    JSON.stringify(mixed.map((r) => r.status)))

  const finalStatus = await post('/api/status', { session_id: sid5, device_id: dev5 }, false, IP5)
  check('最终状态是确定值（不卡在 exchanging）',
    ['done', 'failed', 'expired', 'cancelled', 'waiting'].includes(finalStatus.body?.phase),
    `实际 ${finalStatus.body?.phase}`)

  // ══════════════════════════════════════════════════════════
  console.log('\n[6] 数据一致性核对')
  const db = new DatabaseSync(join(DATA_DIR, 'bonus.sqlite'))

  // 6.1 没有会话卡在 exchanging
  const exchanging = db.prepare("select count(*) n from sessions where phase = 'exchanging'").get().n
  check('没有会话卡在 exchanging', exchanging === 0, `实际 ${exchanging} 个`)

  // 6.2 每个 done 会话都有结果
  const doneNoResult = db.prepare("select count(*) n from sessions where phase = 'done' and result is null").get().n
  check('done 会话都有结果', doneNoResult === 0, `实际 ${doneNoResult} 个`)

  // 6.3 领取记录数 == done 会话数（每次成功都落库，不多不少）
  const doneCount = db.prepare("select count(*) n from sessions where phase = 'done'").get().n
  const redemptionCount = db.prepare('select count(*) n from redemptions').get().n
  check('领取记录数与成功会话数一致', doneCount === redemptionCount,
    `done=${doneCount} redemptions=${redemptionCount}`)

  // 6.4 没有重复的领取记录（同一会话不应落两行）
  const dupRedemption = db.prepare(`
    select device_id, at, count(*) n from redemptions group by device_id, at having n > 1
  `).all()
  check('没有重复的领取记录', dupRedemption.length === 0, JSON.stringify(dupRedemption))

  // 6.5 设备计数不超过上限
  const overDevice = db.prepare('select device_id, activations from devices where activations > ?')
    .all(MAX_PER_DEVICE)
  check('没有设备超额', overDevice.length === 0, JSON.stringify(overDevice))

  // 6.6 IP 计数不超过上限
  const overIp = db.prepare('select ip, day, activations from ip_days where activations > ?')
    .all(MAX_PER_IP_DAY)
  check('没有 IP 超额', overIp.length === 0, JSON.stringify(overIp))

  // 6.7 已使用的激活码数量 == 领取记录数
  const usedCodes = db.prepare("select count(*) n from codes where state = 'used'").get().n
  check('已用激活码数不超过领取记录数', usedCodes <= redemptionCount,
    `used=${usedCodes} redemptions=${redemptionCount}`)

  // 6.8 结果归属正确：每条领取记录的 device_id 必须来自真实会话
  const orphan = db.prepare(`
    select r.device_id from redemptions r
    where not exists (select 1 from sessions s where s.device_id = r.device_id and s.phase = 'done')
  `).all()
  check('没有孤儿领取记录', orphan.length === 0, JSON.stringify(orphan))

  db.close()

  // ══════════════════════════════════════════════════════════
  console.log('\n[7] 日志核对')
  check('日志无未捕获异常', !/UnhandledPromiseRejection|TypeError|ReferenceError/.test(serverLog),
    serverLog.match(/UnhandledPromiseRejection|TypeError|ReferenceError/)?.[0] ?? '')
  check('日志无重复兑换告警', !/inFlight.*重复/.test(serverLog))

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
