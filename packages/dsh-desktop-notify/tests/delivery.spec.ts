/**
 * 投递层纯逻辑的用例：路径推导、结果解析、人读文案，以及摘要截断。
 *
 * 路径推导值得单独测，因为它是"通知身份"的唯一来源——推错了就会去执行一个不存在的
 * 二进制，或者更糟：推到一个**存在但没有 bundle 身份**的进程上，那样调用会把宿主
 * 打死。所以这里对形状的要求是严格的：不符就返回 undefined，绝不猜。
 */
import { describe, expect, it } from 'vitest'
import {
  describeAuthorization,
  describeToggle,
  detailOf,
  executableNameOf,
  outerContentsOf,
  outcomeOf,
  parseAddonResult,
  unknownStatus,
} from '../src/core/delivery.ts'
import { assistantTextOf, summarize } from '../src/core/summary.ts'

/** 实测的 harness 可执行文件路径。 */
const HELPER_EXEC =
  '/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper'

describe('outerContentsOf', () => {
  it('从真实的 helper 路径推出外层 app 的 Contents', () => {
    expect(outerContentsOf(HELPER_EXEC)).toBe('/Applications/DSH Desktop.app/Contents')
  })

  it('安装路径带空格与中文也能推对', () => {
    const path =
      '/Users/张三/我的 应用/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper'
    expect(outerContentsOf(path)).toBe('/Users/张三/我的 应用/DSH Desktop.app/Contents')
  })

  it('形状不符一律返回 undefined，不猜', () => {
    const bad = [
      '',
      '/usr/bin/node',
      '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
      // MacOS 段不对
      '/Applications/Foo.app/Contents/Frameworks/Bar.app/Contents/Bin/exe',
      // 外层不是 .app
      '/Applications/Foo/Contents/Frameworks/Bar.app/Contents/MacOS/exe',
      // 中间不是 Frameworks
      '/Applications/Foo.app/Contents/Plugins/Bar.app/Contents/MacOS/exe',
      // 段数不够
      '/a/b/c',
    ]
    for (const path of bad) expect(outerContentsOf(path)).toBeUndefined()
  })
})

describe('executableNameOf', () => {
  it('取出 CFBundleExecutable', () => {
    const plist =
      '<?xml version="1.0"?><plist><dict>'
      + '<key>CFBundleIdentifier</key><string>io.dsh.desktop</string>'
      + '<key>CFBundleExecutable</key><string>DSH Desktop</string>'
      + '</dict></plist>'
    expect(executableNameOf(plist)).toBe('DSH Desktop')
  })

  it('缺键或空值时返回 undefined', () => {
    expect(executableNameOf('<plist></plist>')).toBeUndefined()
    expect(
      executableNameOf('<key>CFBundleExecutable</key><string>   </string>'),
    ).toBeUndefined()
  })
})

describe('parseAddonResult', () => {
  it('解析正常的一行 JSON', () => {
    expect(parseAddonResult('{"ok":true,"bundleId":"io.dsh.desktop"}')).toEqual({
      ok: true,
      bundleId: 'io.dsh.desktop',
    })
  })

  it('只取最后一行，忽略前面的噪声', () => {
    expect(parseAddonResult('warning: something\n{"ok":true}')).toEqual({ ok: true })
  })

  it('坏输入返回 undefined 而不抛', () => {
    expect(parseAddonResult('')).toBeUndefined()
    expect(parseAddonResult('   ')).toBeUndefined()
    expect(parseAddonResult('not json')).toBeUndefined()
    expect(parseAddonResult('42')).toBeUndefined()
    expect(parseAddonResult('null')).toBeUndefined()
  })
})

describe('outcomeOf', () => {
  it('成功时带出身份', () => {
    expect(outcomeOf({ ok: true, bundleId: 'io.dsh.desktop' }, '')).toEqual({
      ok: true,
      identity: 'io.dsh.desktop',
    })
  })

  it('失败时用 addon 的 error', () => {
    const outcome = outcomeOf({ ok: false, error: 'no-bundle-identity' }, '')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('no-bundle-identity')
  })

  it('没有可解析结果时退回 stderr 的最后一行', () => {
    const outcome = outcomeOf(undefined, 'line one\n真正的错误')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('真正的错误')
  })

  it('stderr 也是空时给一句可读的话', () => {
    expect(outcomeOf(undefined, '').error).toBe('投递进程没有返回可解析的结果。')
  })
})

describe('detailOf：send 与 status 的返回形状不同', () => {
  it('成功的探测必须报正常，不能报投递失败', () => {
    // 回归用例。status() 的返回里**没有** ok 字段；曾经用统一的 outcomeOf 判定，
    // 于是每次成功的探测都被误报成"投递失败"，界面一直是红的。
    const probeResult = {
      bundleId: 'io.dsh.desktop',
      authorizationStatus: 2,
      alertSetting: 2,
      soundSetting: 2,
      alertStyle: 1,
    }
    expect(detailOf(probeResult, '', 'status')).toBe('')
  })

  it('探测到横幅被关时给出可操作的提示', () => {
    const probeResult = { bundleId: 'io.dsh.desktop', authorizationStatus: 1, alertSetting: 0 }
    expect(detailOf(probeResult, '', 'status')).toContain('横幅与声音被关')
  })

  it('成功的投递报正常', () => {
    expect(detailOf({ bundleId: 'io.dsh.desktop', ok: true, alertSetting: 2 }, '', 'send')).toBe('')
  })

  it('投递返回 ok:false 时带出 addon 的错误', () => {
    expect(
      detailOf({ bundleId: 'io.dsh.desktop', ok: false, error: 'UNErrorDomain code=1' }, '', 'send'),
    ).toBe('UNErrorDomain code=1')
  })

  it('身份守卫拒绝时说明拿不到身份', () => {
    expect(detailOf({ bundleId: '', ok: false, error: 'no-bundle-identity' }, '', 'send')).toBe(
      'no-bundle-identity',
    )
    // 连 error 都没有时也要给一句人话：空串会被当成"一切正常"。
    expect(detailOf({ bundleId: '' }, '', 'status')).not.toBe('')
  })

  it('没有可解析结果时退回 stderr 的最后一行', () => {
    expect(detailOf(undefined, '一堆噪声\n真正的原因', 'send')).toBe('真正的原因')
    expect(detailOf(undefined, '', 'send')).not.toBe('')
  })
})

describe('人读文案', () => {
  it('授权状态', () => {
    expect(describeAuthorization(1)).toContain('拒绝')
    expect(describeAuthorization(2)).toBe('已授权')
    expect(describeAuthorization(-1)).toContain('未知')
  })

  it('开关状态', () => {
    expect(describeToggle(0)).toBe('不支持')
    expect(describeToggle(1)).toBe('已关闭')
    expect(describeToggle(2)).toBe('已开启')
  })

  it('初始状态是未探测而不是误报正常', () => {
    const status = unknownStatus()
    expect(status.kind).toBe('unavailable')
    expect(status.authorizationStatus).toBe(-1)
    expect(status.alertSetting).toBe(-1)
  })
})

describe('摘要', () => {
  it('折行、折叠空白', () => {
    expect(summarize('第一行\n\n第二行   带空格')).toBe('第一行 第二行 带空格')
  })

  it('超长按码点截断，不切坏代理对', () => {
    const text = '🐳'.repeat(50)
    const result = summarize(text, 10)
    expect([...result]).toHaveLength(11) // 10 个码点 + 省略号
    expect(result.endsWith('…')).toBe(true)
    // 每个码点都完整（没有被切成孤立代理项）。
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('assistantTextOf 只用 text 块', () => {
    expect(
      assistantTextOf([
        { type: 'reasoning', text: '推理' },
        { type: 'text', text: '正文甲' },
        { type: 'tool-call', name: 'bash' },
        { type: 'text', text: '正文乙' },
      ]),
    ).toBe('正文甲\n正文乙')
    expect(assistantTextOf('不是数组')).toBe('')
    expect(assistantTextOf([{ type: 'reasoning', text: '只有推理' }])).toBe('')
  })
})
