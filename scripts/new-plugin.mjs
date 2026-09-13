#!/usr/bin/env node
/**
 * 从模板包复制出一个新的插件包，并把必须一致的标识一次改对。
 *
 *   node scripts/new-plugin.mjs foo          # 生成 @scope/dsh-foo
 *   node scripts/new-plugin.mjs dsh-foo      # 同上
 *   node scripts/new-plugin.mjs @other/dsh-foo   # 显式指定 scope，覆盖仓库默认
 *
 * npm scope 与模板包来自仓库根 package.json 的 dshPlugins 字段：
 *   "dshPlugins": { "scope": "@lixklv", "template": "dsh-hello" }
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function usage() {
  console.log('用法: node scripts/new-plugin.mjs <name>')
  console.log('  <name> 例如 foo 或 dsh-foo，生成 @scope/dsh-foo')
  console.log('  也可以用 @other/dsh-foo 显式指定 scope')
}

const raw = process.argv[2]
if (!raw || raw === '--help' || raw === '-h') {
  usage()
  process.exit(raw ? 0 : 1)
}

// ---- 读取仓库配置：scope 与模板包 ----
const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const configuredScope = rootManifest.dshPlugins?.scope ?? ''
const templateDirName = rootManifest.dshPlugins?.template ?? 'dsh-hello'
const templateDir = join(REPO_ROOT, 'packages', templateDirName)
if (!existsSync(templateDir)) {
  console.error(`[new-plugin] 找不到模板包：packages/${templateDirName}`)
  process.exit(1)
}

const templateManifest = JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf8'))
const templateFullName = templateManifest.name
const templateBase = templateFullName.replace(/^@[^/]+\//, '')
const templateShort = templateBase.replace(/^dsh-/, '')

// ---- 解析目标名字 ----
const explicitScope = raw.startsWith('@') ? raw.slice(0, raw.indexOf('/')) : ''
let base = explicitScope ? raw.slice(raw.indexOf('/') + 1) : raw
const scope = explicitScope || configuredScope
if (!base.startsWith('dsh-')) base = `dsh-${base}`
const short = base.slice('dsh-'.length)
const fullName = scope ? `${scope}/${base}` : base
const dest = join(REPO_ROOT, 'packages', base)

if (!NAME_RE.test(base)) {
  console.error(`[new-plugin] 非法包名 "${base}"：只允许小写字母、数字与单连字符`)
  process.exit(1)
}
if (base.startsWith('ui-')) {
  console.error(`[new-plugin] 非法包名 "${base}"：不要用 ui- 开头`)
  process.exit(1)
}
if (existsSync(dest)) {
  console.error(`[new-plugin] 目标已存在：packages/${base}`)
  process.exit(1)
}

// ---- 复制（跳过构建产物与依赖） ----
const SKIP = new Set(['lib', 'node_modules', 'coverage'])

function copy(from, to) {
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry)) continue
    const src = join(from, entry)
    const dst = join(to, entry)
    cpSync(src, dst, { recursive: true })
    if (statSync(src).isDirectory()) copy(src, dst)
  }
}

copy(templateDir, dest)

// ---- 替换标识：先换完整包名，再换短名 ----
// 顺序不能反：先换短名会把 dsh-hello 拆开，导致后面的完整包名匹配不上。
function rewrite(file) {
  const before = readFileSync(file, 'utf8')
  const after = before.split(templateFullName).join(fullName).split(templateShort).join(short)
  if (after !== before) writeFileSync(file, after)
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const target = join(dir, entry)
    if (statSync(target).isDirectory()) walk(target)
    else rewrite(target)
  }
}
walk(dest)

console.log(`[new-plugin] 已生成 packages/${base}  (${fullName})`)
console.log('')
console.log('接下来：')
console.log(`  1. 写 src/client/index.ts 的 UI 与 src/index.ts 的 host 行为`)
console.log(`  2. 改 package.json 的 description（version 已是 0.0.1）`)
console.log(`  3. pnpm install && pnpm gate`)
console.log(`  4. 本地验证：cd packages/${base} && dsh plugin --profile web add link:"$PWD"`)
console.log('  5. 重启 dsh web 后生效')
console.log('')
console.log('自检：下面这些位置必须都是新标识')

const checks = [
  ['package.json', /"name":\s*"([^"]+)"/],
  ['cordis.patch.yml', /^\s*name:\s*'?([^'\n]+)'?$/m],
  ['tsdown.config.ts', /clientBundle\('([^']+)'/],
  ['src/client/index.ts', /const PLUGIN_ID = '([^']+)'/],
]
for (const [file, pattern] of checks) {
  const content = readFileSync(join(dest, file), 'utf8')
  const match = pattern.exec(content)
  console.log(`  ${file.padEnd(24)} ${match === null ? '(未找到)' : match[1]}`)
}
console.log('')
console.log('  id 与 PLUGIN_ID 用短名是正常的；name 与 clientBundle id 必须是完整包名。')
