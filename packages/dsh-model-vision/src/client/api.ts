/**
 * 设置远端接缝：把 `ctx.remote.settings` 包成这个插件需要的最小面。
 *
 * 这里刻意不 import `@deepseek-ai/dsh-api-remotes`：它在浏览器半区模块表之外，
 * 而 `remote` 本来就已经作为 cordis 服务挂在容器里，`ctx.get` 取即可。
 * 这样客户端 bundle 不需要任何跨包 external，纯度门天然满足。
 *
 * 远端方法返回的是**结果信封**（`{ ok: true, value }` / `{ ok: false, error }`），
 * 不抛异常，所有调用点都要判 `ok`。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  type ModelEntry,
  type ModalityState,
  type RouteView,
  type SettingsPathOp,
  inspectRoute,
  planWrite,
} from '../core/modality.ts'

/** 远端的统一返回信封。 */
export interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/** 设置命名空间在描述里的视图。 */
export interface NamespaceView {
  ns: string
  value: unknown
  user?: unknown
  applies?: string
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

/** 读取结果：要么给出路由视图，要么给出可直接展示的失败原因。 */
export type LoadResult =
  | { ok: true; view: RouteView; applies: string }
  | { ok: false; message: string }

/** 写入结果。 */
export type WriteResult = { ok: true; view: RouteView; applies: string } | { ok: false; message: string }

/** 从 cordis 容器里取任意服务（服务名不由本包声明，故用局部窄接口）。 */
function serviceOf(ctx: Context, name: string): unknown {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  return getter.call(ctx, name)
}

/**
 * 取根 remote 服务。
 *
 * 事件面（`$on`）只挂在**根** remote 上，嵌套 face 上调用会静默失效，所以订阅一律
 * 走这里。
 * @param ctx - 浏览器半区的 cordis 上下文。
 * @returns 根 remote，或 undefined。
 */
export function remoteRootOf(ctx: Context): unknown {
  return serviceOf(ctx, 'remote')
}

/**
 * 订阅一个 remote 事件。
 * @param ctx - 浏览器半区的 cordis 上下文。
 * @param event - 事件名。
 * @param listener - 回调。
 * @returns 取消订阅的函数；事件面不可用时是空操作。
 */
export function onRemoteEvent(ctx: Context, event: string, listener: () => void): () => void {
  const root = remoteRootOf(ctx) as
    | { $on?: (name: string, handler: (...args: unknown[]) => void) => () => void }
    | undefined
  if (typeof root?.$on !== 'function') return () => undefined
  const disposer = root.$on(event, () => {
    listener()
  })
  return typeof disposer === 'function' ? disposer : () => undefined
}

/**
 * 取设置远端服务。
 * @param ctx - 浏览器半区的 cordis 上下文。
 * @returns 远端面，或 undefined（该部署没挂设置页时）。
 */
export function settingsRemoteOf(ctx: Context): SettingsRemote | undefined {
  const direct = serviceOf(ctx, 'remote.settings')
  if (direct !== undefined && direct !== null) return direct as SettingsRemote
  const remote = serviceOf(ctx, 'remote') as { settings?: SettingsRemote } | undefined
  return remote?.settings
}

/**
 * 读出一个 provider 路由的模态视图。
 * @param remote - 设置远端。
 * @param ns - 设置命名空间。
 * @param settingsPath - 到 provider profile 的路径。
 * @returns 路由视图或失败原因。
 */
export async function loadRoute(
  remote: SettingsRemote,
  ns: string,
  settingsPath: readonly string[],
): Promise<LoadResult> {
  let described: RemoteEnvelope<DescribeValue>
  try {
    described = await remote.describe()
  } catch (error) {
    return { ok: false, message: `无法读取设置：${messageOf(error)}` }
  }
  if (described?.ok !== true || described.value === undefined) {
    return { ok: false, message: described?.error?.message ?? '无法读取设置。' }
  }

  const namespace = described.value.namespaces.find((candidate) => candidate.ns === ns)
  if (namespace === undefined) {
    return { ok: false, message: `设置文档里没有 ${ns} 命名空间。` }
  }

  const view = inspectRoute({
    ns,
    settingsPath,
    writable: described.value.writable === true,
    revision: namespace.revision,
    userSection: namespace.user,
    resolvedSection: namespace.value,
  })

  return { ok: true, view, applies: namespace.applies ?? 'live' }
}

/**
 * 通用写入：规划 op、落盘，冲突时按最新文档重新规划一次。
 *
 * 重试必须**重新规划**而不是复用 op：冲突意味着文档已经变了，旧下标可能已经指向
 * 另一个模型，直接重放会写错对象。
 * @param remote - 设置远端。
 * @param view - 当前路由视图。
 * @param plan - 用最新视图规划 op 的回调；返回 null 表示目标已不在文档里。
 * @param missing - plan 返回 null 时展示的原因。
 * @returns 写入后的最新视图或失败原因。
 */
async function commit(
  remote: SettingsRemote,
  view: RouteView,
  plan: (current: RouteView) => SettingsPathOp[] | null,
  missing: string,
): Promise<WriteResult> {
  const attempt = async (current: RouteView): Promise<RemoteEnvelope<NamespaceView>> => {
    const ops = plan(current)
    if (ops === null) return { ok: false, error: { code: 'target-missing', message: missing } }
    try {
      return await remote.mutate(current.ns, ops, current.revision)
    } catch (error) {
      return { ok: false, error: { code: 'write-threw', message: `写入失败：${messageOf(error)}` } }
    }
  }

  let result = await attempt(view)

  // 冲突：文档在读取之后被别人改过，重读一次再重新规划。
  if (result.ok !== true && result.error?.code === 'settings/conflict') {
    const reloaded = await loadRoute(remote, view.ns, view.settingsPath)
    if (reloaded.ok) result = await attempt(reloaded.view)
  }

  if (result.ok !== true) return { ok: false, message: result.error?.message ?? '写入被拒绝。' }

  const reloaded = await loadRoute(remote, view.ns, view.settingsPath)
  return reloaded.ok
    ? { ok: true, view: reloaded.view, applies: reloaded.applies }
    : { ok: false, message: reloaded.message }
}

/** 在最新视图里按 id 与声明位置定位条目。 */
function entryOf(
  view: RouteView,
  modelId: string,
  kind: 'models' | 'modelOverrides',
): ModelEntry | undefined {
  return view.entries.find((candidate) => candidate.id === modelId && candidate.kind === kind)
}

/**
 * 写入一次模态三态修改。
 * @param remote - 设置远端。
 * @param view - 当前路由视图。
 * @param modelId - 目标模型 id。
 * @param kind - 目标模型声明在 `models` 还是 `modelOverrides`。
 * @param state - 目标三态。
 * @returns 写入后的最新视图或失败原因。
 */
export async function writeModality(
  remote: SettingsRemote,
  view: RouteView,
  modelId: string,
  kind: 'models' | 'modelOverrides',
  state: ModalityState,
): Promise<WriteResult> {
  return commit(
    remote,
    view,
    (current) => {
      const entry = entryOf(current, modelId, kind)
      return entry === undefined ? null : planWrite(current, entry, state)
    },
    `模型 ${modelId} 已不在设置中，请刷新后重试。`,
  )
}

/** 把任意抛出物转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
