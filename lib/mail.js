/**
 * 五件套信箱（Host 侧实现）
 *
 * 规范来源：`团队模板室/调度师团队/团队模板/邮箱模板/README.md`
 *          `团队模板室/决策（Leader）团队/团队模板/项目模板/_邮件类型规范.md` §六 §七
 *
 * 三条硬约束（评审后定稿）：
 *  1. 一封信在一个持有者的五件套里只有一个副本；推进 = 移目录 + 改 status。
 *  2. **超时判据写在磁盘上**（<root>/_inflight/<mail_id>.json 的 deadline），
 *     不依赖进程内定时器，DSH 重启后照样能补扫。
 *  3. 投递失败只是提示；「没回复」一律由 ACK 超时判定 —— 忙会话的 prompt 往往不抛错。
 *
 * 目录：
 *   <root>/<owner>/<peer>/{已接收,处理中,已发送,待办,已解决}/
 *   <root>/_inflight/<mail_id>.json    在途账本（唯一的时间依据）
 *   <root>/_seq.json                   当日编号计数器
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DIRS = ['已接收', '处理中', '已发送', '待办', '已解决']
const STATUS_BY_DIR = {
  已接收: 'pending',
  处理中: 'running',
  已发送: 'awaiting_ack',
  待办: 'blocked',
  已解决: 'done',
}

const VALID_TYPES = new Set([
  'S-PROJ-INIT', 'S-HANDOVER', 'S-PROGRESS', 'S-ACK', 'S-TODO-NOTICE',
  'T-ASSIGN', 'T-ACCEPT-REQ', 'T-ACCEPT-RES',
  'I-PLAN-FUSE', 'I-CODE-FUSE',
  'R-PLAN-PROPOSAL', 'R-HUMAN-DECISION', 'R-REJECT', 'R-CLOSEOUT', 'R-ALERT',
])

const REQUIRED_EXTRA = {
  'S-ACK': ['ack_of'],
  'S-TODO-NOTICE': ['todo_of', 'stuck_since', 'elapsed_minutes', 'reason'],
}

const TODO_VAGUE = new Set(['卡住了', '没进展', '有问题'])

function safePart(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!/^[A-Za-z0-9._\u4e00-\u9fa5-]{1,64}$/.test(text)) {
    if (!fallback) throw Object.assign(new Error('bad mailbox part: ' + text), { code: 'BAD_MAILBOX' })
    return fallback
  }
  return text
}

function yamlValue(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return /[:#\n"]/.test(text) ? JSON.stringify(text) : text
}

/** 校验一封信的头部（§七 的机械规则，首版只移植会改变"会不会卡在路上"的那些）。 */
export function validateLetter(meta) {
  const issues = []
  for (const key of ['mail_id', 'type', 'from', 'to', 'timestamp', 'status']) {
    if (!meta[key]) issues.push('缺必填字段: ' + key)
  }
  if (meta.type && !VALID_TYPES.has(meta.type)) issues.push('type 不在清单: ' + meta.type)
  for (const key of REQUIRED_EXTRA[meta.type] || []) {
    if (!meta[key]) issues.push(meta.type + ' 缺必填字段: ' + key)
  }
  if (meta.type === 'S-ACK' && !meta.ack_of) issues.push('S-ACK 缺 ack_of（没有目标等于没发）')
  if (meta.type === 'S-TODO-NOTICE') {
    const reason = String(meta.reason || '')
    if (reason.length < 4 || TODO_VAGUE.has(reason)) issues.push('S-TODO-NOTICE 的 reason 太短或是空话：' + reason)
  }
  return issues
}

export function createMailbox(options) {
  const root = options.root
  const ackTimeoutMs = options.ackTimeoutMs
  const service = options.service
  const log = options.log || (() => {})

  const inflightDir = join(root, '_inflight')
  const seqFile = join(root, '_seq.json')

  async function ensureBox(owner, peer) {
    const base = join(root, owner, peer)
    for (const dir of DIRS) await mkdir(join(base, dir), { recursive: true })
    return base
  }

  async function readJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = path + '.' + Math.random().toString(16).slice(2, 8) + '.tmp'
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  }

  async function nextMailId(now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0')
    const day = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    const seq = await readJson(seqFile, {})
    const key = 'M-' + day
    const value = Number.isFinite(seq[key]) ? seq[key] + 1 : 1
    seq[key] = value
    await writeJson(seqFile, seq)
    return 'M-' + day + '-' + String(value).padStart(4, '0')
  }

  function renderLetter(meta, body) {
    const head = ['---']
    const order = ['mail_id', 'type', 'from', 'to', 'timestamp', 'status', 'dir_owner', 'ack_of', 'todo_of', 'stuck_since', 'elapsed_minutes', 'reason', 'reply_to']
    for (const key of order) {
      if (meta[key] === undefined || meta[key] === '') continue
      head.push(key + ': ' + yamlValue(meta[key]))
    }
    head.push('---', '')
    return head.join('\n') + String(body || '').trim() + '\n'
  }

  /** 把一封信从某个目录移到另一个目录，同时改写 status（一封信只有一份）。 */
  async function moveLetter(base, fromDir, toDir, mailId) {
    const fileName = mailId + '.md'
    const from = join(base, fromDir, fileName)
    const to = join(base, toDir, fileName)
    let text
    try {
      text = await readFile(from, 'utf8')
    } catch {
      return false
    }
    const expect = STATUS_BY_DIR[toDir]
    const rewritten = text.replace(/^status:\s*.*$/m, 'status: ' + expect)
    await mkdir(join(base, toDir), { recursive: true })
    const tmp = to + '.' + Math.random().toString(16).slice(2, 8) + '.tmp'
    await writeFile(tmp, rewritten, 'utf8')
    await rename(tmp, to)
    await rm(from, { force: true })
    return true
  }

  async function listBox(owner, peer) {
    const base = join(root, owner, peer)
    const rows = []
    for (const dir of DIRS) {
      const names = await readdir(join(base, dir)).catch(() => [])
      for (const name of names) {
        if (!name.endsWith('.md')) continue
        rows.push({ mailId: name.slice(0, -3), dir, status: STATUS_BY_DIR[dir], owner, peer })
      }
    }
    return rows
  }

  /** 投递：push 到目标会话。失败只记在账本上，不改变状态（忙会话多半不抛错）。 */
  async function push(sessionId, text) {
    const controller = service('sessionController')
    if (!controller || !sessionId) return { delivered: false, reason: 'no-controller-or-session' }
    try {
      await controller.prompt({ requestId: 'mail-' + Math.random().toString(16).slice(2, 10), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
      return { delivered: true }
    } catch (error) {
      return { delivered: false, reason: (error && error.message) || String(error) }
    }
  }

  async function send(request) {
    const owner = safePart(request.owner, 'me')
    const peer = safePart(request.peer, 'peer')
    const type = String(request.type || 'S-PROGRESS').trim()
    const body = String(request.body || '').trim()
    if (!body) throw Object.assign(new Error('body is required'), { code: 'EMPTY_BODY' })

    await mkdir(root, { recursive: true })
    const mailId = request.mailId ? String(request.mailId) : await nextMailId()
    const now = new Date()
    const base = await ensureBox(owner, peer)
    await ensureBox(peer, owner)

    const meta = {
      mail_id: mailId,
      type,
      from: owner,
      to: peer,
      timestamp: now.toISOString(),
      dir_owner: owner,
      ack_of: request.ackOf,
      todo_of: request.todoOf,
      stuck_since: request.stuckSince,
      elapsed_minutes: request.elapsedMinutes,
      reason: request.reason,
    }

    const issues = validateLetter({ ...meta, status: 'awaiting_ack' })
    if (issues.length > 0) {
      return { ok: false, error: { message: 'letter rejected: ' + issues.join('; '), code: 'MAIL_INVALID', issues } }
    }

    const text = renderLetter({ ...meta, status: 'awaiting_ack' }, body)
    await writeFile(join(base, '已发送', mailId + '.md'), text, 'utf8')
    await writeFile(join(root, peer, owner, '已接收', mailId + '.md'), text.replace(/^status:\s*.*$/m, 'status: pending'), 'utf8')

    const windowMs = Number.isFinite(Number(request.timeoutMs)) ? Math.max(1000, Number(request.timeoutMs)) : ackTimeoutMs
    const deadline = now.getTime() + windowMs
    const record = {
      mail_id: mailId,
      type,
      owner,
      peer,
      senderSessionId: request.senderSessionId || null,
      peerSessionId: request.peerSessionId || null,
      sentAt: now.toISOString(),
      deadline,
      windowMs,
      acked: false,
      blocked: false,
      deliver: null,
    }
    await mkdir(inflightDir, { recursive: true })
    await writeJson(join(inflightDir, mailId + '.json'), record)

    const notice = '〔信箱〕' + mailId + ' 来自 ' + owner + '（' + type + '）\n' + body
    record.deliver = await push(record.peerSessionId, notice)
    await writeJson(join(inflightDir, mailId + '.json'), record)

    log('mail sent', mailId, owner, '->', peer, record.deliver.delivered ? 'pushed' : 'push-failed')
    return { ok: true, mailId, deadline, deadlineIso: new Date(deadline).toISOString(), deliver: record.deliver }
  }

  async function ack(request) {
    const mailId = String(request.mailId || '').trim()
    if (!mailId) throw Object.assign(new Error('mailId is required'), { code: 'NO_MAIL_ID' })
    const record = await readJson(join(inflightDir, mailId + '.json'), undefined)
    if (!record) return { ok: false, error: { message: 'unknown mail: ' + mailId, code: 'MAIL_NOT_FOUND' } }

    const close = request.close === true
    const senderBase = join(root, record.owner, record.peer)
    const peerBase = join(root, record.peer, record.owner)

    const senderMoved = await moveLetter(senderBase, close ? '处理中' : '已发送', close ? '已解决' : '处理中', mailId)
    const peerMoved = await moveLetter(peerBase, close ? '处理中' : '已接收', close ? '已解决' : '处理中', mailId)

    record.acked = true
    record.ackedAt = new Date().toISOString()
    if (close) record.closed = true
    await writeJson(join(inflightDir, mailId + '.json'), record)

    return { ok: true, mailId, closed: close, senderMoved, peerMoved, deadline: record.deadline }
  }

  async function list(request) {
    const owner = safePart(request.owner, 'me')
    const peer = request.peer ? safePart(request.peer, 'peer') : undefined
    const rows = []
    if (peer) rows.push(...(await listBox(owner, peer)))
    else {
      const peers = await readdir(join(root, owner)).catch(() => [])
      for (const dir of peers) {
        if (dir === '_inflight') continue
        rows.push(...(await listBox(owner, dir)))
      }
    }
    const now = Date.now()
    for (const row of rows) {
      const record = await readJson(join(inflightDir, row.mailId + '.json'), undefined)
      if (!record) continue
      row.deadline = record.deadline
      row.overdue = !record.acked && !record.blocked && record.deadline < now
      row.acked = record.acked === true
      row.blocked = record.blocked === true
    }
    return { ok: true, owner, peer, count: rows.length, rows }
  }

  /** 超时扫描：只看磁盘账本，所以重启后照样生效。 */
  async function tick() {
    const names = await readdir(inflightDir).catch(() => [])
    const now = Date.now()
    let moved = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await readJson(join(inflightDir, name), undefined)
      if (!record || record.acked || record.blocked) continue
      if (!Number.isFinite(record.deadline) || record.deadline >= now) continue

      const senderBase = join(root, record.owner, record.peer)
      const peerBase = join(root, record.peer, record.owner)
      const senderMoved = await moveLetter(senderBase, '已发送', '待办', record.mail_id)
      const peerMoved = await moveLetter(peerBase, '已接收', '待办', record.mail_id)

      record.blocked = true
      record.blockedAt = new Date().toISOString()
      record.blockReason = 'ack-timeout'
      await writeJson(join(inflightDir, name), record)
      moved += 1

      const minutes = Math.max(1, Math.round((now - record.deadline + ackTimeoutMs) / 60000))
      const notice = [
        '〔信箱·待办〕' + record.mail_id + '（' + record.type + '）',
        '对方 ' + record.peer + ' 没有确认收到，已移入待办。',
        '已等 ' + minutes + ' 分钟；senderMoved=' + senderMoved + ' peerMoved=' + peerMoved,
        '需要你或对方处理：恢复后调用 mail_ack 可继续推进。',
      ].join('\n')
      void push(record.senderSessionId, notice)
      log('mail blocked (ack timeout)', record.mail_id)
    }
    return { moved }
  }

  return { send, ack, list, tick, root, ackTimeoutMs }
}