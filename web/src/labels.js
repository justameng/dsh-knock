/**
 * 后台展示用的文案映射。
 *
 * 后端存的是稳定的英文标识（便于日志检索与程序判断），
 * 但后台是给人看的，必须翻译成人话，并把技术细节藏到提示里。
 */

/** 请求流水结果码 → 中文说明。 */
export const OUTCOME_LABELS = {
  activated: { label: '激活码核销成功', hint: '用户填对激活码，成功绑定设备', tone: 'ok' },
  started: { label: '已发起授权', hint: '拿到平台授权链接，等待用户去登录授权', tone: 'ok' },
  rate_limited: { label: '被限流拦截', hint: '同一 IP 短时间内请求过多', tone: 'warn' },

  // auth_init 失败时会写成 `init_<kind>`，kind 取自 PlatformError：
  // network / protocol / auth / business / waf / unexpected
  init_network: { label: '发起授权失败：网络问题', hint: '无法连接平台，或请求超时', tone: 'warn' },
  init_protocol: { label: '发起授权失败：协议异常', hint: '平台返回了非预期内容，可能是风控挑战', tone: 'warn' },
  init_auth: { label: '发起授权失败：鉴权问题', hint: '平台拒绝了请求的客户端标识', tone: 'bad' },
  init_business: { label: '发起授权失败：平台拒绝', hint: '平台业务层拒绝，常见原因是限流（RATE_LIMITED）', tone: 'warn' },
  init_waf: { label: '发起授权失败：风控拦截', hint: '被平台风控挑战，重试后仍未通过', tone: 'warn' },
  init_unexpected: { label: '发起授权失败：未知错误', hint: '未归类的异常，需要看日志', tone: 'bad' },

  not_active: { label: '凭据状态异常', hint: '激活码不在「已绑定」状态，通常是被释放或已使用', tone: 'bad' },
  not_found: { label: '激活码不存在', hint: '用户输入的激活码在库中查不到', tone: 'bad' },
  bound_elsewhere: { label: '激活码已被他人绑定', hint: '同一个码被另一台设备先核销了', tone: 'bad' },
  already_used: { label: '激活码已使用', hint: '该码已经完成过领取', tone: 'bad' },
  revoked: { label: '激活码已作废', hint: '该码被管理员作废', tone: 'bad' },
  expired: { label: '激活码已过期', hint: '超过有效期', tone: 'bad' },
  device_mismatch: { label: '设备不匹配', hint: '凭据与当前设备不一致', tone: 'bad' },
  invalid_device: { label: '设备标识格式错误', hint: '前端传来的设备标识不合法', tone: 'bad' },
  invalid_code: { label: '激活码格式错误', hint: '输入为空或格式不对', tone: 'bad' },
  device_limit: { label: '超出每设备限额', hint: '该设备领取次数已用尽', tone: 'warn' },
  ip_limit: { label: '超出每 IP 每日限额', hint: '同一网络当天领取次数用尽', tone: 'warn' },
}

/**
 * 结果码 → 中文。
 *
 * `known` 是显式标记，不要靠比对 `hint` 文案来判断是否认识这个码——
 * 那样改一个字就静默改了逻辑分支，而且没有任何测试会失败。
 */
export function outcomeLabel(code) {
  const found = OUTCOME_LABELS[code]
  if (found !== undefined) return { ...found, known: true }
  // 未映射的码原样显示，便于发现新增枚举没同步（契约测试也会报出来）
  return { label: code, hint: '未知结果（映射表未覆盖，请补充）', tone: '', known: false }
}

/** 会话状态 → 中文。 */
export const PHASE_LABELS = {
  waiting: { label: '等待回调', tone: 'warn' },
  exchanging: { label: '兑换中', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  expired: { label: '已过期', tone: 'warn' },
  cancelled: { label: '已取消', tone: '' },
}

export const phaseLabel = (phase) => PHASE_LABELS[phase] ?? { label: phase, tone: '' }

/** 激活码状态 → 中文。 */
export const CODE_STATE_LABELS = {
  unused: { label: '未使用', tone: 'ok' },
  active: { label: '已绑定', tone: 'warn' },
  used: { label: '已领取', tone: 'accent' },
  revoked: { label: '已作废', tone: '' },
}

export const codeStateLabel = (state) => CODE_STATE_LABELS[state] ?? { label: state, tone: '' }

/** 审计动作 → 中文。 */
export const ACTION_LABELS = {
  'code.generate': '生成激活码',
  'code.revoke': '作废激活码',
  'code.revoke_batch': '批量作废',
  'code.purge': '清理激活码',
  'record.delete': '删除明细记录',
  'record.purge': '清空明细记录',
  'quota.reset_ip': '重置 IP 额度',
  'quota.reset_device': '重置设备额度',
  'settings.update': '修改站点配置',
  'admin.unauthorized': '未授权访问后台',
}

export const actionLabel = (action) => ACTION_LABELS[action] ?? action

/**
 * 部署模式 → 中文。
 * 必须与后端 server/client-ip.mjs 的 HEADER_CHAIN 键名一致，
 * 漏一个会显示成兜底文案，误导排查方向。
 */
export const DEPLOY_MODE_LABELS = {
  auto: '自动识别 CDN',
  edgeone: 'EdgeOne 加速',
  cloudflare: 'Cloudflare 加速',
  nginx: 'Nginx 反代',
  direct: '直连（不信任代理头）',
}

export const deployModeLabel = (mode) => DEPLOY_MODE_LABELS[mode] ?? `${mode}（未知模式）`

/** 审计对象里可能出现英文标识，一并翻译。 */
export function auditTarget(target) {
  if (target === null || target === undefined || target === '') return '—'
  return CODE_STATE_LABELS[target]?.label ?? target
}

/** 时间戳格式化，统一到秒。 */
export function formatTime(ms, { withDate = true } = {}) {
  if (ms === null || ms === undefined || ms === '') return '—'
  const options = { hour12: false, hour: '2-digit', minute: '2-digit' }
  if (withDate) { options.month = '2-digit'; options.day = '2-digit' }
  return new Date(Number(ms)).toLocaleString('zh-CN', options)
}
