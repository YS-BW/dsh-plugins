#!/usr/bin/env node
/**
 * 插件发布预检 + 发布。把容易踩的坑固化进流程：
 * 未登录、版本号已存在、缺发布元数据、tarball 内容不对、scoped 包没开 public。
 *
 *   node scripts/publish.mjs <包名>              # 只预检 + dry-run，不会发布
 *   node scripts/publish.mjs <包名> --publish    # 全部预检通过后真正发布
 *
 * <包名> 可以是包目录名（dsh-hello）或相对/绝对路径。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = args.find((value) => !value.startsWith('--'))
const doPublish = args.includes('--publish')

/** npm/pnpm 的代理告警是环境噪音，不是错误。 */
const NOISE = /UNDICI-EHPA|trace-warnings|EnvHttpProxyAgent/

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT,
    env: process.env,
  })
  const clean = (text) =>
    (text ?? '')
      .split('\n')
      .filter((line) => !NOISE.test(line))
      .join('\n')
      .trim()
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
  }
}

function fail(message) {
  console.error(`\n[publish] 中止：${message}`)
  process.exit(1)
}

if (target === undefined) {
  console.error('用法: node scripts/publish.mjs <包名> [--publish]')
  process.exit(1)
}

const candidates = [
  resolve(REPO_ROOT, target),
  resolve(REPO_ROOT, 'packages', target),
]
const packageDir = candidates.find((dir) => existsSync(join(dir, 'package.json')))
if (packageDir === undefined) fail(`找不到包目录：${target}`)

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const { name, version, private: isPrivate } = manifest
console.log(`[publish] 目标：${name}@${version}`)
console.log(`[publish] 目录：${packageDir}`)

// ---- 1. 发布元数据 ----
if (isPrivate === true) fail('package.json 里 private: true，不能发布')
if (typeof name !== 'string' || typeof version !== 'string') fail('package.json 缺 name 或 version')
if (typeof manifest.description !== 'string') fail('package.json 缺 description（npm 页面会空白）')
if (typeof manifest.license !== 'string') fail('package.json 缺 license')

const recommended = ['author', 'repository', 'keywords']
const missing = recommended.filter((key) => manifest[key] === undefined)
if (missing.length > 0) {
  console.warn(`[publish] 提醒：建议补上 ${missing.join(' / ')}`)
  console.warn('          repository 会出现在 npm 页面，也是社区索引核对来源的凭据')
}

const scoped = name.startsWith('@')
if (scoped && manifest.publishConfig?.access !== 'public') {
  console.warn('[publish] 提醒：scoped 包需要 public 访问权限，本次会用 --access public')
  console.warn('          （想省掉这个参数就在 package.json 加 "publishConfig": { "access": "public" }）')
}

// ---- 2. 登录状态 ----
const whoami = run('npm', ['whoami'])
if (!whoami.ok) {
  fail(
    '还没有登录 npm。先执行 `npm login`，再确认 `npm whoami` 能打印出用户名。\n'
    + `        npm 的返回：${whoami.stderr || whoami.stdout}`,
  )
}
console.log(`[publish] npm 账号：${whoami.stdout}`)

// ---- 3. 版本是否已被占用 ----
const existing = run('npm', ['view', `${name}@${version}`, 'version'])
if (existing.ok && existing.stdout.includes(version)) {
  fail(
    `npm 上已存在 ${name}@${version}，同一版本号不能重复发布。\n`
    + '        改 package.json 的 version（遵循 semver）后再试。',
  )
}
const latest = run('npm', ['view', name, 'version'])
console.log(
  latest.ok
    ? `[publish] npm 上现有最新版：${latest.stdout}（本次要发 ${version}）`
    : '[publish] npm 上还没有这个包，这是首次发布',
)

// ---- 4. 门禁 ----
const isWorkspaceRoot = existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))
const gateCommand = isWorkspaceRoot ? 'pnpm' : null
console.log('\n[publish] 跑门禁 ...')
if (isWorkspaceRoot) {
  const gate = run('pnpm', ['gate'])
  if (!gate.ok) fail(`门禁未通过：\n${gate.stdout}\n${gate.stderr}`)
  console.log('[publish] 门禁通过（preset:check + build + typecheck + test）')
} else {
  for (const script of ['build', 'typecheck', 'test']) {
    const step = run('npm', ['run', script], { cwd: packageDir })
    if (!step.ok) fail(`npm run ${script} 失败：\n${step.stdout}\n${step.stderr}`)
    console.log(`[publish] npm run ${script} 通过`)
  }
}

// ---- 5. 干跑，看清 tarball ----
console.log('\n[publish] dry-run：即将发布的 tarball 内容')
const dryRun = run('npm', ['publish', '--dry-run', ...(scoped ? ['--access', 'public'] : [])], {
  cwd: packageDir,
})
if (!dryRun.ok) fail(`dry-run 失败：\n${dryRun.stdout}\n${dryRun.stderr}`)
for (const line of (dryRun.stdout + '\n' + dryRun.stderr).split('\n')) {
  if (/notice (Tarball Contents|Tarball Details|name:|version:|package size|unpacked size|total files)|notice \d|notice [\d.]+[km]?B /.test(line)) {
    console.log(`  ${line.replace(/^npm notice\s?/, '')}`)
  }
}

if (!doPublish) {
  console.log('\n[publish] 预检全部通过。确认上面的 tarball 无误后，加 --publish 真正发布：')
  console.log(`          node scripts/publish.mjs ${target} --publish`)
  process.exit(0)
}

// ---- 6. 真正发布 ----
console.log('\n[publish] 发布中 ...')
const publish = run('npm', ['publish', ...(scoped ? ['--access', 'public'] : [])], {
  cwd: packageDir,
})
if (!publish.ok) {
  fail(
    `发布失败：\n${publish.stdout}\n${publish.stderr}\n`
    + '        若启用了两步验证，需要加 --otp=<六位码>（本脚本不代传，请手动执行）。',
  )
}

// ---- 7. 验证 ----
const verify = run('npm', ['view', `${name}@${version}`, 'version'])
if (!verify.ok) fail('发布命令返回成功，但 npm 上查不到该版本，请手动确认')

console.log(`\n[publish] 完成：${name}@${version} 已发布`)
console.log('  用户安装：dsh plugin --profile web add ' + name)
console.log('  装完需要重启 dsh web')
console.log('  登记社区索引见 docs/publishing.md')
