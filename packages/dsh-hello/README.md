# dsh-hello

DSH Web GUI 的示例插件：在界面右下角显示一个 `dsh-hello` 徽标。

这个包的作用是**验证插件管线端到端可用**，同时充当新插件的模板：

- host 半区（`src/index.ts`）空实现，只证明插件行能被 loader 加载
- browser 半区（`src/client/index.ts`）注入一个带 CSS Module 样式的浮动徽标
- `tests/` 覆盖 host 加载、徽标挂载、卸载回收三条路径

## 安装

```sh
dsh plugin --profile web add @lixklv/dsh-hello
```

装完需要重启 `dsh web`。卸载：

```sh
dsh plugin --profile web remove @lixklv/dsh-hello
```

## 开发

本包可以**单独拿出来构建**，不依赖仓库根：

```sh
pnpm install
pnpm build        # lib/index.js（host）+ lib/client.js（browser，闭包工厂）
pnpm typecheck
pnpm test
```

本地挂载到 GUI（会改动 profile，重启后生效）：

```sh
dsh plugin --profile web add link:"$PWD"
dsh --profile web --dump-config    # 确认出现 `# == dsh-hello`
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | bundle 清单，把插件行插进 profile 的 loader roster |
| `tsdown.config.ts` | 只声明「我是谁」和 host 入口，其余交给构建预设 |
| `build/tsdown.client.ts` | 由 `scripts/sync-preset.mjs` 生成的构建预设副本（禁止手改） |
| `src/index.ts` | host 半区，跑在 dsh host 进程 |
| `src/client/index.ts` | browser 半区，跑在 Web GUI |
| `src/client/badge.module.css` | 用官方 `--dsw-alias-*` 设计 token，明暗主题自动跟随 |
| `tsconfig.build.json` | 只出类型声明到 `lib/types` |

浏览器半区的 `require` 只能回答平台模块表里的 9 个模块，其余全部内联；
不在表里的 `@deepseek-ai/*` 值导入会被预设的纯度门判为构建失败。

## 许可

MIT
