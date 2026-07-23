import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clock3, ListTodo, LoaderCircle, PackagePlus, PauseCircle, PlayCircle, RefreshCw, Settings, X } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import type { CaptureQueueStatus, Overview } from '../../types/domain'
import { MonitorClassification } from '../classification/MonitorClassification'
import { ProductForm } from '../products/ProductForm'
import { BatchCaptureCard } from './BatchCaptureCard'
import { TaskCenterDrawer, type TaskCenterTab } from './TaskCenterDrawer'

type ClassificationProps = ComponentProps<typeof MonitorClassification>
type ProductFormProps = ComponentProps<typeof ProductForm>
type BatchCaptureProps = ComponentProps<typeof BatchCaptureCard>

type Props = ClassificationProps & {
  overview: Overview
  sessions: ProductFormProps['sessions']
  onAdd: ProductFormProps['onAdd']
  onAddBatch: BatchCaptureProps['onRun']
  onRequireAuth: ProductFormProps['onRequireAuth']
  onPauseBatch: ComponentProps<typeof TaskCenterDrawer>['onPauseBatch']
  onToggleMonitorRunning: () => Promise<void>
  onRefresh: () => Promise<void>
  onOpenSettings: () => void
  monitorToggleBusy?: boolean
}

type AddMode = 'single' | 'batch'

function formatNextRun(value: string | null) {
  if (!value) return '等待计划'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function ProductMonitoringWorkspace({
  overview,
  sessions,
  onAdd,
  onAddBatch,
  onRequireAuth,
  onPauseBatch,
  onToggleMonitorRunning,
  onRefresh,
  onOpenSettings,
  monitorToggleBusy,
  ...classificationProps
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('single')
  const [taskOpen, setTaskOpen] = useState(false)
  const [taskTab, setTaskTab] = useState<TaskCenterTab>('monitor')
  const [queueStatus, setQueueStatus] = useState<CaptureQueueStatus>(overview.captureQueue)
  const [refreshing, setRefreshing] = useState(false)

  const enabledCount = useMemo(() => overview.products.filter((product) => product.enabled).length, [overview.products])
  const productErrorCount = useMemo(() => overview.products.filter((product) => product.lastStatus === 'error').length, [overview.products])
  const runningJobs = queueStatus.jobs.filter((job) => job.status === 'running').length
  const failedJobs = queueStatus.jobs.filter((job) => job.status === 'failed').length
  const attentionCount = productErrorCount + failedJobs + (queueStatus.authRequiredCount || 0)

  useEffect(() => setQueueStatus(overview.captureQueue), [overview.captureQueue])

  useEffect(() => {
    let active = true
    let inFlight = false
    async function refreshQueue() {
      if (inFlight) return
      inFlight = true
      try {
        const next = await api.captureQueue()
        if (active) setQueueStatus(next)
      } catch {
        // The overview value remains usable while the local service reconnects.
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(refreshQueue, taskOpen ? 5_000 : 8_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [taskOpen])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setAddOpen(true)
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        setTaskTab('monitor')
        setTaskOpen(true)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  async function refreshAll() {
    setRefreshing(true)
    try {
      await onRefresh()
      setQueueStatus(await api.captureQueue())
    } finally {
      setRefreshing(false)
    }
  }

  function openTasks(tab: TaskCenterTab) {
    setTaskTab(tab)
    setTaskOpen(true)
  }

  return (
    <div className="space-y-3">
      <section className="monitor-surface-strong overflow-hidden rounded-md border border-white/70" aria-label="监控运行状态">
        <div className="grid grid-cols-3 lg:grid-cols-[minmax(220px,1.25fr)_minmax(170px,0.9fr)_minmax(150px,0.8fr)_minmax(150px,0.8fr)_auto]">
          <button
            type="button"
            onClick={() => void onToggleMonitorRunning()}
            disabled={monitorToggleBusy}
            className={`col-span-3 flex min-h-16 items-center gap-3 px-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 sm:px-4 lg:col-span-1 lg:min-h-20 ${overview.monitor.running ? 'bg-emerald-50/70 hover:bg-emerald-50' : 'bg-amber-50/70 hover:bg-amber-50'}`}
          >
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${overview.monitor.running ? 'bg-emerald-600 text-white' : 'bg-amber-100 text-amber-700'}`}>{monitorToggleBusy ? <LoaderCircle className="h-5 w-5 animate-spin" /> : overview.monitor.running ? <PlayCircle className="h-5 w-5" /> : <PauseCircle className="h-5 w-5" />}</span>
            <span><span className="block text-sm font-semibold text-slate-950">全局自动监控</span><span className={`mt-1 block text-xs ${overview.monitor.running ? 'text-emerald-700' : 'text-amber-700'}`}>{monitorToggleBusy ? '正在切换' : overview.monitor.running ? '运行中，点击暂停' : '已暂停，点击开启'}</span></span>
          </button>

          <div className="flex min-h-16 min-w-0 items-center gap-2 border-t border-slate-100 px-2 sm:px-4 lg:min-h-20 lg:border-l lg:border-t-0">
            <CalendarClock className="h-4 w-4 shrink-0 text-blue-600 sm:h-5 sm:w-5" />
            <div className="min-w-0"><div className="text-xs text-slate-500"><span className="sm:hidden">下次执行</span><span className="hidden sm:inline">下次自动执行</span></div><div className="mt-1 truncate text-sm font-semibold text-slate-900" title={formatNextRun(overview.monitor.nextRunAt)}>{formatNextRun(overview.monitor.nextRunAt)}</div></div>
          </div>

          <button type="button" onClick={() => openTasks('monitor')} className="flex min-h-16 min-w-0 items-center gap-2 border-l border-t border-slate-100 px-2 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 sm:px-4 lg:min-h-20 lg:border-t-0">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 sm:h-5 sm:w-5" />
            <span><span className="block text-xs text-slate-500">监控商品</span><span className="mt-1 block text-sm font-semibold text-slate-900">{enabledCount} / {overview.products.length}</span></span>
          </button>

          <button type="button" onClick={() => openTasks('capture')} className="flex min-h-16 min-w-0 items-center gap-2 border-l border-t border-slate-100 px-2 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 sm:px-4 lg:min-h-20 lg:border-t-0">
            {runningJobs ? <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-blue-600" /> : <Clock3 className="h-5 w-5 shrink-0 text-slate-500" />}
            <span><span className="block text-xs text-slate-500">抓取任务</span><span className="mt-1 block text-sm font-semibold text-slate-900">运行 {runningJobs} · 排队 {queueStatus.pendingCount}</span></span>
          </button>

          <div className="col-span-3 flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 lg:col-span-1 lg:min-h-20 lg:justify-end lg:border-l lg:border-t-0">
            {attentionCount > 0 && <Badge className="border-red-100 bg-red-50 text-red-700"><CircleAlert className="mr-1 h-3.5 w-3.5" />待处理 {attentionCount}</Badge>}
            <Button type="button" variant="secondary" size="sm" onClick={() => void refreshAll()} disabled={refreshing} title="刷新商品和任务状态"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /><span className="sr-only sm:not-sr-only">刷新</span></Button>
          </div>
        </div>
      </section>

      <div className="monitor-title-bar flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/60 px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span className="font-semibold text-slate-950">商品列表</span>
          <span className="text-slate-300">/</span>
          <span>筛选、批量操作并展开核对详情</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => openTasks('monitor')}><ListTodo className="h-4 w-4" />任务中心{queueStatus.pendingCount || runningJobs ? ` ${queueStatus.pendingCount + runningJobs}` : ''}</Button>
          <Button type="button" onClick={() => setAddOpen((current) => !current)}><PackagePlus className="h-4 w-4" />新增商品{addOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
        </div>
      </div>

      {addOpen && (
        <section className="monitor-surface-strong rounded-md border border-blue-200/70" aria-label="新增商品">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div><h2 className="text-sm font-semibold text-slate-950">新增监控商品</h2><p className="mt-0.5 text-xs text-slate-500">选择单个或批量录入；抓取任务会在后台队列继续执行。</p></div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md bg-slate-100 p-1" role="tablist" aria-label="新增方式">
                <button type="button" role="tab" aria-selected={addMode === 'single'} onClick={() => setAddMode('single')} className={`h-8 rounded px-3 text-xs font-medium ${addMode === 'single' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}>单个商品</button>
                <button type="button" role="tab" aria-selected={addMode === 'batch'} onClick={() => setAddMode('batch')} className={`h-8 rounded px-3 text-xs font-medium ${addMode === 'batch' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}>批量商品</button>
              </div>
              <button type="button" onClick={() => setAddOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭新增面板" aria-label="关闭新增面板"><X className="h-4 w-4" /></button>
            </div>
          </header>
          <div className="p-3 sm:p-4">
            {addMode === 'single'
              ? <ProductForm sessions={sessions} onAdd={onAdd} onRequireAuth={onRequireAuth} />
              : <BatchCaptureCard sessions={sessions} busy={Boolean(classificationProps.batchBusy)} onRun={onAddBatch} onRequireAuth={onRequireAuth} />}
          </div>
        </section>
      )}

      <MonitorClassification {...classificationProps} products={overview.products} monitor={overview.monitor} onRequestAdd={() => setAddOpen(true)} />

      {attentionCount > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>有 {attentionCount} 项需要处理。打开任务中心查看失败原因；账号异常时先检测登录，确认失效后再重新授权。</span>
          <button type="button" onClick={onOpenSettings} className="ml-auto shrink-0 font-medium text-amber-950 hover:underline"><Settings className="mr-1 inline h-3.5 w-3.5" />设置</button>
        </div>
      )}

      <TaskCenterDrawer
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        initialTab={taskTab}
        products={overview.products}
        monitor={overview.monitor}
        busyProductId={classificationProps.busyProductId}
        batchBusy={classificationProps.batchBusy}
        onCapture={classificationProps.onCapture}
        onCaptureBatch={classificationProps.onCaptureBatch}
        onPauseBatch={onPauseBatch}
        onSchedule={classificationProps.onSchedule}
        onToggle={classificationProps.onToggle}
        onLocalImport={classificationProps.onLocalImport}
        initialStatus={queueStatus}
        onOpenAuth={onOpenSettings}
      />
    </div>
  )
}
