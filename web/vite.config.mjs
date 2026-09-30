import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 部署：构建产物输出到 web/dist，把 dist 作为站点根目录即可。
 * 后端 server/ 独立运行，不受构建影响。
 *
 * 开发预览时可用 DSH_BONUS_INJECT_BACKEND 注入后端地址，
 * 便于本地联调而不必改 index.html。
 */
const injectedBackend = process.env.DSH_BONUS_INJECT_BACKEND ?? ''

/**
 * 把注入的后端地址写进 index.html 的运行时配置块。
 *
 * 必须同时挂 configureServer 和 configurePreviewServer：
 * transformIndexHtml 只在 build 与 dev server 生效，
 * preview 走的是静态文件中间件，不会调用它。
 *
 * 注入失败必须**大声报错**，不能静默跳过：曾经替换不上（比如 index.html
 * 里的引号从单引号改成双引号、或多打了个空格）时什么都不说，
 * 前端照常启动，只是显示「站点尚未配置完成」——
 * 这个现象会把排查方向完全带偏到后端去了。
 */
function injectBackend() {
  // 匹配 backend 字段的空值写法，容忍单双引号与任意空白
  const PATTERN = /backend:\s*(['"])\1/

  const apply = (html) => {
    if (injectedBackend === '') return html
    if (!PATTERN.test(html)) {
      throw new Error(
        '[dsh-bonus] 无法注入后端地址：index.html 里找不到 `backend: \'\'` 占位。\n'
        + '  请确认 index.html 的运行时配置块里仍有这一行（引号可为单或双）。',
      )
    }
    return html.replace(PATTERN, `backend: ${JSON.stringify(injectedBackend)}`)
  }

  return {
    name: 'dsh-bonus-inject-backend',
    transformIndexHtml(html) {
      return apply(html)
    },
    configurePreviewServer(server) {
      if (injectedBackend === '') return
      // 在静态中间件之前拦截 index.html，返回注入后的内容。
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/' && req.url !== '/index.html') { next(); return }
        try {
          const { readFile } = await import('node:fs/promises')
          const { join } = await import('node:path')
          const raw = await readFile(join(server.config.build.outDir, 'index.html'), 'utf8')
          const body = Buffer.from(apply(raw), 'utf8')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
          res.end(body)
        } catch {
          next()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), injectBackend()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5273,
  },
})
