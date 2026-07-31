import { useCallback, useEffect, useRef, useState } from 'react'
import { BarChart3, BookOpen, CircleAlert, CircleCheck, Database, Image as ImageIcon, LoaderCircle, MessageSquare, PackageSearch, Search, Settings, Type, WandSparkles, X } from 'lucide-react'
import { api } from './lib/api'
import { Button } from './components/ui/button'
import { LocalImportDialog } from './features/products/LocalImportDialog'
import { AuthPanel } from './features/auth/AuthPanel'
import { ModelConfigPanel } from './features/analysis/ModelConfigPanel'
import { DataRecords } from './features/monitoring/DataRecords'
import { FeishuAuthorization, FeishuSettings } from './features/monitoring/FeishuSettings'
import { RunLog } from './features/monitoring/RunLog'
import { ProductMonitoringWorkspace } from './features/monitoring/ProductMonitoringWorkspace'
import { HelpCenter } from './features/help/HelpCenter'
import { UpdateDialog } from './features/updates/UpdateDialog'
import { ImageWorkbench, type ImageWorkbenchDraftTransfer } from './features/image-generation/ImageWorkbench'
import { PromptWorkbench } from './features/prompt-studio/PromptWorkbench'
import { SettingsCenter, type SettingsSection } from './features/settings/SettingsCenter'
import { AppearanceSettings } from './features/settings/AppearanceSettings'
import { OperationsAssistant } from './features/operations/OperationsAssistant'
import { OperationsAgentChat } from './features/operations/OperationsAgentChat'
import { loadCustomWallpaper } from './features/settings/customWallpaperStore'
import { APP_WALLPAPER_STORAGE_KEY, CUSTOM_APP_WALLPAPER_ID, DEFAULT_APP_WALLPAPER_ID, resolveAppWallpaper, type AppWallpaperId } from './features/settings/wallpapers'
import type { PromptHistoryItem, PromptProductProfile, PromptStylePreset, PromptSyncPayload } from './features/prompt-studio/types'
import type { AuthSession, LocalImportCommitResult, ModelConfigPatch, ModelConfigTestPayload, ModelConfigTestResult, MonitorChannel, OperationsAnalysis, OperationsPeriodKind, OperationsReportInputType, OperationsSourcePeriodKind, OperationsWorkspace, Overview, Product, ProductCaptureOptions, RunRecord, UpdateInfo } from './types/domain'

const guidePage = { id: 'guide', label: '使用说明书', icon: BookOpen, title: '使用说明书', subtitle: '第一次使用请从这里开始，按顺序完成账号授权、商品抓取和自动监控。' } as const
const primaryNavItems = [
  { id: 'operations-agent', label: 'Agent 对话', icon: MessageSquare, title: 'Agent 对话', subtitle: '基于已导入的运营数据，获取可核对的经营分析与建议。' },
  { id: 'operations', label: '运营数据', icon: BarChart3, title: '运营数据', subtitle: '导入经营数据，查看店铺、类目与单品经营，并生成推广建议。' },
  { id: 'monitoring', label: '商品监控', icon: PackageSearch, title: '商品监控', subtitle: '添加、筛选和核对商品，并在任务中心管理监控计划与抓取进度。' },
  { id: 'image-workbench', label: 'AI 创作', icon: WandSparkles, title: 'AI 创作', subtitle: '输入需求，可先让 AI 帮写并修改确认，再提交到生图队列。' },
  { id: 'records', label: '数据记录', icon: Database, title: '数据记录', subtitle: '查看运行日志、价格历史、本地证据并重试失败商品。' },
] as const
const pageItems = [guidePage, ...primaryNavItems] as const

type PageId = (typeof pageItems)[number]['id']
type FontSize = 'small' | 'standard' | 'large'
type AccountType = 'normal' | 'gift' | 'vip88'
type AiCreationView = 'compose' | 'professional'

function isOperationsPage(page: PageId) {
  return page === 'operations' || page === 'operations-agent'
}
const UPDATE_NOTIFIED_VERSION_KEY = 'ecommerce-monitor-update-notified-version'
const ACTIVE_PAGE_KEY = 'tmall-monitor-active-page'
const AI_CREATION_VIEW_KEY = 'ecommerce-monitor-ai-creation-view'

type PromptProductProfileInput = Omit<PromptProductProfile, 'id' | 'updatedAt'> & { id?: string }
type PromptStylePresetInput = Omit<PromptStylePreset, 'id' | 'updatedAt'> & { id?: string }

async function savePromptProductProfile(profile: PromptProductProfileInput) {
  const { id, ...payload } = profile
  return id ? api.updatePromptProductProfile(id, payload) : api.createPromptProductProfile(payload)
}

async function savePromptStylePreset(preset: PromptStylePresetInput) {
  const { id, ...payload } = preset
  return id ? api.updatePromptStylePreset(id, payload) : api.createPromptStylePreset(payload)
}

function togglePromptHistoryFavorite(id: string, favorite: boolean): Promise<PromptHistoryItem> {
  return api.updatePromptHistory(id, { isFavorite: favorite })
}

function renamePromptHistory(id: string, name: string): Promise<PromptHistoryItem> {
  return api.updatePromptHistory(id, { name })
}

function requireOnlineCapture(product: Product) {
  if (product.captureMode === 'local-only') throw new Error('该商品使用本地数据模式，不会访问淘宝页面。请点击“导入新文件”更新价格。')
}

function App() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [operations, setOperations] = useState<OperationsWorkspace | null>(null)
  const [activePage, setActivePage] = useState<PageId>(() => {
    const saved = window.localStorage.getItem(ACTIVE_PAGE_KEY)
    if (saved === 'prompt-studio') return 'image-workbench'
    if (['overview', 'categories', 'queue', 'capture-queue', 'auth'].includes(saved || '')) return 'monitoring'
    if (saved === 'analysis') return 'guide'
    return pageItems.some((item) => item.id === saved) ? saved as PageId : 'guide'
  })
  const [aiCreationView, setAiCreationView] = useState<AiCreationView>(() => {
    if (window.localStorage.getItem(ACTIVE_PAGE_KEY) === 'prompt-studio') return 'professional'
    return window.localStorage.getItem(AI_CREATION_VIEW_KEY) === 'professional' ? 'professional' : 'compose'
  })
  const [busy, setBusy] = useState(false)
  const [batchBusyProductIds, setBatchBusyProductIds] = useState<string[]>([])
  const [clearingRunLogs, setClearingRunLogs] = useState(false)
  const [busyProductId, setBusyProductId] = useState('')
  const [monitorToggleBusy, setMonitorToggleBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(() => window.localStorage.getItem(ACTIVE_PAGE_KEY) === 'auth')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('accounts')
  const [authGuideAccountType, setAuthGuideAccountType] = useState<AccountType | null>(null)
  const [fontSize, setFontSize] = useState<FontSize>(() => (window.localStorage.getItem('ecommerce-monitor-font-size') as FontSize) || 'standard')
  const [wallpaperId, setWallpaperId] = useState<AppWallpaperId>(() => resolveAppWallpaper(window.localStorage.getItem(APP_WALLPAPER_STORAGE_KEY)).id)
  const [customWallpaperUrl, setCustomWallpaperUrl] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [localImportOpen, setLocalImportOpen] = useState(false)
  const [localImportTarget, setLocalImportTarget] = useState<Product | null>(null)
  const [incomingImageDraft, setIncomingImageDraft] = useState<ImageWorkbenchDraftTransfer | null>(null)
  const [professionalPromptMounted, setProfessionalPromptMounted] = useState(aiCreationView === 'professional')
  const [operationsMounted, setOperationsMounted] = useState(isOperationsPage(activePage))
  const updateCheckActive = useRef(false)
  const qwenPawWarmupKey = useRef('')
  const activePageRef = useRef<PageId>(activePage)
  const customWallpaperUrlRef = useRef('')

  const setCustomWallpaperBlob = useCallback((blob: Blob | null) => {
    if (customWallpaperUrlRef.current) URL.revokeObjectURL(customWallpaperUrlRef.current)
    const nextUrl = blob ? URL.createObjectURL(blob) : ''
    customWallpaperUrlRef.current = nextUrl
    setCustomWallpaperUrl(nextUrl)
  }, [])

  // Product and authorization actions only need the compact monitoring
  // overview. Rebuilding the whole operations workspace here made every
  // delete, toggle and main-SKU save wait on unrelated report calculations.
  const refresh = useCallback(async () => {
    setOverview(await api.overview())
  }, [])

  const refreshOperations = useCallback(async () => {
    setOperations(await api.operations())
  }, [])

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible' && activePageRef.current !== 'image-workbench') {
        void refresh()
        if (isOperationsPage(activePageRef.current)) void refreshOperations()
      }
    }
    Promise.all([refresh(), refreshOperations()]).catch((err) => setError(err.message))
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh, refreshOperations])

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
    activePageRef.current = activePage
    window.localStorage.setItem(ACTIVE_PAGE_KEY, activePage)
  }, [activePage])

  useEffect(() => {
    window.localStorage.setItem(AI_CREATION_VIEW_KEY, aiCreationView)
    if (aiCreationView === 'professional') setProfessionalPromptMounted(true)
  }, [aiCreationView])

  useEffect(() => {
    if (isOperationsPage(activePage)) setOperationsMounted(true)
  }, [activePage])

  useEffect(() => {
    const modelConfig = overview?.modelConfig
    const activeModel = modelConfig?.channelStates?.[modelConfig.channel]
    const configured = activeModel?.hasApiKey ?? modelConfig?.hasApiKey ?? false
    if (!operations?.qwenPaw?.installed || !configured) return undefined
    const key = `${modelConfig?.channel}|${modelConfig?.customBaseUrl}|${activeModel?.model || modelConfig?.model}`
    if (qwenPawWarmupKey.current === key) return undefined
    qwenPawWarmupKey.current = key
    // Warm the local console after the app becomes interactive. The request is
    // intentionally not awaited, so it removes the first Agent-page cold start
    // without delaying the rest of the local workspace.
    const timer = window.setTimeout(() => {
      void api.qwenPawConsole().catch(() => {
        if (qwenPawWarmupKey.current === key) qwenPawWarmupKey.current = ''
      })
    }, 1_200)
    return () => window.clearTimeout(timer)
  }, [operations?.qwenPaw?.installed, overview?.modelConfig])

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize
    window.localStorage.setItem('ecommerce-monitor-font-size', fontSize)
  }, [fontSize])

  useEffect(() => {
    window.localStorage.setItem(APP_WALLPAPER_STORAGE_KEY, wallpaperId)
  }, [wallpaperId])

  useEffect(() => {
    let active = true
    loadCustomWallpaper()
      .then((wallpaper) => {
        if (!active) return
        if (wallpaper) setCustomWallpaperBlob(wallpaper.blob)
        else if (window.localStorage.getItem(APP_WALLPAPER_STORAGE_KEY) === CUSTOM_APP_WALLPAPER_ID) setWallpaperId(DEFAULT_APP_WALLPAPER_ID)
      })
      .catch(() => {
        if (active && window.localStorage.getItem(APP_WALLPAPER_STORAGE_KEY) === CUSTOM_APP_WALLPAPER_ID) setWallpaperId(DEFAULT_APP_WALLPAPER_ID)
      })
    return () => {
      active = false
      if (customWallpaperUrlRef.current) URL.revokeObjectURL(customWallpaperUrlRef.current)
      customWallpaperUrlRef.current = ''
    }
  }, [setCustomWallpaperBlob])

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

  function hasCaptureAccount(accountType?: AccountType) {
    return overview?.authSessions.some((session) => session.source === 'taobao-browser' && (session.enabled ?? session.active) && session.loginStatus !== 'expired' && (!accountType || (session.accountType || 'normal') === accountType)) === true
  }

  function showAuthGuide(accountType: AccountType) {
    setNotice('')
    setError('')
    setAuthGuideAccountType(accountType)
  }

  async function handleAdd(payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) {
    if (!hasCaptureAccount(payload.accountType)) {
      showAuthGuide(payload.accountType)
      throw new Error('尚未授权可用的淘宝扫码账号。')
    }
    setError('')
    setNotice('正在后台采集价格、800 主图和 SKU 图；采集后将脱敏保存并从本地证据解析...')
    try {
      const product = await api.addProduct(payload)
      setBusyProductId(product.id)
      const result = await api.captureProduct(product.id, 'price', true)
      const enabledFeatures = [payload.captureMediaAssets ? '完整素材' : '', payload.captureBuyerShows ? '买家秀' : ''].filter(Boolean).join('、')
      setNotice(`${result.run.message}${enabledFeatures ? ` 已启用${enabledFeatures}，请在商品卡片中按需单独抓取；为避免挤号，不再紧接抓价连续打开淘宝页面。` : ''}`)
      await refresh()
      return result.product
    } catch (err) {
      setNotice('')
      setError(err instanceof Error ? err.message : '添加商品失败')
      await refresh().catch(() => undefined)
      throw err
    } finally {
      setBusyProductId('')
    }
  }

  async function addProductsBatch(payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) {
    if (!hasCaptureAccount(payload.accountType)) {
      showAuthGuide(payload.accountType)
      throw new Error('尚未授权可用的淘宝扫码账号。')
    }
    setBusy(true)
    setError('')
    setNotice(`正在按队列采集 ${payload.urls.length} 个新商品的价格、800 主图和 SKU 图；每个商品采集后都会脱敏保存并从本地证据解析...`)
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

  async function saveSkuMonitorPrice(product: Product, skuId: string, value: number | null, channel: MonitorChannel = 'lowest') {
    await api.updateSkuMonitorPrice(product.id, skuId, value, channel)
    await refresh()
  }

  async function savePrimarySkuIds(product: Product, primarySkuIds: string[]) {
    await api.updateProduct(product.id, { primarySkuIds })
    await refresh()
  }

  async function captureProduct(product: Product, options: ProductCaptureOptions = {}) {
    requireOnlineCapture(product)
    const accountType = product.accountType || 'normal'
    if (!hasCaptureAccount(accountType)) {
      showAuthGuide(accountType)
      throw new Error('请先授权并启用可用的淘宝扫码账号。')
    }
    setBusyProductId(product.id)
    try {
      const result = options.accountMode === 'all'
        ? await api.captureAllAccountViews(product.id)
        : await api.captureProduct(product.id, options.captureKind || 'price')
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

  async function captureSearchMainImage(product: Product) {
    requireOnlineCapture(product)
    if (!hasCaptureAccount()) {
      showAuthGuide(product.accountType || 'normal')
      throw new Error('请先授权并启用可用的淘宝扫码账号。')
    }
    setBusyProductId(product.id)
    try {
      const result = await api.captureSearchMainImage(product.id, true)
      await refresh()
      return result
    } finally {
      setBusyProductId('')
    }
  }

  async function reparseProductLocalEvidence(product: Product, kind: 'price' | 'materials' | 'buyer-show' | 'search-main-image') {
    setBusyProductId(product.id)
    try {
      const result = await api.reparseProductLocalEvidence(product.id, kind)
      await refresh()
      return result
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
    const missingAccountProduct = onlineProducts.find((product) => !hasCaptureAccount(product.accountType || 'normal'))
    if (missingAccountProduct) {
      showAuthGuide(missingAccountProduct.accountType || 'normal')
      throw new Error(`缺少可用的${missingAccountProduct.accountType === 'gift' ? '礼金' : missingAccountProduct.accountType === 'vip88' ? '88VIP' : '普通'}账号；日常抓价不会换用其他账号类型。`)
    }
    setBusy(true)
    setBatchBusyProductIds(onlineProducts.map((product) => product.id))
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
      setBatchBusyProductIds([])
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

  async function clearRunLogs() {
    if (!window.confirm('确定清空全部运行日志？这不会删除商品、价格历史、本地证据或监控设置。')) return
    setClearingRunLogs(true)
    setError('')
    setNotice('')
    try {
      const result = await api.clearRunLogs()
      setNotice(result.removed ? `已清空 ${result.removed} 条运行日志。` : '运行日志已经是空的。')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空运行日志失败')
    } finally {
      setClearingRunLogs(false)
    }
  }

  async function saveModelConfig(payload: ModelConfigPatch) {
    setError('')
    setNotice('')
    await api.updateModelConfig(payload)
    await refresh()
    if (operations?.qwenPaw.installed) {
      try {
        const runtime = await api.prepareQwenPawOperations()
        setOperations((current) => current ? { ...current, qwenPaw: runtime } : current)
        setNotice('模型配置已保存，运营 Agent 已自动更新并会重新连接。')
        return
      } catch (reason) {
        setNotice(`模型配置已保存；运营 Agent 会在下次打开时更新。${reason instanceof Error ? ` ${reason.message}` : ''}`)
        return
      }
    }
    setNotice('模型配置已保存，AI 创作、运营助手分析和 Agent 对话会统一使用当前配置。')
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

  function syncPromptToImageWorkbench(payload: PromptSyncPayload) {
    setIncomingImageDraft({
      id: globalThis.crypto?.randomUUID?.() || `prompt-${Date.now()}`,
      prompt: payload.prompt,
      negativePrompt: payload.negativePrompt,
      ratio: payload.ratio,
      resolution: payload.resolution,
      quality: payload.quality,
      format: payload.format,
      background: payload.background,
      referenceImages: payload.referenceFiles,
    })
    setError('')
    setNotice('提示词、参数和参考图已同步到 AI 创作，请确认后再加入生图队列。')
    setAiCreationView('compose')
    setActivePage('image-workbench')
  }

  async function testModelConfig(payload: ModelConfigTestPayload): Promise<ModelConfigTestResult> {
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

  async function uploadOperationsReport(file: File, payload: { type: OperationsReportInputType, storeName?: string, reportDate?: string, periodKind?: OperationsPeriodKind, periodStart?: string, periodEnd?: string, sourceName?: string }) {
    setError('')
    setNotice('正在导入运营数据...')
    const result = await api.uploadOperationsReport(file, payload)
    setOperations(result.workspace)
    setNotice('运营数据已导入并完成本地指标计算。')
    return result.workspace
  }

  async function uploadProductCatalog(file: File) {
    setError('')
    setNotice('正在更新商品 ID 和型号资料...')
    const result = await api.uploadProductCatalog(file)
    setOperations(result.workspace)
    setNotice(`已追加 ${result.importedCount} 条商品资料，最新版本已参与运营数据关联。`)
    return result.workspace
  }

  async function saveProductCatalogEntry(payload: { storeName: string, productId: string, category?: string, model?: string }) {
    setError('')
    const result = await api.saveProductCatalogEntry(payload)
    setOperations(result.workspace)
    setNotice('商品资料已保存，当前版本已立即参与本地汇总。')
    return result.workspace
  }

  async function exportProductCatalog() {
    const { blob, fileName } = await api.exportProductCatalog()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  async function previewOperationsReport(file: File) {
    return api.previewOperationsReport(file)
  }

  async function loadOperationsWorkspace(filters: { periodKind?: 'all' | OperationsPeriodKind, sourcePeriodKind?: OperationsSourcePeriodKind, start?: string, end?: string, storeName?: string }) {
    const next = await api.operations(filters)
    setOperations(next)
    return next
  }

  async function loadOperationsArchive() {
    const allReports = await api.operations({ periodKind: 'all' })
    return { reports: allReports.reports, archive: allReports.archive }
  }

  async function deleteOperationsReport(id: string) {
    setError('')
    await api.deleteOperationsReport(id)
    setOperations(await api.operations())
    setNotice('运营数据已删除。')
  }

  async function renameOperationsReport(id: string, fileName: string) {
    setError('')
    const result = await api.renameOperationsReport(id, fileName)
    setOperations(result.workspace)
    setNotice('归档名称已修改。')
    return result.workspace
  }

  async function createOperationsStore(name: string) {
    setError('')
    const next = await api.createOperationsStore(name)
    setOperations(next)
    setNotice(`店铺“${name}”已添加。`)
    return next
  }

  async function removeOperationsStore(name: string) {
    setError('')
    const next = await api.deleteOperationsStore(name)
    setOperations(next)
    setNotice(`店铺“${name}”已删除；关联报表和商品资料已改为未归属店铺。`)
    return next
  }

  async function assignOperationsReportsStore(ids: string[], storeName: string) {
    setError('')
    const result = await api.assignOperationsReportsStore(ids, storeName)
    setOperations(result.workspace)
    setNotice(`已将 ${result.updatedCount} 份报表归属到“${storeName}”。`)
    return result.workspace
  }

  async function updateOperationsProfile(payload: { principles?: string, dailyReport?: { enabled?: boolean, time?: string } }) {
    setError('')
    const next = await api.updateOperationsProfile(payload)
    setOperations(next)
    if (payload.principles !== undefined && next.qwenPaw.installed) {
      try {
        const runtime = await api.prepareQwenPawOperations()
        setOperations((current) => current ? { ...current, qwenPaw: runtime } : current)
        setNotice('运营思路已保存，Agent 会重新连接并按最新思路执行。')
        return
      } catch (reason) {
        setNotice(`运营思路已保存；Agent 会在下次打开时同步。${reason instanceof Error ? ` ${reason.message}` : ''}`)
        return
      }
    }
    setNotice('运营助手设置已保存。')
  }

  async function saveOperationsSalesDeduction(payload: { storeName: string, reportDate: string, amount: number, note?: string }) {
    setError('')
    const filters = operations?.filters || { periodKind: 'all' as const }
    await api.addOperationsSalesDeduction(payload)
    const next = await api.operations(filters)
    setOperations(next)
    setNotice('销售扣除已保存，整店净 GSV、经营 ROI 与推广费率已重算。')
    return next
  }

  async function removeOperationsSalesDeduction(id: string) {
    setError('')
    const filters = operations?.filters || { periodKind: 'all' as const }
    await api.deleteOperationsSalesDeduction(id)
    const next = await api.operations(filters)
    setOperations(next)
    setNotice('销售扣除已删除，经营指标已恢复计算。')
    return next
  }

  async function analyzeOperations(): Promise<OperationsAnalysis> {
    setError('')
    setNotice('正在生成运营分析...')
    const result = await api.analyzeOperations()
    setOperations(result.workspace)
    setNotice(result.analysis.mode === 'ai' ? '运营分析已完成。' : '模型未配置，已生成本地公式分析。')
    return result.analysis
  }

  async function clearOperationsAnalyses() {
    setError('')
    const filters = operations?.filters || { periodKind: 'all' as const }
    const result = await api.clearOperationsAnalyses()
    const next = await api.operations(filters)
    setOperations(next)
    setNotice(result.cleared ? `已清空 ${result.cleared} 条运营分析。` : '当前没有可清空的运营分析。')
  }

  async function runOperationsDailyReport(): Promise<{ analysis: OperationsAnalysis, sent: boolean, sendError: string }> {
    setError('')
    setNotice('正在生成经营日报...')
    const result = await api.runOperationsDailyReport()
    setOperations(result.workspace)
    setNotice(result.sent ? '经营日报已发送至飞书。' : result.sendError || '经营日报已生成。')
    return result
  }

  async function activateOperationsCloudSync(payload: { endpoint?: string, code: string, deviceName?: string }) {
    setError('')
    setNotice('正在绑定云端团队授权...')
    const result = await api.activateOperationsCloudSync(payload)
    setOperations(result.workspace)
    setNotice(`已绑定“${result.cloudSync.teamName || '团队'}”。现在可以手动同步云端数据。`)
    return result.workspace
  }

  async function runOperationsCloudSync() {
    setError('')
    setNotice('正在同步云端运营数据...')
    const result = await api.runOperationsCloudSync()
    setOperations(result.workspace)
    setNotice(`云端同步完成：新增 ${result.result.inserted} 份，更新 ${result.result.updated} 份，移除 ${result.result.removed} 份云端来源报表。`)
    return result.workspace
  }

  async function disconnectOperationsCloudSync() {
    setError('')
    const result = await api.disconnectOperationsCloudSync()
    setOperations(result.workspace)
    setNotice('已断开云端团队，本机已有数据保持不变。')
    return result.workspace
  }

  function openSettings(section: SettingsSection = 'accounts') {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

  if (!overview || !operations) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f6f8fa] text-slate-500">正在加载本地监控工作台...</div>
  }

  const data = overview
  const runs = data.runs || []
  const currentPage = pageItems.find((item) => item.id === activePage) ?? guidePage

  const authPanel = (
    <AuthPanel
      sessions={data.authSessions}
      onSaved={refresh}
      onActivate={activateSession}
      onDelete={deleteSession}
    />
  )

  const modelConfigPanel = <ModelConfigPanel purpose="all" config={data.modelConfig} onSave={saveModelConfig} onDiscover={api.modelCatalog} onTest={testModelConfig} />
  const promptWorkbench = <PromptWorkbench presentation="professional" config={data.modelConfig} onLoadWorkspace={api.promptStudio} onAnalyzeProduct={api.analyzePromptProduct} onGenerate={api.generatePromptSet} onQuickGenerate={api.quickGeneratePrompt} onOpenModelSettings={() => openSettings('models')} onSaveProductProfile={savePromptProductProfile} onDeleteProductProfile={api.deletePromptProductProfile} onSaveStylePreset={savePromptStylePreset} onDeleteStylePreset={api.deletePromptStylePreset} onToggleLibraryFavorite={api.togglePromptLibraryFavorite} onToggleFavoriteHistory={togglePromptHistoryFavorite} onRenameHistory={renamePromptHistory} onDeleteHistory={api.deletePromptHistory} onSyncToImageWorkbench={syncPromptToImageWorkbench} onExitProfessional={() => setAiCreationView('compose')} />
  const imageWorkbench = <ImageWorkbench active={activePage === 'image-workbench' && aiCreationView === 'compose'} config={data.modelConfig} onOpenModelSettings={() => openSettings('models')} incomingDraft={incomingImageDraft} onEnhancePrompt={api.enhanceImagePrompt} onOpenProfessionalPrompt={() => { setProfessionalPromptMounted(true); setAiCreationView('professional') }} />
  const operationsAssistant = <OperationsAssistant
    workspace={operations}
    onUpload={uploadOperationsReport}
    onUploadProductCatalog={uploadProductCatalog}
    onSaveProductCatalogEntry={saveProductCatalogEntry}
    onExportProductCatalog={exportProductCatalog}
    onPreview={previewOperationsReport}
    onDeleteReport={deleteOperationsReport}
    onRenameReport={renameOperationsReport}
    onCreateStore={createOperationsStore}
    onDeleteStore={removeOperationsStore}
    onAssignReportsStore={assignOperationsReportsStore}
    onSaveSalesDeduction={saveOperationsSalesDeduction}
    onDeleteSalesDeduction={removeOperationsSalesDeduction}
    onAnalyze={analyzeOperations}
    onClearAnalyses={clearOperationsAnalyses}
    onRunDailyReport={runOperationsDailyReport}
    onLoadWorkspace={loadOperationsWorkspace}
    onLoadArchive={loadOperationsArchive}
    onActivateCloudSync={activateOperationsCloudSync}
    onRunCloudSync={runOperationsCloudSync}
    onDisconnectCloudSync={disconnectOperationsCloudSync}
  />
  const operationsAgent = <OperationsAgentChat active={activePage === 'operations-agent'} workspace={operations} modelConfig={data.modelConfig} onOpenModelSettings={() => openSettings('models')} onUpdateProfile={updateOperationsProfile} onDeleteReport={deleteOperationsReport} />

  function renderPage() {
    if (activePage === 'monitoring') {
      return (
        <ProductMonitoringWorkspace
          overview={data}
          sessions={data.authSessions}
          products={data.products}
          monitor={data.monitor}
          onAdd={handleAdd}
          onAddBatch={addProductsBatch}
          onRequireAuth={showAuthGuide}
          onToggle={toggleProduct}
          onSchedule={saveProductSchedule}
          onMediaPreference={saveProductMediaPreference}
          onSaveSkuMonitorPrice={saveSkuMonitorPrice}
          onSavePrimarySkuIds={savePrimarySkuIds}
          onCapture={captureProduct}
          onRetryBuyerShows={retryBuyerShows}
          onCaptureSearchMainImage={captureSearchMainImage}
          onReparseLocalEvidence={reparseProductLocalEvidence}
          onLocalImport={openLocalImport}
          onDelete={deleteProduct}
          onDeleteBatch={deleteProductsBatch}
          onCaptureBatch={captureProductsBatch}
          onPauseBatch={pauseProductsBatch}
          onToggleMonitorRunning={() => toggleMonitorRunning()}
          onRefresh={refresh}
          onOpenSettings={() => openSettings('accounts')}
          batchBusy={busy}
          batchBusyProductIds={batchBusyProductIds}
          busyProductId={busyProductId}
          monitorToggleBusy={monitorToggleBusy}
        />
      )
    }

    if (activePage === 'records') {
      return (
        <div className="space-y-5">
          <RunLog runs={runs} busy={busy} clearing={clearingRunLogs} onRetryFailed={retryFailedRun} onClear={clearRunLogs} />
          <DataRecords snapshots={data.snapshots} products={data.products} onClear={clearSnapshots} onEvidenceChanged={refresh} />
        </div>
      )
    }

    if (activePage === 'guide') {
      return <HelpCenter onNavigate={(page) => {
        if (page === 'settings') {
          openSettings('accounts')
          return
        }
        if (page === 'image-workbench') setAiCreationView('compose')
        setActivePage(page)
      }} />
    }

    return null
  }

  const selectedWallpaper = resolveAppWallpaper(wallpaperId)
  const selectedWallpaperSrc = selectedWallpaper.id === CUSTOM_APP_WALLPAPER_ID ? customWallpaperUrl : selectedWallpaper.src

  return (
    <div className={`wallpaper-${selectedWallpaper.id} relative min-h-screen ${selectedWallpaperSrc ? 'bg-transparent' : 'bg-[#f6f8fa]'}`}>
      {selectedWallpaperSrc && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 bg-[#f6f8fa]"
          style={{
            backgroundImage: `linear-gradient(rgba(246, 248, 250, 0.46), rgba(246, 248, 250, 0.46)), url(${selectedWallpaperSrc})`,
            backgroundPosition: selectedWallpaper.position,
            backgroundRepeat: 'no-repeat',
            backgroundSize: 'contain',
          }}
        />
      )}
      <aside className="app-sidebar app-sidebar-surface fixed inset-y-0 left-0 z-10 flex w-64 flex-col border-r border-white/70">
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white">
            <Search className="h-5 w-5" />
          </div>
          <div className="brand-copy">
            <div className="font-semibold text-slate-950">经营罗盘</div>
            <div className="text-xs text-slate-400">本地工作台</div>
          </div>
        </div>
        <nav className="app-nav flex-1 space-y-1 p-3">
          {primaryNavItems.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                if (item.id === 'image-workbench') setAiCreationView('compose')
                if (isOperationsPage(item.id)) setOperationsMounted(true)
                setActivePage(item.id)
              }}
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
        <div className="app-sidebar-footer border-t border-slate-200 px-5 py-4 text-xs text-slate-400">本机运行 · v{data.runtime.version}</div>
      </aside>

      <main className="app-main relative z-10 ml-64 min-h-screen">
        <header className="app-topbar-surface sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-white/70 px-3 py-2 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold text-slate-950">{currentPage.title}</h1>
            <p className="truncate text-sm text-slate-500">{activePage === 'image-workbench' && aiCreationView === 'professional' ? '逐项控制产品事实、风格、文案和修改边界，再同步回 AI 创作。' : currentPage.subtitle}</p>
          </div>
          <div className="flex w-full max-w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
            <label className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-500" title="调整界面文字大小"><Type className="h-4 w-4" /><select value={fontSize} onChange={(event) => setFontSize(event.target.value as FontSize)} className="bg-transparent text-xs text-slate-700 outline-none" aria-label="界面文字大小"><option value="small">小字</option><option value="standard">标准</option><option value="large">大字</option></select></label>
            <Button type="button" variant="secondary" size="sm" className="h-9 w-9 p-0" onClick={() => openSettings('appearance')} aria-label="切换应用壁纸" title="切换应用壁纸"><ImageIcon className="h-4 w-4" /></Button>
            <Button type="button" variant={activePage === 'guide' ? 'primary' : 'secondary'} onClick={() => setActivePage('guide')}><BookOpen className="h-4 w-4" />使用说明书</Button>
            <Button type="button" variant="secondary" onClick={() => openSettings('accounts')} className="relative">
              <Settings className="h-4 w-4" /><span className="hidden sm:inline">设置中心</span>
              {updateInfo?.updateAvailable && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" aria-label={`发现新版本 v${updateInfo.latestVersion}`} />}
            </Button>
          </div>
        </header>

        <div className="space-y-5 p-3 sm:p-6">
          {(notice || error) && <div className={`fixed bottom-5 left-1/2 z-[70] flex w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-md border bg-white p-3 text-sm shadow-xl ${error ? 'border-red-200 text-red-700' : notice.startsWith('正在') ? 'border-blue-200 text-blue-800' : 'border-emerald-200 text-emerald-800'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error ? <CircleAlert className="h-4 w-4 shrink-0" /> : notice.startsWith('正在') ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : <CircleCheck className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1">{error || notice}</span><button type="button" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => { setNotice(''); setError('') }} title="关闭提示" aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
          {professionalPromptMounted && <div className={activePage === 'image-workbench' && aiCreationView === 'professional' ? '' : 'hidden'}>{promptWorkbench}</div>}
          <div className={activePage === 'image-workbench' && aiCreationView === 'compose' ? '' : 'hidden'}>{imageWorkbench}</div>
          {operationsMounted && <div className={activePage === 'operations' ? '' : 'hidden'}>{operationsAssistant}</div>}
          {operationsMounted && <div className={activePage === 'operations-agent' ? '' : 'hidden'}>{operationsAgent}</div>}
          {activePage !== 'image-workbench' && !isOperationsPage(activePage) && renderPage()}
        </div>
      </main>
      {authGuideAccountType && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/35 p-4" role="dialog" aria-modal="true" aria-labelledby="auth-guide-title">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700"><Settings className="h-5 w-5" /></div>
                <div>
                  <h2 id="auth-guide-title" className="text-lg font-semibold text-slate-950">先完成账号授权</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">当前没有可用的淘宝扫码账号。授权并检测在线后，再开始抓取商品。</p>
                </div>
              </div>
              <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setAuthGuideAccountType(null)} aria-label="关闭账号授权引导" title="关闭"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAuthGuideAccountType(null)}>稍后设置</Button>
              <Button type="button" onClick={() => { setAuthGuideAccountType(null); openSettings('accounts') }}>
                <Settings className="h-4 w-4" />
                去账号授权
              </Button>
            </div>
          </div>
        </div>
      )}
      <SettingsCenter
        open={settingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={() => setSettingsOpen(false)}
        accountContent={authPanel}
        feishuContent={<div className="space-y-5"><FeishuAuthorization feishu={data.feishu} products={data.products} onSave={saveFeishuSettings} /><FeishuSettings feishu={data.feishu} logs={data.notificationLogs} products={data.products} onSave={saveFeishuSettings} onTest={testFeishu} /></div>}
        appearanceContent={<AppearanceSettings wallpaperId={wallpaperId} customWallpaperUrl={customWallpaperUrl} onWallpaperChange={setWallpaperId} onCustomWallpaperSaved={setCustomWallpaperBlob} onCustomWallpaperDeleted={() => { setCustomWallpaperBlob(null); setWallpaperId((current) => current === CUSTOM_APP_WALLPAPER_ID ? DEFAULT_APP_WALLPAPER_ID : current) }} />}
        modelContent={modelConfigPanel}
        currentVersion={data.runtime.version}
        updateInfo={updateInfo}
        updateChecking={updateChecking}
        updateError={updateError}
        onCheckUpdate={() => checkUpdates(false)}
        onOpenUpdateDialog={() => { setUpdateOpen(true); if (!updateInfo && !updateChecking) checkUpdates(false).catch(() => undefined) }}
      />
      <LocalImportDialog key={localImportTarget?.id || 'new-local-import'} open={localImportOpen} dataDir={data.runtime.dataDir} initialItemId={localImportTarget?.itemId || localImportTarget?.lastSnapshot?.itemId || ''} initialAccountType={localImportTarget?.accountType || 'normal'} onClose={() => { setLocalImportOpen(false); setLocalImportTarget(null) }} onImported={localImportCompleted} />
      {updateOpen && <UpdateDialog currentVersion={data.runtime.version} info={updateInfo} checking={updateChecking} error={updateError} onCheck={() => checkUpdates(false)} onClose={() => setUpdateOpen(false)} />}
    </div>
  )
}

export default App
