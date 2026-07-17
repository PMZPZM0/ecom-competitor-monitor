import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  CircleAlert,
  Clock3,
  Download,
  Heart,
  Images,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Settings2,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { ApiError, api } from '../../lib/api'
import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageLibraryItem,
  ModelConfig,
  ModelConfigPatch,
  ModelConfigTestResult,
} from '../../types/domain'
import { ModelConfigPanel } from '../analysis/ModelConfigPanel'
import { ImageAnnotationDialog, type AnnotationExportMode } from './ImageAnnotationDialog'
import { ImageDetailDialog } from './ImageDetailDialog'
import { ReferenceImagePicker, type ReferenceImageFile } from './ReferenceImagePicker'

const ratios = [
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
] as const

const resolutions = [
  { value: '1k', label: '1K', note: '标准' },
  { value: '2k', label: '2K', note: '增强' },
  { value: '4k', label: '4K', note: '增强' },
] as const

const DRAFT_KEY = 'ecommerce-monitor-image-draft-v2'

type Status = 'idle' | 'running' | 'ready' | 'error' | 'cancelled'
type MessageTone = 'neutral' | 'success' | 'error'
type LibraryView = 'history' | 'favorites'
type Draft = Pick<ImageGenerationRequest, 'prompt' | 'negativePrompt' | 'ratio' | 'resolution' | 'quality' | 'format' | 'background' | 'count'>
type GenerationFiles = { referenceImages?: File[]; maskImage?: Blob }
type PhotoshopStatus = {
  ready: boolean
  tone: MessageTone
  message: string
  latestImage?: ImageLibraryItem
}

const defaultDraft: Draft = {
  prompt: '',
  negativePrompt: '',
  ratio: '1:1',
  resolution: '1k',
  quality: 'medium',
  format: 'png',
  background: 'auto',
  count: 1,
}

function loadDraft(): Draft {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}') as Partial<Draft>
    return {
      prompt: typeof saved.prompt === 'string' ? saved.prompt.slice(0, 4000) : '',
      negativePrompt: typeof saved.negativePrompt === 'string' ? saved.negativePrompt.slice(0, 2000) : '',
      ratio: ratios.some((item) => item.value === saved.ratio) ? saved.ratio as Draft['ratio'] : '1:1',
      resolution: resolutions.some((item) => item.value === saved.resolution) ? saved.resolution as Draft['resolution'] : '1k',
      quality: ['low', 'medium', 'high'].includes(saved.quality || '') ? saved.quality as Draft['quality'] : 'medium',
      format: ['png', 'jpeg', 'webp'].includes(saved.format || '') ? saved.format as Draft['format'] : 'png',
      background: ['auto', 'opaque', 'transparent'].includes(saved.background || '') ? saved.background as Draft['background'] : 'auto',
      count: Math.min(4, Math.max(1, Number(saved.count) || 1)),
    }
  } catch {
    return defaultDraft
  }
}

function extensionFor(mimeType: ImageLibraryItem['mimeType']) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function imageBlob(src: string) {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('图片内容为空，请重新生成。')
  return blob
}

function fullImageSrc(item: ImageLibraryItem) {
  return api.imageFileUrl(item.id)
}

function thumbnailSrc(item: ImageLibraryItem) {
  return api.imageFileUrl(item.id, true)
}

function groupLabel(value: string) {
  const date = new Date(value)
  const today = new Date()
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (startDate === startToday) return '今天'
  if (startDate === startToday - 86_400_000) return '昨天'
  return date.toLocaleDateString()
}

function mergeImages(current: ImageLibraryItem[], incoming: ImageLibraryItem[]) {
  const map = new Map(current.map((item) => [item.id, item]))
  incoming.forEach((item) => map.set(item.id, item))
  return [...map.values()].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

type Props = {
  config: ModelConfig
  onSaveConfig: (payload: ModelConfigPatch) => Promise<void>
  onTestConfig: (payload: Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'imageModel' | 'apiKey'>) => Promise<ModelConfigTestResult>
}

export function ImageWorkbench({ config, onSaveConfig, onTestConfig }: Props) {
  const [initialDraft] = useState(loadDraft)
  const formRef = useRef<HTMLFormElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const startedAtRef = useRef(0)
  const lastRequestRef = useRef<{ request: ImageGenerationRequest; files: GenerationFiles } | null>(null)
  const [prompt, setPrompt] = useState(initialDraft.prompt)
  const [negativePrompt, setNegativePrompt] = useState(initialDraft.negativePrompt || '')
  const [ratio, setRatio] = useState<Draft['ratio']>(initialDraft.ratio)
  const [resolution, setResolution] = useState<Draft['resolution']>(initialDraft.resolution)
  const [quality, setQuality] = useState<Draft['quality']>(initialDraft.quality)
  const [format, setFormat] = useState<Draft['format']>(initialDraft.format)
  const [background, setBackground] = useState<Draft['background']>(initialDraft.background)
  const [count, setCount] = useState(initialDraft.count)
  const [references, setReferences] = useState<ReferenceImageFile[]>([])
  const [sourceImage, setSourceImage] = useState<ImageLibraryItem | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [lastResponse, setLastResponse] = useState<ImageGenerationResponse | null>(null)
  const [latestImages, setLatestImages] = useState<ImageLibraryItem[]>([])
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<MessageTone>('neutral')
  const [lastErrorCode, setLastErrorCode] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [library, setLibrary] = useState<ImageLibraryItem[]>([])
  const [libraryView, setLibraryView] = useState<LibraryView>('history')
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [libraryFeedback, setLibraryFeedback] = useState<{ tone: MessageTone; message: string } | null>(null)
  const [selectedImage, setSelectedImage] = useState<ImageLibraryItem | null>(null)
  const [editingImage, setEditingImage] = useState<ImageLibraryItem | null>(null)
  const [actionBusy, setActionBusy] = useState('')
  const [photoshopStatuses, setPhotoshopStatuses] = useState<Record<string, PhotoshopStatus>>({})

  const configured = config.hasApiKey && Boolean(config.imageModel)
  const connectionLabel = !configured ? '未配置' : config.lastTestStatus === 'success' ? '基础连接正常' : config.lastTestStatus === 'failed' ? '验证失败' : config.lastTestStatus === 'unverified' ? '待生成验证' : '已配置'
  const connectionTone = !configured || config.lastTestStatus === 'failed'
    ? 'bg-amber-50 text-amber-700'
    : config.lastTestStatus === 'success'
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-blue-50 text-blue-700'

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true)
    setLibraryError('')
    try {
      setLibrary((await api.images()).filter((item) => !item.isArchived).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()))
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : '生成历史读取失败。')
    } finally {
      setLibraryLoading(false)
    }
  }, [])

  useEffect(() => { void loadLibrary() }, [loadLibrary])

  useEffect(() => {
    const draft: Draft = { prompt, negativePrompt, ratio, resolution, quality, format, background, count }
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [background, count, format, negativePrompt, prompt, quality, ratio, resolution])

  useEffect(() => {
    if (format === 'jpeg' && background === 'transparent') setBackground('opaque')
  }, [background, format])

  useEffect(() => {
    if (status !== 'running') return undefined
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000))), 1000)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => () => abortRef.current?.abort(), [])

  function currentRequest(): ImageGenerationRequest {
    return {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      ratio,
      resolution,
      quality,
      format,
      background,
      count,
      sourceImageId: sourceImage?.id,
    }
  }

  function showInputError(error: string) {
    setStatus('error')
    setMessage(error)
    setMessageTone('error')
  }

  function clearInputError() {
    if (status !== 'error') return
    setStatus(latestImages.length ? 'ready' : 'idle')
    setMessage('')
    setMessageTone('neutral')
  }

  async function runGeneration(request: ImageGenerationRequest, files: GenerationFiles = {}) {
    if (!request.prompt) {
      showInputError('请输入正向提示词。')
      return false
    }
    if (!configured) {
      showInputError('先完成图片模型配置，再开始生成。')
      setConfigOpen(true)
      return false
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    lastRequestRef.current = { request, files }
    startedAtRef.current = Date.now()
    setElapsedSeconds(0)
    setLastErrorCode('')
    setStatus('running')
    setMessage('请求已提交，请保持页面打开。')
    setMessageTone('neutral')
    setLibraryFeedback(null)

    try {
      const response = await api.generateImages(request, files, controller.signal)
      if (!response.images.length) throw new Error('模型没有返回图片，请调整提示词后重试。')
      setLastResponse(response)
      setLatestImages(response.images)
      setLibrary((current) => mergeImages(current, response.images))
      setLibraryView('history')
      setLibraryFeedback(response.warnings?.length ? { tone: 'neutral', message: response.warnings.join(' ') } : null)
      setElapsedSeconds(Math.max(1, Math.round(response.durationMs / 1000)))
      setStatus('ready')
      setMessage(`已生成 ${response.images.length} 张图片并保存到历史。`)
      setMessageTone('success')
      return true
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setStatus('cancelled')
        setMessage('已停止等待。上游模型可能仍在生成并计费，完成后图片会自动写入历史。')
        setMessageTone('neutral')
      } else {
        const errorCode = error instanceof ApiError ? error.code : ''
        setLastErrorCode(errorCode)
        setStatus('error')
        setMessage(errorCode === 'MODEL_API_TIMEOUT'
          ? '生图等待超过 10 分钟，本地已停止等待；上游可能仍在处理，为避免重复计费请勿立即再次生成。'
          : errorCode === 'IMAGE_EDIT_UNSUPPORTED'
            ? '当前图片模型或兼容网关不支持图片编辑，请改用支持参考图或蒙版编辑的模型。'
            : error instanceof Error ? error.message : '图片生成失败，请重试。')
        setMessageTone('error')
      }
      return false
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function generate(event: React.FormEvent) {
    event.preventDefault()
    if (lastErrorCode === 'MODEL_API_TIMEOUT' && !window.confirm('上次请求超时后，上游可能仍在处理。现在重新提交可能重复计费，确定继续？')) return
    void runGeneration(currentRequest(), { referenceImages: references.map((image) => image.file) })
  }

  function replaceLibraryItem(updated: ImageLibraryItem) {
    setLibrary((current) => current.map((item) => item.id === updated.id ? updated : item))
    setLatestImages((current) => current.map((item) => item.id === updated.id ? updated : item))
    setSelectedImage((current) => current?.id === updated.id ? updated : current)
  }

  async function toggleFavorite(item: ImageLibraryItem) {
    setActionBusy(`favorite:${item.id}`)
    setLibraryFeedback(null)
    try {
      const updated = await api.updateImage(item.id, { isFavorite: !item.isFavorite })
      replaceLibraryItem(updated)
      setLibraryFeedback({ tone: 'success', message: updated.isFavorite ? '已加入收藏相册。' : '已从收藏相册移除。' })
    } catch (error) {
      setLibraryFeedback({ tone: 'error', message: error instanceof Error ? error.message : '收藏状态更新失败。' })
    } finally {
      setActionBusy('')
    }
  }

  async function downloadImage(item: ImageLibraryItem, index = 0) {
    setActionBusy(`download:${item.id}`)
    setLibraryFeedback({ tone: 'neutral', message: '正在准备原图下载。' })
    try {
      triggerDownload(await imageBlob(fullImageSrc(item)), `AI生图-${index + 1}-${item.id}.${extensionFor(item.mimeType)}`)
      setLibraryFeedback({ tone: 'success', message: '原图已开始下载。' })
    } catch (error) {
      setLibraryFeedback({ tone: 'error', message: error instanceof Error ? error.message : '图片下载失败。' })
    } finally {
      setActionBusy('')
    }
  }

  async function downloadLatest() {
    if (!latestImages.length) return
    if (latestImages.length === 1) {
      await downloadImage(latestImages[0])
      return
    }
    setActionBusy('download:latest')
    setLibraryFeedback({ tone: 'neutral', message: '正在打包本次生成图片。' })
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      await Promise.all(latestImages.map(async (item, index) => zip.file(`${String(index + 1).padStart(2, '0')}.${extensionFor(item.mimeType)}`, await imageBlob(fullImageSrc(item)))))
      triggerDownload(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `AI生图-${new Date().toISOString().slice(0, 10)}.zip`)
      setLibraryFeedback({ tone: 'success', message: '本次图片已打包并开始下载。' })
    } catch (error) {
      setLibraryFeedback({ tone: 'error', message: error instanceof Error ? error.message : '图片打包失败。' })
    } finally {
      setActionBusy('')
    }
  }

  async function deleteImage(item: ImageLibraryItem) {
    if (!window.confirm('确定永久删除这张生成图片？此操作不可恢复。')) return
    setActionBusy(`delete:${item.id}`)
    try {
      await api.deleteImage(item.id)
      setLibrary((current) => current.filter((candidate) => candidate.id !== item.id))
      setLatestImages((current) => current.filter((candidate) => candidate.id !== item.id))
      setSelectedImage(null)
      setPhotoshopStatuses((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
      setLibraryFeedback({ tone: 'success', message: '图片已删除。' })
    } catch (error) {
      setLibraryFeedback({ tone: 'error', message: error instanceof Error ? error.message : '图片删除失败。' })
    } finally {
      setActionBusy('')
    }
  }

  async function openInPhotoshop(item: ImageLibraryItem) {
    const previous = photoshopStatuses[item.id]
    setActionBusy(`photoshop-open:${item.id}`)
    setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: current[item.id]?.ready || false, tone: 'neutral', message: '正在创建工作副本并打开 Photoshop…' } }))
    try {
      const result = await api.openImageInPhotoshop(item.id)
      const message = result.reused
        ? `已在 ${result.applicationName} 重新打开工作副本。修改后按 Ctrl/Cmd+S 保存，再返回同步。`
        : `已在 ${result.applicationName} 打开工作副本。修改后按 Ctrl/Cmd+S 保存，再返回同步。`
      setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: true, tone: 'success', message } }))
      setLibraryFeedback({ tone: 'success', message: 'Photoshop 工作副本已打开；原图不会被覆盖。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Photoshop 打开失败。'
      setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: previous?.ready || false, tone: 'error', message } }))
      setLibraryFeedback({ tone: 'error', message })
    } finally {
      setActionBusy('')
    }
  }

  async function syncFromPhotoshop(item: ImageLibraryItem) {
    setActionBusy(`photoshop-sync:${item.id}`)
    setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: true, tone: 'neutral', message: '正在读取 Photoshop 已保存的修改…' } }))
    try {
      const result = await api.syncImageFromPhotoshop(item.id)
      setLibrary((current) => mergeImages(current, [result.image]))
      setLatestImages((current) => mergeImages(current, [result.image]))
      setLibraryView('history')
      setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: true, tone: 'success', message: 'PS 修改已作为新版本加入图片历史，原图仍保留。', latestImage: result.image } }))
      setLibraryFeedback({ tone: 'success', message: 'Photoshop 修改已同步为新的图片版本。' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Photoshop 修改同步失败。'
      setPhotoshopStatuses((current) => ({ ...current, [item.id]: { ready: true, tone: 'error', message } }))
      setLibraryFeedback({ tone: 'error', message })
    } finally {
      setActionBusy('')
    }
  }

  function scrollToSettings() {
    window.requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function reuseParameters(item: ImageLibraryItem) {
    setPrompt(item.prompt || '')
    setNegativePrompt(item.negativePrompt || '')
    setRatio(item.ratio)
    setResolution(item.resolution)
    setQuality(item.quality)
    setFormat(item.format)
    setBackground(item.background)
    setSelectedImage(null)
    setLibraryView('history')
    setMessage('历史参数已填入生成设置，确认后再生成。')
    setMessageTone('success')
    scrollToSettings()
  }

  function createFromImage(item: ImageLibraryItem) {
    if (references.length > 3) {
      references.slice(3).forEach((image) => URL.revokeObjectURL(image.previewUrl))
      setReferences(references.slice(0, 3))
    }
    setSourceImage(item)
    setSelectedImage(null)
    setLibraryView('history')
    setMessage(references.length > 3 ? '来源图已加入参考区；来源图占 1 个位置，已保留前 3 张额外参考图。' : '来源图已加入参考区，填写新提示词后再生成。')
    setMessageTone('success')
    scrollToSettings()
  }

  async function submitAnnotation(blob: Blob, mode: AnnotationExportMode, editPrompt: string, item: ImageLibraryItem) {
    if (!configured) throw new Error('图片模型未配置。请先关闭批注，完成模型配置后再编辑。')
    const extension = blob.type === 'image/webp' ? 'webp' : 'png'
    const filename = `${mode === 'mask' ? 'mask' : 'annotation'}-${item.id}.${extension}`
    const file = new File([blob], filename, { type: blob.type || 'image/png' })
    const request = {
      ...currentRequest(),
      prompt: editPrompt.trim(),
      negativePrompt: negativePrompt.trim() || item.negativePrompt || undefined,
      ratio: item.ratio,
      resolution: item.resolution,
      quality: item.quality,
      format: item.format,
      background: item.background,
      count: 1,
      sourceImageId: item.id,
      editMode: mode,
    }
    const referenceFiles = references.map((image) => image.file)
    const files = mode === 'mask'
      ? { referenceImages: referenceFiles.slice(0, 3), maskImage: file }
      : { referenceImages: [...referenceFiles.slice(0, 2), file] }
    if (mode === 'annotation' && referenceFiles.length > 2) setLibraryFeedback({ tone: 'neutral', message: '来源图和批注图各占 1 个位置，本次使用前 2 张额外参考图。' })
    const completed = await runGeneration(request, files)
    if (!completed) throw new Error('批注编辑未完成，框选和备注已保留，请根据工作台提示处理后重试。')
  }

  const visibleItems = useMemo(() => library.filter((item) => libraryView === 'history' || item.isFavorite), [library, libraryView])
  const latestIds = useMemo(() => new Set(latestImages.map((item) => item.id)), [latestImages])
  const latestVisible = visibleItems.filter((item) => latestIds.has(item.id))
  const datedGroups = useMemo(() => {
    const groups = new Map<string, ImageLibraryItem[]>()
    visibleItems.filter((item) => !latestIds.has(item.id)).forEach((item) => {
      const label = groupLabel(item.createdAt)
      groups.set(label, [...(groups.get(label) || []), item])
    })
    return [...groups.entries()]
  }, [latestIds, visibleItems])

  const runningMessage = elapsedSeconds < 60 ? '模型正在准备' : elapsedSeconds < 180 ? '模型生成中，请保持页面打开' : '兼容网关响应较慢，最多等待 10 分钟'
  const resultStatus = status === 'running' ? `生成中 · ${elapsedSeconds} 秒` : status === 'ready' ? `已完成 · ${elapsedSeconds} 秒` : status === 'error' ? '生成失败' : status === 'cancelled' ? '已取消' : '待生成'
  const resultTone = status === 'running' ? 'bg-blue-50 text-blue-700' : status === 'ready' ? 'bg-emerald-50 text-emerald-700' : status === 'error' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'

  function renderImageGrid(items: ImageLibraryItem[]) {
    return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">{items.map((item) => {
      const favoriteBusy = actionBusy === `favorite:${item.id}`
      return <article key={item.id} className="group min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition hover:border-blue-200 hover:shadow-md">
        <div className="relative aspect-square bg-slate-100">
          <button type="button" onClick={() => setSelectedImage(item)} className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500" aria-label="查看图片详情"><img src={thumbnailSrc(item)} alt="AI 生成图片缩略图" loading="lazy" decoding="async" className="h-full w-full object-contain" /></button>
          <button type="button" onClick={() => void toggleFavorite(item)} disabled={Boolean(actionBusy)} className={`absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md shadow-sm transition ${item.isFavorite ? 'bg-amber-50 text-amber-700' : 'bg-white/90 text-slate-500 hover:text-amber-600'}`} title={item.isFavorite ? '取消收藏' : '收藏'} aria-label={item.isFavorite ? '取消收藏' : '收藏'}>{favoriteBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Heart className={`h-4 w-4 ${item.isFavorite ? 'fill-current' : ''}`} />}</button>
          {latestIds.has(item.id) && <span className="absolute left-2 top-2 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">本次</span>}
        </div>
        <button type="button" onClick={() => setSelectedImage(item)} className="block w-full px-3 py-2.5 text-left">
          <div className="line-clamp-1 text-xs font-medium text-slate-700">{item.prompt || '未命名图片'}</div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400"><span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="uppercase">{item.resolution}{item.upscaled ? ' 增强' : ''} · {item.format}</span></div>
          {(item.nativeSize || item.outputSize) && <div className="mt-1 truncate text-[10px] text-slate-400">{item.nativeSize && item.outputSize && item.nativeSize !== item.outputSize ? `${item.nativeSize} → ${item.outputSize}` : item.outputSize || item.nativeSize}</div>}
        </button>
      </article>
    })}</div>
  }

  const selectedBusy = selectedImage && actionBusy.endsWith(`:${selectedImage.id}`) ? actionBusy.split(':')[0] : ''

  return (
    <>
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(370px,420px)_minmax(0,1fr)]">
        <form ref={formRef} onSubmit={generate} className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm xl:sticky xl:top-20 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-3"><span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white"><Sparkles className="h-4 w-4" /></span><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-950">生成设置</h2><div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500"><span className="truncate">{config.imageModel || '未选择图片模型'}</span><span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${connectionTone}`}>{connectionLabel}</span></div></div></div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfigOpen(true)}><Settings2 className="h-4 w-4" />配置</Button>
          </div>

          <div className="scrollbar-thin space-y-4 p-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 xl:block xl:min-h-0 xl:flex-1 xl:space-y-4 xl:overflow-y-auto">
            <label className="block" htmlFor="image-generation-prompt"><span className="text-sm font-medium text-slate-800">正向提示词</span><textarea id="image-generation-prompt" value={prompt} maxLength={4000} rows={6} required disabled={status === 'running'} onChange={(event) => { setPrompt(event.target.value); clearInputError() }} placeholder="描述主体、场景、构图、光线、材质和风格" className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50" /><span className="mt-1 block text-right text-xs text-slate-400">{prompt.length}/4000</span></label>

            <label className="block" htmlFor="image-generation-negative-prompt"><span className="text-sm font-medium text-slate-800">排除要求 <span className="font-normal text-slate-400">可选</span></span><textarea id="image-generation-negative-prompt" value={negativePrompt} maxLength={2000} rows={3} disabled={status === 'running'} onChange={(event) => { setNegativePrompt(event.target.value); clearInputError() }} placeholder="例如：不要文字、不要水印、不要杂乱背景" className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50" /><span className="mt-1 block text-xs leading-5 text-slate-400">会合并到主提示词，并非所有模型原生支持负面参数。</span></label>

            <ReferenceImagePicker images={references} sourceImage={sourceImage ? { id: sourceImage.id, previewUrl: thumbnailSrc(sourceImage) } : undefined} maxFiles={sourceImage ? 3 : 4} disabled={status === 'running'} onChange={setReferences} onClearSource={() => setSourceImage(null)} onError={(error) => showInputError(error)} />

            <fieldset disabled={status === 'running'}><legend className="text-sm font-medium text-slate-800">画面比例</legend><div className="mt-2 grid grid-cols-4 gap-1 rounded-md bg-slate-100 p-1">{ratios.map((item) => <button key={item.value} type="button" aria-pressed={ratio === item.value} onClick={() => setRatio(item.value)} className={`h-9 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${ratio === item.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item.label}</button>)}</div></fieldset>

            <fieldset disabled={status === 'running'}><legend className="text-sm font-medium text-slate-800">输出分辨率</legend><div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">{resolutions.map((item) => <button key={item.value} type="button" aria-pressed={resolution === item.value} onClick={() => setResolution(item.value)} className={`flex h-10 items-center justify-center gap-1.5 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${resolution === item.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><span>{item.label}</span><span className={`text-[10px] font-normal ${resolution === item.value ? item.note === '增强' ? 'text-blue-600' : 'text-slate-400' : 'text-slate-400'}`}>{item.note}</span></button>)}</div></fieldset>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm font-medium text-slate-800">生成质量<select disabled={status === 'running'} value={quality} onChange={(event) => setQuality(event.target.value as Draft['quality'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"><option value="low">快速</option><option value="medium">标准</option><option value="high">高清</option></select></label>
              <label className="text-sm font-medium text-slate-800">输出格式<select disabled={status === 'running'} value={format} onChange={(event) => setFormat(event.target.value as Draft['format'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm uppercase text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WEBP</option></select></label>
              <label className="text-sm font-medium text-slate-800">图片背景<select disabled={status === 'running'} value={background} onChange={(event) => setBackground(event.target.value as Draft['background'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent" disabled={format === 'jpeg'}>透明</option></select></label>
              <div className="text-sm font-medium text-slate-800">生成数量<div className="mt-2 flex h-10 items-center justify-between rounded-md border border-slate-200 bg-white"><button type="button" onClick={() => setCount((value) => Math.max(1, value - 1))} disabled={count === 1 || status === 'running'} className="inline-flex h-full w-10 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="减少一张"><Minus className="h-4 w-4" /></button><span className="text-sm font-semibold text-slate-900" aria-live="polite">{count}</span><button type="button" onClick={() => setCount((value) => Math.min(4, value + 1))} disabled={count === 4 || status === 'running'} className="inline-flex h-full w-10 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="增加一张"><Plus className="h-4 w-4" /></button></div></div>
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-200 bg-white p-4">
            {message && <p className={`mb-3 flex items-start gap-2 text-sm ${messageTone === 'error' ? 'text-red-600' : messageTone === 'success' ? 'text-emerald-700' : 'text-slate-600'}`} role={messageTone === 'error' ? 'alert' : 'status'} aria-live="polite">{status === 'running' ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : messageTone === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : messageTone === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : null}<span className="min-w-0 break-words">{status === 'running' ? runningMessage : message}</span></p>}
            {status === 'running' ? <Button type="button" variant="secondary" onClick={() => abortRef.current?.abort()} className="h-11 w-full border-red-200 text-red-700 hover:bg-red-50"><X className="h-4 w-4" />停止等待 · {elapsedSeconds} 秒</Button> : <Button type="submit" className="h-11 w-full"><WandSparkles className="h-4 w-4" />生成图片</Button>}
          </div>
        </form>

        <section className="flex min-h-[620px] min-w-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm" aria-labelledby="image-library-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5">
            <div className="min-w-0"><h2 id="image-library-title" className="text-sm font-semibold text-slate-950">图片资产</h2><p className="mt-0.5 truncate text-xs text-slate-500">{lastResponse ? `${lastResponse.model} · ${lastResponse.size}` : `${library.length} 张本地生成图片`}</p></div>
            <div className="flex flex-wrap items-center gap-2">
              {(status === 'cancelled' || (status === 'error' && lastErrorCode !== 'MODEL_API_TIMEOUT')) && lastRequestRef.current && <Button type="button" variant="secondary" size="sm" onClick={() => void runGeneration(lastRequestRef.current!.request, lastRequestRef.current!.files)}><RotateCw className="h-4 w-4" />重试</Button>}
              {latestImages.length > 0 && <Button type="button" variant="secondary" size="sm" disabled={Boolean(actionBusy)} onClick={() => void downloadLatest()}>{actionBusy === 'download:latest' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}下载本次</Button>}
              <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${resultTone}`} role="status" aria-live="polite">{status === 'running' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : status === 'ready' ? <Check className="h-3.5 w-3.5" /> : status === 'error' ? <CircleAlert className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}{resultStatus}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
            <div className="flex gap-1 rounded-md bg-slate-100 p-1" role="tablist" aria-label="图片资产视图"><button type="button" role="tab" aria-selected={libraryView === 'history'} onClick={() => setLibraryView('history')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${libraryView === 'history' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}><Clock3 className="h-3.5 w-3.5" />生成历史</button><button type="button" role="tab" aria-selected={libraryView === 'favorites'} onClick={() => setLibraryView('favorites')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${libraryView === 'favorites' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}><Heart className="h-3.5 w-3.5" />收藏相册</button></div>
            <button type="button" onClick={() => void loadLibrary()} disabled={libraryLoading} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新图片资产" aria-label="刷新图片资产"><RefreshCw className={`h-4 w-4 ${libraryLoading ? 'animate-spin' : ''}`} /></button>
          </div>

          {status === 'running' && <div className="bg-blue-50 px-4 py-3" role="status"><div className="flex items-center justify-between gap-3 text-sm"><span className="flex min-w-0 items-center gap-2 font-medium text-blue-900"><LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />{runningMessage}</span><span className="shrink-0 text-blue-700">{elapsedSeconds} 秒</span></div><div className="mt-2 h-1 overflow-hidden bg-blue-100"><div className="h-full w-1/3 animate-pulse bg-blue-600 motion-reduce:animate-none" /></div></div>}
          {libraryFeedback && <div className={`border-b px-4 py-2 text-xs ${libraryFeedback.tone === 'error' ? 'border-red-100 bg-red-50 text-red-700' : libraryFeedback.tone === 'success' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-50 text-slate-600'}`} role={libraryFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{libraryFeedback.message}</div>}

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-3 sm:p-4">
            {libraryLoading && !library.length ? <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="h-5 w-5 animate-spin" />正在读取图片资产</div>
              : libraryError && !library.length ? <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center"><CircleAlert className="h-7 w-7 text-red-500" /><div className="text-sm text-red-700">{libraryError}</div><Button type="button" variant="secondary" size="sm" onClick={() => void loadLibrary()}><RefreshCw className="h-4 w-4" />重新读取</Button></div>
                : visibleItems.length ? <div className="space-y-6">{latestVisible.length > 0 && <section><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-blue-700">本次结果</h3><span className="text-[11px] text-slate-400">{latestVisible.length} 张</span></div>{renderImageGrid(latestVisible)}</section>}{datedGroups.map(([label, items]) => <section key={label}><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-slate-600">{label}</h3><span className="text-[11px] text-slate-400">{items.length} 张</span></div>{renderImageGrid(items)}</section>)}</div>
                  : <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center text-slate-400"><span className="inline-flex h-14 w-14 items-center justify-center rounded-md border border-slate-200 bg-white">{libraryView === 'favorites' ? <Heart className="h-7 w-7" /> : <Images className="h-7 w-7" />}</span><span className="text-sm font-medium text-slate-600">{libraryView === 'favorites' ? '还没有收藏图片' : '生成的图片会保存在这里'}</span><span className="text-xs">{libraryView === 'favorites' ? '在图片右上角点击收藏' : '完成首次生成后自动进入历史'}</span></div>}
          </div>
        </section>
      </div>

      {selectedImage && <ImageDetailDialog item={selectedImage} src={fullImageSrc(selectedImage)} busy={selectedBusy} onClose={() => setSelectedImage(null)} onDownload={() => void downloadImage(selectedImage)} onDelete={() => void deleteImage(selectedImage)} onToggleFavorite={() => void toggleFavorite(selectedImage)} onEdit={() => { setEditingImage(selectedImage); setSelectedImage(null) }} photoshopStatus={photoshopStatuses[selectedImage.id]} onPhotoshopOpen={() => void openInPhotoshop(selectedImage)} onPhotoshopSync={() => void syncFromPhotoshop(selectedImage)} onViewPhotoshopVersion={(item) => setSelectedImage(item)} onReuse={() => reuseParameters(selectedImage)} onCreateFrom={() => createFromImage(selectedImage)} />}
      {editingImage && <ImageAnnotationDialog item={editingImage} src={fullImageSrc(editingImage)} onClose={() => setEditingImage(null)} onSubmit={(blob, mode, editPrompt) => submitAnnotation(blob, mode, editPrompt, editingImage)} />}
      {configOpen && <ModelConfigPanel config={config} onSave={async (payload) => { await onSaveConfig(payload); setConfigOpen(false) }} onTest={onTestConfig} onClose={() => setConfigOpen(false)} />}
    </>
  )
}
