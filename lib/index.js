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
  const humanPermits = new Map()
  const HUMAN_PERMIT_TTL_MS = 10 * 60 * 1000

  /** 人类亲口要求建会话 → 记一次授权。 */
  function grantHumanPermit(sessionId, note) {
    if (!sessionId) return
    humanPermits.set(sessionId, { at: Date.now(), note: note || '' })
  }

  /** 取用一次授权（用后即消耗，过期的清掉）。 */
  function takeHumanPermit(sessionId) {
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
    const limit = Number.isFinite(request.maxReplyChars) ? request.maxReplyChars : cfg.maxReplyChars
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : cfg.replyTimeoutMs
    const result = { id, ok: false, startedAt, root }

    try {
      const action = request.action === undefined ? 'deliver' : request.action
      const ACTIONS = ['deliver', 'sessions', 'events', 'init_workspace', 'handoff', 'notify', 'relay', 'list_children', 'jump', 'delete_workspace', 'mail_send', 'mail_ack', 'mail_list', 'mail_status', 'mail_pause', 'mail_inbox', 'mail_friends', 'mail_group', 'peer_state', 'commands']
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
        if (cfg.allowAgentCreateSession !== true && !takeHumanPermit(callerSession)) {
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
        if (cfg.allowAgentCreateSession !== true && !takeHumanPermit(handoffCaller)) {
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
    return { ok: false, id, error: { message: 'queue timeout (' + timeoutMs + 'ms）', code: 'QUEUE_TIMEOUT' } }
  }

  /** 会话好友表：<root>/friends.json，{friendlyName: {sessionId, cwd, updatedAt}}。 */
  const FRIENDS_FILE = () => join(root, 'friends.json')
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
          for (const row of list) {
            const archived = row && row.archivedSessionIds
            if (Array.isArray(archived)) ids.push(...archived)
          }
          archivedCache = { at: Date.now(), ids: new Set(ids) }
          return archivedCache.ids
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
    const intervalMs = 30 * 60 * 1000
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
          const table = await loadFriends()
          const target = table[name]
          if (!target || !target.sessionId) return { ok: false, error: { message: 'unknown friend: ' + name, code: 'FRIEND_NOT_FOUND' } }
          const myCwd = caller ? await sessionCwdOf(caller) : undefined
          // 与 resolveFriend 保持同一判据：同区与嵌套目录放行，只有彼此无关的工作区才需要 allowCrossWorkspace
          if (cfg.allowCrossWorkspace !== true && workspaceRelation(myCwd, target.cwd) === 'other') {
            return { ok: false, error: { message: 'cross-workspace delivery is disabled (allowCrossWorkspace); ' + String(myCwd || '?') + ' vs ' + String(target.cwd || '?'), code: 'CROSS_WORKSPACE_DISABLED' } }
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

async function autoRegisterSession(sessionId, cwd, wanted) {
  const table = await loadFriends()
  const existing = Object.entries(table).find(([, row]) => row && row.sessionId === sessionId)
  if (existing) return { name: existing[0], created: false, sessionId, cwd: existing[1].cwd || cwd }
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
  table[name] = { sessionId, cwd, workspace: cwd, updatedAt: new Date().toISOString(), auto: true }
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
      if (callerCwd && row.cwd && !samePath(row.cwd, callerCwd) && cfg.allowCrossWorkspace !== true) {
        cross.push(name)
        continue
      }
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
      const text = String(raw || '').trim()
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

      // 3) 剩下的当工作区线索
      const leftover = rest.split(/\s+/).filter(Boolean).join(' ').trim()
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

    const registerOne = async (name, description, hint, handler) => {
      try {
        return commands.register({ name, description, input: { hint }, handler })
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
        '把自己登记成可寻址的名字（别人可以按名字发信或在 @ 里找到你）',
        '名字，例如 本地-c91e 或 Super-agent-lead',
        async (invocation) => {
          const rawInput = String((invocation && invocation.rawInput) || '').trim()
          const agentId = invocation && invocation.agent ? invocation.agent.id : undefined
          if (!agentId) return fail('无法确定当前会话')
          if (!rawInput) return fail('用法：/register-me <名字>\n例如：/register-me 本地-c91e')
          // 宽进严出：名字不合法就清洗后直接注册，并把改成了什么告诉用户
          const cleaned = sanitizeFriendName(rawInput)
          if (!cleaned.name) {
            return fail('这个名字里没有一个可用字符，换一个吧（字母、数字、下划线、连字符、汉字都行）。')
          }
          const cwd = await sessionCwdOf(agentId)
          const registered = await autoRegisterSession(agentId, cwd, cleaned.name)
          if (!registered || registered.name !== cleaned.name) {
            return fail('注册失败：' + ((registered && registered.reason) || 'unknown'))
          }
          return ok(
            '〔信箱·注册〕已登记为 `' + cleaned.name + '`。' +
              (cleaned.changed
                ? '\n（你写的是 `' + rawInput + '`，因为名字只能用字母、数字、下划线、连字符和汉字，我改成了上面这个。）'
                : '') +
              '\n别人可按此名字发信，或在 `@` 里找到你。名字是全局的，同名后注册者会覆盖先注册者。' +
              '\n想改名：再用 /register-me 一个新名字即可。',
          )
        },
      ),
    )

    // ── /register-peer ────────────────────────────────────────────
    disposers.push(
      registerOne(
        'register-peer',
        '把另一个会话加进好友表并命名（会话 id、工作区名给多少算多少，缺的我来补）',
        '说个会话id、或工作区名、或想叫的名字，都给不全也没关系',
        async (invocation) => {
          const rawInput = String((invocation && invocation.rawInput) || '').trim()
          const parsed = parsePeerArgs(rawInput)
          const sessions = await storedSessions().catch(() => [])
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
              // id 对不上：不报错，给候选
              const tops = (sessions || []).slice(0, 8)
              const lines = await Promise.all(
                tops.map(async (row) => '  ' + (await friendly(row.sessionId)) + '  ' + row.sessionId),
              )
              return fail(
                '没找到这个会话 id：' + parsed.sessionId + '\n' +
                  (lines.length > 0
                    ? '下面是本机现有的会话，复制其中一行再发一次即可：\n' + lines.join('\n')
                    : '本机暂时没有可注册的会话。'),
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
            const registered = await autoRegisterSession(parsed.sessionId, cwd, wanted)
            if (!registered || !registered.name) {
              return fail('注册没成功：' + ((registered && registered.reason) || 'unknown'))
            }
            return ok(
              '〔信箱·注册〕已把 ' + parsed.sessionId + ' 登记为 `' + registered.name + '`。' +
                (autoNamed ? '\n名字是我按「工作区名 + 会话尾号」自动取的。' : '') +
                (renamedA ? '\n（你写的名字含不能用的字符，我改成了上面这个。）' : '') +
                '\n想换名字：/register-peer ' + parsed.sessionId + ' "新名字"',
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
            if (all.length === 0) return fail('本机暂时没有可注册的会话。')
            const lines = await Promise.all(
              all.map(async (row) => '  ' + (await friendly(row.sessionId)) + '  ' + row.sessionId),
            )
            return fail(
              (hint ? '没有匹配「' + hint + '」的会话。' : '') +
                '现有会话如下，复制一行再发一次即可：\n' + lines.join('\n'),
            )
          }

          if (candidates.length === 1) {
            // 唯一命中：直接注册，不让用户再确认一次
            const target = candidates[0]
            const rawWanted = parsed.name || (await friendly(target.sessionId))
            const cleanB = sanitizeFriendName(rawWanted)
            if (!cleanB.name) return fail('这个名字里没有一个可用字符，换一个吧。')
            const wanted = cleanB.name
            const registered = await autoRegisterSession(target.sessionId, target.cwd, wanted)
            if (!registered || !registered.name) {
              return fail('注册没成功：' + ((registered && registered.reason) || 'unknown'))
            }
            return ok(
              '〔信箱·注册〕已把 ' + target.sessionId + ' 登记为 `' + registered.name + '`。' +
                (cleanB.changed && parsed.name ? '\n（你写的名字含不能用的字符，我改成了上面这个。）' : ''),
            )
          }

          // 多个命中：列出来让用户挑，不逼它记格式
          const lines = await Promise.all(
            candidates.map(async (row) => '  ' + (await friendly(row.sessionId)) + '  ' + row.sessionId),
          )
          return fail(
            '匹配到 ' + candidates.length + ' 个会话，请挑一个再发一次（只发 id 就行）：\n' + lines.join('\n'),
          )
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
      // 「帮我建个工作区」「开个新项目的工作区」「我想新建一个工作区」…
      test: /(建|开|新建|创建|起)\s*[立]?\s*[一二几]?\s*(个|一个)?\s*新?\s*的?\s*(工作区|工作空间|项目|workspace)/i,
      hint: [
        '〔信箱·种子〕人类想新建工作区。走这条流程：',
        '1. 先问清：目录放哪、项目叫什么。预设按设置决定——',
        '   · 设置里开了「新建会话时先问用哪个预设」→ 必须列出可用预设让人挑；',
        '   · 没开 → 不问，直接交给 DSH 默认预设。',
        '2. 目录没给就用 ask_user_question 让人类选，不要自己往 C 盘或系统目录里建。',
        '3. 调 session_init_workspace（参数 project / workspace 目录 / preset / title）完成建立。',
        '   · 设置里「允许 Agent 通过本插件新建会话」是关的 → 这个工具会返回 AGENT_CREATE_DISABLED。',
        '     这时不要绕路上脚本或手工建目录，直接告诉人类：需要在设置 → 会话编排 → 安全里开启，',
        '     或者改用 DSH 原生的新建会话。',
        '4. 建好后告诉人类：工作区已建在哪、会话 id 是什么、自动注册的名字是什么。',
        '5. 需要对方也注册时再调 session_register_name 或 /register-peer，不要替人类决定。',
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