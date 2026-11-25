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
const start = async (records, { askPresetOnCreate = false } = {}) => {
  const hooks = new Map()
  const root = await mkdtemp(join(tmpdir(), 'permit-ws-'))
  await mkdir(join(root, 'inbox'), { recursive: true })
  const controller = makeController(records)
  const ctx = {
    get: (key) => {
      if (key === 'sessionController') return controller
      // 门控之后的业务链要能走到底，才测得到「成功后消耗」。
      // 缺 agentPresets 会让每个请求都停在 PRESET 解析之前，授权永远不被消耗——
      // 那样「第二次不放行」这条断言就测不出东西（我第一版正是这样）。
      if (key === 'agentPresets') return { resolve: async (id) => ({ id }) }
      if (key === 'workspaceRegistry') {
        return {
          resolveByPath: async (path) => ({ id: 'ws-stub', path, title: 'stub' }),
          create: async (path, title) => ({ id: 'ws-stub', path, title }),
        }
      }
      if (key === 'connection') return { requestRejection: () => undefined }
      if (key === 'tools') return { register: () => () => {} }
      if (key === 'commands') return { register: () => () => {} }
      return undefined
    },
    on: (event, handler) => {
      // 记下 agent/pre-step：种子授权（grantHumanPermit）走这条路，
      // 而 humanPermits → peekHumanPermit 这条分支此前零覆盖。
      if (event === 'agent/pre-step') hooks.set('agent/pre-step', handler)
      return () => {}
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx, { dir: root, dispatcher: true, pollMs: 60, sweepFriends: false, askPresetOnCreate })
  return { root, controller, hooks }
}

/** 投一个 init_workspace 请求，等 dispatcher 出结果。 */
const submit = async (root, creatorSessionId, options = {}) => {
  const id = 'permit-' + randomUUID().slice(0, 8)
  const request = {
    id,
    action: 'init_workspace',
    project: 'permit-probe',
    cwd: 'D:\\dshdata\\本地\\_permit_probe',
    creatorSessionId,
  }
  // omitPreset：模拟「agent 没给预设」→ 开了 askPresetOnCreate 时业务会以 PRESET_REQUIRED 拒绝，
  // 用来验证「门控过了但业务失败」不会烧掉人类授权。
  if (options.omitPreset !== true) request.preset = 'cordis'
  await writeFile(join(root, 'inbox', id + '.json'), JSON.stringify(request), 'utf8')
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
  check('首次放行', !gated(first), JSON.stringify({ code: codeOf(first), ok: first.ok }))
  check(
    '同一条人类消息第二次不放行',
    gated(second),
    JSON.stringify({ code: codeOf(second), ok: second.ok, message: second.error && second.error.message }),
  )
  await rm(root, { recursive: true, force: true })
}

// ── 场景 5：空事件表 → 拒绝且不空转 ──
{
  const { root, controller } = await start([])
  const result = await submit(root, 'session-empty')
  check('空事件表 → 拒绝且不空转', gated(result) && controller.calls.length === 1, JSON.stringify({ code: codeOf(result), pages: controller.calls.length }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 6：旧的已消费消息不能遮蔽更早/更新的意图 ──
// 真实路径：agent 第一次调工具（授权被取走）→ 因为缺预设被拒 → 人类补一句「用 cordis」
// → agent 重试。此时那条人类消息已被消费，旧代码扫到它就 return false，永久拒绝。
// 修复后必须继续往前翻，找到另一条能放行的意图（这里换成「更新的那条还没消费」）。
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    if (seq === 5) records.push(humanEvent(5, PERMIT_TEXT)) // 旧的那条，第一次会被消费
    else if (seq === 250) records.push(humanEvent(250, '再帮我建个工作区吧')) // 新的那条
    else records.push(agentEvent(seq, 'x'))
  }
  const { root } = await start(records)
  const first = await submit(root, 'session-shadow')
  check('场景6 首次放行', !gated(first), JSON.stringify({ code: codeOf(first) }))
  // 第二次：seq 250 那条也会被消费；再往下还有 seq 5。若实现「命中已消费就放弃」，这里会被拒。
  const second = await submit(root, 'session-shadow')
  check('已消费的旧消息不遮蔽更早的意图', !gated(second), JSON.stringify({ code: codeOf(second) }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 7：业务失败不烧掉授权 ──
// 门控通过后还有会失败的地方（缺预设 → PRESET_REQUIRED；路径不合法；宿主服务不在）。
// 旧代码门控一通过就 takeHumanPermit 消耗掉，那一步失败就等于把人类的这次要求白烧了。
// 判据：第一次请求因 PRESET_REQUIRED 失败之后，第二次带合法预设应当仍被放行。
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    records.push(seq === 20 ? humanEvent(20, PERMIT_TEXT) : agentEvent(seq, 'x'))
  }
  const { root } = await start(records, { askPresetOnCreate: true })
  // 第一次：不给 preset，且打开 askPresetOnCreate → 门控过、业务拒（PRESET_REQUIRED）
  const first = await submit(root, 'session-burn', { omitPreset: true })
  check('场景7 首次因缺预设失败', codeOf(first) === 'PRESET_REQUIRED', JSON.stringify({ code: codeOf(first) }))
  // 第二次：补上预设 → 授权不该已经被烧掉
  const second = await submit(root, 'session-burn')
  check('业务失败不烧掉人类授权', !gated(second), JSON.stringify({ code: codeOf(second) }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 8：已消费的意图在**前一页**，未消费的在更早页 ──
// 跨页版本：第一页（最新 500 条）只有一条已消费的意图，真正的授权在更早的页里。
// 若实现「页级 consumed 直接放弃」，会停在第一页返回拒绝，永远翻不到第 2 页。
{
  const records = []
  for (let seq = 1; seq <= 1400; seq += 1) {
    if (seq === 5) records.push(humanEvent(5, PERMIT_TEXT)) // 第 3 页（最旧）
    else if (seq === 1300) records.push(humanEvent(1300, '再建个工作区')) // 第 1 页（最新）
    else records.push(agentEvent(seq, 'x'))
  }
  const { root, controller } = await start(records)
  const first = await submit(root, 'session-crosspage')
  check('场景8 首次放行（消耗最新那条）', !gated(first), JSON.stringify({ code: codeOf(first) }))
  const pagesAfterFirst = controller.calls.length
  const second = await submit(root, 'session-crosspage')
  check(
    '页级只含已消费意图时继续翻页',
    !gated(second),
    JSON.stringify({ code: codeOf(second), pagesAfterFirst, pagesTotal: controller.calls.length }),
  )
  check('场景8 确实翻了 2 页以上', controller.calls.length > pagesAfterFirst, JSON.stringify({ pagesAfterFirst, pagesTotal: controller.calls.length }))
  await rm(root, { recursive: true, force: true })
}

// ── 场景 9：humanPermits 路径（种子授权）也要遵守「失败不烧、成功才耗」 ──
// 这条路径此前零覆盖：/new-workspace 命令与自然语言种子都走 grantHumanPermit，
// 而 peek/commit/release 存在的理由正是这条路径。若不测，把它改回 takeHumanPermit
// 也不会有人发现（复审实测：那样改完 15 条断言仍全绿）。
{
  const records = [] // 事件表里没有任何意图消息，只要种子授权这一条路
  for (let seq = 1; seq <= 50; seq += 1) records.push(agentEvent(seq, 'x'))
  const { root, hooks } = await start(records, { askPresetOnCreate: true })

  const preStep = hooks.get('agent/pre-step')
  check('场景9 pre-step 钩子已注册', typeof preStep === 'function', typeof preStep)

  if (typeof preStep === 'function') {
    // 人类说「帮我建个工作区」→ 种子记一次授权
    // 注意：种子读的是 **next() 返回的 decision.messages**，不是 payload.messages。
    // 传给 payload 的东西没人看（我第一版就这么写，种子永远不触发）。
    await preStep(
      { agent: { id: 'session-seed' }, step: 1 },
      // kind 必须是 'enter'：pre-step 只在真正要进模型的那一刻才跑种子
      // （decision.kind === 'enter'，见 lib/index.js 里那层判断）。
      async () => ({
        kind: 'enter',
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: PERMIT_TEXT }] }],
      }),
    )

    // 第一次：不带 preset → 业务拒（PRESET_REQUIRED），授权不该被烧掉
    const first = await submit(root, 'session-seed', { omitPreset: true })
    check('场景9 首次因缺预设失败', codeOf(first) === 'PRESET_REQUIRED', JSON.stringify({ code: codeOf(first) }))

    // 第二次：补上 preset → 授权还在，应当通过
    const second = await submit(root, 'session-seed')
    check('场景9 种子授权在业务失败后仍可用', !gated(second), JSON.stringify({ code: codeOf(second) }))

    // 第三次：授权已被第二次用掉，应当拒绝
    const third = await submit(root, 'session-seed')
    check('场景9 种子授权成功后被消耗', gated(third), JSON.stringify({ code: codeOf(third) }))
  }
  await rm(root, { recursive: true, force: true })
}

// ── 场景 10：并发时同一份授权只能放行一次 ──
// 复审实测过的回归：peek 之后到 take 之间有 await（controller.create），
// 而 drain() 并发跑（maxConcurrent 默认 4）。没有预留表时，两条 init_workspace
// 会同时 peek 到同一份授权、同时通过门控 → 一句人类消息建出两个会话。
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    records.push(seq === 20 ? humanEvent(20, PERMIT_TEXT) : agentEvent(seq, 'x'))
  }
  const { root, controller } = await start(records)
  // 让 create 慢一点，把并发的窗口撑开
  const originalCreate = controller.create.bind(controller)
  controller.create = async (...args) => {
    await new Promise((r) => setTimeout(r, 300))
    return originalCreate(...args)
  }
  // 两个请求同时进队列 → drain 会并发处理
  const [a, b] = await Promise.all([submit(root, 'session-race'), submit(root, 'session-race')])
  const passes = [a, b].filter((r) => !gated(r)).length
  check('并发下同一份授权只放行一次', passes === 1, JSON.stringify({ passes, a: codeOf(a), b: codeOf(b) }))
  await rm(root, { recursive: true, force: true })
}


// ── 场景 11：人类明确说「已授权可以建立新会话」也能放行 ──
// 旧逻辑只认「工作区」关键词；人类说「建立会话已授权」不会命中，agent 拿着
// 同一句话去调 init_workspace/handoff 仍会被 AGENT_CREATE_DISABLED 挡住。
{
  const cases = [
    ['已授权可以建立新会话', true],
    ['建立会话已授权', true],
    ['我授权你新建会话', true],
    ['不要建立新会话', false],
    ['不能新建会话', false],
  ]
  for (const [text, shouldPass] of cases) {
    const records = []
    for (let seq = 1; seq <= 300; seq += 1) {
      records.push(seq === 20 ? humanEvent(20, text) : agentEvent(seq, 'x'))
    }
    const { root } = await start(records)
    const result = await submit(root, 'session-phrase-' + shouldPass + '-' + Math.random().toString(36).slice(2, 6))
    check(
      '场景11 「' + text + '」' + (shouldPass ? ' 放行' : ' 拒绝'),
      shouldPass ? !gated(result) : gated(result),
      JSON.stringify({ code: codeOf(result) }),
    )
    await rm(root, { recursive: true, force: true })
  }
}

// ── 场景 12：agent 自己说「已授权可以建立新会话」不算 ──
{
  const records = []
  for (let seq = 1; seq <= 300; seq += 1) {
    records.push(seq === 20 ? agentEvent(20, '已授权可以建立新会话') : agentEvent(seq, 'x'))
  }
  const { root } = await start(records)
  const result = await submit(root, 'session-agent-phrase')
  check('场景12 agent 冒名的授权说法不放行', gated(result), JSON.stringify({ code: codeOf(result) }))
  await rm(root, { recursive: true, force: true })
}

console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)
