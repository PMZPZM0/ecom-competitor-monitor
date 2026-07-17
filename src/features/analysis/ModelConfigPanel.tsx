import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, PlugZap, Save, Trash2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import type { ModelChannel, ModelChannelState, ModelConfig, ModelConfigPatch, ModelConfigTestResult } from '../../types/domain'

type Props = {
  config: ModelConfig
  onSave: (payload: ModelConfigPatch) => Promise<void>
  onTest?: (payload: Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'imageModel' | 'apiKey'>) => Promise<ModelConfigTestResult>
  onClose?: () => void
}

type Feedback = { tone: 'success' | 'error' | 'neutral'; text: string }

const CHANNEL_LABELS: Record<ModelChannel, string> = {
  stable: '稳定生图',
  fast: '高速通道',
  custom: '自定义配置',
}

const EMPTY_CHANNEL_STATE: ModelChannelState = {
  hasApiKey: false,
  apiKeyMasked: '',
  apiKeySource: 'none',
  lastTestedAt: null,
  lastTestStatus: null,
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
  }
}

export function ModelConfigPanel({ config, onSave, onTest, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [channel, setChannel] = useState<ModelChannel>(config.channel || 'stable')
  const [customBaseUrl, setCustomBaseUrl] = useState(config.customBaseUrl || '')
  const [imageModel, setImageModel] = useState(config.imageModel || 'gpt-image-2')
  const [model, setModel] = useState(config.model || 'gpt-4.1-mini')
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<ModelChannel, string>>({ stable: '', fast: '', custom: '' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [testResult, setTestResult] = useState<ModelConfigTestResult | null>(null)
  const apiKey = apiKeyDrafts[channel]
  const channelLabel = CHANNEL_LABELS[channel]
  const channelState = getChannelState(config, channel)

  useEffect(() => {
    setChannel(config.channel || 'stable')
    setCustomBaseUrl(config.customBaseUrl || '')
    setImageModel(config.imageModel || 'gpt-image-2')
    setModel(config.model || 'gpt-4.1-mini')
  }, [config.channel, config.customBaseUrl, config.imageModel, config.model])

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

  function validateImageConnection() {
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
    if (!imageModel.trim()) return '请输入图片模型名称。'
    return ''
  }

  function validateForSave() {
    const imageError = validateImageConnection()
    if (imageError) return imageError
    if (!model.trim()) return '请输入分析模型名称。'
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
    try {
      await onSave({
        channel,
        ...(channel === 'custom' ? { customBaseUrl: customBaseUrl.trim().replace(/\/+$/, '') } : {}),
        imageModel: imageModel.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setApiKeyDrafts((current) => ({ ...current, [channel]: '' }))
      setShowKey(false)
      setFeedback({ tone: 'success', text: `${channelLabel}配置已保存。` })
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '模型配置保存失败。' })
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    const validationError = validateImageConnection()
    if (validationError) {
      setFeedback({ tone: 'error', text: validationError })
      return
    }
    if (!onTest) return
    if (!channelState.hasApiKey && !apiKey.trim()) {
      setFeedback({ tone: 'error', text: `${channelLabel}尚未配置 Key，请联系管理员。` })
      return
    }
    setTesting(true)
    setFeedback({ tone: 'neutral', text: '正在验证模型连接。' })
    try {
      const result = await onTest({
        channel,
        ...(channel === 'custom' ? { customBaseUrl: customBaseUrl.trim().replace(/\/+$/, '') } : {}),
        imageModel: imageModel.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setTestResult(result)
      setFeedback({
        tone: result.status === 'success' ? 'success' : 'neutral',
        text: `${result.message}（${result.latencyMs} ms）`,
      })
    } catch (error) {
      setTestResult(null)
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '模型连接失败。' })
    } finally {
      setTesting(false)
    }
  }

  async function clearApiKey() {
    if (!window.confirm(`确定清除本机保存的${channelLabel} Key？`)) return
    setClearing(true)
    setFeedback(null)
    try {
      await onSave({ channel, clearApiKey: true })
      setApiKeyDrafts((current) => ({ ...current, [channel]: '' }))
      setTestResult(null)
      setFeedback({ tone: 'success', text: `${channelLabel} Key 已清除。` })
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : 'API Key 清除失败。' })
    } finally {
      setClearing(false)
    }
  }

  const customAddressMatches = channel !== 'custom'
    || customBaseUrl.trim().replace(/\/+$/, '') === (config.customBaseUrl || '').replace(/\/+$/, '')
  const draftMatchesTestedModel = !apiKey.trim() && imageModel.trim() === config.imageModel && customAddressMatches
  const currentTestStatus = testResult?.status || (draftMatchesTestedModel ? channelState.lastTestStatus : null)
  const lastTestedAt = testResult?.testedAt || (draftMatchesTestedModel ? channelState.lastTestedAt : null)
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
      : '请填写自定义 API 地址，并联系管理员配置该通道 Key。'
    : hasEffectiveKey
      ? channelChanged
        ? `已切换至${channelLabel}，将使用该通道的 Key，保存后生效。`
        : `地址已内置，${channelLabel} Key 已配置。`
      : `${channelLabel}尚未配置 Key，请联系管理员。`
  const keyGuidance = apiKey.trim()
    ? `${channelLabel} Key 待保存。`
    : channelState.apiKeySource === 'environment'
      ? `${channelLabel}使用环境变量 Key；输入新 Key 后会改为本机保存。`
      : channelState.hasApiKey
        ? `${channelLabel} Key 已配置；留空会保留。`
        : `${channelLabel}尚未配置 Key，请联系管理员。`

  const panel = (
    <Card className={onClose ? 'w-full max-w-2xl overflow-y-auto shadow-2xl max-h-[calc(100vh-2rem)]' : undefined} role={onClose ? 'document' : undefined}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle id="model-config-title" className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-blue-600" />
            模型配置
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium ${currentTestStatus === 'success' ? 'bg-emerald-50 text-emerald-700' : currentTestStatus === 'failed' ? 'bg-red-50 text-red-700' : currentTestStatus === 'unverified' ? 'bg-amber-50 text-amber-700' : hasEffectiveKey ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {channelLabel} · {currentTestStatus === 'success' ? '基础连接已验证' : currentTestStatus === 'failed' ? '上次验证失败' : currentTestStatus === 'unverified' ? '待生成验证' : hasEffectiveKey ? '已配置，尚未验证' : '尚未连接'}
            </span>
            <span>Key：{keySourceLabel}</span>
            {lastTestedAt && <span>最近验证：{new Date(lastTestedAt).toLocaleString('zh-CN')}</span>}
          </div>
        </div>
        {onClose && (
          <button ref={closeButtonRef} type="button" onClick={onClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="关闭模型配置" title="关闭">
            <X className="h-4 w-4" />
          </button>
        )}
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            <span className="flex items-center gap-2">
              模型通道
              <span className="inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">内部使用</span>
            </span>
            <div className="relative">
              <select
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as ModelChannel)
                  setShowKey(false)
                  setTestResult(null)
                  setFeedback(null)
                }}
                disabled={saving || testing || clearing}
                className="h-10 w-full appearance-none rounded-md border border-slate-200 bg-white px-3 pr-10 text-sm font-normal text-slate-800 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <option value="stable">稳定生图（推荐）</option>
                <option value="fast">高速通道</option>
                <option value="custom">自定义配置</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            </div>
            <span className={`text-xs font-normal ${hasEffectiveKey ? 'text-slate-500' : 'text-amber-600'}`}>{channelGuidance}</span>
          </label>

          {channel === 'custom' && (
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              自定义 API 地址
              <Input
                value={customBaseUrl}
                onChange={(event) => {
                  setCustomBaseUrl(event.target.value)
                  setTestResult(null)
                  setFeedback(null)
                }}
                placeholder="https://your-api.example/v1"
                inputMode="url"
                autoComplete="url"
              />
              <span className="text-xs font-normal text-slate-500">填写 OpenAI 兼容接口根地址；自定义地址只在此通道中使用。</span>
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              图片模型
              <Input value={imageModel} onChange={(event) => { setImageModel(event.target.value); setTestResult(null) }} placeholder="gpt-image-2" autoComplete="off" />
              <span className="text-xs font-normal text-slate-400">AI 生图使用，独立于分析模型。</span>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              分析模型
              <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" autoComplete="off" />
              <span className="text-xs font-normal text-slate-400">仅供 AI 数据分析使用。</span>
            </label>
          </div>

          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            API Key
            <div className="relative">
              <Input
                value={apiKey}
                onChange={(event) => {
                  setApiKeyDrafts((current) => ({ ...current, [channel]: event.target.value }))
                  setTestResult(null)
                }}
                placeholder="联系管理员"
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
              {testing ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : feedback.tone === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : feedback.tone === 'error' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <PlugZap className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{feedback.text}</span>
            </div>
          )}

          <div className="flex flex-col items-stretch gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {channelState.apiKeySource === 'saved' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void clearApiKey()} disabled={saving || testing || clearing} className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 sm:w-auto">
                  {clearing ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-4 w-4" />}
                  {clearing ? '清除中' : `清除${channelLabel} Key`}
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
              {onTest && (
                <Button type="button" variant="secondary" onClick={() => void testConnection()} disabled={saving || testing || clearing} title="只验证当前通道、Key 和图片模型，不会生成图片或产生生图费用" className="w-full sm:w-auto">
                  {testing ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <PlugZap className="h-4 w-4" />}
                  {testing ? '验证中' : '测试连接'}
                </Button>
              )}
              <Button type="submit" disabled={saving || testing || clearing} className={onTest ? 'w-full sm:w-auto' : 'col-span-2 w-full sm:w-auto'}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Save className="h-4 w-4" />}
                {saving ? '保存中' : '保存配置'}
              </Button>
            </div>
          </div>
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
