/**
 * 管理后台接口测试。
 *
 *   node tests/admin.mjs
 *
 * 覆盖：鉴权、概览统计、卡密增删查、批量作废、清理、
 *       领取记录落库、明细接口、站点文案读写。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const PORT = 8793
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_TOKEN = 'admin-test-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-bonus-admin-'))

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const headers = (auth = true) => ({
  'content-type': 'application/json',
  ...(auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
})

const post = (path, body, auth = true) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: headers(auth), body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const get = (path, auth = true) => fetch(`${BASE}${path}`, { headers: headers(auth) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

const child = spawn(process.execPath, [join(WEB, 'server', 'index.mjs')], {
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_MAX_PER_DEVICE: '5',
    DSH_BONUS_MAX_PER_IP_DAY: '100',
    DSH_BONUS_MAX_STARTS_IP_MIN: '500',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '5000',
    DSH_BONUS_DEPLOY_MODE: 'cloudflare',
    DSH_BONUS_TEST_DOUBLE: join(HERE, 'platform-double.mjs'),
  },
})

async function waitUp() {
  for (let index = 0; index < 80; index += 1) {
    try {
      const r = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(800) })
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  return false
}

try {
  check('后端已监听', await waitUp())

  console.log('\n[1] 鉴权')
  check('无令牌 401', (await get('/admin/overview', false)).status === 401)
  check('错令牌 401', (await fetch(`${BASE}/admin/overview`, {
    headers: { authorization: 'Bearer wrong-token-abcdefgh' },
  })).status === 401)
  check('正确令牌可访问', (await get('/admin/overview')).status === 200)
  check('未授权访问被记入审计',
    (await get('/admin/audit')).body?.audit?.some((row) => row.action === 'admin.unauthorized'))

  console.log('\n[2] 概览统计')
  const overview = await get('/admin/overview')
  check('返回 dashboard', typeof overview.body?.dashboard === 'object')
  check('返回趋势数据', Array.isArray(overview.body?.daily))
  check('返回结果分布', Array.isArray(overview.body?.outcomes))
  const d = overview.body?.dashboard
  check('含激活码分组', typeof d?.codes?.total === 'number')
  check('含领取分组', typeof d?.redemption?.today === 'number')
  check('含流量分组', typeof d?.traffic?.devices === 'number')
  check('配额回填每 IP 每天', d?.quota?.max_per_ip_day === 100, String(d?.quota?.max_per_ip_day))
  check('部署模式为 cloudflare', d?.deploy?.mode === 'cloudflare', String(d?.deploy?.mode))

  // 部署模式必须能被前端翻译成中文；漏项会显示成兜底文案，误导排查方向。
  // 这里校验后端给出的 mode 一定在前端映射表里。
  const MODE_LABELS = ['auto', 'edgeone', 'cloudflare', 'nginx', 'direct']
  check('部署模式是已知值', MODE_LABELS.includes(d?.deploy?.mode), String(d?.deploy?.mode))

  console.log('\n[3] 批量生成')
  const gen = await post('/admin/codes', { count: 25, batch: '测试批次', note: '管理后台测试' })
  check('生成成功', gen.status === 200 && gen.body?.ok === true)
  const codes = gen.body?.codes ?? []
  check('生成 25 个', codes.length === 25, `实际 ${codes.length}`)
  check('格式正确', codes.every((c) => /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(c)))
  check('生成被记入审计',
    (await get('/admin/audit')).body?.audit?.some((row) => row.action === 'code.generate'))
  check('数量上限被夹紧（请求 9999 → 最多 500）',
    (await post('/admin/codes', { count: 9999 })).body?.count <= 500)

  console.log('\n[4] 列表与筛选')
  const all = await get('/admin/codes?limit=100')
  check('列表返回数据', (all.body?.codes ?? []).length >= 25)
  check('列表含统计', typeof all.body?.stats?.total === 'number')
  check('按状态筛选', (await get('/admin/codes?state=unused&limit=5')).body?.codes?.every((r) => r.state === 'unused'))
  check('按批次筛选', (await get('/admin/codes?batch=测试批次&limit=100')).body?.codes?.length === 25)
  check('列表不下发敏感字段', all.body?.codes?.every((r) => r.ticket === undefined))

  console.log('\n[5] 跑一次完整领取（用替身）')
  const deviceId = crypto.randomUUID()
  const code = codes[0]
  const activated = await post('/api/activate', { code, device_id: deviceId }, false)
  check('核销成功', activated.body?.ok === true)
  const started = await post('/api/start', { ticket: code, device_id: deviceId }, false)
  check('发起授权成功', started.body?.ok === true)
  const status = await post('/api/status', { session_id: started.body?.session_id, device_id: deviceId }, false)
  const stateToken = status.body?.__state
  const done = await post('/api/callback', {
    session_id: started.body?.session_id,
    device_id: deviceId,
    callback_url: `http://127.0.0.1:1455/oauth/callback?code=GOODCODE&state=${stateToken}`,
  }, false)
  check('兑换成功', done.status === 200 && done.body?.ok === true, JSON.stringify(done.body).slice(0, 140))

  console.log('\n[6] 领取记录落库')
  const redemptions = await get('/admin/redemptions?limit=10')
  check('领取记录可查', (redemptions.body?.redemptions ?? []).length >= 1)
  const row = redemptions.body?.redemptions?.[0]
  check('记录含激活码', row?.code === code, String(row?.code))
  check('记录含账号', typeof row?.contact === 'string', String(row?.contact))
  check('记录含赠金金额', row?.bonus_cny !== null && row?.bonus_cny !== undefined)
  check('记录判定为已到账', row?.hit === 1, String(row?.hit))
  check('记录含 IP', typeof row?.ip === 'string' && row.ip.length > 0, String(row?.ip))
  check('记录含活动名', row?.campaign === 'dsh_login_bonus', String(row?.campaign))
  const afterRedemption = await get('/admin/overview')
  check('概览的领取数已更新', afterRedemption.body?.dashboard?.redemption?.total >= 1)
  check('概览的今日领取已更新', afterRedemption.body?.dashboard?.redemption?.today >= 1)

  console.log('\n[7] 其它明细接口')
  check('会话明细可查', (await get('/admin/sessions?limit=10')).body?.sessions?.length >= 1)
  check('会话明细含状态', typeof (await get('/admin/sessions?limit=1')).body?.sessions?.[0]?.phase === 'string')
  check('会话按状态筛选', (await get('/admin/sessions?phase=done&limit=10')).body?.sessions?.every((r) => r.phase === 'done'))
  check('设备明细可查', (await get('/admin/devices?limit=10')).body?.devices?.length >= 1)
  check('请求流水可查', (await get('/admin/attempts?limit=10')).body?.attempts?.length >= 1)
  check('审计日志可查', (await get('/admin/audit?limit=10')).body?.audit?.length >= 1)

  console.log('\n[8] 作废与批量作废')
  const target = codes[1]
  check('单个作废成功', (await post('/admin/revoke', { code: target })).body?.ok === true)
  const batch = await post('/admin/revoke-batch', { codes: [codes[2], codes[3], codes[4]] })
  check('批量作废成功', batch.body?.ok === true && batch.body?.revoked === 3, JSON.stringify(batch.body))
  check('批量作废空数组被拒', (await post('/admin/revoke-batch', { codes: [] })).status === 400)
  const revokedState = await get(`/admin/codes?state=revoked&limit=100`)
  check('已作废可筛出', revokedState.body?.codes?.length >= 4)

  console.log('\n[9] 清理')
  const purge = await post('/admin/purge', { state: 'revoked' })
  check('清理已作废成功', purge.body?.ok === true && purge.body?.purged >= 4, JSON.stringify(purge.body))
  check('非法状态被拒', (await post('/admin/purge', { state: 'active' })).status === 400)

  console.log('\n[10] 站点文案')
  const saved = await post('/admin/settings', {
    site_name: '测试公益站',
    site_url: 'https://test.example',
    code_source: '测试渠道',
    bonus_validity: '3 天',
    tutorial: '第一步\n第二步\n第三步',
    announce: '测试公告',
  })
  check('保存成功', saved.body?.ok === true, JSON.stringify(saved.body).slice(0, 140))
  check('返回已更新项', (saved.body?.changed ?? []).length === 6, JSON.stringify(saved.body?.changed))
  const reread = await get('/admin/settings')
  check('回读站点名', reread.body?.site?.site_name === '测试公益站')
  check('回读教程', reread.body?.site?.tutorial === '第一步\n第二步\n第三步')
  check('文案变更被记入审计',
    (await get('/admin/audit')).body?.audit?.some((r) => r.action === 'settings.update'))

  // 前台应能读到新文案
  const publicConfig = await get('/api/config', false)
  check('前台配置暴露站点文案', publicConfig.body?.site?.site_name === '测试公益站')
  check('前台配置暴露每 IP 每天限额', publicConfig.body?.max_per_ip_day === 100)
  check('前台配置不下发管理令牌', publicConfig.body?.admin_token === undefined)

  console.log('\n[12] 明细记录的删除与清空')
  // 先造一条审计记录，确认删除生效
  const before = (await get('/admin/audit?limit=200')).body?.audit ?? []
  check('审计记录可读', before.length > 0, `共 ${before.length} 条`)
  const victimId = before[0].id
  const del = await post('/admin/records/delete', { table: 'audit', ids: [victimId] })
  check('删除单条记录成功', del.body?.ok === true && del.body?.deleted === 1, JSON.stringify(del.body))
  const afterDel = (await get('/admin/audit?limit=200')).body?.audit ?? []
  check('记录确实被删除', !afterDel.some((r) => r.id === victimId))
  check('删除操作本身被记入审计',
    afterDel.some((r) => r.action === 'record.delete'))

  // 清空 attempts 表
  const purgeAttempts = await post('/admin/records/purge', { table: 'attempts' })
  check('清空请求流水成功', purgeAttempts.body?.ok === true && purgeAttempts.body?.purged >= 1,
    JSON.stringify(purgeAttempts.body))
  const afterPurge = (await get('/admin/attempts?limit=10')).body?.attempts ?? []
  check('请求流水已清空', afterPurge.length === 0, `还剩 ${afterPurge.length} 条`)

  // 安全边界：不允许清空 codes 表（激活码是业务凭证）
  const purgeCodes = await post('/admin/records/purge', { table: 'codes' })
  check('禁止清空激活码表', purgeCodes.status === 400, `实际 ${purgeCodes.status}`)
  const codesStillThere = await get('/admin/codes?limit=10')
  check('激活码未被清空', (codesStillThere.body?.codes ?? []).length > 0)
  // 不允许任意表名
  check('禁止清空未知表', (await post('/admin/records/purge', { table: 'settings' })).status === 400)
  check('禁止删除未知表记录', (await post('/admin/records/delete', { table: 'sqlite_master', ids: [1] })).status === 400)
  check('空 ids 被拒', (await post('/admin/records/delete', { table: 'audit', ids: [] })).status === 400)

  console.log('\n[13] 额度管理')
  const quotaList = await get('/admin/ip-quota?limit=50')
  check('IP 额度可查', quotaList.status === 200 && Array.isArray(quotaList.body?.quota), JSON.stringify(quotaList.body).slice(0, 140))
  check('返回限额配置', typeof quotaList.body?.limits?.max_per_ip_day === 'number')
  const quotaRows = quotaList.body?.quota ?? []
  check('已有额度记录（前面跑过领取）', quotaRows.length > 0, `共 ${quotaRows.length} 条`)
  const targetIp = quotaRows[0]?.ip
  const targetDay = quotaRows[0]?.day
  check('记录含 IP 与日期', typeof targetIp === 'string' && typeof targetDay === 'string')

  if (targetIp !== undefined) {
    const resetOne = await post('/admin/reset-ip', { ip: targetIp, day: targetDay })
    check('重置单个 IP 额度成功', resetOne.body?.ok === true && resetOne.body?.cleared >= 1, JSON.stringify(resetOne.body))
    const afterReset = await get('/admin/ip-quota?limit=50')
    const stillThere = (afterReset.body?.quota ?? []).some((r) => r.ip === targetIp && r.day === targetDay)
    check('该 IP 该日的记录已消失', !stillThere)
    check('重置操作被记入审计',
      (await get('/admin/audit')).body?.audit?.some((r) => r.action === 'quota.reset_ip'))
  }

  // 参数校验
  check('缺 IP 且未指定 all 被拒', (await post('/admin/reset-ip', {})).status === 400)

  // 设备额度重置
  const deviceList = await get('/admin/devices?limit=5')
  const targetDevice = deviceList.body?.devices?.[0]?.device_id
  check('有设备记录可测', typeof targetDevice === 'string', String(targetDevice))
  if (typeof targetDevice === 'string') {
    const resetDevice = await post('/admin/reset-device', { device_id: targetDevice })
    check('重置设备额度成功', resetDevice.body?.ok === true, JSON.stringify(resetDevice.body))
    const afterDevice = await get('/admin/devices?limit=100')
    check('该设备记录已消失', !(afterDevice.body?.devices ?? []).some((d) => d.device_id === targetDevice))
  }
  check('非法设备标识被拒', (await post('/admin/reset-device', { device_id: 'nope' })).status === 400)

  // 清空全部
  const resetAll = await post('/admin/reset-ip', { all: true })
  check('清空全部 IP 额度成功', resetAll.body?.ok === true, JSON.stringify(resetAll.body))
  const afterAll = await get('/admin/ip-quota?limit=50')
  check('全部额度已清空', (afterAll.body?.quota ?? []).length === 0, `还剩 ${(afterAll.body?.quota ?? []).length} 条`)

  console.log('\n[14] 会话有效期不超过平台限制')
  // 平台签发的授权码只有 600 秒有效，会话有效期必须不大于它，
  // 否则页面倒计时会显示超过真实可用时间，用户在最后一刻提交才发现过期。
  // 用新码 + 新设备，避免撞上前面的配额与绑定。
  const ttlCode = (await post('/admin/codes', { count: 1 })).body?.codes?.[0]
  const ttlDevice = crypto.randomUUID()
  const ttlAct = await post('/api/activate', { code: ttlCode, device_id: ttlDevice }, false)
  check('额度测试用激活码已核销', ttlAct.body?.ok === true, JSON.stringify(ttlAct.body).slice(0, 140))
  const startedForTtl = await post('/api/start', { ticket: ttlCode, device_id: ttlDevice }, false)
  if (startedForTtl.body?.ok === true) {
    const ttlMs = Number(startedForTtl.body.expires_at) - Date.now()
    check('会话有效期 ≤ 600 秒（平台授权码上限）', ttlMs <= 600_000 + 5000, `实际 ${Math.round(ttlMs / 1000)} 秒`)
    check('会话有效期 > 60 秒（够用户操作）', ttlMs > 60_000, `实际 ${Math.round(ttlMs / 1000)} 秒`)
  } else {
    check('会话已建立（用于测有效期）', false, JSON.stringify(startedForTtl.body).slice(0, 140))
  }

  console.log('\n[15] 功能开关：激活码校验')
  // 默认开启
  const cfgOn = await get('/api/config', false)
  check('默认开启激活码校验', cfgOn.body?.site?.code_required === true, String(cfgOn.body?.site?.code_required))

  // 关闭
  const off = await post('/admin/settings', { code_required: 'false' })
  check('可关闭激活码校验', off.body?.ok === true && off.body?.site?.code_required === false,
    JSON.stringify(off.body?.site?.code_required))

  const cfgOff = await get('/api/config', false)
  check('前台配置反映关闭状态', cfgOff.body?.site?.code_required === false)

  // 关闭后：核销接口应拒绝
  const activateWhenOff = await post('/api/activate', { code: 'AAAA-AAAA-AAAA-AAAA', device_id: crypto.randomUUID() }, false)
  check('关闭后核销接口被拒', activateWhenOff.status === 403 && activateWhenOff.body?.error === 'code_disabled',
    JSON.stringify(activateWhenOff.body))

  // 关闭后：不带凭据也能发起授权（这是核心行为）
  const devNoCode = crypto.randomUUID()
  const startNoCode = await post('/api/start', { device_id: devNoCode }, false)
  check('关闭后无需凭据即可发起授权', startNoCode.status === 200 && startNoCode.body?.ok === true,
    JSON.stringify(startNoCode.body).slice(0, 160))
  check('仍返回授权链接', typeof startNoCode.body?.authorize_url === 'string'
    && startNoCode.body.authorize_url.startsWith('https://platform.deepseek.com/'))
  check('仍返回会话 id', typeof startNoCode.body?.session_id === 'string')

  // 关闭后：设备额度仍然生效（这是唯一的额度依据）
  check('关闭后仍要求 device_id', (await post('/api/start', {}, false)).status === 400)

  // 重新开启
  const backOn = await post('/admin/settings', { code_required: 'true' })
  check('可重新开启激活码校验', backOn.body?.site?.code_required === true)
  const activateAfterOn = await post('/api/activate', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', device_id: crypto.randomUUID() }, false)
  // 重新开启后，不存在的码统一返回 403（与「已被占用」同码，防枚举）
  check('重新开启后核销接口恢复', activateAfterOn.status === 403, `实际 ${activateAfterOn.status}`)

  console.log('\n[16] 公告弹窗配置')
  const announce = await post('/admin/settings', {
    announce_enabled: 'true',
    announce_title: '测试公告',
    announce: '这是公告正文\n第二行',
    announce_link_text: '加入群聊',
    announce_link_url: 'https://example.com/group',
    announce_frequency: 'daily',
  })
  check('公告配置可保存', announce.body?.ok === true, JSON.stringify(announce.body?.changed))
  const cfgAnnounce = await get('/api/config', false)
  const a = cfgAnnounce.body?.site
  check('前台读到公告开关', a?.announce_enabled === true)
  check('前台读到公告标题', a?.announce_title === '测试公告')
  check('前台读到公告正文（含换行）', a?.announce === '这是公告正文\n第二行', JSON.stringify(a?.announce))
  check('前台读到跳转按钮', a?.announce_link_text === '加入群聊' && a?.announce_link_url === 'https://example.com/group')
  check('前台读到弹出频率', a?.announce_frequency === 'daily', String(a?.announce_frequency))

  // 关闭公告
  const announceOff = await post('/admin/settings', { announce_enabled: 'false' })
  check('公告可关闭', announceOff.body?.site?.announce_enabled === false)
  // 内容仍在（只是不显示），便于下次开启时复用
  check('关闭后内容仍保留', announceOff.body?.site?.announce === '这是公告正文\n第二行')

  console.log('\n[17] 未知接口')
  check('未知管理接口 404', (await get('/admin/nonexistent')).status === 404)
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
