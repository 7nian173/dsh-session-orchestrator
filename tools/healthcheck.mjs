#!/usr/bin/env node
/**
 * 发布前自检（healthcheck）。exit 0 才允许 push。
 *
 *   node tools/healthcheck.mjs
 *
 * 三段：
 *   1) 语法：node --check 三个 lib 文件
 *   2) 断言：tools/mail-push-test.mjs + tools/permit-window-test.mjs
 *   3) 清单：package.json 的 files 逐条存在 + bundle patch 存在
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const node = process.execPath
const results = []

function run(name, args) {
  const res = spawnSync(node, args, { cwd: root, encoding: 'utf8' })
  const ok = res.status === 0
  results.push({ name, ok, out: (res.stdout || '') + (res.stderr || '') })
  return ok
}

for (const file of ['lib/index.js', 'lib/mail.js', 'lib/client.js']) {
  run('语法 ' + file, ['--check', join(root, file)])
}

run('断言 mail-push-test', [join(root, 'tools/mail-push-test.mjs')])
// 授权窗口翻页：这段逻辑失效是静默的（长会话里人类自己的请求被门控拦掉），
// 必须进自检，否则单靠 mail-push-test 全绿也发现不了。
run('断言 permit-window-test', [join(root, 'tools/permit-window-test.mjs')])
// 隐私与可移植性：扫本机绝对路径、真实会话/信件 id、主机名。
// 为什么进自检：这类东西一旦进了文档就跟着发布出去，而且没人会回头再看。
// 实测（2026-11-20）：一处本机路径跟着 Release 正文和 tag message 一起上了 GitHub。
run('隐私本机硬编码', [join(root, 'tools/privacy-check.mjs')])

let manifestOk = true
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const missing = (pkg.files || []).filter((f) => !existsSync(join(root, f)))
  manifestOk = missing.length === 0
  results.push({ name: '清单 files', ok: manifestOk, out: missing.length ? 'missing: ' + missing.join(', ') : 'ok' })
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  const patchOk = Boolean(patch) && existsSync(join(root, patch))
  results.push({ name: 'bundle patch', ok: patchOk, out: patch ? (patchOk ? 'ok' : 'missing: ' + patch) : 'dsh.bundle.patch 未声明' })
} catch (error) {
  results.push({ name: '清单 files', ok: false, out: 'package.json 读取失败: ' + (error && error.message) })
}

let failed = 0
for (const row of results) {
  console.log((row.ok ? 'PASS ' : 'FAIL ') + row.name)
  if (!row.ok) {
    failed += 1
    const tail = row.out.trim().split(/\r?\n/).slice(-6).join('\n')
    if (tail) console.log(tail.replace(/^/gm, '    '))
  }
}

console.log('')
console.log(failed === 0 ? 'healthcheck 通过，可以 push' : 'healthcheck 失败 ' + failed + ' 项，不许 push')
process.exit(failed === 0 ? 0 : 1)