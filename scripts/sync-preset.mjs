#!/usr/bin/env node
/**
 * 把仓库根的 shared/tsdown.client.ts 同步成每个包内的 build/tsdown.client.ts 副本。
 *
 * 为什么要有这个脚本：
 * 插件包必须能被**单独复制出去构建**（不依赖仓库根这个「启动文件夹」）。
 * 但共享预设又不能真的复制成多份互不相干的源码——改一处 bug 要改 N 个包。
 * 所以：shared/ 是唯一真源，包内是生成副本（带生成头注释），
 * 这个脚本负责同步，`--check` 负责在 CI / 本地门禁里拦住手改导致的漂移。
 *
 *   node scripts/sync-preset.mjs           # 写入/刷新所有副本
 *   node scripts/sync-preset.mjs --check   # 只校验，漂移则退出码 1
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(REPO_ROOT, 'shared', 'tsdown.client.ts')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const TARGET_RELATIVE = join('build', 'tsdown.client.ts')

/** 生成副本的头部：明确「禁止手改」与改共享源后的补救命令。 */
const HEADER = [
  '// 本文件由 scripts/sync-preset.mjs 从 shared/tsdown.client.ts 生成，禁止手改。',
  '//',
  '// 存在意义：让本包能被单独复制出去构建，不依赖仓库根的 shared/ 目录。',
  '// 要改构建行为：先改 shared/tsdown.client.ts，再在仓库根运行 `pnpm preset:sync`。',
  '',
].join('\n')

const checkOnly = process.argv.includes('--check')

if (!existsSync(SOURCE)) {
  console.error(`[sync-preset] 找不到共享预设：${SOURCE}`)
  process.exit(1)
}

/** 需要同步的包：包目录里有 tsdown.config.ts 的。 */
const packages = readdirSync(PACKAGES_DIR).filter((entry) => {
  const dir = join(PACKAGES_DIR, entry)
  return statSync(dir).isDirectory() && existsSync(join(dir, 'tsdown.config.ts'))
})

if (packages.length === 0) {
  console.error('[sync-preset] packages/ 下没有任何含 tsdown.config.ts 的包')
  process.exit(1)
}

const expected = HEADER + readFileSync(SOURCE, 'utf8')
const drifted = []
let written = 0

for (const name of packages) {
  const target = join(PACKAGES_DIR, name, TARGET_RELATIVE)
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined

  if (current === expected) continue

  if (checkOnly) {
    drifted.push(`packages/${name}/${TARGET_RELATIVE}`)
    continue
  }

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, expected)
  written += 1
  console.log(`[sync-preset] 已${current === undefined ? '生成' : '刷新'} packages/${name}/${TARGET_RELATIVE}`)
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error('[sync-preset] 以下副本与 shared/tsdown.client.ts 不一致：')
    for (const file of drifted) console.error(`  ${file}`)
    console.error('[sync-preset] 运行 `pnpm preset:sync` 刷新；不要手改包内副本。')
    process.exit(1)
  }
  console.log(`[sync-preset] OK（${packages.length} 个包的副本与共享预设一致）`)
} else {
  console.log(
    written === 0
      ? `[sync-preset] 无需改动（${packages.length} 个包已是最新）`
      : `[sync-preset] 完成：更新 ${written} 个包`,
  )
}
