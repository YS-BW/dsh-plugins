#!/usr/bin/env node
/**
 * 真实挂载验证：把插件装进一个**临时 profile**，用 dsh 自己的 loader 解析一遍，
 * 确认 bundle patch 能被正确应用、插件行能挂上。这是「发布了用不了」的最终防线——
 * 静态检查看的是文件内容，这里看的是 DSH 实际怎么理解这些文件。
 *
 *   node scripts/verify-mount.mjs              # 验证全部 packages/*
 *   node scripts/verify-mount.mjs dsh-hello    # 只验证指定包
 *
 * 运行时纪律（见 AGENTS.md）：只动临时 profile，绝不碰用户的 web profile；
 * 不重启、不抢占任何正在运行的 DSH 服务。dump-config 只是打印配置，不起服务。
 *
 * 机器上没有 dsh 时跳过（退出码 0 并明确提示），这样 CI 上不会误报失败。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const SCRATCH_PROFILE = 'dsh-mount-verify'

const targets = process.argv.slice(2).filter((value) => !value.startsWith('--'))

function whichDsh() {
  const result = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

const dsh = whichDsh()
if (dsh === null) {
  console.log('[verify-mount] SKIP：PATH 里没有 dsh，跳过真实挂载验证')
  process.exit(0)
}

function listPackages() {
  return readdirSync(PACKAGES_DIR)
    .map((entry) => join(PACKAGES_DIR, entry))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .sort()
}

const packageDirs = targets.length === 0
  ? listPackages()
  : targets.map((name) => {
    const dir = join(PACKAGES_DIR, name)
    if (!existsSync(join(dir, 'package.json'))) {
      console.error(`[verify-mount] 找不到包：${name}`)
      process.exit(1)
    }
    return dir
  })

if (packageDirs.length === 0) {
  console.error('[verify-mount] packages/ 下没有包')
  process.exit(1)
}

const profileDir = join(process.env.HOME ?? '', '.dsh', 'profiles', SCRATCH_PROFILE)
const failures = []

function run(args) {
  return spawnSync(dsh, args, { encoding: 'utf8', env: process.env })
}

try {
  rmSync(profileDir, { recursive: true, force: true })

  for (const dir of packageDirs) {
    const label = relative(REPO_ROOT, dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const add = run(['plugin', '--profile', SCRATCH_PROFILE, 'add', `link:${dir}`])
    if (add.status !== 0) {
      failures.push({ label, message: `dsh plugin add 失败：\n${(add.stderr || add.stdout || '').trim()}` })
      continue
    }

    const dump = run(['--profile', SCRATCH_PROFILE, '--dump-config'])
    if (dump.status !== 0) {
      failures.push({ label, message: `dsh --dump-config 失败：\n${(dump.stderr || dump.stdout || '').trim()}` })
      continue
    }

    const output = `${dump.stdout ?? ''}${dump.stderr ?? ''}`
    const marker = `# == ${manifest.name}`
    if (!output.includes(marker)) {
      failures.push({
        label,
        message: `dump-config 里没有 "${marker}"，说明 bundle patch 没被应用`
          + '（cordis.patch.yml 的路径或结构有问题）',
      })
      continue
    }

    // marker 之后的第一个 name: 行必须就是本包
    const after = output.slice(output.indexOf(marker))
    const nameLine = /^\s*name:\s*'?([^'\n]+)'?\s*$/m.exec(after)
    if (nameLine === null || nameLine[1] !== manifest.name) {
      failures.push({
        label,
        message: `挂载行的 name 是 ${nameLine === null ? '(缺失)' : `"${nameLine[1]}"`}，`
          + `与包名 "${manifest.name}" 不一致`,
      })
      continue
    }

    console.log(`  PASS  ${label}  ->  ${marker}`)
  }
} finally {
  // 无论成败都要清掉临时 profile，绝不留下痕迹
  rmSync(profileDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const item of failures) {
    console.error(`  FAIL  ${item.label}\n         ${item.message}`)
  }
  console.error(`\n[verify-mount] 失败：${failures.length} 个包无法正确挂载`)
  process.exit(1)
}
console.log(`[verify-mount] OK：${packageDirs.length} 个包都能被 DSH loader 正确挂载`)
