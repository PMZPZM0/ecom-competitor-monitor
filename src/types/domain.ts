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
  /** Exactly one automatic schedule mode is active for a product. Legacy data defaults to interval. */
  monitorScheduleMode?: 'once' | 'interval'
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

export type PriceResolutionStatus = 'verified' | 'partial' | 'ambiguous' | 'unavailable' | 'legacy'

export type PriceChannelResolution = {
  status: 'verified' | 'ambiguous' | 'unavailable' | 'stale'
  valueCents: number | null
  formula?: string
  reason?: string
  evidenceIds: string[]
}

export type PriceResolution = {
  status: PriceResolutionStatus
  reason?: string
  parserVersion?: string
  evidenceHash?: string
  channels?: Partial<Record<'normal' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin', PriceChannelResolution>>
}

export type PriceEvidence = {
  id: string
  itemId: string
  skuId: string
  accountType: 'normal' | 'gift' | 'vip88'
  kind: 'list' | 'normal' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin'
  valueCents: number
  source: 'api-explicit' | 'api-formula' | 'selected-dom'
  endpoint: string
  sourcePath: string
  promotionCodes: string[]
  selectedSkuVerified: boolean
  capturedAt: string
  formula?: string
}

export type BuyerShowCapture = {
  status: 'complete' | 'partial' | 'confirmed-empty' | 'failed'
  source: 'observed-network' | 'legacy-rate-api' | 'verified-dom' | 'cache'
  failureCode?: string
  itemId: string
  sellerId?: string
  accountSessionId?: string
  reportedTotal: number
  pageCount: number
  requestCount: number
  items: BuyerShowItem[]
  mediaCount: number
  textOnlyCount: number
  capturedAt: string
  lastSuccessfulAt?: string
  attempts?: Array<{
    source: BuyerShowCapture['source']
    status: BuyerShowCapture['status']
    failureCode?: string
    requestCount: number
    itemCount: number
    mediaCount: number
  }>
}

export type Snapshot = {
  id: string
  productId: string
  capturedAt: string
  parserVersion?: string
  resolutionStatus?: PriceResolutionStatus
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
  buyerShowCapture?: BuyerShowCapture
  buyerShowCachedItems?: BuyerShowItem[]
  skuImages: string[]
  skuPrices: Array<{
    skuId: string
    name: string
    image?: string
    price: number
    normalPrice?: number
    governmentPrice?: number | null
    governmentStatus?: 'available' | 'none'
    governmentDiscountAmount?: number | null
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
      government?: string
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
    parserVersion?: string
    resolutionStatus?: PriceResolutionStatus
    priceResolution?: PriceResolution
    priceEvidence?: PriceEvidence[]
    accountPrices?: Array<{
      sessionId: string
      accountName: string
      accountType: 'normal' | 'gift' | 'vip88'
      price: number
      resolutionStatus?: PriceResolutionStatus
      priceResolution?: PriceResolution
      normalPrice?: number
      governmentPrice?: number | null
      surprisePrice?: number | null
      giftPrice?: number | null
      giftDiscountAmount?: number | null
      vipPrice?: number | null
      vipDiscountAmount?: number | null
      coinPrice?: number | null
      originalPrice?: number
      priceCalculation?: {
        normal: string
        government?: string
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
  runtime: {
    version: string
    buildCommit: string
    scraperVersion: string
    startedAt: string
    processId: number
    mode: 'desktop' | 'development'
    dataDir: string
    dbPath: string
    schemaVersion: number
    profileDir: string
    captureBrowserIdleMs: number
  }
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

export type UpdateInfo = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseName: string
  notes: string
  publishedAt: string | null
  releaseUrl: string
  downloadUrl: string
  acceleratedDownloadUrl: string
  assetName: string
  assetSize: number
  assetDigest: string
  platform: string
  arch: string
  checkedAt: string
}
