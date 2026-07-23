import type { Analysis, AuthSession, BrowserEngineCatalog, BrowserEngineId, CaptureQueueStatus, ExcelSyncResult, ExcelSyncStatus, ImageGenerationJob, ImageGenerationRequest, ImageGenerationResponse, ImageLibraryItem, LarkCliStatus, LocalEvidenceStatus, LocalImportCommitResult, LocalImportPreview, ModelCatalog, ModelCatalogRequest, ModelConfigPatch, ModelConfigTestPayload, ModelConfigTestResult, MonitorChannel, Overview, PhotoshopOpenResult, PhotoshopSyncResult, Product, RawDataCaptureResult, RunRecord, Snapshot, UpdateInfo } from '../types/domain'
import type { ProductRecognitionResult, PromptEnhancementResult, PromptGenerationRequest, PromptGenerationResult, PromptHistoryItem, PromptProductProfile, PromptReferenceFiles, PromptStudioWorkspace, PromptStylePreset, QuickPromptGenerationResult, QuickPromptRequest } from '../features/prompt-studio/types'

const baseUrl = import.meta.env.VITE_API_BASE || ''

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const formDataBody = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(formDataBody ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const text = await response.text()
    let message = text
    let code = ''
    try {
      const body = JSON.parse(text) as { message?: string; error?: string | { code?: string; message?: string } }
      message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || message
      code = typeof body.error === 'object' ? body.error?.code || '' : ''
    } catch {
      // Keep the original response text when it is not JSON.
    }
    throw new ApiError(message || `请求失败：${response.status}`, response.status, code)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export const api = {
  overview: () => request<Overview>('/api/overview'),
  captureQueue: () => request<CaptureQueueStatus>('/api/capture-queue'),
  clearCaptureQueue: () => request<{ removed: number }>('/api/capture-queue/completed', { method: 'DELETE' }),
  clearFailedCaptureQueue: () => request<{ removed: number }>('/api/capture-queue/failed', { method: 'DELETE' }),
  deleteCaptureJob: (id: string) => request<void>(`/api/capture-queue/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  resumeCaptureJob: (id: string) => request<CaptureQueueStatus['jobs'][number]>(`/api/capture-queue/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  checkUpdate: () => request<UpdateInfo>('/api/runtime/update'),
  addProduct: (payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) =>
    request<Product>('/api/products', { method: 'POST', body: JSON.stringify(payload) }),
  addProductsBatch: (payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) =>
    request<{ total: number; created: number; skipped: number; success: number; failed: number; message: string; run: RunRecord | null; items: NonNullable<RunRecord['items']> }>('/api/products/batch', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id: string, payload: Partial<Product>) =>
    request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateSkuMonitorPrice: (id: string, skuId: string, value: number | null, channel: MonitorChannel = 'lowest') =>
    request<Product>(`/api/products/${id}/sku-monitor-price`, { method: 'PATCH', body: JSON.stringify({ skuId, value, channel }) }),
  deleteProduct: (id: string) => request<void>(`/api/products/${id}`, { method: 'DELETE' }),
  deleteProductsBatch: (ids: string[]) =>
    request<{ requested: number; deleted: number }>('/api/products/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  captureProduct: (id: string, captureKind: 'price' | 'buyer-show' | 'materials' = 'price', rollbackUninitialized = false) => request<{ product: Product; run: RunRecord }>(`/api/products/${id}/capture`, { method: 'POST', body: JSON.stringify({ captureKind, rollbackUninitialized }) }),
  captureAllAccountViews: (id: string) => request<{ product: Product; run: RunRecord }>(`/api/products/${id}/capture-all-accounts`, { method: 'POST' }),
  retryBuyerShows: (id: string) => request<{ ok: boolean; product: Product; capture: NonNullable<Snapshot['buyerShowCapture']> }>(`/api/products/${id}/buyer-shows/retry`, { method: 'POST' }),
  captureSearchMainImage: (id: string, force = false) => request<{ ok: boolean; status: NonNullable<Product['searchMainImageStatus']>; product: Product; message: string; cached?: boolean }>(`/api/products/${id}/search-main-image`, { method: 'POST', body: JSON.stringify({ force }) }),
  reparseProductLocalEvidence: (id: string, kind: 'price' | 'materials' | 'buyer-show' | 'search-main-image') => request<{ ok: boolean; kind: string; product: Product; message: string }>(`/api/products/${id}/reparse-local-evidence`, { method: 'POST', body: JSON.stringify({ kind }) }),
  productSnapshots: (id: string) => request<Snapshot[]>(`/api/products/${id}/snapshots?limit=96`),
  openProduct: (id: string, sessionId?: string) => request<{ ok: boolean; url: string; accountName: string; accountType: 'normal' | 'gift' | 'vip88' }>(`/api/products/${id}/open`, { method: 'POST', body: JSON.stringify({ sessionId }) }),
  captureProductsBatch: (ids: string[], captureKind: 'price' | 'buyer-show' | 'materials' = 'price') => request<{ ok: boolean; run: RunRecord }>('/api/products/batch-capture', { method: 'POST', body: JSON.stringify({ ids, captureKind }) }),
  updateMonitor: (payload: { intervalMinutes?: number; running?: boolean }) =>
    request<Overview['monitor']>('/api/monitor/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  updateFeishuSettings: (payload: { enabled?: boolean; webhookUrl?: string; signingSecret?: string; clearSigningSecret?: boolean; documentEnabled?: boolean }) =>
    request<Overview['feishu']>('/api/feishu/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  testFeishu: () => request<{ ok: boolean }>('/api/feishu/test', { method: 'POST' }),
  syncProductToFeishu: (id: string) => request<{ ok: boolean; partial?: boolean }>(`/api/products/${id}/feishu-sync`, { method: 'POST' }),
  larkCliStatus: () => request<LarkCliStatus>('/api/feishu/cli/status'),
  startLarkCliSetup: () => request<LarkCliStatus['setup']>('/api/feishu/cli/setup', { method: 'POST' }),
  startLarkCliLogin: () => request<LarkCliStatus['login']>('/api/feishu/cli/login', { method: 'POST' }),
  createFeishuDocument: () => request<{ documentId: string; documentUrl: string }>('/api/feishu/document/create', { method: 'POST' }),
  updateModelConfig: (payload: ModelConfigPatch) =>
    request<Overview['modelConfig']>('/api/model-config', { method: 'PATCH', body: JSON.stringify(payload) }),
  modelCatalog: (payload: ModelCatalogRequest) =>
    request<ModelCatalog>('/api/model-config/models', { method: 'POST', body: JSON.stringify(payload) }),
  testModelConfig: (payload: ModelConfigTestPayload) =>
    request<ModelConfigTestResult>('/api/model-config/test', { method: 'POST', body: JSON.stringify(payload) }),
  promptStudio: () => request<PromptStudioWorkspace>('/api/prompt-studio'),
  analyzePromptProduct: (files: PromptReferenceFiles, existingFacts: PromptGenerationRequest['productFacts']) => {
    const body = new FormData()
    body.append('request', JSON.stringify({ existingFacts }))
    files.productReferenceFiles.forEach((file) => body.append('productImages', file, file.name))
    files.styleReferenceFiles.forEach((file) => body.append('styleImages', file, file.name))
    return request<ProductRecognitionResult>('/api/prompt-studio/analyze-product', { method: 'POST', body })
  },
  generatePromptSet: (payload: PromptGenerationRequest, files: PromptReferenceFiles) => {
    const body = new FormData()
    body.append('request', JSON.stringify(payload))
    files.productReferenceFiles.forEach((file) => body.append('productImages', file, file.name))
    files.styleReferenceFiles.forEach((file) => body.append('styleImages', file, file.name))
    return request<PromptGenerationResult>('/api/prompt-studio/generate', { method: 'POST', body })
  },
  quickGeneratePrompt: (payload: QuickPromptRequest, files: PromptReferenceFiles) => {
    const body = new FormData()
    body.append('request', JSON.stringify(payload))
    files.productReferenceFiles.forEach((file) => body.append('productImages', file, file.name))
    return request<QuickPromptGenerationResult>('/api/prompt-studio/quick-generate', { method: 'POST', body })
  },
  enhanceImagePrompt: (payload: QuickPromptRequest, files: PromptReferenceFiles) => {
    const body = new FormData()
    body.append('request', JSON.stringify(payload))
    files.productReferenceFiles.forEach((file) => body.append('productImages', file, file.name))
    return request<PromptEnhancementResult>('/api/prompt-studio/enhance', { method: 'POST', body })
  },
  createPromptProductProfile: (payload: Omit<PromptProductProfile, 'id' | 'updatedAt'>) =>
    request<PromptProductProfile>('/api/prompt-studio/product-profiles', { method: 'POST', body: JSON.stringify(payload) }),
  updatePromptProductProfile: (id: string, payload: Partial<Omit<PromptProductProfile, 'id' | 'updatedAt'>>) =>
    request<PromptProductProfile>(`/api/prompt-studio/product-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deletePromptProductProfile: (id: string) => request<void>(`/api/prompt-studio/product-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createPromptStylePreset: (payload: Omit<PromptStylePreset, 'id' | 'updatedAt'>) =>
    request<PromptStylePreset>('/api/prompt-studio/style-presets', { method: 'POST', body: JSON.stringify(payload) }),
  updatePromptStylePreset: (id: string, payload: Partial<Omit<PromptStylePreset, 'id' | 'updatedAt'>>) =>
    request<PromptStylePreset>(`/api/prompt-studio/style-presets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deletePromptStylePreset: (id: string) => request<void>(`/api/prompt-studio/style-presets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updatePromptHistory: (id: string, payload: { name?: string; isFavorite?: boolean; selectedVariantKey?: 'safe' | 'commercial' | 'creative' }) =>
    request<PromptHistoryItem>(`/api/prompt-studio/history/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  togglePromptLibraryFavorite: (templateId: string, favorite: boolean) =>
    request<{ libraryFavorites: string[] }>(`/api/prompt-studio/library-favorites/${encodeURIComponent(templateId)}`, { method: 'PATCH', body: JSON.stringify({ favorite }) }),
  deletePromptHistory: (id: string) => request<void>(`/api/prompt-studio/history/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateImages: (payload: ImageGenerationRequest, files: { referenceImages?: File[]; maskImage?: Blob } = {}, signal?: AbortSignal) => {
    const body = new FormData()
    body.append('request', JSON.stringify(payload))
    files.referenceImages?.forEach((file) => body.append('referenceImages', file, file.name))
    if (files.maskImage) body.append('maskImage', files.maskImage, 'edit-mask.png')
    return request<ImageGenerationResponse>('/api/images/generate', { method: 'POST', body, signal })
  },
  createImageJob: (payload: ImageGenerationRequest, files: { referenceImages?: File[]; maskImage?: Blob } = {}, clientRequestId?: string) => {
    const body = new FormData()
    body.append('request', JSON.stringify(clientRequestId ? { ...payload, clientRequestId } : payload))
    files.referenceImages?.forEach((file) => body.append('referenceImages', file, file.name))
    if (files.maskImage) body.append('maskImage', files.maskImage, 'edit-mask.png')
    return request<ImageGenerationJob>('/api/image-jobs', { method: 'POST', body })
  },
  imageJobs: () => request<ImageGenerationJob[]>('/api/image-jobs'),
  clearImageJobs: () => request<{ removed: number; retainedActive: number }>('/api/image-jobs', { method: 'DELETE' }),
  imageJob: (id: string) => request<ImageGenerationJob>(`/api/image-jobs/${encodeURIComponent(id)}`),
  retryImageJob: (id: string) => request<ImageGenerationJob>(`/api/image-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  cancelImageJob: (id: string) => request<ImageGenerationJob>(`/api/image-jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  images: () => request<ImageLibraryItem[]>('/api/images'),
  imageFileUrl: (id: string, thumbnail = false) => `${baseUrl}/api/images/${encodeURIComponent(id)}/file${thumbnail ? '?thumbnail=1' : ''}`,
  updateImage: (id: string, payload: { isFavorite?: boolean; isArchived?: boolean }) =>
    request<ImageLibraryItem>(`/api/images/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteImage: (id: string) => request<void>(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  openImageInPhotoshop: (id: string) =>
    request<PhotoshopOpenResult>(`/api/images/${encodeURIComponent(id)}/photoshop/open`, { method: 'POST', body: '{}' }),
  syncImageFromPhotoshop: (id: string) =>
    request<PhotoshopSyncResult>(`/api/images/${encodeURIComponent(id)}/photoshop/sync`, { method: 'POST', body: '{}' }),
  previewLocalImport: (payload: { content: string; accountType: 'normal' | 'gift' | 'vip88'; itemIdHint?: string }) => {
    const query = new URLSearchParams({ accountType: payload.accountType })
    if (payload.itemIdHint) query.set('itemIdHint', payload.itemIdHint)
    return request<LocalImportPreview>(`/api/local-imports/preview?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: payload.content,
    })
  },
  commitLocalImport: (importId: string) =>
    request<LocalImportCommitResult>(`/api/local-imports/${encodeURIComponent(importId)}/commit`, { method: 'POST', body: '{}' }),
  captureRawData: (payload: { sessionId: string; itemId: string; platform: 'tmall' | 'taobao' }) =>
    request<RawDataCaptureResult>('/api/raw-data/capture', { method: 'POST', body: JSON.stringify(payload) }),
  localEvidence: () => request<LocalEvidenceStatus>('/api/local-evidence'),
  selectLocalEvidenceDirectory: () =>
    request<{ directory: string | null }>('/api/local-evidence/select-directory', { method: 'POST', body: '{}' }),
  openLocalEvidenceDirectory: () =>
    request<{ ok: true; directory: string }>('/api/local-evidence/open-directory', { method: 'POST', body: '{}' }),
  updateLocalEvidenceSettings: (directory: string | null) =>
    request<LocalEvidenceStatus>('/api/local-evidence', { method: 'PATCH', body: JSON.stringify({ directory }) }),
  deleteLocalEvidence: () => request<LocalEvidenceStatus>('/api/local-evidence', { method: 'DELETE' }),
  excelSyncStatus: () => request<ExcelSyncStatus>('/api/excel-sync'),
  syncExcelWorkbook: () => request<ExcelSyncResult>('/api/excel-sync/run', { method: 'POST', body: '{}' }),
  openExcelWorkbook: () => request<{ ok: true; path: string }>('/api/excel-sync/open', { method: 'POST', body: '{}' }),
  runAnalysis: () => request<Analysis>('/api/analysis/run', { method: 'POST' }),
  taobaoOAuthUrl: () =>
    request<{ configured: boolean; url?: string; message?: string }>('/api/auth/taobao/oauth-url'),
  browserEngines: () => request<BrowserEngineCatalog>('/api/auth/browser-engines'),
  installBrowserEngine: (engine: BrowserEngineId) => request<{ ok: true; engine: { id: BrowserEngineId; name: string; downloadUrl: string } }>(`/api/auth/browser-engines/${engine}/install`, { method: 'POST', body: '{}' }),
  startTaobaoScan: (payload: { name: string; accountType: 'normal' | 'gift' | 'vip88'; browserEngine: BrowserEngineId }) =>
    request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>('/api/auth/taobao/scan/start', { method: 'POST', body: JSON.stringify(payload) }),
  taobaoScanStatus: (profileKey: string) =>
    request<{ status: 'waiting' | 'synced' | 'cancelled'; session?: AuthSession }>('/api/auth/taobao/scan/status', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  cancelTaobaoScan: (profileKey: string) =>
    request<{ ok: boolean }>('/api/auth/taobao/scan/cancel', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  activateAuthSession: (id: string) => request<AuthSession>(`/api/auth/sessions/${id}/activate`, { method: 'POST' }),
  checkAuthSession: (id: string) => request<{ id: string; status?: 'valid' | 'degraded' | 'expired'; loginStatus: 'valid' | 'expired' | 'manual'; checkedAt?: string; message: string; session?: AuthSession }>(`/api/auth/sessions/${id}/check`, { method: 'POST' }),
  checkAllAuthSessions: () => request<{ total: number; valid: number; identityOnline: number; priceUsable: number; priceUnavailable: number; degraded: number; expired: number; manual: number }>('/api/auth/sessions/check-all', { method: 'POST' }),
  reauthorizeAuthSession: (id: string, browserEngine: BrowserEngineId) => request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>(`/api/auth/sessions/${id}/reauthorize`, { method: 'POST', body: JSON.stringify({ browserEngine }) }),
  importAuthLoginBundle: (file: File, browserEngine: BrowserEngineId) => {
    const body = new FormData()
    body.append('bundle', file)
    body.append('browserEngine', browserEngine)
    return request<{ session: AuthSession; message: string }>('/api/auth/login-bundles/import', { method: 'POST', body })
  },
  deleteAuthSession: (id: string) => request<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  clearSnapshots: () => request<void>('/api/snapshots', { method: 'DELETE' }),
}
