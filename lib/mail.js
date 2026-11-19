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
 * 磁盘（v6，一切按工作区走）：
 *   <工作区>/.dsh-mail/_letters.json   该工作区的信件状态
 *   <工作区>/.dsh-mail/envelope/<id>.<side>.md  两侧各一份信封本体
 *   <工作区>/.dsh-mail/_index.json     状态索引（A/P/R/B/D 路径）
 *   <工作区>/.dsh-mail/_ledger.json    每次动作的留痕
 *   <工作区>/.dsh-mail/group.json      会话群路由表
 */

/**
 * ── 信封标准格式与状态字母表（v6 定稿；旧脚本 mail_send.py / 邮箱模板 不在本机，本表为自定并落码）──
 *
 * 一封信只有一个本体，但**两侧各留一份**（发信方 / 收信方），用 side 字段区分：
 *
 *   <工作区根>/.dsh-mail/envelope/<mail_id>.<side>.md
 *
 * 信封正文 = YAML 头 + 空行 + Markdown 正文：
 *
 *   ---
 *   mail_id: M-YYYYMMDD-NNNN
 *   type: S-PROGRESS            # 取值见 VALID_TYPES
 *   from: <发信方注册名>
 *   to: <收信方注册名>
 *   timestamp: 2026-11-17T09:00:00.000Z
 *   status: awaiting_ack        # 见下表，目录与它严格绑定
 *   side: from                  # from | to，标明这份留痕属于哪一侧
 *   dir_owner: session-xxxx     # 该侧会话 ID，归档/已处理时用它区分
 *   ack_of: M-...               # 仅 S-ACK
 *   path: S>P>D                 # 状态索引：这封信到目前为止走过的路径
 *   ---
 *   <正文>
 *
 * 状态 ↔ 目录 ↔ 字母（字母只用于 path 索引，便于一眼看出过程）：
 *
 *   取字母规则：**一律取状态英文名首字母**（pending=P、awaiting_ack=A、running=R、blocked=B、done=D）。
 *
 *   status        目录     字母   含义
 *   pending       已接收   P      到了对端，未读未动
 *   awaiting_ack  已发送   A      已出手，等回执
 *   running       处理中   R      对端已开始处理
 *   blocked       待办     B      投不出去 / 超时没人回 / 显式阻塞
 *   done          已解决   D      闭环
 *
 * path 规则：只追加不回退；分支照实记（如 A>B>D）。典型：发信方 A>R>D，收信方 P>R>D。
 */
/** 字母 = 状态英文名首字母（人类 10:26 定）；同一状态的多种内部写法归一 */
export const STATUS_CODES = {
  pending: 'P',
  awaiting_ack: 'A',
  pushed: 'A',
  delivered: 'R',
  running: 'R',
  acked: 'R',
  blocked: 'B',
  expired: 'E',
  done: 'D',
}

/** 字母 → 目录名（五件套；同一状态的多种内部写法归一） */
export const STATUS_DIRS = {
  pending: '已接收',
  awaiting_ack: '已发送',
  pushed: '已发送',
  delivered: '处理中',
  running: '处理中',
  acked: '处理中',
  blocked: '待办',
  expired: '已过期',
  done: '已解决',
}
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VALID_TYPES = new Set([
  'S-PROJ-INIT', 'S-HANDOVER', 'S-PROGRESS', 'S-ACK', 'S-TODO-NOTICE', 'S-EXPIRE',
  'T-ASSIGN', 'T-ACCEPT-REQ', 'T-ACCEPT-RES',
  'I-PLAN-FUSE', 'I-CODE-FUSE',
  'R-PLAN-PROPOSAL', 'R-HUMAN-DECISION', 'R-REJECT', 'R-CLOSEOUT', 'R-ALERT',
])

const REQUIRED_EXTRA = {
  'S-ACK': ['ack_of'],
  'S-TODO-NOTICE': ['todo_of', 'stuck_since', 'elapsed_minutes', 'reason'],
  'S-EXPIRE': ['expire_of', 'reason'],
}

const TODO_VAGUE = new Set(['卡住了', '没进展', '有问题'])
const MARK = /〔信箱·(M-\d{8}-\d{4})〕/g

/** 旧送达节拍（v6 遗留）；v0.2 起不再重推，保留常量只为读旧账本时不炸。 */
const SENTINEL_DELAYS = [10000, 5000, 3000, 2000]

/**
 * 信使通道默认参数（v0.2 §5–§8）。
 *   intervalMs    通道节奏：一条一条投，投完等这么久再取下一条
 *   maxAttempts   单条投递失败重试上限，超过即 dropped
 *   busyHoldMs    目标持续在任务中超过这么久 → 信转待办（holding）
 *   staleAfterMs  信封静置超过这么久仍未处理 → 允许补一次催收（看门狗）
 *   digestGapMs   形态 B 摘要的最小间隔；数字没变不重发
 *   maxNoticeA    单封最多催收次数（含首次）
 */
const COURIER_DEFAULTS = { intervalMs: 5000, maxAttempts: 3, busyHoldMs: 180000, staleAfterMs: 1800000, digestGapMs: 600000, maxNoticeA: 2 }

/** 背压豁免：这两类是对已有信的动作，不该被它自己挡住。 */
const BACKPRESSURE_EXEMPT = new Set(['S-ACK', 'S-TODO-NOTICE', 'S-EXPIRE'])

/** 同一封信在两份文件里出现（历史重复）时，按这个顺序取更靠后的那份。 */
const STATUS_RANK = { pending: 0, pushed: 1, delivered: 2, blocked: 3, acked: 4, done: 5, expired: 6 }

/** 真正「还在途、对方还没见过」的状态。门控与在途闸门只认这三种；
    历史版本留下的 `running` 之类未知状态不许把通道和唤醒永久堵死（实盘遇到过 5 封）。 */
const LIVE_STATUS = new Set(['pending', 'pushed', 'delivered'])

/** controller.prompt 的 signal 参数必传（0.5.0 复验：缺参数会抛 throwIfAborted）。 */
const signalNow = () => new AbortController().signal

export function receiptOf(mailId) {
  return '〔信箱·' + mailId + '〕'
}

/** 信件 id 只允许这套字符：它会被直接拼进信封文件名，放行 `..` 就等于允许写到工作区外。 */
const SAFE_MAIL_ID = /^[A-Za-z0-9._-]{1,80}$/

export function isSafeMailId(value) {
  if (typeof value !== 'string') return false
  if (!SAFE_MAIL_ID.test(value)) return false
  if (value.includes('..')) return false
  if (value.startsWith('.')) return false
  return true
}

export function validateLetter(meta) {
  const issues = []
  for (const key of ['mail_id', 'type', 'from', 'to']) if (!meta[key]) issues.push('缺必填字段: ' + key)
  if (meta.mail_id && !isSafeMailId(String(meta.mail_id))) issues.push('mail_id 含非法字符（只允许字母数字 . _ -，且不能含 .. 或以 . 开头）: ' + meta.mail_id)
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
  const ackTimeoutMs = options.ackTimeoutMs
  const service = options.service
  const log = options.log || (() => {})

  const cwdOf = options.cwdOf || (async () => undefined)
  const listedCwds = options.cwds || (async () => [])
  const fallbackCwd = options.fallbackCwd
  /** 自动建群阈值：A↔B 往返回信达到这么多封就建群（v6 补，默认 3）。 */
  const groupThreshold = Math.max(2, Number(options.groupAutoThreshold) || 3)
  /** 软释放：对方一直不 ack 时，等这么久就放行下一封（0 = 关闭，只认显式 ack）。 */
  const releaseMs = Number.isFinite(Number(options.backpressureReleaseMs)) ? Math.max(0, Number(options.backpressureReleaseMs)) : 600000
  /** 会话是否已归档（由 Host 侧注入；缺省视为未归档）。 */
  const isArchived = typeof options.isArchived === 'function' ? options.isArchived : async () => false
  /** mailId → timer */
  const timers = new Map()
  /** 聚合缓存：每封信都带 _cwd（它落盘的工作区根） */
  let letters = []
  let seq = {}
  let loaded = false
  /** cwd → { box, loaded }；letters 由聚合缓存按 _cwd 分片写回 */
  const boxes = new Map()
  function boxOf(cwd) {
    let st = boxes.get(cwd)
    if (!st) {
      st = { box: workspaceBox(cwd), loaded: false }
      boxes.set(cwd, st)
    }
    return st
  }

  /** 汇总各工作区的 _letters.json；第一次把已注册会话的工作区都拉一遍。 */
  async function load() {
    if (loaded) return
    const cwds = new Set(boxes.keys())
    try {
      for (const cwd of (await listedCwds()) || []) if (typeof cwd === 'string' && cwd) cwds.add(cwd)
    } catch (error) {
      log('listedCwds failed', error && error.message)
    }
    for (const cwd of cwds) await loadOne(cwd)
    // 通道跟信件同批加载：重启后排队条目直接从 _courier.json 续上
    for (const cwd of cwds) await courierOf(cwd)
    loaded = true
  }

  async function loadOne(cwd) {
    const state = boxOf(cwd)
    if (state.loaded) return
    try {
      const raw = JSON.parse(await readFile(state.box.state, 'utf8'))
      for (const letter of Array.isArray(raw.letters) ? raw.letters : []) {
        // 落盘文件也可能被改过：非法 id（含 .. / 盘符 / 路径分隔符）直接丢弃，
        // 否则它会被拼进信封路径，读到就等于允许穿越。
        if (!letter || !letter.id || !isSafeMailId(String(letter.id))) continue
        letter._cwd = cwd
        const dup = letters.find((existing) => existing.id === letter.id)
        if (dup) {
          // 历史遗留的重复副本：取状态更靠前的那份（acked/done 盖过 delivered），
          // 否则一次 ack 落在哪份文件上，重启后就取决于加载顺序。
          const mine = STATUS_RANK[letter.status] ?? -1
          const theirs = STATUS_RANK[dup.status] ?? -1
          if (mine > theirs) {
            // 只合并已知字段，别让落盘文件里的 __proto__ 之类键改掉对象原型
            for (const [key, value] of Object.entries(letter)) {
              if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
              dup[key] = value
            }
          }
          continue
        }
        letters.push(letter)
      }
      for (const [key, value] of Object.entries(raw.seq || {})) {
        if (Number.isFinite(Number(value))) seq[key] = Math.max(Number(seq[key]) || 0, Number(value))
      }
    } catch {
      // 没有文件 = 空箱
    }
    state.loaded = true
  }

  /** 写入串行化：通道 drain 与定时器会并发落盘，Windows 上 rename 撞锁会 EPERM。 */
  let writeQueue = Promise.resolve()
  function serialize(task) {
    const run = writeQueue.then(task)
    writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 按 _cwd 分片写回各自工作区（一封只存一处，信封另存两份）。 */
  async function save() {
    return serialize(saveNow)
  }

  async function saveNow() {
    const groups = new Map()
    for (const letter of letters) {
      if (!letter._cwd) continue
      if (!groups.has(letter._cwd)) groups.set(letter._cwd, [])
      groups.get(letter._cwd).push(letter)
    }
    for (const [cwd, list] of groups) {
      const state = boxOf(cwd)
      let registered = true
      try {
        await readFile(state.box.ledger, 'utf8')
      } catch {
        registered = false
      }
      if (!registered) continue
      await mkdir(dirname(state.box.state), { recursive: true })
      // 与磁盘合并再写：进程里可能只有局部视图（新实例、加载失败、多实例并存），
      // 直接覆盖会把别人的信件整批抹掉。磁盘上的信只要能读到就保留，内存里的更新优先。
      try {
        const raw = JSON.parse(await readFile(state.box.state, 'utf8'))
        for (const [key, value] of Object.entries(raw.seq || {})) {
          if (Number.isFinite(Number(value))) seq[key] = Math.max(Number(seq[key]) || 0, Number(value))
        }
        const memory = new Set(list.map((letter) => letter.id))
        for (const letter of Array.isArray(raw.letters) ? raw.letters : []) {
          if (!letter || !letter.id || memory.has(letter.id)) continue
          letter._cwd = cwd
          list.push(letter)
          letters.push(letter)
          memory.add(letter.id)
        }
      } catch {
        // 磁盘上没有这个文件，或读不动：照常写内存里的这份
      }
      const tmp = state.box.state + '.' + Math.random().toString(16).slice(2, 8) + '.tmp'
      // sentinel.timer 是 Timeout 对象，不能进 JSON；落盘只存可序列化的字段
      const plain = list.map((letter) => {
        if (!letter.sentinel) return letter
        const { timer, ...rest } = letter.sentinel
        return { ...letter, sentinel: rest }
      })
      await writeFile(tmp, JSON.stringify({ letters: plain, seq }, null, 2), 'utf8')
      await rename(tmp, state.box.state)
    }
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

  /* ── 会话群（v6 补）：group.json 只做路由，不代收回执 ───────────── */

  async function readGroup(cwd) {
    const state = boxOf(cwd)
    try {
      const data = JSON.parse(await readFile(state.box.group, 'utf8'))
      return { groups: Array.isArray(data.groups) ? data.groups : [] }
    } catch {
      return { groups: [] }
    }
  }

  async function writeGroup(cwd, data) {
    const state = boxOf(cwd)
    await writeFile(state.box.group, JSON.stringify(data, null, 2), 'utf8')
  }

  function isTaskChannel(group) {
    return Boolean(group && group.scope === 'task')
  }

  function groupsOf(groups, sessionId) {
    return groups.filter((group) => Array.isArray(group.members) && group.members.includes(sessionId))
  }

  /** 普通群优先；只剩任务专用通道时也返回它。 */
  function sharedGroup(groups, a, b) {
    const both = groups.filter((group) => Array.isArray(group.members) && group.members.includes(a) && group.members.includes(b))
    return both.find((group) => !isTaskChannel(group)) || both[0]
  }

  /** 任务专用通道不参与交集合并，否则「专用」语义会被并群吃掉。 */
  function mergeableGroupsOf(groups, sessionId) {
    return groupsOf(groups, sessionId).filter((group) => !isTaskChannel(group))
  }

  /** 交集合并：SA、SC 有交集就并成一个群，否则新建 {a,b}。 */
  /** 群 id 必须唯一：只用毫秒时间戳时，同一毫秒建两个群会撞 id，并群时按 id 删除会连无关群一起删。 */
  function nextGroupId(groups) {
    const base = 'G-' + Date.now().toString(36).toUpperCase()
    let id = base
    for (let n = 1; (groups || []).some((g) => g.id === id); n += 1) id = base + '-' + n
    return id
  }

  function planGroup(groups, a, b, auto) {
    const sa = new Set([a])
    const sc = new Set([b])
    const used = new Set()
    for (const group of mergeableGroupsOf(groups, a)) {
      used.add(group.id)
      for (const member of group.members) sa.add(member)
    }
    for (const group of mergeableGroupsOf(groups, b)) {
      used.add(group.id)
      for (const member of group.members) sc.add(member)
    }
    const intersection = [...sa].filter((member) => sc.has(member))
    const id = nextGroupId(groups)
    if (intersection.length > 0) {
      const members = [...new Set([...sa, ...sc])]
      return { action: 'merge', id, members, mergedFrom: [...used], auto }
    }
    return { action: 'new', id, members: [a, b], mergedFrom: [], auto }
  }

  async function upsertPair(cwd, a, b, auto) {
    const data = await readGroup(cwd)
    const existing = sharedGroup(data.groups, a, b)
    if (existing && !isTaskChannel(existing)) return { ok: true, changed: false, group: existing }
    if (existing && isTaskChannel(existing)) {
      // 这对会话原本只有一条任务专用通道 → 提升为普通群，避免同一对人挂两个群
      existing.scope = undefined
      existing.owner = undefined
      existing.expiresAt = undefined
      existing.promotedAt = new Date().toISOString()
      existing.auto = auto === true
      await writeGroup(cwd, data)
      log('task channel promoted', existing.id, existing.members.join(','))
      return { ok: true, changed: true, group: existing, merged: false, promoted: true }
    }
    const plan = planGroup(data.groups, a, b, auto)
    if (plan.action === 'merge') data.groups = data.groups.filter((group) => !plan.mergedFrom.includes(group.id))
    data.groups.push({
      id: plan.id,
      name: '群-' + plan.id.slice(-4),
      members: plan.members,
      createdAt: new Date().toISOString(),
      auto: auto === true,
      mergedFrom: plan.mergedFrom,
    })
    await writeGroup(cwd, data)
    log('group ' + plan.action, plan.id, plan.members.join(','))
    return { ok: true, changed: true, group: data.groups[data.groups.length - 1], merged: plan.action === 'merge' }
  }

  /** 群只做路由：目标在群里时给出群 id，投递仍按成员表查到会话 ID 直投。 */
  async function routeOf(letter) {
    const cwd = letter.toCwd || letter.fromCwd
    if (!cwd || !letter.fromSession || !letter.toSession) return null
    const data = await readGroup(cwd)
    return sharedGroup(data.groups, letter.fromSession, letter.toSession) || null
  }

  /** A↔B 往返达到阈值 → 自动建群，并告知双方。 */
  async function maybeGroup(letter) {
    const a = letter.fromSession
    const b = letter.toSession
    if (!a || !b) return
    const cwd = letter.toCwd || letter.fromCwd
    if (!cwd) return
    const data = await readGroup(cwd)
    if (sharedGroup(data.groups, a, b)) return
    const roundTrips = letters.filter(
      (item) => (item.fromSession === a && item.toSession === b) || (item.fromSession === b && item.toSession === a),
    ).length
    if (roundTrips < groupThreshold) return
    const result = await upsertPair(cwd, a, b, true)
    if (!result.changed) return
    await appendLedger(cwd, {
      at: new Date().toISOString(),
      mail_id: letter.id,
      side: 'to',
      note: 'group:' + (result.merged ? 'merged' : 'created'),
      groupId: result.group.id,
      members: result.group.members,
    }).catch((error) => log('group ledger failed', error && error.message))
    // 建群只记账，不投消息：这是路由变化，不需要谁去响应。
    // 旧版会给双方各发一条 prompt「你们已入群」，在会话里看起来像人说的话。
  }

    /** 某一侧的状态字母：P=已接收 A=已发送 R=处理中 B=待办 D=已解决。 */
  function sideCode(letter, side) {
    if (letter.status === 'expired') return 'E'
    if (letter.status === 'blocked') return 'B'
    if (letter.status === 'done') return 'D'
    if (letter.status === 'acked' || letter.status === 'delivered') return 'R'
    // 从待办重开、还没被对方消费：两侧都仍算待办 B，路径不因重开多一段字母。
    if (letter.reopened && !letter.deliveredAt && !letter.ackedAt) return 'B'
    return side === 'from' ? 'A' : 'P'
  }

  function sideDir(letter, side) {
    const code = sideCode(letter, side)
    // E 要落到「已过期」，别跟着 done 一起掉进「已解决」——实盘一封被撤销的信就这样显示成了 D
    return code === 'A' ? '已发送' : code === 'P' ? '已接收' : code === 'R' ? '处理中' : code === 'B' ? '待办' : code === 'E' ? '已过期' : '已解决'
  }

  function cwdForSide(letter, side) {
    return side === 'from' ? letter.fromCwd : letter.toCwd
  }

  async function appendLedger(cwd, event) {
    const state = boxOf(cwd)
    let ledger = { events: [] }
    try {
      ledger = JSON.parse(await readFile(state.box.ledger, 'utf8'))
    } catch {
      ledger = { events: [] }
    }
    if (!Array.isArray(ledger.events)) ledger.events = []
    ledger.events.push(event)
    if (ledger.events.length > 500) ledger.events = ledger.events.slice(-500)
    await writeFile(state.box.ledger, JSON.stringify(ledger, null, 2), 'utf8')
    state.loaded = true
  }

  async function updateIndex(cwd, letter, side) {
    const state = boxOf(cwd)
    const file = join(state.box.dir, '_index.json')
    let index = {}
    try {
      index = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      index = {}
    }
    const entry = index[letter.id] || { type: letter.type, from: letter.from, to: letter.to, sides: {} }
    const prev = entry.sides[side] && entry.sides[side].path
    const code = sideCode(letter, side)
    const path = prev ? (prev.endsWith(code) ? prev : prev + '>' + code) : code
    entry.sides[side] = {
      sessionId: side === 'from' ? letter.fromSession : letter.toSession,
      dir: sideDir(letter, side),
      code,
      path,
      updatedAt: new Date().toISOString(),
    }
    // __proto__ 之类的键不能污染原型：用无原型对象承接，并且只认合法 mail_id。
    const safeIndex = Object.create(null)
    for (const [key, value] of Object.entries(index)) safeIndex[key] = value
    safeIndex[letter.id] = entry
    index = safeIndex
    letter.paths = letter.paths || {}
    letter.paths[side] = path
    await writeFile(file, JSON.stringify(index, null, 2), 'utf8')
    return path
  }

  /** 两侧各留一份信封 + 状态索引 + 留痕；没有建箱（未注册）的工作区一律不写。 */
  async function archive(letter) {
    letter.paths = letter.paths || {}
    for (const side of ['from', 'to']) {
      const cwd = cwdForSide(letter, side)
      if (!cwd) continue
      try {
        const state = boxOf(cwd)
        let registered = true
        try {
          await readFile(state.box.ledger, 'utf8')
        } catch {
          registered = false
        }
        if (!registered) {
          log('skip envelope (workspace not registered)', letter.id, side, cwd)
          continue
        }
        await mkdir(state.box.envelope, { recursive: true })
        const sidePath = await updateIndex(cwd, letter, side)
        const head = [
          '---',
          'mail_id: ' + letter.id,
          'type: ' + letter.type,
          'from: ' + letter.from,
          'to: ' + letter.to,
          'timestamp: ' + letter.sentAt,
          'now_at: ' + new Date().toISOString(),
          'status: ' + sideDir(letter, side),
          'side: ' + side,
          'dir_owner: ' + ((side === 'from' ? letter.fromSession : letter.toSession) || 'unknown'),
          letter.ackOf ? 'ack_of: ' + letter.ackOf : '',
          'path: ' + sidePath,
          // v0.2：待办与通道状态写进信封头，重启后不用猜
          letter.todoSince ? 'todo_since: ' + letter.todoSince : '',
          'paused: ' + (letter.paused === true ? 'true' : 'false'),
          'notice_a: ' + (letter.noticeA || 0),
          'notice_b: ' + (letter.noticeB || 0),
          letter.queueSeq ? 'queue_seq: ' + letter.queueSeq : '',
          '---',
          '',
          letter.body,
        ].filter((line) => line !== '')
        await writeFile(join(state.box.envelope, letter.id + '.' + side + '.md'), head.join('\n') + '\n', 'utf8')
        await appendLedger(cwd, {
          at: new Date().toISOString(),
          mail_id: letter.id,
          side,
          dir: sideDir(letter, side),
          code: sideCode(letter, side),
          status: letter.status,
          note: letter.blockReason || null,
        })
      } catch (error) {
        log('archive failed', letter.id, side, error && error.message)
      }
    }
  }

  /**
   * 投递到目标会话：优先走宿主「自动化任务」通道（界面上是一张提醒卡），
   * 不可用时退回 sessionController.prompt。
   */
  async function deliverNotice(letter, text, sessionId) {
    return sendNotice(sessionId || letter.toSession, text, letter.id)
  }

  /**
   * 投递到某个会话：只走 sessionController.prompt，不创建宿主「自动化任务」。
   * 这样目标会话不会多出 [SCHEDULE CHANGE] 注入，自动化任务列表也不会堆卡片。
   */
  async function sendNotice(target, text, label) {
    if (!target) return { queued: false, reason: 'no-target-session' }
    if (await isArchived(target)) return { queued: false, reason: 'target-archived' }
    const controller = service('sessionController')
    if (!controller) return { queued: false, reason: 'no-controller' }
    try {
      await controller.prompt({
        requestId: 'mail-' + (label || target) + '-' + Math.random().toString(16).slice(2, 8),
        sessionId: target,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, signalNow())
      return { queued: true, via: 'prompt' }
    } catch (error) {
      return { queued: false, reason: (error && error.message) || String(error) }
    }
  }

  /** 推送信封索引（来源 / 位置 / 状态），不注入正文。 */
  async function push(letter) {
    return deliverNotice(letter, await indexNotice(letter))
  }

  /**
   * 待办（held）：信被通道接管，卡片停投，等目标空闲或人工恢复。
   * v0.2 起不再立刻向两侧各投一张卡：收信方的催收与发信方的摘要都进通道排队，
   * 一条一条投；信封落 `paused: true`，重启后仍是暂停态。
   */
  async function block(letter, reason) {
    if (letter.status === 'blocked' || letter.status === 'done' || letter.status === 'acked' || letter.status === 'expired') return
    letter.status = 'blocked'
    letter.blockedAt = new Date().toISOString()
    letter.todoSince = letter.todoSince || letter.blockedAt
    letter.paused = true
    letter.blockReason = reason
    clearTimer(letter.id)
    clearHoldTimer(letter.id)
    clearSentinel(letter)
    await save()
    await archive(letter)
    await enqueueTodo(letter, reason)
    armStaleWatch(letter)
    // 入队后立刻踢一次通道：否则要等下一个 idle 边才有人投，通知会白躺着
    scheduleDrain(0)
    log('mail held', letter.id, reason)
  }

  function clearTimer(mailId) {
    const timer = timers.get(mailId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(mailId)
    }
  }

  /* ── 信使通道（v0.2 §5–§8）────────────────────────────────────
     一个工作区一份 _courier.json，全局串行：取一条、投一条、歇 5 秒。
     投递以「对方消费了上一张卡」为闸门（在途 ≤ 1），不看秒数表。
  */

  const courierCfg = { ...COURIER_DEFAULTS, ...(options.courier || {}) }
  const couriers = new Map()
  const holdTimers = new Map()
  const staleTimers = new Map()
  let draining = false
  let drainTimer = null
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function courierOf(cwd) {
    let state = couriers.get(cwd)
    if (!state) {
      state = { cwd, loaded: false, seq: 0, paused: false, items: [], digests: {} }
      couriers.set(cwd, state)
    }
    if (state.loaded) return state
    try {
      const raw = JSON.parse(await readFile(workspaceBox(cwd).courier, 'utf8'))
      state.seq = Number(raw.seq) || 0
      state.paused = raw.paused === true
      state.items = Array.isArray(raw.items) ? raw.items : []
      state.digests = raw.digests && typeof raw.digests === 'object' ? raw.digests : {}
    } catch {
      // 没有文件 = 空通道
    }
    state.loaded = true
    return state
  }

  async function saveCourier(cwd) {
    return serialize(() => saveCourierNow(cwd))
  }

  async function saveCourierNow(cwd) {
    const state = await courierOf(cwd)
    let registered = true
    try {
      await readFile(boxOf(cwd).box.ledger, 'utf8')
    } catch {
      registered = false
    }
    if (!registered) return
    await mkdir(dirname(workspaceBox(cwd).courier), { recursive: true })
    await writeFile(workspaceBox(cwd).courier, JSON.stringify({ seq: state.seq, paused: state.paused, items: state.items, digests: state.digests }, null, 2), 'utf8')
  }

  async function enqueue(cwd, item) {
    if (!cwd) return null
    const state = await courierOf(cwd)
    state.seq += 1
    const entry = { seq: state.seq, state: 'queued', attempts: 0, enqueuedAt: new Date().toISOString(), lastNoticeAt: null, ...item }
    state.items.push(entry)
    await saveCourier(cwd)
    return entry
  }

  /** 待办入场：收信方催收（形态 A）＋ 发信方摘要（形态 B）。 */
  async function enqueueTodo(letter, reason) {
    const cwd = letter._cwd
    if (!cwd) return
    // 同一封信在通道里只留一条待投条目：发信时就排过的那条要作废，否则会投两次
    for (const state of couriers.values()) {
      let changed = false
      for (const item of state.items) {
        if (item.mailId !== letter.id) continue
        if (item.state === 'queued' || item.state === 'held') {
          item.state = 'done'
          item.retired = 'duplicate'
          changed = true
        }
      }
      if (changed) await saveCourier(state.cwd)
    }
    if (letter.toSession) {
      const busy = await targetBusy(letter.toSession)
      const entry = await enqueue(cwd, {
        mailId: letter.id,
        sessionId: letter.toSession,
        fromSession: letter.fromSession || null,
        form: 'a',
        urgent: letter.urgent === true,
        expireOf: letter.expireOf || null,
        // 卡还没被消费过：再投一张只是往队列里堆纸，先持有；消费过但没回执的才值得催
        state: busy || !letter.deliveredAt ? 'held' : 'queued',
        reason: reason || null,
      })
      if (entry) letter.queueSeq = entry.seq
    }
    if (letter.expireOf) await expireOriginal(letter)
    if (letter.fromSession) await enqueueDigest(cwd, letter.fromSession)
  }

  /** 形态 B 去重：同一个发信方已有一条在排就不再排；数字没变且未到间隔也不排。 */
  async function enqueueDigest(cwd, sessionId) {
    const state = await courierOf(cwd)
    const pending = state.items.some((item) => item.form === 'b' && item.sessionId === sessionId && (item.state === 'queued' || item.state === 'held'))
    if (pending) return null
    const mine = letters.filter((letter) => letter.fromSession === sessionId && letter.status === 'blocked')
    if (mine.length === 0) return null
    const last = state.digests[sessionId]
    if (last && Number(last.count) === mine.length && Date.now() - Number(last.at || 0) < courierCfg.digestGapMs) return null
    // 快照：投递时这些信可能已经被重开成 pushed，再查就查不到了
    const names = {}
    for (const letter of mine) names[letter.id] = letter.to
    const oldest = Math.min(...mine.map((letter) => Date.parse(letter.todoSince || letter.blockedAt || '') || Date.now()))
    return enqueue(cwd, { mailId: null, sessionId, form: 'b', state: 'queued', mailIds: mine.map((letter) => letter.id), names, count: mine.length, oldest })
  }

  /**
   * 撤销/过期（S-EXPIRE）：把 expire_of 指向的那封标 expired，并作废它的待投条目。
   * 对事不对人：同一封原信重复撤销时幂等，不重复入队。
   */
  async function expireOriginal(letter) {
    if (!letter.expireOf) return { ok: false, reason: 'no expire_of' }
    const target = find(letter.expireOf)
    if (!target) return { ok: false, reason: 'target-not-found' }
    if (target.status === 'expired' || target.status === 'done') return { ok: true, already: true }
    target.status = 'expired'
    target.expiredAt = new Date().toISOString()
    target.expiredBy = letter.id
    // 已 acked 的信允许撤销（「别做了」是真实需求），但要把「先被接收、再被撤销」留在台账里，
    // 否则事后看只剩 E，分不清是没人理还是有人确认过又被叫停。
    if (target.ackedAt) target.expiredAfterAck = true
    clearTimer(target.id)
    clearHoldTimer(target.id)
    clearStaleTimer(target.id)
    clearSentinel(target)
    await retireItems(target.id, 'expired')
    await save()
    await archive(target)
    await appendLedger(target._cwd, {
      at: new Date().toISOString(),
      mail_id: target.id,
      side: 'to',
      note: 'expire:by:' + letter.id,
      reason: letter.reason || null,
    }).catch(() => {})
    return { ok: true, expired: target.id }
  }

  /** 结案后作废通道里针对这封信的待投条目（已投出去的不管）。 */
  async function retireItems(mailId, reason = 'acked') {
    for (const state of couriers.values()) {
      let changed = false
      for (const item of state.items) {
        if (item.mailId !== mailId) continue
        if (item.state === 'queued' || item.state === 'held') {
          item.state = 'done'
          item.retired = reason
          changed = true
        }
      }
      if (changed) await saveCourier(state.cwd)
    }
  }

  /** 该会话还有没有「投了但没被消费」的卡；有就不许再投（在途 ≤ 1）。 */
  function inflightFor(sessionId) {
    let newest = null
    for (const letter of letters) {
      if (letter.toSession !== sessionId) continue
      if (!letter.pushedAt || letter.deliveredAt) continue
      // 待办信也算在途：它的卡没被消费过，就不许再塞第二张；
      // 但历史未知状态（如 running）不算，否则通道永远打不开
      if (!LIVE_STATUS.has(letter.status) && letter.status !== 'blocked') continue
      if (!newest || letter.pushedAt > newest) newest = letter.pushedAt
    }
    return newest ? Date.now() - (Date.parse(newest) || 0) : null
  }

  function armHoldTimer(letter) {
    clearHoldTimer(letter.id)
    if (!courierCfg.busyHoldMs) return
    const timer = setTimeout(() => {
      holdTimers.delete(letter.id)
      const live = find(letter.id)
      if (!live || live.deliveredAt || ['acked', 'done', 'blocked'].includes(live.status)) return
      void targetBusy(live.toSession).then((busy) => {
        if (busy) void block(live, 'target-busy')
      })
    }, courierCfg.busyHoldMs)
    if (typeof timer.unref === 'function') timer.unref()
    holdTimers.set(letter.id, timer)
  }

  function clearHoldTimer(mailId) {
    const timer = holdTimers.get(mailId)
    if (timer) {
      clearTimeout(timer)
      holdTimers.delete(mailId)
    }
  }

  /** 看门狗：静置超过 staleAfterMs 仍没被处理 → 允许补一次催收（单封上限 maxNoticeA）。 */
  function armStaleWatch(letter) {
    clearStaleTimer(letter.id)
    const timer = setTimeout(() => {
      staleTimers.delete(letter.id)
      const live = find(letter.id)
      if (!live || live.status !== 'blocked') return
      if ((live.noticeA || 0) >= courierCfg.maxNoticeA) return
      if (live.deliveredAt || live.ackedAt) return
      const cwd = live._cwd
      if (!cwd) return
      void enqueue(cwd, { mailId: live.id, sessionId: live.toSession, fromSession: live.fromSession || null, form: 'a', state: 'queued', reason: 'stale-watchdog' })
        .then(() => appendLedger(cwd, { at: new Date().toISOString(), mail_id: live.id, side: 'to', note: 'courier:stale-recheck' }).catch(() => {}))
        .then(() => scheduleDrain(0))
        .catch(() => {})
    }, courierCfg.staleAfterMs)
    if (typeof timer.unref === 'function') timer.unref()
    staleTimers.set(letter.id, timer)
  }

  function clearStaleTimer(mailId) {
    const timer = staleTimers.get(mailId)
    if (timer) {
      clearTimeout(timer)
      staleTimers.delete(mailId)
    }
  }

  function scheduleDrain(delay = 0) {
    if (drainTimer) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      void drain()
    }, Math.max(0, delay))
    if (typeof drainTimer.unref === 'function') drainTimer.unref()
  }

  /** 单线程：一次只取一条，投完歇 intervalMs 再取下一条。 */
  async function drain() {
    if (draining) return
    draining = true
    try {
      for (;;) {
        const pick = await nextDeliverable()
        if (!pick) break
        await deliverItem(pick.cwd, pick.item)
        if (courierCfg.intervalMs > 0) await sleepMs(courierCfg.intervalMs)
      }
    } catch (error) {
      log('courier drain failed', error && error.message)
    } finally {
      draining = false
    }
  }

  async function nextDeliverable() {
    await load()
    const all = []
    for (const state of couriers.values()) {
      if (state.paused) continue
      for (const item of state.items) if (item.state === 'queued') all.push({ cwd: state.cwd, item })
    }
    // 加急优先，同级按入场顺序；加急件是对事不对人的撤销/告知，晚一步就白干
    all.sort((a, b) => (b.item.urgent ? 1 : 0) - (a.item.urgent ? 1 : 0) || a.item.seq - b.item.seq)
    for (const candidate of all) {
      const urgent = candidate.item.urgent === true
      if (!urgent && (await targetBusy(candidate.item.sessionId))) continue
      const inflight = inflightFor(candidate.item.sessionId)
      // 上一张卡还没被消费：只有它已经老到该走看门狗时，才允许再投一条；加急豁免
      if (!urgent && inflight !== null && inflight < courierCfg.staleAfterMs) continue
      return candidate
    }
    return null
  }

  async function deliverItem(cwd, item) {
    const letter = item.mailId ? find(item.mailId) : null
    if (item.mailId && (!letter || letter.status === 'acked' || letter.status === 'done')) {
      item.state = 'done'
      await saveCourier(cwd)
      return
    }
    let text = null
    if (item.form === 'a' && letter) text = await noticeTextA(letter)
    else if (item.form === 'b') text = await noticeTextB(item, cwd)
    else if (item.form === 'c') text = await noticeTextC(item)
    if (!text) {
      item.state = 'done'
      await saveCourier(cwd)
      return
    }
    // 门控第二层：到达投递口时再判一次（状态可能已经变了）。被挡下的不占对话。
    if (letter && !shouldWake(letter)) {
      item.state = 'done'
      item.retired = 'notify-gated'
      item.filedAt = new Date().toISOString()
      await appendLedger(cwd, {
        at: item.filedAt,
        mail_id: letter.id,
        side: 'to',
        note: 'courier:filed',
        form: item.form,
        sessionId: item.sessionId,
        status: letter.status,
      }).catch(() => {})
      await saveCourier(cwd)
      return
    }
    const result = letter
      ? await deliverNotice(letter, text, item.sessionId)
      : await sendNotice(item.sessionId, text, '信使')
    item.attempts = (item.attempts || 0) + 1
    item.lastNoticeAt = new Date().toISOString()
    if (result.queued) {
      item.state = 'done'
      if (letter) {
        if (item.form === 'a') {
          letter.noticeA = (letter.noticeA || 0) + 1
          // 新的一轮催收卡发出去了：等它被消费才算「对方看到」
          letter.deliveredAt = null
          if (letter.status === 'pending') letter.status = 'pushed'
          if (!letter.pushedAt) letter.pushedAt = new Date().toISOString()
          letter.queueSeq = item.seq
        } else if (item.form === 'b') {
          letter.noticeB = (letter.noticeB || 0) + 1
        } else {
          letter.noticeC = (letter.noticeC || 0) + 1
        }
        await save()
        await archive(letter)
      }
      // 留痕：卡投给谁、第几次。同一 mail_id 的第二次投递不会进 noteStep（deliveredAt 已存在），
      // 不留这一笔就无从核对「对方到底收没收到催收卡」。
      await appendLedger(cwd, {
        at: new Date().toISOString(),
        mail_id: item.mailId || null,
        side: item.side || 'to',
        note: 'courier:delivered',
        form: item.form,
        sessionId: item.sessionId,
        attempt: item.attempts,
      }).catch(() => {})
      if (item.form === 'b') {
        const state = await courierOf(cwd)
        state.digests[item.sessionId] = {
          at: Date.now(),
          count: letters.filter((entry) => entry.fromSession === item.sessionId && entry.status === 'blocked').length,
        }
      }
      await saveCourier(cwd)
    } else {
      log('courier deliver failed', item.mailId || '-', item.sessionId, result.reason)
      if (item.attempts >= courierCfg.maxAttempts) {
        item.state = 'dropped'
        await appendLedger(cwd, { at: new Date().toISOString(), mail_id: item.mailId || null, side: 'to', note: 'courier:dropped', reason: result.reason || null }).catch(() => {})
      }
      await saveCourier(cwd)
    }
  }

  /** 形态 A：收信方催收，一封一张。 */
  async function noticeTextA(letter) {
    const path = envelopePathOf(letter)
    let size = ''
    if (path) {
      try {
        size = '（' + (Math.max(1, Math.round((await stat(path)).size / 1024 * 10) / 10)).toFixed(1) + ' KB）'
      } catch {
        size = ''
      }
    }
    return [
      stampOf(letter),
      '〔信箱·待收〕' + letter.id,
      '来自 ' + letter.from + ' · ' + letter.type + ' · 位置：' + (path || '(未落盘)') + size,
      '状态：待办 B —— 这封还没进过你的任何一轮' + (letter.blockReason ? '（' + letter.blockReason + '）' : ''),
      '（回信带上 〔信箱·' + letter.id + '〕 即结案）',
    ].join('\n')
  }

  /** 形态 B：发信方摘要，一个发信方一张，数字没变不重发。 */
  async function noticeTextB(item, cwd) {
    const sessionId = item.sessionId
    const ids = Array.isArray(item.mailIds) && item.mailIds.length > 0 ? item.mailIds : letters.filter((letter) => letter.fromSession === sessionId && letter.status === 'blocked').map((letter) => letter.id)
    // 快照只用来拿 id 与对端；投递前按**当前状态**重算，别把已经 ack 的信报成待办。
    const mine = ids
      .map((id) => ({ id, letter: find(id) }))
      .filter((row) => row.letter && row.letter.status === 'blocked')
      .map((row) => ({ id: row.id, peer: (item.names && item.names[row.id]) || row.letter.to || null }))
      .filter((row) => row.peer)
    if (mine.length === 0) return null
    const byPeer = new Map()
    for (const letter of mine) byPeer.set(letter.peer, (byPeer.get(letter.peer) || 0) + 1)
    const parts = [...byPeer.entries()].map(([peer, count]) => peer + ' ' + count + ' 封').join('、')
    const oldest = Number(item.oldest) || Date.now()
    const minutes = Math.max(0, Math.round((Date.now() - oldest) / 60000))
    const state = await courierOf(cwd)
    const live = state.items.filter((item) => item.state === 'queued' || item.state === 'held').sort((a, b) => a.seq - b.seq)
    const self = live.find((item) => item.form === 'b' && item.sessionId === sessionId)
    const rank = self ? live.findIndex((item) => item.seq === self.seq) + 1 : 1
    const lines = [
      "现在 " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + "（本机时区）",
      '〔信使〕你名下现在 ' + mine.length + ' 封待办：' + parts + '，最早 ' + minutes + ' 分钟前。',
      '不是对方不理你 —— 是信没被消费或没拿到回执，别等。',
    ]
    if (live.length > 1) lines.push('通道里 ' + (rank > 1 ? '前面还有 ' + (rank - 1) + ' 条，' : '') + '你这条排第 ' + rank + ' 位（共 ' + live.length + ' 条），我一条条递，请稍候。')
    else lines.push('通道现在就这一条，马上递。')
    lines.push('要重推哪封，带上 mail_id 说一声。')
    return lines.join('\n')
  }

  /** 收信方摘要：目标空闲且持有队列非空时先报数。用入队时的快照，避免重开后查不到。 */
  async function noticeTextC(item) {
    const sessionId = item.sessionId
    const snapshot = Array.isArray(item.mailIds) && item.mailIds.length > 0
      ? item.mailIds.map((id) => ({ id, from: (item.names && item.names[id]) || (find(id) || {}).from || '?' }))
      : letters.filter((letter) => letter.toSession === sessionId && letter.status === 'blocked').map((letter) => ({ id: letter.id, from: letter.from }))
    if (snapshot.length === 0) return null
    const ids = snapshot.slice(0, 8).map((row) => row.id + '（来自 ' + row.from + '）').join('、') + (snapshot.length > 8 ? ' 等' : '')
    return ["现在 " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + "（本机时区）", '〔信使〕你有 ' + snapshot.length + ' 封没处理：' + ids + '。', '我按顺序一封封递，你回完一封我再看下一封。'].join(String.fromCharCode(10))
  }

  /** 目标空闲：把持有队列里的条目重新排队，先报数再逐封。 */
  async function promoteHeld(sessionId) {
    await load()
    let promoted = 0
    for (const state of couriers.values()) {
      if (state.paused) continue
      const held = state.items.filter((item) => item.state === 'held' && item.sessionId === sessionId).sort((a, b) => a.seq - b.seq)
      if (held.length === 0) continue
      const names = {}
      const mailIds = held.map((entry) => {
        const letter = entry.mailId ? find(entry.mailId) : null
        if (letter) names[entry.mailId] = letter.from
        return entry.mailId
      }).filter(Boolean)
      state.seq += 1
      state.items.push({ seq: state.seq, mailId: null, sessionId, form: 'c', state: 'queued', attempts: 0, enqueuedAt: new Date().toISOString(), lastNoticeAt: null, mailIds, names })
      for (const item of held) {
        state.seq += 1
        item.seq = state.seq
        item.state = 'queued'
        promoted += 1
        const letter = item.mailId ? find(item.mailId) : null
        if (letter && letter.status === 'blocked') {
          letter.status = 'pushed'
          letter.reopened = true
          letter.paused = false
          letter.deliveredAt = null
          letter.pushedAt = null
          await save()
          await archive(letter)
          await appendLedger(letter._cwd, { at: new Date().toISOString(), mail_id: letter.id, side: 'to', note: 'courier:reopen', queueSeq: item.seq }).catch(() => {})
        }
      }
      await saveCourier(state.cwd)
    }
    if (promoted > 0) scheduleDrain(0)
    return promoted
  }

  /* ── 哨兵：送达触发器（v5 §2/§3）────────────────────────────
     空闲 → 直接送达 + 10 秒确认窗
     忙   → 这次推送原地转触发器，等 idle 边；10 秒内又变忙则放弃并把节拍缩到 5s→3s→2s
     每次动作写 _ledger.json，发信方读它就知道「已收到 / 未收到」
  */

  function sentinelOf(letter) {
    if (!letter.sentinel) letter.sentinel = { attempts: 0, delayMs: SENTINEL_DELAYS[0], dueAt: null, state: 'idle', timer: null }
    return letter.sentinel
  }

  function clearSentinel(letter) {
    const sentinel = letter.sentinel
    if (!sentinel) return
    if (sentinel.timer) clearTimeout(sentinel.timer)
    sentinel.timer = null
    sentinel.dueAt = null
    sentinel.state = 'idle'
  }

  async function targetBusy(sessionId) {
    const controller = service('sessionController')
    if (!controller || !sessionId || typeof controller.state !== 'function') return false
    try {
      const state = await controller.state({ sessionId })
      return Boolean(state && (state.running === true || state.active === true))
    } catch (error) {
      log('state failed', sessionId, error && error.message)
      return false
    }
  }

  function envelopePathOf(letter) {
    const cwd = letter.toCwd || letter.fromCwd
    if (!cwd) return null
    return join(workspaceBox(cwd).envelope, letter.id + '.' + (letter.toCwd ? 'to' : 'from') + '.md')
  }

  /** 所有信箱文案的第一行：让模型有“现在几点、信是几点的”。 */
  function stampOf(letter) {
    const now = new Date()
    const sent = new Date(letter.sentAt)
    const hhmm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
    const mins = Math.max(0, Math.round((now - sent) / 60000))
    return "现在 " + hhmm(now) + "（本机时区）· 本信 " + hhmm(sent) + "（" + mins + " 分钟前）"
  }

  /** 只报“现在几点”，给门槛与横幅用。 */
  function stampNow() {
    const now = new Date()
    return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0")
  }

  /* ── 唤醒门控（v0.3）──────────────────────────────────────────
     对话是稀缺资源：一次 prompt 就等于把对方从别的事里拽出来。
     所以只在「不看就会坏」的场合推：撤销/加急、待办通知、以及
     对方名下当前已经没有别的在途信（首次跨会话＝必须叫醒）。
     其余普通信只落盘排队，由 pre-step 横幅与 mail_inbox 自己来拉。
     注意：门控只挡“发起推送”，不改状态机；四层账本照旧。
  */
  const WAKE_TYPES = new Set(['S-TODO-NOTICE', 'S-EXPIRE'])
  /** 纯回执：只告诉对方“我收到了”，不值得占对方一轮；要催就再用待办通知。 */
  const SILENT_TYPES = new Set(['S-ACK'])

  function shouldWake(letter) {
    if (!letter) return true
    if (letter.urgent === true) return true
    if (SILENT_TYPES.has(letter.type)) return false
    if (WAKE_TYPES.has(letter.type)) return true
    if (letter.status === 'blocked') return true
    // 已经进过对方一轮还没结案：这是催收，必须推
    if ((letter.noticeA || 0) >= 1) return true
    if (!letter.toSession) return true
    // 一个目标同时只叫醒一次：排在前面的那封去叫，后面的老实排队。
    // 之前写成「有别的在途信就不叫」，一批三封全被门控挡掉，等于谁都不叫。
    const older = letters.some((entry) => {
      if (entry.id === letter.id) return false
      if (entry.toSession !== letter.toSession) return false
      if (!LIVE_STATUS.has(entry.status)) return false
      // 静默信（S-ACK）自己永远不会叫醒谁，也就不该把后面那封真信的门控挡住。
      // 实盘：lead 的探针会话遗留一条 S-ACK，就把我寄给他的信全挡了。
      if (SILENT_TYPES.has(entry.type)) return false
      // 已经进过对方一轮的就不算“前面还有人等着”：轮到下一封了
      if (entry.deliveredAt) return false
      const a = Date.parse(entry.sentAt) || 0
      const b = Date.parse(letter.sentAt) || 0
      return a < b || (a === b && String(entry.id) < String(letter.id))
    })
    return !older
  }

  /** 通知只给索引，不注入信封全文（v5 §4）。 */
  async function indexNotice(letter) {
    const path = envelopePathOf(letter)
    let size = '?'
    if (path) {
      try {
        size = (Math.max(1, Math.round((await stat(path)).size / 1024 * 10) / 10)).toFixed(1) + ' KB'
      } catch {
        size = '?'
      }
    }
    return [
      receiptOf(letter.id),
      stampOf(letter),
      '〔信箱索引〕' + letter.id,
      '来源：' + letter.from + '（' + (letter.fromSession ? '会话 ' + letter.fromSession : '脚本/无会话') + '）· 类型 ' + letter.type,
      '位置：' + (path || '(未落盘)') + (size && size !== '?' ? '（' + size + '）' : ''),
      '状态：' + sideDir(letter, 'to') + ' ' + sideCode(letter, 'to') + '（信只有一份，正文在该文件里）',
    ].join('\n')
  }

  async function writeSentinelNote(letter, phase, extra) {
    const cwd = letter.toCwd || letter.fromCwd
    if (!cwd) return
    try {
      await appendLedger(cwd, {
        at: new Date().toISOString(),
        mail_id: letter.id,
        side: 'to',
        dir: sideDir(letter, 'to'),
        code: sideCode(letter, 'to'),
        status: letter.status,
        note: 'sentinel:' + phase,
        delayMs: sentinelOf(letter).delayMs,
        dueAt: sentinelOf(letter).dueAt,
        ...(extra || {}),
      })
    } catch (error) {
      log('sentinel ledger failed', letter.id, error && error.message)
    }
  }

  /**
   * v0.2 起不再有「缩表重推」：同一会话未消费的卡在途 ≤ 1，
   * 重推只在看门狗（staleAfterMs）到点后由通道放行一次。
   * armSentinel / fireSentinel 已移除，保留 sentinel 状态只为读旧账本与写留痕。
   */

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

    // 撤销信对事不对人：同一封原信只允许有一件待投/在投的撤销，重复发直接返回已有那件
    if (type === 'S-EXPIRE' && request.expireOf) {
      const dup = letters.find((letter) => letter.expireOf === request.expireOf && ['pending', 'pushed', 'delivered', 'blocked'].includes(letter.status))
      if (dup) return { ok: true, duplicate: true, mailId: dup.id, status: dup.status }
    }

    // ── 背压（v0.2 §5 I1）：上一封没结案就不许再发。S-ACK / S-TODO-NOTICE 豁免。
    let prior = null
    let released = null
    if (!BACKPRESSURE_EXEMPT.has(type)) {
      const outstanding = letters.find((letter) => letter.from === owner && letter.to === peer && ['pending', 'pushed', 'delivered'].includes(letter.status))
      if (outstanding) {
        // 软释放：对方一直不回执，等够阈值就放行，并留痕；不改那封信的状态，只记一笔
        const since = Math.max(
          (Date.parse(outstanding.pushedAt || '') || 0),
          (Date.parse(outstanding.deliveredAt || '') || 0),
          (Date.parse(outstanding.sentAt || '') || 0),
        )
        const waited = Date.now() - since
        if (!(releaseMs > 0 && waited >= releaseMs)) {
        return {
          ok: false,
          error: {
            message: '上一封还没结案（' + outstanding.id + '，状态 ' + outstanding.status + '），先等回执再发；要催收可以等信使的摘要',
            code: 'PAIR_OUTSTANDING',
            mailId: outstanding.id,
            status: outstanding.status,
            waitingMs: Date.now() - (Date.parse(outstanding.sentAt) || Date.now()),
          },
        }
        }
        released = { mailId: outstanding.id, status: outstanding.status, waitingMs: waited }
        if (outstanding._cwd) {
          void appendLedger(outstanding._cwd, {
            at: new Date().toISOString(),
            mail_id: outstanding.id,
            side: 'to',
            note: 'backpressure:soft-release',
            waitingMs: waited,
            thresholdMs: releaseMs,
          }).catch(() => {})
        }
      }
      const held = letters.filter((letter) => letter.from === owner && letter.to === peer && letter.status === 'blocked').pop()
      if (held) {
        // 已进待办的一封不挡新信，但要让发信方知道：这封还挂在通道里
        prior = { mailId: held.id, status: 'held', heldMinutes: Math.max(0, Math.round((Date.now() - (Date.parse(held.todoSince || held.blockedAt || '') || Date.now())) / 60000)) }
      }
    }

    const meta = { mail_id: request.mailId || nextMailId(), type, from: owner, to: peer, ack_of: request.ackOf, todo_of: request.todoOf, stuck_since: request.stuckSince, elapsed_minutes: request.elapsedMinutes, expire_of: request.expireOf, reason: request.reason }
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
      expireOf: request.expireOf || null,
      // 加急：撤销信与显式 urgent 才走快车道（对事不对人，同一件事只发一件）
      urgent: type === 'S-EXPIRE' || request.urgent === true,
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
    letter.toCwd = await cwdOf(letter.toSession).catch(() => undefined)
    letter.fromCwd = await cwdOf(letter.fromSession).catch(() => undefined)
    // 无会话的脚本发信：允许显式给 senderCwd，好让发信方也留一份信封与索引；
    // 不给就只有收信方那一份（历史行为），不影响投递。
    if (!letter.fromCwd && typeof request.senderCwd === 'string' && request.senderCwd.trim()) {
      // senderCwd 会让插件在这个路径下建 .dsh-mail/，因此必须是调用方已验证过的绝对路径；
      // 这里再挡一层：含 .. 或 NUL 的一律拒绝，避免把信箱建到别处。
      const raw = request.senderCwd.trim()
      if (raw.includes('..') || raw.includes('\u0000') || !/^[A-Za-z]:[\\/]/.test(raw)) {
        log('senderCwd rejected', JSON.stringify(raw))
      } else {
        letter.fromCwd = raw
      }
    }
    // 顺手回收过期/闲置的任务通道（发信是低频动作，放这里够用）
    await pruneTaskGroups(letter.toCwd, 600000).catch(() => [])
    if (letter.fromCwd && letter.fromCwd !== letter.toCwd) await pruneTaskGroups(letter.fromCwd, 600000).catch(() => [])
    letter._cwd = letter.toCwd || letter.fromCwd || fallbackCwd
    if (!letter._cwd) {
      return { ok: false, error: { message: 'no workspace resolved for this letter (need cwdOf/registered session)', code: 'NO_WORKSPACE' } }
    }
    letter.paths = {}

    // 真实会话的信箱要先建出来：archive() 与 saveCourierNow() 都拿 _ledger.json 当“已注册”判据，
    // 目录不存在就静默跳过，结果信只在内存里、盘上没有信封（实盘 M-20261118-0008 就是这样丢的）。
    // 没有会话的脚本路径不建箱，保留“未注册工作区不长 .dsh-mail”的老规矩。
    for (const [side, cwd] of [['to', letter.toCwd], ['from', letter.fromCwd]]) {
      if (!cwd) continue
      const sessionId = side === 'to' ? letter.toSession : letter.fromSession
      if (!sessionId) continue
      try {
        await ensureWorkspaceBox(cwd)
      } catch (error) {
        log('ensure box failed: ', side, cwd, (error && error.message) || String(error))
      }
    }

    letters.push(letter)
    // 先落盘信封再通知：索引里要能读出真实路径与大小
    await save()
    await archive(letter)

    const busy = letter.toSession ? await targetBusy(letter.toSession) : false
    // 在途 ≤ 1：该会话还有一张没被消费的卡，就不再塞第二张；通道暂停时也只入队。
    const inflight = letter.toSession ? inflightFor(letter.toSession) : null
    const pausedNow = letter._cwd ? (await courierOf(letter._cwd)).paused === true : false
    const defer =
      Boolean(letter.toSession) &&
      (busy || pausedNow || (inflight !== null && inflight < courierCfg.staleAfterMs))
    if (defer) {
      letter.push = { queued: false, reason: busy ? 'target-busy' : pausedNow ? 'channel-paused' : 'inflight', deferred: true }
      letter.status = 'pending'
      await enqueue(letter._cwd, { mailId: letter.id, sessionId: letter.toSession, fromSession: letter.fromSession || null, form: 'a', urgent: letter.urgent === true, expireOf: letter.expireOf || null, state: 'queued', reason: letter.push.reason })
      // 加急件不挂持有计时：它本来就是绕过忙状态的，被'忙太久'打成待办反而丢了
      if (busy && letter.urgent !== true) armHoldTimer(letter)
      await writeSentinelNote(letter, busy ? 'wait-idle' : 'deferred', { reason: letter.push.reason })
    } else {
      // 唤醒门控：普通信不推，只落盘排队；阻塞场景（加急/待办/首次跨会话）照旧推
      const wake = shouldWake(letter)
      letter.push = wake ? await push(letter) : { queued: false, reason: 'notify-gated', gated: true }
      letter.status = letter.push.queued ? 'pushed' : 'pending'
      if (letter.push.queued) letter.pushedAt = new Date().toISOString()
      else if (letter.toSession && !letter.push.gated) {
        // 推失败不重试轰炸：入通道排队，由通道自己的上限兜底
        await enqueue(letter._cwd, { mailId: letter.id, sessionId: letter.toSession, fromSession: letter.fromSession || null, form: 'a', urgent: letter.urgent === true, expireOf: letter.expireOf || null, state: 'queued', reason: letter.push.reason || 'push-failed' })
      }
      if (!wake) {
        // 不留痕就无从解释“我发了信对方为什么没动静”——留一笔，便于对账
        await appendLedger(letter._cwd, {
          at: new Date().toISOString(),
          mail_id: letter.id,
          side: 'to',
          note: 'notice:gated',
          reason: 'first-wake-gate',
          unread: letters.filter((entry) => entry.toSession === letter.toSession && LIVE_STATUS.has(entry.status)).length,
        }).catch(() => {})
      }
    }
    scheduleDrain(0)
    // 撤销信：落盘前把 expire_of 指向的那封标过期（成功推送路径不经过 enqueueTodo）
    if (letter.expireOf) await expireOriginal(letter)
    await save()
    await archive(letter)
    armTimer(letter)
    // 回执是记录，不是请求：当场结清。否则它会占着这对角色的背压槽位（后面所有信都发不出去）、
    // 5 分钟后又超时转待办，给一封回执发催收卡——实盘探针已验证这条链会真的发生。
    if (SILENT_TYPES.has(letter.type)) {
      clearTimer(letter.id)
      letter.status = 'acked'
      letter.autoSettled = true
      letter.ackedAt = letter.ackedAt || new Date().toISOString()
      letter.deliveredAt = letter.deliveredAt || letter.ackedAt
      await save()
      await archive(letter)
    }
    await maybeGroup(letter)
    const routed = await routeOf(letter)
    if (routed) await appendLedger(letter.toCwd || letter.fromCwd, { at: new Date().toISOString(), mail_id: letter.id, side: 'to', note: 'route:group', groupId: routed.id }).catch(() => {})
    log('mail sent', letter.id, owner, '->', peer, letter.status)
    return { ok: true, mailId: letter.id, status: letter.status, cwd: letter.toCwd || letter.fromCwd || null, deadline: letter.deadline, deadlineIso: new Date(letter.deadline).toISOString(), push: letter.push, peerState: busy ? 'running' : letter.toSession ? 'idle' : 'unknown', ...(prior ? { prior } : {}), ...(released ? { released } : {}) }
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
    clearHoldTimer(mailId)
    clearStaleTimer(mailId)
    // 回执到了：通道里针对这封信的待投条目作废，别再补催收
    await retireItems(mailId)
    await save()
    await archive(letter)
    return { ok: true, mailId, status: letter.status, cwd: letter.toCwd || letter.fromCwd || null, closed: close }
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

  /**
   * 未读清单（只读，拉取式）：门控之后由 agent 自己来问「我有什么没处理」。
   * 不加急的普通信不会推，但如果它一直没人拉，定时器照样把它打成待办。
   */
  async function inbox(request) {
    await load()
    const sessionId = String(request.sessionId || request.senderSessionId || '').trim() || null
    const now = Date.now()
    const rows = letters
      .filter((letter) => {
        if (sessionId && letter.toSession !== sessionId) return false
        // 只列真正待处理的：历史未知状态（running 等）不算未读，免得一拉一屏陈年旧账
        return LIVE_STATUS.has(letter.status) || letter.status === 'blocked'
      })
      .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (Date.parse(a.sentAt) || 0) - (Date.parse(b.sentAt) || 0))
      .map((letter) => ({
        mailId: letter.id,
        from: letter.from,
        to: letter.to,
        type: letter.type,
        status: letter.status,
        urgent: letter.urgent === true,
        dir: sideDir(letter, 'to'),
        side: sideCode(letter, 'to'),
        sentAt: letter.sentAt,
        ageMinutes: Math.max(0, Math.round((now - (Date.parse(letter.sentAt) || now)) / 60000)),
        delivered: Boolean(letter.deliveredAt),
        path: envelopePathOf(letter),
      }))
    const lines = rows.map(
      (row, index) =>
        index + 1 + '. ' + row.mailId + ' · ' + row.type + (row.urgent ? ' · 加急' : '') + ' · 来自 ' + row.from + ' · ' + row.status + ' ' + row.dir + ' · ' + row.ageMinutes + ' 分钟前',
    )
    return {
      ok: true,
      sessionId,
      at: new Date().toISOString(),
      clock: stampNow(),
      count: rows.length,
      unread: rows.filter((row) => !row.delivered).length,
      rows,
      lines,
    }
  }

  /* 横幅没有走 agent/pre-step 注入：UserMessage 必须带 id/content/source，
     造一条就会在对话记录里显示成“人类说的话”，比不提示更糟。拉取口只有 mail_inbox。 */

  /**
   * pre-step 横幅：只在真有未读且这是本回合第一步时出现一行。
   * 由 index.js 以 `source: {kind:'runtime-context'}` 注入系统上下文，不伪装成人类发言、不唤醒。
   */
  async function stepBanner(agent) {
    if (!agent || !agent.id) return null
    await load()
    const mine = letters.filter((letter) => letter.toSession === agent.id && !['acked', 'done', 'expired'].includes(letter.status))
    if (mine.length === 0) return null
    const oldest = Math.min(...mine.map((letter) => Date.parse(letter.sentAt) || Date.now()))
    const minutes = Math.max(0, Math.round((Date.now() - oldest) / 60000))
    return (
      '〔信箱·开工检查〕现在 ' + stampNow() + '（本机时区），你有 ' + mine.length + ' 封未读，最早 ' + minutes + ' 分钟前。' +
      '先调 mail_inbox 看清单（它不会自动叫醒你，所以这一步不能省）。'
    )
  }

  /** `agent/pre-step` 观测：回执标记进了对方这一轮 → 对方知道了。 */
  async function noteStep(agent, messages) {
    const ids = mailIdsInMessages(messages)
    if (ids.length === 0) return
    await load()
    let changed = false
    const touched = []
    for (const id of ids) {
      const letter = find(id)
      if (!letter || letter.deliveredAt) continue
      if (agent && letter.toSession && agent.id !== letter.toSession) continue
      letter.deliveredAt = new Date().toISOString()
      if (letter.status === 'pushed' || letter.status === 'pending') letter.status = 'delivered'
      // 送达即回执：回执标记进了对方这一轮，说明信已经在他的上下文里，
      // 再来回问「你收到了吗」只是拿人的记性补程序的窟窿——插件自己 ack。
      // 这样「读了先 ack」不再靠角色卡纪律，任何装了插件的人都不会踩超时。
      if (!letter.ackedAt) {
        letter.ackedAt = letter.deliveredAt
        letter.status = 'acked'
        letter.autoAcked = true
        letter.receipt = letter.receipt || '已读（自动）'
        clearTimer(letter.id)
        clearHoldTimer(letter.id)
        clearStaleTimer(letter.id)
        await retireItems(letter.id, 'acked')
      } else {
        // 已手工 ack 过的老信：仍按原逻辑重置窗口，保留旧行为
        letter.deadline = Date.parse(letter.deliveredAt) + (Number(letter.windowMs) || ackTimeoutMs)
        armTimer(letter)
      }
      touched.push(letter)
      changed = true
    }
    if (changed) {
      await save()
      // 送达也是一步，要写进 _index/_ledger，否则路径会跳过 R（处理中）
      for (const letter of touched) await archive(letter)
      // 上一张卡被消费了 → 通道的「在途 ≤ 1」闸门打开，可以递下一条
      scheduleDrain(0)
    }
  }

  /**
   * 会话状态边（v0.2）：
   *   running → 目标在任务中：不投卡，起持有计时器；超过 busyHoldMs 就转待办
   *   idle    → 目标空闲：先把持有队列重新排队（先报数），再逐封递
   */
  async function noteStatus(agent, status) {
    if (!agent) return
    await load()
    const mine = letters.filter((letter) => letter.toSession === agent.id && !['acked', 'done', 'blocked'].includes(letter.status))
    if (status === 'idle') {
      for (const letter of mine) {
        clearHoldTimer(letter.id)
        letter.busySince = null
        if (!letter.deliveredAt) await writeSentinelNote(letter, 'idle', {})
      }
      const promoted = await promoteHeld(agent.id)
      await save()
      if (promoted === 0) scheduleDrain(0)
    } else if (status === 'running' || status === 'busy') {
      for (const letter of mine) {
        if (letter.deliveredAt) continue
        if (!letter.busySince) letter.busySince = new Date().toISOString()
        armHoldTimer(letter)
        await writeSentinelNote(letter, 'wait-idle', { busySince: letter.busySince })
      }
      await save()
    }
  }

  /** 冷启动兜底：只扫一次，把跨进程期间过期的信补进待办，并恢复通道。 */
  async function sweepAtStart() {
    await load()
    for (const cwd of [...boxes.keys()]) {
      await pruneTaskGroups(cwd, 600000).catch(() => [])
      await courierOf(cwd)
    }
    let blocked = 0
    for (const letter of letters) {
      if (letter.status === 'blocked' || letter.status === 'done' || letter.status === 'acked') continue
      if (Number.isFinite(letter.deadline) && letter.deadline < Date.now()) {
        void block(letter, 'ack-timeout (cold start)')
        blocked += 1
      } else {
        armTimer(letter)
        if (letter.busySince) armHoldTimer(letter)
      }
    }
    // 迁移：升级前就已是待办的信没有通道条目，补一条 held，否则它永远没人捡
    for (const letter of letters) {
      if (letter.status !== "blocked" || !letter.toSession || !letter._cwd) continue
      const state = await courierOf(letter._cwd)
      const present = state.items.some((item) => item.mailId === letter.id && (item.state === "queued" || item.state === "held"))
      if (present) continue
      await enqueue(letter._cwd, { mailId: letter.id, sessionId: letter.toSession, fromSession: letter.fromSession || null, form: "a", state: "held", reason: "migrated" })
    }
    // 冷启动：持有队列里的条目如果目标此刻并不忙，直接放行（不会再有 idle 边了）
    const heldSessions = new Set()
    for (const state of couriers.values()) {
      for (const item of state.items) if (item.state === "held") heldSessions.add(item.sessionId)
    }
    for (const sessionId of heldSessions) {
      if (!(await targetBusy(sessionId))) await promoteHeld(sessionId)
    }
    scheduleDrain(0)
    return { blocked, armed: letters.length }
  }

  /**
   * 发信方一眼看状态：把 _letters 的内部状态换算成五件套目录 + 字母路径，
   * 再带上「这两个会话是否在同一个群」的信息。不读正文。
   */
  async function status(request) {
    await load()
    const mailId = request.mailId ? String(request.mailId).trim() : undefined
    const owner = request.owner ? String(request.owner).trim() : undefined
    const now = Date.now()
    const picked = letters
      .filter((letter) => (!mailId || letter.id === mailId) && (!owner || letter.from === owner || letter.to === owner))
      .slice(-100)
    const rows = []
    for (const letter of picked) {
      const boxCwd = letter.toCwd || letter.fromCwd
      let entry
      if (boxCwd) {
        try {
          const index = JSON.parse(await readFile(join(boxOf(boxCwd).box.dir, '_index.json'), 'utf8'))
          entry = index[letter.id]
        } catch {
          entry = undefined
        }
      }
      const sides = {}
      for (const side of ['from', 'to']) {
        const indexed = entry && entry.sides ? entry.sides[side] : undefined
        sides[side] = indexed
          ? { sessionId: indexed.sessionId, dir: indexed.dir, code: indexed.code, path: indexed.path }
          : { sessionId: side === 'from' ? letter.fromSession : letter.toSession, dir: sideDir(letter, side), code: sideCode(letter, side), path: sideCode(letter, side) }
      }
      let group = null
      if (boxCwd && letter.fromSession && letter.toSession) {
        try {
          const data = await readGroup(boxCwd)
          const shared = sharedGroup(data.groups, letter.fromSession, letter.toSession)
          if (shared) group = { id: shared.id, members: shared.members.length, auto: shared.auto === true }
        } catch {
          group = null
        }
      }
      rows.push({
        mailId: letter.id,
        type: letter.type,
        from: letter.from,
        to: letter.to,
        status: letter.status,
        fromPath: sides.from.path,
        toPath: sides.to.path,
        fromDir: sides.from.dir,
        toDir: sides.to.dir,
        group,
        deadline: letter.deadline,
        overdue: letter.status !== 'acked' && letter.status !== 'done' && letter.status !== 'blocked' && letter.deadline < now,
        blockReason: letter.blockReason || null,
        paused: letter.paused === true,
        todoSince: letter.todoSince || null,
        noticeA: letter.noticeA || 0,
        noticeB: letter.noticeB || 0,
        queueSeq: letter.queueSeq || null,
        reopened: letter.reopened === true,
      })
    }
    const boxCwd = picked.length > 0 ? picked[picked.length - 1].toCwd || picked[picked.length - 1].fromCwd : undefined
    const queue = await queueSummary(boxCwd ? [boxCwd] : [...couriers.keys()])
    return { ok: true, count: rows.length, box: boxCwd ? workspaceBox(boxCwd).dir : null, queue, rows }
  }

  /** 通道一眼看：排了多少条、有没有暂停、最早一条等了多久。 */
  async function queueSummary(cwdList) {
    const list = cwdList && cwdList.length > 0 ? cwdList : [...couriers.keys()]
    let queued = 0
    let held = 0
    let paused = false
    let oldest = null
    for (const cwd of list) {
      const state = await courierOf(cwd)
      paused = paused || state.paused === true
      for (const item of state.items) {
        if (item.state !== 'queued' && item.state !== 'held') continue
        if (item.state === 'queued') queued += 1
        else held += 1
        if (!oldest || String(item.enqueuedAt) < oldest) oldest = item.enqueuedAt || null
      }
    }
    return { pending: queued + held, queued, held, paused, oldest, oldestMinutes: oldest ? Math.max(0, Math.round((Date.now() - (Date.parse(oldest) || Date.now())) / 60000)) : 0 }
  }

  /**
   * 暂停开关（v0.2 §8）：置位后通道只入队不投递，落盘，重启保持。
   * do = pause | resume | status；cwd 缺省用 fallbackCwd。
   */
  async function pause(request) {
    await load()
    const doWhat = String(request.do || 'status').toLowerCase()
    const cwd = (typeof request.cwd === 'string' && request.cwd) || fallbackCwd
    if (!cwd) return { ok: false, error: { message: 'no workspace given', code: 'NO_WORKSPACE' } }
    const state = await courierOf(cwd)
    if (doWhat === 'pause') {
      state.paused = true
      state.pausedAt = new Date().toISOString()
      await saveCourier(cwd)
    } else if (doWhat === 'resume') {
      state.paused = false
      state.pausedAt = null
      await saveCourier(cwd)
      scheduleDrain(0)
    } else if (doWhat !== 'status') {
      return { ok: false, error: { message: 'do must be pause | resume | status: ' + doWhat, code: 'BAD_PAUSE' } }
    }
    const summary = await queueSummary([cwd])
    return { ok: true, cwd, paused: state.paused === true, pausedAt: state.pausedAt || null, ...summary }
  }

  /**
   * 任务专用通道：建会话成功后自动给「创建者 ↔ 新会话」开一条带作用域的通道。
   * - scope='task'，不参与交集合并，只有普通群建立时才会把它提升；
   * - 默认 24 小时 TTL，或被闲置回收；
   * - 两个工作区各写一份，任一侧发信都能路由到。
   */
  async function createTaskChannel(request) {
    const owner = String(request.ownerSessionId || '').trim()
    const member = String(request.memberSessionId || '').trim()
    if (!owner || !member || owner === member) {
      return { ok: false, error: { message: 'owner and member must be two different sessions', code: 'BAD_MEMBERS' } }
    }
    const ttlMs = Math.max(60000, Number(request.ttlMs) || 86400000)
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    const cwds = [...new Set([request.memberCwd, request.ownerCwd].filter(Boolean))]
    const channels = []
    for (const cwd of cwds) {
      let registered = true
      try {
        await readFile(boxOf(cwd).box.ledger, 'utf8')
      } catch {
        registered = false
      }
      if (!registered) continue
      const data = await readGroup(cwd)
      const existing = sharedGroup(data.groups, owner, member)
      if (existing) {
        if (isTaskChannel(existing) && !existing.expiresAt) {
          existing.expiresAt = expiresAt
          await writeGroup(cwd, data)
        }
        channels.push({ cwd, id: existing.id, existed: true })
        continue
      }
      const groupId = nextGroupId(data.groups) + Math.random().toString(36).slice(2, 3).toUpperCase()
      data.groups.push({
        id: groupId,
        name: '通道-' + groupId.slice(-4),
        members: [owner, member],
        createdAt: new Date().toISOString(),
        auto: true,
        scope: 'task',
        owner,
        createdFrom: 'session-create',
        expiresAt,
        mergedFrom: [],
      })
      await writeGroup(cwd, data)
      channels.push({ cwd, id: groupId, existed: false })
    }
    if (channels.length === 0) {
      return { ok: false, error: { message: 'no registered mailbox on either side; channel not created', code: 'NO_MAILBOX' } }
    }
    return { ok: true, expiresAt, channels }
  }

  /**
   * 回收任务通道：TTL 到期，或群内信件全部落定后静默超时。
   * 退休只删群记录，不动信件/信封/索引，并在 _ledger.json 留一笔。
   */
  async function pruneTaskGroups(cwd, idleMs) {
    if (!cwd) return []
    let data
    try {
      data = await readGroup(cwd)
    } catch {
      return []
    }
    const now = Date.now()
    const keep = []
    const retired = []
    for (const group of data.groups) {
      if (!isTaskChannel(group)) {
        keep.push(group)
        continue
      }
      let reason = null
      // 成员会话已归档 → 通道立刻退休，不等 TTL
      const memberArchived = (await Promise.all(group.members.map((member) => isArchived(member).catch(() => false)))).some(Boolean)
      if (memberArchived) reason = 'archived'
      if (!reason && group.expiresAt && (Date.parse(group.expiresAt) || 0) <= now) reason = 'ttl'
      if (!reason && idleMs > 0) {
        const pair = letters.filter(
          (letter) =>
            letter.fromSession && letter.toSession && group.members.includes(letter.fromSession) && group.members.includes(letter.toSession),
        )
        const settled = pair.length > 0 && pair.every((letter) => letter.status === 'done' || letter.status === 'blocked')
        const last = pair
          .map((letter) => Date.parse(letter.ackedAt || letter.deliveredAt || letter.pushedAt || letter.sentAt || '') || 0)
          .sort((left, right) => right - left)[0]
        if (settled && last && now - last > idleMs) reason = 'idle'
      }
      if (reason) {
        retired.push({ id: group.id, reason })
        continue
      }
      keep.push(group)
    }
    if (retired.length > 0) {
      data.groups = keep
      await writeGroup(cwd, data)
      for (const item of retired) {
        await appendLedger(cwd, { at: new Date().toISOString(), note: 'channel:retired', groupId: item.id, reason: item.reason }).catch(() => {})
      }
      log('task channels retired', retired.length, 'in', cwd)
    }
    return retired
  }

  /** 显式建群：用户自然语言要求、/拉群 命令、或脚本走队列，都走这里；支持 2..N 人并群。 */
  async function groupCreate(request) {
    const raw = Array.isArray(request.members) && request.members.length > 0 ? request.members : [request.memberA, request.memberB]
    const members = raw.map((item) => String(item || '').trim()).filter(Boolean)
    if (members.length < 2) return { ok: false, error: { message: 'at least two members are required', code: 'BAD_MEMBERS' } }
    let cwd = typeof request.cwd === 'string' && request.cwd ? request.cwd : undefined
    if (!cwd) {
      for (const member of members) {
        const resolved = await cwdOf(member).catch(() => undefined)
        if (resolved) {
          cwd = resolved
          break
        }
      }
    }
    cwd = cwd || fallbackCwd
    if (!cwd) return { ok: false, error: { message: 'no workspace for these members', code: 'NO_WORKSPACE' } }
    let registered = true
    try {
      await readFile(boxOf(cwd).box.ledger, 'utf8')
    } catch {
      registered = false
    }
    if (!registered) return { ok: false, error: { message: 'workspace has no mailbox (nobody registered)', code: 'NO_MAILBOX' } }

    const data = await readGroup(cwd)
    const shared = data.groups.find((group) => members.every((member) => group.members.includes(member)))
    if (shared && !isTaskChannel(shared)) return { ok: true, cwd, changed: false, merged: false, group: shared }
    if (shared && isTaskChannel(shared)) {
      // 这对会话原本只有任务专用通道 → 提升为普通群，避免同一对人挂两个群
      shared.scope = undefined
      shared.owner = undefined
      shared.expiresAt = undefined
      shared.createdFrom = undefined
      shared.promotedAt = new Date().toISOString()
      shared.auto = request.auto === true
      await writeGroup(cwd, data)
      log('task channel promoted (groupCreate)', shared.id, shared.members.join(','))
      return { ok: true, cwd, changed: true, merged: false, promoted: true, group: shared }
    }

    const union = new Set(members)
    const used = new Set()
    for (const group of data.groups) {
      // 任务专用通道不参与并群
      if (isTaskChannel(group)) continue
      if (group.members.some((member) => members.includes(member))) {
        used.add(group.id)
        for (const member of group.members) union.add(member)
      }
    }
    if (used.size > 0) data.groups = data.groups.filter((group) => !used.has(group.id))
    const groupId = nextGroupId(data.groups)
    const group = {
      id: groupId,
      name: '群-' + groupId.slice(-4),
      members: [...union],
      createdAt: new Date().toISOString(),
      auto: request.auto === true,
      mergedFrom: [...used],
    }
    data.groups.push(group)
    await writeGroup(cwd, data)
    return { ok: true, cwd, changed: true, merged: used.size > 0, group }
  }

  /** 列群：给发信方/使用者看路由表。 */
  async function groupList(request) {
    const explicit = typeof request.cwd === 'string' && request.cwd ? request.cwd : undefined
    const cwd = explicit || (request.sessionId ? await cwdOf(request.sessionId).catch(() => undefined) : undefined) || fallbackCwd
    if (!cwd) return { ok: false, error: { message: 'no workspace given', code: 'NO_WORKSPACE' } }
    const data = await readGroup(cwd)
    return { ok: true, cwd, count: data.groups.length, groups: data.groups }
  }

  return { send, ack, list, status, pause, groupCreate, groupList, createTaskChannel, pruneTaskGroups, noteStep, noteStatus, sweepAtStart, inbox, stepBanner }
}

/** 一个工作区的信箱路径（工作区为根）。 */
export function workspaceBox(root) {
  const dir = join(root, '.dsh-mail')
  return {
    root,
    dir,
    state: join(dir, '_letters.json'),
    envelope: join(dir, 'envelope'),
    ledger: join(dir, '_ledger.json'),
    group: join(dir, 'group.json'),
    courier: join(dir, '_courier.json'),
  }
}

/**
 * 注册门控：只有工作区里出现已注册会话时，才建这一套。
 * 没注册就一个文件都不建（机制不存在）。
 */
export async function ensureWorkspaceBox(root) {
  if (!root) return undefined
  const box = workspaceBox(root)
  await mkdir(box.envelope, { recursive: true })
  for (const [path, seed] of [
    [box.ledger, '{}'],
    [box.group, JSON.stringify({ groups: [] }, null, 2)],
    [box.courier, JSON.stringify({ seq: 0, paused: false, items: [], digests: {} }, null, 2)],
  ]) {
    try {
      await readFile(path, 'utf8')
    } catch {
      await writeFile(path, seed, 'utf8')
    }
  }
  return box
}
