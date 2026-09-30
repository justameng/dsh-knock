/**
 * 点击涟漪指令。给按钮类元素加上水波反馈。
 *
 *   <button v-ripple>...</button>
 *
 * 只在有明确点击位置的场景生效；键盘触发（Enter/Space）不加涟漪，
 * 因为拿不到坐标，硬加会从左上角冒出来，很怪。
 */
import { prefersReducedMotion } from './motion.js'

export const vRipple = {
  mounted(el) {
    el.classList.add('ripple-host')
    el.__rippleHandler = (event) => {
      if (prefersReducedMotion()) return
      // 键盘触发没有坐标，跳过
      if (event.clientX === 0 && event.clientY === 0) return
      if (el.disabled) return

      const rect = el.getBoundingClientRect()
      // 半径取对角线一半，保证能覆盖整个按钮
      const radius = Math.hypot(rect.width, rect.height) / 2
      const span = document.createElement('span')
      span.className = 'ripple'
      span.style.width = `${radius * 2}px`
      span.style.height = `${radius * 2}px`
      span.style.left = `${event.clientX - rect.left - radius}px`
      span.style.top = `${event.clientY - rect.top - radius}px`
      el.appendChild(span)
      span.addEventListener('animationend', () => span.remove())
    }
    el.addEventListener('pointerdown', el.__rippleHandler)
  },
  unmounted(el) {
    if (el.__rippleHandler !== undefined) {
      el.removeEventListener('pointerdown', el.__rippleHandler)
      delete el.__rippleHandler
    }
  },
}
