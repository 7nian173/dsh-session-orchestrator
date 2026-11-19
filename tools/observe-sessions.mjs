#!/usr/bin/env node
/**
 * 会话状态采样器。
 *
 * 目的：验证「agent 卡住 → 进入空闲 → 被塞进新信」这条链在真实多会话
 * 团队里到底怎么发生。这类问题只能跑出来，不能脑测 —— 单看某一天的
 * 终态看不出「什么时候卡了、卡了多久、卡完多久被塞了信」。
 *
 * 每次运行追加一行 JSONL。用追加而不是覆盖，是为了保住时间序列。
 *
 * 采什么：
 *   - 各成员的会话状态（running / idle / unknown）+ 上次状态变化时刻
 *   - 每封未结信的状态与时间戳（sentAt / pushedAt / deliveredAt / blockedAt）
 *   - 通道队列深度（queued / held / in-flight）
 *   - 进程心跳（判断 DSH 本身是不是活着）
 *   - 本次运行看到的「状态边」：与上次采样相比，谁从什么变成了什么
 *
 * 为什么记录「状态边」而不是只记录「状态」：
 *   一次采样看到一个会话 idle，无法判断它是「刚干完活」还是「卡了 3 小时」。
 *   只有把它和上一次采样对比，才知道它是什么时候进入 idle 的。
 *   所以每次采样都会读上一次的记录，算出边，并把边一起写下来。
 *
 * 用法：
 *   node tools/observe-sessions.mjs                    默认目标 Super-agent 工作区
 *   node tools/observe-sessions.mjs --cwd <工作区>      指定工作区
 *   node tools/observe-sessions.mjs --tag <标签>        给这次实验打个标记
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
// 数据落在插件仓库的上级（= 工作区根）下，属于这个插件的测试数据
const dataDir = join(dirname(repoRoot), '_observer')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const targetCwd = argOf('cwd', 'E:\\AI Projects\\Super-agent')
const tag = argOf('tag', 'default')
const bridgeRoot = 'D:\\dshdata\\session-bridge'

const seriesPath = join(dataDir, tag + '.jsonl')
const latestPath = join(dataDir, tag + '.latest.json')

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const now = new Date()
const nowMs = now.getTime()

/**
 * 会话状态：读插件的 friends 表（里面带 state 与 stateAt）。
 *
 * ⚠️ 按 sessionId 归并，不能按 name：同一个会话可以注册多个名字
 * （实测 `lead` 与 `决策` 都是 session-42635e1a），按名字算会把它算成两个会话，
 * 于是同一次状态变化被记两条边、idle 时长被统计两遍。
 */
const snapshotSessions = async () => {
  const table = await readJson(join(bridgeRoot, 'friends.json'), {})
  const bySession = new Map()
  for (const [name, row] of Object.entries(table || {})) {
    if (!row || typeof row !== 'object') continue
    // 没有 sessionId 的行保留（脚本注册的好友可能没有会话），用 name 当键
    const key = row.sessionId || 'name:' + name
    const prev = bySession.get(key)
    if (prev) {
      // 同一会话多名字：合并成一行，把别名都记下来
      prev.aliases.push(name)
      // 状态以较新的那个为准（stateAt 更晚的）
      const prevMs = prev.stateAt ? Date.parse(prev.stateAt) : 0
      const curMs = row.stateAt ? Date.parse(row.stateAt) : 0
      if (curMs > prevMs) {
        prev.state = row.state || 'unknown'
        prev.stateAt = row.stateAt || null
      }
      prev.inTarget = prev.inTarget || (typeof row.cwd === 'string' && row.cwd.toLowerCase() === targetCwd.toLowerCase())
      continue
    }
    bySession.set(key, {
      name,
      aliases: [name],
      sessionId: row.sessionId || null,
      state: row.state || 'unknown',
      stateAt: row.stateAt || null,
      cwd: row.cwd || null,
      inTarget: typeof row.cwd === 'string' && row.cwd.toLowerCase() === targetCwd.toLowerCase(),
    })
  }
  return [...bySession.values()]
}

/** 未结信件：只保留还没结案的，已经 done/acked/expired 的不需要每轮跟踪。 */
const snapshotLetters = async (cwd) => {
  const box = join(cwd, '.dsh-mail')
  if (!existsSync(box)) return { letters: [], boxExists: false }
  const raw = await readJson(join(box, '_letters.json'), { letters: [] })
  const open = (raw.letters || [])
    .filter((letter) => ['pending', 'pushed', 'delivered', 'blocked'].includes(letter.status))
    .map((letter) => ({
      id: letter.id,
      status: letter.status,
      from: letter.from,
      to: letter.to,
      fromSession: letter.fromSession || null,
      toSession: letter.toSession || null,
      sentAt: letter.sentAt || null,
      pushedAt: letter.pushedAt || null,
      deliveredAt: letter.deliveredAt || null,
      firstDeliveredAt: letter.firstDeliveredAt || null,
      blockedAt: letter.blockedAt || null,
      readAt: letter.readAt || null,
      readSource: letter.readSource || null,
      ackedAt: letter.ackedAt || null,
      deadline: letter.deadline || null,
      blockReason: letter.blockReason || null,
      urgent: letter.urgent === true,
      // 判断「卡了多久」用：这封信从发出到现在过了多久
      ageMs: letter.sentAt ? nowMs - Date.parse(letter.sentAt) : null,
      // 判断「送达后没人管多久」用
      sinceDeliveredMs: letter.deliveredAt ? nowMs - Date.parse(letter.deliveredAt) : null,
    }))
  return { letters: open, boxExists: true }
}

/** 通道队列：held/queued 的深度直接反映「有没有信在等」。 */
const snapshotCourier = async (cwd) => {
  const path = join(cwd, '.dsh-mail', '_courier.json')
  const raw = await readJson(path, null)
  if (!raw) return { exists: false, items: [], counts: {} }
  const items = (raw.items || []).map((item) => ({
    seq: item.seq,
    state: item.state,
    mailId: item.mailId || null,
    sessionId: item.sessionId || null,
    form: item.form || null,
    reason: item.reason || null,
    enqueuedAt: item.enqueuedAt || null,
    attempts: item.attempts || 0,
  }))
  const counts = {}
  for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1
  return { exists: true, paused: raw.paused === true, items, counts }
}

const snapshotHeartbeat = async () => {
  const raw = await readJson(join(bridgeRoot, 'heartbeat.json'), null)
  if (!raw) return { alive: false }
  const beatMs = raw.time ? Date.parse(raw.time) : 0
  return {
    alive: Number.isFinite(beatMs) && nowMs - beatMs < 30000,
    pid: raw.pid || null,
    beatAt: raw.time || null,
    // 心跳陈旧 = DSH 卡住或退出了，这条对判断「是不是团队真的空闲」很关键
    staleMs: Number.isFinite(beatMs) ? nowMs - beatMs : null,
    inflight: raw.inflight ?? null,
  }
}

/** 算状态边：与上次采样对比，谁变了、什么时间变的。 */
const diffAgainstPrevious = (prev, current) => {
  if (!prev) return { firstRun: true, sessionEdges: [], letterEdges: [] }

  const keyOf = (row) => row.sessionId || 'name:' + row.name
  const prevSessions = new Map((prev.sessions || []).map((row) => [keyOf(row), row]))
  const sessionEdges = []
  for (const row of current.sessions) {
    const key = keyOf(row)
    const before = prevSessions.get(key)
    if (!before) {
      sessionEdges.push({ name: row.name, sessionId: row.sessionId, from: '(new)', to: row.state })
      continue
    }
    if (before.state !== row.state) {
      sessionEdges.push({
        name: row.name,
        // 别名一起带上：同一个会话的另一个名字在别处被引用时能对上
        aliases: row.aliases && row.aliases.length > 1 ? row.aliases : undefined,
        sessionId: row.sessionId,
        from: before.state,
        to: row.state,
        // 这次采样到上一次采样的间隔：变化只保证发生在这段区间内，不是精确时刻
        observedAfterMs: nowMs - Date.parse(prev.at),
      })
    }
  }

  const prevLetters = new Map((prev.letters || []).map((row) => [row.id, row]))
  const letterEdges = []
  for (const row of current.letters) {
    const before = prevLetters.get(row.id)
    if (!before) {
      letterEdges.push({ id: row.id, from: '(new)', to: row.status, urgent: row.urgent })
      continue
    }
    if (before.status !== row.status) {
      letterEdges.push({ id: row.id, from: before.status, to: row.status, ageMs: row.ageMs })
    }
  }
  // 上一轮还在、这一轮消失 = 结案了（或换了工作区），这也是信息
  for (const [id, before] of prevLetters) {
    if (!current.letters.some((row) => row.id === id)) {
      letterEdges.push({ id, from: before.status, to: '(closed)' })
    }
  }

  return { firstRun: false, sessionEdges, letterEdges }
}

const main = async () => {
  await mkdir(dataDir, { recursive: true })
  const prev = await readJson(latestPath, null)

  const [sessions, letterBox, courier, heartbeat] = await Promise.all([
    snapshotSessions(),
    snapshotLetters(targetCwd),
    snapshotCourier(targetCwd),
    snapshotHeartbeat(),
  ])

  const current = {
    at: now.toISOString(),
    atLocal: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    tag,
    targetCwd,
    heartbeat,
    sessions,
    targetSessions: sessions.filter((row) => row.inTarget),
    letters: letterBox.letters,
    letterCount: letterBox.letters.length,
    courier,
  }

  const edges = diffAgainstPrevious(prev, current)
  const record = { ...current, edges }

  await appendFile(seriesPath, JSON.stringify(record) + '\n', 'utf8')
  await writeFile(latestPath, JSON.stringify(record, null, 2), 'utf8')

  // 控制台只打一行摘要，别刷屏（这个脚本会被定时器反复调用）
  const open = current.letterCount
  const held = courier.counts.held || 0
  const queued = courier.counts.queued || 0
  const sessionMoves = edges.sessionEdges.length
  const letterMoves = edges.letterEdges.length
  const stale = heartbeat.staleMs === null ? 'no-heartbeat' : heartbeat.staleMs + 'ms'
  console.log(
    `[observe ${current.atLocal}] open=${open} held=${held} queued=${queued} ` +
      `sessionEdges=${sessionMoves} letterEdges=${letterMoves} heartbeat=${heartbeat.alive ? 'alive' : 'STALE'}(${stale})`,
  )
  for (const e of edges.sessionEdges) console.log(`    session ${e.name}: ${e.from} -> ${e.to}`)
  for (const e of edges.letterEdges) console.log(`    letter ${e.id}: ${e.from} -> ${e.to}`)
}

main().catch((error) => {
  // 采样器自己不能崩：崩了会留下数据空洞，比采到的数据本身更误导
  console.error('[observe] failed:', (error && error.message) || String(error))
  process.exit(1)
})
