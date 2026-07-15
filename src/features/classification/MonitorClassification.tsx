import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight, Download, LoaderCircle, Play, RotateCcw, Search, Trash2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { currency } from '../../lib/utils'
import { downloadFile } from '../../lib/download'
import type { AuthSession, Overview, Product, RunRecord } from '../../types/domain'
import { ImagePreview, ShopLogo, type Preview } from '../products/productDisplay'
import { ProductMonitorCard } from '../products/ProductMonitorCard'
import { downloadBuyerShowsBatchHref, productHasCoinBenefit, productModel, productShopName } from '../products/productDisplayUtils'
import { productSortOptions, sortProducts, type ProductSortKey } from '../products/productSort'
import { productCaptureProtectionUntil } from '../products/captureProtection'

type Props = {
  products: Product[]
  monitor: Overview['monitor']
  onToggle: (product: Product) => Promise<void>
  onToggleGlobal: () => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onCapture: (product: Product) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onDelete: (product: Product) => Promise<void>
  onDeleteBatch: (products: Product[]) => Promise<void>
  onCaptureBatch: (products: Product[]) => Promise<RunRecord | void>
  batchBusy?: boolean
  busyProductId?: string
  authSessions: AuthSession[]
}

type ModelGroup = {
  model: string
  products: Product[]
}

type ShopGroup = {
  shopName: string
  shopLogo?: string
  products: Product[]
  models: ModelGroup[]
}

function numericPrices(products: Product[]) {
  return products.flatMap((product) => product.lastSnapshot?.skuPrices?.map((sku) => sku.price).filter((price) => typeof price === 'number' && price > 0) || [])
}

function rangeLabel(products: Product[]) {
  const prices = numericPrices(products)
  if (!prices.length) return '--'
  return `${currency(Math.min(...prices))} - ${currency(Math.max(...prices))}`
}

function skuCount(products: Product[]) {
  return products.reduce((sum, product) => sum + (product.lastSnapshot?.skuPrices?.length || 0), 0)
}

function buildGroups(products: Product[]): ShopGroup[] {
  const byShop = new Map<string, Product[]>()
  for (const product of products) {
    const shopName = productShopName(product)
    byShop.set(shopName, [...(byShop.get(shopName) || []), product])
  }

  return Array.from(byShop.entries())
    .map(([shopName, shopProducts]) => {
      const byModel = new Map<string, Product[]>()
      for (const product of shopProducts) {
        const model = productModel(product)
        byModel.set(model, [...(byModel.get(model) || []), product])
      }
      return {
        shopName,
        shopLogo: shopProducts.find((product) => product.shopLogo || product.lastSnapshot?.shopLogo)?.shopLogo || shopProducts.find((product) => product.lastSnapshot?.shopLogo)?.lastSnapshot?.shopLogo,
        products: shopProducts,
        models: Array.from(byModel.entries()).map(([model, modelProducts]) => ({ model, products: modelProducts })),
      }
    })
}

type AccountFilter = '' | 'normal' | 'gift' | 'vip88'
type CoinFilter = '' | 'enabled' | 'disabled'

const accountLabels = { normal: '普通账号 普通价', gift: '礼金账号 礼金价', vip88: '88VIP账号 88VIP价' } as const

function searchableText(product: Product) {
  const accountType = product.accountType || 'normal'
  const skuText = product.lastSnapshot?.skuPrices?.flatMap((sku) => [sku.name, sku.skuId]).join(' ') || ''
  return [
    product.name,
    productShopName(product),
    productModel(product),
    product.group,
    product.autoGroup,
    product.itemId,
    product.url,
    accountLabels[accountType],
    productHasCoinBenefit(product) ? '淘金币 金币价 有淘金币' : '无淘金币',
    skuText,
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
}

export function MonitorClassification({ products, monitor, onToggle, onToggleGlobal, onSchedule, onCapture, onRetryBuyerShows, onDelete, onDeleteBatch, onCaptureBatch, batchBusy, busyProductId, authSessions }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [query, setQuery] = useState('')
  const [shopFilter, setShopFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState<AccountFilter>('')
  const [coinFilter, setCoinFilter] = useState<CoinFilter>('')
  const [sortKey, setSortKey] = useState<ProductSortKey>('updated-desc')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchFeedback, setBatchFeedback] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)
  const allGroups = useMemo(() => buildGroups(products), [products])
  const modelOptions = useMemo(() => Array.from(new Set(products.filter((product) => !shopFilter || productShopName(product) === shopFilter).map(productModel))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [products, shopFilter])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
    return products.filter((product) => {
      if (shopFilter && productShopName(product) !== shopFilter) return false
      if (modelFilter && productModel(product) !== modelFilter) return false
      if (accountFilter && (product.accountType || 'normal') !== accountFilter) return false
      if (coinFilter === 'enabled' && !productHasCoinBenefit(product)) return false
      if (coinFilter === 'disabled' && productHasCoinBenefit(product)) return false
      return !normalizedQuery || searchableText(product).includes(normalizedQuery)
    })
  }, [products, query, shopFilter, modelFilter, accountFilter, coinFilter])
  const sortedProducts = useMemo(() => sortProducts(filteredProducts, sortKey), [filteredProducts, sortKey])
  const limitedProducts = useMemo(() => sortedProducts.slice(0, 100), [sortedProducts])
  const totalPages = Math.max(1, Math.ceil(limitedProducts.length / 10))
  const pageProducts = useMemo(() => limitedProducts.slice((page - 1) * 10, page * 10), [limitedProducts, page])
  const groups = useMemo(() => buildGroups(pageProducts), [pageProducts])
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)
  const errorCount = filteredProducts.filter((product) => product.lastStatus === 'error').length
  const visibleIds = useMemo(() => new Set(pageProducts.map((product) => product.id)), [pageProducts])
  const selectedVisibleCount = pageProducts.filter((product) => selectedIds.has(product.id)).length
  const allVisibleSelected = pageProducts.length > 0 && selectedVisibleCount === pageProducts.length
  const hasFilters = Boolean(query || shopFilter || modelFilter || accountFilter || coinFilter)

  function resetFilters() {
    setQuery('')
    setShopFilter('')
    setModelFilter('')
    setAccountFilter('')
    setCoinFilter('')
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
    const selectedProducts = sortedProducts.filter((product) => selectedIds.has(product.id))
    setBatchFeedback({ tone: 'progress', message: `已加入 ${selectedProducts.length} 个商品，正在按队列抓取价格和素材...` })
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
    if (!preview) return undefined
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  useEffect(() => {
    const existingIds = new Set(products.map((product) => product.id))
    setSelectedIds((current) => new Set([...current].filter((id) => existingIds.has(id))))
  }, [products])

  useEffect(() => setPage(1), [query, shopFilter, modelFilter, accountFilter, coinFilter, sortKey])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  return (
    <>
      <Card className="mb-5">
        <CardContent className="space-y-3 pt-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(260px,1.5fr)_minmax(170px,1fr)_minmax(170px,1fr)_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、店铺、型号、SKU、账号、淘金币或商品 ID" aria-label="搜索监控商品" />
            </label>
            <select value={shopFilter} onChange={(event) => chooseShop(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-400" aria-label="按店铺筛选">
              <option value="">全部店铺</option>
              {allGroups.map((group) => <option key={group.shopName} value={group.shopName}>{group.shopName}（{group.products.length}）</option>)}
            </select>
            <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-400" aria-label="按型号筛选">
              <option value="">全部型号</option>
              {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
            <Button type="button" variant="ghost" onClick={resetFilters} disabled={!hasFilters} title="清空全部筛选"><RotateCcw className="h-4 w-4" />重置</Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex h-9 overflow-hidden rounded-md border border-slate-200 bg-white" aria-label="账号类型筛选">
                {([{ value: '', label: '全部账号' }, { value: 'normal', label: '普通' }, { value: 'gift', label: '礼金' }, { value: 'vip88', label: '88VIP' }] as const).map((option) => <button key={option.value || 'all'} type="button" onClick={() => setAccountFilter(option.value)} className={`border-r border-slate-200 px-3 text-xs last:border-r-0 ${accountFilter === option.value ? 'bg-emerald-50 font-medium text-emerald-700' : 'text-slate-600 hover:bg-slate-50'}`}>{option.label}</button>)}
              </div>
              <div className="inline-flex h-9 overflow-hidden rounded-md border border-slate-200 bg-white" aria-label="淘金币筛选">
                {([{ value: '', label: '全部价格' }, { value: 'enabled', label: '有淘金币' }, { value: 'disabled', label: '无淘金币' }] as const).map((option) => <button key={option.value || 'all'} type="button" onClick={() => setCoinFilter(option.value)} className={`border-r border-slate-200 px-3 text-xs last:border-r-0 ${coinFilter === option.value ? 'bg-amber-50 font-medium text-amber-700' : 'text-slate-600 hover:bg-slate-50'}`}>{option.label}</button>)}
              </div>
              <Badge className="border-slate-200 bg-slate-50 text-slate-600">找到 {filteredProducts.length} 个 · 最多展示前 {Math.min(100, filteredProducts.length)} 个</Badge>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500" htmlFor="classification-product-sort">商品排序</label>
              <select id="classification-product-sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as ProductSortKey)} className="h-9 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-emerald-400">
                {productSortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <Button type="button" variant="secondary" size="sm" onClick={toggleVisibleSelection} disabled={!pageProducts.length}>{allVisibleSelected ? '取消本页全选' : '全选本页'}</Button>
              <Button type="button" size="sm" onClick={captureSelected} disabled={!selectedIds.size || selectedIds.size > 20 || batchBusy} title={selectedIds.size > 20 ? '为降低访问风险，单次最多抓取 20 个商品' : '同一账号按顺序抓取，不同账号自动并行'}><Play className="h-4 w-4" />{batchBusy ? '队列抓取中' : selectedIds.size > 20 ? '最多选择 20 个' : `批量抓取（${selectedIds.size}）`}</Button>
              <Button type="button" variant="secondary" size="sm" onClick={downloadSelectedBuyerShows} disabled={!selectedIds.size || batchFeedback?.tone === 'progress'} title="下载选中商品的买家秀 ZIP"><Download className="h-4 w-4" />{batchFeedback?.tone === 'progress' ? '任务处理中' : `批量下载买家秀（${selectedIds.size}）`}</Button>
              <Button type="button" variant="danger" size="sm" onClick={deleteSelected} disabled={!selectedIds.size}><Trash2 className="h-4 w-4" />批量删除（{selectedIds.size}）</Button>
            </div>
          </div>
          {batchFeedback && <div className={`mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs ${batchFeedback.tone === 'progress' ? 'bg-sky-50 text-sky-700' : batchFeedback.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`} role="status" aria-live="polite">{batchFeedback.tone === 'progress' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : batchFeedback.tone === 'success' ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}<span>{batchFeedback.message}</span></div>}
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>分类索引</CardTitle>
              <div className="mt-1 text-sm text-slate-500">{groups.length} 个店铺 · {totalModels} 个型号</div>
            </CardHeader>
            <CardContent className="space-y-2">
              <button
                type="button"
                onClick={() => chooseShop('')}
                className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm ${shopFilter ? 'border-slate-200 bg-white text-slate-600' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}
              >
                <span>全部店铺</span>
                <span>{products.length}</span>
              </button>
              {allGroups.map((group) => (
                <button
                  key={group.shopName}
                  type="button"
                  onClick={() => chooseShop(group.shopName)}
                  className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                    shopFilter === group.shopName ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <ShopLogo src={group.shopLogo} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 font-medium">{group.shopName}</span>
                    <span className="text-xs text-slate-400">{group.products.length} 商品 · {group.models.length} 型号</span>
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>监控概况</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2">
                <span className="text-slate-500">启用商品</span>
                <span className="font-semibold text-slate-950">{filteredProducts.filter((product) => product.enabled).length}</span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2">
                <span className="text-slate-500">SKU 总数</span>
                <span className="font-semibold text-slate-950">{skuCount(filteredProducts)}</span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-red-50 px-3 py-2">
                <span className="inline-flex items-center gap-1 text-red-600">
                  <AlertTriangle className="h-4 w-4" />
                  异常
                </span>
                <span className="font-semibold text-red-700">{errorCount}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-8">
          {groups.map((shop) => (
            <section key={shop.shopName}>
              <div className="mb-4 flex flex-row items-center justify-between gap-4 border-b border-slate-200 pb-3">
                <div className="flex min-w-0 items-start gap-3">
                  <ShopLogo src={shop.shopLogo} />
                  <div className="min-w-0">
                    <h2 className="line-clamp-1 text-base font-semibold text-slate-950">{shop.shopName}</h2>
                    <div className="mt-1 text-xs text-slate-500">{shop.products.length} 个商品 · {shop.models.length} 个型号 · {skuCount(shop.products)} 个 SKU</div>
                  </div>
                </div>
              </div>
              <div className="space-y-6">
                {shop.models.map((modelGroup) => (
                  <div key={`${shop.shopName}-${modelGroup.model}`}>
                    <div className="mb-3 flex items-center justify-between gap-4 px-1">
                      <div>
                        <div className="font-semibold text-slate-950">{modelGroup.model}</div>
                        <div className="mt-1 text-xs text-slate-400">{modelGroup.products.length} 商品 · {skuCount(modelGroup.products)} SKU</div>
                      </div>
                      <div className="text-xs font-semibold text-emerald-700">{rangeLabel(modelGroup.products)}</div>
                    </div>
                    <div className="space-y-4 bg-slate-100/70 p-3">
                      {modelGroup.products.map((product) => (
                        <div key={product.id} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2">
                          <label className="mt-4 flex h-6 w-6 cursor-pointer items-center justify-center" title="选择商品">
                            <input type="checkbox" checked={selectedIds.has(product.id)} onChange={() => toggleProductSelection(product.id)} className="h-4 w-4 accent-emerald-600" aria-label={`选择 ${product.name}`} />
                          </label>
                          <ProductMonitorCard
                            product={product}
                            onToggle={onToggle}
                            onToggleGlobal={onToggleGlobal}
                            onSchedule={onSchedule}
                            onCapture={onCapture}
                            onRetryBuyerShows={onRetryBuyerShows}
                            onDelete={onDelete}
                            busy={busyProductId === product.id}
                            onPreview={setPreview}
                            captureProtectionUntil={productCaptureProtectionUntil(product, authSessions)}
                            monitor={monitor}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {products.length === 0 && <div className="rounded-md border border-dashed border-slate-200 bg-white p-12 text-center text-slate-400">还没有商品，先到“监控总览”添加竞品。</div>}
          {products.length > 0 && filteredProducts.length === 0 && <div className="rounded-md border border-dashed border-slate-200 bg-white p-12 text-center text-slate-500"><div className="font-medium text-slate-700">没有匹配的监控商品</div><button type="button" onClick={resetFilters} className="mt-2 text-sm text-emerald-700 hover:text-emerald-800">清空筛选条件</button></div>}
          {limitedProducts.length > 10 && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
              <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="上一页"><ChevronLeft className="h-4 w-4" /></button>
              <span className="text-xs text-slate-500">第 {page} / {totalPages} 页 · 本页 {pageProducts.length} 个</span>
              <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="下一页"><ChevronRight className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      </div>
      <ImagePreview preview={preview} onClose={() => setPreview(null)} />
    </>
  )
}
