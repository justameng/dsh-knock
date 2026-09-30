<script setup>
import { computed, ref } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import { site } from '../site.js'

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['agree'])

const sections = computed(() => [
  {
    title: '服务性质',
    body: '本站是第三方自助工具页，与 DeepSeek 官方无隶属、代理或合作关系。本站不发放赠金，赠金由平台按其规则判定与发放。本站不收取任何费用，不提供代领、代付或账号交易。',
  },
  {
    title: '授权范围',
    body: '领取使用平台官方的浏览器授权流程（OAuth 授权码 + PKCE）。你在 platform.deepseek.com 的官方页面上亲自登录并点击「授权」，本站不接触、不索取你的账号与密码，也无法代你对账号做任何操作。',
  },
  {
    title: '数据处理',
    body: '由于平台只允许回环地址作为回调地址，浏览器无法把授权结果直接送回本站，因此需要你把授权后跳转到的地址复制回本页。本站服务器会使用该地址中的授权码完成兑换，并读取一次账号资料与钱包余额。授权令牌在读取完成后立即主动注销，不写入磁盘、不写入日志。本站不存储你的账号、手机号、邮箱或余额数据。',
  },
  {
    title: '领取限制',
    body: '激活码一人一码，核销后与你的浏览器绑定。同一网络每天仅可领取一次。请勿批量注册、自动化刷取或倒卖赠金，也不要为他人代领。',
  },
  {
    title: '使用者义务',
    body: '你须仅以自己的账号领取，一人一号。不得利用本页规避平台规则。你须自行确认自己的行为符合平台最新条款。',
  },
  {
    title: '免责声明',
    body: `本页按现状提供，不承诺赠金必然到账，不承诺接口长期可用。因平台政策调整、接口变更或账号自身状态导致的失败，本站不承担任何责任。你因违反平台条款而产生的后果由你自行承担。赠金到账后有效期为 ${site.value.bonus_validity}。`,
  },
  {
    title: '风险提示',
    body: '领取需要你在本页提交一次授权跳转地址，服务器会短暂接触你的授权令牌（读完余额即注销）。如果你不接受这一点，请不要使用本页。',
  },
])

const scroller = ref(null)
const scrolledToEnd = ref(false)

/** 滚动到底才能点同意，避免用户在未阅读的情况下通过。 */
function onScroll(event) {
  const el = event.target
  // 留 24px 容差，避免因小数像素永远判定不到底。
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) scrolledToEnd.value = true
}

const canAgree = computed(() => scrolledToEnd.value)

function confirm() {
  if (!canAgree.value) return
  emit('agree')
  open.value = false
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="overlay" />
      <DialogContent class="sheet">
        <header class="head">
          <DialogTitle class="title">领取协议与免责条款</DialogTitle>
          <DialogDescription class="desc">请阅读至末尾后点击同意。</DialogDescription>
        </header>

        <div ref="scroller" class="body" @scroll="onScroll">
          <section v-for="(item, index) in sections" :key="item.title" class="clause">
            <h3 class="clause-title">{{ index + 1 }}. {{ item.title }}</h3>
            <p class="clause-body">{{ item.body }}</p>
          </section>
          <p class="end">以上为全部条款。</p>
        </div>

        <footer class="foot">
          <p v-if="!canAgree" class="hint">请向下滚动阅读至末尾</p>
          <div class="actions">
            <DialogClose as-child>
              <button type="button" class="btn">关闭</button>
            </DialogClose>
            <button type="button" class="btn btn-primary" :disabled="!canAgree" @click="confirm">
              同意并继续
            </button>
          </div>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(16, 20, 28, .5);
  backdrop-filter: blur(2px);
}

/* 进出场动效 */
.overlay[data-state='open'] { animation: overlayIn .2s ease-out; }
.overlay[data-state='closed'] { animation: overlayOut .16s ease-in; }

@keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes overlayOut { from { opacity: 1; } to { opacity: 0; } }

/* 窄屏高度自适应：内容少时不硬撑 */
@media (max-height: 700px) {
  .sheet { max-height: 88dvh; }
}

@media (prefers-reduced-motion: reduce) {
  .overlay[data-state='open'], .overlay[data-state='closed'] { animation: none; }
}

/* 移动端也做成居中的浮动卡片，而不是贴边抽屉。
   贴边抽屉在手机上看像「糊满屏幕」，且顶部会露出背景内容，观感脏。 */
.sheet {
  position: fixed;
  z-index: 41;
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%);
  width: calc(100vw - 32px);
  max-height: min(82dvh, 640px);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

/* 桌面端：更宽一些，高度也放宽 */
@media (min-width: 768px) {
  .sheet {
    width: min(620px, calc(100vw - 48px));
    max-height: min(78dvh, 700px);
  }
}

.head {
  padding: 20px 22px 14px;
  border-bottom: 1px solid var(--c-border);
}

.title {
  margin: 0;
  font-size: var(--fs-h2);
  font-weight: 650;
}

.desc {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

.body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 20px 22px;
}

.clause + .clause { margin-top: 18px; }

.clause-title {
  margin: 0 0 6px;
  font-size: var(--fs-sm);
  font-weight: 620;
}

.clause-body {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.8;
  color: var(--c-text-2);
}

.end {
  margin: 24px 0 0;
  padding-top: 16px;
  border-top: 1px dashed var(--c-border);
  font-size: var(--fs-xs);
  color: var(--c-text-3);
  text-align: center;
}

.foot {
  padding: 14px 22px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--c-border);
}

.hint {
  margin: 0 0 10px;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
  text-align: center;
}

.actions {
  display: flex;
  gap: 10px;
}

.actions .btn { flex: 1; }

@media (min-width: 768px) {
  .actions { justify-content: flex-end; }
  .actions .btn { flex: 0 0 auto; min-width: 104px; }
}
</style>
