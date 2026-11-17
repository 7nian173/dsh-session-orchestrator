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

// ── 哨兵：忙 → 等 idle 边；空闲 → 10 秒窗口；10s 内转忙 → 放弃并缩到 5s
// 用长 ACK 窗口的独立实例，避免 1 秒 ackTimeout 先把它打成待办
const box2 = createMailbox({ ackTimeoutMs: 600000, service: (k) => (k === 'sessionController' ? controller : undefined), log: () => {}, cwdOf })
let busy = true
controller.state = async () => ({ running: busy, active: busy })
const s2 = await box2.send({ owner: 'lead', peer: 'peer', type: 'S-PROGRESS', body: 'busy case', senderSessionId: 'session-from', peerSessionId: 'session-to', mailId: 'M-20261117-9001' })
const id2 = s2.mailId
const ledBusy = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
const notes2 = ((ledBusy.events || []).filter((e) => e.mail_id === id2 && e.note)).map((e) => e.note)
check('忙目标 → wait-idle', notes2.includes('sentinel:wait-idle'), JSON.stringify(notes2))

busy = false
await box2.noteStatus({ id: 'session-to' }, 'idle')
const ledArmed = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
const armed = ((ledArmed.events || []).filter((e) => e.mail_id === id2 && e.note === 'sentinel:armed')).pop()
check('idle 边 → 10 秒窗口', armed && armed.delayMs === 10000, JSON.stringify(armed || null))

busy = true
await box2.noteStatus({ id: 'session-to' }, 'running')
const ledAbort = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
const abort = ((ledAbort.events || []).filter((e) => e.mail_id === id2 && e.note === 'sentinel:abort-busy')).pop()
check('转忙 → 放弃并缩到 5s', abort && abort.nextDelayMs === 5000, JSON.stringify(abort || null))

busy = false
await box2.noteStatus({ id: 'session-to' }, 'idle')
await new Promise((r) => setTimeout(r, 5600))
const notices = calls.filter((c) => String(c.id).startsWith('mail-' + id2))
check('5 秒到点推索引通知', notices.length >= 2, JSON.stringify(notices))
const ledNotified = await readJson(join(wsTo, '.dsh-mail', '_ledger.json'))
check('留痕有 notified', ((ledNotified.events || []).some((e) => e.mail_id === id2 && e.note === 'sentinel:notified')), '')

// ── 群路由：阈值 3 自动建群 + 交集合并
const gb = createMailbox({ ackTimeoutMs: 600000, service: () => undefined, log: () => {}, cwdOf: async () => wsTo })
let gid = 0
const pairSend = async (a, b, times) => {
  for (let i = 0; i < times; i++) {
    gid += 1
    await gb.send({ owner: a, peer: b, type: 'S-PROGRESS', body: 'x', senderSessionId: a, peerSessionId: b, mailId: 'M-20261117-9' + String(gid).padStart(3, '0') })
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