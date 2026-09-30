<script setup>
import { computed, ref } from 'vue'
import { adminApi } from '../../admin-api.js'
import { formatAmount } from '../../format.js'
import { outcomeLabel, phaseLabel, actionLabel, auditTarget, formatTime } from '../../labels.js'

const emit = defineEmits(['notify'])

const TABS = [
  { key: 'redemptions', label: '领取记录', hint: '每一次成功领取的完整明细', table: 'redemptions' },
  { key: 'sessions', label: '授权会话', hint: '每个授权会话的生命周期与失败原因', table: 'sessions' },
  { key: 'devices', label: '设备', hint: '按浏览器标识累计的领取次数', table: 'devices' },
  { key: 'attempts', label: '请求流水', hint: '所有请求及其结果，含被拒原因，用于排障', table: 'attempts' },
  { key: 'audit', label: '操作日志', hint: '管理操作与关键事件的审计记录', table: 'audit' },
]

const PHASES = ['waiting', 'exchanging', 'done', 'failed', 'expired', 'cancelled']

const tab = ref('redemptions')
const loading = ref(false)
const rows = ref([])
const filterIp = ref('')
const filterCode = ref('')
const filterPhase = ref('')
const selected = ref(new Set())
const busy = ref(false)

const current = computed(() => TABS.find((item) => item.key === tab.value))

/** 记录的主键：设备表用 device_id，其余用 id。 */
const keyOf = (row) => (tab.value === 'devices' ? row.device_id : row.id)

const allSelected = computed(() => rows.value.length > 0
  && rows.value.every((row) => selected.value.has(keyOf(row))))

function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(rows.value.map(keyOf))
}

function toggleOne(row) {
  const key = keyOf(row)
  const next = new Set(selected.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}

/** 切页签时清空选择，避免跨表误删。 */
function switchTab(key) {
  tab.value = key
  selected.value = new Set()
  void load()
}

async function deleteSelected() {
  const ids = [...selected.value]
  if (ids.length === 0) return
  if (!window.confirm(`确定删除选中的 ${ids.length} 条记录？此操作不可撤销。`)) return
  busy.value = true
  try {
    const result = await adminApi.deleteRecords(current.value.table, ids)
    if (result.ok) {
      emit('notify', 'success', '已删除', `共删除 ${result.body.deleted} 条记录。`)
      selected.value = new Set()
      await load()
    } else {
      emit('notify', 'error', '删除失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    busy.value = false
  }
}

async function purgeAll() {
  const label = current.value.label
  if (!window.confirm(`确定清空「${label}」的全部记录？此操作不可撤销。`)) return
  busy.value = true
  try {
    const result = await adminApi.purgeRecords(current.value.table)
    if (result.ok) {
      emit('notify', 'success', '已清空', `「${label}」共清除 ${result.body.purged} 条。`)
      selected.value = new Set()
      await load()
    } else {
      emit('notify', 'error', '清空失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    busy.value = false
  }
}

async function load() {
  loading.value = true
  rows.value = []
  try {
    const params = { limit: '200' }
    let result
    if (tab.value === 'redemptions') {
      if (filterIp.value.trim() !== '') params.ip = filterIp.value.trim()
      if (filterCode.value.trim() !== '') params.code = filterCode.value.trim()
      result = await adminApi.redemptions(params)
      if (result.ok) rows.value = result.body?.redemptions ?? []
    } else if (tab.value === 'sessions') {
      if (filterPhase.value !== '') params.phase = filterPhase.value
      result = await adminApi.sessions(params)
      if (result.ok) rows.value = result.body?.sessions ?? []
    } else if (tab.value === 'devices') {
      result = await adminApi.devices(params)
      if (result.ok) rows.value = result.body?.devices ?? []
    } else if (tab.value === 'attempts') {
      result = await adminApi.attempts(params)
      if (result.ok) rows.value = result.body?.attempts ?? []
    } else {
      result = await adminApi.audit(params)
      if (result.ok) rows.value = result.body?.audit ?? []
    }
    if (!result.ok) emit('notify', 'error', '读取失败', result.body?.message ?? `HTTP ${result.status}`)
  } finally {
    loading.value = false
  }
}

/** 会话错误字段是 JSON 字符串，解析成人话；已知标识翻译成中文。 */
function errorText(raw) {
  if (raw === null || raw === undefined || raw === '') return '—'
  let detail = raw
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.detail ?? parsed?.kind ?? raw
  } catch { /* 直接当字符串 */ }
  // 用显式 known 标记判断，而不是比对 hint 文案
  const known = outcomeLabel(String(detail))
  return known.known ? known.label : String(detail)
}

function exportCsv() {
  if (rows.value.length === 0) {
    emit('notify', 'info', '没有可导出的数据', '当前列表为空。')
    return
  }
  const keys = Object.keys(rows.value[0])
  const esc = (v) => {
    const t = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const csv = [keys.join(','), ...rows.value.map((row) => keys.map((k) => esc(row[k])).join(','))].join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `dsh-${tab.value}-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

defineExpose({ load })
</script>

<template>
  <div>
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button
          v-for="item in TABS"
          :key="item.key"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: tab === item.key }"
          :aria-selected="tab === item.key"
          @click="switchTab(item.key)"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="tools">
        <input v-if="tab === 'redemptions'" v-model="filterIp" type="text" placeholder="按 IP 筛选" @keyup.enter="load">
        <input v-if="tab === 'redemptions'" v-model="filterCode" type="text" placeholder="按激活码筛选" @keyup.enter="load">
        <select v-if="tab === 'sessions'" v-model="filterPhase" @change="load">
          <option value="">全部状态</option>
          <option v-for="p in PHASES" :key="p" :value="p">{{ phaseLabel(p).label }}</option>
        </select>
        <button v-ripple type="button" class="btn btn-sm" @click="load">刷新</button>
        <button v-ripple type="button" class="btn btn-sm" :disabled="rows.length === 0" @click="exportCsv">导出 CSV</button>
        <Transition name="pop">
          <button
            v-if="selected.size > 0"
            v-ripple
            type="button"
            class="btn btn-sm btn-danger"
            :disabled="busy"
            @click="deleteSelected"
          >
            删除选中 {{ selected.size }} 条
          </button>
        </Transition>
        <button
          v-ripple
          type="button"
          class="btn btn-sm btn-danger"
          :disabled="busy || rows.length === 0"
          @click="purgeAll"
        >
          清空全部
        </button>
      </div>
    </div>

    <p class="tab-hint">{{ current?.hint }}</p>

    <!-- 骨架屏 -->
    <div v-if="loading" class="skeleton-table">
      <div v-for="i in 6" :key="i" class="skeleton-row" :style="{ animationDelay: `${i * 60}ms` }" />
    </div>

    <p v-else-if="rows.length === 0" class="empty">暂无数据。</p>

    <div v-else class="table-wrap fade-in">
      <table class="table table-cards">
        <!-- 领取记录 -->
        <template v-if="tab === 'redemptions'">
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>时间</th><th>激活码</th><th>账号</th><th>赠金</th><th>充值</th>
              <th>结果</th><th>活动</th><th>IP</th><th>设备</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="c-check">
                <input type="checkbox" :checked="selected.has(row.id)" :aria-label="`选择 ${row.id}`" @change="toggleOne(row)">
              </td>
              <td class="nowrap text-3" data-label="时间">{{ formatTime(row.at) }}</td>
              <td class="mono" data-label="激活码">{{ row.code }}</td>
              <td data-label="账号">{{ row.contact ?? '—' }}</td>
              <td class="mono strong" data-label="赠金">{{ formatAmount(row.bonus_cny) }}</td>
              <td class="mono text-3" data-label="充值">{{ formatAmount(row.normal_cny) }}</td>
              <td data-label="结果">
                <span class="tag" :class="row.hit === 1 ? 'tag-ok' : 'tag-warn'">
                  {{ row.hit === 1 ? '赠金已到账' : '未查到赠金' }}
                </span>
              </td>
              <td class="text-3" data-label="活动">{{ row.campaign ?? '—' }}</td>
              <td class="mono text-3" data-label="IP">{{ row.ip }}</td>
              <td class="mono text-3" data-label="设备">{{ String(row.device_id).slice(0, 8) }}…</td>
            </tr>
          </tbody>
        </template>

        <!-- 授权会话 -->
        <template v-else-if="tab === 'sessions'">
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>创建时间</th><th>会话</th><th>激活码</th><th>状态</th><th>失败原因</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="c-check">
                <input type="checkbox" :checked="selected.has(row.id)" :aria-label="`选择 ${row.id}`" @change="toggleOne(row)">
              </td>
              <td class="nowrap text-3" data-label="创建时间">{{ formatTime(row.created_at) }}</td>
              <td class="mono text-3" data-label="会话">{{ String(row.id).slice(0, 8) }}…</td>
              <td class="mono" data-label="激活码">{{ row.code }}</td>
              <td data-label="状态">
                <span class="tag" :data-tone="phaseLabel(row.phase).tone">{{ phaseLabel(row.phase).label }}</span>
              </td>
              <td class="text-3" data-label="失败原因">{{ errorText(row.error) }}</td>
              <td class="mono text-3" data-label="IP">{{ row.ip }}</td>
            </tr>
          </tbody>
        </template>

        <!-- 设备 -->
        <template v-else-if="tab === 'devices'">
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>设备标识</th><th>首次出现</th><th>最近出现</th><th>领取次数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.device_id">
              <td class="c-check">
                <input type="checkbox" :checked="selected.has(row.device_id)" :aria-label="`选择 ${row.device_id}`" @change="toggleOne(row)">
              </td>
              <td class="mono text-3" data-label="设备标识">{{ row.device_id }}</td>
              <td class="nowrap text-3" data-label="首次出现">{{ formatTime(row.first_seen) }}</td>
              <td class="nowrap text-3" data-label="最近出现">{{ formatTime(row.last_seen) }}</td>
              <td class="mono strong" data-label="领取次数">{{ row.activations }}</td>
            </tr>
          </tbody>
        </template>

        <!-- 请求流水 -->
        <template v-else-if="tab === 'attempts'">
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>时间</th><th>结果</th><th>说明</th><th>IP</th><th>设备</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="c-check">
                <input type="checkbox" :checked="selected.has(row.id)" :aria-label="`选择 ${row.id}`" @change="toggleOne(row)">
              </td>
              <td class="nowrap text-3" data-label="时间">{{ formatTime(row.at) }}</td>
              <td data-label="结果">
                <span class="tag" :data-tone="outcomeLabel(row.outcome).tone">
                  {{ outcomeLabel(row.outcome).label }}
                </span>
              </td>
              <td class="text-3" data-label="说明">{{ outcomeLabel(row.outcome).hint }}</td>
              <td class="mono text-3" data-label="IP">{{ row.ip }}</td>
              <td class="mono text-3" data-label="设备">{{ row.device_id === null ? '—' : `${String(row.device_id).slice(0, 8)}…` }}</td>
            </tr>
          </tbody>
        </template>

        <!-- 操作日志 -->
        <template v-else>
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="c-check">
                <input type="checkbox" :checked="selected.has(row.id)" :aria-label="`选择 ${row.id}`" @change="toggleOne(row)">
              </td>
              <td class="nowrap text-3" data-label="时间">{{ formatTime(row.at) }}</td>
              <td data-label="操作者">{{ row.actor }}</td>
              <td data-label="动作">{{ actionLabel(row.action) }}</td>
              <td class="text-3" data-label="对象">{{ auditTarget(row.target) }}</td>
              <td class="text-3" data-label="详情">{{ row.detail ?? '—' }}</td>
              <td class="mono text-3" data-label="IP">{{ row.ip ?? '—' }}</td>
            </tr>
          </tbody>
        </template>
      </table>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r);
  background: #eceef1;
  overflow-x: auto;
  scrollbar-width: none;
  max-width: 100%;
}

.tabs::-webkit-scrollbar { display: none; }

.tab {
  flex: none;
  padding: 7px 14px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--c-text-2);
  font: 550 var(--fs-sm) / 1.4 var(--font);
  cursor: pointer;
  white-space: nowrap;
  transition: background .16s, color .16s, box-shadow .16s;
}

.tab:hover { color: var(--c-text); }

.tab.active {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--shadow-xs);
}

.tools {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tools input,
.tools select {
  width: auto;
  min-width: 130px;
  padding: 7px 11px;
  font-size: var(--fs-sm);
}

.tab-hint {
  margin: 0 0 14px;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

.empty {
  padding: 56px 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--fs-sm);
}

/* 表格淡入 */
.fade-in {
  animation: fadeIn .3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* 骨架屏 */
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

.skeleton-row:last-child { border-bottom: 0; }

@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.strong { font-weight: 600; }

.c-check { width: 36px; }

.pop-enter-active, .pop-leave-active { transition: opacity .18s, transform .18s; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: scale(.94); }

/* 语义标签色调 */
.tag[data-tone='ok'] { border-color: var(--c-success-border); background: var(--c-success-soft); color: var(--c-success); }
.tag[data-tone='warn'] { border-color: var(--c-warn-border); background: var(--c-warn-soft); color: var(--c-warn); }
.tag[data-tone='bad'] { border-color: var(--c-danger-border); background: var(--c-danger-soft); color: var(--c-danger); }
.tag[data-tone='accent'] { border-color: var(--c-accent-border); background: var(--c-accent-soft); color: var(--c-accent); }

@media (prefers-reduced-motion: reduce) {
  .fade-in, .skeleton-row { animation: none !important; }
}
</style>
