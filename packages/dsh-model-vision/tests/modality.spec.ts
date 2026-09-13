import { describe, expect, it } from 'vitest'
import {
  inspectRoute,
  modalityFieldOf,
  modalitiesFor,
  planWrite,
  stateOfDeclared,
} from '../src/core/modality.ts'

describe('modalityFieldOf', () => {
  it('maps each provider namespace to the field its adapter schema actually declares', () => {
    // llm-pi-ai 的模型条目 schema 是 input；写 inputModalities 会被 schema 拒绝。
    expect(modalityFieldOf('llm-pi-ai')).toBe('input')
    // llm-deepseek 是 inputModalities。
    expect(modalityFieldOf('llm-deepseek')).toBe('inputModalities')
  })

  it('falls back for an unknown namespace instead of throwing', () => {
    expect(modalityFieldOf('llm-something-else')).toBe('inputModalities')
  })
})

describe('stateOfDeclared', () => {
  it('treats an absent or empty declaration as inherit', () => {
    expect(stateOfDeclared(undefined)).toBe('inherit')
    expect(stateOfDeclared([])).toBe('inherit')
    expect(stateOfDeclared('text')).toBe('inherit')
  })

  it('reads text-only and image declarations', () => {
    expect(stateOfDeclared(['text'])).toBe('text')
    expect(stateOfDeclared(['text', 'image'])).toBe('text+image')
    expect(stateOfDeclared(['image'])).toBe('text+image')
  })
})

describe('modalitiesFor', () => {
  it('returns undefined for inherit so the writer deletes the field', () => {
    expect(modalitiesFor('inherit')).toBeUndefined()
    expect(modalitiesFor('text')).toEqual(['text'])
    expect(modalitiesFor('text+image')).toEqual(['text', 'image'])
  })
})

const PI_AI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'

/** 用户层没声明 models 时，llm-pi-ai 的 provider 配置。 */
const piAiResolved = {
  providers: {
    baizhi: {
      models: [
        { id: 'deepseek-flash', name: 'deepseek-flash' },
        { id: 'deepseek-vision', name: 'vision', input: ['text', 'image'] },
      ],
    },
  },
}

describe('inspectRoute', () => {
  it('prefers the user layer so resolved defaults never get baked into the document', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'baizhi'],
      writable: true,
      revision: 4,
      userSection: { providers: { baizhi: { models: [{ id: 'deepseek-flash' }] } } },
      resolvedSection: piAiResolved,
    })

    expect(view.problem).toBeUndefined()
    expect(view.materializes).toBe(false)
    expect(view.writeModels).toEqual([{ id: 'deepseek-flash' }])
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0].id).toBe('deepseek-flash')
    expect(view.entries[0].declared).toBe('inherit')
    // 设置层与用户层都没声明 input，解析值也是「未声明」。目录带来的真实能力
    // 由适配器在解析模型时叠加，不在设置文档里，所以这里不冒充「生效值」。
    expect(view.entries[0].effective).toBe('inherit')
  })

  it('separates the user declaration from the resolved document value', () => {
    const view = inspectRoute({
      ns: DEEPSEEK,
      settingsPath: [],
      writable: true,
      revision: 1,
      userSection: {},
      resolvedSection: { models: [{ id: 'v', inputModalities: ['text'] }] },
    })

    // 用户层没写，解析层（schema 默认）给了纯文本：declared 是「未声明」，
    // effective 才是文档解析出的值。
    expect(view.entries[0].declared).toBe('inherit')
    expect(view.entries[0].effective).toBe('text')
  })

  it('materializes the resolved model list when the user declared none', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'baizhi'],
      writable: true,
      revision: 1,
      userSection: {},
      resolvedSection: piAiResolved,
    })

    expect(view.materializes).toBe(true)
    expect(view.entries.map((entry) => entry.id)).toEqual(['deepseek-flash', 'deepseek-vision'])
    expect(view.entries[1].effective).toBe('text+image')
  })

  it('reads modelOverrides when the route declares no models list', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'gateway'],
      writable: true,
      revision: 2,
      userSection: {},
      resolvedSection: {
        providers: { gateway: { modelOverrides: { 'gpt-4o': { input: ['text', 'image'] } } } },
      },
    })

    expect(view.entries).toEqual([
      { id: 'gpt-4o', kind: 'modelOverrides', index: -1, declared: 'inherit', effective: 'text+image' },
    ])
  })

  it('refuses to offer edits when models and modelOverrides are both declared', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'broken'],
      writable: true,
      revision: 3,
      userSection: {
        providers: { broken: { models: [{ id: 'a' }], modelOverrides: { b: {} } } },
      },
      resolvedSection: {},
    })

    expect(view.problem).toContain('modelOverrides')
  })

  it('reports a problem instead of throwing when the provider is unknown', () => {
    const view = inspectRoute({
      ns: DEEPSEEK,
      settingsPath: [],
      writable: true,
      revision: 0,
      userSection: undefined,
      resolvedSection: undefined,
    })

    expect(view.entries).toEqual([])
    expect(view.problem).toBeDefined()
  })
})

describe('planWrite', () => {
  it('writes the whole models array because a path op cannot index into an array', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'baizhi'],
      writable: true,
      revision: 7,
      userSection: { providers: { baizhi: { models: [{ id: 'a' }, { id: 'b' }] } } },
      resolvedSection: piAiResolved,
    })

    const ops = planWrite(view, view.entries[1], 'text+image')

    expect(ops).toHaveLength(1)
    expect(ops[0].op).toBe('set')
    expect(ops[0].path).toEqual(['providers', 'baizhi', 'models'])
    // 未改动的那一条必须原样保留。
    expect((ops[0] as { value: unknown[] }).value).toEqual([
      { id: 'a' },
      { id: 'b', input: ['text', 'image'] },
    ])
  })

  it('deletes the field for inherit rather than writing an empty array', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'baizhi'],
      writable: true,
      revision: 7,
      userSection: { providers: { baizhi: { models: [{ id: 'a', input: ['text', 'image'] }] } } },
      resolvedSection: piAiResolved,
    })

    const ops = planWrite(view, view.entries[0], 'inherit')

    expect((ops[0] as { value: unknown[] }).value).toEqual([{ id: 'a' }])
  })

  it('strips image request limits when llm-deepseek degrades to text only', () => {
    const view = inspectRoute({
      ns: DEEPSEEK,
      settingsPath: [],
      writable: true,
      revision: 2,
      userSection: {},
      resolvedSection: {
        models: [
          {
            id: 'deepseek-v4-flash-vision-exp',
            inputModalities: ['text', 'image'],
            imagePixelBudget: 640000,
            imageMaxBytes: 1048576,
          },
        ],
      },
    })

    const ops = planWrite(view, view.entries[0], 'text')

    expect(ops[0].path).toEqual(['models'])
    expect((ops[0] as { value: unknown[] }).value).toEqual([
      { id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text'] },
    ])
  })

  it('keeps the image limits when the model still accepts images', () => {
    const view = inspectRoute({
      ns: DEEPSEEK,
      settingsPath: [],
      writable: true,
      revision: 2,
      userSection: {},
      resolvedSection: {
        models: [{ id: 'v', inputModalities: ['text'], imagePixelBudget: 640000 }],
      },
    })

    const ops = planWrite(view, view.entries[0], 'text+image')

    expect((ops[0] as { value: unknown[] }).value).toEqual([
      { id: 'v', inputModalities: ['text', 'image'], imagePixelBudget: 640000 },
    ])
  })

  it('writes modelOverrides by leaf because a dict path is addressable', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'gateway'],
      writable: true,
      revision: 5,
      userSection: {},
      resolvedSection: { providers: { gateway: { modelOverrides: { 'gpt-4o': {} } } } },
    })

    expect(planWrite(view, view.entries[0], 'text+image')).toEqual([
      { op: 'set', path: ['providers', 'gateway', 'modelOverrides', 'gpt-4o', 'input'], value: ['text', 'image'] },
    ])
    expect(planWrite(view, view.entries[0], 'inherit')).toEqual([
      { op: 'unset', path: ['providers', 'gateway', 'modelOverrides', 'gpt-4o', 'input'] },
    ])
  })

  it('never mutates the view it was given', () => {
    const view = inspectRoute({
      ns: PI_AI,
      settingsPath: ['providers', 'baizhi'],
      writable: true,
      revision: 1,
      userSection: { providers: { baizhi: { models: [{ id: 'a' }] } } },
      resolvedSection: {},
    })

    planWrite(view, view.entries[0], 'text+image')

    expect(view.writeModels).toEqual([{ id: 'a' }])
  })
})
