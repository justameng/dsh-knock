/**
 * 端到端测试（全服务器版）。覆盖：
 *   - 激活码生命周期、并发核销、设备/IP 配额
 *   - 授权会话：发起、复用、状态、取消、过期
 *   - 回调地址解析的容错（整条 URL / 只有 query / 纯 code）
 *   - 回调提交的安全边界：state 校验、并发兑换、重复提交
 *   - 管理接口鉴权、限流
 *
 *   node tests/server.mjs
 *
 * 用隔离的数据目录和固定管理令牌，不碰任何真实数据。
 * 唯一会真的访问平台的是 /api/start（调用 auth_init），随后立刻取消。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseCallbackInput } from '../server/callback-url.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const PORT = 8789
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'test-admin-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-bonus-server-'))

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))

const get = (path, headers = {}) => fetch(`${BASE}${path}`, { headers })
  .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` }
const uuid = () => crypto.randomUUID()

const child = spawn(process.execPath, [join(WEB, 'server', 'index.mjs')], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_MAX_PER_DEVICE: '3',
    DSH_BONUS_MAX_PER_IP_DAY: '100',
    DSH_BONUS_MAX_STARTS_IP_MIN: '200',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '2000',
    DSH_BONUS_TRUST_PROXY: 'false',
    // 用平台替身：不消耗真实配额，响应确定，可重复跑。
    DSH_BONUS_TEST_DOUBLE: join(HERE, 'platform-double.mjs'),
  },
})

async function waitUp() {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(800) })
      if (response.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  return false
}

try {
  check('后端已监听', await waitUp())

  console.log('\n[1] 回调地址解析（纯函数，不依赖网络）')
  const variants = [
    ['整条 URL', 'http://127.0.0.1:1455/oauth/callback?code=abc123&state=st1', 'abc123', 'st1'],
    ['https URL', 'https://x.example/cb?code=abc123&state=st1', 'abc123', 'st1'],
    ['只有 query', 'code=abc123&state=st1', 'abc123', 'st1'],
    ['带问号 query', '?code=abc123&state=st1', 'abc123', 'st1'],
    ['缺 state', 'http://127.0.0.1:1455/oauth/callback?code=abc123', 'abc123', null],
    ['纯 code', 'I8QpcRxkNKjKUZz4lBbkJxmLypHhpomcmxUF5DXL_dE', 'I8QpcRxkNKjKUZz4lBbkJxmLypHhpomcmxUF5DXL_dE', null],
    ['前后有空格', '  http://127.0.0.1:1/cb?code=abc123&state=st1  ', 'abc123', 'st1'],
  ]
  for (const [label, input, wantCode, wantState] of variants) {
    const got = parseCallbackInput(input)
    check(`解析：${label}`, got.code === wantCode && (wantState === null || got.state === wantState),
      JSON.stringify(got))
  }
  check('空输入不炸', parseCallbackInput('').code === null)
  check('垃圾输入不炸', parseCallbackInput('这不是地址').code === null)
  check('undefined 不炸', parseCallbackInput(undefined).code === null)

  console.log('\n[2] 管理接口鉴权')
  check('无令牌被拒（401）', (await post('/admin/codes', { count: 1 })).status === 401)
  check('错令牌被拒（401）', (await post('/admin/codes', { count: 1 }, { authorization: 'Bearer wrong-token-here' })).status === 401)
  check('缺 Bearer 前缀被拒（401）', (await post('/admin/codes', { count: 1 }, { authorization: ADMIN_TOKEN })).status === 401)

  console.log('\n[3] 生成激活码')
  const generated = await post('/admin/codes', { count: 14, batch: 'test' }, admin)
  check('生成返回 200', generated.status === 200)
  const allCodes = generated.body?.codes ?? []
  check('生成 14 个', allCodes.length === 14, `实际 ${allCodes.length}`)
  check('格式形如 XXXX-XXXX-XXXX-XXXX', allCodes.every((c) => /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(c)), allCodes[0])
  check('不含易混字符 I/O/0/1', allCodes.every((c) => !/[IO01]/.test(c)))
  check('14 个互不相同', new Set(allCodes).size === 14)
  const codes = allCodes.slice(0, 4)
  const spare = allCodes.slice(4, 12)

  console.log('\n[4] 激活码核销')
  const deviceA = uuid()
  const act = await post('/api/activate', { code: codes[0], device_id: deviceA })
  check('核销成功（200）', act.status === 200, JSON.stringify(act.body).slice(0, 160))
  check('返回掩码而非明文', act.body?.code_masked === `${codes[0].slice(0, 4)}****${codes[0].slice(-4)}`)
  check('小写与空格可被接受', (await post('/api/activate', { code: ` ${codes[1].toLowerCase()} `, device_id: uuid() })).status === 200)
  const again = await post('/api/activate', { code: codes[0], device_id: deviceA })
  check('同码同设备幂等', again.status === 200 && again.body?.reused === true, JSON.stringify(again.body))
  const other = await post('/api/activate', { code: codes[0], device_id: uuid() })
  check('同码换设备被拒', other.status === 403 && other.body?.error === 'bound_elsewhere', JSON.stringify(other.body))

  console.log('\n[5] 无效输入')
  // 统一 403，不区分「不存在」与「已被占用」——状态码差异会被用来枚举激活码。
  check('不存在的码 → 403（与已占用同码，防枚举）',
    (await post('/api/activate', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', device_id: uuid() })).status === 403)
  check('非法设备标识 → 400', (await post('/api/activate', { code: codes[2], device_id: 'nope' })).status === 400)
  check('缺激活码 → 400', (await post('/api/activate', { device_id: uuid() })).status === 400)
  check('未知接口 → 404', (await post('/api/nonexistent', {})).status === 404)

  console.log('\n[6] 发起授权（平台调用走替身）')
  const noTicket = await post('/api/start', { device_id: deviceA })
  check('无凭据被拒', noTicket.status === 403 && noTicket.body?.error === 'not_found', JSON.stringify(noTicket.body))
  const wrongDevice = await post('/api/start', { ticket: codes[0], device_id: uuid() })
  check('凭据换设备被拒', wrongDevice.status === 403 && wrongDevice.body?.error === 'device_mismatch')

  const started = await post('/api/start', { ticket: codes[0], device_id: deviceA })
  check('发起授权成功', started.status === 200, JSON.stringify(started.body).slice(0, 200))
  check('返回平台授权链接', typeof started.body?.authorize_url === 'string'
    && started.body.authorize_url.startsWith('https://platform.deepseek.com/dsh/authorize?'), started.body?.authorize_url)
  check('授权链接无片段与内嵌凭据', !started.body.authorize_url.includes('#')
    && !/@/.test(started.body.authorize_url.split('?')[0]))
  check('返回会话 id', typeof started.body?.session_id === 'string' && started.body.session_id.length === 36)
  check('回调地址是回环地址', started.body?.callback_uri === 'http://127.0.0.1:1455/oauth/callback', String(started.body?.callback_uri))
  check('不下发 verifier 与 state', started.body?.code_verifier === undefined && started.body?.state_token === undefined)
  const sessionId = started.body.session_id

  const reusedStart = await post('/api/start', { ticket: codes[0], device_id: deviceA })
  check('重复发起复用同一会话', reusedStart.body?.session_id === sessionId && reusedStart.body?.reused === true,
    JSON.stringify(reusedStart.body).slice(0, 160))

  console.log('\n[7] 会话状态与取消')
  const status = await post('/api/status', { session_id: sessionId, device_id: deviceA })
  check('状态查询成功', status.status === 200 && status.body?.phase === 'waiting', JSON.stringify(status.body))
  check('状态不含凭据', status.body?.verifier === undefined && status.body?.state_token === undefined)
  check('未知会话 → 404', (await post('/api/status', { session_id: uuid(), device_id: deviceA })).status === 404)

  // 关键安全断言：会话必须绑定到创建设备。
  // 否则任何人拿到 session_id 就能读他人手机号与余额、甚至抢兑消耗他人的授权码。
  const otherDevice = uuid()
  const stolen = await post('/api/status', { session_id: sessionId, device_id: otherDevice })
  check('他人设备读会话 → 404（不暴露存在性）',
    stolen.status === 404 && stolen.body?.error === 'session_not_found', JSON.stringify(stolen.body))
  const stolenCallback = await post('/api/callback', {
    session_id: sessionId, device_id: otherDevice,
    callback_url: 'http://127.0.0.1:1455/oauth/callback?code=STEAL&state=x',
  })
  check('他人设备提交回调 → 404', stolenCallback.status === 404, JSON.stringify(stolenCallback.body))
  const stolenCancel = await post('/api/cancel', { session_id: sessionId, device_id: otherDevice })
  check('他人设备取消会话 → 静默成功但不生效', stolenCancel.status === 200)
  const afterStolenCancel = await post('/api/status', { session_id: sessionId, device_id: deviceA })
  check('他人取消未影响真实会话', afterStolenCancel.body?.phase === 'waiting', JSON.stringify(afterStolenCancel.body))

  const cancelled = await post('/api/cancel', { session_id: sessionId, device_id: deviceA })
  check('取消成功', cancelled.status === 200 && cancelled.body?.ok === true)
  const afterCancel = await post('/api/status', { session_id: sessionId, device_id: deviceA })
  check('取消后状态为 cancelled', afterCancel.body?.phase === 'cancelled', JSON.stringify(afterCancel.body))
  // 取消会释放激活码并回滚额度，因此同一个码可以被另一台设备重新核销。
  const useAfterCancel = await post('/api/activate', { code: codes[0], device_id: uuid() })
  check('取消后激活码被释放（可被他人核销）', useAfterCancel.status === 200, JSON.stringify(useAfterCancel.body))

  console.log('\n[8] 回调提交的安全边界')
  // 用全新的码，避免与 [7] 中已被释放的码串数据。
  const deviceB = uuid()
  const codeB = spare[0]
  const actB = await post('/api/activate', { code: codeB, device_id: deviceB })
  check('第二组激活码核销成功', actB.status === 200, JSON.stringify(actB.body).slice(0, 160))
  const s2 = await post('/api/start', { ticket: codeB, device_id: deviceB })
  const sid2 = s2.body?.session_id
  check('第二个会话已建立', typeof sid2 === 'string', JSON.stringify(s2.body).slice(0, 200))

  check('回调缺 session → 404', (await post('/api/callback', { callback_url: 'http://127.0.0.1:1/cb?code=a&state=b' })).status === 404)
  const unparsable = await post('/api/callback', { session_id: sid2, device_id: deviceB, callback_url: '这不是地址' })
  check('无法解析的地址 → 400', unparsable.status === 400 && unparsable.body?.error === 'callback_unparsable',
    JSON.stringify(unparsable.body))
  const stateMismatch = await post('/api/callback', {
    session_id: sid2, device_id: deviceB, callback_url: 'http://127.0.0.1:1455/oauth/callback?code=abc&state=WRONGSTATE',
  })
  check('state 错误 → 400', stateMismatch.status === 400 && stateMismatch.body?.error === 'state_mismatch',
    JSON.stringify(stateMismatch.body))

  // 关键安全断言：state 缺失必须被拒，不能跳过校验。
  // 曾经写成「parsed.state !== null 才校验」，导致用户提交一个不含 state
  // 的地址就能整段绕过 CSRF 防护。
  const stateMissing = await post('/api/callback', {
    session_id: sid2, device_id: deviceB, callback_url: 'http://127.0.0.1:1455/oauth/callback?code=abc',
  })
  check('state 缺失 → 400（不得跳过校验）',
    stateMissing.status === 400 && stateMissing.body?.error === 'state_mismatch',
    JSON.stringify(stateMissing.body))

  const stillWaiting = await post('/api/status', { session_id: sid2, device_id: deviceB })
  check('校验失败后会话仍可重试', stillWaiting.body?.phase === 'waiting', JSON.stringify(stillWaiting.body))

  console.log('\n[8b] 并发：多个请求同时兑换，共享同一次平台调用且结果一致')
  // 正确语义：N 个并发提交都得到**同一个结果**，而不是被拒绝。
  // 替身里 exchange 故意延时，确保并发真的重叠。
  // 必须带正确的 state——否则会在校验环节被拒，测不到并发共享。
  const realState = stillWaiting.body?.__state
  check('能取到会话 state（测试替身下发）', typeof realState === 'string' && realState.length > 0)
  const goodCallback = `http://127.0.0.1:1455/oauth/callback?code=GOODCODE123&state=${realState}`
  const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
    post('/api/callback', { session_id: sid2, device_id: deviceB, callback_url: goodCallback })))
  const statuses = concurrent.map((r) => r.status)
  check('并发提交全部返回 200（无一被拒）', statuses.every((s) => s === 200), JSON.stringify(statuses))
  check('并发提交结果完全一致',
    concurrent.every((r) => r.body?.ok === true && r.body?.result?.hit === true),
    JSON.stringify(concurrent.map((r) => r.body?.error ?? 'ok')))
  const sharers = concurrent.filter((r) => r.body?.shared === true)
  check('恰好一个请求实际执行兑换', sharers.length === 4, `共享标记 ${sharers.length} 个，独占 1 个`)

  const afterDone = await post('/api/status', { session_id: sid2, device_id: deviceB })
  check('会话进入 done', afterDone.body?.phase === 'done', JSON.stringify(afterDone.body).slice(0, 160))
  check('结果已落库且含赠金', afterDone.body?.result?.hit === true
    && afterDone.body?.result?.bonus_wallets?.[0]?.currency === 'CNY', JSON.stringify(afterDone.body?.result).slice(0, 200))

  console.log('\n[8c] 幂等：已完成的会话重复提交')
  const replay = await Promise.all(Array.from({ length: 3 }, () =>
    post('/api/callback', { session_id: sid2, device_id: deviceB, callback_url: goodCallback })))
  check('重复提交全部返回 200', replay.every((r) => r.status === 200), JSON.stringify(replay.map((r) => r.status)))
  check('幂等重放标记正确', replay.every((r) => r.body?.replayed === true))
  check('重放返回同一结果', replay.every((r) => r.body?.result?.hit === true))

  console.log('\n[8d] 失败路径与隔离')
  const codeC = spare[1]
  const deviceC = uuid()
  await post('/api/activate', { code: codeC, device_id: deviceC })
  const s3 = await post('/api/start', { ticket: codeC, device_id: deviceC })
  const sid3 = s3.body?.session_id
  check('第三个会话已建立', typeof sid3 === 'string')
  // 带正确 state，才能走到「兑换」这一步去测失败路径；
  // 不带 state 会在校验环节就被拒，测不到目标。
  const sid3State = (await post('/api/status', { session_id: sid3, device_id: deviceC })).body?.__state
  const fakeCallback = `http://127.0.0.1:1455/oauth/callback?code=FAKE${'x'.repeat(30)}&state=${sid3State}`
  const bad = await post('/api/callback', { session_id: sid3, device_id: deviceC, callback_url: fakeCallback })
  check('无效授权码 → 兑换失败', bad.status === 400 && bad.body?.error === 'exchange_failed', JSON.stringify(bad.body).slice(0, 200))
  const afterFail = await post('/api/status', { session_id: sid3, device_id: deviceC })
  check('失败后会话进入 failed', afterFail.body?.phase === 'failed', JSON.stringify(afterFail.body).slice(0, 160))
  check('失败原因有记录', typeof afterFail.body?.error?.detail === 'string')
  const reuseAfterFail = await post('/api/callback', { session_id: sid3, device_id: deviceC, callback_url: fakeCallback })
  check('失败会话重复提交返回 410', reuseAfterFail.status === 410, `实际 ${reuseAfterFail.status}`)
  // 关键隔离：失败会话不得影响已成功的会话。
  const doneStillOk = await post('/api/status', { session_id: sid2, device_id: deviceB })
  check('失败会话不影响已完成会话', doneStillOk.body?.phase === 'done' && doneStillOk.body?.result?.hit === true)

  console.log('\n[9] 设备配额')
  const deviceE = uuid()
  for (let index = 0; index < 3; index += 1) {
    const a = await post('/api/activate', { code: spare[4 + index], device_id: deviceE })
    if (index === 0) check('新设备首次核销成功', a.status === 200, JSON.stringify(a.body).slice(0, 160))
  }
  const overLimit = await post('/api/activate', { code: spare[7], device_id: deviceE })
  check('超出设备上限被拒', overLimit.status === 403 && overLimit.body?.error === 'device_limit', JSON.stringify(overLimit.body))

  console.log('\n[10] 作废')
  const more = await post('/admin/codes', { count: 1 }, admin)
  const victim = more.body?.codes?.[0]
  check('作废成功', (await post('/admin/revoke', { code: victim }, admin)).status === 200)
  const useRevoked = await post('/api/activate', { code: victim, device_id: uuid() })
  check('作废码不可用', useRevoked.status === 403 && useRevoked.body?.error === 'revoked', JSON.stringify(useRevoked.body))

  console.log('\n[11] 统计与列表')
  const stats = await get('/admin/stats', admin)
  check('统计接口可用', stats.status === 200 && typeof stats.body?.stats?.total === 'number', JSON.stringify(stats.body?.stats))
  const listed = await get('/admin/codes?state=unused&limit=5', admin)
  check('列表接口可用', listed.status === 200 && Array.isArray(listed.body?.codes))
  check('列表不含内部字段', listed.body?.codes?.every((row) => row.ticket === undefined))

  console.log('\n[12] CORS 与来源')
  const corsResponse = await fetch(`${BASE}/api/config`, { headers: { origin: 'https://evil.example' } })
  check('未授权来源不带 CORS 头', corsResponse.headers.get('access-control-allow-origin') === null)
  const preflight = await fetch(`${BASE}/api/activate`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  })
  check('未授权来源预检被拒（403）', preflight.status === 403, `实际 ${preflight.status}`)
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
