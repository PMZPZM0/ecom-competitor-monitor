import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, FileJson, LoaderCircle, Play, RotateCcw, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { downloadFile } from '../../lib/download'
import { currency } from '../../lib/utils'
import type { MonitorChannel, Overview, Product, ProductCaptureOptions, RunRecord } from '../../types/domain'
import { ImagePreview, type Preview } from '../products/productDisplay'
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
  onCapture: (product: Product, options?: ProductCaptureOptions) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onLocalImport: (product?: Product) => void
  onDelete: (product: Product) => Promise<void>
  onDeleteBatch: (products: Product[]) => Promise<void>
  onCaptureBatch: (products: Product[]) => Promise<RunRecord | void>
  onRequestAdd?: () => void
  batchBusy?: boolean
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

function verifiedMinimum(product: Product) {
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
  for (const sku of product.lastSnapshot?.skuPrices || []) {
    for (const channel of channels) {
      const value = channel === 'normal' ? verifiedPriceValue(sku, channel) ?? (sku.resolutionStatus === 'verified' ? normalPriceForSku(sku) : null) : verifiedPriceValue(sku, channel)
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && (!best || value < best.value)) {
        best = { value, label: channel === 'normal' ? publicPriceLabelForSku(sku) : labels[channel] }
      }
    }
  }
  return best
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

export function MonitorClassification({ products, monitor, onToggle, onSchedule, onMediaPreference, onSaveSkuMonitorPrice, onCapture, onRetryBuyerShows, onLocalImport, onDelete, onDeleteBatch, onCaptureBatch, onRequestAdd, batchBusy, busyProductId }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [query, setQuery] = useState('')
  const [shopFilter, setShopFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState<AccountFilter>('')
  const [benefitFilter, setBenefitFilter] = useState<BenefitFilter>('')
  const [sortKey, setSortKey] = useState<ProductSortKey>('updated-desc')
  const [page, setPage] = useState(1)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [expandedProductId, setExpandedProductId] = useState('')
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

  useEffect(() => {
    const existingIds = new Set(products.map((product) => product.id))
    setSelectedIds((current) => new Set([...current].filter((id) => existingIds.has(id))))
    if (expandedProductId && !existingIds.has(expandedProductId)) setExpandedProductId('')
  }, [products, expandedProductId])

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
      if (event.key === 'Escape' && expandedProductId && !preview) setExpandedProductId('')
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [expandedProductId, preview])

  return (
    <>
      <section className="monitor-surface border-y border-white/70" aria-label="商品筛选与批量操作">
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
            <div className="inline-flex h-8 overflow-hidden rounded-md bg-slate-100 p-0.5" aria-label="账号类型筛选">
              {([{ value: '', label: '全部账号' }, { value: 'normal', label: '普通' }, { value: 'gift', label: '礼金' }, { value: 'vip88', label: '88VIP' }] as const).map((option) => <button key={option.value || 'all'} type="button" onClick={() => setAccountFilter(option.value)} className={`rounded px-2.5 text-xs ${accountFilter === option.value ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{option.label}</button>)}
            </div>
            <div className="inline-flex min-h-8 flex-wrap items-center gap-0.5 rounded-md bg-slate-100 p-0.5" aria-label="优惠类型筛选">
              {benefitLabels.map((option) => <button key={option.value || 'all'} type="button" onClick={() => setBenefitFilter(option.value)} className={`h-7 rounded px-2.5 text-xs ${benefitFilter === option.value ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{option.label}</button>)}
            </div>
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

      <section className="monitor-surface mt-3 overflow-hidden border-y border-white/70" aria-label="商品监控列表">
        <div className="hidden grid-cols-[28px_minmax(220px,1.7fr)_120px_100px_150px_140px] items-center gap-3 bg-white/25 px-4 py-2.5 text-xs font-semibold text-slate-600 lg:grid">
          <span />
          <span>商品</span>
          <span>价格与阈值</span>
          <span>主账号</span>
          <span>监控状态</span>
          <span className="text-right">快捷操作</span>
        </div>
        <div className="divide-y divide-slate-100">
          {pageProducts.map((product) => {
            const expanded = expandedProductId === product.id
            const { primary } = productImages(product)
            const state = productState(product, monitor)
            const currentPrice = verifiedMinimum(product)
            const rules = monitorRuleSummary(product)
            const busy = busyProductId === product.id || Boolean(batchBusy)
            return (
              <article key={product.id} className={`border-l-4 ${state.rail} bg-white/10 transition-colors hover:bg-white/28`}>
                <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 lg:grid-cols-[28px_minmax(220px,1.7fr)_120px_100px_150px_140px] lg:items-center lg:gap-3 lg:px-4">
                  <label className="flex h-8 items-center justify-center self-start lg:self-center" title="选择商品">
                    <input type="checkbox" checked={selectedIds.has(product.id)} onChange={() => toggleProductSelection(product.id)} className="h-4 w-4 accent-blue-600" aria-label={`选择 ${productTitle(product)}`} />
                  </label>
                  <button type="button" onClick={() => setExpandedProductId(expanded ? '' : product.id)} className="flex min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" aria-expanded={expanded} aria-controls={`product-detail-${product.id}`}>
                    <span className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-slate-100">{primary ? <img src={primary} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : null}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-slate-950" title={productTitle(product)}>{productTitle(product)}</span>{product.captureMode === 'local-only' && <FileJson className="h-3.5 w-3.5 shrink-0 text-sky-600" />}</span>
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500"><span className="max-w-48 truncate">{productShopName(product)}</span><span>{productModel(product)}</span><span className="tabular-nums text-slate-400">ID {productItemId(product) || '未识别'}</span></span>
                      <span className="mt-1 block text-[11px] text-slate-400">{product.lastSnapshot?.skuPrices?.length || 0} 个 SKU · {product.lastSnapshot?.capturedAt ? `更新于 ${new Date(product.lastSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未成功抓取'}</span>
                    </span>
                    {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                  </button>
                  <div className="col-start-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 lg:contents">
                    <div>
                      <div className={`text-base font-semibold tabular-nums ${currentPrice == null ? 'text-slate-400' : 'text-slate-950'}`}>{currentPrice == null ? '--' : currency(currentPrice.value)}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">{currentPrice?.label || '尚未验证价格'}{rules.count ? ` · ${rules.count} 项监控 · 最低 ${currency(rules.minimum)}` : ' · 尚未设置监控价'}</div>
                    </div>
                    <div><Badge className={accountClass(product)}>{accountLabel(product)}</Badge></div>
                    <div className="col-span-2 min-w-0 lg:col-span-1"><Badge className={state.badge}>{state.label}</Badge><div className={`mt-1 truncate text-[11px] ${state.tone === 'red' ? 'text-red-600' : 'text-slate-500'}`} title={state.detail}>{state.detail}</div></div>
                  </div>
                  <div className="col-start-2 flex flex-wrap justify-start gap-2 lg:col-start-auto lg:justify-end">
                    {product.captureMode === 'local-only' ? <Button type="button" size="sm" onClick={() => onLocalImport(product)}><FileJson className="h-4 w-4" />导入</Button> : <Button type="button" size="sm" onClick={() => void onCapture(product)} disabled={busy}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{busy ? '执行中' : '抓取'}</Button>}
                    <Button type="button" variant="secondary" size="sm" onClick={() => setExpandedProductId(expanded ? '' : product.id)}>{expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{expanded ? '收起' : '详情'}</Button>
                  </div>
                </div>
                {expanded && (
                  <div id={`product-detail-${product.id}`} className="border-t border-white/70 bg-white/48 p-2 sm:p-3">
                    <ProductMonitorCard
                      product={product}
                      onToggle={onToggle}
                      onSchedule={onSchedule}
                      onMediaPreference={onMediaPreference}
                      onSaveSkuMonitorPrice={onSaveSkuMonitorPrice}
                      onCapture={onCapture}
                      onRetryBuyerShows={onRetryBuyerShows}
                      onLocalImport={onLocalImport}
                      onDelete={onDelete}
                      busy={busyProductId === product.id}
                      onPreview={setPreview}
                      monitor={monitor}
                    />
                  </div>
                )}
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
      <ImagePreview preview={preview} onClose={() => setPreview(null)} />
    </>
  )
}
