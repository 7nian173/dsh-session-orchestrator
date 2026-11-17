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
  done: '已解决',
}
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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

/** 送达节拍：10s → 5s → 3s → 2s（下限 2s，防忙循环）。 */
const SENTINEL_DELAYS = [10000, 5000, 3000, 2000]

/** controller.prompt 的 signal 参数必传（0.5.0 复验：缺参数会抛 throwIfAborted）。 */
const signalNow = () => new AbortController().signal

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

  const cwdOf = options.cwdOf || (async () => undefined)
  const listedCwds = options.cwds || (async () => [])
  const fallbackCwd = options.fallbackCwd
  /** 自动建群阈值：A↔B 往返回信达到这么多封就建群（v6 补，默认 3）。 */
  const groupThreshold = Math.max(2, Number(options.groupAutoThreshold) || 3)
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
    loaded = true
  }

  async function loadOne(cwd) {
    const state = boxOf(cwd)
    if (state.loaded) return
    try {
      const raw = JSON.parse(await readFile(state.box.state, 'utf8'))
      for (const letter of Array.isArray(raw.letters) ? raw.letters : []) {
        if (!letter || !letter.id || letters.some((existing) => existing.id === letter.id)) continue
        letter._cwd = cwd
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

  /** 按 _cwd 分片写回各自工作区（一封只存一处，信封另存两份）。 */
  async function save() {
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

  function groupsOf(groups, sessionId) {
    return groups.filter((group) => Array.isArray(group.members) && group.members.includes(sessionId))
  }

  function sharedGroup(groups, a, b) {
    return groups.find((group) => Array.isArray(group.members) && group.members.includes(a) && group.members.includes(b))
  }

  /** 交集合并：SA、SC 有交集就并成一个群，否则新建 {a,b}。 */
  function planGroup(groups, a, b, auto) {
    const sa = new Set([a])
    const sc = new Set([b])
    const used = new Set()
    for (const group of groupsOf(groups, a)) {
      used.add(group.id)
      for (const member of group.members) sa.add(member)
    }
    for (const group of groupsOf(groups, b)) {
      used.add(group.id)
      for (const member of group.members) sc.add(member)
    }
    const intersection = [...sa].filter((member) => sc.has(member))
    const id = 'G-' + Date.now().toString(36).toUpperCase()
    if (intersection.length > 0) {
      const members = [...new Set([...sa, ...sc])]
      return { action: 'merge', id, members, mergedFrom: [...used], auto }
    }
    return { action: 'new', id, members: [a, b], mergedFrom: [], auto }
  }

  async function upsertPair(cwd, a, b, auto) {
    const data = await readGroup(cwd)
    if (sharedGroup(data.groups, a, b)) return { ok: true, changed: false, group: sharedGroup(data.groups, a, b) }
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
    const controller = service('sessionController')
    if (!controller) return
    const notice = '〔信箱·群〕你们已入群 ' + result.group.id + '（成员 ' + result.group.members.length + ' 个）。之后发信会自动走群路由，回执仍按普通来信回。'
    for (const sessionId of [a, b]) {
      try {
        await controller.prompt({ requestId: 'mail-group-' + result.group.id + '-' + Math.random().toString(16).slice(2, 8), sessionId, mode: 'queue', content: [{ type: 'text', text: notice }] }, signalNow())
      } catch (error) {
        log('group notice failed', sessionId, error && error.message)
      }
    }
  }

    /** 某一侧的状态字母：P=已接收 A=已发送 R=处理中 B=待办 D=已解决。 */
  function sideCode(letter, side) {
    if (letter.status === 'blocked') return 'B'
    if (letter.status === 'done') return 'D'
    if (letter.status === 'acked' || letter.status === 'delivered') return 'R'
    return side === 'from' ? 'A' : 'P'
  }

  function sideDir(letter, side) {
    const code = sideCode(letter, side)
    return code === 'A' ? '已发送' : code === 'P' ? '已接收' : code === 'R' ? '处理中' : code === 'B' ? '待办' : '已解决'
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
    index[letter.id] = entry
    await writeFile(file, JSON.stringify(index, null, 2), 'utf8')
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
        const head = [
          '---',
          'mail_id: ' + letter.id,
          'type: ' + letter.type,
          'from: ' + letter.from,
          'to: ' + letter.to,
          'timestamp: ' + letter.sentAt,
          'status: ' + sideDir(letter, side),
          'side: ' + side,
          'dir_owner: ' + ((side === 'from' ? letter.fromSession : letter.toSession) || 'unknown'),
          letter.ackOf ? 'ack_of: ' + letter.ackOf : '',
          'path: ' + (letter.paths[side] || sideCode(letter, side)),
          '---',
          '',
          letter.body,
        ].filter((line) => line !== '')
        await writeFile(join(state.box.envelope, letter.id + '.' + side + '.md'), head.join('\n') + '\n', 'utf8')
        await updateIndex(cwd, letter, side)
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
    const target = sessionId || letter.toSession
    if (!target) return { queued: false, reason: 'no-target-session' }
    const schedule = service('schedule')
    if (schedule && typeof schedule.create === 'function') {
      try {
        const entry = await schedule.create(
          {
            title: '信箱 · ' + letter.from + ' → ' + letter.to,
            prompt: text,
            timing: { kind: 'after', after_seconds: 1 },
            target: { kind: 'session', sessionId: target },
          },
          undefined,
        )
        const scheduleId = entry && entry.id
        if (scheduleId) {
          let delivered = false
          try {
            if (typeof schedule.run === 'function') {
              await schedule.run({ id: scheduleId })
              delivered = true
            }
          } catch (error) {
            log('schedule run failed', error && error.message)
          }
          try {
            if (typeof schedule.edit === 'function') await schedule.edit({ id: scheduleId, action: 'delete' })
          } catch (error) {
            log('schedule cleanup failed', error && error.message)
          }
          if (delivered) return { queued: true, via: 'schedule', scheduleId }
        }
      } catch (error) {
        log('schedule notify failed', letter.id, error && error.message)
      }
    }
    const controller = service('sessionController')
    if (!controller) return { queued: false, reason: 'no-controller' }
    try {
      await controller.prompt({
        requestId: 'mail-' + letter.id + '-' + Math.random().toString(16).slice(2, 8),
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
      '〔信箱·待办〕' + letter.id,
      '来源：' + letter.from + '（会话 ' + (letter.fromSession || 'unknown') + '）→ ' + letter.to,
      '位置：' + (envelopePathOf(letter) || '(未落盘)'),
      '状态：' + sideDir(letter, 'to') + ' ' + sideCode(letter, 'to') + '（' + reason + '；' + Math.round(ackTimeoutMs / 60000) + ' 分钟内没拿到回执）',
    ].join('\n')
    for (const sessionId of [letter.fromSession, letter.toSession]) {
      if (!sessionId) continue
      const delivered = await deliverNotice(letter, notice, sessionId)
      if (delivered.queued) letter.notified.push(sessionId)
      else log('todo notice failed', sessionId, delivered.reason)
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
      '〔信箱索引〕' + letter.id,
      '来源：' + letter.from + '（会话 ' + (letter.fromSession || 'unknown') + '）· 类型 ' + letter.type,
      '位置：' + (path || '(未落盘)') + '（' + size + '）',
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

  function armSentinel(letter, delayMs) {
    const sentinel = sentinelOf(letter)
    if (sentinel.timer) clearTimeout(sentinel.timer)
    sentinel.delayMs = Math.max(SENTINEL_DELAYS[SENTINEL_DELAYS.length - 1], Number(delayMs) || SENTINEL_DELAYS[0])
    sentinel.dueAt = Date.now() + sentinel.delayMs
    sentinel.state = 'armed'
    sentinel.timer = setTimeout(() => { void fireSentinel(letter.id) }, sentinel.delayMs)
    if (typeof sentinel.timer.unref === 'function') sentinel.timer.unref()
  }

  async function fireSentinel(mailId) {
    const letter = find(mailId)
    if (!letter) return
    const sentinel = sentinelOf(letter)
    if (letter.deliveredAt || letter.status === 'acked' || letter.status === 'done' || letter.status === 'blocked') {
      clearSentinel(letter)
      return
    }
    if (await targetBusy(letter.toSession)) {
      // 10 秒内又变忙：放弃本次推送，回到等 idle 边；节拍缩表
      sentinel.state = 'waiting'
      const next = sentinel.delayMs === SENTINEL_DELAYS[0] ? SENTINEL_DELAYS[1] : Math.max(SENTINEL_DELAYS[3], Math.floor(sentinel.delayMs / 2))
      sentinel.delayMs = next
      await writeSentinelNote(letter, 'abort-busy', { nextDelayMs: next })
      return
    }
    const result = await push(letter)
    letter.push = result
    sentinel.attempts += 1
    sentinel.state = 'waiting'
    if (result.queued) {
      if (letter.status === 'pending') letter.status = 'pushed'
      if (!letter.pushedAt) letter.pushedAt = new Date().toISOString()
      await writeSentinelNote(letter, 'notified', { attempt: sentinel.attempts })
      await save()
    } else {
      await writeSentinelNote(letter, 'push-failed', { reason: result.reason })
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
    letter.toCwd = await cwdOf(letter.toSession).catch(() => undefined)
    letter.fromCwd = await cwdOf(letter.fromSession).catch(() => undefined)
    letter._cwd = letter.toCwd || letter.fromCwd || fallbackCwd
    if (!letter._cwd) {
      return { ok: false, error: { message: 'no workspace resolved for this letter (need cwdOf/registered session)', code: 'NO_WORKSPACE' } }
    }
    letter.paths = {}

    letters.push(letter)

    letter.push = await push(letter)
    letter.status = letter.push.queued ? 'pushed' : 'pending'
    if (letter.push.queued) letter.pushedAt = new Date().toISOString()
    if (letter.push && letter.push.queued) {
      if (await targetBusy(letter.toSession)) {
        // 目标忙：这一次推送已在对方队列里，触发器驻留等 idle 边，不再扫
        sentinelOf(letter).state = 'waiting'
        await writeSentinelNote(letter, 'wait-idle', {})
      } else {
        armSentinel(letter, SENTINEL_DELAYS[0])
        await writeSentinelNote(letter, 'confirm-window', { delayMs: SENTINEL_DELAYS[0] })
      }
    }
    await save()
    await archive(letter)
    armTimer(letter)
    await maybeGroup(letter)
    const routed = await routeOf(letter)
    if (routed) await appendLedger(letter.toCwd || letter.fromCwd, { at: new Date().toISOString(), mail_id: letter.id, side: 'to', note: 'route:group', groupId: routed.id }).catch(() => {})
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
    const touched = []
    for (const id of ids) {
      const letter = find(id)
      if (!letter || letter.deliveredAt) continue
      if (agent && letter.toSession && agent.id !== letter.toSession) continue
      letter.deliveredAt = new Date().toISOString()
      if (letter.status === 'pushed' || letter.status === 'pending') letter.status = 'delivered'
      clearTimer(id)
      touched.push(letter)
      changed = true
    }
    if (changed) {
      await save()
      // 送达也是一步，要写进 _index/_ledger，否则路径会跳过 R（处理中）
      for (const letter of touched) await archive(letter)
    }
  }

  /**
   * 会话状态边（哨兵触发器）：
   *   idle    → 目标空闲，等 10 秒确认窗（节拍随缩表可变）
   *   running → 目标变忙，正在倒计时的这次推送作废，触发器回到等待
   */
  async function noteStatus(agent, status) {
    if (!agent) return
    await load()
    const mine = letters.filter((letter) => letter.toSession === agent.id && !letter.deliveredAt && (letter.status === 'pushed' || letter.status === 'pending'))
    for (const letter of mine) {
      if (status === 'idle') {
        const sentinel = sentinelOf(letter)
        if (sentinel.state === 'armed') continue
        armSentinel(letter, sentinel.delayMs)
        await writeSentinelNote(letter, 'armed', { delayMs: sentinel.delayMs })
      } else if (status === 'running' || status === 'busy') {
        const sentinel = sentinelOf(letter)
        if (sentinel.state !== 'armed') continue
        clearSentinel(letter)
        sentinel.state = 'waiting'
        sentinel.delayMs = sentinel.delayMs === SENTINEL_DELAYS[0] ? SENTINEL_DELAYS[1] : Math.max(SENTINEL_DELAYS[3], Math.floor(sentinel.delayMs / 2))
        await writeSentinelNote(letter, 'abort-busy', { nextDelayMs: sentinel.delayMs })
      }
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
    if (shared) return { ok: true, cwd, changed: false, merged: false, group: shared }

    const union = new Set(members)
    const used = new Set()
    for (const group of data.groups) {
      if (group.members.some((member) => members.includes(member))) {
        used.add(group.id)
        for (const member of group.members) union.add(member)
      }
    }
    if (used.size > 0) data.groups = data.groups.filter((group) => !used.has(group.id))
    const group = {
      id: 'G-' + Date.now().toString(36).toUpperCase(),
      name: '群-' + members.length,
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

  return { send, ack, list, groupCreate, groupList, noteStep, noteStatus, sweepAtStart, root }
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
  ]) {
    try {
      await readFile(path, 'utf8')
    } catch {
      await writeFile(path, seed, 'utf8')
    }
  }
  return box
}
