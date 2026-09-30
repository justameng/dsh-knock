<script setup>
import { computed } from 'vue'
import { formatAmount } from '../../format.js'
import { outcomeLabel, deployModeLabel } from '../../labels.js'
import { useCountUp } from '../../motion.js'

const props = defineProps({
  overview: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})

const d = computed(() => props.overview?.dashboard ?? null)

/**
 * 关键指标。用 CountUp 让数字滚动到位——直接跳变很生硬。
 *
 * 注意：useCountUp 必须在 setup 顶层调用，不能放进 computed 里，
 * 否则每次重算都会新建一组 ref 与 rAF 循环。
 */
const num = {
  total: useCountUp(computed(() => d.value?.codes.total ?? 0)),
  used: useCountUp(computed(() => d.value?.codes.used ?? 0)),
  today: useCountUp(computed(() => d.value?.redemption.today ?? 0)),
  devices: useCountUp(computed(() => d.value?.traffic.devices ?? 0)),
}

const primary = computed(() => {
  const data = d.value
  if (data === null) return []
  return [
    { key: 'total', label: '激活码总数', counter: num.total, sub: `未使用 ${data.codes.unused}`, tone: '' },
    { key: 'used', label: '已领取', counter: num.used, sub: `使用率 ${data.codes.used_rate}%`, tone: 'ok' },
    { key: 'today', label: '今日领取', counter: num.today, sub: `累计 ${data.redemption.total}`, tone: 'accent' },
    { key: 'devices', label: '独立设备', counter: num.devices, sub: `今日独立 IP ${data.traffic.ips_today}`, tone: '' },
  ]
})

const secondary = computed(() => {
  const data = d.value
  if (data === null) return []
  return [
    { label: '已绑定未完成', value: data.codes.active, hint: '已核销但还没走完授权' },
    { label: '已作废', value: data.codes.revoked, hint: '被管理员作废的激活码' },
    { label: '最近一小时', value: data.redemption.last_hour, hint: '近 60 分钟内的领取数' },
    { label: '查到赠金', value: data.redemption.hit, hint: '成功查到 CNY 赠金' },
    { label: '未查到赠金', value: data.redemption.miss, hint: '授权成功但账号没有赠金' },
    { label: '今日请求流水', value: data.traffic.attempts_today, hint: '所有请求，含被拒的' },
    { label: '进行中会话', value: data.traffic.sessions_waiting, hint: '用户正在授权中' },
  ]
})

const quota = computed(() => {
  const q = d.value?.quota
  if (q === undefined) return []
  return [
    ['每设备', `${q.max_per_device} 次`],
    ['每 IP 每天', `${q.max_per_ip_day} 次`],
    ['每 IP 每分钟发起', `${q.max_starts_per_minute} 次`],
    ['每 IP 每小时发起', `${q.max_starts_per_hour} 次`],
  ]
})

const deploy = computed(() => {
  const info = d.value?.deploy
  if (info === undefined) return []
  return [
    ['部署模式', deployModeLabel(info.mode)],
    ['代理头信任', info.trust_proxy ? '已开启' : '已关闭'],
    ['会话有效期', `${info.session_ttl_minutes} 分钟`],
    ['读后注销令牌', info.revoke_after_read ? '是' : '否'],
  ]
})

/** 趋势条：补齐 14 天，空缺显示为 0，避免图表忽长忽短。 */
const dailyBars = computed(() => {
  const rows = props.overview?.daily ?? []
  const map = new Map(rows.map((r) => [r.day, r.count]))
  const out = []
  for (let i = 13; i >= 0; i -= 1) {
    const dt = new Date(Date.now() - i * 86_400_000)
    const day = dt.toISOString().slice(0, 10)
    out.push({ day, count: map.get(day) ?? 0 })
  }
  return out
})

const maxDaily = computed(() => Math.max(...dailyBars.value.map((r) => r.count), 1))

/**
 * 柱高按最大值归一化成百分比。
 * 父级 .chart-bar-wrap 是 flex 项、高度确定，百分比能正确解析。
 */
function barHeight(count) {
  if (count === 0) return '3px'
  return `${Math.max(Math.round((count / maxDaily.value) * 100), 8)}%`
}

/** 结果分布：翻译成中文，按数量排序，并算出占比用于画条。 */
const outcomes = computed(() => {
  const rows = props.overview?.outcomes ?? []
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1
  return rows.map((row) => {
    const meta = outcomeLabel(row.outcome)
    return {
      code: row.outcome,
      label: meta.label,
      hint: meta.hint,
      tone: meta.tone,
      count: row.count,
      percent: Math.round((row.count / total) * 100),
    }
  })
})

/** 当天有数据的日期，用于趋势图 tooltip。 */
const todayCount = computed(() => dailyBars.value[dailyBars.value.length - 1]?.count ?? 0)

const tidy = (v) => (v === null || v === undefined ? '—' : formatAmount(v))
</script>

<template>
  <div class="overview">
    <!-- 骨架屏：加载中保持布局稳定，不跳动 -->
    <div v-if="loading && d === null" class="metrics">
      <div v-for="i in 4" :key="i" class="metric skeleton" />
    </div>

    <template v-else-if="d !== null">
      <!-- 关键指标 -->
      <div class="metrics">
        <div
          v-for="(item, index) in primary"
          :key="item.key"
          v-reveal="{ delay: index * 50 }"
          class="metric lift"
          :data-tone="item.tone"
        >
          <span class="metric-label">{{ item.label }}</span>
          <span class="metric-value">{{ item.counter.value }}</span>
          <span class="metric-sub">{{ item.sub }}</span>
        </div>
      </div>

      <!-- 次要指标 -->
      <div v-reveal="{ delay: 180 }" class="strip">
        <div v-for="item in secondary" :key="item.label" class="strip-item" :title="item.hint">
          <span class="strip-value">{{ item.value }}</span>
          <span class="strip-label">{{ item.label }}</span>
        </div>
      </div>

      <div class="grid-2">
        <!-- 趋势 -->
        <section v-reveal="{ delay: 60 }" class="panel">
          <header class="panel-head">
            <h3 class="panel-title">最近 14 天领取趋势</h3>
            <span class="panel-note">今日 {{ todayCount }}</span>
          </header>
          <div class="chart">
            <div
              v-for="(row, index) in dailyBars"
              :key="row.day"
              class="chart-col"
              :title="`${row.day} · ${row.count} 次`"
            >
              <span class="chart-bar-wrap">
                <span
                  class="chart-bar"
                  :class="{ 'is-zero': row.count === 0 }"
                  :style="{
                    height: barHeight(row.count),
                    animationDelay: `${300 + index * 22}ms`,
                  }"
                />
              </span>
              <span class="chart-count" :class="{ zero: row.count === 0 }">{{ row.count }}</span>
            </div>
          </div>
        </section>

        <!-- 结果分布（中文 + 占比条） -->
        <section v-reveal="{ delay: 120 }" class="panel">
          <header class="panel-head">
            <h3 class="panel-title">近 7 天请求结果</h3>
            <span class="panel-note">共 {{ outcomes.reduce((s, o) => s + o.count, 0) }} 次</span>
          </header>
          <p v-if="outcomes.length === 0" class="empty">暂无数据</p>
          <ul v-else class="outcome-list">
            <li v-for="(item, index) in outcomes" :key="item.code" class="outcome" :data-tone="item.tone">
              <div class="outcome-main">
                <span class="outcome-label">{{ item.label }}</span>
                <span class="outcome-count">{{ item.count }}</span>
              </div>
              <div class="outcome-track">
                <span
                  class="outcome-fill"
                  :style="{ width: `${Math.max(item.percent, 2)}%`, animationDelay: `${340 + index * 40}ms` }"
                />
              </div>
              <span class="outcome-hint">{{ item.hint }} · {{ item.percent }}%</span>
            </li>
          </ul>
        </section>
      </div>

      <div class="grid-2">
        <section v-reveal="{ delay: 60 }" class="panel">
          <h3 class="panel-title">配额限制</h3>
          <dl class="kv">
            <template v-for="([k, v]) in quota" :key="k">
              <dt>{{ k }}</dt><dd>{{ v }}</dd>
            </template>
          </dl>
        </section>
        <section v-reveal="{ delay: 120 }" class="panel">
          <h3 class="panel-title">运行信息</h3>
          <dl class="kv">
            <template v-for="([k, v]) in deploy" :key="k">
              <dt>{{ k }}</dt><dd>{{ v }}</dd>
            </template>
            <dt>数据目录</dt>
            <dd class="wrap">{{ d.deploy.data_dir }}</dd>
          </dl>
        </section>
      </div>
    </template>

    <p v-else class="empty">无法读取统计数据。</p>
  </div>
</template>

<style scoped>
/* ── 入场动效 ── */
.rise {
  opacity: 0;
  animation: rise .42s cubic-bezier(.22, .9, .3, 1) forwards;
}

/* ── 关键指标 ── */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
  gap: 12px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 18px 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
}

.metric-label {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
  font-weight: 500;
}

.metric-value {
  font-size: 30px;
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.metric-sub {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

.metric[data-tone='ok'] .metric-value { color: var(--c-success); }
.metric[data-tone='accent'] .metric-value { color: var(--c-accent); }

/* 骨架屏 */
.skeleton {
  height: 104px;
  border-color: transparent;
  background: linear-gradient(90deg, #eef0f3 25%, #f6f7f9 50%, #eef0f3 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s ease-in-out infinite;
}

@keyframes shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

/* ── 次要指标条 ── */
.strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
  gap: 1px;
  margin-top: 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  background: var(--c-border);
  overflow: hidden;
}

.strip-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 12px 14px;
  background: var(--c-surface);
  cursor: help;
  transition: background .16s;
}

.strip-item:hover { background: var(--c-surface-2); }

.strip-value {
  font-size: 18px;
  font-weight: 620;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.strip-label {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

/* ── 面板 ── */
.grid-2 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  margin-top: 14px;
}

@media (min-width: 900px) {
  .grid-2 { grid-template-columns: 1fr 1fr; }
}

.panel {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 16px;
}

.panel-title {
  margin: 0 0 16px;
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--c-text-2);
}

.panel-head .panel-title { margin: 0; }

.panel-note {
  font-size: var(--fs-xs);
  color: var(--c-text-3);
  font-variant-numeric: tabular-nums;
}

.empty {
  color: var(--c-text-3);
  font-size: var(--fs-sm);
  text-align: center;
  padding: 24px 0;
}

/* ── 柱状图 ──
   图表撑满面板剩余高度，避免与右侧更高的面板并排时下方留出大片空白。 */
.chart {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  min-height: 150px;
}

.chart-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  min-width: 0;
  cursor: default;
}

.chart-bar-wrap {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  min-height: 0;
}

/**
 * 柱子高度用百分比，相对 .chart-bar-wrap（flex 项，高度确定）。
 * 注意别再用 .empty 类名——那个类属于空状态段落，会互相污染。
 */
.chart-bar {
  display: block;
  flex: none;
  width: 100%;
  max-width: 24px;
  min-height: 3px;
  border-radius: 4px 4px 2px 2px;
  background: linear-gradient(180deg, #5b8cff, #2f6bff);
  animation: grow .5s cubic-bezier(.22, .9, .3, 1) backwards;
  transition: filter .16s;
}

/* 零值柱子：只做视觉区分，不要用 .empty —— 那个类名属于空状态段落，
   两者会互相污染（scoped CSS 只加哈希，不隔离类名）。 */
.chart-bar.is-zero {
  background: #e3e6ea;
  border-radius: 2px;
}

.chart-col:hover .chart-bar { filter: brightness(1.12); }

@keyframes grow {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}

.chart-count {
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--c-text-2);
  font-variant-numeric: tabular-nums;
}

.chart-count.zero { color: #c3c8d0; }

/* ── 结果分布 ── */
.outcome-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 12px;
  align-content: start;
}

.outcome {
  min-width: 0;
}

.outcome-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
}

.outcome-label {
  font-size: var(--fs-sm);
  font-weight: 550;
  color: var(--c-text);
}

.outcome-count {
  font-size: var(--fs-sm);
  font-family: var(--font-mono);
  font-weight: 620;
  color: var(--c-text-2);
  font-variant-numeric: tabular-nums;
}

.outcome-track {
  height: 5px;
  border-radius: 3px;
  background: #eef0f3;
  overflow: hidden;
}

.outcome-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--c-accent);
  transform-origin: left;
  animation: sweep .55s cubic-bezier(.22, .9, .3, 1) backwards;
}

.outcome[data-tone='ok'] .outcome-fill { background: var(--c-success); }
.outcome[data-tone='warn'] .outcome-fill { background: #e8a33d; }
.outcome[data-tone='bad'] .outcome-fill { background: #e05c5c; }

@keyframes sweep {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}

.outcome-hint {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

/* ── 键值表 ── */
.kv {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 9px 18px;
  font-size: var(--fs-sm);
}

.kv dt { color: var(--c-text-3); }
.kv dd { margin: 0; color: var(--c-text-2); font-weight: 500; }
.wrap { word-break: break-all; font-weight: 400; }

/* 窄屏：图表压缩但保持完整 */
@media (max-width: 420px) {
  .chart { height: 104px; }
  .chart-count { font-size: 9px; }
  .metric-value { font-size: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  .rise, .chart-bar, .outcome-fill, .skeleton {
    animation: none !important;
    opacity: 1;
    transform: none;
  }
}
</style>
