import { CheckCircle2, Clipboard, Crown, Download, Eye, Gift, LoaderCircle, ShieldCheck, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { api } from '../../lib/api'
import type { AuthSession, RawDataCaptureResult } from '../../types/domain'

type AccountType = 'normal' | 'gift' | 'vip88'
type Platform = 'tmall' | 'taobao'

export type RawDataViewerSeed = {
  itemId: string
  platform: Platform
  accountType: AccountType
}

type Props = {
  open: boolean
  dataDir?: string
  sessions: AuthSession[]
  initial: RawDataViewerSeed
  onClose: () => void
  onOpenAuth: () => void
}

const accountOptions = [
  { value: 'normal' as const, label: '普通账号', icon: UserRound },
  { value: 'gift' as const, label: '礼金账号', icon: Gift },
  { value: 'vip88' as const, label: '88VIP账号', icon: Crown },
]

const accountLabels: Record<AccountType, string> = {
  normal: '普通账号',
  gift: '礼金账号',
  vip88: '88VIP账号',
}

function sessionAccountType(session: AuthSession): AccountType {
  return session.accountType || 'normal'
}

function availableBrowserSessions(sessions: AuthSession[]) {
  return sessions.filter((session) => session.source === 'taobao-browser'
    && Boolean(session.browserProfileKey && session.browserPort)
    && (session.enabled ?? session.active)
    && session.loginStatus !== 'expired')
}

function captureSessionFor(sessions: AuthSession[], accountType: AccountType) {
  const available = availableBrowserSessions(sessions)
  return available.find((session) => sessionAccountType(session) === accountType)
    || (['vip88', 'gift', 'normal'] as const).map((type) => available.find((session) => sessionAccountType(session) === type)).find(Boolean)
}

function absoluteLocalPath(dataDir: string | undefined, file: string) {
  if (!file || !dataDir || /^(?:[a-z]:[\\/]|\/)/i.test(file)) return file
  const separator = dataDir.includes('\\') ? '\\' : '/'
  return `${dataDir.replace(/[\\/]+$/, '')}${separator}${file.replace(/[\\/]/g, separator)}`
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function RawDataViewerDialog({ open, dataDir, sessions, initial, onClose, onOpenAuth }: Props) {
  const [itemId, setItemId] = useState(initial.itemId)
  const [platform, setPlatform] = useState<Platform>(initial.platform)
  const [accountType, setAccountType] = useState<AccountType>(initial.accountType)
  const [capturing, setCapturing] = useState(false)
  const [result, setResult] = useState<RawDataCaptureResult | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)

  const close = useCallback(() => {
    if (!capturing) onClose()
  }, [capturing, onClose])

  useEffect(() => {
    if (!open) return
    setItemId(initial.itemId)
    setPlatform(initial.platform)
    setAccountType(initial.accountType)
    setResult(null)
    setError('')
    setCopied(false)
  }, [initial.accountType, initial.itemId, initial.platform, open])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => previousFocus?.focus())
    }
  }, [close, open])

  function updateItemId(value: string) {
    setItemId(value.replace(/\D/g, '').slice(0, 20))
    setResult(null)
    setError('')
    setCopied(false)
  }

  async function capture() {
    if (!/^\d{6,20}$/.test(itemId)) {
      setError('请输入 6 至 20 位数字商品 ID。')
      return
    }
    const session = captureSessionFor(sessions, accountType)
    if (!session) {
      setError('没有可用的扫码账号，请先完成账号授权和登录检测。')
      return
    }
    setCapturing(true)
    setResult(null)
    setError('')
    setCopied(false)
    try {
      setResult(await api.captureRawData({ sessionId: session.id, itemId, platform }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '脱敏数据获取失败，请检测账号后重试。')
    } finally {
      setCapturing(false)
    }
  }

  async function copyJson() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.jsonText)
      setCopied(true)
    } catch {
      setError('系统没有授予剪贴板权限，请使用“下载 JSON”。')
    }
  }

  function downloadJson() {
    if (!result) return
    const url = URL.createObjectURL(new Blob([result.jsonText], { type: 'application/json;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `商品_${result.itemId}_脱敏数据_${result.capturedAt.slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (!open) return null

  const captureSession = captureSessionFor(sessions, accountType)
  const actualAccountType = captureSession ? sessionAccountType(captureSession) : null
  const usingFallback = Boolean(actualAccountType && actualAccountType !== accountType)
  const previewLimit = 160_000
  const previewText = result && result.jsonText.length > previewLimit
    ? `${result.jsonText.slice(0, previewLimit)}\n\n... 界面仅预览前 ${formatBytes(previewLimit)}，复制和下载仍包含完整数据。`
    : result?.jsonText || ''
  const sourceFile = absoluteLocalPath(dataDir, result?.sourceFile || '')

  return createPortal(
    <div className="fixed inset-0 z-[125] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-[1px] sm:p-6" role="presentation" onMouseDown={close}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="raw-data-viewer-title" aria-busy={capturing} className="flex h-[100dvh] max-h-[100dvh] w-full max-w-6xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[calc(100dvh-3rem)] sm:max-h-[900px] sm:rounded-md" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700"><Eye className="h-4 w-4" /></span>
            <div className="min-w-0">
              <h2 id="raw-data-viewer-title" className="text-base font-semibold text-slate-950">脱敏数据查看器</h2>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">检查、复制或下载本地解析出的价格证据，不建立监控商品。</p>
            </div>
          </div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" onClick={close} disabled={capturing} title="关闭数据查看器" aria-label="关闭数据查看器"><X className="h-4 w-4" /></button>
        </header>

        <div className="flex shrink-0 items-start gap-2.5 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 sm:px-5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <p><strong>只读工具：</strong>本次会真实打开一次商品页并保存脱敏证据，但不会新增或修改商品，不会进入抓取/监控队列，也不会触发飞书。</p>
        </div>

        <div className="grid shrink-0 gap-3 border-b border-slate-200 px-4 py-4 sm:grid-cols-[minmax(220px,1fr)_128px_minmax(300px,1.15fr)_auto] sm:items-end sm:px-5">
          <label className="grid gap-1.5 text-xs font-medium text-slate-700">商品 ID
            <Input autoFocus value={itemId} onChange={(event) => updateItemId(event.target.value)} inputMode="numeric" className="font-mono tabular-nums" placeholder="输入 6-20 位数字" disabled={capturing} />
          </label>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-slate-700">商品平台</span>
            <div className="grid h-10 grid-cols-2 rounded-md bg-slate-100 p-1">
              {(['tmall', 'taobao'] as const).map((value) => <button key={value} type="button" aria-pressed={platform === value} onClick={() => { setPlatform(value); setResult(null) }} disabled={capturing} className={`rounded text-xs font-medium transition ${platform === value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{value === 'tmall' ? '天猫' : '淘宝'}</button>)}
            </div>
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-xs font-medium text-slate-700">账号视角</legend>
            <div className="grid h-10 grid-cols-3 rounded-md bg-slate-100 p-1">
              {accountOptions.map((option) => <button key={option.value} type="button" aria-pressed={accountType === option.value} onClick={() => { setAccountType(option.value); setResult(null) }} disabled={capturing} className={`inline-flex items-center justify-center gap-1 rounded text-xs font-medium transition ${accountType === option.value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><option.icon className="h-3.5 w-3.5" /><span className="hidden lg:inline">{option.label}</span><span className="lg:hidden">{option.value === 'vip88' ? '88VIP' : option.value === 'gift' ? '礼金' : '普通'}</span></button>)}
            </div>
          </fieldset>
          <Button type="button" onClick={() => void capture()} disabled={capturing || !captureSession || !/^\d{6,20}$/.test(itemId)} className="w-full sm:w-auto">{capturing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}{capturing ? '正在获取' : '获取脱敏数据'}</Button>
        </div>

        <div className={`shrink-0 px-4 py-2.5 text-xs leading-5 sm:px-5 ${!captureSession || error ? 'bg-red-50 text-red-700' : usingFallback ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`} role={error ? 'alert' : 'status'} aria-live="polite">
          {error || (!captureSession
            ? <span>没有可用扫码账号。<button type="button" className="ml-1 font-semibold underline underline-offset-2" onClick={onOpenAuth}>去账号授权</button></span>
            : usingFallback
              ? `没有在线的${accountLabels[accountType]}，本次将使用${accountLabels[actualAccountType!]}“${captureSession.name}”，结果按实际账号标记。`
              : `将使用“${captureSession.name}”获取${accountLabels[accountType]}视角的数据。`)}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-4 py-4 sm:px-5">
          {capturing && <div className="flex h-full min-h-72 flex-col items-center justify-center text-center" role="status"><LoaderCircle className="h-8 w-8 animate-spin text-blue-600" /><div className="mt-3 text-sm font-semibold text-slate-800">正在后台加载并脱敏</div><div className="mt-1 text-xs text-slate-500">完成前不会写入商品库。</div></div>}
          {!capturing && !result && <div className="flex h-full min-h-72 flex-col items-center justify-center text-center"><Eye className="h-9 w-9 text-slate-300" /><div className="mt-3 text-sm font-semibold text-slate-700">尚未获取数据</div><div className="mt-1 text-xs text-slate-500">输入商品 ID 后获取只读证据。</div></div>}
          {!capturing && result && (
            <div className="mx-auto max-w-5xl">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-900">价格证据 JSON</h3><Badge className="border-emerald-200 bg-emerald-50 text-emerald-700"><CheckCircle2 className="mr-1 h-3.5 w-3.5" />已脱敏</Badge></div>
                  <div className="mt-1 break-all text-[11px] leading-5 text-slate-500" title={sourceFile}>本地证据：{sourceFile}</div>
                </div>
                <div className="flex shrink-0 gap-2"><Button type="button" size="sm" variant="secondary" onClick={() => void copyJson()}><Clipboard className="h-4 w-4" />{copied ? '已复制' : '复制完整 JSON'}</Button><Button type="button" size="sm" onClick={downloadJson}><Download className="h-4 w-4" />下载 JSON</Button></div>
              </div>
              <div className="mt-3 grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200 bg-white py-3 text-center">
                <div><div className="text-[11px] text-slate-400">商品 ID</div><div className="mt-1 truncate px-2 font-mono text-sm font-semibold text-slate-900">{result.itemId}</div></div>
                <div><div className="text-[11px] text-slate-400">已验证 SKU</div><div className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">{result.verifiedSkuCount}</div></div>
                <div><div className="text-[11px] text-slate-400">数据大小</div><div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatBytes(result.byteSize)}</div></div>
              </div>
              <pre className="mt-3 max-h-[52dvh] overflow-auto border border-slate-200 bg-white p-3 font-mono text-[11px] leading-5 text-slate-700" tabIndex={0}>{previewText}</pre>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}
