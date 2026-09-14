/**
 * 从会话事件里提取可展示的摘要文本。
 *
 * 这个模块存在的唯一理由是**不能泄漏思考过程**。本会话的真实统计：
 *
 *     assistant/message 的 content block 统计（100 条消息）
 *       reasoning  98
 *       text       61
 *       tool-call  127
 *
 * `reasoning` 与 `text` 是**并列的 block**，不是包含关系。任何"把内容块拼起来"
 * 的写法都会把模型的内部推理弹到用户屏幕上。只有 `type === 'text'` 才是对用户
 * 说过的话。
 *
 * 另一件要处理的事：98 条消息里只有 61 条有 text，**37 条是纯工具调用轮次**，
 * 根本没有可展示的正文。所以这里可能返回空串，调用方必须处理"本轮没有文字回复"
 * 这种情况，而不是拿一段空正文去发通知。
 *
 * @module @lixklv/dsh-desktop-notify/core/summary
 */

/** 摘要在通知里的最大长度（字符数，按 Unicode 码点计）。 */
export const SUMMARY_LIMIT = 40

/**
 * 取一条 assistant 消息里的正文文本。
 *
 * 只认 `type === 'text'` 的块；`reasoning` / `tool-call` / 其它未知类型一律跳过。
 * 多个 text 块按顺序拼接，去掉首尾空白。
 *
 * @param content - 消息的 content 字段（形状不可信，全部运行期收敛）。
 * @returns 正文文本；没有正文时返回空串。
 */
export function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text') continue
    if (typeof candidate.text !== 'string') continue
    parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/**
 * 把一段文本压成适合通知正文的一行。
 *
 * 换行折成空格、连续空白折叠、超长按码点截断并加省略号。用码点而不是 UTF-16
 * 下标切，避免把 emoji 或代理对切一半。
 *
 * @param text - 原始文本。
 * @param limit - 最大长度，默认 {@link SUMMARY_LIMIT}。
 * @returns 单行摘要。
 */
export function summarize(text: string, limit: number = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  if (points.length <= limit) return flat
  return `${points.slice(0, limit).join('')}…`
}
