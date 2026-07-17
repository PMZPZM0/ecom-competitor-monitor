import { Download, ExternalLink, Heart, Images, LoaderCircle, Pencil, RefreshCw, RotateCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../components/ui/button'
import type { ImageLibraryItem } from '../../types/domain'

type Props = {
  item: ImageLibraryItem
  src: string
  busy: string
  onClose: () => void
  onDownload: () => void
  onDelete: () => void
  onToggleFavorite: () => void
  onEdit: () => void
  photoshopStatus?: {
    ready: boolean
    tone: 'neutral' | 'success' | 'error'
    message: string
    latestImage?: ImageLibraryItem
  }
  onPhotoshopOpen: () => void
  onPhotoshopSync: () => void
  onViewPhotoshopVersion: (item: ImageLibraryItem) => void
  onReuse: () => void
  onCreateFrom: () => void
}

const qualityLabel = { low: '快速', medium: '标准', high: '高清' }

export function ImageDetailDialog({ item, src, busy, onClose, onDownload, onDelete, onToggleFavorite, onEdit, photoshopStatus, onPhotoshopOpen, onPhotoshopSync, onViewPhotoshopVersion, onReuse, onCreateFrom }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', keydown)
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown)
      previousFocus?.focus()
    }
  }, [busy, onClose])

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/75 p-2 sm:p-5" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="image-detail-title" className="flex h-[calc(100dvh-1rem)] w-full max-w-7xl flex-col overflow-hidden rounded-md bg-white shadow-2xl outline-none sm:h-[calc(100dvh-2.5rem)]" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0"><h2 id="image-detail-title" className="text-base font-semibold text-slate-950">图片详情</h2><p className="mt-0.5 text-xs text-slate-500">{new Date(item.createdAt).toLocaleString()} · {item.model}</p></div>
          <button type="button" onClick={onClose} disabled={Boolean(busy)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="关闭详情" aria-label="关闭图片详情"><X className="h-5 w-5" /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-h-[320px] items-center justify-center overflow-hidden bg-slate-100 p-3 sm:p-6">
            <img src={src} alt="AI 生成图片详情" className="max-h-full max-w-full object-contain shadow-lg" />
          </div>
          <aside className="scrollbar-thin overflow-y-auto border-t border-slate-200 p-4 lg:border-l lg:border-t-0">
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onEdit} disabled={Boolean(busy)}><Pencil className="h-4 w-4" />批注编辑</Button>
              <Button type="button" variant="secondary" onClick={onPhotoshopOpen} disabled={Boolean(busy)}>{busy === 'photoshop-open' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}{photoshopStatus?.ready ? '重新打开 PS' : 'Photoshop 编辑'}</Button>
              {photoshopStatus?.ready && <Button type="button" variant="secondary" onClick={onPhotoshopSync} disabled={Boolean(busy)}>{busy === 'photoshop-sync' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}同步 PS 修改</Button>}
              <Button type="button" variant="secondary" onClick={onCreateFrom} disabled={Boolean(busy)}><Images className="h-4 w-4" />基于此图创作</Button>
              <Button type="button" variant="secondary" onClick={onReuse} disabled={Boolean(busy)}><RotateCw className="h-4 w-4" />复用参数</Button>
              <Button type="button" variant="secondary" onClick={onDownload} disabled={Boolean(busy)}>{busy === 'download' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}下载</Button>
              <Button type="button" variant="secondary" onClick={onToggleFavorite} disabled={Boolean(busy)} className={item.isFavorite ? 'border-amber-200 bg-amber-50 text-amber-700' : ''}>{busy === 'favorite' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Heart className={`h-4 w-4 ${item.isFavorite ? 'fill-current' : ''}`} />}{item.isFavorite ? '取消收藏' : '收藏'}</Button>
              <Button type="button" variant="danger" onClick={onDelete} disabled={Boolean(busy)}>{busy === 'delete' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}删除</Button>
            </div>

            {photoshopStatus?.message && <div className={`mt-3 rounded-md px-3 py-2 text-xs leading-5 ${photoshopStatus.tone === 'error' ? 'bg-red-50 text-red-700' : photoshopStatus.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`} role={photoshopStatus.tone === 'error' ? 'alert' : 'status'} aria-live="polite"><span>{photoshopStatus.message}</span>{photoshopStatus.latestImage && <button type="button" className="ml-2 font-semibold underline underline-offset-2" onClick={() => onViewPhotoshopVersion(photoshopStatus.latestImage!)}>查看新版本</button>}</div>}

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-slate-100 py-4 text-sm">
              <div><dt className="text-xs text-slate-400">比例</dt><dd className="mt-1 font-medium text-slate-800">{item.ratio}</dd></div>
              <div><dt className="text-xs text-slate-400">分辨率</dt><dd className="mt-1 font-medium uppercase text-slate-800">{item.resolution}{item.upscaled ? ' · 增强' : ''}</dd></div>
              <div><dt className="text-xs text-slate-400">生成质量</dt><dd className="mt-1 font-medium text-slate-800">{qualityLabel[item.quality]}</dd></div>
              <div><dt className="text-xs text-slate-400">格式</dt><dd className="mt-1 font-medium uppercase text-slate-800">{item.format}</dd></div>
              <div className="col-span-2"><dt className="text-xs text-slate-400">输出尺寸</dt><dd className="mt-1 font-medium text-slate-800">{item.nativeSize && item.outputSize && item.nativeSize !== item.outputSize ? `${item.nativeSize} → ${item.outputSize}` : item.outputSize || item.nativeSize || (item.width && item.height ? `${item.width} × ${item.height}` : '--')}</dd></div>
              {item.parentImageId && <div className="col-span-2"><dt className="text-xs text-slate-400">版本来源</dt><dd className="mt-1 truncate font-medium text-slate-800">基于 {item.parentImageId} 创作{item.maskApplied ? ' · 蒙版编辑' : ''}</dd></div>}
            </dl>

            <section className="mt-4"><h3 className="text-sm font-medium text-slate-800">正向提示词</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{item.prompt || '--'}</p></section>
            {item.negativePrompt && <section className="mt-4"><h3 className="text-sm font-medium text-slate-800">排除要求</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{item.negativePrompt}</p></section>}
            {item.revisedPrompt && item.revisedPrompt !== item.prompt && <section className="mt-4 border-t border-slate-100 pt-4"><h3 className="text-sm font-medium text-slate-800">模型改写提示词</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-500">{item.revisedPrompt}</p></section>}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
