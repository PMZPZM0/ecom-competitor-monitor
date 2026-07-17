import type { Analysis, AuthSession, CaptureQueueStatus, ImageGenerationRequest, ImageGenerationResponse, ImageLibraryItem, LarkCliStatus, LocalEvidenceStatus, LocalImportCommitResult, LocalImportPreview, ModelConfigPatch, ModelConfigTestResult, Overview, PhotoshopOpenResult, PhotoshopSyncResult, Product, RawDataCaptureResult, RunRecord, Snapshot, UpdateInfo } from '../types/domain'

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
  checkUpdate: () => request<UpdateInfo>('/api/runtime/update'),
  addProduct: (payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) =>
    request<Product>('/api/products', { method: 'POST', body: JSON.stringify(payload) }),
  addProductsBatch: (payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean; captureMediaAssets: boolean }) =>
    request<{ total: number; created: number; skipped: number; success: number; failed: number; message: string; run: RunRecord | null; items: NonNullable<RunRecord['items']> }>('/api/products/batch', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id: string, payload: Partial<Product>) =>
    request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateSkuMonitorPrice: (id: string, skuId: string, value: number | null) =>
    request<Product>(`/api/products/${id}/sku-monitor-price`, { method: 'PATCH', body: JSON.stringify({ skuId, value }) }),
  deleteProduct: (id: string) => request<void>(`/api/products/${id}`, { method: 'DELETE' }),
  deleteProductsBatch: (ids: string[]) =>
    request<{ requested: number; deleted: number }>('/api/products/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  captureProduct: (id: string) => request<{ product: Product; run: RunRecord }>(`/api/products/${id}/capture`, { method: 'POST' }),
  retryBuyerShows: (id: string) => request<{ ok: boolean; product: Product; capture: NonNullable<Snapshot['buyerShowCapture']> }>(`/api/products/${id}/buyer-shows/retry`, { method: 'POST' }),
  productSnapshots: (id: string) => request<Snapshot[]>(`/api/products/${id}/snapshots?limit=96`),
  openProduct: (id: string, sessionId?: string) => request<{ ok: boolean; url: string; accountName: string; accountType: 'normal' | 'gift' | 'vip88' }>(`/api/products/${id}/open`, { method: 'POST', body: JSON.stringify({ sessionId }) }),
  captureProductsBatch: (ids: string[]) => request<{ ok: boolean; run: RunRecord }>('/api/products/batch-capture', { method: 'POST', body: JSON.stringify({ ids }) }),
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
  testModelConfig: (payload: Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'imageModel' | 'apiKey'>) =>
    request<ModelConfigTestResult>('/api/model-config/test', { method: 'POST', body: JSON.stringify(payload) }),
  generateImages: (payload: ImageGenerationRequest, files: { referenceImages?: File[]; maskImage?: Blob } = {}, signal?: AbortSignal) => {
    const body = new FormData()
    body.append('request', JSON.stringify(payload))
    files.referenceImages?.forEach((file) => body.append('referenceImages', file, file.name))
    if (files.maskImage) body.append('maskImage', files.maskImage, 'edit-mask.png')
    return request<ImageGenerationResponse>('/api/images/generate', { method: 'POST', body, signal })
  },
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
  runAnalysis: () => request<Analysis>('/api/analysis/run', { method: 'POST' }),
  taobaoOAuthUrl: () =>
    request<{ configured: boolean; url?: string; message?: string }>('/api/auth/taobao/oauth-url'),
  startTaobaoScan: (payload: { name: string; accountType: 'normal' | 'gift' | 'vip88' }) =>
    request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>('/api/auth/taobao/scan/start', { method: 'POST', body: JSON.stringify(payload) }),
  taobaoScanStatus: (profileKey: string) =>
    request<{ status: 'waiting' | 'synced' | 'cancelled'; session?: AuthSession }>('/api/auth/taobao/scan/status', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  cancelTaobaoScan: (profileKey: string) =>
    request<{ ok: boolean }>('/api/auth/taobao/scan/cancel', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  activateAuthSession: (id: string) => request<AuthSession>(`/api/auth/sessions/${id}/activate`, { method: 'POST' }),
  checkAuthSession: (id: string) => request<{ id: string; status?: 'valid' | 'degraded' | 'expired'; loginStatus: 'valid' | 'expired' | 'manual'; checkedAt?: string; message: string; session?: AuthSession }>(`/api/auth/sessions/${id}/check`, { method: 'POST' }),
  checkAllAuthSessions: () => request<{ total: number; valid: number; degraded: number; expired: number; manual: number }>('/api/auth/sessions/check-all', { method: 'POST' }),
  reauthorizeAuthSession: (id: string) => request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>(`/api/auth/sessions/${id}/reauthorize`, { method: 'POST' }),
  deleteAuthSession: (id: string) => request<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  clearSnapshots: () => request<void>('/api/snapshots', { method: 'DELETE' }),
}
