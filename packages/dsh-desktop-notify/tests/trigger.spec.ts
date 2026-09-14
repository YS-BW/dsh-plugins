/**
 * 触发层的用例。这是整个插件最值得测的一层：它是纯函数，而且承担了三个从真实会话
 * 日志里挖出来的坑（reasoning 不能当正文、纯工具轮次没有正文、标题会发两次）。
 */
import { describe, expect, it } from 'vitest'
import { defaultConfig, type NotifyConfig } from '../src/core/config.ts'
import {
  firstQuestionOf,
  initialSessionState,
  planEvent,
  type SessionState,
} from '../src/core/trigger.ts'

/** 打开全部开关的配置。 */
function on(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return { ...defaultConfig(), enabled: true, ...overrides }
}

/** 依次喂多条事件，返回最终状态与所有产出的通知。 */
function feed(
  events: readonly unknown[],
  config: NotifyConfig,
  from: SessionState = initialSessionState(),
): { state: SessionState; bodies: string[]; kinds: string[] } {
  let state = from
  const bodies: string[] = []
  const kinds: string[] = []
  for (const event of events) {
    const planned = planEvent(state, event as { type?: unknown; data?: unknown }, config)
    state = planned.state
    for (const intent of planned.intents) {
      bodies.push(intent.body)
      kinds.push(intent.kind)
    }
  }
  return { state, bodies, kinds }
}

/** 造一条 assistant 消息事件。 */
function message(...blocks: readonly Record<string, unknown>[]): unknown {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: blocks } } }
}

describe('摘要提取：只有 text 是正文', () => {
  it('reasoning 块绝不进摘要', () => {
    const { state } = feed(
      [message({ type: 'reasoning', text: '我在想一件不该被用户看到的事' })],
      on(),
    )
    expect(state.summary).toBe('')
    expect(state.turnHadText).toBe(false)
  })

  it('同一消息里的 reasoning 与 text 并存时只取 text', () => {
    const { state } = feed(
      [
        message(
          { type: 'reasoning', text: '内部推理' },
          { type: 'text', text: '对用户说的话' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ),
      ],
      on(),
    )
    expect(state.summary).toBe('对用户说的话')
    expect(state.summary).not.toContain('内部推理')
  })

  it('纯工具调用轮次不覆盖已有摘要', () => {
    const { state } = feed(
      [
        message({ type: 'text', text: '第一句话' }),
        message({ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }),
      ],
      on(),
    )
    expect(state.summary).toBe('第一句话')
  })

  it('content 形状不可信时不抛异常', () => {
    const weird = [
      { type: 'assistant/message', data: { message: { content: 'not-an-array' } } },
      { type: 'assistant/message', data: { message: null } },
      { type: 'assistant/message', data: {} },
      { type: 'assistant/message', data: { message: { content: [null, 42, { type: 'text' }] } } },
    ]
    expect(() => feed(weird, on())).not.toThrow()
  })
})

describe('会话标题：provider 赢，fallback 不覆盖', () => {
  it('先 fallback 后 provider，最终用 provider', () => {
    const { state } = feed(
      [
        { type: 'session/title', data: { title: '你知道当前的运行环境吗，就', source: { kind: 'fallback' } } },
        { type: 'session/title', data: { title: '了解AI运行环境', source: { kind: 'provider' } } },
      ],
      on(),
    )
    expect(state.title).toBe('了解AI运行环境')
  })

  it('provider 先到时，后到的 fallback 不覆盖它', () => {
    const { state } = feed(
      [
        { type: 'session/title', data: { title: '正式标题', source: { kind: 'provider' } } },
        { type: 'session/title', data: { title: '截断的首问', source: { kind: 'fallback' } } },
      ],
      on(),
    )
    expect(state.title).toBe('正式标题')
  })

  it('标题事件本身不发通知', () => {
    const { bodies } = feed(
      [{ type: 'session/title', data: { title: '标题', source: { kind: 'provider' } } }],
      on(),
    )
    expect(bodies).toHaveLength(0)
  })
})

describe('回合结束', () => {
  it('正常结束：标题用会话标题，正文用本轮摘要', () => {
    const { bodies, kinds } = feed(
      [
        { type: 'session/title', data: { title: '修一个 bug', source: { kind: 'provider' } } },
        { type: 'turn/start', data: { turn: 1 } },
        message({ type: 'text', text: '修好了，原因是缓存没失效。' }),
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      on(),
    )
    expect(kinds).toEqual(['turn-completed'])
    expect(bodies[0]).toBe('修好了，原因是缓存没失效。')
  })

  it('本轮只有工具调用时，正文说「没有文字回复」而不是拿上一轮的', () => {
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        message({ type: 'text', text: '第一轮的答复' }),
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'turn/start', data: { turn: 2 } },
        message({ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }),
        { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      ],
      on(),
    )
    expect(bodies).toEqual(['第一轮的答复', '本轮没有文字回复'])
  })

  it('中断时不带那半截摘要，只说中断', () => {
    const { bodies, kinds } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        message({ type: 'text', text: '我正说到一半就被打断了' }),
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      ],
      on(),
    )
    expect(kinds).toEqual(['turn-aborted'])
    expect(bodies[0]).toBe('任务已中断')
    expect(bodies[0]).not.toContain('说到一半')
  })

  it('失败时带上错误信息', () => {
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'error', error: { message: '连接被重置' } } },
        },
      ],
      on(),
    )
    expect(bodies[0]).toContain('任务执行失败')
    expect(bodies[0]).toContain('连接被重置')
  })

  it('interrupted 与未知 reason 都不触发（前者机制上不上 firehose）', () => {
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'turn/end', data: { turn: 2, reason: { kind: '上游新增的某个 kind' } } },
      ],
      on(),
    )
    expect(bodies).toHaveLength(0)
  })

  it('同一回合重复事件只通知一次', () => {
    const events = [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    const { bodies } = feed(events, on())
    expect(bodies).toHaveLength(1)
  })
})

describe('等待人工输入', () => {
  it('ask_user_question 触发并带上第一个问题', () => {
    const { bodies, kinds } = feed(
      [
        {
          type: 'tool/call',
          data: {
            turn: 2,
            callId: 'call_1',
            name: 'ask_user_question',
            arguments: JSON.stringify({ questions: [{ question: '用哪个方案？' }] }),
          },
        },
      ],
      on(),
    )
    expect(kinds).toEqual(['question-asked'])
    expect(bodies[0]).toBe('等待你的选择：用哪个方案？')
  })

  it('别的工具调用一律不触发', () => {
    const { bodies } = feed(
      [
        { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } },
        { type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{}' } },
        { type: 'tool/call', data: { callId: 'c3', name: 'web_search', arguments: '{}' } },
      ],
      on(),
    )
    expect(bodies).toHaveLength(0)
  })

  it('参数不是合法 JSON 时退回通用文案', () => {
    const { bodies } = feed(
      [{ type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: '{坏掉的' } }],
      on(),
    )
    expect(bodies[0]).toBe('等待你的选择')
  })

  it('approval/asked 触发并带上工具名', () => {
    const { bodies, kinds } = feed(
      [{ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: '需要写权限' } }],
      on(),
    )
    expect(kinds).toEqual(['approval-asked'])
    expect(bodies[0]).toContain('bash')
    expect(bodies[0]).toContain('需要写权限')
  })

  it('同一次请求重复事件只通知一次', () => {
    const { bodies } = feed(
      [
        { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
        { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
      ],
      on(),
    )
    expect(bodies).toHaveLength(1)
  })

  it('不同的请求 id 各自通知', () => {
    const { bodies } = feed(
      [
        { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
        { type: 'approval/asked', data: { id: 'a2', toolName: 'edit' } },
      ],
      on(),
    )
    expect(bodies).toHaveLength(2)
  })
})

describe('配置开关', () => {
  it('总开关关闭时不投递', () => {
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      on({ enabled: false }),
    )
    expect(bodies).toHaveLength(0)
  })

  it('总开关关闭时仍然记下去重键，重新打开不会补发', () => {
    let state = initialSessionState()
    const off = on({ enabled: false })
    const first = planEvent(
      state,
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      off,
    )
    state = first.state
    expect(first.intents).toHaveLength(0)

    const second = planEvent(
      state,
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      on(),
    )
    expect(second.intents).toHaveLength(0)
  })

  it('关闭某一类触发只影响那一类', () => {
    const config = on({ onTurnFailed: false })
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      ],
      config,
    )
    expect(bodies).toHaveLength(1)
  })

  it('关掉摘要后完成通知没有正文', () => {
    const { bodies } = feed(
      [
        { type: 'turn/start', data: { turn: 1 } },
        message({ type: 'text', text: '有正文' }),
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      on({ includeSummary: false }),
    )
    expect(bodies[0]).toBe('')
  })
})

describe('去重键有界', () => {
  it('长会话不会让去重表无限增长', () => {
    let state = initialSessionState()
    for (let turn = 1; turn <= 200; turn += 1) {
      state = planEvent(
        state,
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
        on(),
      ).state
    }
    expect(state.notified.length).toBeLessThanOrEqual(64)
    // 最近的仍然记得住。
    expect(state.notified).toContain('turn:200')
  })
})

describe('firstQuestionOf', () => {
  it('各种坏输入都返回空串', () => {
    expect(firstQuestionOf(undefined)).toBe('')
    expect(firstQuestionOf('')).toBe('')
    expect(firstQuestionOf('不是 JSON')).toBe('')
    expect(firstQuestionOf('[]')).toBe('')
    expect(firstQuestionOf('{"questions":[]}')).toBe('')
    expect(firstQuestionOf('{"questions":[null]}')).toBe('')
    expect(firstQuestionOf('{"questions":[{"header":"没有 question 字段"}]}')).toBe('')
  })
})
