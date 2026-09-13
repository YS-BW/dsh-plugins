/**
 * browser 半区：把「视觉输入」三态开关挂进官方「设置 → 模型」页。
 *
 * 落点是官方声明的 `settings.models.provider-card` keyed slot，key 是该 provider
 * 的 `settingsNs`。这是官方契约里唯一留给外部插件的 Models 页席位，因此不依赖
 * DOM 结构、不需要替换官方页，也不会在官方改版时静默失效。
 *
 * 本文件的全部代码（含 CSS 注入）都在模块工厂被 materialize 时才执行，脚本解析
 * 阶段只完成 `window.__ModuleLoader__.load` 注册；注册的 id 必须等于
 * package.json 的 name。
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { onRemoteEvent, settingsRemoteOf } from './api.ts'
import { type ProviderCardProps, VisionPanel } from './panel.tsx'

/** 与 cordis.patch.yml 的 id 一致的短标识。 */
const PLUGIN_ID = 'dsh-model-vision'

/** 官方 Models 页的 provider 卡片扩展位（keyed，key = provider 的 settingsNs）。 */
const PROVIDER_CARD_SLOT = 'settings.models.provider-card'

/**
 * 覆盖的 provider 命名空间。
 *
 * 两个适配器的模态字段**不同名**（llm-pi-ai 是 `input`，llm-deepseek 是
 * `inputModalities`），但 keyed slot 的 key 恰好就是 settingsNs，所以按命名空间
 * 各注册一次即可拿到对应的卡片，字段名由 core 层按命名空间决定。
 */
const NAMESPACES: readonly string[] = ['llm-pi-ai', 'llm-deepseek']

/**
 * 插件级服务依赖。
 *
 * 只声明 `slots`：它在运行时的客户端服务目录里被确认存在，是注册 slot 的前提。
 *
 * **不要**把 `remote.settings` 写成硬依赖。它没出现在客户端服务目录里（同样缺席的
 * 还有官方页自己在用的 `settingsScope`，所以不能据此断定它不存在），而一旦这个名字
 * 解析不了，cordis 会让插件永久停在等待态——正是「装上了、不报错、就是没面板」。
 * 远端因此改为惰性解析：面板挂载在用户打开「设置 → 模型」之后，那时远端必然已就绪；
 * 真拿不到也会在面板上给出明确文案，而不是无声消失。
 */
export const inject = ['slots']

/** 本插件用到的 slots 服务面（服务不由本包声明，故用局部窄接口）。 */
interface SlotsService {
  inject(name: string, register: () => () => void): void
  register(
    options: { name: string; key?: string; id?: string; order?: number },
    component: (props: unknown) => unknown,
  ): () => void
}

/** 从 cordis 容器里取服务。 */
function serviceOf(ctx: Context, name: string): unknown {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  return getter.call(ctx, name)
}

/**
 * 挂载 browser 半区。
 * @param ctx - 浏览器半区的 cordis 上下文。
 */
export function apply(ctx: Context): void {
  // CSS 注入与 slot 注册都需要真实页面；非浏览器环境直接跳过。
  if (typeof document === 'undefined') return

  const slots = serviceOf(ctx, 'slots') as SlotsService | undefined
  // slots 是已声明的硬依赖，正常不会缺席；真缺席就没法注册，只能退出。
  if (slots === undefined) return

  // 无条件注册：远端在面板渲染时惰性解析，缺了也不会让插件无声消失。
  for (const ns of NAMESPACES) {
    slots.inject(PROVIDER_CARD_SLOT, () =>
      slots.register({ name: PROVIDER_CARD_SLOT, key: ns }, (props) =>
        createElement(VisionPanel, {
          ...(props as ProviderCardProps),
          getRemote: () => settingsRemoteOf(ctx),
          // 事件面只挂在根 remote 上，所以在这里解析，不把容器塞进面板。
          onEvent: (event, listener) => onRemoteEvent(ctx, event, listener),
        }),
      ),
    )
  }
}

export { PLUGIN_ID }
