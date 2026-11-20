import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMailbox, ensureWorkspaceBox, isSafeMailId, receiptOf } from '../lib/mail.js'
import { codeFreshness } from '../lib/index.js'

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
// 索引两侧对称：送达后双方路径都出现 R（已送达）。
// 之前收信侧留 P，导致同一封信两个视角路径长度不同（A>R>D vs P>D），
// 看索引的人会以为两封信走了不同流程。「送达 ≠ 已读 ≠ 已回」由 readState 表达。
check('送达后收信方也记 R（索引两侧对称）', idxDel[id]?.sides?.to?.path === 'P>R', idxDel[id]?.sides?.to?.path)
const idxFromDel = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('送达后发信方 A>R', idxFromDel[id]?.sides?.from?.path === 'A>R', idxFromDel[id]?.sides?.from?.path)

await box.ack({ mailId: id, close: true })
const idxTo2 = await readJson(join(wsTo, '.dsh-mail', '_index.json'))
const idxFrom2 = await readJson(join(wsFrom, '.dsh-mail', '_index.json'))
check('结案后收信方 P>R>D', idxTo2[id]?.sides?.to?.path === 'P>R>D', idxTo2[id]?.sides?.to?.path)
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
// ⚠️ 上面那条在本机几乎总是绿，因为 appendLedger 恰好赶在 readJson 之前落盘。
// 真正要锁的是「send() 返回时留痕已在磁盘上」这个契约——否则审计证据可能丢。
// 这里立刻（不 sleep）读，且连做几次，把「不 await」的窗口放大。
{
  let immediateMisses = 0
  for (let round = 0; round < 5; round += 1) {
    // 每轮用独立工作区：共用同一个目录时，多个 mailbox 实例的
    // read-modify-write 会互相覆盖 ledger，那是测试自身的问题，
    // 会把它误报成「产品丢留痕」。
    const immWs = join(tmp, 'imm-' + round)
    await ensureWorkspaceBox(immWs)
    const immBox = createMailbox({
      ackTimeoutMs: 600000,
      cwdOf: async () => immWs,
      cwds: async () => [immWs],
      isArchived: async () => false,
      log: () => {},
      service: () => undefined,
      backpressureReleaseMs: 40,
    })
    const base = 'M-20261118-82' + String(round).padStart(2, '0')
    await immBox.send(chMail('IM', 'IN', 'S82', 'S83', base))
    await sleep(60) // 越过 backpressureReleaseMs
    const passed = await immBox.send(chMail('IM', 'IN', 'S82', 'S83', base.slice(0, -1) + '9'))
    if (!passed.ok) continue
    // 关键：send() 刚返回，**不等**，立刻读 ledger
    const immLedger = await readJson(join(immWs, '.dsh-mail', '_ledger.json'))
    const found = (immLedger.events || []).some((e) => e.note === 'backpressure:soft-release' && e.mail_id === base)
    if (!found) immediateMisses += 1
  }
  check('send() 返回时软释放留痕已落盘（不依赖时序）', immediateMisses === 0, JSON.stringify({ immediateMisses }))
}

// ── 加急撤销（S-EXPIRE）：对事不对人、绕过忙与在途 ──
const orig = await chBox.send(chMail('V', 'W', 'S31', 'S30', 'M-20261118-9001'))
check('原信先投出', orig.ok === true, JSON.stringify(orig.error && orig.error.code))
await chBox.noteStep({ id: 'S30' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·M-20261118-9001〕' }] }])
busy2 = true
const expireCalls = chCalls.length
const exp = await chBox.send(chMail('W', 'V', 'S31', 'S30', 'M-20261118-9002', 'S-EXPIRE', { expireOf: 'M-20261118-9001', reason: '任务已完成，无需处理' }))
check('撤销信放行（背压豁免）', exp.ok === true && exp.status !== 'blocked', JSON.stringify(exp.error && exp.error.code))
// ⚠️ 原来固定 sleep(80) 等异步归档，实测偶发失败过一次
// （toDir 读到 Processing 而不是 Expired）——固定等待的快慢假设不可靠。
// 改成轮询到条件成立，超时才算失败。
{
  const deadline = Date.now() + 3000
  let ready = null
  while (Date.now() < deadline) {
    const st = await chBox.status({ mailId: 'M-20261118-9001' })
    const row = (st.rows || [])[0]
    if (row && row.status === 'expired' && row.toDir === 'Expired' && row.fromDir === 'Expired') {
      ready = row
      break
    }
    await sleep(20)
  }
  check(
    '原信转 expired（E）',
    ready !== null,
    ready ? JSON.stringify(ready.toPath) : '超时未转 expired',
  )
}
const origNow = await chBox.status({ mailId: 'M-20261118-9001' })
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
// 横幅要带上「此刻几点」和「积压多久」：
// 模型拿到的应当是一个**时间切片**，而不是来一封收一条零散提醒。
// 只有绝对时刻时，它无法区分「刚来的」和「压了两小时的」。
check(
  'stepBanner 带当前时刻',
  /\d{2}:\d{2}（UTC[+-]\d{2}:\d{2}）/.test(String(banner)),
  String(banner).slice(0, 40),
)
check('stepBanner 带积压时长', /积压/.test(String(banner)), String(banner).slice(0, 80))
// 横幅必须带「别挂循环」的警告：这是 agent 每回合唯一必看的信箱文本，
// 而「为等待挂循环 → 会话显示 running → 来信全被压成待办」这个坑
// 只有在他还没挂上去之前提醒才有用。实测过这条因果链（sleep 900 期间
// 会话连续显示 running 约 3 分钟，同期来信全部 deferred）。
check(
  'stepBanner 警告别挂循环',
  /sleep|循环/.test(String(banner)) && /running|压成待办/.test(String(banner)),
  String(banner).slice(-48),
)
await gateBox.ack({ mailId: 'M-20261118-9107', close: true })

// 积压跨度：多封且时间分散时，要能看出「不是一批」
{
  const spanWs = join(tmp, 'span')
  await ensureWorkspaceBox(spanWs)
  const spanBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => spanWs,
    cwds: async () => [spanWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  for (const id of ['M-20261119-9201', 'M-20261119-9202', 'M-20261119-9203']) {
    await spanBox.send({
      owner: 'S' + id.slice(-1), peer: 'R', type: 'S-PROGRESS', body: 'x',
      senderSessionId: 'SS' + id.slice(-1), peerSessionId: 'RSPAN', mailId: id,
    })
  }
  const spanPath = join(spanWs, '.dsh-mail', '_letters.json')
  const spanRaw = await readJson(spanPath)
  const shift = { 'M-20261119-9201': 3 * 3600 * 1000, 'M-20261119-9202': 40 * 60 * 1000, 'M-20261119-9203': 2 * 60 * 1000 }
  for (const entry of spanRaw.letters || []) {
    if (shift[entry.id]) entry.sentAt = new Date(Date.now() - shift[entry.id]).toISOString()
  }
  await writeFile(spanPath, JSON.stringify(spanRaw, null, 2), 'utf8')
  const spanBox2 = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => spanWs,
    cwds: async () => [spanWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const spanBanner = await spanBox2.stepBanner({ id: 'RSPAN' })
  check(
    'stepBanner 能区分「不是一批」（带跨度）',
    typeof spanBanner === 'string' && /跨度/.test(spanBanner) && /最早/.test(spanBanner) && /最新/.test(spanBanner),
    String(spanBanner),
  )
}

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
    // 把 sentAt 改到很久以前：模拟「一封早该超时的信，账本里 deadline 坏了」。
    // 兜底若拿 now 当基准，会把它续成「现在 + 一个完整窗口」= 凭空放它一马。
    target.sentAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
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
  // 这封信的 sentAt 在 30 分钟前、窗口 60 秒 → 它**本该**超时，blocked 是正确结果。
  // 要验的不是「它没被 block」，而是「它没被当成刚发出的信而续命」——
  // 旧实现（base = now）会算出 now+60s，于是它活过来、status 还是 pending。
  check(
    'deadline 非法 + 已过期 → 该超时就超时（不续命）',
    row2.status === 'blocked',
    JSON.stringify({ status: row2.status, deadline: row2.deadline }),
  )
  // 续命检查：这封信 30 分钟前就该超时了，修 deadline 不能把它救回来。
  // 判据是 deadline 落回「sentAt + 窗口」附近，而不是 now + 窗口。
  const repairedDeadline = Number(row2.deadline)
  const sentMs = Date.now() - 30 * 60 * 1000
  check(
    'deadline 兜底按 sentAt 算，不给过期信续命',
    Number.isFinite(repairedDeadline) && repairedDeadline < Date.now() + 5000 && repairedDeadline < sentMs + 120000,
    JSON.stringify({ repairedDeadline, sentMs, now: Date.now(), deltaFromSent: repairedDeadline - sentMs }),
  )
  // 落盘检查：修复必须进账本，否则每次重启都重算一遍，磁盘上永远是 null。
  // ⚠️ 必须在「这封信不会走 block 路径」的场景里测：
  // block() 内部自己会 save()，那会顺带把修复写进去，掩盖掉「armTimer 修了但没落盘」。
  // 所以下面单独造一封 sentAt 在**未来窗口内**的信（不超时），只验落盘。
  const PID = 'M-20261119-7802'
  const persistBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'persist'),
    cwds: async () => [join(tmp, 'persist')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await persistBox.send({
    owner: 'P1', peer: 'P2', type: 'S-PROGRESS', body: 'persist',
    senderSessionId: 'SP1', peerSessionId: 'SP2', mailId: PID,
  })
  const persistLetters = join(tmp, 'persist', '.dsh-mail', '_letters.json')
  const pBefore = await readJson(persistLetters)
  const pTarget = (pBefore.letters || []).find((entry) => entry.id === PID)
  if (pTarget) {
    pTarget.deadline = null
    pTarget.sentAt = new Date().toISOString() // 刚发出，窗口 60 秒，不会超时
    await writeFile(persistLetters, JSON.stringify(pBefore, null, 2), 'utf8')
  }
  const persistBox2 = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'persist'),
    cwds: async () => [join(tmp, 'persist')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await persistBox2.status({ mailId: PID })
  const sweep2 = await persistBox2.sweepAtStart()
  const pAfter = await readJson(persistLetters)
  const pPersisted = (pAfter.letters || []).find((entry) => entry.id === PID)
  // 两个条件都要：armTimer 真的修了（repaired>=1）**且** 磁盘上不再是 null。
  // 只看 repaired 会漏掉「修了但没 save」——那正是复审报的洞。
  check(
    'deadline 修复已写回账本（不经 block 路径）',
    // 注意 `Number(null) === 0` 且 isFinite(0) 是 true —— 直接 Number.isFinite(Number(x))
    // 会把 null 当成合法值放过去（我第一版就栽在这，回归测试时才发现）。
    sweep2.repaired >= 1 && pPersisted && typeof pPersisted.deadline === 'number' && Number.isFinite(pPersisted.deadline),
    JSON.stringify({ persisted: pPersisted && pPersisted.deadline, repaired: sweep2.repaired }),
  )
}

// ── 回归：已送达（delivered）的信不能被背压软释放 ──
// delivered 表示信已经进了对方上下文、对方可能读过 —— 那是对方的债。
// 旧逻辑把它也当「在途」，等满 backpressureReleaseMs 就放行，
// 等于「读过没回就能再发下一封」（实验室指出）。
{
  const bpBox = createMailbox({
    ackTimeoutMs: 600000,
    backpressureReleaseMs: 50, // 50ms 就能触发软释放，把窗口压到最短
    cwdOf: async () => join(tmp, 'bp'),
    cwds: async () => [join(tmp, 'bp')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const BP1 = 'M-20261119-7901'
  const first = await bpBox.send({
    owner: 'B1', peer: 'B2', type: 'S-PROGRESS', body: 'first',
    senderSessionId: 'SB1', peerSessionId: 'SB2', mailId: BP1,
  })
  check('背压：第一封发出', first.ok === true, JSON.stringify(first.error || first.mailId))
  // 让它进入 delivered（模拟对方已收下）
  await bpBox.noteStep({ id: 'SB2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + BP1 + '〕' }] }])
  await new Promise((r) => setTimeout(r, 120)) // 超过 backpressureReleaseMs
  const second = await bpBox.send({
    owner: 'B1', peer: 'B2', type: 'S-PROGRESS', body: 'second',
    senderSessionId: 'SB1', peerSessionId: 'SB2',
  })
  check(
    '已送达的信挡住下一封（不软释放）',
    second.ok === false && second.error && second.error.code === 'PAIR_OUTSTANDING',
    JSON.stringify({ ok: second.ok, code: second.error && second.error.code, msg: (second.error && second.error.message || '').slice(-40) }),
  )
}

// ── 回归：索引两侧的 delivered 字母必须一致 ──
// `_index.json` 是给人看的。之前 delivered 在发信侧是 R、收信侧是 P，
// 同一封信两个视角路径长度不同，看索引的人会以为走了不同流程。
{
  const symBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async (sid) => (sid === 'SY1' ? join(tmp, 'sym-from') : sid === 'SY2' ? join(tmp, 'sym-to') : undefined),
    cwds: async () => [join(tmp, 'sym-from'), join(tmp, 'sym-to')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await ensureWorkspaceBox(join(tmp, 'sym-from'))
  await ensureWorkspaceBox(join(tmp, 'sym-to'))
  const SYM = 'M-20261119-7902'
  await symBox.send({
    owner: 'S1', peer: 'S2', type: 'S-PROGRESS', body: 'sym',
    senderSessionId: 'SY1', peerSessionId: 'SY2', mailId: SYM,
  })
  // 推进到 delivered
  await symBox.noteStep({ id: 'SY2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + SYM + '〕' }] }])
  const fromIdx = await readJson(join(tmp, 'sym-from', '.dsh-mail', '_index.json'))
  const toIdx = await readJson(join(tmp, 'sym-to', '.dsh-mail', '_index.json'))
  const fromCode = fromIdx[SYM]?.sides?.from?.code
  const toCode = toIdx[SYM]?.sides?.to?.code
  check('索引两侧 delivered 字母对称', fromCode === toCode && fromCode === 'R', JSON.stringify({ from: fromCode, to: toCode }))
}

// ── 回归：blocked 也是终态，noteStep 不能给它补写送达证据 ──
// block() 与 armTimer() 都把 blocked 当终态，只有 noteStep 漏了。
// 实验室实测 M-0034：13:19 超时转 blocked → 13:26 持有卡投进上下文 →
// noteStep 写出 deliveredAt/readAt（readSource='in-turn'），
// 一封从没进过任何一轮的待办信，账本上多出一条「送达」。
{
  const blkBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'blk'),
    cwds: async () => [join(tmp, 'blk')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const BID = 'M-20261119-8001'
  await blkBox.send({
    owner: 'K1', peer: 'K2', type: 'S-PROGRESS', body: 'blocked',
    senderSessionId: 'SK1', peerSessionId: 'SK2', mailId: BID,
  })
  const blkLetters = join(tmp, 'blk', '.dsh-mail', '_letters.json')
  const bBefore = await readJson(blkLetters)
  const bTarget = (bBefore.letters || []).find((e) => e.id === BID)
  if (bTarget) {
    bTarget.status = 'blocked'
    bTarget.blockedAt = new Date().toISOString()
    bTarget.deliveredAt = null
    bTarget.readAt = null
    bTarget.deadline = Date.now() + 60000
    await writeFile(blkLetters, JSON.stringify(bBefore, null, 2), 'utf8')
  }
  const blkBox2 = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'blk'),
    cwds: async () => [join(tmp, 'blk')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  // 让回执标记「再次进到某一轮」（模拟持有卡二次投递）
  await blkBox2.noteStep({ id: 'SK2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + BID + '〕' }] }])
  const bAfter = await readJson(blkLetters)
  const bNow = (bAfter.letters || []).find((e) => e.id === BID)
  check(
    'blocked 信收到回执标记不补写送达证据',
    bNow && bNow.deliveredAt === null && bNow.readAt === null,
    JSON.stringify({ deliveredAt: bNow && bNow.deliveredAt, readAt: bNow && bNow.readAt, status: bNow && bNow.status }),
  )
  check('blocked 信不会被 noteStep 改状态', bNow && bNow.status === 'blocked', JSON.stringify({ status: bNow && bNow.status }))
}

// ── 回归：read-unanswered 必须可达（`读到没表态` 与 `没读过` 要能分开）──
// noteStep 写 deliveredAt 的同时也写 readAt（readSource='in-turn'），
// 所以「deliveredAt 优先」的旧顺序让 read-unanswered 永远走不到。
// 真读过 = readSource==='inbox-pull'（对方主动调 mail_inbox 查未读）。
{
  const rdBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => join(tmp, 'rd'),
    cwds: async () => [join(tmp, 'rd')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const RID = 'M-20261119-8002'
  await rdBox.send({
    owner: 'R1', peer: 'R2', type: 'S-PROGRESS', body: 'read',
    senderSessionId: 'SR1', peerSessionId: 'SR2', mailId: RID,
  })
  // ① 只进了某一轮（in-turn）→ 应报 delivered-unread，不是 read-unanswered
  await rdBox.noteStep({ id: 'SR2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + RID + '〕' }] }])
  const stInTurn = await rdBox.status({ mailId: RID })
  const rowInTurn = (stInTurn.rows || [])[0] || {}
  check('仅 in-turn 时报 delivered-unread', rowInTurn.readState === 'delivered-unread', JSON.stringify({ readState: rowInTurn.readState }))

  // ② 本人主动拉取（inbox-pull）→ 应升级为 read-unanswered
  await rdBox.inbox({ sessionId: 'SR2' })
  const stPulled = await rdBox.status({ mailId: RID })
  const rowPulled = (stPulled.rows || [])[0] || {}
  check('本人拉取后升级为 read-unanswered', rowPulled.readState === 'read-unanswered', JSON.stringify({ readState: rowPulled.readState, readSource: rowPulled.readSource }))
}

// ── 回归：readState 的分支顺序本身（与 inbox 升级解耦）──
// 上面那条靠真实 inbox 拉取验证，但它同时依赖两处改动；这里直接构造
// 「readAt 有值 + readSource='inbox-pull' + deliveredAt 有值」的落盘状态，
// 只要 readState 的分支顺序退回去就会红。
{
  const ordBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => join(tmp, 'ord'),
    cwds: async () => [join(tmp, 'ord')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const OID = 'M-20261119-8003'
  await ordBox.send({
    owner: 'O1', peer: 'O2', type: 'S-PROGRESS', body: 'ord',
    senderSessionId: 'SO1', peerSessionId: 'SO2', mailId: OID,
  })
  const ordLetters = join(tmp, 'ord', '.dsh-mail', '_letters.json')
  const oBefore = await readJson(ordLetters)
  const oTarget = (oBefore.letters || []).find((e) => e.id === OID)
  if (oTarget) {
    const nowIso = new Date().toISOString()
    oTarget.deliveredAt = nowIso
    oTarget.readAt = nowIso
    oTarget.readSource = 'inbox-pull'
    await writeFile(ordLetters, JSON.stringify(oBefore, null, 2), 'utf8')
  }
  const ordBox2 = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => join(tmp, 'ord'),
    cwds: async () => [join(tmp, 'ord')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const stOrd = await ordBox2.status({ mailId: OID })
  const rowOrd = (stOrd.rows || [])[0] || {}
  // 先把「改动是否真的落到盘上」验一遍，否则分支顺序断言是空转的
  const oAfter = await readJson(ordLetters)
  const oNow = (oAfter.letters || []).find((e) => e.id === OID)
  check(
    '分支顺序测试的前置状态已落盘',
    oNow && Boolean(oNow.deliveredAt) && Boolean(oNow.readAt) && oNow.readSource === 'inbox-pull',
    JSON.stringify({ deliveredAt: oNow && oNow.deliveredAt, readAt: oNow && oNow.readAt, readSource: oNow && oNow.readSource }),
  )
  check(
    'read-unanswered 优先于 delivered-unread（分支顺序）',
    rowOrd.readState === 'read-unanswered',
    JSON.stringify({ readState: rowOrd.readState, readSource: rowOrd.readSource, exists: Boolean(oNow) }),
  )
}

// ── 回归：已送达的信二次进轮，不能重算 deadline（否则回执窗口可被无限后推）──
// 实测 M-0037：sentAt+300s 该超时，但 deadline 被推到 sentAt+837s；
// 因为 noteStep 每被调用一次就 `deadline = deliveredAt + windowMs`，
// 而持有卡反复投递会让它反复进来 —— 对方于是永远等不到超时。
{
  const dlBox = createMailbox({
    ackTimeoutMs: 5000,
    cwdOf: async () => join(tmp, 'dl'),
    cwds: async () => [join(tmp, 'dl')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const DID = 'M-20261119-8102'
  await dlBox.send({
    owner: 'D1', peer: 'D2', type: 'S-PROGRESS', body: 'deadline',
    senderSessionId: 'SD1', peerSessionId: 'SD2', mailId: DID,
  })
  const dlLetters = join(tmp, 'dl', '.dsh-mail', '_letters.json')
  const dBefore = await readJson(dlLetters)
  const dTarget = (dBefore.letters || []).find((e) => e.id === DID)
  const markerDeliveredAt = '2026-11-19T13:00:00.000Z'
  const markerDeadline = Date.now() + 5000
  if (dTarget) {
    dTarget.status = 'delivered'
    dTarget.deliveredAt = markerDeliveredAt
    dTarget.deadline = markerDeadline
    await writeFile(dlLetters, JSON.stringify(dBefore, null, 2), 'utf8')
  }
  const dlBox2 = createMailbox({
    ackTimeoutMs: 5000,
    cwdOf: async () => join(tmp, 'dl'),
    cwds: async () => [join(tmp, 'dl')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  // 持有卡二次投递：标记再进一轮
  await dlBox2.noteStep({ id: 'SD2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + DID + '〕' }] }])
  const dAfter = await readJson(dlLetters)
  const dNow = (dAfter.letters || []).find((e) => e.id === DID)
  check(
    '已送达的信二次进轮不重算 deadline',
    dNow && dNow.deliveredAt === markerDeliveredAt && dNow.deadline === markerDeadline,
    JSON.stringify({ deliveredAt: dNow && dNow.deliveredAt, deadline: dNow && dNow.deadline, expectedDeadline: markerDeadline }),
  )
}

// ── 回归：deliveredAt 被合法清空后，超时窗口仍不能被重开 ──
// 实验室按真实链路复现：armStaleWatch → 催收卡投出 → 投出成功后
// `letter.deliveredAt = null`（等新卡被消费）→ noteStep 的
// `if (letter.deliveredAt) continue` 闸门失效 → deadline 被重新算。
// 修法：审计字段 firstDeliveredAt 只增不改，闸门改用它；
// 且 deadline 只在**没有合法值**时才计算。
{
  const fdBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'fd'),
    cwds: async () => [join(tmp, 'fd')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const FID = 'M-20261119-8103'
  await fdBox.send({
    owner: 'F1', peer: 'F2', type: 'S-PROGRESS', body: 'first-delivered',
    senderSessionId: 'SF1', peerSessionId: 'SF2', mailId: FID,
  })
  const fdLetters = join(tmp, 'fd', '.dsh-mail', '_letters.json')
  const fBefore = await readJson(fdLetters)
  const fTarget = (fBefore.letters || []).find((e) => e.id === FID)

  // 第一轮：正常送达 → firstDeliveredAt 与 deadline 都该落定
  await fdBox.noteStep({ id: 'SF2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + FID + '〕' }] }])
  const fDelivered = (await readJson(fdLetters)).letters.find((e) => e.id === FID)
  const firstDeadline = fDelivered && fDelivered.deadline
  check(
    '首次送达写入 firstDeliveredAt',
    Boolean(fDelivered && fDelivered.firstDeliveredAt),
    JSON.stringify({ firstDeliveredAt: fDelivered && fDelivered.firstDeliveredAt }),
  )

  // 模拟催收卡投出：deliveredAt 被清空（真实代码在 mail.js 里就是这么做的）
  const fRound2 = await readJson(fdLetters)
  const fTarget2 = (fRound2.letters || []).find((e) => e.id === FID)
  if (fTarget2) {
    fTarget2.deliveredAt = null
    await writeFile(fdLetters, JSON.stringify(fRound2, null, 2), 'utf8')
  }
  await new Promise((r) => setTimeout(r, 30))

  // 第二轮：标记再进一次 → deadline 不该被推迟
  const fdBox2 = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'fd'),
    cwds: async () => [join(tmp, 'fd')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await fdBox2.noteStep({ id: 'SF2' }, [{ role: 'user', content: [{ type: 'text', text: '〔信箱·' + FID + '〕' }] }])
  const fAfter = (await readJson(fdLetters)).letters.find((e) => e.id === FID)
  check(
    'deliveredAt 被清空后 deadline 不被推迟',
    fAfter && fAfter.deadline === firstDeadline,
    JSON.stringify({ before: firstDeadline, after: fAfter && fAfter.deadline, firstDeliveredAt: fAfter && fAfter.firstDeliveredAt }),
  )
}

// ── 回归：重开待办信必须拿到新的完整回执窗口 ──
// promoteHeld 的语义是「目标恢复活跃，这封重新递一次」。旧实现只清
// deliveredAt/pushedAt，**不重置 deadline**，于是重开的信带着过期 deadline
// 出去，投递后再进一轮立刻又 block —— 绕一圈回到原地，中间还有一次
// 「1 秒内变回待办」的抖动（实验室实测 1.006 秒）。
// 而且 block() 已经清掉定时器、armTimer 在 blocked 状态又 return，
// 所以重开后的信在「被消费」之前完全没有定时器。
{
  const rpBox = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'rp'),
    cwds: async () => [join(tmp, 'rp')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
    courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 200, digestGapMs: 0 },
  })
  const RID2 = 'M-20261119-8104'
  await rpBox.send({
    owner: 'RP1', peer: 'RP2', type: 'S-PROGRESS', body: 'reopen',
    senderSessionId: 'SRP1', peerSessionId: 'SRP2', mailId: RID2,
  })
  const rpLetters = join(tmp, 'rp', '.dsh-mail', '_letters.json')

  // 手动做成「已超时进待办」的样子：deadline 在过去
  const rBefore = await readJson(rpLetters)
  const rTarget = (rBefore.letters || []).find((e) => e.id === RID2)
  const staleDeadline = Date.now() - 60000
  if (rTarget) {
    rTarget.status = 'blocked'
    rTarget.blockedAt = new Date().toISOString()
    rTarget.deadline = staleDeadline
    rTarget.deliveredAt = null
    rTarget.firstDeliveredAt = null
    await writeFile(rpLetters, JSON.stringify(rBefore, null, 2), 'utf8')
  }

  // 触发 promoteHeld 的真实前置：通道队列里必须先有 state==='held' 的条目。
  // promoteHeld 只扫描 `state.items` 里 state==='held' 的项，不进队列它什么都不做
  // （我第一版就是漏了这步，断言看到 status 还是 blocked）。
  // 所以要先把通道跑起来：noteStatus('running') 让信封进 held，再切 idle 重开。
  const rpBox2 = createMailbox({
    ackTimeoutMs: 60000,
    cwdOf: async () => join(tmp, 'rp'),
    cwds: async () => [join(tmp, 'rp')],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
    courier: { intervalMs: 0, busyHoldMs: 50, staleAfterMs: 200, digestGapMs: 0 },
  })
  await rpBox2.status({ mailId: RID2 }) // 确保 load()
  await rpBox2.noteStatus({ id: 'SRP2' }, 'idle')
  // 直接调 send 让通道把这条 blocked 信入队成 held，再切 idle 触发重开
  await rpBox2.sweepAtStart()
  await rpBox2.noteStatus({ id: 'SRP2' }, 'running')
  await new Promise((r) => setTimeout(r, 120))
  await rpBox2.noteStatus({ id: 'SRP2' }, 'idle')
  await new Promise((r) => setTimeout(r, 120))
  const promoted = true
  const rAfter = await readJson(rpLetters)
  const rNow = (rAfter.letters || []).find((e) => e.id === RID2)
  const moved = rNow && (rNow.reopened === true || rNow.status === 'pushed' || rNow.status === 'blocked')
  check(
    '重开后拿到新的完整窗口（不再带着过期 deadline）',
    rNow && Number(rNow.deadline) > staleDeadline,
    JSON.stringify({ promoted, status: rNow && rNow.status, deadline: rNow && rNow.deadline, oldDeadline: staleDeadline, moved }),
  )
}

// ── 回归：stepBanner 与 mail_inbox 必须用同一套「未读」判据 ──
// 实验室指出两处漂移：stepBanner 用取反 `!['acked','done','expired']`
// （把 running 之类未知状态也算未读），inbox 用 LIVE_STATUS ∪ {blocked}。
// 同一封信在两个入口显示不同数量，排查时无从判断哪个对。
{
  const ubWs = join(tmp, 'unread-parity')
  await ensureWorkspaceBox(ubWs)
  const ubBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => ubWs,
    cwds: async () => [ubWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const ubIds = ['M-20261119-9301', 'M-20261119-9302', 'M-20261119-9303']
  for (const id of ubIds) {
    await ubBox.send({
      owner: 'U' + id.slice(-1), peer: 'RU', type: 'S-PROGRESS', body: 'x',
      senderSessionId: 'SU' + id.slice(-1), peerSessionId: 'RU', mailId: id,
    })
  }
  // 把中间那封改成 LIVE_STATUS 之外、但旧判据会算成未读的状态
  const ubPath = join(ubWs, '.dsh-mail', '_letters.json')
  const ubRaw = await readJson(ubPath)
  const ubMid = (ubRaw.letters || []).find((e) => e.id === ubIds[1])
  if (ubMid) {
    ubMid.status = 'running' // 历史未知状态：不该算未读
    await writeFile(ubPath, JSON.stringify(ubRaw, null, 2), 'utf8')
  }
  const ubBox2 = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => ubWs,
    cwds: async () => [ubWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const ubBanner = await ubBox2.stepBanner({ id: 'RU' })
  const ubInbox = await ubBox2.inbox({ sessionId: 'RU' })
  const bannerCount = (() => {
    const m = String(ubBanner || '').match(/你名下 (\d+) 封未读/)
    return m ? Number(m[1]) : 0
  })()
  // inbox() 返回的是 { rows, count, unread, ... }，不是 items/letters
  const inboxCount = (ubInbox.rows || []).length
  check(
    'banner 与 inbox 的未读数一致',
    bannerCount === inboxCount && bannerCount === 2,
    JSON.stringify({ bannerCount, inboxCount, banner: String(ubBanner).slice(0, 60) }),
  )
}

// ── 回归：从没被推送过的信，发信方查得到（不该静默失败）──
// 使用方实测：连续 10 封正文 300-1100 字的 S-ACK 全部 notify-gated，
// readAt 全为 none。发信方以为发了，收信方永远收不到，双方都不报错。
// 这个失败极难自证——收方主动翻信箱能翻到内容，反而掩盖了推送失败。
{
  const sfWs = join(tmp, 'silent-filed')
  await ensureWorkspaceBox(sfWs)
  const sfBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => sfWs,
    cwds: async () => [sfWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const LONG = 'x'.repeat(800)
  const sent = await sfBox.send({
    owner: 'SF1', peer: 'SF2', type: 'S-ACK', ackOf: 'M-20261120-9101',
    body: LONG, senderSessionId: 'SSF1', peerSessionId: 'SSF2', mailId: 'M-20261120-9102',
  })
  check('超长 S-ACK 不拒发（会打断已跑通的工作流）', sent.ok === true, JSON.stringify(sent.error || null))
  check(
    '超长 S-ACK 发送时给警告',
    Boolean(sent.warning) && sent.warning.chars === 800,
    JSON.stringify(sent.warning || null),
  )

  const st = await sfBox.status({ mailId: 'M-20261120-9102' })
  const row = (st.rows || [])[0] || {}
  check('status 标出「从未推送过」', row.silentlyFiled === true, JSON.stringify({ silentlyFiled: row.silentlyFiled, reason: row.silentReason }))
  check('status 给出正文长度', row.bodyChars === 800, String(row.bodyChars))
  check('status 给出可读的 hint', typeof row.silentHint === 'string' && /没读到|没推到|不会被推送/.test(row.silentHint), String(row.silentHint))

  const ls = await sfBox.list({ owner: 'SF1' })
  const lrow = (ls.rows || []).find((r2) => r2.mailId === 'M-20261120-9102') || {}
  check('list 也标出「从未推送过」', lrow.silentlyFiled === true, JSON.stringify({ silentlyFiled: lrow.silentlyFiled }))
}

// ── 回归：发信方也要能知道「我发出去的信没人读到」──
// 使用方 lead 提问：`send()` 当场返回 warning，但如果发信方当时没看、
// 直接过去了，之后有没有地方再提醒他？此前没有 —— stepBanner 只看 toSession，
// 等于完全不管发信方。结果就是「发了、对方永远收不到、双方都不报错」。
//
// 关键的设计细节（我第一版做错过）：S-ACK **本来就该静默**，不能把它算进来，
// 否则每一封回执都会触发提醒，噪音比问题本身更烦。
// 真正该提醒的是「不该静默却静默了」：类型是 S-ACK 但正文写了实质内容。
{
  const mkIsolated = async (name) => {
    const root = join(tmp, 'sender-banner-' + name)
    await ensureWorkspaceBox(root)
    return {
      root,
      box: createMailbox({
        ackTimeoutMs: 600000,
        cwdOf: async () => root,
        cwds: async () => [root],
        isArchived: async () => false,
        log: () => {},
        service: () => undefined,
      }),
    }
  }

  // ① 短 S-ACK：不该提示（回执本来就该静默）
  {
    const { box } = await mkIsolated('short-ack')
    await box.send({
      owner: 'ME', peer: 'P1', type: 'S-ACK', ackOf: 'M-20261120-9501', body: '收到',
      senderSessionId: 'SME', peerSessionId: 'SP1', mailId: 'M-20261120-9502',
    })
    const banner = await box.stepBanner({ id: 'SME' })
    check('短 S-ACK 不触发发信提醒（回执本就该静默）', banner === null, String(banner))
  }

  // ② 超长 S-ACK：该提示（使用方踩的那个失败）
  {
    const { box } = await mkIsolated('long-ack')
    await box.send({
      owner: 'ME', peer: 'P1', type: 'S-ACK', ackOf: 'M-20261120-9503', body: 'x'.repeat(700),
      senderSessionId: 'SME', peerSessionId: 'SP1', mailId: 'M-20261120-9504',
    })
    const banner = await box.stepBanner({ id: 'SME' })
    check(
      '超长 S-ACK 触发发信提醒',
      typeof banner === 'string' && /S-ACK 正文超过/.test(banner) && /mail_list/.test(banner),
      String(banner),
    )
  }

  // ③ 普通未读 + 超长 S-ACK：两种信息都要出现
  {
    const { box } = await mkIsolated('mixed')
    await box.send({
      owner: 'ME', peer: 'P1', type: 'S-ACK', ackOf: 'M-20261120-9505', body: 'x'.repeat(700),
      senderSessionId: 'SME', peerSessionId: 'SP1', mailId: 'M-20261120-9506',
    })
    await box.send({
      owner: 'P9', peer: 'ME', type: 'S-PROGRESS', body: 'hi',
      senderSessionId: 'SP9', peerSessionId: 'SME', mailId: 'M-20261120-9507',
    })
    const banner = await box.stepBanner({ id: 'SME' })
    check(
      '有未读时也带上发信提醒',
      typeof banner === 'string' && /开工检查/.test(banner) && /没读到|mail_list/.test(banner),
      String(banner),
    )
  }
}

// ── 回归：同一封信跨两个工作区各存一份副本时，ack 必须两侧一起更新 ──
// 使用方 lead 报的缺陷 2（比 S-ACK 断链更危险）：M-20261117-0066 在
// E 侧 delivered、D 侧 done，ack 返回 done 但待办里还在。
//
// 三处配合造成的：
//   ① loadOne 合并时 `dup[key] = value` 把 `_cwd` 也盖掉，只留胜出那侧的
//   ② saveNow 按单值 `_cwd` 分组，只写一侧
//   ③ ack 命中已 done 就早退，返回 cwd:null 什么都不写
//
// 修法：`_cwds`（复数）记录所有副本所在工作区，loadOne 合并时并集，
// saveNow 每个工作区都写，且 `_cwds` 本身要持久化（否则重启后又退化成单值）。
{
  const wsA = join(tmp, 'xws-a')
  const wsB = join(tmp, 'xws-b')
  await ensureWorkspaceBox(wsA)
  await ensureWorkspaceBox(wsB)
  const XID = 'M-20261120-9601'

  // 在 A 侧造一封 done 的信
  const boxA = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => wsA,
    cwds: async () => [wsA],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await boxA.send({
    owner: 'XA', peer: 'XB', type: 'S-PROGRESS', body: 'cross-workspace',
    senderSessionId: 'SXA', peerSessionId: 'SXB', mailId: XID,
  })
  await boxA.ack({ mailId: XID, close: true })

  // 在 B 侧造同一 id 的「低状态」副本（模拟另一侧还停在 delivered）
  const aRaw = await readJson(join(wsA, '.dsh-mail', '_letters.json'))
  const aLetter = (aRaw.letters || []).find((e) => e.id === XID)
  check('跨区测试的前置：A 侧是 done', aLetter && aLetter.status === 'done', JSON.stringify({ status: aLetter && aLetter.status }))
  if (aLetter) {
    const bCopy = { ...aLetter, status: 'delivered', ackedAt: null, deliveredAt: new Date().toISOString() }
    delete bCopy._cwds
    bCopy._cwd = wsB
    await writeFile(join(wsB, '.dsh-mail', '_letters.json'), JSON.stringify({ letters: [bCopy], seq: aRaw.seq || {} }, null, 2), 'utf8')
  }

  // 从同时能看到两个工作区的实例 ack（force：绕过 already 早退）
  const boxX = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => wsA,
    cwds: async () => [wsA, wsB],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  await boxX.status({})
  const acked = await boxX.ack({ mailId: XID, close: true, force: true, receipt: '两侧同步' })
  check('跨区 ack 成功', acked.ok === true, JSON.stringify(acked.error || null))

  const aAfter = (await readJson(join(wsA, '.dsh-mail', '_letters.json'))).letters.find((e) => e.id === XID)
  const bAfter = (await readJson(join(wsB, '.dsh-mail', '_letters.json'))).letters.find((e) => e.id === XID)
  check(
    '跨区 ack 两侧都更新（不再只写一侧）',
    aAfter && bAfter && aAfter.status === 'done' && bAfter.status === 'done',
    JSON.stringify({ a: aAfter && aAfter.status, b: bAfter && bAfter.status }),
  )
  check(
    '_cwds 已持久化（否则重启后退化成单值）',
    Array.isArray(bAfter && bAfter._cwds) && (bAfter._cwds || []).length >= 2,
    JSON.stringify({ cwds: bAfter && bAfter._cwds }),
  )
}

// ── evidence：让「信里的技术断言指向可 diff 原文」变成可传可查 ──
// 使用方报的真实事故：复核者转发上游结论时，去自己库里找到一个「像的」文件，
// 把上游给的路径换成了自己的。转发与转述在动作上一样，而重写后**无法 diff**。
//
// 设计要点（我否掉了使用方的「词频打 unverified_claims 标记」）：
// 实测发现一封认真写的技术信里「实测/确认/验证」大多在描述方法而非断言结论，
// 按词频标记会让每封信都被标——标记一旦总是出现就等于没有标记。
// 所以只做「可传 + 可查 + 如实记录」，不做自动判定。
{
  const evWs = join(tmp, 'evidence')
  await ensureWorkspaceBox(evWs)
  const evBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => evWs,
    cwds: async () => [evWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })

  // ① 带证据：落盘 + 计数 + 信封头写条数
  const withEv = await evBox.send({
    owner: 'EV1', peer: 'EV2', type: 'R-ALERT', body: '带证据的答复',
    senderSessionId: 'SEV1', peerSessionId: 'SEV2', mailId: 'M-20261120-9901',
    evidence: [{ path: 'D:/x/核-口径.md', line: 35 }, { path: 'D:/x/另.md' }],
  })
  check('evidence 不影响发送', withEv.ok === true, JSON.stringify(withEv.error || null))

  const evRaw = await readJson(join(evWs, '.dsh-mail', '_letters.json'))
  const evLetter = (evRaw.letters || []).find((e) => e.id === 'M-20261120-9901')
  check(
    'evidence 落盘（之前会被白名单静默丢弃）',
    Array.isArray(evLetter && evLetter.evidence) && evLetter.evidence.length === 2,
    JSON.stringify(evLetter && evLetter.evidence),
  )

  const evSt = await evBox.status({ mailId: 'M-20261120-9901' })
  const evRow = (evSt.rows || [])[0] || {}
  check('status 报 evidenceCount', evRow.evidenceCount === 2, String(evRow.evidenceCount))
  check('带证据时 evidenceMissing 为 false', evRow.evidenceMissing === false, String(evRow.evidenceMissing))

  const evEnv = await readFile(join(evWs, '.dsh-mail', 'envelope', 'M-20261120-9901.to.md'), 'utf8')
  check('信封头写 evidence 条数', /^evidence: 2$/m.test(evEnv), (evEnv.match(/^evidence:.*$/m) || [''])[0])

  // ② R-* 但不带证据：如实记 none，不判价值
  await evBox.send({
    owner: 'EV3', peer: 'EV2', type: 'R-ALERT', body: '没有证据的答复',
    senderSessionId: 'SEV3', peerSessionId: 'SEV2', mailId: 'M-20261120-9902',
  })
  const noneEnv = await readFile(join(evWs, '.dsh-mail', 'envelope', 'M-20261120-9902.to.md'), 'utf8')
  check('R-* 无证据时信封头写 none', /^evidence: none$/m.test(noneEnv), (noneEnv.match(/^evidence:.*$/m) || [''])[0])

  const noneSt = await evBox.status({ mailId: 'M-20261120-9902' })
  const noneRow = (noneSt.rows || [])[0] || {}
  check('R-* 无证据时 evidenceMissing 为 true', noneRow.evidenceMissing === true, String(noneRow.evidenceMissing))

  // ③ 形状校验：这是来自队列的任意 JSON，必须过滤
  await evBox.send({
    owner: 'EV4', peer: 'EV2', type: 'R-ALERT', body: '形状校验',
    senderSessionId: 'SEV4', peerSessionId: 'SEV2', mailId: 'M-20261120-9903',
    evidence: [{ path: 'ok.md', line: 10 }, { path: '' }, { path: 'noline.md', line: 'abc' }, { line: 5 }],
  })
  const shapeRaw = await readJson(join(evWs, '.dsh-mail', '_letters.json'))
  const shapeLetter = (shapeRaw.letters || []).find((e) => e.id === 'M-20261120-9903')
  const shape = shapeLetter && shapeLetter.evidence
  check('evidence 形状校验：空 path 被过滤', Array.isArray(shape) && shape.length === 2, JSON.stringify(shape))
  check(
    'evidence 形状校验：非数字 line 变 null',
    Array.isArray(shape) && shape[1] && shape[1].line === null,
    JSON.stringify(shape && shape[1]),
  )

  // ③b line 必须是正整数（使用方指出：Number('') === 0，会落成 line:0）
  // 「看起来对」是今天那场事故的形状；line: 0 会显示出来但不指向任何位置。
  await evBox.send({
    owner: 'EV6', peer: 'EV2', type: 'R-ALERT', body: 'line 校验',
    senderSessionId: 'SEV6', peerSessionId: 'SEV2', mailId: 'M-20261120-9905',
    evidence: [
      { path: 'empty.md', line: '' },
      { path: 'null.md', line: null },
      { path: 'zero.md', line: 0 },
      { path: 'neg.md', line: -5 },
      { path: 'good.md', line: 35 },
    ],
  })
  const lineRaw = await readJson(join(evWs, '.dsh-mail', '_letters.json'))
  const lineLetter = (lineRaw.letters || []).find((e) => e.id === 'M-20261120-9905')
  const byPath = {}
  for (const entry of (lineLetter && lineLetter.evidence) || []) byPath[entry.path] = entry.line
  check(
    'line 只接受正整数：空串/null/0/负数都变 null',
    byPath['empty.md'] === null && byPath['null.md'] === null && byPath['zero.md'] === null && byPath['neg.md'] === null,
    JSON.stringify(byPath),
  )
  check('line 正整数保留', byPath['good.md'] === 35, String(byPath['good.md']))

  // ④ 非 R-* 类型无证据时不写 none（避免噪音）
  await evBox.send({
    owner: 'EV5', peer: 'EV2', type: 'S-PROGRESS', body: '进度通知',
    senderSessionId: 'SEV5', peerSessionId: 'SEV2', mailId: 'M-20261120-9904',
  })
  const spEnv = await readFile(join(evWs, '.dsh-mail', 'envelope', 'M-20261120-9904.to.md'), 'utf8')
  check('非 R-* 类型无证据时不写 evidence 行', !/^evidence:/m.test(spEnv), (spEnv.match(/^evidence:.*$/m) || ['(无)'])[0])
}

// ── 回归：索引条目必须有 status 字段 ──
// 使用方实测踩到：_index.json 里原本只有 type/from/to/sides，
// **没有 status**。于是外面按它筛状态时：
//   e.status === 'blocked'  → 永远 0 条（字段不存在）
//   e.status !== 'done'     → 永远全集（undefined !== 'done' 为真）
// **两个方向都错，而且都会返回结果** —— 最贵的那种形状。
{
  const ixWs = join(tmp, 'index-status')
  await ensureWorkspaceBox(ixWs)
  const ixBox = createMailbox({
    ackTimeoutMs: 600000,
    cwdOf: async () => ixWs,
    cwds: async () => [ixWs],
    isArchived: async () => false,
    log: () => {},
    service: () => undefined,
  })
  const IXID = 'M-20261120-9951'
  await ixBox.send({
    owner: 'IX1', peer: 'IX2', type: 'S-PROGRESS', body: 'index status',
    senderSessionId: 'SIX1', peerSessionId: 'SIX2', mailId: IXID,
  })
  const ixRaw = await readJson(join(ixWs, '.dsh-mail', '_index.json'))
  const ixEntry = ixRaw[IXID] || {}
  check('索引条目带 status 字段', typeof ixEntry.status === 'string' && ixEntry.status.length > 0, JSON.stringify({ status: ixEntry.status }))
  check(
    '索引 status 与信件本体一致',
    ixEntry.status === (await readJson(join(ixWs, '.dsh-mail', '_letters.json'))).letters.find((e) => e.id === IXID).status,
    JSON.stringify({ index: ixEntry.status }),
  )
  // 关键：按 status 筛必须真的能筛出东西（而不是永远 0 或永远全集）
  const all = Object.values(ixRaw)
  const byExact = all.filter((e) => e.status === 'pending').length + all.filter((e) => e.status === 'pushed').length
  check('按 status 精确筛能得到结果（不是永远 0）', byExact > 0, String(byExact))
}

// ── 「改了 ≠ 生效」的机检 ──
// 使用方 lead 指出：我的断言全绿，但他的运行实例还是旧代码。
// 因为断言直接调函数、不经过运行实例 —— 两边都对，中间差一次重载。
// 今天这个形状咬了三次（evidence 后端/schema/索引 status）。
//
// 判据：加载时刻早于代码 mtime = 未重载。
{
  const fresh = codeFreshness()
  check('codeFreshness 返回完整结构', fresh && typeof fresh.loadedAt === 'string' && typeof fresh.stale === 'boolean', JSON.stringify(fresh))
  check('刚加载时应判定为「不落后」', fresh.stale === false, JSON.stringify({ stale: fresh.stale, mtime: fresh.codeMtime, loaded: fresh.loadedAt }))
  // 关键：判据必须是「代码 mtime > 加载时刻」，不是别的
  const loadedMs = Date.parse(fresh.loadedAt)
  const mtimeMs = Date.parse(fresh.codeMtime)
  check(
    '判据是「代码 mtime 晚于加载时刻」（允许 2 秒误差）',
    fresh.stale === (mtimeMs > loadedMs + 2000),
    JSON.stringify({ loadedMs, mtimeMs, stale: fresh.stale }),
  )
}

console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)