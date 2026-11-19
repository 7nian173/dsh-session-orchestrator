#!/usr/bin/env node
/**
 * 授权窗口翻页测试（tools/permit-window-test.mjs）。
 *
 * 这个测试 import 了 lib/index.js，因此需要宿主的 @deepseek-ai/schemastery。
 * 它只在开发端（插件仓库根有 node_modules）跑；发布端工作树不装依赖，
 * 强行要求依赖会让「发布前自检」失败于与代码无关的原因。
 *
 * 所以外层包一层：依赖缺失时打印 SKIP 并 exit 0（而不是让 healthcheck 红）。
 * 缺依赖这件事本身要说清楚，不能被当成「测试通过」蒙过去。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const entry = join(here, '_permit-window-test-body.mjs')

// 依赖探测：能解析到 schemastery 才真跑。
const hasSchema = existsSync(join(root, 'node_modules', '@deepseek-ai', 'schemastery'))
if (!hasSchema) {
  console.log('SKIP permit-window-test — 未安装 @deepseek-ai/schemastery（发布端不装依赖；本测试只在开发端有意义）')
  process.exit(0)
}

const result = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8' })
process.stdout.write(result.stdout || '')
if (result.status !== 0) {
  process.stderr.write(result.stderr || '')
}
process.exit(result.status === null ? 1 : result.status)
