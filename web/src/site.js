/**
 * 站点文案的响应式容器。
 *
 * 单独成模块，避免 App.vue ↔ main.js 的循环依赖。
 * 启动时由 main.js 拉取后端配置填充，管理后台改完立即生效。
 */
import { ref } from 'vue'
import { config } from './config.js'

export const site = ref({
  site_name: '小学生公益站',
  site_url: 'https://example.com',
  code_source: '群友专属渠道',
  bonus_validity: '7 天',
  tutorial: '',
  announce: '',
})

/** 从后端拉取文案。失败时保持默认值，页面不会白屏。 */
export async function loadSite() {
  if (config.backend === '') return
  try {
    const response = await fetch(`${config.backend}/api/config`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return
    const body = await response.json()
    if (body?.site) site.value = { ...site.value, ...body.site }
  } catch { /* 保持默认值 */ }
}
