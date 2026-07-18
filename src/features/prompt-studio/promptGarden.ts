import { z } from 'zod'

export const PROMPT_GARDEN_BASE_URL = 'https://garden.always200.com'
const PROMPT_GARDEN_DETAIL_CACHE_LIMIT = 20

export const promptGardenSubModeKeys = [
  'basic-system',
  'basic-user',
  'pro-multi',
  'pro-variable',
  'image-text2image',
  'image-image2image',
] as const

export type PromptGardenSubModeKey = typeof promptGardenSubModeKeys[number]

export type PromptGardenSuggestion = {
  id: string
  title: string
  summary: string
  tags: string[]
  categoryPath: string[]
  importCode: string
  mode: PromptGardenSubModeKey
  thumbnailUrl?: string
  updatedAt?: string
  source?: string
}

export type PromptGardenMessage = {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export type PromptGardenVariable = {
  name: string
  description?: string
  required: boolean
  defaultValue?: string
  options: string[]
}

export type PromptGardenPrompt = {
  id: string
  importCode: string
  subModeKey: PromptGardenSubModeKey
  format: 'text' | 'messages'
  text: string
  messages: PromptGardenMessage[]
  variables: PromptGardenVariable[]
  title: string
  summary: string
  tags: string[]
  categoryPath: string[]
  author?: string
  authorUrl?: string
  source?: string
  sourceUrl?: string
  license?: string
}

export type PromptGardenSuggestions = {
  items: PromptGardenSuggestion[]
  browseUrl: string
  nextExclude: string[]
  ttlSeconds: number
}

type PromptGardenClientOptions = {
  baseUrl?: string
  fetch?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  now?: () => number
  timeoutMs?: number
  detailTtlSeconds?: number
}

type RequestOptions = {
  signal?: AbortSignal
}

type SuggestionOptions = RequestOptions & {
  exclude?: string[]
}

const subModeKeySchema = z.enum(promptGardenSubModeKeys)
const httpUrlSchema = z.url().refine((value) => /^https?:$/i.test(new URL(value).protocol))
const shortText = z.string().trim().min(1).max(10_000)
const promptText = z.string().trim().min(1).max(500_000)
const stringList = z.array(z.string().trim().min(1).max(500)).max(100)

const suggestionSchema = z.object({
  id: shortText,
  title: shortText,
  summary: z.string().trim().max(20_000).default(''),
  tags: stringList.default([]),
  categoryPath: stringList.default([]),
  importCode: shortText,
  mode: subModeKeySchema,
  thumbnailUrl: httpUrlSchema.optional(),
  updatedAt: z.string().trim().max(200).optional(),
  source: z.string().trim().max(500).optional(),
})

const suggestionsSchema = z.object({
  items: z.array(suggestionSchema).max(100),
  browseUrl: httpUrlSchema,
  nextExclude: stringList.default([]),
  ttlSeconds: z.number().int().positive().max(86_400),
})

const messageSchema = z.object({
  id: z.string().trim().min(1).max(500).optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: promptText,
})

const variableSchema = z.object({
  name: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100),
  description: z.string().trim().max(10_000).optional(),
  required: z.boolean().optional(),
  defaultValue: z.string().max(100_000).optional(),
  options: stringList.optional(),
})

const detailSchema = z.object({
  id: shortText,
  importCode: shortText,
  schema: z.literal('prompt-garden.prompt.v1'),
  schemaVersion: z.literal(1),
  optimizerTarget: z.object({ subModeKey: subModeKeySchema }),
  prompt: z.discriminatedUnion('format', [
    z.object({ format: z.literal('text'), text: promptText }),
    z.object({ format: z.literal('messages'), messages: z.array(messageSchema).min(1).max(100) }),
  ]),
  variables: z.array(z.unknown()).max(100),
  ttlSeconds: z.number().int().positive().max(86_400).optional(),
  meta: z.object({
    title: z.string().trim().max(10_000).optional(),
    description: z.string().trim().max(20_000).optional(),
    tags: stringList.optional(),
    categoryPath: stringList.optional(),
    categoryPathKey: stringList.optional(),
    author: z.string().trim().max(10_000).optional(),
    authorUrl: z.string().trim().max(10_000).optional(),
    source: z.string().trim().max(10_000).optional(),
    sourceUrl: z.string().trim().max(10_000).optional(),
    license: z.string().trim().max(20_000).optional(),
  }).optional(),
})

type CacheEntry = {
  expiresAt: number
  value: unknown
}

export class PromptGardenError extends Error {
  readonly status?: number

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = 'PromptGardenError'
    this.status = status
  }
}

function safeHttpUrl(value?: string) {
  if (!value) return undefined
  const parsed = httpUrlSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function normalizeSuggestions(value: unknown, requestedMode: PromptGardenSubModeKey): PromptGardenSuggestions {
  const parsed = suggestionsSchema.safeParse(value)
  if (!parsed.success) throw new PromptGardenError('提示词花园推荐数据格式不兼容', undefined, parsed.error)
  if (parsed.data.items.some((item) => item.mode !== requestedMode)) {
    throw new PromptGardenError('提示词花园返回了不匹配的提示词类型')
  }
  return parsed.data
}

function normalizePrompt(value: unknown): PromptGardenPrompt {
  const parsed = detailSchema.safeParse(value)
  if (!parsed.success) throw new PromptGardenError('提示词花园详情数据格式不兼容', undefined, parsed.error)

  const { data } = parsed
  if (data.optimizerTarget.subModeKey !== 'image-text2image') {
    throw new PromptGardenError('当前提示词库只接受文生图提示词')
  }
  if (data.prompt.format !== 'text') {
    throw new PromptGardenError('文生图提示词必须使用 text 格式')
  }

  const messages: PromptGardenMessage[] = []
  const text = data.prompt.text
  const meta = data.meta
  const variables = data.variables.flatMap((variable) => {
    const result = variableSchema.safeParse(variable)
    return result.success ? [{
      name: result.data.name,
      description: result.data.description,
      required: result.data.required ?? false,
      defaultValue: result.data.defaultValue,
      options: result.data.options || [],
    }] : []
  })

  return {
    id: data.id,
    importCode: data.importCode,
    subModeKey: data.optimizerTarget.subModeKey,
    format: data.prompt.format,
    text,
    messages,
    variables,
    title: meta?.title?.trim() || data.id,
    summary: meta?.description?.trim() || '',
    tags: meta?.tags || [],
    categoryPath: meta?.categoryPath || meta?.categoryPathKey || [],
    author: meta?.author?.trim() || undefined,
    authorUrl: safeHttpUrl(meta?.authorUrl),
    source: meta?.source?.trim() || undefined,
    sourceUrl: safeHttpUrl(meta?.sourceUrl),
    license: meta?.license?.trim() || undefined,
  }
}

function getDefaultStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function normalizeBaseUrl(value: string) {
  const parsed = new URL(value)
  if (!/^https?:$/.test(parsed.protocol)) throw new PromptGardenError('提示词花园地址必须使用 HTTP 或 HTTPS')
  return parsed.toString().replace(/\/$/, '')
}

function parseImportCode(value: string) {
  const importCode = value.trim().split('@', 1)[0]
  if (!importCode || importCode.length > 200) throw new PromptGardenError('提示词导入码无效')
  return importCode
}

function cacheTtlFromHeader(value: string | null, fallback: number) {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)/i)
  const seconds = Number(match?.[1])
  return Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : fallback
}

export function createPromptGardenClient(options: PromptGardenClientOptions = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || PROMPT_GARDEN_BASE_URL)
  const fetchImpl = options.fetch || fetch
  const storage = options.storage === undefined ? getDefaultStorage() : options.storage
  const now = options.now || Date.now
  const timeoutMs = options.timeoutMs ?? 5_000
  const detailTtlSeconds = options.detailTtlSeconds ?? 300
  const detailCache = new Map<string, CacheEntry>()

  function cacheKey(url: string) {
    return `ecommerce-monitor:prompt-garden:v1:${url}`
  }

  function readCache(url: string) {
    if (!storage) return undefined
    const key = cacheKey(url)
    try {
      const entry = JSON.parse(storage.getItem(key) || 'null') as CacheEntry | null
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now()) {
        try { storage.removeItem(key) } catch { /* Ignore unavailable storage. */ }
        return undefined
      }
      return entry.value
    } catch {
      try { storage.removeItem(key) } catch { /* Ignore unavailable storage. */ }
      return undefined
    }
  }

  function deleteCache(url: string) {
    try { storage?.removeItem(cacheKey(url)) } catch { /* Ignore unavailable storage. */ }
  }

  function writeCache(url: string, value: unknown, ttlSeconds: number) {
    if (!storage) return
    try {
      storage.setItem(cacheKey(url), JSON.stringify({ expiresAt: now() + ttlSeconds * 1_000, value }))
    } catch {
      // A full or disabled sessionStorage must not make the public API unusable.
    }
  }

  function readDetailCache(url: string) {
    const entry = detailCache.get(url)
    if (!entry || entry.expiresAt <= now()) {
      detailCache.delete(url)
      return undefined
    }
    return entry.value
  }

  function writeDetailCache(url: string, value: unknown, ttlSeconds: number) {
    if (!detailCache.has(url) && detailCache.size >= PROMPT_GARDEN_DETAIL_CACHE_LIMIT) {
      const oldestKey = detailCache.keys().next().value
      if (oldestKey) detailCache.delete(oldestKey)
    }
    detailCache.set(url, { expiresAt: now() + ttlSeconds * 1_000, value })
  }

  async function fetchJson(url: string, signal?: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new PromptGardenError('提示词花园请求已取消')

      const controller = new AbortController()
      const forwardAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', forwardAbort, { once: true })
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        const retryable = response.status === 429 || response.status >= 500
        if (!response.ok) {
          if (attempt === 0 && retryable) continue
          throw new PromptGardenError(`提示词花园请求失败（${response.status}）`, response.status)
        }

        let value: unknown
        try {
          value = await response.json()
        } catch (error) {
          throw new PromptGardenError('提示词花园返回的不是有效 JSON', response.status, error)
        }
        return { value, cacheControl: response.headers.get('cache-control') }
      } catch (error) {
        if (controller.signal.aborted) throw new PromptGardenError('提示词花园请求已取消或超时', undefined, error)
        throw error
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', forwardAbort)
      }
    }
    throw new PromptGardenError('提示词花园请求失败')
  }

  return {
    async getSuggestions(mode: PromptGardenSubModeKey, request: SuggestionOptions = {}) {
      const parsedMode = subModeKeySchema.safeParse(mode)
      if (!parsedMode.success) throw new PromptGardenError('提示词花园模式无效', undefined, parsedMode.error)
      const validMode = parsedMode.data
      const url = new URL('/api/public/prompts/suggestions', `${baseUrl}/`)
      url.searchParams.set('mode', validMode)
      url.searchParams.set('limit', '5')
      url.searchParams.set('strategy', 'mixed')
      url.searchParams.set('locale', 'zh-CN')
      const exclude = [...new Set(request.exclude?.map((value) => value.trim()).filter(Boolean) || [])].slice(0, 100)
      if (exclude.length) url.searchParams.set('exclude', exclude.join(','))

      const key = url.toString()
      const cached = readCache(key)
      if (cached !== undefined) {
        try {
          return normalizeSuggestions(cached, validMode)
        } catch {
          deleteCache(key)
        }
      }

      const result = await fetchJson(key, request.signal)
      const suggestions = normalizeSuggestions(result.value, validMode)
      writeCache(key, result.value, suggestions.ttlSeconds)
      return suggestions
    },

    async getPrompt(importCodeValue: string, request: RequestOptions = {}) {
      const importCode = parseImportCode(importCodeValue)
      const url = new URL(`/api/public/prompt-source/${encodeURIComponent(importCode)}`, `${baseUrl}/`).toString()
      const cached = readDetailCache(url)
      if (cached !== undefined) {
        try {
          return normalizePrompt(cached)
        } catch {
          detailCache.delete(url)
        }
      }

      const result = await fetchJson(url, request.signal)
      const prompt = normalizePrompt(result.value)
      if (prompt.importCode !== importCode) throw new PromptGardenError('提示词花园返回了不匹配的导入码')
      const responseTtl = detailSchema.safeParse(result.value)
      const ttlSeconds = responseTtl.success && responseTtl.data.ttlSeconds
        ? responseTtl.data.ttlSeconds
        : cacheTtlFromHeader(result.cacheControl, detailTtlSeconds)
      writeDetailCache(url, result.value, ttlSeconds)
      return prompt
    },
  }
}

export const promptGardenClient = createPromptGardenClient()
