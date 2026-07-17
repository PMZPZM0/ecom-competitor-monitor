import { AlertTriangle, CheckCircle2, ClipboardPaste, Crown, FileInput, FolderOpen, Gift, LoaderCircle, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input, Textarea } from '../../components/ui/input'
import { api } from '../../lib/api'
import { currency } from '../../lib/utils'
import type { LocalImportCommitResult, LocalImportPreview } from '../../types/domain'

type AccountType = LocalImportPreview['accountType']

type Props = {
  open: boolean
  dataDir?: string
  initialItemId?: string
  initialAccountType?: AccountType
  onClose: () => void
  onImported: (result: LocalImportCommitResult) => void
}

const MAX_BYTES = 8 * 1024 * 1024
const accountOptions = [
  { value: 'normal' as const, label: '普通账号', icon: UserRound },
  { value: 'gift' as const, label: '礼金账号', icon: Gift },
  { value: 'vip88' as const, label: '88VIP账号', icon: Crown },
]
const inputTypeLabels: Record<LocalImportPreview['inputType'], string> = { json: 'JSON', jsonp: 'JSONP', html: 'HTML', text: '文本' }
const resolutionLabels: Record<LocalImportPreview['resolutionStatus'], string> = { verified: '已验证', partial: '部分验证', ambiguous: '存在歧义', unavailable: '无法解析', legacy: '旧版数据' }

function byteSize(content: string) {
  return new Blob([content]).size
}

function formatSize(bytes: number) {
  if (!bytes) return '0 KB'
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function skuIsVerified(sku: LocalImportPreview['skuPrices'][number]) {
  return sku.priceResolution?.status === 'verified' || sku.resolutionStatus === 'verified'
}

function localFirstVerified(preview: LocalImportPreview | null) {
  return preview?.localFirst?.sourceSaved === true
    && preview.localFirst.sourceSanitized === true
    && preview.localFirst.parsedFromDisk === true
    && preview.localFirst.networkAccessed === false
}

function absoluteLocalPath(dataDir: string | undefined, file: string) {
  if (!file || !dataDir || /^(?:[a-z]:[\\/]|\/)/i.test(file)) return file
  const separator = dataDir.includes('\\') ? '\\' : '/'
  return `${dataDir.replace(/[\\/]+$/, '')}${separator}${file.replace(/[\\/]/g, separator)}`
}

export function LocalImportDialog({ open, dataDir, initialItemId = '', initialAccountType = 'normal', onClose, onImported }: Props) {
  const [content, setContent] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [itemIdHint, setItemIdHint] = useState(initialItemId)
  const [accountType, setAccountType] = useState<AccountType>(initialAccountType)
  const [preview, setPreview] = useState<LocalImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const requestSequence = useRef(0)
  const committingRef = useRef(false)

  const reset = useCallback(() => {
    requestSequence.current += 1
    setContent('')
    setSourceName('')
    setItemIdHint(initialItemId)
    setAccountType(initialAccountType)
    setPreview(null)
    setPreviewing(false)
    setCommitting(false)
    setError('')
    committingRef.current = false
  }, [initialAccountType, initialItemId])

  const finishClose = useCallback(() => {
    reset()
    onClose()
  }, [onClose, reset])

  const close = useCallback(() => {
    if (!committingRef.current) finishClose()
  }, [finishClose])

  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
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
  }, [close, open, reset])

  async function runPreview(rawContent: string, overrides?: { accountType?: AccountType; itemIdHint?: string }) {
    if (!rawContent.trim()) {
      setError('请先粘贴数据，或从本机选择文件。')
      setPreview(null)
      return
    }
    if (byteSize(rawContent) > MAX_BYTES) {
      setError('数据超过 8 MB，请只保留当前商品的数据。')
      setPreview(null)
      return
    }
    const sequence = ++requestSequence.current
    setPreviewing(true)
    setPreview(null)
    setError('')
    try {
      const result = await api.previewLocalImport({ content: rawContent, accountType: overrides?.accountType ?? accountType, itemIdHint: (overrides?.itemIdHint ?? itemIdHint).trim() || undefined })
      if (sequence === requestSequence.current) setPreview(result)
    } catch (caught) {
      if (sequence === requestSequence.current) setError(caught instanceof Error ? caught.message : '本地数据解析失败。')
    } finally {
      if (sequence === requestSequence.current) setPreviewing(false)
    }
  }

  function importText(rawContent: string, name: string) {
    setContent(rawContent)
    setSourceName(name)
    void runPreview(rawContent)
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.getData('text')
    if (!pasted) return
    event.preventDefault()
    const target = event.currentTarget
    const start = target.selectionStart ?? content.length
    const end = target.selectionEnd ?? content.length
    const nextContent = `${content.slice(0, start)}${pasted}${content.slice(end)}`
    importText(nextContent, '粘贴内容')
    requestAnimationFrame(() => target.setSelectionRange(start + pasted.length, start + pasted.length))
  }

  async function readClipboard() {
    const sequence = ++requestSequence.current
    setError('')
    try {
      if (!navigator.clipboard?.readText) throw new Error('当前环境不能读取剪贴板，请直接粘贴到输入框。')
      const clipboardText = await navigator.clipboard.readText()
      if (sequence !== requestSequence.current) return
      if (!clipboardText.trim()) throw new Error('剪贴板中没有可解析的文本。')
      importText(clipboardText, '剪贴板')
    } catch (caught) {
      if (sequence !== requestSequence.current) return
      setError(caught instanceof Error ? caught.message : '读取剪贴板失败，请直接粘贴到输入框。')
    }
  }

  async function readFile(file?: File) {
    if (!file) return
    if (file.size > MAX_BYTES) {
      setError('文件超过 8 MB，请选择更小的 JSON、JSONP、HTML 或 TXT 文件。')
      return
    }
    if (!/\.(json|jsonp|html?|txt)$/i.test(file.name) && !['application/json', 'text/html', 'text/plain'].includes(file.type)) {
      setError('仅支持 JSON、JSONP、HTML 和 TXT 文件。')
      return
    }
    const sequence = ++requestSequence.current
    try {
      const fileContent = await file.text()
      if (sequence === requestSequence.current) importText(fileContent, file.name)
    } catch {
      if (sequence === requestSequence.current) setError('无法读取该文件，请确认文件未被占用后重试。')
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void readFile(event.currentTarget.files?.[0])
    event.currentTarget.value = ''
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    void readFile(event.dataTransfer.files?.[0])
  }

  function selectAccount(nextAccountType: AccountType) {
    setAccountType(nextAccountType)
    if (content.trim()) void runPreview(content, { accountType: nextAccountType })
  }

  async function confirmImport() {
    if (!preview?.canCommit || !localFirstVerified(preview)) return
    committingRef.current = true
    setCommitting(true)
    setError('')
    try {
      onImported(await api.commitLocalImport(preview.importId))
      committingRef.current = false
      finishClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导入失败，请检查预览结果后重试。')
    } finally {
      committingRef.current = false
      setCommitting(false)
    }
  }

  if (!open) return null

  const contentBytes = byteSize(content)
  const busy = previewing || committing
  const localFlowVerified = localFirstVerified(preview)
  const canCommit = Boolean(preview?.canCommit && localFlowVerified)
  const sourceFilePath = absoluteLocalPath(dataDir, preview?.sourceFile || preview?.savedFile || '')
  const parsedFilePath = absoluteLocalPath(dataDir, preview?.savedFile || '')
  const priceText = preview?.priceRange ? `${currency(preview.priceRange[0])} - ${currency(preview.priceRange[1])}` : currency(preview?.price)
  const statusText = error || (committing ? '正在写入暂停商品和价格记录...' : previewing ? '正在脱敏保存、重新读盘并核验...' : preview ? (canCommit ? '核验通过，可导入为暂停商品。' : '价格证据未通过核验，只能预览。') : '等待粘贴或选择已有文件。')

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-0 backdrop-blur-[1px] sm:p-6" role="presentation" onMouseDown={close}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="local-import-title" aria-describedby="local-import-description" aria-busy={busy} className="flex h-[100dvh] max-h-[100dvh] w-full max-w-5xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[calc(100dvh-3rem)] sm:max-h-[900px] sm:rounded-md" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700"><FileInput className="h-4 w-4" /></span>
            <div className="min-w-0"><h2 id="local-import-title" className="text-base font-semibold text-slate-950">手动导入已有数据</h2><p id="local-import-description" className="mt-0.5 text-xs leading-5 text-slate-500">只处理你已经拥有的 JSON、JSONP、HTML 或 TXT 文件。</p></div>
          </div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" onClick={close} disabled={committing} title="关闭手动导入" aria-label="关闭手动导入"><X className="h-4 w-4" /></button>
        </header>

        <div className="flex shrink-0 items-start gap-2.5 bg-sky-50 px-4 py-3 text-xs leading-5 text-sky-950 sm:px-5"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" /><p><strong>普通抓取不需要使用这里。</strong>要直接添加商品，请关闭本窗口后使用“自动采集并本地解析”；这里不会自己打开淘宝页面。</p></div>

        <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(380px,1.05fr)] lg:overflow-hidden">
          <div className="min-w-0 overflow-x-hidden px-4 py-4 sm:px-5 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-slate-200">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(280px,1.15fr)]">
              <label className="grid gap-1.5 text-xs font-medium text-slate-700">商品 ID（可选，用于核对）<Input value={itemIdHint} onChange={(event) => { setItemIdHint(event.target.value.replace(/\D/g, '').slice(0, 20)); setPreview(null); setError('') }} onBlur={() => content.trim() && void runPreview(content)} inputMode="numeric" className="font-mono tabular-nums" placeholder="文件内没有 ID 时再填写" disabled={busy} /></label>
              <fieldset className="grid gap-1.5"><legend className="text-xs font-medium text-slate-700">这份数据的账号视角</legend><div className="grid h-10 grid-cols-3 rounded-md bg-slate-100 p-1">{accountOptions.map((option) => <button key={option.value} type="button" aria-pressed={accountType === option.value} onClick={() => selectAccount(option.value)} disabled={busy} className={`inline-flex items-center justify-center gap-1 rounded text-xs font-medium transition ${accountType === option.value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><option.icon className="h-3.5 w-3.5" /><span className="hidden sm:inline">{option.label}</span><span className="sm:hidden">{option.value === 'vip88' ? '88VIP' : option.value === 'gift' ? '礼金' : '普通'}</span></button>)}</div></fieldset>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2"><Button type="button" onClick={() => void readClipboard()} disabled={busy}><ClipboardPaste className="h-4 w-4" />粘贴剪贴板</Button><Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}><FolderOpen className="h-4 w-4" />选择文件</Button><input ref={fileInputRef} type="file" className="hidden" accept=".json,.jsonp,.html,.htm,.txt,application/json,text/html,text/plain" onChange={handleFileChange} /></div>
            <div className="mt-3" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <Textarea autoFocus value={content} onChange={(event) => { requestSequence.current += 1; setContent(event.target.value); setSourceName('手动输入'); setPreview(null); setPreviewing(false); setError('') }} onPaste={handlePaste} className="min-h-64 resize-y font-mono text-xs leading-5" placeholder="在这里粘贴已有数据，或把文件拖到这里。" spellCheck={false} disabled={busy} />
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-400"><span className="min-w-0 truncate" title={sourceName}>{sourceName || '尚未选择数据'}</span><span className={contentBytes > MAX_BYTES ? 'shrink-0 font-medium text-red-600' : 'shrink-0 tabular-nums'}>{formatSize(contentBytes)} / 8 MB</span></div>
            </div>
            <Button type="button" variant="secondary" className="mt-3 w-full" onClick={() => void runPreview(content)} disabled={!content.trim() || busy}><RefreshCw className={`h-4 w-4 ${previewing ? 'animate-spin' : ''}`} />{previewing ? '保存并解析中' : preview ? '重新保存并解析' : '脱敏保存并解析'}</Button>
            <div className="mt-3 flex items-start gap-2 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" /><span>Cookie、Authorization、token、sign 和账号身份字段会在落盘前移除；导入成功的商品默认暂停。</span></div>
          </div>

          <div className="min-h-[360px] bg-slate-50/60 px-4 py-4 sm:px-5 lg:min-h-0 lg:overflow-y-auto">
            <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-900">解析预览</h3>{preview && <Badge className={canCommit ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}>{canCommit ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <AlertTriangle className="mr-1 h-3.5 w-3.5" />}{canCommit ? '可导入' : '仅预览'}</Badge>}</div>
            {previewing && <div className="mt-16 flex flex-col items-center justify-center text-center" role="status"><LoaderCircle className="h-7 w-7 animate-spin text-blue-600" /><div className="mt-3 text-sm font-medium text-slate-800">正在保存、读回并核验</div></div>}
            {!previewing && !preview && <div className="mt-16 flex flex-col items-center justify-center px-6 text-center"><FileInput className="h-8 w-8 text-slate-300" /><div className="mt-3 text-sm font-medium text-slate-700">等待已有数据</div><div className="mt-1 max-w-xs text-xs leading-5 text-slate-500">选择文件或粘贴内容后，这里会显示商品和 SKU 价格。</div></div>}
            {!previewing && preview && (
              <div className="mt-3 space-y-3">
                <div className={`flex items-start gap-2 px-3 py-2.5 text-xs leading-5 ${canCommit ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>{canCommit ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}<span>{canCommit ? '数据已脱敏落盘、重新读盘并通过价格核验。' : '数据已保存供预览，但没有足够的价格证据，不能写入监控。'}</span></div>
                <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-3 gap-y-2 border-y border-slate-200 bg-white px-3 py-3 text-xs"><dt className="text-slate-400">格式</dt><dd className="text-slate-700">{inputTypeLabels[preview.inputType]} · {resolutionLabels[preview.resolutionStatus]}</dd><dt className="text-slate-400">商品 ID</dt><dd className="font-mono text-slate-700">{preview.itemId || '未识别'}</dd><dt className="text-slate-400">商品</dt><dd className="text-slate-700">{preview.title || '未识别'}</dd><dt className="text-slate-400">店铺</dt><dd className="text-slate-700">{preview.shopName || '未识别'}</dd></dl>
                <div className="grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200 bg-white py-3 text-center"><div><div className="text-[11px] text-slate-400">SKU 总数</div><div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{preview.skuCount}</div></div><div><div className="text-[11px] text-slate-400">已验证</div><div className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">{preview.verifiedSkuCount}</div></div><div><div className="text-[11px] text-slate-400">价格区间</div><div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{priceText}</div></div></div>
                {preview.skuPrices.length > 0 && <section><div className="mb-1.5 flex items-center justify-between gap-3"><h4 className="text-xs font-semibold text-slate-800">SKU 价格</h4>{preview.skuPrices.length > 100 && <span className="text-[11px] text-slate-400">仅显示前 100 条</span>}</div><div className="max-h-56 divide-y divide-slate-100 overflow-y-auto border-y border-slate-200 bg-white">{preview.skuPrices.slice(0, 100).map((sku, index) => { const verified = skuIsVerified(sku); return <div key={`${sku.skuId}-${index}`} className="grid grid-cols-[minmax(0,1fr)_86px] items-center gap-3 px-3 py-2.5 text-xs"><div className="min-w-0"><div className="truncate font-medium text-slate-700" title={sku.name}>{sku.name || `SKU ${index + 1}`}</div><div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">{sku.skuId}</div></div><div className="text-right"><div className="font-semibold tabular-nums text-slate-900">{currency(sku.normalPrice ?? sku.price)}</div><div className={`mt-0.5 text-[10px] ${verified ? 'text-emerald-600' : 'text-amber-600'}`}>{verified ? '已验证' : '未验证'}</div></div></div> })}</div></section>}
                {preview.warnings.length > 0 && <section className="bg-amber-50 px-3 py-2.5"><h4 className="flex items-center gap-1.5 text-xs font-semibold text-amber-800"><AlertTriangle className="h-3.5 w-3.5" />解析提醒</h4><ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-800">{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>· {warning}</li>)}</ul></section>}
                <div className="break-all text-[11px] leading-5 text-slate-400" title={parsedFilePath}>解析记录：{parsedFilePath}</div>{sourceFilePath && sourceFilePath !== parsedFilePath && <div className="break-all text-[11px] leading-5 text-slate-400" title={sourceFilePath}>脱敏源文件：{sourceFilePath}</div>}
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className={`flex min-w-0 items-center gap-2 text-xs ${error ? 'text-red-700' : canCommit ? 'text-emerald-700' : 'text-slate-500'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error ? <AlertTriangle className="h-4 w-4 shrink-0" /> : busy ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-blue-600" /> : canCommit ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShieldCheck className="h-4 w-4 shrink-0" />}<span className="line-clamp-2">{statusText}</span></div><div className="flex shrink-0 justify-end gap-2"><Button type="button" variant="secondary" onClick={close} disabled={committing}>取消</Button><Button type="button" onClick={() => void confirmImport()} disabled={!canCommit || busy}>{committing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{committing ? '写入中' : '导入为暂停商品'}</Button></div></footer>
      </section>
    </div>,
    document.body,
  )
}
