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
  { value: '4:5', label: '4:5' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '16:9', label: '16:9' },
  { value: 'custom', label: '自定义' },
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
type EditIntent = NonNullable<ImageGenerationRequest['editIntent']>
type CompositionMode = NonNullable<ImageGenerationRequest['compositionMode']>
type Draft = Pick<ImageGenerationRequest, 'prompt' | 'negativePrompt' | 'ratio' | 'resolution' | 'quality' | 'format' | 'background' | 'count'> & {
  creationMode: CreationMode
  promptReady: boolean
  customWidth: number
  customHeight: number
  editIntent: EditIntent
  compositionMode: CompositionMode
  copyText: string
  copyPosition: NonNullable<ImageGenerationRequest['copyPosition']>
  copyStyle: NonNullable<ImageGenerationRequest['copyStyle']>
  copyScale: NonNullable<ImageGenerationRequest['copyScale']>
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
  customWidth: 1024,
  customHeight: 1024,
  editIntent: 'redraw',
  compositionMode: 'keep',
  copyText: '',
  copyPosition: 'bottom',
  copyStyle: 'light',
  copyScale: 'medium',
}

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
      customWidth: Number.isInteger(saved.customWidth) ? Math.min(4096, Math.max(512, saved.customWidth as number)) : 1024,
      customHeight: Number.isInteger(saved.customHeight) ? Math.min(4096, Math.max(512, saved.customHeight as number)) : 1024,
      editIntent: ['background', 'outpaint', 'redraw'].includes(saved.editIntent || '') ? saved.editIntent as EditIntent : 'redraw',
      compositionMode: saved.compositionMode === 'smart' ? 'smart' : 'keep',
      copyText: typeof saved.copyText === 'string' ? saved.copyText.slice(0, 500) : '',
      copyPosition: ['top', 'center', 'bottom'].includes(saved.copyPosition || '') ? saved.copyPosition as Draft['copyPosition'] : 'bottom',
      copyStyle: saved.copyStyle === 'dark' ? 'dark' : 'light',
      copyScale: ['small', 'medium', 'large'].includes(saved.copyScale || '') ? saved.copyScale as Draft['copyScale'] : 'medium',
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
  if (error instanceof ApiError && [502, 503, 504].includes(error.status)) {
    return `提示词通道暂时不可用（${error.status}），原内容已保留。请稍后重试；如果持续失败，请到设置中心重新检测文字模型。`
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
  const [customWidth, setCustomWidth] = useState(initialDraft.customWidth)
  const [customHeight, setCustomHeight] = useState(initialDraft.customHeight)
  const [resolution, setResolution] = useState<Draft['resolution']>(initialDraft.resolution)
  const [quality, setQuality] = useState<Draft['quality']>(initialDraft.quality)
  const [format, setFormat] = useState<Draft['format']>(initialDraft.format)
  const [background, setBackground] = useState<Draft['background']>(initialDraft.background)
  const [count, setCount] = useState(initialDraft.count)
  const [creationMode, setCreationMode] = useState<CreationMode>(initialDraft.creationMode)
  const [editIntent, setEditIntent] = useState<EditIntent>(initialDraft.editIntent)
  const [compositionMode, setCompositionMode] = useState<CompositionMode>(initialDraft.compositionMode)
  const [copyText, setCopyText] = useState(initialDraft.copyText)
  const [copyPosition, setCopyPosition] = useState<Draft['copyPosition']>(initialDraft.copyPosition)
  const [copyStyle, setCopyStyle] = useState<Draft['copyStyle']>(initialDraft.copyStyle)
  const [copyScale, setCopyScale] = useState<Draft['copyScale']>(initialDraft.copyScale)
  const [promptReady, setPromptReady] = useState(initialDraft.promptReady)
  const [references, setReferences] = useState<ReferenceImageFile[]>([])
  const [sourceImage, setSourceImage] = useState<ImageLibraryItem | null>(null)
  const [lastResponse, setLastResponse] = useState<ImageGenerationResponse | null>(null)
  const [latestImages, setLatestImages] = useState<ImageLibraryItem[]>([])
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<MessageTone>('neutral')
  const [helpingPrompt, setHelpingPrompt] = useState(false)
  const [helpingCopy, setHelpingCopy] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<{ tone: MessageTone; message: string } | null>(null)
  const [promptHelpFeedback, setPromptHelpFeedback] = useState<{ tone: MessageTone; message: string } | null>(null)
  const [enqueuing, setEnqueuing] = useState(false)
  const [jobs, setJobs] = useState<ImageGenerationJob[]>([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError, setQueueError] = useState('')
  const [queueFeedback, setQueueFeedback] = useState('')
  const [queueClearing, setQueueClearing] = useState(false)
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
    if (!active) return
    void (async () => {
      await loadJobs(false)
      await loadLibrary()
    })()
  }, [active, loadJobs, loadLibrary])

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
      customWidth,
      customHeight,
      editIntent,
      compositionMode,
      copyText,
      copyPosition,
      copyStyle,
      copyScale,
      promptReady: false,
    }
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [background, compositionMode, copyPosition, copyScale, copyStyle, copyText, count, creationMode, customHeight, customWidth, editIntent, format, negativePrompt, prompt, quality, ratio, resolution])

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
    if (!active) return undefined
    const refresh = () => { if (document.visibilityState === 'visible') void loadJobs(true) }
    const timer = window.setInterval(refresh, hasActiveJobs ? 1800 : 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [active, hasActiveJobs, loadJobs])

  function currentRequest(): ImageGenerationRequest {
    const hasEditSource = Boolean(sourceImage || references.length)
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
      ...(ratio === 'custom' ? { customWidth, customHeight } : {}),
      ...(hasEditSource ? { editIntent, compositionMode } : {}),
      ...(copyText.trim() ? { copyText: copyText.trim(), copyPosition, copyStyle, copyScale } : {}),
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

  function selectEditIntent(nextIntent: EditIntent) {
    setEditIntent(nextIntent)
    if (count === 1) setCount(2)
    if (nextIntent === 'outpaint') setCompositionMode('keep')
    setPromptReady(false)
    promptEditRevisionRef.current += 1
  }

  function changeReferences(nextReferences: ReferenceImageFile[]) {
    if (!references.length && nextReferences.length && count === 1) setCount(2)
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
        parameters: {
          ratio: request.ratio === 'custom'
            ? customWidth / customHeight < 0.84 ? '3:4' : customWidth / customHeight > 1.19 ? '4:3' : '1:1'
            : request.ratio,
          resolution: request.resolution,
          quality: request.quality,
          background: request.background,
        },
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

  async function helpWriteCopy() {
    if (!prompt.trim() && !copyText.trim()) {
      setCopyFeedback({ tone: 'error', message: '先写画面需求或现有文案，再让 AI 提取和润色。' })
      return
    }
    if (!promptConfigured) {
      setCopyFeedback({ tone: 'error', message: 'AI 文案需要先配置文字模型。' })
      onOpenModelSettings()
      return
    }
    setHelpingCopy(true)
    setCopyFeedback({ tone: 'neutral', message: '正在识别参考图文字并整理成品文案…' })
    try {
      const productReferenceFiles = await promptFilesForEnhancement([...references], sourceImage)
      const promptRatio = ratio === 'custom'
        ? customWidth / customHeight < 0.84 ? '3:4' : customWidth / customHeight > 1.19 ? '4:3' : '1:1'
        : ratio
      const result = await api.quickGeneratePrompt({
        clientRequestId: crypto.randomUUID(),
        userRequest: copyText.trim()
          ? `为当前电商图片润色以下成品文案。保留明确的品牌、型号、价格和活动事实，不要补造信息；只返回最适合实际排版的简洁文案方案：\n${copyText.trim()}\n画面需求：${prompt.trim()}`
          : `根据当前电商图片和参考图，提取可辨认的现有文字，并为画面策划简洁、可直接排版的成品文案。不要补造品牌、型号、价格或活动信息。画面需求：${prompt.trim()}`,
        parameters: { ratio: promptRatio, resolution, quality, background },
        creationMode,
        saveHistory: false,
      }, { productReferenceFiles, styleReferenceFiles: [] })
      const copy = result.request.copy
      const lines = [copy.title, copy.subtitle, ...copy.sellingPoints, copy.price, copy.campaignInfo, ...copy.additionalText].map((value) => value.trim()).filter(Boolean)
      if (!lines.length) throw new Error('AI 没有返回可排版文案；参考图可能没有清晰文字，请先手动输入一句再润色。')
      setCopyText([...new Set(lines)].join('\n'))
      setCopyFeedback({ tone: 'success', message: `文案已由 ${result.model} 提取并填回，可继续修改。` })
    } catch (error) {
      setCopyFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'AI 文案处理失败。' })
    } finally {
      setHelpingCopy(false)
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
    setQueueFeedback('')
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
    setQueueFeedback('')
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

  async function clearJobs() {
    const clearableCount = jobsRef.current.filter((job) => !['running', 'saving'].includes(job.status)).length
    if (!clearableCount) return
    if (!window.confirm(`确定清空 ${clearableCount} 个生图任务？排队任务会取消，已生成图片仍保留在图片资产中；正在生成的任务不会中断。`)) return
    setQueueClearing(true)
    setQueueError('')
    setQueueFeedback('')
    try {
      const result = await api.clearImageJobs()
      await loadJobs(true)
      setQueueFeedback(result.retainedActive
        ? `已清空 ${result.removed} 个任务；${result.retainedActive} 个正在生成或保存的任务已保留，完成后可再次清空。`
        : `已清空 ${result.removed} 个任务，生成图片仍保留在图片资产中。`)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : '生图队列清空失败。')
    } finally {
      setQueueClearing(false)
    }
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
    setCopyText(item.copy?.text || '')
    setCopyPosition(item.copy?.position || 'bottom')
    setCopyStyle(item.copy?.style || 'light')
    setCopyScale(item.copy?.scale || 'medium')
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
    setEditIntent('redraw')
    setCompositionMode('keep')
    setCount(2)
    setCreationMode('product')
    setPromptReady(false)
    promptEditRevisionRef.current += 1
    setPromptHelpFeedback(null)
    setPrompt('')
    setNegativePrompt('')
    setRatio(item.ratio)
    setCustomWidth(item.customWidth || item.width || 1024)
    setCustomHeight(item.customHeight || item.height || 1024)
    setResolution(item.resolution)
    setQuality(item.quality)
    setFormat(item.format)
    setBackground(item.background)
    setCopyText('')
    setCopyPosition('bottom')
    setCopyStyle('light')
    setCopyScale('medium')
    setSelectedImage(null)
    setLibraryView('history')
    setMessage('已载入原图和原参数。你的修改内容会原样发送给图片模型，不追加隐藏提示词。')
    setMessageTone('success')
    scrollToSettings()
  }

  async function submitAnnotation(blob: Blob, mode: AnnotationExportMode, editPrompt: string, item: ImageLibraryItem, maskBlob?: Blob) {
    if (!imageConfigured) throw new Error('图片模型未配置。请先关闭批注，完成模型配置后再编辑。')
    const extension = blob.type === 'image/webp' ? 'webp' : 'png'
    const filename = `${mode === 'mask' ? 'mask' : 'annotation'}-${item.id}.${extension}`
    const file = new File([blob], filename, { type: blob.type || 'image/png' })
    const request: ImageGenerationRequest = {
      ...currentRequest(),
      prompt: editPrompt.trim(),
      negativePrompt: undefined,
      ratio: item.ratio,
      resolution: item.resolution,
      quality: item.quality,
      format: item.format,
      background: item.background,
      count: 2,
      sourceImageId: item.id,
      editMode: mode,
      editIntent: 'local',
      compositionMode: 'keep',
      copyText: undefined,
      copyPosition: undefined,
      copyStyle: undefined,
      copyScale: undefined,
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
            {(item.nativeSize || item.outputSize) && <div className="mt-1 flex items-center gap-2 truncate text-[10px] text-slate-400"><span className="truncate">{item.nativeSize && item.outputSize && item.nativeSize !== item.outputSize ? `${item.nativeSize} → ${item.outputSize}` : item.outputSize || item.nativeSize}</span>{item.validation && <span className="shrink-0 font-semibold text-emerald-600">保护 {item.validation.score} 分</span>}</div>}
          </button>
          <div className="flex shrink-0 items-center pr-2">
            <button type="button" onClick={() => void downloadImage(item)} disabled={Boolean(actionBusy)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50" title="下载图片" aria-label="下载这张图片">{downloadBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</button>
          </div>
        </div>
      </article>
    })}</div>
  }

  const selectedBusy = selectedImage && actionBusy.endsWith(`:${selectedImage.id}`) ? actionBusy.split(':')[0] : ''
  const hasEditSource = Boolean(sourceImage || references.length)

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

            {hasEditSource && <section aria-labelledby="image-edit-mode-title">
              <div className="flex items-center justify-between gap-2"><h3 id="image-edit-mode-title" className="text-sm font-medium text-slate-800">编辑方式</h3><span className="text-[11px] text-slate-400">局部修改请在图片详情点“批注编辑”</span></div>
              <div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
                {([
                  ['redraw', '自由重绘', '允许整体变化'],
                  ['background', '换背景', '主体位置优先保留'],
                  ['outpaint', '智能扩图', '扩画布不裁主体'],
                ] as const).map(([value, label, note]) => <button key={value} type="button" aria-pressed={editIntent === value} onClick={() => selectEditIntent(value)} className={`min-h-14 rounded px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${editIntent === value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><span className="block text-xs font-semibold">{label}</span><span className="mt-0.5 block text-[10px] leading-4">{note}</span></button>)}
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-blue-50/80 px-3 py-2">
                <div><div className="text-xs font-medium text-blue-900">主体构图</div><div className="mt-0.5 text-[11px] text-blue-700">{compositionMode === 'keep' ? '尽量保持原位置和比例' : '允许模型重新安排主体位置'}</div></div>
                <div className="flex shrink-0 gap-1 rounded-md bg-white/80 p-1" role="group" aria-label="主体构图方式">{([['keep', '保持位置'], ['smart', '智能重排']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={compositionMode === value} onClick={() => setCompositionMode(value)} className={`h-8 rounded px-2 text-[11px] font-semibold ${compositionMode === value ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-white'}`}>{label}</button>)}</div>
              </div>
            </section>}

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
              {sourceImage && <p className="mt-1.5 text-xs leading-5 text-slate-500">只写你真正想要的修改；系统会原样发送，不追加隐藏规则或审美模板。</p>}
              <textarea id="image-generation-prompt" value={prompt} maxLength={IMAGE_PROMPT_LIMITS.prompt} rows={5} required onChange={(event) => { setPrompt(event.target.value); promptEditRevisionRef.current += 1; clearInputError() }} placeholder={sourceImage ? '例如：把背景改成明亮的现代厨房，产品和文字保持原样' : creationMode === 'product' ? '例如：把产品放进明亮的现代厨房，画面干净，产品保持原样' : '例如：雨后的未来城市街道，电影感夜景，蓝绿色灯光'} className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              {promptHelpFeedback && <p className={`mt-2 flex items-start gap-1.5 text-xs leading-5 ${promptHelpFeedback.tone === 'error' ? 'text-red-600' : promptHelpFeedback.tone === 'success' ? 'text-emerald-700' : 'text-slate-600'}`} role={promptHelpFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{helpingPrompt ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : promptHelpFeedback.tone === 'error' ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : promptHelpFeedback.tone === 'success' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}<span>{promptHelpFeedback.message}</span></p>}
              <span className="mt-1 block text-right text-xs text-slate-400">{prompt.length}/{IMAGE_PROMPT_LIMITS.prompt}</span>
            </div>

            <fieldset><legend className="text-sm font-medium text-slate-800">画面比例</legend><div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">{ratios.map((item) => <button key={item.value} type="button" aria-pressed={ratio === item.value} onClick={() => setRatio(item.value)} className={`h-9 rounded text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${ratio === item.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item.label}</button>)}</div>{ratio === 'custom' && <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-end gap-2"><label className="text-xs text-slate-600">宽度<input type="number" min={512} max={4096} step={1} value={customWidth} onChange={(event) => setCustomWidth(Math.min(4096, Math.max(512, Number(event.target.value) || 512)))} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 outline-none focus:border-blue-500" /></label><span className="pb-2 text-slate-400">×</span><label className="text-xs text-slate-600">高度<input type="number" min={512} max={4096} step={1} value={customHeight} onChange={(event) => setCustomHeight(Math.min(4096, Math.max(512, Number(event.target.value) || 512)))} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 outline-none focus:border-blue-500" /></label></div>}{sourceRatioChanged && <p className="mt-1.5 text-xs leading-5 text-amber-700">{editIntent === 'outpaint' ? '将用扩图画布补足新比例，原主体不做中心裁切。' : `最终图片会输出为 ${ratio === 'custom' ? `${customWidth}×${customHeight}` : ratio}；需要保住完整主体时请选择“智能扩图”。`}</p>}</fieldset>

            <section className="rounded-md bg-slate-50/90 p-3" aria-labelledby="image-copy-title">
              <div className="flex items-center justify-between gap-2"><div><h3 id="image-copy-title" className="text-sm font-medium text-slate-800">成品文案 <span className="font-normal text-slate-400">可选</span></h3><p className="mt-0.5 text-[11px] leading-4 text-slate-500">模型做无字底图，应用再用真实中文字体排版，避免乱码。</p></div><div className="flex shrink-0 items-center gap-1"><Button type="button" variant="secondary" size="sm" onClick={() => void helpWriteCopy()} disabled={helpingCopy || (!prompt.trim() && !copyText.trim())}>{helpingCopy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}{copyText ? 'AI 润色' : 'AI 提取'}</Button>{copyText && <button type="button" onClick={() => { setCopyText(''); setCopyFeedback(null) }} className="px-1.5 text-xs font-medium text-slate-400 hover:text-red-600">清空</button>}</div></div>
              <textarea value={copyText} maxLength={500} rows={3} onChange={(event) => setCopyText(event.target.value)} placeholder={'例如：\n新春焕新季\n新年好物，美好启程'} className="mt-2 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
              {copyText && <div className="mt-2 grid grid-cols-3 gap-2"><label className="text-[11px] font-medium text-slate-600">位置<select value={copyPosition} onChange={(event) => setCopyPosition(event.target.value as Draft['copyPosition'])} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"><option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option></select></label><label className="text-[11px] font-medium text-slate-600">颜色<select value={copyStyle} onChange={(event) => setCopyStyle(event.target.value as Draft['copyStyle'])} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"><option value="light">白字</option><option value="dark">深色字</option></select></label><label className="text-[11px] font-medium text-slate-600">字号<select value={copyScale} onChange={(event) => setCopyScale(event.target.value as Draft['copyScale'])} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"><option value="small">小</option><option value="medium">标准</option><option value="large">大</option></select></label></div>}
              {copyFeedback && <p className={`mt-2 text-xs leading-5 ${copyFeedback.tone === 'error' ? 'text-red-600' : copyFeedback.tone === 'success' ? 'text-emerald-700' : 'text-slate-500'}`} role={copyFeedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{copyFeedback.message}</p>}
            </section>

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

          <ImageJobQueue active={active} jobs={jobs} loading={queueLoading} error={queueError} feedback={queueFeedback} clearing={queueClearing} busyJobId={queueBusyJobId} onRefresh={() => void loadJobs(false)} onClear={() => void clearJobs()} onRetry={(job) => void retryJob(job)} onCancel={(job) => void cancelJob(job)} onOpenImage={(image) => setSelectedImage(image)} />

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
