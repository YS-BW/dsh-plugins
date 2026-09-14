/**
 * 事件 → 通知意图的映射。**纯函数，没有任何 IO。**
 *
 * 这是整个插件的判断中枢，所以刻意做成可穷举测试的纯状态机：喂进状态与一条会话
 * 事件，吐出「要发哪些通知」和「新状态」。host 半区只负责把意图交给投递层。
 *
 * ## 能接 / 接不了
 *
 * 唯一**机制上接不了**的是 `turn/end` 的 `interrupted`：它由崩溃修复在会话恢复时
 * 写入持久化句柄与**构造种子**，而 firehose 的契约是 "constructor seeds do not
 * emit"（`dsh-session` 源码注释），所以它永远不会出现在 `session/event` 上。本模块
 * 因此不对它做任何映射——收到了也说明上游改了语义，那时再补。
 *
 * ## 三个真实数据里踩出来的约束
 *
 * 1. **只有 `type: 'text'` 是正文**。同一条消息里 `reasoning` 与 `text` 并列，
 *    拼错就把模型的思考过程弹到用户屏幕上。
 * 2. **纯工具调用轮次没有正文**（本会话 98 条有推理、只有 61 条有正文），所以用
 *    `turnHadText` 区分「本轮说了话」与「本轮只在调工具」，后者不能拿上一轮的摘要
 *    冒充。
 * 3. **`session/title` 发两次**：先一条 `source.kind === 'fallback'` 的截断首问，
 *    再一条 `provider` 的 LLM 标题。provider 必须赢，且 fallback 不能覆盖它。
 *
 * @module @lixklv/dsh-desktop-notify/core/trigger
 */
import type { NotifyConfig } from './config.ts'
import { assistantTextOf, summarize } from './summary.ts'

/** 可通知的状态种类。 */
export type TriggerKind =
  | 'turn-completed'
  | 'turn-aborted'
  | 'turn-blocked'
  | 'turn-error'
  | 'turn-max-tokens'
  | 'question-asked'
  | 'approval-asked'

/** 一条待投递的通知。 */
export interface NotifyIntent {
  /** 触发它的状态种类。 */
  kind: TriggerKind
  /** 通知标题（通常是会话标题）。 */
  title: string
  /** 通知正文。 */
  body: string
  /** 去重键：同一个键只通知一次，用来抵消重复或重放的事件。 */
  dedupeKey: string
}

/** 单个会话的通知状态。 */
export interface SessionState {
  /** 会话标题；provider 标题优先，没有才用 fallback 的截断首问。 */
  title: string
  /** 是否已拿到 provider 标题；拿到之后 fallback 不再覆盖。 */
  providerTitled: boolean
  /** 最近一条**有正文**的 assistant 消息（纯工具轮次不覆盖它）。 */
  summary: string
  /** 当前这一轮是否出现过正文；`turn/start` 时重置。 */
  turnHadText: boolean
  /** 已通知过的去重键，有界。 */
  notified: readonly string[]
}

/** 去重键的保留上限：超过就丢最旧的。 */
const NOTIFIED_CAP = 64

/** 没有标题时的回退标题。 */
const FALLBACK_TITLE = 'DSH'

/**
 * 新建一个会话状态。
 * @returns 空状态。
 */
export function initialSessionState(): SessionState {
  return { title: '', providerTitled: false, summary: '', turnHadText: false, notified: [] }
}

/** 把非字符串收敛成空串。 */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 从 `ask_user_question` 的参数 JSON 里取第一个问题。
 *
 * 工具参数是以**字符串**形式落盘的 JSON，且形状不可信：可能解析失败、可能没有
 * `questions`、问题可能是空数组。任何一种情况都返回空串，由调用方退回到通用文案。
 * @param raw - `tool/call` 事件里的 `arguments` 字段。
 * @returns 第一个问题的文本，取不到时为空串。
 */
export function firstQuestionOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (parsed === null || typeof parsed !== 'object') return ''
  const questions = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const first = questions[0]
  if (first === null || typeof first !== 'object') return ''
  return stringOf((first as { question?: unknown }).question)
}

/** 记下一个去重键，保持有界。 */
function remember(state: SessionState, key: string): readonly string[] {
  const next = [...state.notified, key]
  return next.length > NOTIFIED_CAP ? next.slice(next.length - NOTIFIED_CAP) : next
}

/** 这一轮结束时正文该写什么。 */
function bodyForTurnEnd(state: SessionState, config: NotifyConfig): string {
  if (!config.includeSummary) return ''
  if (!state.turnHadText) return '本轮没有文字回复'
  return summarize(state.summary)
}

/** 异常结束时的正文：只说结论，**不带那半截摘要**。 */
function bodyForFailure(kind: TriggerKind, reason: Record<string, unknown>): string {
  switch (kind) {
    case 'turn-aborted':
      return '任务已中断'
    case 'turn-blocked':
      return '任务被阻断'
    case 'turn-max-tokens':
      return '达到输出上限'
    case 'turn-error': {
      const failure = reason.error
      const message =
        failure !== null && typeof failure === 'object'
          ? stringOf((failure as { message?: unknown }).message)
          : ''
      return message === '' ? '任务执行失败' : summarize(`任务执行失败：${message}`, 60)
    }
    default:
      return '任务已结束'
  }
}

/** `turn/end` 的 reason.kind 到触发种类的映射。 */
const TURN_END_KINDS: Record<string, TriggerKind> = {
  completed: 'turn-completed',
  aborted: 'turn-aborted',
  blocked: 'turn-blocked',
  error: 'turn-error',
  'max-tokens': 'turn-max-tokens',
}

/** 该触发种类在当前配置下是否启用。 */
function enabledFor(kind: TriggerKind, config: NotifyConfig): boolean {
  switch (kind) {
    case 'turn-completed':
      return config.onTurnEnd
    case 'turn-aborted':
    case 'turn-blocked':
    case 'turn-error':
    case 'turn-max-tokens':
      return config.onTurnFailed
    case 'question-asked':
      return config.onQuestion
    case 'approval-asked':
      return config.onApproval
    default:
      return false
  }
}

/** 一条会话事件的形状（只取用到的字段，全部运行期收敛）。 */
export interface SessionEventLike {
  type?: unknown
  data?: unknown
}

/**
 * 处理一条会话事件，产出要发的通知与更新后的状态。
 *
 * 纯函数：不读时钟、不碰 IO、不改传入的参数。同一个 (state, event) 永远得到同一个结果。
 *
 * @param state - 该会话的上一个状态。
 * @param event - 一条 `session/event` 事件。
 * @param config - 当前通知配置。
 * @returns 新状态与本次要投递的通知（可能为空数组）。
 */
export function planEvent(
  state: SessionState,
  event: SessionEventLike,
  config: NotifyConfig,
): { state: SessionState; intents: NotifyIntent[] } {
  const data =
    event.data !== null && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>)
      : {}

  switch (event.type) {
    // 正文与标题只更新状态，不单独发通知 —— 它们是「回合结束」那条通知的素材。
    case 'assistant/message': {
      const message = data.message
      const content =
        message !== null && typeof message === 'object'
          ? (message as { content?: unknown }).content
          : undefined
      const text = assistantTextOf(content)
      if (text === '') return { state, intents: [] }
      return { state: { ...state, summary: text, turnHadText: true }, intents: [] }
    }

    case 'session/title': {
      const title = stringOf(data.title).trim()
      if (title === '') return { state, intents: [] }
      const source = data.source
      const kind =
        source !== null && typeof source === 'object'
          ? stringOf((source as { kind?: unknown }).kind)
          : ''
      // provider 标题一旦到手，fallback 不再覆盖。
      if (state.providerTitled && kind !== 'provider') return { state, intents: [] }
      return {
        state: { ...state, title, providerTitled: state.providerTitled || kind === 'provider' },
        intents: [],
      }
    }

    case 'turn/start':
      return { state: { ...state, turnHadText: false }, intents: [] }

    case 'turn/end': {
      const reason =
        data.reason !== null && typeof data.reason === 'object'
          ? (data.reason as Record<string, unknown>)
          : {}
      const reasonKind = stringOf(reason.kind)
      const kind = TURN_END_KINDS[reasonKind]
      // 未知 reason（上游新增）与 interrupted（不上 firehose）都安静跳过。
      if (kind === undefined) return { state, intents: [] }

      const turn = typeof data.turn === 'number' ? data.turn : -1
      const dedupeKey = `turn:${turn}`
      if (state.notified.includes(dedupeKey)) return { state, intents: [] }

      const next = { ...state, notified: remember(state, dedupeKey) }
      if (!config.enabled || !enabledFor(kind, config)) return { state: next, intents: [] }

      const body = kind === 'turn-completed' ? bodyForTurnEnd(state, config) : bodyForFailure(kind, reason)
      return {
        state: next,
        intents: [
          {
            kind,
            title: state.title.trim() === '' ? FALLBACK_TITLE : state.title,
            body,
            dedupeKey,
          },
        ],
      }
    }

    case 'tool/call': {
      // firehose 上每一次工具调用都会来（本会话 127 次），只有 ask_user_question 有意义。
      if (stringOf(data.name) !== 'ask_user_question') return { state, intents: [] }
      const callId = stringOf(data.callId)
      const dedupeKey = `call:${callId === '' ? stringOf(data.turn) : callId}`
      if (state.notified.includes(dedupeKey)) return { state, intents: [] }

      const next = { ...state, notified: remember(state, dedupeKey) }
      if (!config.enabled || !enabledFor('question-asked', config)) return { state: next, intents: [] }

      const question = summarize(firstQuestionOf(data.arguments), 50)
      return {
        state: next,
        intents: [
          {
            kind: 'question-asked',
            title: state.title.trim() === '' ? FALLBACK_TITLE : state.title,
            body: question === '' ? '等待你的选择' : `等待你的选择：${question}`,
            dedupeKey,
          },
        ],
      }
    }

    case 'approval/asked': {
      const id = stringOf(data.id)
      const dedupeKey = `approval:${id}`
      if (state.notified.includes(dedupeKey)) return { state, intents: [] }

      const next = { ...state, notified: remember(state, dedupeKey) }
      if (!config.enabled || !enabledFor('approval-asked', config)) return { state: next, intents: [] }

      const toolName = stringOf(data.toolName)
      const reason = summarize(stringOf(data.reason), 40)
      const tail = toolName === '' ? '' : `：${toolName}`
      return {
        state: next,
        intents: [
          {
            kind: 'approval-asked',
            title: state.title.trim() === '' ? FALLBACK_TITLE : state.title,
            body: reason === '' ? `等待授权${tail}` : `等待授权${tail}（${reason}）`,
            dedupeKey,
          },
        ],
      }
    }

    // 用户已经答复 / 已决定：清掉等待态。当前实现只靠去重键，不需要额外状态。
    case 'tool/result':
    case 'approval/decided':
      return { state, intents: [] }

    default:
      return { state, intents: [] }
  }
}
