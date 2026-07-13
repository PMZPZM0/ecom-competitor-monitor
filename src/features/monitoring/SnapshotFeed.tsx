import { Images } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { currency } from '../../lib/utils'
import type { Snapshot } from '../../types/domain'

export function SnapshotFeed({ snapshots }: { snapshots: Snapshot[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Images className="h-4 w-4 text-emerald-600" />
          最近抓取记录
        </CardTitle>
      </CardHeader>
      <CardContent className="max-h-[360px] space-y-3 overflow-auto scrollbar-thin">
        {snapshots.slice(0, 12).map((snapshot) => (
          <div key={snapshot.id} className="rounded-md border border-slate-100 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="line-clamp-1 text-sm font-medium text-slate-900">{snapshot.title}</div>
              <div className="text-sm font-semibold text-emerald-700">{currency(snapshot.price)}</div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <span>{new Date(snapshot.capturedAt).toLocaleString()}</span>
              <span>{snapshot.rawSignals.imageCount} 主图</span>
              <span>{snapshot.rawSignals.skuImageCount} SKU 图</span>
            </div>
          </div>
        ))}
        {snapshots.length === 0 && <p className="text-sm text-slate-400">暂无抓取记录。</p>}
      </CardContent>
    </Card>
  )
}
