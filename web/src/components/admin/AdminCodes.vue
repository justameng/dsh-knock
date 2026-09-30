<script setup>
import { computed, ref } from 'vue'
import { adminApi } from '../../admin-api.js'
import { codeStateLabel, formatTime } from '../../labels.js'

const emit = defineEmits(['changed', 'notify'])

const codes = ref([])
const stats = ref(null)
const loading = ref(false)

const genCount = ref(10)
const genBatch = ref('')
const genNote = ref('')
const genBusy = ref(false)
const lastGenerated = ref([])

const filterState = ref('')
const filterBatch = ref('')
const selected = ref(new Set())

const STATES = ['unused', 'active', 'used', 'revoked']

const canSelect = (row) => row.state === 'unused' || row.state === 'active'

const allSelected = computed(() => codes.value.length > 0
  && codes.value.filter(canSelect).every((row) => selected.value.has(row.code)))

async function load() {
  loading.value = true
  try {
    const params = { limit: '200' }
    if (filterState.value !== '') params.state = filterState.value
    if (filterBatch.value.trim() !== '') params.batch = filterBatch.value.trim()
    const result = await adminApi.codes(params)
    if (result.ok) {
      codes.value = result.body?.codes ?? []
      stats.value = result.body?.stats ?? null
    } else {
      emit('notify', 'error', '读取失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    loading.value = false
  }
}

async function generate() {
  const count = Number(genCount.value)
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    emit('notify', 'error', '数量不合法', '请输入 1 到 500 之间的整数。')
    return
  }
  genBusy.value = true
  try {
    const result = await adminApi.generate({
      count, batch: genBatch.value.trim() || null, note: genNote.value.trim() || null,
    })
    if (!result.ok || result.body?.ok !== true) {
      emit('notify', 'error', '生成失败', result.body?.message ?? `HTTP ${result.status}`)
      return
    }
    lastGenerated.value = result.body.codes ?? []
    emit('notify', 'success', `已生成 ${lastGenerated.value.length} 个激活码`, '可复制或下载为 txt。')
    emit('changed')
    await load()
  } finally {
    genBusy.value = false
  }
}

async function copyGenerated() {
  try {
    await navigator.clipboard.writeText(lastGenerated.value.join('\n'))
    emit('notify', 'success', '已复制', `${lastGenerated.value.length} 个激活码已复制到剪贴板。`)
  } catch {
    emit('notify', 'error', '复制失败', '请手动选择复制。')
  }
}

function downloadGenerated() {
  const blob = new Blob([lastGenerated.value.join('\n')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `dsh-codes-${new Date().toISOString().slice(0, 10)}.txt`
  link.click()
  URL.revokeObjectURL(url)
}

async function revokeOne(code) {
  const result = await adminApi.revoke(code)
  if (result.ok) {
    emit('notify', 'success', '已作废', code)
    emit('changed')
    await load()
  } else {
    emit('notify', 'error', '作废失败', result.body?.message ?? `HTTP ${result.status}`)
  }
}

async function revokeSelected() {
  const list = [...selected.value]
  if (list.length === 0) return
  const result = await adminApi.revokeBatch(list)
  if (result.ok) {
    emit('notify', 'success', '批量作废完成', `成功 ${result.body.revoked} / ${result.body.total} 个。`)
    selected.value = new Set()
    emit('changed')
    await load()
  } else {
    emit('notify', 'error', '批量作废失败', result.body?.message ?? `HTTP ${result.status}`)
  }
}

async function purge(state) {
  const label = codeStateLabel(state).label
  if (!window.confirm(`确定删除所有「${label}」的激活码？此操作不可撤销。`)) return
  const result = await adminApi.purge(state)
  if (result.ok) {
    emit('notify', 'success', '清理完成', `已删除 ${result.body.purged} 条。`)
    emit('changed')
    await load()
  } else {
    emit('notify', 'error', '清理失败', result.body?.message ?? `HTTP ${result.status}`)
  }
}

function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(codes.value.filter(canSelect).map((row) => row.code))
}

function toggleOne(code) {
  const next = new Set(selected.value)
  if (next.has(code)) next.delete(code)
  else next.add(code)
  selected.value = next
}

defineExpose({ load })
</script>

<template>
  <div class="stack">
    <!-- 批量生成 -->
    <section v-reveal class="panel">
      <h3 class="panel-title">批量生成</h3>
      <div class="gen">
        <div class="field">
          <label for="gen-count">数量</label>
          <input id="gen-count" v-model.number="genCount" type="number" min="1" max="500">
        </div>
        <div class="field">
          <label for="gen-batch">批次名（可选）</label>
          <input id="gen-batch" v-model="genBatch" type="text" placeholder="例如：群友第一批">
        </div>
        <div class="field">
          <label for="gen-note">备注（可选）</label>
          <input id="gen-note" v-model="genNote" type="text" placeholder="例如：群友第一批">
        </div>
        <button v-ripple type="button" class="btn btn-primary" :disabled="genBusy" @click="generate">
          {{ genBusy ? '生成中…' : '生成' }}
        </button>
      </div>

      <Transition name="expand">
        <div v-if="lastGenerated.length > 0" class="generated">
          <div class="generated-head">
            <span class="text-3">本次生成 {{ lastGenerated.length }} 个</span>
            <div class="generated-actions">
              <button v-ripple type="button" class="btn btn-sm" @click="copyGenerated">复制全部</button>
              <button v-ripple type="button" class="btn btn-sm" @click="downloadGenerated">下载 txt</button>
            </div>
          </div>
          <div class="generated-list">
            <code v-for="(c, i) in lastGenerated" :key="c" :style="{ animationDelay: `${Math.min(i * 12, 400)}ms` }">{{ c }}</code>
          </div>
        </div>
      </Transition>
    </section>

    <!-- 列表 -->
    <section v-reveal="{ delay: 60 }" class="panel">
      <div class="panel-head">
        <h3 class="panel-title">激活码列表</h3>
        <div v-if="stats" class="chips">
          <span class="tag">共 {{ stats.total }}</span>
          <span class="tag tag-ok">未使用 {{ stats.unused }}</span>
          <span class="tag tag-warn">已绑定 {{ stats.active }}</span>
          <span class="tag tag-accent">已领取 {{ stats.used }}</span>
          <span class="tag">作废 {{ stats.revoked }}</span>
        </div>
      </div>

      <div class="filters">
        <select v-model="filterState" @change="load">
          <option value="">全部状态</option>
          <option v-for="s in STATES" :key="s" :value="s">{{ codeStateLabel(s).label }}</option>
        </select>
        <input v-model="filterBatch" type="text" placeholder="按批次筛选" @keyup.enter="load">
        <button v-ripple type="button" class="btn btn-sm" @click="load">刷新</button>
        <Transition name="pop">
          <button v-if="selected.size > 0" v-ripple type="button" class="btn btn-sm btn-danger" @click="revokeSelected">
            作废选中 {{ selected.size }} 个
          </button>
        </Transition>
      </div>

      <div v-if="loading" class="skeleton-table">
        <div v-for="i in 6" :key="i" class="skeleton-row" :style="{ animationDelay: `${i * 60}ms` }" />
      </div>
      <p v-else-if="codes.length === 0" class="empty">没有匹配的激活码。</p>

      <div v-else class="table-wrap fade-in">
        <table class="table table-cards">
          <thead>
            <tr>
              <th class="c-check">
                <input type="checkbox" :checked="allSelected" aria-label="全选" @change="toggleAll">
              </th>
              <th>激活码</th>
              <th>状态</th>
              <th>批次</th>
              <th>创建</th>
              <th>绑定</th>
              <th>领取</th>
              <th class="c-act"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in codes" :key="row.code">
              <td class="c-check">
                <input
                  type="checkbox"
                  :checked="selected.has(row.code)"
                  :disabled="!canSelect(row)"
                  :aria-label="`选择 ${row.code}`"
                  @change="toggleOne(row.code)"
                >
              </td>
              <td class="mono strong" data-label="激活码">{{ row.code }}</td>
              <td data-label="状态">
                <span class="tag" :data-tone="codeStateLabel(row.state).tone">
                  {{ codeStateLabel(row.state).label }}
                </span>
              </td>
              <td class="text-3" data-label="批次">{{ row.batch ?? '—' }}</td>
              <td class="text-3 nowrap" data-label="创建">{{ formatTime(row.created_at) }}</td>
              <td class="text-3 nowrap" data-label="绑定">{{ formatTime(row.bound_at) }}</td>
              <td class="text-3 nowrap" data-label="领取">{{ formatTime(row.used_at) }}</td>
              <td class="c-act" data-label="操作">
                <button v-if="canSelect(row)" type="button" class="btn btn-sm" @click="revokeOne(row.code)">作废</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="purge">
        <span class="text-3">清理：</span>
        <button v-ripple type="button" class="btn btn-sm" @click="purge('unused')">删除未使用</button>
        <button v-ripple type="button" class="btn btn-sm" @click="purge('revoked')">删除已作废</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: 14px; }

.panel {
  padding: 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.panel-title {
  margin: 0 0 14px;
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--c-text-2);
}

.panel-head .panel-title { margin: 0; }

.chips { display: flex; gap: 6px; flex-wrap: wrap; }

.gen {
  display: grid;
  grid-template-columns: 100px 1fr 1fr auto;
  gap: 10px;
  align-items: end;
}

/* 四列在中等宽度下会被压扁，提前降为两列 */
@media (max-width: 900px) {
  .gen { grid-template-columns: 1fr 1fr; }
  .gen .btn { grid-column: 1 / -1; }
}

@media (max-width: 420px) {
  .gen { grid-template-columns: 1fr; }
}

.field label {
  display: block;
  margin-bottom: 5px;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
  font-weight: 500;
}

/* 生成结果展开动效 */
.generated {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--c-border);
  overflow: hidden;
}

.generated-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.generated-actions { display: flex; gap: 8px; }

.generated-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 12px;
  border-radius: var(--r);
  background: var(--c-surface-2);
}

.generated-list code {
  font-size: var(--fs-xs);
  animation: popIn .3s cubic-bezier(.22, .9, .3, 1) backwards;
}

@keyframes popIn {
  from { opacity: 0; transform: scale(.9); }
  to { opacity: 1; transform: none; }
}

.expand-enter-active, .expand-leave-active {
  transition: opacity .24s, transform .24s, max-height .3s;
  max-height: 320px;
}

.expand-enter-from, .expand-leave-to {
  opacity: 0;
  transform: translateY(-6px);
  max-height: 0;
}

.pop-enter-active, .pop-leave-active { transition: opacity .18s, transform .18s; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: scale(.94); }

.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.filters select,
.filters input {
  width: auto;
  min-width: 140px;
  padding: 7px 11px;
  font-size: var(--fs-sm);
}

@media (max-width: 420px) {
  .filters select,
  .filters input { min-width: 0; flex: 1; }
}

.empty {
  padding: 56px 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--fs-sm);
}

.fade-in { animation: fadeIn .3s ease-out; }

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

.c-check { width: 36px; }
.c-act { width: 68px; text-align: right; }
.strong { font-weight: 600; }

.tag[data-tone='ok'] { border-color: var(--c-success-border); background: var(--c-success-soft); color: var(--c-success); }
.tag[data-tone='warn'] { border-color: var(--c-warn-border); background: var(--c-warn-soft); color: var(--c-warn); }
.tag[data-tone='bad'] { border-color: var(--c-danger-border); background: var(--c-danger-soft); color: var(--c-danger); }
.tag[data-tone='accent'] { border-color: var(--c-accent-border); background: var(--c-accent-soft); color: var(--c-accent); }

.purge {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

@media (prefers-reduced-motion: reduce) {
  .fade-in, .skeleton-row, .generated-list code { animation: none !important; opacity: 1; transform: none; }
  .expand-enter-active, .expand-leave-active, .pop-enter-active, .pop-leave-active { transition: none !important; }
}
</style>
