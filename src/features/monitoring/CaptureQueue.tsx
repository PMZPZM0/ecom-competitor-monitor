import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, LogIn, PlayCircle, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import type { CaptureQueueJob, CaptureQueueStatus } from '../../types/domain'

const sourceLabels: Record<string, string> = {
  'manual-product': '单品手动抓取',
  'manual-materials': '完整素材抓取',
  'manual-buyer-show': '买家秀抓取',
  'manual-account-views': '账号视角刷新',
  'single-product': '单品抓取',
  'manual-batch': '新增商品批量抓取',
  'manual-all': '批量抓取',
  scheduled: '定时监控',
  'local-import': '本地数据导入',
}

const stageLabels: Record<CaptureQueueJob['stage'], string> = {
  queued: '排队中',
  opening: '打开商品',
  capturing: '抓取数据',
  saving: '保存结果',
  parsing: '整理数据',
  verifying: '核对价格',
  retrying: '等待重试',
  'auth-required': '需要授权',
  completed: '已完成',
  failed: '失败',
}

function statusView(job: CaptureQueueJob) {
  if (job.status === 'auth-required') return { label: '需要授权', className: 'bg-red-50 text-red-700', icon: AlertCircle }
  if (job.stage === 'retrying') return { label: '等待重试', className: 'bg-amber-50 text-amber-700', icon: Clock3 }
  if (job.status === 'running') return { label: stageLabels[job.stage] || '运行中', className: 'bg-blue-50 text-blue-700', icon: LoaderCircle }
  if (job.status === 'queued') return { label: '排队中', className: 'bg-amber-50 text-amber-700', icon: Clock3 }
  if (job.status === 'failed') return { label: '失败', className: 'bg-red-50 text-red-700', icon: AlertCircle }
  if (job.outcome === 'partial') return { label: '部分完成', className: 'bg-amber-50 text-amber-700', icon: AlertCircle }
  return { label: '已完成', className: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2 }
}

function jobNames(job: CaptureQueueJob) {
  const names = job.products.map((product) => product.name).filter(Boolean)
  if (names.length) return names.join('、')
  return job.productIds.length ? `${job.productIds.length} 个商品` : '等待读取商品范围'
}

export function CaptureQueue({ initialStatus, onOpenAuth }: { initialStatus: CaptureQueueStatus; onOpenAuth?: () => void }) {
  const [queue, setQueue] = useState(initialStatus)
  const [loading, setLoading] = useState(false)
  const [resumingJobId, setResumingJobId] = useState('')
  const [deletingJobId, setDeletingJobId] = useState('')
  const [error, setError] = useState('')
  const refreshInFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    if (!refreshInFlight.current) {
      refreshInFlight.current = (async () => {
        try {
          setQueue(await api.captureQueue())
          setError('')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : '读取抓取队列失败。')
        }
      })().finally(() => { refreshInFlight.current = null })
    }
    await refreshInFlight.current
    if (showLoading) setLoading(false)
  }, [])

  async function clearFinished() {
    setLoading(true)
    try {
      await api.clearCaptureQueue()
      await refresh(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '清空完成任务失败。')
    } finally {
      setLoading(false)
    }
  }

  async function clearFailed() {
    setLoading(true)
    try {
      await api.clearFailedCaptureQueue()
      await refresh(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '清理失败任务失败。')
    } finally {
      setLoading(false)
    }
  }

  async function deleteJob(job: CaptureQueueJob) {
    setDeletingJobId(job.id)
    try {
      await api.deleteCaptureJob(job.id)
      await refresh(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除抓取任务失败。')
    } finally {
      setDeletingJobId('')
    }
  }

  async function resumeJob(job: CaptureQueueJob) {
    setResumingJobId(job.id)
    try {
      await api.resumeCaptureJob(job.id)
      await refresh(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复抓取任务失败。')
    } finally {
      setResumingJobId('')
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => refresh(false), 2500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const activeJobs = queue.jobs.filter((job) => job.status === 'running')
  const failedJobs = queue.jobs.filter((job) => job.status === 'failed' || job.status === 'auth-required' || job.stage === 'retrying')

  return (
    <div className="space-y-5">
      <section className="border-y border-slate-200 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-sm font-semibold text-slate-950">服务端抓取队列</div><div className="mt-1 text-sm text-slate-500">价格、买家秀和完整素材独立排队；刷新或重启不丢任务，失败商品按 1、5、15 分钟只重试失败项。</div></div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>运行 {activeJobs.length}</span><span className="text-slate-300">|</span><span>排队 {queue.pendingCount}</span>{Boolean(queue.authRequiredCount) && <><span className="text-slate-300">|</span><span className="text-red-600">待授权 {queue.authRequiredCount}</span></>}<span className="text-slate-300">|</span><span>完成 {queue.completedCount}</span><Button type="button" variant="secondary" size="sm" onClick={clearFailed} disabled={loading || !failedJobs.length} title="清理失败、待授权和等待重试的任务">清理失败任务</Button><Button type="button" variant="secondary" size="sm" onClick={clearFinished} disabled={loading || !queue.completedCount}>清空完成项</Button><Button type="button" variant="secondary" size="sm" onClick={() => refresh(true)} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button></div>
        </div>
        {activeJobs.map((active) => <div key={active.id} className="mt-3 bg-blue-50 px-4 py-3" role="status" aria-live="polite"><div className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate font-medium text-blue-900">{sourceLabels[active.source] || active.source} · {active.message}</span><span className="shrink-0 tabular-nums text-blue-700">{active.completed}/{active.total || '--'}</span></div><div className="mt-2 h-1.5 overflow-hidden bg-blue-100"><div className="h-full bg-blue-600 transition-[width]" style={{ width: `${active.total ? Math.min(100, active.completed / active.total * 100) : 8}%` }} /></div></div>)}
        {error && <div className="mt-3 text-sm text-red-700" role="alert">{error}</div>}
      </section>

      <section className="overflow-hidden border-y border-slate-200 bg-white">
        <div className="grid grid-cols-[120px_minmax(220px,1fr)_120px_120px_170px_44px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-500 max-[980px]:hidden"><span>状态</span><span>商品</span><span>来源</span><span>进度</span><span>时间</span><span className="sr-only">操作</span></div>
        <div className="divide-y divide-slate-100">
          {queue.jobs.map((job) => {
            const view = statusView(job)
            const Icon = view.icon
            return <div key={job.id} className="grid grid-cols-[120px_minmax(220px,1fr)_120px_120px_170px_44px] items-center gap-3 px-4 py-3 text-sm max-[980px]:grid-cols-1"><span className={`inline-flex w-fit items-center gap-1.5 px-2 py-1 text-xs font-medium ${view.className}`}><Icon className={`h-3.5 w-3.5 ${job.status === 'running' ? 'animate-spin' : ''}`} />{view.label}</span><div className="min-w-0"><div className="truncate font-medium text-slate-800" title={jobNames(job)}>{jobNames(job)}</div><div className="mt-0.5 truncate text-xs text-slate-500">{job.message}</div>{job.status === 'auth-required' && <div className="mt-2 flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" onClick={onOpenAuth}><LogIn className="h-4 w-4" />去账号授权</Button><Button type="button" size="sm" onClick={() => resumeJob(job)} disabled={resumingJobId === job.id}><PlayCircle className="h-4 w-4" />{resumingJobId === job.id ? '恢复中' : '重新尝试'}</Button></div>}</div><span className="text-xs text-slate-600">{sourceLabels[job.source] || job.source}</span><span className="tabular-nums text-slate-700">{job.completed}/{job.total || '--'}{job.attempt > 1 ? <span className="ml-1 text-xs text-amber-600">第 {job.attempt} 次</span> : null}</span><div className="text-xs leading-5 text-slate-500"><div>{job.startedAt ? new Date(job.startedAt).toLocaleString('zh-CN', { hour12: false }) : '等待开始'}</div>{job.nextAttemptAt && <div className="text-amber-700">重试 {new Date(job.nextAttemptAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>}{job.finishedAt && <div>完成 {new Date(job.finishedAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>}</div>{job.status !== 'running' && <Button type="button" variant="ghost" size="sm" className="h-8 w-8 px-0 text-slate-400 hover:text-red-700 max-[980px]:justify-self-end" onClick={() => deleteJob(job)} disabled={deletingJobId === job.id} title="删除任务" aria-label={`删除${jobNames(job)}抓取任务`}><Trash2 className="h-4 w-4" /></Button>}</div>
          })}
          {!queue.jobs.length && <div className="px-4 py-16 text-center text-sm text-slate-400">暂无抓取任务。添加商品、手动抓取或定时监控后会自动出现在这里。</div>}
        </div>
      </section>
    </div>
  )
}
