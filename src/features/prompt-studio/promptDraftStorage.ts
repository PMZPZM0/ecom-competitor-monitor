import type { PromptStudioDraft } from './types'

const DRAFT_KEY = 'ecommerce-monitor-prompt-studio-draft-v1'
const DATABASE_NAME = 'ecommerce-monitor-prompt-studio'
const DATABASE_VERSION = 1
const FILE_STORE = 'draft-files'
const FILES_KEY = 'active-draft'

const categories = new Set(['white-background', 'product-scene', 'campaign-poster', 'detail-page', 'local-edit', 'background-swap', 'product-retouch'])
const copyModes = new Set(['none', 'reserved', 'exact'])
const ratios = new Set(['1:1', '3:4', '4:3', '16:9'])
const resolutions = new Set(['1k', '2k', '4k'])
const qualities = new Set(['low', 'medium', 'high'])
const backgrounds = new Set(['auto', 'opaque', 'transparent'])

export type StoredReferenceFile = {
  id: string
  file: File
}

export type StoredReferenceGroups = {
  product: StoredReferenceFile[]
  style: StoredReferenceFile[]
}

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error || new Error('参考图存储不可用。'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE)
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function restoreShape(saved: unknown, fallback: unknown): unknown {
  if (Array.isArray(fallback)) {
    return Array.isArray(saved) && saved.length <= 100 && saved.every((item) => typeof item === 'string')
      ? [...saved]
      : fallback
  }
  if (typeof fallback === 'string') return typeof saved === 'string' && saved.length <= 10_000 ? saved : fallback
  if (typeof fallback === 'boolean') return typeof saved === 'boolean' ? saved : fallback
  if (!isRecord(fallback) || !isRecord(saved)) return fallback
  return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [key, restoreShape(saved[key], value)]))
}

function restoreStringRecord(value: unknown, fallback: Record<string, string>) {
  if (!isRecord(value)) return fallback
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 10_000)
    .slice(0, 100)
  return Object.fromEntries(entries)
}

export function loadPromptDraft<T extends PromptStudioDraft>(fallback: T): T {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as unknown
    if (!isRecord(saved)) return fallback
    const restored = restoreShape(saved, fallback) as PromptStudioDraft
    return {
      ...restored,
      category: categories.has(restored.category) ? restored.category : fallback.category,
      copy: {
        ...restored.copy,
        mode: copyModes.has(restored.copy.mode) ? restored.copy.mode : fallback.copy.mode,
      },
      parameters: {
        ratio: ratios.has(restored.parameters.ratio) ? restored.parameters.ratio : fallback.parameters.ratio,
        resolution: resolutions.has(restored.parameters.resolution) ? restored.parameters.resolution : fallback.parameters.resolution,
        quality: qualities.has(restored.parameters.quality) ? restored.parameters.quality : fallback.parameters.quality,
        background: backgrounds.has(restored.parameters.background) ? restored.parameters.background : fallback.parameters.background,
      },
      taskFields: restoreStringRecord(saved.taskFields, fallback.taskFields),
    } as T
  } catch {
    return fallback
  }
}

export function savePromptDraft(draft: PromptStudioDraft) {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // Private browser modes may reject localStorage writes; the active state remains usable.
  }
}

export async function loadReferenceGroups(): Promise<StoredReferenceGroups> {
  if (!window.indexedDB) return { product: [], style: [] }
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(FILES_KEY)
      request.onerror = () => reject(request.error || new Error('参考图读取失败。'))
      request.onsuccess = () => {
        const value = request.result as Partial<StoredReferenceGroups> | undefined
        resolve({ product: value?.product || [], style: value?.style || [] })
      }
    })
  } finally {
    db.close()
  }
}

export async function saveReferenceGroups(groups: StoredReferenceGroups) {
  if (!window.indexedDB) return
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(FILE_STORE, 'readwrite').objectStore(FILE_STORE).put(groups, FILES_KEY)
      request.onerror = () => reject(request.error || new Error('参考图保存失败。'))
      request.onsuccess = () => resolve()
    })
  } finally {
    db.close()
  }
}
