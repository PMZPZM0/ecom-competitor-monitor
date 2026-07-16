import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import type { AuthSession, Overview, Product } from '../../types/domain'
import { ImagePreview, type Preview } from './productDisplay'
import { ProductMonitorCard } from './ProductMonitorCard'
import { productSortOptions, sortProducts, type ProductSortKey } from './productSort'
import { productCaptureProtectionUntil } from './captureProtection'

type Props = {
  products: Product[]
  totalProducts?: number
  onToggle: (product: Product) => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onMediaPreference: (product: Product, captureMediaAssets: boolean) => Promise<void>
  onSaveSkuMonitorPrice: (product: Product, skuId: string, value: number | null) => Promise<void>
  onCapture: (product: Product) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onDelete: (product: Product) => Promise<void>
  busyProductId?: string
  authSessions: AuthSession[]
  monitor: Overview['monitor']
}

export function ProductTable({ products, totalProducts = products.length, onToggle, onSchedule, onMediaPreference, onSaveSkuMonitorPrice, onCapture, onRetryBuyerShows, onDelete, busyProductId, authSessions, monitor }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [sortKey, setSortKey] = useState<ProductSortKey>('updated-desc')
  const [page, setPage] = useState(1)
  const cappedProducts = useMemo(() => sortProducts(products, sortKey).slice(0, 20), [products, sortKey])
  const totalPages = Math.max(1, Math.ceil(cappedProducts.length / 10))
  const visibleProducts = cappedProducts.slice((page - 1) * 10, page * 10)

  useEffect(() => setPage(1), [sortKey])
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (!preview) return undefined
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  return (
    <>
      <section className="min-h-[420px]">
        <div className="mb-4 flex flex-row items-start justify-between gap-4 border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">商品抓取工作台</h2>
            <div className="mt-1 text-sm text-slate-500">最多显示排序后的 20 个商品，每页 10 个；其余 {Math.max(0, totalProducts - 20)} 个仍保留在“监控分类”。</div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="overview-product-sort">商品排序</label>
            <select id="overview-product-sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as ProductSortKey)} className="h-9 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-emerald-400">
              {productSortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <Badge className="border-sky-100 bg-sky-50 text-sky-700">第 {page} / {totalPages} 页 · {cappedProducts.length} 个</Badge>
          </div>
        </div>
        <div className="space-y-5 bg-slate-100/70 p-3">
          {visibleProducts.map((product) => (
            <ProductMonitorCard
              key={product.id}
              product={product}
              onToggle={onToggle}
              onSchedule={onSchedule}
              onMediaPreference={onMediaPreference}
              onSaveSkuMonitorPrice={onSaveSkuMonitorPrice}
              onCapture={onCapture}
              onRetryBuyerShows={onRetryBuyerShows}
              onDelete={onDelete}
              busy={busyProductId === product.id}
              onPreview={setPreview}
              captureProtectionUntil={productCaptureProtectionUntil(product, authSessions)}
              monitor={monitor}
            />
          ))}
          {visibleProducts.length === 0 && <div className="rounded-md border border-dashed border-slate-200 p-12 text-center text-slate-400">还没有商品，先添加一个天猫商品链接。</div>}
        </div>
        {cappedProducts.length > 10 && (
          <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="上一页"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-xs text-slate-500">第 {page} 页，共 {totalPages} 页</span>
            <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="下一页"><ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
      </section>
      <ImagePreview preview={preview} onClose={() => setPreview(null)} />
    </>
  )
}
