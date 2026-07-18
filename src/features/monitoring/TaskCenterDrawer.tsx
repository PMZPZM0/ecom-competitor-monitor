import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ListChecks, ListTodo, X } from 'lucide-react'
import { CaptureQueue } from './CaptureQueue'
import { MonitorQueue } from './MonitorQueue'

export type TaskCenterTab = 'monitor' | 'capture'

export type TaskCenterDrawerProps = ComponentProps<typeof MonitorQueue> & ComponentProps<typeof CaptureQueue> & {
  open: boolean
  onClose: () => void
  initialTab?: TaskCenterTab
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function TaskCenterDrawer({
  open,
  onClose,
  initialTab = 'monitor',
  products,
  monitor,
  busyProductId,
  batchBusy,
  onCapture,
  onCaptureBatch,
  onPauseBatch,
  onSchedule,
  onToggle,
  onLocalImport,
  initialStatus,
  onOpenAuth,
}: TaskCenterDrawerProps) {
  const [activeTab, setActiveTab] = useState<TaskCenterTab>(initialTab)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const monitorTabRef = useRef<HTMLButtonElement | null>(null)
  const captureTabRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  const instanceId = useId()
  const titleId = `${instanceId}-title`
  const monitorTabId = `${instanceId}-monitor-tab`
  const monitorPanelId = `${instanceId}-monitor-panel`
  const captureTabId = `${instanceId}-capture-tab`
  const capturePanelId = `${instanceId}-capture-panel`

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open) setActiveTab(initialTab)
  }, [initialTab, open])

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

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextTab = event.key === 'ArrowLeft' || event.key === 'Home' ? 'monitor' : 'capture'
    setActiveTab(nextTab)
    if (nextTab === 'monitor') monitorTabRef.current?.focus()
    else captureTabRef.current?.focus()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[120] flex justify-end bg-slate-950/30 sm:pl-12"
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
        className="flex h-full w-full flex-col overflow-hidden bg-[#f6f8fa] shadow-2xl sm:w-[min(94vw,1080px)] sm:border-l sm:border-slate-200"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 bg-white px-4 pt-4 sm:px-5 sm:pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-slate-950">任务中心</h2>
              <p className="mt-1 text-sm text-slate-500">集中查看监控计划、抓取进度和需要处理的任务。</p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label="关闭任务中心"
              title="关闭任务中心"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 flex gap-1 rounded-md bg-slate-100 p-1" role="tablist" aria-label="任务类型">
            <button
              ref={monitorTabRef}
              id={monitorTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === 'monitor'}
              aria-controls={monitorPanelId}
              tabIndex={activeTab === 'monitor' ? 0 : -1}
              onClick={() => setActiveTab('monitor')}
              onKeyDown={handleTabKeyDown}
              className={`inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${activeTab === 'monitor' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <ListChecks className="h-4 w-4 shrink-0" />
              <span>监控计划</span>
            </button>
            <button
              ref={captureTabRef}
              id={captureTabId}
              type="button"
              role="tab"
              aria-selected={activeTab === 'capture'}
              aria-controls={capturePanelId}
              tabIndex={activeTab === 'capture' ? 0 : -1}
              onClick={() => setActiveTab('capture')}
              onKeyDown={handleTabKeyDown}
              className={`inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${activeTab === 'capture' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <ListTodo className="h-4 w-4 shrink-0" />
              <span>抓取任务</span>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5 sm:py-5">
          {activeTab === 'monitor' ? (
            <div id={monitorPanelId} role="tabpanel" aria-labelledby={monitorTabId}>
              <MonitorQueue
                products={products}
                monitor={monitor}
                busyProductId={busyProductId}
                batchBusy={batchBusy}
                onCapture={onCapture}
                onCaptureBatch={onCaptureBatch}
                onPauseBatch={onPauseBatch}
                onSchedule={onSchedule}
                onToggle={onToggle}
                onLocalImport={onLocalImport}
              />
            </div>
          ) : (
            <div id={capturePanelId} role="tabpanel" aria-labelledby={captureTabId}>
              <CaptureQueue initialStatus={initialStatus} onOpenAuth={onOpenAuth} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
