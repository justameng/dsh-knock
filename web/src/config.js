/**
 * 站点配置。
 *
 * 后端地址优先从 window.__DSH_BONUS_CONFIG__ 读取（运行时注入，部署后改配置不用重新构建），
 * 其次读构建时的 VITE_BACKEND，最后留空（页面会提示未配置）。
 *
 * 文案类配置（站点名、激活码渠道、教程等）已迁移到后端，见 main.js 的 site。
 * 这样管理后台可以直接改，无需重新构建。
 */
const runtime = (typeof window !== 'undefined' && window.__DSH_BONUS_CONFIG__) || {}

const pick = (key, fallback) => {
  const value = runtime[key] ?? import.meta.env[`VITE_${key.toUpperCase()}`]
  return value === undefined || value === null || value === '' ? fallback : String(value)
}

export const config = {
  /** 后端地址，不带结尾斜杠。 */
  backend: pick('backend', '').replace(/\/+$/, ''),

  /** 平台授权页主机名，仅用于文案展示 */
  platformHost: pick('platformHost', 'platform.deepseek.com'),
}
