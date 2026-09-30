/**
 * 真实浏览器验证（前台 + 管理后台），用真实平台接口。
 *
 *   node tests/visual.mjs
 *
 * 与其它测试不同，这里**不使用平台替身**，因为要确认：
 *   1. 授权链接是平台真实签发的（authorize_id 不是 mock）
 *   2. 页面渲染与交互正确
 *   3. 多分辨率无横向溢出
 *
 * 注意：每跑一次会真实调用一次 auth_init（随即取消），不消耗赠金。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const SHOTS = join(WEB, '.shots')
const SITE_PORT = 5273
const SITE_ORIGIN = `http://localhost:${SITE_PORT}`
const SERVER_PORT = 8795
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`
const ADMIN_TOKEN = 'visual-admin-token-0123456789'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-bonus-visual-'))

const PLAYWRIGHT = 'G:/deepseek-harness/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs'
const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href)

mkdirSync(SHOTS, { recursive: true })
const children = []
const start = (file, args, env = {}) => children.push(spawn(process.execPath, [join(WEB, file), ...args], {
  stdio: 'ignore',
  env: { ...process.env, ...env },
}))

async function waitFor(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.status < 500) return true
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  return false
}

const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }
const errors = []
let browser = null

try {
  // 注意：不设 DSH_BONUS_TEST_DOUBLE，走真实平台。
  start('server/index.mjs', [], {
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    DSH_BONUS_ADMIN_TOKEN: ADMIN_TOKEN,
    DSH_BONUS_DATA_DIR: DATA_DIR,
    DSH_BONUS_ALLOWED_ORIGINS: SITE_ORIGIN,
    DSH_BONUS_MAX_PER_DEVICE: '5',
    DSH_BONUS_DEPLOY_MODE: 'cloudflare',
    DSH_BONUS_MAX_PER_IP_DAY: '100',
    DSH_BONUS_MAX_STARTS_IP_MIN: '200',
    DSH_BONUS_MAX_STARTS_IP_HOUR: '2000',
  })
  start('node_modules/vite/bin/vite.js', ['preview', '--port', String(SITE_PORT), '--strictPort'], {
    DSH_BONUS_INJECT_BACKEND: SERVER_ORIGIN,
  })

  if (!await waitFor(`${SERVER_ORIGIN}/api/config`) || !await waitFor(`http://127.0.0.1:${SITE_PORT}/`)) {
    throw new Error('服务未就绪')
  }

  const gen = await fetch(`${SERVER_ORIGIN}/admin/codes`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ count: 8, batch: '预览批次', note: '视觉验证' }),
  }).then((r) => r.json())
  const code = gen.codes[0]

  browser = await chromium.launch({ channel: 'msedge' })

  /* ── 前台 ── */
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, deviceScaleFactor: 2 })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`${SITE_ORIGIN}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, 'f1-start.png'), fullPage: true })

  await page.getByRole('button', { name: '阅读协议并开始' }).click()
  await page.waitForTimeout(500)
  const agreeBefore = await page.getByRole('button', { name: '同意并继续' }).isDisabled()
  await page.locator('.body').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(300)
  const agreeAfter = await page.getByRole('button', { name: '同意并继续' }).isDisabled()
  await page.screenshot({ path: join(SHOTS, 'f2-terms.png') })

  // 弹窗必须留出边距、四角圆角完整，不能贴边铺满屏幕
  const dialogBox = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet')
    if (sheet === null) return null
    const r = sheet.getBoundingClientRect()
    const cs = getComputedStyle(sheet)
    return {
      gapTop: Math.round(r.top),
      gapLeft: Math.round(r.left),
      gapRight: Math.round(window.innerWidth - r.right),
      gapBottom: Math.round(window.innerHeight - r.bottom),
      radius: cs.borderTopLeftRadius,
      w: Math.round(r.width),
      h: Math.round(r.height),
    }
  })

  // 通知必须：有样式（fixed 定位 + 圆角 + 阴影）、有数量上限。
  // 曾经的 bug：scoped 样式加不到 portal 上，通知变成页面流里的一串裸 li。
  await page.getByRole('button', { name: '同意并继续' }).click()
  await page.waitForTimeout(600)

  // 连点 6 次核销（不填激活码），触发 6 条错误通知
  for (let i = 0; i < 6; i += 1) {
    await page.getByRole('button', { name: '核销激活码' }).click()
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, 'f2b-toasts.png'), fullPage: true })

  const toastCheck = await page.evaluate(() => {
    const viewport = document.querySelector('.dsh-toast-viewport')
    const items = [...document.querySelectorAll('.dsh-toast')]
    if (viewport === null || items.length === 0) return { count: items.length, ok: false, reason: '未找到通知' }
    const cs = getComputedStyle(viewport)
    const first = items[0]
    const fcs = getComputedStyle(first)
    return {
      count: items.length,
      position: cs.position,
      // 必须脱离文档流，否则会铺在页面内容里
      isFixed: cs.position === 'fixed',
      hasRadius: parseFloat(fcs.borderTopLeftRadius) > 0,
      hasShadow: fcs.boxShadow !== 'none',
      // 通知不应出现在页面主内容区（.page 内）
      insidePage: document.querySelector('.page .dsh-toast') !== null,
    }
  })
  // 清掉通知，避免影响后续断言
  await page.evaluate(() => {
    document.querySelectorAll('.dsh-toast-close').forEach((b) => b.click())
  })
  await page.waitForTimeout(300)
  await page.locator('#code-input').fill(code)
  await page.getByRole('button', { name: '核销激活码' }).click()

  // 等真实平台返回授权链接；失败时把页面状态打出来，便于定位。
  // 注意：成功后进入「粘贴回调地址」阶段，该阶段按钮叫「重新打开授权页」。
  try {
    await page.waitForSelector('button:has-text("重新打开授权页")', { timeout: 30000 })
  } catch {
    await page.screenshot({ path: join(SHOTS, 'debug-link-failed.png'), fullPage: true })
    const text = await page.locator('.page').innerText().catch(() => '')
    throw new Error(`未拿到授权链接。页面内容：\n${String(text).slice(0, 700)}`)
  }
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, 'f3-link.png'), fullPage: true })

  // 取出页面上展示的授权链接。
  //
  // 刻意不走 /api/status 的测试后门：那些字段（__state / __authorize_id）
  // 只在启用平台替身时下发，而这里跑的是真实平台。
  // 而且从「链接真伪」这个验证目的看，真实浏览器打开授权页得到的 URL
  // 才是最直接的证据——不依赖任何测试专用通道。
  const sessionId = await page.evaluate(() => window.__dshSessionId ?? null)

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
    page.getByRole('button', { name: '重新打开授权页' }).click(),
  ])
  let authUrl = popup?.url() ?? ''
  if (popup) await popup.close()

  // 退路：从页面里读前端保存的授权地址（requestLink 时写入的调试字段）
  if (authUrl === '') {
    authUrl = await page.evaluate(() => window.__dshAuthorizeUrl ?? '')
  }
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, 'f4-callback.png'), fullPage: true })

  /* ── 管理后台 ── */
  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
  admin.on('pageerror', (e) => errors.push(`admin: ${e}`))
  await admin.goto(`${SITE_ORIGIN}/#/admin`, { waitUntil: 'networkidle' })
  await admin.waitForTimeout(500)
  await admin.screenshot({ path: join(SHOTS, 'a1-login.png') })

  await admin.locator('#admin-token').fill(ADMIN_TOKEN)
  await admin.getByRole('button', { name: '进入后台' }).click()
  await admin.waitForTimeout(1800)
  await admin.screenshot({ path: join(SHOTS, 'a2-overview.png'), fullPage: true })
  const statCards = await admin.locator('.metric').count()

  await admin.locator('.nav-item', { hasText: '激活码' }).click()
  await admin.waitForTimeout(1400)
  await admin.screenshot({ path: join(SHOTS, 'a3-codes.png'), fullPage: true })
  const codeRows = await admin.locator('.table tbody tr').count()

  await admin.locator('.nav-item', { hasText: '明细' }).click()
  await admin.waitForTimeout(1400)
  await admin.screenshot({ path: join(SHOTS, 'a4-records.png'), fullPage: true })

  await admin.locator('.nav-item', { hasText: '配置' }).click()
  await admin.waitForTimeout(1400)
  await admin.screenshot({ path: join(SHOTS, 'a5-settings.png'), fullPage: true })
  const settingsName = await admin.locator('#site-name').inputValue().catch(() => '')

  /* ── 多分辨率完整性检查 ── */
  const overflow = {}
  const VIEWPORTS = [
    ['320', 320, 640],
    ['375', 375, 812],
    ['390', 390, 844],
    ['768', 768, 1024],
    ['1024', 1024, 768],
    ['1280', 1280, 900],
    ['1920', 1920, 1080],
  ]
  for (const [name, width, height] of VIEWPORTS) {
    const p = await browser.newPage({ viewport: { width, height } })
    await p.goto(`${SITE_ORIGIN}/`, { waitUntil: 'networkidle' })
    await p.waitForTimeout(600)
    // 检查横向溢出，并确认关键元素都在视口内。
    //
    // 注意：只查 documentElement 的 scrollWidth 是不够的——
    // overflow-x: auto 的容器会自己滚动，不产生页面级溢出，
    // 但用户看到的是被裁切的内容（步骤条第 4 步曾经被切成一个圈）。
    // 所以这里逐个检查所有可滚动容器，以及关键元素的可见性。
    overflow[`前台 ${name}`] = await p.evaluate(() => {
      const de = document.documentElement
      const issues = []

      // 1. 页面级横向溢出
      if (de.scrollWidth > de.clientWidth) issues.push(`页面溢出 ${de.scrollWidth}>${de.clientWidth}`)

      // 2. 所有容器的内容裁切（含横向滚动容器）
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        const scrollableX = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
        if (!scrollableX) continue
        // 内容比容器宽 → 用户看到的是被裁掉的内容
        if (el.scrollWidth > el.clientWidth + 1) {
          const name = el.className && typeof el.className === 'string'
            ? el.className.split(' ')[0]
            : el.tagName.toLowerCase()
          issues.push(`容器裁切 .${name} ${el.scrollWidth}>${el.clientWidth}`)
        }
      }

      // 3. 步骤条：四步必须全部完整可见（这是主进度指示，不能裁切）
      const steps = [...document.querySelectorAll('.step')]
      if (steps.length !== 4) {
        issues.push(`步骤数异常 ${steps.length}`)
      } else {
        for (const [i, el] of steps.entries()) {
          const r = el.getBoundingClientRect()
          if (r.right > window.innerWidth + 1 || r.left < -1) {
            issues.push(`第 ${i + 1} 步超出视口`)
          }
          // 文字被 ellipsis 截断也算不完整
          const text = el.querySelector('.step-text')
          if (text !== null && text.scrollWidth > text.clientWidth + 1) {
            issues.push(`第 ${i + 1} 步文字被截断`)
          }
        }
      }

      // 4. 主卡片与主按钮
      const card = document.querySelector('.card')
      if (card === null || card.getBoundingClientRect().width === 0) issues.push('主卡片未渲染')
      const btn = document.querySelector('.card .btn')
      if (btn !== null) {
        const r = btn.getBoundingClientRect()
        if (r.left < -1 || r.right > window.innerWidth + 1) issues.push('主按钮超出视口')
      }

      return { issues }
    })
    if (name === '320') await p.screenshot({ path: join(SHOTS, 'r320.png'), fullPage: true })
    if (name === '390') await p.screenshot({ path: join(SHOTS, 'r390.png'), fullPage: true })
    if (name === '560') await p.screenshot({ path: join(SHOTS, 'r560.png'), fullPage: true })
    if (name === '1920') await p.screenshot({ path: join(SHOTS, 'r1920.png'), fullPage: true })
    await p.close()
  }

  // 后台在移动端的表现
  for (const [name, width, height] of [['390', 390, 844], ['768', 768, 1024], ['320', 320, 640]]) {
    const p = await browser.newPage({ viewport: { width, height } })
    await p.goto(`${SITE_ORIGIN}/#/admin`, { waitUntil: 'networkidle' })
    await p.locator('#admin-token').fill(ADMIN_TOKEN)
    await p.getByRole('button', { name: '进入后台' }).click()
    await p.waitForTimeout(2000)

    // 逐个页签检查，而不是只看概览
    for (const tabName of ['概览', '激活码', '明细', '额度', '配置']) {
      await p.locator('.nav-item', { hasText: tabName }).click()
      await p.waitForTimeout(1100)

      const result = await p.evaluate(() => {
        const de = document.documentElement
        const issues = []
        const vw = window.innerWidth

        // 1. 页面级横向溢出
        if (de.scrollWidth > de.clientWidth) issues.push(`页面溢出 ${de.scrollWidth}>${de.clientWidth}`)

        // 2. 有背景色的容器必须铺满视口宽度。
        //    顶栏曾经被导航撑宽，白底只铺到一半，右边露出底色——
        //    这种情况不产生横向滚动，只看 scrollWidth 发现不了。
        for (const sel of ['.topbar', '.topbar-inner', '.nav']) {
          const el = document.querySelector(sel)
          if (el === null) continue
          const r = el.getBoundingClientRect()
          if (r.right > vw + 1) issues.push(`${sel} 超出视口（右边缘 ${Math.round(r.right)} > ${vw}）`)
          if (r.width > vw + 1) issues.push(`${sel} 宽度超视口（${Math.round(r.width)} > ${vw}）`)
        }

        // 3. 表格在窄屏必须已切换为卡片模式：
        //    表头隐藏、行以块级呈现，用户才不用横向滚。
        //    断点与 base.css 的 .table-cards 保持一致（900px）。
        const table = document.querySelector('.table-cards')
        if (table !== null && vw <= 900) {
          const thead = table.querySelector('thead')
          if (thead !== null && getComputedStyle(thead).display !== 'none') {
            issues.push('窄屏下表格未切换为卡片模式（表头仍显示）')
          }
          const row = table.querySelector('tbody tr')
          if (row !== null && getComputedStyle(row).display !== 'block') {
            issues.push('窄屏下表格行未转为块级')
          }
          // 表格容器不应出现横向滚动（卡片模式的目的就是消灭它）
          const wrap = table.closest('.table-wrap')
          if (wrap !== null && wrap.scrollWidth > wrap.clientWidth + 2) {
            issues.push(`卡片模式仍有横向滚动 ${wrap.scrollWidth}>${wrap.clientWidth}`)
          }
        }

        return { issues }
      })

      if (result.issues.length > 0) {
        overflow[`后台 ${name} · ${tabName}`] = result
      }
    }
    await p.screenshot({ path: join(SHOTS, `admin${name}.png`), fullPage: true })
    await p.close()
  }

  // 授权链接真伪判定：真实平台签发的 authorize_id 不会是 mock- 开头
  const isRealLink = authUrl.startsWith('https://platform.deepseek.com/dsh/authorize?')
    && !authUrl.includes('mock-')

  /* ── 动效验证 ── */
  const motionPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await motionPage.goto(`${SITE_ORIGIN}/`, { waitUntil: 'networkidle' })
  await motionPage.waitForTimeout(1200)
  const motion = await motionPage.evaluate(() => {
    const out = {}

    // 1. 首屏分层入场：hero 子元素应有动画
    const heroChild = document.querySelector('.hero-enter > *')
    out.heroAnimated = heroChild !== null
      && getComputedStyle(heroChild).animationName !== 'none'

    // 2. 背景流动层存在且在动
    const aurora = document.querySelector('.aurora')
    out.auroraAnimated = aurora !== null && getComputedStyle(aurora).animationName !== 'none'

    // 3. 滚动揭示：初始应处于未显示态（opacity < 1）
    const revealEls = [...document.querySelectorAll('.reveal')]
    out.revealCount = revealEls.length
    out.revealHasTransition = revealEls.length > 0
      && getComputedStyle(revealEls[0]).transitionDuration !== '0s'

    // 4. 按钮有过渡（悬停抬升的前提）
    const btn = document.querySelector('.btn')
    out.btnTransition = btn !== null && getComputedStyle(btn).transitionDuration !== '0s'

    // 5. 涟漪宿主类已挂上
    out.rippleHosts = document.querySelectorAll('.ripple-host').length

    return out
  })

  // 点击按钮应产生涟漪元素
  await motionPage.getByRole('button', { name: '阅读协议并开始' }).click()
  await motionPage.waitForTimeout(80)
  const rippleAppeared = await motionPage.evaluate(() => document.querySelectorAll('.ripple').length > 0)
  await motionPage.waitForTimeout(400)

  // 滚动到底，揭示元素应变为可见
  await motionPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await motionPage.waitForTimeout(900)
  const revealedAfterScroll = await motionPage.evaluate(() => {
    const els = [...document.querySelectorAll('.reveal')]
    return els.filter((el) => el.classList.contains('is-revealed')).length
  })
  await motionPage.close()

  console.log('\n── 动效 ──')
  console.log('  首屏分层入场 :', motion.heroAnimated ? '生效' : '未生效')
  console.log('  背景流动     :', motion.auroraAnimated ? '生效' : '未生效')
  console.log('  滚动揭示元素 :', `${motion.revealCount} 个，过渡 ${motion.revealHasTransition ? '已设置' : '缺失'}`)
  console.log('  按钮过渡     :', motion.btnTransition ? '已设置' : '缺失')
  console.log('  涟漪宿主     :', `${motion.rippleHosts} 个`)
  console.log('  点击产生涟漪 :', rippleAppeared ? '是' : '否')
  console.log('  滚动后已揭示 :', `${revealedAfterScroll} / ${motion.revealCount}`)
  const motionOk = motion.heroAnimated && motion.auroraAnimated && motion.revealHasTransition
    && motion.btnTransition && motion.rippleHosts > 0 && rippleAppeared
    && revealedAfterScroll > 0
  console.log('  动效整体判定 :', motionOk ? '通过' : '不通过 ← 有问题')

  // 手机端单独验一遍弹窗：必须留边距，不能铺满
  const mPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await mPage.goto(`${SITE_ORIGIN}/`, { waitUntil: 'networkidle' })
  await mPage.getByRole('button', { name: '阅读协议并开始' }).click()
  await mPage.waitForTimeout(500)
  await mPage.screenshot({ path: join(SHOTS, 'm2-terms.png') })
  const mobileDialog = await mPage.evaluate(() => {
    const sheet = document.querySelector('.sheet')
    if (sheet === null) return null
    const r = sheet.getBoundingClientRect()
    return {
      gapTop: Math.round(r.top),
      gapLeft: Math.round(r.left),
      gapRight: Math.round(window.innerWidth - r.right),
      gapBottom: Math.round(window.innerHeight - r.bottom),
      w: Math.round(r.width),
      vw: window.innerWidth,
    }
  })
  await mPage.close()

  console.log('弹窗边距(桌面)   :', dialogBox === null ? '未渲染'
    : `上 ${dialogBox.gapTop} / 左 ${dialogBox.gapLeft} / 右 ${dialogBox.gapRight} / 下 ${dialogBox.gapBottom}，圆角 ${dialogBox.radius}`)
  console.log('弹窗边距(手机390):', mobileDialog === null ? '未渲染'
    : `上 ${mobileDialog.gapTop} / 左 ${mobileDialog.gapLeft} / 右 ${mobileDialog.gapRight} / 下 ${mobileDialog.gapBottom}，宽 ${mobileDialog.w}/${mobileDialog.vw}`)
  const dialogOk = dialogBox !== null && mobileDialog !== null
    && [dialogBox.gapLeft, dialogBox.gapRight, mobileDialog.gapLeft, mobileDialog.gapRight]
      .every((g) => g >= 12)
  console.log('弹窗是否留边距   :', dialogOk ? '是' : '否 ← 贴边了')
  console.log('通知连点6次后数量:', toastCheck.count, '（上限 3）')
  console.log('通知脱离文档流   :', toastCheck.isFixed ? '是' : `否 ← position=${toastCheck.position}`)
  console.log('通知有圆角/阴影  :', toastCheck.hasRadius && toastCheck.hasShadow ? '是' : '否 ← 样式未生效')
  console.log('通知未混入内容区 :', toastCheck.insidePage ? '否 ← 混进去了' : '是')
  const toastOk = toastCheck.isFixed && toastCheck.hasRadius && toastCheck.hasShadow
    && !toastCheck.insidePage && toastCheck.count <= 3 && toastCheck.count > 0
  console.log('通知整体判定     :', toastOk ? '通过' : '不通过 ← 有问题')

  console.log('授权链接         :', authUrl.slice(0, 90))
  console.log('链接是否真实     :', isRealLink ? '是（平台签发）' : '否 ← 有问题')
  console.log('协议滚到底前禁用 :', agreeBefore)
  console.log('协议滚到底后可用 :', !agreeAfter)
  console.log('后台指标卡数     :', statCards)
  console.log('后台卡密行数     :', codeRows)
  console.log('后台配置站点名   :', settingsName)
  console.log('\n── 多分辨率完整性 ──')
  for (const [name, v] of Object.entries(overflow)) {
    console.log(`  ${name.padEnd(12)} ${v.issues.length === 0 ? '正常' : `问题：${v.issues.join(' / ')}`}`)
  }
  const adminIssues = Object.entries(overflow).filter(([k]) => k.startsWith('后台'))
  console.log(`  后台页签检查 : ${adminIssues.length === 0 ? '全部正常（概览/激活码/明细/额度/配置 × 3 档分辨率）' : `${adminIssues.length} 项有问题`}`)
  console.log('\n页面错误         :', errors.length === 0 ? '无' : errors.join(' | '))
  console.log(`截图目录         : ${SHOTS}`)
} catch (error) {
  console.log(`视觉验证中断：${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  for (const child of children) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
  await sleep(400)
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 清理失败无妨 */ }
}
