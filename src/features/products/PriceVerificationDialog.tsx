import { AlertTriangle, CheckCircle2, ShieldCheck, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { currency } from '../../lib/utils'
import type { Product, Snapshot } from '../../types/domain'
import { publicPriceLabelForSku } from './productDisplayUtils'

type Sku = Snapshot['skuPrices'][number]
type Channel = 'normal' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin'

const channels: Array<{ key: Channel; label: string; value: (sku: Sku) => number | null | undefined; formula: keyof NonNullable<Sku['priceCalculation']> }> = [
  { key: 'normal', label: '普通价', value: (sku) => sku.normalPrice ?? sku.price, formula: 'normal' },
  { key: 'government', label: '国补价', value: (sku) => sku.governmentPrice, formula: 'government' },
  { key: 'surprise', label: '惊喜立减价', value: (sku) => sku.surprisePrice, formula: 'surprise' },
  { key: 'gift', label: '礼金价', value: (sku) => sku.giftPrice, formula: 'gift' },
  { key: 'vip88', label: '88VIP价', value: (sku) => sku.vipPrice, formula: 'vip88' },
  { key: 'coin', label: '淘金币价', value: (sku) => sku.coinPrice, formula: 'coin' },
]

function inspectChannel(sku: Sku, channel: (typeof channels)[number]) {
  const resolution = sku.priceResolution?.channels?.[channel.key]
  const displayed = channel.value(sku)
  const evidence = resolution?.valueCents == null ? null : resolution.valueCents / 100
  const verified = resolution?.status === 'verified'
  const matches = verified && evidence !== null && typeof displayed === 'number' && Math.abs(displayed - evidence) < 0.005
  return {
    ...channel,
    resolution,
    displayed,
    evidence,
    verified,
    matches,
    formulaText: resolution?.formula || sku.priceCalculation?.[channel.formula] || resolution?.reason || '本次没有明确证据或计算公式',
  }
}

export function PriceVerificationDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const skus = product.lastSnapshot?.skuPrices || []
  const inspections = skus.flatMap((sku) => channels.map((channel) => inspectChannel(sku, channel)))
  const verifiedCount = inspections.filter((item) => item.matches).length
  const mismatchCount = inspections.filter((item) => item.verified && !item.matches).length

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-slate-950/70 p-3 sm:p-6" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="price-verification-title" className="flex h-[calc(100dvh-1.5rem)] max-h-[880px] w-full max-w-5xl flex-col overflow-hidden rounded-md bg-white shadow-2xl sm:h-[calc(100dvh-3rem)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div id="price-verification-title" className="flex items-center gap-2 text-base font-semibold text-slate-950"><ShieldCheck className="h-5 w-5 text-blue-600" />价格公式核对</div>
            <div className="mt-1 truncate text-sm text-slate-500">{product.name}</div>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100" title="关闭价格核对"><X className="h-5 w-5" /></button>
        </div>

        <div className={`flex items-center gap-2 px-5 py-3 text-sm ${mismatchCount ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`} role="status">
          {mismatchCount ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          <span>{skus.length} 个 SKU，{verifiedCount} 项证据与展示金额一致{mismatchCount ? `，${mismatchCount} 项不一致，请重新抓取` : ''}；未获取的价格不计为错误。</span>
        </div>

        <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto bg-slate-100/70 p-4">
          {skus.map((sku) => (
            <section key={sku.skuId} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-sm font-semibold text-slate-900"><span className="line-clamp-2">{sku.name}</span></div>
                <div className="text-xs tabular-nums text-slate-400">SKU ID {sku.skuId}</div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                {channels.map((channel) => {
                  const item = inspectChannel(sku, channel)
                  const unavailable = !item.verified
                  return (
                    <div key={channel.key} className={`min-w-0 rounded-md px-3 py-2.5 ${item.matches ? 'bg-emerald-50' : unavailable ? 'bg-slate-50' : 'bg-red-50'}`}>
                      <div className={`flex items-center gap-1.5 text-sm font-medium ${item.matches ? 'text-emerald-700' : unavailable ? 'text-slate-500' : 'text-red-700'}`}>
                        {item.matches ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : !unavailable ? <AlertTriangle className="h-4 w-4 shrink-0" /> : null}
                        {channel.key === 'normal' ? publicPriceLabelForSku(sku) : channel.label}
                      </div>
                      <div className="mt-1 text-base font-semibold tabular-nums text-slate-900">{typeof item.displayed === 'number' ? currency(item.displayed) : '未获取'}</div>
                      {item.verified && <div className="mt-1 text-xs text-slate-500">证据 {item.evidence === null ? '--' : currency(item.evidence)}</div>}
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                {channels.map((channel) => {
                  const item = inspectChannel(sku, channel)
                  return <div key={channel.key} className="grid gap-1 text-sm md:grid-cols-[112px_minmax(0,1fr)]"><span className={item.matches ? 'font-medium text-emerald-700' : 'font-medium text-slate-500'}>{channel.key === 'normal' ? publicPriceLabelForSku(sku) : channel.label}</span><span className="break-words text-slate-600">{item.formulaText}</span></div>
                })}
              </div>
            </section>
          ))}
          {!skus.length && <div className="py-16 text-center text-sm text-slate-500">当前商品还没有 SKU 价格快照，请先抓取商品。</div>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
