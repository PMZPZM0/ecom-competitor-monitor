import { useState } from 'react'
import { CircleAlert, CircleCheck, Crown, Gift, Hash, Images, Link2, LoaderCircle, Plus, Search, UserRound } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { normalizeProductUrl, normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { AuthSession } from '../../types/domain'

type AccountType = 'normal' | 'gift' | 'vip88'
type Platform = 'tmall' | 'taobao'
type InputMode = 'link' | 'id'

type Props = {
  sessions: AuthSession[]
  onAdd: (payload: { name?: string; url: string; group?: string; accountType: AccountType; captureBuyerShows: boolean }) => Promise<void>
}

const prefixes: Record<Platform, string> = {
  tmall: 'https://detail.tmall.com/item.htm?id=',
  taobao: 'https://item.taobao.com/item.htm?id=',
}

function itemIdFromInput(value: string) {
  return value.trim().match(/^\d{6,20}$/)?.[0]
    || value.match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})/i)?.[1]
    || ''
}

export function ProductForm({ sessions, onAdd }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>('link')
  const [platform, setPlatform] = useState<Platform>('tmall')
  const [linkInput, setLinkInput] = useState('')
  const [idInput, setIdInput] = useState('')
  const [group, setGroup] = useState('核心竞品')
  const [accountType, setAccountType] = useState<AccountType>('normal')
  const [captureBuyerShows, setCaptureBuyerShows] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<{ tone: 'progress' | 'success' | 'error'; message: string } | null>(null)

  function updateLinkInput(value: string) {
    const trimmed = value.trim()
    if (/taobao\.com/i.test(trimmed)) setPlatform('taobao')
    if (/tmall\.com/i.test(trimmed)) setPlatform('tmall')
    setLinkInput(value)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setStatus({ tone: 'progress', message: captureBuyerShows ? '正在创建商品并抓取价格、素材和买家秀...' : '正在创建商品并抓取价格与素材...' })
    try {
      const productInput = inputMode === 'id' ? idInput : linkInput
      const itemId = itemIdFromInput(productInput)
      if (!itemId) throw new Error('请输入 6 至 20 位商品 ID，或粘贴淘宝/天猫商品链接。')
      const normalizedUrl = normalizeProductUrl(inputMode === 'id' ? `${prefixes[platform]}${itemId}` : productInput)
      const available = sessions.some((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === accountType)
      if (!available) throw new Error(`尚未授权${accountType === 'gift' ? '礼金' : accountType === 'vip88' ? '88VIP' : '普通'}账号，请先到账号授权页面登录。`)
      await onAdd({ url: normalizedUrl, group, accountType, captureBuyerShows })
      if (inputMode === 'id') setIdInput('')
      else setLinkInput('')
      setStatus({ tone: 'success', message: '商品已添加，首次抓取结果已更新到下方列表。' })
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : '添加失败' })
    } finally {
      setSubmitting(false)
    }
  }

  const productInput = inputMode === 'id' ? idInput : linkInput
  const itemId = itemIdFromInput(productInput)

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex min-h-[78px] flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2"><Search className="h-4 w-4 text-blue-600" />单个商品抓取</CardTitle>
          <div className="mt-1 text-sm text-slate-500">输入商品 ID 或粘贴链接，标题、店铺和型号由抓取结果自动识别。</div>
        </div>
        <div className="inline-flex shrink-0 rounded-md bg-slate-100 p-1" aria-label="输入方式">
          <button type="button" onClick={() => setInputMode('link')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${inputMode === 'link' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Link2 className="h-3.5 w-3.5" />商品链接</button>
          <button type="button" onClick={() => setInputMode('id')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${inputMode === 'id' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Hash className="h-3.5 w-3.5" />商品 ID</button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <form className="flex h-full flex-col gap-3" onSubmit={submit}>
          {inputMode === 'link' ? (
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              淘宝 / 天猫商品链接
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={linkInput}
                  onChange={(event) => updateLinkInput(event.target.value)}
                  onBlur={() => setLinkInput(normalizeProductUrlIfPossible(linkInput))}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData('text')
                    if (!/https?:\/\//i.test(pasted)) return
                    event.preventDefault()
                    updateLinkInput(normalizeProductUrlIfPossible(pasted))
                  }}
                  className="pl-9"
                  placeholder="粘贴淘宝或天猫商品链接"
                  required
                />
              </div>
              <span className="min-h-5 text-xs font-normal leading-5 text-slate-500">{itemId ? `已识别商品 ID ${itemId}，链接中的跟踪参数已自动清理。` : '粘贴长链接后，系统只保留商品地址和商品 ID。'}</span>
            </label>
          ) : (
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              商品 ID
              <div className="grid grid-cols-[minmax(0,1fr)_124px] gap-2">
                <div className="relative">
                  <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input value={idInput} onChange={(event) => setIdInput(event.target.value.replace(/\D/g, '').slice(0, 20))} className="pl-9 font-mono tabular-nums" inputMode="numeric" placeholder="输入纯数字 ID" required />
                </div>
                <div className="inline-flex rounded-md bg-slate-100 p-1" aria-label="商品平台">
                  {(['tmall', 'taobao'] as const).map((item) => <button key={item} type="button" onClick={() => setPlatform(item)} className={`flex-1 rounded px-2 text-xs font-medium ${platform === item ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item === 'tmall' ? '天猫' : '淘宝'}</button>)}
                </div>
              </div>
              <span className="min-h-5 text-xs font-normal leading-5 text-slate-500">只输入数字即可，系统会在后台自动补全{platform === 'tmall' ? '天猫' : '淘宝'}商品地址。</span>
            </label>
          )}
          <label className="grid gap-1 text-sm font-medium text-slate-700">分组<Input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="核心竞品" /></label>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-slate-700">价格账号</legend>
            <div className="grid grid-cols-3 gap-2">
              {[
                { type: 'normal' as const, label: '普通', icon: UserRound },
                { type: 'gift' as const, label: '礼金', icon: Gift },
                { type: 'vip88' as const, label: '88VIP', icon: Crown },
              ].map((option) => {
                const count = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === option.type).length
                const selected = accountType === option.type
                return <button key={option.type} type="button" onClick={() => setAccountType(option.type)} className={`flex h-12 items-center justify-center gap-2 rounded-md border px-2 text-xs ${selected ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /><span className="font-medium">{option.label}</span><span className="text-[11px] opacity-65">{count || '未授权'}</span></button>
              })}
            </div>
          </fieldset>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md bg-slate-50 px-3 text-sm text-slate-700">
            <input type="checkbox" checked={captureBuyerShows} onChange={(event) => setCaptureBuyerShows(event.target.checked)} className="h-4 w-4 accent-blue-600" />
            <Images className="h-4 w-4 text-slate-500" />
            <span className="font-medium">同时抓取买家秀</span>
            <span className="text-xs text-slate-400">可选，会增加抓取时间</span>
          </label>
          <div className="mt-auto flex items-center gap-3 pt-1">
            <Button type="submit" disabled={submitting || !itemId} className="min-w-44"><Plus className="h-4 w-4" />{submitting ? '抓取中' : '添加并立即抓取'}</Button>
            {status && <div className={`flex min-w-0 items-center gap-1.5 text-xs ${status.tone === 'progress' ? 'text-blue-700' : status.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`} role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{status.tone === 'progress' ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : status.tone === 'success' ? <CircleCheck className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}<span className="line-clamp-2">{status.message}</span></div>}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
