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
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

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
// --log-to <path>：跑完把「时刻 | 命令 | 目录 | 改动数」追加一行到指定文件。
//
// 使用方 lead 的诉求：「任何写运行态数据的命令，跑完立刻把时刻/命令/改动数
// 写进施工记录。」他本来打算靠自己记，但**让工具自己记比让人记得更可靠**。
//
// 格式（他定，可 grep，管道分隔）：
//   2026-11-20T11:31:02Z | mail-index-repair --status-only | Super-agent | 补 96 条
const logToIndex = flags.indexOf('--log-to')
const logTo = logToIndex >= 0 ? flags[logToIndex + 1] : null
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

// 补齐 status 字段。
//
// 为什么需要：2026-11-20 之前写出的索引条目只有 type/from/to/sides。
// 外面按 `e.status !== 'done'` 筛未结案会得到全集（undefined !== 'done' 为真），
// 按 `e.status === 'x'` 则永远 0 条。两个方向都错且都返回结果。
//
// ⚠️ **必须遍历索引而不是只遍历本体**。使用方 lead 实测报过：
// 他那边 96 条无 status 的全是「孤儿」（_letters.json 里没有本体）。
// 早先这里写成 `for (const letter of letters.letters)`，孤儿一条都遍历不到，
// 于是报「需要补齐 status: 0」——而实际有 96 条要补。
//
// **那个 0 是我注释和实现相反造成的**：注释写「只统计 status===undefined
// 的条目，不是全部孤儿」，实现却是「只统计本体存在的」，两回事。
// ⚠️ `R` 对应三个状态（delivered / running / acked），反推成一个值是猜测。
//
// 选 `acked` 而不是 `delivered` 或 `unknown`，依据是**真实数据**，不是保守：
// 使用方 lead 那 105 条孤儿里，sides 全为 R 的 83 条中，
// **81 条实际是 acked、只有 2 条是 delivered**。
//
// 而且这些条目的 updatedAt 都是 11-17（同一天），说明 status 是当年插件自己写的、
// 是真实历史值，不是推断值——所以「R 在本项目的真实分布里压倒性对应 acked」这条
// 有实证支撑。
//
// 我原来倾向改 `unknown`（更保守），使用方反驳得对：
// **保守不是正确，只是不犯错。** unknown 会让 83 条全部变成不可知，
// 而 acked 与事实一致 81/83。
const REPAIR_CODE_TO_STATUS = { A: 'pushed', P: 'pending', R: 'acked', B: 'blocked', D: 'done', E: 'expired' }
const REPAIR_CODE_RANK = { P: 0, A: 1, R: 2, B: 3, D: 4, E: 5 }
const statusFromSides = (entry) => {
  const codes = ['from', 'to']
    .map((side) => (entry.sides && entry.sides[side] && entry.sides[side].code) || '')
    .filter(Boolean)
  if (codes.length === 0) return null
  if (codes.some((c) => c === 'E')) return 'expired'
  if (codes.every((c) => c === 'D')) return 'done'
  const latest = [...codes].sort((a, b) => (REPAIR_CODE_RANK[b] ?? -1) - (REPAIR_CODE_RANK[a] ?? -1))[0]
  return REPAIR_CODE_TO_STATUS[latest] || 'unknown'
}

for (const [mailId, entryForStatus] of Object.entries(nextIndex)) {
  if (!entryForStatus || typeof entryForStatus !== 'object') continue
  if (entryForStatus.status !== undefined) continue
  const letter = (letters.letters || []).find((l) => l && l.id === mailId)
  if (letter && typeof letter.status === 'string') {
    entryForStatus.status = letter.status
    statusFilled.push({ mailId, status: letter.status, via: 'body' })
    continue
  }
  const inferred = statusFromSides(entryForStatus)
  if (!inferred) continue
  entryForStatus.status = inferred
  statusFilled.push({ mailId, status: inferred, via: 'sides' })
}

// path 修正仍然只对本体存在的信件做：path 是显示路径，
// 孤儿条目没有本体可对照，改它等于编造。
for (const letter of letters.letters || []) {
  if (!letter || !letter.id) continue
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

// ⚠️ 报数必须带三样：口径 / 时刻 / 命令。
//
// 少了「时刻」的后果（使用方 lead 实测）：同一个口径下，他自己两次跑得出
// 「done 16」和「done 17」——差异是那几分钟里他发了一封信，进了索引。
// 也就是说：**口径写清只能保证不同人得出同一个数，
// 不能保证同一个人在不同时刻得出同一个数。**
//
// 少了「口径」的后果：我和他算同一份数据得出 96 vs 101，
// 因为他算「全部孤儿」、我算「缺 status 的孤儿」。两人都以为自己对。
console.log('=== 统计（这三个数必须一起看）===')
console.log('时刻:', new Date().toISOString(), '（本机', new Date().toLocaleString('zh-CN', { hour12: false }), '）')
// 只打目录名不打绝对路径：这个输出会被贴进信里/文档里，
// 而绝对路径是隐私扫描要拦的东西（今天刚因此返工过一次 Release）。
console.log('命令: node tools/mail-index-repair.mjs <workspace>', statusOnly ? '--status-only' : '', dryRun ? '--dry-run' : '')
console.log('目标目录:', basename(cwd))
console.log('口径: 扫 _index.json 全部条目；')
console.log('      「需要补齐 status」= status===undefined 的条目，含本体存在与孤儿两类')

// 口径自检：打印出来的口径必须和实际行为一致。
// 这条来自 2026-11-20 使用方 lead 的一次实测——我原来的注释写
// 「只统计 status===undefined 的条目，不是全部孤儿」，实现却是
// 「只遍历本体」，两者相反，导致他那边 96 条要补却报 0 条。
//
// 判据：把 toFix 按 via 分类，两类都要能被统计到；
// 若某一类永远是 0，说明那段分支没被走到。
{
  const byVia = {}
  for (const f of statusFilled) byVia[f.via] = (byVia[f.via] || 0) + 1
  console.log('      实际来源分布:', JSON.stringify(byVia) || '(无)')
  const entries = Object.values(nextIndex).filter((e) => e && typeof e === 'object')
  const undefinedCount = entries.filter((e) => e.status === undefined).length
  const hadStatus = entries.filter((e) => e.status !== undefined).length - statusFilled.length
  const accountedFor = hadStatus + statusFilled.length + undefinedCount
  const total = entries.length
  // ⚠️ 光验「总数守恒」不够。
  //
  // 实测：把遍历退回「只遍历本体」后，自检**通过了**——
  // 因为算式变成「原有 211 + 待补 0 + 仍缺 96 = 307」，算术上守恒，
  // 但真相是「该补的 96 条一条没补」。
  //
  // **守恒式只能证明我数全了，不能证明我补对了。**
  // 所以要额外验一条：**凡是 status===undefined 且能从数据推出状态的，
  // 都必须出现在 statusFilled 里**——一个都不能剩。
  const inferable = entries.filter((e) => e.status === undefined && statusFromSides(e) !== null).length
  const missed = inferable - statusFilled.filter((f) => f.via === 'sides').length
  if (accountedFor !== total) {
    console.log('  ⚠️ 口径自检失败: 原有', hadStatus, '+ 已补', statusFilled.length, '+ 仍缺', undefinedCount, '≠ 总条目', total)
    process.exitCode = 3
  } else if (missed > 0) {
    console.log('  ⚠️ 口径自检失败: 可推断', inferable, '条，实际只补了', statusFilled.filter((f) => f.via === 'sides').length, '条，漏了', missed, '条')
    process.exitCode = 3
  } else {
    console.log(
      '      ✓ 口径自检通过: 原有',
      hadStatus,
      '+ 待补',
      statusFilled.length,
      '+ 仍缺',
      undefinedCount,
      '=',
      total,
      '总条目',
    )
  }
}
console.log()
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

// 施工记录：只在真跑（非 dry-run）且确实有改动时写，避免刷屏。
if (logTo && !dryRun && (changes.length > 0 || statusFilled.length > 0)) {
  const parts = []
  if (statusFilled.length > 0) parts.push('补 ' + statusFilled.length + ' 条 status')
  if (changes.length > 0) parts.push('修 ' + changes.length + ' 处 path')
  const line = [new Date().toISOString(), 'mail-index-repair' + (statusOnly ? ' --status-only' : ''), basename(cwd), parts.join(' + ')].join(' | ')
  try {
    await appendFile(resolve(logTo), line + '\n', 'utf8')
    console.log('施工记录已追加:', logTo)
  } catch (error) {
    console.error('写施工记录失败:', (error && error.message) || String(error))
  }
}
