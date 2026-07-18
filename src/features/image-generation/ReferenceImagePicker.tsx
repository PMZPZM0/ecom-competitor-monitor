import { Check, CircleAlert, ClipboardPaste, ImagePlus, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const defaultMaxFiles = 4
const maxBytes = 8 * 1024 * 1024
const compressedTargetBytes = Math.floor(7.5 * 1024 * 1024)
const maxCanvasEdge = 4096
const maxCanvasPixels = 16 * 1024 * 1024

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('浏览器无法压缩这张图片。')),
    type,
    quality,
  ))
}

function compressedFilename(filename: string, mimeType: string) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  return `${filename.replace(/\.[^.]+$/, '') || '参考图'}-已压缩.${extension}`
}

async function compressReferenceImage(file: File) {
  if (file.size <= maxBytes) return file

  const bitmap = await createImageBitmap(file)
  try {
    const edgeScale = Math.min(1, maxCanvasEdge / Math.max(bitmap.width, bitmap.height))
    const pixelScale = Math.min(1, Math.sqrt(maxCanvasPixels / (bitmap.width * bitmap.height)))
    let scale = Math.min(edgeScale, pixelScale)
    let quality = 0.9
    const outputType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: outputType !== 'image/jpeg' })
    if (!context) throw new Error('浏览器无法创建图片压缩画布。')

    for (let attempt = 0; attempt < 12; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await canvasBlob(canvas, outputType, quality)
      if (blob.size <= compressedTargetBytes) {
        return new File([blob], compressedFilename(file.name, blob.type || outputType), {
          type: blob.type || outputType,
          lastModified: file.lastModified,
        })
      }
      if (quality > 0.62) {
        quality -= 0.1
      } else {
        scale *= Math.max(0.58, Math.min(0.86, Math.sqrt(compressedTargetBytes / blob.size) * 0.94))
        quality = 0.82
      }
    }
  } finally {
    bitmap.close()
  }
  throw new Error(`“${file.name}”自动压缩后仍超过 8 MB，请换一张尺寸更小的图片。`)
}

export type ReferenceImageFile = {
  id: string
  file: File
  previewUrl: string
}

type Props = {
  images: ReferenceImageFile[]
  sourceImage?: { id: string; previewUrl: string }
  maxFiles?: number
  required?: boolean
  description?: string
  disabled?: boolean
  onChange: (images: ReferenceImageFile[]) => void
  onClearSource?: () => void
  onError: (message: string) => void
}

export function ReferenceImagePicker({ images, sourceImage, maxFiles = defaultMaxFiles, required = false, description, disabled, onChange, onClearSource, onError }: Props) {
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const imagesRef = useRef(images)
  const [dragging, setDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState(false)

  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [])

  function reportError(message: string) {
    setFeedback(message)
    setFeedbackError(true)
    onError(message)
  }

  async function addFiles(files: File[], source: '选择' | '拖入' | '粘贴') {
    if (disabled || processing) return
    const remaining = maxFiles - images.length
    if (remaining <= 0) {
      reportError(`最多添加 ${maxFiles} 张参考图。`)
      return
    }
    const existing = new Set(images.map((image) => `${image.file.name}:${image.file.size}:${image.file.lastModified}`))
    const valid: File[] = []
    const compressed: string[] = []
    setProcessing(true)
    setFeedbackError(false)
    setFeedback(source === '粘贴' ? '正在读取并处理剪贴板图片…' : '正在检查参考图…')
    for (const file of files) {
      if (!acceptedTypes.has(file.type)) {
        reportError('参考图仅支持 PNG、JPEG 和 WEBP。')
        continue
      }
      try {
        const prepared = await compressReferenceImage(file)
        const key = `${prepared.name}:${prepared.size}:${prepared.lastModified}`
        if (existing.has(key)) continue
        existing.add(key)
        valid.push(prepared)
        if (prepared !== file) compressed.push(`${formatBytes(file.size)} → ${formatBytes(prepared.size)}`)
      } catch (error) {
        reportError(error instanceof Error ? error.message : `“${file.name}”处理失败。`)
        continue
      }
      if (valid.length === remaining) break
    }
    try {
      if (!valid.length) {
        setFeedback((current) => current.includes('正在') ? '没有可添加的新图片。' : current)
        setFeedbackError(true)
        return
      }
      onChange([...images, ...valid.map((file) => ({
        id: globalThis.crypto?.randomUUID?.() || `${file.name}-${file.lastModified}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }))])
      const compressionNote = compressed.length ? `，已自动压缩 ${compressed.join('；')}` : ''
      setFeedback(`${source}成功：已添加 ${valid.length} 张${compressionNote}。`)
      setFeedbackError(false)
      if (files.length > remaining) reportError(`最多保留前 ${maxFiles} 张参考图。`)
    } finally {
      setProcessing(false)
    }
  }

  async function pasteFromClipboard() {
    if (!navigator.clipboard?.read) {
      reportError('当前环境不支持按钮读取剪贴板，请点击参考图区后按 Ctrl/Cmd+V。')
      return
    }
    try {
      const clipboardItems = await navigator.clipboard.read()
      const files: File[] = []
      for (const item of clipboardItems) {
        const type = item.types.find((candidate) => acceptedTypes.has(candidate))
        if (!type) continue
        const blob = await item.getType(type)
        const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1]
        files.push(new File([blob], `剪贴板图片-${Date.now()}-${files.length + 1}.${extension}`, { type }))
      }
      if (!files.length) {
        reportError('剪贴板中没有 PNG、JPEG 或 WEBP 图片。')
        return
      }
      await addFiles(files, '粘贴')
    } catch (error) {
      const permissionDenied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
      reportError(permissionDenied ? '浏览器未允许读取剪贴板，请点击参考图区后按 Ctrl/Cmd+V。' : '读取剪贴板失败，请重新复制图片后再试。')
    }
  }

  function removeImage(id: string) {
    const removed = images.find((image) => image.id === id)
    if (removed) URL.revokeObjectURL(removed.previewUrl)
    onChange(images.filter((image) => image.id !== id))
  }

  return (
    <section aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div id={titleId} className="text-sm font-medium text-slate-800">参考图 <span className={`font-normal ${required ? 'text-blue-600' : 'text-slate-400'}`}>{required ? '必填' : '可选'} · {images.length}/{maxFiles}</span></div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => void pasteFromClipboard()} disabled={disabled || processing || images.length >= maxFiles} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40" title="读取剪贴板中的图片"><ClipboardPaste className="h-3.5 w-3.5" />粘贴图片</button>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled || processing || images.length >= maxFiles} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40">
            <ImagePlus className="h-3.5 w-3.5" />选择图片
          </button>
        </div>
      </div>
      {description && <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" onChange={(event) => { void addFiles(Array.from(event.target.files || []), '选择'); event.target.value = '' }} />
      {sourceImage && <div className="mt-2 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 p-2"><img src={sourceImage.previewUrl} alt="历史来源图" className="h-12 w-12 shrink-0 rounded object-cover" /><div className="min-w-0 flex-1"><div className="text-xs font-medium text-blue-900">基于历史图片创作</div><div className="mt-0.5 truncate text-[11px] text-blue-600">来源 {sourceImage.id}</div></div><button type="button" onClick={onClearSource} disabled={disabled} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-blue-700 hover:bg-blue-100 disabled:opacity-40" title="清除来源图片" aria-label="清除来源图片"><Trash2 className="h-3.5 w-3.5" /></button></div>}
      <div
        tabIndex={disabled ? -1 : 0}
        role="region"
        aria-label="参考图粘贴和拖放区域"
        className={`mt-2 min-h-20 rounded-md border border-dashed p-2 outline-none transition focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-100 ${dragging ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-50/70'} ${disabled || processing ? 'pointer-events-none opacity-60' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files), '拖入') }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file))
          if (!files.length) return
          event.preventDefault()
          void addFiles(files, '粘贴')
        }}
      >
        {images.length ? (
          <div className="grid grid-cols-4 gap-2">
            {images.map((image) => (
              <div key={image.id} className="group relative aspect-square min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white">
                <img src={image.previewUrl} alt={image.file.name} className="h-full w-full object-cover" />
                <button type="button" onClick={() => removeImage(image.id)} className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md bg-slate-950/75 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100" title={`移除 ${image.file.name}`} aria-label={`移除 ${image.file.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                <div className="absolute inset-x-0 bottom-0 truncate bg-slate-950/65 px-1.5 py-1 text-[10px] text-white">{image.file.name}</div>
              </div>
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => inputRef.current?.click()} className="flex min-h-16 w-full items-center justify-center gap-2 text-xs text-slate-500">
            <Upload className="h-4 w-4 text-slate-400" />拖入、选择，或按 Ctrl/Cmd+V 粘贴
          </button>
        )}
      </div>
      <div className={`mt-1.5 flex min-h-5 items-start gap-1.5 text-[11px] leading-5 ${feedbackError ? 'text-red-600' : 'text-slate-500'}`} role="status" aria-live="polite">
        {processing ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" /> : feedback ? feedbackError ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
        <span>{processing ? feedback : feedback || '支持 PNG、JPEG、WEBP；单张超过 8 MB 自动压缩。'}</span>
      </div>
    </section>
  )
}
