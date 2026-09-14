# dsh-desktop-notify

在 DSH Desktop 里发 **macOS 原生系统通知**：回合跑完、被中断、需要你选择或需要你授权时，
屏幕右上角弹一条通知。

通知的发送身份是 **DSH Desktop 本身**（bundle id `io.dsh.desktop`），所以显示的是官方的
名字和图标，系统设置里也是 DSH Desktop 自己那条通知项。

**零外部依赖**：不需要 Homebrew，不需要 `terminal-notifier`，不需要预先安装任何东西。
原生投递层是本包自带的 55KB Node-API addon。

## 装完先做一件事

装上之后通知是**关着的**（默认不在你什么都没做的时候就开始打扰你）。去
**设置 → 桌面通知**把总开关打开，点一下「发送测试通知」确认链路通了。

那一页还会显示身份、系统授权、横幅与声音的真实读数 —— 这几项是排查"为什么不弹"的唯一
入口，见下面「为什么需要这个页面」。

## 能通知哪些状态

| 状态 | 触发信号 | 通知正文 |
| --- | --- | --- |
| 回合正常结束 | `turn/end` + `completed` | 会话标题 + 本轮回复摘要 |
| 回合被中断 | `turn/end` + `aborted` | 任务已中断 |
| 回合受阻 | `turn/end` + `blocked` | 任务被阻断 |
| 回合执行失败 | `turn/end` + `error` | 任务执行失败 + 错误信息 |
| 达到输出上限 | `turn/end` + `max-tokens` | 达到输出上限 |
| 等待你选择 | `tool/call` + `ask_user_question` | 等待你的选择 + 第一个问题 |
| 等待你授权 | `approval/asked` | 等待授权 + 工具名 |

每一类都能单独开关。另外还有两个内容开关：正文是否带回复摘要、是否播放提示音。

### 通知标题怎么来的

优先用事件流里攒到的 `session/title`。但**插件重载后事件流里是没有标题的**：`session/title`
是会话早期写的事件，harness 重启后整份日志变成构造种子，而 firehose 不回放构造种子。
所以标题为空时会去读官方的 `title` 会话投影（它从完整日志派生，含种子）把标题补回来。
投影也读不到就退回兜底的「DSH」—— 标题拿不到不该导致不发通知。

### 有意不支持的：崩溃导致的回合中断

`turn/end` 的 `interrupted` **接不了**。它不是运行期事件：会话恢复时崩溃修复会把它写进
**持久化句柄**和 **`SessionPreparation` 的构造种子**，而 `session/event` firehose 的契约
是 *constructor seeds do not emit*。要覆盖它只能另外去 tail 磁盘上的会话日志 —— 为这一个
状态多一条数据源不划算，所以不做。

## 给模型用的工具

本插件注册一个 `notify` 工具，模型可以主动发通知：

```
notify(title: "构建完成", body: "3 个包全部通过。")
```

## 为什么需要那个设置页（这条路最大的坑）

**`addNotificationRequest` 会骗人。** 在系统未授权时它照样回调成功：通知会进入通知中心，
但 `alertSetting` 与 `soundSetting` 是 0，**横幅不弹、声音不响**。

如果插件只回报"投递成功"，用户看到的现象就是「装了、不报错、就是不弹」，而且没有任何
线索。所以：

- addon 在**每次**投递之后都回报 `authorizationStatus` / `alertSetting` / `soundSetting`
  的真实读数；
- host 把这些读数写进设置；
- 设置页把它们摊开显示，并在横幅关闭时直接告诉你该去哪里打开。

「发送测试通知」按钮不是装饰，它是自证链路的手段。

## 它是怎么发出去的

通知的归属身份由**发送进程的可执行文件路径**决定：CoreFoundation 从
`…/X.app/Contents/MacOS/<exe>` 向上找到最近的 `Contents/Info.plist`。

所以投递固定走一条子进程：

```
ELECTRON_RUN_AS_NODE=1 <DSH Desktop 主二进制> -e <runner>
                         └─ require(notify.node) → UNUserNotificationCenter
                              └─ 身份 = io.dsh.desktop
```

三条来自实测的约束：

1. **不能在 harness 进程里直接调 addon。** 那个进程的可执行文件在
   `DSH Desktop Helper.app` 里，身份是 `io.dsh.desktop.helper`，通知会显示成
   「DSH Desktop Helper」。而且那个 bundle 嵌在 `Contents/Frameworks/` 里，
   拿通知授权会被直接拒绝（实测 `UNErrorDomain code=1`，连授权弹窗都不出现）。
2. **不能用系统 `node`。** 没有 bundle 身份时
   `+[UNUserNotificationCenter currentNotificationCenter]` 会抛
   `NSInternalInconsistencyException`，而且这个异常**穿透 `@try/@catch` 直接
   SIGABRT 打死整个进程**。addon 在碰 UN 框架之前先查 `bundleIdentifier`，
   没有身份就返回错误。
3. **主二进制路径是推出来的，不是写死的。** 从 `process.execPath` 上溯到外层 app 的
   `Contents`，再读 `Info.plist` 的 `CFBundleExecutable`。换安装位置或改名都不受影响；
   形状不符就返回 undefined 并给出可读原因，绝不猜。

子进程开销实测 70–100ms，每条通知起一个。

## 适用环境

| 环境 | 能否使用 |
| --- | --- |
| 官方 DSH Desktop（macOS） | 可以 |
| dsh-desktop-min 等自带真实 node 的壳 | 不可以（拿不到通知身份，插件会明确报告原因） |
| 浏览器里的 `dsh web` | 不可以（同上） |

设置页在后两种环境下会直接说明「当前部署无法投递系统通知」以及原因，而不是静默什么都不做。

## 安装

```sh
dsh plugin --profile web add @lixklv/dsh-desktop-notify
```

装完需要重启 DSH Desktop。卸载：

```sh
dsh plugin --profile web remove @lixklv/dsh-desktop-notify
```

## 开发

本包可以**单独拿出来构建**，不依赖仓库根：

```sh
pnpm install
pnpm build        # 原生 addon + lib/index.js + lib/client.js
pnpm typecheck
pnpm test
```

构建原生投递层只需要 Command Line Tools 里的 clang，不需要 Xcode、不需要 node-gyp、
不需要联网下载 node 头文件 —— Node-API 的四个头已经 vendor 在 `native/include/`。
产出是 universal 二进制（arm64 + x86_64）。

本地挂载到 GUI（会改动 profile，重启后生效）：

```sh
dsh plugin --profile web add link:"$PWD"
dsh --profile web --dump-config    # 确认出现 `# == dsh-desktop-notify`
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `native/notify.mm` | 唯一碰 macOS 原生 API 的地方（Node-API addon） |
| `native/include/` | vendor 的 Node-API 头文件，让包能脱离本机环境构建 |
| `scripts/build-native.mjs` | 用 clang 编译原生层，无需 node-gyp |
| `src/core/trigger.ts` | **事件 → 通知意图的纯状态机**，整个插件的判断中枢 |
| `src/core/summary.ts` | 从消息里取正文（只认 `text`，绝不带 `reasoning`） |
| `src/core/delivery.ts` | 路径推导与结果解析（纯逻辑） |
| `src/index.ts` | host 半区：后端探测、子进程投递、firehose 订阅、`notify` 工具 |
| `src/client/panel.tsx` | 设置页：开关、状态自证、测试通知 |
| `cordis.patch.yml` | bundle 清单，把插件行插进 profile 的 loader roster |

浏览器半区的 `require` 只能回答平台模块表里的 9 个模块，其余全部内联；
不在表里的 `@deepseek-ai/*` 值导入会被预设的纯度门判为构建失败。

## 许可

MIT
