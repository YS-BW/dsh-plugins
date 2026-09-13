import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

/** 一次 inject 的调用记录。 */
interface Injection {
  slot: string
  options: { name: string; key?: string; id?: string }
}

/**
 * 最小 cordis 上下文替身：只提供本插件取用的两个服务。
 * @param options - 是否挂载 slots / remote.settings，用于验证降级路径。
 * @returns 替身上下文与注入记录。
 */
function stubContext(options: { slots?: boolean; remote?: boolean; root?: boolean } = {}): {
  ctx: Context
  injections: Injection[]
  components: Array<(props: unknown) => { props: Record<string, unknown> }>
  rootOn: ReturnType<typeof vi.fn>
  dispose: () => void
} {
  const injections: Injection[] = []
  const components: Array<(props: unknown) => { props: Record<string, unknown> }> = []
  const disposers: Array<() => void> = []
  const rootOn = vi.fn(() => () => undefined)

  const slots = {
    inject(_slot: string, register: () => () => void) {
      disposers.push(register())
    },
    register(opts: { name: string; key?: string; id?: string }, component: unknown) {
      injections.push({ slot: opts.name, options: opts })
      components.push(component as (props: unknown) => { props: Record<string, unknown> })
      return () => undefined
    },
  }

  const services: Record<string, unknown> = {}
  if (options.slots !== false) services['slots'] = slots
  if (options.remote !== false) {
    services['remote.settings'] = {
      describe: vi.fn(async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })),
      mutate: vi.fn(async () => ({ ok: true, value: { ns: 'llm-pi-ai' } })),
    }
  }
  // 根 remote 只承载事件面；嵌套 face 上没有 $on。
  if (options.root !== false) services['remote'] = { $on: rootOn }

  const ctx = {
    get: (name: string) => services[name],
  } as unknown as Context

  return {
    ctx,
    injections,
    components,
    rootOn,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
      disposers.length = 0
    },
  }
}

describe('dsh-model-vision client half', () => {
  it('registers the panel into the official provider-card slot for both provider namespaces', () => {
    const { ctx, injections } = stubContext()
    apply(ctx)

    expect(injections.map((entry) => entry.slot)).toEqual([
      'settings.models.provider-card',
      'settings.models.provider-card',
    ])
    // keyed slot 的 key 必须是 provider 的 settingsNs，写错就是静默不渲染。
    expect(injections.map((entry) => entry.options.key)).toEqual(['llm-pi-ai', 'llm-deepseek'])
  })

  it('does nothing when the slots service is absent instead of throwing', () => {
    const { ctx, injections } = stubContext({ slots: false })
    expect(() => apply(ctx)).not.toThrow()
    expect(injections).toEqual([])
  })

  it('still registers when no settings remote is mounted, so the panel can report it', () => {
    // 远端是惰性解析的：注册不能被它挡住，否则就是「装上了、不报错、就是没面板」。
    const { ctx, injections } = stubContext({ remote: false })
    expect(() => apply(ctx)).not.toThrow()
    expect(injections.map((entry) => entry.options.key)).toEqual(['llm-pi-ai', 'llm-deepseek'])
  })

  it('给面板接上远端解析器，且事件面走根 remote', () => {
    // 事件面只在根 remote 上；接到嵌套 face 上会静默失效，面板就再也不自动刷新。
    const { ctx, components, rootOn } = stubContext()
    apply(ctx)

    const element = components[0]!({
      provider: { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'baizhi'], provider: 'baizhi' },
    })
    const passed = element.props

    expect((passed.getRemote as () => unknown)()).toBeDefined()
    ;(passed.onEvent as (event: string, listener: () => void) => () => void)('settings/document-updated', () => undefined)
    expect(rootOn).toHaveBeenCalledWith('settings/document-updated', expect.any(Function))
  })

  it('disposes every injection when the plugin unloads', () => {
    const { ctx, dispose } = stubContext()
    apply(ctx)
    expect(() => dispose()).not.toThrow()
  })
})
