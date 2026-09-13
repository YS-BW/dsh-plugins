/**
 * host 半区：跑在 dsh host 进程里的 cordis 插件。
 *
 * 纯 GUI 插件通常不需要 host 行为，这里保持空实现即可——但它是插件行的真实
 * 加载入口（cordis.patch.yml 里的 name 指向本包），所以不能删。
 *
 * 需要 host 能力时的常见形态：
 * - 向每个 agent 的系统提示注入一段能力公告：
 *     ctx.systemPrompt.section({ name: 'plugin:dsh-hello', order: 200, text: '...' })
 *   注意：dsh-web 生态要求这类公告必须提供开关，schema 默认 false，让用户按需开启。
 * - 注册设置命名空间：installSettingsSection(ctx, settingsNamespace('dsh-hello'), schema, ...)
 * - 注册模型可调用的工具：ctx.tools.define(...)
 */
import type { Context } from '@deepseek-ai/cordis'

/** 挂载 host 半区。 */
export function apply(_ctx: Context): void {
  // 本示例插件没有 host 侧行为。
}
