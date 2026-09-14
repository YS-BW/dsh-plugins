/**
 * 「设置 → 桌面通知」这一页。
 *
 * 这个页面的存在理由不是"配置项需要一个家"，而是**这条路最大的坑是静默失败**：
 *
 * - `addNotificationRequest` 在未授权时照样回调成功，通知进通知中心但不弹横幅、不响；
 * - 后端可能整个不可用（host 不是从 Electron helper 启动的），此时插件什么也做不了。
 *
 * 两种情况下用户看到的现象都是「装了、不报错、就是不弹」。所以这里把身份、授权状态、
 * 横幅与声音开关的真实读数全部摊开，并且给一个能立刻验证的测试按钮。
 *
 * 组件不直接碰 cordis：远端一律通过 `getContext()` 惰性解析，拿不到时在页面上明说。
 *
 * @module @lixklv/dsh-desktop-notify/client/panel
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { describeAuthorization, describeToggle } from '../core/delivery.ts'
import type { NotifyConfig } from '../core/config.ts'
import {
  loadConfig,
  saveConfig,
  settingsRemoteOf,
  type StatusView,
} from './api.ts'
import styles from './panel.module.css'

/** 面板属性。 */
export interface DesktopNotifyPanelProps {
  /** 取浏览器半区的 cordis 上下文；slot 渲染时始终可用。 */
  getContext: () => Context | undefined
  /** 本插件的设置命名空间。 */
  namespace: string
}

/** 面板状态。 */
type Load =
  | { phase: 'loading' }
  | { phase: 'message'; text: string; bad: boolean }
  | {
      phase: 'ready'
      config: NotifyConfig
      status: StatusView
      revision: number | undefined
      writable: boolean
    }

/** 一个开关行。 */
interface ToggleRow {
  key: keyof NotifyConfig
  label: string
  hint: string
  master?: boolean
}

/** 页面上要展示的开关。顺序即渲染顺序。 */
const TOGGLES: readonly ToggleRow[] = [
  { key: 'enabled', label: '启用系统通知', hint: '总开关。关掉之后下面的设置全部不生效。', master: true },
  { key: 'onTurnEnd', label: '回合正常结束时通知', hint: '每一轮回答结束时弹一条。' },
  { key: 'onTurnFailed', label: '回合异常结束时通知', hint: '中断、失败、受阻、达到输出上限。' },
  { key: 'onQuestion', label: '等待我选择时通知', hint: '需要你在对话里做选择时弹一条。' },
  { key: 'onApproval', label: '等待授权时通知', hint: '需要你批准某个工具调用时弹一条。' },
  { key: 'includeSummary', label: '正文带回复摘要', hint: '关掉就是一条只有标题的短通知。' },
  { key: 'sound', label: '播放提示音', hint: '' },
]

/** 后端种类的人读文本。 */
function backendLabel(status: StatusView): string {
  return status.kind === 'desktop-addon' ? 'DSH Desktop 主进程' : '不可用'
}

/** 时间戳的人读文本。 */
function clockLabel(iso: string): string {
  if (iso === '') return '还没投递过'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * 桌面通知设置页。
 * @param props - 面板属性。
 * @returns 页面元素。
 */
export function DesktopNotifyPanel(props: DesktopNotifyPanelProps): ReactElement {
  const { getContext, namespace } = props
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')

  /** 重新读一遍配置与状态。 */
  const refresh = useCallback(async (): Promise<void> => {
    const ctx = getContext()
    if (ctx === undefined) {
      setLoad({ phase: 'message', text: '拿不到浏览器上下文，无法读取设置。', bad: true })
      return
    }
    const remote = settingsRemoteOf(ctx)
    if (remote === undefined) {
      setLoad({ phase: 'message', text: '这台部署没有提供设置远端，无法读写配置。', bad: true })
      return
    }
    const result = await loadConfig(remote, namespace)
    if (!result.ok) {
      setLoad({ phase: 'message', text: result.message, bad: true })
      return
    }
    setLoad({
      phase: 'ready',
      config: result.config,
      status: result.status,
      revision: result.revision,
      writable: result.writable,
    })
  }, [getContext, namespace])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 写一个字段并刷新。 */
  const write = useCallback(
    async (patch: Record<string, unknown>): Promise<void> => {
      if (load.phase !== 'ready') return
      const ctx = getContext()
      const remote = ctx === undefined ? undefined : settingsRemoteOf(ctx)
      if (remote === undefined) return
      setBusy(true)
      const result = await saveConfig(remote, namespace, patch, load.revision)
      setBusy(false)
      if (!result.ok) {
        setFlash(result.message)
        return
      }
      setFlash('')
      await refresh()
    },
    [getContext, load, namespace, refresh],
  )

  if (load.phase === 'loading') {
    return <div className={styles.page}>正在读取设置…</div>
  }
  if (load.phase === 'message') {
    return (
      <div className={styles.page}>
        <p className={load.bad ? styles.error : styles.note}>{load.text}</p>
      </div>
    )
  }

  const { config, status, writable } = load
  const healthy = status.kind === 'desktop-addon' && status.detail === ''
  const authorized = status.authorizationStatus === 2
  const bannersOn = status.alertSetting === 2
  const soundOn = status.soundSetting === 2

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>投递状态</h3>
        <div className={styles.card}>
          <div className={styles.row}>
            <span className={styles.label}>后端</span>
            <span className={styles.value}>{backendLabel(status)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>通知身份</span>
            <span className={styles.value}>{status.identity === '' ? '未知' : status.identity}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>系统授权</span>
            <span className={`${styles.value} ${authorized ? styles.good : styles.bad}`}>
              {describeAuthorization(status.authorizationStatus)}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>横幅</span>
            <span className={`${styles.value} ${bannersOn ? styles.good : styles.bad}`}>
              {describeToggle(status.alertSetting)}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>声音</span>
            <span className={`${styles.value} ${soundOn ? styles.good : styles.bad}`}>
              {describeToggle(status.soundSetting)}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>上次投递</span>
            <span className={styles.value}>{clockLabel(status.lastAt)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>健康</span>
            <span className={`${styles.value} ${healthy ? styles.good : styles.warn}`}>
              {healthy ? '正常' : (status.detail === '' ? '未知' : status.detail)}
            </span>
          </div>
          {status.kind === 'desktop-addon' && !bannersOn ? (
            <p className={styles.note}>
              系统里横幅或声音是关的。通知仍会进入通知中心，但不会弹出来提醒你 —— 到
              「系统设置 → 通知 → DSH Desktop」里打开即可。
            </p>
          ) : null}
          {status.kind === 'unavailable' ? (
            <p className={styles.note}>
              当前部署无法投递系统通知。本插件通过 DSH Desktop 自己的身份发送通知，
              所以只在这个 app 里可用；命令行起的 dsh web 或浏览器里没有可用的通知身份。
            </p>
          ) : null}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>通知开关</h3>
        <div className={styles.card}>
          {TOGGLES.map((row) => (
            <label key={row.key} className={styles.toggle}>
              <input
                type="checkbox"
                checked={config[row.key]}
                disabled={!writable || busy}
                onChange={(event) => {
                  void write({ [row.key]: event.target.checked })
                }}
              />
              <span className={styles.toggleText}>
                <span className={row.master === true ? styles.master : ''}>{row.label}</span>
                {row.hint === '' ? null : <span className={styles.toggleHint}>{row.hint}</span>}
              </span>
            </label>
          ))}
          {writable ? null : <p className={styles.note}>当前设置文档是只读的，改动无法保存。</p>}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>验证</h3>
        <div className={styles.card}>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={!writable || busy}
              onClick={() => {
                setFlash('已发送，请看屏幕右上角。')
                void write({ testAt: Date.now() })
              }}
            >
              发送测试通知
            </button>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void refresh()}>
              刷新状态
            </button>
          </div>
          <p className={styles.note}>
            测试通知用于自证链路：点完之后上面的「横幅」「声音」「上次投递」会刷新。
            如果这里显示已授权、横幅已开启，却什么都没看到，检查是否开着专注模式。
          </p>
          {flash === '' ? null : <p className={styles.note}>{flash}</p>}
        </div>
      </section>
    </div>
  )
}
