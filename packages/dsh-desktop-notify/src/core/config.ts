/**
 * 通知配置的形状与收敛。
 *
 * 读路径**不信任**存储值：设置文档是用户可以手改的 YAML，任何字段都可能缺失、
 * 类型错、或被改成乱七八糟的值。`coerceConfig` 是唯一的读取入口，保证 host 与
 * browser 两侧看到的是同一份收敛结果。
 *
 * @module @lixklv/dsh-desktop-notify/core/config
 */

/** 通知配置。 */
export interface NotifyConfig {
  /** 总开关。默认**关**：装上不等于同意被通知。 */
  enabled: boolean
  /** 回合正常结束时通知。 */
  onTurnEnd: boolean
  /** 回合异常结束（中断 / 失败 / 受阻 / 超长）时通知。 */
  onTurnFailed: boolean
  /** 等待人工选择时通知。 */
  onQuestion: boolean
  /** 等待授权时通知。 */
  onApproval: boolean
  /** 通知正文带回复摘要。关掉就是一条只有标题的短通知。 */
  includeSummary: boolean
  /** 播放提示音。 */
  sound: boolean
}

/**
 * 默认配置。
 *
 * 总开关默认 false 是刻意的：本插件会在**每一轮对话结束**时发系统通知，装上即
 * 生效意味着用户什么都没做就被打扰。按需开启。
 *
 * @returns 一份全新的默认配置。
 */
export function defaultConfig(): NotifyConfig {
  return {
    enabled: false,
    onTurnEnd: true,
    onTurnFailed: true,
    onQuestion: true,
    onApproval: true,
    includeSummary: true,
    sound: true,
  }
}

/** 逐字段收敛一个布尔值。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 把任意输入收敛成一份完整配置。
 * @param raw - 设置文档里的原始值（可能是 undefined、数组、字符串……）。
 * @returns 完整配置；缺失或类型错误的字段回落到默认值。
 */
export function coerceConfig(raw: unknown): NotifyConfig {
  const base = defaultConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const source = raw as Record<string, unknown>
  return {
    enabled: boolOf(source.enabled, base.enabled),
    onTurnEnd: boolOf(source.onTurnEnd, base.onTurnEnd),
    onTurnFailed: boolOf(source.onTurnFailed, base.onTurnFailed),
    onQuestion: boolOf(source.onQuestion, base.onQuestion),
    onApproval: boolOf(source.onApproval, base.onApproval),
    includeSummary: boolOf(source.includeSummary, base.includeSummary),
    sound: boolOf(source.sound, base.sound),
  }
}
