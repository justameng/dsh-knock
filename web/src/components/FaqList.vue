<script setup>
import { computed, ref } from 'vue'
import { AccordionRoot, AccordionItem, AccordionHeader, AccordionTrigger, AccordionContent } from 'reka-ui'
import { site } from '../site.js'

const items = computed(() => [
  {
    value: 'code',
    question: '激活码从哪里获取？',
    answer: `激活码来自${site.value.code_source}，一人一码，核销后与你的浏览器绑定。如果提示已被绑定到其他设备，说明该码已被使用，需要重新获取。`,
  },
  {
    value: 'unreachable',
    question: '授权后页面打不开，是出错了吗？',
    answer: '不是。平台规定回调地址必须是 127.0.0.1，它指向你自己的设备，所以授权完成后浏览器会停在一个无法访问的页面。把地址栏里的整条地址复制回本站提交即可。',
  },
  {
    value: 'copy',
    question: '手机上怎么复制那条地址？',
    answer: '在打不开的页面上，长按地址栏，选择「全选」，再点「复制」。回到本站，点「从剪贴板粘贴」即可自动填入。地址以 http://127.0.0.1:1455/oauth/callback 开头，并包含 code= 参数。',
  },
  {
    value: 'token',
    question: '我的账号密码安全吗？',
    answer: '账号密码只在 platform.deepseek.com 的官方页面输入，本站不接触。授权令牌在服务器上只存在于兑换的那几秒，读完余额立即主动注销，不写入磁盘、不写入日志。',
  },
  {
    value: 'state',
    question: '提示「授权校验失败（state 不匹配）」怎么办？',
    answer: '通常是因为混用了两次授权的地址。请重新获取一次授权链接，只使用最新那次授权后跳转的地址。',
  },
  {
    value: 'ip',
    question: '提示「当前网络领取次数已达上限」？',
    answer: '本站限制每个网络每天只能领取一次，用于防止滥用。如果你确实没领过却遇到这个提示，可能是与他人共用同一个网络出口。请联系站长处理。',
  },
  {
    value: 'validity',
    question: '赠金多久有效？',
    answer: `到账后有效期为 ${site.value.bonus_validity}，建议领到后尽快使用。`,
  },
  {
    value: 'nobonus',
    question: '授权成功但没有查到赠金？',
    answer: '赠金由平台按其规则发放。账号可能已经领取过该活动赠金，或不符合活动条件。本站不参与判定，也无法干预。',
  },
])
</script>

<template>
  <section class="faq">
    <h2 class="faq-title">常见问题</h2>
    <AccordionRoot type="single" collapsible class="list">
      <AccordionItem v-for="item in items" :key="item.value" :value="item.value" class="item">
        <AccordionHeader class="header">
          <AccordionTrigger class="trigger">
            <span>{{ item.question }}</span>
            <span class="icon" aria-hidden="true" />
          </AccordionTrigger>
        </AccordionHeader>
        <AccordionContent class="content">
          <p>{{ item.answer }}</p>
        </AccordionContent>
      </AccordionItem>
    </AccordionRoot>
  </section>
</template>

<style scoped>
.faq { margin-top: 28px; }

.faq-title {
  margin-bottom: 12px;
  font-size: var(--fs-h2);
}

.list {
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}

.item + .item { border-top: 1px solid var(--c-border); }

.header { margin: 0; }

.trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 15px 18px;
  border: 0;
  background: none;
  color: var(--c-text);
  font: 550 var(--fs-sm) / 1.6 var(--font);
  text-align: left;
  cursor: pointer;
  transition: background .14s;
  -webkit-tap-highlight-color: transparent;
}

.trigger:hover { background: var(--c-surface-2); }

.icon {
  position: relative;
  flex: none;
  width: 12px;
  height: 12px;
}

.icon::before,
.icon::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 12px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--c-text-3);
  transform: translateY(-50%);
}

.icon::after {
  transform: translateY(-50%) rotate(90deg);
  transition: transform .16s;
}

.trigger[data-state='open'] .icon::after { transform: translateY(-50%) rotate(0deg); }

.content {
  padding: 0 18px 16px;
  font-size: var(--fs-sm);
  line-height: 1.8;
  color: var(--c-text-2);
}

.content p { margin: 0; }
</style>
