<script setup>
import { computed, ref } from 'vue'
import { adminApi } from '../../admin-api.js'

const emit = defineEmits(['notify'])

const form = ref({
  site_name: '',
  site_url: '',
  code_source: '',
  bonus_validity: '',
  tutorial: '',
  // 激活码开关。'true' / 'false' 字符串——后端按字符串存
  code_required: 'true',
  // 公告弹窗
  announce_enabled: 'false',
  announce_title: '',
  announce: '',
  announce_link_text: '',
  announce_link_url: '',
  announce_frequency: 'daily',
})

const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)

const codeRequired = computed(() => form.value.code_required !== 'false')
const announceEnabled = computed(() => form.value.announce_enabled === 'true')

async function load() {
  loading.value = true
  try {
    const result = await adminApi.settings()
    if (result.ok) {
      const s = result.body?.site ?? {}
      form.value = {
        site_name: s.site_name ?? '',
        site_url: s.site_url ?? '',
        code_source: s.code_source ?? '',
        bonus_validity: s.bonus_validity ?? '',
        tutorial: s.tutorial ?? '',
        code_required: s.code_required === false ? 'false' : 'true',
        announce_enabled: s.announce_enabled === true ? 'true' : 'false',
        announce_title: s.announce_title ?? '',
        announce: s.announce ?? '',
        announce_link_text: s.announce_link_text ?? '',
        announce_link_url: s.announce_link_url ?? '',
        announce_frequency: s.announce_frequency ?? 'daily',
      }
      loaded.value = true
    } else {
      emit('notify', 'error', '读取配置失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    loading.value = false
  }
}

async function save() {
  // 跳转链接必须合法，否则前端会渲染出一个点不动的按钮
  const url = form.value.announce_link_url.trim()
  if (url !== '' && !/^https?:\/\//i.test(url)) {
    emit('notify', 'error', '链接格式不对', '跳转链接需要以 http:// 或 https:// 开头。')
    return
  }
  saving.value = true
  try {
    const result = await adminApi.saveSettings(form.value)
    if (result.ok) {
      emit('notify', 'success', '已保存', `前台立即生效（更新 ${result.body.changed.length} 项）。`)
    } else {
      emit('notify', 'error', '保存失败', result.body?.message ?? `HTTP ${result.status}`)
    }
  } finally {
    saving.value = false
  }
}

/** 切换开关立即标记为未保存状态，提示用户点保存。 */
function toggleCode() {
  form.value.code_required = codeRequired.value ? 'false' : 'true'
}

function toggleAnnounce() {
  form.value.announce_enabled = announceEnabled.value ? 'false' : 'true'
}

defineExpose({ load })
</script>

<template>
  <div class="stack">
    <p v-if="loading" class="hint">正在加载…</p>

    <template v-else-if="loaded">
      <!-- 功能开关 -->
      <section class="panel">
        <h3 class="panel-title">功能开关</h3>

        <div class="switch-row">
          <div class="switch-text">
            <strong>激活码校验</strong>
            <span>
              开启时，用户必须填入有效激活码才能领取。
              关闭后前台<strong>整个跳过卡密环节</strong>（步骤条少一步），
              仅按「每设备次数」与「每 IP 每天次数」限制。
            </span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: codeRequired }"
            role="switch"
            :aria-checked="codeRequired"
            @click="toggleCode"
          >
            <span class="knob" />
          </button>
        </div>

        <p v-if="!codeRequired" class="warn">
          当前<strong>已关闭</strong>激活码校验：任何人都能直接领取，仅受「每设备次数」与「每 IP 每天次数」限制。
          发码渠道失效或做活动时才建议关闭。
        </p>

        <div class="switch-row">
          <div class="switch-text">
            <strong>公告弹窗</strong>
            <span>开启后用户进入领取页时会弹出公告，可附带一个跳转按钮（如加群、跳转站点）。</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: announceEnabled }"
            role="switch"
            :aria-checked="announceEnabled"
            @click="toggleAnnounce"
          >
            <span class="knob" />
          </button>
        </div>
      </section>

      <!-- 站点文案 -->
      <section class="panel">
        <h3 class="panel-title">站点文案</h3>
        <p class="panel-hint">直接显示在前台领取页，保存后立即生效。</p>
        <div class="grid">
          <div class="field">
            <label for="site-name">站点名称</label>
            <input id="site-name" v-model="form.site_name" type="text">
          </div>
          <div class="field">
            <label for="site-url">站点地址</label>
            <input id="site-url" v-model="form.site_url" type="text">
            <span class="tip">用于页脚与公告跳转</span>
          </div>
          <div class="field" :class="{ disabled: !codeRequired }">
            <label for="code-source">激活码发放渠道</label>
            <input id="code-source" v-model="form.code_source" type="text" :disabled="!codeRequired">
            <span class="tip">关闭激活码后此项不显示</span>
          </div>
          <div class="field">
            <label for="bonus-validity">赠金有效期</label>
            <input id="bonus-validity" v-model="form.bonus_validity" type="text">
            <span class="tip">例如：7 天</span>
          </div>
        </div>
      </section>

      <!-- 公告弹窗 -->
      <section class="panel" :class="{ muted: !announceEnabled }">
        <h3 class="panel-title">公告弹窗内容</h3>
        <p v-if="!announceEnabled" class="panel-hint">
          公告弹窗当前<strong>已关闭</strong>，下面的内容不会显示。填写后开启上方开关即可生效。
        </p>

        <div class="grid">
          <div class="field">
            <label for="announce-title">标题</label>
            <input id="announce-title" v-model="form.announce_title" type="text" placeholder="例如：重要通知">
          </div>
          <div class="field">
            <label for="announce-frequency">弹出频率</label>
            <select id="announce-frequency" v-model="form.announce_frequency">
              <option value="every">每次访问都弹</option>
              <option value="daily">每天弹一次</option>
              <option value="once">只弹一次</option>
            </select>
            <span class="tip">改动公告内容后会自动重新弹给所有人</span>
          </div>
        </div>

        <div class="field">
          <label for="announce-body">公告正文</label>
          <textarea
            id="announce-body"
            v-model="form.announce"
            rows="5"
            placeholder="支持换行。留空则只显示标题与按钮。"
          />
        </div>

        <div class="grid">
          <div class="field">
            <label for="announce-link-text">跳转按钮文字</label>
            <input id="announce-link-text" v-model="form.announce_link_text" type="text" placeholder="例如：加入群聊">
            <span class="tip">留空则不显示按钮</span>
          </div>
          <div class="field">
            <label for="announce-link-url">跳转链接</label>
            <input id="announce-link-url" v-model="form.announce_link_url" type="text" placeholder="https://...">
            <span class="tip">需以 http:// 或 https:// 开头</span>
          </div>
        </div>

        <div class="quick">
          <span class="tip">快捷填入：</span>
          <button type="button" class="btn btn-sm" @click="form.announce_link_text = '加入群聊'">
            加群按钮
          </button>
          <button
            type="button"
            class="btn btn-sm"
            @click="form.announce_link_text = '前往小学生公益站'; form.announce_link_url = form.site_url"
          >
            跳转公益站
          </button>
        </div>
      </section>

      <!-- 教程 -->
      <section class="panel" :class="{ muted: !codeRequired }">
        <h3 class="panel-title">领取教程</h3>
        <p class="panel-hint">
          一行一个步骤，前台按顺序编号展示。
          <template v-if="!codeRequired">关闭激活码后，记得把教程里提到激活码的那一步删掉。</template>
        </p>
        <textarea v-model="form.tutorial" rows="8" spellcheck="false" />
      </section>

      <div class="actions">
        <button v-ripple type="button" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '正在保存…' : '保存配置' }}
        </button>
        <button v-ripple type="button" class="btn" @click="load">放弃修改</button>
      </div>
    </template>

    <p v-else class="hint">无法读取配置。</p>
  </div>
</template>

<style scoped>
.stack {
  display: grid;
  gap: 14px;
}

.panel {
  padding: 20px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-sm);
  transition: opacity .2s;
}

/* 关闭的功能用降透明度表示「当前不生效」 */
.panel.muted {
  opacity: .72;
}

.panel-title {
  margin: 0 0 6px;
  font-size: var(--fs-sm);
  font-weight: 620;
  color: var(--c-text-2);
}

.panel-hint {
  margin: 0 0 16px;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--c-text-3);
}

/* ── 开关 ── */
.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--c-border);
}

.switch-row:last-of-type {
  border-bottom: 0;
  padding-bottom: 0;
}

.switch-text strong {
  display: block;
  margin-bottom: 4px;
  font-size: var(--fs-sm);
  font-weight: 600;
}

.switch-text span {
  display: block;
  font-size: var(--fs-xs);
  line-height: 1.75;
  color: var(--c-text-3);
}

.switch {
  position: relative;
  flex: none;
  width: 46px;
  height: 26px;
  margin-top: 2px;
  padding: 0;
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  background: #e5e7eb;
  cursor: pointer;
  transition: background .2s var(--ease-out), border-color .2s;
}

.switch.on {
  border-color: var(--c-accent);
  background: var(--c-accent);
}

.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(16, 24, 40, .2);
  transition: transform .2s var(--ease-out);
}

.switch.on .knob {
  transform: translateX(20px);
}

.warn {
  margin: 14px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--c-warn-border);
  border-radius: var(--r);
  background: var(--c-warn-soft);
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--c-warn);
}

/* ── 表单 ── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.field {
  margin-bottom: 14px;
}

.field.disabled {
  opacity: .5;
}

.field label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-sm);
  font-weight: 550;
  color: var(--c-text-2);
}

.field textarea {
  font-family: var(--font);
  resize: vertical;
  line-height: 1.8;
}

.tip {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--c-text-3);
}

.quick {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hint {
  padding: 40px 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--fs-sm);
}

.actions {
  display: flex;
  gap: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch .knob,
  .panel {
    transition: none;
  }
}
</style>
