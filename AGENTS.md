# 仓库规则（给 agent 会话）

个人 DSH Web GUI 插件仓库。本文件是该仓库的约定入口。

## 布局

- `shared/tsdown.client.ts`：构建预设的**唯一真源**。
- `packages/<name>/build/tsdown.client.ts`：由 `scripts/sync-preset.mjs` 生成的
  包内副本（带生成头注释）。**禁止手改**；改共享源后在仓库根跑 `pnpm preset:sync`。
  存在意义：每个包必须能被单独复制出去构建，不依赖仓库根。
- `packages/<name>/`：一个独立发布的插件包。包名即插件 id。
- `docs/publishing.md`：发布 npm 与登记进 dsh-web 社区索引的清单。

## 交付定义（Definition of Done）

**任何插件改动，交付前必须让下面这条命令全绿，并把输出贴进交付报告：**

```sh
pnpm gate
```

它按顺序跑 8 道关（全绿约 5 秒）：

| 阶段 | 脚本 | 抓什么 |
| --- | --- | --- |
| `preset:check` | `sync-preset.mjs --check` | 包内预设副本与 `shared/` 漂移 |
| `contract` | `check-plugin.mjs` | 发布契约（静态） |
| `contract:selftest` | `test-checks.mjs` | 确认门禁本身没失效（19 个失败模式用例） |
| `build` | tsdown + tsc | 构建，含客户端 bundle 纯度门 |
| `contract:dist` | `check-plugin.mjs --dist` | 构建产物 + **真实 tarball 内容** |
| `verify:mount` | `verify-mount.mjs` | 装进临时 profile，让 DSH loader 真的解析一遍 |
| `typecheck` | `tsc --noEmit` | 类型 |
| `-r test` | vitest | 单测 |

### 必须避免的两类失败

**A. 发布不了** —— 门禁会挡住这些成因：
包名非法 / scope 与根配置不符 / version 非 semver / `private: true` /
缺 `dsh.engines.dsh` / `files` 漏了 `lib` 或 patch 文件 / 缺 README 或 author・repository・keywords。

**B. 发布了用不了** —— 这类最危险，因为**装得上、不报错、就是没反应**。门禁会挡住：

- `clientBundle(id)` 与 `package.json` 的 `name` 不一致 → 客户端模块表注册不上，浏览器半区静默不执行
- `cordis.patch.yml` 的 `name` 与包名不一致 → loader 解析不到，插件行挂不起来
- `files` 漏 `cordis.patch.yml` 或 `lib/client.js` → 用户装上缺文件
- `exports` 指向 tarball 里不存在的文件
- 构建产物里注册的 id 不对、泄漏本机绝对路径、引入平台模块表之外的 `@deepseek-ai/*`

**下面四处必须一致，改一处就要四处一起改**（`pnpm new` 会自动做对）：

| 位置 | 值 |
| --- | --- |
| `package.json` → `name` | 完整包名 `@lixklv/dsh-xxx` |
| `cordis.patch.yml` → `name` | 完整包名（逐字符一致） |
| `tsdown.config.ts` → `clientBundle(id)` | 完整包名（逐字符一致） |
| `cordis.patch.yml` → `id` | 短名 `dsh-xxx`（loader 内部键，必须全仓库唯一） |

### 不要做

- **不要发预发布版本而不带 dist-tag**：必须 `--tag=next`。别把 CI 快照往 npm 上堆——
  packument 有 100 MB 上限，触顶后所有新版本都发不出去，且超过 72 小时的版本无法自行删除。
- **不要在包里引用仓库根**（`../../shared/...`）：每个包必须能单独复制出去构建。
- **不要动用户的 `web` profile**：验证挂载一律用 `pnpm verify:mount`（自己建临时 profile 并在 finally 里清理）。
- **不要代跑 `npm publish`**：npm 的 2FA 握手要求 TTY 并要求本人按 Touch ID，必须由人在自己终端执行。
- **不要手改 `build/tsdown.client.ts`**：改 `shared/tsdown.client.ts` 后跑 `pnpm preset:sync`。

## 硬约束

1. **只基于官方 NPM SDK**：类型来自 `devDependencies` 里的 `@deepseek-ai/*`。
   tsconfig 禁止 `extends` / `paths` / `references` 指向任何 DSH 源码 checkout。
2. **客户端 bundle 纯度**：浏览器半区的 `require` 只能回答 9 个平台模块
   （`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
   `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
   `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
   `@deepseek-ai/dsh-client-ui-dockkit`）。其余 `@deepseek-ai/*` 值导入会被
   预设的纯度门判为构建失败。跨插件协作走 cordis 服务或 slot。
3. **`clientBundle(id, ...)` 的 id 必须等于 package.json 的 name**（完整包名，含 scope）：
   它是客户端模块表的注册键（host 侧 `reconcilePackage(packageName)`，同名两个
   loader 行会报 `resolves from multiple active Loader sources`），也是样式标签归属。
   而 `cordis.patch.yml` 的 `id` 只是 loader 内部键，用短名即可。
4. **npm scope 单一真源**是仓库根 `package.json` 的 `dshPlugins.scope`（当前 `@lixklv`）。
   `scripts/new-plugin.mjs` 从这里读取，不要各包硬编码不同的 scope。
5. **包内不得出现指向仓库根的引用**（`../../shared/...` 之类）。每个包必须能
   被单独复制出去 `pnpm install && pnpm build && pnpm test`。
   `tsdown` / `lightningcss` / `typescript` 等构建依赖一律声明在**包自己**的
   `devDependencies` 里，不要只放在根 package.json。
6. **资源必须可回收**：DOM、定时器、监听器都放进 `ctx.effect` 返回的 disposer。
7. **无 emoji**：代码、注释、文档、提交信息一律不用。
8. **提交信息** `type(scope): subject`，type 用 `feat` / `fix` / `chore` /
   `docs` / `test` / `refactor` / `perf`。

## 运行时纪律

- 会话运行期间**不得**中断或重启正在运行的 DSH 服务：禁止 `kill` / `pkill` /
  `SIGTERM`，禁止抢占其端口另起替代实例。
- 改动需要重启才生效时（bundle 行、`cordis.patch.yml`），**不要自行重启**；
  在交付报告里标注「需要用户重启 DSH 服务后生效」。
- 验证插件挂载用**临时 profile**，不要动用户的 `web` profile。
  直接跑现成的脚本即可，它会自建 `dsh-mount-verify` profile 并在 `finally` 里清理：
  ```sh
  pnpm verify:mount              # 全部包
  node scripts/verify-mount.mjs dsh-foo   # 单个包
  ```
  需要手工排查时，务必用独立 profile 名并在结束前删掉 `~/.dsh/profiles/<scratch>`。

## 每个包的必备面

```text
package.json            dsh.engines.dsh / dsh.bundle.patch / dsh.client / exports / files / prepack
cordis.patch.yml        - insert: [{ id: <短名>, name: '<完整包名>' }]
build/tsdown.client.ts  由 sync-preset 生成的预设副本
tsconfig.json           自包含
tsconfig.build.json     只出类型声明（不要用 tsdown 的 dts，它会内联整个 SDK 类型面）
tsdown.config.ts        clientBundle('<完整包名>', ['src/index.ts'])
src/index.ts            host 半区
src/client/index.ts     browser 半区
tests/                  至少一条 host 与一条 client 用例
README.md               包级说明（files 里声明了它）
```

## 命令

```sh
pnpm install

# 门禁（交付前必须全绿）
pnpm gate              # 8 道关全跑，约 5 秒
pnpm contract          # 只跑发布契约静态检查
pnpm contract:dist     # 只跑构建产物 + tarball 检查（需先 build）
pnpm contract:selftest # 自测门禁本身是否仍能拦住 19 个失败模式
pnpm verify:mount      # 真实挂载验证（自建临时 profile 并清理）

# 工具
pnpm preset:sync       # 共享预设改动后刷新包内副本
pnpm preset:check      # 校验副本漂移（已接进 pnpm test 与 gate）
pnpm new <name>        # 从模板生成新插件，自动套用 scope
pnpm publish:check <name>  # npm 发布预检 + dry-run，不会发布
```

单独验证某个包时，这些脚本都接受包名参数：

```sh
node scripts/check-plugin.mjs --dist dsh-foo
node scripts/verify-mount.mjs dsh-foo
```

## 与 dsh-web 仓库的关系

- 新增**插件包**不能直接 PR 进 dsh-web（会被 `reject-non-content-pr.yml` 关闭）。
  正规路径是：本仓库开发 → 发 npm → 往
  `packages/dsh-community-plugins/community.json` 追加一条 → PR（base 为 `dev`）。
- 只有**皮肤 / 宠物 / 预设**属于可直达 PR 的内容贡献，且必须落在 dsh-web 仓库内
  （皮肤是纯资产目录，不是代码）。详见 `docs/publishing.md`。
