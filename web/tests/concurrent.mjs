/**
 * 跨会话并发测试：三个（以及更多）不同用户同时走完整流程，验证数据不串。
 *
 *   node tests/concurrent.mjs
 *
 * 场景：
 *   小王 / 小李 / 小张 各自拿到自己的激活码，几乎同一时刻：
 *     1. 同时核销激活码
 *     2. 同时发起授权，拿各自的授权链接
 *     3. 同时提交各自的回调地址
 *   断言：每个人的会话、凭据、结果都严格属于自己，绝不串号。
 *
 * 平台调用走替身，不消耗真实配额。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const PORT = 8792
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'concurrent-admin-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-bonus-concurrent-'))

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))

const adminPost = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
  body: JSON.stringify(body),
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))

const child = spawn(process.execPath, [join(WEB, 'server', 'index.mjs')], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_MAX_PER_DEVICE: '5',
    DSH_BONUS_MAX_PER_IP_DAY: '1000',
    DSH_BONUS_MAX_STARTS_IP_MIN: '1000',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '5000',
    DSH_BONUS_TRUST_PROXY: 'false',
    DSH_BONUS_TEST_DOUBLE: join(HERE, 'platform-double.mjs'),
  },
})

async function waitUp() {
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(800) })
      if (response.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  return false
}

/** 一个完整的用户流程。返回该用户的全部中间产物，供串号检查。 */
async function runUser(name, code) {
  const deviceId = crypto.randomUUID()
  const trace = { name, deviceId, code }

  // 1. 核销激活码
  const activated = await post('/api/activate', { code, device_id: deviceId })
  trace.activate = activated
  if (activated.body?.ok !== true) return trace

  // 2. 发起授权
  const started = await post('/api/start', { ticket: activated.body.ticket, device_id: deviceId })
  trace.start = started
  if (started.body?.ok !== true) return trace
  trace.sessionId = started.body.session_id
  trace.authorizeUrl = started.body.authorize_url

  // 3. 构造真实的回调地址。
  //    真实流程里 state 是服务器生成的、随授权跳转带回来的，测试无法预知，
  //    所以用测试专用字段取出它，模拟「用户把浏览器地址栏内容复制回来」。
  const status = await post('/api/status', { session_id: trace.sessionId, device_id: deviceId })
  trace.state = status.body?.__state
  const callbackUrl = `http://127.0.0.1:1455/oauth/callback?code=CODE_${name}_${Math.random().toString(36).slice(2)}`
    + (trace.state === undefined ? '' : `&state=${trace.state}`)

  // 4. 提交回调地址（用该用户自己的 session_id 与 device_id）
  const done = await post('/api/callback', { session_id: trace.sessionId, device_id: deviceId, callback_url: callbackUrl })
  trace.callback = done
  return trace
}

try {
  check('后端已监听', await waitUp())

  const NAMES = ['小王', '小李', '小张', '小赵', '小钱', '小孙', '小周', '小吴']
  // 三人场景与八人场景各用独立的码，避免共用同一批导致重复核销失败。
  const generated = await adminPost('/admin/codes', { count: 20, batch: 'concurrent' })
  const codes = generated.body?.codes ?? []
  check('生成 20 个激活码', codes.length === 20, `实际 ${codes.length}`)
  const threeCodes = codes.slice(0, 3)
  const eightCodes = codes.slice(3, 11)

  console.log('\n[1] 三人同时发起（同时核销 → 同时取链接 → 同时提交）')
  const three = await Promise.all([
    runUser('小王', threeCodes[0]),
    runUser('小李', threeCodes[1]),
    runUser('小张', threeCodes[2]),
  ])

  for (const t of three) {
    check(`${t.name} 激活成功`, t.activate?.body?.ok === true, JSON.stringify(t.activate?.body).slice(0, 140))
    check(`${t.name} 拿到会话`, typeof t.sessionId === 'string' && t.sessionId.length === 36)
    check(`${t.name} 拿到授权链接`, typeof t.authorizeUrl === 'string'
      && t.authorizeUrl.startsWith('https://platform.deepseek.com/dsh/authorize?'), String(t.authorizeUrl).slice(0, 80))
    check(`${t.name} 兑换成功`, t.callback?.status === 200 && t.callback?.body?.ok === true,
      JSON.stringify(t.callback?.body).slice(0, 160))
  }

  // 核心断言：三个人的关键标识必须两两不同
  const sessionIds = three.map((t) => t.sessionId)
  const authorizeUrls = three.map((t) => t.authorizeUrl)
  const deviceIds = three.map((t) => t.deviceId)
  const tickets = three.map((t) => t.activate?.body?.ticket)
  check('三人会话 ID 互不相同', new Set(sessionIds).size === 3, JSON.stringify(sessionIds))
  check('三人授权链接互不相同', new Set(authorizeUrls).size === 3)
  check('三人设备标识互不相同', new Set(deviceIds).size === 3)
  check('三人激活码互不相同', new Set(tickets).size === 3, JSON.stringify(tickets))

  // 每个人的会话状态必须只反映自己
  console.log('\n[2] 各自查状态，只能看到自己的结果')
  const statuses = await Promise.all(three.map((t) => post('/api/status', { session_id: t.sessionId, device_id: t.deviceId })))
  for (let i = 0; i < three.length; i += 1) {
    const t = three[i]
    const s = statuses[i]
    check(`${t.name} 会话状态为 done`, s.body?.phase === 'done', JSON.stringify(s.body).slice(0, 120))
    check(`${t.name} 能查到自己的结果`, s.body?.result?.hit === true)
  }
  const statusIds = statuses.map((s) => s.body?.session_id)
  check('状态查询返回的会话 ID 与请求一致',
    statusIds.every((id, i) => id === three[i].sessionId), JSON.stringify(statusIds))

  console.log('\n[3] 八人同时全流程')
  const eight = await Promise.all(NAMES.map((name, i) => runUser(name, eightCodes[i])))
  const okCount = eight.filter((t) => t.callback?.status === 200 && t.callback?.body?.ok === true).length
  check('八人全部兑换成功', okCount === NAMES.length, `成功 ${okCount}/${NAMES.length}`)
  const eightSessions = eight.map((t) => t.sessionId)
  check('八人会话 ID 全局唯一', new Set(eightSessions).size === NAMES.length)
  const eightUrls = eight.map((t) => t.authorizeUrl)
  check('八人授权链接全局唯一', new Set(eightUrls).size === NAMES.length, JSON.stringify(eightUrls.slice(0, 3)))
  const eightTickets = eight.map((t) => t.activate?.body?.ticket)
  check('八人激活码全局唯一', new Set(eightTickets).size === NAMES.length)
  const eightStates = eight.map((t) => t.state)
  check('八人 state 全局唯一', new Set(eightStates).size === NAMES.length)
  // 结果必须各归各：每个人的余额都来自自己的会话。
  const eightStatuses = await Promise.all(eight.map((t) => post('/api/status', { session_id: t.sessionId, device_id: t.deviceId })))
  check('八人各自的结果都归属正确',
    eightStatuses.every((s, i) => s.body?.session_id === eight[i].sessionId && s.body?.result?.hit === true))

  console.log('\n[4] 串号攻击：把别人的 state 塞进自己的会话')
  // 用小赵的 state 配小王的 session_id 提交——绝不能让攻击者的 code 被兑换。
  const otherState = eight[3].state
  const cross = await post('/api/callback', {
    session_id: three[0].sessionId,
    device_id: three[0].deviceId,
    callback_url: `http://127.0.0.1:1455/oauth/callback?code=ATTACKER&state=${otherState}`,
  })
  check('交叉提交不会污染已完成会话的结果',
    cross.body?.result?.hit === true || cross.status === 410 || cross.status === 400,
    `实际 ${cross.status} ${JSON.stringify(cross.body).slice(0, 120)}`)
  const stillMine = await post('/api/status', { session_id: three[0].sessionId, device_id: three[0].deviceId })
  check('小王的结果仍是自己的', stillMine.body?.result?.hit === true
    && stillMine.body?.session_id === three[0].sessionId)

  // 未完成会话上的 state 串号必须被拒。
  const codeZ = (await adminPost('/admin/codes', { count: 1 })).body?.codes?.[0]
  const devZ = crypto.randomUUID()
  const actZ = await post('/api/activate', { code: codeZ, device_id: devZ })
  const startZ = await post('/api/start', { ticket: actZ.body?.ticket, device_id: devZ })
  const badState = await post('/api/callback', {
    session_id: startZ.body?.session_id,
    device_id: devZ,
    callback_url: 'http://127.0.0.1:1455/oauth/callback?code=STOLEN&state=totally-wrong-state',
  })
  check('错误 state 被拒（400）', badState.status === 400 && badState.body?.error === 'state_mismatch',
    `实际 ${badState.status} ${JSON.stringify(badState.body).slice(0, 120)}`)
  const zStillWaiting = await post('/api/status', { session_id: startZ.body?.session_id, device_id: devZ })
  check('被拒后会话仍可正常重试', zStillWaiting.body?.phase === 'waiting', JSON.stringify(zStillWaiting.body).slice(0, 120))

  console.log('\n[5] 同一设备并发申请多个会话（应复用而非新建）')
  const deviceX = crypto.randomUUID()
  const codeX = (await adminPost('/admin/codes', { count: 1 })).body?.codes?.[0]
  const actX = await post('/api/activate', { code: codeX, device_id: deviceX })
  const sameDevice = await Promise.all(Array.from({ length: 6 }, () =>
    post('/api/start', { ticket: actX.body?.ticket, device_id: deviceX })))
  const sessionSet = new Set(sameDevice.map((r) => r.body?.session_id))
  check('同设备并发只产生一个会话', sessionSet.size === 1, `产生 ${sessionSet.size} 个会话`)
  check('同设备并发全部返回成功', sameDevice.every((r) => r.body?.ok === true))

  console.log('\n[6] 同一码被不同设备并发核销（应只有一个赢家）')
  const codeY = (await adminPost('/admin/codes', { count: 1 })).body?.codes?.[0]
  const race = await Promise.all(Array.from({ length: 8 }, () =>
    post('/api/activate', { code: codeY, device_id: crypto.randomUUID() })))
  const winners = race.filter((r) => r.body?.ok === true)
  check('并发核销只有一个赢家', winners.length === 1, `赢家 ${winners.length} 个`)
  const losers = race.filter((r) => r.body?.error === 'bound_elsewhere')
  check('其余全部被明确拒绝', losers.length === 7, `被拒 ${losers.length} 个`)
} catch (error) {
  failed += 1
  console.log(`\n测试中断：${error?.message ?? error}`)
} finally {
  try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  await sleep(300)
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 清理失败无妨 */ }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
