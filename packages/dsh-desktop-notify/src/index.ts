/**
 * host 半区：通知的后端探测、投递与触发。
 *
 * ## 投递架构
 *
 * 通知的归属身份由**可执行文件路径**决定（CoreFoundation 从
 * `…/X.app/Contents/MacOS/<exe>` 向上找到最近的 `Contents/Info.plist`），所以投递
 * 固定走一条子进程：
 *
 *     ELECTRON_RUN_AS_NODE=1 <DSH Desktop 主二进制> -e <runner>
 *                                        └─ require(notify.node) → UNUserNotificationCenter
 *                                             └─ 身份 = io.dsh.desktop
 *
 * 不能图省事在 harness 进程里直接调 addon：那个进程的身份是
 * `io.dsh.desktop.helper`，通知会显示成「DSH Desktop Helper」，而且换不回主 app 的
 * 图标。也不能用系统 `node`：没有 bundle 身份时 `UNUserNotificationCenter` 会抛异常
 * 并 SIGABRT 打死整个进程。实测子进程开销 70–100ms，每条通知起一个可接受。
 *
 * ## 三条来自实测的硬约束
 *
 * 1. **身份守卫**：addon 在碰 UN 框架之前先查 `bundleIdentifier`，没有身份就返回
 *    错误。缺这道守卫，一次调用能把整个宿主进程打死（实测 exit 134）。
 * 2. **`addNotificationRequest` 会骗人**：未授权时它照样回调成功，通知进通知中心
 *    但不弹横幅、不响。所以每次投递都把 `alertSetting`/`soundSetting` 的真实读数
 *    写进设置，让界面看得见 —— 否则用户遇到的就是「装了、不报错、就是不弹」。
 * 3. **firehose 是 live-only**：`session/event` 不回放构造种子（resume / fork / 重放
 *    的事件不会广播）。好处是免费幂等；代价是插件重载后每会话状态丢失且无法重建，
 *    所以那份状态只是内存里的尽力而为，不承诺持久。
 *
 * @module @lixklv/dsh-desktop-notify
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { coerceConfig, type NotifyConfig } from './core/config.ts'
import {
  detailOf,
  executableNameOf,
  outerContentsOf,
  parseAddonResult,
  type AddonResult,
  type BackendStatus,
  type NotifyPayload,
} from './core/delivery.ts'
import { NOTIFY_TOOL_NAME, PLUGIN_ID, SETTINGS_NAMESPACE } from './core/namespace.ts'
import { initialSessionState, planEvent, type NotifyIntent, type SessionState } from './core/trigger.ts'

/** 单次子进程调用的超时。正常 70–100ms，给足余量但不无限等。 */
const CALL_TIMEOUT_MS = 15_000

/** 两条通知之间的最小间隔，抑制事件风暴导致的连环弹窗。 */
const MIN_GAP_MS = 300

/** 内存里跟踪的会话状态上限，超过就丢最旧的。 */
const SESSION_STATE_CAP = 128

/** 状态写回设置的最小间隔。 */
const STATUS_WRITE_GAP_MS = 1_000

/** 在子进程里跑的 runner。参数全走环境变量，杜绝 shell 引号问题。 */
const RUNNER_SOURCE = [
  "const addon = require(process.env.DSH_NOTIFY_ADDON)",
  "const raw = process.env.DSH_NOTIFY_PAYLOAD",
  "const result = process.env.DSH_NOTIFY_OP === 'status'",
  "  ? addon.status()",
  "  : addon.send(raw ? JSON.parse(raw) : undefined)",
  "process.stdout.write(JSON.stringify(result))",
].join('\n')

/** 投递后端：把「主二进制 + addon」这一对固定下来。 */
interface Backend {
  binary: string
  addon: string
}

/** 本插件设置命名空间的形状。`status` 由 host 写入，界面只读。 */
const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  onTurnEnd: Schema.boolean().default(true),
  onTurnFailed: Schema.boolean().default(true),
  onQuestion: Schema.boolean().default(true),
  onApproval: Schema.boolean().default(true),
  includeSummary: Schema.boolean().default(true),
  sound: Schema.boolean().default(true),
  /**
   * 界面「发送测试通知」按钮的触发位：客户端把它写成一个新的时间戳，
   * host 在 `watch` 回调里发现它变了就发一条测试通知。
   * 这是复用现有设置通道、不新增传输层的做法（第三方包加不了新的 Remote 命名空间）。
   */
  testAt: Schema.number().default(0),
  status: Schema.object({
    kind: Schema.string().default('unavailable'),
    identity: Schema.string().default(''),
    detail: Schema.string().default('尚未探测。'),
    lastAt: Schema.string().default(''),
    /** 系统层面的授权与提醒设置读数；未探测过时为 -1。 */
    authorizationStatus: Schema.number().default(-1),
    alertSetting: Schema.number().default(-1),
    soundSetting: Schema.number().default(-1),
  }).default({
    kind: 'unavailable',
    identity: '',
    detail: '尚未探测。',
    lastAt: '',
    authorizationStatus: -1,
    alertSetting: -1,
    soundSetting: -1,
  }),
})

/** 本插件用到的设置句柄面（服务类型不铺到函数签名里）。 */
interface SettingsScopeLike {
  get(): unknown
  update(patch: object): Promise<void>
  watch(callback: () => void): () => void
}

/** 把任意抛出物转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 cordis 容器里取一个**可能不存在**的服务。
 *
 * 用惰性解析而不是 `inject` 硬依赖：某些 profile（headless / 精简装配）没有
 * sessionProjections，硬依赖会让插件永久停在等待态，表现是「装上了、不报错、
 * 就是没通知」。拿不到就降级（标题退回兜底），而不是整个插件不工作。
 * @param ctx - 任意 cordis 上下文。
 * @param name - 服务名。
 * @returns 服务实例，不存在时 undefined。
 */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  const value = getter.call(ctx, name)
  return value === null || value === undefined ? undefined : (value as T)
}

/** 读界面写下的测试触发位。 */
function testAtOf(scope: SettingsScopeLike): number {
  const value = scope.get() as { testAt?: unknown } | undefined
  return typeof value?.testAt === 'number' ? value.testAt : 0
}

/** 本包在磁盘上的目录，用来定位 `lib/notify.node`。 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 定位投递后端。
 *
 * 主二进制从 `process.execPath`（harness 是 `…/Frameworks/DSH Desktop Helper.app/…`）
 * 推出外层 app 的 `Contents`，再按 `Info.plist` 的 `CFBundleExecutable` 拼出来。
 * 全程无硬编码，换安装位置或改名都不受影响。
 * @returns 后端；任一环节不成立都返回 undefined。
 */
function locateBackend(): Backend | undefined {
  if (process.platform !== 'darwin') return undefined

  const addon = join(PACKAGE_DIR, 'notify.node')
  if (!existsSync(addon)) return undefined

  const contents = outerContentsOf(process.execPath)
  if (contents === undefined) return undefined

  const plistPath = join(contents, 'Info.plist')
  if (!existsSync(plistPath)) return undefined

  let name: string | undefined
  try {
    name = executableNameOf(readFileSync(plistPath, 'utf8'))
  } catch {
    return undefined
  }
  if (name === undefined) return undefined

  const binary = join(contents, 'MacOS', name)
  return existsSync(binary) ? { binary, addon } : undefined
}

/**
 * 后端不可用的原因文案。宁可说清楚为什么，也不要静默什么都不做。
 * @returns 可展示的原因。
 */
function backendReason(): string {
  if (process.platform !== 'darwin') return '本插件只在 macOS 上投递系统通知。'
  if (!existsSync(join(PACKAGE_DIR, 'notify.node'))) {
    return '缺少原生投递层 lib/notify.node（构建时未生成？）。'
  }
  if (outerContentsOf(process.execPath) === undefined) {
    return '当前 host 不是从 DSH Desktop 的 Electron helper 启动的，拿不到通知身份。'
  }
  return '找不到 DSH Desktop 主二进制，无法投递通知。'
}

/** 通知引擎。 */
interface Engine {
  config(): NotifyConfig
  probe(): Promise<BackendStatus>
  deliver(payload: NotifyPayload): Promise<{ ok: boolean; error?: string; identity?: string }>
  onSessionEvent(sessionId: string, session: unknown, event: unknown): void
  dispose(): void
}

/**
 * 造一个「按会话对象读当前标题」的读取器。
 *
 * 为什么需要它：`session/title` 是会话早期写的事件，harness 重启后整份日志变成
 * **构造种子**，而 firehose 的契约是 *constructor seeds do not emit* —— 于是插件
 * 重载后对已有会话一无所知，通知标题会退化成兜底的「DSH」。官方的 `title` 投影
 * 是从完整日志（含种子）派生的，所以这里主动读它把标题补回来。
 *
 * 服务拿不到或读失败时返回空串：标题拿不到不该导致不发通知。
 * @param ctx - host 上下文。
 * @returns 读取器。
 */
export function makeTitleReader(ctx: Context): (session: unknown) => string {
  return (session: unknown): string => {
    if (session === null || typeof session !== 'object') return ''
    const projections = serviceOf<{ stateOf(session: unknown, key: string): unknown }>(
      ctx,
      'sessionProjections',
    )
    if (projections === undefined) return ''
    try {
      const value = projections.stateOf(session, 'title')
      return typeof value === 'string' ? value.trim() : ''
    } catch {
      return ''
    }
  }
}

/**
 * 组装通知引擎。
 * @param ctx - host 上下文（用于日志）。
 * @param scope - 本插件的设置句柄。
 * @param titleOf - 按会话对象读当前标题；事件流里攒不到时的兜底来源。
 * @returns 引擎。
 */
function createEngine(
  ctx: Context,
  scope: SettingsScopeLike,
  titleOf: (session: unknown) => string,
): Engine {
  let backend = locateBackend()
  let lastDeliveryAt = 0
  let lastStatusWriteAt = 0
  let live: ChildProcess[] = []
  let sessions = new Map<string, SessionState>()

  const initial = locateBackend()
  let status: BackendStatus = {
    kind: initial === undefined ? 'unavailable' : 'desktop-addon',
    identity: '',
    detail: initial === undefined ? backendReason() : '',
    lastAt: '',
    authorizationStatus: -1,
    alertSetting: -1,
    soundSetting: -1,
  }

  /** 把状态写回设置，供浏览器半区读取。带限流；失败不影响通知本身。 */
  const publishStatus = async (force: boolean): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastStatusWriteAt < STATUS_WRITE_GAP_MS) return
    lastStatusWriteAt = now
    try {
      await scope.update({ status: { ...status } })
    } catch (error) {
      ctx.logger.debug(`${PLUGIN_ID}: 状态写回失败：${messageOf(error)}`)
    }
  }

  const config = (): NotifyConfig => coerceConfig(scope.get())

  /** 在子进程里跑一次 addon 调用。 */
  const runAddon = (
    op: 'send' | 'status',
    payload?: NotifyPayload,
  ): Promise<{ raw: AddonResult | undefined; stderr: string }> =>
    new Promise((resolve) => {
      const target = backend
      if (target === undefined) {
        resolve({ raw: undefined, stderr: '' })
        return
      }
      const child = spawn(target.binary, ['-e', RUNNER_SOURCE], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_NOTIFY_ADDON: target.addon,
          DSH_NOTIFY_OP: op,
          ...(payload === undefined ? {} : { DSH_NOTIFY_PAYLOAD: JSON.stringify(payload) }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      live.push(child)

      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: { raw: AddonResult | undefined; stderr: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        live = live.filter((candidate) => candidate !== child)
        resolve(result)
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ raw: undefined, stderr: `调用超时（${CALL_TIMEOUT_MS}ms）。` })
      }, CALL_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        finish({ raw: undefined, stderr: `无法启动投递进程：${messageOf(error)}` })
      })
      child.on('close', () => {
        finish({ raw: parseAddonResult(stdout), stderr })
      })
    })

  /**
   * 用一次 addon 结果刷新状态。
   * @param raw - addon 的解析结果。
   * @param stderr - 子进程的 stderr。
   * @param at - 本次调用的时间；探测不是投递，调用方传原值。
   * @param op - 本次调用的是 `send` 还是 `status`（两者返回形状不同，判定必须分开）。
   */
  const absorb = (
    raw: AddonResult | undefined,
    stderr: string,
    at: string,
    op: 'send' | 'status',
  ): void => {
    status = {
      kind: 'desktop-addon',
      identity: raw?.bundleId ?? status.identity,
      detail: detailOf(raw, stderr, op),
      lastAt: at,
      authorizationStatus: raw?.authorizationStatus ?? status.authorizationStatus,
      alertSetting: raw?.alertSetting ?? status.alertSetting,
      soundSetting: raw?.soundSetting ?? status.soundSetting,
    }
  }

  const deliver = async (
    payload: NotifyPayload,
  ): Promise<{ ok: boolean; error?: string; identity?: string }> => {
    if (backend === undefined) {
      backend = locateBackend()
      if (backend === undefined) {
        const error = backendReason()
        status = { ...status, kind: 'unavailable', detail: error, lastAt: new Date().toISOString() }
        await publishStatus(true)
        return { ok: false, error }
      }
    }

    const { raw, stderr } = await runAddon('send', payload)
    absorb(raw, stderr, new Date().toISOString(), 'send')
    await publishStatus(true)

    return status.detail === ''
      ? { ok: true, ...(status.identity === '' ? {} : { identity: status.identity }) }
      : { ok: false, error: status.detail }
  }

  const probe = async (): Promise<BackendStatus> => {
    backend = locateBackend()
    if (backend === undefined) {
      status = { ...status, kind: 'unavailable', detail: backendReason() }
      await publishStatus(true)
      return status
    }
    const { raw, stderr } = await runAddon('status')
    absorb(raw, stderr, status.lastAt, 'status')
    await publishStatus(true)
    return status
  }

  /** 限流后投递一条通知意图。 */
  const dispatch = async (intent: NotifyIntent): Promise<void> => {
    const now = Date.now()
    if (now - lastDeliveryAt < MIN_GAP_MS) {
      ctx.logger.debug(`${PLUGIN_ID}: 抑制过密通知（${intent.kind}）。`)
      return
    }
    lastDeliveryAt = now
    const result = await deliver({ title: intent.title, body: intent.body, sound: config().sound })
    if (!result.ok) {
      ctx.logger.warn(`${PLUGIN_ID}: ${intent.kind} 未送达：${result.error ?? '未知原因'}`)
    }
  }

  const onSessionEvent = (sessionId: string, session: unknown, event: unknown): void => {
    const previous = sessions.get(sessionId) ?? initialSessionState()
    let planned: { state: SessionState; intents: NotifyIntent[] }
    try {
      planned = planEvent(previous, event as { type?: unknown; data?: unknown }, config())
    } catch (error) {
      // 事件形状不可信（上游可能改结构）；一条失败不该拖垮整条 firehose。
      ctx.logger.debug(`${PLUGIN_ID}: 事件处理失败：${messageOf(error)}`)
      return
    }
    sessions.set(sessionId, planned.state)
    if (sessions.size > SESSION_STATE_CAP) {
      const oldest = sessions.keys().next()
      if (oldest.done !== true) sessions.delete(oldest.value)
    }

    // 触发时才解析标题：事件流里攒到就用它；为空（插件重载后必然如此，因为
    // session/title 属于构造种子、不上 firehose）才主动读官方的 title 投影补上。
    const title = planned.state.title.trim() !== '' ? planned.state.title : titleOf(session)

    for (const intent of planned.intents) {
      void dispatch(title === '' ? intent : { ...intent, title })
    }
  }

  return {
    config,
    probe,
    deliver,
    onSessionEvent,
    dispose: () => {
      for (const child of live) child.kill('SIGKILL')
      live = []
      sessions.clear()
    },
  }
}

/**
 * 挂载 host 半区。
 * @param ctx - host 上下文。
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, {
      applies: 'live',
    }) as unknown as SettingsScopeLike
    const engine = createEngine(settingsCtx, scope, makeTitleReader(settingsCtx))

    settingsCtx.effect(() => {
      void engine.probe().catch((error: unknown) => {
        settingsCtx.logger.warn(`${PLUGIN_ID}: 后端探测失败：${messageOf(error)}`)
      })
      return () => engine.dispose()
    }, `${PLUGIN_ID}:probe`)

    // ── 界面的「发送测试通知」按钮 ────────────────────────────────────────────
    // 客户端不能直接调 host（第三方包加不了 Remote 命名空间），所以约定：客户端把
    // testAt 写成一个新的时间戳，这里发现它变了就发一条测试通知，结果照常写回 status。
    settingsCtx.effect(() => {
      let seen = testAtOf(scope)
      const unwatch = scope.watch(() => {
        const current = testAtOf(scope)
        if (current === seen) return
        seen = current
        void engine
          .deliver({
            title: 'DSH 测试通知',
            body: '如果你看到这条，说明系统通知链路是通的。',
            sound: engine.config().sound,
          })
          .catch((error: unknown) => {
            settingsCtx.logger.warn(`${PLUGIN_ID}: 测试通知失败：${messageOf(error)}`)
          })
      })
      return () => unwatch()
    }, `${PLUGIN_ID}:test`)

    // ── 触发：会话事件 firehose ────────────────────────────────────────────────
    // 回调签名是 (session, event)。listener 由 cordis 在插件卸载时回收。
    settingsCtx.on('session/event', (session: unknown, event: unknown) => {
      const id =
        session !== null && typeof session === 'object'
          ? String((session as { id?: unknown }).id ?? '')
          : ''
      engine.onSessionEvent(id === '' ? '(unknown)' : id, session, event)
    })

    // ── 模型可调用的工具 ──────────────────────────────────────────────────────
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(
        () =>
          toolCtx.tools.register(
            defineTool({
              name: NOTIFY_TOOL_NAME,
              description:
                'Send a native macOS notification to the user. Use it when the user asks to be notified, or when a long-running result is worth surfacing outside the GUI. Keep the title short; one sentence for the body.',
              parameters: {
                title: {
                  type: 'string',
                  required: true,
                  description: 'Notification title, short (roughly 20 characters).',
                },
                body: { type: 'string', description: 'Notification body, one sentence.' },
                sound: {
                  type: 'boolean',
                  description: 'Play the default sound. Defaults to the plugin setting.',
                },
              },
              output: {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ok: { type: 'boolean', required: true },
                    identity: { type: 'string' },
                    error: { type: 'string' },
                  },
                },
                render: (_args, value) => [
                  {
                    type: 'text' as const,
                    text: value.ok
                      ? `已投递系统通知${value.identity === undefined ? '' : `（身份 ${value.identity}）`}。`
                      : `通知未送达：${value.error ?? '未知原因'}`,
                  },
                ],
              },
              isConcurrencySafe: () => true,
              execute: async (args) => {
                const outcome = await engine.deliver({
                  title: args.title,
                  body: args.body ?? '',
                  sound: args.sound ?? engine.config().sound,
                })
                return {
                  ok: outcome.ok,
                  ...(outcome.identity === undefined ? {} : { identity: outcome.identity }),
                  ...(outcome.error === undefined ? {} : { error: outcome.error }),
                }
              },
            }),
          ),
        `${PLUGIN_ID}:tool`,
      )
    })

    // ── /notify 命令：没有界面时的入口，也是排查现场的手段 ────────────────────
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(
        () =>
          commandCtx.commands.register({
            name: 'notify',
            description: '查看通知后端状态，或发一条测试通知',
            input: { hint: 'status | test [标题] [正文]' },
            handler: async (invocation: { rawInput: string }) => {
              const parts = invocation.rawInput.trim().split(/\s+/).filter((part) => part !== '')
              const action = (parts[0] ?? 'status').toLowerCase()

              if (action === 'status') {
                const current = await engine.probe()
                const cfg = engine.config()
                return {
                  kind: 'success' as const,
                  text: [
                    `后端：${current.kind}${current.identity === '' ? '' : `（身份 ${current.identity}）`}`,
                    `总开关：${cfg.enabled ? '开' : '关'}`,
                    `触发：完成 ${cfg.onTurnEnd ? '开' : '关'} ｜ 异常 ${cfg.onTurnFailed ? '开' : '关'}`
                      + ` ｜ 等待选择 ${cfg.onQuestion ? '开' : '关'} ｜ 等待授权 ${cfg.onApproval ? '开' : '关'}`,
                    current.detail === '' ? '状态：正常' : `问题：${current.detail}`,
                  ].join('\n'),
                }
              }

              if (action === 'test') {
                const title = parts[1] ?? 'DSH 测试通知'
                const body = parts.slice(2).join(' ') || '这是一条测试通知。'
                const result = await engine.deliver({
                  title,
                  body,
                  sound: engine.config().sound,
                })
                return result.ok
                  ? { kind: 'success' as const, text: `已投递（身份 ${result.identity ?? '未知'}）。` }
                  : { kind: 'error' as const, text: `未送达：${result.error ?? '未知原因'}` }
              }

              return { kind: 'error' as const, text: `未知子命令 "${action}"；可用：status | test` }
            },
          }),
        `${PLUGIN_ID}:command`,
      )
    })
  })
}
