import type { ImageGenerationRequest } from '../../types/domain'

const IMAGE_OUTBOX_KEY = 'ecommerce-monitor-image-job-outbox-v2'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 20

type FileLike = { size: number; type: string; arrayBuffer: () => Promise<ArrayBuffer> }
type GenerationFiles = { referenceImages?: FileLike[]; maskImage?: FileLike }
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type ImageJobOutboxEntry = {
  key: string
  signature: string
  createdAt: string
}

type StoredOutbox = { entries: ImageJobOutboxEntry[] }

const memoryEntries = new Map<string, ImageJobOutboxEntry[]>()
const memoryFallbackKeys = new Set<string>()

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'clientRequestId')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]))
}

function validEntries(entries: unknown, now: number) {
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is ImageJobOutboxEntry => {
    if (!entry || typeof entry !== 'object') return false
    const candidate = entry as Partial<ImageJobOutboxEntry>
    const createdAt = new Date(candidate.createdAt || '').getTime()
    return Boolean(candidate.key && candidate.signature && Number.isFinite(createdAt) && now - createdAt >= 0 && now - createdAt <= MAX_AGE_MS)
  }).slice(0, MAX_ENTRIES)
}

function readEntries(storage: StorageLike | null, storageKey: string, now: number) {
  if (!storage) {
    const entries = validEntries(memoryEntries.get(storageKey), now)
    memoryEntries.set(storageKey, entries)
    return entries
  }
  try {
    const saved = JSON.parse(storage.getItem(storageKey) || 'null') as StoredOutbox | null
    const persisted = validEntries(saved?.entries, now)
    if (persisted.length) return persisted
    if (memoryFallbackKeys.has(storageKey)) {
      const entries = validEntries(memoryEntries.get(storageKey), now)
      memoryEntries.set(storageKey, entries)
      return entries
    }
    return []
  } catch {
    const entries = validEntries(memoryEntries.get(storageKey), now)
    memoryEntries.set(storageKey, entries)
    return entries
  }
}

function writeEntries(storage: StorageLike | null, storageKey: string, entries: ImageJobOutboxEntry[]) {
  const next = entries.slice(0, MAX_ENTRIES)
  memoryEntries.set(storageKey, next)
  if (!storage) {
    memoryFallbackKeys.add(storageKey)
    return
  }
  try {
    storage.setItem(storageKey, JSON.stringify({ entries: next } satisfies StoredOutbox))
    memoryFallbackKeys.delete(storageKey)
  } catch {
    memoryFallbackKeys.add(storageKey)
  }
}

async function sha256(file: FileLike) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function fileMetadata(file: FileLike) {
  return {
    size: file.size,
    type: file.type,
    sha256: await sha256(file),
  }
}

export async function imageJobSignature(request: unknown, files: GenerationFiles = {}) {
  const [referenceImages, maskImage] = await Promise.all([
    Promise.all((files.referenceImages || []).map(fileMetadata)),
    files.maskImage ? fileMetadata(files.maskImage) : Promise.resolve(null),
  ])
  return JSON.stringify({ request: stableValue(request), referenceImages, maskImage })
}

export async function getOrCreateRequestOutbox(storage: StorageLike | null, storageKey: string, request: unknown, files: GenerationFiles = {}, now = Date.now(), createKey = () => crypto.randomUUID()): Promise<ImageJobOutboxEntry> {
  const signature = await imageJobSignature(request, files)
  const entries = readEntries(storage, storageKey, now)
  const saved = entries.find((entry) => entry.signature === signature)
  if (saved) {
    writeEntries(storage, storageKey, [saved, ...entries.filter((entry) => entry.key !== saved.key)])
    return saved
  }
  const entry = { key: createKey(), signature, createdAt: new Date(now).toISOString() }
  writeEntries(storage, storageKey, [entry, ...entries])
  return entry
}

export function clearRequestOutbox(storage: StorageLike | null, storageKey: string, key: string, now = Date.now()) {
  const entries = readEntries(storage, storageKey, now).filter((entry) => entry.key !== key)
  writeEntries(storage, storageKey, entries)
  if (storage) {
    try {
      if (!entries.length) storage.removeItem(storageKey)
    } catch {
      // Persistence is best effort; the confirmed key is already absent from memory state.
    }
  }
}

export function getOrCreateImageJobOutbox(storage: StorageLike | null, request: ImageGenerationRequest, files: GenerationFiles = {}, now = Date.now(), createKey = () => crypto.randomUUID()) {
  return getOrCreateRequestOutbox(storage, IMAGE_OUTBOX_KEY, request, files, now, createKey)
}

export function clearImageJobOutbox(storage: StorageLike | null, key: string, now = Date.now()) {
  clearRequestOutbox(storage, IMAGE_OUTBOX_KEY, key, now)
}
