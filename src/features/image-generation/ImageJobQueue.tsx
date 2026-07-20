import { useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  Images,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  RotateCw,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import type { ImageGenerationJob, ImageGenerationJobStatus, ImageLibraryItem } from '../../types/domain'
import { visiblePrompt } from '../prompt-studio/promptLayers'

type Props = {
  jobs: ImageGenerationJob[]
  loading: boolean
  error: string
  busyJobId: string
  onRefresh: () => void
  onRetry: (job: ImageGenerationJob) => void
  onCancel: (job: ImageGenerationJob) => void
  onOpenImage: (image: ImageLibraryItem) => void
}

const statusMeta: Record<ImageGenerationJobStatus, {
  label: string
  className: string
  icon: typeof Clock3
}> = {
  queued: { label: '排队中', className: 'bg-amber-50 text-amber-700', icon: Clock3 },
  running: { label: '生成中', className: 'bg-blue-50 text-blue-700', icon: LoaderCircle },
  succeeded: { label: '已完成', className: 'bg-emerald-50 text-emerald-700', icon: Check },
  failed: { label: '失败', className: 'bg-red-50 text-red-700', icon: CircleAlert },
  cancelled: { label: '已取消', className: 'bg-slate-100 text-slate-500', icon: Ban },
}

function elapsedMs(job: ImageGenerationJob, now: number) {
  if (job.status !== 'running' && typeof job.durationMs === 'number' && job.durationMs >= 0) return job.durationMs
  const started = job.startedAt ? new Date(job.startedAt).getTime() : 0
  if (!started) return 0
  const finishedAt = job.finishedAt || job.completedAt
  const finished = finishedAt ? new Date(finishedAt).getTime() : now
  return Math.max(0, finished - started)
}

function durationLabel(value: number) {
  const seconds = Math.max(0, Math.round(value / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

function jobSummary(job: ImageGenerationJob, now: number) {
  const position = job.queuePosition ?? job.position
  if (job.status === 'queued') return position ? `前方 ${Math.max(0, position - 1)} 个任务` : '等待调度'
  if (job.status === 'running') return `已用时 ${durationLabel(elapsedMs(job, now))}`
  if (job.status === 'succeeded') return `耗时 ${durationLabel(elapsedMs(job, now))}`
  if (job.status === 'failed') return job.startedAt ? `耗时 ${durationLabel(elapsedMs(job, now))}` : '未开始生成'
  return job.startedAt ? `运行 ${durationLabel(elapsedMs(job, now))} 后取消` : '排队时取消'
}

export function ImageJobQueue({ jobs, loading, error, busyJobId, onRefresh, onRetry, onCancel, onOpenImage }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [unavailableImageIds, setUnavailableImageIds] = useState<Set<string>>(() => new Set())
  const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running')

  useEffect(() => {
    if (!hasActive) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActive])

  const ordered = useMemo(() => [...jobs].sort((left, right) => {
    const leftActive = left.status === 'queued' || left.status === 'running'
    const rightActive = right.status === 'queued' || right.status === 'running'
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    if (left.status === 'running' && right.status === 'queued') return -1
    if (left.status === 'queued' && right.status === 'running') return 1
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  }), [jobs])
  const visibleJobs = expanded ? ordered : ordered.slice(0, 4)
  const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length

  return (
    <section className="border-b border-slate-200 bg-white" aria-labelledby="image-job-queue-title">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${activeCount ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}><ListChecks className="h-4 w-4" /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h3 id="image-job-queue-title" className="text-sm font-semibold text-slate-900">生图队列</h3>{activeCount > 0 && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">{activeCount} 个进行中</span>}</div>
            <p className="mt-0.5 text-xs text-slate-500">任务在后台继续，刷新页面后仍可查看进度</p>
          </div>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新生图队列" aria-label="刷新生图队列"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      {error && <div className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" role="alert"><span>{error}</span><button type="button" className="shrink-0 font-semibold hover:underline" onClick={onRefresh}>重试</button></div>}

      {!jobs.length && !loading ? <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 text-xs text-slate-500"><Images className="h-4 w-4" />还没有任务，提交后会立即出现在这里。</div>
        : <div className={`divide-y divide-slate-100 border-t border-slate-100 ${expanded ? 'max-h-[32rem] overflow-y-auto' : ''}`}>
          {visibleJobs.map((job) => {
            const meta = statusMeta[job.status]
            const StatusIcon = meta.icon
            const isBusy = busyJobId === job.id
            const resultImages = job.result?.images || []
            return <article key={job.id} className="grid min-w-0 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${meta.className}`}><StatusIcon className={`h-3 w-3 ${job.status === 'running' ? 'animate-spin' : ''}`} />{meta.label}</span>
                  <span className="truncate text-sm font-medium text-slate-800" title={visiblePrompt(job.request.prompt)}>{visiblePrompt(job.request.prompt) || '未命名生图任务'}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                  <span>{job.request.ratio}</span><span>{job.request.resolution.toUpperCase()}</span><span>{job.request.count} 张</span>{job.referenceImageCount > 0 && <span>{job.referenceImageCount} 张参考图</span>}<span>{jobSummary(job, now)}</span>{job.attempt > 1 && <span>第 {job.attempt} 次</span>}
                </div>
                {job.status === 'failed' && job.error?.message && <p className="mt-1 line-clamp-2 text-xs text-red-600">{job.error.message}</p>}
              </div>

              <div className="flex min-w-0 items-center justify-end gap-2">
                {resultImages.length > 0 && <div className="flex -space-x-1.5">{resultImages.slice(0, 3).map((image) => unavailableImageIds.has(image.id)
                  ? <span key={image.id} className="inline-flex h-9 w-9 items-center justify-center rounded border-2 border-white bg-slate-100 text-slate-400 shadow-sm" title="图片已从历史中删除"><Images className="h-4 w-4" /></span>
                  : <button key={image.id} type="button" onClick={() => onOpenImage(image)} className="h-9 w-9 overflow-hidden rounded border-2 border-white bg-slate-100 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="查看生成结果"><img src={api.imageFileUrl(image.id, true)} alt="生成结果" loading="lazy" className="h-full w-full object-cover" onError={() => setUnavailableImageIds((current) => new Set(current).add(image.id))} /></button>)}</div>}
                {(job.status === 'queued' || job.status === 'running') && <Button type="button" variant="secondary" size="sm" disabled={isBusy} onClick={() => onCancel(job)} className="text-slate-600">{isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}取消</Button>}
                {(job.status === 'failed' || job.status === 'cancelled') && (job.error?.retryable !== false) && <Button type="button" variant="secondary" size="sm" disabled={isBusy} onClick={() => onRetry(job)}>{isBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}重试</Button>}
              </div>
            </article>
          })}
        </div>}

      {ordered.length > 4 && <button type="button" onClick={() => setExpanded((value) => !value)} className="flex h-9 w-full items-center justify-center gap-1 border-t border-slate-100 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800">{expanded ? <><ChevronUp className="h-4 w-4" />收起队列</> : <><ChevronDown className="h-4 w-4" />查看全部 {ordered.length} 个任务</>}</button>}
    </section>
  )
}
