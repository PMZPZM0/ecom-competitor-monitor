import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  BellRing,
  CheckCircle2,
  CircleAlert,
  CloudDownload,
  LoaderCircle,
  RefreshCw,
  Settings,
  UserRound,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import type { UpdateInfo } from '../../types/domain'

export type SettingsSection = 'accounts' | 'feishu' | 'models' | 'updates'

export type SettingsCenterProps = {
  open: boolean
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  onClose: () => void
  accountContent: ReactNode
  feishuContent: ReactNode
  modelContent: ReactNode
  currentVersion: string
  updateInfo: UpdateInfo | null
  updateChecking: boolean
  updateError: string
  onCheckUpdate: () => void | Promise<void>
  onOpenUpdateDialog: () => void
}

type SectionOption = {
  id: SettingsSection
  label: string
  description: string
  icon: LucideIcon
}

const sections: SectionOption[] = [
  { id: 'accounts', label: '账号授权', description: '淘宝账号与登录状态', icon: UserRound },
  { id: 'feishu', label: '飞书联动', description: '文档同步与价格提醒', icon: BellRing },
  { id: 'models', label: 'AI 模型', description: '提示词与生图通道', icon: WandSparkles },
  { id: 'updates', label: '软件更新', description: '版本检查与安装包', icon: CloudDownload },
]

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function UpdateSettings({
  currentVersion,
  updateInfo,
  updateChecking,
  updateError,
  onCheckUpdate,
  onOpenUpdateDialog,
}: Pick<
  SettingsCenterProps,
  'currentVersion' | 'updateInfo' | 'updateChecking' | 'updateError' | 'onCheckUpdate' | 'onOpenUpdateDialog'
>) {
  const status = updateChecking
    ? '正在检查 GitHub Releases'
    : updateError
      ? '检查失败'
      : updateInfo?.updateAvailable
        ? `发现新版本 v${updateInfo.latestVersion}`
        : updateInfo
          ? '当前已是最新版本'
          : '尚未检查更新'

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5" aria-labelledby="software-update-heading">
      <div>
        <h3 id="software-update-heading" className="text-base font-semibold text-slate-950">软件更新</h3>
        <p className="mt-1 text-sm leading-6 text-slate-500">检查项目发布版本，安装更新不会删除商品、账号资料和历史记录。</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-500">当前版本</div>
          <div className="mt-1 text-xl font-semibold text-slate-950">v{currentVersion}</div>
        </div>
        <div className={`border-l-4 px-4 py-3 ${updateInfo?.updateAvailable ? 'border-emerald-500 bg-emerald-50' : 'border-blue-400 bg-blue-50'}`}>
          <div className="text-xs text-slate-500">最新版本</div>
          <div className="mt-1 text-xl font-semibold text-slate-950">{updateInfo ? `v${updateInfo.latestVersion}` : '等待检查'}</div>
        </div>
      </div>

      <div
        className={`flex items-start gap-3 px-4 py-3 text-sm ${
          updateError
            ? 'bg-red-50 text-red-700'
            : updateInfo?.updateAvailable
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-blue-50 text-blue-800'
        }`}
        role={updateError ? 'alert' : 'status'}
        aria-live="polite"
      >
        {updateChecking
          ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
          : updateError
            ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            : updateInfo?.updateAvailable
              ? <CloudDownload className="mt-0.5 h-4 w-4 shrink-0" />
              : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
        <div className="min-w-0">
          <div className="font-medium">{status}</div>
          {updateError && <div className="mt-1 text-xs leading-5">{updateError}。这不会影响本地抓取和监控，可稍后重试。</div>}
          {updateInfo?.checkedAt && !updateError && <div className="mt-1 text-xs opacity-75">最近检查：{new Date(updateInfo.checkedAt).toLocaleString('zh-CN', { hour12: false })}</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <Button type="button" variant="secondary" onClick={() => void onCheckUpdate()} disabled={updateChecking}>
          <RefreshCw className={`h-4 w-4 ${updateChecking ? 'animate-spin motion-reduce:animate-none' : ''}`} />
          {updateChecking ? '检查中' : '检查更新'}
        </Button>
        <Button type="button" onClick={onOpenUpdateDialog} disabled={updateChecking && !updateInfo}>
          <CloudDownload className="h-4 w-4" />
          {updateInfo?.updateAvailable ? '查看并下载更新' : '查看版本详情'}
        </Button>
      </div>
    </section>
  )
}

export function SettingsCenter({
  open,
  section,
  onSectionChange,
  onClose,
  accountContent,
  feishuContent,
  modelContent,
  currentVersion,
  updateInfo,
  updateChecking,
  updateError,
  onCheckUpdate,
  onOpenUpdateDialog,
}: SettingsCenterProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  const instanceId = useId()
  const titleId = `${instanceId}-title`
  const panelId = `${instanceId}-${section}-panel`
  const selectedSection = sections.find((item) => item.id === section) ?? sections[0]

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined

    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0)
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open])

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: SettingsSection) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = sections.findIndex((item) => item.id === current)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? sections.length - 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (currentIndex - 1 + sections.length) % sections.length
          : (currentIndex + 1) % sections.length
    const next = sections[nextIndex]
    onSectionChange(next.id)
    const nextTabs = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>(`[data-settings-tab="${next.id}"]`) || [])
    nextTabs.find((element) => element.getClientRects().length > 0)?.focus()
  }

  function renderContent() {
    if (section === 'accounts') return accountContent
    if (section === 'feishu') return feishuContent
    if (section === 'models') return modelContent
    return (
      <UpdateSettings
        currentVersion={currentVersion}
        updateInfo={updateInfo}
        updateChecking={updateChecking}
        updateError={updateError}
        onCheckUpdate={onCheckUpdate}
        onOpenUpdateDialog={() => {
          onClose()
          onOpenUpdateDialog()
        }}
      />
    )
  }

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/35 sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-[min(88dvh,760px)] sm:max-w-[1040px] sm:rounded-lg sm:border sm:border-slate-200"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-4 py-3.5 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white"><Settings className="h-4 w-4" /></span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-slate-950 sm:text-lg">设置中心</h2>
              <p className="mt-0.5 truncate text-xs text-slate-500 sm:text-sm">账号、联动服务、AI 模型和版本维护集中在这里。</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label="关闭设置中心"
            title="关闭设置中心"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="shrink-0 overflow-x-auto border-b border-slate-100 bg-white px-3 py-2 sm:hidden" role="tablist" aria-label="设置分类">
          <div className="flex min-w-max gap-1">
            {sections.map((item) => {
              const Icon = item.icon
              const selected = item.id === section
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-settings-tab={item.id}
                  className={`mobile-settings-tab inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => onSectionChange(item.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, item.id)}
                >
                  <Icon className="h-4 w-4" />{item.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-60 shrink-0 border-r border-slate-100 bg-slate-50/50 p-3 sm:block">
            <nav className="space-y-1" role="tablist" aria-label="设置分类" aria-orientation="vertical">
              {sections.map((item) => {
                const Icon = item.icon
                const selected = item.id === section
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-settings-tab={item.id}
                    className={`flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'bg-white text-blue-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white hover:text-slate-950'}`}
                    onClick={() => onSectionChange(item.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, item.id)}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-blue-600' : 'text-slate-400'}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="mt-0.5 block truncate text-xs font-normal text-slate-400">{item.description}</span>
                    </span>
                  </button>
                )
              })}
            </nav>
          </aside>

          <section
            id={panelId}
            role="tabpanel"
            aria-label={selectedSection.label}
            className="scrollbar-thin min-w-0 flex-1 overflow-y-auto bg-white p-3 sm:p-5"
          >
            {renderContent()}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
