/**
 * 构建原生投递层 `lib/notify.node`。
 *
 * 只依赖 Command Line Tools 里的 clang，不需要 Xcode、不需要 node-gyp、不需要
 * 联网下载 node 头文件 —— Node-API 的四个头已经 vendor 在 `native/include/`。
 *
 * 产出 universal 二进制（arm64 + x86_64）：Node-API 是 ABI 稳定的，同一份 .node
 * 在 Node 与 Electron 里都能加载，两个架构合体能同时覆盖 Apple Silicon 与 Intel。
 * 任一架构编不过就退回本机架构并告警，而不是整个构建失败。
 *
 * ## 为什么这一步必须在 tsdown 之后跑
 *
 * host 的 tsdown 配置带 `clean: true`，它会把整个 `lib/` 清空再写 `index.js`。
 * 先编原生层再跑 tsdown，`notify.node` 会被静默删掉 —— 结果是包能装、能加载、
 * 但每次通知都报「缺少原生投递层」，而仓库门禁只检查 `lib/index.js` 与
 * `lib/client.js`，抓不到这种情况。所以顺序固定，并在最后自证产物齐全。
 *
 * @module @lixklv/dsh-desktop-notify/scripts/build-native
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录。 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 源文件。 */
const source = join(root, 'native', 'notify.mm')

/** 产出位置（与 lib/index.js 同级，随 files 的 "lib" 一起进 tarball）。 */
const output = join(root, 'lib', 'notify.node')

/** 编译参数。`-undefined dynamic_lookup` 让 Node 的符号在加载时解析，无需链接 node。 */
const baseFlags = [
  '-bundle',
  '-undefined',
  'dynamic_lookup',
  '-fobjc-arc',
  '-Os',
  '-framework',
  'Foundation',
  '-framework',
  'UserNotifications',
  `-I${join(root, 'native', 'include')}`,
]

/**
 * 调一次 clang。
 * @param args - 除固定参数外的额外参数。
 */
function compile(args) {
  execFileSync('clang++', [...baseFlags, ...args, '-o', output, source], { stdio: 'pipe' })
}

/**
 * 自证：本包运行时需要的三个产物必须都在。
 *
 * 最后一道闸。上面那个"被 tsdown 清掉"的坑就是这一步存在的理由 —— 它不会让构建
 * 失败，只会让插件在用户机器上安静地不工作。
 */
function verify() {
  const required = [output, join(root, 'lib', 'index.js'), join(root, 'lib', 'client.js')]
  const missing = required.filter((path) => !existsSync(path) || statSync(path).size === 0)
  if (missing.length > 0) {
    throw new Error(
      `构建产物不齐：${missing.map((path) => path.slice(root.length + 1)).join(', ')}。`
        + ' 本包必须能独立复制出去 `pnpm install && pnpm build` 并产出全部运行时文件。',
    )
  }
}

/** 主流程。 */
function main() {
  if (process.platform !== 'darwin') {
    // 本插件只服务 macOS 通知。非 darwin 上跳过原生构建，让包仍能被安装与检查。
    console.warn('[build-native] 非 macOS，跳过原生投递层构建（本插件只在 macOS 上有投递能力）。')
    return
  }
  if (!existsSync(source)) {
    throw new Error(`找不到原生源码：${source}`)
  }

  mkdirSync(dirname(output), { recursive: true })
  rmSync(output, { force: true })

  try {
    compile(['-arch', 'arm64', '-arch', 'x86_64'])
    console.log('[build-native] 已构建 universal lib/notify.node (arm64 + x86_64)')
    verify()
    return
  } catch (error) {
    if (error instanceof Error && error.message.includes('构建产物不齐')) throw error
    console.warn(`[build-native] universal 构建失败，退回本机架构：${error.message}`)
  }

  try {
    compile([])
    console.log(`[build-native] 已构建 lib/notify.node (${process.arch})`)
  } catch (error) {
    throw new Error(
      '原生投递层构建失败。本插件需要 Command Line Tools 里的 clang：xcode-select --install\n'
        + `原始错误：${error.message}`,
    )
  }
  verify()
}

main()
