import { config } from './config.js'

const REQUEST_TIMEOUT_MS = 20_000

/**
 * `/api/callback` 要发起真实的平台调用：兑换（含 WAF 重试）加读余额，
 * 最坏可能到一两分钟。按 20 秒掐断的话，用户会看到「请求失败」
 * 而后端其实正在成功写库——这是最难解释的一类投诉。单独放宽。
 */
const CALLBACK_TIMEOUT_MS = 180_000

const timeoutFor = (path) => (path === '/api/callback' ? CALLBACK_TIMEOUT_MS : REQUEST_TIMEOUT_MS)

const DEVICE_KEY = 'dsh-bonus-device-id'

/**
 * 设备标识：浏览器本地生成的随机 UUID，存 localStorage。
 * 它是配额的计数键，不是密钥；清缓存会换新标识。
 */
export function loadDeviceId() {
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY)
    if (typeof stored === 'string' && /^[0-9a-f-]{36}$/i.test(stored)) return stored
  } catch { /* 隐私模式可能禁用 localStorage */ }
  const id = crypto.randomUUID()
  try { window.localStorage.setItem(DEVICE_KEY, id) } catch { /* 忽略 */ }
  return id
}

/**
 * 调后端。后端可能跨域，所以只用简单 JSON 请求。
 * @returns {Promise<{ok: boolean, status: number, body: any}>}
 */
export async function api(path, body) {
  if (config.backend === '') throw new Error('站点未配置后端地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutFor(path))
  try {
    const response = await fetch(`${config.backend}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON，交由调用方按状态码处理 */ }
    return { ok: response.ok, status: response.status, body: parsed }
  } finally {
    clearTimeout(timer)
  }
}
