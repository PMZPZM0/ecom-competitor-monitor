import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  CircleAlert,
  Clock3,
  Download,
  Heart,
  Images,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { ApiError, api } from '../../lib/api'
import type {
  ImageGenerationJob,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageLibraryItem,
  ModelConfig,
} from '../../types/domain'
import type { PromptEnhancementResult, PromptReferenceFiles, QuickPromptRequest } from '../prompt-studio/types'
import { visibleNegativePrompt, visiblePrompt } from '../prompt-studio/promptLayers'
import { ImageAnnotationDialog, type AnnotationExportMode } from './ImageAnnotationDialog'
import { ImageDetailDialog } from './ImageDetailDialog'
import { ImageJobQueue } from './ImageJobQueue'
import { clearImageJobOutbox, clearRequestOutbox, getOrCreateImageJobOutbox, getOrCreateRequestOutbox } from './imageJobOutbox'
import { IMAGE_PROMPT_LIMITS, overlongImagePrompt } from './imagePromptLimits'
import { createLatestRequestGate, newlySucceededJobs } from './imageJobRequestGate'
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
const PROMPT_ENHANCEMENT_OUTBOX_KEY = 'ecommerce-monitor-prompt-enhancement-outbox-v2'

type MessageTone = 'neutral' | 'success' | 'error'
type LibraryView = 'history' | 'favorites'
type CreationMode = 'product' | 'free'
type Draft = Pick<ImageGenerationRequest, 'prompt' | 'negativePrompt' | 'ratio' | 'resolution' | 'quality' | 'format' | 'background' | 'count'> & {
  creationMode: CreationMode
  promptReady: boolean
}
type GenerationFiles = { referenceImages?: File[]; maskImage?: Blob }
type PhotoshopStatus = {
  ready: boolean
  tone: MessageTone
  message: string
  latestImage?: ImageLibraryItem
}

export type ImageWorkbenchDraftTransfer = {
  id: string
  prompt: string
  negativePrompt?: string
  ratio: ImageGenerationRequest['ratio']
  resolution: ImageGenerationRequest['resolution']
  quality: ImageGenerationRequest['quality']
  format: ImageGenerationRequest['format']
  background: ImageGenerationRequest['background']
  referenceImages: File[]
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
  creationMode: 'product',
  promptReady: false,
}

const promptTemplates = [
  { label: '清理背景', prompt: '清理背景中的杂物，让画面干净整洁，主体位置与构图保持不变。' },
  { label: '增强质感', prompt: '优化光线、反射与材质质感，让产品更清晰自然，不改变产品形态和颜色。' },
  { label: '移动配件', prompt: '优化配件的摆放位置与角度，使画面协调自然，其余内容保持不变。' },
  { label: '白底主图', prompt: '改为纯净白色背景，保留真实自然的接触阴影，产品主体完整居中。' },
  { label: '厨房场景', prompt: '将背景改为干净整洁的现代厨房场景，光线自然，产品主体保持不变。' },
  { label: '优化文案区', prompt: '调整留白，为已确认的文字信息安排清晰的排版区域；文字内容继续逐字保留。' },
] as const

function loadDraft(): Draft {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}') as Partial<Draft>
    const savedPrompt = typeof saved.prompt === 'string' ? saved.prompt : ''
    const savedNegativePrompt = typeof saved.negativePrompt === 'string' ? saved.negativePrompt : ''
    return {
      prompt: visiblePrompt(savedPrompt),
      negativePrompt: visibleNegativePrompt(savedNegativePrompt),
      ratio: ratios.some((item) => item.value === saved.ratio) ? saved.ratio as Draft['ratio'] : '1:1',
      resolution: resolutions.some((item) => item.value === saved.resolution) ? saved.resolution as Draft['resolution'] : '1k',
      quality: ['low', 'medium', 'high'].includes(saved.quality || '') ? saved.quality as Draft['quality'] : 'medium',
      format: ['png', 'jpeg', 'webp'].includes(saved.format || '') ? saved.format as Draft['format'] : 'png',
      background: ['auto', 'opaque', 'transparent'].includes(saved.background || '') ? saved.background as Draft['background'] : 'auto',
      count: saved.count === 2 || saved.count === 4 ? saved.count : 1,
      creationMode: saved.creationMode === 'free' ? 'free' : 'product',
      // Reference images are intentionally not persisted, so a ready prompt cannot
      // safely survive a reload without its original product-image provenance.
      promptReady: false,
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

function promptHelpErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if ((error instanceof ApiError && error.status === 524) || /\b524\b|gateway timeout|请求超时|响应超时/i.test(message)) {
    return 'AI 帮写响应超时，原内容已保留。你可以直接生成，或稍后再次点击“AI 帮写”。'
  }
  return message || 'AI 帮写失败，原内容已保留。你仍可直接生成。'
}

type Props = {
  config: ModelConfig
  active?: boolean
  onOpenModelSettings: () => void
  onEnhancePrompt: (request: QuickPromptRequest, files: PromptReferenceFiles) => Promise<PromptEnhancementResult>
  onOpenProfessionalPrompt: () => void
  incomingDraft?: ImageWorkbenchDraftTransfer | null
}

export function ImageWorkbench({ config, active = true, onOpenModelSettings, onEnhancePrompt, onOpenProfessionalPrompt, incomingDraft }: Props) {
  const [initialDraft] = useState(loadDraft)
  const formRef = useRef<HTMLFormElement>(null)
  const incomingDraftIdRef = useRef('')
  const firstConfigPromptRef = useRef(false)
  const promptEditRevisionRef = useRef(0)
  const jobsRef = useRef<ImageGenerationJob[]>([])
  const jobsHydratedRef = useRef(false)
  const jobsFingerprintRef = useRef('')
  const [jobReadGate] = useState(createLatestRequestGate)
  const [libraryReadGate] = useState(createLatestRequestGate)
  const [prompt, setPrompt] = useState(initialDraft.prompt)
  const [negativePrompt, setNegativePrompt] = useState(initialDraft.negativePrompt || '')
  const [ratio, setRatio] = useState<Draft['ratio']>(initialDraft.ratio)
  const [resolution, setResolution] = useState<Draft['resolution']>(initialDraft.resolution)
  const [quality, setQuality] = useState<Draft['quality']>(initialDraft.quality)
  const [format, setFormat] = useState<Draft['format']>(initialDraft.format)
  const [background, setBackground] = useState<Draft['background']>(initialDraft.background)
  const [count, setCount] = useState(initialDraft.count)
  const [creationMode, setCreationMode] = useState<CreationMode>(initialDraft.creationMode)
  const [promptReady, setPromptReady] = useState(initialDraft.promptReady)
  const [references, setReferences] = useState<ReferenceImageFile[]>([])
  const [sourceImage, setSourceImage] = useState<ImageLibraryItem | null>(null)
  const [lastResponse, setLastResponse] = useState<ImageGenerationResponse | null>(null)
  const [latestImages, setLatestImages] = useState<ImageLibraryItem[]>([])
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<MessageTone>('neutral')
  const [helpingPrompt, setHelpingPrompt] = useState(false)
  const [promptHelpFeedback, setPromptHelpFeedback] = useState<{ tone: MessageTone; message: string } | null>(null)
  const [enqueuing, setEnqueuing] = useState(false)
  const [jobs, setJobs] = useState<ImageGenerationJob[]>([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError, setQueueError] = useState('')
  const [queueBusyJobId, setQueueBusyJobId] = useState('')
  const [library, setLibrary] = useState<ImageLibraryItem[]>([])
  const [libraryView, setLibraryView] = useState<LibraryView>('history')
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [libraryFeedback, setLibraryFeedback] = useState<{ tone: MessageTone; message: string } | null>(null)
  const [selectedImage, setSelectedImage] = useState<ImageLibraryItem | null>(null)
  const [editingImage, setEditingImage] = useState<ImageLibraryItem | null>(null)
  const [actionBusy, setActionBusy] = useState('')
  const [photoshopStatuses, setPhotoshopStatuses] = useState<Record<string, PhotoshopStatus>>({})

  const activeChannelState = config.channelStates?.[config.channel]
  const imageConfigured = config.hasApiKey && Boolean(config.imageModel)
  const promptConfigured = config.hasApiKey && Boolean(config.model)
  const configured = imageConfigured && promptConfigured
  const promptTestStatus = activeChannelState?.testStates?.prompt.lastTestStatus
    || (activeChannelState?.lastTestTarget === 'prompt' ? activeChannelState.lastTestStatus : null)
  const imageTestStatus = activeChannelState?.testStates?.image.lastTestStatus
    || (activeChannelState?.lastTestTarget === 'image' ? activeChannelState.lastTestStatus : null)
  const connectionFailed = promptTestStatus === 'failed' || imageTestStatus === 'failed'
  const connectionLabel = !configured
    ? '未配置'
    : connectionFailed
      ? promptTestStatus === 'failed' ? '提示词连接异常' : '生图连接异常'
      : 'Key 已配置'
  const connectionTone = !configured || connectionFailed
    ? 'bg-amber-50 text-amber-700'
    : promptTestStatus === 'success' && imageTestStatus === 'success'
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-blue-50 text-blue-700'
  const channelLabel = config.channel === 'fast' ? '高速通道' : config.channel === 'custom' ? '自定义通道' : '稳定通道'

  useEffect(() => {
    if (!active || config.hasApiKey || firstConfigPromptRef.current) return
    firstConfigPromptRef.current = true
    onOpenModelSettings()
  }, [active, config.hasApiKey, onOpenModelSettings])

  const loadLibrary = useCallback(async () => {
    const revision = libraryReadGate.begin()
    setLibraryLoading(true)
    try {
      const incoming = (await api.images()).filter((item) => !item.isArchived).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      if (!libraryReadGate.isCurrent(revision)) return
      setLibraryError('')
      setLibrary(incoming)
    } catch (error) {
      if (!libraryReadGate.isCurrent(revision)) return
      setLibraryError(error instanceof Error ? error.message : '生成历史读取失败。')
    } finally {
      if (libraryReadGate.isCurrent(revision)) setLibraryLoading(false)
    }
  }, [libraryReadGate])

  const acceptJobs = useCallback((incoming: ImageGenerationJob[]) => {
    const sorted = [...incoming].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    const fingerprint = JSON.stringify(sorted.map((job) => [
      job.id,
      job.status,
      job.queuePosition ?? job.position ?? null,
      job.updatedAt,
      job.attempt,
      job.result?.images.map((image) => image.id) || [],
      job.error?.code || '',
      job.error?.message || '',
    ]))
    if (jobsFingerprintRef.current === fingerprint) return
    const newlySucceeded = newlySucceededJobs(jobsRef.current, sorted, jobsHydratedRef.current)
    jobsFingerprintRef.current = fingerprint
    jobsRef.current = sorted
    jobsHydratedRef.current = true
    setJobs(sorted)
    if (newlySucceeded.length) {
      const images = newlySucceeded.flatMap((job) => job.result?.images || [])
      const latestResponse = newlySucceeded[0].result
      libraryReadGate.invalidate()
      setLibrary((current) => mergeImages(current, images))
      setLatestImages(latestResponse?.images || [])
      setLastResponse(latestResponse)
      setLibraryView('history')
      setLibraryFeedback(latestResponse?.warnings?.length ? { tone: 'neutral', message: latestResponse.warnings.join(' ') } : { tone: 'success', message: `${images.length} 张图片已生成并保存到历史。` })
      void loadLibrary()
    } else {
      setLastResponse((current) => current || sorted.find((job) => job.status === 'succeeded' && job.result)?.result || null)
    }
  }, [libraryReadGate, loadLibrary])

  const loadJobs = useCallback(async (silent = false) => {
    const revision = jobReadGate.begin()
    if (!silent) setQueueLoading(true)
    try {
      const incoming = await api.imageJobs()
      if (!jobReadGate.isCurrent(revision)) return
      setQueueError('')
      acceptJobs(incoming)
    } catch (error) {
      if (!jobReadGate.isCurrent(revision)) return
      setQueueError(error instanceof Error ? error.message : '生图队列读取失败。')
    } finally {
      if (jobReadGate.isCurrent(revision)) setQueueLoading(false)
    }
  }, [acceptJobs, jobReadGate])

  useEffect(() => {
    void (async () => {
      await loadJobs(false)
      await loadLibrary()
    })()
  }, [loadJobs, loadLibrary])

  useEffect(() => {
    const draft: Draft = {
      prompt,
      negativePrompt,
      ratio,
      resolution,
      quality,
      format,
      background,
      count,
      creationMode,
      promptReady: false,
    }
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [background, count, creationMode, format, negativePrompt, prompt, quality, ratio, resolution])

  useEffect(() => {
    if (!incomingDraft || incomingDraftIdRef.current === incomingDraft.id) return
    incomingDraftIdRef.current = incomingDraft.id
    const incomingNegativePrompt = incomingDraft.negativePrompt || ''
    const lengthError = overlongImagePrompt(incomingDraft.prompt, incomingNegativePrompt)
    if (lengthError) {
      setMessage(`同步失败：${lengthError.label}共 ${lengthError.length} 个字符，超过 AI 创作上限 ${lengthError.limit} 个。内容未被截断，请返回专业提示词精简后重新同步。`)
      setMessageTone('error')
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    setPrompt(visiblePrompt(incomingDraft.prompt))
    setNegativePrompt(visibleNegativePrompt(incomingNegativePrompt))
    setRatio(incomingDraft.ratio)
    setResolution(incomingDraft.resolution)
    setQuality(incomingDraft.quality)
    setFormat(incomingDraft.format)
    setBackground(incomingDraft.background)
    setCount(1)
    setCreationMode(incomingDraft.referenceImages.length ? 'product' : 'free')
    setPromptReady(true)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback({ tone: 'success', message: '专业提示词已同步，可继续修改后直接生成。' })
    setSourceImage(null)
    setReferences((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.previewUrl))
      return incomingDraft.referenceImages.slice(0, 4).map((file, index) => ({
        id: `${incomingDraft.id}-${index}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }))
    })
    setMessage('专业提示词和参考图已同步，将直接加入生图队列，不再二次改写。')
    setMessageTone('success')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [incomingDraft])

  useEffect(() => {
    if (format === 'jpeg' && background === 'transparent') setBackground('opaque')
  }, [background, format])

  const hasActiveJobs = jobs.some((job) => job.status === 'queued' || job.status === 'running')

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void loadJobs(true) }
    const timer = window.setInterval(refresh, hasActiveJobs ? 1800 : 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [hasActiveJobs, loadJobs])

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
    setMessage(error)
    setMessageTone('error')
  }

  function clearInputError() {
    if (messageTone !== 'error') return
    setMessage('')
    setMessageTone('neutral')
  }

  function selectCreationMode(nextMode: CreationMode) {
    if (nextMode === creationMode) return
    setCreationMode(nextMode)
    setPromptReady(false)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback(null)
  }

  function changeReferences(nextReferences: ReferenceImageFile[]) {
    setReferences(nextReferences)
    setPromptReady(false)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback(null)
  }

  function upsertJob(nextJob: ImageGenerationJob) {
    jobReadGate.invalidate()
    setQueueLoading(false)
    acceptJobs([nextJob, ...jobsRef.current.filter((job) => job.id !== nextJob.id)])
  }

  async function enqueueGeneration(request: ImageGenerationRequest, files: GenerationFiles = {}) {
    if (!request.prompt) {
      showInputError('请输入正向提示词。')
      return false
    }
    const lengthError = overlongImagePrompt(request.prompt, request.negativePrompt)
    if (lengthError) {
      showInputError(`${lengthError.label}不能超过 ${lengthError.limit} 个字符，请精简后重试。`)
      return false
    }
    if (!imageConfigured) {
      showInputError('先完成图片模型配置，再开始生成。')
      onOpenModelSettings()
      return false
    }

    setEnqueuing(true)
    setMessage('正在保存任务与参考图…')
    setMessageTone('neutral')
    setLibraryFeedback(null)
    let storage: Storage | null = null
    try { storage = window.localStorage } catch { /* Continue with in-memory idempotency for this attempt. */ }

    try {
      const outbox = await getOrCreateImageJobOutbox(storage, request, files)
      const job = await api.createImageJob(request, files, outbox.key)
      clearImageJobOutbox(storage, outbox.key)
      upsertJob(job)
      setMessage(job.queuePosition && job.queuePosition > 1 ? `已加入生图队列，当前第 ${job.queuePosition} 位。你可以继续填写并提交下一张。` : '已加入生图队列。你可以继续填写并提交下一张。')
      setMessageTone('success')
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务加入队列失败，请重试。')
      setMessageTone('error')
      return false
    } finally {
      setEnqueuing(false)
    }
  }

  async function promptFilesForEnhancement(referenceSnapshot: ReferenceImageFile[], sourceSnapshot: ImageLibraryItem | null) {
    if (!sourceSnapshot) return referenceSnapshot.map((image) => image.file)
    const blob = await imageBlob(fullImageSrc(sourceSnapshot))
    const extension = extensionFor(sourceSnapshot.mimeType)
    const sourceFile = new File([blob], `历史产品图-${sourceSnapshot.id}.${extension}`, { type: sourceSnapshot.mimeType })
    return [sourceFile, ...referenceSnapshot.slice(0, 2).map((image) => image.file)]
  }

  async function helpWritePrompt() {
    const request = currentRequest()
    if (!request.prompt) {
      setPromptHelpFeedback({ tone: 'error', message: '先写一句你的需求，再让 AI 帮你整理。' })
      return
    }
    if (!promptConfigured) {
      setPromptHelpFeedback({ tone: 'error', message: 'AI 帮写需要先配置提示词模型。' })
      onOpenModelSettings()
      return
    }

    const referenceSnapshot = [...references]
    const sourceSnapshot = sourceImage
    const revision = promptEditRevisionRef.current
    setHelpingPrompt(true)
    setPromptHelpFeedback({ tone: 'neutral', message: '真实文字模型正在自由创作最终提示词…' })
    try {
      const productReferenceFiles = await promptFilesForEnhancement(referenceSnapshot, sourceSnapshot)
      const enhancementRequest: QuickPromptRequest = {
        userRequest: request.prompt,
        creationMode,
        saveHistory: false,
        parameters: { ratio: request.ratio, resolution: request.resolution, quality: request.quality, background: request.background },
      }
      let promptStorage: Storage | null = null
      try { promptStorage = window.localStorage } catch { /* Continue with in-memory idempotency for this attempt. */ }
      const promptOutbox = await getOrCreateRequestOutbox(
        promptStorage,
        PROMPT_ENHANCEMENT_OUTBOX_KEY,
        enhancementRequest,
        { referenceImages: productReferenceFiles },
      )
      const result = await onEnhancePrompt(
        { ...enhancementRequest, clientRequestId: promptOutbox.key },
        { productReferenceFiles, styleReferenceFiles: [] },
      )
      if (!result.prompt.trim()) throw new Error('AI 没有返回可用提示词，原内容已保留。')
      const lengthError = overlongImagePrompt(result.prompt, request.negativePrompt)
      if (lengthError) throw new Error(`AI 返回的${lengthError.label}超过 ${lengthError.limit} 个字符，原内容已保留。请重试或使用专业提示词。`)
      if (promptEditRevisionRef.current !== revision) {
        setPromptHelpFeedback({ tone: 'neutral', message: 'AI 帮写已完成，但你刚刚修改了内容，因此没有覆盖输入框。再次点击即可按最新内容帮写。' })
        return
      }
      clearRequestOutbox(promptStorage, PROMPT_ENHANCEMENT_OUTBOX_KEY, promptOutbox.key)
      setPrompt(result.prompt.trim())
      setPromptReady(true)
      setPromptHelpFeedback({ tone: 'success', message: `AI 已自由帮写并填回输入框（${result.model}），你可以继续修改。` })
    } catch (error) {
      setPromptHelpFeedback({ tone: 'error', message: promptHelpErrorMessage(error) })
    } finally {
      setHelpingPrompt(false)
    }
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault()
    if (enqueuing) return
    const referenceSnapshot = [...references]
    if (creationMode === 'product' && !sourceImage && !referenceSnapshot.length) {
      showInputError('商品生图必须先添加至少一张产品参考图，避免产品外观和结构跑偏。')
      return
    }
    promptEditRevisionRef.current += 1
    await enqueueGeneration(currentRequest(), { referenceImages: referenceSnapshot.map((image) => image.file) })
  }

  async function retryJob(job: ImageGenerationJob) {
    setQueueBusyJobId(job.id)
    try {
      upsertJob(await api.retryImageJob(job.id))
      setMessage('任务已重新加入队列。')
      setMessageTone('success')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : '任务重试失败。')
    } finally {
      setQueueBusyJobId('')
    }
  }

  async function cancelJob(job: ImageGenerationJob) {
    setQueueBusyJobId(job.id)
    try {
      upsertJob(await api.cancelImageJob(job.id))
      setMessage('任务已取消；正在运行的上游请求会尽力中止。')
      setMessageTone('neutral')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : '任务取消失败。')
    } finally {
      setQueueBusyJobId('')
    }
  }

  function applyPromptTemplate(template: string) {
    const nextPrompt = prompt.trim() ? `${prompt.trim()}\n${template}` : template
    if (nextPrompt.length > IMAGE_PROMPT_LIMITS.prompt) {
      showInputError(`添加模板后会超过 ${IMAGE_PROMPT_LIMITS.prompt} 个字符，原提示词未被截断。请先精简内容。`)
      return
    }
    setPrompt(nextPrompt)
    promptEditRevisionRef.current += 1
    setPromptReady(false)
    setPromptHelpFeedback(null)
    clearInputError()
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
      setLatestImages([result.image])
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
    setPrompt(visiblePrompt(item.prompt))
    setNegativePrompt(visibleNegativePrompt(item.negativePrompt))
    setPromptReady(true)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback({ tone: 'success', message: '历史提示词已填入，可继续修改后直接生成。' })
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
    references.forEach((image) => URL.revokeObjectURL(image.previewUrl))
    setReferences([])
    setSourceImage(item)
    setCreationMode('product')
    setPromptReady(false)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback(null)
    setPrompt('')
    setNegativePrompt('')
    setRatio(item.ratio)
    setResolution(item.resolution)
    setQuality(item.quality)
    setFormat(item.format)
    setBackground(item.background)
    setSelectedImage(null)
    setLibraryView('history')
    setMessage('已进入严格保留原图模式并同步原图参数。只需填写想修改的内容。')
    setMessageTone('success')
    scrollToSettings()
  }

  async function submitAnnotation(blob: Blob, mode: AnnotationExportMode, editPrompt: string, item: ImageLibraryItem, maskBlob?: Blob) {
    if (!imageConfigured) throw new Error('图片模型未配置。请先关闭批注，完成模型配置后再编辑。')
    const extension = blob.type === 'image/webp' ? 'webp' : 'png'
    const filename = `${mode === 'mask' ? 'mask' : 'annotation'}-${item.id}.${extension}`
    const file = new File([blob], filename, { type: blob.type || 'image/png' })
    const request = {
      ...currentRequest(),
      prompt: editPrompt.trim(),
      negativePrompt: undefined,
      ratio: item.ratio,
      resolution: item.resolution,
      quality: item.quality,
      format: item.format,
      background: item.background,
      count: 1,
      sourceImageId: item.id,
      editMode: mode,
    }
    const files = mode === 'mask'
      ? { maskImage: file }
      : {
          referenceImages: [file],
          ...(maskBlob ? { maskImage: maskBlob } : {}),
        }
    const enqueued = await enqueueGeneration(request, files)
    if (!enqueued) throw new Error('批注任务未能加入队列，请根据工作台提示处理后重试。')
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

  const sourceRatioChanged = Boolean(sourceImage && ratio !== sourceImage.ratio)

  function renderImageGrid(items: ImageLibraryItem[]) {
    return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">{items.map((item) => {
      const favoriteBusy = actionBusy === `favorite:${item.id}`
      const deleteBusy = actionBusy === `delete:${item.id}`
      const downloadBusy = actionBusy === `download:${item.id}`
      return <article key={item.id} className="group min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition hover:border-blue-200 hover:shadow-md">
        <div className="relative aspect-square bg-slate-100">
          <button type="button" onClick={() => setSelectedImage(item)} className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500" aria-label="查看图片详情"><img src={thumbnailSrc(item)} alt="AI 生成图片缩略图" loading="lazy" decoding="async" className="h-full w-full object-contain" /></button>
          <div className="absolute right-2 top-2 flex items-center gap-1.5">
            <button type="button" onClick={() => void toggleFavorite(item)} disabled={Boolean(actionBusy)} className={`inline-flex h-8 w-8 items-center justify-center rounded-md shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${item.isFavorite ? 'bg-amber-50 text-amber-700' : 'bg-white/90 text-slate-500 hover:text-amber-600'}`} title={item.isFavorite ? '取消收藏' : '收藏'} aria-label={item.isFavorite ? '取消收藏' : '收藏'}>{favoriteBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Heart className={`h-4 w-4 ${item.isFavorite ? 'fill-current' : ''}`} />}</button>
            <button type="button" onClick={() => void deleteImage(item)} disabled={Boolean(actionBusy)} className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/90 text-slate-500 shadow-sm transition hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" title="删除图片" aria-label="删除这张图片">{deleteBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button>
          </div>
          {latestIds.has(item.id) && <span className="absolute left-2 top-2 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">本次</span>}
        </div>
        <div className="flex items-stretch">
          <button type="button" onClick={() => setSelectedImage(item)} className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
            <div className="line-clamp-1 text-xs font-medium text-slate-700">{visiblePrompt(item.prompt) || '未命名图片'}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400"><span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="truncate uppercase">{item.resolution}{item.upscaled ? ' 增强' : ''} · {item.format}</span></div>
            {(item.nativeSize || item.outputSize) && <div className="mt-1 truncate text-[10px] text-slate-400">{item.nativeSize && item.outputSize && item.nativeSize !== item.outputSize ? `${item.nativeSize} → ${item.outputSize}` : item.outputSize || item.nativeSize}</div>}
          </button>
          <div className="flex shrink-0 items-center pr-2">
            <button type="button" onClick={() => void downloadImage(item)} disabled={Boolean(actionBusy)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50" title="下载图片" aria-label="下载这张图片">{downloadBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</button>
          </div>
        </div>
      </article>
    })}</div>
  }

  const selectedBusy = selectedImage && actionBusy.endsWith(`:${selectedImage.id}`) ? actionBusy.split(':')[0] : ''

  return (
    <>
      <div className="creative-workspace grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(370px,420px)_minmax(0,1fr)]">
        <form ref={formRef} onSubmit={generate} className="creative-surface min-w-0 rounded-md border border-white/70 shadow-sm xl:sticky xl:top-20 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-3"><span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white"><Sparkles className="h-4 w-4" /></span><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-950">AI 创作台</h2><div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500"><span>提示词可直接写或让 AI 帮写</span><button type="button" onClick={onOpenModelSettings} className={`max-w-48 truncate rounded px-1.5 py-0.5 font-medium ${connectionTone}`} title={`${channelLabel} · ${config.imageModel || '未选择生图模型'} · ${connectionLabel}`}>{channelLabel} · {config.imageModel || connectionLabel}</button></div></div></div>
            <div className="flex items-center gap-1.5"><Button type="button" variant="ghost" size="sm" onClick={onOpenProfessionalPrompt}>专业提示词</Button><Button type="button" variant="secondary" size="sm" onClick={onOpenModelSettings} title="去设置中心配置 AI 模型"><Settings2 className="h-4 w-4" />设置中心</Button></div>
          </div>

          <div className="scrollbar-thin min-h-0 space-y-5 p-4 xl:flex-1 xl:overflow-y-auto">
            <fieldset>
              <legend className="sr-only">创作模式</legend>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
                <button type="button" aria-pressed={creationMode === 'product'} onClick={() => selectCreationMode('product')} className={`min-h-12 rounded px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${creationMode === 'product' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><span className="block text-sm font-semibold">商品生图</span><span className="mt-0.5 block text-[11px]">参考图锁定产品</span></button>
                <button type="button" aria-pressed={creationMode === 'free'} onClick={() => selectCreationMode('free')} className={`min-h-12 rounded px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${creationMode === 'free' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><span className="block text-sm font-semibold">自由生图</span><span className="mt-0.5 block text-[11px]">参考图可以不传</span></button>
              </div>
            </fieldset>

            <ReferenceImagePicker
              images={references}
              sourceImage={sourceImage ? { id: sourceImage.id, previewUrl: thumbnailSrc(sourceImage) } : undefined}
              maxFiles={sourceImage ? 2 : promptReady ? Math.max(3, references.length) : 3}
              required={creationMode === 'product'}
              description={creationMode === 'product' ? '上传产品正面或能看清结构的图片，AI 会优先保持外观、颜色、Logo 和原有文字。' : '需要沿用产品、人物或风格时再上传。'}
              disabled={false}
              onChange={changeReferences}
              onClearSource={() => { setSourceImage(null); setPromptReady(false); promptEditRevisionRef.current += 1; setPromptHelpFeedback(null) }}
              onError={(error) => showInputError(error)}
            />

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-medium text-slate-800" htmlFor="image-generation-prompt">{sourceImage ? '想修改什么？' : '你想生成什么？'}</label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${promptReady ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}><ShieldCheck className="h-3 w-3" />{promptReady ? 'AI 已帮写，可继续修改' : '可直接生成'}</span>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void helpWritePrompt()} disabled={helpingPrompt || !prompt.trim()} aria-busy={helpingPrompt} title="把当前一句需求整理成完整提示词，并直接填回输入框">
                    {helpingPrompt ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                    {helpingPrompt ? '正在帮写' : 'AI 帮写'}
                  </Button>
                </div>
              </div>
              {sourceImage && <p className="mt-1.5 text-xs leading-5 text-slate-500">只写想修改的部分。未指定的产品结构、颜色、文字和视角会尽量保持。</p>}
              <textarea id="image-generation-prompt" value={prompt} maxLength={IMAGE_PROMPT_LIMITS.prompt} rows={5} required onChange={(event) => { setPrompt(event.target.value); promptEditRevisionRef.current += 1; clearInputError() }} placeholder={sourceImage ? '例如：把背景改成明亮的现代厨房，产品和文字保持原样' : creationMode === 'product' ? '例如：把产品放进明亮的现代厨房，画面干净，产品保持原样' : '例如：雨后的未来城市街道，电影感夜景，蓝绿色灯光'} className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              {promptHelpFeedback && <p className={`mt-2 flex items-start gap-1.5 text-xs leading-5 ${promptHelpFeedback.tone === 'error' ? 'text-red-600' : promptHelpFeedback.tone === 'success' ? 'text-emerald-700' : 'text-slate-600'}`} role={promptHelpFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{helpingPrompt ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : promptHelpFeedback.tone === 'error' ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : promptHelpFeedback.tone === 'success' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}<span>{promptHelpFeedback.message}</span></p>}
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="常用需求">{promptTemplates.map((template) => <button key={template.label} type="button" onClick={() => applyPromptTemplate(template.prompt)} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">{template.label}</button>)}</div>
              <span className="mt-1 block text-right text-xs text-slate-400">{prompt.length}/{IMAGE_PROMPT_LIMITS.prompt}</span>
            </div>

            <fieldset><legend className="text-sm font-medium text-slate-800">画面比例</legend><div className="mt-2 grid grid-cols-4 gap-1 rounded-md bg-slate-100 p-1">{ratios.map((item) => <button key={item.value} type="button" aria-pressed={ratio === item.value} onClick={() => setRatio(item.value)} className={`h-9 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${ratio === item.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item.label}</button>)}</div>{sourceRatioChanged && <p className="mt-1.5 text-xs leading-5 text-amber-700">比例与原图不同，只会为适配新画布进行必要的扩图或裁切。</p>}</fieldset>

            <div className="grid grid-cols-2 gap-3">
              <fieldset><legend className="text-sm font-medium text-slate-800">清晰度</legend><div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">{resolutions.map((item) => <button key={item.value} type="button" aria-pressed={resolution === item.value} onClick={() => setResolution(item.value)} className={`flex h-10 items-center justify-center gap-1 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${resolution === item.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><span>{item.label}</span></button>)}</div></fieldset>
              <fieldset><legend className="text-sm font-medium text-slate-800">生成数量</legend><div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">{([1, 2, 4] as const).map((value) => <button key={value} type="button" aria-pressed={count === value} onClick={() => setCount(value)} className={`h-10 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${count === value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{value} 张</button>)}</div></fieldset>
            </div>

            <details className="group border-t border-slate-100 pt-1">
              <summary className="cursor-pointer list-none py-2 text-sm font-medium text-slate-600 hover:text-blue-700">更多设置 <span className="font-normal text-slate-400">排除要求、质量、格式与背景</span></summary>
              <div className="space-y-4 pt-2">
                <label className="block" htmlFor="image-generation-negative-prompt"><span className="text-sm font-medium text-slate-800">额外排除要求 <span className="font-normal text-slate-400">可选</span></span><textarea id="image-generation-negative-prompt" value={negativePrompt} maxLength={IMAGE_PROMPT_LIMITS.negativePrompt} rows={3} onChange={(event) => { setNegativePrompt(event.target.value); promptEditRevisionRef.current += 1; clearInputError() }} placeholder="只写本次额外不要出现的内容" className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /><span className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />生图时仅追加文字清晰规范，其余按你的提示词执行。</span></label>
                <div className="grid grid-cols-3 gap-3">
                  <label className="text-sm font-medium text-slate-800">质量<select value={quality} onChange={(event) => setQuality(event.target.value as Draft['quality'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"><option value="low">快速</option><option value="medium">标准</option><option value="high">高清</option></select></label>
                  <label className="text-sm font-medium text-slate-800">格式<select value={format} onChange={(event) => setFormat(event.target.value as Draft['format'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-2 text-sm uppercase text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WEBP</option></select></label>
                  <label className="text-sm font-medium text-slate-800">背景<select value={background} onChange={(event) => setBackground(event.target.value as Draft['background'])} className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent" disabled={format === 'jpeg'}>透明</option></select></label>
                </div>
              </div>
            </details>
          </div>

          <div className="creative-surface-strong shrink-0 border-t border-white/80 p-4">
            {message && <p className={`mb-3 flex items-start gap-2 text-sm ${messageTone === 'error' ? 'text-red-600' : messageTone === 'success' ? 'text-emerald-700' : 'text-slate-600'}`} role={messageTone === 'error' ? 'alert' : 'status'} aria-live="polite">{enqueuing ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : messageTone === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : messageTone === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : null}<span className="min-w-0 break-words">{message}</span></p>}
            <Button type="submit" className="h-11 w-full" disabled={enqueuing || !prompt.trim()} aria-busy={enqueuing}>{enqueuing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{enqueuing ? '正在加入队列' : `生成 ${count} 张`}</Button>
            <p className="mt-2 text-center text-xs text-slate-400">生成只使用上方当前可见文字，不会再次改写或调用提示词模型。入队后可立即准备下一张。</p>
          </div>
        </form>

        <section className="creative-surface flex min-h-[620px] min-w-0 flex-col overflow-hidden rounded-md border border-white/70 shadow-sm" aria-labelledby="image-library-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5">
            <div className="min-w-0"><h2 id="image-library-title" className="text-sm font-semibold text-slate-950">图片资产</h2><p className="mt-0.5 truncate text-xs text-slate-500">{lastResponse ? `${lastResponse.model} · ${lastResponse.size}` : `${library.length} 张本地生成图片`}</p></div>
            <div className="flex flex-wrap items-center gap-2">
              {latestImages.length > 0 && <Button type="button" variant="secondary" size="sm" disabled={Boolean(actionBusy)} onClick={() => void downloadLatest()}>{actionBusy === 'download:latest' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}下载本次</Button>}
            </div>
          </div>

          <ImageJobQueue jobs={jobs} loading={queueLoading} error={queueError} busyJobId={queueBusyJobId} onRefresh={() => void loadJobs(false)} onRetry={(job) => void retryJob(job)} onCancel={(job) => void cancelJob(job)} onOpenImage={(image) => setSelectedImage(image)} />

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
            <div className="flex gap-1 rounded-md bg-slate-100 p-1" role="tablist" aria-label="图片资产视图"><button type="button" role="tab" aria-selected={libraryView === 'history'} onClick={() => setLibraryView('history')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${libraryView === 'history' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}><Clock3 className="h-3.5 w-3.5" />生成历史</button><button type="button" role="tab" aria-selected={libraryView === 'favorites'} onClick={() => setLibraryView('favorites')} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${libraryView === 'favorites' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500'}`}><Heart className="h-3.5 w-3.5" />收藏相册</button></div>
            <button type="button" onClick={() => void loadLibrary()} disabled={libraryLoading} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新图片资产" aria-label="刷新图片资产"><RefreshCw className={`h-4 w-4 ${libraryLoading ? 'animate-spin' : ''}`} /></button>
          </div>

          {libraryFeedback && <div className={`border-b px-4 py-2 text-xs ${libraryFeedback.tone === 'error' ? 'border-red-100 bg-red-50 text-red-700' : libraryFeedback.tone === 'success' ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-50 text-slate-600'}`} role={libraryFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{libraryFeedback.message}</div>}

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-white/35 p-3 sm:p-4">
            {libraryLoading && !library.length ? <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="h-5 w-5 animate-spin" />正在读取图片资产</div>
              : libraryError && !library.length ? <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-center"><CircleAlert className="h-7 w-7 text-red-500" /><div className="text-sm text-red-700">{libraryError}</div><Button type="button" variant="secondary" size="sm" onClick={() => void loadLibrary()}><RefreshCw className="h-4 w-4" />重新读取</Button></div>
                : visibleItems.length ? <div className="space-y-6">{latestVisible.length > 0 && <section><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-blue-700">本次结果</h3><span className="text-[11px] text-slate-400">{latestVisible.length} 张</span></div>{renderImageGrid(latestVisible)}</section>}{datedGroups.map(([label, items]) => <section key={label}><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-slate-600">{label}</h3><span className="text-[11px] text-slate-400">{items.length} 张</span></div>{renderImageGrid(items)}</section>)}</div>
                  : <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center text-slate-400"><span className="inline-flex h-14 w-14 items-center justify-center rounded-md border border-slate-200 bg-white">{libraryView === 'favorites' ? <Heart className="h-7 w-7" /> : <Images className="h-7 w-7" />}</span><span className="text-sm font-medium text-slate-600">{libraryView === 'favorites' ? '还没有收藏图片' : '生成的图片会保存在这里'}</span><span className="text-xs">{libraryView === 'favorites' ? '在图片右上角点击收藏' : '完成首次生成后自动进入历史'}</span></div>}
          </div>
        </section>
      </div>

      {selectedImage && <ImageDetailDialog item={selectedImage} src={fullImageSrc(selectedImage)} busy={selectedBusy} onClose={() => setSelectedImage(null)} onDownload={() => void downloadImage(selectedImage)} onDelete={() => void deleteImage(selectedImage)} onToggleFavorite={() => void toggleFavorite(selectedImage)} onEdit={() => { setEditingImage(selectedImage); setSelectedImage(null) }} photoshopStatus={photoshopStatuses[selectedImage.id]} onPhotoshopOpen={() => void openInPhotoshop(selectedImage)} onPhotoshopSync={() => void syncFromPhotoshop(selectedImage)} onViewPhotoshopVersion={(item) => setSelectedImage(item)} onReuse={() => reuseParameters(selectedImage)} onCreateFrom={() => createFromImage(selectedImage)} />}
      {editingImage && <ImageAnnotationDialog item={editingImage} src={fullImageSrc(editingImage)} onClose={() => setEditingImage(null)} onSubmit={(blob, mode, editPrompt, maskBlob) => submitAnnotation(blob, mode, editPrompt, editingImage, maskBlob)} />}
    </>
  )
}
