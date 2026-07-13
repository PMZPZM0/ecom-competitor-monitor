import { Crown, Gift, Layers3, Play, UserRound } from 'lucide-react'
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
  const [error, setError] = useState('')
  const urls = useMemo(() => [...new Set(rawUrls.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(normalizeProductUrlIfPossible))], [rawUrls])

  async function submit() {
    setError('')
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : '批量添加失败') }
  }

  return (
    <Card className="h-full">
      <CardHeader className="flex h-[89px] flex-row items-start justify-between gap-4"><div><CardTitle className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-sky-600" />批量添加并抓取</CardTitle><div className="mt-1 text-sm text-slate-500">粘贴新商品链接，一行一个；自动识别商品标题、店铺、型号和 SKU。</div></div><Badge className="border-sky-100 bg-sky-50 text-sky-700">{urls.length}/30 条</Badge></CardHeader>
      <CardContent className="grid gap-3">
        <label className="grid gap-1 text-sm font-medium text-slate-700">新商品链接
          <Textarea className="min-h-28 resize-y" value={rawUrls} onChange={(event) => setRawUrls(event.target.value.split(/\r?\n/).map(normalizeProductUrlIfPossible).join('\n'))} onBlur={() => setRawUrls(urls.join('\n'))} placeholder={'https://detail.tmall.com/item.htm?id=...\nhttps://item.taobao.com/item.htm?id=...'} />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">统一分组<Input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
        <fieldset className="mt-1 grid gap-2">
          <legend className="text-sm font-medium text-slate-700">账号选择</legend>
          <div className="grid grid-cols-3 gap-2">
          {[{ type: 'normal' as const, label: '普通账号', icon: UserRound }, { type: 'gift' as const, label: '礼金账号', icon: Gift }, { type: 'vip88' as const, label: '88VIP账号', icon: Crown }].map((option) => {
            const count = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === option.type).length
            return <button key={option.type} type="button" onClick={() => setAccountType(option.type)} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 text-xs ${accountType === option.type ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /><span className="font-medium">{option.label}</span><span className="text-[10px] opacity-70">{count ? `${count} 个已授权` : '未授权'}</span></button>
          })}
          </div>
        </fieldset>
        <Button type="button" onClick={submit} disabled={busy || urls.length === 0}><Play className="h-4 w-4" />{busy ? '批量创建并抓取中' : `添加并抓取 ${urls.length} 个新商品`}</Button>
        {error && <div className="text-xs leading-5 text-red-600">{error}</div>}
      </CardContent>
    </Card>
  )
}
