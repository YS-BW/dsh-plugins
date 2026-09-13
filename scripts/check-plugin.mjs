#!/usr/bin/env node
/**
 * 插件契约门禁。把「发布契约」变成机器可检查的规则，避免两个失败模式：
 *
 *   A. 发布不了：包名非法、版本号非法、缺 dsh 声明、files 漏了 lib、name 与 scope 不符……
 *   B. 发布了用不了：clientBundle id != 包名（浏览器半区静默不注册）、
 *      cordis.patch.yml 的 name 与包名不符（loader 解析不到）、
 *      files 漏掉 cordis.patch.yml 或 lib/client.js（装上但插件不工作）、
 *      bundle 里漏出本机绝对路径、客户端 bundle 引入了平台表外的 @deepseek-ai/*
 *
 * 用法：
 *   node scripts/check-plugin.mjs                # 静态检查全部 packages/*
 *   node scripts/check-plugin.mjs --dist         # 额外做构建产物与 tarball 检查（需先 build）
 *   node scripts/check-plugin.mjs <包名或路径>...  # 只查指定的包（可给多个，用于跨包冲突检查）
 *
 * 退出码非 0 表示有违规。设计原则是**失败即关闭**：解析不出预期结构一律算违规，
 * 不做「看不懂就放过」的处理。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** 平台模块表：客户端 bundle 的 require 只允许回答这些（与 shared/tsdown.client.ts 一致）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const BASE_NAME_RE = /^dsh-[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCOPED_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROW_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const ABSOLUTE_PATH_RE = /(?:^|[^A-Za-z0-9._-])\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\\\/

const args = process.argv.slice(2)
const withDist = args.includes('--dist')
const targets = args.filter((value) => !value.startsWith('--'))

const errors = []
const warnings = []

function error(pkg, message) {
  errors.push({ pkg, message })
}
function warn(pkg, message) {
  warnings.push({ pkg, message })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function stripQuotes(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
    || (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * 解析 cordis.patch.yml 里的插件行。
 * 只认本仓库脚手架的固定结构（先 `- id:` 再 `name:`），解析不出就返回空数组，
 * 由调用方判为违规——不允许「看不懂就放过」。
 */
function parsePatchRows(text) {
  const rows = []
  let orphanName = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '')
    if (!line.trim()) continue
    const idMatch = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      rows.push({ id: stripQuotes(idMatch[1]), name: null })
      continue
    }
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch !== null) {
      if (rows.length === 0) orphanName = true
      else rows[rows.length - 1].name = stripQuotes(nameMatch[1])
    }
  }
  return { rows, orphanName, hasInsert: /^\s*-\s*insert:/m.test(text) }
}

// ---- 收集待检查的包 ----
const rootManifest = readJson(join(REPO_ROOT, 'package.json'))
const expectedScope = rootManifest.dshPlugins?.scope ?? null

function listPackages() {
  if (!existsSync(PACKAGES_DIR)) return []
  return readdirSync(PACKAGES_DIR)
    .map((entry) => join(PACKAGES_DIR, entry))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .sort()
}

let packageDirs
if (targets.length === 0) {
  packageDirs = listPackages()
} else {
  packageDirs = []
  for (const target of targets) {
    const candidates = [resolve(REPO_ROOT, target), resolve(PACKAGES_DIR, target)]
    const found = candidates.find((dir) => existsSync(join(dir, 'package.json')))
    if (found === undefined) {
      console.error(`[check-plugin] 找不到包：${target}`)
      process.exit(1)
    }
    packageDirs.push(found)
  }
}

if (packageDirs.length === 0) {
  console.error('[check-plugin] packages/ 下没有任何包')
  process.exit(1)
}

const seenNames = new Map()
const seenRowIds = new Map()
const seenShortNames = new Map()

for (const dir of packageDirs) {
  const label = relative(REPO_ROOT, dir)
  const manifestPath = join(dir, 'package.json')

  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (err) {
    error(label, `package.json 不是合法 JSON：${err.message}`)
    continue
  }

  const name = manifest.name
  const version = manifest.version

  // ---- A. package.json 发布契约 ----
  if (typeof name !== 'string' || name.length === 0) {
    error(label, 'package.json 缺 name')
  } else {
    if (!SCOPED_NAME_RE.test(name)) {
      error(label, `name "${name}" 不符合约定（应为 @scope/dsh-xxx 形式，全小写，只含字母数字与单连字符）`)
    }
    const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : ''
    if (expectedScope !== null && name.startsWith('@') && scope !== expectedScope) {
      error(label, `name 的 scope 是 "${scope}"，与根 package.json 的 dshPlugins.scope "${expectedScope}" 不一致`)
    }
    if (expectedScope !== null && !name.startsWith('@')) {
      warn(label, `name "${name}" 没有 scope，与本仓库约定的 "${expectedScope}/..." 不一致`)
    }
    if (seenNames.has(name)) error(label, `name "${name}" 与 ${seenNames.get(name)} 重复`)
    else seenNames.set(name, label)

    const base = name.replace(/^@[^/]+\//, '')
    const short = base.replace(/^dsh-/, '')
    if (seenShortNames.has(short)) {
      warn(label, `短名 "${short}" 与 ${seenShortNames.get(short)} 重复，data-dsh-plugin 等语义属性会撞车`)
    } else {
      seenShortNames.set(short, label)
    }
  }

  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    error(label, `version "${version}" 不是合法 semver`)
  } else if (version.includes('-')) {
    warn(label, `version "${version}" 是预发布版，发布时必须用 --tag 指定 dist-tag，否则会污染 latest`)
  }

  if (manifest.private === true) error(label, 'private: true，无法发布')
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    error(label, '缺 description（npm 页面会空白）')
  }
  if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
    error(label, '缺 license')
  }
  if (manifest.author === undefined) error(label, '缺 author')
  if (manifest.repository === undefined) {
    error(label, '缺 repository（npm 页面与社区索引核对都要用）')
  } else {
    const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
    if (typeof url !== 'string' || !/^(git\+)?https:\/\//.test(url)) {
      error(label, 'repository.url 必须是 https:// 或 git+https:// 地址')
    }
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    error(label, '缺 keywords（至少一个，便于检索）')
  }
  if (manifest.engines?.node === undefined) {
    warn(label, '缺 engines.node')
  }

  // ---- dsh 声明 ----
  const dsh = manifest.dsh
  if (dsh === undefined || typeof dsh !== 'object' || dsh === null) {
    error(label, '缺 dsh 字段（engines / bundle / client）')
  } else {
    if (typeof dsh.engines?.dsh !== 'string' || dsh.engines.dsh.trim() === '') {
      error(label, '缺 dsh.engines.dsh（插件管理器兼容检查的读取位，缺了用户装不上）')
    }
    const patchRel = dsh.bundle?.patch
    if (typeof patchRel !== 'string' || patchRel.trim() === '') {
      error(label, '缺 dsh.bundle.patch')
    } else if (!existsSync(join(dir, patchRel))) {
      error(label, `dsh.bundle.patch 指向的文件不存在：${patchRel}`)
    }
    if (dsh.client === undefined) {
      error(label, '缺 dsh.client 声明')
    } else if (dsh.client.platform !== 'web') {
      error(label, `dsh.client.platform 必须是 "web"，当前是 ${JSON.stringify(dsh.client.platform)}`)
    }
    for (const key of ['inject', 'external']) {
      const value = dsh.client?.[key]
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
        error(label, `dsh.client.${key} 必须是字符串数组`)
      }
    }
    if (dsh.client?.immediately !== undefined && typeof dsh.client.immediately !== 'boolean') {
      error(label, 'dsh.client.immediately 必须是 boolean')
    }
  }

  // ---- files ----
  const patchFileName = typeof dsh?.bundle?.patch === 'string' ? dsh.bundle.patch.replace(/^\.\//, '') : null
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    error(label, '缺 files（否则 tarball 会缺少构建产物）')
  } else {
    const required = ['lib', 'README.md']
    if (patchFileName !== null) required.push(patchFileName)
    for (const item of required) {
      if (!manifest.files.includes(item)) {
        error(label, `files 必须包含 "${item}"（当前：${JSON.stringify(manifest.files)}）`)
      }
    }
  }

  // ---- exports ----
  const exportsField = manifest.exports
  if (exportsField === undefined || typeof exportsField !== 'object') {
    error(label, '缺 exports')
  } else {
    verifyExport(label, exportsField['.'], '.', true)
    verifyExport(label, exportsField['./client'], './client', false)
    if (exportsField['./package.json'] === undefined) {
      warn(label, '建议提供 exports["./package.json"]')
    }
  }

  if (typeof manifest.main !== 'string') warn(label, '缺 main')
  if (typeof manifest.types !== 'string') warn(label, '缺 types')

  // ---- scripts ----
  if (typeof manifest.scripts?.build !== 'string') error(label, '缺 scripts.build')
  if (typeof manifest.scripts?.prepack !== 'string') {
    error(label, '缺 scripts.prepack（npm publish 时靠它现场构建，lib/ 不进 git）')
  }

  // ---- README ----
  const readme = join(dir, 'README.md')
  if (!existsSync(readme)) error(label, '缺 README.md（files 里声明了它）')
  else if (readFileSync(readme, 'utf8').trim().length === 0) error(label, 'README.md 是空的')

  // ---- 自足性 ----
  for (const forbidden of ['../../shared', '../shared']) {
    if (readFileSync(manifestPath, 'utf8').includes(forbidden)) {
      error(label, `package.json 引用了仓库根：${forbidden}`)
    }
  }

  // ---- B. cordis.patch.yml ----
  if (typeof patchRelOK(dsh) === 'string') {
    checkPatch(dir, label, name)
  } else {
    error(label, '无法定位 dsh.bundle.patch，跳过 patch 检查（视为违规）')
  }

  // ---- C. tsdown.config.ts ----
  checkTsdown(dir, label, name)

  // ---- E. 构建产物与 tarball ----
  if (withDist) {
    checkDist(dir, label, manifest)
  }
}

function patchRelOK(dsh) {
  const value = dsh?.bundle?.patch
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function verifyExport(label, value, key, needsTypes) {
  if (value === undefined) {
    error(label, `exports 缺 "${key}"`)
    return
  }
  const isString = typeof value === 'string'
  const defaultValue = isString ? value : value?.default
  if (typeof defaultValue !== 'string') {
    error(label, `exports["${key}"] 必须是字符串，或含字符串 default 的对象`)
    return
  }
  if (!defaultValue.startsWith('./')) {
    error(label, `exports["${key}"].default 必须以 ./ 开头，当前是 "${defaultValue}"`)
  }
  if (!isString) {
    const typesValue = value?.types
    if (typesValue === undefined) {
      if (needsTypes) warn(label, `exports["${key}"] 建议声明 types`)
    } else if (typeof typesValue !== 'string' || !typesValue.endsWith('.d.ts')) {
      error(label, `exports["${key}"].types 必须是 .d.ts 路径`)
    }
  } else if (needsTypes) {
    warn(label, `exports["${key}"] 建议写成 { types, default } 形式`)
  }
}

function checkPatch(dir, label, name) {
  const patchRel = patchRelOK(readJson(join(dir, 'package.json')).dsh)
  const patchPath = join(dir, patchRel)
  const text = readFileSync(patchPath, 'utf8')
  const { rows, orphanName, hasInsert } = parsePatchRows(text)

  if (!hasInsert) {
    error(label, `${patchRel} 里没有 "- insert:" 块`)
    return
  }
  if (orphanName) {
    error(label, `${patchRel} 里有 name 出现在任何 id 之前，结构无法解析`)
  }
  if (rows.length === 0) {
    error(label, `${patchRel} 里解析不出任何插件行（需要 "- id: <短名>" 加 "name: '<完整包名>'"）`)
    return
  }
  if (rows.length > 1) {
    error(label, `${patchRel} 有 ${rows.length} 个插件行；独立插件包应当只有一个`)
  }

  for (const row of rows) {
    if (row.id === null || !ROW_ID_RE.test(row.id)) {
      error(label, `${patchRel} 的 id "${row.id}" 非法（只允许小写字母、数字、连字符）`)
    } else if (seenRowIds.has(row.id)) {
      error(label, `${patchRel} 的 id "${row.id}" 与 ${seenRowIds.get(row.id)} 重复（会导致挂载冲突）`)
    } else {
      seenRowIds.set(row.id, label)
    }
    if (row.name === null) {
      error(label, `${patchRel} 的 id "${row.id}" 没有对应的 name`)
    } else if (row.name !== name) {
      error(
        label,
        `${patchRel} 的 name "${row.name}" 与 package.json 的 name "${name}" 不一致`
        + '（loader 会解析不到这个包，插件装上也挂不起来）',
      )
    }
  }
}

function checkTsdown(dir, label, name) {
  const file = join(dir, 'tsdown.config.ts')
  if (!existsSync(file)) {
    error(label, '缺 tsdown.config.ts')
    return
  }
  const text = readFileSync(file, 'utf8')

  const match = /clientBundle\(\s*(['"])(.+?)\1/.exec(text)
  if (match === null) {
    error(label, "tsdown.config.ts 里找不到 clientBundle('<包名>', ...) 调用")
  } else if (match[2] !== name) {
    error(
      label,
      `clientBundle 的 id "${match[2]}" 与 package.json 的 name "${name}" 不一致`
      + '（这个 id 是客户端模块表的注册键，不一致会让浏览器半区静默不注册）',
    )
  }

  if (text.includes('../../shared') || text.includes('../shared')) {
    error(label, 'tsdown.config.ts 引用了仓库根的 shared/，破坏了包的自足性')
  }
  if (!text.includes("'./build/tsdown.client.ts'") && !text.includes('"./build/tsdown.client.ts"')) {
    warn(label, "tsdown.config.ts 未从 './build/tsdown.client.ts' 引入预设")
  }
  if (!existsSync(join(dir, 'build', 'tsdown.client.ts'))) {
    error(label, '缺 build/tsdown.client.ts（跑 pnpm preset:sync 生成）')
  }
}

function checkDist(dir, label, manifest) {
  const libDir = join(dir, 'lib')
  if (!existsSync(libDir)) {
    error(label, '缺 lib/ 构建产物，请先 pnpm build 再带 --dist 检查')
    return
  }

  const requiredFiles = ['index.js', 'client.js']
  for (const file of requiredFiles) {
    const full = join(libDir, file)
    if (!existsSync(full)) error(label, `构建产物缺 lib/${file}`)
    else if (statSync(full).size === 0) error(label, `lib/${file} 是空文件`)
  }

  // 客户端 bundle 必须注册正确的模块 id
  const clientPath = join(libDir, 'client.js')
  if (existsSync(clientPath)) {
    const client = readFileSync(clientPath, 'utf8')
    const idPattern = new RegExp(`id:\\s*["']${escapeRegex(manifest.name)}["']`)
    if (!idPattern.test(client)) {
      error(
        label,
        `lib/client.js 里没有 id: "${manifest.name}" 的注册语句`
        + '（浏览器半区不会注册，插件看起来装了但界面无反应）',
      )
    }
    if (!client.includes('__ModuleLoader__')) {
      error(label, 'lib/client.js 不是 ModuleLoader 闭包工厂（缺 window.__ModuleLoader__.load）')
    }
    // 本机绝对路径泄漏
    if (ABSOLUTE_PATH_RE.test(client)) {
      error(label, 'lib/client.js 里出现本机绝对路径（CSS 虚拟 id 未做包内相对化？）')
    }
    // 平台表外的 @deepseek-ai/* 引用
    for (const hit of new Set(client.match(/@deepseek-ai\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/g) ?? [])) {
      if (!PLATFORM_MODULES.includes(hit)) {
        error(label, `lib/client.js 引用了平台模块表之外的 "${hit}"，浏览器里会加载失败`)
      }
    }
  }

  // tarball 实测内容
  let packed
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    packed = JSON.parse(raw.slice(raw.indexOf('[')))[0]
  } catch (err) {
    error(label, `npm pack --dry-run 失败：${err.message}`)
    return
  }

  const paths = new Set((packed.files ?? []).map((file) => file.path))
  const patchRel = manifest.dsh?.bundle?.patch?.replace(/^\.\//, '')
  const mustHave = ['package.json', 'README.md', 'lib/index.js', 'lib/client.js']
  if (typeof patchRel === 'string') mustHave.push(patchRel)
  for (const file of mustHave) {
    if (!paths.has(file)) {
      error(label, `tarball 里缺 "${file}"（用户装上后会缺文件，插件无法工作）`)
    }
  }
  for (const key of ['.', './client']) {
    const entry = manifest.exports?.[key]
    const target = typeof entry === 'string' ? entry : entry?.default
    if (typeof target === 'string') {
      const rel = target.replace(/^\.\//, '')
      if (!paths.has(rel)) error(label, `exports["${key}"] 指向 ${target}，但 tarball 里没有这个文件`)
    }
  }

  const size = packed.size ?? 0
  if (size > 10 * 1024 * 1024) {
    error(label, `tarball 体积 ${(size / 1024 / 1024).toFixed(1)} MB 过大，请检查是否误打包了资源或依赖`)
  } else if (size > 2 * 1024 * 1024) {
    warn(label, `tarball 体积 ${(size / 1024 / 1024).toFixed(1)} MB 偏大（DSH 插件通常几十 KB）`)
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- 输出 ----
const checked = packageDirs.length
for (const item of errors) {
  console.error(`  ERROR  ${item.pkg}\n         ${item.message}`)
}
for (const item of warnings) {
  console.warn(`  WARN   ${item.pkg}\n         ${item.message}`)
}

if (errors.length > 0) {
  console.error(`\n[check-plugin] 失败：${checked} 个包中发现 ${errors.length} 个违规、${warnings.length} 个提醒`)
  process.exit(1)
}
console.log(`[check-plugin] OK：${checked} 个包全部符合契约${warnings.length > 0 ? `（${warnings.length} 个提醒）` : ''}`)
