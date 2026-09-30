/**
 * 把平台返回的余额字符串规范化成人类可读形式。
 * 实测平台返回的是高精度十进制串（如 6.0000000000000000、0E-16），
 * 直接渲染没法看。
 */
export function formatAmount(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return '—'
  const number = Number(raw)
  if (!Number.isFinite(number)) return raw
  if (number === 0) return '0'
  return number.toFixed(Math.abs(number) >= 1 ? 4 : 8).replace(/\.?0+$/, '')
}

/** 毫秒差格式化成 mm:ss。 */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
