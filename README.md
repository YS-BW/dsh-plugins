# dsh-plugins

个人 DSH Web GUI 插件仓库。每个 `packages/*` 都是一个**独立的官方 cordis bundle 插件**：可以单独复制出去构建、单独发 npm、单独登记进 dsh-web 的社区插件索引。

不修改 DSH 源码，只通过官方 profile 机制挂载。

## 目录结构

```text
.
├── shared/tsdown.client.ts        # 构建预设的唯一真源
├── packages/
│   └── dsh-hello/                 # 示例插件 + 新插件模板
│       ├── build/                 # 从 shared/ 同步来的预设副本（禁止手改）
│       └── ...
├── scripts/
│   ├── new-plugin.mjs             # 脚手架
│   └── sync-preset.mjs            # 预设同步 + drift 门禁
└── docs/publishing.md             # 发 npm 与登记社区索引的清单
```

## 独立性：每个包都不依赖这个文件夹

两条链路都是独立的：

| 链路 | 是否依赖仓库根 | 证据 |
| --- | --- | --- |
| **运行时**（用户安装） | 不依赖 | 发布的 tarball 只有 `cordis.patch.yml` + `lib/*` + `package.json`，约 7 kB；`lib/index.js` 与 `lib/client.js` 内部零外部 import |
| **构建时**（clone 单包开发） | 不依赖 | 每个包自带 `build/tsdown.client.ts` 与完整 devDependencies |

把 `packages/dsh-hello` 整个目录复制到任意位置，`pnpm install && pnpm build && pnpm test` 都能跑通。

唯一需要仓库根的是**共享预设的维护**：`shared/tsdown.client.ts` 是唯一真源，包内副本由脚本生成。改了共享预设，在仓库根运行：

```sh
pnpm preset:sync     # 刷新所有包内的副本
pnpm preset:check    # 校验副本没有漂移（已接进 pnpm test）
```

> 不要手改 `packages/*/build/tsdown.client.ts`。它带生成头注释，`pnpm test` 会拦下漂移。

## 插件形态

每个插件包固定三层：

| 路径 | 运行位置 | 说明 |
| --- | --- | --- |
| `src/index.ts` | dsh host 进程 | cordis 插件入口，`cordis.patch.yml` 的行指向它 |
| `src/client/` | Web GUI 浏览器 | 经 `dsh.client` 声明注入的浏览器半区 |
| `src/core/` | 两侧共享 | 纯逻辑，两个 program 都编译（可选） |

构建产物两个半区：

- `lib/index.js` — host 半区，ESM
- `lib/client.js` — browser 半区，闭包工厂产物：
  `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`
- `lib/types/` — 由 `tsc -p tsconfig.build.json` 出的类型声明

浏览器半区的 `require` **只能回答平台模块表里的 9 个词**：

```text
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

其余一切都在构建期内联。任何不在表里的 `@deepseek-ai/*` 值导入会被纯度门直接判为构建失败——因为那在运行时必然抛错。跨插件协作只能走 cordis 服务或 slot。

## 命令

仓库根：

```sh
pnpm install
pnpm preset:sync    # 共享预设改动后刷新包内副本
pnpm preset:check   # 校验副本漂移
pnpm new dsh-foo    # 从 dsh-hello 生成新插件
pnpm build          # 全仓构建
pnpm typecheck
pnpm test           # preset:check + 契约检查 + 全仓测试
pnpm gate           # 交付前完整门禁（8 道关，约 5 秒）
```

### 门禁在防什么

`pnpm gate` 是「能不能发布」和「发布后能不能用」的机器化契约。它跑 8 道关：

| 阶段 | 抓什么 |
| --- | --- |
| `preset:check` | 包内预设副本与 `shared/` 漂移 |
| `contract` | 发布契约：包名、scope、semver、`files`、`exports`、`dsh.*` 声明 |
| `contract:selftest` | **门禁本身是否还有效**（19 个失败模式用例） |
| `build` | 构建，含客户端 bundle 纯度门 |
| `contract:dist` | 构建产物 + **真实 tarball 内容** |
| `verify:mount` | 装进临时 profile，让 DSH loader 真的解析一遍 |
| `typecheck` / `-r test` | 类型与单测 |

最危险的一类问题是**装得上、不报错、就是没反应**，根源是四处标识不一致：

| 位置 | 值 |
| --- | --- |
| `package.json` → `name` | 完整包名 `@lixklv/dsh-xxx` |
| `cordis.patch.yml` → `name` | 完整包名（逐字符一致） |
| `tsdown.config.ts` → `clientBundle(id)` | 完整包名（逐字符一致） |
| `cordis.patch.yml` → `id` | 短名 `dsh-xxx`（全仓库唯一） |

`clientBundle` 的 id 是客户端模块表的注册键：不一致的话构建照样成功、包照样能装，
但浏览器半区**静默不注册**，界面毫无变化。`pnpm gate` 会拦住它。

可以单独跑：

```sh
node scripts/check-plugin.mjs              # 静态契约
node scripts/check-plugin.mjs --dist       # 加构建产物与 tarball 检查
node scripts/test-checks.mjs               # 自测门禁
node scripts/verify-mount.mjs dsh-foo      # 真实挂载验证
```

单个包（在包目录里，等于脱离仓库也能用）：

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

## 本地验证（装进 dsh web）

```sh
cd packages/dsh-hello
dsh plugin --profile web add link:"$PWD"
dsh --profile web --dump-config      # 确认出现 `# == dsh-hello`
```

然后**重启 `dsh web`**，页面右下角会出现 `dsh-hello` 徽标。卸载：

```sh
dsh plugin --profile web remove dsh-hello
```

> 改 bundle 行或 `cordis.patch.yml` 后必须重启 DSH 服务才生效；只改浏览器半区源码时重新 `pnpm build` 后刷新页面即可。
>
> 只想验证挂载、不想动自己的 profile 时，用临时 profile：
> `dsh plugin --profile scratch add "link:$PWD"` → `dsh --profile scratch --dump-config` → 用完 `rm -rf ~/.dsh/profiles/scratch`。

## 新增一个插件

```sh
pnpm new dsh-foo        # 等价于 node scripts/new-plugin.mjs dsh-foo
```

生成 `@lixklv/dsh-foo`。npm scope 与模板包写在仓库根 `package.json`：

```json
{ "dshPlugins": { "scope": "@lixklv", "template": "dsh-hello" } }
```

脚本会把这些地方一次改对（**规则：`name` 与 `clientBundle` 用完整包名，`id` 与 `PLUGIN_ID` 用短名**）：

1. `package.json` 的 `name` → `@lixklv/dsh-foo`
2. `cordis.patch.yml` 的 `name` → `@lixklv/dsh-foo`
3. `tsdown.config.ts` 里 `clientBundle('@lixklv/dsh-foo', ...)`
4. `cordis.patch.yml` 的 `id` → `dsh-foo`（loader 内部键，短名即可）

`clientBundle` 的 id 必须等于包名：它是客户端模块表的注册键（host 侧
`reconcilePackage(packageName)`），也是 loader 回收样式标签的归属。同理，
同一个包名被两个 loader 行解析会直接报
`package X resolves from multiple active Loader sources`。

## 设计约束（沿用 dsh-web 生态的硬规则）

- **只基于官方 NPM SDK**：类型来自 `devDependencies` 里的 `@deepseek-ai/*`；tsconfig 不得 `paths` / `references` 指向任何 DSH 源码 checkout。
- **客户端 bundle 纯度**：见上文模块表。type-only 导入会被擦除，不受影响。
- **CSS Modules**：`*.module.css` 走 lightningcss 编译并自动注入 `<style data-plugin>`；不要引 UI 框架样式库。
- **设计 token**：用 `--dsw-alias-*` 真实 token（`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-border-l1..l4`、`--dsw-alias-label-primary/secondary/caption` 等），明暗主题自动跟随。
- **语义属性**：插件根容器打 `data-dsh-plugin="<短名>"`，部件打裸值 `data-dsh-part`。皮肤是纯 CSS 换肤，靠这些属性锚定。
- **必须回收资源**：DOM、定时器、监听器都放进 `ctx.effect` 返回的 disposer，否则停用插件后会残留。
- **无 emoji**：代码、注释、文档、提交信息一律不用。

## 发布与登记

见 [docs/publishing.md](docs/publishing.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
