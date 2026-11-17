import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMailbox, ensureWorkspaceBox } from '../lib/mail.js'

const tmp = join(process.cwd(), '_tmp', 'mail-ws-test')
await rm(tmp, { recursive: true, force: true })
const wsFrom = join(tmp, 'ws-from')
const wsTo = join(tmp, 'ws-to')
await ensureWorkspaceBox(wsFrom)
await ensureWorkspaceBox(wsTo)

const calls = []
const controller = {
  async prompt(req, signal) {
    calls.push({ id: req.requestId, hasSignal: !!signal })
    if (!signal) throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')")
    return { ok: true }
  },
}
const cwdOf = async (sid) => (sid === 'session-from' ? wsFrom : sid === 'session-to' ? wsTo : undefined)
const box = createMailbox({ ackTimeoutMs: 1000, service: (k) => (k === 'sessionController' ? controller : undefined), log: () => {}, cwdOf })

const lines = []
let failed = 0
const check = (n, ok, d) => { lines.push((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); if (!ok) failed++ }
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))

const sent = await box.send({ owner: 'lead', peer: 'peer', type: 'S-PROGRESS', body: 'hello', senderSessionId: 'session-from', peerSessionId: 'session-to' })
check('send.push.queued', sent.ok === true && sent.push && sent.push.queued === true, JSON.stringify(sent.push || sent.error))
check('send.status=pushed', sent.status === 'pushed', String(sent.status))
const id = sent.mailId

const idxFrom = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
const idxTo = await readJson(join(wsTo, '.dsh-mail', '_index.json'))
check('发信方索引 A', idxFrom[id]?.sides?.from?.path === 'A', JSON.stringify(idxFrom[id]?.sides?.from))
check('收信方索引 P', idxTo[id]?.sides?.to?.path === 'P', JSON.stringify(idxTo[id]?.sides?.to))

const envFiles = await readdir(join(wsTo, '.dsh-mail', 'envelope'))
check('收信方信封落地', envFiles.includes(id + '.to.md'), envFiles.join(','))
const envText = await readFile(join(wsTo, '.dsh-mail', 'envelope', id + '.to.md'), 'utf8')
check('信封含 side/dir_owner/path', /side: to/.test(envText) && /dir_owner: session-to/.test(envText) && /path: P/.test(envText), envText.split('\n').slice(0, 10).join(' | '))

const led = await readJson(join(wsFrom, '.dsh-mail', '_ledger.json'))
check('留痕有事件', (led.events || []).length >= 1, JSON.stringify((led.events || []).map((e) => e.code)))

// 送达（pre-step 观测到回执标记）→ 路径要出现 R
await box.noteStep({ id: 'session-to' }, [{ content: [{ type: 'text', text: '〔信箱·' + id + '〕收到了' }] }])
const idxDel = await readJson(join(wsTo, '.dsh-mail', '_index.json'))
check('送达后收信方路径 P>R', idxDel[id]?.sides?.to?.path === 'P>R', idxDel[id]?.sides?.to?.path)
const idxFromDel = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('送达后发信方 A>R', idxFromDel[id]?.sides?.from?.path === 'A>R', idxFromDel[id]?.sides?.from?.path)

await box.ack({ mailId: id, close: true })
const idxTo2 = await readJson(join(wsTo, '.dsh-mail', '_index.json'))
const idxFrom2 = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('收信方路径 P>R>D', idxTo2[id]?.sides?.to?.path === 'P>R>D', idxTo2[id]?.sides?.to?.path)
check('发信方路径 A>R>D', idxFrom2[id]?.sides?.from?.path === 'A>R>D', idxFrom2[id]?.sides?.from?.path)

const wsGhost = join(tmp, 'ws-ghost')
await mkdir(wsGhost, { recursive: true })
const ghost = createMailbox({ ackTimeoutMs: 1000, service: () => undefined, log: () => {}, cwdOf: async () => wsGhost })
const r2 = await ghost.send({ owner: 'a', peer: 'b', type: 'S-PROGRESS', body: 'x' })
check('未注册工作区不建箱', r2.ok === true && !(await readdir(wsGhost)).includes('.dsh-mail'), JSON.stringify(r2.status))

// ── 信使通道（v0.2）：背压 / 忙则排队 / 忙久转待办 / 空闲报数再逐封 / 暂停 / 重启续排
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (fn, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(10)
  }
  return fn()
}
const wsCh = join(tmp, 'ws-ch')
await ensureWorkspaceBox(wsCh)
const cwdCh = async (sid) => (typeof sid === 'string' && sid.startsWith('S') ? wsCh : undefined)
let busy2 = false
const chCalls = []
const chController = {
  async prompt(req, signal) {
    if (!signal) throw new Error('signal missing')
    chCalls.push({ id: String(req.requestId), sessionId: req.sessionId, text: (req.content && req.content[0] && req.content[0].text) || '' })
    return { ok: true }
  },
  async state(request) {
    const id = request && request.sessionId
    const busy = busy2 && id === 'S4'
    return { running: busy, active: busy }
  },
}
const chBox = createMailbox({
  ackTimeoutMs: 600000,
  service: (k) => (k === 'sessionController' ? chController : undefined),
  log: () => {},
  cwdOf: cwdCh,
  courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 200, digestGapMs: 0 },
})
const chMail = (owner, peer, from, to, id, type = 'S-PROGRESS', extra = {}) => ({ owner, peer, type, body: 'x', senderSessionId: from, peerSessionId: to, mailId: id, ...extra })
const chA = await chBox.send(chMail('A', 'B', 'S1', 'S2', 'M-20261117-8001'))
check('首封放行', chA.ok === true && chA.status === 'pushed', JSON.stringify(chA.status))
const chB = await chBox.send(chMail('A', 'B', 'S1', 'S2', 'M-20261117-8002'))
check('背压：未结案不许再发', chB.ok === false && chB.error.code === 'PAIR_OUTSTANDING', JSON.stringify(chB.error && chB.error.code))
const chAck = await chBox.send(chMail('A', 'B', 'S1', 'S2', 'M-20261117-8003', 'S-ACK', { ackOf: 'M-20261117-8001' }))
check('S-ACK 豁免背压', chAck.ok === true, JSON.stringify(chAck.error && chAck.error.code))

// 软释放：对方一直不 ack，等过阈值就放行，并留一笔 backpressure:soft-release
const chSoft = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? chController : undefined), log: () => {}, cwdOf: cwdCh, courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 200, digestGapMs: 0 }, backpressureReleaseMs: 60 })
await chSoft.send(chMail('P', 'Q', 'S8', 'S9', 'M-20261117-8101'))
const softBlocked = await chSoft.send(chMail('P', 'Q', 'S8', 'S9', 'M-20261117-8102'))
check('软释放前仍拦（未到阈值）', softBlocked.ok === false && softBlocked.error.code === 'PAIR_OUTSTANDING', JSON.stringify(softBlocked.error && softBlocked.error.code))
await sleep(90)
const softPassed = await chSoft.send(chMail('P', 'Q', 'S8', 'S9', 'M-20261117-8103'))
check('过阈值 → 软释放放行', softPassed.ok === true && softPassed.released && softPassed.released.mailId === 'M-20261117-8101', JSON.stringify(softPassed.released))
const softLedger = await readJson(join(wsCh, '.dsh-mail', '_ledger.json'))
check('软释放留痕', (softLedger.events || []).some((e) => e.note === 'backpressure:soft-release' && e.mail_id === 'M-20261117-8101'), '')

// 送达不是终点：回执窗口从「对方看到」重新起算，delivered 的信仍要能转待办
const boxT = createMailbox({ ackTimeoutMs: 300, service: (k) => (k === 'sessionController' ? chController : undefined), log: () => {}, cwdOf: cwdCh, courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 3000, digestGapMs: 0 } })
await boxT.send(chMail('T', 'U', 'S12', 'S13', 'M-20261117-8301'))
await boxT.noteStep({ id: 'S13' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261117-8301〕' }] }])
await sleep(60)
const midT = await boxT.status({ mailId: 'M-20261117-8301' })
check('送达后先停在 delivered', midT.rows[0] && midT.rows[0].status === 'delivered', String(midT.rows[0] && midT.rows[0].status))
await sleep(1300)
const afterT = await boxT.status({ mailId: 'M-20261117-8301' })
check('送达后仍会超时转待办', afterT.rows[0] && afterT.rows[0].status === 'blocked', String(afterT.rows[0] && afterT.rows[0].status))
const timerLetter = JSON.parse(await readFile(join(wsCh, '.dsh-mail', '_letters.json'), 'utf8')).letters.find((l) => l.id === 'M-20261117-8301')
check('转待办留痕 todo_since', Boolean(timerLetter && timerLetter.todoSince), JSON.stringify(timerLetter && timerLetter.todoSince))

busy2 = true
const chHeld1 = await chBox.send(chMail('C', 'D', 'S3', 'S4', 'M-20261117-8011'))
const chHeld2 = await chBox.send(chMail('E', 'D', 'S5', 'S4', 'M-20261117-8012'))
check('目标忙 → 不投卡，先入通道', chHeld1.push.queued === false && chHeld2.push.queued === false, JSON.stringify([chHeld1.push, chHeld2.push]))
check('忙时不产生提醒卡', chCalls.every((call) => !/〔信箱·M-20261117-801[12]〕/.test(call.text)), JSON.stringify(chCalls.map((call) => call.id)))
await sleep(120)
const envCh = await readFile(join(wsCh, '.dsh-mail', 'envelope', 'M-20261117-8011.to.md'), 'utf8')
check('忙太久 → 待办信封 paused: true', /^status: 待办$/m.test(envCh) && /^paused: true$/m.test(envCh), envCh.split('\n').slice(0, 12).join(' | '))
const cj = await readJson(join(wsCh, '.dsh-mail', '_courier.json'))
check('持有队列落盘', Array.isArray(cj.items) && cj.items.some((item) => item.mailId === 'M-20261117-8011' && item.state === 'held'), JSON.stringify(cj.items.map((item) => [item.mailId, item.state])))


busy2 = false
const callsFor = (sid) => chCalls.filter((call) => call.sessionId === sid)
const s4Cards = () => callsFor('S4').filter((call) => /〔信箱·待收〕/.test(call.text)).length
const s4Summary = () => callsFor('S4').find((call) => /封没处理/.test(call.text)) || null
await chBox.noteStatus({ id: 'S4' }, 'idle')
await waitFor(() => Boolean(s4Summary()))
check('空闲 → 先报数', Boolean(s4Summary()), JSON.stringify(s4Summary() && s4Summary().text.slice(0, 40)))
await waitFor(() => s4Cards() >= 1)
check('逐封：先只递一封', s4Cards() === 1, String(s4Cards()) + ' | ' + JSON.stringify(callsFor('S4').map((call) => call.text.slice(0, 12))))
await sleep(80)
check('上一张没被消费 → 不发下一张', s4Cards() === 1, String(s4Cards()))

await chBox.noteStep({ id: 'S4' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261117-8011〕 收到' }] }])
await waitFor(() => s4Cards() === 2)
check('上一张被消费 → 递下一封', s4Cards() === 2, String(s4Cards()))

// 发信方拿的是聚合摘要：说清原因、给排位，避免把待办读成沉默
const senderDigest = chCalls.find((call) => /不是对方不理你/.test(call.text))
check('发信方摘要解释原因并给排位', Boolean(senderDigest) && /排第|马上递/.test(senderDigest.text), JSON.stringify(senderDigest && senderDigest.text.slice(0, 80)))

await chBox.pause({ do: 'pause', cwd: wsCh })
await sleep(60)
const beforePause = chCalls.length
const pausedSend = await chBox.send(chMail('F', 'G', 'S6', 'S7', 'M-20261117-8022'))
check('暂停：只入队不投', pausedSend.push.queued === false && pausedSend.push.reason === 'channel-paused', JSON.stringify(pausedSend.push))
await sleep(80)
check('暂停期间不投递', chCalls.length === beforePause, String(chCalls.length - beforePause))
const pauseStatus = await chBox.pause({ do: 'status', cwd: wsCh })
check('暂停状态可查且报积压', pauseStatus.paused === true && pauseStatus.pending >= 1, JSON.stringify({ paused: pauseStatus.paused, pending: pauseStatus.pending }))
const chStatus = await chBox.status({ mailId: 'M-20261117-8012' })
check('mail_status 带通道队列', chStatus.queue && chStatus.queue.paused === true && chStatus.queue.pending >= 1, JSON.stringify(chStatus.queue))

await chBox.pause({ do: 'resume', cwd: wsCh })
await waitFor(() => chCalls.length > beforePause)
check('恢复后继续投递', chCalls.length > beforePause, String(chCalls.length - beforePause))

// 重启续排：独立工作区里排一条待投，新实例从 _courier.json 续上
const wsCh2 = join(tmp, 'ws-ch2')
await ensureWorkspaceBox(wsCh2)
const cwdCh2 = async (sid) => (typeof sid === 'string' && sid.startsWith('R') ? wsCh2 : undefined)
let busy3 = true
const restartCalls = []
const mkRestartController = () => ({
  async prompt(req, signal) {
    if (!signal) throw new Error('signal missing')
    restartCalls.push({ id: String(req.requestId), sessionId: req.sessionId, text: (req.content && req.content[0] && req.content[0].text) || '' })
    return { ok: true }
  },
  async state() { return { running: busy3, active: busy3 } },
})
const firstLife = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? mkRestartController() : undefined), log: () => {}, cwdOf: cwdCh2, cwds: async () => [wsCh2], courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 400, digestGapMs: 0 } })
const queuedOnce = await firstLife.send({ owner: 'H', peer: 'I', type: 'S-PROGRESS', body: 'x', senderSessionId: 'R1', peerSessionId: 'R2', mailId: 'M-20261117-8031' })
check('重启前：忙则只入队', queuedOnce.push.queued === false && restartCalls.length === 0, JSON.stringify(queuedOnce.push))
await firstLife.pause({ do: 'pause', cwd: wsCh2 })
busy3 = false
const cjBefore = await readJson(join(wsCh2, '.dsh-mail', '_courier.json'))
const queuedBefore = (cjBefore.items || []).filter((item) => item.state === 'queued' || item.state === 'held').length
check('重启前：条目已落盘', queuedBefore >= 1, JSON.stringify(cjBefore.items.map((item) => item.state)))

// 新进程 = 新实例，只读磁盘；先恢复通道，验证真的会续投
const secondLife = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? mkRestartController() : undefined), log: () => {}, cwdOf: cwdCh2, cwds: async () => [wsCh2], courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 400, digestGapMs: 0 } })
await secondLife.pause({ do: 'resume', cwd: wsCh2 })
await secondLife.sweepAtStart()
await waitFor(() => restartCalls.some((call) => /〔信箱·/.test(call.text)))
check('新实例从 _courier.json 续排', restartCalls.some((call) => /〔信箱·/.test(call.text)), JSON.stringify(restartCalls.map((call) => call.text.slice(0, 20))))

// ── 群路由：阈值 3 自动建群 + 交集合并
const gb = createMailbox({ ackTimeoutMs: 600000, service: () => undefined, log: () => {}, cwdOf: async () => wsTo })
let gid = 0
const pairSend = async (a, b, times) => {
  for (let i = 0; i < times; i++) {
    gid += 1
    const sent = await gb.send({ owner: a, peer: b, type: 'S-PROGRESS', body: 'x', senderSessionId: a, peerSessionId: b, mailId: 'M-20261117-9' + String(gid).padStart(3, '0') })
    // v0.2 背压：同一对未结案的信最多一封，往返要真的回执
    if (sent && sent.ok) await gb.ack({ mailId: sent.mailId })
  }
}
await pairSend('A1', 'B1', 3)
const g1 = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
check('阈值到 → 自动建群 A1-B1', (g1.groups || []).some((g) => g.members.includes('A1') && g.members.includes('B1') && g.auto === true), JSON.stringify((g1.groups || []).map((g) => g.members)))

await pairSend('C1', 'B1', 3)
await pairSend('A1', 'C1', 3)
const g2 = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
const merged = (g2.groups || []).filter((g) => ['A1', 'B1', 'C1'].every((m) => g.members.includes(m)))
check('交集合并成一个群', merged.length === 1 && (g2.groups || []).length === 1, JSON.stringify((g2.groups || []).map((g) => g.members)))
check('合并留下 mergedFrom', merged[0] && Array.isArray(merged[0].mergedFrom) && merged[0].mergedFrom.length === 2, JSON.stringify(merged[0]?.mergedFrom))

// 再发一封，走群路由（留痕记录 route:group）
await gb.send({ owner: 'A1', peer: 'B1', type: 'S-PROGRESS', body: 'x', senderSessionId: 'A1', peerSessionId: 'B1', mailId: 'M-20261117-9999' })
const ledRoute = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
check('群路由留痕', (ledRoute.events || []).some((e) => e.mail_id === 'M-20261117-9999' && e.note === 'route:group'), '')

// ── 显式建群 API（自然语言/命名行两条触发最终都调它）
const cr = await gb.groupCreate({ memberA: 'A1', memberB: 'B1', cwd: wsTo })
check('显式建群幂等（已在群里）', cr.ok === true && cr.changed === false, JSON.stringify({ changed: cr.changed, id: cr.group?.id }))
const cs = await gb.groupCreate({ memberA: 'D1', memberB: 'E1', cwd: wsTo })
check('显式建群新群', cs.ok === true && cs.changed === true && (cs.group.members || []).length === 2, JSON.stringify(cs.group?.members))
const ls = await gb.groupList({ cwd: wsTo })
check('列群', ls.ok === true && ls.count === 2, JSON.stringify(ls.groups?.map((g) => g.members)))
const bad = await gb.groupCreate({ memberA: 'X1', memberB: 'Y1', cwd: join(tmp, 'ws-none') })
check('未注册工作区建群被拒', bad.ok === false && bad.error.code === 'NO_MAILBOX', JSON.stringify(bad.error))

// ── 多人建群与跨群并合
const multi = await gb.groupCreate({ members: ['F1', 'G1', 'H1'], cwd: wsTo })
check('三人新群', multi.ok === true && multi.changed === true && multi.group.members.length === 3, JSON.stringify(multi.group?.members))
const mergeRes = await gb.groupCreate({ members: ['A1', 'F1'], cwd: wsTo })
check('跨群并合（两个群并成一个）', mergeRes.ok === true && mergeRes.merged === true && mergeRes.group.members.length === 6, JSON.stringify(mergeRes.group?.members))
const after = await gb.groupList({ cwd: wsTo })
check('并完只剩两组（无关群保留）', after.count === 2 && after.groups.some((g) => g.members.length === 6), JSON.stringify(after.groups?.map((g) => g.members.length)))

// ── 任务专用通道：一对一、带 TTL、不参与并群、可被普通群提升、到期回收
const ch = await gb.createTaskChannel({ ownerSessionId: 'O1', memberSessionId: 'M1', memberCwd: wsTo, ttlMs: 600000 })
check('专用通道建成', ch.ok === true && ch.channels.length >= 1, JSON.stringify(ch.channels))
const gA = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
const scoped = (gA.groups || []).find((g) => g.id === ch.channels[0].id)
check('通道带 scope=task 与 TTL', scoped && scoped.scope === 'task' && Boolean(scoped.expiresAt), JSON.stringify({ scope: scoped?.scope, name: scoped?.name }))

await pairSend('P1', 'Q1', 3)
const gB = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
check('别人建群不吃掉通道', (gB.groups || []).some((g) => g.id === scoped.id), '')

const promoted = await gb.groupCreate({ members: ['O1', 'M1'], cwd: wsTo })
const gC = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
const sameP = (gC.groups || []).filter((g) => g.members.includes('O1') && g.members.includes('M1'))
check('同对被提升成普通群而不是再建一个', sameP.length === 1 && sameP[0].scope !== 'task', JSON.stringify(sameP.map((g) => ({ id: g.id, scope: g.scope }))))

const ch2 = await gb.createTaskChannel({ ownerSessionId: 'R1', memberSessionId: 'S1', memberCwd: wsTo, ttlMs: 60000 })
const gD = await readJson(join(wsTo, '.dsh-mail', 'group.json'))
const doomed = (gD.groups || []).find((g) => g.id === ch2.channels[0].id)
doomed.expiresAt = new Date(Date.now() - 1000).toISOString()
await writeFile(join(wsTo, '.dsh-mail', 'group.json'), JSON.stringify(gD, null, 2), 'utf8')
const retired = await gb.pruneTaskGroups(wsTo, 0)
check('TTL 到期被回收', retired.length === 1 && retired[0].reason === 'ttl', JSON.stringify(retired))
const ledRetire = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
check('回收留痕', (ledRetire.events || []).some((e) => e.note === 'channel:retired'), '')

await rm(tmp, { recursive: true, force: true })
console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)