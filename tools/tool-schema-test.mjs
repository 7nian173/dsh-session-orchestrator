#!/usr/bin/env node
/**
 * 工具层 schema 测试（tools/tool-schema-test.mjs）。
 *
 * 这个测试 import 了 lib/index.js，因此需要宿主的 @deepseek-ai/schemastery。
 * 它只在开发端（插件仓库根有 node_modules）跑；发布端工作树不装依赖，
 * 强行要求依赖会让「发布前自检」失败于与代码无关的原因。
 *
 * 所以外层包一层：依赖缺失时打印 SKIP 并 exit 0（而不是让 healthcheck 红）。
 *
 * ⚠️ 但要注意：**SKIP 不等于通过。**
 * 依赖缺失时，工具层 schema 就完全没被验过——而这类 bug（后端有字段、schema 没放行）
 * 恰恰是最难在运行时发现的。所以 SKIP 时要把这句话打出来，不能让人误以为验过了。
 *
 * 为什么这个文件存在：2026-11-20 两次同一形状的阻断性 bug
 * （evidence、S-TODO-NOTICE 三字段）都是断言跑在后端、bug 在工具层。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const entry = join(here, '_tool-schema-test-body.mjs')

const hasSchema = existsSync(join(root, 'node_modules', '@deepseek-ai', 'schemastery'))
if (!hasSchema) {
  console.log(
    'SKIP tool-schema-test — 未安装 @deepseek-ai/schemastery（发布端不装依赖；本测试只在开发端有意义）',
  )
  console.log(
    '  ⚠️ SKIP ≠ 通过：工具层 schema 本次**没有被验过**。' +
      '本测试专门拦「后端有字段、工具 schema 没放行」这类 bug（2026-11-20 撞过两次）。',
  )
  // 光说「没验」不够——要说「去哪儿验」，否则读的人知道有缺口却无处补。
  // （使用方 lead 的建议）
  console.log('  若要验，请在开发端跑（仓库根目录有 node_modules 的那一侧）：')
  console.log('    cd <开发端> && node tools/tool-schema-test.mjs')
  process.exit(0)
}

const result = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8' })

process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')

if (result.error) {
  console.error('tool-schema-test: 子进程未能正常启动 —', result.error.message)
  process.exit(1)
}
if (typeof result.status !== 'number') {
  console.error('tool-schema-test: 子进程被信号终止 signal=' + String(result.signal))
  process.exit(1)
}
process.exit(result.status)
