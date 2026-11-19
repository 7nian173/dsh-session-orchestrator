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

// ⚠️ stdout 与 stderr 都无条件透传，不要按退出码分别处理。
// 之前只在 status !== 0 时打印 stderr、且始终打印 stdout——
// 但子进程若被信号杀死或被 OOM，status 是 null 且 stdout 可能为空，
// 现场看起来就是「EXIT=1 且零输出」，比报错更难查（实验室实测踩到）。
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')

if (result.error) {
  console.error('permit-window-test: 子进程未能正常启动 —', result.error.message)
  process.exit(1)
}
if (typeof result.status !== 'number') {
  console.error('permit-window-test: 子进程被信号终止 signal=' + String(result.signal))
  process.exit(1)
}
process.exit(result.status)
