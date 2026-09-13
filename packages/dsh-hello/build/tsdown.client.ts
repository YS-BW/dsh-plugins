// 本文件由 scripts/sync-preset.mjs 从 shared/tsdown.client.ts 生成，禁止手改。
//
// 存在意义：让本包能被单独复制出去构建，不依赖仓库根的 shared/ 目录。
// 要改构建行为：先改 shared/tsdown.client.ts，再在仓库根运行 `pnpm preset:sync`。
/**
 * 本仓库唯一的 tsdown 构建预设：一个 DSH Web GUI 插件包同时要产出两个半区。
 *
 * - host 半区（src/index.ts → lib/index.js）：ESM，跑在 dsh host 进程，依赖留在
 *   import 上，由 npm 安装的 node_modules 解析。
 * - client 半区（src/client/index.ts → lib/client.js）：浏览器半区，必须打成
 *   「闭包工厂」产物。Web GUI 用 <script> 加载它，脚本执行时只做一件事：
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *   模块体（含 CSS 注入）全部包在 factory 闭包里，首次被 require 时才执行。
 *   工厂收到的 require 只能回答「平台模块表」里的词，其他任何东西都必须在
 *   构建期内联进来。
 *
 * 平台模块表来自装好的引擎实测（@deepseek-ai/dsh-web-frontend 的 shell bundle
 * 里 seeded staticModules），与 0.1.5-rc.1 cohort 一致。往表里加词没有任何
 * 构建期办法能生效：那是 dsh 自己的冻结表，所以这里只做只读镜像。
 *
 * 因此本预设做三件事：
 * 1. 客户端 external 严格等于平台表（+ 声明在 dsh.client.external 里的跨插件
 *    模块，host 会为它们组出图行）；
 * 2. 纯度门：任何不在表里的 @deepseek-ai/* 值导入直接构建失败——require 答不上
 *    来的模块就是运行时必崩，要在构建期拦下（type-only 导入会被擦除，不经过
 *    这道门）；
 * 3. CSS：*.module.css 经 lightningcss 编译成类名映射并自动注入
 *    <style data-plugin data-plugin-css>，普通 *.css 作为全局样式注入。
 *    注入动作发生在 factory 里，所以插件卸载时 loader 能按 data-plugin-css
 *    回收自己的样式标签。
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * 浏览器侧冻结模块表：shell 在建 cordis 之前就把这些注入为静态模块，
 * 客户端 bundle 里出现这些说明符时保留为 external，由工厂的 require 回答。
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/**
 * 允许内联的 wire/type 层：这些面没有需要跨插件共享的运行时身份
 * （没有 Symbol / instanceof / 单例状态），内联不会造成双实例问题。
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand|file-reference|util-workspace-path)(\/|$)/

/** 打包进产物的第三方库（必须内联，模块表里没有它们）。 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** 生成的 descriptor/codec 贡献面，同样没有共享运行时身份。 */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * CSS 虚拟 id。后缀必须是 .mjs 之类的非 .css 结尾：tsdown 自己的 css 管线
 * 按 .css 后缀匹配，撞上就会把模块 CSS 抢走。
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** NODE_ENV 替换值：浏览器产物里 process.env 是注入的普通对象，不是真 env。 */
const NODE_ENV = process.env.NODE_ENV ?? 'production'

/** 读当前构建包的 package.json。tsdown 在包目录下执行，cwd 即包根。 */
function readPackageManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8'))
}

function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 生成一段在 factory 内执行的样式注入代码：按 tagId 去重插入 <style>，
 * 并把类名映射作为默认导出交给 CSS Modules 的 import 侧。
 * @param id - 插件 id（包名），写到 data-plugin 上供 loader 回收。
 * @param tagId - 单张样式表的稳定标识，写到 data-plugin-css 上。
 * @param css - 编译并压缩后的 CSS 文本。
 * @param classMap - CSS Modules 的 local → hashed 映射；全局样式传 undefined。
 */
function styleInjectionModule(
  id: string,
  tagId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=\"' + tagId + '\"]') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** 构建期的包根：tsdown 在包目录下执行，cwd 即包根。 */
const PACKAGE_ROOT = process.cwd()

/**
 * 把 import 里的相对路径解析成「相对包根」的虚拟 id。
 * 不能直接用绝对路径：它会随 //#region 注释进入发布产物，泄漏构建机路径。
 * 包外文件（如仓库根的 shared/）保留绝对路径。
 */
function virtualFileId(source: string, importer: string | undefined): string {
  const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
  const relativePath = relative(PACKAGE_ROOT, absolute).split(sep).join('/')
  return relativePath.startsWith('../') ? absolute : relativePath
}

/** 把虚拟 id 还原成真实文件路径。 */
function physicalFileId(fileId: string): string {
  return isAbsolute(fileId) ? fileId : resolvePath(PACKAGE_ROOT, fileId)
}

/** 三个 CSS 通道：模块（带类名映射）、?inline 文本、全局样式。 */
function cssChannels(id: string) {
  return [
    {
      name: 'dsh-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        return CSS_VIRTUAL_PREFIX + virtualFileId(source, importer) + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const physical = physicalFileId(fileId)
        // 虚拟 id 会把真实文件藏出 watch 图，手动登记回来。
        this.addWatchFile(physical)
        const { code, exports: cssExports } = transform({
          filename: physical,
          code: await readFile(physical),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, entry] of Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
          classMap[local] = entry.name
        }
        return styleInjectionModule(id, `${id}/${basename(fileId)}`, code.toString(), classMap)
      },
    },
    {
      name: 'dsh-css-inline-text',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css?inline')) return null
        const stylesheet = source.slice(0, -'?inline'.length)
        return GLOBAL_CSS_VIRTUAL_PREFIX + `inline:${virtualFileId(stylesheet, importer)}` + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        const prefix = `${GLOBAL_CSS_VIRTUAL_PREFIX}inline:`
        if (!virtualId.startsWith(prefix)) return null
        const physical = physicalFileId(virtualId.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length))
        this.addWatchFile(physical)
        const { code } = transform({ filename: physical, code: await readFile(physical), minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    },
    {
      name: 'dsh-css-global',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        return GLOBAL_CSS_VIRTUAL_PREFIX + virtualFileId(source, importer) + CSS_VIRTUAL_SUFFIX
      },
      async load(this: { addWatchFile(file: string): void }, virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        if (fileId.startsWith('inline:')) return null
        const physical = physicalFileId(fileId)
        this.addWatchFile(physical)
        const { code } = transform({ filename: physical, code: await readFile(physical), minify: true })
        return styleInjectionModule(id, `${id}/${basename(fileId)}`, code.toString())
      },
    },
  ]
}

export interface ClientBundleOptions {
  /** browser 半区入口，默认 src/client/index.ts。 */
  clientEntry?: string
  /** 关掉客户端产物（纯 host 插件）。 */
  skipClient?: boolean
}

/**
 * 生成一个插件包的完整 tsdown 配置（host pass + client pass）。
 * @param id - 插件 id，必须等于 package.json 的 name：它是模块表的注册键，
 *   也是 loader 回收样式标签的归属，写错会挂载失败。
 * @param libEntry - host 半区入口，显式写出（如 ['src/index.ts']）。
 * @param options - 客户端入口覆盖与开关。
 */
export function clientBundle(
  id: string,
  libEntry: readonly string[],
  options: ClientBundleOptions = {},
): ReturnType<typeof defineConfig> {
  const manifest = readPackageManifest()

  // 平台表 + 该包在 dsh.client.external 里显式声明的跨插件模块。
  const declaredClient = (manifest.dsh as { client?: { external?: string[] } } | undefined)?.client
  const requested = new Set<string>([...PLATFORM_MODULES, ...(declaredClient?.external ?? [])])
  const isRequested = (specifier: string): boolean => requested.has(specifier)

  // host 半区的生产依赖留在 import 上；其余（含 devDependencies 里的 SDK）内联。
  const productionDeps = new Set([
    ...Object.keys((manifest.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((manifest.peerDependencies as Record<string, string>) ?? {}),
    ...Object.keys((manifest.optionalDependencies as Record<string, string>) ?? {}),
  ])
  const productionPatterns = [...productionDeps].map(
    (name) => new RegExp(`^${escapeSpecifier(name)}(/|$)`),
  )
  const isProductionDependency = (specifier: string): boolean =>
    productionPatterns.some((pattern) => pattern.test(specifier))

  const hostEntry: Record<string, string> = {}
  for (const entry of libEntry) hostEntry[basename(entry).replace(/\.tsx?$/, '')] = entry

  const host: UserConfig = {
    name: id,
    entry: hostEntry,
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // 类型由 tsc -p tsconfig.build.json 单独产出到 lib/types：tsdown 的 dts
    // 会把引用的 SDK 类型整体内联，产出几十 KB 的重复声明。
    dts: false,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  }

  if (options.skipClient === true) return defineConfig([host])

  const client: UserConfig = {
    name: `${id}/client`,
    entry: { client: options.clientEntry ?? 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // 显式给浏览器 target：不写的话 tsdown 会按 tsconfig 猜成 node 版本。
    target: 'es2022',
    fixedExtension: false,
    // browser 半区靠 bundle 自带的 sourcemap 调试；dts 会打破 banner 结构。
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // 模块表答不上来的 require 就是运行时必崩：表内的留 external，其余内联。
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // 内联进来的 node 习惯写法会读 process.env / import.meta.env，
    // 不替换的话工厂一执行就 ReferenceError。
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (isRequested(source)) return null
          if (VENDORED_LIBRARY.test(source)) return null
          if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
          throw new Error(
            `client bundle purity: "${source}" 既不在平台模块表里，也不是可内联的 wire 层。`
            + ' 跨插件取用只能走 cordis 服务或 slot；确需动态加载另一个插件的 bundle 时，'
            + `把包名写进 ${id} 的 dsh.client.external。`,
          )
        },
      },
      ...cssChannels(id),
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      // 闭包工厂交接：脚本执行只注册 factory，模块体在 materialize 时才跑。
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }

  return defineConfig([host, client])
}
