import { useEffect, useRef, useState } from 'react'
import { BarChart3, BookOpen, CircleAlert, CircleCheck, CloudDownload, Database, FolderTree, ListChecks, ListTodo, LoaderCircle, PauseCircle, PlayCircle, RefreshCw, Search, Settings, Sparkles, Type, WandSparkles, X } from 'lucide-react'
import { api } from './lib/api'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { ProductForm } from './features/products/ProductForm'
import { LocalImportDialog } from './features/products/LocalImportDialog'
import { AuthPanel } from './features/auth/AuthPanel'
import { MetricCards } from './features/dashboard/MetricCards'
import { ProductTable } from './features/products/ProductTable'
import { MonitorClassification } from './features/classification/MonitorClassification'
import { AnalysisPanel } from './features/analysis/AnalysisPanel'
import { ModelConfigPanel } from './features/analysis/ModelConfigPanel'
import { SnapshotFeed } from './features/monitoring/SnapshotFeed'
import { DataRecords } from './features/monitoring/DataRecords'
import { FeishuAuthorization, FeishuSettings } from './features/monitoring/FeishuSettings'
import { BatchCaptureCard } from './features/monitoring/BatchCaptureCard'
import { RunLog } from './features/monitoring/RunLog'
import { MonitorQueue } from './features/monitoring/MonitorQueue'
import { CaptureQueue } from './features/monitoring/CaptureQueue'
import { HelpCenter } from './features/help/HelpCenter'
import { UpdateDialog } from './features/updates/UpdateDialog'
import { ImageWorkbench } from './features/image-generation/ImageWorkbench'
import type { AuthSession, LocalImportCommitResult, ModelConfigPatch, ModelConfigTestResult, Overview, Product, RunRecord, UpdateInfo } from './types/domain'

const primaryNavItems = [
  { id: 'guide', label: '使用说明书', icon: BookOpen, title: '使用说明书', subtitle: '第一次使用请从这里开始，按顺序完成账号授权、商品抓取和自动监控。' },
  { id: 'overview', label: '监控总览', icon: BarChart3, title: '竞品价格与 SKU 图监控', subtitle: '第二步：添加并核对商品，设置监控价、抓取计划和启用状态。' },
  { id: 'capture-queue', label: '抓取队列', icon: ListTodo, title: '抓取任务队列', subtitle: '查看当前排队和运行进度，完成项自动移出，页面刷新不会取消任务。' },
  { id: 'categories', label: '监控分类', icon: FolderTree, title: '店铺与型号自动分类', subtitle: '按店铺和型号整理商品，再进行筛选、批量抓取或批量管理。' },
  { id: 'queue', label: '监控队列', icon: ListChecks, title: '监控与本地更新队列', subtitle: '第三步：查看在线商品的执行计划，并为本地数据商品导入新文件。' },
  { id: 'records', label: '数据记录', icon: Database, title: '数据记录与监控设置', subtitle: '查看历史快照、导出 CSV，并调整后台监控间隔。' },
  { id: 'image-workbench', label: 'AI 生图', icon: WandSparkles, title: 'AI 生图', subtitle: '输入提示词并设置生成参数。' },
  { id: 'analysis', label: 'AI分析（功能开发中）', icon: Sparkles, title: 'AI 数据分析', subtitle: '基于历史抓取数据生成价格、SKU 和图片变化洞察。' },
] as const

const authNavItem = { id: 'auth', label: '账号授权', icon: Settings, title: '淘宝与飞书账号授权', subtitle: '第一步：授权采价账号，再按需连接飞书文档和机器人通知。' } as const
const navItems = [...primaryNavItems, authNavItem] as const

type PageId = (typeof navItems)[number]['id']
type FontSize = 'small' | 'standard' | 'large'
type AccountType = 'normal' | 'gift' | 'vip88'
const UPDATE_NOTIFIED_VERSION_KEY = 'ecommerce-monitor-update-notified-version'

function requireOnlineCapture(product: Product) {
  if (product.captureMode === 'local-only') throw new Error('该商品使用本地数据模式，不会访问淘宝页面。请点击“导入新文件”更新价格。')
}

function App() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [activePage, setActivePage] = useState<PageId>(() => {
    const saved = window.localStorage.getItem('tmall-monitor-active-page')
    return navItems.some((item) => item.id === saved) ? saved as PageId : 'guide'
  })
  const [busy, setBusy] = useState(false)
  const [busyProductId, setBusyProductId] = useState('')
  const [monitorToggleBusy, setMonitorToggleBusy] = useState(false)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [authGuideAccountType, setAuthGuideAccountType] = useState<AccountType | null>(null)
  const [fontSize, setFontSize] = useState<FontSize>(() => (window.localStorage.getItem('ecommerce-monitor-font-size') as FontSize) || 'standard')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [localImportOpen, setLocalImportOpen] = useState(false)
  const [localImportTarget, setLocalImportTarget] = useState<Product | null>(null)
  const updateCheckActive = useRef(false)

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
    const check = () => checkUpdates(false, true).catch(() => undefined)
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    document.addEventListener('visibilitychange', checkWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', checkWhenVisible)
    }
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

  async function checkUpdates(openDialog = true, automatic = false) {
    if (openDialog) setUpdateOpen(true)
    if (updateCheckActive.current) return
    updateCheckActive.current = true
    setUpdateChecking(true)
    setUpdateError('')
    try {
      const info = await api.checkUpdate()
      setUpdateInfo(info)
      if (automatic && info.updateAvailable && window.localStorage.getItem(UPDATE_NOTIFIED_VERSION_KEY) !== info.latestVersion) {
        window.localStorage.setItem(UPDATE_NOTIFIED_VERSION_KEY, info.latestVersion)
        setUpdateOpen(true)
      }
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : '检查更新失败。')
    } finally {
      updateCheckActive.current = false
      setUpdateChecking(false)
    }
  }

  function hasCaptureAccount() {
    return overview?.authSessions.some((session) => session.source === 'taobao-browser' && (session.enabled ?? session.active) && session.loginStatus !== 'expired') === true
  }

  function showAuthGuide(accountType: AccountType) {
    setNotice('')
    setError('')
    setAuthGuideAccountType(accountType)
  }

  async function handleAdd(payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) {
    if (!hasCaptureAccount()) {
      showAuthGuide(payload.accountType)
      throw new Error('尚未授权可用的淘宝扫码账号。')
    }
    setError('')
    setNotice(`正在后台自动采集价格、800 主图和 SKU 图${payload.captureMediaAssets ? '、完整素材' : ''}${payload.captureBuyerShows ? '、买家秀' : ''}；采集后将脱敏保存并从本地证据解析...`)
    try {
      const product = await api.addProduct(payload)
      setBusyProductId(product.id)
      const result = await api.captureProduct(product.id)
      setNotice(result.run.message)
      await refresh()
      return result.product
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '添加商品失败')
      throw err
    } finally {
      setBusyProductId('')
    }
  }

  async function addProductsBatch(payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) {
    if (!hasCaptureAccount()) {
      showAuthGuide(payload.accountType)
      throw new Error('尚未授权可用的淘宝扫码账号。')
    }
    setBusy(true)
    setError('')
    setNotice(`正在按队列自动采集 ${payload.urls.length} 个新商品${payload.captureMediaAssets ? '（包含完整素材）' : ''}${payload.captureBuyerShows ? '（包含买家秀）' : ''}；每个商品采集后都会脱敏保存并从本地证据解析...`)
    try {
      const result = await api.addProductsBatch(payload)
      setNotice(result.message)
      await refresh()
      return result
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '批量抓取失败')
      throw err
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
    requireOnlineCapture(product)
    await api.updateProduct(product.id, { enabled: !product.enabled })
    await refresh()
  }

  async function saveProductSchedule(product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) {
    requireOnlineCapture(product)
    await api.updateProduct(product.id, { monitorScheduleMode: mode, monitorIntervalMinutes: intervalMinutes, monitorStartAt })
    await refresh()
  }

  async function saveProductMediaPreference(product: Product, captureMediaAssets: boolean) {
    await api.updateProduct(product.id, { captureMediaAssets })
    await refresh()
  }

  async function saveSkuMonitorPrice(product: Product, skuId: string, value: number | null) {
    await api.updateSkuMonitorPrice(product.id, skuId, value)
    await refresh()
  }

  async function captureProduct(product: Product) {
    requireOnlineCapture(product)
    const accountType = product.accountType || 'normal'
    if (!hasCaptureAccount()) {
      showAuthGuide(accountType)
      throw new Error('请先授权并启用可用的淘宝扫码账号。')
    }
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
    requireOnlineCapture(product)
    const accountType = product.accountType || 'normal'
    if (!hasCaptureAccount()) {
      showAuthGuide(accountType)
      throw new Error('请先授权并启用可用的淘宝扫码账号。')
    }
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
    const onlineProducts = products.filter((product) => product.captureMode !== 'local-only')
    const skippedLocalCount = products.length - onlineProducts.length
    if (!onlineProducts.length) throw new Error('所选商品均为本地数据模式，请分别导入新文件更新价格。')
    if (!hasCaptureAccount()) {
      showAuthGuide(onlineProducts[0].accountType || 'normal')
      throw new Error('请先授权并启用可用的淘宝扫码账号。')
    }
    setBusy(true)
    if (showFeedback) {
      setError('')
      setNotice(`正在抓取 ${onlineProducts.length} 个在线商品；同一账号按顺序执行，不同账号并行${skippedLocalCount ? `；已排除 ${skippedLocalCount} 个本地数据商品` : ''}...`)
    }
    try {
      const result = await api.captureProductsBatch(onlineProducts.map((product) => product.id))
      if (showFeedback) setNotice(result.run.message)
      await refresh()
      return result.run
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

  async function retryFailedRun(run: RunRecord) {
    const failedIds = new Set((run.items || []).filter((item) => item.status === 'failed').map((item) => item.productId))
    const failedProducts = data.products.filter((product) => failedIds.has(product.id) && product.captureMode !== 'local-only')
    if (!failedProducts.length) {
      setError(data.products.some((product) => failedIds.has(product.id) && product.captureMode === 'local-only') ? '失败项是本地数据商品，请导入新文件更新，不能重新在线抓取。' : '失败商品已被删除，无法重新抓取。')
      return
    }
    try {
      await captureProductsBatch(failedProducts)
    } catch {
      // captureProductsBatch already exposes the failure in the global status area.
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

  async function saveModelConfig(payload: ModelConfigPatch) {
    setError('')
    setNotice('')
    await api.updateModelConfig(payload)
    setNotice('模型配置已保存，生图与分析会分别使用对应模型。')
    await refresh()
  }

  function localImportCompleted(result: LocalImportCommitResult) {
    setError('')
    setNotice(result.alreadyCommitted
      ? '这份本地数据已经导入过，未重复写入价格记录；商品仍保持本地模式和暂停状态。'
      : `本地数据已导入「${result.product.name}」，${result.snapshot.skuPrices.length} 个 SKU 价格已通过证据核验。商品默认暂停，更新价格请再次导入新的本地文件。`)
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : '刷新导入结果失败'))
  }

  function openLocalImport(product?: Product) {
    setLocalImportTarget(product || null)
    setLocalImportOpen(true)
  }

  async function testModelConfig(payload: Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'imageModel' | 'apiKey'>): Promise<ModelConfigTestResult> {
    const result = await api.testModelConfig(payload)
    await refresh()
    return result
  }

  async function saveFeishuSettings(payload: { enabled?: boolean; webhookUrl?: string; signingSecret?: string; clearSigningSecret?: boolean; documentEnabled?: boolean }) {
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
      onSchedule={saveProductSchedule}
      onMediaPreference={saveProductMediaPreference}
      onSaveSkuMonitorPrice={saveSkuMonitorPrice}
      onCapture={captureProduct}
      onRetryBuyerShows={retryBuyerShows}
      onLocalImport={openLocalImport}
      onDelete={deleteProduct}
      busyProductId={busyProductId}
      monitor={data.monitor}
    />
  )

  const productForm = <ProductForm sessions={data.authSessions} onAdd={handleAdd} onRequireAuth={showAuthGuide} />

  const classificationPanel = <MonitorClassification products={data.products} monitor={data.monitor} onToggle={toggleProduct} onSchedule={saveProductSchedule} onMediaPreference={saveProductMediaPreference} onSaveSkuMonitorPrice={saveSkuMonitorPrice} onCapture={captureProduct} onRetryBuyerShows={retryBuyerShows} onLocalImport={openLocalImport} onCaptureBatch={captureProductsBatch} onDelete={deleteProduct} onDeleteBatch={deleteProductsBatch} batchBusy={busy} busyProductId={busyProductId} />

  const authPanel = (
    <AuthPanel
      sessions={data.authSessions}
      onSaved={refresh}
      onActivate={activateSession}
      onDelete={deleteSession}
    />
  )

  const analysisPanel = <AnalysisPanel analyses={data.analyses} onRun={runAnalysis} busy={analysisBusy} />
  const modelConfigPanel = <ModelConfigPanel config={data.modelConfig} onSave={saveModelConfig} onTest={testModelConfig} />
  const imageWorkbench = <ImageWorkbench config={data.modelConfig} onSaveConfig={saveModelConfig} onTestConfig={testModelConfig} />

  function renderPage() {
    if (activePage === 'auth') {
      return <div className="space-y-5">{authPanel}<FeishuAuthorization feishu={data.feishu} products={data.products} onSave={saveFeishuSettings} /><FeishuSettings feishu={data.feishu} logs={data.notificationLogs} products={data.products} onSave={saveFeishuSettings} onTest={testFeishu} /></div>
    }

    if (activePage === 'categories') {
      return classificationPanel
    }

    if (activePage === 'queue') {
      return <MonitorQueue products={data.products} monitor={data.monitor} busyProductId={busyProductId} batchBusy={busy} onCapture={captureProduct} onCaptureBatch={(products) => captureProductsBatch(products, false)} onPauseBatch={pauseProductsBatch} onSchedule={saveProductSchedule} onToggle={toggleProduct} onLocalImport={openLocalImport} />
    }

    if (activePage === 'capture-queue') {
      return <CaptureQueue initialStatus={data.captureQueue} />
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
          <RunLog runs={runs} busy={busy} onRetryFailed={retryFailedRun} />
          <DataRecords snapshots={data.snapshots} products={data.products} onClear={clearSnapshots} onEvidenceChanged={refresh} />
        </div>
      )
    }

    if (activePage === 'guide') {
      return <HelpCenter onNavigate={setActivePage} />
    }

    return (
      <>
        <MetricCards overview={data} />
        <div className="space-y-5">
          <div className="grid grid-cols-2 items-stretch gap-4 max-[1180px]:grid-cols-1">
            {productForm}
            <BatchCaptureCard sessions={data.authSessions} busy={busy} onRun={addProductsBatch} onRequireAuth={showAuthGuide} />
          </div>
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
          {primaryNavItems.map((item) => (
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
        <div className="space-y-2 border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={() => setActivePage(authNavItem.id)}
            aria-label={authNavItem.label}
            className={`flex h-10 w-full items-center gap-3 rounded-md border px-3 text-sm font-medium shadow-sm ${
              activePage === authNavItem.id ? 'border-blue-600 bg-blue-600 text-white' : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
            }`}
          >
            <authNavItem.icon className="h-4 w-4" />
            <span className="nav-label">{authNavItem.label}</span>
          </button>
          <button type="button" aria-label={updateInfo?.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : `检查更新，当前版本 v${data.runtime.version}`} onClick={() => { setUpdateOpen(true); if (!updateInfo && !updateChecking) checkUpdates(false).catch(() => undefined) }} className={`flex min-h-11 w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${updateInfo?.updateAvailable ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-700'}`}>
            <span className="relative shrink-0"><CloudDownload className="h-4 w-4" />{updateInfo?.updateAvailable && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-500" />}</span>
            <span className="nav-label min-w-0"><span className="block truncate font-medium">{updateInfo?.updateAvailable ? `发现新版本 v${updateInfo.latestVersion}` : '检查软件更新'}</span><span className="mt-0.5 block text-xs opacity-70">当前 v{data.runtime.version}</span></span>
          </button>
        </div>
      </aside>

      <main className="app-main ml-64 min-h-screen">
        <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur sm:px-6">
          <div>
            <h1 className="text-xl font-semibold text-slate-950">{currentPage.title}</h1>
            <p className="text-sm text-slate-500">{currentPage.subtitle}</p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
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

        <div className="space-y-5 p-3 sm:p-6">
          {(notice || error) && <div className={`fixed bottom-5 left-1/2 z-[70] flex w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-md border bg-white p-3 text-sm shadow-xl ${error ? 'border-red-200 text-red-700' : notice.startsWith('正在') ? 'border-blue-200 text-blue-800' : 'border-emerald-200 text-emerald-800'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error ? <CircleAlert className="h-4 w-4 shrink-0" /> : notice.startsWith('正在') ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : <CircleCheck className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1">{error || notice}</span><button type="button" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => { setNotice(''); setError('') }} title="关闭提示" aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
          <div className={activePage === 'image-workbench' ? '' : 'hidden'}>{imageWorkbench}</div>
          {activePage !== 'image-workbench' && renderPage()}
        </div>
      </main>
      {authGuideAccountType && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/35 p-4" role="dialog" aria-modal="true" aria-labelledby="auth-guide-title">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700"><Settings className="h-5 w-5" /></div>
                <div><h2 id="auth-guide-title" className="text-lg font-semibold text-slate-950">先完成账号授权</h2><p className="mt-1 text-sm leading-6 text-slate-600">当前没有可用的淘宝扫码账号。授权并检测在线后，再开始抓取商品。</p></div>
              </div>
              <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setAuthGuideAccountType(null)} aria-label="关闭账号授权引导" title="关闭"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAuthGuideAccountType(null)}>稍后设置</Button>
              <Button type="button" onClick={() => { setAuthGuideAccountType(null); setActivePage('auth') }}><Settings className="h-4 w-4" />去账号授权</Button>
            </div>
          </div>
        </div>
      )}
      <LocalImportDialog key={localImportTarget?.id || 'new-local-import'} open={localImportOpen} dataDir={data.runtime.dataDir} initialItemId={localImportTarget?.itemId || localImportTarget?.lastSnapshot?.itemId || ''} initialAccountType={localImportTarget?.accountType || 'normal'} onClose={() => { setLocalImportOpen(false); setLocalImportTarget(null) }} onImported={localImportCompleted} />
      {updateOpen && <UpdateDialog currentVersion={data.runtime.version} info={updateInfo} checking={updateChecking} error={updateError} onCheck={() => checkUpdates(false)} onClose={() => setUpdateOpen(false)} />}
    </div>
  )
}

export default App
