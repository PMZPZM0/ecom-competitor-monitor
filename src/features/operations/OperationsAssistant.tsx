import { useEffect, useRef, useState } from 'react'
import { BarChart3, Check, CircleAlert, ClipboardPaste, Clock3, FileSpreadsheet, LoaderCircle, Send, Sparkles, Target, Upload, UsersRound, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import type { OperationsAnalysis, OperationsReportType, OperationsTarget, OperationsWorkspace } from '../../types/domain'

type OperationsAssistantProps = {
  workspace: OperationsWorkspace
  onUpload: (file: File, payload: { type: OperationsReportType, storeName?: string, reportDate?: string, sourceName?: string }) => Promise<void>
  onUpdateTarget: (key: string, target: OperationsTarget) => Promise<void>
  onFeedback: (id: string, status: 'adopted' | 'skipped' | 'outcome') => Promise<void>
  onAnalyze: () => Promise<OperationsAnalysis>
  onRunDailyReport: () => Promise<{ analysis: OperationsAnalysis, sent: boolean, sendError: string }>
}

type View = 'overview' | 'products' | 'audiences'

const reportTypeLabels: Record<OperationsReportType, string> = {
  promotion: '推广报表',
  market: '大盘数据',
  audience: '人群数据',
  competitor: '竞品人群',
}

const defaultTarget: OperationsTarget = { targetRoi: 2, maxFeeRate: 0.3, dailyBudgetCap: 0 }

function pastedDataFile(value: string) {
  const source = value.trim()
  if (!source) return null
  if (source.startsWith('[') || source.startsWith('{')) {
    return new File([source], '粘贴运营数据.json', { type: 'application/json' })
  }
  const csv = source.includes('\t')
    ? source.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('\t').map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n')
    : source
  return new File([csv], '粘贴运营数据.csv', { type: 'text/csv' })
}

function money(value: number | null | undefined) {
  return Number.isFinite(value) ? `¥${Number(value).toFixed(2)}` : '--'
}

function percent(value: number | null | undefined) {
  return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(1)}%` : '--'
}

function timestamp(value: string | null | undefined) {
  if (!value) return '未导入'
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { hour12: false }) : '未导入'
}

function actionTone(action: string) {
  if (action === '加预算') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (action === '暂停观察') return 'bg-red-50 text-red-700 ring-red-200'
  if (action === '降预算') return 'bg-amber-50 text-amber-700 ring-amber-200'
  return 'bg-slate-100 text-slate-600 ring-slate-200'
}

function Metric({ label, value, detail }: { label: string, value: string, detail: string }) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-4">
        <div className="text-xs text-slate-500">{label}</div>
        <div className="mt-1 truncate text-2xl font-semibold text-slate-950">{value}</div>
        <div className="mt-1 truncate text-xs text-slate-400">{detail}</div>
      </CardContent>
    </Card>
  )
}

export function OperationsAssistant({
  workspace,
  onUpload,
  onUpdateTarget,
  onFeedback,
  onAnalyze,
  onRunDailyReport,
}: OperationsAssistantProps) {
  const [view, setView] = useState<View>('overview')
  const [reportType, setReportType] = useState<OperationsReportType>('promotion')
  const [storeName, setStoreName] = useState('')
  const [reportDate, setReportDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [sourceName, setSourceName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pastedData, setPastedData] = useState('')
  const [analysis, setAnalysis] = useState<OperationsAnalysis | null>(workspace.analyses[0] || null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => setAnalysis(workspace.analyses[0] || null), [workspace.analyses])

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

  async function upload() {
    if (!selectedFile) {
      setError('请先选择报表或截图。')
      return
    }
    await run('upload', async () => {
      await onUpload(selectedFile, { type: reportType, storeName, reportDate, sourceName })
      setSelectedFile(null)
      if (fileInput.current) fileInput.current.value = ''
    })
  }

  async function uploadPastedData() {
    const file = pastedDataFile(pastedData)
    if (!file) {
      setError('请先粘贴 Excel/WPS 表格或 JSON 数据。')
      return
    }
    await run('paste', async () => {
      await onUpload(file, { type: reportType, storeName, reportDate, sourceName })
      setPastedData('')
      setPasteOpen(false)
    })
  }

  const tabs: Array<{ id: View, label: string, icon: typeof BarChart3 }> = [
    { id: 'overview', label: '经营总览', icon: BarChart3 },
    { id: 'products', label: '商品与计划', icon: Target },
    { id: 'audiences', label: '人群分析', icon: UsersRound },
  ]

  const freshLabel = workspace.freshness.fresh ? '数据可用' : '数据已过期'

  return (
    <div className="space-y-5">
      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ring-1 ${workspace.freshness.fresh ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-amber-200'}`}><Clock3 className="h-3.5 w-3.5" />{freshLabel}</span>
            <span className="text-xs text-slate-400">最近导入 {timestamp(workspace.freshness.latestAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => void run('daily', async () => { const result = await onRunDailyReport(); setAnalysis(result.analysis); if (!result.sent && result.sendError) setError(result.sendError) })} disabled={Boolean(busy)}><Send className="h-4 w-4" />发送日报</Button>
          <Button type="button" onClick={() => void run('analyze', async () => setAnalysis(await onAnalyze()))} disabled={Boolean(busy) || !workspace.reports.length}>{busy === 'analyze' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}运行分析</Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="推广消耗" value={money(workspace.totals.spend)} detail={`${workspace.products.length} 个单品`} />
        <Metric label="成交金额" value={money(workspace.totals.revenue)} detail={`${Math.round(workspace.totals.orders || 0)} 个订单`} />
        <Metric label="整体 ROI" value={Number.isFinite(workspace.totals.roi) ? Number(workspace.totals.roi).toFixed(2) : '--'} detail={`转化率 ${percent(workspace.totals.conversionRate)}`} />
        <Metric label="整体费率" value={percent(workspace.totals.feeRate)} detail={`${workspace.suggestions.length} 条推广建议`} />
      </section>

      <section className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = tab.id === view
          return <button key={tab.id} type="button" onClick={() => setView(tab.id)} className={`inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium ${active ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><Icon className="h-4 w-4" />{tab.label}</button>
        })}
      </section>

      {error && <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><CircleAlert className="h-4 w-4 shrink-0" />{error}</div>}

      {view === 'overview' && <div className="space-y-5">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div><CardTitle>导入运营数据</CardTitle><p className="mt-1 text-xs text-slate-500">XLSX、CSV、JSON 或截图</p></div>
            <div className="flex items-center gap-2"><span className="inline-flex items-center gap-2 text-xs text-slate-500"><FileSpreadsheet className="h-4 w-4" />本地保存</span><Button type="button" size="sm" variant="secondary" onClick={() => setPasteOpen((value) => !value)}><ClipboardPaste className="h-4 w-4" />粘贴数据</Button></div>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-[150px_150px_150px_150px_minmax(0,1fr)_auto] lg:items-end">
            <label className="space-y-1 text-xs font-medium text-slate-600"><span>数据类型</span><select value={reportType} onChange={(event) => setReportType(event.target.value as OperationsReportType)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500">{Object.entries(reportTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="space-y-1 text-xs font-medium text-slate-600"><span>数据日期</span><input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500" /></label>
            <label className="space-y-1 text-xs font-medium text-slate-600"><span>店铺</span><input value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="可选" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500" /></label>
            <label className="space-y-1 text-xs font-medium text-slate-600"><span>来源</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="万相台 / 达摩盘" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500" /></label>
            <label className="space-y-1 text-xs font-medium text-slate-600"><span>文件</span><button type="button" onClick={() => fileInput.current?.click()} className="flex h-10 w-full items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 text-left text-sm text-slate-600 hover:border-blue-300 hover:bg-blue-50"><Upload className="h-4 w-4 shrink-0" /><span className="truncate">{selectedFile?.name || '选择报表或截图'}</span></button><input ref={fileInput} type="file" accept=".xlsx,.csv,.json,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} /></label>
            <Button type="button" onClick={() => void upload()} disabled={busy === 'upload'}>{busy === 'upload' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}导入</Button>
          </CardContent>
          {pasteOpen && <div className="border-t border-slate-100 bg-slate-50/70 p-4">
            <div className="mb-2 flex items-center justify-between gap-3"><div><div className="text-sm font-medium text-slate-800">粘贴表格数据</div><div className="mt-0.5 text-xs text-slate-500">从 Excel/WPS 复制包含表头的数据区域，点击下方输入框后直接粘贴；也支持 JSON。</div></div><Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0" title="关闭粘贴区" aria-label="关闭粘贴区" onClick={() => setPasteOpen(false)}><X className="h-4 w-4" /></Button></div>
            <textarea autoFocus value={pastedData} onChange={(event) => setPastedData(event.target.value)} rows={7} placeholder={'商品名称\t消耗\t成交金额\t订单数\n示例商品\t100\t500\t8'} className="w-full resize-y rounded-md border border-slate-200 bg-white p-3 font-mono text-xs leading-5 text-slate-800 outline-none focus:border-blue-500" />
            <div className="mt-3 flex justify-end"><Button type="button" onClick={() => void uploadPastedData()} disabled={busy === 'paste' || !pastedData.trim()}>{busy === 'paste' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}导入粘贴数据</Button></div>
          </div>}
        </Card>

        {analysis && <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle>今日经营结论</CardTitle><span className="text-xs text-slate-400">{analysis.mode === 'ai' ? '模型分析' : '本地公式'} · {timestamp(analysis.createdAt)}</span></CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
            <div><p className="text-sm leading-6 text-slate-800">{analysis.summary}</p>{analysis.insights.length > 0 && <div className="mt-4 space-y-2">{analysis.insights.map((item) => <div key={item} className="border-l-2 border-blue-300 pl-3 text-sm leading-5 text-slate-600">{item}</div>)}</div>}</div>
            <div className="space-y-2 border-t border-slate-100 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0"><div className="text-xs font-semibold text-slate-500">优先行动</div>{analysis.actions.slice(0, 5).map((item, index) => <div key={item} className="flex gap-2 text-sm leading-5 text-slate-700"><span className="font-semibold text-blue-600">{index + 1}</span><span>{item}</span></div>)}</div>
          </CardContent>
        </Card>}

        <Card>
          <CardHeader><CardTitle>推广建议</CardTitle></CardHeader>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 font-medium">单品</th><th className="px-4 py-3 font-medium">消耗 / 成交</th><th className="px-4 py-3 font-medium">ROI / 费率</th><th className="px-4 py-3 font-medium">建议</th><th className="px-4 py-3 font-medium">依据</th><th className="px-4 py-3 font-medium text-right">反馈</th></tr></thead><tbody>{workspace.suggestions.length ? workspace.suggestions.map((item) => <tr key={item.id} className="border-b border-slate-100 last:border-0"><td className="px-4 py-3"><div className="font-medium text-slate-900">{item.productName}</div><div className="mt-1 text-xs text-slate-400">{item.productStage === 'new' ? '新品' : item.productStage === 'mature' ? '老品' : '阶段未标记'}</div></td><td className="px-4 py-3 text-slate-700">{money(item.spend)}<span className="mx-1 text-slate-300">/</span>{money(item.revenue)}</td><td className="px-4 py-3 text-slate-700">{Number.isFinite(item.roi) ? Number(item.roi).toFixed(2) : '--'}<span className="mx-1 text-slate-300">/</span>{percent(item.feeRate)}</td><td className="px-4 py-3"><span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ring-1 ${actionTone(item.action)}`}>{item.action}{item.change ? ` ${item.change > 0 ? '+' : ''}${item.change}%` : ''}</span></td><td className="max-w-sm px-4 py-3 text-xs leading-5 text-slate-500">{item.reason}</td><td className="px-4 py-3 text-right">{item.feedback ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" />{item.feedback.status === 'adopted' ? '已采纳' : item.feedback.status === 'skipped' ? '未采纳' : '已复盘'}</span> : <div className="inline-flex gap-1"><Button type="button" size="sm" variant="secondary" onClick={() => void run(`feedback-${item.id}`, () => onFeedback(item.id, 'adopted'))}>采纳</Button><Button type="button" size="sm" variant="ghost" onClick={() => void run(`feedback-${item.id}`, () => onFeedback(item.id, 'skipped'))}>跳过</Button></div>}</td></tr>) : <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">导入最新推广报表后生成建议</td></tr>}</tbody></table></div>
        </Card>
      </div>}

      {view === 'products' && <div className="space-y-5">
        <Card><CardHeader><CardTitle>单品与计划费率</CardTitle></CardHeader><div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 font-medium">单品</th><th className="px-4 py-3 font-medium">消耗</th><th className="px-4 py-3 font-medium">成交</th><th className="px-4 py-3 font-medium">ROI</th><th className="px-4 py-3 font-medium">费率</th><th className="px-4 py-3 font-medium">目标</th></tr></thead><tbody>{workspace.products.map((item) => { const target = workspace.profile.targets[item.key || item.name] || defaultTarget; return <ProductTargetRow key={item.key || item.name} item={item} target={target} busy={busy} onSave={(next) => void run(`target-${item.key || item.name}`, () => onUpdateTarget(item.key || item.name, next))} /> })}</tbody></table></div></Card>
        <section className="grid gap-3 lg:grid-cols-2"><Card><CardHeader><CardTitle>店铺费率</CardTitle></CardHeader><CardContent className="space-y-3">{workspace.stores.map((item) => <GroupLine key={item.name} item={item} />)}</CardContent></Card><Card><CardHeader><CardTitle>类目费率</CardTitle></CardHeader><CardContent className="space-y-3">{workspace.categories.map((item) => <GroupLine key={item.name} item={item} />)}</CardContent></Card></section>
      </div>}

      {view === 'audiences' && <div className="space-y-5">
        <Card><CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle>人群表现</CardTitle><span className="text-xs text-slate-400">达摩盘 / 单品人群 / 竞品人群</span></CardHeader><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-y border-slate-100 bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 font-medium">人群</th><th className="px-4 py-3 font-medium">消耗</th><th className="px-4 py-3 font-medium">成交</th><th className="px-4 py-3 font-medium">ROI</th><th className="px-4 py-3 font-medium">费率</th></tr></thead><tbody>{workspace.audiences.length ? workspace.audiences.map((item) => <tr key={item.name} className="border-b border-slate-100 last:border-0"><td className="px-4 py-3 font-medium text-slate-900">{item.name}</td><td className="px-4 py-3 text-slate-700">{money(item.spend)}</td><td className="px-4 py-3 text-slate-700">{money(item.revenue)}</td><td className="px-4 py-3 text-slate-700">{Number.isFinite(item.roi) ? Number(item.roi).toFixed(2) : '--'}</td><td className="px-4 py-3 text-slate-700">{percent(item.feeRate)}</td></tr>) : <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">导入达摩盘或人群报表后显示分析</td></tr>}</tbody></table></div></Card>
      </div>}

    </div>
  )
}

function GroupLine({ item }: { item: OperationsWorkspace['stores'][number] }) {
  return <div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-medium text-slate-800">{item.name}</div><div className="mt-1 text-xs text-slate-400">消耗 {money(item.spend)} · 成交 {money(item.revenue)}</div></div><div className="text-right"><div className="text-sm font-semibold text-slate-800">{Number.isFinite(item.roi) ? Number(item.roi).toFixed(2) : '--'}</div><div className="mt-1 text-xs text-slate-400">费率 {percent(item.feeRate)}</div></div></div>
}

function ProductTargetRow({ item, target, busy, onSave }: { item: OperationsWorkspace['products'][number], target: OperationsTarget, busy: string, onSave: (target: OperationsTarget) => void }) {
  const [draft, setDraft] = useState(target)
  useEffect(() => setDraft(target), [target])
  return <tr className="border-b border-slate-100 last:border-0"><td className="px-4 py-3 font-medium text-slate-900">{item.name}</td><td className="px-4 py-3 text-slate-700">{money(item.spend)}</td><td className="px-4 py-3 text-slate-700">{money(item.revenue)}</td><td className="px-4 py-3 text-slate-700">{Number.isFinite(item.roi) ? Number(item.roi).toFixed(2) : '--'}</td><td className="px-4 py-3 text-slate-700">{percent(item.feeRate)}</td><td className="px-4 py-3"><div className="flex items-center gap-2"><input aria-label={`${item.name} 保本 ROI`} type="number" min="0.01" step="0.01" value={draft.targetRoi} onChange={(event) => setDraft({ ...draft, targetRoi: Number(event.target.value) })} className="h-8 w-16 rounded border border-slate-200 px-2 text-xs" title="保本 ROI" /><input aria-label={`${item.name} 费率上限`} type="number" min="0.01" max="100" step="0.1" value={Number((draft.maxFeeRate * 100).toFixed(2))} onChange={(event) => setDraft({ ...draft, maxFeeRate: Number(event.target.value) / 100 })} className="h-8 w-16 rounded border border-slate-200 px-2 text-xs" title="费率上限（%）" /><input aria-label={`${item.name} 单日预算上限`} type="number" min="0" step="1" value={draft.dailyBudgetCap} onChange={(event) => setDraft({ ...draft, dailyBudgetCap: Number(event.target.value) })} className="h-8 w-20 rounded border border-slate-200 px-2 text-xs" title="单日预算上限" /><Button type="button" size="sm" variant="secondary" disabled={busy.startsWith('target-')} onClick={() => onSave(draft)}>保存</Button></div><div className="mt-1 text-[11px] text-slate-400">ROI · 费率% · 预算</div></td></tr>
}
