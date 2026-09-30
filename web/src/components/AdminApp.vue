<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { adminApi, clearToken, getToken, setUnauthorizedHandler } from '../admin-api.js'
import AdminLogin from './admin/AdminLogin.vue'
import AdminOverview from './admin/AdminOverview.vue'
import AdminCodes from './admin/AdminCodes.vue'
import AdminRecords from './admin/AdminRecords.vue'
import AdminQuota from './admin/AdminQuota.vue'
import AdminSettings from './admin/AdminSettings.vue'
import ToastHost from './ToastHost.vue'

const authed = ref(false)
const checking = ref(true)
const tab = ref('overview')
const toastHost = ref(null)

const overview = ref(null)
const overviewLoading = ref(false)
const codesRef = ref(null)
const recordsRef = ref(null)
const quotaRef = ref(null)
const settingsRef = ref(null)

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'codes', label: '激活码' },
  { key: 'records', label: '明细' },
  { key: 'quota', label: '额度' },
  { key: 'settings', label: '配置' },
]

/** 统一交给 ToastHost 处理数量上限与去重。 */
function notify(kind, title, description) {
  toastHost.value?.push(kind, title, description)
}

/**
 * 令牌失效时把用户踢回登录页。
 *
 * 注册到 admin-api 层，任何接口收到 401 都会触发——
 * 而不是只在概览页判断。否则用户在「明细」页令牌过期时，
 * 只会看到「读取失败」，点什么都没反应，也不知道要重新登录。
 */
setUnauthorizedHandler(() => {
  if (!authed.value) return
  authed.value = false
  clearToken()
  notify('warn', '登录已过期', '请重新输入管理令牌。')
})

async function loadOverview() {
  overviewLoading.value = true
  try {
    const result = await adminApi.overview()
    if (result.ok) overview.value = result.body
    else if (result.status !== 401) notify('error', '读取概览失败', result.body?.message ?? result.error ?? `HTTP ${result.status}`)
  } finally {
    overviewLoading.value = false
  }
}

/**
 * 切换页签时按需加载。必须先 await nextTick()：
 * v-if 切过去的组件此刻还没挂载，ref 是 null，直接调用会静默什么都不做。
 */
async function selectTab(key) {
  tab.value = key
  await nextTick()
  if (key === 'overview') await loadOverview()
  else if (key === 'codes') await codesRef.value?.load()
  else if (key === 'records') await recordsRef.value?.load()
  else if (key === 'quota') await quotaRef.value?.load()
  else if (key === 'settings') await settingsRef.value?.load()
}

async function onAuthed() {
  authed.value = true
  await loadOverview()
}

function logout() {
  clearToken()
  authed.value = false
  overview.value = null
}

function onDataChanged() {
  if (tab.value === 'overview') void loadOverview()
}

onMounted(async () => {
  if (getToken().length > 0) {
    const result = await adminApi.overview()
    if (result.ok) {
      authed.value = true
      overview.value = result.body
    } else if (result.status === 401) {
      clearToken()
    }
  }
  checking.value = false
})
</script>

<template>
  <ToastHost ref="toastHost">
    <div v-if="checking" class="boot">正在检查登录状态…</div>

    <AdminLogin v-else-if="!authed" @authed="onAuthed" />

    <div v-else class="shell">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-dot" aria-hidden="true" />
          <span class="brand-text">管理后台</span>
        </div>
        <div class="topbar-actions">
          <a class="btn btn-sm" href="#/">查看前台</a>
          <button type="button" class="btn btn-sm" @click="logout">退出</button>
        </div>
      </div>
      <nav class="nav">
        <div class="nav-inner">
          <button
            v-for="item in TABS"
            :key="item.key"
            type="button"
            class="nav-item"
            :class="{ active: tab === item.key }"
            @click="selectTab(item.key)"
          >
            {{ item.label }}
          </button>
        </div>
      </nav>
    </header>

    <main class="page page-wide body">
      <AdminOverview v-if="tab === 'overview'" :overview="overview" :loading="overviewLoading" />
      <AdminCodes v-else-if="tab === 'codes'" ref="codesRef" @changed="onDataChanged" @notify="notify" />
      <AdminRecords v-else-if="tab === 'records'" ref="recordsRef" @notify="notify" />
      <AdminQuota v-else-if="tab === 'quota'" ref="quotaRef" @notify="notify" />
      <AdminSettings v-else ref="settingsRef" @notify="notify" />
    </main>
    </div>
  </ToastHost>
</template>

<style scoped>
.boot {
  padding: 64px 24px;
  text-align: center;
  color: var(--c-text-3);
}

/* ── 顶栏：白底 + 细分隔线，粘顶 ── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  /* 关键：限制宽度并禁止横向溢出。
     导航在窄屏放不下时，必须由 .nav-inner 内部滚动，
     而不是把顶栏撑宽——否则白底会超出视口，右边露出底色。 */
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
  border-bottom: 1px solid var(--c-border);
  background: rgba(255, 255, 255, .92);
  backdrop-filter: saturate(180%) blur(12px);
}

.topbar-inner,
.nav-inner {
  max-width: var(--page-max-wide);
  margin: 0 auto;
  padding: 0 24px;
}

@media (max-width: 767px) {
  .topbar-inner,
  .nav-inner {
    padding: 0 16px;
  }
}

.topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  min-width: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.brand-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--c-accent);
  box-shadow: 0 0 0 3px var(--c-accent-soft);
}

.brand-text {
  font-size: var(--fs-body);
  font-weight: 620;
  letter-spacing: -0.01em;
}

.topbar-actions {
  display: flex;
  gap: 8px;
}

.nav-inner {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.nav-inner::-webkit-scrollbar { display: none; }

.nav-item {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 16px;
  border: 0;
  background: none;
  color: var(--c-text-3);
  font: 550 var(--fs-sm) / 1 var(--font);
  cursor: pointer;
  white-space: nowrap;
  transition: color .14s;
}

.nav-item:hover { color: var(--c-text); }

.nav-item.active { color: var(--c-accent); }

.nav-item.active::after {
  content: '';
  position: absolute;
  right: 10px;
  bottom: 0;
  left: 10px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--c-accent);
  animation: navIn .22s cubic-bezier(.22, .9, .3, 1);
}

@keyframes navIn {
  from { transform: scaleX(.4); opacity: .4; }
  to { transform: scaleX(1); opacity: 1; }
}

.body {
  padding-top: 24px;
}

/* 通知样式已移到 components/ToastHost.vue ——
   Toast 渲染在 body 下的 portal，scoped 样式匹配不到它。 */
</style>
