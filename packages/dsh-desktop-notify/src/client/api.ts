/**
 * 浏览器半区的远端接缝：把 `ctx.remote.*` 包成本插件真正需要的那点面。
 *
 * 三条硬约束（都不是本插件能选的）：
 *
 * 1. 客户端能看到的 Remote 命名空间是**构建期**由官方 assembly 生成并写死的，第三方
 *    包加不了自己的命名空间。所以配置读写只能借用已有的 `remote.settings`。
 * 2. 远端方法返回**结果信封**（`{ ok: true, value }` / `{ ok: false, error }`），不抛
 *    异常，所有调用点都要判 `ok`。
 * 3. 服务名**不能**写进插件的 `inject` 硬依赖：一旦某个名字解析不了，cordis 会让插件
 *    永久停在等待态，表现是「装上了、不报错、就是没面板」。所以全部惰性解析。
 *
 * ## 「测试通知」为什么走设置而不是新接口
 *
 * 客户端不能直接调 host 的方法（约束 1）。所以测试按钮做的是**往设置里写一个时间戳**
 * （`testAt`），host 半区 `watch` 到这个值变了就发一条测试通知，并把结果写回 `status`。
 * 整条链路复用同一个设置通道，不引入任何新传输层。
 *
 * @module @lixklv/dsh-desktop-notify/client/api
 */
import type { Context } from '@deepseek-ai/cordis'
import { coerceConfig, type NotifyConfig } from '../core/config.ts'
import type { BackendStatus } from '../core/delivery.ts'

/** 远端的统一返回信封。 */
export interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/** 一条路径编辑。 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** 设置命名空间在描述里的视图。 */
export interface NamespaceView {
  ns: string
  value: unknown
  revision?: number
}

/** `describe` 的返回体。 */
export interface DescribeValue {
  writable: boolean
  hasDocument: boolean
  namespaces: NamespaceView[]
}

/** 本插件用到的设置远端面。 */
export interface SettingsRemote {
  describe(): Promise<RemoteEnvelope<DescribeValue>>
  mutate(
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<RemoteEnvelope<NamespaceView>>
}

/** 从 cordis 容器里取设置远端。 */
export function settingsRemoteOf(ctx: Context): SettingsRemote | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  const direct = getter.call(ctx, 'remote.settings')
  if (direct !== undefined && direct !== null) return direct as SettingsRemote
  const remote = getter.call(ctx, 'remote') as { settings?: SettingsRemote } | undefined
  return remote?.settings
}

/** 把任意抛出物转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** host 写回来的运行期状态，界面只读。 */
export interface StatusView extends BackendStatus {}

/** 从设置值里取状态；形状不符时给一份"尚未探测"。 */
export function statusOf(raw: unknown): StatusView {
  const fallback: StatusView = {
    kind: 'unavailable',
    identity: '',
    detail: '尚未探测。',
    lastAt: '',
    authorizationStatus: -1,
    alertSetting: -1,
    soundSetting: -1,
  }
  if (raw === null || typeof raw !== 'object') return fallback
  const source = (raw as { status?: unknown }).status
  if (source === null || typeof source !== 'object') return fallback
  const status = source as Record<string, unknown>
  const num = (value: unknown, or: number): number => (typeof value === 'number' ? value : or)
  const str = (value: unknown, or: string): string => (typeof value === 'string' ? value : or)
  return {
    kind: status.kind === 'desktop-addon' ? 'desktop-addon' : 'unavailable',
    identity: str(status.identity, ''),
    detail: str(status.detail, ''),
    lastAt: str(status.lastAt, ''),
    authorizationStatus: num(status.authorizationStatus, -1),
    alertSetting: num(status.alertSetting, -1),
    soundSetting: num(status.soundSetting, -1),
  }
}

/** 读取结果。 */
export type ConfigLoad =
  | {
      ok: true
      config: NotifyConfig
      status: StatusView
      /** 当前 `testAt`，测试按钮靠把它改成新时间戳来触发。 */
      testAt: number
      revision: number | undefined
      writable: boolean
    }
  | { ok: false; message: string }

/**
 * 读配置与状态。
 * @param remote - 设置远端。
 * @param namespace - 设置命名空间。
 * @returns 配置、状态、revision 与可写性，或失败原因。
 */
export async function loadConfig(remote: SettingsRemote, namespace: string): Promise<ConfigLoad> {
  let described: RemoteEnvelope<DescribeValue>
  try {
    described = await remote.describe()
  } catch (error) {
    return { ok: false, message: `无法读取设置：${messageOf(error)}` }
  }
  if (described?.ok !== true || described.value === undefined) {
    return { ok: false, message: described?.error?.message ?? '无法读取设置。' }
  }
  const view = described.value.namespaces.find((candidate) => candidate.ns === namespace)
  if (view === undefined) {
    return {
      ok: false,
      message: `设置文档里没有 ${namespace} 命名空间：本插件的 host 半区可能没加载成功。`,
    }
  }
  const testAtRaw = (view.value as { testAt?: unknown } | undefined)?.testAt
  return {
    ok: true,
    config: coerceConfig(view.value),
    status: statusOf(view.value),
    testAt: typeof testAtRaw === 'number' ? testAtRaw : 0,
    revision: view.revision,
    writable: described.value.writable === true,
  }
}

/**
 * 写一组配置字段。
 *
 * 冲突（`settings/conflict`）时重读一次再重试：本插件只写固定的几个路径，重放安全。
 * @param remote - 设置远端。
 * @param namespace - 设置命名空间。
 * @param patch - 要写的字段。
 * @param revision - 读到的 revision。
 * @returns 成功后的最新 revision，或失败原因。
 */
export async function saveConfig(
  remote: SettingsRemote,
  namespace: string,
  patch: Record<string, unknown>,
  revision: number | undefined,
): Promise<{ ok: true; revision: number | undefined } | { ok: false; message: string }> {
  const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({
    op: 'set',
    path: [key],
    value,
  }))

  const attempt = async (
    expected: number | undefined,
  ): Promise<RemoteEnvelope<NamespaceView> | { ok: false; error: { code?: string; message: string } }> => {
    try {
      return await remote.mutate(namespace, ops, expected)
    } catch (error) {
      return { ok: false, error: { message: `写入失败：${messageOf(error)}` } }
    }
  }

  let result = await attempt(revision)
  if (result.ok !== true && result.error?.code === 'settings/conflict') {
    const reloaded = await loadConfig(remote, namespace)
    if (reloaded.ok) result = await attempt(reloaded.revision)
  }
  if (result.ok !== true) {
    return { ok: false, message: result.error?.message ?? '写入被拒绝。' }
  }
  const next = (result.value as NamespaceView | undefined)?.revision
  return { ok: true, revision: next ?? revision }
}
