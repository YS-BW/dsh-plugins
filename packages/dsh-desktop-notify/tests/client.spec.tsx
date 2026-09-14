/**
 * browser 半区的用例：slot 注册 + 面板真的能渲染出来。
 *
 * 渲染测试是刻意保留的 —— 这个页面的全部价值就是把"静默失败"变成"看得见"，所以
 * "装上了、不报错、就是没面板"和"面板在但状态读不出来"这两类问题必须能被测出来。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { loadConfig, statusOf, type SettingsRemote } from '../src/client/api.ts'
import { DesktopNotifyPanel } from '../src/client/panel.tsx'

// React 要求测试环境显式声明这一点，否则每次 act() 都会打一条警告。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 一条被截下来的 slot 注册。 */
interface CapturedSlot {
  options: { name: string; id?: string; order?: number; label?: string }
  component: (props: unknown) => unknown
}

/** 搭一个只提供 slots 的浏览器上下文替身。 */
function stubClient(): { ctx: Context; slots: CapturedSlot[]; injected: string[] } {
  const slots: CapturedSlot[] = []
  const injected: string[] = []
  const ctx = {
    inject: (names: readonly string[], callback: (ctx: unknown) => void) => {
      callback(ctx)
    },
    get: (name: string) => {
      if (name !== 'slots') return undefined
      return {
        inject: (name: string, register: () => () => void) => {
          injected.push(name)
          register()
        },
        register: (options: CapturedSlot['options'], component: CapturedSlot['component']) => {
          slots.push({ options, component })
          return () => {}
        },
      }
    },
  } as unknown as Context
  return { ctx, slots, injected }
}

/** 造一份设置远端替身。 */
function stubRemote(
  value: unknown,
  options: { writable?: boolean } = {},
): { remote: SettingsRemote; mutations: unknown[] } {
  const mutations: unknown[] = []
  const remote: SettingsRemote = {
    describe: async () => ({
      ok: true,
      value: {
        writable: options.writable ?? true,
        hasDocument: true,
        namespaces: [{ ns: 'dsh-desktop-notify', value, revision: 7 }],
      },
    }),
    mutate: async (_ns, ops) => {
      mutations.push(ops)
      return { ok: true, value: { ns: 'dsh-desktop-notify', value, revision: 8 } }
    },
  }
  return { remote, mutations }
}

/** 渲染一个元素并等它稳定。 */
async function render(element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  // 面板的读取是异步的，再让一轮微任务跑完。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { root, container }
}

let mounted: Root[] = []
afterEach(() => {
  for (const root of mounted) {
    act(() => root.unmount())
  }
  mounted = []
  document.body.innerHTML = ''
})

describe('客户端装配', () => {
  it('往 settings.section 注册一整页，id 与标签正确', () => {
    const client = stubClient()
    apply(client.ctx)

    expect(client.injected).toEqual(['settings.section'])
    expect(client.slots).toHaveLength(1)
    expect(client.slots[0]!.options).toMatchObject({
      name: 'settings.section',
      id: 'desktop-notify',
      label: '桌面通知',
    })
    expect(typeof client.slots[0]!.options.order).toBe('number')
  })

  it('非浏览器环境（没有 document）直接跳过，不抛', () => {
    const client = stubClient()
    const original = globalThis.document
    // @ts-expect-error 故意制造 SSR 场景
    delete globalThis.document
    try {
      expect(() => apply(client.ctx)).not.toThrow()
    } finally {
      globalThis.document = original
    }
  })
})

describe('远端读取', () => {
  it('命名空间缺失时给出可读原因，而不是静默', async () => {
    const remote: SettingsRemote = {
      describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } }),
      mutate: async () => ({ ok: true, value: { ns: 'x', value: {} } }),
    }
    const result = await loadConfig(remote, 'dsh-desktop-notify')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('dsh-desktop-notify')
  })

  it('远端抛异常时收敛成失败结论', async () => {
    const remote: SettingsRemote = {
      describe: async () => {
        throw new Error('连接断了')
      },
      mutate: async () => ({ ok: true, value: { ns: 'x', value: {} } }),
    }
    const result = await loadConfig(remote, 'dsh-desktop-notify')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('连接断了')
  })

  it('status 形状不可信时退回"尚未探测"', () => {
    expect(statusOf(undefined).authorizationStatus).toBe(-1)
    expect(statusOf({ status: 'not-an-object' }).kind).toBe('unavailable')
    expect(statusOf({ status: { kind: '别的值' } }).kind).toBe('unavailable')
    expect(statusOf({ status: { kind: 'desktop-addon', authorizationStatus: 'x' } }).authorizationStatus).toBe(-1)
  })
})

describe('面板渲染', () => {
  it('未授权时明确提示横幅不会弹', async () => {
    const { remote } = stubRemote({
      enabled: true,
      status: {
        kind: 'desktop-addon',
        identity: 'io.dsh.desktop',
        detail: '',
        lastAt: '2026-09-15T01:00:00.000Z',
        authorizationStatus: 1,
        alertSetting: 0,
        soundSetting: 0,
      },
    })
    const ctx = { get: (name: string) => (name === 'remote.settings' ? remote : undefined) } as unknown as Context
    const view = await render(<DesktopNotifyPanel getContext={() => ctx} namespace="dsh-desktop-notify" />)
    mounted.push(view.root)

    const text = view.container.textContent ?? ''
    expect(text).toContain('io.dsh.desktop')
    expect(text).toContain('已被拒绝')
    expect(text).toContain('不会弹出来提醒你')
  })

  it('后端不可用时说明原因', async () => {
    const { remote } = stubRemote({
      status: {
        kind: 'unavailable',
        identity: '',
        detail: '当前 host 不是从 DSH Desktop 的 Electron helper 启动的，拿不到通知身份。',
        lastAt: '',
        authorizationStatus: -1,
        alertSetting: -1,
        soundSetting: -1,
      },
    })
    const ctx = { get: (name: string) => (name === 'remote.settings' ? remote : undefined) } as unknown as Context
    const view = await render(<DesktopNotifyPanel getContext={() => ctx} namespace="dsh-desktop-notify" />)
    mounted.push(view.root)

    const text = view.container.textContent ?? ''
    expect(text).toContain('不可用')
    expect(text).toContain('拿不到通知身份')
  })

  it('列出全部开关，且总开关反映配置值', async () => {
    const { remote } = stubRemote({
      enabled: true,
      onTurnEnd: false,
      status: { kind: 'desktop-addon', identity: 'io.dsh.desktop', detail: '', lastAt: '' },
    })
    const ctx = { get: (name: string) => (name === 'remote.settings' ? remote : undefined) } as unknown as Context
    const view = await render(<DesktopNotifyPanel getContext={() => ctx} namespace="dsh-desktop-notify" />)
    mounted.push(view.root)

    const boxes = [...view.container.querySelectorAll('input[type="checkbox"]')]
    expect(boxes).toHaveLength(7)
    // 第一个是总开关，第二个是"回合正常结束时通知"。
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('点「发送测试通知」会往设置里写一个新的 testAt', async () => {
    const { remote, mutations } = stubRemote({ enabled: true, testAt: 0 })
    const ctx = { get: (name: string) => (name === 'remote.settings' ? remote : undefined) } as unknown as Context
    const view = await render(<DesktopNotifyPanel getContext={() => ctx} namespace="dsh-desktop-notify" />)
    mounted.push(view.root)

    const button = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === '发送测试通知',
    )
    expect(button).toBeDefined()
    await act(async () => {
      button!.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const wrote = mutations.flat() as Array<{ op: string; path: string[]; value: unknown }>
    const testOp = wrote.find((operation) => operation.path?.[0] === 'testAt')
    expect(testOp).toBeDefined()
    expect(typeof testOp!.value).toBe('number')
  })

  it('拿不到远端时明说，而不是空白页', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const view = await render(<DesktopNotifyPanel getContext={() => ctx} namespace="dsh-desktop-notify" />)
    mounted.push(view.root)
    expect(view.container.textContent ?? '').toContain('没有提供设置远端')
  })
})
