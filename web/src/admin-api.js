/**
 * 管理后台 API 客户端。
 *
 * 令牌存在 sessionStorage：关掉标签页即失效，比 localStorage 更安全。
 * 所有管理接口都要求 Authorization: Bearer <令牌>。
 */
import { config } from './config.js'

const TOKEN_KEY = 'dsh-bonus-admin-token'
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 令牌失效时的回调。由 AdminApp 注册，用于把用户踢回登录页。
 * 各个子组件不必自己判断 401 —— 那是重复劳动，而且容易漏。
 */
let onUnauthorized = null
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler
}

export function getToken() {
  try { return window.sessionStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}

export function setToken(token) {
  try { window.sessionStorage.setItem(TOKEN_KEY, token) } catch { /* 隐私模式 */ }
}

export function clearToken() {
  try { window.sessionStorage.removeItem(TOKEN_KEY) } catch { /* 忽略 */ }
}

/**
 * 发一次请求。
 *
 * **永不抛异常**——网络失败、超时、JSON 解析失败都归一成
 * `{ ok: false, status: 0, error: '网络请求失败' }`。
 * 这样调用方只需要判断 `result.ok`，不必在每个组件里写 try/catch。
 * 曾经各 admin 组件只有 try/finally 没有 catch，fetch 抛错就变成
 * unhandled rejection，用户界面上什么都没发生——最难排查的那种故障。
 */
async function request(method, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.backend}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${getToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    // 令牌失效：统一交给上层处理（踢回登录页），组件不用各自判断
    if (response.status === 401) {
      if (onUnauthorized !== null) onUnauthorized()
      return { ok: false, status: 401, body: null, error: '登录已过期，请重新登录。' }
    }

    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
    return { ok: response.ok, status: response.status, body: parsed }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      body: null,
      error: aborted
        ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），服务器可能正忙。`
        : `无法连接服务器：${error?.message ?? error}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 校验令牌是否有效：调用一个轻量只读接口。 */
export async function verifyToken() {
  const result = await request('GET', '/admin/stats')
  if (result.status === 401) return { ok: false, reason: 'unauthorized' }
  // status 0 表示网络层失败（连不上、超时）
  if (result.status === 0) return { ok: false, reason: 'network', message: result.error }
  if (!result.ok) return { ok: false, reason: 'network' }
  return { ok: true }
}

export const adminApi = {
  overview: () => request('GET', '/admin/overview'),
  codes: (params = {}) => request('GET', `/admin/codes?${new URLSearchParams(params)}`),
  redemptions: (params = {}) => request('GET', `/admin/redemptions?${new URLSearchParams(params)}`),
  sessions: (params = {}) => request('GET', `/admin/sessions?${new URLSearchParams(params)}`),
  devices: (params = {}) => request('GET', `/admin/devices?${new URLSearchParams(params)}`),
  attempts: (params = {}) => request('GET', `/admin/attempts?${new URLSearchParams(params)}`),
  audit: (params = {}) => request('GET', `/admin/audit?${new URLSearchParams(params)}`),
  ipQuota: (params = {}) => request('GET', `/admin/ip-quota?${new URLSearchParams(params)}`),
  settings: () => request('GET', '/admin/settings'),

  generate: (payload) => request('POST', '/admin/codes', payload),
  revoke: (code) => request('POST', '/admin/revoke', { code }),
  revokeBatch: (codes) => request('POST', '/admin/revoke-batch', { codes }),
  purge: (state) => request('POST', '/admin/purge', { state }),
  saveSettings: (payload) => request('POST', '/admin/settings', payload),

  /** 删除单条或多条明细记录。 */
  deleteRecords: (table, ids) => request('POST', '/admin/records/delete', { table, ids }),
  /** 清空某张明细表。 */
  purgeRecords: (table) => request('POST', '/admin/records/purge', { table }),

  /** 重置 IP 每日额度。all:true 表示清空全部。 */
  resetIp: (payload) => request('POST', '/admin/reset-ip', payload),
  /** 重置设备额度。 */
  resetDevice: (deviceId) => request('POST', '/admin/reset-device', { device_id: deviceId }),
}
