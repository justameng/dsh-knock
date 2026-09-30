/**
 * 回调地址解析。抽成独立模块，避免为了用这个纯函数而导入 index.mjs
 * （index.mjs 一被导入就会启动 HTTP 服务）。
 *
 * 用户从浏览器复制回来的东西形态很多：
 *   完整 URL          http://127.0.0.1:1455/oauth/callback?code=xxx&state=yyy
 *   只有 query        code=xxx&state=yyy
 *   带问号的 query    ?code=xxx&state=yyy
 *   只有 code         I8QpcRxkNKjKUZz4lBbkJxmLypHhpomcmxUF5DXL_dE
 * 这里全都要接住，并且对任何垃圾输入都不抛错。
 */

/**
 * @param {unknown} input - 用户粘贴的原文。
 * @returns {{code: string|null, state: string|null}}
 */
export function parseCallbackInput(input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) return { code: null, state: null }

  const tryParse = (text) => {
    try {
      const url = new URL(text, 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      if (code !== null && code.length > 0) return { code, state: url.searchParams.get('state') }
    } catch { /* 继续尝试别的形态 */ }
    return null
  }

  const direct = tryParse(raw)
  if (direct !== null) return direct

  const withQuery = tryParse(`http://127.0.0.1/?${raw.replace(/^\?/, '')}`)
  if (withQuery !== null) return withQuery

  // 实在只有一串 code。
  if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) return { code: raw, state: null }
  return { code: null, state: null }
}
