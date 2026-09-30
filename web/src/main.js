import { createApp, h } from 'vue'
import App from './App.vue'
import AdminApp from './components/AdminApp.vue'
import { useHashRoute } from './useHashRoute.js'
import { loadSite } from './site.js'
import { vReveal } from './motion.js'
import { vRipple } from './ripple.js'
import './styles/base.css'
import './styles/motion.css'

/**
 * 根组件。用渲染函数而不是 template 字符串——
 * 构建产物是 runtime-only 版 Vue，不含模板编译器，字符串模板不会生效。
 */
const Root = {
  setup() {
    const route = useHashRoute()
    return () => (route.value === 'admin' ? h(AdminApp) : h(App))
  },
}

const app = createApp(Root)
// 全局注册动效指令，组件里直接 v-reveal / v-ripple
app.directive('reveal', vReveal)
app.directive('ripple', vRipple)

// 先把文案拉下来再挂载，避免首屏闪一下默认文案。
void loadSite().finally(() => {
  app.mount('#app')
})
