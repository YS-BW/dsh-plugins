/**
 * 投递层的纯逻辑：路径推导、结果解析、状态形状。
 *
 * 真正的进程投递在 host 半区（`src/index.ts`），这里只放**可以脱离环境测试**的部分。
 *
 * ## 为什么身份必须是 `io.dsh.desktop`
 *
 * 通知的归属由发送进程的 bundle 身份决定，而 bundle 身份由**可执行文件的路径**决定：
 * CoreFoundation 从 `…/X.app/Contents/MacOS/<exe>` 向上找到最近的 `Contents/Info.plist`。
 *
 * - harness 进程的可执行文件在 `DSH Desktop Helper.app` 里 → 身份 `io.dsh.desktop.helper`
 * - 用 `ELECTRON_RUN_AS_NODE=1` 跑**主二进制** → 身份 `io.dsh.desktop`
 *
 * 所以投递固定走一条子进程：主二进制 + Node-API addon。实测开销 70–100ms。
 * 顺带这也是唯一安全的方式——把 addon 加载进一个**没有** bundle 身份的进程会让
 * `+[UNUserNotificationCenter currentNotificationCenter]` 抛
 * `NSInternalInconsistencyException` 并直接 SIGABRT 打死进程（addon 里有守卫，
 * 但守卫只保证安全返回，不保证能发出去）。
 *
 * @module @lixklv/dsh-desktop-notify/core/delivery
 */

/** 投递后端种类。 */
export type BackendKind =
  /** 官方 DSH Desktop：主二进制子进程 + Node-API addon。 */
  | 'desktop-addon'
  /** 没有可用后端。 */
  | 'unavailable'

/** 一条通知的投递载荷。 */
export interface NotifyPayload {
  title: string
  body: string
  sound: boolean
}

/** addon 的返回形状。设置读数由 addon 一并回报，见下。 */
export interface AddonResult {
  bundleId?: string
  ok?: boolean
  error?: string
  /** 授权状态：0 notDetermined / 1 denied / 2 authorized。 */
  authorizationStatus?: number
  /** 提醒设置：0 notSupported / 1 disabled / 2 enabled。 */
  alertSetting?: number
  /** 声音设置：同上取值。 */
  soundSetting?: number
  /** 提醒样式：0 none / 1 banner / 2 alert。 */
  alertStyle?: number
}

/** 投递结果。 */
export interface DeliveryOutcome {
  ok: boolean
  /** 成功时的 bundle 身份。 */
  identity?: string
  /** 失败原因，可直接展示。 */
  error?: string
}

/**
 * 从 harness 进程的可执行文件路径推出外层 app 的 `Contents` 目录。
 *
 * 期望的形状（Electron 的标准布局）：
 *
 *     <App>.app/Contents/Frameworks/<X> Helper.app/Contents/MacOS/<exe>
 *     └──────────────────────────┘ 这就是要返回的那一层
 *
 * 逐段校验而不是无脑上溯：形状不符时返回 undefined，让调用方给出明确文案，而不是
 * 拼出一个看似合理的错误路径去执行。
 *
 * @param execPath - 通常是 `process.execPath`。
 * @returns 外层 app 的 `Contents` 绝对路径，形状不符时 undefined。
 */
export function outerContentsOf(execPath: string): string | undefined {
  if (typeof execPath !== 'string' || execPath === '') return undefined
  const segments = execPath.split('/').filter((part) => part !== '')
  // 至少要有 <App>.app/Contents/Frameworks/<Helper>.app/Contents/MacOS/<exe> 这么多段。
  if (segments.length < 7) return undefined

  const exe = segments[segments.length - 1]!
  const macos = segments[segments.length - 2]!
  const helperContents = segments[segments.length - 3]!
  const helperApp = segments[segments.length - 4]!
  const frameworks = segments[segments.length - 5]!
  const outerContents = segments[segments.length - 6]!
  const outerApp = segments[segments.length - 7]!

  if (macos !== 'MacOS') return undefined
  if (helperContents !== 'Contents') return undefined
  if (!helperApp.endsWith('.app')) return undefined
  if (frameworks !== 'Frameworks') return undefined
  if (outerContents !== 'Contents') return undefined
  if (!outerApp.endsWith('.app')) return undefined
  if (exe === '') return undefined

  return `/${segments.slice(0, segments.length - 5).join('/')}`
}

/**
 * 从 `Info.plist` 文本里取 `CFBundleExecutable`。
 *
 * 只做一处最小解析，不引入 plist 依赖：本插件只关心这一个键，而且读不到时要能
 * 明确失败而不是猜。
 * @param plist - plist 的 XML 文本。
 * @returns 可执行文件名，取不到时 undefined。
 */
export function executableNameOf(plist: string): string | undefined {
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? undefined : name
}

/**
 * 解析 addon 写在 stdout 上的 JSON 结果。
 *
 * 子进程可能因为任何原因输出非 JSON（崩溃信息、警告、被截断），所以这里一律
 * 收敛：解析不了就当成一次可展示的失败，绝不抛。
 * @param stdout - 子进程的 stdout。
 * @returns 解析结果；形状不符时返回 undefined。
 */
export function parseAddonResult(stdout: string): AddonResult | undefined {
  const text = stdout.trim()
  if (text === '') return undefined
  // 只取最后一行：addon 会往 stderr 打诊断，stdout 只应有一行 JSON。
  const line = text.split('\n').filter((part) => part.trim() !== '').pop()
  if (line === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed as AddonResult
  } catch {
    return undefined
  }
}

/**
 * 把 addon 的结果收敛成一次投递结论。
 * @param raw - 解析后的 addon 结果（可能 undefined）。
 * @param stderr - 子进程的 stderr，用于失败时提供线索。
 * @returns 投递结论。
 */
export function outcomeOf(raw: AddonResult | undefined, stderr: string): DeliveryOutcome {
  if (raw === undefined) {
    const detail = stderr.trim().split('\n').filter((part) => part !== '').pop()
    return { ok: false, error: detail === undefined ? '投递进程没有返回可解析的结果。' : detail }
  }
  if (raw.ok === true) {
    return { ok: true, ...(raw.bundleId === undefined ? {} : { identity: raw.bundleId }) }
  }
  return { ok: false, error: raw.error ?? '投递失败。' }
}

/**
 * 把一次 addon 调用收敛成一句可展示的诊断文本，空串表示一切正常。
 *
 * **必须按 op 分开判定**：只有 `send` 的返回里有 `ok` 字段，`status` 没有。曾经用
 * 同一个 `outcomeOf` 处理两者，结果是每次成功的探测都被误报成"投递失败" —— 后端明明
 * 是好的，界面却一直显示红的。
 *
 * @param raw - addon 的解析结果；undefined 表示没有可解析的输出。
 * @param stderr - 子进程的 stderr；没有可解析结果时它是唯一线索。
 * @param op - 本次调用的是 `send` 还是 `status`。
 * @returns 诊断文本；正常时为空串。
 */
export function detailOf(
  raw: AddonResult | undefined,
  stderr: string,
  op: 'send' | 'status',
): string {
  if (raw === undefined) {
    return outcomeOf(undefined, stderr).error ?? '投递进程没有返回可解析的结果。'
  }
  // 身份守卫拒绝了执行：宿主进程没有 bundle 身份。
  if (raw.bundleId === undefined || raw.bundleId === '') {
    return raw.error ?? '拿不到通知身份。'
  }
  if (op === 'send' && raw.ok !== true) return raw.error ?? '投递失败。'
  // 即使投递"成功"，读数也可能说明横幅根本不会弹。
  if (raw.alertSetting === 0) {
    return '系统里本 app 的通知未开启（或横幅与声音被关），通知不会显示。'
  }
  return ''
}

/** 后端探测结论，会写进设置供界面读取。 */
export interface BackendStatus {
  /** 当前使用的后端。 */
  kind: BackendKind
  /** 通知的身份标识（成功调用时由 addon 回报）。 */
  identity: string
  /** 后端不可用或上次投递失败的原因；正常时为空串。 */
  detail: string
  /** 上次投递的时间（ISO 字符串）；从未投递过为空串。 */
  lastAt: string
  /**
   * 系统层面的读数。**这三个才是"到底会不会弹横幅"的真相**：
   * `addNotificationRequest` 在未授权时照样回调成功，只有这里能看出区别。
   * 未探测过时都是 -1。
   */
  authorizationStatus: number
  alertSetting: number
  soundSetting: number
}

/**
 * 一份「还没探测过」的初始状态。
 * @returns 初始状态。
 */
export function unknownStatus(): BackendStatus {
  return {
    kind: 'unavailable',
    identity: '',
    detail: '尚未探测。',
    lastAt: '',
    authorizationStatus: -1,
    alertSetting: -1,
    soundSetting: -1,
  }
}

/** 授权状态的人读文本。 */
export function describeAuthorization(value: number): string {
  switch (value) {
    case 0:
      return '尚未询问（首次投递时会弹系统授权框）'
    case 1:
      return '已被拒绝 —— 通知不会显示，需要到「系统设置 → 通知」里打开'
    case 2:
      return '已授权'
    case 3:
      return '临时授权'
    default:
      return '未知（尚未探测）'
  }
}

/** 提醒/声音设置的人读文本。 */
export function describeToggle(value: number): string {
  switch (value) {
    case 0:
      return '不支持'
    case 1:
      return '已关闭'
    case 2:
      return '已开启'
    default:
      return '未知'
  }
}
