import { useEffect, useState } from 'react'
import { BarChart3, BookOpen, CircleAlert, CircleCheck, CloudDownload, Database, FolderTree, ListChecks, LoaderCircle, PauseCircle, PlayCircle, RefreshCw, Search, Settings, Sparkles, Type, X } from 'lucide-react'
import { api } from './lib/api'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { ProductForm } from './features/products/ProductForm'
import { AuthPanel } from './features/auth/AuthPanel'
import { MetricCards } from './features/dashboard/MetricCards'
import { ProductTable } from './features/products/ProductTable'
import { MonitorClassification } from './features/classification/MonitorClassification'
import { AnalysisPanel } from './features/analysis/AnalysisPanel'
import { ModelConfigPanel } from './features/analysis/ModelConfigPanel'
import { SnapshotFeed } from './features/monitoring/SnapshotFeed'
import { DataRecords } from './features/monitoring/DataRecords'
import { MonitorSettings } from './features/monitoring/MonitorSettings'
import { FeishuAuthorization, FeishuSettings } from './features/monitoring/FeishuSettings'
import { BatchCaptureCard } from './features/monitoring/BatchCaptureCard'
import { RunLog } from './features/monitoring/RunLog'
import { MonitorQueue } from './features/monitoring/MonitorQueue'
import { HelpCenter } from './features/help/HelpCenter'
import { UpdateDialog } from './features/updates/UpdateDialog'
import type { AuthSession, Overview, Product, UpdateInfo } from './types/domain'

const navItems = [
  { id: 'overview', label: '监控总览', icon: BarChart3, title: '竞品价格与 SKU 图监控', subtitle: '通过限速队列和账号池轮换抓取，支持价格预警与趋势分析。' },
  { id: 'queue', label: '监控队列', icon: ListChecks, title: '已监控商品队列', subtitle: '集中查看已启用商品的执行顺序、定时计划和运行状态。' },
  { id: 'categories', label: '监控分类', icon: FolderTree, title: '店铺与型号自动分类', subtitle: '按店铺自动建小分类，再按产品型号归档监控数据。' },
  { id: 'auth', label: '账号授权', icon: Settings, title: '淘宝与飞书账号授权', subtitle: '管理淘宝采价账号、飞书扫码授权、价格文档和机器人通知。' },
  { id: 'analysis', label: 'AI 分析（功能开发中）', icon: Sparkles, title: 'AI 数据分析', subtitle: '基于历史抓取数据生成价格、SKU 和图片变化洞察。' },
  { id: 'records', label: '数据记录', icon: Database, title: '数据记录与监控设置', subtitle: '查看历史快照、导出 CSV，并调整后台监控间隔。' },
  { id: 'guide', label: '使用说明', icon: BookOpen, title: '使用说明', subtitle: '从账号授权、商品抓取到自动监控和飞书提醒的完整操作流程。' },
] as const

type PageId = (typeof navItems)[number]['id']
type FontSize = 'small' | 'standard' | 'large'

function App() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [activePage, setActivePage] = useState<PageId>(() => {
    const saved = window.localStorage.getItem('tmall-monitor-active-page')
    return navItems.some((item) => item.id === saved) ? saved as PageId : 'overview'
  })
  const [busy, setBusy] = useState(false)
  const [busyProductId, setBusyProductId] = useState('')
  const [monitorToggleBusy, setMonitorToggleBusy] = useState(false)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [fontSize, setFontSize] = useState<FontSize>(() => (window.localStorage.getItem('ecommerce-monitor-font-size') as FontSize) || 'standard')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')

  async function refresh() {
    setOverview(await api.overview())
  }

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh().catch(() => undefined)
    }
    refresh().catch((err) => setError(err.message))
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [])

  useEffect(() => {
    checkUpdates(false).catch(() => undefined)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('tmall-monitor-active-page', activePage)
  }, [activePage])

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize
    window.localStorage.setItem('ecommerce-monitor-font-size', fontSize)
  }, [fontSize])

  useEffect(() => {
    if ((!notice && !error) || (notice.startsWith('正在') && !error)) return undefined
    const timer = window.setTimeout(() => {
      setNotice('')
      setError('')
    }, error ? 8_000 : 5_000)
    return () => window.clearTimeout(timer)
  }, [notice, error])

  async function checkUpdates(openDialog = true) {
    if (openDialog) setUpdateOpen(true)
    setUpdateChecking(true)
    setUpdateError('')
    try {
      setUpdateInfo(await api.checkUpdate())
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : '检查更新失败。')
    } finally {
      setUpdateChecking(false)
    }
  }

  async function handleAdd(payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88' }) {
    setError('')
    setNotice('正在添加商品，并立即抓取主图、SKU 图和价格...')
    try {
      const product = await api.addProduct(payload)
      setBusyProductId(product.id)
      const result = await api.captureProduct(product.id)
      setNotice(result.run.message)
      await refresh()
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '添加商品失败')
      throw err
    } finally {
      setBusyProductId('')
    }
  }

  async function addProductsBatch(payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88' }) {
    setBusy(true)
    setError('')
    setNotice(`正在创建并抓取 ${payload.urls.length} 个新商品，每组最多并发 5 个，其余排队...`)
    try {
      const result = await api.addProductsBatch(payload)
      setNotice(result.message)
      await refresh()
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '批量抓取失败')
    } finally { setBusy(false) }
  }

  async function toggleMonitorRunning(showFeedback = true) {
    setMonitorToggleBusy(true)
    if (showFeedback) {
      setError('')
      setNotice('')
    }
    try {
      const running = !data.monitor.running
      await api.updateMonitor({ running })
      if (showFeedback) {
        setNotice(running
          ? '全局自动监控已开启；仅已启用的商品会按各自计划抓取。'
          : '全局自动监控已暂停；每个商品的启停状态和定时计划均已保留。')
      }
      await refresh()
    } catch (err) {
      if (showFeedback) setError(err instanceof Error ? err.message : '监控启停失败')
      else throw err
    } finally {
      setMonitorToggleBusy(false)
    }
  }

  async function runAnalysis() {
    setAnalysisBusy(true)
    setError('')
    setNotice('正在生成分析报告...')
    try {
      await api.runAnalysis()
      setNotice('分析报告已生成。')
      await refresh()
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '分析失败')
    } finally {
      setAnalysisBusy(false)
    }
  }

  async function toggleProduct(product: Product) {
    await api.updateProduct(product.id, { enabled: !product.enabled })
    await refresh()
  }

  async function saveProductSchedule(product: Product, intervalMinutes: number, monitorStartAt: string) {
    await api.updateProduct(product.id, { monitorIntervalMinutes: intervalMinutes, monitorStartAt })
    await refresh()
  }

  async function captureProduct(product: Product) {
    setBusyProductId(product.id)
    try {
      const result = await api.captureProduct(product.id)
      await refresh()
      return result.product
    } finally {
      setBusyProductId('')
    }
  }

  async function retryBuyerShows(product: Product) {
    setBusyProductId(product.id)
    try {
      const result = await api.retryBuyerShows(product.id)
      await refresh()
      return result.product
    } finally {
      setBusyProductId('')
    }
  }

  async function deleteProduct(product: Product) {
    if (!window.confirm(`确定删除「${product.name}」？相关历史记录也会一起删除。`)) return
    setError('')
    setNotice('')
    await api.deleteProduct(product.id)
    setNotice('商品和相关历史记录已删除。')
    await refresh()
  }

  async function deleteProductsBatch(products: Product[]) {
    if (!products.length) return
    if (!window.confirm(`确定批量删除选中的 ${products.length} 个商品？相关历史记录也会一起删除。`)) return
    setError('')
    setNotice('')
    try {
      const result = await api.deleteProductsBatch(products.map((product) => product.id))
      setNotice(`已批量删除 ${result.deleted} 个商品及相关历史记录。`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量删除失败')
    }
  }

  async function captureProductsBatch(products: Product[], showFeedback = true) {
    if (!products.length) return
    setBusy(true)
    if (showFeedback) {
      setError('')
      setNotice(`正在抓取 ${products.length} 个选中商品，每组最多并发 5 个，其余排队...`)
    }
    try {
      const result = await api.captureProductsBatch(products.map((product) => product.id))
      if (showFeedback) setNotice(result.run.message)
      await refresh()
    } catch (err) {
      if (showFeedback) {
        setNotice('')
        setError(err instanceof Error ? err.message : '批量抓取失败')
      }
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function pauseProductsBatch(products: Product[]) {
    await Promise.all(products.filter((product) => product.enabled).map((product) => api.updateProduct(product.id, { enabled: false })))
    await refresh()
  }

  async function activateSession(session: AuthSession) {
    setError('')
    setNotice('')
    await api.activateAuthSession(session.id)
    setNotice(session.enabled ?? session.active ? '该账号已停止参与采价。' : '该账号已加入多账号采价。')
    await refresh()
  }

  async function deleteSession(session: AuthSession) {
    if (!window.confirm(`确定删除「${session.name}」授权会话？`)) return
    setError('')
    setNotice('')
    await api.deleteAuthSession(session.id)
    setNotice('授权会话已删除。')
    await refresh()
  }

  async function clearSnapshots() {
    if (!window.confirm('确定清空全部价格与 SKU 历史记录？商品链接会保留。')) return
    setError('')
    setNotice('')
    await api.clearSnapshots()
    setNotice('历史抓取记录已清空。')
    await refresh()
  }

  async function saveMonitorSettings(payload: { intervalMinutes?: number; captureProtectionMinutes?: number; captureProtectionByAccount?: Partial<Record<'normal' | 'gift' | 'vip88', number | null>>; running?: boolean }) {
    setError('')
    setNotice('')
    await api.updateMonitor(payload)
    setNotice('监控设置已保存，后台调度已重新生效。')
    await refresh()
  }

  async function saveModelConfig(payload: { baseUrl?: string; apiKey?: string; model?: string }) {
    setError('')
    setNotice('')
    await api.updateModelConfig(payload)
    setNotice('模型配置已保存，后续 AI 分析会使用该配置。')
    await refresh()
  }

  async function saveFeishuSettings(payload: { enabled?: boolean; webhookUrl?: string; signingSecret?: string; clearSigningSecret?: boolean; cooldownEnabled?: boolean; cooldownMinutes?: number; documentEnabled?: boolean }) {
    setError('')
    await api.updateFeishuSettings(payload)
    setNotice('飞书提醒配置已保存。')
    await refresh()
  }

  async function testFeishu() {
    setError('')
    try {
      await api.testFeishu()
      setNotice('飞书测试消息已发送。')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '飞书测试失败')
      await refresh()
    }
  }

  if (!overview) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fa] text-slate-500">正在加载本地监控工作台...</div>
  }

  const data = overview
  const runs = data.runs || []
  const currentPage = navItems.find((item) => item.id === activePage) ?? navItems[0]

  const productTable = (
    <ProductTable
      products={data.products}
      totalProducts={data.products.length}
      onToggle={toggleProduct}
      onToggleGlobal={() => toggleMonitorRunning(false)}
      onSchedule={saveProductSchedule}
      onCapture={captureProduct}
      onRetryBuyerShows={retryBuyerShows}
      onDelete={deleteProduct}
      busyProductId={busyProductId}
      authSessions={data.authSessions}
      monitor={data.monitor}
    />
  )

  const productForm = <ProductForm sessions={data.authSessions} onAdd={handleAdd} />

  const classificationPanel = (
    <div className="space-y-5"><MonitorSettings monitor={data.monitor} feishu={data.feishu} onSave={saveMonitorSettings} /><MonitorClassification products={data.products} authSessions={data.authSessions} monitor={data.monitor} onToggle={toggleProduct} onToggleGlobal={() => toggleMonitorRunning(false)} onSchedule={saveProductSchedule} onCapture={captureProduct} onRetryBuyerShows={retryBuyerShows} onCaptureBatch={captureProductsBatch} onDelete={deleteProduct} onDeleteBatch={deleteProductsBatch} batchBusy={busy} busyProductId={busyProductId} /></div>
  )

  const authPanel = (
    <AuthPanel
      sessions={data.authSessions}
      monitor={data.monitor}
      onSaved={refresh}
      onActivate={activateSession}
      onDelete={deleteSession}
    />
  )

  const analysisPanel = <AnalysisPanel analyses={data.analyses} onRun={runAnalysis} busy={analysisBusy} />
  const modelConfigPanel = <ModelConfigPanel config={data.modelConfig} onSave={saveModelConfig} />

  function renderPage() {
    if (activePage === 'auth') {
      return <div className="space-y-5">{authPanel}<FeishuAuthorization feishu={data.feishu} products={data.products} onSave={saveFeishuSettings} /><FeishuSettings feishu={data.feishu} logs={data.notificationLogs} products={data.products} onSave={saveFeishuSettings} onTest={testFeishu} /></div>
    }

    if (activePage === 'categories') {
      return classificationPanel
    }

    if (activePage === 'queue') {
      return <MonitorQueue products={data.products} monitor={data.monitor} authSessions={data.authSessions} busyProductId={busyProductId} batchBusy={busy} onCapture={captureProduct} onCaptureBatch={(products) => captureProductsBatch(products, false)} onPauseBatch={pauseProductsBatch} onSchedule={saveProductSchedule} onToggle={toggleProduct} />
    }

    if (activePage === 'analysis') {
      return (
        <div className="grid grid-cols-[420px_1fr] gap-5">
          <div className="space-y-5">
            {analysisPanel}
            {modelConfigPanel}
          </div>
          <SnapshotFeed snapshots={data.snapshots} />
        </div>
      )
    }

    if (activePage === 'records') {
      return (
        <div className="space-y-5">
          <RunLog runs={runs} />
          <DataRecords snapshots={data.snapshots} products={data.products} onClear={clearSnapshots} />
        </div>
      )
    }

    if (activePage === 'guide') {
      return <HelpCenter />
    }

    return (
      <>
        <MetricCards overview={data} />
        <div className="space-y-5">
          <div className="grid grid-cols-2 items-stretch gap-4 max-[1180px]:grid-cols-1">
            {productForm}
            <BatchCaptureCard sessions={data.authSessions} busy={busy} onRun={addProductsBatch} />
          </div>
          <MonitorSettings monitor={data.monitor} feishu={data.feishu} onSave={saveMonitorSettings} />
          {productTable}
        </div>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-[#f6f8fa]">
      <aside className="app-sidebar fixed inset-y-0 left-0 flex w-64 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white">
            <Search className="h-5 w-5" />
          </div>
          <div className="brand-copy">
            <div className="font-semibold text-slate-950">电商竞品监控</div>
            <div className="text-xs text-slate-400">本地工作台</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={() => setActivePage(item.id)}
              aria-label={item.label}
              className={`flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm ${
                activePage === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'
              }`}
              type="button"
            >
              <item.icon className="h-4 w-4" />
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3">
          <button type="button" aria-label={updateInfo?.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : `检查更新，当前版本 v${data.runtime.version}`} onClick={() => { setUpdateOpen(true); if (!updateInfo && !updateChecking) checkUpdates(false).catch(() => undefined) }} className={`flex min-h-11 w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${updateInfo?.updateAvailable ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-700'}`}>
            <span className="relative shrink-0"><CloudDownload className="h-4 w-4" />{updateInfo?.updateAvailable && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-500" />}</span>
            <span className="nav-label min-w-0"><span className="block truncate font-medium">{updateInfo?.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : '检查软件更新'}</span><span className="mt-0.5 block text-xs opacity-70">当前 v{data.runtime.version}</span></span>
          </button>
        </div>
      </aside>

      <main className="app-main ml-64 min-h-screen">
        <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-6 py-2 backdrop-blur">
          <div>
            <h1 className="text-xl font-semibold text-slate-950">{currentPage.title}</h1>
            <p className="text-sm text-slate-500">{currentPage.subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-500" title="调整界面文字大小"><Type className="h-4 w-4" /><select value={fontSize} onChange={(event) => setFontSize(event.target.value as FontSize)} className="bg-transparent text-xs text-slate-700 outline-none" aria-label="界面文字大小"><option value="small">小字</option><option value="standard">标准</option><option value="large">大字</option></select></label>
          {(activePage === 'overview' || activePage === 'queue' || activePage === 'categories') && <>
            <Badge>
              {data.monitor.running
                ? `全局自动监控：运行中${data.monitor.nextRunAt ? ` · 下次 ${new Date(data.monitor.nextRunAt).toLocaleTimeString()}` : ' · 等待计划'}`
                : '全局自动监控：已暂停'}
            </Badge>
            <Button variant="secondary" onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button variant="secondary" className={data.monitor.running ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'} onClick={() => toggleMonitorRunning()} disabled={monitorToggleBusy || busy}>
              {data.monitor.running ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
              {monitorToggleBusy ? '处理中' : data.monitor.running ? '暂停全局自动监控' : '开启全局自动监控'}
            </Button>
          </>}
          </div>
        </header>

        <div className="space-y-5 p-6">
          {(notice || error) && <div className={`fixed bottom-5 left-1/2 z-[70] flex w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-md border bg-white p-3 text-sm shadow-xl ${error ? 'border-red-200 text-red-700' : notice.startsWith('正在') ? 'border-blue-200 text-blue-800' : 'border-emerald-200 text-emerald-800'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error ? <CircleAlert className="h-4 w-4 shrink-0" /> : notice.startsWith('正在') ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : <CircleCheck className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1">{error || notice}</span><button type="button" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => { setNotice(''); setError('') }} title="关闭提示" aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
          {renderPage()}
        </div>
      </main>
      {updateOpen && <UpdateDialog currentVersion={data.runtime.version} info={updateInfo} checking={updateChecking} error={updateError} onCheck={() => checkUpdates(false)} onClose={() => setUpdateOpen(false)} />}
    </div>
  )
}

export default App
