import { ArrowDown, ReceiptText, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { currency } from '../../lib/utils'
import { coinBenefitForSku, giftBenefitForSku, normalPriceForSku, priceLayersForSku, publicPriceLabelForSku, skuForAccountView, surpriseBenefitForSku, verifiedPriceValue, vipBenefitForSku, type SkuPrice } from './productDisplayUtils'

export function DiscountDetailDialog({
  sku,
  accessMode,
  accountType,
  onClose,
}: {
  sku: SkuPrice | null
  accessMode?: 'authenticated' | 'anonymous'
  accountType: 'normal' | 'gift' | 'vip88'
  onClose: () => void
}) {
  useEffect(() => {
    if (!sku) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sku, onClose])

  if (!sku) return null

  const layers = priceLayersForSku(sku, { accountType })
  const originalLayer = layers.find((layer) => layer.kind === 'original' || layer.label === '标价')
  const originalPrice = originalLayer?.value || sku.originalPrice
  const normalPrice = normalPriceForSku(sku)
  const governmentPrice = verifiedPriceValue(sku, 'government', accountType)
  const surpriseBenefit = surpriseBenefitForSku(sku)
  const giftBenefit = giftBenefitForSku(sku, accountType)
  const vipBenefit = vipBenefitForSku(sku, accountType)
  const coinBenefit = coinBenefitForSku(sku)
  const coinPrice = coinBenefit.price
  const anonymous = accessMode === 'anonymous'
  const discountItems = sku.discountItems || []
  const productPrograms = discountItems.filter((item) => (
    item.source === 'product-program' || (item.source === 'page-visible' && item.label === '百亿补贴')
  ))
  const totalDiscount = originalPrice ? Math.max(0, originalPrice - normalPrice) : 0
  let undistributedDiscount = totalDiscount
  const explicitDiscountSteps = discountItems
    .filter((item) => {
      if (!(Number(item.amount) > 0 && undistributedDiscount > 0)) return false
      if (item.source?.startsWith('price-resolver:')) return /price-resolver:(?:public|billion|seckill)$/.test(item.source)
      return !/惊喜立减|淘金币|金币|政府补贴|国家补贴|国补|礼金|88\s*VIP/i.test(`${item.label} ${item.text}`)
    })
    .map((item) => {
      const amount = Math.min(Number(item.amount), undistributedDiscount)
      undistributedDiscount = Number((undistributedDiscount - amount).toFixed(2))
      return { ...item, amount }
    })
  const discountSteps = [...explicitDiscountSteps]
  if (undistributedDiscount > 0) {
    const capturedNormalLayer = (sku.priceLayers || []).find((layer) => (
      layer.kind !== 'original' &&
      layer.value === normalPrice &&
      !/惊喜|淘金币|金币|礼金|88\s*VIP/i.test(layer.label)
    ))
    const capturedLabel = capturedNormalLayer?.label || ''
    const differenceLabel = /店铺优惠/.test(capturedLabel)
      ? '店铺优惠'
      : /平台|补贴|券后|立减/.test(capturedLabel)
        ? capturedLabel
        : '未解析价格差额'
    discountSteps.push({
      label: differenceLabel,
      amount: undistributedDiscount,
      threshold: null,
      text: capturedLabel
        ? `商品页面价格层级标注为“${capturedLabel}”`
        : '页面仅确认标价与到手价，未获取到可核验的优惠名称和金额',
      type: 'promotion',
      source: 'derived',
    })
  }
  let runningPrice = originalPrice || normalPrice
  const calculatedSteps = discountSteps.map((step) => {
    runningPrice = Math.max(normalPrice, Number((runningPrice - Number(step.amount || 0)).toFixed(2)))
    return { ...step, priceAfter: runningPrice }
  })
  const benefitRows = [
    { channel: 'surprise', benefit: surpriseBenefit, formula: sku.priceCalculation?.surprise, arrowClass: 'text-rose-500', panelClass: 'bg-rose-50', labelClass: 'text-rose-700' },
    { channel: 'gift', benefit: giftBenefit, formula: sku.priceCalculation?.gift, arrowClass: 'text-orange-500', panelClass: 'bg-orange-50', labelClass: 'text-orange-700' },
    { channel: 'vip88', benefit: vipBenefit, formula: sku.priceCalculation?.vip88, arrowClass: 'text-violet-500', panelClass: 'bg-violet-50', labelClass: 'text-violet-700' },
  ].filter((row) => row.benefit.available && row.benefit.price !== null)
  const currentPriceKeys = new Set([
    ...benefitRows.map((row) => `${row.benefit.label}:${row.benefit.price}`),
    ...(coinPrice ? [`淘金币价:${coinPrice}`] : []),
  ])
  const alternativePrices = (sku.accountPrices || [])
    .flatMap((accountPrice) => {
      const accountSku = skuForAccountView(sku, accountPrice.sessionId, accountPrice.accountType)
      const accountBenefits = [
        surpriseBenefitForSku(accountSku),
        giftBenefitForSku(accountSku, accountPrice.accountType),
        ...(accountPrice.accountType === 'vip88' ? [vipBenefitForSku(accountSku, accountPrice.accountType)] : []),
      ]
      const accountCoin = coinBenefitForSku(accountSku)
      return [
        ...accountBenefits
          .filter((benefit) => benefit.available && benefit.price !== null)
          .map((benefit) => ({ label: benefit.label, value: benefit.price as number, source: `账号：${accountPrice.accountName}` })),
        ...(accountCoin.available && accountCoin.price !== null
          ? [{ label: '淘金币价', value: accountCoin.price, source: `账号：${accountPrice.accountName}` }]
          : []),
      ]
    })
    .filter((price) => !currentPriceKeys.has(`${price.label}:${price.value}`))
    .filter((price, index, list) => list.findIndex((item) => item.label === price.label && item.value === price.value) === index)

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-slate-950/70 p-3 sm:p-6" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`discount-title-${sku.skuId}`}
        className="flex h-[calc(100dvh-1.5rem)] max-h-[880px] w-full max-w-3xl flex-col overflow-hidden rounded-md bg-white shadow-2xl sm:h-[calc(100dvh-3rem)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700">
              <ReceiptText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id={`discount-title-${sku.skuId}`} className="text-sm font-semibold text-slate-900">优惠明细</h2>
              <div className="mt-1 truncate text-xs text-slate-500">{sku.name}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">SKU ID {sku.skuId}</div>
            </div>
          </div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-slate-800">优惠计算层级</h3>
            {totalDiscount > 0 && <span className="text-[11px] font-medium text-emerald-700">标价差额 {currency(totalDiscount)}</span>}
          </div>
          <div className="rounded-md border border-slate-100 bg-slate-50/60 px-4 py-3">
            <div className="grid grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-3 py-2">
              <span className="text-xs font-medium text-slate-500">标价</span>
              <span className="text-xs text-slate-500">商品页面标价</span>
              <span className="text-right text-base font-semibold text-slate-500 line-through">{currency(originalPrice || normalPrice)}</span>
            </div>
            {calculatedSteps.map((step, index) => (
              <div key={`${step.label}-${step.amount}-${index}`}>
                <div className="flex h-6 items-center pl-9 text-emerald-500"><ArrowDown className="h-4 w-4" /></div>
                <div className="grid grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-3 rounded bg-white px-2 py-2.5">
                  <span className="text-xs font-medium text-emerald-700">{step.label}</span>
                  <div className="min-w-0">
                    <div className="text-xs text-slate-600">{step.text}</div>
                    <div className="mt-1 text-[11px] text-slate-400">优惠后 {currency(step.priceAfter)}{step.threshold ? ` · 满 ${currency(step.threshold)} 可用` : ''}</div>
                  </div>
                  <span className="text-right text-base font-semibold text-emerald-700">-{currency(step.amount)}</span>
                </div>
              </div>
            ))}
            <div className="flex h-6 items-center pl-9 text-sky-500"><ArrowDown className="h-4 w-4" /></div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-3 rounded bg-sky-50 px-2 py-3">
              <span className="text-xs font-semibold text-sky-700">{publicPriceLabelForSku(sku)}</span>
              <span className="text-xs text-sky-700">活动公式验证后的当前公共价格</span>
              <span className="text-right text-lg font-semibold text-sky-800">{currency(normalPrice)}</span>
            </div>
            {governmentPrice && governmentPrice !== normalPrice && <>
              <div className="flex h-6 items-center pl-9 text-teal-500"><ArrowDown className="h-4 w-4" /></div>
              <div className="grid grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-3 rounded bg-teal-50 px-2 py-3">
                <span className="text-xs font-semibold text-teal-700">国补价</span>
                <span className="text-xs text-teal-700">普通价减政府补贴 {currency(sku.governmentDiscountAmount)}</span>
                <span className="text-right text-lg font-semibold text-teal-800">{currency(governmentPrice)}</span>
              </div>
            </>}
            {benefitRows.map((row) => (
              <div key={row.channel}>
                <div className={`flex h-6 items-center pl-9 ${row.arrowClass}`}><ArrowDown className="h-4 w-4" /></div>
                <div className={`grid grid-cols-[104px_minmax(0,1fr)_96px] items-center gap-3 rounded px-2 py-3 ${row.panelClass}`}>
                  <span className={`text-xs font-semibold ${row.labelClass}`}>{row.benefit.label}</span>
                  <span className="text-xs text-slate-600">{row.formula || `当前 SKU 价格与优惠金额已完成公式核验${row.benefit.discountAmount ? `，优惠 ${currency(row.benefit.discountAmount)}` : ''}`}</span>
                  <span className="text-right text-lg font-semibold text-slate-900">{currency(row.benefit.price)}</span>
                </div>
              </div>
            ))}
          </div>
          {productPrograms.length > 0 && (
            <div className="mt-3 flex items-start gap-3 border-y border-amber-100 bg-amber-50/60 px-3 py-2.5">
              <span className="shrink-0 text-xs font-medium text-amber-800">商品活动</span>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-1.5">
                  {productPrograms.map((program) => (
                    <span key={`${program.label}-${program.source}`} className="rounded border border-amber-200 bg-white px-2 py-0.5 text-xs font-medium text-amber-800">{program.label}</span>
                  ))}
                </div>
                <div className="mt-1 text-[11px] text-amber-700">已确认活动身份；页面未单独披露活动分摊金额，不计入上方金额归因。</div>
              </div>
            </div>
          )}
          <div className="mt-3 border-y border-slate-100 py-2.5">
            <div className="mb-2 text-xs font-medium text-slate-700">价格自动计算</div>
            <div className="space-y-1 text-[11px] text-slate-500">
              <div>{sku.priceCalculation?.normal || `普通价 ${currency(normalPrice)}`}</div>
              <div className={governmentPrice ? 'text-teal-700' : ''}>{sku.priceCalculation?.government || (governmentPrice ? `普通价 ${currency(normalPrice)} - 政府补贴 ${currency(sku.governmentDiscountAmount)} = ${currency(governmentPrice)}` : '未获取国补价')}</div>
              <div className={surpriseBenefit.available ? 'text-rose-700' : ''}>{sku.priceCalculation?.surprise || (surpriseBenefit.price ? `普通价 ${currency(normalPrice)} - 惊喜立减 ${currency(surpriseBenefit.discountAmount || normalPrice - surpriseBenefit.price)} = ${currency(surpriseBenefit.price)}` : '未获取惊喜立减价')}</div>
              {giftBenefit.available && <div className="text-orange-700">{sku.priceCalculation?.gift || `${giftBenefit.label} ${currency(giftBenefit.price)}`}</div>}
              {vipBenefit.available && <div className="text-violet-700">{sku.priceCalculation?.vip88 || `88VIP价 ${currency(vipBenefit.price)}`}</div>}
              <div className={coinBenefit.available ? 'text-amber-700' : ''}>{sku.priceCalculation?.coin || (coinPrice ? `普通价 ${currency(normalPrice)} - 淘金币抵扣 ${currency(coinBenefit.discountAmount || normalPrice - coinPrice)} = ${currency(coinPrice)}` : '未获取淘金币价')}</div>
            </div>
          </div>
          <div className={`mt-3 flex items-center justify-between gap-3 border-y px-3 py-2.5 ${coinBenefit.available ? 'border-amber-100 bg-amber-50/60' : 'border-slate-100 bg-slate-50/70'}`}>
            <div>
              <div className={`text-xs font-medium ${coinBenefit.available ? 'text-amber-800' : 'text-slate-500'}`}>淘金币明细</div>
              <div className={`mt-0.5 text-[11px] ${coinBenefit.available ? 'text-amber-700' : 'text-slate-400'}`}>
                {anonymous
                  ? '匿名公开页不提供淘金币明细，请登录后抓取'
                  : coinBenefit.available
                  ? coinBenefit.discountAmount
                    ? `当前 SKU 可抵扣 ${currency(coinBenefit.discountAmount)}`
                    : '当前 SKU 已识别淘金币权益，页面未披露抵扣金额'
                  : '当前 SKU 无淘金币'}
              </div>
            </div>
            <span className={`text-sm font-semibold ${coinBenefit.available ? 'text-amber-800' : 'text-slate-400'}`}>
              {anonymous ? '需登录' : coinPrice ? currency(coinPrice) : coinBenefit.available ? '可用' : '无'}
            </span>
          </div>
          {alternativePrices.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold text-slate-800">其他可用价格</h3>
              <div className="divide-y divide-slate-100 border-y border-slate-100">
                {alternativePrices.map((price) => (
                  <div key={`${price.label}-${price.value}`} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                    <div><span className="font-medium text-slate-700">{price.label}</span><span className="ml-2 text-slate-400">{price.source}</span></div>
                    <span className="text-sm font-semibold text-slate-900">{currency(price.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {totalDiscount === 0 && <div className="mt-3 text-xs text-slate-400">当前标价与到手价相同，未识别到有效优惠差额。</div>}
          </div>
      </section>
    </div>,
    document.body,
  )
}
