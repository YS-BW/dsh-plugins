/**
 * 输入模态声明的读写规则：纯逻辑，无 React / cordis / DOM 依赖，供浏览器半区与单测共用。
 *
 * 背景（引擎源码实测，dsh 0.1.5-rc.1）：
 * - 声明字段的**名字逐命名空间不同**。`dsh-llm-pi-ai` 的模型条目 schema 是
 *   `input: z.array(z.union(MODALITIES))`；`dsh-llm-deepseek` 的是
 *   `inputModalities: z.array(z.union(["text","image"])).min(1).default(["text"])`。
 *   `inputModalities` 同时是两个适配器投影出的**运行时** `ModelInfo` 字段，
 *   但它只是 llm-deepseek 的**配置**键——写进 llm-pi-ai 会被 schema 拒绝。
 * - 词表只有 `text` / `image`，且 `.min(1)`：空数组不是合法声明。
 * - llm-pi-ai 里**空数组等价于「未声明」**，解析器据此回落到上层
 *   （`declaredInput()` 把 `[]` 读作「这一层没有答案」）。所以「继承」必须表达为
 *   **删除该字段**，而不是写 `[]`，更不能用布尔勾选。
 * - llm-deepseek 的解析器拒绝「纯文本 + 图片限额」的组合：
 *   `text-only catalog model cannot declare image request limits`。
 *   从图文降级为纯文本时必须一并摘掉 `imagePixelBudget` / `imageMaxBytes`。
 */

/** 各命名空间里声明输入模态的字段名。 */
export const NAMESPACE_MODALITY_FIELD: Readonly<Record<string, string>> = {
  'llm-pi-ai': 'input',
  'llm-deepseek': 'inputModalities',
}

/** 认不出的命名空间按 llm-deepseek 的写法处理（两者中更常见的显式声明式）。 */
export const DEFAULT_MODALITY_FIELD = 'inputModalities'

/**
 * 取某命名空间的模态字段名。
 * @param ns - 设置命名空间，如 `llm-pi-ai`。
 * @returns 该命名空间里声明输入模态的字段名。
 */
export function modalityFieldOf(ns: string): string {
  return NAMESPACE_MODALITY_FIELD[ns] ?? DEFAULT_MODALITY_FIELD
}

/**
 * 用户在 GUI 上的三态选择。
 * - `inherit`：用户层不声明，交给 schema 默认与目录继承。
 * - `text`：显式纯文本。
 * - `text+image`：显式支持图片输入。
 */
export type ModalityState = 'inherit' | 'text' | 'text+image'

/**
 * 把已声明的字段值读成三态。
 * @param declared - 用户层里该字段的原始值。
 * @returns 对应的三态；缺失、空数组或非数组都算 `inherit`。
 */
export function stateOfDeclared(declared: unknown): ModalityState {
  if (!Array.isArray(declared) || declared.length === 0) return 'inherit'
  return declared.includes('image') ? 'text+image' : 'text'
}

/**
 * 把三态翻译成要写入的字段值。
 * @param state - 三态之一。
 * @returns 要写入的模态数组；`inherit` 返回 undefined，表示应当删除该字段。
 */
export function modalitiesFor(state: ModalityState): readonly string[] | undefined {
  if (state === 'text') return ['text']
  if (state === 'text+image') return ['text', 'image']
  return undefined
}

/** 是否为普通数据对象（排除数组、null 与类实例）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 沿路径读一个嵌套值。
 * @param root - 起点。
 * @param path - 逐级键名；空路径返回 root 本身。
 * @returns 读到的值，任一级不是普通对象则为 undefined。
 */
export function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const part of path) {
    if (!isPlainObject(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * 深拷贝一份纯 JSON 数据。
 * @param value - 可被 JSON 表达的值。
 * @returns 拷贝。
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 一处 settings 路径编辑，与 `settings.mutate` 的 op 形状一致。 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** 该 provider 下一个可编辑的模型。 */
export interface ModelEntry {
  /** 模型 id。 */
  id: string
  /** 声明位置：`models` 数组，或 `modelOverrides` 字典。 */
  kind: 'models' | 'modelOverrides'
  /** `models` 数组下标；`modelOverrides` 时无意义。 */
  index: number
  /** 用户层当前声明；`inherit` 表示没有显式声明。 */
  declared: ModalityState
  /** 解析后实际生效的模态，用于展示与「与声明不一致」提示。 */
  effective: ModalityState
}

/** 一个 provider 路由的模态视图。 */
export interface RouteView {
  /** 设置命名空间。 */
  ns: string
  /** 该命名空间里到这个 provider profile 的路径。 */
  settingsPath: readonly string[]
  /** 该命名空间的模态字段名。 */
  field: string
  /** 写入时回传的 revision，用于冲突检测。 */
  revision: number | undefined
  /** 设置文档是否可写。 */
  writable: boolean
  /** 可编辑的模型列表。 */
  entries: ModelEntry[]
  /** 写回 `models` 时使用的完整数组（用户层优先，否则物化解析层）。 */
  writeModels: unknown[]
  /** 为 true 表示用户层没有 `models`，首次写入会把解析层物化进用户层。 */
  materializes: boolean
  /** 无法给出可编辑模型时的原因，供 UI 直接展示。 */
  problem?: string
}

/** {@link inspectRoute} 的输入。 */
export interface InspectRouteInput {
  /** 设置命名空间。 */
  ns: string
  /** 到 provider profile 的路径。 */
  settingsPath: readonly string[]
  /** 设置文档是否可写。 */
  writable: boolean
  /** 命名空间当前 revision。 */
  revision: number | undefined
  /** 用户层 section（descriptor 的 `user`）。 */
  userSection: unknown
  /** 解析后 section（descriptor 的 `value`）。 */
  resolvedSection: unknown
}

/**
 * 读一个条目里的字段值。
 *
 * 对 `unknown` 先做普通对象收窄再取键，否则 TS 会把 `raw[key]` 判成隐式 any。
 * @param raw - 待读条目。
 * @param key - 字段名。
 * @returns 字段值，条目不是普通对象时为 undefined。
 */
function fieldOf(raw: unknown, key: string): unknown {
  return isPlainObject(raw) ? raw[key] : undefined
}

/**
 * 读出一个 provider 路由的模态状态。
 *
 * 用户层优先：用户已经声明过 `models` 时只动他的数组，避免把解析层的默认值
 * 烘焙进设置文档；用户没声明过才物化解析层，否则没有可写的载体。
 * @param input - 命名空间、路径与两层 section。
 * @returns 该路由的模态视图。
 */
export function inspectRoute(input: InspectRouteInput): RouteView {
  const { ns, settingsPath, writable, revision } = input
  const field = modalityFieldOf(ns)
  const userProfile = readPath(input.userSection, settingsPath)
  const resolvedProfile = readPath(input.resolvedSection, settingsPath)

  const base: RouteView = {
    ns,
    settingsPath,
    field,
    revision,
    writable,
    entries: [],
    writeModels: [],
    materializes: false,
  }

  if (!isPlainObject(userProfile) && !isPlainObject(resolvedProfile)) {
    return { ...base, problem: '该 provider 尚未在设置文档中留下可编辑的配置。' }
  }

  const modelsOf = (profile: unknown): unknown[] =>
    isPlainObject(profile) && Array.isArray(profile['models']) ? (profile['models'] as unknown[]) : []
  const overridesOf = (profile: unknown): Record<string, unknown> =>
    isPlainObject(profile) && isPlainObject(profile['modelOverrides'])
      ? (profile['modelOverrides'] as Record<string, unknown>)
      : {}

  const userModels = modelsOf(userProfile)
  const resolvedModels = modelsOf(resolvedProfile)
  const userOverrides = overridesOf(userProfile)
  const resolvedOverrides = overridesOf(resolvedProfile)

  // llm-pi-ai 的解析器拒绝 models 与 modelOverrides 同时非空。
  const conflicting = userModels.length > 0 && Object.keys(userOverrides).length > 0

  const materializes = userModels.length === 0 && resolvedModels.length > 0
  const writeModels = cloneJson(materializes ? resolvedModels : userModels)

  const resolvedById = new Map<string, Record<string, unknown>>()
  for (const raw of resolvedModels) {
    if (isPlainObject(raw) && typeof raw['id'] === 'string') resolvedById.set(raw['id'], raw)
  }
  for (const [id, raw] of Object.entries(resolvedOverrides)) {
    if (isPlainObject(raw)) resolvedById.set(id, raw)
  }

  const entries: ModelEntry[] = []

  if (writeModels.length > 0) {
    // declared 必须只读**用户层**：materializes 时 writeModels 是解析层的物化副本，
    // 拿它当声明会把 schema 默认值误报成用户已经选过的值。
    const declaredSource = materializes ? [] : userModels
    writeModels.forEach((raw, index) => {
      if (!isPlainObject(raw)) return
      const id = typeof raw['id'] === 'string' ? raw['id'] : ''
      if (id.length === 0) return
      entries.push({
        id,
        kind: 'models',
        index,
        declared: stateOfDeclared(fieldOf(declaredSource[index], field)),
        // 生效态按 id 到解析层查，不按下标对齐：用户层与解析层的顺序未必一致。
        effective: stateOfDeclared(fieldOf(resolvedById.get(id), field)),
      })
    })
  } else {
    const overrideIds = Object.keys(resolvedOverrides).length > 0
      ? Object.keys(resolvedOverrides)
      : Object.keys(userOverrides)
    for (const id of overrideIds) {
      entries.push({
        id,
        kind: 'modelOverrides',
        index: -1,
        declared: stateOfDeclared(fieldOf(userOverrides[id], field)),
        effective: stateOfDeclared(fieldOf(resolvedOverrides[id], field)),
      })
    }
  }

  if (conflicting) {
    return {
      ...base,
      entries,
      writeModels,
      materializes,
      problem: '该 provider 同时声明了 models 与 modelOverrides，适配器会拒绝写入；请先在官方设置页修好其中一处。',
    }
  }

  if (entries.length === 0) {
    return { ...base, materializes, problem: '该 provider 没有在设置中列出任何模型，暂无可配置项。' }
  }

  return { ...base, entries, writeModels, materializes }
}

/**
 * 为一次三态修改生成路径编辑。
 *
 * 数组下标不能直接 `set`：settings 的路径编辑把非普通对象（含数组）的中间节点
 * 当成缺失并重建为对象，`models.3.input` 会写出 `models: {"3": {...}}` 这种损坏
 * 结构。所以 `models` 一律**整数组写回**，`modelOverrides` 是字典才可以按叶子写。
 * @param view - {@link inspectRoute} 的结果。
 * @param entry - 目标模型。
 * @param state - 目标三态。
 * @returns 交给 `settings.mutate` 的 op 列表。
 */
export function planWrite(view: RouteView, entry: ModelEntry, state: ModalityState): SettingsPathOp[] {
  const value = modalitiesFor(state)

  if (entry.kind === 'modelOverrides') {
    const path = [...view.settingsPath, 'modelOverrides', entry.id, view.field]
    return value === undefined
      ? [{ op: 'unset', path }]
      : [{ op: 'set', path, value: [...value] }]
  }

  const next = cloneJson(view.writeModels)
  const current = isPlainObject(next[entry.index]) ? { ...(next[entry.index] as Record<string, unknown>) } : {}

  if (value === undefined) delete current[view.field]
  else current[view.field] = [...value]

  // 降级为纯文本时必须摘掉图片限额，否则 llm-deepseek 的解析器直接抛错。
  if (view.field === 'inputModalities' && state !== 'text+image') {
    delete current['imagePixelBudget']
    delete current['imageMaxBytes']
  }

  next[entry.index] = current
  return [{ op: 'set', path: [...view.settingsPath, 'models'], value: next }]
}
