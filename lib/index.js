/**
 * dsh-session-bridge — 文件队列跨会话投递桥（Host 半身，无客户端部分）。
 *
 * 让本机脚本、cron、CI 或另一个 agent 在同目录工作区里"跨回合说话"：
 * 不依赖 HTTP 端点、不需要登录态；队列本身就是信任边界，也可以随工作区进 Git。
 *
 * 目录（root 由 config.dir 决定）：
 *   root/inbox/<id>.json      待投递请求（脚本先写 <id>.json.tmp 再 rename）
 *   root/working/<id>.<x>.json 已被原子认领、正在处理的请求
 *   root/outbox/<id>.json     处理结果（成功/失败都写，原子写）
 *   root/done/<id>.json       已完成请求（同时是幂等账本：命中即跳过，不再重投）
 *   root/failed/<id>.json     失败副本
 *   root/heartbeat.json       存活心跳
 *
 * 只依赖两个可选的 Host 服务：ctx.sessionController（prompt/state/wait/create）、
 * ctx.sessionPersistence（list，按 header 里的 cwd/agentPreset 给冷会话寻址）。
 */

import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { createMailbox, ensureWorkspaceBox } from './mail.js'

export const name = 'dsh-session-bridge'

export const Config = z.object({
  dir: z.string().default('').description('Queue root. Empty means $DSH_HOME/session-bridge.'),
  pollMs: z.natural().min(200).default(1000).description('Queue scan interval in milliseconds.'),
  replyTimeoutMs: z.natural().min(5000).default(180000).description('Default wait for one turn of reply.'),
  maxReplyChars: z.natural().min(200).default(8000).description('Reply truncation limit.'),
  deliverMode: z.union(['queue', 'steer']).default('queue').description('Default delivery mode.'),
  maxConcurrent: z.natural().min(1).default(4).description('Concurrent requests handled at once.'),
  parseAttempts: z.natural().min(1).default(3).description('In-place parse retries before failing a request.'),
  parseRetryDelayMs: z.natural().min(50).default(400).description('Delay between parse retries.'),
  autoJump: z.boolean().default(true).description('Allow queued one-shot UI navigation.'),
  allowCrossWorkspace: z.boolean().default(false).description('Allow session_tell to reach a friend registered in another workspace.'),
  mailRoot: z.string().default('').description('Mailbox root. Empty means $DSH_HOME/mail.'),
  ackTimeoutMs: z.natural().min(10000).default(300000).description('Move a letter to 待办 when no ACK arrives within this window.'),
})

/** 不声明硬依赖；可选服务一律用 ctx.get(name) + undefined 检查。 */
export const inject = []

const DEFAULTS = {
  dir: '',
  pollMs: 1000,
  replyTimeoutMs: 180000,
  maxReplyChars: 8000,
  deliverMode: 'queue',
  maxConcurrent: 4,
  autoJump: true,
  parseAttempts: 3,
  parseRetryDelayMs: 400,
  mailRoot: '',
  ackTimeoutMs: 300000,
}

const log = (...args) => {
  console.log('[session-bridge]', ...args)
}

/** 配置兜底：坏值不许把队列搞停摆（verifier 建议修 7）。 */
function sanitize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) }
  const num = (value, fallback, min) => (Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback)
  return {
    dir: typeof cfg.dir === 'string' ? cfg.dir : DEFAULTS.dir,
    pollMs: num(cfg.pollMs, DEFAULTS.pollMs, 200),
    replyTimeoutMs: num(cfg.replyTimeoutMs, DEFAULTS.replyTimeoutMs, 5000),
    maxReplyChars: num(cfg.maxReplyChars, DEFAULTS.maxReplyChars, 200),
    deliverMode: cfg.deliverMode === 'steer' ? 'steer' : 'queue',
    maxConcurrent: num(cfg.maxConcurrent, DEFAULTS.maxConcurrent, 1),
    autoJump: cfg.autoJump !== false,
    parseAttempts: num(cfg.parseAttempts, DEFAULTS.parseAttempts, 1),
    parseRetryDelayMs: num(cfg.parseRetryDelayMs, DEFAULTS.parseRetryDelayMs, 50),
    mailRoot: typeof cfg.mailRoot === 'string' ? cfg.mailRoot : DEFAULTS.mailRoot,
    ackTimeoutMs: num(cfg.ackTimeoutMs, DEFAULTS.ackTimeoutMs, 10000),
  }
}

/** Windows 路径不区分大小写；整串 casefold 后再比，别只比盘符（verifier 建议修 4）。 */
function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let p = value.replace(/\//g, sep)
  if (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function samePath(a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  return left !== undefined && right !== undefined && left === right
}

/** 请求里自带的 id 只在安全字符集内被采纳，否则用文件名（路径穿越不可达）。 */
function safeId(candidate, fallback) {
  return typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(candidate) && !candidate.startsWith('.')
    ? candidate
    : fallback
}

function messageOf(event) {
  if (!event || !event.data) return undefined
  // assistant/message 把消息包在 data.message 里；user/message 等 surface 事件的 data 就是消息本体。
  return event.type === 'assistant/message' ? event.data.message : event.data
}

function blockText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function apply(ctx, config = {}) {
  const cfg = sanitize(config)
  const root = isAbsolute(cfg.dir || '')
    ? cfg.dir
    : resolve(cfg.dir || join(process.env.DSH_HOME || process.cwd(), 'session-bridge'))
  const dirs = {
    inbox: join(root, 'inbox'),
    working: join(root, 'working'),
    outbox: join(root, 'outbox'),
    done: join(root, 'done'),
    failed: join(root, 'failed'),
  }
  const mailRoot = isAbsolute(cfg.mailRoot || '')
    ? cfg.mailRoot
    : resolve(cfg.mailRoot || join(process.env.DSH_HOME || process.cwd(), 'mail'))
  const mailbox = createMailbox({
    root: mailRoot,
    ackTimeoutMs: cfg.ackTimeoutMs,
    service: (key) => (ctx.get ? ctx.get(key) : ctx[key]),
    log,
    // v6：一切按工作区走 —— 每封信先解析两侧会话的 cwd，再落到各自 .dsh-mail/
    cwdOf: (sessionId) => (sessionId ? sessionCwdOf(sessionId) : Promise.resolve(undefined)),
    cwds: async () => {
      const table = await loadFriends()
      return [...new Set(Object.values(table || {}).map((row) => row && row.cwd).filter(Boolean))]
    },
  })

  const inflight = new Set()
  const activeIds = new Set()
  let ticking = false
  let heartbeatCounter = 0

  const abort = () => new AbortController().signal
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 读会话最近一页事件（含 user/message 与 turn/end；wait 的 output 不提供这些）。 */
  async function readEvents(sessionId, maxMessages = 80) {
    const controller = service('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    return controller.events({ address: { kind: 'session', sessionId }, maxMessages }, abort())
  }

  const ready = (async () => {
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    // 崩溃残留：working/ 里超过 10 分钟没人处理，转 failed 并补一条 outbox，避免调用方永远等。
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const name of await readdir(dirs.working).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const full = join(dirs.working, name)
      try {
        const info = await stat(full)
        if (info.mtimeMs >= cutoff) continue
        const base = name.replace(/\.[0-9a-f]{8}\.json$/, '').replace(/\.json$/, '')
        const result = { id: base, ok: false, root, error: { message: 'orphaned in working/ (process restart)', code: 'ORPHANED' } }
        await writeJsonAtomic(join(dirs.outbox, base + '.json'), result).catch(() => {})
        await rename(full, join(dirs.failed, base.slice(0, 100) + '.json')).catch(() => {})
      } catch {
        /* 忽略单个文件 */
      }
    }
    log('queue root =', root)
  })().catch((error) => log('failed to initialize queue directories: ', error && error.message))

  function service(key) {
    try {
      return ctx.get ? ctx.get(key) : ctx[key]
    } catch {
      return undefined
    }
  }

  async function exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /** outbox/结果一律 tmp + rename，别让客户端读到半截 JSON（verifier 建议修 2）。 */
  async function writeJsonAtomic(path, value) {
    const tmp = path + '.' + randomUUID().slice(0, 8) + '.tmp'
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  }

  /** 会话持久化表头：冷会话也能按 cwd/preset 寻址。 */
  async function storedSessions() {
    const persistence = service('sessionPersistence')
    if (!persistence) return []
    const snapshots = await persistence.list({ signal: abort() })
    return snapshots.map((snapshot) => ({
      sessionId: snapshot.header.id,
      cwd: snapshot.header.cwd,
      preset: snapshot.header.agentPreset,
      origin: snapshot.header.origin,
      parent: snapshot.header.parentSession,
      createdAt: snapshot.header.createdAt,
    }))
  }

  function parseCwd(request) {
    if (!request.cwd) return undefined
    const raw = String(request.cwd)
    if (!isAbsolute(raw)) throw new Error('cwd must be an absolute path (a relative path resolves against the Host process directory): ' + raw)
    return resolve(raw)
  }

  async function resolveTarget(request) {
    if (typeof request.sessionId === 'string' && request.sessionId.length > 0) {
      return { sessionId: request.sessionId, created: false, matched: 1 }
    }
    const wantCwd = parseCwd(request)
    const wantPreset = typeof request.preset === 'string' && request.preset.length > 0 ? request.preset : undefined

    const rows = (await storedSessions()).filter((row) => row.origin !== 'subagent' && !row.parent)
    const matched = rows.filter(
      (row) => (!wantCwd || samePath(row.cwd, wantCwd)) && (!wantPreset || row.preset === wantPreset),
    )

    if (matched.length > 0) {
      const ordered = matched.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      const chosen = request.pick === 'oldest' ? ordered[0] : ordered[ordered.length - 1]
      return { sessionId: chosen.sessionId, created: false, matched: matched.length, preset: chosen.preset }
    }

    if (request.create === true) {
      const controller = service('sessionController')
      if (!controller) throw new Error('sessionController unavailable，无法新建会话')
      const created = await controller.create({ cwd: wantCwd, agentPreset: wantPreset })
      return { sessionId: created.sessionId, created: true, matched: 0, preset: created.agentPreset || wantPreset }
    }

    throw new Error(
      'no matching session: cwd=' + (wantCwd || '*') + ' preset=' + (wantPreset || '*') + ' (pass create: true to create one)',
    )
  }

  function deliverModeOf(request) {
    return request.mode === 'steer' || request.mode === 'queue' ? request.mode : cfg.deliverMode
  }

  async function deliver(sessionId, text, mode) {
    const controller = service('sessionController')
    if (!controller) throw new Error('sessionController unavailable，无法投递')
    return controller.prompt(
      { requestId: randomUUID(), sessionId, mode, content: [{ type: 'text', text }] },
      abort(),
    )
  }

  /** 投递前的会话游标；失败不再静默放行，而是把 degraded 标记交给上层。 */
  async function cursorOf(sessionId) {
    const controller = service('sessionController')
    if (!controller) return { ok: false }
    try {
      const state = await controller.state({ sessionId }, abort())
      const cursor = state && Number.isFinite(state.cursor) ? state.cursor : undefined
      return { ok: cursor !== undefined, cursor, running: state ? state.running : undefined }
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  }

  function assistantText(records, limit) {
    const parts = []
    for (const record of records || []) {
      const event = record && record.event
      if (!event || event.type !== 'assistant/message') continue
      const text = blockText(messageOf(event))
      if (text.length > 0) parts.push(text)
    }
    const joined = parts.join('\n').trim()
    return joined.length > limit ? joined.slice(0, limit) + '\n…[截断]' : joined
  }

  /**
   * 收集"我们这一轮"的产出。
   *
   * 为什么不用 `wait` 的 output：实测它的记录窗口只给 assistant 输出，拿不到 user/message，
   * 于是"按我这条消息切轮次"根本无从下手（并发投递时会串轮）。改为直接读会话事件页：
   *   找到我们这条 user/message 的 seq → 往后收到下一条 user/message 或 turn/end 为止。
   */
  async function collectOwnTurn(sessionId, sentText, timeoutMs, limit, sinceSeq) {
    const deadline = Date.now() + timeoutMs
    const wanted = sentText.trim()
    let lastError
    let lastPending

    while (Date.now() < deadline) {
      let page
      try {
        page = await readEvents(sessionId)
      } catch (error) {
        lastError = error
        await sleep(500)
        continue
      }

      const records = (page && page.records) || []
      let anchor = -1
      for (let index = 0; index < records.length; index += 1) {
        const event = records[index] && records[index].event
        if (!event || event.type !== 'user/message') continue
        if (blockText(messageOf(event)) !== wanted) continue
        if (Number.isFinite(sinceSeq) && Number(event.seq) <= sinceSeq) continue
        anchor = index
      }

      if (anchor >= 0) {
        // 同一条 turn 里 DSH 会再注入 user/message（排队/steer 的合流，实测 seq 相邻），
        // 所以不能拿"下一条 user/message"当边界，必须用 turn/end 收口。
        const tail = []
        let ended = false
        for (let index = anchor + 1; index < records.length; index += 1) {
          const event = records[index] && records[index].event
          if (!event) continue
          if (event.type === 'turn/end' || event.type === 'session/end') {
            ended = true
            break
          }
          if (event.type === 'turn/start') continue
          tail.push(records[index])
        }
        const hasAssistant = tail.some((record) => record.event && record.event.type === 'assistant/message')
        if (hasAssistant) {
          return { anchored: true, reply: assistantText(tail, limit), records: tail.length, completed: ended }
        }
        if (ended) return { anchored: true, reply: '', records: tail.length, completed: true }
      }

      try {
        const state = await service('sessionController').state({ sessionId }, abort())
        lastPending = state && Array.isArray(state.pendingInput) ? state.pendingInput : undefined
      } catch {}

      await sleep(500)
    }

    return {
      anchored: false,
      reply: '',
      records: 0,
      completed: false,
      pendingInput: lastPending,
      error: lastError,
    }
  }

  async function finish(dirsResult, workingPath, id, request) {
    try {
      await writeJsonAtomic(join(dirs.outbox, id + '.json'), dirsResult)
    } catch (error) {
      log('outbox write failed for', id, (error && error.message) || String(error))
    }
    const donePath = join(dirs.done, id + '.json')
    if (dirsResult.ok === true) {
      const target = (await exists(donePath)) ? join(dirs.done, id.slice(0, 100) + '.' + Date.now() + '.json') : donePath
      await rename(workingPath, target).catch(async () => {
        await writeFile(target, JSON.stringify(request, null, 2), 'utf8')
      })
    } else {
      await rename(workingPath, join(dirs.failed, id.slice(0, 100) + '.json')).catch(() => {})
    }
    if (dirsResult.ok !== true) {
      await writeJsonAtomic(join(dirs.failed, id + '.json'), dirsResult).catch(() => {})
      log('delivery failed', id, dirsResult.error && dirsResult.error.message)
    }
  }

  async function handle(workingPath, id, request) {
    const startedAt = Date.now()
    const limit = Number.isFinite(request.maxReplyChars) ? request.maxReplyChars : cfg.maxReplyChars
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : cfg.replyTimeoutMs
    const result = { id, ok: false, startedAt, root }

    try {
      const action = request.action === undefined ? 'deliver' : request.action
      const ACTIONS = ['deliver', 'sessions', 'events', 'init_workspace', 'handoff', 'notify', 'relay', 'list_children', 'jump', 'delete_workspace', 'mail_send', 'mail_ack', 'mail_list']
      if (!ACTIONS.includes(action)) {
        throw new Error('unknown action: ' + String(action) + '（支持 ' + ACTIONS.join(' / ') + '）')
      }

      // ===== 信箱：五件套 + 在途账本 =====
      if (action === 'mail_send' || action === 'mail_ack' || action === 'mail_list') {
        if (action === 'mail_send' && request.senderSessionId) {
          // 前提：发信方也必须是已注册好友（没有会话的脚本调用不受此限）。
          const table = await loadFriends()
          const registered = Object.values(table).some((row) => row && row.sessionId === request.senderSessionId)
          if (!registered) {
            Object.assign(result, { ok: false, error: { message: 'sender session is not registered in the friends list; call session_register_name first', code: 'SENDER_NOT_REGISTERED' } })
            result.finishedAt = Date.now()
            result.elapsedMs = result.finishedAt - startedAt
            await finish(result, workingPath, id, request)
            return
          }
        }
        if (action === 'mail_send' && !request.peerSessionId && request.peer) {
          const callerCwd = request.senderSessionId ? await sessionCwdOf(request.senderSessionId) : undefined
          const resolved = await resolveFriend(request.peer, callerCwd)
          if (!resolved.ok) {
            Object.assign(result, { ok: false, error: { message: resolved.message, code: resolved.code } })
            result.finishedAt = Date.now()
            result.elapsedMs = result.finishedAt - startedAt
            await finish(result, workingPath, id, request)
            return
          }
          request.peerSessionId = resolved.friend.sessionId
          request.friendRelation = resolved.relation
        }
        const value =
          action === 'mail_send'
            ? await mailbox.send(request)
            : action === 'mail_ack'
              ? await mailbox.ack(request)
              : await mailbox.list(request)
        Object.assign(result, value)
        result.mailRoot = mailRoot
        result.ok = value.ok !== false
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 会话编排：建目录 + 建工作区 + 建初始会话 =====
      if (action === 'init_workspace') {
        const presetId = String(request.preset || '')
        const target = parseCwd(request)
        if (!target) throw new Error('init_workspace requires an absolute cwd')
        const presets = service('agentPresets')
        if (!presets) throw new Error('agentPresets service unavailable')
        try {
          await presets.resolve(presetId)
        } catch {
          const error = new Error('unknown agent preset: ' + presetId)
          error.code = 'PRESET_NOT_FOUND'
          throw error
        }
        await mkdir(target, { recursive: true })
        const registry = service('workspaceRegistry')
        let workspace
        let workspaceCreated = false
        if (registry) {
          workspace = await registry.resolveByPath(target)
          if (!workspace) {
            workspace = await registry.create(target, request.title || request.project || undefined)
            workspaceCreated = true
          }
        }
        const controller = service('sessionController')
        if (!controller) throw new Error('sessionController unavailable，无法建会话')
        // session.create 只接受 workspaceId 或 cwd 其中之一（实测报 gateway/bad-request）
        const created = await controller.create(
          workspace && workspace.id
            ? { workspaceId: workspace.id, agentPreset: presetId }
            : { cwd: target, agentPreset: presetId },
        )
        result.ok = true
        result.project = request.project
        result.cwd = target
        result.preset = presetId
        result.sessionId = created.sessionId
        result.workspaceId = workspace && workspace.id
        result.workspaceCreated = workspaceCreated
        result.workspaceTitle = workspace && workspace.title
        result.creatorSessionId = request.creatorSessionId
        if (request.creatorSessionId && created.sessionId) {
          const linksDir = join(root, 'jumps', 'links')
          await mkdir(linksDir, { recursive: true })
          await writeFile(
            join(linksDir, created.sessionId + '.json'),
            JSON.stringify({ creatorSessionId: request.creatorSessionId, workspace: target, preset: presetId, createdAt: new Date().toISOString() }, null, 2),
            'utf8',
          )
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 交棒：校验源会话“存在”（不是“活着”）+ 用新预设建下一阶段会话 =====
      if (action === 'handoff') {
        const presetId = String(request.preset || '')
        const sourceSessionId = String(request.sourceSessionId || '')
        if (!sourceSessionId) throw new Error('handoff 需要 sourceSessionId')
        const persistence = service('sessionPersistence')
        if (!persistence) throw new Error('sessionPersistence service unavailable')
        const snapshot = await persistence.stat(sourceSessionId, { signal: abort() })
        if (!snapshot) {
          const error = new Error('source session not found: ' + sourceSessionId)
          error.code = 'SOURCE_SESSION_NOT_FOUND'
          throw error
        }
        const cwd = snapshot.header && snapshot.header.cwd
        if (!cwd) {
          const error = new Error('source session has no cwd: ' + sourceSessionId)
          error.code = 'SOURCE_HAS_NO_CWD'
          throw error
        }
        const presets = service('agentPresets')
        if (!presets) throw new Error('agentPresets service unavailable')
        try {
          await presets.resolve(presetId)
        } catch {
          const error = new Error('unknown agent preset: ' + presetId)
          error.code = 'PRESET_NOT_FOUND'
          throw error
        }
        const registry = service('workspaceRegistry')
        const workspace = registry ? await registry.resolveByPath(cwd) : undefined
        const controller = service('sessionController')
        if (!controller) throw new Error('sessionController unavailable，无法建会话')
        const created = await controller.create(
          workspace && workspace.id
            ? { workspaceId: workspace.id, agentPreset: presetId }
            : { cwd, agentPreset: presetId },
        )
        result.ok = true
        result.sessionId = created.sessionId
        result.sourceSessionId = sourceSessionId
        result.cwd = cwd
        result.preset = presetId
        result.workspaceId = workspace && workspace.id
        result.sourcePreset = snapshot.header.agentPreset
        const agents = service('agents')
        result.sourceLive = Boolean(agents && agents.get(sourceSessionId))
        result.creatorSessionId = request.creatorSessionId
        if (request.creatorSessionId && created.sessionId) {
          const linksDir = join(root, 'jumps', 'links')
          await mkdir(linksDir, { recursive: true })
          await writeFile(
            join(linksDir, created.sessionId + '.json'),
            JSON.stringify({ creatorSessionId: request.creatorSessionId, sourceSessionId, cwd, preset: presetId, createdAt: new Date().toISOString() }, null, 2),
            'utf8',
          )
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 唤醒：只投一条带固定前缀的裸提醒（不冒充人类、不改会话形态） =====
      if (action === 'notify') {
        const targetSession = String(request.sessionId || '')
        if (!targetSession) throw new Error('notify requires sessionId')
        const prefix = typeof request.prefix === 'string' && request.prefix.length > 0 ? request.prefix : '【机器通知·信箱】'
        const body = typeof request.text === 'string' ? request.text : ''
        const text = prefix + ' ' + body + (request.onlyPath === true ? '（仅通知，不含指令）' : '')
        const controller = service('sessionController')
        if (!controller) throw new Error('sessionController unavailable，无法投递提醒')
        await controller.prompt(
          {
            requestId: randomUUID(),
            sessionId: targetSession,
            mode: request.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
          },
          abort(),
        )
        result.ok = true
        result.delivered = true
        result.sessionId = targetSession
        result.text = text
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 投给子会话：走 subagents.prompt（sessionController.prompt 会被 subagent routing 拒收）=====
      if (action === 'relay') {
        const parentSessionId = String(request.parentSessionId || '')
        const childSessionId = String(request.childSessionId || '')
        if (!parentSessionId || !childSessionId) throw new Error('relay requires parentSessionId and childSessionId')
        const subagents = service('subagents')
        if (!subagents) throw new Error('subagents service unavailable')
        const receipt = await subagents.prompt(
          {
            requestId: randomUUID(),
            parentSessionId,
            childSessionId,
            mode: 'continuable',
            delivery: request.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text: String(request.text || '') }],
          },
          abort(),
        )
        result.ok = true
        result.delivered = true
        result.parentSessionId = parentSessionId
        result.childSessionId = childSessionId
        result.messageId = receipt && receipt.messageId
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 自动跳转模式：写一条待跳转记录，客户端轮询到就自己跳 =====
      if (action === 'jump') {
        const targetAddress = request.target && typeof request.target === 'object' ? request.target : undefined
        const targetSessionId = String(request.targetSessionId || '')
        if (!targetAddress && !targetSessionId) throw new Error('jump requires targetSessionId or a target address')
        if (cfg.autoJump !== true) {
          result.ok = false
          result.skipped = true
          result.error = { message: 'autoJump is disabled', code: 'AUTO_JUMP_DISABLED' }
        } else {
          const pendingDir = join(root, 'jumps', 'pending')
          await mkdir(pendingDir, { recursive: true })
          const key = Date.now() + '-' + randomUUID().slice(0, 8)
          await writeFile(
            join(pendingDir, key + '.json'),
            JSON.stringify(
              {
                key,
                sourceSessionId: request.sessionId || null,
                target: targetAddress || targetSessionId,
                reason: request.reason || null,
                createdAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            'utf8',
          )
          result.ok = true
          result.queued = true
          result.key = key
          result.target = targetAddress || targetSessionId
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 子会话目录：让脚本自己认出「信使」（不依赖 Leader 写文件）=====
      if (action === 'list_children') {
        const parentSessionId = String(request.sessionId || '')
        if (!parentSessionId) throw new Error('list_children requires sessionId (the parent session)')
        const subagents = service('subagents')
        if (!subagents) throw new Error('subagents service unavailable')
        const children = await subagents.listChildren(parentSessionId, abort())
        const wantedMode = typeof request.mode === 'string' && request.mode.length > 0 ? request.mode : undefined
        result.children = (children || [])
          .filter((entry) => !wantedMode || entry.mode === wantedMode)
          .map((entry) => ({
            sessionId: entry.id,
            mode: entry.mode,
            label: entry.label,
            createdAt: entry.createdAt,
            createdAtIso: entry.createdAt ? new Date(entry.createdAt).toISOString() : undefined,
          }))
        result.count = result.children.length
        result.ok = true
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 撤销：删工作区记录（可连带删目录），给一次性工具收尾用 =====
      if (action === 'delete_workspace') {
        const workspaceId = String(request.workspaceId || '')
        if (!workspaceId) throw new Error('delete_workspace requires workspaceId')
        const registry = service('workspaceRegistry')
        if (!registry) throw new Error('workspaceRegistry service unavailable')
        const workspace = registry.get(workspaceId)
        const removed = await registry.delete(workspaceId)
        let dirRemoved = false
        if (request.removeDir === true && workspace && workspace.path) {
          await rm(workspace.path, { recursive: true, force: true }).then(() => { dirRemoved = true }).catch(() => {})
        }
        result.ok = true
        result.workspaceId = workspaceId
        result.removed = Boolean(removed)
        result.dirRemoved = dirRemoved
        result.path = workspace && workspace.path
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 实测探针：workspaceRegistry.create 之后 workspaceController.follow 会不会推帧 =====
      if (action === 'probe_workspace_stream') {
        const controller = service('workspaceController')
        const registry = service('workspaceRegistry')
        if (!controller || !registry) throw new Error('workspaceController / workspaceRegistry unavailable')
        const frames = []
        const windowMs = Number.isFinite(request.windowMs) ? request.windowMs : 5000
        const probeDir = join(String(request.probeDir || root), '_probe_ws_' + randomUUID().slice(0, 8))
        const abortController = new AbortController()
        let created
        const timer = setTimeout(() => abortController.abort(), windowMs)
        const iterator = controller.follow(abortController.signal)[Symbol.asyncIterator]()
        try {
          const pumping = (async () => {
            try {
              for (;;) {
                const next = await iterator.next()
                if (next.done) break
                const frame = next.value || {}
                frames.push({ at: Date.now(), type: frame.type, workspaceId: frame.workspace && frame.workspace.id })
              }
            } catch {
              // abort 收尾
            }
          })()
          await sleep(800)
          await mkdir(probeDir, { recursive: true })
          created = await registry.create(probeDir, 'probe-' + Date.now())
          await sleep(Math.min(2500, windowMs - 1000))
          abortController.abort()
          await pumping.catch(() => {})
        } finally {
          clearTimeout(timer)
          try {
            await iterator.return?.()
          } catch {}
          if (created) await registry.delete(created.id).catch(() => {})
          await rm(probeDir, { recursive: true, force: true }).catch(() => {})
        }
        result.ok = true
        result.frames = frames
        result.frameCount = frames.length
        result.createdId = created && created.id
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      if (action === 'events') {
        const page = await readEvents(request.sessionId, Number.isFinite(request.limit) ? request.limit : 40)
        result.events = ((page && page.records) || []).map((record) => {
          const event = record && record.event
          const message = messageOf(event)
          return {
            seq: event && event.seq,
            type: event && event.type,
            preview: blockText(message).slice(0, 60),
            dataKeys: event && event.data ? Object.keys(event.data) : [],
            messageKeys: message && typeof message === 'object' ? Object.keys(message) : [],
            messageId: message && typeof message === 'object' ? message.id || message.messageId : undefined,
            hasMarker: blockText(message).includes('sa-session:'),
            textLen: blockText(message).length,
          }
        })
        result.ok = true
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      if (action === 'sessions') {
        const wantCwd = parseCwd(request)
        const wantPreset = typeof request.preset === 'string' && request.preset.length > 0 ? request.preset : undefined
        result.sessions = (await storedSessions())
          .filter((row) => row.origin !== 'subagent' && !row.parent)
          .filter((row) => (!wantCwd || samePath(row.cwd, wantCwd)) && (!wantPreset || row.preset === wantPreset))
          .map((row) => ({
            sessionId: row.sessionId,
            cwd: row.cwd,
            preset: row.preset,
            createdAt: row.createdAt,
            createdAtIso: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
          }))
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        result.ok = true
        result.count = result.sessions.length
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      const text = typeof request.text === 'string' ? request.text : ''
      if (text.trim().length === 0) throw new Error('request is missing text')
      const mode = deliverModeOf(request)

      const target = await resolveTarget(request)
      result.sessionId = target.sessionId
      result.created = target.created === true
      result.preset = target.preset
      if (target.matched > 1) result.matched = target.matched

      const before = await cursorOf(target.sessionId)
      result.cursorOk = before.ok
      if (before.running === true) result.targetBusy = true
      if (!before.ok) result.degraded = 'pre-delivery cursor unavailable; reply may include earlier turns'

      await deliver(target.sessionId, text, mode)
      result.delivered = true
      result.mode = mode

      if (request.reply !== false) {
        const sinceSeq = Number.isFinite(request.afterSeq) ? request.afterSeq : undefined
        const collected = await collectOwnTurn(target.sessionId, text, timeoutMs, limit, sinceSeq)

        if (!collected.anchored && result.degraded === undefined) {
          result.degraded = 'no user/message for this prompt inside the wait window; reply may include other turns'
        }
        result.reason = collected.completed ? 'completed' : collected.pendingInput && collected.pendingInput.length > 0 ? 'input-required' : 'timeout'
        if (collected.pendingInput && collected.pendingInput.length > 0) result.pendingInput = collected.pendingInput
        result.anchored = collected.anchored
        result.reply = collected.reply
        result.replyChars = collected.reply.length
        result.replyRecords = collected.records
        if (sinceSeq !== undefined) result.sinceSeq = sinceSeq
      }
      result.ok = true
    } catch (error) {
      result.error = { message: (error && error.message) || String(error), code: (error && error.code) || undefined }
      if (error && error.name && !result.error.code) result.error.name = error.name
    }

    result.finishedAt = Date.now()
    result.elapsedMs = result.finishedAt - startedAt
    await finish(result, workingPath, id, request)
  }

  /** 原子认领：先 rename 走再处理，重复 id 的第二份文件不会覆盖在途的那份（verifier 必须修 2）。 */
  async function claim(fileName) {
    const fallbackId = fileName.slice(0, -'.json'.length)
    if (await exists(join(dirs.done, fallbackId + '.json'))) {
      const stamp = Date.now()
      await rename(join(dirs.inbox, fileName), join(dirs.done, fallbackId + '.repeat-' + stamp + '.json')).catch(() => {})
      log('duplicate id skipped (idempotent): ', fallbackId)
      return undefined
    }
    const workingName = fallbackId.slice(0, 120) + '.' + randomUUID().slice(0, 8) + '.json'
    const workingPath = join(dirs.working, workingName)
    try {
      await rename(join(dirs.inbox, fileName), workingPath)
    } catch (error) {
      return undefined
    }
    return { fallbackId, workingPath }
  }

  async function readRequest(workingPath) {
    const raw = await readFile(workingPath, 'utf8')
    return JSON.parse(raw)
  }

  /** 半截文件（脚本正在写 / tmp 尚未 rename）很常见：原地短重试几次再判失败，失败也写 outbox。 */
  async function readRequestWithRetry(workingPath) {
    let lastError
    for (let attempt = 1; attempt <= cfg.parseAttempts; attempt += 1) {
      try {
        return { request: await readRequest(workingPath) }
      } catch (error) {
        lastError = error
        if (attempt < cfg.parseAttempts) await new Promise((resolve) => setTimeout(resolve, cfg.parseRetryDelayMs))
      }
    }
    return { error: lastError }
  }

  async function drain() {
    const entries = await readdir(dirs.inbox).catch(() => [])
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.json.tmp')) continue
      if (inflight.size >= cfg.maxConcurrent) break
      const claimed = await claim(entry)
      if (!claimed) continue

      const parsed = await readRequestWithRetry(claimed.workingPath)
      if (parsed.error) {
        const id = claimed.fallbackId
        const now = Date.now()
        const result = {
          id,
          ok: false,
          root,
          startedAt: now,
          finishedAt: now,
          elapsedMs: 0,
          error: { message: 'request JSON parse failed: ' + ((parsed.error && parsed.error.message) || String(parsed.error)) },
        }
        await writeJsonAtomic(join(dirs.outbox, id + '.json'), result).catch(() => {})
        await rename(claimed.workingPath, join(dirs.failed, id + '.json')).catch(() => {})
        continue
      }
      const request = parsed.request
      const id = safeId(request.id, claimed.fallbackId)

      // 权威幂等检查放在读到 request.id 之后：文件名与 request.id 不一致时也不会重投。
      if (activeIds.has(id) || (await exists(join(dirs.done, id + '.json')))) {
        const stamp = Date.now()
        await rename(claimed.workingPath, join(dirs.done, id.slice(0, 100) + '.repeat-' + stamp + '.json')).catch(() => {})
        log('duplicate id skipped (idempotent or in flight): ', id)
        continue
      }

      activeIds.add(id)
      inflight.add(claimed.fallbackId)
      void handle(claimed.workingPath, id, request)
        .catch((error) => log('handler error: ', id, error && error.message))
        .finally(() => {
          inflight.delete(claimed.fallbackId)
          activeIds.delete(id)
        })
    }
  }

  async function tick() {
    await ready
    if (ticking) return
    ticking = true
    try {
      await drain()
    } catch (error) {
      log('queue scan failed: ', error && error.message)
    } finally {
      ticking = false
    }
    if (heartbeatCounter++ % 5 === 0) {
      await writeJsonAtomic(join(root, 'heartbeat.json'), {
        ok: true,
        pid: process.pid,
        time: new Date().toISOString(),
        dir: root,
        polling: cfg.pollMs,
        inflight: inflight.size,
      }).catch(() => {})
    }
  }

  /**
   * 模型工具：把队列里的三个动作暴露成 ctx.tools（Host 侧执行，不经过 shell），
   * 这样在原生沙盒（workspace-write / bash 不可用）下 agent 依然能建工作区、交棒、跳转。
   */
  async function submitLocal(request, timeoutMs = 20000) {
    const id = 'tool-' + randomUUID().slice(0, 12)
    request.id = id
    await mkdir(dirs.inbox, { recursive: true })
    await writeFile(join(dirs.inbox, id + '.json'), JSON.stringify(request, null, 2), 'utf8')
    const outbox = join(dirs.outbox, id + '.json')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(outbox, 'utf8'))
      } catch {
        await sleep(150)
      }
    }
    return { ok: false, id, error: { message: 'queue timeout (' + timeoutMs + 'ms）', code: 'QUEUE_TIMEOUT' } }
  }

  /** 会话好友表：<root>/friends.json，{friendlyName: {sessionId, cwd, updatedAt}}。 */
  const FRIENDS_FILE = () => join(root, 'friends.json')
  const FRIEND_MARK = /^〔友·([^〕]{1,32})〕/
  const FRIEND_NAME = /^[\w一-龥-]{1,32}$/

  /** 工作区归属：同一路径，或一方是另一方的子目录（继承左侧目录分级）。 */
  function workspaceRelation(a, b) {
    const left = normalizePath(a)
    const right = normalizePath(b)
    if (left === undefined || right === undefined) return 'unknown'
    if (left === right) return 'same'
    const withSep = (value) => (value.endsWith(sep) ? value : value + sep)
    if (withSep(right).startsWith(withSep(left)) || withSep(left).startsWith(withSep(right))) return 'nested'
    return 'other'
  }

  /** 解析收件人：必须先注册好友；跨工作区默认拒绝，只有 allowCrossWorkspace 才放行。 */
  async function resolveFriend(name, callerCwd) {
    const table = await loadFriends()
    const row = table[String(name || '').trim()]
    if (!row || !row.sessionId) return { ok: false, code: 'FRIEND_NOT_FOUND', message: 'unknown friend: ' + String(name || '') }
    const relation = workspaceRelation(callerCwd, row.cwd)
    if (relation === 'other' && cfg.allowCrossWorkspace !== true) {
      return { ok: false, code: 'CROSS_WORKSPACE_DISABLED', message: 'cross-workspace delivery is disabled (allowCrossWorkspace); ' + String(callerCwd || '?') + ' vs ' + String(row.cwd || '?') }
    }
    return { ok: true, friend: row, relation }
  }

  async function loadFriends() {
    try {
      const parsed = JSON.parse(await readFile(FRIENDS_FILE(), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  async function saveFriends(table) {
    await writeJsonAtomic(FRIENDS_FILE(), table)
  }

  async function sessionCwdOf(sessionId) {
    const persistence = service('sessionPersistence')
    if (!persistence) return undefined
    try {
      const snapshot = await persistence.stat(sessionId, { signal: abort() })
      return snapshot && snapshot.header ? snapshot.header.cwd : undefined
    } catch {
      return undefined
    }
  }

  function textResult(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }

  function registerTools() {
    log('registerTools enter')
    try {
    const tools = service('tools')
    if (!tools || typeof tools.register !== 'function') {
      log('tools service unavailable; skipping model tool registration')
      return () => {}
    }
    const params = (properties, required) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    })
    const textField = (description) => ({ type: 'string', description })
    const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) }

    const disposers = [
      tools.register({
        name: 'session_init_workspace',
        description:
          'Create (or reuse) a DSH workspace for one project and start its first stage session with a preset. Returns sessionId and workspaceId. Runs inside the Host, so it works without a shell.',
        parameters: params(
          {
            project: textField('Project name; also the default workspace title.'),
            workspace: textField('Absolute path of the workspace directory (created when missing).'),
            preset: textField('Agent preset id for the first stage, e.g. a researcher preset id.'),
            title: textField('Optional workspace title; defaults to project.'),
          },
          ['project', 'workspace', 'preset'],
        ),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          return submitLocal({
            action: 'init_workspace',
            project: args.project,
            cwd: args.workspace,
            preset: args.preset,
            title: args.title,
            creatorSessionId: caller,
          })
        },
      }),
      tools.register({
        name: 'session_handoff',
        description:
          'Start the next stage session in the same workspace as an existing stage session, using another preset. Existence is read from persistence, so cold sessions count. Runs inside the Host.',
        parameters: params(
          {
            source: textField('Existing stage session id (cold or live).'),
            preset: textField('Agent preset id for the next stage, e.g. a planning preset id.'),
          },
          ['source', 'preset'],
        ),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          const value = await submitLocal({
            action: 'handoff',
            sourceSessionId: args.source,
            preset: args.preset,
            creatorSessionId: caller,
          })
          return value
        },
      }),
      tools.register({
        name: 'session_register_name',
        description: 'Register the calling session under a friendly name in this workspace, so other sessions can address it by that name. One name per session; registering again replaces the previous name.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Friendly name, 1-32 characters (letters, digits, underscore, hyphen, CJK).' } },
          required: ['name'],
          additionalProperties: false,
        },
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          if (!caller) return { ok: false, error: { message: 'no calling agent', code: 'NO_CALLER' } }
          const name = String(args.name || '').trim()
          if (!FRIEND_NAME.test(name)) return { ok: false, error: { message: 'invalid name', code: 'BAD_NAME' } }
          const table = await loadFriends()
          const cwd = await sessionCwdOf(caller)
          for (const [existing, row] of Object.entries(table)) {
            if (row && row.sessionId === caller) delete table[existing]
          }
          table[name] = { sessionId: caller, cwd, workspace: cwd, updatedAt: new Date().toISOString() }
          await saveFriends(table)
          // 注册门控：注册即建箱；没注册的工作区不会出现 .dsh-mail
          let mailboxBox
          try {
            mailboxBox = cwd ? await ensureWorkspaceBox(cwd) : undefined
          } catch (error) {
            log('mailbox ensure failed: ', error && error.message)
          }
          return { ok: true, name, sessionId: caller, cwd, mailbox: mailboxBox ? mailboxBox.dir : null }
        },
      }),
      tools.register({
        name: 'session_list_names',
        description: 'List the friendly names registered in the calling session workspace (or all workspaces when includeOtherWorkspaces is true).',
        parameters: {
          type: 'object',
          properties: { includeOtherWorkspaces: { type: 'boolean', description: 'Include friends registered in other workspaces.' } },
          required: [],
          additionalProperties: false,
        },
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          const myCwd = caller ? await sessionCwdOf(caller) : undefined
          const table = await loadFriends()
          const rows = Object.entries(table)
            .map(([name, row]) => ({ name, ...row }))
            .filter((row) => args.includeOtherWorkspaces === true || !myCwd || !row.cwd || row.cwd === myCwd)
          return { ok: true, cwd: myCwd, count: rows.length, names: rows }
        },
      }),
      tools.register({
        name: 'session_tell',
        description: 'Send a message to another session registered under a friendly name. The delivered message carries a machine envelope identifying the sender, so the receiver can tell it apart from its human user.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Friendly name of the target session.' },
            text: { type: 'string', description: 'Message body.' },
          },
          required: ['name', 'text'],
          additionalProperties: false,
        },
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          const name = String(args.name || '').trim()
          const text = String(args.text || '')
          if (!text.trim()) return { ok: false, error: { message: 'empty text', code: 'EMPTY_TEXT' } }
          const table = await loadFriends()
          const target = table[name]
          if (!target || !target.sessionId) return { ok: false, error: { message: 'unknown friend: ' + name, code: 'FRIEND_NOT_FOUND' } }
          const myCwd = caller ? await sessionCwdOf(caller) : undefined
          if (cfg.allowCrossWorkspace !== true && myCwd && target.cwd && myCwd !== target.cwd) {
            return { ok: false, error: { message: 'cross-workspace delivery is disabled (allowCrossWorkspace)', code: 'CROSS_WORKSPACE_DISABLED' } }
          }
          let senderName = caller && caller.slice(0, 18)
          for (const [n, row] of Object.entries(table)) if (row && row.sessionId === caller) senderName = n
          const envelope = '〔友·' + senderName + '〕' + text
          const controller = service('sessionController')
          if (!controller) return { ok: false, error: { message: 'sessionController unavailable', code: 'NO_CONTROLLER' } }
          await controller.prompt({ requestId: randomUUID(), sessionId: target.sessionId, mode: 'queue', content: [{ type: 'text', text: envelope }] }, abort())
          return { ok: true, delivered: true, name, targetSessionId: target.sessionId, senderName, envelope }
        },
      }),
      tools.register({
        name: 'session_jump',
        description:
          'Queue a one-shot UI navigation for the calling session: the browser switches to the target session within a few seconds. Accepts a session id or a continuable subagent child id.',
        parameters: params(
          {
            target: textField('Target session id (ordinary session).'),
            subagentChild: textField('Continuable child session id; use together with parent.'),
            parent: textField('Parent session id of the child; defaults to the caller.'),
            reason: textField('Short reason, recorded with the pending jump.'),
          },
          [],
        ),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          const request = { action: 'jump', sessionId: caller, reason: args.reason }
          if (args.subagentChild) {
            request.target = {
              kind: 'subagent',
              parentSessionId: args.parent || caller,
              childSessionId: args.subagentChild,
              mode: 'continuable',
            }
          } else {
            request.targetSessionId = args.target
          }
          const value = await submitLocal(request)
          return value
        },
      }),
      tools.register({
        name: 'mail_send',
        description:
          'Send a mailbox letter (five-directory mailbox: 已接收/处理中/已发送/待办/已解决) to another role. Writes one copy for the sender in 已发送 and one for the receiver in 已接收, keeps an on-disk in-flight ledger, and pushes the letter into the receiver session. If no acknowledgement arrives before ackTimeoutMs, the plugin moves BOTH copies to 待办 automatically.',
        parameters: params(
          {
            owner: textField('Mailbox owner (the sender role name), e.g. leader or dispatcher.'),
            peer: textField('Peer role name (the receiver).'),
            type: textField('Letter type, e.g. S-PROGRESS, S-ACK, S-TODO-NOTICE, R-PLAN-PROPOSAL, T-ASSIGN.'),
            body: textField('Letter body (Markdown).'),
            peerSessionId: textField('Receiver session id to push into; omit to skip the push.'),
            ackOf: textField('For S-ACK: the mail_id being acknowledged.'),
            reason: textField('For S-TODO-NOTICE: why it is stuck (must be concrete).'),
          },
          ['owner', 'peer', 'body'],
        ),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          return submitLocal({ action: 'mail_send', ...args, senderSessionId: caller })
        },
      }),
      tools.register({
        name: 'mail_ack',
        description:
          'Acknowledge a mailbox letter: moves both copies from 已发送/已接收 to 处理中 and stops the timeout clock. Pass close:true to move both copies to 已解决 (chain closed).',
        parameters: params({ mailId: textField('mail_id to acknowledge.'), close: { type: 'boolean', description: 'Close the chain: move both copies to 已解决.' } }, ['mailId']),
        output,
        async execute(args) {
          return submitLocal({ action: 'mail_ack', mailId: args.mailId, close: args.close === true })
        },
      }),
      tools.register({
        name: 'mail_list',
        description: 'List mailbox letters for one owner (optionally one peer), with directory, status, deadline and overdue flag.',
        parameters: params({ owner: textField('Mailbox owner role name.'), peer: textField('Optional peer role name.') }, ['owner']),
        output,
        async execute(args) {
          return submitLocal({ action: 'mail_list', owner: args.owner, peer: args.peer })
        },
      }),
    ]
    log('tools registered: session_init_workspace / session_handoff / session_jump / mail_send / mail_ack / mail_list')
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
    } catch (error) {
      log('registerTools failed: ', (error && error.message) || String(error))
      return () => {}
    }
  }

  /** 给浏览器半身用的一条同源路由：GET /session-bridge/client-report?data=<json> → 落成文件。 */
  function registerClientReportRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable; skipping /session-bridge/client-report')
      return () => {}
    }
    const reportsDir = join(root, 'client-reports')
    return webServer.register({
      path: '/session-bridge/client-report',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const raw = (url.searchParams.get('data') || '{}').slice(0, 4096)
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            payload = { raw }
          }
          await mkdir(reportsDir, { recursive: true })
          const existing = (await readdir(reportsDir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()
          for (const stale of existing.slice(0, Math.max(0, existing.length - 19))) {
            await rm(join(reportsDir, stale), { force: true }).catch(() => {})
          }
          const file = join(reportsDir, Date.now() + '-' + randomUUID().slice(0, 8) + '.json')
          await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
          return new Response(JSON.stringify({ ok: true, file }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  /** 账本：把某个按钮标记为"已用过"。返回 { ok, used:true }。 */
  function registerFlagUseRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/jump-used',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const key = url.searchParams.get('key') || ''
          if (!key) {
            return new Response(JSON.stringify({ ok: false, error: 'key required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const dir = join(root, 'jumps', 'used')
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, key.replace(/[^A-Za-z0-9._-]/g, '_') + '.flag'), new Date().toISOString(), 'utf8')
          return new Response(JSON.stringify({ ok: true, key }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  /** GET /session-bridge/auto-jump?sessionId=… → 取这个会话最早的一条待跳转记录。 */
  function registerAutoJumpRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/auto-jump',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const pendingDir = join(root, 'jumps', 'pending')
          let names = []
          try {
            names = (await readdir(pendingDir)).filter((name) => name.endsWith('.json')).sort()
          } catch {
            names = []
          }
          for (const name of names) {
            try {
              const record = JSON.parse(await readFile(join(pendingDir, name), 'utf8'))
              if (record.sourceSessionId && record.sourceSessionId !== sessionId) continue
              return new Response(
                JSON.stringify({ ok: true, found: true, key: record.key || name.replace(/\.json$/, ''), target: record.target !== undefined ? record.target : record.targetSessionId }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              )
            } catch {
              continue
            }
          }
          return new Response(JSON.stringify({ ok: true, found: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  /** GET /session-bridge/auto-jump-used?key=… → 消费掉一条待跳转记录。 */
  function registerAutoJumpUsedRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/auto-jump-used',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const key = (url.searchParams.get('key') || '').replace(/[^A-Za-z0-9._-]/g, '_')
          if (!key) {
            return new Response(JSON.stringify({ ok: false, error: 'key required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const dir = join(root, 'jumps', 'pending')
          let removed = false
          for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
            let record
            try {
              record = JSON.parse(await readFile(join(dir, name), 'utf8'))
            } catch {
              continue
            }
            if ((record.key || name.replace(/\.json$/, '')) === key) {
              await rm(join(dir, name), { force: true }).then(() => {
                removed = true
              }).catch(() => {})
              break
            }
          }
          return new Response(JSON.stringify({ ok: true, removed }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  /** GET /session-bridge/back?sessionId=… → 这个会话的创建者是谁（登记表优先，退化为 subagent 父会话）。 */
  function registerBackLookupRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return registerBackLookupRouteImpl(webServer)
  }

  function registerBackLookupRouteImpl(webServer) {
    return webServer.register({
      path: '/session-bridge/back',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          let creator
          let source = 'none'
          try {
            const link = JSON.parse(await readFile(join(root, 'jumps', 'links', safeId(sessionId, '_') + '.json'), 'utf8'))
            creator = link && link.creatorSessionId
            if (creator) source = 'link'
          } catch {}
          if (!creator) {
            const persistence = service('sessionPersistence')
            if (persistence) {
              try {
                const snapshot = await persistence.stat(sessionId, { signal: abort() })
                creator = snapshot && snapshot.header && snapshot.header.parentSession
                if (creator) source = 'parentSession'
              } catch {}
            }
          }
          let used = false
          try {
            await stat(join(root, 'jumps', 'used', ('back-' + sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.flag'))
            used = true
          } catch {}
          return new Response(JSON.stringify({ ok: true, sessionId, found: Boolean(creator), creatorSessionId: creator, source, used }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  /** GET /session-bridge/jump?sessionId=… → 在该会话最近的助手消息里找 sa-session:<id> 标记。 */
  function registerJumpLookupRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/jump',
      kind: 'exact',
      resource: async (request) => {
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const messageId = url.searchParams.get('messageId') || ''
          const usedDir = join(root, 'jumps', 'used')
          const usedFlag = async (key) => {
            try {
              await stat(join(usedDir, key + '.flag'))
              return true
            } catch {
              return false
            }
          }
          const usedKey = (messageId || ('session-' + sessionId)).replace(/[^A-Za-z0-9._-]/g, '_')
          const jumpUsed = await usedFlag(usedKey)
          const page = await readEvents(sessionId, 200)
          const records = (page && page.records) || []
          let target
          let atSeq
          let matchedMessageId
          for (const record of records) {
            const event = record && record.event
            if (!event || event.type !== 'assistant/message') continue
            const message = messageOf(event)
            const id = message && typeof message === 'object' ? message.id || message.messageId : undefined
            if (messageId && id !== messageId) continue
            const text = blockText(message)
            const matches = [...text.matchAll(/(?:sa-)?session:([A-Za-z0-9-]+)/g)]
            if (matches.length > 0) {
              target = matches[matches.length - 1][1]
              atSeq = event.seq
              matchedMessageId = id
              if (messageId) break
            }
          }
          return new Response(JSON.stringify({ ok: true, sessionId, messageId: messageId || undefined, matchedMessageId, found: Boolean(target), target, atSeq, used: jumpUsed }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: (error && error.message) || String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
  }

  // ===== 信箱：推送优先 + 事件驱动（没有每秒扫描） =====
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      throw error
    }
    try {
      if (decision && decision.kind === 'enter') await mailbox.noteStep(payload && payload.agent, decision.messages)
    } catch (error) {
      log('mailbox pre-step failed: ', error && error.message)
    }
    return decision
  })

  ctx.on('agent/status', ({ agent, status }) => {
    void mailbox.noteStatus(agent, status).catch((error) => log('mailbox sentinel failed: ', error && error.message))
  })

  ctx.effect(() => {
    void mailbox.sweepAtStart().then((result) => log('mailbox cold start sweep: ', JSON.stringify(result))).catch((error) => log('mailbox cold sweep failed: ', error && error.message))
    return () => {}
  })

  ctx.effect(() => {
    const disposers = [registerClientReportRoute(), registerJumpLookupRoute(), registerFlagUseRoute(), registerBackLookupRoute(), registerAutoJumpRoute(), registerAutoJumpUsedRoute(), registerTools()]
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      void tick()
    }, cfg.pollMs)
    void tick()
    return () => clearInterval(timer)
  })
}