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
import { homedir } from 'node:os'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { createMailbox, ensureWorkspaceBox, workspaceBox } from './mail.js'

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
  ackTimeoutMs: z.natural().min(10000).default(300000).description('Move a letter to 待办 when no ACK arrives within this window.'),
  notifyToken: z.string().default('').description('Optional shared token for POST /session-bridge/notify; empty means no token check (loopback only).'),
  backTtlMs: z.natural().min(60000).default(1800000).description('How long a recorded jump keeps offering the 返回创建者 button.'),
  childNamePrefix: z.string().default('agent-').description('Prefix for auto-registered names of sessions created through session_init_workspace / session_handoff.'),
  taskChannelTtlMs: z.natural().min(60000).default(86400000).description('TTL of the dedicated creator<->child channel (default 24h).'),
  taskChannelIdleMs: z.natural().min(0).default(600000).description('Retire a dedicated channel when every letter of the pair settled and stayed idle this long.'),
  dispatcher: z.boolean().default(true).description('Run the queue dispatcher and HTTP routes. Set false for a tools-only instance mounted inside an agent preset; its tool calls then go through the running dispatcher over the file queue.'),
  backpressureReleaseMs: z.natural().min(0).default(600000).description('Soft release: allow the next letter of the same pair once the outstanding one has been delivered this long without an ACK. 0 means only an explicit ACK releases the pair.'),
  courierIntervalMs: z.natural().min(0).default(5000).description('Courier pacing: wait this long between two notice deliveries.'),
  busyHoldMs: z.natural().min(1000).default(180000).description('Move an undelivered letter to 待办 after the target stays busy this long.'),
  staleAfterMs: z.natural().min(60000).default(1800000).description('When a letter sits this long unprocessed, allow ONE extra courier nudge.'),
  digestGapMs: z.natural().min(0).default(600000).description('Minimum gap between two sender digests while the count is unchanged.'),
  groupAutoThreshold: z.natural().min(2).default(3).description('Auto-create a session group after this many letters between the same pair (both directions).'),
  allowAgentCreateSession: z.boolean().default(false).description('Allow the agent to start a brand-new session through this plugin. Off by default: the agent then cannot use a new session as a stand-in for a subagent, and DSH native session logic stays authoritative.'),
  askPresetOnCreate: z.boolean().default(false).description('When creating a workspace or session, ask which agent preset to use (listing available presets) instead of silently falling back to the host default. Off by default.'),
  requireDeleteConfirm: z.boolean().default(true).description('Demand a second, explicit CONFIRM phrase before delete_workspace removes a directory. Turning it off means one request can rm -rf the workspace path.'),
  guardSystemDrive: z.boolean().default(true).description('Refuse to create or delete inside the system drive (C:), DSH home and the app install directory. Turn it off only if you genuinely work on the system drive; the app install directory is wiped on every DSH upgrade.'),
  toolTimeoutMs: z.natural().min(1000).default(60000).description('How long a tool call waits for the dispatcher instance over the file queue. Raise it on slow machines or big workspaces.'),
  mailDirName: z.string().default('.dsh-mail').description('Mailbox directory name inside each workspace. Change it only for a fresh workspace; existing letters under the old name are not migrated automatically.'),
  guardedPaths: z.array(z.string()).default([]).description('Extra absolute paths that init_workspace / delete_workspace must never create in or delete (beyond the ones detected from the environment).')
})

/** 不声明硬依赖；可选服务一律用 ctx.get(name) + undefined 检查。 */
// webServer 必须声明为依赖：不声明时插件在 webServer 就绪前就 apply 了，
// ctx.get('webServer') 拿到 undefined，所有 HTTP 路由会静默跳过（/session-bridge/* 全部 404 的根因）。
// webServer 必须是硬依赖（不声明则路由全 404）。
// connection 也写在数组里：Cordis 的 inject 数组表示"这些服务就绪后才 apply"，
// 用对象写法在部分版本不被识别，会导致整个插件不加载（实测）。
// 缺 connection 时下面用 ctx.get 兜底，只退化访问检查，不会崩。
export const inject = ['webServer', 'connection']

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
  ackTimeoutMs: 300000,
  notifyToken: '',
  backTtlMs: 1800000,
  childNamePrefix: 'agent-',
  taskChannelTtlMs: 86400000,
  taskChannelIdleMs: 600000,
  dispatcher: true,
  allowCrossWorkspace: false,
  groupAutoThreshold: 3,
  mailDirName: '.dsh-mail',
  allowAgentCreateSession: false,
  askPresetOnCreate: false,
  requireDeleteConfirm: true,
  guardSystemDrive: true,
  toolTimeoutMs: 60000,
  backpressureReleaseMs: 600000,
  courierIntervalMs: 5000,
  busyHoldMs: 180000,
  staleAfterMs: 1800000,
  digestGapMs: 600000,
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
    ackTimeoutMs: num(cfg.ackTimeoutMs, DEFAULTS.ackTimeoutMs, 10000),
    notifyToken: typeof cfg.notifyToken === 'string' ? cfg.notifyToken : DEFAULTS.notifyToken,
    backTtlMs: num(cfg.backTtlMs, DEFAULTS.backTtlMs, 60000),
    childNamePrefix: typeof cfg.childNamePrefix === 'string' ? cfg.childNamePrefix : DEFAULTS.childNamePrefix,
    taskChannelTtlMs: num(cfg.taskChannelTtlMs, DEFAULTS.taskChannelTtlMs, 60000),
    taskChannelIdleMs: num(cfg.taskChannelIdleMs, DEFAULTS.taskChannelIdleMs, 0),
    guardedPaths: Array.isArray(cfg.guardedPaths) ? cfg.guardedPaths.filter((item) => typeof item === 'string' && item.trim()) : [],
    dispatcher: cfg.dispatcher !== false,
    allowAgentCreateSession: cfg.allowAgentCreateSession === true,
    askPresetOnCreate: cfg.askPresetOnCreate === true,
    requireDeleteConfirm: cfg.requireDeleteConfirm !== false,
    guardSystemDrive: cfg.guardSystemDrive !== false,
    toolTimeoutMs: num(cfg.toolTimeoutMs, DEFAULTS.toolTimeoutMs, 1000),
    groupAutoThreshold: num(cfg.groupAutoThreshold, DEFAULTS.groupAutoThreshold, 2),
    mailDirName: typeof cfg.mailDirName === 'string' && cfg.mailDirName.trim() ? cfg.mailDirName.trim() : DEFAULTS.mailDirName,
    allowCrossWorkspace: cfg.allowCrossWorkspace === true,
    backpressureReleaseMs: num(cfg.backpressureReleaseMs, DEFAULTS.backpressureReleaseMs, 0),
    courierIntervalMs: num(cfg.courierIntervalMs, DEFAULTS.courierIntervalMs, 0),
    busyHoldMs: num(cfg.busyHoldMs, DEFAULTS.busyHoldMs, 1000),
    staleAfterMs: num(cfg.staleAfterMs, DEFAULTS.staleAfterMs, 60000),
    digestGapMs: num(cfg.digestGapMs, DEFAULTS.digestGapMs, 0)
  }
}

/** Windows 路径不区分大小写；整串 casefold 后再比，别只比盘符（verifier 建议修 4）。 */
function normalizePathBase(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let p = value.replace(/\//g, sep)
  if (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function samePath(a, b) {
  const left = normalizePathBase(a)
  const right = normalizePathBase(b)
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
  // 访问检查依赖 connection.requestRejection：缺失时所有 /session-bridge 路由都不设防，
  // 这不是致命错误但要让人看见。
  try {
    const conn = ctx.get ? ctx.get('connection') : undefined
    if (!conn || typeof conn.requestRejection !== 'function') {
      log('WARNING: connection.requestRejection unavailable — HTTP routes will NOT check DSH access. Upgrade the host or keep the queue root on a trusted path only.')
    }
  } catch {}

  /** 只有 dispatcher 实例拥有队列轮询、HTTP 路由与会话事件钩子。 */
  const dispatcher = cfg.dispatcher !== false

  /** 危险动作的确认短语：必须原样发送才执行，避免一个 JSON 就把目录删掉。 */
  const CONFIRM_DELETE_PHRASE = '确认删除'

  /**
   * 人类授权：`allowAgentCreateSession` 关着时，**agent 自己**不能新建会话，
   * 但**人类明确要求**时必须能建。
   *
   * 怎么区分「谁发起」：插件读不到 agent 的内心，只能看证据。
   *   - 人类在**自己发的消息**里说出建会话意图 → 种子逻辑记一条授权（humanPermits）
   *   - 之后 agent 调 init_workspace / handoff 时，若本轮存在人类授权就放行
   *   - 授权按 sessionId 记账，10 分钟过期，用一次即消耗
   *
   * 这不是密码学意义上的鉴权，但它把「agent 自作主张」与「人类让我建」分开了：
   * agent 无法凭空造出人类消息。
   */
  /**
   * `/new-workspace` 的短窗口幂等表：key = project|cwd → { at, sessionId }。
   *
   * 为什么要它：这条命令**每次都会 controller.create 一个新会话**。
   * 人类手抖连发两次、或网络重试，就会多出一个空会话 + 两份自动注册名。
   * 10 秒内同一 project+cwd 直接返回上次结果，不重复建。
   */
  const createWorkspaceRecent = new Map()
  const CREATE_WORKSPACE_DEDUP_MS = 10 * 1000

  const humanPermits = new Map()
  const HUMAN_PERMIT_TTL_MS = 10 * 60 * 1000

  /** 人类亲口要求建会话 → 记一次授权。 */
  function grantHumanPermit(sessionId, note) {
    if (!sessionId) return
    humanPermits.set(sessionId, { at: Date.now(), note: note || '' })
  }

  /**
   * 直接从会话历史里找「人类本轮是否说过要建工作区」。
   *
   * 为什么不能只靠种子：种子在 `agent/pre-step` 的**下一轮**才跑，
   * 而人类说「帮我建个工作区」之后，agent 往往在**同一轮**就调工具了。
   * 那时授权表还是空的 → 门控把人类自己的要求也拦掉（实测踩到）。
   * 所以护栏再加一条：现读人类最近几条消息，命中意图就当场发授权。
   */
  // 已经放行过的「人类消息 seq」：同一条人类消息只放一次，
  // 否则只要最后一句人类发言提到「建工作区」，agent 就能无限次建会话。
  const permitUsedSeq = new Map()
  // 宿主 `sessionController.events` 一页最多 maxMessages 条，且省略 throughSeq 时只取日志末尾。
  // 之前只读一页、把返回里的 hasMore 丢掉：会话超过 500 条事件之后，
  // 「帮我建个工作区」那句被挤出窗口 → 人类自己的请求反而被门控拦掉（实测 → false）。
  // 现在按 throughSeq 向前翻，页数有上限，长会话不会每轮把整个日志读一遍。
  const PERMIT_PAGE_SIZE = 500
  const PERMIT_MAX_PAGES = 6

  /**
   * 从一页记录里找「人类说过要建工作区」。
   *
   * 返回值：`{ verdict: 'ready', key }` 找到一条还没放过的意图；
   *         `{ verdict: 'consumed' }` 这页只有已放过的；
   *         `{ verdict: 'none' }` 这页没有意图。
   *
   * ⚠️ 这里**不写** permitUsedSeq：一次性要消耗「授权」，不该消耗「搜索」。
   * 之前一命中就立刻记账，于是门控通过之后的任何业务失败（缺预设、路径不合法）
   * 都把人类这一次要求白烧掉 —— 人补一句「用 cordis」再试，永久拒绝且无解释。
   * 现在把 key 交回调用方，业务真成了才由 markPermitConsumed 落实。
   */
  function permitScanPage(records, sessionId) {
    // 这一页里是否至少见过一条「已经放过」的意图消息。
    // 见过不代表要立刻放弃——同页更早的位置可能还有一条没放过的。
    let sawConsumed = false
    // 从新往旧扫，只看人类亲手发的话。
    // 注意记录形状是 { event: { type, data, seq } }，不是 { message }——
    // 之前按 record.message 取，永远拿不到消息，授权判定直接失效。
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i]
      const event = record && record.event
      if (!event) continue
      // 只认「用户消息」事件
      const message = messageOf(event)
      if (!message || message.role !== 'user') continue
      if (message.source && message.source.kind && message.source.kind !== 'user') continue
      const text = (message.content || [])
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (!text) continue

      // 命中「建工作区」类意图才算
      let hit = false
      for (const pattern of SEED_PATTERNS) {
        if (pattern.id !== 'init-workspace') continue
        if (pattern.test.test(text)) hit = true
      }
      // 没命中就继续往前翻，而不是直接放弃。
      // 之前这里 return false：只看**最新一条**人类消息，窗口形同虚设。
      // 最常见的真实路径恰恰是「先问建工作区 → agent 追问 → 人再补一句目录」，
      // 那条补充消息不含意图词，于是一次授权也发不出来。
      if (!hit) continue

      // 同一条人类消息只放行一次。用事件 seq 做键。
      // 注意：记录形状是 { event: { seq, type, data } }，record.seq 永不存在，
      // 之前那个分支是死代码，键一直退化成「文本前 60 字」。
      const eventSeq = event && event.seq !== undefined ? event.seq : record && record.seq
      const key =
        sessionId +
        '#' +
        (eventSeq !== undefined
          ? String(eventSeq)
          : String(message.id || text.slice(0, 60)))
      // 已放过 or 已被另一条并发请求预留 → 都算这一条不可用，继续往更早处扫。
      if (permitUsedSeq.get(key) || permitReserved.has(key)) {
        // 这条已经放过（或正被另一条请求占用）：记下来，但**继续往这一页的更早处扫**。
        // 之前这里直接 return，导致同一页里新消息遮蔽旧消息：
        // 人先说过一次（已用掉），后又说一次；两次调用都从新往旧扫，
        // 第一次命中的新消息被消耗后，第二次就卡在那条已消费的新消息上，
        // 永远走不到更早那条还没用过的意图。
        log('permit already consumed for this human message:', key)
        sawConsumed = true
        continue
      }
      // 占位：permitScanPage 到 markPermitConsumed 之间隔着 await（controller.create），
      // 而 drain() 并发跑。不占位的话两条 init_workspace 会同时扫到同一条消息、
      // 同时通过门控，一句人类消息就建出两个会话（场景 10 实测复现）。
      permitReserved.set(key, Date.now())
      log('permit candidate reserved from recent human messages')
      return { verdict: 'ready', key }
    }
    return { verdict: sawConsumed ? 'consumed' : 'none' }
  }

  /** 业务真成功之后才记账：这条人类消息的授权用掉了。 */
  function markPermitConsumed(key) {
    if (!key) return
    permitReserved.delete(key)
    permitUsedSeq.set(key, Date.now())
    // 顺手清掉 30 分钟前的记账，别无限增长
    for (const [k, at] of permitUsedSeq) {
      if (Date.now() - Number(at || 0) > 30 * 60 * 1000) permitUsedSeq.delete(k)
    }
  }

  async function permitFromRecentHumanMessages(sessionId) {
    if (!sessionId) return { granted: false }
    try {
      const controller = service('sessionController')
      if (!controller || typeof controller.events !== 'function') return { granted: false }
      // throughSeq 未设 = 从日志末尾取第一页；之后每页用它「上一页最小 seq - 1」往前翻。
      let throughSeq
      const seenCuts = new Set()
      for (let page = 0; page < PERMIT_MAX_PAGES; page += 1) {
        const request = { address: { kind: 'session', sessionId }, maxMessages: PERMIT_PAGE_SIZE }
        if (throughSeq !== undefined) request.throughSeq = throughSeq
        const result = await controller.events(request, abort())
        const records = (result && (result.records || result.messages)) || []
        if (records.length === 0) break

        const scanned = permitScanPage(records, sessionId)
        if (scanned.verdict === 'ready') return { granted: true, key: scanned.key }
        // 'consumed' 不直接放弃：这页只有已放过的消息时继续往前翻，
        // 让更早的、还没用过的意图有机会放行（否则旧记录会把新记录遮蔽）。
        if (scanned.verdict === 'consumed') {
          log('permit: this page only had consumed human messages, paging further back')
        }

        // 宿主没给 hasMore 时也不要硬翻：靠「最小 seq - 1」推进，无进展就停。
        const minSeq = records.reduce((acc, record) => {
          const seq = record && record.event && record.event.seq
          return typeof seq === 'number' && (acc === undefined || seq < acc) ? seq : acc
        }, undefined)
        if (minSeq === undefined || seenCuts.has(minSeq)) break
        seenCuts.add(minSeq)
        throughSeq = minSeq - 1
        if (result && result.hasMore === false) break
      }
    } catch (error) {
      log('permitFromRecentHumanMessages failed: ', (error && error.message) || String(error))
    }
    return { granted: false }
  }

  /**
   * 只查有没有可用授权，**不消耗**。
   *
   * 为什么要拆出 peek：门控通过之后还有一堆会失败的地方（缺预设、路径不合法、
   * 宿主服务不在）。原来的写法是门控一通过就 takeHumanPermit 把授权取走，
   * 然后那一步失败 —— 授权白白烧掉。人类补一句「用 cordis 预设」再让 agent 重试，
   * humanPermits 已空，permitFromRecentHumanMessages 又命中那条已被消费的消息，
   * 于是永久拒绝，而且不给任何解释。
   * 现在：门控用 peek 判，业务真成功了才 consume。
   */
  // 已「预留」但还没落实的授权：sessionId → 预留时刻。
  // peek 之后到 take 之间有一段 await（controller.create），
  // 而 drain() 是并发跑的（maxConcurrent 默认 4）。没有这张表的话，
  // 两条 init_workspace 会同时 peek 到同一份授权、同时通过门控 →
  // 一句人类消息建出两个会话（复审实测复现：旧代码 1 次，peek 版 2 次）。
  const permitReserved = new Map()

  /**
   * 预留一份授权：只查不消耗，但会占位，防止并发的第二次调用也通过。
   * 返回 true 表示「这次调用拿到了这份授权」，调用方**必须**在成功时
   * commitHumanPermit，在失败时 releaseHumanPermit，否则这份授权会一直占着。
   */
  function peekHumanPermit(sessionId) {
    if (!sessionId) return false
    const entry = humanPermits.get(sessionId)
    if (!entry) return false
    if (Date.now() - Number(entry.at || 0) > HUMAN_PERMIT_TTL_MS) {
      humanPermits.delete(sessionId)
      return false
    }
    // 别人已经预留了 → 这次不算拿到
    if (permitReserved.has(sessionId)) return false
    permitReserved.set(sessionId, Date.now())
    return true
  }

  /** 业务成功：把预留转成真正消耗。 */
  function commitHumanPermit(sessionId) {
    if (!sessionId) return
    permitReserved.delete(sessionId)
    humanPermits.delete(sessionId)
  }

  /** 业务失败：退回预留，让人类可以立刻重试。 */
  function releaseHumanPermit(sessionId) {
    if (!sessionId) return
    permitReserved.delete(sessionId)
  }

  /** 业务失败：把 events 扫描占的那条人类消息也还回去。 */
  function releasePermitKey(key) {
    if (!key) return
    permitReserved.delete(key)
  }

  /** 取用一次授权（用后即消耗，过期的清掉）。 */
  function takeHumanPermit(sessionId) {
    // 预留表同样按 TTL 清理：异常路径下没走到 commit/release 的预留会卡住后续授权
    for (const [key, at] of permitReserved) {
      if (Date.now() - Number(at || 0) > HUMAN_PERMIT_TTL_MS) permitReserved.delete(key)
    }
    const entry = sessionId ? humanPermits.get(sessionId) : undefined
    for (const [key, value] of humanPermits) {
      if (Date.now() - Number(value.at || 0) > HUMAN_PERMIT_TTL_MS) humanPermits.delete(key)
    }
    if (!entry) return false
    if (Date.now() - Number(entry.at || 0) > HUMAN_PERMIT_TTL_MS) {
      humanPermits.delete(sessionId)
      return false
    }
    humanPermits.delete(sessionId)
    return true
  }

  /** 待确认的目录删除：token → { workspaceId, path, createdAt }，10 分钟过期。 */
  const pendingDeletes = new Map()
  const PENDING_DELETE_TTL_MS = 10 * 60 * 1000

  /** 路径分隔符（正则以字符串拼装，避免转义歧义）。 */
  const PATH_SEP_RE = /[\\/]+/

  /**
   * 受保护目录：**全部从环境自动获取，不硬编码盘符路径**。
   * 别人的机器上系统盘可能不是 C:，硬编码 `c:/windows` 等于没有防御。
   * 另可在配置 `guardedPaths` 里补（数组，绝对路径）。
   *
   * 分两类：
   *  - tree：自身及所有子目录都不许建/删（系统目录、程序目录、应用安装目录）
   *  - exact：只不许删它本身，子目录允许（DSH_HOME、用户主目录——真实工作区就在里面）
   */
  function detectProtectedDirs() {
    const tree = new Set()
    const exact = new Set()
    const add = (set, value) => {
      const raw = typeof value === 'string' ? value.trim() : ''
      if (!raw) return
      // 环境变量可能带尾斜杠、正斜杠或大小写差异：统一 resolve 后再收，
      // 否则 `D:\dshdata` 与 `D:/dshdata/` 会被当成两个不同目录而漏保护。
      try {
        set.add(resolve(raw))
      } catch {
        set.add(raw)
      }
    }
    // Windows 系统目录：windir 通常就是 C:\Windows
    add(tree, process.env.SystemRoot)
    add(tree, process.env.windir)
    add(tree, process.env.ProgramFiles)
    add(tree, process.env['ProgramFiles(x86)'])
    add(tree, process.env.ProgramW6432)
    add(tree, process.env.ProgramData)
    add(tree, process.env.ALLUSERSPROFILE)
    // 应用安装目录：每次调用现算。DSH 升级会清空并重建这个目录，
    // 硬编码盘符等于失效，所以这里只认「进程自己在哪」。
    //   Electron 主进程：execPath = <安装根>\DeepSeek Harness.exe  → 退一层就是安装根
    //   resources 路径：安装根下的 resources，退一层同样是安装根
    try {
      if (process.execPath) add(tree, resolve(process.execPath, '..'))
    } catch {}
    try {
      if (process.resourcesPath) add(tree, resolve(process.resourcesPath, '..'))
    } catch {}
    try {
      if (process.argv[1]) add(tree, resolve(process.argv[1], '..'))
    } catch {}
    // 这两个只保护自身：真实工作区常常就在它们下面
    add(exact, process.env.DSH_HOME)
    // 用户主目录：Windows 用 USERPROFILE，POSIX 用 HOME；再兜一层 os.homedir()。
    add(exact, process.env.USERPROFILE)
    add(exact, process.env.HOME)
    try {
      add(exact, homedir())
    } catch {}
    // 用户自定义
    for (const item of Array.isArray(cfg.guardedPaths) ? cfg.guardedPaths : []) add(tree, item)
    return { tree: [...tree], exact: [...exact] }
  }

  /** 路径归一：小写 + 正斜杠 + 去尾部斜杠。 */
  const IS_WINDOWS = process.platform === 'win32'

  /**
   * 路径归一，**统一输出正斜杠**：
   * 模块级的 normalizePathBase 输出的是平台原生分隔符（Windows 上是反斜杠），
   * 直接拿它去 split('/') 会切不开，导致所有路径都被判成"只有一段"。
   * 大小写策略仍跟随平台：Windows 不区分，POSIX 保留。
   */
  function normalizePath(value) {
    const base = normalizePathBase(value)
    if (!base) return ''
    return base.split(String.fromCharCode(92)).join('/')
  }

  /** target 是否就是 base，或在 base 之下。 */
  function isUnder(target, base) {
    const t = normalizePath(target)
    const b = normalizePath(base)
    if (!t || !b) return false
    return t === b || t.startsWith(b + '/')
  }

  /** 返回命中的受保护目录，没命中返回 null。 */
  /**
   * 命中受保护目录就返回它，否则 null。
   *
   * - tree 类（系统目录/程序目录/应用安装目录/用户自定义）：自身与所有子目录都拦。
   *   应用安装目录尤其重要——DSH 升级会清空并重建它。
   * - exact 类（DSH_HOME、用户主目录）：**只拦自身**。
   *   真实项目经常就在 `C:\Users\<me>\项目` 或 `$DSH_HOME\本地` 下面，
   *   按子树拦会把正常项目一起毙掉（实测误杀）。
   */
  function hitProtected(target) {
    const dirs = detectProtectedDirs()
    // guardSystemDrive=false 时放行 tree 类（系统盘/安装目录）——
    // 给「只在 C 盘工作」的用户留一道闸，但 DSH_HOME 与主目录自身仍然保护。
    if (cfg.guardSystemDrive !== false) {
      for (const base of dirs.tree) if (isUnder(target, base)) return base
    }
    const normTarget = normalizePath(target)
    for (const base of dirs.exact) if (normTarget === normalizePath(base)) return base
    return null
  }

  /**
   * 递归删除的安全闸：拒绝盘符根 / 层级过浅 / 受保护目录（含应用安装目录）。
   * 真正的二次确认在 delete_workspace 动作里（confirm / confirmToken）。
   */
  function guardRemovablePath(target) {
    const raw = String(target || '').trim()
    if (!raw) return { ok: false, code: 'BAD_PATH', message: '工作区没有目录路径' }
    const abs = resolve(raw)
    const parts = abs.split(PATH_SEP_RE).filter(Boolean)
    if (parts.length <= 1) return { ok: false, code: 'REFUSE_ROOT', message: '拒绝删除盘符根或层级过浅的目录: ' + abs }
    const hit = hitProtected(abs)
    if (hit) return { ok: false, code: 'REFUSE_PROTECTED', message: '拒绝删除受保护目录（' + hit + '）: ' + abs }
    return { ok: true, path: abs }
  }

  /**
   * 建目录用的闸：拒绝盘符根与受保护目录（系统目录、程序目录、应用安装目录）。
   * 不限定盘符——真实项目散落在 E:/F:/D 各盘，白名单会把正常项目直接毙掉。
   */
  function guardCreatablePath(target) {
    const abs = resolve(String(target || ''))
    const parts = normalizePath(abs).split('/').filter(Boolean)
    if (parts.length <= 1) return { ok: false, message: '拒绝把盘符根登记成工作区: ' + abs }
    const hit = hitProtected(abs)
    if (hit) return { ok: false, message: '拒绝在受保护目录下建工作区（' + hit + '）: ' + abs }
    return { ok: true, path: abs }
  }

  /** 工作区里还有多少会话（确认提示里说明「会话会变未分组、不会被删」）。 */
  async function countWorkspaceSessions(registry, workspaceId) {
    try {
      const list = typeof registry.list === 'function' ? registry.list() : []
      const hit = list.find((row) => row && row.id === workspaceId)
      if (hit && Number.isFinite(hit.sessionCount)) return hit.sessionCount
      if (hit && Array.isArray(hit.sessions)) return hit.sessions.length
    } catch {}
    return 0
  }

  /** 目录删除留痕：写到队列根的 deleted-workspaces.jsonl，事后可查谁删了什么。 */
  function appendDeleteAudit(entry) {
    try {
      const file = join(root, 'deleted-workspaces.jsonl')
      appendFile(file, JSON.stringify(entry) + '\n').catch(() => {})
    } catch {}
  }

  // 工具面实例（dispatcher:false）只注册工具，工具调用走文件队列交给根实例；
  // 它不持有 mailbox，因此不会读写 _letters.json，也就不会用局部视图覆盖全量状态。
  const mailbox = dispatcher ? createMailbox({
    ackTimeoutMs: cfg.ackTimeoutMs,
    // 这两个以前声明了却没传下去：groupAutoThreshold 恒为 3，taskChannelIdleMs 恒为 600000。
    groupAutoThreshold: cfg.groupAutoThreshold,
    taskChannelIdleMs: cfg.taskChannelIdleMs,
    // 信箱目录名可配：默认 .dsh-mail，换名后旧目录不再被读取（迁移需方手动搬）。
    mailDirName: cfg.mailDirName,
    service: (key) => (ctx.get ? ctx.get(key) : ctx[key]),
    log,
    // v6：一切按工作区走 —— 每封信先解析两侧会话的 cwd，再落到各自 .dsh-mail/
    cwdOf: (sessionId) => (sessionId ? sessionCwdOf(sessionId) : Promise.resolve(undefined)),
    isArchived: async (sessionId) => (await archivedSessionIds()).has(sessionId),
    backpressureReleaseMs: cfg.backpressureReleaseMs,
    courier: {
      intervalMs: cfg.courierIntervalMs,
      busyHoldMs: cfg.busyHoldMs,
      staleAfterMs: cfg.staleAfterMs,
      digestGapMs: cfg.digestGapMs,
    },
    cwds: async () => {
      const table = await loadFriends()
      return [...new Set(Object.values(table || {}).map((row) => row && row.cwd).filter(Boolean))]
    },
  }) : null

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

  /**
   * DSH 的访问检查：webServer.register 注册的路由不会自动走 connection.requestRejection，
   * 浏览器里任意网页都能打到 127.0.0.1 的这些路径。每个 handler 最前面都必须过这一道。
   * 返回 401/403 并结束响应；放行时返回 undefined。
   */
  function rejectHttp(req, res) {
    const connection = service('connection')
    const rejection = connection && typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : undefined
    if (rejection === undefined) return undefined
    res.statusCode = rejection
    res.end()
    return rejection
  }

  /** resource 路由版本：Fetch Request 的 headers 也满足 ConnectionTrustRequest。 */
  function rejectResource(request) {
    const connection = service('connection')
    const rejection = connection && typeof connection.requestRejection === 'function' ? connection.requestRejection(request) : undefined
    return rejection === undefined ? undefined : new Response(null, { status: rejection })
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
  /**
   * 候选会话：给 /register-peer 与会话列表用。
   *
   * **受 allowCrossWorkspace 管**——这和投递时的跨区判据保持一致：
   *   · 关着（默认）→ 只列本工作区（含嵌套目录）的会话
   *   · 开着        → 列所有工作区的会话
   * 归档会话两种情况下都不出现。
   */
  async function candidateSessions(callerCwd) {
    const all = await storedSessions().catch(() => [])
    if (cfg.allowCrossWorkspace === true || !callerCwd) return all
    return all.filter((row) => {
      const relation = workspaceRelation(callerCwd, row.cwd)
      // unknown = 任一侧 cwd 拿不到，判不了就放行，不误杀。
      return relation === 'same' || relation === 'nested' || relation === 'unknown'
    })
  }

  /**
   * 本插件视角的会话清单。
   *
   * **已归档的会话不出现**——这是插件自己的卫生规则，不改 DSH 原生行为：
   * DSH 自己的会话列表该列全部就列全部，我们只在插件功能的探查、注册、
   * 候选列表里排除归档会话。否则半年前归档的会话还会被注册成好友、还会出现在
   * /register-peer 的候选里。
   */
  async function storedSessions() {
    const persistence = service('sessionPersistence')
    if (!persistence) return []
    const snapshots = await persistence.list({ signal: abort() })
    let archived = new Set()
    try {
      archived = await archivedSessionIds()
    } catch {
      archived = new Set()
    }
    return snapshots
      .filter((snapshot) => {
        const id = snapshot && snapshot.header && snapshot.header.id
        return Boolean(id) && !archived.has(id)
      })
      .map((snapshot) => ({
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

  /**
   * 统一通知通道：一律走 sessionController.prompt。
   * 不再创建宿主「自动化任务」——那会在目标会话留下 [SCHEDULE CHANGE] 注入，
   * 还会往自动化任务列表里堆卡；prompt 直接进收件箱，语义也更接近「一条来信」。
   */
  async function deliverNotice(sessionId, text, _title) {
    await deliver(sessionId, text, 'queue')
    return { via: 'prompt' }
  }

  /**
   * 只做历史迁移：把旧版本用「自动化任务」投递留下的 信箱* 任务删掉，
   * 新版本一条都不再创建。只删 status=ended 的，还在倒计时的让它自己到期。
   */
  let lastScheduleCleanup = 0
  async function cleanupSchedules() {
    const schedule = service('schedule')
    if (!schedule || typeof schedule.list !== 'function' || typeof schedule.edit !== 'function') return
    if (Date.now() - lastScheduleCleanup < 10 * 60 * 1000) return
    lastScheduleCleanup = Date.now()
    try {
      // 先分页收集，再统一删：边删边翻页会因为 offset 位移漏掉条目
      const ended = []
      let offset = 0
      for (let page = 0; page < 10; page += 1) {
        const result = await schedule.list({ limit: 100, offset })
        const items = (result && result.items) || []
        for (const item of items) {
          if (!item || item.status !== 'ended') continue
          if (!String(item.title || '').startsWith('信箱')) continue
          ended.push(item.id)
        }
        offset += items.length
        const total = Number(result && result.total) || 0
        if (items.length === 0 || offset >= total) break
      }
      const removed = []
      for (const id of ended) {
        try {
          await schedule.edit({ id, action: 'delete' })
          removed.push(id)
        } catch (error) {
          log('schedule cleanup item failed', error && error.message)
        }
      }
      if (removed.length > 0) log('schedule cleanup: removed', removed.length, 'legacy mailbox tasks')
    } catch (error) {
      log('schedule cleanup failed', error && error.message)
    }
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
    // 本次请求预留过授权的会话：成功路径会主动 commit/释放，
    // 异常路径靠 catch 里的 release 兜底——否则预留表会一直占着，
    // 人类后续再要求建会话会被自己的上一次失败挡住。
    let reservedSession
    // events 扫描路径预留的那条人类消息 key（与 reservedSession 同理，catch 里兜底归还）
    let reservedPermitKey
    const limit = Number.isFinite(request.maxReplyChars) ? request.maxReplyChars : cfg.maxReplyChars
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : cfg.replyTimeoutMs
    const result = { id, ok: false, startedAt, root }

    try {
      const action = request.action === undefined ? 'deliver' : request.action
      const ACTIONS = ['deliver', 'sessions', 'events', 'init_workspace', 'handoff', 'notify', 'relay', 'list_children', 'jump', 'delete_workspace', 'mail_send', 'mail_ack', 'mail_list', 'mail_status', 'mail_pause', 'mail_inbox', 'mail_friends', 'mail_group', 'peer_state', 'commands', 'sweep_friends', 'prefs_get', 'prefs_set', 'probe_workspace_stream']
      if (!ACTIONS.includes(action)) {
        throw new Error('unknown action: ' + String(action) + '（支持 ' + ACTIONS.join(' / ') + '）')
      }

      // ===== 信箱：五件套 + 在途账本 =====
      if (action === 'mail_send' || action === 'mail_ack' || action === 'mail_list' || action === 'mail_status' || action === 'mail_pause' || action === 'mail_inbox') {
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
        if (action === 'mail_send' && request.peerSessionId) {
          // 目标已归档：早失败，别让一封信拖到超时才进待办
          try {
            if ((await archivedSessionIds()).has(request.peerSessionId)) {
              Object.assign(result, { ok: false, error: { message: 'target session is archived: ' + request.peerSessionId, code: 'TARGET_ARCHIVED' } })
              result.finishedAt = Date.now()
              result.elapsedMs = result.finishedAt - startedAt
              await finish(result, workingPath, id, request)
              return
            }
          } catch {}
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
        if (action === 'mail_pause' && !request.cwd && request.senderSessionId) request.cwd = await sessionCwdOf(request.senderSessionId)
        const value =
          action === 'mail_send'
            ? await mailbox.send(request)
            : action === 'mail_ack'
              ? await mailbox.ack(request)
              : action === 'mail_status'
                ? await mailbox.status(request)
                : action === 'mail_pause'
                  ? await mailbox.pause(request)
                  : action === 'mail_inbox'
                    ? await mailbox.inbox(request)
                    : await mailbox.list(request)
        Object.assign(result, value)
        result.mailBox = (value && (value.box || (value.cwd ? workspaceBox(value.cwd).dir : null))) || null
        result.ok = value.ok !== false
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 只读好友表：只暴露注册名与 sessionId，不给 cwd/工作区等内部信息 =====
      if (action === 'mail_friends') {
        const table = await loadFriends()
        const friends = Object.entries(table)
          .filter(([, row]) => row && row.sessionId)
          .map(([name, row]) => ({ name, sessionId: row.sessionId }))
          .sort((a, b) => a.name.localeCompare(b.name))
        Object.assign(result, { ok: true, count: friends.length, friends })
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 只读探针：某个会话现在忙不忙（发信前判断用）=====
      // ===== 插件偏好记忆：agent 自己记「人怎么说、我怎么做」 =====
      if (action === 'prefs_get') {
        try {
          const prefs = await loadPrefs()
          Object.assign(result, { ok: true, ...prefs, file: PREFS_FILE() })
        } catch (error) {
          Object.assign(result, { ok: false, error: { message: (error && error.message) || String(error), code: 'PREFS_READ_FAILED' } })
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }
      if (action === 'prefs_set') {
        try {
          const phrasing = String(request.phrasing || '').trim()
          const means = String(request.means || '').trim()
          if (!phrasing) throw new Error('prefs_set requires phrasing')
          const prefs = await loadPrefs()
          // 同义说法覆盖，不堆重复条目
          const rest = prefs.triggers.filter((t) => t.phrasing !== phrasing)
          rest.push({ phrasing, means, created: new Date().toISOString() })
          const saved = await savePrefs({ triggers: rest })
          Object.assign(result, { ok: true, count: saved.triggers.length, file: PREFS_FILE() })
        } catch (error) {
          Object.assign(result, { ok: false, error: { message: (error && error.message) || String(error), code: 'PREFS_WRITE_FAILED' } })
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 清洗好友表：归档会话的名字立刻注销 =====
      if (action === 'sweep_friends') {
        try {
          const swept = await sweepFriends(true)
          Object.assign(result, { ok: true, ...swept })
        } catch (error) {
          Object.assign(result, { ok: false, error: { message: (error && error.message) || String(error), code: 'SWEEP_FAILED' } })
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 只读：当前会话可用的斜杠命令（排查「/ 下面到底有什么」）=====
      if (action === 'commands') {
        const commands = service('commands')
        if (!commands || typeof commands.list !== 'function') {
          Object.assign(result, { ok: false, error: { message: 'commands service unavailable', code: 'NO_COMMANDS_SERVICE' } })
          await finish(result, workingPath, id, request)
          return
        }
        const sessionId = String(request.sessionId || '').trim()
        if (!sessionId) {
          Object.assign(result, { ok: false, error: { message: 'commands needs sessionId', code: 'BAD_TARGET' } })
          await finish(result, workingPath, id, request)
          return
        }
        try {
          const list = await commands.list({ id: sessionId })
          Object.assign(result, { ok: true, sessionId, count: list.length, commands: list })
        } catch (error) {
          Object.assign(result, { ok: false, error: { message: (error && error.message) || String(error), code: 'COMMANDS_FAILED' } })
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      if (action === 'peer_state') {
        let target = String(request.sessionId || '').trim() || undefined
        if (!target && request.name) {
          const callerCwd = request.cwd || (request.senderSessionId ? await sessionCwdOf(request.senderSessionId) : undefined)
          const resolved = await resolveFriend(request.name, callerCwd)
          if (!resolved.ok) {
            Object.assign(result, { ok: false, error: { message: resolved.message, code: resolved.code } })
            await finish(result, workingPath, id, request)
            return
          }
          target = resolved.friend.sessionId
        }
        if (!target) {
          Object.assign(result, { ok: false, error: { message: 'peer_state needs sessionId or a registered name', code: 'BAD_TARGET' } })
          await finish(result, workingPath, id, request)
          return
        }
        const state = await peerStateOf(target)
        Object.assign(result, { ok: true, sessionId: target, state, busy: state === 'running' })
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 信箱群：显式建群 / 列群（自然语言与命令两种触发都落到这里）=====
      if (action === 'mail_group') {
        const op = String(request.do || request.op || 'list')
        let value
        if (op === 'candidates') {
          const callerCwd = request.cwd || (request.sessionId ? await sessionCwdOf(request.sessionId) : undefined)
          const sessions = await workspaceSessionsFor(callerCwd)
          value = {
            ok: true,
            cwd: callerCwd,
            count: sessions.length,
            candidates: sessions.map((item) => ({ label: item.label, registered: item.registered, sessionId: item.sessionId })),
            hint: '用 ask_user_question 多选这些 label（加一个「不建群」取消项），再按选中项调 mail_group do=create members=名字一,名字二',
          }
        } else if (op === 'create') {
          const rawNames = Array.isArray(request.members) && request.members.length > 0 ? request.members : [request.memberA, request.memberB]
          const names = rawNames.map((item) => String(item || '').trim()).filter(Boolean)
          const callerCwd = request.cwd || (request.sessionId ? await sessionCwdOf(request.sessionId) : undefined)
          if (names.length < 2) {
            value = { ok: false, error: { message: 'need at least two members (names or session ids)', code: 'BAD_MEMBERS' } }
          } else {
            const { resolved, unknown, cross } = await resolveMemberNames(names, callerCwd, request.auto !== false)
            if (unknown.length > 0 || cross.length > 0) {
              const sessions = await workspaceSessionsFor(callerCwd)
              value = {
                ok: false,
                error: { message: 'unresolved members: ' + [...unknown, ...cross].join('、'), code: 'UNRESOLVED' },
                candidates: sessions.map((item) => ({ label: item.label, registered: item.registered, sessionId: item.sessionId })),
              }
            } else {
              value = await mailbox.groupCreate({ members: resolved.map((item) => item.sessionId), cwd: callerCwd })
              value.resolved = resolved
            }
          }
        } else {
          value = await mailbox.groupList(request)
        }
        Object.assign(result, value)
        result.mailBox = (value && (value.box || (value.cwd ? workspaceBox(value.cwd).dir : null))) || null
        result.ok = value.ok !== false
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 会话编排：建目录 + 建工作区 + 建初始会话 =====
      if (action === 'init_workspace') {
        // 安全门控：默认不允许 agent 通过本插件拉起新会话。
        // 调度师拿「新建会话」当子代理用会绕开 DSH 原生会话逻辑，所以默认关闭。
        // 人类明确要求时放行；agent 自作主张时拒绝。
        const callerSession = String(request.creatorSessionId || request.sessionId || '')
        // 预留而非消耗：peek 之后到 create 之间还有一堆会失败的地方，
        // 提前消耗会把人类的这次要求白烧掉；但只 peek 不占位又会让并发的
        // 第二次调用同时通过（会一句建出两个会话）。所以占位 + finally 归还。
        const permitWasPeeked = cfg.allowAgentCreateSession !== true && peekHumanPermit(callerSession)
        if (permitWasPeeked) reservedSession = callerSession
        let permitCommitted = false
        // 记录「这次是靠哪条人类消息放行的」，业务成功之后才落实消耗。
        let permitFromHistoryKey
        if (cfg.allowAgentCreateSession !== true && !permitWasPeeked) {
          const scanned = await permitFromRecentHumanMessages(callerSession)
          permitFromHistoryKey = scanned.granted ? scanned.key : undefined
          if (permitFromHistoryKey) reservedPermitKey = permitFromHistoryKey
        }
        if (cfg.allowAgentCreateSession !== true && !permitWasPeeked && !permitFromHistoryKey) {
          const error = new Error(
            'agent-created sessions are disabled in settings (allowAgentCreateSession). ' +
              'Only an explicit human request in this conversation may create one; ' +
              'otherwise use a DSH native subagent, or have the human enable it in Settings → 会话编排 → 安全.',
          )
          error.code = 'AGENT_CREATE_DISABLED'
          throw error
        }
        const presetId = String(request.preset || '')
        const target = parseCwd(request)
        if (!target) throw new Error('init_workspace requires an absolute cwd')
        // 建目录只做黑名单拦截：挡住系统目录与盘符根，但不限定盘符——
        // 真实项目在 E: / F: / D:\文档 下都有，白名单会把这些直接毙掉（实测 5/6 被误拦）。
        const createGuard = guardCreatablePath(target)
        if (!createGuard.ok) throw new Error(createGuard.message)
        // 没指定预设时：开了 askPresetOnCreate 就要求先问人，否则交给宿主默认预设。
        if (!presetId && cfg.askPresetOnCreate === true) {
          const error = new Error(
            'preset is required while askPresetOnCreate is on: list presets and ask the human which one to use (Settings → 会话编排 → 高级).',
          )
          error.code = 'PRESET_REQUIRED'
          throw error
        }
        const presets = service('agentPresets')
        if (!presets) throw new Error('agentPresets service unavailable')
        if (presetId) {
          try {
            await presets.resolve(presetId)
          } catch {
            const error = new Error('unknown agent preset: ' + presetId)
            error.code = 'PRESET_NOT_FOUND'
            throw error
          }
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
        // session.create 只接受 workspaceId 或 cwd 其中之一（实测报 gateway/bad-request）。
        // 预设为空时必须整个字段省略：传 '' 会被宿主当成「名叫空串的预设」，
        // 报 unknown agent preset: （后面什么都没有）。
        const presetField = presetId ? { agentPreset: presetId } : {}
        const created = await controller.create(
          workspace && workspace.id
            ? { workspaceId: workspace.id, ...presetField }
            : { cwd: target, ...presetField },
        )
        // 业务真成了才消耗授权：上面任何一步失败（缺预设、路径不合法、宿主服务不在）
        // 都不该烧掉人类的这一次要求。两条来源分别结清。
        if (permitWasPeeked) {
          commitHumanPermit(callerSession)
          permitCommitted = true
          reservedSession = undefined
        }
        if (permitFromHistoryKey) {
          markPermitConsumed(permitFromHistoryKey)
          reservedPermitKey = undefined
        }
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
          // 自动接线：双方注册 + 专用通道（失败不影响建工作区本身）
          result.wire = await wireNewSession(request.creatorSessionId, created.sessionId, target)
        }
        result.finishedAt = Date.now()
        result.elapsedMs = result.finishedAt - startedAt
        await finish(result, workingPath, id, request)
        return
      }

      // ===== 交棒：校验源会话“存在”（不是“活着”）+ 用新预设建下一阶段会话 =====
      if (action === 'handoff') {
        // 同一个门控：handoff 也会拉起新会话，一并受 allowAgentCreateSession 管。
        const handoffCaller = String(request.creatorSessionId || request.sourceSessionId || '')
        const handoffPermitPeeked = cfg.allowAgentCreateSession !== true && peekHumanPermit(handoffCaller)
        if (handoffPermitPeeked) reservedSession = handoffCaller
        let handoffHistoryKey
        if (cfg.allowAgentCreateSession !== true && !handoffPermitPeeked) {
          const scanned = await permitFromRecentHumanMessages(handoffCaller)
          handoffHistoryKey = scanned.granted ? scanned.key : undefined
          if (handoffHistoryKey) reservedPermitKey = handoffHistoryKey
        }
        if (cfg.allowAgentCreateSession !== true && !handoffPermitPeeked && !handoffHistoryKey) {
          const error = new Error(
            'agent-created sessions are disabled in settings (allowAgentCreateSession). ' +
              'Only an explicit human request in this conversation may create one; ' +
              'otherwise use a DSH native subagent, or have the human enable it in Settings → 会话编排 → 安全.',
          )
          error.code = 'AGENT_CREATE_DISABLED'
          throw error
        }
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
        // 业务真成了才消耗授权（与 init_workspace 一致）。
        if (handoffPermitPeeked) {
          commitHumanPermit(handoffCaller)
          reservedSession = undefined
        }
        if (handoffHistoryKey) {
          markPermitConsumed(handoffHistoryKey)
          reservedPermitKey = undefined
        }
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
          // 自动接线：双方注册 + 专用通道（失败不影响交棒本身）
          result.wire = await wireNewSession(request.creatorSessionId, created.sessionId, cwd)
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
        const delivered = await deliverNotice(targetSession, text, '信箱通知 · ' + (request.from || '外部程序'))
        result.ok = true
        result.delivered = true
        result.via = delivered.via
        result.scheduleId = delivered.scheduleId
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
        if (!workspace) throw new Error('unknown workspace: ' + workspaceId)
        // 两段式：removeDir 先登记待删，必须再来一次带 confirm:'确认删除' 的请求才真删。
        // 目录删除不可逆，且队列对同机进程可写，所以这里不接受一次请求就把树删掉。
        const removeDir = request.removeDir === true
        const confirm = String(request.confirm || '').trim()
        const targetPath = typeof workspace.path === 'string' ? workspace.path : ''

        if (removeDir && cfg.requireDeleteConfirm !== false && confirm !== CONFIRM_DELETE_PHRASE) {
          const sessionCount = await countWorkspaceSessions(registry, workspaceId)
          const token = 'del-' + randomUUID().replace(/-/g, '').slice(0, 16)
          pendingDeletes.set(token, {
            workspaceId,
            path: targetPath,
            createdAt: Date.now(),
            requestId: id,
          })
          result.ok = false
          result.needsConfirm = true
          result.confirmToken = token
          result.workspaceId = workspaceId
          result.path = targetPath
          result.sessions = sessionCount
          result.warning =
            '将删除工作区「' + (workspace.title || workspaceId) + '」及其目录，不可恢复；' +
            '其中 ' + sessionCount + ' 个会话会变成未分组、不会被删除。' +
            '确认请在下一行回复「确认删除」，并带上 confirmToken=' + token + ' 与 confirm="' + CONFIRM_DELETE_PHRASE + '" 重发。'
          result.finishedAt = Date.now()
          result.elapsedMs = result.finishedAt - startedAt
          await finish(result, workingPath, id, request)
          return
        }

        // 路径护栏与二次确认是两件事：关掉确认短语也必须过护栏，
        // 否则「关掉确认」就等于把系统目录保护一起关掉。
        if (removeDir) {
          const pathGuard = guardRemovablePath(targetPath)
          if (!pathGuard.ok) {
            result.ok = false
            result.error = { message: pathGuard.message, code: pathGuard.code }
            result.finishedAt = Date.now()
            result.elapsedMs = result.finishedAt - startedAt
            await finish(result, workingPath, id, request)
            return
          }
        }

        if (removeDir && cfg.requireDeleteConfirm === false) {
          // 用户在设置里关掉了二次确认：护栏已过，直接执行
        } else if (removeDir && confirm === CONFIRM_DELETE_PHRASE) {
          const token = String(request.confirmToken || '').trim()
          const pending = token ? pendingDeletes.get(token) : undefined
          const expired = pending && Date.now() - Number(pending.createdAt || 0) > PENDING_DELETE_TTL_MS
          if (expired && token) pendingDeletes.delete(token)
          for (const [key, entry] of pendingDeletes) {
            if (Date.now() - Number(entry.createdAt || 0) > PENDING_DELETE_TTL_MS) pendingDeletes.delete(key)
          }
          if (!pending || expired || pending.workspaceId !== workspaceId) {
            result.ok = false
            result.needsConfirm = true
            result.error = {
              message: '确认令牌无效或已过期：请先发一次不带 confirm 的请求拿到 confirmToken，再在 10 分钟内确认',
              code: 'CONFIRM_REQUIRED',
            }
            result.finishedAt = Date.now()
            result.elapsedMs = result.finishedAt - startedAt
            await finish(result, workingPath, id, request)
            return
          }
          pendingDeletes.delete(token)
        }

        const removed = await registry.delete(workspaceId)
        let dirRemoved = false
        if (removeDir && targetPath) {
          await rm(targetPath, { recursive: true, force: true }).then(() => { dirRemoved = true }).catch(() => {})
          appendDeleteAudit({ at: new Date().toISOString(), workspaceId, path: targetPath, requestId: id })
        }
        result.ok = true
        result.workspaceId = workspaceId
        result.removed = Boolean(removed)
        result.dirRemoved = dirRemoved
        result.path = targetPath
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
        // 探针目录固定落在队列根之下；忽略外部传入的 probeDir，避免 mkdir/rm 打到别处。
        const probeDir = join(root, '_probe_ws_' + randomUUID().slice(0, 8))
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
      // 失败路径：把这次预留的授权还回去，人类可以立刻重试（见 peekHumanPermit 的注释）。
      if (reservedSession) releaseHumanPermit(reservedSession)
      if (reservedPermitKey) releasePermitKey(reservedPermitKey)
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
      void sweepFriends().catch(() => {})
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
  async function submitLocal(request, timeoutMs = cfg.toolTimeoutMs || 60000) {
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
    // 超时必须撤回请求文件：否则工具已经报失败，队列稍后仍会把它执行掉
    // —— 重复建会话、重复发信，而且调用方毫不知情。
    // 只删 inbox（还没被认领的）；如果已经被挪到 working/，说明正在执行，
    // 这时不再干预，改为在返回里说明「可能已执行」。
    let cancelled = false
    try {
      await rm(join(dirs.inbox, id + '.json'), { force: true })
      cancelled = true
    } catch {
      cancelled = false
    }
    let stillWorking = false
    try {
      await stat(join(dirs.working, id + '.json'))
      stillWorking = true
    } catch {
      stillWorking = false
    }
    return {
      ok: false,
      id,
      cancelled,
      error: {
        message:
          'queue timeout (' + timeoutMs + 'ms) — ' +
          (stillWorking
            ? '请求已被认领，可能仍在执行；用 mail_status / sessions 核对真实结果，不要直接重试'
            : cancelled
              ? '请求已撤回，可以安全重试'
              : '请求状态未知，重试前先核对'),
        code: 'QUEUE_TIMEOUT',
      },
    }
  }

  /** 会话好友表：<root>/friends.json，{friendlyName: {sessionId, cwd, updatedAt}}。 */
  const FRIENDS_FILE = () => join(root, 'friends.json')

  /**
   * 插件自己的偏好记忆：人类怎么说、agent 该怎么响应，由 agent 自己记。
   *
   * 放在队列根下，**不写进任何工作区**——它是插件级配置，跟着插件走。
   * 结构：{ triggers: [ { phrasing, means, created } ], updatedAt }
   */
  const PREFS_FILE = () => join(root, 'agent-prefs.json')

  async function loadPrefs() {
    try {
      const raw = JSON.parse(await readFile(PREFS_FILE(), 'utf8'))
      if (raw && typeof raw === 'object') {
        return {
          triggers: Array.isArray(raw.triggers) ? raw.triggers.filter((t) => t && typeof t.phrasing === 'string') : [],
          updatedAt: raw.updatedAt,
        }
      }
    } catch {
      /* 没这个文件就是空的，不是错误 */
    }
    return { triggers: [] }
  }

  async function savePrefs(prefs) {
    const payload = { triggers: Array.isArray(prefs.triggers) ? prefs.triggers.slice(-50) : [], updatedAt: new Date().toISOString() }
    await mkdir(root, { recursive: true })
    const tmp = PREFS_FILE() + '.tmp'
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, PREFS_FILE())
    return payload
  }
  const FRIEND_NAME = /^[\w一-龥-]{1,32}$/

  /**
   * 把用户随手写的名字清洗成合法名字（宽进严出）。
   *
   * 不合法就删字符，不报错：
   *   - 保留 字母 / 数字 / 下划线 / 连字符 / 汉字
   *   - 空白折叠成一个连字符（"决策 会话" → "决策-会话"）
   *   - 其它标点一律删掉
   *   - 超长截到 32
   * 返回 { name, changed, dropped }，changed 表示与输入不同。
   */
  function sanitizeFriendName(raw) {
    const original = String(raw == null ? '' : raw).trim()
    if (!original) return { name: '', changed: false, dropped: [] }
    const dropped = []
    let out = ''
    let lastWasSpace = false
    for (const ch of original) {
      if (/\s/.test(ch)) {
        if (!lastWasSpace && out.length > 0) out += '-'
        lastWasSpace = true
        continue
      }
      lastWasSpace = false
      if (/[\w\u4e00-\u9fa5-]/.test(ch)) out += ch
      else dropped.push(ch)
    }
    out = out.replace(/-+/g, '-').replace(/^-|-$/g, '')
    let truncated = false
    if (out.length > 32) {
      out = out.slice(0, 32)
      truncated = true
    }
    // 全是不合法字符时返回空串，让调用方拒绝，而不是硬塞一个占位名
    return { name: out, changed: out !== original, dropped, truncated }
  }

  /** 工作区归属：同一路径，或一方是另一方的子目录（继承左侧目录分级）。 */
  function workspaceRelation(a, b) {
    const left = normalizePathBase(a)
    const right = normalizePathBase(b)
    if (left === undefined || right === undefined) return 'unknown'
    if (left === right) return 'same'
    const withSep = (value) => (value.endsWith(sep) ? value : value + sep)
    if (withSep(right).startsWith(withSep(left)) || withSep(left).startsWith(withSep(right))) return 'nested'
    return 'other'
  }

  /**
   * 解析收件人：必须先注册好友；跨工作区默认拒绝，只有 allowCrossWorkspace 才放行。
   * cwd 以 sessionPersistence 现查为准：好友表里的 cwd 只是注册时的缓存，
   * 实测出现过反斜杠被吃掉甚至混入 NUL 的条目，信它会算错工作区关系。
   */
  async function resolveFriend(name, callerCwd) {
    const table = await loadFriends()
    const row = table[String(name || '').trim()]
    if (!row || !row.sessionId) return { ok: false, code: 'FRIEND_NOT_FOUND', message: 'unknown friend: ' + String(name || '') }
    // 归档会话在插件视角等于「不存在」：好友名立刻失效，不等后台清扫。
    // 这只是我们自己的卫生规则，DSH 原生会话列表照旧列全部。
    try {
      if ((await archivedSessionIds()).has(row.sessionId)) {
        return {
          ok: false,
          code: 'FRIEND_ARCHIVED',
          message: 'friend "' + String(name || '') + '" belongs to an archived session (' + row.sessionId + '); register a live session instead',
        }
      }
    } catch {
      /* 归档表读不到就按存在处理，不误伤 */
    }
    const liveCwd = await sessionCwdOf(row.sessionId)
    const safeCached = typeof row.cwd === 'string' && row.cwd.indexOf('\u0000') === -1 ? row.cwd : undefined
    const cwd = liveCwd || safeCached
    const relation = workspaceRelation(callerCwd, cwd)
    if (relation === 'other' && cfg.allowCrossWorkspace !== true) {
      return { ok: false, code: 'CROSS_WORKSPACE_DISABLED', message: 'cross-workspace delivery is disabled (allowCrossWorkspace); ' + String(callerCwd || '?') + ' vs ' + String(cwd || '?') }
    }
    return { ok: true, friend: { ...row, cwd, cachedCwd: row.cwd }, relation }
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

  /** agent/status 边 → 好友表：谁在任务中，落盘给别的会话看。 */
  async function noteFriendState(agent, status) {
    if (!agent || !agent.id) return
    const next = status === 'idle' ? 'idle' : status === 'running' || status === 'busy' ? 'running' : null
    if (!next) return
    const table = await loadFriends()
    let changed = false
    for (const row of Object.values(table)) {
      if (!row || row.sessionId !== agent.id) continue
      if (row.state === next) continue
      row.state = next
      row.stateAt = new Date().toISOString()
      changed = true
    }
    if (changed) await saveFriends(table)
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

  /** 会话是否在任务中：好友表靠「事件写入 + 读时刷新」两条腿，谁也不单独可信。 */
  async function peerStateOf(sessionId) {
    if (!sessionId) return 'unknown'
    if ((await archivedSessionIds()).has(sessionId)) return 'archived'
    const controller = service('sessionController')
    if (!controller || typeof controller.state !== 'function') return 'unknown'
    try {
      const state = await controller.state({ sessionId })
      return state && (state.running === true || state.active === true) ? 'running' : 'idle'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 归档注册表：宿主把已归档会话记在 $DSH_HOME/storages/workspace.json 的
   * global.archivedSessionIds。好友表要跟着这张表回收，避免半年前的名字一直挂着。
   */
  let archivedCache = { at: 0, ids: new Set() }
  async function archivedSessionIds() {
    if (Date.now() - archivedCache.at < 60000 && archivedCache.ids.size >= 0) {
      // 60 秒缓存：一轮清理会问很多次，别反复读同一份文件
      if (Date.now() - archivedCache.at < 60000) return archivedCache.ids
    }
    // 优先问宿主服务；读不到再退回磁盘布局（那是 DSH 的私有实现细节，版本一变就失效，
    // 所以只当兜底，并在失效时留一条可见日志）。
    const registry = service('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        const list = registry.list()
        if (Array.isArray(list) && list.length > 0) {
          const ids = []
          let sawField = false
          for (const row of list) {
            const archived = row && row.archivedSessionIds
            if (Array.isArray(archived)) {
              sawField = true
              ids.push(...archived)
            }
          }
          // **只有真的看到过这个字段**才把服务结果当真。
          // 之前只要 list() 返回非空数组就用它，而 registry.list() 的 Workspace
          // 根本没有 archivedSessionIds 这个字段 → 得到一个空集合 → 归档过滤整个失效
          // （实测 41 个已归档会话仍然出现在候选里），而且还会把这个空集合缓存 60 秒。
          // 现在：没看到字段就当作「服务不提供这个信息」，继续往下读磁盘。
          if (sawField) {
            archivedCache = { at: Date.now(), ids: new Set(ids) }
            return archivedCache.ids
          }
        }
      } catch {}
    }
    try {
      const raw = JSON.parse(await readFile(join(process.env.DSH_HOME || process.cwd(), 'storages', 'workspace.json'), 'utf8'))
      const ids = raw && raw.global && Array.isArray(raw.global.archivedSessionIds) ? raw.global.archivedSessionIds : []
      archivedCache = { at: Date.now(), ids: new Set(ids) }
      return archivedCache.ids
    } catch (error) {
      // 降级但可见：好友表回收会因此停摆，不再静默
      log('archivedSessionIds unavailable (host service and storages/workspace.json both failed):', (error && error.message) || String(error))
      return new Set()
    }
  }

  /**
   * 好友名随会话回收：
   *  - 会话进了 archivedSessionIds → 直接清；
   *  - 会话在持久化列表里彻底消失，且好友名登记超过 10 分钟 → 清（宽限防误删刚建的会话）；
   *  - 持久化返回空表时只按归档表清，防止一次读空把整张好友表抹掉。
   * 只删名字，不动信件；专用通道由 TTL/闲置回收负责。
   */
  let lastFriendSweep = 0
  async function sweepFriends(force = false) {
    // 5 分钟一轮：归档会话的名字要在人能感知的时间内从好友表消失。
    const intervalMs = 5 * 60 * 1000
    if (!force && Date.now() - lastFriendSweep < intervalMs) return { skipped: true }
    lastFriendSweep = Date.now()
    const table = await loadFriends()
    const names = Object.keys(table)
    if (names.length === 0) return { ok: true, removed: 0 }
    const archived = await archivedSessionIds()
    let alive = null
    const persistence = service('sessionPersistence')
    if (persistence) {
      try {
        const snapshots = await persistence.list({ signal: abort() })
        if (Array.isArray(snapshots) && snapshots.length > 0) {
          alive = new Set(snapshots.map((snapshot) => snapshot && snapshot.header && snapshot.header.id).filter(Boolean))
        }
      } catch (error) {
        log('friend sweep: persistence list failed', error && error.message)
      }
    }
    const now = Date.now()
    const removed = []
    for (const [name, row] of Object.entries(table)) {
      if (!row || !row.sessionId) continue
      const archivedNow = archived.has(row.sessionId)
      const gone = alive !== null && !alive.has(row.sessionId)
      if (!archivedNow && !gone) continue
      const age = now - (Date.parse(row.updatedAt || '') || 0)
      if (!archivedNow && age < 10 * 60 * 1000) continue
      delete table[name]
      removed.push({ name, sessionId: row.sessionId, reason: archivedNow ? 'archived' : 'missing' })
    }
    if (removed.length === 0) return { ok: true, removed: 0 }
    await saveFriends(table)
    log('friends pruned: ', JSON.stringify(removed))
    return { ok: true, removed: removed.length, names: removed.map((item) => item.name) }
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
          table[name] = { sessionId: caller, cwd, workspace: cwd, updatedAt: new Date().toISOString(), state: 'unknown', stateAt: null }
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
          const rows = []
          for (const [name, row] of Object.entries(table)) {
            if (!(args.includeOtherWorkspaces === true || !myCwd || !row.cwd || row.cwd === myCwd)) continue
            const state = await peerStateOf(row.sessionId)
            rows.push({ name, ...row, state, stateAt: row.stateAt || null })
          }
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
          const myCwd = caller ? await sessionCwdOf(caller) : undefined
          // 走和 mail_send 同一条解析路径：这样归档检查、跨区判据、cwd 现查全都一致。
          // 之前自己内联查表，绕过了 FRIEND_ARCHIVED，还能拿缓存 cwd 算跨区（会算错）。
          const resolved = await resolveFriend(name, myCwd)
          if (!resolved.ok) return { ok: false, error: { message: resolved.message, code: resolved.code } }
          const target = resolved.friend
          const table = await loadFriends()
          let senderName = caller && String(caller).slice(0, 18)
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
            ackOf: textField('For S-ACK: the mail_id being acknowledged. camelCase in requests; the envelope header writes ack_of.'),
            expireOf: textField('For S-EXPIRE: the mail_id being cancelled. camelCase in requests; the envelope header writes expire_of — passing expire_of here is rejected as MAIL_INVALID.'),
            reason: textField('For S-TODO-NOTICE and S-EXPIRE: why (must be concrete, empty slogans are rejected).'),
            urgent: { type: 'boolean', description: 'Mark the letter urgent: it jumps the courier queue and ignores busy/in-flight and backpressure. Use sparingly.' },
            timeoutMs: { type: 'number', description: 'Override the acknowledgement window in milliseconds (default ackTimeoutMs = 5 min).' },
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
        parameters: params(
          {
            mailId: textField('mail_id to acknowledge.'),
            close: { type: 'boolean', description: 'Close the chain: move both copies to 已解决.' },
            receipt: textField('Optional receipt text stored on the letter and shown to the sender. Defaults to 完成 (closed) or 处理中.'),
            force: { type: 'boolean', description: 'Overwrite the receipt of an already-closed letter. Without it, acking a done letter is idempotent.' },
          },
          ['mailId'],
        ),
        output,
        async execute(args) {
          return submitLocal({
            action: 'mail_ack',
            mailId: args.mailId,
            close: args.close === true,
            receipt: args.receipt,
            force: args.force === true,
          })
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
      tools.register({
        name: 'mail_inbox',
        description:
          'Pull your unread mailbox letters (read-only). Use it at the start of any task when the turn banner says 你有 N 封未读, or whenever you are unsure whether someone is waiting on you. Ordinary letters are no longer pushed into your dialogue, so this is how you find them: it returns one line per letter with mail_id, type, sender, five-directory status, age and envelope path. Answering a letter only counts when you send a reply carrying 〔信箱·<mail_id>〕 or call mail_ack.',
        parameters: params({ sessionId: textField('Optional session id to inspect; defaults to the calling session.') }, []),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          return submitLocal({ action: 'mail_inbox', sessionId: args.sessionId || caller, senderSessionId: caller })
        },
      }),
      tools.register({
        name: 'mail_friends',
        description:
          'List registered friends: registered name + session id only. This is the same table the @ picker shows. Use it when you need a name or session id to send a letter, without exposing cwd or workspace details.',
        parameters: params({}, []),
        output,
        async execute() {
          return submitLocal({ action: 'mail_friends' })
        },
      }),
      tools.register({
        name: 'mail_status',
        description:
          'One-glance state of mailbox letters: five-directory status (已发送/已接收/处理中/待办/已解决), the letter path (A=已发送 P=已接收 R=处理中 B=待办 D=已解决), and whether the two sessions share a group. Reads _index.json + group.json; never returns the letter body.',
        parameters: params({ mailId: textField('Optional mail_id.'), owner: textField('Optional registered name: filters letters sent by or to it.') }, []),
        output,
        async execute(args) {
          return submitLocal({ action: 'mail_status', mailId: args.mailId, owner: args.owner })
        },
      }),
      tools.register({
        name: 'mail_pause',
        description: 'Pause or resume the mailbox courier in the calling workspace. While paused the channel only queues notices and delivers nothing; the flag lives on disk and survives restarts. do=status reports queue depth (queued/held/paused).',
        parameters: params({
          do: textField('pause | resume | status (default status).'),
          cwd: textField('Optional workspace path; defaults to the calling session workspace.'),
        }, []),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          return submitLocal({ action: 'mail_pause', do: args.do || 'status', cwd: args.cwd, senderSessionId: caller })
        },
      }),
      tools.register({
        name: 'mail_group',
        description:
          'Create or list a mailbox group (shared routing table of session ids). Two trigger paths both land here: (1) natural language — when your human asks in words to put two sessions in one group, call this with do=create and the two session ids; (2) command/queue — scripts may POST {action:"mail_group", do:"create"|"list", memberA, memberB}. Groups only route; acknowledgements still travel as ordinary letters. Names may be registered names, workspace session titles, or session ids; unresolved ones come back as UNRESOLVED plus `candidates`. When that happens, present the candidates with ask_user_question using multi_select:true and add a 「不建群」cancel option, then create with the chosen names. The command form `/拉群 A和B` is handled by pre-step only when every name resolves, so the form path is what the human sees otherwise.',
        parameters: params(
          {
            do: textField('create | list | candidates (default list). candidates returns this workspace session titles for a multi-select form.'),
            memberA: textField('First member: registered name, session title, or session id.'),
            memberB: textField('Second member: registered name, session title, or session id.'),
            members: textField('Comma-separated member list when the human picked several in the form; overrides memberA/B.'),
          },
          [],
        ),
        output,
        async execute(args, exec) {
          const caller = exec && exec.agent ? exec.agent.id : undefined
          const members = typeof args.members === 'string' && args.members.trim()
            ? args.members.split(/[,，、]/).map((item) => item.trim()).filter(Boolean)
            : undefined
          return submitLocal({ action: 'mail_group', do: args.do || 'list', memberA: args.memberA, memberB: args.memberB, members, sessionId: caller })
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

  /**
   * 信箱出口通知：外部程序 → 某个会话。
   * POST /session-bridge/notify  { to: 注册名|sessionId, text, from?, title?, mode?: 'schedule'|'prompt' }
   * 默认走宿主内置「自动化任务」（schedule）通道，落到目标会话就是一张定时提醒卡；schedule 不可用时退回 prompt。
   */
  /**
   * 只读好友表：给浏览器 @ 菜单用，只返回 registered name + sessionId。
   * 不含 cwd/workspace/state，避免把内部信息带进前端。
   */
  /**
   * 配置读写路由：浏览器端拿不到 host 的 configEditor 服务，只能经这里中转。
   *   GET  /session-bridge/config   → 当前生效配置
   *   POST /session-bridge/config   → { patch: {...} } 写回 profile 并让 Loader 重新组合
   * 两条都走 connection.requestRejection，跨源页面拿不到。
   */
  function registerConfigRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    const readBody = (req) =>
      new Promise((resolveBody, rejectBody) => {
        let raw = ''
        let bytes = 0
        req.on('data', (chunk) => {
          bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
          raw += chunk
          if (bytes > 65536) {
            rejectBody(new Error('body too large'))
            req.destroy()
          }
        })
        req.on('end', () => resolveBody(raw))
        req.on('error', rejectBody)
      })
    return webServer.register({
      kind: 'exact',
      path: '/session-bridge/config',
      async handler(req, res) {
        if (rejectHttp(req, res) !== undefined) return
        const send = (status, payload) => {
          const body = JSON.stringify(payload)
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        }
        const editor = service('configEditor')
        if (!editor || typeof editor.configuration !== 'function') {
          return send(503, { ok: false, error: { code: 'NO_CONFIG_EDITOR', message: 'host does not expose configEditor' } })
        }
        try {
          if (req.method === 'GET') {
            const rows = await editor.configuration()
            const hit = Array.isArray(rows) ? rows.find((row) => row && row.entry && row.entry.options && row.entry.options.id === 'session-bridge') : undefined
            if (!hit) return send(404, { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'no config row with id session-bridge' } })
            const effective = {
              ...(hit.inherited || {}),
              ...((hit.entry && hit.entry.options && hit.entry.options.config) || {}),
              ...(hit.override || {}),
            }
            return send(200, { ok: true, config: effective })
          }
          if (req.method === 'POST') {
            const raw = await readBody(req)
            let parsed = {}
            try {
              parsed = JSON.parse(raw || '{}')
            } catch {
              return send(400, { ok: false, error: { code: 'BAD_JSON' } })
            }
            const patch = parsed && typeof parsed.patch === 'object' && parsed.patch ? parsed.patch : null
            if (!patch) return send(400, { ok: false, error: { code: 'MISSING_PATCH' } })
            const rows = await editor.configuration()
            const hit = Array.isArray(rows) ? rows.find((row) => row && row.entry && row.entry.options && row.entry.options.id === 'session-bridge') : undefined
            if (!hit) return send(404, { ok: false, error: { code: 'ENTRY_NOT_FOUND', message: 'no config row with id session-bridge' } })
            await editor.edit(hit.entry, (current) => ({ ...(current || {}), ...patch }))
            return send(200, { ok: true })
          }
          res.setHeader('allow', 'GET, POST')
          return send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
        } catch (error) {
          return send(500, { ok: false, error: { code: 'CONFIG_FAILED', message: (error && error.message) || String(error) } })
        }
      },
    })
  }

  function registerFriendsRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      kind: 'exact',
      path: '/session-bridge/friends',
      async handler(req, res) {
        if (rejectHttp(req, res) !== undefined) return
        const send = (status, payload) => {
          const body = JSON.stringify(payload)
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        }
        try {
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET')
            return send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
          }
          const table = await loadFriends()
          const friends = Object.entries(table)
            .filter(([, row]) => row && row.sessionId)
            .map(([name, row]) => ({ name, sessionId: row.sessionId }))
            .sort((a, b) => a.name.localeCompare(b.name))
          return send(200, { ok: true, count: friends.length, friends })
        } catch (error) {
          return send(500, { ok: false, error: { code: 'FRIENDS_FAILED', message: (error && error.message) || String(error) } })
        }
      },
    })
  }

  function registerNotifyRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable; skipping /session-bridge/notify')
      return () => {}
    }
    const token = String(cfg.notifyToken || '')
    const readBody = (req) =>
      new Promise((resolveBody, rejectBody) => {
        let raw = ''
        let bytes = 0
        const MAX_BODY_BYTES = 65536
        req.on('data', (chunk) => {
          bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
          raw += chunk
          if (bytes > MAX_BODY_BYTES) {
            rejectBody(new Error('body too large: ' + bytes + ' bytes'))
            req.destroy()
          }
        })
        req.on('end', () => resolveBody(raw))
        req.on('error', rejectBody)
      })
    return webServer.register({
      kind: 'exact',
      path: '/session-bridge/notify',
      async handler(req, res) {
        if (rejectHttp(req, res) !== undefined) return
        const send = (status, payload) => {
          const body = JSON.stringify(payload)
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        }
        try {
          if (req.method === 'GET') {
            return send(200, {
              ok: true,
              endpoint: 'POST /session-bridge/notify',
              body: { to: '<注册名 或 sessionId>', text: '…', from: '可选', title: '可选' },
              tokenRequired: Boolean(token),
              via: 'prompt（直接投进目标会话的下一轮，不建宿主自动化任务）',
            })
          }
          if (req.method !== 'POST') {
            res.setHeader('allow', 'GET, POST')
            return send(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
          }
          if (token && String(req.headers['x-dsh-token'] || '') !== token) {
            return send(401, { ok: false, error: { code: 'BAD_TOKEN' } })
          }
          const raw = await readBody(req)
          let body = {}
          try {
            body = JSON.parse(raw || '{}')
          } catch {
            return send(400, { ok: false, error: { code: 'BAD_JSON' } })
          }
          const text = String(body.text || '').trim()
          if (!text) return send(400, { ok: false, error: { code: 'EMPTY_TEXT' } })
          const to = String(body.to || body.target || body.sessionId || '').trim()
          if (!to) return send(400, { ok: false, error: { code: 'MISSING_TO' } })
          let sessionId = to
          // 不假设 sessionId 前缀：像 id 的（含 8 位以上 hex 或 session- 前缀）直接当 id 用，
          // 否则才去好友表里按名字解析。宿主换 id 形态时这里不会误判。
          if (!/^session-|^[0-9a-f]{8}-/i.test(to)) {
            const table = await loadFriends()
            const row = table[to]
            if (!row || !row.sessionId) {
              return send(404, { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'unknown session id or registered name: ' + to } })
            }
            sessionId = row.sessionId
          }
          const from = String(body.from || '外部程序').slice(0, 40)
          const prompt = '〔信箱·外部〕' + from + '：\n' + text
          // 只走 prompt：宿主「自动化任务」会在目标会话留 [SCHEDULE CHANGE] 注入，
          // 也会往任务列表里堆卡片。通知归插件自己的状态机管，不借宿主的任务表。
          const controller = service('sessionController')
          if (!controller) return send(503, { ok: false, error: { code: 'NO_CONTROLLER' } })
          await controller.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, abort())
          return send(200, { ok: true, sessionId, via: 'prompt', delivery: 'queued' })
        } catch (error) {
          return send(400, { ok: false, error: { code: 'BAD_REQUEST', message: (error && error.message) || String(error) } })
        }
      },
    })
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          // 只认「真的跳进过这个会话」的记录（用户点跳转 / 自动跳转 / 带创建者的新建）。
          // 不再退化为 parentSession —— 那会让每个子 agent 都长出返回按钮。
          let creator
          let source = 'none'
          let at = 0
          try {
            const link = JSON.parse(await readFile(join(root, 'jumps', 'links', safeId(sessionId, '_') + '.json'), 'utf8'))
            creator = link && link.creatorSessionId
            if (creator) {
              source = link.source || 'link'
              at = Number(link.at || 0) || Date.parse(link.createdAt || '') || 0
            }
          } catch {}
          const fresh = !at || Date.now() - at < cfg.backTtlMs
          let used = false
          try {
            await stat(join(root, 'jumps', 'used', ('back-' + sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.flag'))
            used = true
          } catch {}
          // 严格门控：只有 jump-record 写下的记录（source='jump'）才给按钮，
          // parentSession / 新建会话的 creatorSessionId 一律不出按钮。
          const found = Boolean(creator) && source === 'jump' && fresh && !used
          return new Response(JSON.stringify({ ok: true, sessionId, found, creatorSessionId: creator, source, used, at, fresh }), {
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

  /**
   * GET /session-bridge/jump-record?from=<来源会话>&to=<目标会话>&kind=forward|auto
   * 浏览器确认「刚刚发生了一次跳转」后记账：这是返回按钮唯一的授权来源。
   * 只有用户点跳转、自动跳转、以及带 creatorSessionId 的新建会话才会留下这条记录。
   */
  function registerJumpRecordRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/jump-record',
      kind: 'exact',
      resource: async (request) => {
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
        try {
          const url = new URL(request.url)
          const from = url.searchParams.get('from') || ''
          const to = url.searchParams.get('to') || ''
          const kind = url.searchParams.get('kind') === 'auto' ? 'auto' : 'forward'
          if (!from || !to || from === to) {
            return new Response(JSON.stringify({ ok: false, error: 'from/to required and must differ' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const linksDir = join(root, 'jumps', 'links')
          await mkdir(linksDir, { recursive: true })
          const at = Date.now()
          await writeFile(
            join(linksDir, safeId(to, '_') + '.json'),
            JSON.stringify({ creatorSessionId: from, source: 'jump', kind, at, createdAt: new Date(at).toISOString() }, null, 2),
            'utf8',
          )
          // 新的一次跳转 → 清掉旧的“已用”标记，保证本次能显示
          await rm(join(root, 'jumps', 'used', ('back-' + to).replace(/[^A-Za-z0-9._-]/g, '_') + '.flag'), { force: true }).catch(() => {})
          return new Response(JSON.stringify({ ok: true, from, to, kind, at }), {
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

  /** GET /session-bridge/back-consume?sessionId=… → 按钮已经渲染过一次，本次跳转即告消费。 */
  function registerBackConsumeRoute() {
    const webServer = service('webServer')
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    return webServer.register({
      path: '/session-bridge/back-consume',
      kind: 'exact',
      resource: async (request) => {
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
          const dir = join(root, 'jumps', 'used')
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, ('back-' + sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.flag'), new Date().toISOString(), 'utf8')
          return new Response(JSON.stringify({ ok: true, sessionId, consumed: true }), {
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
        const refusal = rejectResource(request)
        if (refusal !== undefined) return refusal
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
/** 命令式建群：/拉群 A和B（可多个）。未注册的自动注册并建箱；对不上就列出本工作区会话问用户。 */
// 中文入口保留，另加英文 /group，避免非中文用户没有建群入口
const GROUP_CMD = /\/(?:拉群|group)\s+(.+)/

async function autoRegisterSession(sessionId, cwd, wanted, { overwrite = false } = {}) {
  const table = await loadFriends()
  const existing = Object.entries(table).filter(([, row]) => row && row.sessionId === sessionId)
  if (existing.length > 0 && !overwrite) {
    // 已经注册过：返回现值，调用方自己决定要不要改名
    return { name: existing[0][0], created: false, sessionId, cwd: existing[0][1].cwd || cwd }
  }
  if (existing.length > 0 && overwrite) {
    // 改名：先清掉这个会话的所有旧条目（一个会话只留一个主名），
    // 再把 wanted 写进去。不这么做的话新名字会被「已存在」分支挡掉。
    for (const [name] of existing) delete table[name]
  }
  // 自动名 = <工作区目录名>-<会话 ID 后四位>，例如 `本地-c91e` / `FatFish-Whisper-workspace-b2b6`。
  // 工作区前缀不能省：同一个工作区里多个会话只靠后四位区分，跨工作区必须先看前缀。
  const clean = (value) => String(value || '').replace(/[^\w一-龥-]/g, '').replace(/^-+|-+$/g, '')
  const workspaceName = clean(String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop())
  const sessionTail = (String(sessionId || '').match(/([0-9a-f]{4})$/i) || [])[1] || String(sessionId || '').slice(-4)
  const extraPrefix = clean(cfg.childNamePrefix).slice(0, 8)
  const basePrefix = clean((extraPrefix ? extraPrefix + '-' : '') + (workspaceName || 'session'))
  let name = (basePrefix + '-' + sessionTail).slice(0, 32)
  if (!FRIEND_NAME.test(name)) name = 'session-' + sessionTail
  if (table[name]) {
    let n = 2
    while (table[name] && n < 100) {
      name = (basePrefix + '-' + sessionTail + '-' + n).slice(0, 32)
      n += 1
    }
  }
  if (!FRIEND_NAME.test(name)) return { name: null, created: false }
  // ── 用调用方要的名字，别用自动名 ──
  // 之前这里直接写 table[name]（自动生成的「目录名-尾4」），wanted 参数从未生效：
  //   · /register-peer <id> 决策  → 实际注册成 agent-本地-abcd，回执还报「成功」
  //   · /register-me 我的名字     → 与 wanted 比对必然不一致，必失败
  // 这是回归，务必保留这段。
  let finalName = name
  const asked = typeof wanted === 'string' ? wanted.trim() : ''
  if (asked) {
    if (!FRIEND_NAME.test(asked)) return { name: null, created: false, reason: 'requested name is not a valid friend name' }
    // 要的名字被别的会话占了：不能抢，如实报错
    const holder = table[asked]
    if (holder && holder.sessionId && holder.sessionId !== sessionId) {
      return { name: null, created: false, reason: 'name already taken by another session: ' + asked }
    }
    finalName = asked
  }
  // cwd 可能是 undefined（新会话还没绑定工作区）。
  // JSON.stringify 会把 undefined 字段整个丢掉，导致重启后这个好友没有 cwd、
  // 跨工作区判据失效。所以落盘时统一兜成空串，读侧按 falsy 处理。
  const safeCwd = typeof cwd === 'string' && cwd ? cwd : ''
  table[finalName] = { sessionId, cwd: safeCwd, workspace: safeCwd, updatedAt: new Date().toISOString(), auto: !asked }
  await saveFriends(table)
  try {
    await ensureWorkspaceBox(cwd)
  } catch (error) {
    log('auto register box failed: ', error && error.message)
  }
  return { name, created: true, sessionId, cwd }
}

/**
 * 建会话成功后的自动接线：注册名加前缀、一对一、专用通道带 TTL。
 *  1. 双方自动进好友表并建箱；
 *  2. 开一条 scope='task' 的专用通道，默认 24 小时 TTL，不参与并群。
 * 任何一步失败都不影响建会话本身的返回值，只在结果里留 wire 字段。
 */
async function wireNewSession(creatorSessionId, createdSessionId, createdCwd) {
  const report = { registered: [], channel: null, warnings: [] }
  if (!creatorSessionId || !createdSessionId) return report
  try {
    const creatorCwd = await sessionCwdOf(creatorSessionId)
    const creator = await autoRegisterSession(creatorSessionId, creatorCwd, await titleOf(creatorSessionId))
    if (creator.name) report.registered.push({ side: 'creator', name: creator.name, created: creator.created })
    else report.warnings.push('creator auto-registration failed')
    const child = await autoRegisterSession(createdSessionId, createdCwd, await titleOf(createdSessionId))
    if (child.name) report.registered.push({ side: 'child', name: child.name, created: child.created })
    else report.warnings.push('child auto-registration failed')
    const channel = await mailbox.createTaskChannel({
      ownerSessionId: creatorSessionId,
      ownerCwd: creatorCwd,
      memberSessionId: createdSessionId,
      memberCwd: createdCwd,
      ttlMs: cfg.taskChannelTtlMs,
    })
    if (channel.ok) report.channel = channel
    else report.warnings.push('channel: ' + ((channel.error && channel.error.message) || 'failed'))
  } catch (error) {
    report.warnings.push((error && error.message) || String(error))
  }
  return report
}

/** 会话标题：宿主把左栏标题存在 $DSH_HOME/storages/session_projcache/sessions/<id>.json 的 title.val。 */
const titleCache = new Map()
function findTitle(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null
  if (node.title && typeof node.title === 'object' && typeof node.title.val === 'string' && node.title.val.trim()) return node.title.val.trim()
  for (const value of Object.values(node)) {
    const hit = findTitle(value, depth + 1)
    if (hit) return hit
  }
  return null
}
async function titleOf(sessionId) {
  if (!sessionId) return null
  if (titleCache.has(sessionId)) return titleCache.get(sessionId)
  const home = process.env.DSH_HOME || process.cwd()
  let title = null
  try {
    const raw = JSON.parse(await readFile(join(home, 'storages', 'session_projcache', 'sessions', String(sessionId) + '.json'), 'utf8'))
    title = findTitle(raw)
  } catch {
    title = null
  }
  titleCache.set(sessionId, title)
  return title
}

/** 本工作区可见会话：名字优先用注册名，其次用首条用户消息前 24 字（与左栏显示口径一致）。 */
async function workspaceSessionsFor(cwd) {
  const rows = (await storedSessions()).filter((row) => row.origin !== 'subagent' && !row.parent)
  const table = await loadFriends()
  const nameById = new Map()
  for (const [name, row] of Object.entries(table)) if (row && row.sessionId) nameById.set(row.sessionId, name)
  const out = []
  for (const row of rows) {
    const registeredName = nameById.get(row.sessionId)
    let label = (await titleOf(row.sessionId)) || registeredName
    if (!label) {
      try {
        const page = await readEvents(row.sessionId, 4)
        const first = ((page && page.records) || [])
          .map((record) => blockText(messageOf(record.event)))
          .find((text) => typeof text === 'string' && text.trim().length > 0)
        label = first ? first.trim().replace(/\s+/g, ' ').slice(0, 24) : '(未命名会话)'
      } catch {
        label = '(未命名会话)'
      }
    }
    out.push({ sessionId: row.sessionId, cwd: row.cwd, preset: row.preset, label, registered: Boolean(registeredName) })
  }
  return out
}

/** 名字 → 会话：注册名优先，其次左栏标题（精确/包含）；未注册的可自动注册并建箱。 */
async function resolveMemberNames(names, callerCwd, auto) {
  const table = await loadFriends()
  const sessions = await workspaceSessionsFor(callerCwd)
  const resolved = []
  const unknown = []
  const cross = []
  for (const name of names) {
    const row = table[name]
    if (row && row.sessionId) {
      // 判据要和投递一致：同区与嵌套目录都放行，只有彼此无关的工作区才算跨区。
      // 之前用 samePath，嵌套目录（子工作区）会被误判成跨区而拒绝。
      if (callerCwd && row.cwd && workspaceRelation(row.cwd, callerCwd) === 'other' && cfg.allowCrossWorkspace !== true) {
        cross.push(name)
        continue
      }
      // 归档会话在插件视角不存在，别让群把它拉进来
      try {
        if ((await archivedSessionIds()).has(row.sessionId)) {
          cross.push(name)
          continue
        }
      } catch {}
      resolved.push({ name, sessionId: row.sessionId, auto: false })
      continue
    }
    const hit = sessions.find((item) => item.label === name) || sessions.find((item) => item.label.includes(name))
    if (!hit) {
      unknown.push(name)
      continue
    }
    if (auto === false) {
      resolved.push({ name: hit.label, sessionId: hit.sessionId, auto: false })
      continue
    }
    const registered = await autoRegisterSession(hit.sessionId, hit.cwd || callerCwd, hit.label)
    resolved.push({ name: registered.name || hit.label, sessionId: hit.sessionId, auto: true })
  }
  return { resolved, unknown, cross, sessions }
}

async function handleGroupCommand(agent, messages) {
  if (!agent || !agent.id) return
  const callerCwd = await sessionCwdOf(agent.id)
  for (const message of messages || []) {
    for (const block of (message && message.content) || []) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
      const match = GROUP_CMD.exec(block.text)
      if (!match) continue
      const names = String(match[1]).split(/[和与,，、\s]+/).map((item) => item.trim()).filter(Boolean)
      if (names.length < 2) continue
      const controller = service('sessionController')
      const notify = (text) =>
        controller
          ? controller.prompt({ requestId: randomUUID(), sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text }] }, abort()).catch(() => {})
          : Promise.resolve()
      const { resolved, unknown, cross } = await resolveMemberNames(names, callerCwd, true)
      if (unknown.length > 0 || cross.length > 0) {
        // 有对不上的名字：不在这里回表格，交给本会话的智能体用「多选表单」问用户
        log('group command needs a choice:', unknown.join(',') || cross.join(','))
        return
      }
      if (resolved.length < 2) return
      const result = await mailbox.groupCreate({ members: resolved.map((item) => item.sessionId), cwd: callerCwd })
      if (!result.ok) {
        await notify('〔信箱·群〕建群失败：' + ((result.error && result.error.message) || 'unknown'))
        return
      }
      const autoNames = resolved.filter((item) => item.auto).map((item) => item.name)
      await notify(
        [
          result.changed
            ? '〔信箱·群〕已建群 ' + result.group.id + (result.merged ? '（与已有群合并）' : '') + '：' + resolved.map((item) => item.name).join('、')
            : '〔信箱·群〕已有共同群' + (result.group ? ' ' + result.group.id : '') + '，未新建。',
          autoNames.length > 0 ? '自动注册并建箱：' + autoNames.join('、') : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }
  }
}

  /**
   * 斜杠命令：/注册好友 <名字>（英文宿主上显示 /register）。
   *
   * 走宿主标准的 commands 服务，不用伪造输入源：
   *   ctx.commands.register({ name, description, input: { hint }, handler })
   * 命令名按 DSH 当前语言选：中文宿主用「注册好友」，其余用 register。
   * 解析与执行都由宿主完成（commands.execute），不走 pre-step 文本匹配。
   */
  /**
   * 两个斜杠命令，语义分开，避免混淆：
   *   /register-me  <名字>                       把自己登记成这个名字
   *   /register-peer <工作区> <会话id> [名字]      把别人的会话加进好友表
   *
   * 都走宿主标准的 commands 服务（commands.register），
   * 解析与执行由宿主完成，不进模型上下文。
   * 名字固定英文：宿主命令名不做本地化，描述里写清用途与示例。
   */
  function registerSlashCommands() {
    const commands = service('commands')
    if (!commands || typeof commands.register !== 'function') {
      log('commands service unavailable; slash commands not registered')
      return () => {}
    }

    /** 统一的结果构造。 */
    const ok = (text) => ({ kind: 'success', text })
    const fail = (text) => ({ kind: 'error', text })

    /** 解析 `/register-peer` 的参数：<工作区> <会话id> [名字]。 */
    /**
     * 宽松解析 `/register-peer` 的参数。
     *
     * 原则：**缺什么补什么，不要求用户按格式写**。
     * 能认出来的全都认：
     *   - 会话 id（session-<uuid> / 裸 uuid）出现在任何位置
     *   - 名字用引号包起来：`"决策会话"` / '决策' / 「决策」
     *   - 其余片段都当作工作区线索
     * 返回 { sessionId?, workspaceHint?, name? }，全程不报「格式错」。
     */
    const parsePeerArgs = (raw) => {
      // 上限 200：5 KB 的输入原样回显进命令输出没有意义，也会撑爆一屏
      const text = String(raw || '').trim().slice(0, 200)
      const out = { sessionId: undefined, workspaceHint: undefined, name: undefined }
      if (!text) return out

      // 1) 先摘出被引号包住的名字（支持中英文引号）
      let rest = text
      const quoted = rest.match(/["'「『](.+?)["'」』]/)
      if (quoted) {
        out.name = quoted[1].trim()
        rest = (rest.slice(0, quoted.index) + ' ' + rest.slice(quoted.index + quoted[0].length)).trim()
      }

      // 2) 摘出会话 id：session-<uuid> 或裸 uuid
      const idMatch = rest.match(/(?:^|\s)(session-[0-9a-fA-F-]{8,}|[0-9a-fA-F]{8}-[0-9a-fA-F-]{8,})(?=\s|$)/)
      if (idMatch) {
        out.sessionId = idMatch[1]
        rest = (rest.slice(0, idMatch.index) + ' ' + rest.slice(idMatch.index + idMatch[0].length)).trim()
      }

      // 3) 剩下的当工作区线索；纯引号对（"" 或 ''）不算线索
      const leftover = rest
        .split(/\s+/)
        .filter(Boolean)
        .filter((piece) => !/^["'「『」』]{2}$/.test(piece))
        .join(' ')
        .trim()
      if (leftover) out.workspaceHint = leftover
      return out
    }


    /** 工作区名：目录名，冲突时加路径缩略（末段 + 短哈希）。 */
    /**
     * 工作区短名：取路径末段；冲突时补父目录首字母与短哈希。
     * 例 E:\AI Projects\Super-agent → Super-agent，重名时 Super-agent-AI-a3f2
     */
    const workspaceToken = (cwd, { disambiguate = false } = {}) => {
      const raw = String(cwd || '').replace(/[\\/]+$/, '')
      const parts = raw.split(/[\\/]+/).filter(Boolean)
      const seg = parts[parts.length - 1] || 'workspace'
      const clean = seg.replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 32) || 'workspace'
      if (!disambiguate) return clean
      const parent =
        parts.length >= 3 ? String(parts[parts.length - 2]).replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 4) : ''
      let hash = 0
      for (const ch of raw.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 0xffff
      const suffix = hash.toString(16).padStart(4, '0').slice(0, 4)
      return [clean, parent, suffix].filter(Boolean).join('-').slice(0, 32)
    }

    /** 这个名字是否已被占用。 */
    const nameTaken = async (name) => {
      const table = await loadFriends().catch(() => ({}))
      return Object.prototype.hasOwnProperty.call(table || {}, name)
    }

    /**
     * 把候选会话渲染成人能读的列表：**先给人看的名字，会话 id 放后面**。
     * 之前直接甩原始 id，又长又多，界面上会截断，而且看不出哪个是哪个。
     *
     * 名字优先用注册名，其次用会话标题，都没有才退回目录名+尾号。
     * 最多 6 条，并按名字去重——宁可少列，也不要糊成一团。
     */
    /**
     * 会话标题往往是一整句话（"你是 preset-review。工作目录 D:\dshdata\本地"），
     * 直接当名字会又长又认不出。这里做三件事：
     *   1. 砍掉句读之后的句子，只留第一个短句
     *   2. 剥掉「你是 xxx」「工作目录 xxx」这类模板前缀
     *   3. 前面挂上工作区名，让人一眼看出它在哪个区
     */
    const cleanTitle = (raw) => {
      let text = String(raw || '').replace(/\s+/g, ' ').trim()
      if (!text) return ''
      // 只留第一句
      const stop = text.search(/[。！？；\n]|\s{2,}/)
      if (stop > 0) text = text.slice(0, stop)
      // 剥模板前缀
      text = text
        .replace(/^你是\s*[\w.-]+[。，,\s]*/i, '')
        .replace(/^preset[- ]?[\w]+[。，,\s]*/i, '')
        .replace(/工作目录\s*[A-Za-z]:[\\/][^\s]*/gi, '')
        .replace(/Reply with exactly one short.*$/i, '')
        .replace(/[\s。，,、]+$/g, '')
        .trim()
      // 太长就截断（中文按字算）
      // 中文按字算，英文按词算，20 个字足够认出一条会话
      if (text.length > 22) text = text.slice(0, 22).replace(/[\s，,]+$/, '') + '…'
      return text
    }

    const renderCandidates = async (sessions, limit = 6) => {
      const table = await loadFriends().catch(() => ({}))
      const nameById = new Map()
      for (const [name, row] of Object.entries(table || {})) {
        if (row && row.sessionId) nameById.set(row.sessionId, name)
      }
      const rows = []
      for (const row of (sessions || []).slice(0, limit)) {
        const registered = nameById.get(row.sessionId)
        const rawTitle = registered ? null : await titleOf(row.sessionId).catch(() => null)
        const cwd = await sessionCwdOf(row.sessionId).catch(() => row.cwd)
        const wsName = cwd ? workspaceToken(cwd) : ''
        const cleaned = rawTitle ? cleanTitle(rawTitle) : ''
        const tail = String(row.sessionId).slice(-4)
        // 优先：注册名（本身就是人起的名，不用加工）
        // 其次：清洗后的标题，前面挂工作区名
        // 最后：工作区名-尾号
        const label =
          registered ||
          (cleaned
            ? (wsName ? wsName + ' · ' : '') + cleaned
            : (wsName ? wsName + '-' : '(未命名会话)-') + tail)
        rows.push({
          label,
          registered: Boolean(registered),
          sessionId: row.sessionId,
        })
      }
      return rows
    }

    /**
     * 把候选行拼成给人看的文本：**一行一条，只要名字**。
     *
     * 之前把完整 session id 也印上去，界面上会截断成一团乱码，而且看不出谁是谁。
     * 现在只给名字；名字重复时补一个短尾号区分。
     * 完整 id 只在提示语里说明「选哪个」，不铺在列表里。
     */
    const candidateLines = (rows) => {
      const counts = new Map()
      for (const row of rows) counts.set(row.label, (counts.get(row.label) || 0) + 1)
      return rows.map((row, index) => {
        const dup = counts.get(row.label) > 1
        const tail = dup ? ' ·' + String(row.sessionId).slice(-4) : ''
        const mark = row.registered ? '（已注册）' : ''
        return '  ' + (index + 1) + '. ' + row.label + tail + mark
      })
    }

    /**
     * 统一包一层：命令 handler 抛异常时，宿主只写事件日志、对话里什么都不显示。
     * 所以每个命令都在这里兜住异常，转成一条可见的 error 文本。
     * 新加命令只要走 registerOne，就自动有这个保护。
     */
    const withEcho = (name, handler) => async (invocation) => {
      try {
        const result = await handler(invocation)
        // 兜底：handler 返回了 undefined / 非 CommandResult 时也要让人看见
        if (!result || typeof result !== 'object' || !('kind' in result)) {
          return { kind: 'error', text: '/' + name + ' 没有返回结果（内部错误），请重试一次。' }
        }
        // 宿主对 error 的 text 强制非空，空串会抛 TypeError → 命令在对话里什么都不显示。
        // 在交出之前补一句，别让它变成一个静默失败。
        if (result.kind === 'error' && !String(result.text == null ? '' : result.text).trim()) {
          return { kind: 'error', text: '/' + name + ' 执行失败，但没有给出原因（内部错误）。' }
        }
        // success 的 text 允许省略，但空串同样别交出去
        if (result.kind === 'success' && result.text !== undefined && !String(result.text).trim()) {
          return { kind: 'success', text: '/' + name + ' 已完成。' }
        }
        return result
      } catch (error) {
        const detail = (error && error.message) || String(error)
        log('slash command failed: ', name, detail)
        return { kind: 'error', text: '/' + name + ' 执行出错：' + detail }
      }
    }

    const registerOne = async (name, description, hint, handler) => {
      try {
        return commands.register({ name, description, input: { hint }, handler: withEcho(name, handler) })
      } catch (error) {
        log('register command failed: ', name, (error && error.message) || String(error))
        return () => {}
      }
    }

    const disposers = []

    // ── /register-me ──────────────────────────────────────────────
    disposers.push(
      registerOne(
        'register-me',
        '把自己登记成可寻址的名字，例：/register-me 本地-c91e（别人可按名字发信或在 @ 里找到你）',
        '必须跟一个名字，例：/register-me 本地-c91e（光敲命令不会执行）',
        async (invocation) => {
          const rawInput = String((invocation && invocation.rawInput) || '').trim()
          const agentId = invocation && invocation.agent ? invocation.agent.id : undefined
          if (!agentId) {
            return fail(
              '拿不到当前会话 id，注册没做。\n' +
                '如果你是在刚新建、还没发过消息的会话里执行的，先随便发一句话让会话建立起来，再执行这个命令。',
            )
          }
          if (!rawInput) {
            return fail(
              [
                '还差一个名字。',
                '',
                '正确格式：',
                '  /register-me 本地-c91e',
                '    名字   必填，1–32 字符，可用字母数字下划线连字符和汉字',
                '           建议带工作区前缀避免撞名，如 FatFish-Whisper-开发区-dispatcher',
                '',
                '嫌麻烦的话，把下面这行复制给助手，它会自己走完：',
                '',
                '  用会话编排插件给我这个会话注册一个名字，我来定叫什么。' +
                  '调 session_register_name，名字由我提供。',
              ].join('\n'),
            )
          }
          // 宽进严出：名字不合法就清洗后直接注册，并把改成了什么告诉用户
          const cleaned = sanitizeFriendName(rawInput)
          if (!cleaned.name) {
            return fail('这个名字里没有一个可用字符，换一个吧（字母、数字、下划线、连字符、汉字都行）。')
          }
          const cwd = await sessionCwdOf(agentId)
          // 记下改名前叫什么，回执里说清楚，别让人以为凭空多了个名字
          const beforeTable = await loadFriends()
          const previousNames = Object.entries(beforeTable)
            .filter(([, row]) => row && row.sessionId === agentId)
            .map(([name]) => name)
          // 显式改名：覆盖旧名字（一个会话只留一个主名）
          const registered = await autoRegisterSession(agentId, cwd, cleaned.name, { overwrite: true })
          if (!registered || registered.name !== cleaned.name) {
            return fail('注册失败：' + ((registered && registered.reason) || 'unknown'))
          }
          return ok(
            '〔信箱·注册〕已登记为 `' + cleaned.name + '`。' +
              (cleaned.changed
                ? '\n（你写的是 `' + rawInput + '`，因为名字只能用字母、数字、下划线、连字符和汉字，我改成了上面这个。）'
                : '') +
              (previousNames.length > 0 && !previousNames.includes(cleaned.name)
                ? '\n（原来的名字 ' + previousNames.map((n) => '`' + n + '`').join('、') + ' 已被替换，一个会话只保留一个主名。）'
                : '') +
              '\n别人可按此名字发信，或在 `@` 里找到你。名字是全局的，同名后注册者会覆盖先注册者。' +
              '\n想改名：再用 /register-me 一个新名字即可。' +
              '\n\n┌ 接下来你可以直接对我说：' +
              '\n│ 「把<要说的内容>送给<注册名>」——我就替你把这封信发出去' +
              '\n│ 「看看有什么没处理」——我列给你' +
              '\n│ 或者你用自己的说法告诉我，说一次我就记住，以后按你的说法触发。',
          )
        },
      ),
    )

    // ── /register-peer ────────────────────────────────────────────
    disposers.push(
      registerOne(
        'register-peer',
        '把另一个会话加进好友表并命名，例：/register-peer 本地-dc16 决策（给多少算多少，缺的我来补）',
        '必须跟一个会话名或会话id，例：/register-peer 本地-dc16（光敲命令不会执行）',
        async (invocation) => {
          const rawInput = String((invocation && invocation.rawInput) || '').trim()
          const agentId = invocation && invocation.agent ? invocation.agent.id : undefined
          const parsed = parsePeerArgs(rawInput)
          const callerCwd = agentId ? await sessionCwdOf(agentId).catch(() => undefined) : undefined
          // 候选范围受跨工作区开关约束：关着只看本工作区，开着看全部。
          const sessions = await candidateSessions(callerCwd)
          const scopeNote =
            cfg.allowCrossWorkspace === true
              ? '（已开启跨工作区，范围：所有工作区）'
              : '（未开启跨工作区，范围：仅本工作区；想跨区请在设置里打开「跨工作区放行」）'
          const table = await loadFriends().catch(() => ({}))
          const friendly = async (sessionId) => {
            const cwd = await sessionCwdOf(sessionId).catch(() => undefined)
            return (cwd ? workspaceToken(cwd) + '-' : '') + String(sessionId).slice(-4)
          }

          // ── 情况 A：给了会话 id ────────────────────────────────
          if (parsed.sessionId) {
            const known = (sessions || []).find((row) => row.sessionId === parsed.sessionId)
            const registeredAlready = Object.entries(table || {}).find(([, row]) => row && row.sessionId === parsed.sessionId)
            if (!known && !registeredAlready) {
              // 分三种情况，别一律说「找不到」：
              //   1) 这个 id 真实存在，但在别的没放行的工作区 → 明确说被跨区设置挡住
              //   2) 这个 id 真实存在，但已归档 → 说归档
              //   3) 真的不存在 → 给候选
              const everywhere = await storedSessions().catch(() => [])
              const existsSomewhere = everywhere.find((row) => row.sessionId === parsed.sessionId)
              if (existsSomewhere && cfg.allowCrossWorkspace !== true) {
                return fail(
                  '这个会话存在，但在别的工作区：' +
                    (existsSomewhere.cwd || '（未知目录）') +
                    '\n当前「跨工作区放行」是关着的，只能注册本工作区的会话。\n' +
                    '想注册它：去 设置 → 会话编排 → 安全 打开「跨工作区放行」，再发一次。',
                )
              }
              if (!existsSomewhere) {
                // 可能是已归档：storedSessions 已经把归档的剔掉了
                const archivedSet = await archivedSessionIds().catch(() => new Set())
                if (archivedSet.has(parsed.sessionId)) {
                  return fail(
                    '这个会话已被归档，插件视角里它不存在，不能注册。\n' +
                      '在 DSH 里取消归档后再试，或换一个活着的会话。',
                  )
                }
              }
              const tops = (sessions || []).slice(0, 6)
              const lines = candidateLines(await renderCandidates(tops, tops.length))
              return fail(
                [
                  '没找到这个会话 id：' + parsed.sessionId,
                  '',
                  '正确格式（给多少算多少，至少要有一样）：',
                  '  /register-peer <会话id> [名字]',
                  '  /register-peer <工作区名> [名字]',
                  '    会话id 或 工作区名   至少给一样',
                  '    名字                 可选，不给就自动取「工作区名-会话尾号」',
                  scopeNote,
                  lines.length > 0 ? '' : null,
                  lines.length > 0 ? '现有的会话：' : null,
                  lines.length > 0 ? lines.join('\n') : '这台机器上没有可注册的会话。',
                  lines.length > 0 ? '' : null,
                  lines.length > 0 ? '选一个，把下面的命令复制出来、把 <id> 换成它的会话 id，再接一次：' : null,
                  lines.length > 0 ? '' : null,
                  lines.length > 0 ? '  /register-peer <id>' + (parsed.name ? ' ' + parsed.name : '') : null,
                  '',
                  '或者把这行直接发给助手，它会自己走完：',
                  '',
                  '  把 <id> 换成上面某个会话的 id，用 /register-peer 注册进好友表。',
                ]
                  .filter((line) => line !== null)
                  .join('\n'),
              )
            }
            const cwd = known ? known.cwd : await sessionCwdOf(parsed.sessionId)
            let wanted = parsed.name
            let autoNamed = false
            if (!wanted) {
              autoNamed = true
              wanted = await friendly(parsed.sessionId)
              if (await nameTaken(wanted)) {
                wanted = (cwd ? workspaceToken(cwd, { disambiguate: true }) : 'session') + '-' + String(parsed.sessionId).slice(-4)
              }
            }
            const cleanA = sanitizeFriendName(wanted)
            if (!cleanA.name) return fail('这个名字里没有一个可用字符，换一个吧。')
            const renamedA = cleanA.changed && Boolean(parsed.name)
            wanted = cleanA.name
            const registered = await autoRegisterSession(parsed.sessionId, cwd, wanted, { overwrite: Boolean(parsed.name) })
            if (!registered || !registered.name) {
              return fail('注册没成功：' + ((registered && registered.reason) || 'unknown'))
            }
            return ok(
              '〔信箱·注册〕已把 ' + parsed.sessionId + ' 登记为 `' + registered.name + '`。' +
                (autoNamed ? '\n名字是我按「工作区名 + 会话尾号」自动取的。' : '') +
                (renamedA ? '\n（你写的名字含不能用的字符，我改成了上面这个。）' : '') +
                '\n想换名字：/register-peer ' + parsed.sessionId + ' "新名字"' +
                '\n\n┌ 之后要发信，可以直接说：' +
                '\n│ 「把<内容>送给 ' + registered.name + '」' +
                '\n│ 或者你用自己的说法告诉我，说一次我就记住，以后按你的说法触发。',
            )
          }

          // ── 情况 B：只给了工作区线索或名字 ──────────────────────
          const hint = (parsed.workspaceHint || parsed.name || '').toLowerCase()
          const candidates = (sessions || [])
            .filter((row) => {
              if (!hint) return true
              const cwd = String(row.cwd || '').toLowerCase()
              return cwd.includes(hint) || String(row.sessionId).toLowerCase().includes(hint)
            })
            .slice(0, 8)

          if (candidates.length === 0) {
            const all = (sessions || []).slice(0, 8)
            if (all.length === 0) {
              return fail('本机暂时没有可注册的会话。用 New Session 开一个，或在 DSH 里先建一个会话。')
            }
            const lines = candidateLines(await renderCandidates(all, all.length))
            // 命令只把事实说清楚，并给出一条能直接复制的命令。
            // 想让它替人做完，人要自己把这条命令发给助手——命令本身做不到。
            return {
              kind: 'error',
              text:
                (hint ? '没有匹配「' + hint + '」的会话。' : '') +
                '现有会话如下：\n' +
                lines.join('\n') +
                '\n\n选一个，把下面的命令复制出来、把 <id> 换成它的会话 id，再接一次：\n\n' +
                '  /register-peer <id>' + (parsed.name ? ' ' + parsed.name : '') +
                '\n\n或者把这行直接发给助手，它会自己走完：\n\n  把 <id> 换成上面某个会话的 id，用 /register-peer 注册进好友表。',
            }
          }

          if (candidates.length === 1) {
            // 唯一命中：直接注册，不让用户再确认一次
            const target = candidates[0]
            const rawWanted = parsed.name || (await friendly(target.sessionId))
            const cleanB = sanitizeFriendName(rawWanted)
            if (!cleanB.name) return fail('这个名字里没有一个可用字符，换一个吧。')
            const wanted = cleanB.name
            const registered = await autoRegisterSession(target.sessionId, target.cwd, wanted, { overwrite: Boolean(parsed.name) })
            if (!registered || !registered.name) {
              return fail('注册没成功：' + ((registered && registered.reason) || 'unknown'))
            }
            return ok(
              '〔信箱·注册〕已把 ' + target.sessionId + ' 登记为 `' + registered.name + '`。' +
                (cleanB.changed && parsed.name ? '\n（你写的名字含不能用的字符，我改成了上面这个。）' : ''),
            )
          }

          // 多个命中：列出来让用户挑，不逼它记格式
          const lines = candidateLines(await renderCandidates(candidates, candidates.length))
          return {
            kind: 'error',
            text:
              '匹配到 ' + candidates.length + ' 个会话：\n' +
              lines.join('\n') +
              '\n\n选一个，把下面的命令复制出来、把 <id> 换成它的会话 id，再接一次：\n\n' +
              '  /register-peer <id>' + (parsed.name ? ' ' + parsed.name : ''),
          }
        },
      ),
    )

    // ── /new-workspace ───────────────────────────────────────────
    // 人类明确要求时直接做完，不依赖 agent 回合。
    //   · 参数齐全（项目名 + 目录）→ 当场建工作区与会话
    //   · 参数不全 → 回一段「格式 + 可复制的 LLM 指令」，让人补或转给助手
    disposers.push(
      registerOne(
        'new-workspace',
        '新建 DSH 工作区并开会话，例：/new-workspace 我的项目 D:\\work\\myproj',
        '项目名 + 目录，例：/new-workspace 我的项目 D:\\work\\myproj',
        async (invocation) => {
          const rawInput = String((invocation && invocation.rawInput) || '').trim()
          const agentId = invocation && invocation.agent ? invocation.agent.id : undefined

          // 解析：**从右往左**找第一个盘符或根路径，它往后都是目录。
          //
          // 难点：路径可能带空格（E:\AI Projects\FatFish），也可能是中文目录（D:\文档），
          // 而人类习惯在后面补一句说明（“…建成了”）。三种情况必须一次吃准：
          //   1. 找到最后一个「盘符起点」或 POSIX 根，从那里**吃到行尾**（这样空格不受影响）
          //   2. 用 path.isAbsolute 回判：不是合法绝对路径就退回「只给了项目名」
          //   3. Windows 上遇到 /unix/path 直接拒，避免悄悄建到 C:\unix\path
          let workspace
          let project = rawInput
          let posixOnWindows = null
          if (rawInput) {
            const B = String.fromCharCode(92)
            // 找最后一个盘符（D:\ 或 D:/）
            const driveHits = [...rawInput.matchAll(/[A-Za-z]:[\\/]/g)]
            if (driveHits.length > 0) {
              const start = driveHits[driveHits.length - 1].index
              if (start > 0) {
                workspace = rawInput.slice(start).trim()
                project = rawInput.slice(0, start).trim()
              }
            } else if (rawInput.includes('/')) {
              // 没有盘符但含斜杠：POSIX 风格
              const start = rawInput.indexOf('/')
              if (start > 0) {
                const candidate = rawInput.slice(start).trim()
                if (IS_WINDOWS) {
                  // Windows 上 /foo 会被 resolve 成 C:\foo，静默建到用户没写的盘。
                  // 这里只记下来，解析段结束后统一提示（needMore 还没定义）。
                  posixOnWindows = candidate
                } else {
                  workspace = candidate
                  project = rawInput.slice(0, start).trim()
                }

              }
            }
            // 回判：必须真的是绝对路径，否则当项目名处理
            if (workspace && !isAbsolute(workspace)) {
              project = rawInput
              workspace = undefined
            }
          }

          /** 参数不全时统一回这一段：格式说明 + 可直接复制的 LLM 指令。 */
          const needMore = (missing) => {
            const example = '我的项目 D:\\work\\myproj'
            const askLlm =
              '用会话编排插件新建一个工作区并开会话。' +
              '项目名：' + (project || '（待定）') + '；' +
              '目录：' + (workspace || '（待定，请先问我）') + '。' +
              '调 session_init_workspace（project / workspace / preset / title）。'
            return fail(
              [
                missing,
                '',
                '正确格式：',
                '  /new-workspace ' + example,
                '    项目名   必填，可以带空格',
                '    目录     必填，盘符开头（D:\\… 或 E:\\…）',
                '',
                '嫌麻烦的话，把下面这行复制给助手，它会自己走完：',
                '',
                '  ' + askLlm,
              ].join('\n'),
            )
          }

          if (!rawInput) return needMore('还差项目名和目录。')
          if (posixOnWindows) {
            const B = String.fromCharCode(92)
            return needMore(
              '这是 POSIX 风格路径（' + posixOnWindows + '），当前是 Windows，请写盘符形式，例如 D:' + B + 'work' + B + 'myproj。',
            )
          }
          if (!project) return needMore('还差项目名。')
          if (!workspace) return needMore('还差目录——工作区建在哪个文件夹？')

          // 目录护栏与预设校验先做，失败就直接回人话，不进队列。
          // **必须先校验再发授权**：否则护栏拒绝后授权仍留在表里 10 分钟，
          // agent 随后自己起意调 init_workspace 会白拿一次放行（这是授权泄漏）。
          const guard = guardCreatablePath(workspace)
          if (!guard.ok) {
            return fail('这个目录不能建工作区：' + guard.message + '\n换一个目录再试。')
          }

          // 10 秒内同一 项目+目录 只建一次：连发两次不该出两个会话
          // 键要归一化：`D:\p` 与 `D:\p\` 是同一个目录，不归一化会重复建两个工作区
          const dedupKey = project + '|' + (normalizePathBase(workspace) || workspace)
          const recent = createWorkspaceRecent.get(dedupKey)
          if (recent && Date.now() - recent.at < CREATE_WORKSPACE_DEDUP_MS) {
            return fail(
              '刚刚（' + Math.round((Date.now() - recent.at) / 1000) + ' 秒前）已经为「' + project + '」建过这个工作区了。\n' +
                (recent.sessionId ? '会话：' + recent.sessionId + '\n' : '') +
                '要再建一个的话，等 10 秒后再发，或者换个项目名。',
            )
          }
          createWorkspaceRecent.set(dedupKey, { at: Date.now(), sessionId: null })
          // 清掉过期的
          for (const [k, v] of createWorkspaceRecent) {
            if (Date.now() - Number(v.at || 0) > CREATE_WORKSPACE_DEDUP_MS * 6) createWorkspaceRecent.delete(k)
          }

          // 人类亲手敲的命令 = 明确要求 → 发一次授权，绕过「禁止 agent 自主建会话」的门控。
          if (agentId) grantHumanPermit(agentId, 'slash:new-workspace')

          // 走队列执行真实动作（和工具同一条路径，行为完全一致）。
          try {
            const value = await submitLocal({
              action: 'init_workspace',
              project,
              cwd: workspace,
              title: project,
              creatorSessionId: agentId,
            })
            // submitLocal 不会抛异常：业务失败时返回 { ok:false, error }。
            // 不检查 ok 会把失败当成成功，回一句「已建好」——这是最坏的误导。
            if (!value || value.ok !== true) {
              const err = (value && value.error) || {}
              if (err.code === 'AGENT_CREATE_DISABLED') {
                return fail(
                  '建会话被设置挡住了。\n' +
                    '去 设置 → 会话编排 → 安全，把「允许 Agent 通过本插件新建会话」打开，再敲一次。',
                )
              }
              if (err.code === 'PRESET_REQUIRED') {
                return fail(
                  '设置里开了「新建会话时先问用哪个预设」，所以要先选预设。\n' +
                    '把下面这行复制给助手，它会列出预设让你挑：\n\n' +
                    '  用会话编排插件新建工作区，项目名：' + project + '，目录：' + workspace + '。' +
                    '先列出可用预设让我挑，再调 session_init_workspace。',
                )
              }
              return fail('建工作区没成功：' + (err.message || '未知原因'))
            }
            const sessionId = value && (value.sessionId || (value.session && value.session.id))
            // 记下会话 id，重复发的时候能告诉人类上一次建的是哪个
            if (sessionId) {
              const prev = createWorkspaceRecent.get(dedupKey)
              createWorkspaceRecent.set(dedupKey, { at: prev ? prev.at : Date.now(), sessionId })
            }
            const workspaceId = value && (value.workspaceId || (value.workspace && value.workspace.id))
            const registered = value && value.wire && Array.isArray(value.wire.registered)
              ? value.wire.registered.map((item) => item.name).filter(Boolean)
              : []
            return {
              kind: 'success',
              text:
                '〔会话编排〕工作区已建好。\n' +
                '  项目    ' + project + '\n' +
                '  目录    ' + workspace + '\n' +
                (sessionId ? '  会话    ' + sessionId + '\n' : '') +
                (workspaceId ? '  工作区  ' + workspaceId + '\n' : '') +
                (registered.length > 0 ? '  已注册  ' + registered.join('、') + '\n' : '') +
                '\n去左侧工作区列表里就能看到它。',
            }
          } catch (error) {
            // 建失败就把去重记录清掉：否则人类想立刻重试会被自己刚才那次失败挡住
            createWorkspaceRecent.delete(dedupKey)
            const detail = (error && error.message) || String(error)
            const code = error && error.code
            if (code === 'AGENT_CREATE_DISABLED') {
              return fail(
                '建会话被设置挡住了。\n' +
                  '去 设置 → 会话编排 → 安全，把「允许 Agent 通过本插件新建会话」打开，再敲一次。',
              )
            }
            return fail('建工作区失败：' + detail)
          }
        },
      ),
    )

    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }

  /**
   * 自然语言种子：只做「意图识别 + 给流程提示」，不代替 agent 执行。
   *
   * 判断很宽：命中关键词就给一段 runtime-context，说明该走哪条流程、要问人类什么。
   * 不命中就什么都不做，绝不拦截或改写人类消息。
   *
   * 之所以放在 pre-step 而不是做成命令：用户不会为了建个工作区先学命令语法。
   */
  const SEED_PATTERNS = [
    {
      id: 'init-workspace',
      /**
       * 只认明确的说法。宽匹配（「建个工作区」「开个项目」）会命中太多歧义——
       * 「建工作区」在别人语境里可能是「生成项目骨架」「整理目录」「建 git worktree」。
       * 所以这里**必须出现「工作区」这个词本身**，且动词与它紧邻。
       *
       * 认：
       *   帮我建立个新的工作区 / 新建一个工作区 / 开个 dsh 工作区 / 建工作区
       * 不认（交给普通对话）：
       *   建个项目 / 开个新项目 / 整理一下目录 / 建 git 仓库
       */
      test: /(建|开|新建|创建|建立|起)[立]?\s*[一二几]?\s*(个|一个)?\s*(新的?|dsh\s*的?)?\s*(工作区|工作空间)/i,
      hint: [
        '〔信箱·种子〕人类要用本插件新建 DSH 工作区。',
        '',
        '这是**确切动作**：在指定目录登记 DSH workspace + 立刻开一个会话（session_init_workspace）。',
        '',
        '只问缺的两件事，一次问完：',
        '  1. 目录放哪（没给就用 ask_user_question 让人选，不要自己往 C 盘或系统目录建）',
        '  2. 项目叫什么',
        '',
        '**不要问「你要建哪种工作区」「拿来做什么」「要什么技术栈骨架」「要不要 README/AGENTS.md」**——',
        '那些不是本插件的事。本插件只登记 workspace 并开会话。',
        '',
        '若返回 AGENT_CREATE_DISABLED：不要绕路，告诉人类去 设置 → 会话编排 → 安全 开启。',
        '细节见 docs/AGENT-GUIDE.md §2.5。',
      ].join('\n'),
    },
    {
      id: 'register-friend',
      // 「帮我注册个」「把你注册个」「注册成 xx」「给他注册个名字」
      // 宽：只要出现「注册/登记」就算，后面跟人称或「个」更好；
      // 但排除「把 A 加到 B」这种纯编程语境（那个词是「加」不是「注册」）。
      test: /(注册|登记)|添加\s*(个|一个)?\s*(好友|名字)|把\s*(\S{1,12})\s*(注册|登记)/,
      hint: [
        '〔信箱·种子〕人类想做好友注册。分两种，别搞混：',
        '- 注册**自己**（当前会话）→ 调 session_register_name，或让人类用 /register-me。',
        '- 注册**别人** → 先确认目标会话：给 id 最省事，只给工作区名就先查会话列表；',
        '  对不上就列出候选让人类挑，不要报格式错。确认后调 /register-peer 或 session_register_name。',
        '名字随便写就行，插件会自动清洗（空格折连字符、标点删掉）；不要要求人类按格式写。',
        '想改名就用同样的方式再注册一次。',
      ].join('\n'),
    },
    {
      id: 'send-letter',
      // 「给 xx 发个信息」「通知一下 xx」「让 xx 知道」
      test: /(发|寄|送)\s*(个|一条|一封)?\s*(信|信息|消息)|通知\s*(一下|他|她|它)/,
      hint: [
        '〔信箱·种子〕人类想发信。流程：',
        '1. 确认收件人：用 session_list_names 或 mail_friends 找名字；不确定就列出候选问人类。',
        '2. 收件人还没注册就先注册（session_register_name / /register-peer）。',
        '3. 用 mail_send 发信，type 按内容选，急事加 urgent: true。',
        '4. 发完告诉人类：信 id、当前状态、对方默认不会被弹窗打扰（会自己在开工时取）。',
      ].join('\n'),
    },
    {
      id: 'any-session',
      // 「跳/切/打开 xx 会话」「去 xx 那里」
      test: /(跳|切|换|打开|去)\s*(到)?\s*(\S{0,10})\s*(会话|对话|窗口)/,
      hint: [
        '〔信箱·种子〕人类想跳到另一个会话。用 session_jump 排队一次跳转；',
        '目标不确定就先用 session_list_names / 会话列表给出候选让人类挑，不要瞎跳。',
      ].join('\n'),
    },
  ]

  /** 从一条人类消息里认出意图，返回 hint 文本或 undefined。 */
  function seedFor(messages) {
    for (const message of messages || []) {
      if (!message || message.role !== 'user') continue
      // 只认人类亲手发的话：机器消息带 source，跳过
      if (message.source && message.source.kind && message.source.kind !== 'user') continue
      const text = (message.content || [])
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (!text) continue
      // 已经是插件自己的卡片/命令，别再种一遍
      if (/^〔信箱|^\/register|^\/注册/.test(text.trim())) continue
      for (const pattern of SEED_PATTERNS) {
        if (pattern.test.test(text)) return { id: pattern.id, hint: pattern.hint }
      }
    }
    return undefined
  }

  if (dispatcher) ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      throw error
    }
    try {
      if (decision && decision.kind === 'enter') {
         await mailbox.noteStep(payload && payload.agent, decision.messages)
         await handleGroupCommand(payload && payload.agent, decision.messages)
         // 自然语言种子：只在本回合第一步判断一次，命中才追加提示，不拦截人类消息。
         if (!payload || payload.step === 1) {
           const seed = seedFor(decision.messages)
           if (seed) {
             // 人类亲口说了建会话意图 → 给这个会话记一次授权，
             // 这样 agent 随后调 init_workspace 时不会被门控拦住。
             if (seed.id === 'init-workspace') grantHumanPermit(payload && payload.agent && payload.agent.id, 'seed')
             decision = {
               ...decision,
               messages: [
                 ...decision.messages,
                 {
                   id: randomUUID(),
                   role: 'user',
                   content: [{ type: 'text', text: seed.hint }],
                   source: { kind: 'runtime-context' },
                 },
               ],
             }
             log('seed fired:', seed.id)
           }
         }
         // 开工横幅：每回合第一步、且真有未读时才插一行。
         // source 用 runtime-context，是给模型的上下文，不是"人类说了一句话"。
         if (!payload || payload.step === 1) {
           const banner = await mailbox.stepBanner(payload && payload.agent)
           // 横幅没出现时留一行日志：否则「没有未读」和「step 不是 1」
           // 在排查时完全看不出区别（实验室指出这一点）。
           if (!banner) {
             try {
               const agentId = payload && payload.agent && payload.agent.id
               log('banner skipped: no unread for', agentId ? agentId.slice(0, 20) : '(no agent)')
             } catch {}
           }
           if (banner) {
             decision = {
               ...decision,
               messages: [
                 ...decision.messages,
                 {
                   id: randomUUID(),
                   role: 'user',
                   content: [{ type: 'text', text: banner }],
                   source: { kind: 'runtime-context' },
                 },
               ],
             }
           }
         }
       }
    } catch (error) {
      log('mailbox pre-step failed: ', error && error.message)
    }
    return decision
  })

  if (dispatcher) ctx.on('agent/status', ({ agent, status }) => {
    void noteFriendState(agent, status).catch((error) => log('friend state failed: ', error && error.message))
    void mailbox.noteStatus(agent, status).catch((error) => log('mailbox sentinel failed: ', error && error.message))
  })

  ctx.effect(() => {
    if (!dispatcher) return () => {}
    void mailbox.sweepAtStart().then((result) => log('mailbox cold start sweep: ', JSON.stringify(result))).catch((error) => log('mailbox cold sweep failed: ', error && error.message))
    void cleanupSchedules().catch(() => {})
    void sweepFriends(true).catch(() => {})
    return () => {}
  })

  ctx.effect(() => {
    const routes = dispatcher
      ? [registerNotifyRoute(), registerFriendsRoute(), registerConfigRoute(), registerClientReportRoute(), registerJumpLookupRoute(), registerFlagUseRoute(), registerBackLookupRoute(), registerBackConsumeRoute(), registerJumpRecordRoute(), registerAutoJumpRoute(), registerAutoJumpUsedRoute()]
      : []
    const disposers = [...routes, registerTools(), registerSlashCommands()]
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    if (!dispatcher) return () => {}
    const timer = setInterval(() => {
      void tick()
    }, cfg.pollMs)
    void tick()
    return () => clearInterval(timer)
  })
}