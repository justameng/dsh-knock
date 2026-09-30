/**
 * 动效基础设施。
 *
 * 三条原则：
 *   1. 时长克制：入场 260-460ms，交互反馈 120-180ms。超过 500ms 会显得拖沓。
 *   2. 缓动统一：cubic-bezier(.22,.9,.3,1)，起步快、收尾稳。
 *   3. 尊重 prefers-reduced-motion：用户关掉动效时一律不动。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'

/** 用户是否偏好减少动效。 */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * v-reveal 指令：元素进入视口时淡入上移。
 *
 *   <div v-reveal>...</div>
 *   <div v-reveal="{ delay: 120 }">...</div>
 *
 * 只触发一次，之后断开观察，避免滚动来回时反复闪动。
 */
export const vReveal = {
  mounted(el, binding) {
    // 减少动效时直接显示，不加任何动画
    if (prefersReducedMotion()) {
      el.classList.add('is-revealed')
      return
    }

    const delay = Number(binding.value?.delay ?? 0)
    el.classList.add('reveal')
    if (delay > 0) el.style.transitionDelay = `${delay}ms`

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        el.classList.add('is-revealed')
        observer.disconnect()
      }
    }, {
      // 元素露出 12% 就开始，避免等太久才有反应
      threshold: 0.12,
      // 底部留 40px 余量，元素刚进屏幕就开始，不等它完全进入
      rootMargin: '0px 0px -40px 0px',
    })

    observer.observe(el)
    el.__revealObserver = observer
  },
  unmounted(el) {
    el.__revealObserver?.disconnect()
    delete el.__revealObserver
  },
}

/**
 * 数字滚动。用于后台指标卡这类整数展示。
 *
 * @param {import('vue').Ref<number>|Function} source 目标值来源
 * @param {{ duration?: number }} options
 * @returns {{ value: import('vue').Ref<number> }}
 */
export function useCountUp(source, options = {}) {
  const duration = options.duration ?? 620
  const value = ref(0)
  let frame = null

  const read = () => {
    const raw = typeof source === 'function' ? source() : source.value
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }

  const easeOut = (t) => 1 - Math.pow(1 - t, 3)

  const run = (to) => {
    if (frame !== null) cancelAnimationFrame(frame)
    if (prefersReducedMotion() || duration <= 0) {
      value.value = to
      return
    }
    const from = value.value
    const start = performance.now()
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1)
      value.value = Math.round(from + (to - from) * easeOut(t))
      if (t < 1) frame = requestAnimationFrame(step)
      else frame = null
    }
    frame = requestAnimationFrame(step)
  }

  onMounted(() => run(read()))

  watch(() => read(), (to) => run(to))

  onUnmounted(() => {
    if (frame !== null) cancelAnimationFrame(frame)
  })

  return { value }
}
