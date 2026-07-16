import { Archive, CircleAlert, CircleCheck, Crown, Gift, Hash, Images, Layers3, Link2, LoaderCircle, Play, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Textarea } from '../../components/ui/input'
import { itemIdFromProductInput, normalizeProductUrl, normalizeProductUrlIfPossible, productUrlForItemId, type ProductPlatform } from '../../lib/productUrl'
import type { AuthSession } from '../../types/domain'

type Payload = { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }
type InputMode = 'link' | 'id'

type Props = {
  sessions: AuthSession[]
  busy: boolean
  onRun: (payload: Payload) => Promise<{ failed: number; message: string }>
  onRequireAuth: (accountType: Payload['accountType']) => void
}

export function BatchCaptureCard({ sessions, busy, onRun, onRequireAuth }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>('link')
  const [platform, setPlatform] = useState<ProductPlatform>('tmall')
  const [rawLinks, setRawLinks] = useState('')
  const [rawIds, setRawIds] = useState('')
  const [accountType, setAccountType] = useState<Payload['accountType']>('normal')
  const [captureBuyerShows, setCaptureBuyerShows] = useState(false)
  const [captureMediaAssets, setCaptureMediaAssets] = useState(false)
  const [status, setStatus] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)
  const rawInput = inputMode === 'id' ? rawIds : rawLinks
  const entries = useMemo(() => [...new Set(rawInput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))], [rawInput])
  const urls = useMemo(() => inputMode === 'id'
    ? [...new Set(entries.map(itemIdFromProductInput).filter(Boolean).map((itemId) => productUrlForItemId(itemId, platform)))]
    : [...new Set(entries.map(normalizeProductUrlIfPossible))], [entries, inputMode, platform])

  async function submit() {
    setStatus({ tone: 'progress', message: `正在创建并抓取 ${urls.length} 个商品${captureMediaAssets ? '，包含完整素材' : ''}${captureBuyerShows ? '，包含买家秀' : ''}...` })
    try {
      if (!entries.length) throw new Error(inputMode === 'id' ? '请至少输入一个商品 ID。' : '请粘贴至少一个商品链接。')
      if (entries.length > 30) throw new Error('单次最多添加 30 个商品。')
      if (inputMode === 'id') {
        const invalidIndex = entries.findIndex((value) => !itemIdFromProductInput(value))
        if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 行不是有效的 6 至 20 位商品 ID。`)
      }
      for (const value of urls) {
        normalizeProductUrl(value)
      }
      const available = sessions.some((session) => (session.enabled ?? session.active) && session.loginStatus !== 'expired' && (session.accountType || 'normal') === accountType)
      if (!available) {
        onRequireAuth(accountType)
        throw new Error(`尚未授权${accountType === 'gift' ? '礼金' : accountType === 'vip88' ? '88VIP' : '普通'}账号。`)
      }
      const result = await onRun({ urls, group: '默认分组', accountType, captureBuyerShows, captureMediaAssets })
      if (inputMode === 'id') setRawIds('')
      else setRawLinks('')
      setStatus({ tone: result.failed ? 'error' : 'success', message: result.message })
    } catch (caught) { setStatus({ tone: 'error', message: caught instanceof Error ? caught.message : '批量添加失败' }) }
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex min-h-[78px] flex-row items-start justify-between gap-4">
        <div><CardTitle className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-blue-600" />批量添加并抓取</CardTitle><div className="mt-1 text-sm text-slate-500">批量输入商品 ID 或链接；同一账号按顺序抓取，不同账号自动并行。</div></div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex rounded-md bg-slate-100 p-1" aria-label="批量输入方式">
            <button type="button" onClick={() => setInputMode('link')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${inputMode === 'link' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Link2 className="h-3.5 w-3.5" />商品链接</button>
            <button type="button" onClick={() => setInputMode('id')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${inputMode === 'id' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Hash className="h-3.5 w-3.5" />商品 ID</button>
          </div>
          <Badge className="border-blue-100 bg-blue-50 text-blue-700">{entries.length}/30 条</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {inputMode === 'link' ? (
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">新商品链接
            <Textarea className="min-h-20 resize-y font-mono" value={rawLinks} onChange={(event) => setRawLinks(event.target.value.split(/\r?\n/).map(normalizeProductUrlIfPossible).join('\n'))} onBlur={() => setRawLinks(urls.join('\n'))} placeholder={'https://detail.tmall.com/item.htm?id=...\nhttps://item.taobao.com/item.htm?id=...'} />
            <span className="min-h-5 text-xs font-normal leading-5 text-slate-500">一行一个链接，系统会自动清理无用的跟踪参数并去重。</span>
          </label>
        ) : (
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center justify-between gap-3">商品 ID（一行一个）
              <span className="inline-flex rounded-md bg-slate-100 p-1" aria-label="批量商品平台">
                {(['tmall', 'taobao'] as const).map((item) => <button key={item} type="button" onClick={() => setPlatform(item)} className={`rounded px-3 py-1 text-xs font-medium ${platform === item ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item === 'tmall' ? '天猫' : '淘宝'}</button>)}
              </span>
            </span>
            <Textarea className="min-h-20 resize-y font-mono tabular-nums" value={rawIds} onChange={(event) => setRawIds(event.target.value)} inputMode="numeric" placeholder={'1033688812571\n1062991546966'} />
            <span className="min-h-5 text-xs font-normal leading-5 text-slate-500">只输入数字即可，系统会统一补全{platform === 'tmall' ? '天猫' : '淘宝'}商品地址。</span>
          </label>
        )}
        <fieldset className="mt-1 grid gap-2">
          <legend className="text-sm font-medium text-slate-700">账号选择</legend>
          <div className="grid grid-cols-3 gap-2">
          {[{ type: 'normal' as const, label: '普通账号', icon: UserRound }, { type: 'gift' as const, label: '礼金账号', icon: Gift }, { type: 'vip88' as const, label: '88VIP账号', icon: Crown }].map((option) => {
            const count = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === option.type).length
            return <button key={option.type} type="button" onClick={() => setAccountType(option.type)} className={`flex h-12 items-center justify-center gap-2 rounded-md border px-2 text-xs ${accountType === option.type ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /><span className="font-medium">{option.label.replace('账号', '')}</span><span className="text-[11px] opacity-65">{count || '未授权'}</span></button>
          })}
          </div>
        </fieldset>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md bg-slate-50 px-3 text-sm text-slate-700">
            <input type="checkbox" checked={captureMediaAssets} onChange={(event) => setCaptureMediaAssets(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            <Archive className="h-4 w-4 shrink-0 text-slate-500" />
            <span><span className="block font-medium">抓取完整素材</span><span className="block text-xs text-slate-400">750 主图、详情图、视频</span></span>
          </label>
          <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md bg-slate-50 px-3 text-sm text-slate-700">
            <input type="checkbox" checked={captureBuyerShows} onChange={(event) => setCaptureBuyerShows(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            <Images className="h-4 w-4 shrink-0 text-slate-500" />
            <span><span className="block font-medium">同时抓取买家秀</span><span className="block text-xs text-slate-400">整批统一，独立可选</span></span>
          </label>
        </div>
        <div className="mt-auto grid gap-2 pt-1"><Button type="button" onClick={submit} disabled={busy || entries.length === 0} className="w-full"><Play className="h-4 w-4" />{busy ? '队列抓取中' : `添加并抓取 ${entries.length} 个`}</Button>{status && <div className={`flex min-w-0 items-center gap-1.5 text-xs ${status.tone === 'progress' ? 'text-blue-700' : status.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`} role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{status.tone === 'progress' ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : status.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}<span className="line-clamp-2">{status.message}</span></div>}</div>
      </CardContent>
    </Card>
  )
}
