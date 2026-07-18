import {
  Download,
  Eraser,
  LoaderCircle,
  MapPin,
  RotateCcw,
  SquareDashedMousePointer,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../components/ui/button'
import type { ImageLibraryItem } from '../../types/domain'

export type AnnotationExportMode = 'mask' | 'annotation'

type Point = { x: number; y: number }
type AnnotationTool = 'rectangle' | 'point'
type Annotation = {
  id: number
  note: string
} & (
  | { kind: 'rectangle'; x: number; y: number; width: number; height: number }
  | { kind: 'point'; x: number; y: number }
)
type ActiveRectangle = { start: Point; end: Point }

const MAX_ANNOTATIONS = 12
const MAX_NOTE_LENGTH = 300
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const ANNOTATION_COLOR = '#2563eb'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizedRectangle({ start, end }: ActiveRectangle) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function annotationMetrics(width: number, height: number) {
  const shortSide = Math.min(width, height)
  return {
    lineWidth: clamp(shortSide * 0.004, 3, 10),
    radius: clamp(shortSide * 0.024, 15, 34),
  }
}

function drawNumber(context: CanvasRenderingContext2D, number: number, x: number, y: number, radius: number) {
  context.save()
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fillStyle = ANNOTATION_COLOR
  context.fill()
  context.lineWidth = Math.max(3, radius * 0.14)
  context.strokeStyle = '#ffffff'
  context.stroke()
  context.fillStyle = '#ffffff'
  context.font = `700 ${radius * (number > 9 ? 0.75 : 0.95)}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(number), x, y + radius * 0.04)
  context.restore()
}

function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation, index: number, canvasWidth: number, canvasHeight: number) {
  const { lineWidth, radius } = annotationMetrics(canvasWidth, canvasHeight)
  if (annotation.kind === 'rectangle') {
    context.save()
    context.lineJoin = 'round'
    context.strokeStyle = '#ffffff'
    context.lineWidth = lineWidth + Math.max(3, lineWidth * 0.8)
    context.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
    context.strokeStyle = ANNOTATION_COLOR
    context.lineWidth = lineWidth
    context.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
    context.restore()
    drawNumber(
      context,
      index + 1,
      clamp(annotation.x, radius + 2, canvasWidth - radius - 2),
      clamp(annotation.y, radius + 2, canvasHeight - radius - 2),
      radius,
    )
    return
  }
  drawNumber(
    context,
    index + 1,
    clamp(annotation.x, radius + 2, canvasWidth - radius - 2),
    clamp(annotation.y, radius + 2, canvasHeight - radius - 2),
    radius,
  )
}

function renderComposite(canvas: HTMLCanvasElement, image: HTMLImageElement, annotations: Annotation[]) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建批注画布。')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  annotations.forEach((annotation, index) => drawAnnotation(context, annotation, index, canvas.width, canvas.height))
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法导出批注图片。')), type, quality))
}

async function uploadBlob(canvas: HTMLCanvasElement) {
  let blob = await canvasBlob(canvas)
  if (blob.size <= MAX_UPLOAD_BYTES) return blob

  for (const quality of [0.9, 0.82, 0.74, 0.66]) {
    blob = await canvasBlob(canvas, 'image/webp', quality)
    if (blob.size <= MAX_UPLOAD_BYTES) return blob
  }

  for (const scale of [0.85, 0.7, 0.55]) {
    const resized = document.createElement('canvas')
    resized.width = Math.max(1, Math.round(canvas.width * scale))
    resized.height = Math.max(1, Math.round(canvas.height * scale))
    const context = resized.getContext('2d')
    if (!context) break
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(canvas, 0, 0, resized.width, resized.height)
    blob = await canvasBlob(resized, 'image/webp', 0.82)
    if (blob.size <= MAX_UPLOAD_BYTES) return blob
  }
  return blob
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function compilePrompt(annotations: Annotation[]) {
  const instructions = annotations.map((annotation, index) => `${index + 1}. ${annotation.kind === 'rectangle' ? '框选区域' : '点击位置'}：${annotation.note.trim()}`)
  return `这是严格局部编辑任务。只按照批注图中的编号逐项修改对应位置，编号与修改要求一一对应。除各编号明确要求修改的内容外，未标注区域、产品身份、结构比例、颜色材质、品牌文字、视角与构图必须保持原图不变，不要整体重绘。若某编号要求新增、删除或替换文字，只修改该编号指定区域和指定文字；新增或替换的文字必须与该条原文逐字一致，其他文字保持不变。\n${instructions.join('\n')}`
}

type Props = {
  item: ImageLibraryItem
  src: string
  onClose: () => void
  onSubmit: (blob: Blob, mode: AnnotationExportMode, prompt: string) => Promise<void>
}

export function ImageAnnotationDialog({ item, src, onClose, onSubmit }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const baseImageRef = useRef<HTMLImageElement | null>(null)
  const annotationsRef = useRef<Annotation[]>([])
  const activeRectangleRef = useRef<ActiveRectangle | null>(null)
  const nextIdRef = useRef(1)
  const noteEditorRef = useRef<HTMLTextAreaElement>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tool, setTool] = useState<AnnotationTool>('rectangle')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'export' | 'submit' | null>(null)
  const [error, setError] = useState('')

  const incompleteAnnotation = annotations.find((annotation) => !annotation.note.trim())

  function paintCanvas(includeActive = false) {
    const canvas = canvasRef.current
    const image = baseImageRef.current
    if (!canvas || !image) return
    renderComposite(canvas, image, annotationsRef.current)
    const active = includeActive ? activeRectangleRef.current : null
    const context = canvas.getContext('2d')
    if (!active || !context) return
    const rectangle = normalizedRectangle(active)
    const { lineWidth } = annotationMetrics(canvas.width, canvas.height)
    context.save()
    context.setLineDash([lineWidth * 2.5, lineWidth * 1.5])
    context.lineWidth = lineWidth
    context.strokeStyle = '#2563eb'
    context.fillStyle = 'rgba(37, 99, 235, 0.1)'
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    context.restore()
  }

  function replaceAnnotations(next: Annotation[], nextSelectedId: number | null) {
    annotationsRef.current = next
    setAnnotations(next)
    setSelectedId(nextSelectedId)
    window.requestAnimationFrame(() => paintCanvas())
  }

  function addAnnotation(annotation: Omit<Annotation, 'id' | 'note'>) {
    if (annotationsRef.current.length >= MAX_ANNOTATIONS) {
      setError(`一张图最多添加 ${MAX_ANNOTATIONS} 条批注，请先合并或删除重复标注。`)
      paintCanvas()
      return
    }
    const nextAnnotation = { ...annotation, id: nextIdRef.current++, note: '' } as Annotation
    replaceAnnotations([...annotationsRef.current, nextAnnotation], nextAnnotation.id)
    setError('')
    window.requestAnimationFrame(() => noteEditorRef.current?.focus())
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const keydown = (event: KeyboardEvent) => {
      const target = event.target
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
      const key = event.key.toLowerCase()
      const command = event.ctrlKey || event.metaKey

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (!typing && !busy && command && !event.shiftKey && key === 'z') {
        event.preventDefault()
        event.stopImmediatePropagation()
        undo()
        return
      }
      if (!typing && !loading && !busy && !command && !event.altKey && (key === 'r' || key === '1')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setTool('rectangle')
        return
      }
      if (!typing && !loading && !busy && !command && !event.altKey && (key === 'p' || key === '2')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setTool('point')
        return
      }
      if (!typing && !busy && !command && !event.altKey && !event.repeat && selectedId !== null && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const index = annotationsRef.current.findIndex((annotation) => annotation.id === selectedId)
        const next = annotationsRef.current.filter((annotation) => annotation.id !== selectedId)
        replaceAnnotations(next, next[Math.min(index, next.length - 1)]?.id || null)
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', keydown, true)
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keydown, true)
      previousFocus?.focus()
    }
  }, [busy, loading, onClose, selectedId])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    baseImageRef.current = null
    activeRectangleRef.current = null
    annotationsRef.current = []
    nextIdRef.current = 1
    setAnnotations([])
    setSelectedId(null)
    setLoading(true)
    setError('')
    fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(`图片读取失败：${response.status}`)
        return response.blob()
      })
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
          if (cancelled) return
          const maxSide = 4096
          const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
          const canvas = canvasRef.current
          if (!canvas) return
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
          baseImageRef.current = image
          paintCanvas()
          setLoading(false)
        }
        image.onerror = () => { if (!cancelled) { setError('图片解码失败，无法进入批注。'); setLoading(false) } }
        image.src = objectUrl
      })
      .catch((caught) => { if (!cancelled) { setError(caught instanceof Error ? caught.message : '图片读取失败。'); setLoading(false) } })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  function pointFromEvent(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) * canvas.width / rect.width, 0, canvas.width),
      y: clamp((event.clientY - rect.top) * canvas.height / rect.height, 0, canvas.height),
    }
  }

  function startAnnotation(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || loading || busy) return
    event.preventDefault()
    const point = pointFromEvent(event)
    if (tool === 'point') {
      addAnnotation({ kind: 'point', ...point })
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    activeRectangleRef.current = { start: point, end: point }
    paintCanvas(true)
  }

  function moveAnnotation(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeRectangleRef.current) return
    activeRectangleRef.current.end = pointFromEvent(event)
    paintCanvas(true)
  }

  function finishAnnotation(event: React.PointerEvent<HTMLCanvasElement>) {
    const active = activeRectangleRef.current
    if (!active) return
    active.end = pointFromEvent(event)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    activeRectangleRef.current = null
    const rectangle = normalizedRectangle(active)
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    const minimumWidth = 8 * canvas.width / bounds.width
    const minimumHeight = 8 * canvas.height / bounds.height
    if (rectangle.width >= minimumWidth && rectangle.height >= minimumHeight) addAnnotation({ kind: 'rectangle', ...rectangle })
    else paintCanvas()
  }

  function cancelAnnotation(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    activeRectangleRef.current = null
    paintCanvas()
  }

  function updateNote(id: number, note: string) {
    const next = annotationsRef.current.map((annotation) => annotation.id === id ? { ...annotation, note } : annotation)
    annotationsRef.current = next
    setAnnotations(next)
    if (error) setError('')
  }

  function removeAnnotation(id: number) {
    const index = annotationsRef.current.findIndex((annotation) => annotation.id === id)
    const next = annotationsRef.current.filter((annotation) => annotation.id !== id)
    const fallback = next[Math.min(index, next.length - 1)]?.id || null
    replaceAnnotations(next, selectedId === id ? fallback : selectedId)
  }

  function undo() {
    const next = annotationsRef.current.slice(0, -1)
    replaceAnnotations(next, next.at(-1)?.id || null)
  }

  function clear() {
    activeRectangleRef.current = null
    replaceAnnotations([], null)
    setError('')
  }

  async function buildExport() {
    const canvas = canvasRef.current
    const image = baseImageRef.current
    if (!canvas || !image) throw new Error('批注画布尚未就绪。')
    const output = document.createElement('canvas')
    output.width = canvas.width
    output.height = canvas.height
    renderComposite(output, image, annotationsRef.current)
    return output
  }

  async function exportImage() {
    if (!annotations.length) return
    setBusy('export')
    setError('')
    try {
      downloadBlob(await canvasBlob(await buildExport()), `AI图片批注-${item.id}.png`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出失败。')
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    if (!annotations.length) return
    if (incompleteAnnotation) {
      const number = annotations.findIndex((annotation) => annotation.id === incompleteAnnotation.id) + 1
      setSelectedId(incompleteAnnotation.id)
      setError(`请填写第 ${number} 条批注的修改内容。`)
      window.requestAnimationFrame(() => noteEditorRef.current?.focus())
      return
    }
    setBusy('submit')
    setError('')
    try {
      const blob = await uploadBlob(await buildExport())
      if (blob.size > MAX_UPLOAD_BYTES) throw new Error('批注文件超过 8 MB，请换用较低分辨率原图后重试。')
      await onSubmit(blob, 'annotation', compilePrompt(annotations))
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交批注失败。')
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/75 p-2 sm:p-5" role="presentation" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="annotation-dialog-title" className="flex h-[calc(100dvh-1rem)] w-full max-w-7xl flex-col overflow-hidden rounded-md bg-white shadow-2xl outline-none sm:h-[calc(100dvh-2.5rem)]" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0"><h2 id="annotation-dialog-title" className="text-base font-semibold text-slate-950">框选并备注</h2><p className="mt-0.5 truncate text-xs text-slate-500">标出位置并填写修改内容，原图不会被覆盖</p></div>
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100" title="关闭批注（Esc）" aria-label="关闭批注编辑" aria-keyshortcuts="Escape"><X className="h-5 w-5" /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="relative flex min-h-[42dvh] flex-1 items-center justify-center overflow-hidden bg-slate-100 p-3 sm:p-5 lg:min-h-0">
            <canvas
              ref={canvasRef}
              onPointerDown={startAnnotation}
              onPointerMove={moveAnnotation}
              onPointerUp={finishAnnotation}
              onPointerCancel={cancelAnnotation}
              className="max-h-full max-w-full touch-none cursor-crosshair bg-white shadow-lg"
              role="img"
              aria-label={`图片批注画布，当前有 ${annotations.length} 条批注`}
            />
            {loading && <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-100 text-sm text-slate-600"><LoaderCircle className="h-5 w-5 animate-spin" />正在载入原图</div>}
          </div>

          <aside className="scrollbar-thin max-h-[50dvh] overflow-y-auto border-t border-slate-200 bg-white p-4 lg:max-h-none lg:border-l lg:border-t-0">
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium text-slate-800">标注方式</div>
                <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1" role="group" aria-label="选择标注方式">
                  <button type="button" aria-pressed={tool === 'rectangle'} aria-keyshortcuts="R 1" title="框选区域（R 或 1）" disabled={loading || Boolean(busy)} onClick={() => setTool('rectangle')} className={`inline-flex h-10 items-center justify-center gap-1.5 rounded text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${tool === 'rectangle' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><SquareDashedMousePointer className="h-4 w-4" />框选区域<kbd className="ml-0.5 rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[10px] font-semibold leading-none text-slate-400">R</kbd></button>
                  <button type="button" aria-pressed={tool === 'point'} aria-keyshortcuts="P 2" title="点击备注（P 或 2）" disabled={loading || Boolean(busy)} onClick={() => setTool('point')} className={`inline-flex h-10 items-center justify-center gap-1.5 rounded text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${tool === 'point' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><MapPin className="h-4 w-4" />点击备注<kbd className="ml-0.5 rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[10px] font-semibold leading-none text-slate-400">P</kbd></button>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">{tool === 'rectangle' ? '在图片上拖动，框住需要修改的区域。' : '在需要修改的位置点一下，添加编号。'}</p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-slate-800">修改清单 <span className="font-normal text-slate-400">{annotations.length}/{MAX_ANNOTATIONS}</span></div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={undo} disabled={!annotations.length || Boolean(busy)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="撤销最后一条（Ctrl/Cmd+Z）" aria-label="撤销最后一条批注" aria-keyshortcuts="Control+Z Meta+Z"><RotateCcw className="h-4 w-4" /></button>
                  <button type="button" onClick={clear} disabled={!annotations.length || Boolean(busy)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="清空全部" aria-label="清空全部批注"><Eraser className="h-4 w-4" /></button>
                </div>
              </div>

              {annotations.length ? <div className="space-y-2">{annotations.map((annotation, index) => {
                const selected = annotation.id === selectedId
                return <div key={annotation.id} className={`rounded-md border transition ${selected ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <div className="flex items-center gap-1 p-1.5">
                    <button type="button" onClick={() => setSelectedId(annotation.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-expanded={selected}>
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{index + 1}</span>
                      <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-slate-700">{annotation.kind === 'rectangle' ? '框选区域' : '点击位置'}</span>{!selected && <span className={`block truncate text-[11px] ${annotation.note ? 'text-slate-500' : 'text-amber-600'}`}>{annotation.note || '待填写修改内容'}</span>}</span>
                    </button>
                    <button type="button" onClick={() => removeAnnotation(annotation.id)} disabled={Boolean(busy)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" title={`删除第 ${index + 1} 条（Delete）`} aria-label={`删除第 ${index + 1} 条批注`} aria-keyshortcuts="Delete Backspace"><Trash2 className="h-4 w-4" /></button>
                  </div>
                  {selected && <label className="block px-3 pb-3 text-xs font-medium text-slate-700" htmlFor={`annotation-note-${annotation.id}`}>修改内容<textarea ref={noteEditorRef} id={`annotation-note-${annotation.id}`} value={annotation.note} maxLength={MAX_NOTE_LENGTH} rows={3} disabled={Boolean(busy)} onChange={(event) => updateNote(annotation.id, event.target.value)} placeholder="例如：改成白色陶瓷材质" className="mt-1.5 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal leading-6 text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50" /><span className="mt-1 block text-right font-normal text-slate-400">{annotation.note.length}/{MAX_NOTE_LENGTH}</span></label>}
                </div>
              })}</div> : <div className="rounded-md bg-slate-50 px-3 py-4 text-center text-xs leading-5 text-slate-500">先在图片上{tool === 'rectangle' ? '拖动框选区域' : '点一下添加备注位置'}</div>}

              {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
              <div className="space-y-2 border-t border-slate-100 pt-4">
                <Button type="button" variant="secondary" className="w-full" onClick={() => void exportImage()} disabled={!annotations.length || Boolean(busy)}>{busy === 'export' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}导出带编号批注图</Button>
                <Button type="button" className="w-full" onClick={() => void submit()} disabled={!annotations.length || Boolean(busy)}>{busy === 'submit' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{busy === 'submit' ? '正在加入队列' : '加入队列并关闭'}</Button>
              </div>
              <p className="text-xs leading-5 text-slate-400" role="status" aria-live="polite">{annotations.length ? `已标注 ${annotations.length} 处；每个编号都需要填写修改内容。` : '支持框选较大区域，也可以点一下标记细节。'}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
