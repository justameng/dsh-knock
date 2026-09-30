<script setup>
import { computed, ref } from 'vue'
import { config } from './config.js'
import { site } from './site.js'
import { useClaim } from './composables/useClaim.js'
import { formatAmount, formatClock } from './format.js'
import TermsDialog from './components/TermsDialog.vue'
import FaqList from './components/FaqList.vue'
import ToastHost from './components/ToastHost.vue'
import AnnounceDialog from './components/AnnounceDialog.vue'

const { state, steps, stepIndex, codeRequired, checkQuota, agreeTerms, activate, requestLink, submitCallback, cancel } = useClaim()

const termsOpen = ref(false)
const toastHost = ref(null)

/** 统一的提示入口，交给 ToastHost 处理数量上限与去重。 */
function pushToast(kind, title, description) {
  toastHost.value?.push(kind, title, description)
}

const backendReady = computed(() => config.backend.length > 0)

const tutorialSteps = computed(() => String(site.value.tutorial ?? '')
  .split('\n').map((line) => line.trim()).filter((line) => line.length > 0))

/**
 * 同意协议后的下一步。
 *
 * 先查一次额度：如果这台设备或这个网络已经用完次数，
 * 直接给出结论，别让用户白填一遍激活码。
 * 查询失败不阻塞流程——预检是优化，不是闸门，真正的把关在后端。
 */
async function onAgree() {
  const quota = await checkQuota()
  if (quota?.allowed === false) {
    state.phase = 'blocked'
    state.blockedReason = quota.message
    return
  }
  agreeTerms()
}

async function onActivate() {
  await activate()
  if (state.codeError) pushToast('error', '激活码核销失败', state.codeError)
  else if (state.activation) pushToast('success', '激活码已核销', '正在为你获取授权链接…')
  if (state.linkError) pushToast('error', '获取授权链接失败', state.linkError)
}

function onOpenAuthorize() {
  if (state.session === null) return
  window.open(state.session.authorize_url, '_blank', 'noopener,noreferrer')
}

async function copyLink() {
  if (state.session === null) return
  try {
    await navigator.clipboard.writeText(state.session.authorize_url)
    pushToast('success', '已复制', '可在其他设备打开这条链接。')
  } catch {
    pushToast('error', '复制失败', '请手动选中链接复制。')
  }
}

async function pasteCallback() {
  try {
    const text = await navigator.clipboard.readText()
    if (typeof text === 'string' && text.trim().length > 0) {
      state.callbackInput = text.trim()
      pushToast('info', '已从剪贴板读取', '确认无误后点「提交并领取」。')
    } else {
      pushToast('error', '剪贴板为空', '请先复制浏览器地址栏里的地址。')
    }
  } catch {
    pushToast('error', '无法读取剪贴板', '请长按输入框手动粘贴。')
  }
}

async function onSubmitCallback() {
  await submitCallback()
  if (state.result) {
    const hit = state.result.hit
    if (hit === true) pushToast('success', '领取成功', `赠金已到账，有效期 ${site.value.bonus_validity}。`)
    else if (hit === false) pushToast('info', '授权成功，但未查到赠金', '账号可能已领取过，或不符合活动条件。')
    // hit 为 null：授权成功但没读到余额，不是失败，说清即可
    else pushToast('success', '授权已完成', '赠金由平台发放。本次未读到余额，请稍后到平台查看。')
  } else if (state.callbackError) {
    pushToast('error', '兑换失败', state.callbackError)
  }
}

const hasWallets = computed(() => (state.result?.bonus_wallets?.length ?? 0)
  + (state.result?.normal_wallets?.length ?? 0) > 0)

/** 结果标题。hit 三态：true 到账 / false 未查到 / null 未读到余额。 */
const resultTitle = computed(() => {
  const hit = state.result?.hit
  if (hit === true) return '赠金已到账'
  if (hit === false) return '授权完成，未查到赠金'
  return '授权已完成'
})

function stepState(index) {
  if (state.phase === 'done') return 'done'
  if (index < stepIndex.value) return 'done'
  if (index === stepIndex.value) return 'current'
  return 'todo'
}
</script>

<template>
  <ToastHost ref="toastHost">
    <div class="aurora" aria-hidden="true" />
    <div class="page">
      <header class="hero hero-enter">
        <div class="hero-mark" aria-hidden="true">DSH</div>
        <h1 class="hero-title">体验赠金领取</h1>
        <p class="hero-sub">
          使用 DeepSeek 官方授权流程，赠金直接进入你自己的账号。
          手机也能领，无需安装任何程序。
        </p>
      </header>

      <nav class="steps" aria-label="领取步骤" :data-count="steps.length">
        <div
          v-for="(step, index) in steps"
          :key="step.key"
          class="step"
          :data-state="stepState(index)"
        >
          <span class="step-num">
            <Transition name="num" mode="out-in">
              <span :key="stepState(index)">{{ stepState(index) === 'done' ? '✓' : index + 1 }}</span>
            </Transition>
          </span>
          <span class="step-text">{{ step.label }}</span>
        </div>
      </nav>

      <!-- 主操作区：步骤间用过渡切换，避免硬切造成的跳变 -->
      <main class="stage">
        <Transition name="stage" mode="out-in">
          <!-- 未配置 -->
          <section v-if="!backendReady" key="unconfigured" class="card">
            <h2>站点尚未配置完成</h2>
            <p class="text-2 mt-8">站长还没有填写后端地址，领取流程暂时不可用。</p>
          </section>

          <!-- 1. 协议 -->
          <section v-else-if="state.phase === 'terms'" key="terms" class="card">
            <h2>开始之前</h2>
            <p class="text-2 mt-8">
              领取前需要阅读并同意<strong>领取协议与免责条款</strong>，
              其中说明了本站如何处理你的授权信息。
            </p>
            <button v-ripple type="button" class="btn btn-primary btn-block mt-20" @click="termsOpen = true">
              阅读协议并开始
            </button>
          </section>

          <!-- 终局性拒绝：额度已用尽，做什么都没用。
               单独一屏而不是塞进「填写激活码」的错误行——那里的暗示是
               「换个码再试」，而这里换什么都没用，必须给结论。 -->
          <section v-else-if="state.phase === 'blocked'" key="blocked" class="card">
            <div class="result-head">
              <span class="result-icon">!</span>
              <div>
                <h2>这次领不到了</h2>
              </div>
            </div>
            <p class="text-2 mt-8">{{ state.blockedReason }}</p>
            <div class="callout mt-16">
              <strong>为什么有次数限制</strong>
              <p>
                赠金是平台补贴，按设备与网络双重限制，防止被批量刷走。
                如果你确实没领过却被拦下，可能是和他人共用了同一个网络出口
                （公司、学校、合租房常见）——请联系站长处理。
              </p>
            </div>
          </section>

          <!-- 2. 激活码。关闭开关时状态机不会进入 code 阶段，
               这里再加一道显式守卫，防止配置加载时序导致误渲染。
               注意必须调用 codeRequired()——直接写 codeRequired 是函数引用，恒为真。 -->
          <section v-else-if="codeRequired() && state.phase === 'code'" key="code" class="card">
            <h2>填写激活码</h2>
            <p class="text-2 mt-8">
              激活码来自<strong>{{ site.code_source }}</strong>，一人一码。
            </p>
            <label class="label" for="code-input">激活码</label>
            <input
              id="code-input"
              v-model="state.codeInput"
              type="text"
              class="code-input"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              :disabled="state.codeBusy"
              @keyup.enter="onActivate"
            >
            <Transition name="fade">
              <p v-if="state.codeError" class="err">{{ state.codeError }}</p>
            </Transition>
            <button
              v-ripple
              type="button"
              class="btn btn-primary btn-block mt-16"
              :disabled="state.codeBusy"
              @click="onActivate"
            >
              {{ state.codeBusy ? '正在核销…' : '核销激活码' }}
            </button>
          </section>

          <!-- 3. 打开授权页 -->
          <section v-else-if="state.phase === 'link'" key="link" class="card">
            <h2>打开官方授权页</h2>
            <p class="text-2 mt-8">
              在 <strong>{{ config.platformHost }}</strong> 用你自己的 DeepSeek 账号登录，
              然后点击「授权」。本站不接触你的账号密码。
            </p>
            <Transition name="fade">
              <p v-if="state.linkError" class="err">{{ state.linkError }}</p>
            </Transition>
            <button
              v-ripple
              v-if="state.session"
              type="button"
              class="btn btn-primary btn-block mt-20"
              @click="onOpenAuthorize"
            >
              打开官方授权页
            </button>
            <button
              v-ripple
              v-else
              type="button"
              class="btn btn-primary btn-block mt-20"
              :disabled="state.linkBusy"
              @click="requestLink"
            >
              <span v-if="state.linkBusy" class="spinner" aria-hidden="true" />
              {{ state.linkBusy ? '正在获取授权链接…' : '获取授权链接' }}
            </button>
          </section>

          <!-- 4. 粘贴回调 -->
          <section v-else-if="state.phase === 'callback'" key="callback" class="card">
            <h2>把回调地址粘贴回来</h2>

            <div class="callout">
              <strong>授权后页面打不开，这是正常的</strong>
              <p>
                平台规定回调地址必须是 <code>127.0.0.1</code>，它指向你自己的设备，
                所以授权完成后浏览器会停在一个无法访问的页面。这不是出错。
              </p>
            </div>

            <ol class="howto">
              <li>在官方页面完成登录并点击「授权」</li>
              <li>浏览器跳转后，<strong>点地址栏</strong>，全选并复制整条地址</li>
              <li>回到本页，粘贴到下面的输入框，提交</li>
            </ol>

            <div class="actions-row">
              <button v-ripple type="button" class="btn" @click="onOpenAuthorize">重新打开授权页</button>
              <button v-ripple type="button" class="btn" @click="copyLink">复制授权链接</button>
            </div>

            <label class="label" for="callback-input">回调地址</label>
            <textarea
              id="callback-input"
              v-model="state.callbackInput"
              rows="3"
              class="code-input"
              placeholder="http://127.0.0.1:1455/oauth/callback?code=...&state=..."
              spellcheck="false"
              :disabled="state.callbackBusy"
            />
            <p class="text-3 mt-6">
              手机上：长按地址栏 → 全选 → 复制。地址以
              <code>http://127.0.0.1:1455/oauth/callback</code> 开头，且包含 <code>code=</code>。
            </p>
            <Transition name="fade">
              <p v-if="state.callbackError" class="err">{{ state.callbackError }}</p>
            </Transition>

            <button
              v-ripple
              type="button"
              class="btn btn-primary btn-block mt-16"
              :disabled="state.callbackBusy"
              @click="onSubmitCallback"
            >
              <span v-if="state.callbackBusy" class="spinner" aria-hidden="true" />
              {{ state.callbackBusy ? '正在兑换…' : '提交并领取' }}
            </button>
            <button v-ripple type="button" class="btn btn-block mt-8" @click="pasteCallback">
              从剪贴板粘贴
            </button>

            <!-- 倒计时与重新获取入口。
                 注意「重新获取链接」必须始终可用——它曾经被 v-if 包在
                 secondsLeft > 0 里，倒计时归零后这个唯一的出路就消失了，
                 用户卡死在 callback 阶段，只能刷新页面。 -->
            <p class="text-3 mt-12 countdown">
              <template v-if="state.secondsLeft > 0">
                本次授权剩余 <span class="clock">{{ formatClock(state.secondsLeft * 1000) }}</span> ·
              </template>
              <template v-else>
                <span class="expired">本次授权已超时</span> ·
              </template>
              <button type="button" class="link-btn" @click="cancel">重新获取链接</button>
            </p>
          </section>

          <!-- 完成 -->
          <section v-else-if="state.phase === 'done'" key="done" class="card">
            <div class="result-head">
              <span class="result-icon" :data-ok="state.result?.hit === true">{{ state.result?.hit === true ? '✓' : '!' }}</span>
              <div>
                <h2>{{ resultTitle }}</h2>
                <p class="text-3">{{ state.result?.contact ?? '' }}</p>
              </div>
            </div>

            <div v-if="hasWallets" class="wallets">
              <div v-for="(w, i) in state.result.bonus_wallets" :key="`b-${w.currency}`" class="wallet wallet-bonus" :style="{ animationDelay: `${i * 70}ms` }">
                <span class="wallet-label">赠金余额</span>
                <span class="wallet-amount">{{ formatAmount(w.balance) }} <em>{{ w.currency }}</em></span>
              </div>
              <div v-for="(w, i) in state.result.normal_wallets" :key="`n-${w.currency}`" class="wallet" :style="{ animationDelay: `${(state.result.bonus_wallets?.length ?? 0) * 70 + i * 70}ms` }">
                <span class="wallet-label">充值余额</span>
                <span class="wallet-amount">{{ formatAmount(w.balance) }} <em>{{ w.currency }}</em></span>
              </div>
            </div>

            <!-- 余额未读到：必须说清「授权成功」与「读不到余额」是两回事，
                 否则用户会以为白领了一场。 -->
            <div v-else-if="state.result?.hit === null" class="callout">
              <strong>授权已完成，只是暂时读不到余额</strong>
              <p>
                你的授权已经生效，赠金由平台发放，这一步不受影响。
                本次查询余额时被平台风控拦截，请稍后到
                <strong>{{ config.platformHost }}</strong> 查看余额。
              </p>
            </div>

            <p v-if="state.result?.hit === true" class="text-2 mt-16">
              赠金有效期为 {{ site.bonus_validity }}，请尽快使用。
            </p>
            <p v-else-if="state.result?.hit === false" class="text-2 mt-16">
              未查询到 CNY 赠金。账号可能已领取过，或不符合本次活动条件。
            </p>

            <div v-if="state.result?.unnotified?.length" class="unnotified">
              <span
                v-for="item in state.result.unnotified"
                :key="item.campaign"
                class="tag tag-accent"
              >{{ item.campaign }} · {{ item.amount }}</span>
            </div>
          </section>
        </Transition>
      </main>

      <!-- 教程：折叠在下方，不抢主流程的注意力 -->
      <details v-if="tutorialSteps.length > 0 && state.phase !== 'done'" v-reveal class="tutorial">
        <summary>查看领取教程（{{ tutorialSteps.length }} 步）</summary>
        <ol>
          <li v-for="(line, index) in tutorialSteps" :key="index">{{ line }}</li>
        </ol>
      </details>

      <FaqList v-reveal="{ delay: 60 }" />

      <footer v-reveal class="foot">
        <a :href="site.site_url" target="_blank" rel="noopener noreferrer">{{ site.site_name }}</a>
        · 第三方自助工具页，与 DeepSeek 官方无隶属关系。授权走平台官方接口，赠金由平台发放。
      </footer>
    </div>

    <TermsDialog v-model:open="termsOpen" @agree="onAgree" />
    <AnnounceDialog />
  </ToastHost>
</template>

<style scoped>
/* ── 头部 ── */
.hero {
  padding: 40px 0 24px;
  text-align: center;
}

@media (min-width: 768px) {
  .hero {
    padding: 56px 0 28px;
  }
}

.hero-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: 16px;
  border-radius: 13px;
  background: linear-gradient(145deg, #2f6bff, #1f4fd8);
  color: #fff;
  font: 700 15px/1 var(--font);
  letter-spacing: .04em;
  box-shadow: 0 6px 18px rgba(47, 107, 255, .28);
}

.hero-title {
  font-size: var(--fs-display);
  font-weight: 680;
  letter-spacing: -0.03em;
}

.hero-sub {
  max-width: 30rem;
  margin: 10px auto 0;
  color: var(--c-text-2);
}

.hero-announce {
  max-width: 30rem;
  margin: 16px auto 0;
  padding: 10px 14px;
  border: 1px solid var(--c-accent-border);
  border-radius: var(--r);
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-size: var(--fs-sm);
  text-align: left;
}

/* ── 步骤条 ──
   用 grid 而不是横向滚动：步骤是主进度指示，用户必须一眼看全，
   绝不能被裁切（窄屏下曾经把第 4 步切成一个圈）。
   列数由 steps.length 决定——关闭激活码时只有 3 步。 */
.steps {
  display: grid;
  grid-template-columns: repeat(var(--step-count, 4), minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 18px;
}

.steps[data-count='3'] { --step-count: 3; }
.steps[data-count='4'] { --step-count: 4; }
.steps[data-count='5'] { --step-count: 5; }

/* 窄屏排两行，保证所有步骤都完整可见 */
@media (max-width: 560px) {
  .steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.step {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  background: var(--c-surface);
  box-shadow: var(--shadow-xs);
  font-size: var(--fs-sm);
  line-height: 1;
  color: var(--c-text-3);
  transition: border-color .15s, background .15s, color .15s, transform .15s;
}

/* 悬停轻微抬起，给出可感知的反馈 */
.step:hover { transform: translateY(-1px); }

.step-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 文字垂直居中：与左侧圆点视觉对齐 */
  line-height: 1.2;
}

.step[data-state='current'] {
  border-color: var(--c-accent-border);
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-weight: 600;
}

.step[data-state='done'] {
  color: var(--c-text-2);
}

.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #eef0f3;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--c-text-2);
}

.step[data-state='current'] .step-num {
  background: var(--c-accent);
  color: #fff;
  animation: dsh-pulse 1.1s var(--ease-out);
}

.step[data-state='done'] .step-num {
  background: var(--c-success-soft);
  color: var(--c-success);
}

/* 步骤序号切换（数字 → 对勾）时的微过渡 */
.num-enter-active, .num-leave-active {
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
}

.num-enter-from { opacity: 0; transform: scale(.6); }
.num-leave-to { opacity: 0; transform: scale(.6); }

/* ── 主操作区 ── */
.stage { min-height: 0; }

/* 步骤切换过渡：出得快、进得稳，避免拖沓 */
.stage-enter-active { transition: opacity .26s ease-out, transform .26s cubic-bezier(.22, .9, .3, 1); }
.stage-leave-active { transition: opacity .16s ease-in, transform .16s ease-in; }
.stage-enter-from { opacity: 0; transform: translateY(10px); }
.stage-leave-to { opacity: 0; transform: translateY(-6px); }

/* 错误提示淡入 */
.fade-enter-active, .fade-leave-active { transition: opacity .2s, transform .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-4px); }

/* 加载小圆圈 */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 2px;
  border: 2px solid rgba(255, 255, 255, .35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 倒计时数字用等宽，避免秒数变化时宽度抖动 */
.clock {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--c-text-2);
}

.label {
  display: block;
  margin: 18px 0 7px;
  font-size: var(--fs-sm);
  font-weight: 550;
  color: var(--c-text-2);
}

.code-input {
  font-family: var(--font-mono);
  letter-spacing: .05em;
}

input.code-input { text-transform: uppercase; }

.err {
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
}

.mt-6 { margin-top: 6px; }
.mt-8 { margin-top: 8px; }
.mt-12 { margin-top: 12px; }
.mt-16 { margin-top: 16px; }
.mt-20 { margin-top: 20px; }

/* 提示块 */
.callout {
  margin: 16px 0;
  padding: 14px 16px;
  border: 1px solid var(--c-warn-border);
  border-radius: var(--r);
  background: var(--c-warn-soft);
}

.callout strong {
  display: block;
  margin-bottom: 4px;
  font-size: var(--fs-sm);
  color: var(--c-warn);
}

.callout p {
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--c-text-2);
}

.howto {
  margin: 0 0 16px;
  padding-left: 20px;
  font-size: var(--fs-sm);
  line-height: 1.95;
  color: var(--c-text-2);
}

.actions-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.actions-row .btn { flex: 1; }

.countdown { text-align: center; }

.link-btn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-accent);
  font: inherit;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

/* ── 结果 ── */
.result-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.result-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--c-warn-soft);
  color: var(--c-warn);
  font-size: 19px;
  font-weight: 700;
  animation: pop .45s cubic-bezier(.34, 1.4, .5, 1);
}

@keyframes pop {
  from { opacity: 0; transform: scale(.5); }
  to { opacity: 1; transform: scale(1); }
}

.result-icon[data-ok='true'] {
  background: var(--c-success-soft);
  color: var(--c-success);
}

.wallets {
  display: grid;
  gap: 10px;
}

.wallet {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  background: var(--c-surface-2);
  animation: walletIn .4s cubic-bezier(.22, .9, .3, 1) backwards;
}

@keyframes walletIn {
  from { opacity: 0; transform: translateY(8px) scale(.98); }
  to { opacity: 1; transform: none; }
}

.wallet-bonus {
  border-color: var(--c-success-border);
  background: var(--c-success-soft);
}

.wallet-label {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}

.wallet-amount {
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.wallet-amount em {
  font-style: normal;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--c-text-3);
}

.wallet-bonus .wallet-amount { color: var(--c-success); }

.unnotified {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}

/* ── 教程折叠 ── */
.tutorial {
  margin-top: 24px;
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  background: var(--c-surface);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}

.tutorial summary {
  padding: 14px 18px;
  font-size: var(--fs-sm);
  font-weight: 550;
  color: var(--c-text-2);
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.tutorial summary::-webkit-details-marker { display: none; }

.tutorial summary::after {
  content: '+';
  float: right;
  color: var(--c-text-3);
  font-family: var(--font-mono);
}

.tutorial[open] summary::after { content: '−'; }

.tutorial summary:hover { background: var(--c-surface-2); }

.tutorial ol {
  margin: 0;
  padding: 0 18px 16px 36px;
  font-size: var(--fs-sm);
  line-height: 1.95;
  color: var(--c-text-2);
}

/* ── 页脚 ── */
.foot {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--c-border);
  font-size: var(--fs-xs);
  line-height: 1.8;
  color: var(--c-text-3);
  text-align: center;
}

.foot a { color: var(--c-text-2); }

/* 通知样式已移到 components/ToastHost.vue ——
   Toast 渲染在 body 下的 portal，scoped 样式匹配不到它。 */

/* 窄屏：按钮堆叠，避免挤压 */
@media (max-width: 420px) {
  .actions-row { flex-direction: column; }
  .hero { padding: 28px 0 20px; }
  .hero-mark { width: 42px; height: 42px; margin-bottom: 12px; }
  .step { padding: 8px 10px; font-size: var(--fs-xs); }
  .card { padding: 18px; }
  .wallet-amount { font-size: 19px; }
}

@media (prefers-reduced-motion: reduce) {
  .stage-enter-active, .stage-leave-active,
  .fade-enter-active, .fade-leave-active { transition: none !important; }
  .wallet, .result-icon, .spinner { animation: none !important; }
}
</style>
