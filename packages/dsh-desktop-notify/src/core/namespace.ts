/**
 * 两个半区共用的标识。
 *
 * 命名空间字符串在 host（注册 settings 命名空间）与 browser（读写同一个命名空间）
 * 两侧必须逐字符一致，所以只留这一个真源，不做两份硬编码。
 *
 * @module @lixklv/dsh-desktop-notify/core/namespace
 */

/** 插件短标识，与 cordis.patch.yml 的 id 一致。 */
export const PLUGIN_ID = 'dsh-desktop-notify'

/** 本插件设置所在的命名空间（必须是小写连字符标识符，这是设置服务的硬要求）。 */
export const SETTINGS_NAMESPACE = 'dsh-desktop-notify'

/** 官方设置面板里的整页席位。 */
export const SETTINGS_SECTION_SLOT = 'settings.section'

/** 本页在设置导航里的键。 */
export const SETTINGS_SECTION_ID = 'desktop-notify'

/** 本页在设置导航里的位置（排在定时任务之后）。 */
export const SETTINGS_SECTION_ORDER = 70

/** 注册给模型的工具名。 */
export const NOTIFY_TOOL_NAME = 'notify'
