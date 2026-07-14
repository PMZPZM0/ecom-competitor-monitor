import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock3, LoaderCircle, PauseCircle, RotateCw, Search } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import type { AuthSession, Overview, Product } from '../../types/domain'
import { formatProtectionCountdown, productCaptureProtectionUntil } from '../products/captureProtection'
import { productImages, productItemId, productModel, productShopName, productTitle } from '../products/productDisplayUtils'
import { MonitorScheduleDialog } from './MonitorScheduleDialog'

type Props = {
  products: Product[]
  monitor: Overview['monitor']
  authSessions: AuthSession[]
  busyProductId?: string
  batchBusy?: boolean
  onCapture: (product: Product) => Promise<Product | void>
  onCaptureBatch: (products: Product[]) => Promise<void>
  onPauseBatch: (products: Product[]) => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onToggle: (product: Product) => Promise<void>
}

function accountLabel(product: Product) {
  if (product.accountType === 'gift') return '礼金账号'
  if (product.accountType === 'vip88') return '88VIP账号'
  return '普通账号'
}

function queueTime(product: Product) {
  const parsed = Date.parse(product.nextMonitorAt || '')
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function scheduleStatus(product: Product, monitor: Overview['monitor'], now: number) {
  if (!monitor.running) return { label: '等待全局开启', className: 'border-amber-200 bg-amber-50 text-amber-700' }
  const nextAt = Date.parse(product.nextMonitorAt || '')
  if (!Number.isFinite(nextAt)) return { label: '等待调度', className: 'border-slate-200 bg-slate-50 text-slate-600' }
  if (nextAt <= now) return { label: '等待执行', className: 'border-sky-200 bg-sky-50 text-sky-700' }
  return { label: '计划中', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
}

export function MonitorQueue({ products, monitor, authSessions, busyProductId, batchBusy, onCapture, onCaptureBatch, onPauseBatch, onSchedule, onToggle }: Props) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [now, setNow] = useState(Date.now())
  const [actionProductId, setActionProductId] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [scheduleProduct, setScheduleProduct] = useState<Product | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const enabledProducts = useMemo(() => products.filter((product) => product.enabled), [products])
  const filteredProducts = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return enabledProducts
      .filter((product) => !keyword || [productTitle(product), productShopName(product), productModel(product), productItemId(product)].some((value) => value.toLowerCase().includes(keyword)))
      .sort((left, right) => queueTime(left) - queueTime(right) || Date.parse(right.lastSnapshot?.capturedAt || right.createdAt) - Date.parse(left.lastSnapshot?.capturedAt || left.createdAt))
  }, [enabledProducts, query])
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / 10))
  const visibleProducts = filteredProducts.slice((page - 1) * 10, page * 10)
  const selectedProducts = filteredProducts.filter((product) => selectedIds.has(product.id))
  const pageFullySelected = visibleProducts.length > 0 && visibleProducts.every((product) => selectedIds.has(product.id))
  const batchWorking = Boolean(batchBusy || actionProductId === 'batch')

  useEffect(() => setPage(1), [query])
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])
  useEffect(() => {
    const enabledIds = new Set(enabledProducts.map((product) => product.id))
    setSelectedIds((current) => new Set([...current].filter((id) => enabledIds.has(id))))
  }, [enabledProducts])

  function togglePageSelection(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      visibleProducts.forEach((product) => checked ? next.add(product.id) : next.delete(product.id))
      return next
    })
  }

  function toggleProductSelection(productId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(productId)
      else next.delete(productId)
      return next
    })
  }

  async function capture(product: Product) {
    setActionProductId(product.id)
    setFeedback(null)
    try {
      await onCapture(product)
      setFeedback({ tone: 'success', message: `“${productTitle(product)}”抓取完成，队列计划已自动更新。` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '立即抓取失败。' })
    } finally {
      setActionProductId('')
    }
  }

  async function remove(product: Product) {
    setActionProductId(product.id)
    setFeedback(null)
    try {
      await onToggle(product)
      setFeedback({ tone: 'success', message: `“${productTitle(product)}”已移出监控队列，商品、历史和计划均保留。` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '移出监控队列失败。' })
    } finally {
      setActionProductId('')
    }
  }

  async function captureSelected() {
    if (!selectedProducts.length) return
    setActionProductId('batch')
    setFeedback({ tone: 'progress', message: `正在按队列顺序抓取 ${selectedProducts.length} 个商品，每组最多 5 个...` })
    try {
      await onCaptureBatch(selectedProducts)
      setFeedback({ tone: 'success', message: `已完成 ${selectedProducts.length} 个队列商品的批量抓取。` })
      setSelectedIds(new Set())
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '批量抓取失败。' })
    } finally {
      setActionProductId('')
    }
  }

  async function pauseSelected() {
    if (!selectedProducts.length) return
    setActionProductId('batch')
    setFeedback({ tone: 'progress', message: `正在将 ${selectedProducts.length} 个商品移出监控队列...` })
    try {
      await onPauseBatch(selectedProducts)
      setFeedback({ tone: 'success', message: `已将 ${selectedProducts.length} 个商品移出队列；商品、历史和计划均保留。` })
      setSelectedIds(new Set())
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '批量移出队列失败。' })
    } finally {
      setActionProductId('')
    }
  }

  async function saveSchedule(product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) {
    await onSchedule(product, mode, intervalMinutes, monitorStartAt)
    setScheduleProduct(null)
    setFeedback({ tone: 'success', message: `“${productTitle(product)}”的抓取计划已保存，并同步到总览和监控分类。` })
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-base font-semibold text-slate-950">已监控商品队列</h2><Badge className="border-sky-100 bg-sky-50 text-sky-700">{enabledProducts.length} 个商品</Badge></div>
          <p className="mt-1 text-sm text-slate-500">只显示已启用商品；可修改定时计划、单品抓取、批量抓取或移出队列。</p>
        </div>
        <label className="relative block w-full max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索商品、店铺、型号或商品 ID" aria-label="搜索监控队列" /></label>
      </div>

      {!monitor.running && <div className="flex items-start gap-2 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><div><span className="font-semibold">全局自动监控已暂停。</span> 队列和每个商品的计划都已保留，点击页面顶部“开启全局自动监控”后继续执行。</div></div>}

      {feedback && <div className={`flex items-center gap-2 px-3 py-2 text-sm ${feedback.tone === 'progress' ? 'bg-blue-50 text-blue-800' : feedback.tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{feedback.tone === 'progress' ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : feedback.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}{feedback.message}</div>}

      {selectedProducts.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-y border-blue-100 bg-blue-50 px-4 py-3"><span className="text-sm font-medium text-blue-900">已选 {selectedProducts.length} 个队列商品</span><div className="flex items-center gap-2"><Button type="button" size="sm" onClick={captureSelected} disabled={batchWorking}><RotateCw className="h-4 w-4" />批量抓取</Button><Button type="button" size="sm" variant="secondary" onClick={pauseSelected} disabled={batchWorking}><PauseCircle className="h-4 w-4" />批量移出</Button></div></div>}

      <div className="overflow-x-auto border-y border-slate-200 bg-white">
        <div className="grid min-w-[780px] grid-cols-[72px_minmax(300px,1.5fr)_140px_210px_250px] items-center gap-3 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-500 max-[1280px]:grid-cols-[64px_minmax(260px,1fr)_180px_230px] max-[1280px]:[&>*:nth-child(3)]:hidden">
          <div className="flex items-center gap-2"><input type="checkbox" checked={pageFullySelected} onChange={(event) => togglePageSelection(event.target.checked)} aria-label="选择本页队列商品" />顺序</div><div>商品</div><div>账号</div><div>执行计划</div><div className="text-right">操作</div>
        </div>
        {visibleProducts.map((product, index) => {
          const { primary } = productImages(product)
          const status = scheduleStatus(product, monitor, now)
          const protectionUntil = productCaptureProtectionUntil(product, authSessions)
          const protectionRemaining = Math.max(0, Date.parse(protectionUntil || '') - now || 0)
          const working = busyProductId === product.id || actionProductId === product.id || batchWorking
          return (
            <div key={product.id} className="grid min-w-[780px] grid-cols-[72px_minmax(300px,1.5fr)_140px_210px_250px] items-center gap-3 border-t border-slate-100 px-4 py-3 first:border-t-0 hover:bg-slate-50/70 max-[1280px]:grid-cols-[64px_minmax(260px,1fr)_180px_230px] max-[1280px]:[&>*:nth-child(3)]:hidden">
              <div className="flex items-center gap-2"><input type="checkbox" checked={selectedIds.has(product.id)} onChange={(event) => toggleProductSelection(product.id, event.target.checked)} aria-label={`选择 ${productTitle(product)}`} /><span className="text-sm font-semibold tabular-nums text-slate-400">{(page - 1) * 10 + index + 1}</span></div>
              <div className="flex min-w-0 items-center gap-3"><div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">{primary ? <img src={primary} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : null}</div><div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-900" title={productTitle(product)}>{productTitle(product)}</div><div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"><span className="truncate">{productShopName(product)}</span><span>型号 {productModel(product)}</span><span className="tabular-nums">ID {productItemId(product) || '未识别'}</span></div><div className="mt-1 text-xs text-slate-400">上次抓取：{product.lastSnapshot?.capturedAt ? new Date(product.lastSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未成功抓取'} · {product.lastSnapshot?.skuPrices?.length || 0} 个 SKU</div></div></div>
              <div><Badge className={product.accountType === 'gift' ? 'border-amber-100 bg-amber-50 text-amber-700' : product.accountType === 'vip88' ? 'border-violet-100 bg-violet-50 text-violet-700' : 'border-sky-100 bg-sky-50 text-sky-700'}>{accountLabel(product)}</Badge></div>
              <div className="min-w-0"><Badge className={status.className}>{status.label}</Badge><div className="mt-1.5 flex items-center gap-1 text-xs text-slate-600"><Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />{monitor.running && product.nextMonitorAt ? new Date(product.nextMonitorAt).toLocaleString('zh-CN', { hour12: false }) : '暂不执行'}</div><div className="mt-1 text-xs text-slate-400">{product.monitorScheduleMode === 'once' ? '单次定时 · 完成后暂停' : `循环监控 · 每 ${product.monitorIntervalMinutes ?? monitor.intervalMinutes} 分钟`}</div></div>
              <div className="flex justify-end gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => setScheduleProduct(product)} disabled={working} title="设置日期、时间和抓取周期"><CalendarClock className="h-4 w-4" />定时</Button><Button type="button" size="sm" onClick={() => capture(product)} disabled={working || protectionRemaining > 0} title={protectionRemaining > 0 ? '本软件设置的采集频率保护，不代表淘宝账号风控' : '立即抓取当前商品'}>{working ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}{working ? '执行中' : protectionRemaining > 0 ? formatProtectionCountdown(protectionRemaining) : '抓取'}</Button><Button type="button" variant="secondary" size="sm" onClick={() => remove(product)} disabled={working} title="移出监控队列，保留定时设置"><PauseCircle className="h-4 w-4" />移出</Button></div>
            </div>
          )
        })}
        {!visibleProducts.length && <div className="px-6 py-16 text-center text-sm text-slate-500">{query ? '没有匹配的已监控商品。' : '当前没有已监控商品，请在监控总览或监控分类中点击“启用本商品”。'}</div>}
      </div>

      {filteredProducts.length > 10 && <div className="flex items-center justify-end gap-2"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="上一页"><ChevronLeft className="h-4 w-4" /></button><span className="text-xs text-slate-500">第 {page} / {totalPages} 页</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40" title="下一页"><ChevronRight className="h-4 w-4" /></button></div>}
      {scheduleProduct && <MonitorScheduleDialog product={scheduleProduct} monitor={monitor} onClose={() => setScheduleProduct(null)} onSave={(mode, intervalMinutes, monitorStartAt) => saveSchedule(scheduleProduct, mode, intervalMinutes, monitorStartAt)} />}
    </section>
  )
}
