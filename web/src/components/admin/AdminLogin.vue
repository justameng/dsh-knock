<script setup>
import { ref } from 'vue'
import { verifyToken, setToken } from '../../admin-api.js'

const emit = defineEmits(['authed'])

const input = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  const token = input.value.trim()
  if (token.length === 0) {
    error.value = '请输入管理令牌。'
    return
  }
  busy.value = true
  error.value = ''
  setToken(token)
  const result = await verifyToken()
  busy.value = false
  if (!result.ok) {
    error.value = result.reason === 'unauthorized'
      ? '令牌不正确。'
      : '无法连接后端，请确认服务已启动、且前端已配置正确的后端地址。'
    return
  }
  emit('authed')
}
</script>

<template>
  <div class="wrap">
    <form class="box" @submit.prevent="submit">
      <div class="mark" aria-hidden="true">DSH</div>
      <h1 class="title">管理后台</h1>
      <p class="desc">需要管理令牌才能进入。</p>

      <label class="label" for="admin-token">管理令牌</label>
      <input
        id="admin-token"
        v-model="input"
        type="password"
        autocomplete="current-password"
        placeholder="粘贴管理令牌"
        :disabled="busy"
      >
      <p v-if="error" class="err">{{ error }}</p>

      <button type="submit" class="btn btn-primary btn-block mt-16" :disabled="busy">
        {{ busy ? '正在验证…' : '进入后台' }}
      </button>
      <a class="back" href="#/">← 返回领取页</a>
    </form>
  </div>
</template>

<style scoped>
.wrap {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: 24px;
}

.box {
  width: 100%;
  max-width: 380px;
  padding: 32px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-md);
  text-align: center;
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: 18px;
  border-radius: 12px;
  background: linear-gradient(145deg, #2f6bff, #1f4fd8);
  color: #fff;
  font: 700 14px/1 var(--font);
  letter-spacing: .04em;
  box-shadow: 0 6px 16px rgba(47, 107, 255, .26);
}

.title {
  font-size: var(--fs-h1);
  font-weight: 650;
}

.desc {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--c-text-3);
}

.label {
  display: block;
  margin: 22px 0 7px;
  font-size: var(--fs-sm);
  font-weight: 550;
  color: var(--c-text-2);
  text-align: left;
}

.err {
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  color: var(--c-danger);
  text-align: left;
}

.mt-16 { margin-top: 16px; }

.back {
  display: inline-block;
  margin-top: 18px;
  font-size: var(--fs-sm);
  color: var(--c-text-3);
  text-decoration: none;
}

.back:hover { color: var(--c-accent); }
</style>
