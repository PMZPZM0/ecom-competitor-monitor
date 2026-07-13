import { BellRing, CalendarClock, Check, Coins, Copy, Download, ExternalLink, Images, PauseCircle, PlayCircle, ReceiptText, RotateCw, Save, TimerReset, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import { currency, timeAgo } from '../../lib/utils'
import { normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { Overview, Product, Snapshot } from '../../types/domain'
import { BuyerShowDialog, ImageThumb, ShopLogo, VideoLink, type Preview } from './productDisplay'
import { DiscountDetailDialog } from './DiscountDetailDialog'
import { formatProtectionCountdown } from './captureProtection'
import {
  accountBenefitForSku,
  coinPriceForSku,
  coinBenefitForSku,
  displayPriceLabel,
  downloadBuyerShowItemHref,
  downloadBuyerShowsHref,
  downloadHref,
  downloadMediaBundleHref,
  layerClass,
  normalPriceForSku,
  priceLayersForSku,
  productDetailImages,
  productImages,
  productItemId,
  productModel,
  productShopName,
  productTitle,
  productVideos,
  type SkuPrice,
} from './productDisplayUtils'

const SkuPriceTrend = lazy(() => import('./SkuPriceTrend').then((module) => ({ default: module.SkuPriceTrend })))

function scheduleInputParts(monitorStartAt: string | null | undefined, nextMonitorAt: string | null | undefined, intervalMinutes: number) {
  const fallbackAt = Date.now() + intervalMinutes * 60_000
  const parsed = new Date(monitorStartAt || nextMonitorAt || fallbackAt)
  const value = Number.isNaN(parsed.getTime()) ? new Date(fallbackAt) : parsed
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hours = String(value.getHours()).padStart(2, '0')
  const minutes = String(value.getMinutes()).padStart(2, '0')
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` }
}

type Props = {
  product: Product
  monitor: Overview['monitor']
  onToggle: (product: Product) => Promise<void>
  onSchedule: (product: Product, intervalMinutes: number, monitorStartAt: string) => Promise<void>
  onCapture: (product: Product) => Promise<void>
  onDelete: (product: Product) => Promise<void>
  busy?: boolean
  onPreview: (preview: Preview) => void
  compactContext?: boolean
  captureProtectionUntil?: string | null
}

function primaryPriceClass(label: string) {
  if (label === '礼金价') return { label: 'text-orange-600', value: 'text-orange-700' }
  if (label === '淘金币价') return { label: 'text-amber-600', value: 'text-amber-700' }
  if (label === '88VIP价') return { label: 'text-violet-600', value: 'text-violet-700' }
  return { label: 'text-sky-600', value: 'text-sky-700' }
}

function CaptureStatus({ product }: { product: Product }) {
  const snapshot = product.lastSnapshot
  const anonymous = snapshot?.accessMode === 'anonymous'

  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-slate-700">最近抓取</div>
        <Badge className={product.lastStatus === 'error' ? 'border-red-100 bg-red-50 text-red-700' : anonymous ? 'border-amber-100 bg-amber-50 text-amber-700' : ''}>
          {product.lastStatus === 'ok' ? anonymous ? '匿名公开价' : '正常' : product.lastStatus === 'error' ? '异常' : '待抓取'}
        </Badge>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
        <span>{snapshot?.skuPrices?.length || 0} 个 SKU</span>
        <span>
        {timeAgo(product.updatedAt)}
        {snapshot?.source ? ` · ${snapshot.source === 'browser' ? '浏览器登录态' : '直接请求'}` : ''}
        </span>
      </div>
      {product.lastError && <div className="mt-2 text-xs leading-5 text-red-500">{product.lastError}</div>}
      {anonymous && <div className="mt-2 text-xs leading-5 text-amber-700">本次仅记录公开价格；淘金币、礼金和会员价需登录，匿名结果不触发低价提醒。</div>}
    </div>
  )
}

function SkuPricePanel({ product, snapshots, showTrend, onPreview, onSaveSkuMonitorPrice }: { product: Product; snapshots: Snapshot[]; showTrend: boolean; onPreview: (preview: Preview) => void; onSaveSkuMonitorPrice: (skuId: string, value: number | null) => Promise<void> }) {
  const [copiedSkuId, setCopiedSkuId] = useState('')
  const [copiedSkuNameId, setCopiedSkuNameId] = useState('')
  const [detailSku, setDetailSku] = useState<SkuPrice | null>(null)
  const [monitorPriceDrafts, setMonitorPriceDrafts] = useState<Record<string, string>>({})
  const [savingMonitorSkuId, setSavingMonitorSkuId] = useState('')
  const snapshot = product.lastSnapshot
  const anonymous = snapshot?.accessMode === 'anonymous'
  const skuPrices = snapshot?.skuPrices || []
  const accountTypeLabel = { normal: '惊喜立减价', gift: '礼金价', vip88: '88VIP价' } as const

  async function copySkuId(skuId: string) {
    await navigator.clipboard.writeText(skuId)
    setCopiedSkuId(skuId)
    window.setTimeout(() => setCopiedSkuId(''), 1200)
  }

  async function copySkuName(sku: SkuPrice) {
    await navigator.clipboard.writeText(sku.name)
    setCopiedSkuNameId(sku.skuId)
    window.setTimeout(() => setCopiedSkuNameId(''), 1200)
  }

  async function saveSkuMonitorPrice(skuId: string) {
    const draft = monitorPriceDrafts[skuId] ?? (product.skuMonitorPrices?.[skuId]?.toString() || '')
    const value = draft.trim() ? Number(draft) : null
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      window.alert('监控价必须大于 0，或清空关闭该 SKU 预警。')
      return
    }
    setSavingMonitorSkuId(skuId)
    try {
      await onSaveSkuMonitorPrice(skuId, value)
    } finally {
      setSavingMonitorSkuId('')
    }
  }

  return (
    <div className="min-w-0 self-start rounded-md bg-slate-50/80 p-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2.5">
        {skuPrices.map((sku) => {
          const allLayers = priceLayersForSku(sku)
          const originalLayer = allLayers.find((layer) => layer.kind === 'original' || layer.label === '标价')
          const priceLayers = priceLayersForSku(sku, { includeOriginal: false })
          const normalPrice = normalPriceForSku(sku)
          const accountBenefit = accountBenefitForSku(sku, product.accountType || 'normal')
          const coinBenefit = coinBenefitForSku(sku)
          const coinPrice = coinPriceForSku(sku)
          const coinPriceLabel = anonymous ? '淘金币需登录' : coinPrice ? '淘金币价' : coinBenefit.available ? '淘金币抵扣' : '无淘金币'
          const primaryLabel = anonymous ? '匿名公开价' : '普通价'
          const primaryClass = anonymous ? { label: 'text-slate-500', value: 'text-slate-700' } : primaryPriceClass(primaryLabel)
          const seenPrices = new Set([normalPrice.toFixed(2), ...(accountBenefit.price ? [accountBenefit.price.toFixed(2)] : []), ...(coinPrice ? [coinPrice.toFixed(2)] : [])])
          const additionalPrices = [
            ...priceLayers.map((layer) => ({ label: displayPriceLabel(layer.label, product.accountType), value: layer.value, kind: layer.kind })),
            ...(sku.accountPrices || []).map((accountPrice) => {
              // An account snapshot that only contains the list price is not
              // an account benefit and must not be rendered as one.
              const value = accountPrice.accountType === 'gift'
                ? accountPrice.giftPrice
                : accountPrice.accountType === 'vip88'
                  ? accountPrice.vipPrice
                  : accountPrice.surprisePrice
              return value && value > 0
                ? { label: accountTypeLabel[accountPrice.accountType], value, kind: 'price' as const }
                : null
            }).filter((price): price is NonNullable<typeof price> => price !== null),
          ].filter((price) => {
            if (price.label === '普通价' || price.label === '淘金币价') return false
            const key = price.value.toFixed(2)
            if (seenPrices.has(key)) return false
            seenPrices.add(key)
            return true
          })
          return (
          <div key={sku.skuId} className="rounded-md bg-white p-2.5 shadow-sm transition hover:shadow-md">
            <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2.5">
              <div className="group relative h-14 w-14 overflow-hidden rounded-md border border-slate-100 bg-slate-50">
                <button type="button" className="h-full w-full" onClick={() => sku.image && onPreview({ src: sku.image, title: sku.name })}>
                  {sku.image ? <img src={sku.image} alt="" className="h-full w-full object-contain" /> : <span className="flex h-full items-center justify-center text-[10px] text-slate-400">无图</span>}
                </button>
                {sku.image && (
                  <a href={downloadHref(sku.image, `${sku.skuId}_${sku.name}_SKU图`)} className="absolute bottom-0 right-0 inline-flex h-5 w-5 items-center justify-center rounded-tl bg-slate-950/75 text-white hover:bg-emerald-600" title="下载 SKU 图（JPG）">
                    <Download className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex h-[18px] min-w-0 items-center gap-1 text-xs leading-[18px] text-slate-700">
                  <span className="min-w-0 flex-1 truncate" title={sku.name}>{sku.name}</span>
                  <button type="button" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="复制完整 SKU 名称" onClick={() => copySkuName(sku)}>
                    {copiedSkuNameId === sku.skuId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
                <div className="mt-0.5 flex h-5 min-w-0 items-center gap-1">
                  {originalLayer && <span className="min-w-0 truncate whitespace-nowrap text-[11px] text-slate-400">标价 {currency(originalLayer.value)}</span>}
                  <button
                    type="button"
                    className="inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-sky-100 bg-sky-50 px-1 text-[10px] text-sky-700 hover:bg-sky-100"
                    title="查看优惠明细"
                    onClick={() => setDetailSku(sku)}
                  >
                    <ReceiptText className="h-3 w-3" />
                    明细
                  </button>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-slate-400">
                  <span className="min-w-0 truncate">SKU ID {sku.skuId}</span>
                  <button type="button" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-slate-100 hover:text-slate-700" title="复制 SKU ID" onClick={() => copySkuId(sku.skuId)}>
                    {copiedSkuId === sku.skuId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  </button>
                  {(typeof sku.quantity === 'number' || sku.quantityText) && (
                    <span className="ml-auto shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title="来源于淘宝买家商品页，受账号、收货地区、活动、限购及平台展示上限影响，不等于商家后台仓库库存。">
                      {typeof sku.quantity === 'number' ? `前台可售 ${sku.quantity}（参考）` : `前台状态 ${sku.quantityText}`}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-1 pt-1">
              <div className="flex min-h-10 min-w-0 flex-col items-start justify-center gap-0.5 rounded bg-sky-50 px-1.5 py-1">
                <span className={`shrink-0 whitespace-nowrap text-[10px] font-medium ${primaryClass.label}`}>{primaryLabel}</span>
                <span className={`whitespace-nowrap text-sm font-semibold leading-none ${primaryClass.value}`}>{currency(normalPrice)}</span>
              </div>
              <div className={`flex min-h-10 min-w-0 flex-col items-start justify-center gap-0.5 rounded px-1.5 py-1 ${!anonymous && accountBenefit.available ? product.accountType === 'gift' ? 'bg-orange-50' : product.accountType === 'vip88' ? 'bg-violet-50' : 'bg-rose-50' : 'bg-slate-50'}`}>
                  <span className={`shrink-0 whitespace-nowrap text-[10px] font-medium ${!anonymous && accountBenefit.available ? product.accountType === 'gift' ? 'text-orange-600' : product.accountType === 'vip88' ? 'text-violet-600' : 'text-rose-600' : 'text-slate-400'}`}>
                    {anonymous ? `${accountBenefit.label}需登录` : accountBenefit.available ? accountBenefit.label : `未获取${accountBenefit.label}`}
                  </span>
                  {anonymous ? (
                    <span className="whitespace-nowrap text-[10px] text-slate-400">个性价不可用</span>
                  ) : accountBenefit.price ? (
                    <span className={`whitespace-nowrap text-sm font-semibold leading-none ${product.accountType === 'gift' ? 'text-orange-700' : product.accountType === 'vip88' ? 'text-violet-700' : 'text-rose-700'}`}>{currency(accountBenefit.price)}</span>
                  ) : (
                    <span className="whitespace-nowrap text-[10px] text-slate-400">当前 SKU 无</span>
                  )}
                </div>
              <div className={`flex min-h-10 min-w-0 flex-col items-start justify-center gap-0.5 rounded px-1.5 py-1 ${!anonymous && coinBenefit.available ? 'bg-amber-50' : 'bg-slate-50'}`}>
                <span className={`shrink-0 whitespace-nowrap text-[10px] font-medium ${!anonymous && coinBenefit.available ? 'text-amber-600' : 'text-slate-400'}`}>{coinPriceLabel}</span>
                {anonymous ? (
                  <span className="whitespace-nowrap text-[10px] text-slate-400">个性价不可用</span>
                ) : coinPrice ? (
                  <span className="whitespace-nowrap text-sm font-semibold leading-none text-amber-700">{currency(coinPrice)}</span>
                ) : coinBenefit.discountAmount ? (
                  <span className="whitespace-nowrap text-xs font-semibold leading-none text-amber-700">抵扣 {currency(coinBenefit.discountAmount)}</span>
                ) : (
                  <span className="whitespace-nowrap text-[10px] text-slate-400">当前 SKU 无</span>
                )}
              </div>
            </div>
            <div className="mt-1.5 flex h-8 items-center gap-1 rounded bg-amber-50 px-1.5">
              <BellRing className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="shrink-0 text-[10px] font-medium text-amber-700">监控价</span>
              <input type="number" min="0" step="0.01" value={monitorPriceDrafts[sku.skuId] ?? (product.skuMonitorPrices?.[sku.skuId]?.toString() || '')} onChange={(event) => setMonitorPriceDrafts((current) => ({ ...current, [sku.skuId]: event.target.value }))} placeholder="未设置" className="h-6 min-w-0 flex-1 bg-transparent text-xs text-amber-900 outline-none placeholder:text-amber-500" title="低于此价格时提醒飞书，清空关闭该 SKU 预警" />
              <button type="button" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-amber-700 hover:bg-amber-100 disabled:opacity-60" title="保存 SKU 监控价" onClick={() => saveSkuMonitorPrice(sku.skuId)} disabled={savingMonitorSkuId === sku.skuId}><Save className="h-3.5 w-3.5" /></button>
            </div>
            {additionalPrices.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-100 pt-2">
              {additionalPrices.slice(0, 4).map((price) => (
                <div key={`${sku.skuId}-${price.label}-${price.value}`} className={`flex min-h-7 items-center justify-between gap-2 rounded border px-1.5 py-0.5 text-[10px] ${layerClass(price.kind, price.label)}`}>
                  <span className="line-clamp-1">{price.label}</span>
                  <span className="shrink-0 font-semibold">
                    {price.kind === 'discount' ? '-' : ''}
                    {currency(price.value)}
                  </span>
                </div>
              ))}
              </div>
            )}
          </div>
          )
        })}
        {skuPrices.length === 0 && <div className="rounded-md border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">暂无 SKU 数据，点击抓取后更新。</div>}
      </div>
      {showTrend && (
        <Suspense fallback={<div className="mt-3 h-32 animate-pulse rounded-md bg-slate-50" />}>
          <SkuPriceTrend snapshots={snapshots} product={product} />
        </Suspense>
      )}
      <DiscountDetailDialog
        sku={detailSku}
        accountType={product.accountType || 'normal'}
        accessMode={snapshot?.accessMode}
        onClose={() => setDetailSku(null)}
      />
    </div>
  )
}

function CaptureButton({ busy, captureProtectionUntil, onCapture }: { busy?: boolean; captureProtectionUntil?: string | null; onCapture: () => void }) {
  const [clock, setClock] = useState(() => Date.now())
  const protectionRemaining = captureProtectionUntil ? Math.max(0, new Date(captureProtectionUntil).getTime() - clock) : 0

  useEffect(() => {
    if (!captureProtectionUntil || new Date(captureProtectionUntil).getTime() <= Date.now()) return undefined
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [captureProtectionUntil])

  return (
    <Button type="button" variant="secondary" onClick={onCapture} disabled={busy || protectionRemaining > 0} title={protectionRemaining > 0 ? '本软件设置的采集频率保护倒计时，不代表淘宝账号触发风控。' : '抓取当前商品'}>
      {protectionRemaining > 0 ? <TimerReset className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
      {busy ? '抓取中' : protectionRemaining > 0 ? `采集保护 ${formatProtectionCountdown(protectionRemaining)}` : '抓取'}
    </Button>
  )
}

export function ProductMonitorCard({ product, monitor, onToggle, onSchedule, onCapture, onDelete, busy, onPreview, compactContext = false, captureProtectionUntil }: Props) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [trendVisible, setTrendVisible] = useState(false)
  const [copiedTitle, setCopiedTitle] = useState(false)
  const [copiedItemId, setCopiedItemId] = useState(false)
  const [copiedProductUrl, setCopiedProductUrl] = useState(false)
  const [openingProduct, setOpeningProduct] = useState(false)
  const [syncingFeishu, setSyncingFeishu] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [buyerShowOpen, setBuyerShowOpen] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState(String(product.monitorIntervalMinutes ?? monitor.intervalMinutes))
  const initialIntervalMinutes = product.monitorIntervalMinutes ?? monitor.intervalMinutes
  const [scheduleDateDraft, setScheduleDateDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).date)
  const [scheduleTimeDraft, setScheduleTimeDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).time)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const { primary, gallery } = productImages(product)
  const detailImages = productDetailImages(product)
  const videos = productVideos(product)
  const buyerShows = (product.lastSnapshot?.buyerShows || []).filter((item) => item.text || item.images?.length || item.videoUrls?.length)
  const skuDisplayImages = Array.from(new Map((product.lastSnapshot?.skuPrices || [])
    .filter((sku) => sku.image)
    .map((sku) => [sku.image as string, { src: sku.image as string, title: sku.name }])).values())
  const title = productTitle(product)
  const shopName = productShopName(product)
  const shopLogo = product.shopLogo || product.lastSnapshot?.shopLogo || ''
  const model = productModel(product)
  const itemId = productItemId(product)
  const coinSkuCount = (product.lastSnapshot?.skuPrices || []).filter((sku) => coinBenefitForSku(sku).available).length
  const accountTypeLabel = product.accountType === 'gift' ? '礼金账号' : product.accountType === 'vip88' ? '88VIP账号' : '普通账号'
  const accountTypeClass = product.accountType === 'gift'
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : product.accountType === 'vip88'
      ? 'border-violet-200 bg-violet-50 text-violet-700'
      : 'border-sky-200 bg-sky-50 text-sky-700'

  useEffect(() => {
    if (trendVisible) return undefined
    const card = cardRef.current
    if (!card || !('IntersectionObserver' in window)) {
      setTrendVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setTrendVisible(true)
      observer.disconnect()
    }, { rootMargin: '320px 0px' })
    observer.observe(card)
    return () => observer.disconnect()
  }, [trendVisible])

  useEffect(() => {
    if (!trendVisible) return undefined
    let active = true
    api.productSnapshots(product.id)
      .then((history) => {
        if (active) setSnapshots(history)
      })
      .catch(() => {
        if (active) setSnapshots([])
      })
    return () => {
      active = false
    }
  }, [product.id, product.updatedAt, trendVisible])

  useEffect(() => {
    const parts = scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, product.monitorIntervalMinutes ?? monitor.intervalMinutes)
    setScheduleDraft(String(product.monitorIntervalMinutes ?? monitor.intervalMinutes))
    setScheduleDateDraft(parts.date)
    setScheduleTimeDraft(parts.time)
  }, [product.id, product.monitorIntervalMinutes, product.monitorStartAt, product.nextMonitorAt, monitor.intervalMinutes])

  async function copyTitle() {
    await navigator.clipboard.writeText(title)
    setCopiedTitle(true)
    window.setTimeout(() => setCopiedTitle(false), 1200)
  }

  async function copyItemId() {
    if (!itemId) return
    await navigator.clipboard.writeText(itemId)
    setCopiedItemId(true)
    window.setTimeout(() => setCopiedItemId(false), 1200)
  }

  async function copyProductUrl() {
    await navigator.clipboard.writeText(normalizeProductUrlIfPossible(product.url))
    setCopiedProductUrl(true)
    window.setTimeout(() => setCopiedProductUrl(false), 1200)
  }

  async function openProduct() {
    setOpeningProduct(true)
    try {
      await api.openProduct(product.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '打开商品失败')
    } finally {
      setOpeningProduct(false)
    }
  }

  async function saveSkuMonitorPrice(skuId: string, value: number | null) {
    const next = { ...(product.skuMonitorPrices || {}) }
    if (value === null) delete next[skuId]
    else next[skuId] = value
    await api.updateProduct(product.id, { skuMonitorPrices: next, monitorPrice: null })
  }

  async function syncFeishu() {
    setSyncingFeishu(true)
    try {
      await api.syncProductToFeishu(product.id)
      window.alert('当前商品价格已同步到已启用的飞书机器人和飞书文档。')
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '飞书同步失败')
    } finally {
      setSyncingFeishu(false)
    }
  }

  async function saveSchedule() {
    const intervalMinutes = Number(scheduleDraft)
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 30 || intervalMinutes > 1440) {
      window.alert('单品定时监控间隔必须是 30 至 1440 分钟的整数。')
      return
    }
    const monitorStart = new Date(`${scheduleDateDraft}T${scheduleTimeDraft}:00`)
    if (!scheduleDateDraft || !scheduleTimeDraft || Number.isNaN(monitorStart.getTime())) {
      window.alert('请选择有效的监控日期和抓取时间。')
      return
    }
    setSavingSchedule(true)
    try {
      await onSchedule(product, intervalMinutes, monitorStart.toISOString())
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '保存单品定时监控失败')
    } finally {
      setSavingSchedule(false)
    }
  }

  return (
    <article ref={cardRef} className="rounded-md border border-slate-200/80 bg-white p-4 shadow-sm" style={{ contentVisibility: 'auto', containIntrinsicSize: '1000px' }}>
      <div className="flex min-w-0 items-start gap-3">
        {!compactContext && <ShopLogo src={shopLogo} />}
        <div className="min-w-0 flex-1">
          {!compactContext && <div className="line-clamp-1 text-xs font-semibold text-emerald-700">{shopName}</div>}
          <div className="flex items-start gap-2">
            <div className="line-clamp-2 font-medium leading-6 text-slate-950">{title}</div>
            <button type="button" className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="复制标题" onClick={copyTitle}>
              {copiedTitle ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {!compactContext && <Badge className="border-sky-100 bg-sky-50 text-sky-700">型号 {model}</Badge>}
            <Badge className="border-slate-200 bg-slate-50 text-slate-600">{product.group}</Badge>
            <Badge className="border-emerald-100 bg-emerald-50 text-emerald-700">主图 1+{gallery.length}</Badge>
            <Badge className="border-violet-100 bg-violet-50 text-violet-700">SKU 图 {skuDisplayImages.length}</Badge>
            <Badge className="border-amber-100 bg-amber-50 text-amber-700">{videos.length} 个视频</Badge>
            {itemId && (
              <span className="inline-flex h-6 items-center gap-1 rounded border border-violet-100 bg-violet-50 px-2 text-xs text-violet-700">
                商品ID {itemId}
                <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-violet-100" title="复制商品ID" onClick={copyItemId}>
                  {copiedItemId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                </button>
              </span>
            )}
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1 rounded border border-sky-100 bg-sky-50 px-2 text-xs text-sky-700 hover:bg-sky-100 disabled:opacity-60"
              title="使用独立的 Google Chrome 新窗口打开"
              onClick={openProduct}
              disabled={openingProduct}
            >
              <ExternalLink className="h-3 w-3" />
              {openingProduct ? '打开中' : '打开商品'}
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-sky-100 bg-sky-50 text-sky-700 hover:bg-sky-100"
              title="复制商品链接"
              aria-label="复制商品链接"
              onClick={copyProductUrl}
            >
              {copiedProductUrl ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge className={`px-3 py-1.5 ${accountTypeClass}`}>{accountTypeLabel}</Badge>
          {(product.accountType || 'normal') === 'normal' && (
            <div className={`inline-flex items-center gap-1.5 text-[11px] ${coinSkuCount ? 'text-amber-700' : 'text-slate-400'}`} title="根据最近一次抓取的 SKU 淘金币价格和抵扣明细自动判断">
              <Coins className="h-3.5 w-3.5 text-amber-600" />
              {coinSkuCount ? `淘金币 ${coinSkuCount} 个 SKU` : '无淘金币'}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[330px_minmax(0,1fr)] gap-4">
        <div className="min-w-0 space-y-3">
          <div className="rounded-md bg-slate-50 p-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-slate-700">主图素材</div>
              <div className="text-[11px] text-slate-400">只显示 800 首图和前 5 张 750 主图</div>
            </div>
            <ImageThumb src={primary} title={`${title}-800主图第一张`} label="800 主图" className="h-[188px] bg-white" imageClassName="!aspect-auto h-full" onPreview={onPreview} />
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {gallery.map((image, index) => (
                <ImageThumb
                  key={image}
                  src={image}
                  title={`${title}-750主图-${index + 1}`}
                  label={`${index + 1}`}
                  className="h-[58px] bg-white"
                  imageClassName="!aspect-auto h-full"
                  onPreview={onPreview}
                />
              ))}
            </div>
          </div>

          {videos.length > 0 && (
            <div className="rounded-md bg-amber-50/60 p-2">
              <div className="mb-2 text-xs font-medium text-amber-700">视频素材</div>
              <div className="flex flex-wrap gap-2">{videos.map((video, index) => <VideoLink key={video} src={video} index={index} />)}</div>
            </div>
          )}

          <div className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
            下载包自动分类：800 主图、750 主图、SKU 图、详情图 {detailImages.length} 张、视频素材。
          </div>
          <CaptureStatus product={product} />
        </div>

        <SkuPricePanel product={product} snapshots={snapshots} showTrend={trendVisible} onPreview={onPreview} onSaveSkuMonitorPrice={saveSkuMonitorPrice} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <TimerReset className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-xs font-semibold text-slate-700">单品定时监控</span>
          <Badge className={!monitor.running || !product.enabled ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}>
            {!monitor.running ? '全局已暂停' : product.enabled ? '运行中' : '单品已暂停'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500">
          <CalendarClock className="h-4 w-4 text-slate-400" />
          <label htmlFor={`monitor-date-${product.id}`} className="sr-only">监控日期</label>
          <input
            id={`monitor-date-${product.id}`}
            type="date"
            value={scheduleDateDraft}
            onChange={(event) => setScheduleDateDraft(event.target.value)}
            className="h-8 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-emerald-400"
          />
          <label htmlFor={`monitor-time-${product.id}`} className="sr-only">详细抓取时间</label>
          <input
            id={`monitor-time-${product.id}`}
            type="time"
            step={60}
            value={scheduleTimeDraft}
            onChange={(event) => setScheduleTimeDraft(event.target.value)}
            className="h-8 w-[94px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-emerald-400"
          />
          <span>起，每</span>
          <input
            type="number"
            min={30}
            max={1440}
            step={1}
            value={scheduleDraft}
            onChange={(event) => setScheduleDraft(event.target.value)}
            className="h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-center text-xs text-slate-800 outline-none focus:border-emerald-400"
            aria-label="单品定时监控间隔"
          />
          <span>分钟</span>
          <button type="button" onClick={saveSchedule} disabled={savingSchedule} className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60" title="保存单品定时监控">
            <Save className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[168px] text-right text-slate-400">
            {monitor.running && product.enabled && product.nextMonitorAt
              ? `下次 ${new Date(product.nextMonitorAt).toLocaleString('zh-CN', { hour12: false })}`
              : '当前不执行定时抓取'}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CaptureButton busy={busy} captureProtectionUntil={captureProtectionUntil} onCapture={() => onCapture(product)} />
        <Button type="button" variant="ghost" onClick={() => onToggle(product)}>
          {product.enabled ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
          {product.enabled ? '暂停监控' : '启用监控'}
        </Button>
        <Button type="button" variant="secondary" onClick={syncFeishu} disabled={syncingFeishu || !product.lastSnapshot}>
          <BellRing className="h-4 w-4" />{syncingFeishu ? '同步中' : '同步飞书'}
        </Button>
        <Button type="button" variant="danger" onClick={() => onDelete(product)}>
          <Trash2 className="h-4 w-4" />
          删除商品
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setBuyerShowOpen(true)} disabled={!buyerShows.length} title={buyerShows.length ? `预览 ${buyerShows.length} 条有效买家秀` : '当前快照暂无有效买家秀，请重新抓取商品'}>
            <Images className="h-4 w-4" />买家秀预览{buyerShows.length ? `（${buyerShows.length}）` : ''}
          </Button>
          {buyerShows.length > 0 && <a href={downloadBuyerShowsHref(product.id)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 text-sm font-medium text-amber-700 hover:bg-amber-100"><Download className="h-4 w-4" />买家秀下载</a>}
          <a href={downloadMediaBundleHref(product.id)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-emerald-600 bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700">
            <Download className="h-4 w-4" />一键下载素材包
          </a>
        </div>
      </div>
      {buyerShowOpen && <BuyerShowDialog title={title} items={buyerShows} onClose={() => setBuyerShowOpen(false)} onDownload={() => { window.location.href = downloadBuyerShowsHref(product.id) }} onDownloadItem={(item) => { window.location.href = downloadBuyerShowItemHref(product.id, item.id) }} />}
    </article>
  )
}
