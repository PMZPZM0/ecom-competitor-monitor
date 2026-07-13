import { BrainCircuit, WandSparkles } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import type { Analysis } from '../../types/domain'

type Props = {
  analyses: Analysis[]
  onRun: () => Promise<void>
  busy: boolean
}

export function AnalysisPanel({ analyses, onRun, busy }: Props) {
  const latest = analyses[0]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-emerald-600" />
          AI 数据分析
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button type="button" onClick={onRun} disabled={busy} className="w-full">
          <WandSparkles className="h-4 w-4" />
          {busy ? '分析中' : '生成分析报告'}
        </Button>
        {latest ? (
          <div className="space-y-3">
            <div className="rounded-md bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">{latest.summary}</div>
            <div className="space-y-2">
              {latest.insights.map((insight, index) => (
                <div key={index} className="rounded-md border border-slate-100 p-3 text-sm leading-6 text-slate-700">
                  {insight}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm leading-6 text-slate-500">点击生成分析报告。未配置 AI key 时会使用本地规则生成价格趋势洞察。</p>
        )}
      </CardContent>
    </Card>
  )
}
