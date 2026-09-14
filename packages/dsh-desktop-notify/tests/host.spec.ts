/**
 * host 半区的用例。
 *
 * 这里搭一个最小 cordis 替身，把插件真正注册的东西全部截下来（设置命名空间、模型
 * 工具、命令、会话事件监听），验证接线正确 —— 尤其是 `defineTool` 的参数与输出
 * schema 必须真的合法，写错了会在注册时抛，而不是等到模型调用时才炸。
 *
 * 测试环境里 `process.execPath` 是普通 node，推不出 DSH Desktop 主二进制，所以后端
 * 必然是"不可用"：这正好用来验证**不可用时给出可读原因**，而不是静默失败或抛异常。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, makeTitleReader } from '../src/index.ts'

/** 一个被截下来的工具定义。 */
interface CapturedTool {
  name: string
  description: string
  /** defineTool 编译后的 JSON Schema —— 模型看到的就是这一份。 */
  parameters: Record<string, unknown>
  output: unknown
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}

/** 一个被截下来的命令定义。 */
interface CapturedCommand {
  name: string
  handler(invocation: { rawInput: string }): Promise<{ kind: string; text: string }>
}

/** 测试替身收集到的东西。 */
interface Harness {
  ctx: Context
  namespaces: string[]
  tools: CapturedTool[]
  commands: CapturedCommand[]
  sessionEvents: Array<(session: unknown, event: unknown) => void>
  store: Record<string, unknown>
  dispose(): void
}

/**
 * 搭一个最小 cordis 替身。
 * @returns 替身与它截下来的注册项。
 */
function stubHost(): Harness {
  const namespaces: string[] = []
  const tools: CapturedTool[] = []
  const commands: CapturedCommand[] = []
  const sessionEvents: Array<(session: unknown, event: unknown) => void> = []
  const disposers: Array<() => void> = []
  const store: Record<string, unknown> = {}

  const makeContext = (): Record<string, unknown> => ({
    // 嵌套 inject 要能一路同步回调下去，否则插件体根本不会执行。
    inject: (_names: readonly string[], callback: (ctx: unknown) => void) => {
      callback(makeContext())
    },
    settings: {
      register: (namespace: string) => {
        namespaces.push(namespace)
        return {
          get: () => store,
          update: async (patch: object) => {
            Object.assign(store, patch)
          },
          watch: () => () => {},
        }
      },
    },
    tools: {
      register: (definition: CapturedTool) => {
        tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register: (definition: CapturedCommand) => {
        commands.push(definition)
        return () => {}
      },
    },
    effect: (execute: () => unknown) => {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    },
    on: (name: string, handler: (session: unknown, event: unknown) => void) => {
      if (name === 'session/event') sessionEvents.push(handler)
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  })

  return {
    ctx: makeContext() as unknown as Context,
    namespaces,
    tools,
    commands,
    sessionEvents,
    store,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

describe('host 半区装配', () => {
  it('注册设置命名空间、模型工具与会话事件监听', () => {
    const host = stubHost()
    expect(() => apply(host.ctx)).not.toThrow()

    expect(host.namespaces).toEqual(['dsh-desktop-notify'])
    expect(host.tools.map((tool) => tool.name)).toEqual(['notify'])
    expect(host.commands.map((command) => command.name)).toEqual(['notify'])
    expect(host.sessionEvents).toHaveLength(1)
  })

  it('工具的参数 schema 是模型真正会看到的形状', () => {
    const host = stubHost()
    apply(host.ctx)
    const tool = host.tools[0]!

    // defineTool 会把参数规格编译成 JSON Schema，模型看到的就是这一份。
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        sound: { type: 'boolean' },
      },
      required: ['title'],
    })
    // 输出契约必须声明，否则 register 会在装配期就抛。
    expect(tool.output).toBeDefined()
    expect(tool.description).toContain('macOS')
  })

  it('没有可用的通知后端时，工具返回可读原因而不是抛异常', async () => {
    const host = stubHost()
    apply(host.ctx)
    const tool = host.tools[0]!

    const result = (await tool.execute({ title: '测试' })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
  })

  it('探测结果会写进设置，供界面读取', async () => {
    const host = stubHost()
    apply(host.ctx)
    // 探测是异步发起的，让微任务队列跑完。
    await new Promise((resolve) => setTimeout(resolve, 0))

    const status = host.store.status as Record<string, unknown> | undefined
    expect(status).toBeDefined()
    expect(status?.kind).toBe('unavailable')
    expect(typeof status?.detail).toBe('string')
  })

  it('/notify status 能报出后端与开关状态', async () => {
    const host = stubHost()
    apply(host.ctx)
    const command = host.commands[0]!

    const result = await command.handler({ rawInput: 'status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('后端')
    expect(result.text).toContain('总开关')
  })

  it('/notify 未知子命令报错而不是静默', async () => {
    const host = stubHost()
    apply(host.ctx)
    const result = await host.commands[0]!.handler({ rawInput: '乱写' })
    expect(result.kind).toBe('error')
  })
})

describe('会话事件接线', () => {
  it('喂进各种形状的事件都不抛异常', () => {
    const host = stubHost()
    apply(host.ctx)
    const handler = host.sessionEvents[0]!

    const weird = [
      { id: 's1', name: 'normal' },
      null,
      undefined,
      'not-an-object',
      { id: 42 },
    ]
    const events = [
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1', arguments: '{}' } },
      { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '甲' }] } } },
      { type: 'session/title', data: { title: '标题', source: { kind: 'provider' } } },
      null,
      {},
      'garbage',
    ]

    for (const session of weird) {
      for (const event of events) {
        expect(() => handler(session, event)).not.toThrow()
      }
    }
  })

  it('卸载时收干净（disposer 不抛）', () => {
    const host = stubHost()
    apply(host.ctx)
    expect(() => host.dispose()).not.toThrow()
  })
})

describe('标题读取：firehose 不回放构造种子时的兜底', () => {
  it('读到投影里的标题', () => {
    const ctx = {
      get: (name: string) =>
        name === 'sessionProjections'
          ? { stateOf: (_session: unknown, key: string) => (key === 'title' ? '了解AI运行环境' : null) }
          : undefined,
    } as unknown as Context
    expect(makeTitleReader(ctx)({ id: 's1' })).toBe('了解AI运行环境')
  })

  it('没有这个服务时返回空串（降级，不是崩溃）', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(makeTitleReader(ctx)({ id: 's1' })).toBe('')
  })

  it('投影返回非字符串时返回空串', () => {
    const ctx = {
      get: () => ({ stateOf: () => 42 }),
    } as unknown as Context
    expect(makeTitleReader(ctx)({ id: 's1' })).toBe('')
  })

  it('读投影抛异常时被吞掉，不影响发通知', () => {
    const ctx = {
      get: () => ({
        stateOf: () => {
          throw new Error('投影服务坏了')
        },
      }),
    } as unknown as Context
    expect(() => makeTitleReader(ctx)({ id: 's1' })).not.toThrow()
    expect(makeTitleReader(ctx)({ id: 's1' })).toBe('')
  })

  it('会话对象形状不对时返回空串', () => {
    const ctx = {
      get: () => ({ stateOf: () => '标题' }),
    } as unknown as Context
    const read = makeTitleReader(ctx)
    expect(read(null)).toBe('')
    expect(read(undefined)).toBe('')
    expect(read('not-an-object')).toBe('')
  })
})
