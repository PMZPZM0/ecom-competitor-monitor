import { useState } from 'react'
import { PauseCircle, PlayCircle, Save, TimerReset } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import type { Overview } from '../../types/domain'

type Props = {
  monitor: Overview['monitor']
  feishu: Overview['feishu']
  onSave: (payload: { intervalMinutes?: number; running?: boolean }) => Promise<void>
}

export function MonitorSettings({ monitor, feishu, onSave }: Props) {
  const [interval, setIntervalValue] = useState(String(monitor.intervalMinutes))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><TimerReset className="h-4 w-4 text-emerald-600" />定时价格监控</CardTitle>
        <div className="mt-1 text-sm text-slate-500">定时任务只抓启用商品并通过账号池轮换；未单独设置的商品使用这里的默认间隔，单品卡片可覆盖。</div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="mb-2 block text-sm font-medium text-slate-700">抓取间隔（分钟）</label>
          <Input min={30} max={1440} type="number" value={interval} onChange={(event) => setIntervalValue(event.target.value)} />
        </div>
        <Button type="button" variant="secondary" className={monitor.running ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'} onClick={() => onSave({ running: !monitor.running })}>
          {monitor.running ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
          {monitor.running ? '暂停全局自动监控' : '开启全局自动监控'}
        </Button>
        <Button type="button" onClick={() => onSave({ intervalMinutes: Math.max(30, Number(interval) || 60) })}>
          <Save className="h-4 w-4" />
          保存设置
        </Button>
        </div>
        <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
          <div className={`rounded-md border px-3 py-2 ${monitor.running ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-amber-100 bg-amber-50 text-amber-800'}`}><div className="font-medium">全局自动监控</div><div className="mt-0.5">{monitor.running ? `已开启；仅抓取已启用商品${monitor.nextRunAt ? ` · 下次 ${new Date(monitor.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : ''}` : '已暂停；单品启停和定时计划均保留'}</div></div>
          <div className={`rounded-md border px-3 py-2 ${feishu.documentEnabled ? 'border-violet-100 bg-violet-50 text-violet-800' : 'border-slate-100 bg-slate-50 text-slate-500'}`}><div className="font-medium">飞书文档</div><div className="mt-0.5">{feishu.documentEnabled ? '每次成功抓取都写入' : '未开启自动写入'}</div></div>
          <div className={`rounded-md border px-3 py-2 ${feishu.enabled ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-slate-100 bg-slate-50 text-slate-500'}`}><div className="font-medium">机器人低价报警</div><div className="mt-0.5">{feishu.enabled ? '每次严格低于 SKU 监控价都提醒' : '未开启自动提醒'}</div></div>
        </div>
      </CardContent>
    </Card>
  )
}
