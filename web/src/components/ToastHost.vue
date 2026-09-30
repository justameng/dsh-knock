<script setup>
import { ToastProvider, ToastRoot, ToastTitle, ToastDescription, ToastViewport, ToastClose } from 'reka-ui'
import { ref } from 'vue'

/**
 * 全局通知。
 *
 * 三个坑都踩过，这里一并处理：
 *   1. reka-ui 的 Toast 会渲染到 body 下的 portal，**scoped 样式加不到它身上**，
 *      样式必须写成全局（<style> 不加 scoped）。
 *   2. 没有数量上限时，用户连点会堆一屏通知。这里限制最多 3 条，
 *      相同标题+内容的重复通知不再追加。
 *   3. **不要在 ToastRoot 之外自己再起一个 setTimeout 计时器**。
 *      reka-ui 内部已有计时（ToastRootImpl 的 duration 到期会 emit close），
 *      两套计时器会打架：Provider 的 5 秒先到就把 toast 关掉，
 *      外面那个「错误提示显示 8 秒」的计时器根本轮不到执行。
 *      正确做法是给每条 toast 传自己的 duration，让库统一管生命周期。
 */
const MAX_VISIBLE = 3
const toasts = ref([])
let seq = 0

/** 错误留久一点（用户要读完），普通提示 5 秒。 */
const DURATION = { error: 8000, warn: 6000, success: 5000, info: 5000 }

function dismiss(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function push(kind, title, description) {
  // 重复通知：同一标题与内容已在屏幕上，就不再追加。
  // 不去「重置计时」——那需要操作库的内部计时器；直接忽略更简单，
  // 反正屏幕上已经有一条一模一样的信息，用户看到的就是他需要的。
  const existing = toasts.value.find((t) => t.title === title && t.description === description)
  if (existing !== undefined) return

  const item = { id: ++seq, kind, title, description, duration: DURATION[kind] ?? 5000 }
  // 超出上限时挤掉最旧的
  toasts.value = [...toasts.value, item].slice(-MAX_VISIBLE)
}

defineExpose({ push, dismiss })
</script>

<template>
  <ToastProvider :swipe-direction="'right'">
    <slot />
    <ToastViewport class="dsh-toast-viewport">
      <ToastRoot
        v-for="item in toasts"
        :key="item.id"
        class="dsh-toast"
        :data-kind="item.kind"
        :duration="item.duration"
        :default-open="true"
        @update:open="(value) => { if (!value) dismiss(item.id) }"
      >
        <ToastTitle class="dsh-toast-title">{{ item.title }}</ToastTitle>
        <ToastDescription class="dsh-toast-desc">{{ item.description }}</ToastDescription>
        <ToastClose class="dsh-toast-close" aria-label="关闭">×</ToastClose>
      </ToastRoot>
    </ToastViewport>
  </ToastProvider>
</template>

<!-- 必须全局：Toast 渲染在 body 下的 portal，scoped 属性匹配不到 -->
<style>
.dsh-toast-viewport {
  position: fixed;
  z-index: 100;
  right: 16px;
  bottom: 16px;
  left: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
}

@media (min-width: 768px) {
  .dsh-toast-viewport {
    left: auto;
    right: 24px;
    bottom: 24px;
    width: 350px;
  }
}

.dsh-toast {
  position: relative;
  padding: 14px 40px 14px 16px;
  border: 1px solid #e8eaed;
  border-left: 3px solid #2f6bff;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 12px 32px rgba(16, 24, 40, .14), 0 2px 8px rgba(16, 24, 40, .07);
  pointer-events: auto;
  list-style: none;
  /* 入场动效 */
  animation: dsh-toast-in .28s cubic-bezier(.22, .9, .3, 1);
}

.dsh-toast[data-kind='success'] { border-left-color: #0f7b43; }
.dsh-toast[data-kind='error'] { border-left-color: #c02626; }

@keyframes dsh-toast-in {
  from { opacity: 0; transform: translateY(12px) scale(.97); }
  to { opacity: 1; transform: none; }
}

.dsh-toast-title {
  display: block;
  margin: 0;
  font: 600 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #16181c;
}

.dsh-toast-desc {
  display: block;
  margin: 4px 0 0;
  font: 400 12.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #4b5563;
}

.dsh-toast-close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #8b929e;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: background .14s, color .14s;
}

.dsh-toast-close:hover {
  background: #f3f4f6;
  color: #16181c;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-toast { animation: none; }
}
</style>
