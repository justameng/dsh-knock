<script setup>
import { computed, ref } from 'vue'
import { adminApi } from '../../admin-api.js'

const emit = defineEmits(['notify'])

const quota = ref([])
const limits = ref({ max_per_ip_day: 1, max_per_device: 1 })
const loading = ref(false)
const busy = ref(false)
const filterDay = ref('')
const deviceInput = ref('')

const today = new Date().toISOString().slice(0, 10)

async function load() {
  loading.value = true
  try {
    const params = { limit: '200' }
    if (filterDay.value !== '') params.day = filterDay.value
    const result = await adminApi.ipQuota(params)
    if (result.ok) {
      quota.value = result.body?.quota ?? []
      limits.value = result.body?.limits ?? limits.value
    } else {
      emit('notify', 'error', '读取失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    loading.value = false
  }
}

/** 用量是否已达上限——达到的标红，方便一眼找到问题 IP。 */
const isExhausted = (row) => Number(row.activations) >= Number(limits.value.max_per_ip_day)

const exhaustedCount = computed(() => quota.value.filter(isExhausted).length)

async function resetOne(row) {
  const label = row.day === today ? `${row.ip}（今日）` : `${row.ip} @ ${row.day}`
  if (!window.confirm(`重置 ${label} 的领取额度？\n\n该 IP 将可以重新领取。`)) return
  busy.value = true
  try {
    const result = await adminApi.resetIp({ ip: row.ip, day: row.day })
    if (result.ok) {
      emit('notify', 'success', '已重置', `${row.ip} 的额度已清除（${result.body.cleared} 条）。`)
      await load()
    } else {
      emit('notify', 'error', '重置失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    busy.value = false
  }
}

async function resetAll() {
  if (!window.confirm('清空全部 IP 额度记录？\n\n所有网络的领取次数都会归零，用户可重新领取。')) return
  busy.value = true
  try {
    const result = await adminApi.resetIp({ all: true })
    if (result.ok) {
      emit('notify', 'success', '已清空', `共清除 ${result.body.cleared} 条额度记录。`)
      await load()
    } else {
      emit('notify', 'error', '清空失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    busy.value = false
  }
}

async function resetDevice() {
  const id = deviceInput.value.trim()
  if (id === '') return
  if (!window.confirm(`重置设备 ${id.slice(0, 8)}… 的额度？\n\n该设备将可以重新领取。`)) return
  busy.value = true
  try {
    const result = await adminApi.resetDevice(id)
    if (result.ok) {
      emit('notify', 'success', '已重置', result.body.cleared > 0
        ? '该设备可以重新领取了。'
        : '未找到该设备的记录，可能标识有误。')
      deviceInput.value = ''
      await load()
    } else {
      emit('notify', 'error', '重置失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    busy.value = false
  }
}

defineExpose({ load })
</script>

<template>
  <div>
    <section class="panel">
      <div class="panel-head">
        <h3 class="panel-title">网络领取额度</h3>
        <div class="chips">
          <span class="tag">每 IP 每天 {{ limits.max_per_ip_day }} 次</span>
          <span class="tag">每设备 {{ limits.max_per_device }} 次</span>
          <span v-if="exhaustedCount > 0" class="tag tag-warn">{{ exhaustedCount }} 个 IP 已达上限</span>
        </div>
      </div>

      <p class="panel-hint">
        用户报「当前网络领取次数已达上限」时，在这里按 IP 查证。
        若确认是正常用户被误伤（例如与他人共用出口网络），重置该 IP 的额度即可让其重新领取。
      </p>

      <div class="toolbar">
        <input v-model="filterDay" type="date" @change="load">
        <button v-ripple type="button" class="btn btn-sm" @click="filterDay = ''; load()">看全部</button>
        <button v-ripple type="button" class="btn btn-sm" @click="load">刷新</button>
        <button
          v-ripple
          type="button"
          class="btn btn-sm btn-danger"
          :disabled="busy || quota.length === 0"
          @click="resetAll"
        >
          清空全部额度
        </button>
      </div>

      <div v-if="loading" class="skeleton-table">
        <div v-for="i in 5" :key="i" class="skeleton-row" :style="{ animationDelay: `${i * 60}ms` }" />
      </div>
      <p v-else-if="quota.length === 0" class="empty">还没有任何领取记录。</p>

      <div v-else class="table-wrap fade-in">
        <table class="table table-cards">
          <thead>
            <tr>
              <th>IP</th>
              <th>日期</th>
              <th>已领取</th>
              <th>状态</th>
              <th class="c-act"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in quota" :key="`${row.ip}-${row.day}`">
              <td class="mono" data-label="IP">{{ row.ip }}</td>
              <td class="text-3" data-label="日期">{{ row.day }}</td>
              <td class="mono strong" data-label="已领取">{{ row.activations }} / {{ limits.max_per_ip_day }}</td>
              <td data-label="状态">
                <span class="tag" :class="isExhausted(row) ? 'tag-warn' : 'tag-ok'">
                  {{ isExhausted(row) ? '已达上限' : '可继续' }}
                </span>
              </td>
              <td class="c-act">
                <button v-ripple type="button" class="btn btn-sm" :disabled="busy" @click="resetOne(row)">
                  重置
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3 class="panel-title">设备额度</h3>
      <p class="panel-hint">
        设备额度按浏览器标识计数。用户换浏览器或清缓存会得到全新的设备标识，
        相当于新设备——这是摩擦，不是安全边界。
        需要让某台设备重来时，去 <strong>明细 → 设备</strong> 页签复制标识，粘贴到下面重置。
      </p>
      <div class="toolbar">
        <input
          v-model="deviceInput"
          type="text"
          placeholder="粘贴设备标识（UUID）"
          @keyup.enter="resetDevice"
        >
        <button
          v-ripple
          type="button"
          class="btn btn-sm"
          :disabled="busy || deviceInput.trim() === ''"
          @click="resetDevice"
        >
          重置该设备
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel {
  padding: 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
}

.panel + .panel {
  margin-top: 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.panel-title {
  margin: 0 0 8px;
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--c-text-2);
}

.panel-head .panel-title {
  margin: 0;
}

.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.panel-hint {
  margin: 0 0 14px;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--c-text-3);
}

.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.toolbar input {
  width: auto;
  min-width: 160px;
  padding: 7px 11px;
  font-size: var(--fs-sm);
}

.empty {
  padding: 48px 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--fs-sm);
}

.fade-in {
  animation: fadeIn .3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

.skeleton-table {
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  background: var(--c-surface);
  overflow: hidden;
}

.skeleton-row {
  height: 41px;
  border-bottom: 1px solid var(--c-border);
  background: linear-gradient(90deg, #f3f4f6 25%, #fafbfc 50%, #f3f4f6 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s ease-in-out infinite;
}

.skeleton-row:last-child {
  border-bottom: 0;
}

@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.c-act {
  width: 76px;
  text-align: right;
}

.strong {
  font-weight: 600;
}

.tag.tag-ok {
  border-color: var(--c-success-border);
  background: var(--c-success-soft);
  color: var(--c-success);
}

.tag.tag-warn {
  border-color: var(--c-warn-border);
  background: var(--c-warn-soft);
  color: var(--c-warn);
}

@media (prefers-reduced-motion: reduce) {
  .fade-in,
  .skeleton-row {
    animation: none !important;
  }
}
</style>
