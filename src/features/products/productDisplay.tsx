import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, LoaderCircle, Play, RotateCw, Store, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { downloadHref } from './productDisplayUtils'
import type { BuyerShowItem } from '../../types/domain'

export type Preview = {
  src: string
  title: string
}

export function ShopLogo({ src }: { src?: string }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-100 bg-white">
      {src && !/tmall|taobao|avatar|user/i.test(src) ? <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" /> : <Store className="h-4 w-4 text-slate-400" />}
    </div>
  )
}

export function ImagePreview({ preview, onClose }: { preview: Preview | null; onClose: () => void }) {
  useEffect(() => {
    if (!preview) return
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [preview, onClose])

  if (!preview) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-slate-950/70 p-3 sm:p-6" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={preview.title} className="flex max-h-full max-w-5xl flex-col overflow-hidden rounded-md bg-white p-3 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="line-clamp-1 text-sm font-medium text-slate-800">{preview.title}</div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
            关闭
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto"><img src={preview.src} alt="" className="max-h-[78vh] max-w-full rounded-md object-contain" /></div>
      </div>
    </div>,
    document.body,
  )
}

export function BuyerShowDialog({ title, items, statusText = '', onClose, onDownload, onDownloadItem, onRetry, downloadBusy = false, retryBusy = false, downloadMessage = '' }: { title: string; items: BuyerShowItem[]; statusText?: string; onClose: () => void; onDownload: () => void; onDownloadItem: (item: BuyerShowItem) => void; onRetry?: () => void; downloadBusy?: boolean; retryBusy?: boolean; downloadMessage?: string }) {
  const visibleItems = items.filter((item) => item.text || item.images?.length || item.videoUrls?.length)
  const [page, setPage] = useState(0)
  const pageSize = 8
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageItems = visibleItems.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  if (!visibleItems.length) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-slate-950/70 p-3 sm:p-6" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="buyer-show-dialog-title" className="flex h-[calc(100dvh-1.5rem)] max-h-[880px] w-full max-w-5xl flex-col overflow-hidden rounded-md bg-white shadow-2xl sm:h-[calc(100dvh-3rem)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0"><div id="buyer-show-dialog-title" className="truncate text-sm font-semibold text-slate-900">买家秀预览</div><div className="truncate text-xs text-slate-500">{title} · 共 {visibleItems.length} 条{statusText ? ` · ${statusText}` : ''}</div>{downloadMessage && <div className="mt-1 flex items-center gap-1 text-xs text-sky-700" role="status" aria-live="polite">{downloadBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}{downloadMessage}</div>}</div>
          <div className="flex shrink-0 items-center gap-2">{onRetry && <Button type="button" variant="secondary" size="sm" onClick={onRetry} disabled={retryBusy || downloadBusy} title="仅重新抓取买家秀，价格和素材不变"><RotateCw className={`h-4 w-4 ${retryBusy ? 'animate-spin' : ''}`} />{retryBusy ? '重试中' : '重试买家秀'}</Button>}<Button type="button" size="sm" onClick={onDownload} disabled={downloadBusy || retryBusy}>{downloadBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{downloadBusy ? '生成中' : '下载 ZIP'}</Button><Button type="button" variant="ghost" size="sm" onClick={onClose} title="关闭买家秀预览"><X className="h-4 w-4" />关闭</Button></div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-3 md:grid-cols-2">
            {pageItems.map((item, pageIndex) => {
              const index = currentPage * pageSize + pageIndex
              return (
              <article key={item.id || index} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500"><span className="font-semibold">买家秀 {index + 1}{item.author ? ` · ${item.author}` : ''}</span><span>{item.createdAt || ''}</span></div>
                {item.sku && <div className="mb-2 truncate text-[11px] text-slate-400" title={item.sku}>{item.sku}</div>}
                {item.text && <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{item.text}</p>}
                {item.images?.length > 0 && <div className="grid grid-cols-3 gap-2">{item.images.map((src, imageIndex) => <a key={`${src}-${imageIndex}`} href={src} target="_blank" rel="noreferrer" className="aspect-square overflow-hidden rounded-md border border-slate-200 bg-white"><img src={src} alt="买家秀图片" loading="lazy" decoding="async" className="h-full w-full object-cover" /></a>)}</div>}
                {item.videoUrls?.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{item.videoUrls.map((src, videoIndex) => <a key={`${src}-${videoIndex}`} href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700"><Play className="h-3.5 w-3.5" />视频 {videoIndex + 1}</a>)}</div>}
                <div className="mt-3 flex justify-end border-t border-slate-200 pt-2"><Button type="button" variant="secondary" size="sm" onClick={() => onDownloadItem(item)} disabled={downloadBusy} title={`下载买家秀 ${index + 1}`}><Download className="h-3.5 w-3.5" />下载本条</Button></div>
              </article>
              )
            })}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-white px-4 py-3 text-xs text-slate-500">
          <span>第 {currentPage + 1} / {pageCount} 页 · 当前 {pageItems.length} 条</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={currentPage === 0} title="上一页"><ChevronLeft className="h-4 w-4" />上一页</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={currentPage >= pageCount - 1} title="下一页">下一页<ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ImageThumb({
  src,
  title,
  label,
  className = '',
  imageClassName = '',
  onPreview,
  allowDownload = true,
}: {
  src?: string
  title: string
  label: string
  className?: string
  imageClassName?: string
  onPreview: (preview: Preview) => void
  allowDownload?: boolean
}) {
  if (!src) {
    return (
      <div className={`flex aspect-[4/3] items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-400 ${className}`}>
        无图
      </div>
    )
  }

  return (
    <div className={`group relative overflow-hidden rounded-md border border-slate-100 bg-slate-50 ${className}`}>
      <button type="button" className={`block aspect-[4/3] w-full ${imageClassName}`} onClick={() => onPreview({ src, title })}>
        <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
      </button>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-slate-950/65 px-2 py-1 text-[11px] text-white">
        <span>{label}</span>
        {allowDownload && <a href={downloadHref(src, title)} title="下载图片" onClick={(event) => event.stopPropagation()}><Download className="h-3.5 w-3.5" /></a>}
      </div>
    </div>
  )
}

export function VideoLink({ src, index }: { src: string; index: number }) {
  return (
    <span className="inline-flex h-8 overflow-hidden rounded-md border border-amber-100 bg-amber-50 text-xs font-medium text-amber-700">
      <a href={src} target="_blank" className="inline-flex items-center gap-1 px-2 hover:bg-amber-100">
        <Play className="h-3.5 w-3.5" />
        视频 {index + 1}
      </a>
      <a href={downloadHref(src, `视频-${index + 1}`)} className="inline-flex items-center border-l border-amber-100 px-2 hover:bg-amber-100" title="下载视频">
        <Download className="h-3.5 w-3.5" />
      </a>
    </span>
  )
}
