#!/usr/bin/env node
/**
 * 激活码管理命令行。直接操作数据库，不需要后端起在跑。
 *
 *   node tools/codes.mjs gen --count 20 --batch 第一批
 *   node tools/codes.mjs list --state unused --limit 50
 *   node tools/codes.mjs stats
 *   node tools/codes.mjs revoke DSH9-K3M7-P2QX-8TRA
 *   node tools/codes.mjs export --batch 第一批 > codes.txt
 *
 * 数据目录默认 ./data，用 DSH_BONUS_DATA_DIR 覆盖。
 */
import { join } from 'node:path'
import { Store, maskCode } from '../server/store.mjs'

const args = process.argv.slice(2)
const command = args[0]

function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const dataDir = process.env.DSH_BONUS_DATA_DIR ?? join(process.cwd(), 'data')
const store = new Store(join(dataDir, 'bonus.sqlite'))

function usage() {
  console.log(`
激活码管理

  node tools/codes.mjs gen [--count 10] [--batch 名字] [--note 备注]
  node tools/codes.mjs list [--state unused|active|used|revoked] [--batch 名字] [--limit 100]
  node tools/codes.mjs stats
  node tools/codes.mjs revoke <激活码>
  node tools/codes.mjs export [--batch 名字]     # 纯文本，每行一个，方便直接分发
`)
}

try {
  switch (command) {
    case 'gen': {
      const count = Math.min(Math.max(Number(option('count', 10)) || 10, 1), 500)
      const codes = store.generate({
        count,
        batch: option('batch'),
        note: option('note'),
      })
      console.log(`已生成 ${codes.length} 个激活码：\n`)
      for (const code of codes) console.log(`  ${code}`)
      console.log(`\n数据文件：${join(dataDir, 'bonus.sqlite')}`)
      break
    }
    case 'list': {
      const rows = store.list({
        state: option('state'),
        batch: option('batch'),
        limit: Math.min(Number(option('limit', 100)) || 100, 500),
      })
      if (rows.length === 0) { console.log('没有匹配的记录。'); break }
      console.log('激活码          状态     批次        创建时间              绑定时间')
      for (const row of rows) {
        const created = new Date(Number(row.created_at)).toISOString().slice(0, 19).replace('T', ' ')
        const bound = row.bound_at ? new Date(Number(row.bound_at)).toISOString().slice(0, 19).replace('T', ' ') : '-'
        console.log(`${String(row.code).padEnd(15)} ${String(row.state).padEnd(8)} ${String(row.batch ?? '-').padEnd(11)} ${created}  ${bound}`)
      }
      console.log(`\n共 ${rows.length} 条。`)
      break
    }
    case 'stats': {
      const stats = store.stats()
      console.log('')
      console.log(`  总数      : ${stats.total}`)
      console.log(`  未使用    : ${stats.unused}`)
      console.log(`  已绑定    : ${stats.active}`)
      console.log(`  已领取    : ${stats.used}`)
      console.log(`  已作废    : ${stats.revoked}`)
      console.log(`  今日激活  : ${stats.activations_today}`)
      console.log('')
      break
    }
    case 'revoke': {
      const code = args[1]
      if (code === undefined) { console.error('用法：node tools/codes.mjs revoke <激活码>'); process.exitCode = 2; break }
      const ok = store.revoke(code)
      console.log(ok ? `已作废 ${maskCode(code)}` : `找不到 ${maskCode(code)}，或它已是终态。`)
      break
    }
    case 'export': {
      const rows = store.list({ state: 'unused', batch: option('batch'), limit: 500 })
      for (const row of rows) console.log(row.code)
      console.error(`已导出 ${rows.length} 个未使用的激活码。`)
      break
    }
    default:
      usage()
      if (command !== undefined) process.exitCode = 1
  }
} finally {
  store.close()
}
