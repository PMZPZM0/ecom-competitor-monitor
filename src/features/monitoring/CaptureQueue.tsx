import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import type { CaptureQueueJob, CaptureQueueStatus } from '../../types/domain'

const sourceLabels: Record<string, string> = {
  'manual-product': '单品手动抓取',
  'single-product': '单品抓取',
  'manual-batch': '新增商品批量抓取',
  'manual-all': '批量抓取',
  scheduled: '定时监控',
  'local-import': '本地数据导入',
}

function statusView(job: CaptureQueueJob) {
  if (job.status === 'running') return { label: '运行中', className: 'bg-blue-50 text-blue-700', icon: LoaderCircle }
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

export function CaptureQueue({ initialStatus }: { initialStatus: CaptureQueueStatus }) {
  const [queue, setQueue] = useState(initialStatus)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setQueue(await api.captureQueue())
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取抓取队列失败。')
    } finally {
      if (showLoading) setLoading(false)
    }
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

  useEffect(() => {
    const timer = window.setInterval(() => refresh(false), 1500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const active = queue.jobs.find((job) => job.status === 'running')

  return (
    <div className="space-y-5">
      <section className="border-y border-slate-200 bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-sm font-semibold text-slate-950">服务端抓取队列</div><div className="mt-1 text-sm text-slate-500">只保留排队和运行任务；完成结果短暂确认后自动移出，长期结果请到数据记录查看。</div></div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>运行 {active ? 1 : 0}</span><span className="text-slate-300">|</span><span>排队 {queue.pendingCount}</span><span className="text-slate-300">|</span><span>完成 {queue.completedCount}</span><Button type="button" variant="secondary" size="sm" onClick={clearFinished} disabled={loading || !queue.completedCount}>清空完成项</Button><Button type="button" variant="secondary" size="sm" onClick={() => refresh(true)} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button></div>
        </div>
        {active && <div className="mt-4 bg-blue-50 px-4 py-3" role="status" aria-live="polite"><div className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate font-medium text-blue-900">{active.message}</span><span className="shrink-0 tabular-nums text-blue-700">{active.completed}/{active.total || '--'}</span></div><div className="mt-2 h-1.5 overflow-hidden bg-blue-100"><div className="h-full bg-blue-600 transition-[width]" style={{ width: `${active.total ? Math.min(100, active.completed / active.total * 100) : 8}%` }} /></div></div>}
        {error && <div className="mt-3 text-sm text-red-700" role="alert">{error}</div>}
      </section>

      <section className="overflow-hidden border-y border-slate-200 bg-white">
        <div className="grid grid-cols-[120px_minmax(220px,1fr)_120px_120px_170px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-500 max-[980px]:hidden"><span>状态</span><span>商品</span><span>来源</span><span>进度</span><span>时间</span></div>
        <div className="divide-y divide-slate-100">
          {queue.jobs.map((job) => {
            const view = statusView(job)
            const Icon = view.icon
            return <div key={job.id} className="grid grid-cols-[120px_minmax(220px,1fr)_120px_120px_170px] items-center gap-3 px-4 py-3 text-sm max-[980px]:grid-cols-1"><span className={`inline-flex w-fit items-center gap-1.5 px-2 py-1 text-xs font-medium ${view.className}`}><Icon className={`h-3.5 w-3.5 ${job.status === 'running' ? 'animate-spin' : ''}`} />{view.label}</span><div className="min-w-0"><div className="truncate font-medium text-slate-800" title={jobNames(job)}>{jobNames(job)}</div><div className="mt-0.5 truncate text-xs text-slate-500">{job.message}</div></div><span className="text-xs text-slate-600">{sourceLabels[job.source] || job.source}</span><span className="tabular-nums text-slate-700">{job.completed}/{job.total || '--'}</span><div className="text-xs leading-5 text-slate-500"><div>{job.startedAt ? new Date(job.startedAt).toLocaleString('zh-CN', { hour12: false }) : '等待开始'}</div>{job.finishedAt && <div>完成 {new Date(job.finishedAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>}</div></div>
          })}
          {!queue.jobs.length && <div className="px-4 py-16 text-center text-sm text-slate-400">暂无抓取任务。添加商品、手动抓取或定时监控后会自动出现在这里；完成项保留 {queue.retentionSeconds || 5} 秒后自动移出。</div>}
        </div>
      </section>
    </div>
  )
}
