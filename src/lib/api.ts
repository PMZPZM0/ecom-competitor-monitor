import type { Analysis, AuthSession, CaptureQueueStatus, LarkCliStatus, Overview, Product, RunRecord, Snapshot, UpdateInfo } from '../types/domain'

const baseUrl = import.meta.env.VITE_API_BASE || ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const text = await response.text()
    let message = text
    try {
      const body = JSON.parse(text) as { message?: string; error?: string }
      message = body.message || body.error || message
    } catch {
      // Keep the original response text when it is not JSON.
    }
    throw new Error(message || `请求失败：${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export const api = {
  overview: () => request<Overview>('/api/overview'),
  captureQueue: () => request<CaptureQueueStatus>('/api/capture-queue'),
  clearCaptureQueue: () => request<{ removed: number }>('/api/capture-queue/completed', { method: 'DELETE' }),
  checkUpdate: () => request<UpdateInfo>('/api/runtime/update'),
  addProduct: (payload: { name?: string; url: string; group?: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean }) =>
    request<Product>('/api/products', { method: 'POST', body: JSON.stringify(payload) }),
  addProductsBatch: (payload: { urls: string[]; group: string; accountType: 'normal' | 'gift' | 'vip88'; captureBuyerShows: boolean }) =>
    request<{ total: number; created: number; skipped: number; success: number; failed: number; message: string }>('/api/products/batch', { method: 'POST', body: JSON.stringify(payload) }),
  updateProduct: (id: string, payload: Partial<Product>) =>
    request<Product>(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteProduct: (id: string) => request<void>(`/api/products/${id}`, { method: 'DELETE' }),
  deleteProductsBatch: (ids: string[]) =>
    request<{ requested: number; deleted: number }>('/api/products/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  captureProduct: (id: string) => request<{ product: Product; run: RunRecord }>(`/api/products/${id}/capture`, { method: 'POST' }),
  retryBuyerShows: (id: string) => request<{ ok: boolean; product: Product; capture: NonNullable<Snapshot['buyerShowCapture']> }>(`/api/products/${id}/buyer-shows/retry`, { method: 'POST' }),
  productSnapshots: (id: string) => request<Snapshot[]>(`/api/products/${id}/snapshots?limit=96`),
  openProduct: (id: string) => request<{ ok: boolean; url: string; accountName: string; accountType: 'normal' | 'gift' | 'vip88' }>(`/api/products/${id}/open`, { method: 'POST' }),
  captureProductsBatch: (ids: string[]) => request<{ ok: boolean; run: RunRecord }>('/api/products/batch-capture', { method: 'POST', body: JSON.stringify({ ids }) }),
  updateMonitor: (payload: { intervalMinutes?: number; captureProtectionMinutes?: number; captureProtectionByAccount?: Partial<Record<'normal' | 'gift' | 'vip88', number | null>>; running?: boolean }) =>
    request<Overview['monitor']>('/api/monitor/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  updateFeishuSettings: (payload: { enabled?: boolean; webhookUrl?: string; signingSecret?: string; clearSigningSecret?: boolean; cooldownEnabled?: boolean; cooldownMinutes?: number; documentEnabled?: boolean }) =>
    request<Overview['feishu']>('/api/feishu/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
  testFeishu: () => request<{ ok: boolean }>('/api/feishu/test', { method: 'POST' }),
  syncProductToFeishu: (id: string) => request<{ ok: boolean; partial?: boolean }>(`/api/products/${id}/feishu-sync`, { method: 'POST' }),
  larkCliStatus: () => request<LarkCliStatus>('/api/feishu/cli/status'),
  startLarkCliSetup: () => request<LarkCliStatus['setup']>('/api/feishu/cli/setup', { method: 'POST' }),
  startLarkCliLogin: () => request<LarkCliStatus['login']>('/api/feishu/cli/login', { method: 'POST' }),
  createFeishuDocument: () => request<{ documentId: string; documentUrl: string }>('/api/feishu/document/create', { method: 'POST' }),
  updateModelConfig: (payload: { baseUrl?: string; apiKey?: string; model?: string }) =>
    request<Overview['modelConfig']>('/api/model-config', { method: 'PATCH', body: JSON.stringify(payload) }),
  runAnalysis: () => request<Analysis>('/api/analysis/run', { method: 'POST' }),
  taobaoOAuthUrl: () =>
    request<{ configured: boolean; url?: string; message?: string }>('/api/auth/taobao/oauth-url'),
  startTaobaoScan: (payload: { name: string; accountType: 'normal' | 'gift' | 'vip88' }) =>
    request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>('/api/auth/taobao/scan/start', { method: 'POST', body: JSON.stringify(payload) }),
  taobaoScanStatus: (profileKey: string) =>
    request<{ status: 'waiting' | 'synced' | 'cancelled'; session?: AuthSession }>('/api/auth/taobao/scan/status', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  cancelTaobaoScan: (profileKey: string) =>
    request<{ ok: boolean }>('/api/auth/taobao/scan/cancel', { method: 'POST', body: JSON.stringify({ profileKey }) }),
  addAuthSession: (payload: { name: string; cookie: string; accountType: 'normal' | 'gift' | 'vip88' }) =>
    request<AuthSession>('/api/auth/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  activateAuthSession: (id: string) => request<AuthSession>(`/api/auth/sessions/${id}/activate`, { method: 'POST' }),
  checkAuthSession: (id: string) => request<{ id: string; loginStatus: 'valid' | 'expired' | 'manual'; checkedAt?: string; message: string; session?: AuthSession }>(`/api/auth/sessions/${id}/check`, { method: 'POST' }),
  releaseAuthSessionCooldown: (id: string) => request<AuthSession>(`/api/auth/sessions/${id}/release-cooldown`, { method: 'POST' }),
  checkAllAuthSessions: () => request<{ total: number; valid: number; expired: number; manual: number }>('/api/auth/sessions/check-all', { method: 'POST' }),
  reauthorizeAuthSession: (id: string) => request<{ ok: boolean; url: string; message: string; profileKey: string; port: number }>(`/api/auth/sessions/${id}/reauthorize`, { method: 'POST' }),
  deleteAuthSession: (id: string) => request<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  clearSnapshots: () => request<void>('/api/snapshots', { method: 'DELETE' }),
}
