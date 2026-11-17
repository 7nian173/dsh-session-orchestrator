/**
 * 信箱（v3·推送优先 + 事件驱动）
 *
 * 参照 DSH 原生写法（`dsh-agent-teams` 的 mailbox.js / scheduler.js）：
 *   - 消息是**状态文件里的记录**，不再用文件夹当状态机；
 *   - 投递 = prompt，文本带回执标记；只有真的进了对方某一轮（`agent/pre-step` 放行）才算"对方知道了"；
 *   - 对方忙 = 回执迟迟不出现，而不是投递报错；
 *   - 唤醒靠 **idle 边**（`agent/status`）+ 每封信一个一次性定时器，**没有每秒扫描**。
 *
 * 状态：pending(已写) → pushed(已入队) → delivered(已进对方一轮) → acked(对方回了回执) → blocked(待办) → done
 *
 * 磁盘：<root>/mailbox.json（唯一状态）+ <root>/archive/<mail_id>.md（只写一次的归档，不移动）
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
const MARK = /〔信箱·(M-\d{8}-\d{4})〕/g

export function receiptOf(mailId) {
  return '〔信箱·' + mailId + '〕'
}

export function validateLetter(meta) {
  const issues = []
  for (const key of ['mail_id', 'type', 'from', 'to']) if (!meta[key]) issues.push('缺必填字段: ' + key)
  if (meta.type && !VALID_TYPES.has(meta.type)) issues.push('type 不在清单: ' + meta.type)
  for (const key of REQUIRED_EXTRA[meta.type] || []) if (!meta[key]) issues.push(meta.type + ' 缺必填字段: ' + key)
  if (meta.type === 'S-TODO-NOTICE') {
    const reason = String(meta.reason || '')
    if (reason.length < 4 || TODO_VAGUE.has(reason)) issues.push('S-TODO-NOTICE 的 reason 太短或是空话：' + reason)
  }
  return issues
}

/** 从一条消息的 text 块里捞出所有信箱回执标记（给 agent/pre-step 用）。 */
export function mailIdsInMessages(messages) {
  const found = new Set()
  for (const message of messages || []) {
    for (const block of message && Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        for (const match of block.text.matchAll(MARK)) found.add(match[1])
      }
    }
  }
  return [...found]
}

export function createMailbox(options) {
  const root = options.root
  const ackTimeoutMs = options.ackTimeoutMs
  const service = options.service
  const log = options.log || (() => {})

  const storeFile = join(root, 'mailbox.json')
  const archiveDir = join(root, 'archive')
  /** mailId → timer */
  const timers = new Map()
  let letters = []
  let seq = {}
  let loaded = false

  async function load() {
    if (loaded) return
    try {
      const raw = JSON.parse(await readFile(storeFile, 'utf8'))
      letters = Array.isArray(raw.letters) ? raw.letters : []
      seq = raw.seq && typeof raw.seq === 'object' ? raw.seq : {}
    } catch {
      letters = []
      seq = {}
    }
    loaded = true
  }

  async function save() {
    await mkdir(dirname(storeFile), { recursive: true })
    const tmp = storeFile + '.' + Math.random().toString(16).slice(2, 8) + '.tmp'
    await writeFile(tmp, JSON.stringify({ letters, seq }, null, 2), 'utf8')
    await rename(tmp, storeFile)
  }

  function nextMailId(now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0')
    const day = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    const key = 'M-' + day
    seq[key] = (Number.isFinite(seq[key]) ? seq[key] : 0) + 1
    return 'M-' + day + '-' + String(seq[key]).padStart(4, '0')
  }

  function find(mailId) {
    return letters.find((letter) => letter.id === mailId)
  }

  async function archive(letter) {
    try {
      await mkdir(archiveDir, { recursive: true })
      const head = [
        '---',
        'mail_id: ' + letter.id,
        'type: ' + letter.type,
        'from: ' + letter.from,
        'to: ' + letter.to,
        'timestamp: ' + letter.sentAt,
        'status: ' + letter.status,
        letter.ackOf ? 'ack_of: ' + letter.ackOf : '',
        '---',
        '',
        letter.body,
      ].filter((line) => line !== '')
      await writeFile(join(archiveDir, letter.id + '.md'), head.join('\n') + '\n', 'utf8')
    } catch (error) {
      log('archive failed', letter.id, error && error.message)
    }
  }

  /** 推送到目标会话。返回 {queued:true} 或 {queued:false, reason}。 */
  async function push(letter, text) {
    const controller = service('sessionController')
    if (!controller) return { queued: false, reason: 'no-controller' }
    if (!letter.toSession) return { queued: false, reason: 'no-target-session' }
    try {
      await controller.prompt({
        requestId: 'mail-' + letter.id + '-' + Math.random().toString(16).slice(2, 8),
        sessionId: letter.toSession,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      return { queued: true }
    } catch (error) {
      return { queued: false, reason: (error && error.message) || String(error) }
    }
  }

  function bodyFor(letter, reminder) {
    const tag = receiptOf(letter.id)
    const head = reminder
      ? tag + '你有新邮件，请查看 ' + letter.id + '（来自 ' + letter.from + '，' + letter.type + '）'
      : tag + '来自 ' + letter.from + ' 的信（' + letter.type + '）：'
    return head + '\n\n' + letter.body
  }

  /** 待办：两侧都通知（发起方 + 接收方）。 */
  async function block(letter, reason) {
    if (letter.status === 'blocked' || letter.status === 'done' || letter.status === 'acked') return
    letter.status = 'blocked'
    letter.blockedAt = new Date().toISOString()
    letter.blockReason = reason
    letter.notified = []
    await save()
    await archive(letter)
    const notice = [
      '〔信箱·待办〕' + letter.id + '（' + letter.type + '，' + letter.from + ' → ' + letter.to + '）',
      '原因：' + reason,
      '在 ' + Math.round(ackTimeoutMs / 60000) + ' 分钟内没有拿到「收到／处理中」回执。',
      '处理建议：收到信的一方回一封回执，或双方约定后人工放行。',
    ].join('\n')
    for (const sessionId of [letter.fromSession, letter.toSession]) {
      if (!sessionId) continue
      const controller = service('sessionController')
      if (!controller) break
      try {
        await controller.prompt({
          requestId: 'mail-todo-' + letter.id + '-' + Math.random().toString(16).slice(2, 8),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: notice }],
        })
        letter.notified.push(sessionId)
      } catch (error) {
        log('todo notice failed', sessionId, error && error.message)
      }
    }
    clearTimer(letter.id)
    await save()
    log('mail blocked', letter.id, reason)
  }

  function clearTimer(mailId) {
    const timer = timers.get(mailId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(mailId)
    }
  }

  /** 每封信一个一次性定时器（不是扫描）；进程退出即可丢，冷启动有冷扫兜底。 */
  function armTimer(letter) {
    clearTimer(letter.id)
    if (letter.status === 'acked' || letter.status === 'done' || letter.status === 'blocked') return
    const delay = Math.max(1000, letter.deadline - Date.now())
    const timer = setTimeout(() => {
      const live = find(letter.id)
      if (live && live.status !== 'acked' && live.status !== 'done') void block(live, 'ack-timeout')
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(letter.id, timer)
  }

  async function send(request) {
    await load()
    const owner = String(request.owner || request.from || '').trim()
    const peer = String(request.peer || request.to || '').trim()
    if (!owner || !peer) return { ok: false, error: { message: 'owner and peer are required', code: 'BAD_MAILBOX' } }
    const type = String(request.type || 'S-PROGRESS').trim()
    const body = String(request.body || '').trim()
    if (!body) return { ok: false, error: { message: 'body is required', code: 'EMPTY_BODY' } }

    const meta = { mail_id: request.mailId || nextMailId(), type, from: owner, to: peer, ack_of: request.ackOf, todo_of: request.todoOf, stuck_since: request.stuckSince, elapsed_minutes: request.elapsedMinutes, reason: request.reason }
    const issues = validateLetter(meta)
    if (issues.length > 0) return { ok: false, error: { message: 'letter rejected: ' + issues.join('; '), code: 'MAIL_INVALID', issues } }

    const now = Date.now()
    const windowMs = Number.isFinite(Number(request.timeoutMs)) ? Math.max(1000, Number(request.timeoutMs)) : ackTimeoutMs
    const letter = {
      id: meta.mail_id,
      type,
      from: owner,
      to: peer,
      fromSession: request.senderSessionId || null,
      toSession: request.peerSessionId || null,
      body,
      ackOf: request.ackOf || null,
      status: 'pending',
      sentAt: new Date(now).toISOString(),
      pushedAt: null,
      deliveredAt: null,
      ackedAt: null,
      deadline: now + windowMs,
      windowMs,
      push: null,
      reminders: 0,
    }
    letters.push(letter)

    letter.push = await push(letter, bodyFor(letter, false))
    letter.status = letter.push.queued ? 'pushed' : 'pending'
    if (letter.push.queued) letter.pushedAt = new Date().toISOString()
    await save()
    await archive(letter)
    armTimer(letter)
    log('mail sent', letter.id, owner, '->', peer, letter.status)
    return { ok: true, mailId: letter.id, status: letter.status, deadline: letter.deadline, deadlineIso: new Date(letter.deadline).toISOString(), push: letter.push }
  }

  /** 对方的「收到／处理中」回执。 */
  async function ack(request) {
    await load()
    const mailId = String(request.mailId || '').trim()
    const letter = find(mailId)
    if (!letter) return { ok: false, error: { message: 'unknown mail: ' + mailId, code: 'MAIL_NOT_FOUND' } }
    const close = request.close === true
    letter.ackedAt = new Date().toISOString()
    letter.status = close ? 'done' : 'acked'
    letter.receipt = String(request.receipt || (close ? '完成' : '处理中')).slice(0, 200)
    clearTimer(mailId)
    await save()
    await archive(letter)
    return { ok: true, mailId, status: letter.status, closed: close }
  }

  async function list(request) {
    await load()
    const owner = String(request.owner || '').trim()
    const peer = request.peer ? String(request.peer).trim() : undefined
    const now = Date.now()
    const rows = letters
      .filter((letter) => (!owner || letter.from === owner || letter.to === owner) && (!peer || letter.from === peer || letter.to === peer))
      .slice(-200)
      .map((letter) => ({
        mailId: letter.id,
        type: letter.type,
        from: letter.from,
        to: letter.to,
        status: letter.status,
        pushed: letter.push ? letter.push.queued === true : false,
        delivered: Boolean(letter.deliveredAt),
        acked: Boolean(letter.ackedAt),
        deadline: letter.deadline,
        overdue: letter.status !== 'acked' && letter.status !== 'done' && letter.status !== 'blocked' && letter.deadline < now,
        reminders: letter.reminders || 0,
      }))
    return { ok: true, owner: owner || null, peer: peer || null, count: rows.length, rows }
  }

  /** `agent/pre-step` 观测：回执标记进了对方这一轮 → 对方知道了。 */
  async function noteStep(agent, messages) {
    const ids = mailIdsInMessages(messages)
    if (ids.length === 0) return
    await load()
    let changed = false
    for (const id of ids) {
      const letter = find(id)
      if (!letter || letter.deliveredAt) continue
      if (agent && letter.toSession && agent.id !== letter.toSession) continue
      letter.deliveredAt = new Date().toISOString()
      if (letter.status === 'pushed' || letter.status === 'pending') letter.status = 'delivered'
      clearTimer(id)
      changed = true
    }
    if (changed) await save()
  }

  /** idle 边（哨兵）：目标会话变空闲时，把还没落地的那封信重推一次并留一句提醒。 */
  async function noteStatus(agent, status) {
    if (status !== 'idle' || !agent) return
    await load()
    const pending = letters.filter((letter) => letter.toSession === agent.id && !letter.deliveredAt && (letter.status === 'pushed' || letter.status === 'pending'))
    for (const letter of pending) {
      letter.reminders = (letter.reminders || 0) + 1
      const result = await push(letter, bodyFor(letter, letter.reminders > 1))
      letter.push = result
      if (result.queued) {
        letter.status = 'pushed'
        letter.pushedAt = new Date().toISOString()
        armTimer(letter)
      }
      await save()
      log('sentinel re-push', letter.id, 'attempt', letter.reminders)
    }
  }

  /** 冷启动兜底：只扫一次，把跨进程期间过期的信补进待办。 */
  async function sweepAtStart() {
    await load()
    let blocked = 0
    for (const letter of letters) {
      if (letter.status === 'blocked' || letter.status === 'done' || letter.status === 'acked') continue
      if (Number.isFinite(letter.deadline) && letter.deadline < Date.now()) {
        void block(letter, 'ack-timeout (cold start)')
        blocked += 1
      } else {
        armTimer(letter)
      }
    }
    return { blocked, armed: letters.length }
  }

  return { send, ack, list, noteStep, noteStatus, sweepAtStart, root }
}