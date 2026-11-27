#!/usr/bin/env node
/**
 * 跨工作区门控测试（tools/gate-test.mjs）。
 *
 * gate-test 的 body 需要 import lib/index.js，而 lib/index.js 依赖
 * @deepseek-ai/schemastery；发布端工作树不装依赖，所以外层探测一下：
 * 缺依赖时打印 SKIP 并 exit 0（和 tool-schema-test 同一形状），
 * 开发端有 node_modules 时真正执行 body。
 *
 * ⚠️ SKIP ≠ 通过：它只说明「这一层当前环境没验」。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const entry = join(here, '_gate-test-body.mjs')

const hasSchema = existsSync(join(root, 'node_modules', '@deepseek-ai', 'schemastery'))
if (!hasSchema) {
  console.log('SKIP gate-test — 未安装 @deepseek-ai/schemastery（发布端不装依赖；本测试只在开发端有意义）')
  console.log('  ⚠️ SKIP ≠ 通过：跨工作区门控本次没有被验过。开发端跑：cd <开发端> && node tools/gate-test.mjs')
  process.exit(0)
}

const result = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8' })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) {
  console.error('gate-test: 子进程未能正常启动 —', result.error.message)
  process.exit(1)
}
if (typeof result.status !== 'number') {
  console.error('gate-test: 子进程被信号终止 signal=' + String(result.signal))
  process.exit(1)
}
process.exit(result.status)
