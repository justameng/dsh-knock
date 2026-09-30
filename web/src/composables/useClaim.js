import { computed, reactive } from 'vue'
import { api, loadDeviceId } from '../api.js'
import { site } from '../site.js'

/** 激活码功能是否启用。关闭后整个卡密环节跳过。 */
const codeRequired = () => site.value.code_required !== false

/**
 * 领取流程状态机。
 *
 * 阶段（phase）：
 *   terms    未同意协议
 *   code     待核销激活码（关闭激活码时不会进入）
 *   link     已拿到授权链接，等待用户去官方页面授权
 *   callback 已打开授权页，等待用户把回调地址粘贴回来
 *   done     已完成，展示余额
 *   error    出错，可重试
 *
 * 所有对后端的调用都收敛在这里，组件只负责渲染与事件。
 */
export function useClaim() {
  const state = reactive({
    phase: 'terms',
    deviceId: loadDeviceId(),

    // 激活码
    codeInput: '',
    activation: null,      // { code_masked }
    codeError: '',
    codeBusy: false,

    // 授权会话
    session: null,         // { session_id, authorize_url, expires_at }
    linkBusy: false,
    linkError: '',

    // 回调
    callbackInput: '',
    callbackError: '',
    callbackBusy: false,

    // 结果
    result: null,
    resultError: null,

    // 终局性拒绝：设备/激活码额度已用尽，做什么都没用，只能换设备或换人。
    // 与 codeError 的区别是「不可重试」——不该再引导用户去填码。
    blockedReason: '',

    // 倒计时剩余秒数
    secondsLeft: 0,
  })

  let timer = null

  function stopTimer() {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  function startTimer() {
    stopTimer()
    const tick = () => {
      if (state.session === null) { stopTimer(); return }
      const left = Math.max(0, Math.round((state.session.expires_at - Date.now()) / 1000))
      state.secondsLeft = left
      if (left === 0) {
        stopTimer()
        state.callbackError = '这次授权等待超时了，请重新获取授权链接。'
      }
    }
    tick()
    timer = setInterval(tick, 1000)
  }

  /**
   * 同意协议后的下一步。
   *
   * 需要激活码 → 进入核销环节；
   * 关闭激活码 → 直接去取授权链接，跳过整个卡密流程。
   */
  async function agreeTerms() {
    if (!codeRequired()) {
      state.phase = 'link'
      await requestLink()
      return
    }
    state.phase = 'code'
  }

  /** 核销激活码。 */
  async function activate() {
    if (!codeRequired()) {
      // 关闭卡密时不该走到这里；真走到了就直接进下一步，不报错。
      state.phase = 'link'
      await requestLink()
      return
    }
    const raw = state.codeInput.trim()
    if (raw === '') {
      state.codeError = '请先填写激活码。'
      return
    }
    state.codeBusy = true
    state.codeError = ''
    try {
      const response = await api('/api/activate', { code: raw, device_id: state.deviceId })
      if (!response.ok || response.body?.ok !== true) {
        const reason = response.body?.error
        // 终局性拒绝：设备额度已用尽。填任何码都不会变，直接给结论。
        if (reason === 'device_limit') {
          state.phase = 'blocked'
          state.blockedReason = response.body?.message
            ?? '这台设备已经领取过了。赠金是每台设备一次，换个设备或换个人来领。'
          return
        }
        state.codeError = response.body?.message ?? '激活码核销失败，请稍后重试。'
        return
      }
      state.activation = {
        code_masked: response.body.code_masked,
        // 后端已归一化，后续发起授权要用它，而不是用户原始输入。
        ticket: response.body.ticket,
      }
      state.phase = 'link'
      await requestLink()
    } catch (error) {
      state.codeError = `无法连接服务器：${error?.message ?? error}`
    } finally {
      state.codeBusy = false
    }
  }

  /** 向后端申请授权链接。 */
  async function requestLink() {
    // 开启激活码时必须有凭据；关闭时不需要，后端会跳过校验。
    if (codeRequired() && state.activation === null) return
    state.linkBusy = true
    state.linkError = ''
    try {
      const response = await api('/api/start', {
        ticket: state.activation?.ticket ?? '',
        device_id: state.deviceId,
      })
      const body = response.body
      if (!response.ok || body?.ok !== true) {
        state.linkError = body?.message ?? '获取授权链接失败，请稍后重试。'
        // 凭据失效（被释放/过期/被别人占用）：退回激活码步骤，让用户能重新核销，
        // 否则页面只剩一个点了也没用的按钮，用户彻底卡死。
        // 关闭激活码时不退回——那时没有核销环节可退。
        if (codeRequired()
          && ['not_active', 'not_found', 'device_mismatch', 'already_used', 'revoked', 'expired'].includes(body?.error)) {
          state.activation = null
          state.phase = 'code'
          state.codeError = body.message ?? '凭据已失效，请重新核销激活码。'
        }
        return
      }
      state.session = {
        session_id: body.session_id,
        authorize_url: body.authorize_url,
        expires_at: body.expires_at,
      }
      state.phase = 'callback'
      // 供自动化验证脚本读取（浏览器端调试用途）。
      window.__dshSessionId = body.session_id
      window.__dshAuthorizeUrl = body.authorize_url
      startTimer()
    } catch (error) {
      state.linkError = `无法连接服务器：${error?.message ?? error}`
    } finally {
      state.linkBusy = false
    }
  }

  /** 提交回调地址，完成兑换。 */
  async function submitCallback() {
    const raw = state.callbackInput.trim()
    if (raw === '') {
      state.callbackError = '请先粘贴浏览器地址栏里的那条地址。'
      return
    }
    if (state.session === null) {
      state.callbackError = '授权会话已失效，请重新获取授权链接。'
      return
    }
    state.callbackBusy = true
    state.callbackError = ''
    try {
      const response = await api('/api/callback', {
        session_id: state.session.session_id,
        // 带上设备标识：服务端会校验会话归属，防止别人拿到 session_id 抢兑
        device_id: state.deviceId,
        callback_url: raw,
      })
      const body = response.body
      if (!response.ok || body?.ok !== true) {
        state.callbackError = body?.message ?? '兑换失败，请检查地址是否完整。'
        // 兑换失败时把详情也留下来，便于用户反馈。
        state.resultError = body?.detail ? { detail: body.detail } : null

        // 会话已不可用（过期/失败/取消/设备不匹配）：留在 callback 阶段没有意义，
        // 所有按钮都会失败，用户卡死。主动退回 link 阶段，让他能重新发起。
        const deadSession = ['session_expired', 'session_not_found', 'session_done',
          'failed', 'expired', 'cancelled'].includes(body?.error)
        if (deadSession) {
          stopTimer()
          state.session = null
          state.callbackInput = ''
          state.phase = 'link'
        }
        return
      }
      stopTimer()
      state.result = body.result
      state.phase = 'done'
    } catch (error) {
      state.callbackError = `请求失败：${error?.message ?? error}`
    } finally {
      state.callbackBusy = false
    }
  }

  /**
   * 查这台设备与当前网络还能不能领。
   *
   * 纯预检：用于在用户填码之前就告诉他「额度已用尽」。
   * **失败不抛错也不阻塞**——预检是体验优化，真正的把关在后端。
   * 如果因为网络问题拿不到结果，就照常走流程，让后端去判断。
   *
   * @returns {Promise<{allowed: boolean, message: string, reason: string|null}|null>}
   */
  async function checkQuota() {
    try {
      const response = await api('/api/quota', { device_id: state.deviceId })
      if (!response.ok || response.body?.ok !== true) return null
      return {
        allowed: response.body.allowed === true,
        message: response.body.message ?? '',
        reason: response.body.reason ?? null,
      }
    } catch {
      return null
    }
  }

  /**
   * 取消本次授权并重新取一条链接。
   *
   * 后端会把激活码释放回 unused，所以**不能**拿旧 ticket 再取链接（会 not_active），
   * 需要重新核销一次。
   *
   * 关键：要区分「可恢复失败」与「终局性失败」。
   *   - 码被别人占用、码已作废 → 让用户换一个码，退回核销步骤是对的。
   *   - **设备额度已用尽** → 换什么码都没用，必须直接告诉他结论，
   *     否则用户会在「填码 → 被拒 → 再填」之间反复折腾。
   *     这正是「点重新获取链接后被判设备已领取」的真实体验问题。
   */
  async function cancel() {
    const sessionId = state.session?.session_id
    const code = state.codeInput.trim()
    stopTimer()
    state.session = null
    state.callbackInput = ''
    state.callbackError = ''
    state.linkError = ''
    state.phase = 'link'
    state.linkBusy = true

    try {
      if (sessionId !== undefined) {
        try { await api('/api/cancel', { session_id: sessionId, device_id: state.deviceId }) } catch { /* 取消失败不影响本地 */ }
      }

      // 关闭激活码时没有核销环节，直接重新取链接即可。
      if (!codeRequired()) {
        state.linkBusy = false
        await requestLink()
        return
      }

      // 重新核销同一个激活码：后端是幂等的，同码同设备会直接返回可用凭据。
      const again = await api('/api/activate', { code, device_id: state.deviceId })
      if (again.ok && again.body?.ok === true) {
        state.activation = { code_masked: again.body.code_masked, ticket: again.body.ticket }
        state.linkBusy = false
        await requestLink()
        return
      }

      const reason = again.body?.error
      // 终局性：这台设备已经领过，换码也没用。直接说清楚，不再让他填码。
      if (reason === 'device_limit' || reason === 'already_used') {
        state.activation = null
        state.phase = 'blocked'
        state.blockedReason = reason === 'device_limit'
          ? '这台设备已经领取过了。赠金是每台设备一次，换个设备或换个人来领。'
          : '这个激活码已经用过了。激活码是一人一码，请用你自己的。'
        return
      }

      // 可恢复：码被别人占用 / 已作废 / 已过期 → 退回核销步骤让用户换码
      state.activation = null
      state.phase = 'code'
      state.codeError = again.body?.message ?? '重新获取失败，请重新核销激活码。'
    } catch (error) {
      state.activation = null
      state.phase = codeRequired() ? 'code' : 'link'
      state.codeError = `无法连接服务器：${error?.message ?? error}`
    } finally {
      state.linkBusy = false
    }
  }

  /**
   * 步骤列表。关闭激活码时整段跳过核销步骤——
   * 不是隐藏文字，而是这一步真的不存在了。
   */
  const steps = computed(() => {
    const list = [{ key: 'terms', label: '阅读并同意协议' }]
    if (codeRequired()) list.push({ key: 'code', label: '核销激活码' })
    list.push({ key: 'link', label: '打开官方授权页' })
    list.push({ key: 'callback', label: '粘贴回调地址' })
    return list
  })

  /**
   * 当前步骤在流程里的序号，用于步骤条高亮。
   *
   * `blocked` 是流程外的终止态，不属于任何一步——返回 -1，
   * 步骤条会全部失去高亮，正好表达「这条路走不通了」。
   * 显式列出它而不是靠 indexOf 自然落空，是为了让意图可读。
   */
  const stepIndex = computed(() => {
    if (state.phase === 'blocked') return -1
    const order = codeRequired()
      ? ['terms', 'code', 'link', 'callback', 'done']
      : ['terms', 'link', 'callback', 'done']
    return order.indexOf(state.phase)
  })

  return {
    // 注意：不能用 readonly() 包。输入框用 v-model 双向绑定，readonly 会让写入静默失效。
    // 状态修改仍统一走下面这几个 action，组件不直接改语义字段。
    state,
    steps,
    stepIndex,
    codeRequired,
    checkQuota,
    agreeTerms,
    activate,
    requestLink,
    submitCallback,
    cancel,
  }
}
