import { CircleAlert, CircleCheck, Crown, Gift, Layers3, LoaderCircle, Play, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input, Textarea } from '../../components/ui/input'
import { normalizeProductUrl, normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { AuthSession } from '../../types/domain'

type Payload = { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88' }

type Props = {
  sessions: AuthSession[]
  busy: boolean
  onRun: (payload: Payload) => Promise<void>
}

export function BatchCaptureCard({ sessions, busy, onRun }: Props) {
  const [rawUrls, setRawUrls] = useState('')
  const [group, setGroup] = useState('核心竞品')
  const [accountType, setAccountType] = useState<Payload['accountType']>('normal')
  const [status, setStatus] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)
  const urls = useMemo(() => [...new Set(rawUrls.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(normalizeProductUrlIfPossible))], [rawUrls])

  async function submit() {
    setStatus({ tone: 'progress', message: `正在创建并抓取 ${urls.length} 个商品...` })
    try {
      if (!urls.length) throw new Error('请粘贴至少一个商品链接。')
      if (urls.length > 30) throw new Error('单次最多添加 30 个商品链接。')
      for (const value of urls) {
        normalizeProductUrl(value)
      }
      const available = sessions.some((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === accountType)
      if (!available) throw new Error(`尚未授权${accountType === 'gift' ? '礼金' : accountType === 'vip88' ? '88VIP' : '普通'}账号。`)
      await onRun({ urls, group, accountType })
      setRawUrls('')
      setStatus({ tone: 'success', message: '批量商品已创建，抓取结果已更新。' })
    } catch (caught) { setStatus({ tone: 'error', message: caught instanceof Error ? caught.message : '批量添加失败' }) }
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex min-h-[78px] flex-row items-start justify-between gap-4"><div><CardTitle className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-blue-600" />批量添加并抓取</CardTitle><div className="mt-1 text-sm text-slate-500">粘贴新商品链接，一行一个；按队列自动识别标题、店铺、型号和 SKU。</div></div><Badge className="border-blue-100 bg-blue-50 text-blue-700">{urls.length}/30 条</Badge></CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <label className="grid gap-1 text-sm font-medium text-slate-700">新商品链接
          <Textarea className="min-h-20 resize-y font-mono" value={rawUrls} onChange={(event) => setRawUrls(event.target.value.split(/\r?\n/).map(normalizeProductUrlIfPossible).join('\n'))} onBlur={() => setRawUrls(urls.join('\n'))} placeholder={'https://detail.tmall.com/item.htm?id=...\nhttps://item.taobao.com/item.htm?id=...'} />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">统一分组<Input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
        <fieldset className="mt-1 grid gap-2">
          <legend className="text-sm font-medium text-slate-700">账号选择</legend>
          <div className="grid grid-cols-3 gap-2">
          {[{ type: 'normal' as const, label: '普通账号', icon: UserRound }, { type: 'gift' as const, label: '礼金账号', icon: Gift }, { type: 'vip88' as const, label: '88VIP账号', icon: Crown }].map((option) => {
            const count = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === option.type).length
            return <button key={option.type} type="button" onClick={() => setAccountType(option.type)} className={`flex h-12 items-center justify-center gap-2 rounded-md border px-2 text-xs ${accountType === option.type ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /><span className="font-medium">{option.label.replace('账号', '')}</span><span className="text-[11px] opacity-65">{count || '未授权'}</span></button>
          })}
          </div>
        </fieldset>
        <div className="mt-auto flex items-center gap-3 pt-1"><Button type="button" onClick={submit} disabled={busy || urls.length === 0} className="min-w-44"><Play className="h-4 w-4" />{busy ? '队列抓取中' : `添加并抓取 ${urls.length} 个`}</Button>{status && <div className={`flex min-w-0 items-center gap-1.5 text-xs ${status.tone === 'progress' ? 'text-blue-700' : status.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`} role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{status.tone === 'progress' ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : status.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}<span className="line-clamp-2">{status.message}</span></div>}</div>
      </CardContent>
    </Card>
  )
}
