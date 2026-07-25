import { useEffect, useState } from 'react'
import { CircleAlert, FileSpreadsheet, Image as ImageIcon, LoaderCircle, Save, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import type { OperationsReportType, OperationsWorkspace } from '../../types/domain'

type OperationsPrinciplesProps = {
  workspace: OperationsWorkspace
  onUpdateProfile: (payload: { principles?: string, dailyReport?: { enabled?: boolean, time?: string } }) => Promise<void>
  onDeleteReport: (id: string) => Promise<void>
}

const reportTypeLabels: Record<OperationsReportType, string> = {
  promotion: '推广报表',
  market: '大盘数据',
  audience: '人群数据',
  competitor: '竞品人群',
}

function timestamp(value: string | null | undefined) {
  if (!value) return '未执行'
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { hour12: false }) : '未执行'
}

export function OperationsPrinciples({ workspace, onUpdateProfile, onDeleteReport }: OperationsPrinciplesProps) {
  const [principles, setPrinciples] = useState(workspace.profile.principles)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => setPrinciples(workspace.profile.principles), [workspace.profile.principles])

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setError('')
    try {
      await task()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成。')
    } finally {
      setBusy('')
    }
  }

  return <div className="space-y-5">
    {error && <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><CircleAlert className="h-4 w-4 shrink-0" />{error}</div>}
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader><CardTitle>我的运营思路</CardTitle></CardHeader>
        <CardContent>
          <textarea value={principles} onChange={(event) => setPrinciples(event.target.value)} rows={13} maxLength={4000} placeholder="例如：新品前 7 天优先看点击率和收藏；ROI 未达保本线连续两天就降预算；高客单价产品不为短期 ROI 牺牲人群质量。" className="w-full resize-y rounded-md border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-800 outline-none focus:border-blue-500" />
          <div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-slate-400">{principles.length}/4000</span><Button type="button" onClick={() => void run('principles', () => onUpdateProfile({ principles }))} disabled={busy === 'principles'}>{busy === 'principles' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存思路</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>每日经营日报</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm text-slate-700"><span>自动发送飞书日报</span><input type="checkbox" checked={workspace.profile.dailyReport.enabled} onChange={(event) => void run('schedule', () => onUpdateProfile({ dailyReport: { enabled: event.target.checked } }))} className="h-4 w-4 accent-blue-600" /></label>
          <label className="block space-y-1 text-xs font-medium text-slate-600"><span>发送时间</span><input type="time" value={workspace.profile.dailyReport.time} onChange={(event) => void run('schedule-time', () => onUpdateProfile({ dailyReport: { time: event.target.value } }))} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500" /></label>
          <div className="border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500"><div>上次生成：{timestamp(workspace.profile.dailyReport.lastRunAt)}</div><div>上次发送：{timestamp(workspace.profile.dailyReport.lastSentAt)}</div>{workspace.profile.dailyReport.lastError && <div className="mt-2 text-red-600">{workspace.profile.dailyReport.lastError}</div>}</div>
        </CardContent>
      </Card>
    </section>
    <Card>
      <CardHeader><CardTitle>已导入数据</CardTitle></CardHeader>
      <div className="divide-y divide-slate-100">{workspace.reports.length ? workspace.reports.map((report) => <div key={report.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><div className="flex items-center gap-2 text-sm font-medium text-slate-800">{report.kind === 'screenshot' ? <ImageIcon className="h-4 w-4 text-blue-600" /> : <FileSpreadsheet className="h-4 w-4 text-emerald-600" />}<span className="truncate">{report.fileName}</span></div><div className="mt-1 text-xs text-slate-400">{reportTypeLabels[report.type]} · {report.storeName || '未标记店铺'} · {report.reportDate} · {report.rows.length ? `${report.rows.length} 行` : '截图'}</div></div><Button type="button" size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" title="删除数据" aria-label={`删除 ${report.fileName}`} onClick={() => void run(`delete-${report.id}`, () => onDeleteReport(report.id))}><Trash2 className="h-4 w-4" /></Button></div>) : <div className="px-4 py-10 text-center text-sm text-slate-400">暂无运营数据</div>}</div>
    </Card>
  </div>
}
