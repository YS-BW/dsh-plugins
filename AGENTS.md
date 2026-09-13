# 仓库规则（给 agent 会话）

个人 DSH Web GUI 插件仓库。本文件是该仓库的约定入口。

## 布局

- `shared/tsdown.client.ts`：构建预设的**唯一真源**。
- `packages/<name>/build/tsdown.client.ts`：由 `scripts/sync-preset.mjs` 生成的
  包内副本（带生成头注释）。**禁止手改**；改共享源后在仓库根跑 `pnpm preset:sync`。
  存在意义：每个包必须能被单独复制出去构建，不依赖仓库根。
- `packages/<name>/`：一个独立发布的插件包。包名即插件 id。
- `docs/publishing.md`：发布 npm 与登记进 dsh-web 社区索引的清单。

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
- 验证插件挂载用**临时 profile**，不要动用户的 `web` profile：
  ```sh
  dsh plugin --profile <scratch> add "link:$PWD/packages/<name>"
  dsh --profile <scratch> --dump-config | grep -A3 "<name>"
  dsh plugin --profile <scratch> remove <name> && rm -rf ~/.dsh/profiles/<scratch>
  ```

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
pnpm preset:sync   # 共享预设改动后刷新包内副本
pnpm preset:check  # 校验副本漂移（已接进 pnpm test）
pnpm new <name>    # 从 dsh-hello 生成新插件
pnpm gate          # 发布前完整门禁：preset:check + build + typecheck + test
```

## 与 dsh-web 仓库的关系

- 新增**插件包**不能直接 PR 进 dsh-web（会被 `reject-non-content-pr.yml` 关闭）。
  正规路径是：本仓库开发 → 发 npm → 往
  `packages/dsh-community-plugins/community.json` 追加一条 → PR（base 为 `dev`）。
- 只有**皮肤 / 宠物 / 预设**属于可直达 PR 的内容贡献，且必须落在 dsh-web 仓库内
  （皮肤是纯资产目录，不是代码）。详见 `docs/publishing.md`。
