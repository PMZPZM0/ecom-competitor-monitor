import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, PlugZap, RefreshCw, Save, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import type { ModelCatalog, ModelCatalogRequest, ModelChannel, ModelChannelState, ModelConfig, ModelConfigPatch, ModelConfigTestPayload, ModelConfigTestResult, ModelConfigTestTarget } from '../../types/domain'

type Props = {
  config: ModelConfig
  onSave: (payload: ModelConfigPatch) => Promise<void>
  onDiscover?: (payload: ModelCatalogRequest) => Promise<ModelCatalog>
  onTest?: (payload: ModelConfigTestPayload) => Promise<ModelConfigTestResult>
  onClose?: () => void
  purpose?: 'all' | 'image' | 'prompt' | 'creation'
}

type Feedback = { tone: 'success' | 'error' | 'neutral'; text: string }
type LocalTestState = { status: 'success' | 'unverified' | 'failed'; testedAt: string | null }
type ChannelModels = { model: string; imageModel: string }
type CatalogEntry = { catalog: ModelCatalog; fingerprint: string }
type ModelPickerProps = {
  label: string
  value: string
  options: string[]
  placeholder: string
  onChange: (value: string) => void
  disabled?: boolean
  compact?: boolean
  helpText?: string
}

const DEFAULT_PROMPT_MODEL = 'gpt-5.5'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const CUSTOM_MODEL_VALUE = '__custom_model__'

const CHANNEL_LABELS: Record<ModelChannel, string> = {
  stable: '稳定生图',
  fast: '高速通道',
  custom: '自定义配置',
}

const FIXED_CHANNELS = [
  { id: 'stable' as const, label: '稳定通道', description: '优先保证生成稳定性', recommended: true },
  { id: 'fast' as const, label: '高速通道', description: '优先缩短等待时间', recommended: false },
]

const EMPTY_CHANNEL_STATE: ModelChannelState = {
  model: DEFAULT_PROMPT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
  hasApiKey: false,
  apiKeyMasked: '',
  apiKeySource: 'none',
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestTarget: null,
  testStates: {
    image: { lastTestedAt: null, lastTestStatus: null },
    prompt: { lastTestedAt: null, lastTestStatus: null },
  },
}

function getChannelModels(config: ModelConfig, channel: ModelChannel): ChannelModels {
  const state = config.channelStates?.[channel]
  return {
    model: state?.model || config.model || DEFAULT_PROMPT_MODEL,
    imageModel: state?.imageModel || config.imageModel || DEFAULT_IMAGE_MODEL,
  }
}

function getModelDrafts(config: ModelConfig): Record<ModelChannel, ChannelModels> {
  return {
    stable: getChannelModels(config, 'stable'),
    fast: getChannelModels(config, 'fast'),
    custom: getChannelModels(config, 'custom'),
  }
}

function catalogErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '可用模型读取失败。'
  if (/<(?:!doctype|html|body)\b|cannot\s+post/i.test(message)) return '模型列表服务暂不可用，请重启应用后重试。'
  return message.length > 180 ? `${message.slice(0, 180)}…` : message
}

function normalizedConnectionUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function secretFingerprint(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

function ModelPicker({ label, value, options, placeholder, onChange, disabled = false, compact = false, helpText }: ModelPickerProps) {
  const id = useId()
  const customInputRef = useRef<HTMLInputElement>(null)
  const [customMode, setCustomMode] = useState(false)
  const modelOptions = [...new Set(options.map((option) => option.trim()).filter(Boolean))]

  function handleSelect(nextValue: string) {
    if (nextValue === CUSTOM_MODEL_VALUE) {
      setCustomMode(true)
      requestAnimationFrame(() => customInputRef.current?.focus())
      return
    }
    setCustomMode(false)
    onChange(nextValue)
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={`${id}-select`} className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-slate-700`}>{label}</label>
      <div className="relative min-w-0">
        <select
          id={`${id}-select`}
          value={customMode ? CUSTOM_MODEL_VALUE : value}
          onChange={(event) => handleSelect(event.target.value)}
          disabled={disabled}
          className={`${compact ? 'h-9' : 'h-10'} w-full min-w-0 appearance-none truncate rounded-md border border-slate-200 bg-white px-3 pr-9 text-sm font-normal text-slate-800 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-55`}
        >
          {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          <option value={CUSTOM_MODEL_VALUE}>自定义模型…</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      </div>
      {customMode && (
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${id}-custom`} className="sr-only">自定义{label}</label>
          <Input
            ref={customInputRef}
            id={`${id}-custom`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            className={compact ? 'h-9 bg-white text-sm' : undefined}
          />
          <span className="text-[11px] font-normal leading-4 text-slate-500">填写接口支持的完整模型名称。</span>
        </div>
      )}
      {helpText && <span className="text-xs font-normal text-slate-400">{helpText}</span>}
    </div>
  )
}

function getChannelState(config: ModelConfig, channel: ModelChannel) {
  const state = config.channelStates?.[channel]
  if (state) return state
  if (channel !== (config.channel || 'stable')) return EMPTY_CHANNEL_STATE
  return {
    hasApiKey: config.hasApiKey,
    apiKeyMasked: config.apiKeyMasked,
    apiKeySource: config.apiKeySource,
    lastTestedAt: config.lastTestedAt,
    lastTestStatus: config.lastTestStatus,
    lastTestTarget: config.lastTestTarget,
    testStates: {
      image: config.lastTestTarget === 'image' ? { lastTestedAt: config.lastTestedAt, lastTestStatus: config.lastTestStatus } : { lastTestedAt: null, lastTestStatus: null },
      prompt: config.lastTestTarget === 'prompt' ? { lastTestedAt: config.lastTestedAt, lastTestStatus: config.lastTestStatus } : { lastTestedAt: null, lastTestStatus: null },
    },
  }
}

export function ModelConfigPanel({ config, onSave, onDiscover, onTest, onClose, purpose = 'all' }: Props) {
  const creationMode = purpose === 'creation'
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const discoveryAttemptedRef = useRef(new Set<ModelChannel>())
  const catalogRequestSequenceRef = useRef<Record<ModelChannel, number>>({ stable: 0, fast: 0, custom: 0 })
  const persistedChannelRef = useRef<ModelChannel>(config.channel || 'stable')
  const persistedModelsRef = useRef<Record<ModelChannel, ChannelModels>>(getModelDrafts(config))
  const persistedCustomBaseUrlRef = useRef(config.customBaseUrl || '')
  const [channel, setChannel] = useState<ModelChannel>(config.channel || 'stable')
  const [customBaseUrl, setCustomBaseUrl] = useState(config.customBaseUrl || '')
  const [modelDrafts, setModelDrafts] = useState<Record<ModelChannel, ChannelModels>>(() => getModelDrafts(config))
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<ModelChannel, string>>({ stable: '', fast: '', custom: '' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingTarget, setTestingTarget] = useState<ModelConfigTestTarget | null>(null)
  const [clearing, setClearing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<ModelConfigTestTarget, LocalTestState>>>({})
  const [catalogs, setCatalogs] = useState<Partial<Record<ModelChannel, CatalogEntry>>>({})
  const [catalogLoading, setCatalogLoading] = useState<ModelChannel | null>(null)
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<ModelChannel, string>>>({})
  const apiKey = apiKeyDrafts[channel]
  const { model, imageModel } = modelDrafts[channel]
  const channelLabel = purpose === 'prompt' || creationMode
    ? channel === 'stable' ? '稳定通道' : channel === 'fast' ? '高速通道' : '自定义配置'
    : CHANNEL_LABELS[channel]
  const testTarget: ModelConfigTestTarget = purpose === 'prompt' ? 'prompt' : 'image'
  const channelState = getChannelState(config, channel)
  const connectionFingerprint = useCallback((targetChannel: ModelChannel) => {
    const targetState = getChannelState(config, targetChannel)
    const draftKey = apiKeyDrafts[targetChannel].trim()
    const baseUrl = targetChannel === 'custom' ? normalizedConnectionUrl(customBaseUrl) : `builtin:${targetChannel}`
    const keyIdentity = draftKey
      ? `draft:${secretFingerprint(draftKey)}`
      : `configured:${targetState.hasApiKey ? 'yes' : 'no'}:${targetState.apiKeySource}:${targetState.apiKeyMasked}`
    return `${targetChannel}|${baseUrl}|${keyIdentity}`
  }, [apiKeyDrafts, config, customBaseUrl])
  const currentCatalogEntry = catalogs[channel]
  const currentCatalog = currentCatalogEntry?.fingerprint === connectionFingerprint(channel) ? currentCatalogEntry.catalog : undefined
  const imageModelOptions = [...new Set([imageModel, ...(currentCatalog?.imageModels || [])].filter(Boolean))]
  const promptModelOptions = [...new Set([model, ...(currentCatalog?.promptModels || [])].filter(Boolean))]

  const discoverModels = useCallback(async (targetChannel: ModelChannel) => {
    if (!onDiscover) return
    const targetState = getChannelState(config, targetChannel)
    const targetKey = apiKeyDrafts[targetChannel].trim()
    if (!targetState.hasApiKey && !targetKey) {
      setCatalogErrors((current) => ({ ...current, [targetChannel]: '先填写并保存 API Key，再读取这个通道的可用模型。' }))
      return
    }
    const targetModels = modelDrafts[targetChannel]
    const fingerprint = connectionFingerprint(targetChannel)
    const requestSequence = catalogRequestSequenceRef.current[targetChannel] + 1
    catalogRequestSequenceRef.current[targetChannel] = requestSequence
    setCatalogLoading(targetChannel)
    setCatalogErrors((current) => ({ ...current, [targetChannel]: '' }))
    try {
      const result = await onDiscover({
        channel: targetChannel,
        ...(targetChannel === 'custom' ? { customBaseUrl: customBaseUrl.trim().replace(/\/+$/, '') } : {}),
        ...targetModels,
        ...(targetKey ? { apiKey: targetKey } : {}),
      })
      if (catalogRequestSequenceRef.current[targetChannel] !== requestSequence) return
      setCatalogs((current) => ({ ...current, [targetChannel]: { catalog: result, fingerprint } }))
    } catch (error) {
      if (catalogRequestSequenceRef.current[targetChannel] !== requestSequence) return
      setCatalogErrors((current) => ({ ...current, [targetChannel]: catalogErrorMessage(error) }))
    } finally {
      if (catalogRequestSequenceRef.current[targetChannel] === requestSequence) {
        setCatalogLoading((current) => current === targetChannel ? null : current)
      }
    }
  }, [apiKeyDrafts, config, connectionFingerprint, customBaseUrl, modelDrafts, onDiscover])

  useEffect(() => {
    const nextChannel = config.channel || 'stable'
    const nextModels = getModelDrafts(config)
    const previousModels = persistedModelsRef.current
    if (nextChannel !== persistedChannelRef.current) setChannel(nextChannel)
    setCustomBaseUrl((current) => current === persistedCustomBaseUrlRef.current ? config.customBaseUrl || '' : current)
    setModelDrafts((current) => ({
      stable: current.stable.model === previousModels.stable.model && current.stable.imageModel === previousModels.stable.imageModel ? nextModels.stable : current.stable,
      fast: current.fast.model === previousModels.fast.model && current.fast.imageModel === previousModels.fast.imageModel ? nextModels.fast : current.fast,
      custom: current.custom.model === previousModels.custom.model && current.custom.imageModel === previousModels.custom.imageModel ? nextModels.custom : current.custom,
    }))
    persistedChannelRef.current = nextChannel
    persistedModelsRef.current = nextModels
    persistedCustomBaseUrlRef.current = config.customBaseUrl || ''
    setTestResults({})
  }, [config])

  useEffect(() => {
    if (!creationMode || !onDiscover || !channelState.hasApiKey || discoveryAttemptedRef.current.has(channel)) return
    discoveryAttemptedRef.current.add(channel)
    void discoverModels(channel)
  }, [channel, channelState.hasApiKey, creationMode, discoverModels, onDiscover])

  useEffect(() => {
    if (!onClose) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  function invalidateCatalog(targetChannel: ModelChannel) {
    catalogRequestSequenceRef.current[targetChannel] += 1
    setCatalogs((current) => {
      if (!current[targetChannel]) return current
      const next = { ...current }
      delete next[targetChannel]
      return next
    })
    setCatalogErrors((current) => {
      if (!current[targetChannel]) return current
      const next = { ...current }
      delete next[targetChannel]
      return next
    })
    setCatalogLoading((current) => current === targetChannel ? null : current)
  }

  function channelHasUnsavedChanges(targetChannel: ModelChannel) {
    const draft = modelDrafts[targetChannel]
    const persisted = persistedModelsRef.current[targetChannel]
    const modelChanged = draft.model.trim() !== persisted.model.trim()
      || draft.imageModel.trim() !== persisted.imageModel.trim()
    const keyChanged = Boolean(apiKeyDrafts[targetChannel].trim())
    const addressChanged = targetChannel === 'custom'
      && normalizedConnectionUrl(customBaseUrl) !== normalizedConnectionUrl(persistedCustomBaseUrlRef.current)
    return modelChanged || keyChanged || addressChanged
  }

  const currentChannelDirty = channelHasUnsavedChanges(channel)

  function validateConnection(target: ModelConfigTestTarget = testTarget) {
    if (channel === 'custom') {
      let url
      try {
        url = new URL(customBaseUrl.trim())
      } catch {
        return customBaseUrl.trim() ? '自定义 API 地址格式不正确。' : '请输入自定义 API 地址。'
      }
      const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
      if (url.username || url.password || url.search || url.hash) return '自定义 API 地址不能包含账号、密码、查询参数或锚点。'
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return '自定义 API 地址必须使用 HTTPS；仅本机服务可使用 HTTP。'
    }
    if (target === 'prompt' && !model.trim()) return '请输入提示词模型名称。'
    if (target === 'image' && !imageModel.trim()) return '请输入图片模型名称。'
    return ''
  }

  function validateForSave() {
    const connectionError = validateConnection()
    if (connectionError) return connectionError
    if (!model.trim()) return '请输入提示词/分析模型名称。'
    if (!imageModel.trim()) return '请输入图片模型名称。'
    return ''
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const validationError = validateForSave()
    if (validationError) {
      setFeedback({ tone: 'error', text: validationError })
      return
    }
    setSaving(true)
    setFeedback(null)
    const savedModels = { imageModel: imageModel.trim(), model: model.trim() }
    const savedCustomBaseUrl = normalizedConnectionUrl(customBaseUrl)
    const connectionChanged = Boolean(apiKey.trim())
      || (channel === 'custom' && savedCustomBaseUrl !== normalizedConnectionUrl(persistedCustomBaseUrlRef.current))
    try {
      await onSave({
        channel,
        ...(channel === 'custom' ? { customBaseUrl: savedCustomBaseUrl } : {}),
        ...savedModels,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      persistedModelsRef.current = { ...persistedModelsRef.current, [channel]: savedModels }
      persistedChannelRef.current = channel
      if (channel === 'custom') persistedCustomBaseUrlRef.current = savedCustomBaseUrl
      setModelDrafts((current) => ({ ...current, [channel]: savedModels }))
      setApiKeyDrafts((current) => ({ ...current, [channel]: '' }))
      if (connectionChanged) {
        invalidateCatalog(channel)
        discoveryAttemptedRef.current.delete(channel)
      }
      setShowKey(false)
      setTestResults({})
      setFeedback({ tone: 'success', text: `${channelLabel}配置已保存。` })
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '模型配置保存失败。' })
    } finally {
      setSaving(false)
    }
  }

  async function testConnection(target: ModelConfigTestTarget = testTarget) {
    const validationError = validateConnection(target)
    if (validationError) {
      setFeedback({ tone: 'error', text: validationError })
      return
    }
    if (!onTest) return
    if (!channelState.hasApiKey && !apiKey.trim()) {
      setFeedback({ tone: 'error', text: `请先填写你自己的 ${channelLabel} API Key。` })
      return
    }
    setTestingTarget(target)
    setFeedback({ tone: 'neutral', text: target === 'prompt' ? '正在测试提示词模型。' : '正在测试生图模型。' })
    try {
      const result = await onTest({
        target,
        channel,
        ...(channel === 'custom' ? { customBaseUrl: customBaseUrl.trim().replace(/\/+$/, '') } : {}),
        ...(target === 'prompt' ? { model: model.trim() } : { imageModel: imageModel.trim() }),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setTestResults((current) => ({ ...current, [target]: { status: result.status, testedAt: result.testedAt } }))
      setFeedback({
        tone: result.status === 'success' ? 'success' : 'neutral',
        text: `${result.message}（${result.latencyMs} ms）`,
      })
    } catch (error) {
      setTestResults((current) => ({ ...current, [target]: { status: 'failed', testedAt: new Date().toISOString() } }))
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '模型连接失败。' })
    } finally {
      setTestingTarget(null)
    }
  }

  async function clearApiKey() {
    if (!window.confirm(`确定清除本机保存的${channelLabel} Key？`)) return
    setClearing(true)
    setFeedback(null)
    try {
      await onSave({ channel, clearApiKey: true })
      setApiKeyDrafts((current) => ({ ...current, [channel]: '' }))
      invalidateCatalog(channel)
      discoveryAttemptedRef.current.delete(channel)
      setTestResults({})
      setFeedback({ tone: 'success', text: `${channelLabel} Key 已清除。` })
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'API Key 清除失败。' })
    } finally {
      setClearing(false)
    }
  }

  function selectChannel(nextChannel: ModelChannel) {
    if (nextChannel === channel) return
    if (currentChannelDirty) {
      setFeedback({ tone: 'error', text: `${channelLabel}有未保存修改，请先保存配置，再切换模型通道。` })
      return
    }
    setChannel(nextChannel)
    setShowKey(false)
    setTestResults({})
    setFeedback(null)
  }

  function updateCurrentModels(patch: Partial<ChannelModels>) {
    setModelDrafts((current) => ({
      ...current,
      [channel]: { ...current[channel], ...patch },
    }))
    setTestResults({})
    setFeedback(null)
  }

  const customAddressMatches = channel !== 'custom'
    || customBaseUrl.trim().replace(/\/+$/, '') === (config.customBaseUrl || '').replace(/\/+$/, '')
  function testStateFor(target: ModelConfigTestTarget): LocalTestState | null {
    if (testResults[target]) return testResults[target] || null
    const persistedModels = getChannelModels(config, channel)
    const modelMatches = target === 'prompt' ? model.trim() === persistedModels.model : imageModel.trim() === persistedModels.imageModel
    const persisted = channelState.testStates?.[target]
    const status = persisted?.lastTestStatus || (channelState.lastTestTarget === target ? channelState.lastTestStatus : null)
    const testedAt = persisted?.lastTestedAt || (channelState.lastTestTarget === target ? channelState.lastTestedAt : null)
    if (apiKey.trim() || !customAddressMatches || !modelMatches || !status) return null
    return { status, testedAt }
  }
  const promptTestState = testStateFor('prompt')
  const imageTestState = testStateFor('image')
  const currentTestState = testTarget === 'prompt' ? promptTestState : imageTestState
  const creationTestStates = [promptTestState, imageTestState]
  const currentTestStatus = creationMode
    ? creationTestStates.some((state) => state?.status === 'failed')
      ? 'failed'
      : creationTestStates.every((state) => state?.status === 'success')
        ? 'success'
        : creationTestStates.some((state) => state?.status === 'unverified')
          ? 'unverified'
          : null
    : currentTestState?.status || null
  const lastTestedAt = creationMode
    ? creationTestStates.map((state) => state?.testedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null
    : currentTestState?.testedAt || null
  const keySourceLabel = apiKey.trim()
    ? '待保存'
    : channelState.apiKeySource === 'environment'
      ? '环境变量'
      : channelState.apiKeySource === 'saved'
        ? '本机保存'
        : '未配置'
  const channelChanged = channel !== (config.channel || 'stable')
  const hasEffectiveKey = Boolean(apiKey.trim() || channelState.hasApiKey)
  const channelGuidance = channel === 'custom'
    ? hasEffectiveKey
      ? channelChanged
        ? '已切换至自定义配置，请填写接口地址；将使用该通道的 Key，保存后生效。'
        : '自定义地址和 Key 仅用于此通道。'
      : '请填写自定义 API 地址和你自己的 API Key。'
    : hasEffectiveKey
      ? channelChanged
        ? `已切换至${channelLabel}，将使用该通道的 Key，保存后生效。`
        : `地址已内置，${channelLabel} Key 已配置。`
      : `${channelLabel}尚未配置，请填写你自己的 API Key。`
  const keyGuidance = apiKey.trim()
    ? `${channelLabel} Key 待保存。`
    : channelState.apiKeySource === 'environment'
      ? `${channelLabel}使用环境变量 Key；输入新 Key 后会改为本机保存。`
      : channelState.hasApiKey
        ? `${channelLabel} Key 已配置；留空会保留。`
        : `请输入你自己的 ${channelLabel} API Key；密钥仅保存在本机。`

  const panel = (
    <Card className={onClose ? 'w-full max-w-2xl overflow-y-auto shadow-2xl max-h-[calc(100vh-2rem)]' : undefined} role={onClose ? 'document' : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle id="model-config-title" className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-blue-600" />
            {creationMode ? 'AI 创作模型设置' : purpose === 'prompt' ? '提示词模型设置' : '模型配置'}
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium ${currentTestStatus === 'success' ? 'bg-emerald-50 text-emerald-700' : currentTestStatus === 'failed' ? 'bg-red-50 text-red-700' : currentTestStatus === 'unverified' ? 'bg-amber-50 text-amber-700' : hasEffectiveKey ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {channelLabel} · {creationMode
                ? currentTestStatus === 'success' ? '提示词与生图均已验证' : currentTestStatus === 'failed' ? '连接异常' : hasEffectiveKey ? '已配置，待分别验证' : '尚未连接'
                : currentTestStatus === 'success' ? (testTarget === 'prompt' ? '提示词连接已验证' : '基础连接已验证') : currentTestStatus === 'failed' ? '上次验证失败' : currentTestStatus === 'unverified' ? '待实际验证' : hasEffectiveKey ? '已配置，尚未验证' : '尚未连接'}
            </span>
            <span>Key：{keySourceLabel}</span>
            {lastTestedAt && <span>最近验证：{new Date(lastTestedAt).toLocaleString('zh-CN')}</span>}
          </div>
          {creationMode && hasEffectiveKey && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="模型连接验证状态">
              <span className={`rounded px-2 py-1 font-medium ${promptTestState?.status === 'success' ? 'bg-emerald-50 text-emerald-700' : promptTestState?.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>提示词：{promptTestState?.status === 'success' ? '已验证' : promptTestState?.status === 'failed' ? '失败' : '待验证'}</span>
              <span className={`rounded px-2 py-1 font-medium ${imageTestState?.status === 'success' ? 'bg-emerald-50 text-emerald-700' : imageTestState?.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>生图：{imageTestState?.status === 'success' ? '已验证' : imageTestState?.status === 'failed' ? '失败' : '待验证'}</span>
            </div>
          )}
        </div>
        {onClose && (
          <button ref={closeButtonRef} type="button" onClick={onClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="关闭模型配置" title="关闭">
            <X className="h-4 w-4" />
          </button>
        )}
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          {creationMode ? (
            <>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium text-slate-700">选择模型通道</legend>
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
                  {FIXED_CHANNELS.map((option) => {
                    const selected = channel === option.id
                    const optionModels = modelDrafts[option.id]
                    return (
                      <div key={option.id} className={`overflow-hidden rounded-md border transition ${selected ? 'border-blue-500 bg-blue-50/60 shadow-sm' : 'border-slate-200 bg-white'}`}>
                        <button type="button" aria-pressed={selected} onClick={() => selectChannel(option.id)} disabled={saving || Boolean(testingTarget) || clearing} className="min-h-16 w-full px-3 py-2.5 text-left transition hover:bg-blue-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:opacity-55">
                          <span className="flex items-center justify-between gap-2 text-sm font-semibold text-slate-900"><span>{option.label}</span>{option.recommended && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700">推荐</span>}</span>
                          <span className="mt-1 block text-xs font-normal text-slate-500">{option.description}</span>
                          {!selected && <span className="mt-1 block truncate text-[11px] font-normal text-slate-400">{optionModels.imageModel} · {optionModels.model}</span>}
                        </button>
                        {selected && (
                          <div className="grid gap-2 border-t border-blue-100 bg-white/80 p-3">
                            <ModelPicker key={`${channel}-image-fixed`} label="生图模型" value={imageModel} options={imageModelOptions} placeholder={DEFAULT_IMAGE_MODEL} onChange={(value) => updateCurrentModels({ imageModel: value })} disabled={saving || Boolean(testingTarget) || clearing} compact />
                            <ModelPicker key={`${channel}-prompt-fixed`} label="提示词模型" value={model} options={promptModelOptions} placeholder={DEFAULT_PROMPT_MODEL} onChange={(value) => updateCurrentModels({ model: value })} disabled={saving || Boolean(testingTarget) || clearing} compact />
                            {onDiscover && (
                              <div className="mt-1 border-t border-slate-100 pt-2">
                                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                  <span>{catalogLoading === channel ? '正在读取可用模型…' : currentCatalog ? `已读取 ${currentCatalog.promptModels.length} 个提示词模型、${currentCatalog.imageModels.length} 个生图模型` : '从当前通道读取真实可用模型'}</span>
                                  <button type="button" onClick={() => void discoverModels(channel)} disabled={catalogLoading === channel || saving || Boolean(testingTarget)} className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                                    <RefreshCw className={`h-3 w-3 ${catalogLoading === channel ? 'animate-spin motion-reduce:animate-none' : ''}`} />刷新模型
                                  </button>
                                </div>
                                {catalogErrors[channel] && <p className="mt-1 text-[11px] leading-4 text-amber-700" role="status">{catalogErrors[channel]} 已保存的模型不会被覆盖，仍可手动填写。</p>}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <span className={`text-xs font-normal ${hasEffectiveKey ? 'text-slate-500' : 'text-amber-600'}`}>{channelGuidance}</span>
              </fieldset>

              <details open={channel === 'custom' ? true : undefined} className="group rounded-md border border-slate-200 bg-slate-50/60">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
                  <SlidersHorizontal className="h-4 w-4 text-slate-500" />
                  <span className="flex-1">高级设置</span>
                  {channel === 'custom' && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">自定义已启用</span>}
                  <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid gap-4 border-t border-slate-200 p-3">
                  <button type="button" aria-pressed={channel === 'custom'} onClick={() => selectChannel('custom')} disabled={saving || Boolean(testingTarget) || clearing} className={`flex min-h-10 items-center justify-between gap-3 rounded-md border px-3 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-55 ${channel === 'custom' ? 'border-blue-400 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200'}`}>
                    <span>使用自定义 OpenAI 兼容接口</span>
                    {channel === 'custom' && <Check className="h-4 w-4" />}
                  </button>
                  {channel === 'custom' && (
                    <>
                      <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                        自定义 API 地址
                        <Input value={customBaseUrl} onChange={(event) => { setCustomBaseUrl(event.target.value); invalidateCatalog('custom'); setTestResults({}); setFeedback(null) }} placeholder="https://your-api.example/v1" inputMode="url" autoComplete="url" />
                        <span className="text-xs font-normal text-slate-500">填写 OpenAI 兼容接口根地址，仅用于自定义通道。</span>
                      </label>
                      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                        <ModelPicker key={`${channel}-image-custom`} label="图片模型" value={imageModel} options={imageModelOptions} placeholder={DEFAULT_IMAGE_MODEL} onChange={(value) => updateCurrentModels({ imageModel: value })} disabled={saving || Boolean(testingTarget) || clearing} />
                        <ModelPicker key={`${channel}-prompt-custom`} label="提示词/分析模型" value={model} options={promptModelOptions} placeholder={DEFAULT_PROMPT_MODEL} onChange={(value) => updateCurrentModels({ model: value })} disabled={saving || Boolean(testingTarget) || clearing} />
                      </div>
                      {onDiscover && (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500">
                          <span>{catalogLoading === channel ? '正在读取可用模型…' : currentCatalog ? `已读取 ${currentCatalog.promptModels.length} 个提示词模型、${currentCatalog.imageModels.length} 个生图模型` : catalogErrors[channel] || '从自定义接口读取真实可用模型'}</span>
                          <Button type="button" variant="secondary" size="sm" onClick={() => void discoverModels(channel)} disabled={catalogLoading === channel || saving || Boolean(testingTarget)}><RefreshCw className={`h-3.5 w-3.5 ${catalogLoading === channel ? 'animate-spin motion-reduce:animate-none' : ''}`} />刷新模型</Button>
                          {catalogErrors[channel] && <span className="w-full text-amber-700">查询失败不会覆盖已保存模型，仍可手动填写。</span>}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </details>
            </>
          ) : (
            <>
              <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                <span className="flex items-center gap-2">模型通道<span className="inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">内部使用</span></span>
                <div className="relative">
                  <select value={channel} onChange={(event) => selectChannel(event.target.value as ModelChannel)} disabled={saving || Boolean(testingTarget) || clearing} className="h-10 w-full appearance-none rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm font-normal text-slate-800 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-55">
                    <option value="stable">{purpose === 'prompt' ? '稳定通道（推荐）' : '稳定生图（推荐）'}</option>
                    <option value="fast">高速通道</option>
                    <option value="custom">自定义配置</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                </div>
                <span className={`text-xs font-normal ${hasEffectiveKey ? 'text-slate-500' : 'text-amber-600'}`}>{channelGuidance}</span>
              </label>

              {channel === 'custom' && <label className="grid gap-1.5 text-sm font-medium text-slate-700">自定义 API 地址<Input value={customBaseUrl} onChange={(event) => { setCustomBaseUrl(event.target.value); invalidateCatalog('custom'); setTestResults({}); setFeedback(null) }} placeholder="https://your-api.example/v1" inputMode="url" autoComplete="url" /><span className="text-xs font-normal text-slate-500">填写 OpenAI 兼容接口根地址；自定义地址只在此通道中使用。</span></label>}

              <div className={`grid min-w-0 gap-3 ${purpose === 'prompt' ? '' : 'sm:grid-cols-2'}`}>
                {purpose !== 'prompt' && <ModelPicker key={`${channel}-image`} label="图片模型" value={imageModel} options={imageModelOptions} placeholder={DEFAULT_IMAGE_MODEL} onChange={(value) => updateCurrentModels({ imageModel: value })} disabled={saving || Boolean(testingTarget) || clearing} helpText="AI 生图使用，独立于提示词模型。" />}
                <ModelPicker key={`${channel}-prompt`} label="提示词/分析模型" value={model} options={promptModelOptions} placeholder={DEFAULT_PROMPT_MODEL} onChange={(value) => updateCurrentModels({ model: value })} disabled={saving || Boolean(testingTarget) || clearing} helpText="AI 提示词和 AI 数据分析使用。" />
              </div>
            </>
          )}

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            API Key
            <div className="relative">
              <Input
                value={apiKey}
                onChange={(event) => {
                  setApiKeyDrafts((current) => ({ ...current, [channel]: event.target.value }))
                  invalidateCatalog(channel)
                  setTestResults({})
                  setFeedback(null)
                }}
                placeholder="请输入你自己的 API Key"
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                className="pr-11"
              />
              <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center rounded-r-md text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏 API Key' : '显示 API Key'}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <span className={`text-xs font-normal ${hasEffectiveKey ? 'text-slate-500' : 'text-amber-600'}`}>{keyGuidance} 软件不会回显完整密钥。</span>
          </label>

          {feedback && (
            <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${feedback.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : feedback.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-800'}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
              {testingTarget ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : feedback.tone === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : feedback.tone === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <PlugZap className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{feedback.text}</span>
            </div>
          )}

          <div className="flex flex-col items-stretch gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid gap-1.5">
              {channelState.apiKeySource === 'saved' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void clearApiKey()} disabled={saving || Boolean(testingTarget) || clearing} className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 sm:w-auto">
                  {clearing ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-4 w-4" />}
                  {clearing ? '清除中' : `清除${channelLabel} Key`}
                </Button>
              )}
              {currentChannelDirty && <span className="text-xs font-medium text-amber-700" role="status">当前通道有未保存修改，保存后才能切换通道。</span>}
            </div>
            <div className={`grid gap-2 ${creationMode && onTest ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2 sm:flex sm:items-center sm:justify-end'}`}>
              {onTest && creationMode ? (
                <>
                  <Button type="button" variant="secondary" onClick={() => void testConnection('prompt')} disabled={saving || Boolean(testingTarget) || clearing} title="发送一条极短文本请求验证提示词模型，不会生成图片" className="w-full sm:w-auto">
                    {testingTarget === 'prompt' ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PlugZap className="h-4 w-4" />}
                    {testingTarget === 'prompt' ? '测试中' : '测试提示词'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => void testConnection('image')} disabled={saving || Boolean(testingTarget) || clearing} title="验证当前通道、Key 和图片模型，不会生成图片" className="w-full sm:w-auto">
                    {testingTarget === 'image' ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PlugZap className="h-4 w-4" />}
                    {testingTarget === 'image' ? '测试中' : '测试生图'}
                  </Button>
                </>
              ) : onTest ? (
                <Button type="button" variant="secondary" onClick={() => void testConnection()} disabled={saving || Boolean(testingTarget) || clearing} title={testTarget === 'prompt' ? '发送一条极短的结构化请求验证提示词模型，会消耗极少量文本额度' : '只验证当前通道、Key 和图片模型，不会生成图片或产生生图费用'} className="w-full sm:w-auto">
                  {testingTarget ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PlugZap className="h-4 w-4" />}
                  {testingTarget ? '验证中' : '测试连接'}
                </Button>
              ) : null}
              <Button type="submit" disabled={saving || Boolean(testingTarget) || clearing} className={onTest ? 'w-full sm:w-auto' : 'col-span-2 w-full sm:w-auto'}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Save className="h-4 w-4" />}
                {saving ? '保存中' : '保存配置'}
              </Button>
            </div>
          </div>
          {onTest && creationMode && <p className="-mt-2 text-right text-xs leading-5 text-slate-400">两项测试互相独立；只有提示词和生图都通过，才表示 AI 创作模型完整可用。</p>}
          {onTest && !creationMode && testTarget === 'prompt' && <p className="-mt-2 text-right text-xs text-slate-400">提示词连接测试会发送一条极短文本请求，不会生成图片。</p>}
        </form>
      </CardContent>
    </Card>
  )

  if (!onClose) return panel

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="model-config-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {panel}
    </div>
  )
}
