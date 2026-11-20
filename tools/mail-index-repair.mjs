/**
 * 重算信箱状态索引：用 _ledger.json 里的事件还原每封信每一侧的字母路径。
 *
 * 用法：
 *   node tools/mail-index-repair.mjs <工作区目录> [--dry-run]
 *
 * 修复对象：
 *   - <cwd>/.dsh-mail/_index.json 的 sides[side].path
 *   - <cwd>/.dsh-mail/envelope/<mail_id>.<side>.md 的 `path:` 行
 * 只会追加/补齐，不删除任何信件或文件。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const CODES = { pending: 'P', awaiting_ack: 'A', pushed: 'A', delivered: 'R', running: 'R', acked: 'R', blocked: 'B', done: 'D' }

const [cwdArg, ...flags] = process.argv.slice(2)
if (!cwdArg) {
  console.error('usage: node tools/mail-index-repair.mjs <workspace dir> [--dry-run] [--status-only]')
  process.exit(2)
}
const dryRun = flags.includes('--dry-run')
// --status-only：只补 status 字段，不动 path。
//
// 为什么需要这个开关：2026-11-20 实测，对「本地」工作区跑全量修复时
// 会同时改 21 处 path 和 63 处 status。**改 path 是修改历史数据的显示路径**，
// 需要人确认；而补 status 是纯补字段，副作用可忽略。
// 两件事混在一个命令里，会让人为了补字段而顺手改掉路径。
const statusOnly = flags.includes('--status-only')
const cwd = resolve(cwdArg)
const box = join(cwd, '.dsh-mail')

const readJson = async (name, fallback) => {
  try {
    return JSON.parse(await readFile(join(box, name), 'utf8'))
  } catch {
    return fallback
  }
}

const letters = await readJson('_letters.json', { letters: [] })
const ledger = await readJson('_ledger.json', { events: [] })
const index = await readJson('_index.json', {})

const bySide = new Map()
for (const event of ledger.events || []) {
  if (!event || !event.mail_id || !event.side || !event.code) continue
  const key = event.mail_id + '|' + event.side
  const at = Date.parse(event.at || '') || 0
  if (!bySide.has(key)) bySide.set(key, [])
  bySide.get(key).push({ at, code: event.code })
}

const buildPath = (mailId, side, currentCode) => {
  const events = (bySide.get(mailId + '|' + side) || []).sort((a, b) => a.at - b.at)
  const codes = []
  for (const item of events) {
    if (codes.length === 0 || codes[codes.length - 1] !== item.code) codes.push(item.code)
  }
  if (currentCode && codes[codes.length - 1] !== currentCode) codes.push(currentCode)
  return codes.length ? codes.join('>') : (currentCode || '')
}

const changes = []
const statusFilled = []
const nextIndex = JSON.parse(JSON.stringify(index || {}))

for (const letter of letters.letters || []) {
  if (!letter || !letter.id) continue
  // 补齐 status 字段。
  //
  // 为什么需要：2026-11-20 之前写出的索引条目只有 type/from/to/sides，
  // 外面按 `e.status !== 'done'` 筛未结案会得到全集（undefined !== 'done' 为真），
  // 按 `e.status === 'x'` 则永远 0 条。两个方向都错且都返回结果。
  // 新代码会写这个字段，但旧条目要等各自下次归档才补——所以这里一次性补齐。
  const entryForStatus = nextIndex[letter.id]
  if (entryForStatus && entryForStatus.status === undefined && typeof letter.status === 'string') {
    entryForStatus.status = letter.status
    statusFilled.push({ mailId: letter.id, status: letter.status })
  }
  for (const side of ['from', 'to']) {
    const current = letter.status === 'blocked' ? 'B' : letter.status === 'done' ? 'D' : letter.status === 'acked' || letter.status === 'delivered' ? 'R' : side === 'from' ? 'A' : 'P'
    const entry = nextIndex[letter.id] || { type: letter.type, from: letter.from, to: letter.to, sides: {} }
    const prev = entry.sides && entry.sides[side] ? entry.sides[side] : undefined
    const rebuilt = buildPath(letter.id, side, current)
    if (!prev) continue
    if (!statusOnly && prev.path !== rebuilt) {
      changes.push({ mailId: letter.id, side, from: prev.path, to: rebuilt })
      prev.path = rebuilt
      prev.code = current
    }
    nextIndex[letter.id] = entry
  }
}

console.log('信件数:', (letters.letters || []).length, ' · 留痕事件:', (ledger.events || []).length)
console.log('需要修正 path:', changes.length)
console.log('需要补齐 status:', statusFilled.length)
for (const f of statusFilled.slice(0, 10)) console.log('  ', f.mailId, '←', f.status)
if (statusFilled.length > 10) console.log('   … 另有', statusFilled.length - 10, '条')
for (const c of changes) console.log('  ', c.mailId, c.side, c.from, '→', c.to)

if (!dryRun && (changes.length > 0 || statusFilled.length > 0)) {
  await writeFile(join(box, '_index.json'), JSON.stringify(nextIndex, null, 2), 'utf8')
  console.log('已写回 _index.json')

  // 同步信封里的 path: 行
  let files = []
  try {
    files = (await readdir(join(box, 'envelope'))).filter((n) => n.endsWith('.md'))
  } catch {
    files = []
  }
  let patched = 0
  for (const name of files) {
    const full = join(box, 'envelope', name)
    const raw = await readFile(full, 'utf8')
    const m = /^(---\n[\s\S]*?\n---\n)/.exec(raw)
    if (!m) continue
    const head = m[1]
    const idMatch = /mail_id:\s*(\S+)/.exec(head)
    const sideMatch = /side:\s*(\S+)/.exec(head)
    if (!idMatch || !sideMatch) continue
    const want = nextIndex[idMatch[1]] && nextIndex[idMatch[1]].sides && nextIndex[idMatch[1]].sides[sideMatch[1]]
    if (!want || !want.path) continue
    if (!/^path:\s*/m.test(head)) continue
    const newHead = head.replace(/^path:\s*.*$/m, 'path: ' + want.path)
    if (newHead === head) continue
    await writeFile(full, newHead + raw.slice(head.length), 'utf8')
    patched += 1
  }
  console.log('信封 path 行已同步:', patched)
} else if (dryRun) {
  console.log('（--dry-run，未写盘）')
}
