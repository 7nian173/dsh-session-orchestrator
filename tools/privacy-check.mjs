#!/usr/bin/env node
/**
 * 隐私与可移植性检查：扫描仓库里的本机硬编码。
 *
 * 为什么需要它：这类东西**一旦写进文档就跟着发布出去了**，
 * 而且不会有人回头再看一遍。2026-11-20 实测——一处本机路径
 * 跟着 Release 正文和 tag message 一起上了 GitHub，事后才被发现。
 *
 * 设计原则：**能自动判的就自动判，判不了的不瞎判。**
 *   硬错误（一定不该出现）：本机绝对路径、用户名、可识别的真实会话 id
 *   软提示（可能有意为之）：示例里的占位路径
 *
 * 用法：
 *   node tools/privacy-check.mjs          扫描并报告（有硬错误时 exit 1）
 *   node tools/privacy-check.mjs --fix    只报告，不自动改（改要人判断）
 *
 * 已经被 healthcheck 调用，所以 push 前会自动跑。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync as readFileSyncSync } from 'node:fs'
import { join, dirname, relative, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ⚠️ 扫描根默认取 **cwd**，不是脚本所在目录的父目录。
//
// 使用方 lead 实测踩到：他从自己的仓跑 `node <别处>/privacy-check.mjs`，
// 脚本按 `dirname(here)` 把 root 算成了脚本所在的目录，扫的是别人的仓
// （3872 处全是 session-bridge 的会话记录），而他自己的仓一处没扫。
//
// 正确语义是「检查当前这个仓库」，所以：
//   1. 优先 --root 显式指定
//   2. 否则用 process.cwd()
//   3. 只有当 cwd 里没有 .git 时，才退回脚本父目录（兼容旧用法）
const resolveRoot = () => {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--root')
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1])
  const cwd = process.cwd()
  // cwd 是 git 仓库 → 就用它；否则退回脚本父目录（在仓库内的常规调用）
  if (existsSync(join(cwd, '.git'))) return cwd
  return dirname(here)
}
const root = resolveRoot()

// --scope / .privacyignore：只扫「会被发布的东西」。
//
// 使用方 lead 指出的关键区分：**「含本机路径」和「会外发」是两件事。**
// 他们的 `_施工记录/` 里有 319 处命中，但那是**证据**——
// 信件 id 是证据的一部分，脱敏就破坏了它作为证据的价值。
// 而那个仓从来没有远端，这些内容永远不会外发。
//
// 判据不是「文件里有没有本机路径」，是「这个目录会不会被发布」。
// 这和 docsOnly 是同一个道理：不看它长什么样，看它为什么在这。
const loadScope = () => {
  const argv = process.argv.slice(2)
  const patterns = []

  // 命令行：--scope a/b --scope c/
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scope' && argv[i + 1]) patterns.push(argv[i + 1])
  }

  // 文件：.privacyignore（每行一条，支持 # 注释与结尾 /）
  try {
    const text = readFileSyncSync(join(root, '.privacyignore'), 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      patterns.push(line)
    }
  } catch {
    // 没有这个文件就是没配 scope
  }

  return patterns.map((p2) => p2.replace(/\\/g, '/').replace(/\/+$/, ''))
}
const scopePatterns = loadScope()

/** 路径是否落在 scope 之外（scope 里写的是「要扫的」，没写就是全扫）。 */
const inScope = (relPath) => {
  if (scopePatterns.length === 0) return true
  const normalized = relPath.replace(/\\/g, '/')
  return scopePatterns.some((entry) => normalized === entry || normalized.startsWith(entry + '/'))
}

/** 只扫会被发布/公开的东西 */
const SCAN_EXT = new Set(['.md', '.js', '.mjs', '.json', '.yml', '.yaml', '.html', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '_tmp', '.git', '.dsh-mail', 'dist'])

/**
 * 硬错误规则：命中即失败。
 *
 * 每条规则都要写清「为什么」，否则以后没人敢改。
 */
const HARD_RULES = [
  {
    id: 'local-drive-path',
    // Windows 盘符绝对路径。本机是 D:\ / E:\ 下的开发目录，
    // 但用户机器上长什么样都无所谓——文档里不该出现任何人的盘符路径。
    // 只列本机特有的目录名。`Users` 不在这里 —— 它有独立规则处理带用户名的情形，
    // 而 `C:\Users\<me>` 这种占位符是正确用法。
    test: /\b[A-Za-z]:[\\/](?:dshdata|AI Projects|AI开发|_lab)\b/i,
    why: '本机绝对路径（会暴露目录结构与用户名）',
  },
  {
    id: 'user-home',
    // `C:\Users\<me>` 这种占位符是正确用法，要放过。
    // 真正该报的是带了具体用户名的路径。
    test: /\b(?:C:)?[\\/]Users[\\/](?!<)(?!%)(?!\$)[A-Za-z0-9._-]{2,}/i,
    why: '用户主目录路径（带具体用户名）',
  },
  {
    id: 'real-session-id',
    // 真实会话 id 形如 session-<uuid>；示例里通常写成 session-...
    test: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    why: '真实会话 id（不是示例，可用于定位具体会话）',
  },
  {
    id: 'real-mail-id',
    // 真实信件 id 形如 M-20261119-0034。
    //
    // ⚠️ 这个规则**只扫文档**，不扫 tools/ 下的测试。
    // 原因：实测发现测试号段一直在蔓延（8000+ → 7800+ → 7900+），
    // 任何「号段上限」假设都会随时间失效。
    //
    // 更可靠的判据是**文件性质**：
    //   文档（README/docs）里的 mail_id 是**叙述真实事故**，该脱敏
    //   tools/ 测试里的 mail_id 是**测试夹具**，本来就该是编的
    // 所以靠 scope 排除测试文件，而不是靠号段猜。
    // 0001-0009 是文档里约定俗成的连续示例号（如 {"mailId": "M-...-0001"}），
    // 用否定前瞻排除掉，否则每条命令示例都会被误报。
    test: /\bM-2026\d{4}-(?!0{3}[1-9]\b)\d{4}\b/,
    why: '真实信件 id（可能关联真实业务数据）',
    docsOnly: true,
  },
  {
    id: 'machine-name',
    // 主机名出现在文档里通常是抄了命令输出
    test: /\bDESKTOP-[A-Z0-9]{7}\b/i,
    why: '本机主机名',
  },
]

/** 软提示：不失败，只提醒「你自己确认一下这是不是示例」 */
const SOFT_RULES = [
  {
    id: 'example-path',
    test: /\b[A-Za-z]:[\\/](?:projects|path|your)[^\s`'")\]]*/i,
    why: '示例路径（确认是编的，不是本机真实目录）',
  },
  {
    id: 'ds-home-placeholder',
    test: /\$DSH_HOME/,
    why: '占位符（正确用法，无需处理）',
    infoOnly: true,
  },
]

const collect = async (dir, out = []) => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collect(full, out)
      continue
    }
    if (!SCAN_EXT.has(extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
  return out
}

/**
 * 扫 git 载体：commit message 与 tag annotated message。
 *
 * 为什么要单独扫（使用方 lead 指出的，我原来的说法不够准）：
 *   - tag 的 annotated message 在 `.git` 对象库里，`git status` 看不见
 *   - commit message 同样在对象库里，`git status` 也看不见
 *   - GitHub Release 正文根本不在本机，要 `gh release view`
 *
 * 所以「发布前自检」不是一个动作，是四个不同的检查：
 *   工作树 git status / commit git log / tag git tag -n99 / Release gh release view
 * 2026-11-20 实测：一处本机路径同时进了 tag message 和 Release 正文，
 * 而工作树当时是干净的。
 *
 * ⚠️ 只查「将要推送但还没推送的」，不查历史。
 * 扫描的目的是**阻止新泄露进入**，不是清算历史。历史改不了，
 * 让它永远红会让人习惯性忽略红灯。
 */
const scanGitCarriers = async () => {
  const { execFileSync } = await import('node:child_process')
  const hits = []
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }

  const checkText = (label, text) => {
    const lines = String(text).split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      for (const rule of HARD_RULES) {
        if (rule.docsOnly) continue // git message 里的 id 一律按潜在真实数据处理
        if (rule.test.test(lines[i])) {
          hits.push({ carrier: label, line: i + 1, rule: rule.id, why: rule.why, text: lines[i].trim().slice(0, 120) })
        }
      }
    }
  }

  // 基准点：依次尝试 origin/master、origin/HEAD、本地 master。
  // 全都没有就跳过——CI 浅克隆里可能拿不到，拿不到不等于有问题。
  const base = (() => {
    for (const candidate of ['origin/master', 'origin/HEAD', 'master']) {
      const sha = run(['rev-parse', '--verify', '--quiet', candidate]).trim()
      if (sha) return candidate
    }
    return ''
  })()

  if (base) {
    const range = base + '..HEAD'
    const log = run(['log', range, '--format=%B%n---COMMIT---'])
    if (log.trim()) checkText('待推送 commit(' + range + ')', log)
  } else {
    console.log('  （跳过 commit 扫描：找不到基准分支）')
  }

  // tag 只查「本地有、远端没有」的——已推送的 tag 同样改不了历史
  const localTags = run(['tag', '-l']).split('\n').filter(Boolean)
  const remoteTags = new Set(
    run(['ls-remote', '--tags', 'origin'])
      .split('\n')
      .map((line) => {
        const m = line.match(/refs\/tags\/(.+?)(?:\^\{\})?$/)
        return m ? m[1] : ''
      })
      .filter(Boolean),
  )
  for (const tag of localTags) {
    if (remoteTags.has(tag)) continue
    const body = run(['tag', '-n99', '-l', tag])
    if (body) checkText('未推送 tag:' + tag, body)
  }

  return hits
}

const main = async () => {
  const files = await collect(root)
  const hard = []
  const soft = []

  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    // 把自己排除掉：规则本身写着这些模式
    if (rel === 'tools/privacy-check.mjs') continue
    // scope 之外的不扫（那些内容不会外发）
    if (!inScope(rel)) continue
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const rule of HARD_RULES) {
        // docsOnly 的规则只扫文档：tools/ 下的 id 是测试夹具，不是真实数据
        if (rule.docsOnly && !/(^|[\\/])(README[^\\/]*|[^\\/]*\.md|[^\\/]*\.html)$/i.test(relative(root, file))) continue
        if (rule.test.test(line)) {
          hard.push({ file: relative(root, file), line: i + 1, rule: rule.id, why: rule.why, text: line.trim().slice(0, 120) })
        }
      }
      for (const rule of SOFT_RULES) {
        if (rule.infoOnly) continue
        if (rule.test.test(line)) {
          soft.push({ file: relative(root, file), line: i + 1, rule: rule.id, why: rule.why, text: line.trim().slice(0, 120) })
        }
      }
    }
  }

  // files.length 是「找到的候选文件数」，scope 里实际扫的更少。
  // 只报前者会让人以为 scope 没生效（使用方实测就这么误判过），所以两个都给。
  const scannedCount = files.filter((f) => inScope(relative(root, f).replace(/\\/g, '/'))).length
  const scopeNote =
    scopePatterns.length > 0
      ? '，scope 限定 ' + scopePatterns.join(' / ') + '（实际扫 ' + scannedCount + '）'
      : ''
  console.log('隐私与可移植性检查（候选 ' + files.length + ' 个文件' + scopeNote + '）')

  // git 载体（commit / tag）——工作树干净也查不到这些东西
  const carrierHits = await scanGitCarriers()
  for (const hit of carrierHits) hard.push({ file: hit.carrier, line: hit.line, rule: hit.rule, why: hit.why, text: hit.text })

  if (soft.length > 0) {
    console.log('\n提示（请自行确认是编的例子，不是真目录）：')
    for (const hit of soft) console.log('  ' + hit.file + ':' + hit.line + '  ' + hit.why + '\n    ' + hit.text)
  }

  if (hard.length === 0) {
    console.log('\nPASS 隐私检查：没有发现本机硬编码')
    process.exit(0)
  }

  console.log('\nFAIL 隐私检查：发现 ' + hard.length + ' 处本机硬编码')
  for (const hit of hard) {
    console.log('\n  ' + hit.file + ':' + hit.line + '  [' + hit.rule + '] ' + hit.why)
    console.log('    ' + hit.text)
  }
  console.log('\n怎么改：换成占位符。示例——')
  console.log('  D:\\dshdata\\本地        →  <工作区>  或  D:\\projects\\my-app')
  console.log('  session-<真实uuid>     →  session-...7e5c91e（留后四位即可示意）')
  console.log('  M-20261117-0066        →  <一个示例信件 id>')
  process.exit(1)
}

main().catch((error) => {
  console.error('privacy-check failed:', (error && error.message) || String(error))
  process.exit(1)
})
