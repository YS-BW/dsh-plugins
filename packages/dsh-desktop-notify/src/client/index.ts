/**
 * browser 半区：把「桌面通知」设置页挂进官方设置面板。
 *
 * 落点是官方声明的 `settings.section` slot（`kind: 'list'`、`scope: 'root'`）：注册时
 * 给 `id`（页键）、`order`（导航位置）、`label`（显示名），就在设置左侧导航里得到一个
 * 整页。这条契约是官方留给功能插件自己的席位，不依赖 DOM 结构、不需要改动官方页面。
 *
 * 本文件就是 lib/client.js 的模块体。构建产物是闭包工厂：
 *   window.__ModuleLoader__.load({ id: '@lixklv/dsh-desktop-notify', factory: (require) => { ...apply... } })
 * 所有代码都在 factory 被 materialize 时才执行，脚本解析阶段只完成注册。
 * 注册的 id 必须等于 package.json 的 name。
 *
 * @module @lixklv/dsh-desktop-notify/client
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  PLUGIN_ID,
  SETTINGS_NAMESPACE,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
} from '../core/namespace.ts'
import { DesktopNotifyPanel } from './panel.tsx'

/**
 * 插件级服务依赖。
 *
 * 只声明 `slots`：它在运行时的客户端服务目录里被确认存在，是注册 slot 的前提。
 * `remote.*` 一律不写进这里——名字解析不了会让 cordis 把插件永久停在等待态，
 * 表现是「装上了、不报错、就是没面板」；页面打开时远端必然已就绪，那时再惰性解析。
 */
export const inject = ['slots']

/** 本插件用到的 slots 服务面（服务不由本包声明，故用局部窄接口）。 */
interface SlotsService {
  inject(name: string, register: () => () => void): void
  register(
    options: { name: string; id?: string; order?: number; label?: string },
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
  // slot 注册需要真实页面；SSR / 非浏览器环境直接跳过。
  if (typeof document === 'undefined') return

  const slots = serviceOf(ctx, 'slots') as SlotsService | undefined
  if (slots === undefined) return

  // 用 inject 而不是直接 register：本插件的 bundle 可能先于设置面板装配完成，
  // 对尚未声明的 slot 直接注册会抛错，而 inject 会等到声明出现再注册。
  slots.inject(SETTINGS_SECTION_SLOT, () =>
    slots.register(
      {
        name: SETTINGS_SECTION_SLOT,
        id: SETTINGS_SECTION_ID,
        order: SETTINGS_SECTION_ORDER,
        label: '桌面通知',
      },
      () =>
        createElement(DesktopNotifyPanel, {
          getContext: () => ctx,
          namespace: SETTINGS_NAMESPACE,
        }),
    ),
  )
}

export { PLUGIN_ID }
