# @lixklv/dsh-model-vision

在 DSH Web GUI 的官方「设置 → 模型」页里，为每个模型直接配置**是否接受图片输入**。

引擎支持这个开关，官方设置页却没给入口；缺了它会以「不报错但用不了」的方式失败：
给纯文本线路贴图会被服务端以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝，而你在界面上
看不到任何可改的地方。

## 它做什么

在每个 provider 卡片下方加一个面板，按 provider 列出设置里已声明的模型，每个模型
一个三态开关：

| 选项 | 写入的设置值 | 含义 |
| --- | --- | --- |
| 默认 | 删除该字段 | 不声明，交给 schema 默认与模型目录继承 |
| 纯文本 | `["text"]` | 显式声明只接受文本 |
| 支持图片 | `["text","image"]` | 显式声明接受文本与图片，之后即可贴图 |

保存后**立即生效，无需重启**。

## 为什么是三态而不是勾选框

在 `llm-pi-ai` 里，「不声明」与「显式纯文本」是两回事。引擎的解析器把空数组读作
「这一层没有答案」，继续往上问：

```js
function declaredInput(configured) {
  return configured === void 0 || configured.length === 0 ? undefined : [...configured]
}
```

一个布尔勾选框会把「未声明」在用户第一次点击时静默固化成「显式纯文本」，从而**关掉**
本来能从模型目录继承到的图片能力。三态才能表达「我不管，按默认来」。

## 覆盖的 provider

| 命名空间 | 模态字段 |
| --- | --- |
| `llm-pi-ai` | `providers.<p>.models[].input` |
| `llm-deepseek` | `models[].inputModalities` |

字段名**逐命名空间不同**，写错会被 schema 直接拒绝：`inputModalities` 虽然也是两个
适配器投影出的运行时 `ModelInfo` 字段，但它只是 `llm-deepseek` 的**配置**键。

## 实现要点

- **落点是官方契约，不是 DOM 注入。** 面板注册进官方声明的
  `settings.models.provider-card` keyed slot（key 即该行的 `settingsNs`）。官方
  `slot-contract.d.ts` 的原话是「给仓库外分发的插件往 Models 设置区加 UI 的两个席位，
  无需修改它」，因此官方改版不会静默失效。
- **写路径只有官方 settings 服务。** 通过 `ctx.remote.settings` 的
  `describe()` + `mutate(ns, ops, expectedRevision)` 落盘，带 revision 冲突检测；
  冲突时重读并**重新规划** op（按模型 id 重定位），而不是重放旧 op。
- **`models` 一律整数组写回。** settings 的路径编辑会把数组这类非普通对象的中间节点
  当成缺失并重建为对象，`models.3.input` 会写出 `models: {"3": {...}}` 这种损坏结构。
  只有 `modelOverrides` 这种字典才按叶子写。
- **降级为纯文本时摘掉图片限额。** `llm-deepseek` 的解析器拒绝
  `text-only catalog model cannot declare image request limits`，所以关掉图片输入时
  必须一并删除 `imagePixelBudget` / `imageMaxBytes`。
- **宿主半区是空实现。** 插件行必须存在（宿主靠它发现 `dsh.client` 并把浏览器半区
  serve 出去），但配置完全走官方 settings 服务，宿主侧不持有任何状态。
- **客户端 bundle 无跨包依赖。** `remote` 是 cordis 服务，用 `ctx.get` 取即可，
  不需要 import `@deepseek-ai/dsh-api-remotes`，模块表纯度门天然满足。
- **`inject` 只声明 `slots`。** 设置远端改为惰性解析：`remote.settings` 没出现在运行时
  的客户端服务目录里，把它写成硬依赖的话，一旦服务名解析不了，cordis 会让插件永久停在
  等待态——正是「装上了、不报错、就是没面板」。远端拿不到时面板会给出明确文案。
- **事件订阅走根 remote。** `$on` 只挂在根 `remote` 上，嵌套 face 上调用会静默失效；
  由 apply 侧解析后经 `onEvent` 传入面板。

## 安装

```sh
dsh plugin --profile web add @lixklv/dsh-model-vision
```

本仓库内本地开发：

```sh
dsh plugin --profile web add link:"$PWD"
```

装完需要**重启 dsh web**（插件行在启动时解析）并强制刷新浏览器。

## 已知边界

- 写入被 DSH 拒绝时（例如非 loopback 来源），面板会显示官方返回的错误原文。
- 某个 provider 若同时声明了 `models` 与 `modelOverrides`，适配器会拒绝写入；
  面板会直接指出这一点而不是给出一个点了就报错的开关。
- 面板只列出设置文档里已声明的模型。纯目录路由需要先在官方设置页添加模型。
- 「默认」态下模型是否真能收图由引擎的模型目录决定——这个信息不在设置文档里，
  所以面板不冒充「生效值」，只如实标注解析层读到的模态。

## 开发

```sh
pnpm --filter @lixklv/dsh-model-vision test
pnpm --filter @lixklv/dsh-model-vision typecheck
pnpm gate            # 仓库根：8 道关全跑
```
