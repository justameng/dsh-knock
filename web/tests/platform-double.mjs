/**
 * 平台替身，仅供测试使用。
 *
 * 为什么不直接打真实平台：
 *   每跑一次测试都会消耗平台配额，反复跑还会把环境打到 RATE_LIMITED，
 *   让测试变得不稳定且不可重复。这里给出确定性的响应。
 *
 * 启用方式：DSH_BONUS_TEST_DOUBLE=<本文件绝对路径>
 */
import { shapeAccount } from '../server/platform.mjs'

/** 记录被调用的次数，供测试断言「同一次兑换只打了一次平台」。 */
export const calls = { init: 0, exchange: 0, cancel: 0, logout: 0, read: 0 }

/**
 * 令牌前缀。tests/privacy.mjs 用它当作「哨兵」在数据库里搜，
 * 验证授权令牌不会被落盘。改这个值时要同步改隐私测试。
 */
export const TOKEN_PREFIX = 'SENTINEL_TOKEN_'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default {
  async init() {
    // 先自增再 await：并发时若先 await 再自增，多个请求会读到同一个序号，
    // 导致授权链接重复——这是替身自身的竞态，会让测试误报服务器有问题。
    const seq = ++calls.init
    await delay(10)
    return {
      authorize_url: `https://platform.deepseek.com/dsh/authorize?authorize_id=mock-${seq}-${'a'.repeat(24)}`,
      authorize_id: `mock-${seq}-${'a'.repeat(24)}`,
      expires_in: 600,
    }
  },

  async exchange({ code }) {
    const seq = ++calls.exchange
    // 故意慢一点，让并发请求有机会重叠，从而验证共享去重。
    await delay(120)
    if (typeof code !== 'string' || code.startsWith('FAKE')) {
      const error = new Error('auth_exchange: 无效的授权码')
      error.kind = 'business'
      error.stage = 'auth_exchange'
      error.detail = 'INVALID_CODE'
      throw error
    }
    return {
      // 前缀刻意做成可搜索的哨兵，供隐私测试在数据库里查它是否落盘
      token: `${TOKEN_PREFIX}${seq}`,
      authorized_url: 'https://platform.deepseek.com/dsh/authorized?mock=1',
      user: null,
    }
  },

  async cancel() {
    calls.cancel += 1
    await delay(5)
    return {}
  },

  async logout() {
    calls.logout += 1
    return undefined
  },

  async read() {
    calls.read += 1
    await delay(10)
    return shapeAccount(
      { mobile: '176******70' },
      {
        normal_wallets: [{ balance: '0E-16', currency: 'CNY' }],
        bonus_wallets: [{ balance: '6.0000000000000000', currency: 'CNY' }],
      },
      [{ campaign: 'dsh_login_bonus', amount: '6.00', expires_at: '2026-10-06T18:27:48Z' }],
    )
  },
}
