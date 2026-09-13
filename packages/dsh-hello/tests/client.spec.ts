import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

/**
 * 最小 cordis 上下文替身：只实现本插件用到的 ctx.effect，
 * 并捕获它注册的 disposer，用来验证卸载路径。
 */
function stubContext(): { ctx: Context; dispose: () => void } {
  let disposers: Array<() => void> = []
  const ctx = {
    effect: (execute: () => () => void) => {
      disposers.push(execute())
    },
  } as unknown as Context
  return {
    ctx,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
      disposers = []
    },
  }
}

describe('dsh-hello client half', () => {
  it('mounts the badge with semantic attributes', () => {
    const { ctx } = stubContext()
    apply(ctx)

    const badge = document.querySelector('[data-dsh-plugin="hello"][data-dsh-part="badge"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('dsh-hello')
    // CSS Modules 已编译出类名（jsdom 下 CSS 可能被 stub 成键名，所以只要求非空）。
    expect((badge as HTMLElement).className.length).toBeGreaterThan(0)

    // 收尾：避免把节点留给下一个用例。
    document.querySelectorAll('[data-dsh-plugin="hello"]').forEach((node) => node.remove())
  })

  it('removes the badge on dispose', () => {
    const { ctx, dispose } = stubContext()
    apply(ctx)
    expect(document.querySelector('[data-dsh-plugin="hello"]')).not.toBeNull()

    dispose()
    expect(document.querySelector('[data-dsh-plugin="hello"]')).toBeNull()
  })
})
