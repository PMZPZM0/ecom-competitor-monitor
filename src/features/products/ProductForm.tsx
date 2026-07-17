import { useState } from 'react'
import { Archive, CircleAlert, CircleCheck, Crown, Gift, Hash, Images, Link2, LoaderCircle, Plus, Search, UserRound } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { itemIdFromProductInput, normalizeProductUrl, normalizeProductUrlIfPossible, productUrlForItemId, type ProductPlatform } from '../../lib/productUrl'
import type { AuthSession, Product } from '../../types/domain'

type AccountType = 'normal' | 'gift' | 'vip88'
type InputMode = 'link' | 'id'

const accountTypeLabels: Record<AccountType, string> = { normal: '普通', gift: '礼金', vip88: '88VIP' }

function availableCaptureSessions(sessions: AuthSession[]) {
  return sessions.filter((session) => session.source === 'taobao-browser' && (session.enabled ?? session.active) && session.loginStatus !== 'expired')
}

function preferredAccountType(sessions: AuthSession[]): AccountType {
  return (['vip88', 'gift', 'normal'] as const).find((type) => sessions.some((session) => (session.accountType || 'normal') === type)) || 'normal'
}

type Props = {
  sessions: AuthSession[]
  onAdd: (payload: { name?: string; url: string; group?: string; accountType: AccountType; captureBuyerShows: boolean; captureMediaAssets: boolean }) => Promise<Product | void>
  onRequireAuth: (accountType: AccountType) => void
}

export function ProductForm({ sessions, onAdd, onRequireAuth }: Props) {
  const availableSessions = availableCaptureSessions(sessions)
  const fallbackAccountType = preferredAccountType(availableSessions)
  const [inputMode, setInputMode] = useState<InputMode>('link')
  const [platform, setPlatform] = useState<ProductPlatform>('tmall')
  const [linkInput, setLinkInput] = useState('')
  const [idInput, setIdInput] = useState('')
  const [accountType, setAccountType] = useState<AccountType>(() => fallbackAccountType)
  const [captureBuyerShows, setCaptureBuyerShows] = useState(false)
  const [captureMediaAssets, setCaptureMediaAssets] = useState(false)
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
    setStatus({ tone: 'progress', message: `正在后台打开商品，采集价格、800 主图和 SKU 图${captureMediaAssets ? '、完整素材' : ''}${captureBuyerShows ? '、买家秀' : ''}；采集完成后会脱敏保存并从本地文件解析...` })
    try {
      const productInput = inputMode === 'id' ? idInput : linkInput
      const itemId = itemIdFromProductInput(productInput)
      if (!itemId) throw new Error('请输入 6 至 20 位商品 ID，或粘贴淘宝/天猫商品链接。')
      const normalizedUrl = inputMode === 'id' ? productUrlForItemId(itemId, platform) : normalizeProductUrl(productInput)
      if (!availableSessions.length) {
        onRequireAuth(accountType)
        throw new Error('尚未授权可用的淘宝扫码账号，请先到账号授权页面登录。')
      }
      const added = await onAdd({ url: normalizedUrl, accountType, captureBuyerShows, captureMediaAssets })
      if (inputMode === 'id') setIdInput('')
      else setLinkInput('')
      const snapshot = added?.lastSnapshot
      setStatus(snapshot?.browserEvidenceFile && snapshot.localFirst?.parsedFromDisk
        ? { tone: 'success', message: `自动采集完成，数据已脱敏保存并从本地文件解析：${snapshot.browserEvidenceFile}` }
        : snapshot?.localImportError
        ? { tone: 'error', message: `后台采集已完成，但本地证据保存或读盘解析失败：${snapshot.localImportError}` }
        : { tone: 'success', message: snapshot?.localImportFile ? `自动采集完成，证据已脱敏保存并从本地文件解析：${snapshot.localImportFile}` : '自动采集与解析完成，结果已更新到下方列表。' })
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof Error ? error.message : '添加失败' })
    } finally {
      setSubmitting(false)
    }
  }

  const productInput = inputMode === 'id' ? idInput : linkInput
  const itemId = itemIdFromProductInput(productInput)

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="min-h-[78px]">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2"><Search className="h-4 w-4 text-blue-600" />添加监控商品</CardTitle>
          <div className="mt-1 text-sm leading-5 text-slate-500">输入链接或商品 ID，软件会使用已授权账号在后台打开商品；采集结果先脱敏保存到本机，再从本地文件解析。</div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <form className="flex h-full flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-2 border-b border-slate-100 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="text-sm font-semibold text-slate-800">自动采集 + 本地解析</div><div className="mt-0.5 text-xs text-slate-500">使用已授权账号在后台打开商品页；每个账号视角可能分别访问</div></div>
            <div className="inline-flex w-full rounded-md bg-slate-100 p-1 sm:w-auto" aria-label="自动采集输入方式">
              <button type="button" onClick={() => setInputMode('link')} className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded px-3 text-xs font-medium ${inputMode === 'link' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Link2 className="h-3.5 w-3.5" />商品链接</button>
              <button type="button" onClick={() => setInputMode('id')} className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded px-3 text-xs font-medium ${inputMode === 'id' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Hash className="h-3.5 w-3.5" />商品 ID</button>
            </div>
          </div>
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
                  <Input value={idInput} onChange={(event) => setIdInput(event.target.value)} className="pl-9 font-mono tabular-nums" inputMode="numeric" placeholder="输入纯数字 ID" required />
                </div>
                <div className="inline-flex rounded-md bg-slate-100 p-1" aria-label="商品平台">
                  {(['tmall', 'taobao'] as const).map((item) => <button key={item} type="button" onClick={() => setPlatform(item)} className={`flex-1 rounded px-2 text-xs font-medium ${platform === item ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item === 'tmall' ? '天猫' : '淘宝'}</button>)}
                </div>
              </div>
              <span className="min-h-5 text-xs font-normal leading-5 text-slate-500">只输入数字即可，系统会在后台自动补全{platform === 'tmall' ? '天猫' : '淘宝'}商品地址。</span>
            </label>
          )}
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-slate-700">主价格视角 / 监控来源</legend>
            <div className="grid grid-cols-3 gap-2">
              {[
                { type: 'normal' as const, label: '普通', icon: UserRound },
                { type: 'gift' as const, label: '礼金', icon: Gift },
                { type: 'vip88' as const, label: '88VIP', icon: Crown },
              ].map((option) => {
                const optionSessions = availableSessions.filter((session) => (session.accountType || 'normal') === option.type)
                const healthyCount = optionSessions.filter((session) => session.healthStatus !== 'degraded').length
                const stateText = healthyCount ? `${healthyCount} 可用` : optionSessions.length ? `${optionSessions.length} 待复检` : '未在线'
                const selected = accountType === option.type
                return <button key={option.type} type="button" aria-pressed={selected} onClick={() => setAccountType(option.type)} className={`flex h-12 items-center justify-center gap-2 rounded-md border px-2 text-xs ${selected ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /><span className="font-medium">{option.label}</span><span className="text-[11px] opacity-65">{stateText}</span></button>
              })}
            </div>
            <div className="min-h-5 text-xs leading-5 text-slate-500">
              {availableSessions.length && !availableSessions.some((session) => (session.accountType || 'normal') === accountType)
                ? `${accountTypeLabels[accountType]}视角暂无在线账号；本次会自动使用能力最完整的${accountTypeLabels[fallbackAccountType]}账号，并将它设为监控来源。`
                : '同一账号会尽量抓取其可见的全部价格；该选择决定商品的主价格视角和监控来源。'}
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
              <span><span className="block font-medium">同时抓取买家秀</span><span className="block text-xs text-slate-400">独立可选，会增加时间</span></span>
            </label>
          </div>
          <div className="mt-auto grid gap-2 pt-1">
            <Button type="submit" disabled={submitting || !itemId} className="w-full"><Plus className="h-4 w-4" />{submitting ? '自动采集与解析中' : '自动采集并本地解析'}</Button>
            {status && <div className={`flex min-w-0 items-start gap-1.5 text-xs leading-5 ${status.tone === 'progress' ? 'text-blue-700' : status.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`} role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{status.tone === 'progress' ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : status.tone === 'success' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}<span className="min-w-0 break-all">{status.message}</span></div>}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
