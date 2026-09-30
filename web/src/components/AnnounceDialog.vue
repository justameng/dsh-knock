<script setup>
import { computed, onMounted, ref } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import { site } from '../site.js'

/**
 * 公告弹窗。
 *
 * 支持三种展示频率：
 *   every —— 每次访问都弹
 *   daily —— 每天一次（默认）
 *   once  —— 只弹一次，关掉不再出现
 *
 * 频率记在 localStorage，用公告内容做键——改了公告会重新弹给所有人，
 * 这样运营改文案后用户能看到，不用等缓存过期。
 */
const open = ref(false)

const STORAGE_KEY = 'dsh-bonus-announce-seen'

/** 用公告标题+正文做指纹，内容变了就重新弹。 */
const fingerprint = computed(() => {
  const raw = `${site.value.announce_title}|${site.value.announce}`
  // 简单哈希，避免把长文本塞进 localStorage 键
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0
  }
  return String(hash >>> 0)
})

function shouldShow() {
  const cfg = site.value
  if (cfg.announce_enabled !== true) return false
  if (String(cfg.announce ?? '').trim() === '' && String(cfg.announce_title ?? '').trim() === '') return false

  const frequency = cfg.announce_frequency ?? 'daily'
  if (frequency === 'every') return true

  try {
    const seen = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (seen === null || seen.fingerprint !== fingerprint.value) return true
    if (frequency === 'once') return false
    // daily：同一天只弹一次
    return seen.day !== new Date().toISOString().slice(0, 10)
  } catch {
    // 隐私模式禁用 localStorage 时，退化为每次都弹
    return true
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fingerprint: fingerprint.value,
      day: new Date().toISOString().slice(0, 10),
    }))
  } catch { /* 忽略 */ }
}

function close() {
  markSeen()
  open.value = false
}

/** 点跳转按钮时也记一次，避免用户点完链接回来又被弹一次。 */
function onLinkClick() {
  markSeen()
  open.value = false
}

onMounted(() => {
  // 等站点配置拉取完成后再判断，否则会拿到默认值
  if (shouldShow()) {
    // 稍作延迟，避免和首屏入场动画打架
    setTimeout(() => { open.value = true }, 600)
  }
})
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="overlay" />
      <DialogContent class="sheet" @escape-key-down="markSeen">
        <header class="head">
          <DialogTitle class="title">{{ site.announce_title || '公告' }}</DialogTitle>
          <DialogDescription class="sr-only">站点公告</DialogDescription>
        </header>

        <div class="body">
          <p class="text">{{ site.announce }}</p>
        </div>

        <footer class="foot">
          <a
            v-if="site.announce_link_url"
            class="btn btn-primary btn-block"
            :href="site.announce_link_url"
            target="_blank"
            rel="noopener noreferrer"
            @click="onLinkClick"
          >{{ site.announce_link_text || '查看详情' }}</a>
          <button type="button" class="btn btn-block" @click="close">知道了</button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(16, 20, 28, .5);
  backdrop-filter: blur(2px);
}

.overlay[data-state='open'] { animation: overlayIn .2s ease-out; }
.overlay[data-state='closed'] { animation: overlayOut .16s ease-in; }

@keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes overlayOut { from { opacity: 1; } to { opacity: 0; } }

/* 与协议弹窗保持一致的居中卡片，不贴边 */
.sheet {
  position: fixed;
  z-index: 51;
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%);
  width: calc(100vw - 32px);
  max-height: min(80dvh, 560px);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

@media (min-width: 768px) {
  .sheet {
    width: min(460px, calc(100vw - 48px));
  }
}

.head {
  padding: 22px 24px 14px;
}

.title {
  margin: 0;
  font-size: var(--fs-h2);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 0 24px 4px;
}

.text {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.85;
  color: var(--c-text-2);
  /* 保留用户输入的换行 */
  white-space: pre-wrap;
  word-break: break-word;
}

.foot {
  display: grid;
  gap: 8px;
  padding: 18px 24px calc(20px + env(safe-area-inset-bottom));
}

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .overlay[data-state='open'],
  .overlay[data-state='closed'] {
    animation: none;
  }
}
</style>
