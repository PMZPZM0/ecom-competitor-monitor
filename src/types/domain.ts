export type Product = {
  id: string
  name: string
  shopName?: string
  shopLogo?: string
  model?: string
  itemId?: string
  autoGroup?: string
  url: string
  group: string
  accountType?: 'normal' | 'gift' | 'vip88'
  /** Per-product scheduled capture interval. Omit to use the global default. */
  monitorIntervalMinutes?: number | null
  /** User-selected local date/time anchor, persisted as an ISO timestamp. */
  monitorStartAt?: string | null
  nextMonitorAt?: string | null
  monitorPrice?: number | null
  skuMonitorPrices?: Record<string, number>
  enabled: boolean
  mainImage?: string
  lastStatus: 'pending' | 'ok' | 'error'
  lastError?: string
  lastSnapshot?: Snapshot
  createdAt: string
  updatedAt: string
}

export type Snapshot = {
  id: string
  productId: string
  capturedAt: string
  title: string
  shopName?: string
  shopLogo?: string
  model?: string
  itemId?: string
  autoGroup?: string
  mainImage: string
  mainImage800?: string
  gallery750Images?: string[]
  mainImages: string[]
  detailImages?: string[]
  videoUrls?: string[]
  buyerShows?: BuyerShowItem[]
  skuImages: string[]
  skuPrices: Array<{
    skuId: string
    name: string
    image?: string
    price: number
    normalPrice?: number
    surprisePrice?: number | null
    surpriseStatus?: 'available' | 'none'
    surpriseDiscountAmount?: number | null
    giftPrice?: number | null
    giftStatus?: 'available' | 'none'
    giftDiscountAmount?: number | null
    vipPrice?: number | null
    vipStatus?: 'available' | 'none'
    vipDiscountAmount?: number | null
    coinPrice?: number | null
    coinStatus?: 'available' | 'none'
    coinDiscountAmount?: number | null
    priceCalculation?: {
      normal: string
      surprise: string
      gift?: string
      vip88?: string
      coin: string
    }
    originalPrice?: number
    priceTitle?: string
    priceLayers?: Array<{
      label: string
      value: number
      kind?: 'price' | 'discount' | 'original'
      source?: string
    }>
    discountItems?: Array<{
      label: string
      amount?: number | null
      threshold?: number | null
      text: string
      type?: 'reduction' | 'coupon' | 'subsidy' | 'credit' | 'member' | 'promotion'
      source?: string
    }>
    quantity?: number
    quantityText?: string
    quantitySource?: 'buyer-page'
    accountPrices?: Array<{
      sessionId: string
      accountName: string
      accountType: 'normal' | 'gift' | 'vip88'
      price: number
      normalPrice?: number
      surprisePrice?: number | null
      giftPrice?: number | null
      giftDiscountAmount?: number | null
      vipPrice?: number | null
      vipDiscountAmount?: number | null
      coinPrice?: number | null
      originalPrice?: number
      priceCalculation?: {
        normal: string
        surprise: string
        gift?: string
        vip88?: string
        coin: string
      }
      priceLayers?: Array<{
        label: string
        value: number
        kind?: 'price' | 'discount' | 'original'
        source?: string
      }>
      discountItems?: Array<{
        label: string
        amount?: number | null
        threshold?: number | null
        text: string
        type?: 'reduction' | 'coupon' | 'subsidy' | 'credit' | 'member' | 'promotion'
        source?: string
      }>
    }>
  }>
  price: number | null
  priceRange: [number, number] | null
  source?: 'fetch' | 'browser'
  accessMode?: 'authenticated' | 'anonymous'
  rawSignals: {
    htmlBytes: number
    imageCount: number
    skuImageCount: number
    priceCount: number
    highResImageCount?: number
    videoCount?: number
    buyerShowCount?: number
    detailImageCount?: number
  }
}

export type BuyerShowItem = {
  id: string
  text?: string
  images: string[]
  videoUrls: string[]
  author?: string
  sku?: string
  createdAt?: string
}

export type AuthSession = {
  id: string
  name: string
  cookie: string
  source?: 'manual-cookie' | 'taobao-browser'
  accountType?: 'normal' | 'gift' | 'vip88'
  browserProfileKey?: string
  browserPort?: number
  active: boolean
  enabled?: boolean
  healthStatus?: 'healthy' | 'degraded' | 'cooldown'
  lastUsedAt?: string | null
  lastSuccessAt?: string | null
  lastFailureAt?: string | null
  consecutiveFailures?: number
  cooldownUntil?: string | null
  loginStatus?: 'valid' | 'expired'
  lastCheckedAt?: string | null
  createdAt: string
}

export type Analysis = {
  id: string
  mode: 'ai' | 'rule-based'
  summary: string
  insights: string[]
  actions?: string[]
  createdAt: string
}

export type RunRecord = {
  id: string
  source: 'manual-all' | 'manual-batch' | 'manual-product' | 'single-product' | 'scheduled'
  scope: string
  status: 'success' | 'partial' | 'failed'
  startedAt: string
  finishedAt: string
  total: number
  success: number
  failed: number
  message: string
}

export type Overview = {
  products: Product[]
  snapshots: Snapshot[]
  analyses: Analysis[]
  authSessions: AuthSession[]
  runs: RunRecord[]
  modelConfig: {
    baseUrl: string
    apiKey: string
    model: string
    hasApiKey: boolean
  }
  monitor: {
    intervalMinutes: number
    captureProtectionMinutes: number
    captureProtectionByAccount: Partial<Record<'normal' | 'gift' | 'vip88', number | null>>
    running: boolean
    lastRunAt: string | null
    nextRunAt: string | null
  }
  feishu: {
    enabled: boolean
    webhookConfigured: boolean
    webhookUrlMasked: string
    signingSecretConfigured: boolean
    cooldownEnabled: boolean
    cooldownMinutes: number
    lastTestedAt: string | null
    documentEnabled: boolean
    documentConfigured: boolean
    documentUrl: string
    lastDocumentSyncAt: string | null
  }
  notificationLogs: Array<{
    id: string
    productId: string
    skuId?: string
    type: 'below-threshold' | 'manual-sync' | 'test' | 'document-sync'
    status: 'sent' | 'failed' | 'suppressed'
    message: string
    price: number | null
    threshold: number | null
    source: string
    createdAt: string
  }>
}

export type LarkCliStatus = {
  installed: boolean
  version: string
  configured: boolean
  authenticated: boolean
  botReady?: boolean
  userStatus?: string
  userMessage?: string
  message?: string
  setup: { status: 'idle' | 'running' | 'completed' | 'failed'; url: string; message: string; startedAt: string | null }
  login: { status: 'idle' | 'waiting' | 'completed' | 'failed'; url: string; message: string; startedAt: string | null }
}
