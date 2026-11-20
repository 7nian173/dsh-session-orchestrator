#!/usr/bin/env node
/**
 * 工具层 schema 测试：验证「模型能传进来的参数」覆盖了后端实际需要的字段。
 *
 * 为什么需要这个文件（2026-11-20 使用方 lead 发现的阻断性 bug）：
 *
 *   `evidence` 那次：后端三层都写好了（落盘 / 校验 / 显示），
 *   但 `mail_send` 的**工具 schema 没放行** → 模型传不进去 → 后端逻辑全是死代码。
 *
 *   `S-TODO-NOTICE` 那次更严重：三个必填（todo_of / stuck_since / elapsed_minutes）
 *   同样不在 schema 里。而它是 `delivered` 死锁的**唯一出口** ——
 *   出口堵死，整个通道无法解开。
 *
 * 两次的共同点：**断言跑在后端（直接调 submitLocal / 直接调 mailbox），
 * 而 bug 在工具层。** 「断言在这个层，bug 在那个层。」
 *
 * 所以这个文件专门跑那一层：真的调 `apply()`，拿到 `tools.register` 注册的东西，
 * 检查 schema，然后**按 schema 的形状去执行**。
 *
 * 用法：node tools/tool-schema-test.mjs
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
const lines = []
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1
    lines.push('PASS ' + name + (detail ? ' — ' + detail : ''))
  } else {
    failed += 1
    lines.push('FAIL ' + name + (detail ? ' — ' + detail : ''))
  }
}

const tmp = join(tmpdir(), 'dsh-tool-schema-' + process.pid)
await rm(tmp, { recursive: true, force: true })
await mkdir(tmp, { recursive: true })

const registered = []

// ── 构造一个最小的 ctx / service，只为让 apply() 跑起来并注册工具 ──
const effectFns = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {},
  // ⚠️ 工具注册发生在 ctx.effect(() => { ... registerTools() ... }) 里面。
  // 原来这里写的是空函数，所以 apply() 跑完了但一个工具都没注册——
  // 而测试报的是「mail_send 未注册」，看起来像产品 bug，其实是**测试桩的 bug**。
  //
  // 这正是使用方 lead 说的那件事的另一面：
  // 断言跑在哪个层，决定了它能看见哪个层的 bug。
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effectFns.push(dispose)
    return dispose
  },
  get() {
    return undefined
  },
  plugin() {},
  emit() {},
  async start() {},
}

const service = (name) => {
  if (name === 'tools') {
    return {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    }
  }
  if (name === 'connection') return { on() {} }
  if (name === 'webServer') return { routes: [], get() {}, post() {} }
  if (name === 'sessions') {
    return {
      async list() {
        return []
      },
      async get() {
        return undefined
      },
    }
  }
  return undefined
}
ctx.get = service

const { apply, codeFreshness } = await import('../lib/index.js')

let applied = false
try {
  apply(ctx, { dir: tmp, agentCreateSession: false })
  applied = true
} catch (error) {
  lines.push('（apply 抛错，工具可能没注册：' + ((error && error.message) || String(error)) + '）')
}
check('apply() 能跑起来', applied, applied ? '' : '见上面')

const mailSend = registered.find((tool) => tool && tool.name === 'mail_send')
check('mail_send 已注册', Boolean(mailSend), '已注册工具: ' + registered.map((t) => t && t.name).join(', '))

if (mailSend) {
  const props = (mailSend.parameters && mailSend.parameters.properties) || {}
  const required = (mailSend.parameters && mailSend.parameters.required) || []

  check('schema 声明 additionalProperties: false（所以缺字段就传不进去）', mailSend.parameters.additionalProperties === false, String(mailSend.parameters.additionalProperties))

  // ① evidence（0.3.2 那次的教训）
  check('schema 里有 evidence', 'evidence' in props, Object.keys(props).join(', '))

  // ② S-TODO-NOTICE 的三个必填 —— 这是死锁唯一出口，必须能传
  for (const field of ['todoOf', 'stuckSince', 'elapsedMinutes']) {
    check('schema 里有 ' + field + '（S-TODO-NOTICE 必填）', field in props, field in props ? '' : '不在 ' + Object.keys(props).join(', '))
  }

  // ③ 交叉验证：后端 REQUIRED_EXTRA 要求的字段，schema 必须都能传
  //
  // 这是防「下次加必填又忘了放 schema」的根本判据。
  // 映射：后端 snake_case → 工具 camelCase
  const SNAKE_TO_CAMEL = {
    ack_of: 'ackOf',
    todo_of: 'todoOf',
    stuck_since: 'stuckSince',
    elapsed_minutes: 'elapsedMinutes',
    expire_of: 'expireOf',
    reason: 'reason',
  }
  const { REQUIRED_EXTRA } = await import('../lib/mail.js').then(
    (mod) => ({ REQUIRED_EXTRA: mod.REQUIRED_EXTRA }),
    () => ({ REQUIRED_EXTRA: null }),
  )
  if (REQUIRED_EXTRA) {
    for (const [type, fields] of Object.entries(REQUIRED_EXTRA)) {
      const missing = fields.map((f) => SNAKE_TO_CAMEL[f] || f).filter((f) => !(f in props))
      check(
        type + ' 的必填字段全在 schema 里',
        missing.length === 0,
        missing.length === 0 ? '' : '缺: ' + missing.join(', '),
      )
    }
  } else {
    lines.push('（跳过 REQUIRED_EXTRA 交叉验证：lib/mail.js 未导出它）')
  }

  // ④ 真正按 schema 执行一次 S-TODO-NOTICE（走 execute 那条路，不是 submitLocal）
  if (typeof mailSend.execute === 'function') {
    const exec = { agent: { id: 'session-tool-layer-1' } }
    // 先注册好友：工具层要求 sender session 已在好友表里，
    // 否则会 SENDER_NOT_REGISTERED（这不是本次要验的东西）
    const registerName = registered.find((t) => t && t.name === 'session_register_name')
    if (registerName && typeof registerName.execute === 'function') {
      try {
        await registerName.execute({ name: 'tool-layer-1' }, exec)
      } catch {
        // 注册失败不影响后面的 schema 断言——那才是本文件的重点
      }
    }

    // 注意：这里不验「原始信能发出」——那需要完整的好友表与投递链路，
    // 属于 mail-push-test 的范围。本文件的职责只有一个：
    // **schema 放行的字段，能不能真的传到后端校验那一层。**

    const todoArgs = {
      owner: 'TL1',
      peer: 'TL2',
      type: 'S-TODO-NOTICE',
      body: '工具层测试：催收',
      peerSessionId: 'session-tool-layer-2',
      todoOf: 'M-20261120-0001',
      stuckSince: new Date().toISOString(),
      elapsedMinutes: 5,
      reason: '工具层 schema 测试：验证三个必填字段真的能传进来',
    }
    let second
    try {
      second = await mailSend.execute({ ...todoArgs }, exec)
    } catch (error) {
      second = { ok: false, error: { message: (error && error.message) || String(error) } }
    }
    const rejected = Boolean(second && second.error && second.error.code === 'MAIL_INVALID')
    check(
      '工具层：S-TODO-NOTICE 的必填能传进去（不被 schema 拦）',
      !rejected,
      rejected ? JSON.stringify(second.error.issues || second.error.message) : 'ok=' + (second && second.ok),
    )
  }
}

// 清理：apply() 可能还持有定时器/句柄，重试几次再放弃。
// 删不掉不算测试失败（临时目录在 %TEMP%，系统会清），
// 但要把残留路径打出来，方便排查。
try {
  await rm(tmp, { recursive: true, force: true })
} catch {
  await new Promise((r) => setTimeout(r, 200))
  try {
    await rm(tmp, { recursive: true, force: true })
  } catch (error) {
    lines.push('（临时目录未能清理：' + tmp + ' — ' + ((error && error.code) || '') + '）')
  }
}

console.log(lines.join('\n'))
console.log('')
console.log('工具层 schema 测试：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
