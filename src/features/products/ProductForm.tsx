import { useState } from 'react'
import { Crown, Gift, Link2, Plus, UserRound } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { normalizeProductUrl, normalizeProductUrlIfPossible } from '../../lib/productUrl'
import type { AuthSession } from '../../types/domain'

type Props = {
  sessions: AuthSession[]
  onAdd: (payload: { name: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88' }) => Promise<void>
}

export function ProductForm({ sessions, onAdd }: Props) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [group, setGroup] = useState('核心竞品')
  const [accountType, setAccountType] = useState<'normal' | 'gift' | 'vip88'>('normal')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setFormError('')
    setSubmitting(true)
    try {
      const normalizedUrl = normalizeProductUrl(url)
      const available = sessions.some((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === accountType)
      if (!available) throw new Error(`尚未授权${accountType === 'gift' ? '礼金' : accountType === 'vip88' ? '88VIP' : '普通'}账号，请先到账号授权页面登录。`)
      await onAdd({ name, url: normalizedUrl, group, accountType })
      setName('')
      setUrl('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '添加失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="h-full">
      <CardHeader className="h-[89px]">
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-emerald-600" />
          添加天猫商品链接
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            商品链接
            <Input value={url} onChange={(event) => setUrl(normalizeProductUrlIfPossible(event.target.value))} onBlur={() => setUrl((value) => normalizeProductUrlIfPossible(value))} placeholder="https://detail.tmall.com/item.htm?id=..." required />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            商品简称
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：烤箱竞品 A" required />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            分组
            <Input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="核心竞品" />
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-slate-700">账号选择</legend>
            <div className="grid grid-cols-3 gap-2">
              {[
                { type: 'normal' as const, label: '普通账号', icon: UserRound, color: 'sky' },
                { type: 'gift' as const, label: '礼金账号', icon: Gift, color: 'amber' },
                { type: 'vip88' as const, label: '88VIP账号', icon: Crown, color: 'violet' },
              ].map((option) => {
                const count = sessions.filter((session) => (session.enabled ?? session.active) && (session.accountType || 'normal') === option.type).length
                const selected = accountType === option.type
                const selectedClass = option.color === 'amber' ? 'border-amber-300 bg-amber-50 text-amber-800' : option.color === 'violet' ? 'border-violet-300 bg-violet-50 text-violet-800' : 'border-sky-300 bg-sky-50 text-sky-800'
                return (
                  <button key={option.type} type="button" onClick={() => setAccountType(option.type)} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-2 py-2 text-xs ${selected ? selectedClass : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                    <option.icon className="h-4 w-4" />
                    <span className="font-medium">{option.label}</span>
                    <span className="text-[10px] opacity-70">{count ? `${count} 个已授权` : '未授权'}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
          <Button type="submit" disabled={submitting}>
            <Plus className="h-4 w-4" />
            {submitting ? '添加并抓取中' : '添加并立即抓取'}
          </Button>
          {formError && <p className="text-xs leading-5 text-red-600">{formError}</p>}
        </form>
      </CardContent>
    </Card>
  )
}
