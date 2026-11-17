#!/usr/bin/env node
/**
 * 从 _index.json + envelope/ 重建 _letters.json 里缺失的信件记录。
 *
 *   node tools/mail-state-repair.mjs <工作区> --dry-run
 *   node tools/mail-state-repair.mjs <工作区> --apply
 *
 * 只补不删：已有的记录原样保留，缺的按信封头 + 索引补出来。
 * 补出来的记录带 recovered:true，正文取自信封，会话 id 取自索引。
 */
import { readFile, readdir, writeFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const cwd = args.find((a) => !a.startsWith('--'))
const apply = args.includes('--apply')
if (!cwd) {
  console.error('usage: node tools/mail-state-repair.mjs <workspace> [--dry-run|--apply]')
  process.exit(1)
}

const dir = join(resolve(cwd), '.dsh-mail')
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

function parseEnvelope(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const head = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    head[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { head, body: (match[2] || '').trim() }
}

function statusFrom(pathOfCode) {
  const code = String(pathOfCode || '').split('>').filter(Boolean).pop()
  if (code === 'D') return 'done'
  if (code === 'B') return 'blocked'
  if (code === 'R') return 'acked'
  return 'pending'
}

const index = await readJson(join(dir, '_index.json'))
let state = { letters: [], seq: {} }
try {
  state = await readJson(join(dir, '_letters.json'))
} catch {
  state = { letters: [], seq: {} }
}
const known = new Set((state.letters || []).map((letter) => letter.id))
const files = await readdir(join(dir, 'envelope'))
const byId = new Map()
for (const name of files) {
  const id = name.split('.')[0]
  if (!byId.has(id)) byId.set(id, {})
  byId.get(id)[name.includes('.to.md') ? 'to' : 'from'] = join(dir, 'envelope', name)
}

const added = []
for (const [id, entry] of Object.entries(index)) {
  if (known.has(id)) continue
  const sides = byId.get(id) || {}
  const file = sides.to || sides.from
  if (!file) continue
  const parsed = parseEnvelope(await readFile(file, 'utf8'))
  if (!parsed) continue
  const head = parsed.head
  const side = sides.to ? 'to' : 'from'
  const indexed = (entry.sides && entry.sides[side]) || {}
  const sentAt = head.timestamp || new Date().toISOString()
  const status = statusFrom(indexed.path)
  const letter = {
    id,
    type: head.type || entry.type || 'S-PROGRESS',
    from: head.from || entry.from,
    to: head.to || entry.to,
    fromSession: (entry.sides && entry.sides.from && entry.sides.from.sessionId) || null,
    toSession: (entry.sides && entry.sides.to && entry.sides.to.sessionId) || null,
    body: parsed.body,
    ackOf: head.ack_of || null,
    status,
    sentAt,
    pushedAt: null,
    deliveredAt: null,
    ackedAt: status === 'done' || status === 'acked' ? sentAt : null,
    deadline: Date.parse(sentAt) + 300000,
    windowMs: 300000,
    push: null,
    reminders: 0,
    recovered: true,
    todoSince: status === 'blocked' ? sentAt : null,
    paused: status === 'blocked',
    noticeA: 0,
    noticeB: 0,
  }
  state.letters.push(letter)
  added.push(letter)
}

// seq 补齐：保证下一天的编号不会撞上已有 id
for (const letter of state.letters) {
  const match = String(letter.id || '').match(/^M-(\d{8})-(\d+)$/)
  if (!match) continue
  const key = 'M-' + match[1]
  state.seq[key] = Math.max(Number(state.seq[key]) || 0, Number(match[2]))
}

console.log(`工作区 ${resolve(cwd)}`)
console.log(`索引 ${Object.keys(index).length} 条，现有记录 ${(state.letters || []).length - added.length} 条，补 ${added.length} 条`)
for (const letter of added) {
  console.log(`  + ${letter.id}  ${letter.from} → ${letter.to}  ${letter.status}  ${letter.body.slice(0, 30).replace(/\s+/g, ' ')}`)
}

if (added.length === 0) process.exit(0)
if (!apply) {
  console.log('（dry-run，未写入；确认后加 --apply）')
  process.exit(0)
}
const tmp = join(dir, '_letters.json.tmp')
await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
await rename(tmp, join(dir, '_letters.json'))
console.log('已写入 _letters.json')