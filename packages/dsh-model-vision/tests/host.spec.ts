import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

describe('dsh-model-vision host half', () => {
  it('loads without host-side services', () => {
    // host 半区当前是空实现：它必须能在没有任何服务可注入的情况下被 loader 调用。
    expect(() => apply({} as Context)).not.toThrow()
  })
})
