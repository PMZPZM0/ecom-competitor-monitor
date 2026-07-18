import { Archive, BellRing, CircleAlert, CircleCheck, Crown, Download, ExternalLink, FileJson, Gift, Images, LoaderCircle, PauseCircle, PlayCircle, ReceiptText, RotateCw, Save, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import { downloadFile } from '../../lib/download'
import { currency, timeAgo } from '../../lib/utils'
import { normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { MonitorChannel, Overview, Product, ProductCaptureOptions, Snapshot } from '../../types/domain'
import { BuyerShowDialog, ImageThumb, VideoLink, type Preview } from './productDisplay'
import { DiscountDetailDialog } from './DiscountDetailDialog'
import { PriceVerificationDialog } from './PriceVerificationDialog'
import { scheduleInputParts } from './productSchedule'
import {
  accountBenefitForSku,
  accountPriceViewForSku,
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
  productImages,
  productItemId,
  productModel,
  productShopName,
  productTitle,
  productVideos,
  skuForAccountView,
  verifiedPriceChannel,
  type SkuPrice,
} from './productDisplayUtils'

const SkuPriceTrend = lazy(() => import('./SkuPriceTrend').then((module) => ({ default: module.SkuPriceTrend })))
const EMPTY_ACCOUNT_CAPTURES: NonNullable<Snapshot['accountCaptures']> = []
const monitorChannelOptions: Array<{ value: MonitorChannel; label: string; accounts: Array<NonNullable<Product['accountType']>> }> = [
  { value: 'lowest', label: '最低已验证价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'normal', label: '普通价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'billion', label: '百亿补贴价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'seckill', label: '淘宝秒杀价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'government', label: '国补价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'surprise', label: '惊喜立减价', accounts: ['normal', 'gift', 'vip88'] },
  { value: 'gift', label: '礼金价', accounts: ['gift', 'vip88'] },
  { value: 'vip88', label: '88VIP价', accounts: ['vip88'] },
  { value: 'coin', label: '淘金币价', accounts: ['normal', 'gift', 'vip88'] },
]

type Props = {
  product: Product
  monitor: Overview['monitor']
  onToggle: (product: Product) => Promise<void>
  onSchedule: (product: Product, mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
  onMediaPreference: (product: Product, captureMediaAssets: boolean) => Promise<void>
  onSaveSkuMonitorPrice: (product: Product, skuId: string, value: number | null, channel?: MonitorChannel) => Promise<void>
  onCapture: (product: Product, options?: ProductCaptureOptions) => Promise<Product | void>
  onRetryBuyerShows: (product: Product) => Promise<Product>
  onLocalImport: (product?: Product) => void
  onDelete: (product: Product) => Promise<void>
  busy?: boolean
  onPreview: (preview: Preview) => void
  compactContext?: boolean
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
  if (label === '百亿补贴价') return { label: 'text-indigo-600', value: 'text-indigo-700' }
  if (label === '淘宝秒杀价') return { label: 'text-fuchsia-600', value: 'text-fuchsia-700' }
  return { label: 'text-sky-600', value: 'text-sky-700' }
}

function CaptureStatus({ product }: { product: Product }) {
  const snapshot = product.lastSnapshot
  const anonymous = snapshot?.accessMode === 'anonymous'

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
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
        {snapshot?.source ? ` · ${snapshot.source === 'browser' ? '浏览器登录态' : snapshot.source === 'local-import' ? '本地数据导入' : '直接请求'}` : ''}
        </span>
      </div>
      {product.lastError && <div className="mt-2 text-xs leading-5 text-red-500">{product.lastError}</div>}
      {snapshot?.browserEvidenceFile
        ? <div className="mt-2 break-all text-xs leading-5 text-emerald-700" title={snapshot.browserEvidenceFile}>浏览器数据已保存并读盘解析：{snapshot.browserEvidenceFile}</div>
        : snapshot?.localImportFile && <div className="mt-2 break-all text-xs leading-5 text-emerald-700" title={snapshot.localImportFile}>本地价格证据已保存：{snapshot.localImportFile}</div>}
      {snapshot?.localImportError && !snapshot.browserEvidenceFile && <div className="mt-2 break-words text-xs leading-5 text-red-500">本地价格证据保存失败：{snapshot.localImportError}</div>}
      {anonymous && <div className="mt-2 text-xs leading-5 text-amber-700">本次仅记录公开价格；淘金币、礼金和会员价需登录，匿名结果不触发低价提醒。</div>}
    </div>
  )
}

function SkuPricePanel({ product, snapshots, showTrend, accountSessionId, accountType, accountName, primaryAccountType, isPrimaryAccountView, onPreview, onSaveSkuMonitorPrice, allowMediaDownload }: { product: Product; snapshots: Snapshot[]; showTrend: boolean; accountSessionId: string; accountType: NonNullable<Product['accountType']>; accountName: string; primaryAccountType: NonNullable<Product['accountType']>; isPrimaryAccountView: boolean; onPreview: (preview: Preview) => void; onSaveSkuMonitorPrice: (skuId: string, value: number | null, channel: MonitorChannel) => Promise<void>; allowMediaDownload: boolean }) {
  const [copiedSkuId, setCopiedSkuId] = useState('')
  const [copiedSkuNameId, setCopiedSkuNameId] = useState('')
  const [detailSku, setDetailSku] = useState<SkuPrice | null>(null)
  const [monitorPriceDrafts, setMonitorPriceDrafts] = useState<Record<string, string>>({})
  const [monitorPriceStatuses, setMonitorPriceStatuses] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const [monitorChannels, setMonitorChannels] = useState<Record<string, MonitorChannel>>({})
  const snapshot = product.lastSnapshot
  const anonymous = snapshot?.accessMode === 'anonymous'
  const skuPrices = (snapshot?.skuPrices || []).flatMap((sku) => (
    accountSessionId && !accountPriceViewForSku(sku, accountSessionId, accountType)
      ? []
      : [skuForAccountView(sku, accountSessionId, accountType)]
  ))

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

  function monitorDraftKey(skuId: string, channel: MonitorChannel) {
    return `${skuId}:${channel}`
  }

  function monitorRuleValue(skuId: string, channel: MonitorChannel) {
    return product.skuMonitorRules?.[skuId]?.[channel] ?? (channel === 'lowest' ? product.skuMonitorPrices?.[skuId] : undefined)
  }

  async function saveSkuMonitorPrice(skuId: string, channel: MonitorChannel) {
    const key = monitorDraftKey(skuId, channel)
    const draft = monitorPriceDrafts[key] ?? (monitorRuleValue(skuId, channel)?.toString() || '')
    const value = draft.trim() ? Number(draft) : null
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      window.alert('监控价必须大于 0，或清空关闭该 SKU 预警。')
      return
    }
    const currentValue = monitorRuleValue(skuId, channel) ?? null
    if (value === currentValue) {
      setMonitorPriceDrafts((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      return
    }
    setMonitorPriceStatuses((current) => ({ ...current, [key]: 'saving' }))
    try {
      await onSaveSkuMonitorPrice(skuId, value, channel)
      setMonitorPriceDrafts((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      setMonitorPriceStatuses((current) => ({ ...current, [key]: 'saved' }))
    } catch (error) {
      setMonitorPriceStatuses((current) => ({ ...current, [key]: 'error' }))
      window.alert(error instanceof Error ? error.message : '监控价保存失败，请重试。')
    }
  }

  function updateMonitorPriceDraft(skuId: string, channel: MonitorChannel, value: string) {
    const key = monitorDraftKey(skuId, channel)
    setMonitorPriceDrafts((current) => ({ ...current, [key]: value }))
    setMonitorPriceStatuses((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  return (
    <div className="min-w-0 self-start">
      {showTrend && (
        <Suspense fallback={<div className="mb-3 h-80 animate-pulse rounded-md bg-slate-100" />}>
          <SkuPriceTrend snapshots={snapshots} product={product} accountSessionId={accountSessionId} accountType={accountType} accountName={accountName} showMonitorThresholds={isPrimaryAccountView} />
        </Suspense>
      )}
      {!isPrimaryAccountView && <div className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">当前为 {accountName} 的历史查看视角，不修改监控规则。切回带“监控”标记的账号视角后可设置监控价。</div>}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))' }}>
        {skuPrices.map((sku) => {
          const allLayers = priceLayersForSku(sku)
          const originalLayer = allLayers.find((layer) => layer.kind === 'original' || layer.label === '标价')
          const priceLayers = priceLayersForSku(sku, { includeOriginal: false })
          const normalVerified = verifiedPriceChannel(sku, 'normal')
          const normalPrice = normalVerified ? normalPriceForSku(sku) : null
          const accountBenefit = accountBenefitForSku(sku, accountType)
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
            ...priceLayers.map((layer) => ({ label: displayPriceLabel(layer.label, accountType), value: layer.value, kind: layer.kind })),
          ].filter((price) => {
            if (price.kind === 'discount') return false
            if (price.label === primaryLabel || price.label === '淘金币价') return false
            if (price.label === '普通价' && (primaryLabel === '淘宝秒杀价' || primaryLabel === '百亿补贴价')) return false
            if (price.label === '国补价' && !verifiedPriceChannel(sku, 'government')) return false
            if (price.label === '惊喜立减价' && !verifiedPriceChannel(sku, 'surprise')) return false
            if (price.label === '礼金价' && !verifiedPriceChannel(sku, 'gift')) return false
            if (price.label === '88VIP价' && !verifiedPriceChannel(sku, 'vip88')) return false
            const key = `${price.label}:${price.value.toFixed(2)}`
            if (seenPrices.has(key)) return false
            seenPrices.add(key)
            return true
          }) : []
          const monitorChannel = monitorChannels[sku.skuId] || 'lowest'
          const monitorKey = monitorDraftKey(sku.skuId, monitorChannel)
          const monitorPriceStatus = monitorPriceStatuses[monitorKey]
          const availableMonitorChannels = monitorChannelOptions.filter((option) => option.accounts.includes(primaryAccountType))
          const stalePrices = Object.entries(sku.stalePrices || {}).filter((entry): entry is [Exclude<MonitorChannel, 'lowest'>, NonNullable<typeof entry[1]>] => Boolean(entry[1]))
          return (
          <div key={sku.skuId} className="rounded-xl border border-slate-200/70 bg-white p-3 shadow-[0_4px_14px_rgba(15,23,42,0.05)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-sky-200 hover:shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
            <div className="grid grid-cols-[58px_minmax(0,1fr)] gap-2.5">
              <div className="group relative h-14 w-14 overflow-hidden rounded-md border border-slate-100 bg-slate-50">
                <button type="button" className="h-full w-full" onClick={() => sku.image && onPreview({ src: sku.image, title: sku.name })}>
                  {sku.image ? <img src={sku.image} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : <span className="flex h-full items-center justify-center text-xs text-slate-400">无图</span>}
                </button>
                {sku.image && allowMediaDownload && (
                  <a href={downloadHref(sku.image, `${sku.skuId}_${sku.name}_SKU图`)} className="absolute bottom-0 right-0 inline-flex h-5 w-5 items-center justify-center rounded-tl bg-slate-950/75 text-white hover:bg-emerald-600" title="下载 SKU 图（JPG）">
                    <Download className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex h-[18px] min-w-0 items-center gap-1 text-xs leading-[18px] text-slate-700">
                  <button type="button" className={`flex min-w-0 flex-1 items-center gap-1.5 text-left transition hover:text-sky-700 ${copiedSkuNameId === sku.skuId ? 'text-emerald-700' : ''}`} title="点击复制完整 SKU 名称" onClick={() => copySkuName(sku)}><span className="min-w-0 flex-1 truncate">{sku.name}</span>{copiedSkuNameId === sku.skuId && <span className="shrink-0 text-[11px]">已复制</span>}</button>
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
                  <button type="button" className={`min-w-0 truncate text-left transition hover:text-sky-700 ${copiedSkuId === sku.skuId ? 'text-emerald-700' : ''}`} title="点击复制 SKU ID" onClick={() => copySkuId(sku.skuId)}>SKU ID {sku.skuId}{copiedSkuId === sku.skuId ? ' · 已复制' : ''}</button>
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
              <div className={`flex min-h-12 min-w-0 flex-col items-start justify-center gap-1 rounded px-2 py-1.5 ${!anonymous && accountBenefit.available ? accountType === 'gift' ? 'bg-orange-50' : accountType === 'vip88' ? 'bg-violet-50' : 'bg-rose-50' : 'bg-slate-50'}`}>
                  <span className={`text-xs font-medium leading-4 ${!anonymous && accountBenefit.available ? accountType === 'gift' ? 'text-orange-600' : accountType === 'vip88' ? 'text-violet-600' : 'text-rose-600' : 'text-slate-400'}`}>
                    {!normalVerified ? '等待明确证据' : anonymous ? `${accountBenefit.label}需登录` : accountBenefit.available ? accountBenefit.label : `未获取${accountBenefit.label}`}
                  </span>
                  {anonymous ? (
                    <span className="whitespace-nowrap text-xs text-slate-400">个性价不可用</span>
                  ) : accountBenefit.price ? (
                    <span className={`whitespace-nowrap text-sm font-semibold leading-none ${accountType === 'gift' ? 'text-orange-700' : accountType === 'vip88' ? 'text-violet-700' : 'text-rose-700'}`}>{currency(accountBenefit.price)}</span>
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
            {stalePrices.length > 0 && <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded bg-slate-100 px-2 py-1.5 text-[11px] text-slate-600" title="这些价格仅用于历史查看，不参与监控或飞书提醒"><Archive className="h-3.5 w-3.5 shrink-0" /><span className="shrink-0 font-medium">上次已验证</span><span className="min-w-0 truncate">{stalePrices.map(([channel, stale]) => `${monitorChannelOptions.find((option) => option.value === channel)?.label || channel} ${currency(stale.value)}`).join(' · ')}</span></div>}
            {isPrimaryAccountView && <div className="mt-2 flex min-h-10 items-center gap-1.5 rounded-md border border-amber-200/80 bg-amber-50 px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
              <BellRing className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <select value={monitorChannel} onChange={(event) => setMonitorChannels((current) => ({ ...current, [sku.skuId]: event.target.value as MonitorChannel }))} className="h-7 w-[112px] shrink-0 border-0 bg-transparent pr-1 text-xs font-medium text-amber-800 outline-none focus:ring-2 focus:ring-amber-300" aria-label={`${sku.name}监控价格口径`}>
                {availableMonitorChannels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <span className="h-5 w-px shrink-0 bg-amber-200" />
              <span className="shrink-0 text-xs text-amber-600">¥</span>
              <input type="number" min="0.01" step="0.01" value={monitorPriceDrafts[monitorKey] ?? (monitorRuleValue(sku.skuId, monitorChannel)?.toString() || '')} onChange={(event) => updateMonitorPriceDraft(sku.skuId, monitorChannel, event.target.value)} onBlur={() => void saveSkuMonitorPrice(sku.skuId, monitorChannel)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} disabled={monitorPriceStatus === 'saving'} placeholder="未设置" className="h-7 min-w-0 flex-1 bg-transparent text-sm font-medium text-amber-950 outline-none placeholder:text-xs placeholder:font-normal placeholder:text-amber-500 disabled:opacity-60" title="只使用本次已验证的所选价格口径判断；离开输入框自动保存，清空后关闭该项预警" />
              <span className={`flex w-14 shrink-0 items-center justify-end gap-1 text-[11px] ${monitorPriceStatus === 'error' ? 'text-red-600' : 'text-amber-700'}`} aria-live="polite">{monitorPriceStatus === 'saving' ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />保存中</> : monitorPriceStatus === 'saved' ? <><CircleCheck className="h-3.5 w-3.5" />已保存</> : monitorPriceStatus === 'error' ? <><CircleAlert className="h-3.5 w-3.5" />失败</> : null}</span>
            </div>}
          </div>
          )
        })}
        {skuPrices.length === 0 && <div className="rounded-md border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">{product.captureMode === 'local-only' ? '暂无 SKU 数据，请导入新的本地文件。' : '暂无 SKU 数据，点击抓取后更新。'}</div>}
      </div>
      <DiscountDetailDialog
        sku={detailSku}
        accountType={accountType}
        accessMode={snapshot?.accessMode}
        onClose={() => setDetailSku(null)}
      />
    </div>
  )
}

function CaptureButton({ busy, onCapture }: { busy?: boolean; onCapture: () => void }) {
  return (
    <Button type="button" onClick={onCapture} disabled={busy} className="h-9 rounded-lg px-3 shadow-sm shadow-blue-200/60 active:translate-y-px" title="抓取当前商品">
      <RotateCw className="h-4 w-4" />
      {busy ? '抓取中' : '抓取'}
    </Button>
  )
}

export function ProductMonitorCard({ product, monitor, onToggle, onSchedule, onMediaPreference, onSaveSkuMonitorPrice: persistSkuMonitorPrice, onCapture, onRetryBuyerShows, onLocalImport, onDelete, busy, onPreview, compactContext = false }: Props) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [trendVisible, setTrendVisible] = useState(false)
  const [copiedItemId, setCopiedItemId] = useState(false)
  const [copiedProductUrl, setCopiedProductUrl] = useState(false)
  const [openingProduct, setOpeningProduct] = useState(false)
  const [syncingFeishu, setSyncingFeishu] = useState(false)
  const [togglingMonitor, setTogglingMonitor] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [savingMediaPreference, setSavingMediaPreference] = useState(false)
  const [buyerShowOpen, setBuyerShowOpen] = useState(false)
  const [priceVerificationOpen, setPriceVerificationOpen] = useState(false)
  const [selectedAccountSessionId, setSelectedAccountSessionId] = useState(() => product.lastSnapshot?.primaryAccountSessionId || product.primaryAccountSessionId || '')
  const [retryingBuyerShows, setRetryingBuyerShows] = useState(false)
  const [operation, setOperation] = useState<OperationStatus | null>(null)
  const operationTimerRef = useRef<number | null>(null)
  const [scheduleModeDraft, setScheduleModeDraft] = useState<NonNullable<Product['monitorScheduleMode']>>(product.monitorScheduleMode === 'once' ? 'once' : 'interval')
  const [scheduleDraft, setScheduleDraft] = useState(String(product.monitorIntervalMinutes ?? monitor.intervalMinutes))
  const initialIntervalMinutes = product.monitorIntervalMinutes ?? monitor.intervalMinutes
  const [scheduleDateDraft, setScheduleDateDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).date)
  const [scheduleTimeDraft, setScheduleTimeDraft] = useState(() => scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialIntervalMinutes).time)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const localOnly = product.captureMode === 'local-only'
  const captureMediaAssets = product.captureMediaAssets === true
  const accountCaptures = product.lastSnapshot?.accountCaptures || EMPTY_ACCOUNT_CAPTURES
  const primaryAccountCapture = accountCaptures.find((capture) => capture.sessionId === product.lastSnapshot?.primaryAccountSessionId)
    || accountCaptures.find((capture) => capture.primary)
    || accountCaptures[0]
  const selectedAccountCapture = accountCaptures.find((capture) => capture.sessionId === selectedAccountSessionId)
    || primaryAccountCapture
  const primaryAccountType = primaryAccountCapture?.accountType || product.lastSnapshot?.primaryAccountType || product.accountType || 'normal'
  const selectedAccountType = selectedAccountCapture?.accountType || primaryAccountType
  const selectedAccountName = selectedAccountCapture?.accountName || (selectedAccountType === 'vip88' ? '88VIP账号' : selectedAccountType === 'gift' ? '礼金账号' : '普通账号')
  const isPrimaryAccountView = !selectedAccountCapture || !primaryAccountCapture || selectedAccountCapture.sessionId === primaryAccountCapture.sessionId
  const { primary, gallery: capturedGallery } = productImages(product)
  const gallery = captureMediaAssets ? capturedGallery : []
  const videos = captureMediaAssets ? productVideos(product) : []
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
  const title = productTitle(product)
  const shopName = productShopName(product)
  const model = productModel(product)
  const itemId = productItemId(product)
  const accountTypeLabel = primaryAccountType === 'gift' ? '礼金账号' : primaryAccountType === 'vip88' ? '88VIP账号' : '普通账号'
  const accountTypeClass = primaryAccountType === 'gift'
    ? 'bg-orange-500 text-white'
    : primaryAccountType === 'vip88'
      ? 'bg-violet-600 text-white'
      : 'bg-sky-600 text-white'

  useEffect(() => {
    const primarySessionId = product.lastSnapshot?.primaryAccountSessionId || product.primaryAccountSessionId || accountCaptures[0]?.sessionId || ''
    setSelectedAccountSessionId((current) => accountCaptures.some((capture) => capture.sessionId === current) ? current : primarySessionId)
  }, [accountCaptures, product.id, product.primaryAccountSessionId, product.lastSnapshot?.capturedAt, product.lastSnapshot?.primaryAccountSessionId])

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
    const captureScope = '价格、800 主图和 SKU 图'
    showOperation({ key: 'capture', tone: 'progress', message: `正在抓取${captureScope}；买家秀和完整素材使用各自独立任务。` })
    try {
      const captured = await onCapture(product)
      if (!captured || captured.lastStatus === 'error' || !captured.lastSnapshot) {
        showOperation({
          key: 'capture',
          tone: 'error',
          message: `本次抓取未保存：${captured?.lastError || '没有返回可验证的价格快照。请检查账号授权和商品页面后重试。'}`,
        }, 9000)
        return
      }
      const capturedSnapshot = captured?.lastSnapshot
      const evidenceMessage = capturedSnapshot?.localImportError
        ? ` 本地价格证据保存失败：${capturedSnapshot.localImportError}`
        : capturedSnapshot?.localImportFile ? ' 本地价格证据已自动保存。' : ''
      const message = `${captureScope}已更新。${evidenceMessage}`
      const hasError = Boolean(capturedSnapshot?.localImportError)
      showOperation({ key: 'capture', tone: hasError ? 'error' : 'success', message }, hasError ? 9000 : 5000)
    } catch (error) {
      showOperation({ key: 'capture', tone: 'error', message: error instanceof Error ? error.message : '抓取失败，请检查账号状态。' }, 9000)
    }
  }

  async function captureMaterials() {
    showOperation({ key: 'materials-capture', tone: 'progress', message: '正在单独抓取 750 主图、详情图和视频素材...' })
    try {
      const captured = await onCapture(product, { captureKind: 'materials' })
      if (!captured?.lastSnapshot || captured.lastStatus === 'error') throw new Error(captured?.lastError || '完整素材抓取失败。')
      showOperation({ key: 'materials-capture', tone: 'success', message: `完整素材已更新：${captured.lastSnapshot.gallery750Images?.length || 0} 张主图、${captured.lastSnapshot.detailImages?.length || 0} 张详情图、${captured.lastSnapshot.videoUrls?.length || 0} 个视频。` }, 6000)
    } catch (error) {
      showOperation({ key: 'materials-capture', tone: 'error', message: error instanceof Error ? error.message : '完整素材抓取失败。' }, 9000)
    }
  }

  async function refreshAccountViews() {
    showOperation({ key: 'account-views', tone: 'progress', message: '正在按账号类型刷新价格视角；主账号失败时不会由其他账号接管。' })
    try {
      const captured = await onCapture(product, { accountMode: 'all', captureKind: 'price' })
      if (!captured?.lastSnapshot || captured.lastStatus === 'error') throw new Error(captured?.lastError || '账号价格视角刷新失败。')
      showOperation({ key: 'account-views', tone: 'success', message: `已刷新 ${captured.lastSnapshot.accountCaptures?.length || 1} 个账号价格视角。` }, 6000)
    } catch (error) {
      showOperation({ key: 'account-views', tone: 'error', message: error instanceof Error ? error.message : '账号价格视角刷新失败。' }, 9000)
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

  async function changeMediaPreference(enabled: boolean) {
    setSavingMediaPreference(true)
    showOperation({ key: 'media-preference', tone: 'progress', message: enabled ? '正在开启完整素材抓取...' : '正在关闭完整素材抓取和下载...' })
    try {
      await onMediaPreference(product, enabled)
      showOperation({
        key: 'media-preference',
        tone: 'success',
        message: enabled ? '完整素材已开启；可使用旁边的刷新按钮单独抓取 750 主图、详情图和视频。' : '完整素材已关闭；价格抓取仍保留 800 主图和 SKU 图。',
      }, 6000)
    } catch (error) {
      showOperation({ key: 'media-preference', tone: 'error', message: error instanceof Error ? error.message : '完整素材设置保存失败。' }, 9000)
    } finally {
      setSavingMediaPreference(false)
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
      await api.openProduct(product.id, selectedAccountCapture?.sessionId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '打开商品失败')
    } finally {
      setOpeningProduct(false)
    }
  }

  async function saveSkuMonitorPrice(skuId: string, value: number | null, channel: MonitorChannel) {
    await persistSkuMonitorPrice(product, skuId, value, channel)
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
      className={`product-monitor-card relative overflow-hidden rounded-xl border bg-white shadow-[0_8px_28px_rgba(15,23,42,0.07)] transition-[border-color,box-shadow] duration-200 hover:shadow-[0_12px_34px_rgba(15,23,42,0.1)] ${localOnly ? 'border-sky-200' : product.enabled ? 'border-emerald-200/90' : 'border-slate-200'}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '1000px' }}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${localOnly ? 'bg-sky-500' : product.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      <header className="px-5 pb-4 pt-2">
        <div className="product-monitor-header-grid min-w-0">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`-ml-5 -mt-2 inline-flex h-8 items-center rounded-br-lg px-3 text-xs font-semibold shadow-sm ${accountTypeClass}`}>{accountTypeLabel} · {localOnly ? '本地价格视角' : '监控来源'}</span>
              {localOnly && <Badge className="border-sky-200 bg-sky-50 text-sky-700"><FileJson className="mr-1 h-3.5 w-3.5" />本地数据 · 已暂停</Badge>}
              {!compactContext && <span className="min-w-0 truncate text-base font-semibold text-slate-800">{shopName}</span>}
              <div className="flex max-w-full items-center gap-2" title={accountCaptures.length === 1 ? '当前仅有 1 个成功价格视角；其他在线账号重新抓取成功后会自动加入切换。' : undefined}>
                <span className="shrink-0 text-[11px] font-medium text-slate-500">价格视角</span>
                <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-slate-100 p-1" role="group" aria-label="切换账号价格视角">
                  {accountCaptures.length > 0 ? accountCaptures.map((capture) => {
                      const selected = capture.sessionId === selectedAccountCapture?.sessionId
                      const AccountIcon = capture.accountType === 'vip88' ? Crown : capture.accountType === 'gift' ? Gift : UserRound
                      const label = capture.accountType === 'vip88' ? '88VIP' : capture.accountType === 'gift' ? '礼金' : '普通'
                      return (
                        <button key={capture.sessionId} type="button" aria-pressed={selected} onClick={() => setSelectedAccountSessionId(capture.sessionId)} title={`${capture.accountName} · ${capture.primary ? '监控与飞书来源' : '仅切换卡片展示'}`} className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                          <AccountIcon className="h-3.5 w-3.5" />{label}{capture.primary && <span className="text-[10px] text-emerald-600">监控</span>}
                        </button>
                      )
                    }) : <span className="px-2 py-1 text-[11px] text-slate-400">等待成功抓取</span>}
                </div>
                {!localOnly && <button type="button" onClick={refreshAccountViews} disabled={busy || operation?.tone === 'progress'} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-sky-200 hover:text-sky-700 disabled:opacity-50" title="刷新全部已授权账号的价格视角；日常定时仍只抓主账号" aria-label="刷新全部账号价格视角"><RotateCw className={`h-3.5 w-3.5 ${operation?.key === 'account-views' && operation.tone === 'progress' ? 'animate-spin' : ''}`} /></button>}
              </div>
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="min-w-0 max-w-[620px] line-clamp-2 text-[1.05rem] font-semibold leading-7 text-slate-950">{title}</h3>
              <div className="flex shrink-0 items-center gap-3 pt-0.5 text-sm">
                <button type="button" className="inline-flex items-center gap-1.5 font-medium text-sky-700 transition hover:text-sky-900 disabled:opacity-60" title={`使用${selectedAccountName}的独立浏览器打开`} onClick={openProduct} disabled={openingProduct}><ExternalLink className="h-4 w-4" />{openingProduct ? '打开中' : '打开商品'}</button>
                <button type="button" className={`font-medium transition hover:text-sky-900 ${copiedProductUrl ? 'text-emerald-700' : 'text-sky-700'}`} title="复制精简后的商品链接" onClick={copyProductUrl}>{copiedProductUrl ? '链接已复制' : '复制链接'}</button>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-500">
              {itemId && <button type="button" className={`font-medium tabular-nums transition hover:text-sky-700 ${copiedItemId ? 'text-emerald-700' : 'text-slate-600'}`} title="点击复制商品 ID" onClick={copyItemId}>商品 ID {itemId}{copiedItemId ? ' · 已复制' : ''}</button>}
              {!compactContext && <span><span className="text-slate-400">型号</span><span className="ml-1.5 font-medium text-slate-700">{model}</span></span>}
              <span className="h-3.5 w-px bg-slate-200" aria-hidden="true" />
              <Button type="button" variant="secondary" size="sm" className="rounded-lg" onClick={() => setBuyerShowOpen(true)} disabled={!buyerShows.length} title={buyerShows.length ? `预览 ${buyerShows.length} 条有效买家秀` : '当前快照暂无有效买家秀，请重新抓取商品'}><Images className="h-4 w-4" />买家秀{buyerShows.length ? ` ${buyerShows.length}` : ''}</Button>
              {!localOnly && <Button type="button" variant="secondary" size="sm" className="w-8 rounded-lg px-0" onClick={retryBuyerShows} disabled={retryingBuyerShows || operation?.tone === 'progress'} title={buyerShowCapture?.status === 'failed' ? '仅重试买家秀' : '单独抓取买家秀'} aria-label={buyerShowCapture?.status === 'failed' ? '仅重试买家秀' : '单独抓取买家秀'}><RotateCw className={`h-4 w-4 ${retryingBuyerShows ? 'animate-spin' : ''}`} /></Button>}
              {buyerShows.length > 0 && <Button type="button" variant="secondary" size="sm" className="w-8 rounded-lg px-0" onClick={() => runDownload('buyer-shows', '正在整理买家秀图片、视频和文案并生成 ZIP...', downloadBuyerShowsHref(product.id), `${title}_买家秀.zip`)} disabled={operation?.tone === 'progress'} title="下载买家秀 ZIP" aria-label="下载买家秀 ZIP">{operation?.key === 'buyer-shows' && operation.tone === 'progress' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</Button>}
              {!localOnly && <label className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${captureMediaAssets ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`} title="关闭时只抓价格、800 主图和 SKU 图，且不提供商品素材下载">
                <input type="checkbox" checked={captureMediaAssets} onChange={(event) => changeMediaPreference(event.target.checked)} disabled={savingMediaPreference || operation?.tone === 'progress'} className="h-3.5 w-3.5 accent-blue-600" />
                <Archive className="h-3.5 w-3.5" />完整素材
              </label>}
              {captureMediaAssets && <Button type="button" variant="secondary" size="sm" className="w-8 rounded-lg px-0" onClick={captureMaterials} disabled={busy || operation?.tone === 'progress'} title="单独抓取完整素材" aria-label="单独抓取完整素材">{operation?.key === 'materials-capture' && operation.tone === 'progress' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}</Button>}
              {captureMediaAssets && <Button type="button" variant="secondary" size="sm" className="w-8 rounded-lg px-0" onClick={() => runDownload('media', '正在整理主图、SKU 图、详情图和视频并生成素材包...', downloadMediaBundleHref(product.id), `${title}_素材包.zip`)} disabled={operation?.tone === 'progress'} title="下载完整素材包" aria-label="下载完整素材包">{operation?.key === 'media' && operation.tone === 'progress' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</Button>}
            </div>
          </div>

          <div className="product-monitor-command-deck min-w-0">
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              <Button type="button" variant="secondary" size="sm" className="h-9 rounded-lg shadow-sm active:translate-y-px" onClick={() => setPriceVerificationOpen(true)} disabled={!product.lastSnapshot?.skuPrices?.length} title="逐 SKU 核对价格证据、展示金额和计算公式"><ShieldCheck className="h-4 w-4" />核对价格</Button>
              {!localOnly && <Button type="button" variant="secondary" size="sm" className={`h-9 rounded-lg shadow-sm active:translate-y-px ${product.enabled ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'}`} onClick={toggleMonitoring} disabled={togglingMonitor} title={!monitor.running ? '启用本商品计划；全局自动监控开启后执行' : product.enabled ? '暂停本商品定时监控' : '启用本商品定时监控'}>{product.enabled ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}{togglingMonitor ? '更新中' : product.enabled ? '暂停定时' : '启用定时'}</Button>}
              <Button type="button" variant="secondary" size="sm" className="h-9 rounded-lg shadow-sm active:translate-y-px" onClick={syncFeishu} disabled={syncingFeishu || !product.lastSnapshot}><BellRing className="h-4 w-4" />{syncingFeishu ? '同步中' : '同步飞书'}</Button>
              {localOnly ? <Button type="button" size="sm" className="h-9 rounded-lg shadow-sm" onClick={() => onLocalImport(product)} title="选择新的本地数据文件更新价格"><FileJson className="h-4 w-4" />导入新文件</Button> : <CaptureButton busy={busy} onCapture={captureNow} />}
              <Button type="button" variant="danger" size="sm" className="h-9 w-9 rounded-lg px-0 active:translate-y-px" onClick={() => onDelete(product)} title="删除商品" aria-label="删除商品"><Trash2 className="h-4 w-4" /></Button>
            </div>
            {localOnly ? <div className="product-monitor-schedule-row mt-2 ml-auto flex items-center justify-end gap-2 text-xs text-sky-700"><FileJson className="h-3.5 w-3.5" />本地数据不执行定时或在线抓取；请导入新文件更新价格。</div> : <div className="product-monitor-schedule-row mt-2 ml-auto flex flex-wrap items-center justify-end gap-2 text-sm text-slate-600">
              <div className="inline-flex h-9 overflow-hidden rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label="抓取计划模式">
                <button type="button" role="radio" aria-checked={scheduleModeDraft === 'once'} onClick={() => setScheduleModeDraft('once')} className={`rounded-md px-2.5 text-xs font-medium transition ${scheduleModeDraft === 'once' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>单次</button>
                <button type="button" role="radio" aria-checked={scheduleModeDraft === 'interval'} onClick={() => setScheduleModeDraft('interval')} className={`rounded-md px-2.5 text-xs font-medium transition ${scheduleModeDraft === 'interval' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>循环</button>
              </div>
              {scheduleModeDraft === 'once' ? <>
                <label htmlFor={`monitor-date-${product.id}`} className="sr-only">监控日期</label>
                <input id={`monitor-date-${product.id}`} type="date" value={scheduleDateDraft} onChange={(event) => setScheduleDateDraft(event.target.value)} className="h-9 w-[140px] rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                <label htmlFor={`monitor-time-${product.id}`} className="sr-only">详细抓取时间</label>
                <input id={`monitor-time-${product.id}`} type="time" step={60} value={scheduleTimeDraft} onChange={(event) => setScheduleTimeDraft(event.target.value)} className="h-9 w-[100px] rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
              </> : <label className="inline-flex h-9 items-center gap-1.5 text-xs text-slate-500">每<input type="number" min={30} max={1440} step={1} value={scheduleDraft} onChange={(event) => setScheduleDraft(event.target.value)} className="h-9 w-[76px] rounded-lg border border-slate-200 bg-white px-2 text-center text-xs text-slate-800 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100" aria-label="单品循环监控间隔" />分钟</label>}
              <Button type="button" variant="secondary" size="sm" onClick={saveSchedule} disabled={savingSchedule} className="h-9 rounded-lg shadow-sm active:translate-y-px" title="保存本商品抓取计划">{savingSchedule ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{savingSchedule ? '保存中' : '保存计划'}</Button>
            </div>}
          </div>
        </div>
      </header>
      {(operation || busy) && (
        <div className={`mx-5 mb-3 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs ${(operation?.tone === 'progress' || busy) ? 'bg-blue-50 text-blue-700' : operation?.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`} role="status" aria-live="polite">
          {(operation?.tone === 'progress' || busy) ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : operation?.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}
          <span>{operation?.message || '正在抓取商品数据，请保持软件运行。'}</span>
        </div>
      )}

      <div className="product-monitor-content gap-5 border-t border-slate-100 bg-slate-50/70 px-5 py-5">
        <section className="min-w-0" aria-label="商品素材与抓取状态">
          <ImageThumb src={primary} title={`${title}-800主图第一张`} label="800 主图" className="h-[210px] bg-white" imageClassName="!aspect-auto h-full" onPreview={onPreview} allowDownload={captureMediaAssets} />
          {captureMediaAssets && gallery.length > 0 && <div className="mt-2 grid grid-cols-5 gap-1.5">
            {gallery.map((image, index) => (
              <ImageThumb
                key={image}
                src={image}
                title={`${title}-750主图-${index + 1}`}
                label={`${index + 1}`}
                className="h-[54px] bg-white"
                imageClassName="!aspect-auto h-full"
                onPreview={onPreview}
                allowDownload
              />
            ))}
          </div>}

          {videos.length > 0 && (
            <div className="mt-3">
              <div className="mb-2 text-xs font-medium text-slate-600">视频</div>
              <div className="flex flex-wrap gap-2">{videos.map((video, index) => <VideoLink key={video} src={video} index={index} />)}</div>
            </div>
          )}
          <CaptureStatus product={product} />
        </section>

        <SkuPricePanel product={product} snapshots={snapshots} showTrend={trendVisible} accountSessionId={selectedAccountCapture?.sessionId || ''} accountType={selectedAccountType} accountName={selectedAccountName} primaryAccountType={primaryAccountType} isPrimaryAccountView={isPrimaryAccountView} onPreview={onPreview} onSaveSkuMonitorPrice={saveSkuMonitorPrice} allowMediaDownload={captureMediaAssets} />
      </div>

      {buyerShowOpen && <BuyerShowDialog title={title} items={buyerShows} statusText={buyerShowStatusText} onClose={() => setBuyerShowOpen(false)} retryBusy={retryingBuyerShows} onRetry={localOnly ? undefined : retryBuyerShows} downloadBusy={operation?.tone === 'progress' && operation.key.startsWith('buyer-show') && operation.key !== 'buyer-show-retry'} downloadMessage={operation?.key.startsWith('buyer-show') ? operation.message : ''} onDownload={() => runDownload('buyer-shows', '正在整理全部买家秀并生成 ZIP...', downloadBuyerShowsHref(product.id), `${title}_买家秀.zip`)} onDownloadItem={(item) => runDownload(`buyer-show-item:${item.id}`, '正在整理这条买家秀并生成 ZIP...', downloadBuyerShowItemHref(product.id, item.id), `${title}_买家秀.zip`)} />}
      {priceVerificationOpen && <PriceVerificationDialog product={product} accountSessionId={selectedAccountCapture?.sessionId || ''} accountType={selectedAccountType} accountName={selectedAccountName} onClose={() => setPriceVerificationOpen(false)} />}
    </article>
  )
}
