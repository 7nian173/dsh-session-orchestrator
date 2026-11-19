// 授权窗口翻页的独立测试。
//
// 为什么单独一个文件：apply() 需要完整 ctx，套不进 mail-push-test.mjs 的沙箱。
// 而这段逻辑的失效方式是**静默的**——会话超过一页（500 条事件）之后，
// 「帮我建个工作区」被挤出窗口，人类自己的请求反而被门控拒绝（实测）。
//
// 测法：桩一个 ctx 让 apply() 真跑起来，往队列根目录的 inbox 里丢 init_workspace 请求，
// 等 dispatcher 的 drain() 把它处理完，读 outbox 看错误码。
// 门控拒绝 → AGENT_CREATE_DISABLED；放行 → 会因桩里没有 workspaceRegistry 而报别的错。
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { apply } from '../lib/index.js'

let failed = 0
const lines = []
const check = (name, ok, detail) => {
  lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failed += 1
}

const PERMIT_TEXT = '帮我建个工作区，目录是 D:\\dshdata\\本地\\_permit_probe'

const humanEvent = (seq, text) => ({
  event: {
    seq,
    type: 'user/message',
    time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  },
})

const agentEvent = (seq, text) => ({
  event: {
    seq,
    type: 'user/message',
    time: Date.now(),
    data: { role: 'user', source: { kind: 'agent' }, content: [{ type: 'text', text }] },
  },
})

/** 桩 controller：按宿主语义切页（seq <= throughSeq，从新往旧取一页，返回时间正序）。 */
const makeController = (records) => {
  const calls = []
  return {
    calls,
    async events(request) {
      const throughSeq = request && typeof request.throughSeq === 'number' ? request.throughSeq : Infinity
      const size = (request && request.maxMessages) || 500
      calls.push({ throughSeq, maxMessages: request && request.maxMessages })
      const eligible = records.filter((record) => record.event.seq <= throughSeq)
      const page = eligible.slice(-size)
      return { records: page, hasMore: eligible.length > page.length }
    },
    async create() {
      return { sessionId: 'session-stub' }
    },
    async prompt() {
      return { ok: true }
    },
  }
}

/**
 * 起一个真的 dispatcher（dispatcher: true 才会轮询队列）。
 * 队列根目录用临时目录，避免污染真实的 session-bridge。
 */
const start = async (records) => {
  const root = await mkdtemp(join(tmpdir(), 'permit-ws-'))
  await mkdir(join(root, 'inbox'), { recursive: true })
  const controller = makeController(records)
  const ctx = {
    get: (key) => {
      if (key === 'sessionController') return controller
      if (key === 'connection') return { requestRejection: () => undefined }
      if (key === 'tools') return { register: () => () => {} }
      if (key === 'commands') return { register: () => () => {} }
      return undefined
    },
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx, { dir: root, dispatcher: true, pollMs: 60, sweepFriends: false })
  return { root, controller }
}

/** 投一个 init_workspace 请求，等 dispatcher 出结果。 */
const submit = async (root, creatorSessionId) => {
  const id = 'permit-' + randomUUID().slice(0, 8)
  await writeFile(
    join(root, 'inbox', id + '.json'),
    JSON.stringify({
      id,
      action: 'init_workspace',
      project: 'permit-probe',
      cwd: 'D:\\dshdata\\本地\\_permit_probe',
      preset: 'cordis',
      creatorSessionId,
    }),
    'utf8',
  )
  for (let i = 0; i < 400; i += 1) {
    for (const sub of ['outbox', 'done', 'failed']) {
      try {
        const value = JSON.parse(await readFile(join(root, sub, id + '.json'), 'utf8'))
        return value
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return { ok: false, error: { code: 'TEST_TIMEOUT', message: 'no result' } }
}

const codeOf = (result) => (result && result.error && result.error.code) || null
const gated = (result) => codeOf(result) === 'AGENT_CREATE_DISABLED'

// ── 场景 1：意图消息在最旧的那页（长会话 1200 条 > 一页 500）──
// 修复前只读一页 → 找不到 → 拒绝人类自己的请求。
{
  const records = []
  for (let seq = 1; seq <= 1200; seq += 1) {
    records.push(seq === 1 ? humanEvent(1, PERMIT_TEXT) : agentEvent(seq, 'x'))
  }
  const { root, controller } = await start(records)
  const result = await submit(root, 'session-long')
  check('长会话能翻到最旧那页的意图', !gated(result), JSON.stringify({ code: codeOf(result), pages: controller.calls.length }))
  check('确实翻了多页', controller.calls.length >= 2, String(controller.calls.length))
  check('翻页有界（≤6 页）', controller.calls.length <= 6, String(controller.calls.length))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 2：全篇没有意图 → 仍然拒绝 ──
{
  const records = []
  for (let seq = 1; seq <= 1200; seq += 1) records.push(agentEvent(seq, '随便说说'))
  const { root } = await start(records)
  const result = await submit(root, 'session-nointent')
  check('没有意图消息 → 门控拒绝', gated(result), JSON.stringify({ code: codeOf(result) }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 3：agent 冒名说「建工作区」不算授权 ──
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    records.push(seq === 10 ? agentEvent(10, PERMIT_TEXT) : agentEvent(seq, 'x'))
  }
  const { root } = await start(records)
  const result = await submit(root, 'session-agentsays')
  check('agent 冒名说「建工作区」不放行', gated(result), JSON.stringify({ code: codeOf(result) }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 4：同一条人类消息只放行一次 ──
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    records.push(seq === 10 ? humanEvent(10, PERMIT_TEXT) : agentEvent(seq, 'x'))
  }
  const { root } = await start(records)
  const first = await submit(root, 'session-once')
  const second = await submit(root, 'session-once')
  check('首次放行', !gated(first), JSON.stringify({ code: codeOf(first) }))
  check('同一条人类消息第二次不放行', gated(second), JSON.stringify({ code: codeOf(second) }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 5：空事件表 → 拒绝且不空转 ──
{
  const { root, controller } = await start([])
  const result = await submit(root, 'session-empty')
  check('空事件表 → 拒绝且不空转', gated(result) && controller.calls.length === 1, JSON.stringify({ code: codeOf(result), pages: controller.calls.length }))
  await rm(root, { recursive: true, force: true })
}

console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)
