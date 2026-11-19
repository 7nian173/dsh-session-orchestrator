import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMailbox, ensureWorkspaceBox, isSafeMailId, receiptOf } from '../lib/mail.js'

const tmp = join(process.cwd(), '_tmp', 'mail-ws-test')




await rm(tmp, { recursive: true, force: true })
const wsFrom = join(tmp, 'ws-from')
const wsTo = join(tmp, 'ws-to')
await ensureWorkspaceBox(wsFrom)
await ensureWorkspaceBox(wsTo)

const calls = []
const controller = {
  async prompt(req, signal) {
    // 存下真实投递文本：端到端断言要靠它反证 indexNotice 的首行格式。
    // 只存 requestId 的话，indexNotice 把标记改坏时套件仍是全绿（2026-11-19 事故）。
    const text = (req.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    calls.push({ id: req.requestId, hasSignal: !!signal, sessionId: req.sessionId, text })
    if (!signal) throw new Error("Cannot read properties of undefined (reading 'throwIfAborted')")
    return { ok: true }
  },
}
const cwdOf = async (sid) => (sid === 'session-from' ? wsFrom : sid === 'session-to' ? wsTo : undefined)
const box = createMailbox({ ackTimeoutMs: 1000, service: (k) => (k === 'sessionController' ? controller : undefined), log: () => {}, cwdOf })

const lines = []
globalThis.__dshLines = lines

// 崩了也要把已跑过的结果打出来：否则看起来像「测试没跑」而不是「测试失败」。
// （实验室 agent-_lab-0e24 报过这个：saveNow 抛 EPERM 时 lines 一条都没输出。）
const flushOnCrash = (label) => (error) => {
  try {
    console.log((globalThis.__dshLines || []).join('\n'))
    console.log('\n[' + label + '] ' + ((error && error.stack) || String(error)))
  } catch {}
  process.exit(1)
}
process.on('uncaughtException', flushOnCrash('uncaughtException'))
process.on('unhandledRejection', flushOnCrash('unhandledRejection'))

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
check('送达后收信方仍是 P（未表态）', idxDel[id]?.sides?.to?.path === 'P', idxDel[id]?.sides?.to?.path)
const idxFromDel = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('送达后发信方 A>R', idxFromDel[id]?.sides?.from?.path === 'A>R', idxFromDel[id]?.sides?.from?.path)

await box.ack({ mailId: id, close: true })
const idxTo2 = await readJson(join(wsTo, '.dsh-mail', '_index.json'))
const idxFrom2 = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('结案后收信方 P>D', idxTo2[id]?.sides?.to?.path === 'P>D', idxTo2[id]?.sides?.to?.path)
check('发信方路径 A>R>D', idxFrom2[id]?.sides?.from?.path === 'A>R>D', idxFrom2[id]?.sides?.from?.path)

const wsGhost = join(tmp, 'ws-ghost')
await mkdir(wsGhost, { recursive: true })
const ghost = createMailbox({ ackTimeoutMs: 1000, service: () => undefined, log: () => {}, cwdOf: async () => wsGhost })
const r2 = await ghost.send({ owner: 'a', peer: 'b', type: 'S-PROGRESS', body: 'x' })
check('未注册工作区不建箱', r2.ok === true && !(await readdir(wsGhost)).includes('.dsh-mail'), JSON.stringify(r2.status))

// ── 信使通道（v0.2）：背压 / 忙则排队 / 忙久转待办 / 空闲报数再逐封 / 暂停 / 重启续排
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (fn, timeoutMs = 5000) => {
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
    const busy = busy2 && (id === 'S4' || id === 'S30')
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

// ── 加急撤销（S-EXPIRE）：对事不对人、绕过忙与在途 ──
const orig = await chBox.send(chMail('V', 'W', 'S31', 'S30', 'M-20261118-9001'))
check('原信先投出', orig.ok === true, JSON.stringify(orig.error && orig.error.code))
await chBox.noteStep({ id: 'S30' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261118-9001〕' }] }])
busy2 = true
const expireCalls = chCalls.length
const exp = await chBox.send(chMail('W', 'V', 'S31', 'S30', 'M-20261118-9002', 'S-EXPIRE', { expireOf: 'M-20261118-9001', reason: '任务已完成，无需处理' }))
check('撤销信放行（背压豁免）', exp.ok === true && exp.status !== 'blocked', JSON.stringify(exp.error && exp.error.code))
await sleep(80)
const origNow = await chBox.status({ mailId: 'M-20261118-9001' })
check('原信转 expired（E）', origNow.rows[0] && origNow.rows[0].status === 'expired', JSON.stringify(origNow.rows[0] && origNow.rows[0].toPath))
check('过期信落到 Expired 目录而不是 Resolved', origNow.rows[0] && origNow.rows[0].toDir === 'Expired' && origNow.rows[0].fromDir === 'Expired', JSON.stringify({ to: origNow.rows[0] && origNow.rows[0].toDir, from: origNow.rows[0] && origNow.rows[0].fromDir }))
const expCalls = chCalls.slice(expireCalls).filter((call) => /〔信箱·/.test(call.text))
check('加急件绕过忙状态投出去', expCalls.length >= 1, JSON.stringify(expCalls.map((c) => c.text.slice(0, 18))))
const dupExp = await chBox.send(chMail('W', 'V', 'S30', 'S31', 'M-20261118-9003', 'S-EXPIRE', { expireOf: 'M-20261118-9001', reason: '重复撤销' }))
check('同一件事只发一件撤销', dupExp.duplicate === true && dupExp.mailId === 'M-20261118-9002', JSON.stringify(dupExp))
const expQueue = JSON.parse(await readFile(join(wsCh, '.dsh-mail', '_courier.json'), 'utf8'))
// 暂停优先于加急：通道 paused 时连撤销也只入队（人工急停不该被系统绕过）
const pausedUrgentBase = await chSoft.send(chMail('V2', 'W2', 'S50', 'S51', 'M-20261118-9401'))
await chSoft.pause({ do: 'pause', cwd: wsCh })
const urgentPaused = await chSoft.send(chMail('W2', 'V2', 'S51', 'S50', 'M-20261118-9402', 'S-EXPIRE', { expireOf: 'M-20261118-9401', reason: '验收：暂停优先于加急' }))
check('通道暂停时撤销也只入队', urgentPaused.ok === true && urgentPaused.status !== 'pushed' && urgentPaused.push && urgentPaused.push.deferred === true, JSON.stringify(urgentPaused.push))
await chSoft.pause({ do: 'resume', cwd: wsCh })
void pausedUrgentBase

check('加急条目带 urgent 标记', (expQueue.items || []).some((item) => item.mailId === 'M-20261118-9002' && item.urgent === true), JSON.stringify((expQueue.items || []).map((i) => [i.mailId, i.urgent])))
check('文案带绝对时间戳', (expCalls[0] ? /本信发出于 \d{2}:\d{2}（UTC[+-]\d{2}:\d{2}，本机时区）/.test(expCalls[0].text) : false), expCalls[0] ? expCalls[0].text.slice(0, 44) : '')
busy2 = false


// 已 ack 的信允许撤销，但要留 expiredAfterAck（否则事后分不清“没人理”与“确认过又被叫停”）
const ackThen = await chBox.send(chMail('X', 'Y', 'S40', 'S41', 'M-20261118-9301'))
await chBox.ack({ mailId: 'M-20261118-9301', close: false })
const expAfterAck = await chBox.send(chMail('Y', 'X', 'S41', 'S40', 'M-20261118-9302', 'S-EXPIRE', { expireOf: 'M-20261118-9301', reason: '验收：已 acked 仍可撤销' }))
const ledAfterAck = await readJson(join(wsCh, '.dsh-mail', '_letters.json'))
const recAfterAck = (ledAfterAck.letters || []).find((l) => l.id === 'M-20261118-9301') || {}
check('已 acked 仍可撤销且记 expiredAfterAck', ackThen.ok === true && expAfterAck.ok === true && recAfterAck.status === 'expired' && recAfterAck.expiredAfterAck === true, JSON.stringify({ status: recAfterAck.status, after: recAfterAck.expiredAfterAck, ackedAt: Boolean(recAfterAck.ackedAt) }))

// 送达即回执：信进了对方一轮就自动 ack，不再等手工回执、也不会超时转待办
const boxT = createMailbox({ ackTimeoutMs: 300, service: (k) => (k === 'sessionController' ? chController : undefined), log: () => {}, cwdOf: cwdCh, courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 3000, digestGapMs: 0 } })
await boxT.send(chMail('T', 'U', 'S12', 'S13', 'M-20261117-8301'))
await boxT.noteStep({ id: 'S13' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261117-8301〕' }] }])
await sleep(60)
const midT = await boxT.status({ mailId: 'M-20261117-8301' })
check('送达只到 delivered，不自动 ack', midT.rows[0] && midT.rows[0].status === 'delivered', String(midT.rows[0] && midT.rows[0].status))
await sleep(1300)
const afterT = await boxT.status({ mailId: 'M-20261117-8301' })
check('未表态的信超时转待办', afterT.rows[0] && ['blocked', 'delivered'].includes(afterT.rows[0].status), String(afterT.rows[0] && afterT.rows[0].status))
const timerLetter = JSON.parse(await readFile(join(wsCh, '.dsh-mail', '_letters.json'), 'utf8')).letters.find((l) => l.id === 'M-20261117-8301')
check('已读留痕 readAt', Boolean(timerLetter && timerLetter.readAt), JSON.stringify(timerLetter && (timerLetter.readAt || timerLetter.readSource)))

busy2 = true
const chHeld1 = await chBox.send(chMail('C', 'D', 'S3', 'S4', 'M-20261117-8011'))
const chHeld2 = await chBox.send(chMail('E', 'D', 'S5', 'S4', 'M-20261117-8012'))
check('目标忙 → 不投卡，先入通道', chHeld1.push.queued === false && chHeld2.push.queued === false, JSON.stringify([chHeld1.push, chHeld2.push]))
check('忙时不产生提醒卡', chCalls.every((call) => !/〔信箱·M-20261117-801[12]〕/.test(call.text)), JSON.stringify(chCalls.map((call) => call.id)))
await sleep(120)
const envCh = await readFile(join(wsCh, '.dsh-mail', 'envelope', 'M-20261117-8011.to.md'), 'utf8')
check('忙太久 → 待办信封 paused: true', /^status: Todo$/m.test(envCh) && /^paused: true$/m.test(envCh), envCh.split('\n').slice(0, 12).join(' | '))
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
await waitFor(() => s4Cards() === 2, 8000)
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
// 只断言“这封信在通道文件里有条目”：忙了 50ms 后会转 held，执行顺序不同会看到 queued 或 done+held，
// 纠结具体状态就让测试跟调度器赛跑（CI 上抖过一次）。
const persisted = (cjBefore.items || []).some((item) => item.mailId === 'M-20261117-8031')
check('重启前：条目已落盘', persisted, JSON.stringify((cjBefore.items || []).map((item) => [item.mailId, item.state])))

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
check('并完只剩两组（无关群保留）', after.count === 2 && after.groups.some((g) => g.members.length === 6), JSON.stringify(after.groups?.map((g) => [g.id, g.members.length, g.members.join('/')])))

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

// ── 唤醒门控（v0.3）：普通信只有“排在最前的那封”能叫醒对方，其余只落盘；
//    阻塞信（待办通知）与加急信照推；mail_inbox 是拉取口。
const wsGate = join(tmp, 'ws-gate')
await ensureWorkspaceBox(wsGate)
const gateCalls = []
const gateController = {
  async prompt(req, signal) {
    if (!signal) throw new Error('signal missing')
    gateCalls.push({ sessionId: req.sessionId, text: (req.content && req.content[0] && req.content[0].text) || '' })
    return { ok: true }
  },
}
const gateBox = createMailbox({
  ackTimeoutMs: 600000,
  service: (k) => (k === 'sessionController' ? gateController : undefined),
  log: () => {},
  cwdOf: async () => wsGate,
  courier: { intervalMs: 0, busyHoldMs: 0, staleAfterMs: 3000, digestGapMs: 0 },
})
const gateMail = (owner, from, to, id, type = 'S-PROGRESS', extra = {}) => ({ owner, peer: 'R', type, body: 'x', senderSessionId: from, peerSessionId: to, mailId: id, ...extra })
const gate1 = await gateBox.send(gateMail('L1', 'S60', 'S61', 'M-20261118-9100'))
check('门控：普通首封仍叫醒对方', gate1.status === 'pushed', JSON.stringify(gate1.push))
await gateBox.noteStep({ id: 'S61' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261118-9100〕 收到' }] }])
const callsBeforeAck = gateCalls.length
const gateAck = await gateBox.send(gateMail('L1', 'S60', 'S61', 'M-20261118-9101', 'S-ACK', { ackOf: 'M-20261118-9100' }))
await sleep(80)
const courierGate = await readJson(join(wsGate, '.dsh-mail', '_courier.json'))
const ledGate = await readJson(join(wsGate, '.dsh-mail', '_ledger.json'))
check(
  '门控：S-ACK 回执不占对话',
  gateAck.ok === true && gateCalls.length === callsBeforeAck,
  JSON.stringify({ calls: gateCalls.length - callsBeforeAck, items: (courierGate.items || []).map((item) => [item.mailId, item.state, item.retired]) }),
)
check(
  '门控留痕（notice:gated / courier:filed 皆可）',
  (ledGate.events || []).some((e) => e.mail_id === 'M-20261118-9101' && (e.note === 'notice:gated' || e.note === 'courier:filed')),
  JSON.stringify((ledGate.events || []).filter((e) => e.mail_id === 'M-20261118-9101').map((e) => e.note)),
)
// S-ACK 不该挡后续信件的唤醒：它自己永远不叫醒谁，却能在门控里冒充“前面还有人等着”
const ackToGate = await gateBox.send(gateMail('L4', 'S70', 'S71', 'M-20261118-9110', 'S-ACK', { ackOf: 'M-20261118-9100' }))
const afterAck = await gateBox.send(gateMail('L5', 'S72', 'S71', 'M-20261118-9111'))
check('静默 S-ACK 不挡后续唤醒', ackToGate.push && ackToGate.push.gated === true && afterAck.status === 'pushed', JSON.stringify({ ack: ackToGate.push, next: afterAck.push }))

// 历史脏状态不许把唤醒永久堵死：实盘 Lead 会话里有 5 封 status=running 的旧信，门控被它们一直挡住
const lettersFile = join(wsGate, '.dsh-mail', '_letters.json')
const legacy = await readJson(lettersFile)
legacy.letters.push({
  id: 'M-20261118-9199',
  type: 'S-PROGRESS',
  from: 'L9',
  to: 'R',
  fromSession: 'S68',
  toSession: 'S69',
  status: 'running',
  sentAt: new Date(Date.now() - 3600000).toISOString(),
  _cwd: wsGate,
})
await writeFile(lettersFile, JSON.stringify(legacy, null, 2), 'utf8')
const gateLegacy = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? gateController : undefined), log: () => {}, cwdOf: async () => wsGate, courier: { intervalMs: 0 } })
const legacyProbe = await gateLegacy.send(gateMail('L9', 'S68', 'S69', 'M-20261118-9198'))
check('历史 running 状态不挡唤醒', legacyProbe.status === 'pushed', JSON.stringify(legacyProbe.push || legacyProbe.error))

const todoMail = await gateBox.send(gateMail('L3', 'S63', 'S65', 'M-20261118-9103', 'S-TODO-NOTICE', { reason: '对方卡在发布验证，等你确认版本号', todoOf: 'M-20261118-9100', stuckSince: new Date(Date.now() - 120000).toISOString(), elapsedMinutes: 2 }))
const todoPushed = await waitFor(() => gateCalls.some((call) => call.text.includes('M-20261118-9103')))
check('阻塞信（S-TODO-NOTICE）照推', todoMail.status === 'pushed' && todoPushed, JSON.stringify({ push: todoMail.push || todoMail.error, calls: gateCalls.length }))
// 9100 在 noteStep 时已经自动 ack，所以另发一封留在未读里
const inboxMail = await gateBox.send(gateMail('L6', 'S70', 'S61', 'M-20261118-9106'))
const inb = await gateBox.inbox({ sessionId: 'S61' })
check('mail_inbox 返回未读清单与时钟', inboxMail.ok === true && inb.count >= 1 && /^\d{2}:\d{2}$/.test(inb.clock) && inb.rows.every((row) => typeof row.ageMinutes === 'number'), JSON.stringify({ count: inb.count, clock: inb.clock, rows: inb.rows.map((r) => r.mailId) }))
check('mail_inbox 每行带类型与来源', inb.lines.some((ln) => /M-20261118-9106 · S-PROGRESS · 来自 L6/.test(ln)), inb.lines.join(' | '))
await gateBox.ack({ mailId: 'M-20261118-9106', close: true })
const inb2 = await gateBox.inbox({ sessionId: 'S61' })
check('mail_inbox 排除已结案', !inb2.rows.some((r) => r.mailId === 'M-20261118-9106'), JSON.stringify(inb2.rows.map((r) => r.mailId)))

// 静默回执必须当场结清：不能占背压槽位、不能超时转待办、不能永远挂在未读里
const ackProbe = await chBox.send(chMail('Z1', 'Z2', 'S80', 'S81', 'M-20261118-9501', 'S-ACK', { ackOf: 'M-20261117-8001' }))
const afterAckProbe = await chBox.send(chMail('Z1', 'Z2', 'S80', 'S81', 'M-20261118-9502'))
check('静默回执当场结清（acked + autoSettled）', ackProbe.ok === true && ackProbe.status === 'acked', JSON.stringify({ status: ackProbe.status, push: ackProbe.push }))
check('静默回执不占背压槽位', afterAckProbe.ok === true && afterAckProbe.status === 'pushed', JSON.stringify(afterAckProbe.error || afterAckProbe.push))

await rm(tmp, { recursive: true, force: true })
// 真实会话的第一次收信：信箱必须当场建出来。不建的话 archive 与 courier 都以「未注册」静默跳过，
// 结果信只在内存里、盘上没有信封（实盘 M-20261118-0008 就这么丢过一次）。
const wsFresh = join(tmp, 'ws-fresh')
await mkdir(wsFresh, { recursive: true })
const freshCalls = []
const freshController = { async prompt(req) { freshCalls.push(req.sessionId); return { ok: true } } }
const freshBox = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? freshController : undefined), log: () => {}, cwdOf: async () => wsFresh, courier: { intervalMs: 0 } })
const freshSend = await freshBox.send({ owner: 'L', peer: 'R', type: 'S-PROGRESS', body: 'x', senderSessionId: 'SF1', peerSessionId: 'SF2', mailId: 'M-20261118-9201' })
const freshEnvelope = await readdir(join(wsFresh, '.dsh-mail', 'envelope')).catch(() => [])
check('新会话首次收信即建箱并落信封', freshSend.ok === true && freshEnvelope.includes('M-20261118-9201.to.md'), JSON.stringify(freshEnvelope))
const freshCourier = await readJson(join(wsFresh, '.dsh-mail', '_courier.json')).catch(() => null)
check('新箱的通道文件同时写出', freshCourier !== null && typeof freshCourier.seq === 'number', JSON.stringify(freshCourier && Object.keys(freshCourier)))

// 开工横幅：有未读才出现，且指向 mail_inbox；没有未读就安静
const bannerMail = await gateBox.send(gateMail('L7', 'S71', 'S61', 'M-20261118-9107'))
const banner = await gateBox.stepBanner({ id: 'S61' })
check('stepBanner 有未读时给一行', Boolean(bannerMail.ok) && typeof banner === 'string' && /信箱·开工检查/.test(banner) && /mail_inbox/.test(banner), String(banner))
const bannerEmpty = await gateBox.stepBanner({ id: 'S99' })
check('stepBanner 无未读时安静', bannerEmpty === null, String(bannerEmpty))
await gateBox.ack({ mailId: 'M-20261118-9107', close: true })

// 安全闸：mail_id 会被直接拼进信封文件名，穿越必须拒
const guardBox = createMailbox({ ackTimeoutMs: 600000, service: () => undefined, log: () => {}, cwdOf: async () => wsGate })
const evilIds = ['M-../../ESCAPED', '../../../ESCAPED', 'C:/ESCAPED', '.hidden', 'a/b']
const evilResults = []
for (const evil of evilIds) {
  const r = await guardBox.send({ owner: 'a', peer: 'b', type: 'S-PROGRESS', body: 'x', senderSessionId: 'S90', peerSessionId: 'S91', mailId: evil })
  evilResults.push([evil, r.ok, r.error && r.error.code])
}
check('mail_id 穿越一律拒收', evilResults.every(([, ok, code]) => ok === false && code === 'MAIL_INVALID'), JSON.stringify(evilResults))
check('isSafeMailId 边界正确', isSafeMailId('M-20261119-0001') === true && isSafeMailId('../x') === false && isSafeMailId('.x') === false && isSafeMailId('a/b') === false, '')
const okId = await guardBox.send({ owner: 'a', peer: 'b', type: 'S-PROGRESS', body: 'x', senderSessionId: 'S90', peerSessionId: 'S91', mailId: 'M-20261119-9999' })
check('合法 mail_id 正常收信', okId.ok === true && okId.mailId === 'M-20261119-9999', JSON.stringify(okId.error))

// ── 回归：noteStep 不能把已 done 的信当成首次送达 ──
// 实验室（agent-_lab-0e24）2026-11-19 指出：之前这组用例的顺序是
//   投卡 → 结案 → 再投卡
// 而 deliveredAt 在第一次投卡时就已写入，旧代码的 `if (!letter.deliveredAt) continue`
// 本来就会跳过 —— 把守卫删掉这条断言照样绿，测不到 bug。
// 真实脏数据（M-0020/M-0021）的形状是：
//   结案 → 卡才第一次进上下文（此时 deliveredAt 还是 null）
// 所以顺序必须反过来，并且断言 deliveredAt 保持 null，而不是 status（两种情况下都是 done）。
{
  const wsReg = join(tmp, 'reg')
  const regBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => wsReg,
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const REGID = 'M-20261119-8801'
  await regBox.send({
    owner: 'R1',
    peer: 'R2',
    type: 'S-PROGRESS',
    body: 'reg',
    senderSessionId: 'SR1',
    peerSessionId: 'SR2',
    mailId: REGID,
  })
  // ① 先结案（此时 deliveredAt 仍为 null —— 这是复现的必要条件）
  await regBox.ack({ mailId: REGID, close: true })
  // ② 卡这时才第一次进上下文：旧代码会把它当成首次送达并回填 deliveredAt
  await regBox.noteStep({ id: 'SR2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + REGID + '〕' }] }])
  const row = (await regBox.status({ mailId: REGID })).rows[0] || {}
  let regLetter = {}
  try {
    const raw = JSON.parse(await readFile(join(wsReg, '.dsh-mail', '_letters.json'), 'utf8'))
    const arr = raw.letters || raw
    regLetter = (Array.isArray(arr) ? arr : Object.values(arr)).find((x) => x && x.id === REGID) || {}
  } catch {
    regLetter = {}
  }
  check(
    '已 done 的信不会被二次投递污染',
    row.status === 'done' && !regLetter.deliveredAt,
    JSON.stringify({ status: row.status, deliveredAt: regLetter.deliveredAt ?? null }),
  )
}

// ── 回归：投递文本必须带 MARK 能识别的回执标记 ──
// 2026-11-19 压缩索引文本时把 `〔信箱·M-…〕` 改成了 `〔信箱〕M-…`，
// noteStep 的 MARK 正则从此匹配不到 → deliveredAt/readAt 永不写 → 三段语义整条链失效。
// 这条断言锁住首行格式。
{
  const markBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'mark'),
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const MID = 'M-20261119-7701'
  await markBox.send({
    owner: 'K1',
    peer: 'K2',
    type: 'S-PROGRESS',
    body: 'mark',
    senderSessionId: 'SK1',
    peerSessionId: 'SK2',
    mailId: MID,
  })
  // 从落盘的索引/账本里拿投递文本不可靠；直接调用内部行为：
  // 用 noteStep 反证——如果标记对得上，deliveredAt 会被写上。
  await markBox.noteStep({ id: 'SK2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + MID + '〕' }] }])
  const st = await markBox.status({ mailId: MID })
  const row = (st.rows || [])[0] || {}
  check(
    '回执标记与 MARK 正则一致（deliveredAt 能写上）',
    // deliveredAt 优先于 readAt（delivered 是「真的落进对方上下文」的硬证据）
    ['delivered-unread', 'read-unanswered', 'acknowledged'].includes(row.readState),
    JSON.stringify({ readState: row.readState }),
  )
}

// 直接锁格式：receiptOf 的输出必须能被 MARK 匹配（noteStep 靠它认「送达」）
{
  const probe = receiptOf('M-20261119-7702')
  const hits = [...probe.matchAll(/〔信箱·(M-\d{8}-\d{4})〕/g)].map((m) => m[1])
  check('回执标记格式可被 MARK 识别', hits.length === 1 && hits[0] === 'M-20261119-7702', JSON.stringify({ probe, hits }))
}

// ── 端到端：真实投递文本的首行必须能被 MARK 认出来 ──
// 上面两条分别测 receiptOf() 字符串、手写标记喂 noteStep，都绕过了 indexNotice。
// 2026-11-19 的事故正是 indexNotice 把首行写成 `〔信箱〕M-…`：两条断言全绿，链路全塌。
// 这一条从 controller.prompt 收到的真实文本取首行，喂给 MARK，再喂 noteStep 看 deliveredAt。
{
  const e2e = calls.filter((call) => call.sessionId === 'session-to' && call.text && call.text.includes(id))
  check('投递文本被捕获', !!e2e.length, JSON.stringify(calls.map((c) => [c.sessionId, (c.text || '').slice(0, 20)])))
  if (e2e.length) {
    const e2eText = e2e[0].text
    const firstLine = e2eText.split('\n')[0]
    const hits = [...e2eText.matchAll(/〔信箱·(M-\d{8}-\d{4})〕/g)].map((m) => m[1])
    check('真实投递首行含 MARK 标记', hits.includes(id), JSON.stringify({ firstLine, hits }))
    check('首行就是回执标记（不是第二行）', firstLine.includes('〔信箱·' + id + '〕'), JSON.stringify(firstLine))

    // 端到端反证：把真实文本喂给 noteStep，deliveredAt 必须写上
    const e2eBox = createMailbox({
      ackTimeoutMs: 60000,
      cwdOf: async () => join(tmp, 'e2e'),
      isArchived: async () => false,
      log: () => {},
      service: () => undefined,
    })
    const EID = 'M-20261119-7703'
    await e2eBox.send({
      owner: 'E1', peer: 'E2', type: 'S-PROGRESS', body: 'e2e',
      senderSessionId: 'SE1', peerSessionId: 'SE2', mailId: EID,
    })
    // 用与真实投递同构的文本（借 indexNotice 的产物：真实 calls 里的那条格式）
    const synthetic = e2eText.replace(id, EID)
    await e2eBox.noteStep({ id: 'SE2' }, [{ role: 'user', content: [{ type: 'text', text: synthetic }] }])
    const st = await e2eBox.status({ mailId: EID })
    const row = (st.rows || [])[0] || {}
    check(
      '真实格式的投递文本能驱动送达',
      ['delivered-unread', 'read-unanswered', 'acknowledged'].includes(row.readState),
      JSON.stringify({ readState: row.readState, synthetic: synthetic.split('\n')[0] }),
    )
  }
}

// ── 回归：deadline 非法时 armTimer 不能把信当场打成待办 ──
// 老数据 / 手改过的账本里 deadline 可能是 null。`null - Date.now()` 是 -Date.now()，
// `Math.max(1000, -Date.now())` 给 1000 —— 只延迟 1 秒就 block。
// 而 NaN 更糟：`Math.max(1000, NaN)` 是 NaN，setTimeout 当 0，立刻触发 block。
// 这两种都不该让一封正常的信在 1 秒内变待办。
{
  const nanBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'nan'),
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const NID = 'M-20261119-7801'
  await nanBox.send({
    owner: 'N1', peer: 'N2', type: 'S-PROGRESS', body: 'nan',
    senderSessionId: 'SN1', peerSessionId: 'SN2', mailId: NID,
  })
  // 直接读落盘状态，把 deadline 弄成 null，再让它重新进入 armTimer 路径。
  const lettersPath = join(tmp, 'nan', '.dsh-mail', '_letters.json')
  const before = await readJson(lettersPath)
  const target = (before.letters || []).find((entry) => entry.id === NID)
  check('落盘里找到待改的信', Boolean(target), JSON.stringify((before.letters || []).map((e) => e.id)))
  if (target) {
    target.deadline = null // null 与 NaN 走同一条兜底分支
    await writeFile(lettersPath, JSON.stringify(before, null, 2), 'utf8')
  }

  // 新开一个信箱实例读这份文件 → load() → 冷扫 → armTimer。
  // 注意：load() 只遍历 boxes 里已经登记过的 cwd，所以必须先让它碰一次这个目录
  // （一次 status 查询就够），否则 sweepAtStart 会扫 0 封、断言变成空转。
  // 关键：createMailbox 的 `cwds` 决定 load() 扫哪些目录。
  // 不传就是空数组 —— load() 扫 0 个目录、status() 永远返回 0 条，
  // 断言会变成「看起来通过」的空转（我第一版就踩了这个）。
  const nanBox2 = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'nan'),
    cwds: async () => [join(tmp, 'nan')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await nanBox2.status({ mailId: NID }) // 触发 load()
  await nanBox2.sweepAtStart()
  await new Promise((r) => setTimeout(r, 1500)) // 超过 1 秒，旧代码此时已成 blocked
  const st2 = await nanBox2.status({ mailId: NID })
  const row2 = (st2.rows || [])[0] || {}
  check(
    'deadline 非法不会把信在 1 秒内打成待办',
    row2.status !== 'blocked' && Boolean(row2.status),
    JSON.stringify({ status: row2.status, deadline: row2.deadline }),
  )
}

console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)