/**
 * 极简哈希路由。只有两个视图：#/ 前台领取页，#/admin 管理后台。
 * 不引入 vue-router：两个页面不值得加一个依赖。
 */
import { ref, onMounted, onUnmounted } from 'vue'

export function useHashRoute() {
  const route = ref(current())

  function current() {
    const hash = window.location.hash.replace(/^#/, '')
    return hash.startsWith('/admin') ? 'admin' : 'claim'
  }

  const onHashChange = () => { route.value = current() }

  onMounted(() => window.addEventListener('hashchange', onHashChange))
  onUnmounted(() => window.removeEventListener('hashchange', onHashChange))

  return route
}
