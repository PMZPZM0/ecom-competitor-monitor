import { BellRing, CalendarClock, Check, CircleAlert, CircleCheck, Coins, Copy, Download, ExternalLink, Images, LoaderCircle, PauseCircle, PlayCircle, ReceiptText, RotateCw, Save, ShieldCheck, TimerReset, Trash2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import { downloadFile } from '../../lib/download'
import { currency, timeAgo } from '../../lib/utils'
import { normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { Overview, Product, Snapshot } from '../../types/domain'
import { BuyerShowDialog, ImageThumb, ShopLogo, VideoLink, type Preview } from './productDisplay'
import { DiscountDetailDialog } from './DiscountDetailDialog'
import { PriceVerificationDialog } from './PriceVerificationDialog'
import { formatProtectionCountdown } from './captureProtection'
import { scheduleInputParts } from './productSchedule'
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
  publicPriceLabelForSku,
  priceLayersForSku,
  productDetailImages,
  productImages,
  productItemId,
  productModel,
  productShopName,
  productTitle,
  productVideos,
  verifiedPriceChannel,
  type SkuPrice,
} from './productDisplayUtils'

const SkuPriceTrend = lazy(() => import('./SkuPriceTrend').then((module) => ({ default: module.SkuPriceTrend })))

type Props = {
  product: Product
  monitor: Overview['monitor']
  onToggle: (product: Product) => Promise<void>
  onToggleGlobal: () => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onCapture: (product: Product) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onDelete: (product: Product) => Promise<void>
  busy?: boolean
  onPreview: (preview: Preview) => void
  compactContext?: boolean
  captureProtectionUntil?: string | null
}

type OperationStatus = {
  key: string
  tone: 'progress' | 'success' | 'error'
  message: string
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
        {timeAgo(snapshot?.capturedAt || product.createdAt)}
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
    <div className="min-w-0 self-start bg-slate-50/70 p-3">
      {showTrend && (
        <Suspense fallback={<div className="mb-3 h-80 animate-pulse rounded-md bg-slate-100" />}>
          <SkuPriceTrend snapshots={snapshots} product={product} />
        </Suspense>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(350px,1fr))] gap-2.5">
        {skuPrices.map((sku) => {
          const allLayers = priceLayersForSku(sku)
          const originalLayer = allLayers.find((layer) => layer.kind === 'original' || layer.label === '标价')
          const priceLayers = priceLayersForSku(sku, { includeOriginal: false })
          const normalVerified = verifiedPriceChannel(sku, 'normal')
          const normalPrice = normalVerified ? normalPriceForSku(sku) : null
          const accountBenefit = accountBenefitForSku(sku, product.accountType || 'normal')
          const coinBenefit = coinBenefitForSku(sku)
          const coinPrice = coinPriceForSku(sku)
          const coinPriceLabel = anonymous ? '淘金币需登录' : coinPrice ? '淘金币价' : coinBenefit.available ? '淘金币抵扣' : '无淘金币'
          const primaryLabel = !normalVerified ? '价格未验证' : anonymous ? '匿名公开价' : publicPriceLabelForSku(sku)
          const primaryClass = !normalVerified || anonymous ? { label: 'text-slate-500', value: 'text-slate-700' } : primaryPriceClass(primaryLabel)
          const seenPrices = new Set([
            ...(normalPrice != null ? [`${publicPriceLabelForSku(sku)}:${normalPrice.toFixed(2)}`] : []),
            ...(accountBenefit.price ? [`${accountBenefit.label}:${accountBenefit.price.toFixed(2)}`] : []),
            ...(coinPrice ? [`淘金币价:${coinPrice.toFixed(2)}`] : []),
          ])
          const additionalPrices = normalVerified ? [
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
            if (price.kind === 'discount') return false
            if (price.label === '普通价' || price.label === '淘宝秒杀价' || price.label === '淘金币价') return false
            const key = `${price.label}:${price.value.toFixed(2)}`
            if (seenPrices.has(key)) return false
            seenPrices.add(key)
            return true
          }) : []
          return (
          <div key={sku.skuId} className="rounded-md bg-white p-2.5 shadow-sm transition hover:shadow-md">
            <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2.5">
              <div className="group relative h-14 w-14 overflow-hidden rounded-md border border-slate-100 bg-slate-50">
                <button type="button" className="h-full w-full" onClick={() => sku.image && onPreview({ src: sku.image, title: sku.name })}>
                  {sku.image ? <img src={sku.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : <span className="flex h-full items-center justify-center text-xs text-slate-400">无图</span>}
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
                  {originalLayer && <span className="min-w-0 truncate whitespace-nowrap text-xs text-slate-400">标价 {currency(originalLayer.value)}</span>}
                  <button
                    type="button"
                    className="inline-flex h-6 shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-sky-100 bg-sky-50 px-1.5 text-xs text-sky-700 hover:bg-sky-100"
                    title="查看优惠明细"
                    onClick={() => setDetailSku(sku)}
                  >
                    <ReceiptText className="h-3 w-3" />
                    明细
                  </button>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-slate-400">
                  <span className="min-w-0 truncate">SKU ID {sku.skuId}</span>
                  <button type="button" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-slate-100 hover:text-slate-700" title="复制 SKU ID" onClick={() => copySkuId(sku.skuId)}>
                    {copiedSkuId === sku.skuId ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                  </button>
                  {(typeof sku.quantity === 'number' || sku.quantityText) && (
                    <span className="ml-auto shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500" title="来源于淘宝买家商品页，受账号、收货地区、活动、限购及平台展示上限影响，不等于商家后台仓库库存。">
                      {typeof sku.quantity === 'number' ? `前台可售 ${sku.quantity}（参考）` : `前台状态 ${sku.quantityText}`}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(76px,1fr))] gap-1.5 pt-1">
              <div className="flex min-h-12 min-w-0 flex-col items-start justify-center gap-1 rounded bg-sky-50 px-2 py-1.5">
                <span className={`text-xs font-medium leading-4 ${primaryClass.label}`}>{primaryLabel}</span>
                <span className={`whitespace-nowrap text-sm font-semibold leading-none ${primaryClass.value}`}>{currency(normalPrice)}</span>
              </div>
              <div className={`flex min-h-12 min-w-0 flex-col items-start justify-center gap-1 rounded px-2 py-1.5 ${!anonymous && accountBenefit.available ? product.accountType === 'gift' ? 'bg-orange-50' : product.accountType === 'vip88' ? 'bg-violet-50' : 'bg-rose-50' : 'bg-slate-50'}`}>
                  <span className={`text-xs font-medium leading-4 ${!anonymous && accountBenefit.available ? product.accountType === 'gift' ? 'text-orange-600' : product.accountType === 'vip88' ? 'text-violet-600' : 'text-rose-600' : 'text-slate-400'}`}>
                    {!normalVerified ? '等待明确证据' : anonymous ? `${accountBenefit.label}需登录` : accountBenefit.available ? accountBenefit.label : `未获取${accountBenefit.label}`}
                  </span>
                  {anonymous ? (
                    <span className="whitespace-nowrap text-xs text-slate-400">个性价不可用</span>
                  ) : accountBenefit.price ? (
                    <span className={`whitespace-nowrap text-sm font-semibold leading-none ${product.accountType === 'gift' ? 'text-orange-700' : product.accountType === 'vip88' ? 'text-violet-700' : 'text-rose-700'}`}>{currency(accountBenefit.price)}</span>
                  ) : (
                    <span className="whitespace-nowrap text-xs text-slate-400">当前 SKU 无</span>
                  )}
                </div>
              <div className={`flex min-h-12 min-w-0 flex-col items-start justify-center gap-1 rounded px-2 py-1.5 ${!anonymous && coinBenefit.available ? 'bg-amber-50' : 'bg-slate-50'}`}>
                <span className={`text-xs font-medium leading-4 ${!anonymous && coinBenefit.available ? 'text-amber-600' : 'text-slate-400'}`}>{normalVerified ? coinPriceLabel : '等待明确证据'}</span>
                {anonymous ? (
                  <span className="whitespace-nowrap text-xs text-slate-400">个性价不可用</span>
                ) : coinPrice ? (
                  <span className="whitespace-nowrap text-sm font-semibold leading-none text-amber-700">{currency(coinPrice)}</span>
                ) : coinBenefit.discountAmount ? (
                  <span className="whitespace-nowrap text-xs font-semibold leading-none text-amber-700">抵扣 {currency(coinBenefit.discountAmount)}</span>
                ) : (
                  <span className="whitespace-nowrap text-xs text-slate-400">当前 SKU 无</span>
                )}
              </div>
              {additionalPrices.slice(0, 5).map((price) => (
                <div key={`${sku.skuId}-${price.label}-${price.value}`} className={`flex min-h-12 min-w-0 flex-col items-start justify-center gap-1 rounded px-2 py-1.5 ${layerClass(price.kind, price.label)}`}>
                  <span className="text-xs font-medium leading-4">{price.label}</span>
                  <span className="whitespace-nowrap text-sm font-semibold leading-none">{price.kind === 'discount' ? '-' : ''}{currency(price.value)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex h-9 items-center gap-1.5 rounded bg-amber-50 px-2">
              <BellRing className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="shrink-0 text-xs font-medium text-amber-700">监控价</span>
              <input type="number" min="0" step="0.01" value={monitorPriceDrafts[sku.skuId] ?? (product.skuMonitorPrices?.[sku.skuId]?.toString() || '')} onChange={(event) => setMonitorPriceDrafts((current) => ({ ...current, [sku.skuId]: event.target.value }))} placeholder="未设置" className="h-6 min-w-0 flex-1 bg-transparent text-xs text-amber-900 outline-none placeholder:text-amber-500" title="低于此价格时提醒飞书，清空关闭该 SKU 预警" />
              <button type="button" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-amber-700 hover:bg-amber-100 disabled:opacity-60" title="保存 SKU 监控价" onClick={() => saveSkuMonitorPrice(sku.skuId)} disabled={savingMonitorSkuId === sku.skuId}><Save className="h-3.5 w-3.5" /></button>
            </div>
          </div>
          )
        })}
        {skuPrices.length === 0 && <div className="rounded-md border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">暂无 SKU 数据，点击抓取后更新。</div>}
      </div>
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
    <Button type="button" onClick={onCapture} disabled={busy || protectionRemaining > 0} className="shadow-sm" title={protectionRemaining > 0 ? '本软件设置的采集频率保护倒计时，不代表淘宝账号触发风控。' : '抓取当前商品'}>
      {protectionRemaining > 0 ? <TimerReset className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
      {busy ? '抓取中' : protectionRemaining > 0 ? `采集保护 ${formatProtectionCountdown(protectionRemaining)}` : '抓取'}
    </Button>
  )
}

export function ProductMonitorCard({ product, monitor, onToggle, onToggleGlobal, onSchedule, onCapture, onRetryBuyerShows, onDelete, busy, onPreview, compactContext = false, captureProtectionUntil }: Props) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [trendVisible, setTrendVisible] = useState(false)
  const [copiedTitle, setCopiedTitle] = useState(false)
  const [copiedItemId, setCopiedItemId] = useState(false)
  const [copiedProductUrl, setCopiedProductUrl] = useState(false)
  const [openingProduct, setOpeningProduct] = useState(false)
  const [syncingFeishu, setSyncingFeishu] = useState(false)
  const [togglingMonitor, setTogglingMonitor] = useState(false)
  const [togglingGlobalMonitor, setTogglingGlobalMonitor] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [buyerShowOpen, setBuyerShowOpen] = useState(false)
  const [priceVerificationOpen, setPriceVerificationOpen] = useState(false)
  const [retryingBuyerShows, setRetryingBuyerShows] = useState(false)
  const [operation, setOperation] = useState<OperationStatus | null>(null)
  const operationTimerRef = useRef<number | null>(null)
  const [scheduleModeDraft, setScheduleModeDraft] = useState<NonNullable<Product['monitorScheduleMode']>>(product.monitorScheduleMode === 'once' ? 'once' : 'interval')
  const [scheduleDraft, setScheduleDraft] = useState(String(product.monitorIntervalMinutes ?? monitor.intervalMinutes))
  const initialIntervalMinutes = product.monitorIntervalMinutes ?? monitor.intervalMinutes
  const [scheduleDateDraft, setScheduleDateDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).date)
  const [scheduleTimeDraft, setScheduleTimeDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).time)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const { primary, gallery } = productImages(product)
  const detailImages = productDetailImages(product)
  const videos = productVideos(product)
  const buyerShowCapture = product.lastSnapshot?.buyerShowCapture
  const currentBuyerShows = (product.lastSnapshot?.buyerShows || []).filter((item) => item.text || item.images?.length || item.videoUrls?.length)
  const cachedBuyerShows = product.lastSnapshot?.buyerShowCachedItems || []
  const usingBuyerShowCache = (buyerShowCapture?.status === 'failed' || buyerShowCapture?.status === 'skipped') && currentBuyerShows.length === 0 && cachedBuyerShows.length > 0
  const buyerShows = (usingBuyerShowCache ? product.lastSnapshot?.buyerShowCachedItems || [] : currentBuyerShows).filter((item) => item.text || item.images?.length || item.videoUrls?.length)
  const buyerShowStatusText = usingBuyerShowCache
    ? buyerShowCapture?.status === 'skipped' ? '本次按设置跳过，展示上次成功缓存' : '本次抓取失败，展示上次成功缓存'
    : buyerShowCapture?.status === 'complete' ? '本次完整抓取'
      : buyerShowCapture?.status === 'partial' ? `${buyerShowCapture.pageCount <= 1 ? '本次仅抓到评价首屏' : '本次部分抓取'} · ${buyerShowCapture.mediaCount} 个媒体`
        : buyerShowCapture?.status === 'confirmed-empty' ? '本次确认无买家秀'
          : buyerShowCapture?.status === 'failed' ? `本次买家秀未获取 · ${buyerShowCapture.failureCode || '未知原因'}`
            : buyerShowCapture?.status === 'skipped' ? '已关闭自动抓取买家秀' : ''
  const skuDisplayImages = Array.from(new Map((product.lastSnapshot?.skuPrices || [])
    .filter((sku) => sku.image)
    .map((sku) => [sku.image as string, { src: sku.image as string, title: sku.name }])).values())
  const title = productTitle(product)
  const shopName = productShopName(product)
  const shopLogo = product.shopLogo || product.lastSnapshot?.shopLogo || ''
  const model = productModel(product)
  const itemId = productItemId(product)
  const coinSkuCount = (product.lastSnapshot?.skuPrices || []).filter((sku) => verifiedPriceChannel(sku, 'coin') && coinBenefitForSku(sku).available).length
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
  }, [product.id, product.lastSnapshot?.capturedAt, trendVisible])

  useEffect(() => {
    const parts = scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, product.monitorIntervalMinutes ?? monitor.intervalMinutes)
    setScheduleModeDraft(product.monitorScheduleMode === 'once' ? 'once' : 'interval')
    setScheduleDraft(String(product.monitorIntervalMinutes ?? monitor.intervalMinutes))
    setScheduleDateDraft(parts.date)
    setScheduleTimeDraft(parts.time)
  }, [product.id, product.monitorScheduleMode, product.monitorIntervalMinutes, product.monitorStartAt, product.nextMonitorAt, monitor.intervalMinutes])

  useEffect(() => () => {
    if (operationTimerRef.current) window.clearTimeout(operationTimerRef.current)
  }, [])

  function showOperation(next: OperationStatus, clearAfter = 0) {
    if (operationTimerRef.current) window.clearTimeout(operationTimerRef.current)
    setOperation(next)
    operationTimerRef.current = clearAfter
      ? window.setTimeout(() => setOperation((current) => current?.key === next.key ? null : current), clearAfter)
      : null
  }

  async function runDownload(key: string, message: string, path: string, filename: string) {
    showOperation({ key, tone: 'progress', message })
    try {
      await downloadFile(path, filename)
      showOperation({ key, tone: 'success', message: '下载已开始，请到浏览器下载列表或系统下载目录查看。' }, 5000)
    } catch (error) {
      showOperation({ key, tone: 'error', message: error instanceof Error ? error.message : '下载失败，请稍后重试。' }, 9000)
    }
  }

  async function captureNow() {
    showOperation({ key: 'capture', tone: 'progress', message: product.captureBuyerShows === false ? '正在抓取价格、SKU 和素材，请保持软件运行。' : '正在抓取价格、SKU、素材和买家秀，请保持软件运行。' })
    try {
      const captured = await onCapture(product)
      const buyerCapture = captured?.lastSnapshot?.buyerShowCapture
      const cachedCount = captured?.lastSnapshot?.buyerShowCachedItems?.length || 0
      const message = buyerCapture?.status === 'skipped'
        ? '价格与素材已更新；已按商品设置跳过买家秀。'
        : buyerCapture?.status === 'failed'
        ? cachedCount > 0
          ? `价格与素材已更新；买家秀本次失败，继续展示 ${cachedCount} 条历史成功数据。`
          : `价格与素材已更新；买家秀本次未获取（${buyerCapture.failureCode || '未知原因'}）。`
        : `抓取完成，价格、素材和 ${captured?.lastSnapshot?.buyerShows?.length || 0} 条买家秀已更新。`
      showOperation({ key: 'capture', tone: buyerCapture?.status === 'failed' ? 'error' : 'success', message }, buyerCapture?.status === 'failed' ? 9000 : 5000)
    } catch (error) {
      showOperation({ key: 'capture', tone: 'error', message: error instanceof Error ? error.message : '抓取失败，请检查账号状态。' }, 9000)
    }
  }

  async function retryBuyerShows() {
    setRetryingBuyerShows(true)
    showOperation({ key: 'buyer-show-retry', tone: 'progress', message: '正在仅重试买家秀，价格、SKU 和素材保持不变...' })
    try {
      const updated = await onRetryBuyerShows(product)
      const capture = updated.lastSnapshot?.buyerShowCapture
      const count = updated.lastSnapshot?.buyerShows?.length || updated.lastSnapshot?.buyerShowCachedItems?.length || 0
      showOperation({
        key: 'buyer-show-retry',
        tone: capture?.status === 'failed' ? 'error' : 'success',
        message: capture?.status === 'failed'
          ? `买家秀重试仍未获取（${capture.failureCode || '未知原因'}），价格与素材未改动。`
          : `买家秀重试完成，现有 ${count} 条有效数据；价格与素材未重新抓取。`,
      }, capture?.status === 'failed' ? 9000 : 5000)
    } catch (error) {
      showOperation({ key: 'buyer-show-retry', tone: 'error', message: error instanceof Error ? error.message : '买家秀重试失败。' }, 9000)
    } finally {
      setRetryingBuyerShows(false)
    }
  }

  async function toggleMonitoring() {
    setTogglingMonitor(true)
    showOperation({ key: 'monitor', tone: 'progress', message: product.enabled ? '正在暂停本商品自动监控...' : '正在启用本商品自动监控...' })
    try {
      await onToggle(product)
      showOperation({
        key: 'monitor',
        tone: 'success',
        message: product.enabled
          ? '本商品自动监控已暂停；定时计划仍会保留。'
          : monitor.running
            ? '本商品自动监控已启用，将按保存的计划执行。'
            : '本商品已启用；全局自动监控仍暂停，开启后才会执行。',
      }, 5000)
    } catch (error) {
      showOperation({ key: 'monitor', tone: 'error', message: error instanceof Error ? error.message : '监控状态更新失败。' }, 9000)
    } finally {
      setTogglingMonitor(false)
    }
  }

  async function enableGlobalMonitoring() {
    if (monitor.running) return
    setTogglingGlobalMonitor(true)
    showOperation({ key: 'global-monitor', tone: 'progress', message: '正在开启全局自动监控...' })
    try {
      await onToggleGlobal()
      showOperation({
        key: 'global-monitor',
        tone: 'success',
        message: product.enabled
          ? '全局自动监控已开启，本商品计划已开始执行。'
          : '全局自动监控已开启；本商品仍处于暂停，启用本商品后才会执行。',
      }, 7000)
    } catch (error) {
      showOperation({ key: 'global-monitor', tone: 'error', message: error instanceof Error ? error.message : '开启全局自动监控失败。' }, 9000)
    } finally {
      setTogglingGlobalMonitor(false)
    }
  }

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
    showOperation({ key: 'feishu', tone: 'progress', message: '正在把当前商品的全部 SKU 价格同步到飞书...' })
    try {
      await api.syncProductToFeishu(product.id)
      showOperation({ key: 'feishu', tone: 'success', message: '飞书同步完成，机器人和价格文档已更新。' }, 5000)
    } catch (error) {
      showOperation({ key: 'feishu', tone: 'error', message: error instanceof Error ? error.message : '飞书同步失败。' }, 9000)
    } finally {
      setSyncingFeishu(false)
    }
  }

  async function saveSchedule() {
    const intervalMinutes = Number(scheduleDraft)
    if (scheduleModeDraft === 'interval' && (!Number.isInteger(intervalMinutes) || intervalMinutes < 30 || intervalMinutes > 1440)) {
      window.alert('单品定时监控间隔必须是 30 至 1440 分钟的整数。')
      return
    }
    const monitorStart = new Date(`${scheduleDateDraft}T${scheduleTimeDraft}:00`)
    if (scheduleModeDraft === 'once' && (!scheduleDateDraft || !scheduleTimeDraft || Number.isNaN(monitorStart.getTime()))) {
      window.alert('请选择有效的监控日期和抓取时间。')
      return
    }
    if (scheduleModeDraft === 'once' && monitorStart.getTime() <= Date.now()) {
      window.alert('单次定时必须选择未来时间。')
      return
    }
    setSavingSchedule(true)
    showOperation({ key: 'schedule', tone: 'progress', message: '正在保存定时监控计划...' })
    try {
      await onSchedule(product, scheduleModeDraft, intervalMinutes, scheduleModeDraft === 'once' ? monitorStart.toISOString() : null)
      const blockers = [!monitor.running ? '开启全局自动监控' : '', !product.enabled ? '启用本商品' : ''].filter(Boolean)
      showOperation({
        key: 'schedule',
        tone: 'success',
        message: blockers.length
          ? `本商品抓取计划已保存；还需${blockers.join('、')}后才会执行。`
          : '本商品抓取计划已保存并生效。',
      }, 7000)
    } catch (error) {
      showOperation({ key: 'schedule', tone: 'error', message: error instanceof Error ? error.message : '保存单品定时监控失败。' }, 9000)
    } finally {
      setSavingSchedule(false)
    }
  }

  return (
    <article
      ref={cardRef}
      className={`product-monitor-card relative overflow-hidden rounded-md border bg-white p-4 pt-5 shadow-[0_5px_18px_rgba(15,23,42,0.08)] transition-shadow hover:shadow-[0_7px_22px_rgba(15,23,42,0.11)] ${product.enabled ? 'border-emerald-200' : 'border-slate-300'}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '1000px' }}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${product.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      <div className="flex min-w-0 items-start gap-3">
        {!compactContext && <ShopLogo src={shopLogo} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {!compactContext && <div className="min-w-0 text-sm"><span className="mr-2 text-slate-400">店铺</span><span className="font-semibold text-emerald-700">{shopName}</span></div>}
            {itemId && (
              <div className="inline-flex items-center gap-1.5 text-sm text-slate-600">
                <span className="text-slate-400">商品 ID</span>
                <span className="font-medium tabular-nums text-slate-700">{itemId}</span>
                <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="复制商品 ID" onClick={copyItemId}>
                  {copiedItemId ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
          </div>
          <div className="mt-1.5 flex items-start gap-2">
            <div className="line-clamp-2 text-base font-medium leading-7 text-slate-950">{title}</div>
            <button type="button" className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="复制标题" onClick={copyTitle}>
              {copiedTitle ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {!compactContext && <Badge className="border-sky-100 bg-sky-50 py-1.5 text-sm text-sky-700">型号 {model}</Badge>}
            <Badge className="border-slate-200 bg-slate-50 py-1.5 text-sm text-slate-600">{product.group}</Badge>
            <Badge className="border-emerald-100 bg-emerald-50 py-1.5 text-sm text-emerald-700">主图 1+{gallery.length}</Badge>
            <Badge className="border-violet-100 bg-violet-50 py-1.5 text-sm text-violet-700">SKU 图 {skuDisplayImages.length}</Badge>
            <Badge className="border-amber-100 bg-amber-50 py-1.5 text-sm text-amber-700">{videos.length} 个视频</Badge>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded border border-sky-100 bg-sky-50 px-2.5 text-sm text-sky-700 hover:bg-sky-100 disabled:opacity-60"
              title="使用独立的 Google Chrome 新窗口打开"
              onClick={openProduct}
              disabled={openingProduct}
            >
              <ExternalLink className="h-4 w-4" />
              {openingProduct ? '打开中' : '打开商品'}
            </button>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-sky-100 bg-sky-50 text-sky-700 hover:bg-sky-100"
              title="复制商品链接"
              aria-label="复制商品链接"
              onClick={copyProductUrl}
            >
              {copiedProductUrl ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge className={`px-3 py-1.5 text-sm ${accountTypeClass}`}>{accountTypeLabel}</Badge>
          {(product.accountType || 'normal') === 'normal' && (
            <div className={`inline-flex items-center gap-1.5 text-sm ${coinSkuCount ? 'text-amber-700' : 'text-slate-400'}`} title="根据最近一次抓取的 SKU 淘金币价格和抵扣明细自动判断">
              <Coins className="h-3.5 w-3.5 text-amber-600" />
              {coinSkuCount ? `淘金币 ${coinSkuCount} 个 SKU` : '无淘金币'}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-slate-100 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setBuyerShowOpen(true)} disabled={!buyerShows.length} title={buyerShows.length ? `预览 ${buyerShows.length} 条有效买家秀` : '当前快照暂无有效买家秀，请重新抓取商品'}>
            <Images className="h-4 w-4" />买家秀{buyerShows.length ? `（${buyerShows.length}）` : ''}
          </Button>
          {buyerShowCapture?.status === 'failed' && <Button type="button" variant="secondary" size="sm" onClick={retryBuyerShows} disabled={retryingBuyerShows || operation?.tone === 'progress'} title="只重新抓取买家秀，不改动价格、SKU 和素材"><RotateCw className={`h-4 w-4 ${retryingBuyerShows ? 'animate-spin' : ''}`} />{retryingBuyerShows ? '重试中' : '仅重试买家秀'}</Button>}
          {buyerShows.length > 0 && <Button type="button" variant="secondary" size="sm" onClick={() => runDownload('buyer-shows', '正在整理买家秀图片、视频和文案并生成 ZIP...', downloadBuyerShowsHref(product.id), `${title}_买家秀.zip`)} disabled={operation?.tone === 'progress'}><Download className="h-4 w-4" />{operation?.key === 'buyer-shows' && operation.tone === 'progress' ? '生成中' : '下载买家秀'}</Button>}
          <Button type="button" variant="secondary" size="sm" onClick={() => runDownload('media', '正在整理主图、SKU 图、详情图和视频并生成素材包...', downloadMediaBundleHref(product.id), `${title}_素材包.zip`)} disabled={operation?.tone === 'progress'}>
            <Download className="h-4 w-4" />{operation?.key === 'media' && operation.tone === 'progress' ? '生成中' : '下载素材包'}
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <CaptureButton busy={busy} captureProtectionUntil={captureProtectionUntil} onCapture={captureNow} />
          <Button type="button" variant="secondary" onClick={() => setPriceVerificationOpen(true)} disabled={!product.lastSnapshot?.skuPrices?.length} title="逐 SKU 核对价格证据、展示金额和计算公式"><ShieldCheck className="h-4 w-4" />核对价格</Button>
          <Button type="button" variant="secondary" className={product.enabled ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'} onClick={toggleMonitoring} disabled={togglingMonitor}>
            {product.enabled ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
            {togglingMonitor ? '更新中' : product.enabled ? '暂停本商品' : '启用本商品'}
          </Button>
          <Button type="button" variant="secondary" onClick={syncFeishu} disabled={syncingFeishu || !product.lastSnapshot}>
            <BellRing className="h-4 w-4" />{syncingFeishu ? '同步中' : '同步飞书'}
          </Button>
          <Button type="button" variant="danger" onClick={() => onDelete(product)} title="删除商品" aria-label="删除商品"><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      {(operation || busy) && (
        <div className={`mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs ${(operation?.tone === 'progress' || busy) ? 'bg-blue-50 text-blue-700' : operation?.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`} role="status" aria-live="polite">
          {(operation?.tone === 'progress' || busy) ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : operation?.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}
          <span>{operation?.message || '正在抓取价格、素材和买家秀，请保持软件运行。'}</span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[310px_minmax(0,1fr)] gap-4 max-[1280px]:grid-cols-1">
        <div className="min-w-0 space-y-3">
          <div className="rounded-md bg-slate-50 p-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-slate-700">主图素材</div>
              <div className="text-xs text-slate-400">只显示 800 首图和前 5 张 750 主图</div>
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

      <div className={`-mx-4 -mb-4 mt-4 border-t px-4 pb-4 pt-3 ${!monitor.running ? 'border-amber-200 bg-amber-50/70' : !product.enabled ? 'border-slate-200 bg-slate-50' : 'border-emerald-100 bg-emerald-50/40'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <TimerReset className={`h-4 w-4 shrink-0 ${!monitor.running ? 'text-amber-600' : product.enabled ? 'text-emerald-600' : 'text-slate-400'}`} />
            <span className="text-sm font-semibold text-slate-800">本商品抓取计划</span>
            <Badge className={!monitor.running || !product.enabled ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-100 bg-white text-emerald-700'}>
              {!monitor.running && !product.enabled ? '还差 2 项' : !monitor.running ? '等待全局开启' : !product.enabled ? '等待本商品启用' : '已生效'}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
            <span className="text-xs font-medium text-slate-500">执行条件</span>
            {monitor.running ? (
              <span className="inline-flex items-center gap-1 text-emerald-700"><CircleCheck className="h-4 w-4" />全局已开启</span>
            ) : (
              <Button type="button" size="sm" variant="secondary" className="border-amber-200 bg-white text-amber-800 hover:bg-amber-100" onClick={enableGlobalMonitoring} disabled={togglingGlobalMonitor}>
                {togglingGlobalMonitor ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}{togglingGlobalMonitor ? '开启中' : '开启全局'}
              </Button>
            )}
            {product.enabled ? (
              <span className="inline-flex items-center gap-1 text-emerald-700"><CircleCheck className="h-4 w-4" />本商品已启用</span>
            ) : (
              <Button type="button" size="sm" variant="secondary" className="border-emerald-600 bg-white text-emerald-700 hover:bg-emerald-50" onClick={toggleMonitoring} disabled={togglingMonitor}>
                {togglingMonitor ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}{togglingMonitor ? '启用中' : '启用本商品'}
              </Button>
            )}
            {monitor.running && product.enabled && <span className="text-emerald-700">{product.nextMonitorAt ? `下次抓取：${new Date(product.nextMonitorAt).toLocaleString('zh-CN', { hour12: false })}` : '等待生成下次抓取时间'}</span>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
          <div className="inline-flex h-9 overflow-hidden rounded-md border border-slate-200 bg-white" role="radiogroup" aria-label="抓取计划模式">
            <button type="button" role="radio" aria-checked={scheduleModeDraft === 'once'} onClick={() => setScheduleModeDraft('once')} className={`px-3 text-sm font-medium ${scheduleModeDraft === 'once' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>单次定时</button>
            <button type="button" role="radio" aria-checked={scheduleModeDraft === 'interval'} onClick={() => setScheduleModeDraft('interval')} className={`border-l border-slate-200 px-3 text-sm font-medium ${scheduleModeDraft === 'interval' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>循环监控</button>
          </div>
          {scheduleModeDraft === 'once' ? <>
            <span>执行于</span>
            <label htmlFor={`monitor-date-${product.id}`} className="sr-only">监控日期</label>
            <input id={`monitor-date-${product.id}`} type="date" value={scheduleDateDraft} onChange={(event) => setScheduleDateDraft(event.target.value)} className="h-9 w-[145px] rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-emerald-400" />
            <label htmlFor={`monitor-time-${product.id}`} className="sr-only">详细抓取时间</label>
            <input id={`monitor-time-${product.id}`} type="time" step={60} value={scheduleTimeDraft} onChange={(event) => setScheduleTimeDraft(event.target.value)} className="h-9 w-[105px] rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-emerald-400" />
          </> : <>
            <span>每</span>
            <input type="number" min={30} max={1440} step={1} value={scheduleDraft} onChange={(event) => setScheduleDraft(event.target.value)} className="h-9 w-[88px] rounded-md border border-slate-200 bg-white px-2 text-center text-sm text-slate-800 outline-none focus:border-emerald-400" aria-label="单品循环监控间隔" />
            <span>分钟抓取一次</span>
          </>}
          <button type="button" onClick={saveSchedule} disabled={savingSchedule} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 font-medium text-white hover:bg-emerald-700 disabled:opacity-60" title="保存本商品抓取计划">
            <Save className="h-3.5 w-3.5" />
            {savingSchedule ? '保存中' : '保存计划'}
          </button>
          <span className="text-xs text-slate-500">{scheduleModeDraft === 'once' ? '执行完成后自动暂停本商品。' : '只按当前分钟周期循环，不读取日期时间。'}</span>
        </div>
      </div>

      {buyerShowOpen && <BuyerShowDialog title={title} items={buyerShows} statusText={buyerShowStatusText} onClose={() => setBuyerShowOpen(false)} retryBusy={retryingBuyerShows} onRetry={retryBuyerShows} downloadBusy={operation?.tone === 'progress' && operation.key.startsWith('buyer-show') && operation.key !== 'buyer-show-retry'} downloadMessage={operation?.key.startsWith('buyer-show') ? operation.message : ''} onDownload={() => runDownload('buyer-shows', '正在整理全部买家秀并生成 ZIP...', downloadBuyerShowsHref(product.id), `${title}_买家秀.zip`)} onDownloadItem={(item) => runDownload(`buyer-show-item:${item.id}`, '正在整理这条买家秀并生成 ZIP...', downloadBuyerShowItemHref(product.id, item.id), `${title}_买家秀.zip`)} />}
      {priceVerificationOpen && <PriceVerificationDialog product={product} onClose={() => setPriceVerificationOpen(false)} />}
    </article>
  )
}
