/**
 * browser 半区：跑在 dsh web GUI 里的 cordis 插件。
 *
 * 本文件就是 lib/client.js 的模块体。构建产物是闭包工厂：
 *   window.__ModuleLoader__.load({ id: '@lixklv/dsh-hello', factory: (require) => { ...apply... } })
 * 也就是说本文件里的所有代码（包括 CSS 注入）都在 factory 被 materialize 时才
 * 执行，脚本解析阶段只完成注册。注册的 id 必须等于 package.json 的 name。
 *
 * 三层结构约定（dsh-web 生态）：src/index.ts 是 host 半区，src/client/ 是浏览器
 * 半区，src/core/ 放两侧共享的纯逻辑。本插件只有前两者。
 */
import type { Context } from '@deepseek-ai/cordis'
import styles from './badge.module.css'

const PLUGIN_ID = 'dsh-hello'

/** 挂载 browser 半区。 */
export function apply(ctx: Context): void {
  // 构建期的 CSS 注入需要 document；SSR / 非浏览器环境直接跳过。
  if (typeof document === 'undefined') return

  // ctx.effect 的返回值（disposer）会在插件卸载时按注册逆序执行，
  // 用来回收自己加的 DOM 与监听器，避免热更新或停用插件后残留节点。
  ctx.effect(() => {
    const badge = document.createElement('div')
    // 语义属性约定：根容器打 data-dsh-plugin，部件打裸值 data-dsh-part。
    // 皮肤是纯 CSS 换肤，靠这些属性锚定插件部件。
    badge.dataset.dshPlugin = 'hello'
    badge.dataset.dshPart = 'badge'
    badge.className = styles.badge
    badge.textContent = PLUGIN_ID

    document.body.append(badge)
    return () => {
      badge.remove()
    }
  }, `${PLUGIN_ID}:badge`)
}
