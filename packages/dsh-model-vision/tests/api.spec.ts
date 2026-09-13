import { describe, expect, it, vi } from 'vitest'
import {
  type DescribeValue,
  type RemoteEnvelope,
  type SettingsRemote,
  loadRoute,
  onRemoteEvent,
  settingsRemoteOf,
  writeModality,
} from '../src/client/api.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 造一个只回答 get 的 cordis 上下文。 */
function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** 描述体的便捷构造：一个 llm-pi-ai provider，用户层声明了两个模型。 */
function piAiDescribe(overrides: Partial<DescribeValue> = {}): DescribeValue {
  const user = {
    providers: { baizhi: { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-vision' }] } },
  }
  return {
    writable: true,
    hasDocument: true,
    namespaces: [{ ns: 'llm-pi-ai', value: user, user, applies: 'live', revision: 9 }],
    ...overrides,
  }
}

/** 一个记录调用的设置远端替身。 */
function fakeRemote(describe: () => Promise<RemoteEnvelope<DescribeValue>>, mutate?: SettingsRemote['mutate']): {
  remote: SettingsRemote
  mutate: ReturnType<typeof vi.fn>
} {
  const mutateMock = vi.fn(mutate ?? (async () => ({ ok: true, value: { ns: 'llm-pi-ai' } })))
  return {
    remote: { describe, mutate: mutateMock as unknown as SettingsRemote['mutate'] },
    mutate: mutateMock,
  }
}

describe('settingsRemoteOf', () => {
  it('prefers the dedicated service and falls back to remote.settings', () => {
    const direct = { describe: vi.fn(), mutate: vi.fn() }
    expect(settingsRemoteOf({ get: (name: string) => (name === 'remote.settings' ? direct : undefined) } as unknown as Context)).toBe(direct)

    const nested = { describe: vi.fn(), mutate: vi.fn() }
    expect(settingsRemoteOf({ get: (name: string) => (name === 'remote' ? { settings: nested } : undefined) } as unknown as Context)).toBe(nested)

    expect(settingsRemoteOf({ get: () => undefined } as unknown as Context)).toBeUndefined()
  })
})

describe('loadRoute', () => {
  it('builds a view from the namespace descriptor', async () => {
    const { remote } = fakeRemote(async () => ({ ok: true, value: piAiDescribe() }))
    const result = await loadRoute(remote, 'llm-pi-ai', ['providers', 'baizhi'])

    expect(result.ok).toBe(true)
    if (result.ok !== true) return
    expect(result.applies).toBe('live')
    expect(result.view.revision).toBe(9)
    expect(result.view.field).toBe('input')
    expect(result.view.entries.map((entry) => entry.id)).toEqual(['deepseek-flash', 'deepseek-vision'])
  })

  it('surfaces a describe failure as a message rather than throwing', async () => {
    const { remote } = fakeRemote(async () => ({ ok: false, error: { message: 'boom' } }))
    const result = await loadRoute(remote, 'llm-pi-ai', [])
    expect(result).toEqual({ ok: false, message: 'boom' })
  })

  it('reports a missing namespace explicitly', async () => {
    const { remote } = fakeRemote(async () => ({ ok: true, value: piAiDescribe({ namespaces: [] }) }))
    const result = await loadRoute(remote, 'llm-pi-ai', [])
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.message).toContain('llm-pi-ai')
  })
})

describe('writeModality', () => {
  it('writes the whole models array and reloads afterwards', async () => {
    const { remote, mutate } = fakeRemote(async () => ({ ok: true, value: piAiDescribe() }))
    const loaded = await loadRoute(remote, 'llm-pi-ai', ['providers', 'baizhi'])
    if (loaded.ok !== true) throw new Error('fixture failed')

    const result = await writeModality(remote, loaded.view, 'deepseek-vision', 'models', 'text+image')

    expect(result.ok).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
    const [ns, ops, revision] = mutate.mock.calls[0] as [string, unknown[], number]
    expect(ns).toBe('llm-pi-ai')
    expect(revision).toBe(9)
    expect(ops).toEqual([
      {
        op: 'set',
        path: ['providers', 'baizhi', 'models'],
        value: [{ id: 'deepseek-flash' }, { id: 'deepseek-vision', input: ['text', 'image'] }],
      },
    ])
  })

  it('re-reads and retries exactly once on a revision conflict', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'stale' } })
      .mockResolvedValueOnce({ ok: true, value: { ns: 'llm-pi-ai' } })
    const { remote } = fakeRemote(async () => ({ ok: true, value: piAiDescribe() }), mutate)
    const loaded = await loadRoute(remote, 'llm-pi-ai', ['providers', 'baizhi'])
    if (loaded.ok !== true) throw new Error('fixture failed')

    const result = await writeModality(remote, loaded.view, 'deepseek-flash', 'models', 'text')

    expect(result.ok).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-conflict refusal', async () => {
    const { remote, mutate } = fakeRemote(
      async () => ({ ok: true, value: piAiDescribe() }),
      async () => ({ ok: false, error: { code: 'settings/rejected', message: 'schema says no' } }),
    )
    const loaded = await loadRoute(remote, 'llm-pi-ai', ['providers', 'baizhi'])
    if (loaded.ok !== true) throw new Error('fixture failed')

    const result = await writeModality(remote, loaded.view, 'deepseek-flash', 'models', 'text')

    expect(result).toEqual({ ok: false, message: 'schema says no' })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('reports a model that vanished between read and write', async () => {
    const { remote, mutate } = fakeRemote(async () => ({ ok: true, value: piAiDescribe() }))
    const loaded = await loadRoute(remote, 'llm-pi-ai', ['providers', 'baizhi'])
    if (loaded.ok !== true) throw new Error('fixture failed')

    const result = await writeModality(remote, loaded.view, 'gone', 'models', 'text')

    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.message).toContain('gone')
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('onRemoteEvent', () => {
  it('subscribes through the root remote and unsubscribes cleanly', () => {
    const handler = vi.fn()
    const unsubscribe = vi.fn()
    const root = { $on: vi.fn(() => unsubscribe), settings: {} }

    const dispose = onRemoteEvent(ctxWith({ remote: root }), 'settings/document-updated', handler)

    // 事件面只在根 remote 上，嵌套 face 上没有 $on。
    expect(root.$on).toHaveBeenCalledWith('settings/document-updated', expect.any(Function))
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards the listener argument-free', () => {
    const handler = vi.fn()
    let fire: (() => void) | undefined
    const root = { $on: (_event: string, listener: () => void) => ((fire = listener), () => undefined) }

    onRemoteEvent(ctxWith({ remote: root }), 'llm/adapters-updated', handler)
    fire?.()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('degrades to a no-op when there is no event surface', () => {
    expect(() => onRemoteEvent(ctxWith({}), 'settings/document-updated', vi.fn())()).not.toThrow()
    expect(() => onRemoteEvent({ get: () => undefined } as never, 'x', vi.fn())()).not.toThrow()
  })
})
