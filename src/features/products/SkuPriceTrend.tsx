import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { TrendingUp } from 'lucide-react'
import { currency } from '../../lib/utils'
import type { Product, Snapshot } from '../../types/domain'

const lineColors = ['#0284c7', '#ea580c', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2', '#4f46e5']

const priceModes = [
  { value: 'normalPrice', label: '普通价' },
  { value: 'surprisePrice', label: '惊喜立减价' },
  { value: 'giftPrice', label: '礼金价' },
  { value: 'vipPrice', label: '88VIP价' },
  { value: 'coinPrice', label: '淘金币价' },
] as const

type PriceMode = (typeof priceModes)[number]['value']

function priceForMode(sku: Snapshot['skuPrices'][number], mode: PriceMode, accountType: Product['accountType']) {
  if (mode === 'normalPrice') {
    const value = sku.normalPrice ?? sku.price
    const accountBenefitMissing = accountType === 'gift' ? !sku.giftPrice : accountType === 'vip88' ? !sku.vipPrice : false
    if (accountBenefitMissing && sku.originalPrice === value) return null
    return value
  }
  const direct = sku[mode]
  if (typeof direct === 'number') return direct
  const targetAccountType = mode === 'giftPrice' ? 'gift' : mode === 'vipPrice' ? 'vip88' : null
  if (!targetAccountType) return null
  const accountPrice = sku.accountPrices?.find((item) => item.accountType === targetAccountType)
  return mode === 'giftPrice' ? accountPrice?.giftPrice ?? accountPrice?.price ?? null : accountPrice?.vipPrice ?? accountPrice?.price ?? null
}

export function SkuPriceTrend({ snapshots, product }: { snapshots: Snapshot[]; product: Product }) {
  const [selectedSku, setSelectedSku] = useState('all')
  const [priceMode, setPriceMode] = useState<PriceMode>('normalPrice')
  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime()),
    [snapshots],
  )
  const skuOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const snapshot of [...orderedSnapshots].reverse()) {
      for (const sku of snapshot.skuPrices || []) {
        if (!options.has(sku.skuId)) options.set(sku.skuId, sku.name)
      }
    }
    return Array.from(options, ([id, name]) => ({ id, name }))
  }, [orderedSnapshots])

  useEffect(() => {
    if (selectedSku !== 'all' && !skuOptions.some((sku) => sku.id === selectedSku)) setSelectedSku('all')
  }, [selectedSku, skuOptions])

  const visibleSkus = selectedSku === 'all' ? skuOptions.slice(0, 8) : skuOptions.filter((sku) => sku.id === selectedSku)
  const chartData = orderedSnapshots.map((snapshot) => {
    const capturedAt = new Date(snapshot.capturedAt)
    const point: Record<string, string | number> = {
      capturedAt: snapshot.capturedAt,
      time: capturedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    }
    for (const sku of snapshot.skuPrices || []) {
      const value = priceForMode(sku, priceMode, product.accountType)
      if (typeof value === 'number') point[sku.skuId] = value
    }
    return point
  })
  const selectedModeLabel = priceModes.find((mode) => mode.value === priceMode)?.label || '价格'

  return (
    <section className="mt-3 min-w-0 border-t border-slate-100 pt-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-sky-50 text-sky-700">
            <TrendingUp className="h-4 w-4" />
          </span>
          <div>
            <div className="text-xs font-semibold text-slate-800">SKU 价格趋势</div>
            <div className="text-[11px] text-slate-400">最近 {orderedSnapshots.length} 次监控记录</div>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <select value={priceMode} onChange={(event) => setPriceMode(event.target.value as PriceMode)} className="h-8 w-[132px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-sky-400" aria-label="选择价格口径">
            {priceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          <select
            value={selectedSku}
            onChange={(event) => setSelectedSku(event.target.value)}
            className="h-8 max-w-[260px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-sky-400"
            aria-label="选择趋势图 SKU"
          >
            <option value="all">全部 SKU</option>
            {skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.name} · {sku.id}</option>)}
          </select>
        </div>
      </div>

      {orderedSnapshots.length >= 2 && visibleSkus.length > 0 ? (
        <div className="h-60 min-w-0 w-full rounded-md bg-slate-50/60 px-2 pb-1 pt-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={36} />
              <YAxis
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value) => `¥${value}`}
                domain={[(value: number) => Math.max(0, Math.floor(value * 0.95)), (value: number) => Math.ceil(value * 1.05)]}
              />
              <Tooltip
                formatter={(value, name) => [currency(Number(value)), String(name)]}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.capturedAt ? new Date(payload[0].payload.capturedAt).toLocaleString('zh-CN') : ''}
                contentStyle={{ borderRadius: 6, borderColor: '#cbd5e1', fontSize: 12 }}
              />
              {visibleSkus.length > 1 && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />}
              {visibleSkus.map((sku, index) => {
                const threshold = product.skuMonitorPrices?.[sku.id]
                return typeof threshold === 'number' && threshold > 0 ? (
                  <ReferenceLine key={`monitor-${sku.id}`} y={threshold} stroke={lineColors[index % lineColors.length]} strokeDasharray="5 4" strokeOpacity={0.55} label={visibleSkus.length === 1 ? { value: `监控价 ${currency(threshold)}`, fill: '#b45309', fontSize: 10, position: 'insideTopRight' } : undefined} />
                ) : null
              })}
              {visibleSkus.map((sku, index) => (
                <Line
                  key={sku.id}
                  type="monotone"
                  dataKey={sku.id}
                  name={`${sku.name} · ${selectedModeLabel} · ${sku.id.slice(-5)}`}
                  stroke={lineColors[index % lineColors.length]}
                  strokeWidth={2}
                  dot={chartData.length <= 16 ? { r: 2.5 } : false}
                  activeDot={{ r: 4 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50/50 text-xs text-slate-400">
          至少完成 2 次监控后生成价格趋势
        </div>
      )}
    </section>
  )
}
