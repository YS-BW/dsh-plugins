/**
 * 官方「设置 → 模型」页里每个 provider 卡片下方的视觉输入面板。
 *
 * 落点是官方声明的 `settings.models.provider-card` keyed slot（key 是该行的
 * `settingsNs`）——这是官方契约里唯一给外部插件留的 Models 页席位，不依赖 DOM
 * 结构，官方改版也不会静默失效。
 *
 * 每模型一个三态开关。三态而不是布尔勾选是正确性要求：llm-pi-ai 里「不声明」与
 * 「显式纯文本」语义不同，布尔勾选会把继承静默固化成显式声明，从而关掉本来能从
 * 模型目录继承到的图片能力。
 */
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react'
import { type ModelEntry, type ModalityState } from '../core/modality.ts'
import {
  type LoadResult,
  type SettingsRemote,
  type WriteResult,
  loadRoute,
  writeModality,
} from './api.ts'
import styles from './panel.module.css'

/** 模态三态的可选值与文案。 */
const STATE_OPTIONS: ReadonlyArray<{ value: ModalityState; label: string; title: string }> = [
  { value: 'inherit', label: '默认', title: '不声明，交给 schema 默认与模型目录继承' },
  { value: 'text', label: '纯文本', title: '显式声明只接受文本输入' },
  { value: 'text+image', label: '支持图片', title: '显式声明接受文本与图片输入' },
]

/** 官方 provider 卡片 slot 传下来的 props 子集。 */
export interface ProviderCardProps {
  provider?: {
    provider?: string
    displayName?: string
    settingsNs?: string
    settingsPath?: readonly string[]
  }
  configured?: boolean
  keyConfigured?: boolean
}

/** 面板自身的 props：官方 slot props 加上由 apply 提供的解析器。 */
export interface VisionPanelProps extends ProviderCardProps {
  /** 惰性解析设置远端；未就绪时返回 undefined。 */
  getRemote: () => SettingsRemote | undefined
  /**
   * 订阅一个 remote 事件。
   *
   * 事件面只挂在根 remote 上，所以由 apply 侧解析后传进来，面板不自己摸容器。
   */
  onEvent: (event: string, listener: () => void) => () => void
}

/**
 * 渲染一个 provider 的视觉输入面板。
 *
 * 设置远端**惰性解析**，不做硬依赖：面板只在用户打开「设置 → 模型」时挂载，
 * 那时远端必然已就绪。反过来若把它写成 cordis 的硬依赖而服务名又不成立，插件会
 * 永久停在等待态，表现为「装上了、不报错、就是没有面板」——那是最难查的失败。
 * @param props - slot props 与远端解析器。
 * @returns 面板元素。
 */
export function VisionPanel(props: VisionPanelProps): ReactElement | null {
  const getRemote = props.getRemote
  const onEvent = props.onEvent
  const ns = props.provider?.settingsNs
  const settingsPath = props.provider?.settingsPath
  const pathKey = (settingsPath ?? []).join('\u0000')

  const [remote, setRemote] = useState<SettingsRemote | undefined>(undefined)
  const [result, setResult] = useState<LoadResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const reload = useCallback(
    async (target: SettingsRemote) => {
      if (ns === undefined) return
      setResult(await loadRoute(target, ns, settingsPath ?? []))
    },
    [ns, pathKey],
  )

  useEffect(() => {
    setRemote(getRemote())
  }, [getRemote])

  useEffect(() => {
    if (remote === undefined) {
      setResult({ ok: false, message: '设置服务尚未就绪，重新打开本页即可。' })
      return
    }
    void reload(remote)
  }, [remote, reload])

  useEffect(() => {
    if (remote === undefined) return undefined
    return onEvent('settings/document-updated', () => void reload(remote))
  }, [remote, reload, onEvent])

  const view = result !== null && result.ok ? result.view : null
  const writable = view !== null && view.writable === true
  const entries = useMemo(() => view?.entries ?? [], [view])

  /** 统一的落盘包装：跑一次写入，然后更新视图，或给出错误。 */
  const run = useCallback(
    async (busyKey: string, action: () => Promise<WriteResult>) => {
      if (remote === undefined || view === null) return
      setBusy(busyKey)
      setFailure(null)
      const written = await action()
      if (written.ok) {
        setResult({ ok: true, view: written.view, applies: written.applies })
      } else {
        setFailure(written.message)
      }
      setBusy(null)
    },
    [remote, view],
  )

  const onSelectModality = useCallback(
    (entry: ModelEntry, next: ModalityState) => {
      if (remote === undefined || view === null) return
      void run(`${entry.kind}:${entry.id}`, () =>
        writeModality(remote, view, entry.id, entry.kind, next),
      )
    },
    [remote, view, run],
  )

  if (ns === undefined) return null

  const disabled = !writable || busy !== null

  return (
    <div className={styles.panel} data-dsh-plugin="model-vision" data-dsh-part="panel">
      <div className={styles.head}>
        <span className={styles.title}>视觉输入</span>
        <span className={styles.subtitle}>声明这些模型是否接受图片</span>
      </div>

      {result === null ? <p className={styles.note}>读取中…</p> : null}
      {result !== null && !result.ok ? <p className={styles.error}>{result.message}</p> : null}
      {view !== null && !writable ? <p className={styles.note}>当前设置文档是只读的，无法保存。</p> : null}
      {view !== null && view.problem !== undefined ? <p className={styles.note}>{view.problem}</p> : null}

      {entries.length > 0 ? (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={`modality:${entry.kind}:${entry.id}`} className={styles.row}>
              <span className={styles.model} title={entry.id}>
                {entry.id}
              </span>
              <span className={styles.badges}>
                {entry.declared === 'inherit' ? (
                  <span
                    className={styles.badge}
                    title={`设置文档里没有显式声明；文档解析值为「${labelOfModality(entry.effective)}」。未声明的模型是否收图由引擎目录决定。`}
                  >
                    未声明
                  </span>
                ) : null}
              </span>
              <Segments
                label={`${entry.id} 视觉输入`}
                options={STATE_OPTIONS}
                active={entry.declared}
                disabled={disabled}
                onSelect={(value) => onSelectModality(entry, value)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {view !== null && view.materializes ? (
        <p className={styles.note}>首次修改会把该 provider 的模型列表写入你的设置文档。</p>
      ) : null}

      {failure !== null ? <p className={styles.error}>{failure}</p> : null}

      <p className={styles.note}>
        「默认」表示不声明，交给引擎目录决定；「支持图片」会显式打开图片输入，之后即可在输入框贴图。
      </p>

      {view !== null && writable && result?.ok === true && result.applies === 'live' ? (
        <p className={styles.saved}>保存后立即生效，无需重启。</p>
      ) : null}
    </div>
  )
}

/** 一组互斥按钮。 */
function Segments<T extends string | undefined>(props: {
  label: string
  options: ReadonlyArray<{ value: T; label: string; title: string }>
  active: T
  disabled: boolean
  onSelect: (value: T) => void
}): ReactElement {
  return (
    <span className={styles.segments} role="group" aria-label={props.label}>
      {props.options.map((option) => {
        const isActive = option.value === props.active
        return (
          <button
            key={option.label}
            type="button"
            title={option.title}
            aria-pressed={isActive}
            disabled={props.disabled}
            className={isActive ? styles.segmentActive : styles.segment}
            onClick={() => props.onSelect(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </span>
  )
}

/** 模态三态的中文短标签。 */
function labelOfModality(state: ModalityState): string {
  if (state === 'text+image') return '文本 + 图片'
  if (state === 'text') return '纯文本'
  return '默认'
}
