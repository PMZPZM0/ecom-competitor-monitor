import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BellRing, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Download, Eye, FileJson, LoaderCircle, PauseCircle, Play, PlayCircle, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { downloadFile } from '../../lib/download'
import { api } from '../../lib/api'
import { currency } from '../../lib/utils'
import type { MonitorChannel, Overview, Product, ProductCaptureOptions, RunRecord } from '../../types/domain'
import { ImagePreview, type Preview } from '../products/productDisplay'
import { PriceVerificationDialog } from '../products/PriceVerificationDialog'
import { ProductMonitorCard } from '../products/ProductMonitorCard'
import {
  downloadBuyerShowsBatchHref,
  normalPriceForSku,
  productHasCoinBenefit,
  productImages,
  productItemId,
  productModel,
  productShopName,
  productTitle,
  publicPriceLabelForSku,
  verifiedPriceValue,
} from '../products/productDisplayUtils'
import { productSortOptions, sortProducts, type ProductSortKey } from '../products/productSort'

type Props = {
  products: Product[]
  monitor: Overview['monitor']
  onToggle: (product: Product) => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onMediaPreference: (product: Product, captureMediaAssets: boolean) => Promise<void>
  onSaveSkuMonitorPrice: (product: Product, skuId: string, value: number | null, channel?: MonitorChannel) => Promise<void>
  onSavePrimarySkuIds: (product: Product, primarySkuIds: string[]) => Promise<void>
  onCapture: (product: Product, options?: ProductCaptureOptions) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onCaptureSearchMainImage: (product: Product) => Promise<{ ok: boolean; status: NonNullable<Product['searchMainImageStatus']>; product: Product; message: string }>
  onReparseLocalEvidence: (product: Product, kind: 'price' | 'materials' | 'buyer-show' | 'search-main-image') => Promise<{ ok: boolean; product: Product; message: string }>
  onLocalImport: (product?: Product) => void
  onDelete: (product: Product) => Promise<void>
  onDeleteBatch: (products: Product[]) => Promise<void>
  onCaptureBatch: (products: Product[]) => Promise<RunRecord | void>
  onRequestAdd?: () => void
  batchBusy?: boolean
  batchBusyProductIds?: string[]
  busyProductId?: string
}

type AccountFilter = '' | 'normal' | 'gift' | 'vip88'
type BenefitFilter = '' | 'billion' | 'seckill' | 'government' | 'surprise' | 'coin' | 'gift' | 'vip88'

const accountLabels = { normal: '普通账号 普通价', gift: '礼金账号 礼金价', vip88: '88VIP账号 88VIP价' } as const
const benefitLabels: Array<{ value: BenefitFilter; label: string }> = [
  { value: '', label: '全部优惠' },
  { value: 'billion', label: '百亿补贴' },
  { value: 'seckill', label: '淘宝秒杀' },
  { value: 'government', label: '国补' },
  { value: 'surprise', label: '惊喜立减' },
  { value: 'coin', label: '淘金币' },
  { value: 'gift', label: '礼金' },
  { value: 'vip88', label: '88VIP' },
]

function productHasBenefit(product: Product, channel: Exclude<BenefitFilter, ''>) {
  if (channel === 'coin') return productHasCoinBenefit(product)
  return Boolean(product.lastSnapshot?.skuPrices?.some((sku) => verifiedPriceValue(sku, channel) !== null))
}

function searchableText(product: Product) {
  const accountType = product.accountType || 'normal'
  const skuText = product.lastSnapshot?.skuPrices?.flatMap((sku) => [sku.name, sku.skuId]).join(' ') || ''
  const benefits = benefitLabels
    .filter((item): item is { value: Exclude<BenefitFilter, ''>; label: string } => Boolean(item.value))
    .filter((item) => productHasBenefit(product, item.value))
    .map((item) => item.label)
    .join(' ')
  return [
    product.name,
    productShopName(product),
    productModel(product),
    product.group,
    product.autoGroup,
    productItemId(product),
    product.url,
    accountLabels[accountType],
    benefits,
    skuText,
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
}

function verifiedMinimumForSku(sku: NonNullable<Product['lastSnapshot']>['skuPrices'][number]) {
  const channels = ['normal', 'billion', 'seckill', 'government', 'surprise', 'gift', 'vip88', 'coin'] as const
  const labels: Record<typeof channels[number], string> = {
    normal: '普通价',
    billion: '百亿补贴价',
    seckill: '淘宝秒杀价',
    government: '国补价',
    surprise: '惊喜立减价',
    gift: '礼金价',
    vip88: '88VIP价',
    coin: '淘金币价',
  }
  let best: { value: number; label: string } | null = null
  for (const channel of channels) {
    const value = channel === 'normal' ? verifiedPriceValue(sku, channel) ?? (sku.resolutionStatus === 'verified' ? normalPriceForSku(sku) : null) : verifiedPriceValue(sku, channel)
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && (!best || value < best.value)) {
      best = { value, label: channel === 'normal' ? publicPriceLabelForSku(sku) : labels[channel] }
    }
  }
  return best
}

function visibleSkuPrices(product: Product) {
  const skuPrices = product.lastSnapshot?.skuPrices || []
  const skuById = new Map(skuPrices.map((sku) => [sku.skuId, sku]))
  const primarySkuIds = [...new Set(product.primarySkuIds || [])]
    .filter((skuId) => skuById.has(skuId))
    .slice(0, 3)
  if (primarySkuIds.length) {
    return primarySkuIds.map((skuId) => {
      const sku = skuById.get(skuId)!
      const price = verifiedMinimumForSku(sku)
      return { skuId, name: sku.name || `SKU ${skuId}`, value: price?.value ?? null, label: price?.label || '暂无已验证价' }
    })
  }
  const automatic = skuPrices
    .map((sku) => ({ sku, price: verifiedMinimumForSku(sku) }))
    .sort((left, right) => (left.price?.value ?? Number.POSITIVE_INFINITY) - (right.price?.value ?? Number.POSITIVE_INFINITY))[0]
  if (!automatic) return [{ skuId: '', name: '暂无 SKU', value: null, label: '待抓取' }]
  return [{
    skuId: automatic.sku.skuId,
    name: automatic.sku.name || `SKU ${automatic.sku.skuId}`,
    value: automatic.price?.value ?? null,
    label: automatic.price?.label || '暂无已验证价',
  }]
}

function monitorRuleSummary(product: Product) {
  const explicit = Object.values(product.skuMonitorRules || {}).flatMap((rule) => Object.values(rule))
  const legacy = Object.values(product.skuMonitorPrices || {})
  const values = (explicit.length ? explicit : legacy).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  return {
    count: values.length,
    minimum: values.length ? Math.min(...values) : null,
  }
}

function primarySkuCount(product: Product) {
  const currentSkuIds = new Set(product.lastSnapshot?.skuPrices?.map((sku) => sku.skuId) || [])
  return [...new Set(product.primarySkuIds || [])].filter((skuId) => currentSkuIds.has(skuId)).slice(0, 3).length
}

function accountLabel(product: Product) {
  if (product.accountType === 'gift') return '礼金账号'
  if (product.accountType === 'vip88') return '88VIP账号'
  return '普通账号'
}

function accountClass(product: Product) {
  if (product.accountType === 'gift') return 'border-orange-100 bg-orange-50 text-orange-700'
  if (product.accountType === 'vip88') return 'border-violet-100 bg-violet-50 text-violet-700'
  return 'border-sky-100 bg-sky-50 text-sky-700'
}

function productState(product: Product, monitor: Overview['monitor']) {
  if (product.lastSnapshot?.resolutionStatus === 'partial') {
    const total = product.lastSnapshot.skuPrices?.length || 0
    const verified = product.lastSnapshot.skuPrices?.filter((sku) => sku.resolutionStatus === 'verified').length || 0
    return { label: `部分可用 ${verified}/${total}`, detail: product.lastError || '部分 SKU 缺少当前优惠证据', tone: 'amber', rail: 'border-l-amber-400', badge: 'border-amber-100 bg-amber-50 text-amber-700' }
  }
  if (product.lastStatus === 'error') return { label: '抓取异常', detail: product.lastError || '等待重试', tone: 'red', rail: 'border-l-red-500', badge: 'border-red-100 bg-red-50 text-red-700' }
  if (product.captureMode === 'local-only') return { label: '本地数据', detail: '等待导入新文件', tone: 'sky', rail: 'border-l-sky-500', badge: 'border-sky-100 bg-sky-50 text-sky-700' }
  if (!product.enabled) return { label: '未启用', detail: '手动抓取仍可使用', tone: 'slate', rail: 'border-l-slate-300', badge: 'border-slate-200 bg-slate-50 text-slate-600' }
  if (!monitor.running) return { label: '等待全局开启', detail: '商品计划已保留', tone: 'amber', rail: 'border-l-amber-400', badge: 'border-amber-100 bg-amber-50 text-amber-700' }
  return {
    label: '监控中',
    detail: product.nextMonitorAt ? `下次 ${new Date(product.nextMonitorAt).toLocaleString('zh-CN', { hour12: false })}` : '等待调度',
    tone: 'emerald',
    rail: 'border-l-emerald-500',
    badge: 'border-emerald-100 bg-emerald-50 text-emerald-700',
  }
}

export function MonitorClassification({ products, monitor, onToggle, onSchedule, onMediaPreference, onSaveSkuMonitorPrice, onSavePrimarySkuIds, onCapture, onRetryBuyerShows, onCaptureSearchMainImage, onReparseLocalEvidence, onLocalImport, onDelete, onDeleteBatch, onCaptureBatch, onRequestAdd, batchBusy, batchBusyProductIds, busyProductId }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [query, setQuery] = useState('')
  const [shopFilter, setShopFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState<AccountFilter>('')
  const [benefitFilter, setBenefitFilter] = useState<BenefitFilter>('')
  const [sortKey, setSortKey] = useState<ProductSortKey>('updated-desc')
  const [page, setPage] = useState(1)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [previewProductId, setPreviewProductId] = useState('')
  const [priceVerificationProductId, setPriceVerificationProductId] = useState('')
  const [quickActionKey, setQuickActionKey] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchFeedback, setBatchFeedback] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const shopOptions = useMemo(() => Array.from(new Set(products.map(productShopName))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [products])
  const modelOptions = useMemo(() => Array.from(new Set(products.filter((product) => !shopFilter || productShopName(product) === shopFilter).map(productModel))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [products, shopFilter])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
    return products.filter((product) => {
      if (shopFilter && productShopName(product) !== shopFilter) return false
      if (modelFilter && productModel(product) !== modelFilter) return false
      if (accountFilter && (product.accountType || 'normal') !== accountFilter) return false
      if (benefitFilter && !productHasBenefit(product, benefitFilter)) return false
      return !normalizedQuery || searchableText(product).includes(normalizedQuery)
    })
  }, [products, query, shopFilter, modelFilter, accountFilter, benefitFilter])
  const sortedProducts = useMemo(() => sortProducts(filteredProducts, sortKey), [filteredProducts, sortKey])
  const limitedProducts = useMemo(() => sortedProducts.slice(0, 100), [sortedProducts])
  const totalPages = Math.max(1, Math.ceil(limitedProducts.length / 10))
  const pageProducts = useMemo(() => limitedProducts.slice((page - 1) * 10, page * 10), [limitedProducts, page])
  const visibleIds = useMemo(() => new Set(pageProducts.map((product) => product.id)), [pageProducts])
  const selectedVisibleCount = pageProducts.filter((product) => selectedIds.has(product.id)).length
  const selectedOnlineCount = sortedProducts.filter((product) => selectedIds.has(product.id) && product.captureMode !== 'local-only').length
  const allVisibleSelected = pageProducts.length > 0 && selectedVisibleCount === pageProducts.length
  const hasFilters = Boolean(query || shopFilter || modelFilter || accountFilter || benefitFilter)
  const previewProduct = products.find((product) => product.id === previewProductId) || null
  const priceVerificationProduct = products.find((product) => product.id === priceVerificationProductId) || null

  function resetFilters() {
    setQuery('')
    setShopFilter('')
    setModelFilter('')
    setAccountFilter('')
    setBenefitFilter('')
  }

  function chooseShop(shopName: string) {
    setShopFilter(shopName)
    setModelFilter('')
  }

  function toggleProductSelection(productId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })
  }

  function toggleVisibleSelection() {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function deleteSelected() {
    const selectedProducts = products.filter((product) => selectedIds.has(product.id))
    await onDeleteBatch(selectedProducts)
    setSelectedIds(new Set())
  }

  async function captureSelected() {
    const selectedProducts = sortedProducts.filter((product) => selectedIds.has(product.id) && product.captureMode !== 'local-only')
    if (!selectedProducts.length) {
      setBatchFeedback({ tone: 'error', message: '所选商品均为本地数据模式，请分别导入新文件更新价格。' })
      return
    }
    setBatchFeedback({ tone: 'progress', message: `已加入 ${selectedProducts.length} 个商品，正在按账号隔离队列抓取...` })
    try {
      const run = await onCaptureBatch(selectedProducts)
      setBatchFeedback({ tone: run?.failed ? 'error' : 'success', message: run?.message || `${selectedProducts.length} 个商品的批量抓取任务已完成。` })
      setSelectedIds(new Set())
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '批量抓取失败。' })
    }
  }

  async function downloadSelectedBuyerShows() {
    const count = selectedIds.size
    setBatchFeedback({ tone: 'progress', message: `正在整理 ${count} 个商品的买家秀并生成 ZIP...` })
    try {
      await downloadFile(downloadBuyerShowsBatchHref(Array.from(selectedIds)), '批量买家秀.zip')
      setBatchFeedback({ tone: 'success', message: '批量买家秀 ZIP 已生成并开始下载。' })
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '批量买家秀下载失败。' })
    }
  }

  async function runQuickCapture(product: Product) {
    const key = `${product.id}:capture`
    setQuickActionKey(key)
    setBatchFeedback({ tone: 'progress', message: `正在抓取“${productTitle(product)}”，请保持软件运行。` })
    try {
      const captured = await onCapture(product)
      if (!captured?.lastSnapshot || captured.lastStatus === 'error') throw new Error(captured?.lastError || '没有生成可验证的价格快照。')
      setBatchFeedback({ tone: 'success', message: `“${productTitle(product)}”已更新，价格证据已保存到本地并完成解析。` })
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '商品抓取失败。' })
    } finally {
      setQuickActionKey('')
    }
  }

  async function runQuickSync(product: Product) {
    const key = `${product.id}:sync`
    setQuickActionKey(key)
    setBatchFeedback({ tone: 'progress', message: `正在同步“${productTitle(product)}”到飞书。` })
    try {
      await api.syncProductToFeishu(product.id)
      setBatchFeedback({ tone: 'success', message: `“${productTitle(product)}”已同步到飞书。` })
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '飞书同步失败。' })
    } finally {
      setQuickActionKey('')
    }
  }

  async function runQuickToggle(product: Product) {
    const key = `${product.id}:monitor`
    setQuickActionKey(key)
    try {
      await onToggle(product)
      setBatchFeedback({ tone: 'success', message: product.enabled ? `已暂停“${productTitle(product)}”的定时监控。` : `已启用“${productTitle(product)}”的定时监控。` })
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '监控状态更新失败。' })
    } finally {
      setQuickActionKey('')
    }
  }

  async function runQuickDelete(product: Product) {
    const key = `${product.id}:delete`
    setQuickActionKey(key)
    try {
      await onDelete(product)
      setBatchFeedback({ tone: 'success', message: '商品已删除。' })
    } catch (error) {
      setBatchFeedback({ tone: 'error', message: error instanceof Error ? error.message : '删除商品失败。' })
    } finally {
      setQuickActionKey('')
    }
  }

  useEffect(() => {
    const existingIds = new Set(products.map((product) => product.id))
    setSelectedIds((current) => new Set([...current].filter((id) => existingIds.has(id))))
    if (previewProductId && !existingIds.has(previewProductId)) setPreviewProductId('')
    if (priceVerificationProductId && !existingIds.has(priceVerificationProductId)) setPriceVerificationProductId('')
  }, [products, previewProductId, priceVerificationProductId])

  useEffect(() => setPage(1), [query, shopFilter, modelFilter, accountFilter, benefitFilter, sortKey])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape' && previewProductId && !preview) setPreviewProductId('')
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [previewProductId, preview])

  return (
    <>
      <section className="product-workbench-filter" aria-label="商品筛选与批量操作">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 p-3 lg:grid-cols-[minmax(280px,1.7fr)_minmax(150px,0.8fr)_minmax(150px,0.8fr)_170px_auto]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input ref={searchRef} className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、店铺、型号、SKU、账号、优惠或商品 ID" aria-label="搜索监控商品" />
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400 xl:block">/</kbd>
          </label>
          <Button type="button" variant="secondary" onClick={() => setMobileFiltersOpen((current) => !current)} aria-expanded={mobileFiltersOpen} className="px-3 lg:hidden"><SlidersHorizontal className="h-4 w-4" />筛选</Button>
          <select value={shopFilter} onChange={(event) => chooseShop(event.target.value)} className={`${mobileFiltersOpen ? 'block' : 'hidden'} col-span-2 h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 lg:col-span-1 lg:block`} aria-label="按店铺筛选">
            <option value="">全部店铺</option>
            {shopOptions.map((shop) => <option key={shop} value={shop}>{shop}</option>)}
          </select>
          <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} className={`${mobileFiltersOpen ? 'block' : 'hidden'} col-span-2 h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 lg:col-span-1 lg:block`} aria-label="按型号筛选">
            <option value="">全部型号</option>
            {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as ProductSortKey)} className={`${mobileFiltersOpen ? 'block' : 'hidden'} col-span-2 h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 lg:col-span-1 lg:block`} aria-label="商品排序">
            {productSortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <Button type="button" variant="ghost" onClick={resetFilters} disabled={!hasFilters} title="清空全部筛选" className={`${mobileFiltersOpen ? 'inline-flex' : 'hidden'} col-span-2 lg:col-span-1 lg:inline-flex`}><RotateCcw className="h-4 w-4" />重置</Button>
        </div>

        <div className={`${mobileFiltersOpen ? 'flex' : 'hidden'} flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-3 py-2.5 lg:flex`}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5"><span className="text-[11px] font-medium text-slate-400">账号</span><div className="inline-flex h-8 overflow-hidden rounded-md bg-slate-100 p-0.5" aria-label="账号类型筛选">
              {([{ value: '', label: '全部' }, { value: 'normal', label: '普通' }, { value: 'gift', label: '礼金' }, { value: 'vip88', label: '88VIP' }] as const).map((option) => <button key={option.value || 'all'} type="button" onClick={() => setAccountFilter(option.value)} className={`rounded px-2.5 text-xs ${accountFilter === option.value ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{option.label}</button>)}
            </div></div>
            <div className="flex items-center gap-1.5"><span className="text-[11px] font-medium text-slate-400">价格</span><div className="inline-flex min-h-8 flex-wrap items-center gap-0.5 rounded-md bg-slate-100 p-0.5" aria-label="优惠类型筛选">
              {benefitLabels.map((option) => <button key={option.value || 'all'} type="button" onClick={() => setBenefitFilter(option.value)} className={`h-7 rounded px-2.5 text-xs ${benefitFilter === option.value ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{option.label}</button>)}
            </div></div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>找到 {filteredProducts.length} 个</span>
            {filteredProducts.length > 100 && <span className="text-amber-700">仅显示前 100 个</span>}
            <Button type="button" variant="secondary" size="sm" onClick={toggleVisibleSelection} disabled={!pageProducts.length}>{allVisibleSelected ? '取消本页' : '全选本页'}</Button>
          </div>
        </div>
      </section>

      {selectedIds.size > 0 && (
        <div className="sticky top-[72px] z-[8] mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 shadow-sm">
          <span className="text-sm font-medium text-blue-900">已选 {selectedIds.size} 个商品</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={captureSelected} disabled={!selectedOnlineCount || selectedOnlineCount > 20 || batchBusy} title={selectedOnlineCount > 20 ? '单次最多抓取 20 个商品' : '只抓取选中的在线商品'}><Play className="h-4 w-4" />{batchBusy ? '队列抓取中' : selectedOnlineCount > 20 ? '最多 20 个' : `批量抓取 ${selectedOnlineCount}`}</Button>
            <Button type="button" variant="secondary" size="sm" onClick={downloadSelectedBuyerShows} disabled={batchFeedback?.tone === 'progress'}><Download className="h-4 w-4" />买家秀 ZIP</Button>
            <Button type="button" variant="danger" size="sm" onClick={deleteSelected}><Trash2 className="h-4 w-4" />删除</Button>
          </div>
        </div>
      )}

      {batchFeedback && <div className={`mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${batchFeedback.tone === 'progress' ? 'bg-blue-50 text-blue-800' : batchFeedback.tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`} role={batchFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{batchFeedback.tone === 'progress' ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : batchFeedback.tone === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}<span>{batchFeedback.message}</span></div>}

      <section className="product-workbench-list mt-3 overflow-hidden rounded-lg border" aria-label="商品监控列表">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5 text-xs text-slate-500">
          <span><strong className="font-semibold text-slate-800">{filteredProducts.length} 个商品</strong><span className="mx-1.5 text-slate-300">·</span>点击商品预览明细</span>
          <span className="hidden sm:inline">右侧直接执行操作</span>
        </div>
        <div className="space-y-2 p-2 sm:p-3">
          {pageProducts.map((product) => {
            const { primary } = productImages(product)
            const state = productState(product, monitor)
            const skuPriceCards = visibleSkuPrices(product)
            const rules = monitorRuleSummary(product)
            const mainSkuCount = primarySkuCount(product)
            const busy = busyProductId === product.id || batchBusyProductIds?.includes(product.id) === true
            const captureBusy = quickActionKey === `${product.id}:capture`
            const syncBusy = quickActionKey === `${product.id}:sync`
            const monitorBusy = quickActionKey === `${product.id}:monitor`
            const deleteBusy = quickActionKey === `${product.id}:delete`
            return (
              <article key={product.id} className={`product-list-card group relative overflow-hidden rounded-lg border bg-white shadow-[0_4px_12px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[0_10px_22px_rgba(15,23,42,0.09)] ${state.rail.replace('border-l-', 'border-')}`}>
                <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${state.rail.replace('border-l-', 'bg-')}`} />
                <div className="product-list-card-grid px-3 py-3 sm:px-4">
                  <label className="product-list-selection" title="选择商品">
                    <input type="checkbox" checked={selectedIds.has(product.id)} onChange={() => toggleProductSelection(product.id)} className="h-4 w-4 accent-blue-600" aria-label={`选择 ${productTitle(product)}`} />
                  </label>
                  <button type="button" onClick={() => setPreviewProductId(product.id)} className="product-list-primary flex min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
                    <span className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-slate-100 bg-slate-50">{primary ? <img src={primary} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : <span className="flex h-full items-center justify-center text-[11px] text-slate-400">无图</span>}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold leading-5 text-slate-950" title={productTitle(product)}>{productTitle(product)}</span>{product.captureMode === 'local-only' && <FileJson className="h-3.5 w-3.5 shrink-0 text-sky-600" />}</span>
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500"><span className="max-w-48 truncate">{productShopName(product)}</span><span>{productModel(product)}</span><span className="tabular-nums text-slate-400">ID {productItemId(product) || '未识别'}</span></span>
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400"><Badge className={accountClass(product)}>{accountLabel(product)}</Badge><Badge className={state.badge}>{state.label}</Badge><span>{product.lastSnapshot?.skuPrices?.length || 0} 个 SKU</span><span className={mainSkuCount ? 'font-medium text-sky-700' : ''}>主 SKU {mainSkuCount} 个</span><span className={state.tone === 'red' ? 'text-red-600' : ''}>{state.detail}</span></span>
                    </span>
                    <Eye className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-sky-600" />
                  </button>
                  <div className="product-list-price min-w-0">
                    <div className={`grid gap-1.5 ${skuPriceCards.length > 1 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1'}`}>
                      {skuPriceCards.map((sku) => (
                        <div key={sku.skuId || 'pending'} className="min-w-0 border border-slate-100 bg-slate-50/80 px-2 py-1.5">
                          <div className="truncate text-[11px] font-medium text-slate-600" title={sku.name}>{sku.name}</div>
                          <div className={`mt-1 text-base font-semibold leading-none tabular-nums ${sku.value === null ? 'text-slate-400' : 'text-slate-950'}`}>{sku.value === null ? '待抓取' : currency(sku.value)}</div>
                          <div className="mt-1 truncate text-[10px] text-slate-400">{sku.label}</div>
                        </div>
                      ))}
                    </div>
                    {rules.count > 0 && <div className="mt-1 text-[11px] text-slate-500">{rules.count} 项阈值</div>}
                  </div>
                  <div className="product-list-actions">
                    <button type="button" onClick={() => setPriceVerificationProductId(product.id)} disabled={!product.lastSnapshot?.skuPrices?.length} className="product-quick-action" title="逐 SKU 核对价格证据、展示金额和计算公式"><ShieldCheck className="h-3.5 w-3.5" /><span>核对</span></button>
                    {product.captureMode !== 'local-only' && <button type="button" onClick={() => void runQuickToggle(product)} disabled={monitorBusy} className={`product-quick-action ${product.enabled ? 'text-amber-700 hover:border-amber-200 hover:bg-amber-50' : 'text-emerald-700 hover:border-emerald-200 hover:bg-emerald-50'}`} title={product.enabled ? '暂停本商品定时监控' : '启用本商品定时监控'}>{monitorBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : product.enabled ? <PauseCircle className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}<span>{product.enabled ? '暂停' : '定时'}</span></button>}
                    <button type="button" onClick={() => void runQuickSync(product)} disabled={syncBusy || !product.lastSnapshot} className="product-quick-action" title="同步当前商品的全部 SKU 价格到飞书">{syncBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}<span>飞书</span></button>
                    {product.captureMode === 'local-only'
                      ? <button type="button" onClick={() => onLocalImport(product)} className="product-quick-action product-quick-action-primary" title="导入新的本地数据文件"><FileJson className="h-3.5 w-3.5" /><span>导入</span></button>
                      : <button type="button" onClick={() => void runQuickCapture(product)} disabled={busy || captureBusy} className="product-quick-action product-quick-action-primary" title="抓取当前商品价格与 SKU">{busy || captureBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}<span>{busy || captureBusy ? '抓取中' : '抓取'}</span></button>}
                    <button type="button" onClick={() => void runQuickDelete(product)} disabled={deleteBusy} className="product-quick-action product-quick-action-danger" title="删除商品" aria-label={`删除 ${productTitle(product)}`}>{deleteBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button>
                  </div>
                </div>
              </article>
            )
          })}
          {!products.length && <div className="px-6 py-16 text-center"><div className="font-medium text-slate-800">还没有监控商品</div><div className="mt-1 text-sm text-slate-500">先添加一个商品，核对价格后再启用监控。</div>{onRequestAdd && <Button type="button" className="mt-4" onClick={onRequestAdd}>添加商品</Button>}</div>}
          {products.length > 0 && !pageProducts.length && <div className="px-6 py-16 text-center"><div className="font-medium text-slate-800">没有匹配的商品</div><button type="button" onClick={resetFilters} className="mt-2 text-sm font-medium text-blue-700 hover:text-blue-800">清空筛选条件</button></div>}
        </div>
      </section>

      {limitedProducts.length > 10 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>第 {page} / {totalPages} 页 · 本页 {pageProducts.length} 个</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" title="上一页"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40" title="下一页"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      {previewProduct && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/35 p-0 backdrop-blur-[2px] sm:items-center sm:p-5" role="presentation" onMouseDown={() => setPreviewProductId('')}>
          <section role="dialog" aria-modal="true" aria-label="商品预览" onMouseDown={(event) => event.stopPropagation()} className="flex max-h-[94vh] w-full max-w-[1240px] flex-col overflow-hidden rounded-t-xl bg-slate-50 shadow-2xl sm:rounded-xl">
            <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
              <div><div className="text-sm font-semibold text-slate-950">商品预览</div><div className="mt-0.5 text-xs text-slate-500">在这里查看 SKU、优惠公式、定时计划与素材</div></div>
              <button type="button" onClick={() => setPreviewProductId('')} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-950" title="关闭预览" aria-label="关闭预览"><X className="h-4 w-4" /></button>
            </header>
            <div className="min-h-0 overflow-y-auto p-2 sm:p-4">
              <ProductMonitorCard product={previewProduct} onToggle={onToggle} onSchedule={onSchedule} onMediaPreference={onMediaPreference} onSaveSkuMonitorPrice={onSaveSkuMonitorPrice} onSavePrimarySkuIds={onSavePrimarySkuIds} onCapture={onCapture} onRetryBuyerShows={onRetryBuyerShows} onCaptureSearchMainImage={onCaptureSearchMainImage} onReparseLocalEvidence={onReparseLocalEvidence} onLocalImport={onLocalImport} onDelete={onDelete} busy={busyProductId === previewProduct.id || batchBusyProductIds?.includes(previewProduct.id) === true} onPreview={setPreview} monitor={monitor} showPrimaryActions={false} />
            </div>
          </section>
        </div>
      )}
      {priceVerificationProduct && <PriceVerificationDialog product={priceVerificationProduct} accountSessionId={priceVerificationProduct.lastSnapshot?.primaryAccountSessionId || priceVerificationProduct.primaryAccountSessionId || ''} accountType={priceVerificationProduct.lastSnapshot?.primaryAccountType || priceVerificationProduct.accountType || 'normal'} accountName={accountLabel(priceVerificationProduct)} onClose={() => setPriceVerificationProductId('')} />}
      <ImagePreview preview={preview} onClose={() => setPreview(null)} />
    </>
  )
}
