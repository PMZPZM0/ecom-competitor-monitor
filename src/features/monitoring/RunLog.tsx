import { Activity, CheckCircle2, Clock, RotateCw, XCircle } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { timeAgo } from '../../lib/utils'
import type { RunRecord } from '../../types/domain'

function sourceLabel(source: RunRecord['source']) {
  if (source === 'scheduled') return '后台定时'
  if (source === 'manual-product') return '单品手动'
  if (source === 'manual-all') return '全部手动'
  if (source === 'manual-batch') return '批量抓取'
  if (source === 'local-import') return '本地导入'
  return '单品抓取'
}

function statusTone(status: RunRecord['status']) {
  if (status === 'success') return 'border-emerald-100 bg-emerald-50 text-emerald-700'
  if (status === 'partial') return 'border-amber-100 bg-amber-50 text-amber-700'
  return 'border-red-100 bg-red-50 text-red-700'
}

const accountLabels = { normal: '普通账号', gift: '礼金账号', vip88: '88VIP账号' }

type Props = {
  runs: RunRecord[]
  busy?: boolean
  onRetryFailed?: (run: RunRecord) => Promise<void>
}

export function RunLog({ runs, busy = false, onRetryFailed }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-600" />
          运行日志
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[320px] space-y-3 overflow-auto">
        {runs.map((run) => {
          const failedItems = (run.items || []).filter((item) => item.status === 'failed')
          return <div key={run.id} className="rounded-md border border-slate-100 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-slate-950">
                  {run.status === 'failed' ? <XCircle className="h-4 w-4 text-red-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                  {sourceLabel(run.source)}
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">{run.message}</div>
              </div>
              <Badge className={statusTone(run.status)}>
                {run.status === 'success' ? '成功' : run.status === 'partial' ? '部分失败' : '失败'}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {timeAgo(run.finishedAt)}
              </span>
              <span>总数 {run.total}</span>
              <span>成功 {run.success}</span>
              <span>失败 {run.failed}</span>
            </div>
            {!!run.items?.length && <details className="mt-3 border-t border-slate-100 pt-2" open={run.status !== 'success'}>
              <summary className="cursor-pointer select-none text-xs font-medium text-slate-600">逐商品结果（{run.items.length}）</summary>
              <div className="mt-2 divide-y divide-slate-100 bg-slate-50 px-3">
                {run.items.map((item, index) => <div key={`${item.productId}-${index}`} className="flex items-start gap-2 py-2 text-xs">
                  {item.status === 'failed' ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" /> : <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${item.status === 'partial' ? 'text-amber-600' : 'text-emerald-600'}`} />}
                  <div className="min-w-0 flex-1"><div className="truncate font-medium text-slate-800" title={item.name}>{item.name}</div><div className="mt-0.5 text-slate-500">{accountLabels[item.accountType]} · 商品 ID {item.requestedItemId || item.itemId || '未识别'}</div><div className={`mt-1 leading-5 ${item.status === 'failed' ? 'text-red-700' : item.status === 'partial' ? 'text-amber-700' : 'text-slate-500'}`}>{item.message}</div></div>
                </div>)}
              </div>
              {!!failedItems.length && onRetryFailed && <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={busy} onClick={() => onRetryFailed(run)}><RotateCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />重试失败商品（{failedItems.length}）</Button>}
            </details>}
          </div>
        })}
        {runs.length === 0 && <p className="text-sm text-slate-400">还没有运行记录。</p>}
      </CardContent>
    </Card>
  )
}
