import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import {
  promptGardenClient,
  type PromptGardenPrompt,
  type PromptGardenSuggestion,
} from './promptGarden'

const PROMPT_GARDEN_HOME = 'https://garden.always200.com'
const PROMPT_LENGTH_LIMIT = 4_000

export type PromptGardenPanelProps = {
  search: string
  onApplyPrompt: (prompt: PromptGardenPrompt) => Promise<boolean>
}

function searchableText(item: PromptGardenSuggestion) {
  return [
    item.title,
    item.summary,
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.categoryPath) ? item.categoryPath : [item.categoryPath]),
    item.source,
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
}

function errorMessage(error: unknown) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return '当前网络已断开，联网后可以重新加载。'
  }
  const detail = error instanceof Error ? error.message : String(error ?? '')
  if (/timeout|timed out|abort|超时/i.test(detail)) {
    return '连接提示词库超时，请稍后重试。'
  }
  return detail ? `提示词库暂时不可用：${detail}` : '提示词库暂时不可用，请稍后重试。'
}

function safePanelId(value: string) {
  return `prompt-garden-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function sourceLabel(source?: string) {
  if (source === 'featured') return '社区精选'
  if (source === 'latest') return '近期更新'
  if (source === 'random') return '随机灵感'
  return source
}

export function PromptGardenPanel({ search, onApplyPrompt }: PromptGardenPanelProps) {
  const [suggestions, setSuggestions] = useState<PromptGardenSuggestion[]>([])
  const [browseUrl, setBrowseUrl] = useState(PROMPT_GARDEN_HOME)
  const [nextExclude, setNextExclude] = useState<string[]>([])
  const [lastRequestedExclude, setLastRequestedExclude] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(true)
  const [suggestionsError, setSuggestionsError] = useState('')
  const [expandedCode, setExpandedCode] = useState('')
  const [detail, setDetail] = useState<PromptGardenPrompt | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [applyingCode, setApplyingCode] = useState('')
  const [appliedCode, setAppliedCode] = useState('')
  const [applyError, setApplyError] = useState('')
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set())
  const suggestionsRequest = useRef(0)
  const detailRequest = useRef(0)

  const loadSuggestions = useCallback(async (exclude: string[] = []) => {
    const requestId = ++suggestionsRequest.current
    setLastRequestedExclude(exclude)
    setSuggestionsLoading(true)
    setSuggestionsError('')
    try {
      const result = await promptGardenClient.getSuggestions('image-text2image', { exclude })
      if (requestId !== suggestionsRequest.current) return
      setSuggestions(result.items)
      setBrowseUrl(result.browseUrl || PROMPT_GARDEN_HOME)
      setNextExclude(result.nextExclude)
      setBrokenImages(new Set())
      setExpandedCode('')
      setDetail(null)
      setDetailError('')
      setApplyError('')
    } catch (error) {
      if (requestId === suggestionsRequest.current) setSuggestionsError(errorMessage(error))
    } finally {
      if (requestId === suggestionsRequest.current) setSuggestionsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSuggestions()
    return () => {
      suggestionsRequest.current += 1
      detailRequest.current += 1
    }
  }, [loadSuggestions])

  const visibleSuggestions = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN')
    return keyword ? suggestions.filter((item) => searchableText(item).includes(keyword)) : suggestions
  }, [search, suggestions])

  async function loadDetail(item: PromptGardenSuggestion) {
    const requestId = ++detailRequest.current
    setExpandedCode(item.importCode)
    setDetail(null)
    setDetailLoading(true)
    setDetailError('')
    setApplyError('')
    setAppliedCode('')
    try {
      const result = await promptGardenClient.getPrompt(item.importCode)
      if (requestId === detailRequest.current) setDetail(result)
    } catch (error) {
      if (requestId === detailRequest.current) setDetailError(errorMessage(error))
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false)
    }
  }

  async function showDetail(item: PromptGardenSuggestion) {
    if (expandedCode !== item.importCode) {
      await loadDetail(item)
      return
    }
    detailRequest.current += 1
    setExpandedCode('')
    setDetail(null)
    setDetailError('')
    setApplyError('')
  }

  async function applyPrompt(prompt: PromptGardenPrompt, importCode: string) {
    setApplyingCode(importCode)
    setApplyError('')
    setAppliedCode('')
    try {
      const applied = await onApplyPrompt(prompt)
      if (applied) setAppliedCode(importCode)
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : '套用失败，请重试。')
    } finally {
      setApplyingCode('')
    }
  }

  return (
    <section className="min-w-0" aria-label="社区提示词">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Sparkles className="h-4 w-4 text-blue-600" aria-hidden="true" />
            社区灵感
          </h3>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
            来源 Prompt Garden。只读取公开模板，不会上传你的商品图或当前提示词。
          </p>
        </div>
        <a
          href={browseUrl || PROMPT_GARDEN_HOME}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-slate-500 outline-none transition hover:bg-slate-100 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none"
        >
          浏览更多
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </header>

      {suggestionsError && (
        <RemoteError
          message={suggestionsError}
          browseUrl={browseUrl}
          onRetry={() => void loadSuggestions(lastRequestedExclude)}
        />
      )}

      {suggestionsLoading && suggestions.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center gap-2 px-4 text-sm text-slate-500" role="status" aria-live="polite">
          <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          正在读取社区提示词…
        </div>
      ) : visibleSuggestions.length ? (
        <div aria-live="polite">
          {visibleSuggestions.map((item) => {
            const expanded = expandedCode === item.importCode
            const panelId = safePanelId(item.id || item.importCode)
            const thumbnailVisible = Boolean(item.thumbnailUrl) && !brokenImages.has(item.id)
            return (
              <article key={item.id || item.importCode} className="border-b border-slate-100 px-3 py-3 last:border-b-0">
                <div className="flex min-w-0 gap-3">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 sm:h-24 sm:w-24">
                    {thumbnailVisible ? (
                      <img
                        src={item.thumbnailUrl || undefined}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        onError={() => setBrokenImages((current) => new Set(current).add(item.id))}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-slate-300" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">{item.title}</h4>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{item.summary || '查看完整提示词和作者信息。'}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1" aria-label="提示词标签和来源">
                      {(item.tags || []).slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{tag}</span>
                      ))}
                      {item.source && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">{sourceLabel(item.source)}</span>}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => void showDetail(item)}
                  className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 outline-none transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none"
                >
                  {expanded && detailLoading ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : expanded ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {expanded ? '收起' : '查看'}
                </button>

                {expanded && (
                  <div id={panelId} className="mt-2 rounded-md bg-slate-50 p-3">
                    {detailLoading ? (
                      <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-slate-500" role="status">
                        <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        正在加载完整提示词…
                      </div>
                    ) : detailError ? (
                      <RemoteError
                        compact
                        message={detailError}
                        browseUrl={browseUrl}
                        onRetry={() => void loadDetail(item)}
                      />
                    ) : detail ? (
                      <>
                        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700" tabIndex={0}>
                          {detail.text}
                        </p>
                        {detail.variables.length > 0 && (
                          <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 p-3">
                            <p className="text-xs font-semibold text-blue-900">套用后还要补充 {detail.variables.length} 项</p>
                            <ul className="mt-2 grid gap-1.5 text-[11px] leading-5 text-blue-800">
                              {detail.variables.map((variable) => (
                                <li key={variable.name}>
                                  <code className="rounded bg-white px-1 py-0.5 text-[10px] font-semibold text-blue-700">{`{{${variable.name}}}`}</code>
                                  <span className="ml-1.5">{variable.description || (variable.required ? '必填内容' : '可选内容')}{variable.defaultValue ? `（默认：${variable.defaultValue}）` : variable.required ? '（必填）' : ''}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <PromptAttribution prompt={detail} />
                        {detail.text.length > PROMPT_LENGTH_LIMIT && (
                          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" role="alert">
                            这条模板有 {detail.text.length} 个字符，超过当前工作台的 {PROMPT_LENGTH_LIMIT} 字上限。为避免内容被截断，请先去原页面精简后再使用。
                          </p>
                        )}
                        {applyError && <p className="mt-2 text-xs leading-5 text-red-600" role="alert">{applyError}</p>}
                        <Button
                          type="button"
                          size="sm"
                          className="mt-3 w-full"
                          disabled={Boolean(applyingCode) || detail.text.length > PROMPT_LENGTH_LIMIT}
                          onClick={() => void applyPrompt(detail, item.importCode)}
                        >
                          {applyingCode === item.importCode ? (
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                          ) : appliedCode === item.importCode ? (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {detail.text.length > PROMPT_LENGTH_LIMIT ? '内容过长，暂不能套用' : appliedCode === item.importCode ? '已套用' : '套用此提示词'}
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      ) : suggestionsError && suggestions.length === 0 ? null : (
        <div className="flex min-h-40 flex-col items-center justify-center px-5 text-center">
          <Sparkles className="h-6 w-6 text-slate-300" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-slate-700">
            {search.trim() ? '这一批没有匹配的提示词' : '这一批暂无推荐'}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {search.trim() ? '搜索只筛选当前这一批，换一批后可继续查找。' : '可以稍后重试或去社区浏览。'}
          </p>
        </div>
      )}

      {suggestions.length > 0 && (
        <footer className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-3">
          <p className="min-w-0 text-[11px] text-slate-500">
            当前显示 {visibleSuggestions.length} / {suggestions.length} 条
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={suggestionsLoading || nextExclude.length === 0}
            onClick={() => void loadSuggestions(nextExclude)}
          >
            {suggestionsLoading ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            换一批
          </Button>
        </footer>
      )}
    </section>
  )
}

function PromptAttribution({ prompt }: { prompt: PromptGardenPrompt }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-500">
      {prompt.author && (
        <>
          <dt>作者</dt>
          <dd className="min-w-0 truncate">
            {prompt.authorUrl ? (
              <a href={prompt.authorUrl} target="_blank" rel="noreferrer" className="font-medium text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500">{prompt.author}</a>
            ) : prompt.author}
          </dd>
        </>
      )}
      {prompt.source && (
        <>
          <dt>来源</dt>
          <dd className="min-w-0 truncate">
            {prompt.sourceUrl ? (
              <a href={prompt.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500">
                <span className="truncate">{prompt.source}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              </a>
            ) : prompt.source}
          </dd>
        </>
      )}
      {prompt.license && (
        <>
          <dt>许可</dt>
          <dd className="min-w-0 break-words">{prompt.license}</dd>
        </>
      )}
    </dl>
  )
}

function RemoteError({
  message,
  browseUrl,
  onRetry,
  compact = false,
}: {
  message: string
  browseUrl: string
  onRetry: () => void
  compact?: boolean
}) {
  return (
    <div className={compact ? 'text-center' : 'm-3 rounded-md border border-amber-200 bg-amber-50 p-3'} role="alert">
      <div className="flex items-start gap-2 text-left">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <p className="text-xs leading-5 text-amber-900">{message}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 pl-6">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-xs font-medium text-amber-900 outline-none transition hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 motion-reduce:transition-none"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          重试
        </button>
        <a
          href={browseUrl || PROMPT_GARDEN_HOME}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-amber-800 outline-none transition hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 motion-reduce:transition-none"
        >
          打开网页
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}
