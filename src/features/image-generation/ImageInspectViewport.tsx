import { Maximize2, Minus, Move, Plus, Scan } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Point = { x: number; y: number }
type Size = { width: number; height: number }

type Props = {
  src: string
  alt: string
  className?: string
}

const EMPTY_SIZE: Size = { width: 0, height: 0 }
const ZERO_POINT: Point = { x: 0, y: 0 }

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function ImageInspectViewport({ src, alt, className = '' }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; start: Point; origin: Point } | null>(null)
  const [viewport, setViewport] = useState<Size>(EMPTY_SIZE)
  const [natural, setNatural] = useState<Size>(EMPTY_SIZE)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>(ZERO_POINT)
  const [fitMode, setFitMode] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fitScale = useMemo(() => {
    if (!viewport.width || !viewport.height || !natural.width || !natural.height) return 1
    const horizontalPadding = Math.min(32, viewport.width * 0.08)
    const verticalPadding = Math.min(32, viewport.height * 0.08)
    return Math.min(
      (viewport.width - horizontalPadding) / natural.width,
      (viewport.height - verticalPadding) / natural.height,
    )
  }, [natural, viewport])

  const limits = useMemo(() => ({
    minimum: Math.max(0.02, fitScale * 0.35),
    maximum: Math.max(4, fitScale * 8),
  }), [fitScale])

  const clampOffset = useCallback((point: Point, nextScale = scale) => {
    if (!natural.width || !natural.height || !viewport.width || !viewport.height) return ZERO_POINT
    const overflowX = Math.max(0, (natural.width * nextScale - viewport.width) / 2)
    const overflowY = Math.max(0, (natural.height * nextScale - viewport.height) / 2)
    return {
      x: overflowX ? clamp(point.x, -overflowX, overflowX) : 0,
      y: overflowY ? clamp(point.y, -overflowY, overflowY) : 0,
    }
  }, [natural, scale, viewport])

  const fitImage = useCallback(() => {
    setScale(fitScale)
    setOffset(ZERO_POINT)
    setFitMode(true)
  }, [fitScale])

  useEffect(() => {
    if (fitMode) {
      setScale(fitScale)
      setOffset(ZERO_POINT)
      return
    }
    setOffset((current) => clampOffset(current))
  }, [clampOffset, fitMode, fitScale])

  const applyScale = useCallback((requestedScale: number, anchor?: Point) => {
    const nextScale = clamp(requestedScale, limits.minimum, limits.maximum)
    setOffset((current) => {
      if (!anchor || !scale) return clampOffset(current, nextScale)
      const ratio = nextScale / scale
      return clampOffset({
        x: anchor.x - (anchor.x - current.x) * ratio,
        y: anchor.y - (anchor.y - current.y) * ratio,
      }, nextScale)
    })
    setScale(nextScale)
    setFitMode(false)
  }, [clampOffset, limits, scale])

  const showActualSize = useCallback(() => {
    const nextScale = clamp(1, limits.minimum, limits.maximum)
    setScale(nextScale)
    setOffset(ZERO_POINT)
    setFitMode(false)
  }, [limits])

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const anchor = {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    }
    applyScale(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), anchor)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (!offset.x && !offset.y && natural.width * scale <= viewport.width && natural.height * scale <= viewport.height)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: offset }
    setDragging(true)
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); applyScale(scale * 1.25) }
    else if (event.key === '-') { event.preventDefault(); applyScale(scale / 1.25) }
    else if (event.key === '0') { event.preventDefault(); fitImage() }
    else if (event.key === '1') { event.preventDefault(); showActualSize() }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); setOffset((current) => clampOffset({ ...current, x: current.x + 32 })) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setOffset((current) => clampOffset({ ...current, x: current.x - 32 })) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setOffset((current) => clampOffset({ ...current, y: current.y + 32 })) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setOffset((current) => clampOffset({ ...current, y: current.y - 32 })) }
  }

  const canPan = natural.width * scale > viewport.width || natural.height * scale > viewport.height

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      className={`group relative min-h-0 overflow-hidden bg-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${canPan ? dragging ? 'cursor-grabbing' : 'cursor-grab' : 'cursor-default'} ${className}`}
      onWheel={onWheel}
      onDoubleClick={fitImage}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        setOffset(clampOffset({ x: drag.origin.x + event.clientX - drag.start.x, y: drag.origin.y + event.clientY - drag.start.y }))
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      aria-label={`${alt}预览`}
    >
      {!loadFailed && natural.width > 0 && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none absolute max-w-none select-none bg-white ring-1 ring-black/10"
          style={{
            left: `calc(50% + ${offset.x}px)`,
            top: `calc(50% + ${offset.y}px)`,
            width: natural.width * scale,
            height: natural.height * scale,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
      {!loadFailed && natural.width === 0 && (
        <img
          src={src}
          alt=""
          className="pointer-events-none invisible absolute"
          onLoad={(event) => {
            const image = event.currentTarget
            setNatural({ width: image.naturalWidth, height: image.naturalHeight })
            setLoadFailed(false)
          }}
          onError={() => setLoadFailed(true)}
        />
      )}
      {loadFailed && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-700">图片加载失败</div>}

      <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-slate-200 bg-white/95 p-1 shadow-sm" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => applyScale(scale / 1.25)} className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="缩小（-）" aria-label="缩小图片"><Minus className="h-4 w-4" /></button>
        <output className="min-w-14 px-1 text-center text-xs font-medium tabular-nums text-slate-700" title="当前显示比例">{Math.round(scale * 100)}%</output>
        <button type="button" onClick={() => applyScale(scale * 1.25)} className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="放大（+）" aria-label="放大图片"><Plus className="h-4 w-4" /></button>
        <span className="mx-1 h-5 w-px bg-slate-200" />
        <button type="button" onClick={fitImage} className={`inline-flex h-8 w-8 items-center justify-center rounded hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${fitMode ? 'bg-blue-50 text-blue-700' : 'text-slate-600'}`} title="适合窗口（0）" aria-label="图片适合窗口"><Maximize2 className="h-4 w-4" /></button>
        <button type="button" onClick={showActualSize} className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="原始尺寸（1）" aria-label="按原始尺寸显示"><Scan className="h-4 w-4" /></button>
        <span className={`ml-1 inline-flex h-8 w-8 items-center justify-center rounded ${canPan ? 'text-blue-700' : 'text-slate-300'}`} title="拖动查看细节"><Move className="h-4 w-4" /></span>
      </div>
    </div>
  )
}
