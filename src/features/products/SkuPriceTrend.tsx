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
import type { MonitorChannel, Product, Snapshot } from '../../types/domain'
import { accountPriceViewForSku, lowestVerifiedPriceForSku, skuForAccountView, verifiedPriceChannelsForAccount, verifiedPriceValue } from './productDisplayUtils'

const lineColors = ['#0284c7', '#ea580c', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2', '#4f46e5']

const priceModes = [
  { value: 'lowest', label: '最低已验证价' },
  { value: 'normalPrice', label: '普通价' },
  { value: 'billionPrice', label: '百亿补贴价' },
  { value: 'seckillPrice', label: '淘宝秒杀价' },
  { value: 'governmentPrice', label: '国补价' },
  { value: 'surprisePrice', label: '惊喜立减价' },
  { value: 'giftPrice', label: '礼金价' },
  { value: 'vipPrice', label: '88VIP价' },
  { value: 'coinPrice', label: '淘金币价' },
] as const

type PriceMode = (typeof priceModes)[number]['value']
type PriceChannel = Exclude<MonitorChannel, 'lowest'>

const monitorChannelForMode: Record<PriceMode, MonitorChannel> = {
  lowest: 'lowest',
  normalPrice: 'normal',
  billionPrice: 'billion',
  seckillPrice: 'seckill',
  governmentPrice: 'government',
  surprisePrice: 'surprise',
  giftPrice: 'gift',
  vipPrice: 'vip88',
  coinPrice: 'coin',
}

function priceForMode(sku: Snapshot['skuPrices'][number], mode: PriceMode, accountType: NonNullable<Product['accountType']>) {
  if (mode === 'lowest') return lowestVerifiedPriceForSku(sku, accountType)
  const channel = monitorChannelForMode[mode] as PriceChannel
  return verifiedPriceValue(sku, channel, accountType)
}

export function SkuPriceTrend({ snapshots, product, accountSessionId, accountType, accountName, showMonitorThresholds = true }: { snapshots: Snapshot[]; product: Product; accountSessionId: string; accountType: NonNullable<Product['accountType']>; accountName: string; showMonitorThresholds?: boolean }) {
  const [selectedSku, setSelectedSku] = useState('group:0')
  const [priceMode, setPriceMode] = useState<PriceMode>('normalPrice')
  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime()),
    [snapshots],
  )
  const supportedPriceModes = useMemo(() => {
    const supportedChannels = new Set<MonitorChannel>(['lowest', ...verifiedPriceChannelsForAccount(accountType)])
    return priceModes.filter((mode) => supportedChannels.has(monitorChannelForMode[mode.value]))
  }, [accountType])
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
    if (selectedSku.startsWith('group:')) {
      const groupIndex = Number(selectedSku.slice(6))
      if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex * 8 >= Math.max(1, skuOptions.length)) setSelectedSku('group:0')
      return
    }
    if (!skuOptions.some((sku) => sku.id === selectedSku)) setSelectedSku('group:0')
  }, [selectedSku, skuOptions])

  useEffect(() => {
    if (!supportedPriceModes.some((mode) => mode.value === priceMode)) setPriceMode('normalPrice')
  }, [priceMode, supportedPriceModes])

  const skuGroups = useMemo(() => Array.from({ length: Math.ceil(skuOptions.length / 8) }, (_, index) => skuOptions.slice(index * 8, index * 8 + 8)), [skuOptions])
  const selectedGroup = selectedSku.startsWith('group:') ? Number(selectedSku.slice(6)) || 0 : -1
  const visibleSkus = selectedGroup >= 0 ? skuGroups[selectedGroup] || [] : skuOptions.filter((sku) => sku.id === selectedSku)
  const chartData = orderedSnapshots.map((snapshot) => {
    const capturedAt = new Date(snapshot.capturedAt)
    const point: Record<string, string | number> = {
      capturedAt: snapshot.capturedAt,
      time: capturedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    }
    for (const sku of snapshot.skuPrices || []) {
      const accountView = accountPriceViewForSku(sku, accountSessionId, accountType)
      if (accountSessionId && !accountView) continue
      const value = priceForMode(accountView ? skuForAccountView(sku, accountSessionId, accountType) : sku, priceMode, accountType)
      if (typeof value === 'number') point[sku.skuId] = value
    }
    return point
  })
  const selectedModeLabel = priceModes.find((mode) => mode.value === priceMode)?.label || '价格'

  return (
    <section className="product-price-trend mb-3 min-w-0 border-b border-slate-200 pb-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-sky-50 text-sky-700">
            <TrendingUp className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-semibold text-slate-800">SKU 价格趋势</div>
            <div className="text-xs text-slate-400">{accountName}视角 · 最近 {orderedSnapshots.length} 次监控记录</div>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          <select value={priceMode} onChange={(event) => setPriceMode(event.target.value as PriceMode)} className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus:border-sky-400 sm:w-[145px]" aria-label="选择价格口径">
            {supportedPriceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          <select
            value={selectedSku}
            onChange={(event) => setSelectedSku(event.target.value)}
            className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus:border-sky-400 sm:max-w-[300px]"
            aria-label="选择趋势图 SKU"
          >
            {skuGroups.map((group, index) => <option key={`group-${index}`} value={`group:${index}`}>{skuGroups.length === 1 ? `全部 SKU（${group.length}）` : `SKU 第 ${index + 1} 组（${index * 8 + 1}-${index * 8 + group.length}）`}</option>)}
            {skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.name} · {sku.id}</option>)}
          </select>
        </div>
      </div>

      {orderedSnapshots.length >= 2 && visibleSkus.length > 0 ? (
        <div className="h-[320px] min-w-0 w-full rounded-md bg-white px-2 pb-1 pt-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: '#64748b', fontSize: '0.75rem' }} tickLine={false} axisLine={false} minTickGap={42} />
              <YAxis
                tick={{ fill: '#64748b', fontSize: '0.75rem' }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value) => `¥${value}`}
                domain={[(value: number) => Math.max(0, Math.floor(value * 0.95)), (value: number) => Math.ceil(value * 1.05)]}
              />
              <Tooltip
                formatter={(value, name) => [currency(Number(value)), String(name)]}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.capturedAt ? new Date(payload[0].payload.capturedAt).toLocaleString('zh-CN') : ''}
                contentStyle={{ borderRadius: 6, borderColor: '#cbd5e1', fontSize: '0.75rem' }}
              />
              {visibleSkus.length > 1 && <Legend wrapperStyle={{ fontSize: '0.75rem', paddingTop: 8 }} />}
              {showMonitorThresholds && visibleSkus.map((sku, index) => {
                const monitorChannel = monitorChannelForMode[priceMode]
                const threshold = product.skuMonitorRules?.[sku.id]?.[monitorChannel] ?? (monitorChannel === 'lowest' ? product.skuMonitorPrices?.[sku.id] : undefined)
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
                  connectNulls={false}
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
