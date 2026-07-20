const DATABASE_NAME = 'ecommerce-monitor-appearance'
const DATABASE_VERSION = 1
const STORE_NAME = 'wallpapers'
const CUSTOM_WALLPAPER_KEY = 'custom'

const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const MAX_OUTPUT_WIDTH = 2048
const MAX_OUTPUT_HEIGHT = 1152
const TARGET_RATIO = 16 / 9

export type StoredCustomWallpaper = {
  id: typeof CUSTOM_WALLPAPER_KEY
  blob: Blob
  fileName: string
  width: number
  height: number
  updatedAt: number
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地壁纸存储。'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地壁纸存储失败。'))
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('本地壁纸存储失败。'))
    }
  })
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('图片无法读取，请换一张 PNG、JPG 或 WebP。'))
    }
    image.src = objectUrl
  })
}

function canvasToWebp(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('壁纸处理失败，请换一张图片重试。'))
    }, 'image/webp', 0.86)
  })
}

export async function normalizeCustomWallpaper(file: File): Promise<StoredCustomWallpaper> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('仅支持 PNG、JPG 和 WebP 图片。')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('原图不能超过 12 MB。')

  const image = await loadImage(file)
  const sourceRatio = image.naturalWidth / image.naturalHeight
  const sourceWidth = sourceRatio > TARGET_RATIO ? image.naturalHeight * TARGET_RATIO : image.naturalWidth
  const sourceHeight = sourceRatio > TARGET_RATIO ? image.naturalHeight : image.naturalWidth / TARGET_RATIO
  const sourceX = (image.naturalWidth - sourceWidth) / 2
  const sourceY = (image.naturalHeight - sourceHeight) / 2
  const scale = Math.min(1, MAX_OUTPUT_WIDTH / sourceWidth, MAX_OUTPUT_HEIGHT / sourceHeight)
  const width = Math.max(16, Math.round(sourceWidth * scale))
  const height = Math.max(9, Math.round(width / TARGET_RATIO))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('当前设备无法处理壁纸图片。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height)

  return {
    id: CUSTOM_WALLPAPER_KEY,
    blob: await canvasToWebp(canvas),
    fileName: file.name,
    width,
    height,
    updatedAt: Date.now(),
  }
}

export function loadCustomWallpaper() {
  return withStore<StoredCustomWallpaper | undefined>('readonly', (store) => store.get(CUSTOM_WALLPAPER_KEY))
    .then((record) => record ?? null)
}

export function saveCustomWallpaper(wallpaper: StoredCustomWallpaper) {
  return withStore<IDBValidKey>('readwrite', (store) => store.put(wallpaper))
}

export function deleteCustomWallpaper() {
  return withStore<undefined>('readwrite', (store) => store.delete(CUSTOM_WALLPAPER_KEY))
}
