/**
 * 前后端契约一致性检查。
 *
 *   node tests/contract.mjs
 *
 * 这类 bug 很难靠人工发现：后端加了新的枚举值，前端映射表没跟上，
 * 界面就显示兜底文案（比如部署模式全部显示成「直连」），
 * 误导排查方向，而且不报错、不崩溃。
 *
 * 这里直接读两边的源文件，比对枚举是否一致。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const read = (rel) => readFileSync(join(WEB, rel), 'utf8')

/**
 * 从源码里抓某个对象的键名。
 * 支持两种写法：裸键名 `auto:` 和带引号的键名 `'code.generate':`。
 */
function extractKeys(source, objectName) {
  const start = source.indexOf(`${objectName} = {`)
  if (start === -1) return null
  const body = source.slice(start)
  const end = body.indexOf('\n}')
  const block = body.slice(0, end === -1 ? body.length : end)
  const keys = []
  for (const line of block.split('\n')) {
    // 裸键名
    const bare = line.match(/^\s{2}([a-z_][a-z0-9_]*)\s*:/i)
    if (bare) { keys.push(bare[1]); continue }
    // 带引号的键名，如 'code.generate':
    const quoted = line.match(/^\s{2}'([^']+)'\s*:/)
    if (quoted) keys.push(quoted[1])
  }
  return keys
}

console.log('\n[1] 部署模式：后端 HEADER_CHAIN ↔ 前端 DEPLOY_MODE_LABELS')
const clientIpSrc = read('server/client-ip.mjs')
const labelsSrc = read('src/labels.js')

const backendModes = extractKeys(clientIpSrc, 'HEADER_CHAIN')
const frontendModes = extractKeys(labelsSrc, 'DEPLOY_MODE_LABELS')

check('后端能解析出模式列表', Array.isArray(backendModes) && backendModes.length > 0, JSON.stringify(backendModes))
check('前端能解析出模式列表', Array.isArray(frontendModes) && frontendModes.length > 0, JSON.stringify(frontendModes))

if (Array.isArray(backendModes) && Array.isArray(frontendModes)) {
  const missing = backendModes.filter((m) => !frontendModes.includes(m))
  check('前端覆盖了后端所有模式', missing.length === 0, `缺少: ${JSON.stringify(missing)}`)

  const extra = frontendModes.filter((m) => !backendModes.includes(m))
  check('前端没有多余模式', extra.length === 0, `多余: ${JSON.stringify(extra)}`)

  // auto / direct 是兜底与特例，必须存在
  check('后端有 auto 模式', backendModes.includes('auto'))
  check('后端有 direct 模式', backendModes.includes('direct'))
  check('后端有 edgeone 模式', backendModes.includes('edgeone'))
}

console.log('\n[2] 配置默认值与模式列表一致')
const configSrc = read('server/config.mjs')
// 写法形如：str(process.env.DSH_BONUS_DEPLOY_MODE, 'auto')
const defaultMode = configSrc.match(/DSH_BONUS_DEPLOY_MODE,\s*'([a-z]+)'/)?.[1]
check('能解析出默认部署模式', defaultMode !== undefined, String(defaultMode))
check('默认部署模式在列表内', backendModes?.includes(defaultMode), `默认值 ${defaultMode}`)

console.log('\n[3] 结果码：后端写入值 ↔ 前端 OUTCOME_LABELS')
// 后端写入 attempts 表的 outcome 有两类：
//   1. 单引号字面量，如 recordAttempt(ip, dev, 'started')
//   2. 模板字面量，如 recordAttempt(ip, dev, `init_${error?.kind ?? 'error'}`)
// 曾经的正则只匹配第 1 类，第 2 类完全隐形——于是 init_network 等六个值
// 一个都没进映射表，后台请求流水页全显示原始英文串 + 「未知结果」。
const indexSrc = read('server/index.mjs')
const storeSrc = read('server/store.mjs')

const staticOutcomes = new Set()
const dynamicPrefixes = new Set()
for (const src of [indexSrc, storeSrc]) {
  for (const m of src.matchAll(/recordAttempt\([^)]*?,\s*'([a-z_]+)'/g)) staticOutcomes.add(m[1])
  // 模板字面量：抓 `prefix${...}` 里 ${ 之前的静态部分。
  // 注意不能带尾下划线——`init_${...}` 的静态部分是 `init_`，
  // 拼出来的值是 `init_network` 而不是 `init__network`。
  for (const m of src.matchAll(/recordAttempt\([^)]*?,\s*`([a-z_]*?)\$\{/g)) dynamicPrefixes.add(m[1])
}

const outcomeKeys = extractKeys(labelsSrc, 'OUTCOME_LABELS') ?? []
check('后端有静态结果码', staticOutcomes.size > 0, JSON.stringify([...staticOutcomes]))
check('后端有动态结果码前缀', dynamicPrefixes.size > 0, JSON.stringify([...dynamicPrefixes]))

const missingStatic = [...staticOutcomes].filter((r) => !outcomeKeys.includes(r))
check('前端覆盖所有静态结果码', missingStatic.length === 0, `缺少: ${JSON.stringify(missingStatic)}`)

// 动态前缀：后端会拼出 `${prefix}${kind}`，前端必须覆盖全部 kind 组合。
// kind 取自 PlatformError 的 kind 字段（network/protocol/auth/business/waf/unexpected）。
// 前缀本身已含结尾下划线（如 `init_`），拼接时不要再加分隔符。
const PLATFORM_KINDS = ['network', 'protocol', 'auth', 'business', 'waf', 'unexpected']
const dynamicExpected = []
for (const prefix of dynamicPrefixes) {
  for (const kind of PLATFORM_KINDS) dynamicExpected.push(`${prefix}${kind}`)
}
const missingDynamic = dynamicExpected.filter((r) => !outcomeKeys.includes(r))
check(
  `前端覆盖所有动态结果码（${dynamicExpected.length} 个组合）`,
  missingDynamic.length === 0,
  `缺少: ${JSON.stringify(missingDynamic)}`,
)

console.log('\n[4] 拒绝原因：store 抛出的失败 reason ↔ 后端 REASON_TEXT')
// 只校验「失败」原因。reused / activated / valid 是成功路径的返回值，
// 不该出现在错误文案表里——这是设计，不是缺陷。
const SUCCESS_REASONS = new Set(['reused', 'activated', 'valid'])
// 注意：REASON_TEXT 定义在 index.mjs，不是 store.mjs。
// 曾经从 storeSrc 提取，永远得到空数组，导致这条断言恒真、从未真正校验过。
const reasonTextKeys = extractKeys(indexSrc, 'REASON_TEXT') ?? []
check('能解析出 REASON_TEXT（非空）', reasonTextKeys.length > 0, `实际 ${reasonTextKeys.length} 个键`)

const thrownReasons = new Set()
for (const m of storeSrc.matchAll(/reason:\s*'([a-z_]+)'/g)) thrownReasons.add(m[1])
const failureReasons = [...thrownReasons].filter((r) => !SUCCESS_REASONS.has(r))
check('store 有失败原因', failureReasons.length > 0, JSON.stringify(failureReasons))
const missingReasons = failureReasons.filter((r) => !reasonTextKeys.includes(r))
check('后端覆盖所有失败原因', missingReasons.length === 0, `缺少: ${JSON.stringify(missingReasons)}`)

console.log('\n[5] 激活码状态：store ↔ 前端 CODE_STATE_LABELS')
const stateKeys = extractKeys(labelsSrc, 'CODE_STATE_LABELS') ?? []
const codeStates = ['unused', 'active', 'used', 'revoked']
const missingStates = codeStates.filter((s) => !stateKeys.includes(s))
check('前端覆盖所有激活码状态', missingStates.length === 0, `缺少: ${JSON.stringify(missingStates)}`)

console.log('\n[6] 会话阶段：store ↔ 前端 PHASE_LABELS')
const phaseKeys = extractKeys(labelsSrc, 'PHASE_LABELS') ?? []
const phases = ['waiting', 'exchanging', 'done', 'failed', 'expired', 'cancelled']
const missingPhases = phases.filter((p) => !phaseKeys.includes(p))
check('前端覆盖所有会话阶段', missingPhases.length === 0, `缺少: ${JSON.stringify(missingPhases)}`)

console.log('\n[7] 审计动作：后端写入值 ↔ 前端 ACTION_LABELS')
const actionKeys = extractKeys(labelsSrc, 'ACTION_LABELS') ?? []
const writtenActions = new Set()
for (const src of [indexSrc]) {
  for (const m of src.matchAll(/action:\s*'([a-z_.]+)'/g)) writtenActions.add(m[1])
}
const missingActions = [...writtenActions].filter((a) => !actionKeys.includes(a))
check('后端有写入审计动作', writtenActions.size > 0, JSON.stringify([...writtenActions]))
check('前端覆盖所有审计动作', missingActions.length === 0, `缺少: ${JSON.stringify(missingActions)}`)

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
