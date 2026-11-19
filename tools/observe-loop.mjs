#!/usr/bin/env node
/**
 * 常驻采样器：按固定间隔反复调用 observe-sessions。
 *
 * 为什么不用 Windows 计划任务：
 *   schtasks 最小粒度是 1 分钟，而这次要观察的 idle 段可能只有几十秒
 *   （实测 lead 有一段只有 80 秒），1 分钟采样会整段跳过。
 *   用常驻循环能拿到任意间隔，而且失败不影响下一轮。
 *
 * 为什么参数写成脚本而不是命令行：
 *   回调里要同时处理 「子进程失败」「子进程超时」「自己被打断」三种情况，
 *   写成 inline 会很容易漏掉其中一种。采样器崩掉会留下数据空洞，
 *   而空洞比错误数据更误导 —— 你会以为「那段时间没有活动」。
 *
 * 用法：
 *   node tools/observe-loop.mjs --interval 30 --tag leader-team
 *   停止：Ctrl+C，或删掉 _observer/<tag>.stop
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const dataDir = join(dirname(repoRoot), '_observer')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const intervalSec = Math.max(5, Number(argOf('interval', '30')))
const tag = argOf('tag', 'leader-team')

const stopFile = join(dataDir, tag + '.stop')
const logPath = join(dataDir, tag + '.log')

const log = async (line) => {
  const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const text = '[' + stamp + '] ' + line
  console.log(text)
  try {
    await appendFile(logPath, text + '\n', 'utf8')
  } catch {}
}

/** 跑一次采样，带超时。返回 { ok, code, stdout, stderr, timedOut }。 */
const sampleOnce = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'observe-sessions.mjs'), '--tag', tag], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))

    // 采样器本身不该跑超过 10 秒；卡住就杀掉，否则会拖住整个循环
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, timedOut: true, stdout, stderr })
    }, 10000)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })

let stopping = false
const stop = async (reason) => {
  if (stopping) return
  stopping = true
  await log('stopping: ' + reason)
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

const main = async () => {
  await mkdir(dataDir, { recursive: true })
  await log('observe-loop start interval=' + intervalSec + 's tag=' + tag)
  let rounds = 0
  let consecutiveFailures = 0

  while (!stopping) {
    // 用 stop 文件做软停止：这样从别的会话也能让它停，不用去找 PID
    if (existsSync(stopFile)) {
      await log('found stop file, exiting')
      break
    }

    const result = await sampleOnce()
    rounds += 1
    if (result.ok) {
      consecutiveFailures = 0
      // 只把摘要写日志（observe-sessions 自己已写 JSONL）
      const line = (result.stdout || '').trim().split('\n')[0] || '(no output)'
      await log('#' + rounds + ' ' + line)
      // 后续行是状态边，单独记下来便于事后 grep
      const extra = (result.stdout || '').trim().split('\n').slice(1)
      for (const e of extra) if (e.trim()) await log('    ' + e.trim())
    } else {
      consecutiveFailures += 1
      await log('#' + rounds + ' FAILED timedOut=' + Boolean(result.timedOut) + ' code=' + result.code + ' err=' + (result.stderr || '').slice(0, 200))
      // 连续失败就拉长间隔，避免一直失败刷屏
      if (consecutiveFailures >= 5) {
        await log('too many consecutive failures, backing off 60s')
        await new Promise((r) => setTimeout(r, 60000))
        consecutiveFailures = 0
        continue
      }
    }

    await new Promise((r) => setTimeout(r, intervalSec * 1000))
  }
  await log('observe-loop exit after ' + rounds + ' rounds')
}

main().catch(async (error) => {
  await log('observe-loop crashed: ' + ((error && error.stack) || String(error)))
  process.exit(1)
})
