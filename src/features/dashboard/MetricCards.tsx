import { AlertTriangle, Image, PackageSearch, Timer } from 'lucide-react'
import { Card, CardContent } from '../../components/ui/card'
import { timeAgo } from '../../lib/utils'
import type { Overview } from '../../types/domain'

export function MetricCards({ overview }: { overview: Overview }) {
  const errors = overview.products.filter((product) => product.lastStatus === 'error').length
  const imageCount = overview.snapshots[0]?.rawSignals?.imageCount ?? 0
  const metrics = [
    { label: '监控商品', value: overview.products.length, icon: PackageSearch, tone: 'emerald' },
    { label: '最近主图数', value: imageCount, icon: Image, tone: 'sky' },
    { label: '异常商品', value: errors, icon: AlertTriangle, tone: 'amber' },
    { label: '上次运行', value: timeAgo(overview.monitor.lastRunAt), icon: Timer, tone: 'slate' },
  ]

  return (
    <div className="grid grid-cols-4 gap-4 max-[950px]:grid-cols-2">
      {metrics.map((metric) => (
        <Card key={metric.label}>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-500">{metric.label}</div>
              <div className="mt-2 text-2xl font-semibold text-slate-950">{metric.value}</div>
            </div>
            <div className="rounded-md bg-emerald-50 p-3 text-emerald-700">
              <metric.icon className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
