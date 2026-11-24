#!/usr/bin/env node
/**
 * 跨工作区门控回归测试（tools/gate-test.mjs）。
 *
 * 这不是「再测一遍 mailbox.send」：mailbox.send 本身不知道工作区策略，
 * 门控在 submitLocal / resolveFriend 这一层。这里真的 apply()、真的拿工具注册，
 * 再按工具 schema 的形状执行，验证每一条 Agent 能主动发消息的路径都过同一道门：
 *
 *   - session_tell：按好友名解析 → resolveFriend → crossWorkspaceGate
 *   - mail_send：按 peer 名解析 → 同一道门
 *   - mail_send + peerSessionId：曾经绕过 resolveFriend，必须也被 crossWorkspaceGate 拦住
 *
 * 开关关着时，跨区分支必须全部 CROSS_WORKSPACE_DISABLED；同区/嵌套目录必须放行。
 * 开关开着时，两条路径都放行，并写 cross-workspace.jsonl 审计。
 *
 * 跑法：node tools/gate-test.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const root = join(process.cwd(), '_tmp', 'gate-test')
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

const lines = []
let failed = 0
const check = (name, ok, detail) => {
  lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failed += 1
}

const wsA = join(root, 'ws-a')
const wsB = join(root, 'ws-b')
await mkdir(wsA, { recursive: true })
await mkdir(wsB, { recursive: true })

function makeCtx() {
  const registered = []
  const prompts = []
  const effects = []
  const sessions = {
    'session-a': { header: { id: 'session-a', cwd: wsA } },
    'session-a-child': { header: { id: 'session-a-child', cwd: join(wsA, 'child') } },
    'session-b': { header: { id: 'session-b', cwd: wsB } },
  }
  const persistence = {
    async stat(id) {
      return sessions[id] || null
    },
    async list() {
      return Object.values(sessions)
    },
  }
  const controller = {
    async prompt(request) {
      prompts.push(request)
      return { ok: true, messageId: 'test-' + prompts.length }
    },
    async state() {
      return { running: false, active: false }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            registered.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionController') return controller
      if (name === 'connection') return { on() {}, requestRejection() { return undefined } }
      return undefined
    },
    plugin() {},
    emit() {},
    async start() {},
  }
  return { ctx, registered, prompts, effects }
}

async function makeHarness(allowCrossWorkspace) {
  const dir = join(root, allowCrossWorkspace ? 'run-allow' : 'run-deny')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'friends.json'),
    JSON.stringify({
      a: { sessionId: 'session-a', cwd: wsA },
      b: { sessionId: 'session-b', cwd: wsB },
      child: { sessionId: 'session-a-child', cwd: join(wsA, 'child') },
    }),
    'utf8',
  )
  const made = makeCtx()
  apply(made.ctx, { dir, allowCrossWorkspace, pollMs: 100, toolTimeoutMs: 5000 })
  const tool = (name) => made.registered.find((entry) => entry && entry.name === name)
  return { dir, ...made, tool }
}

function disposeAll(...harnesses) {
  for (const harness of harnesses) {
    for (const dispose of harness.effects) {
      try {
        dispose()
      } catch {}
    }
  }
}

const exec = (sessionId) => ({ agent: { id: sessionId } })

// ── 开关关着 ────────────────────────────────────────────────────────────
const deny = await makeHarness(false)
const tellDeny = deny.tool('session_tell')
const mailDeny = deny.tool('mail_send')
const statusDeny = deny.tool('mail_status')

check('session_tell 已注册', Boolean(tellDeny), deny.registered.map((t) => t.name).join(', '))
check('mail_send 已注册', Boolean(mailDeny), deny.registered.map((t) => t.name).join(', '))

const tellCross = await tellDeny.execute({ name: 'b', text: 'cross' }, exec('session-a'))
check(
  '关着：session_tell 跨区被拒',
  tellCross.ok === false && tellCross.error && tellCross.error.code === 'CROSS_WORKSPACE_DISABLED',
  JSON.stringify(tellCross),
)
check(
  '关着：session_tell 拒绝时带 policy.instance',
  tellCross.error && tellCross.error.policy && tellCross.error.policy.instance === 'root',
  JSON.stringify(tellCross.error && tellCross.error.policy),
)

const mailBypass = await mailDeny.execute(
  { owner: 'a', peer: 'b', body: 'cross', type: 'S-PROGRESS', peerSessionId: 'session-b' },
  exec('session-a'),
)
check(
  '关着：mail_send 带 peerSessionId 跨区也被拒（历史旁路）',
  mailBypass.ok === false && mailBypass.error && mailBypass.error.code === 'CROSS_WORKSPACE_DISABLED',
  JSON.stringify(mailBypass),
)
check(
  '关着：mail_send 拒绝时带 policy',
  mailBypass.error && mailBypass.error.policy && mailBypass.error.policy.allowCrossWorkspace === false,
  JSON.stringify(mailBypass.error && mailBypass.error.policy),
)

const tellSame = await tellDeny.execute({ name: 'child', text: 'same' }, exec('session-a'))
check(
  '关着：同区/嵌套 session_tell 仍放行',
  tellSame.ok === true && deny.prompts.some((request) => request.sessionId === 'session-a-child'),
  JSON.stringify(tellSame),
)

const statusResult = await statusDeny.execute({}, exec('session-a'))
check(
  'mail_status 暴露 policy.allowCrossWorkspace=false',
  statusResult.ok === true && statusResult.policy && statusResult.policy.allowCrossWorkspace === false,
  JSON.stringify(statusResult.policy),
)

const denyAudit = await readFile(join(deny.dir, 'cross-workspace.jsonl'), 'utf8').catch(() => '')
const denyEntries = denyAudit
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)
check(
  '关着：审计有 session_tell 拒绝记录',
  denyEntries.some((entry) => entry.tool === 'session_tell' && entry.allowed === false),
  denyAudit,
)
check(
  '关着：审计有 mail_send 拒绝记录',
  denyEntries.some((entry) => entry.tool === 'mail_send' && entry.allowed === false),
  denyAudit,
)

// ── 开关开着 ────────────────────────────────────────────────────────────
const allow = await makeHarness(true)
const tellAllow = allow.tool('session_tell')
const mailAllow = allow.tool('mail_send')

const tellCrossAllow = await tellAllow.execute({ name: 'b', text: 'cross-allowed' }, exec('session-a'))
check(
  '开着：session_tell 跨区放行',
  tellCrossAllow.ok === true && allow.prompts.some((request) => request.sessionId === 'session-b'),
  JSON.stringify(tellCrossAllow),
)

const mailCrossAllow = await mailAllow.execute(
  { owner: 'a', peer: 'b', body: 'cross-allowed', type: 'S-PROGRESS', peerSessionId: 'session-b' },
  exec('session-a'),
)
check(
  '开着：mail_send 带 peerSessionId 跨区放行',
  mailCrossAllow.ok === true,
  JSON.stringify(mailCrossAllow),
)

const allowAudit = await readFile(join(allow.dir, 'cross-workspace.jsonl'), 'utf8').catch(() => '')
const allowEntries = allowAudit
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)
check(
  '开着：审计有允许记录',
  allowEntries.some((entry) => entry.allowed === true && entry.tool === 'mail_send'),
  allowAudit,
)

disposeAll(deny, allow)
await rm(root, { recursive: true, force: true })

console.log(lines.join('\n'))
console.log('---')
console.log(failed === 0 ? 'gate-test 通过' : 'gate-test 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
