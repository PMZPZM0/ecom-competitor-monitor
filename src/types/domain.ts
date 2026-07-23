export type MonitorChannel = 'lowest' | 'normal' | 'billion' | 'seckill' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin'
export type SkuMonitorRules = Record<string, Partial<Record<MonitorChannel, number>>>
export type ProductCaptureOptions = {
  accountMode?: 'primary' | 'all'
  captureKind?: 'price' | 'buyer-show' | 'materials'
}

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
  captureMode?: 'browser' | 'local-only'
  primaryAccountSessionId?: string
  captureBuyerShows?: boolean
  captureMediaAssets?: boolean
  /** Exactly one automatic schedule mode is active for a product. Legacy data defaults to interval. */
  monitorScheduleMode?: 'once' | 'interval'
  /** Per-product scheduled capture interval. Omit to use the global default. */
  monitorIntervalMinutes?: number | null
  /** User-selected local date/time anchor, persisted as an ISO timestamp. */
  monitorStartAt?: string | null
  nextMonitorAt?: string | null
  monitorPrice?: number | null
  skuMonitorPrices?: Record<string, number>
  skuMonitorRules?: SkuMonitorRules
  skuLifecycle?: Record<string, {
    skuId: string
    name: string
    image?: string
    status: 'active' | 'archived'
    firstSeenAt: string
    lastSeenAt: string
    archivedAt?: string | null
  }>
  enabled: boolean
  mainImage?: string
  searchMainImage?: string
  searchMainImageStatus?: 'verified' | 'unavailable' | 'failed'
  searchMainImageSource?: 'taobao-search-exact-item-card' | ''
  searchMainImageCapturedAt?: string
  searchMainImageEvidenceId?: string
  searchMainImageEvidenceFile?: string
  searchMainImageLocalFirst?: {
    sourceSaved: boolean
    sourceSanitized: boolean
    parsedFromDisk: boolean
    networkAccessedAfterCapture: boolean
  }
  searchMainImageError?: string
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
  label?: string
  formula?: string
  reason?: string
  evidenceIds: string[]
}

export type PriceResolution = {
  status: PriceResolutionStatus
  reason?: string
  campaignKind?: 'billion' | 'seckill' | null
  normalLabel?: string
  parserVersion?: string
  evidenceHash?: string
  displayedCents?: number
  promotions?: Array<{
    code: string
    amountCents: number
    kind: string
    label: string
  }>
  evidence?: PriceEvidence[]
  formulaInputs?: {
    promotions?: Array<{
      code: string
      amountCents: number
      kind: string
      label: string
    }>
  }
  channels?: Partial<Record<'normal' | 'billion' | 'seckill' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin', PriceChannelResolution>>
}

export type PriceEvidence = {
  id: string
  itemId: string
  skuId: string
  accountType: 'normal' | 'gift' | 'vip88'
  kind: 'list' | 'normal' | 'billion' | 'seckill' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin'
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
  status: 'complete' | 'partial' | 'confirmed-empty' | 'failed' | 'skipped'
  source: 'observed-network' | 'legacy-rate-api' | 'verified-dom' | 'cache' | 'disabled'
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
  browserEvidenceId?: string
  browserEvidenceFile?: string
  materialEvidenceId?: string
  materialEvidenceFile?: string
  materialCapturedAt?: string
  buyerShowEvidenceId?: string
  buyerShowEvidenceFile?: string
  buyerShowLocalFirst?: {
    sourceSaved: boolean
    sourceSanitized: boolean
    parsedFromDisk: boolean
    networkAccessedAfterCapture: boolean
  }
  localFirst?: {
    sourceSaved: boolean
    sourceSanitized: boolean
    parsedFromDisk: boolean
    networkAccessedAfterCapture: boolean
  }
  localImportId?: string
  localImportFile?: string
  localImportError?: string
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
  primaryAccountSessionId?: string
  primaryAccountType?: 'normal' | 'gift' | 'vip88'
  accountCaptures?: Array<{
    sessionId: string
    accountName: string
    accountType: 'normal' | 'gift' | 'vip88'
    primary: boolean
    capturedAt: string
    price?: number | null
    priceRange?: [number, number] | null
    resolutionStatus?: PriceResolutionStatus
    skuCount: number
    verifiedSkuCount: number
  }>
  accountErrors?: Array<{
    sessionId: string
    accountName: string
    attempt: number
    message: string
  }>
  skuImages: string[]
  skuPrices: Array<{
    skuId: string
    name: string
    image?: string
    price: number
    normalPrice?: number
    billionPrice?: number | null
    billionStatus?: 'available' | 'none'
    seckillPrice?: number | null
    seckillStatus?: 'available' | 'none'
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
      billion?: string
      seckill?: string
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
    stalePrices?: Partial<Record<Exclude<MonitorChannel, 'lowest'>, {
      value: number
      verifiedAt: string | null
      evidenceIds: string[]
      field: string
    }>>
    accountPrices?: Array<{
      sessionId: string
      accountName: string
      accountType: 'normal' | 'gift' | 'vip88'
      capturedAt?: string
      price: number
      resolutionStatus?: PriceResolutionStatus
      priceResolution?: PriceResolution
      normalPrice?: number
      billionPrice?: number | null
      billionStatus?: 'available' | 'none'
      seckillPrice?: number | null
      seckillStatus?: 'available' | 'none'
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
      originalPrice?: number
      priceTitle?: string
      priceCalculation?: {
        normal: string
        billion?: string
        seckill?: string
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
  archivedSkuPrices?: Array<{
    skuId: string
    name: string
    image?: string
    archivedAt?: string
    resolutionStatus?: PriceResolutionStatus
    priceResolution?: PriceResolution
  }>
  price: number | null
  priceRange: [number, number] | null
  source?: 'fetch' | 'browser' | 'local-import'
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
    accountCaptureCount?: number
    observedSkuCount?: number
    outputSkuCount?: number
    verifiedPriceSkuCount?: number
    timingsMs?: {
      pageCapture?: number
      promotionCapture?: number
      browserAcquisition?: number
      localEvidenceSave?: number
      localEvidenceRead?: number
      localEvidenceReload?: number
      localParse?: number
      buyerShow?: number
      total?: number
    }
    buyerShowEvidenceSourceSaved?: boolean
    buyerShowEvidenceParsedFromDisk?: boolean
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
  browserEngine?: BrowserEngineId
  active: boolean
  enabled?: boolean
  healthStatus?: 'healthy' | 'degraded'
  lastUsedAt?: string | null
  lastSuccessAt?: string | null
  lastFailureAt?: string | null
  consecutiveFailures?: number
  loginStatus?: 'valid' | 'expired'
  tmallPriceStatus?: 'unknown' | 'valid' | 'cooldown' | 'degraded'
  tmallPriceCheckedAt?: string | null
  tmallPriceCooldownUntil?: string | null
  tmallPriceDeviceCooldownUntil?: string | null
  tmallPriceLastFailureAt?: string | null
  tmallPriceFailureReason?: string | null
  tmallPriceFailureCount?: number
  identityOnline?: boolean
  priceUsable?: boolean
  availabilityStatus?: 'ready' | 'login-expired' | 'price-unavailable' | 'price-unverified' | 'access-restricted'
  availabilityReason?: string
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

export type RunItem = {
  productId: string
  requestedItemId: string
  itemId: string
  name: string
  accountType: 'normal' | 'gift' | 'vip88'
  status: 'success' | 'partial' | 'failed'
  message: string
  capturedAt: string
}

export type BrowserEngineId = 'uc' | '360' | 'qq' | 'sogou' | 'edge'

export type BrowserEngineOption = {
  id: BrowserEngineId
  name: string
  available: boolean
  downloadUrl: string
}

export type BrowserEngineCatalog = {
  defaultEngine: BrowserEngineId
  engines: BrowserEngineOption[]
}

export type RunRecord = {
  id: string
  source: 'manual-all' | 'manual-batch' | 'manual-product' | 'single-product' | 'scheduled' | 'local-import'
  scope: string
  status: 'success' | 'partial' | 'failed'
  startedAt: string
  finishedAt: string
  total: number
  success: number
  partial: number
  failed: number
  message: string
  items?: RunItem[]
}

export type CaptureQueueJob = {
  id: string
  operationType?: 'monitor' | 'product' | 'buyer-show' | 'materials'
  captureKind?: ProductCaptureOptions['captureKind']
  source: string
  scope: string
  status: 'queued' | 'running' | 'auth-required' | 'completed' | 'failed'
  stage: 'queued' | 'opening' | 'capturing' | 'saving' | 'parsing' | 'verifying' | 'retrying' | 'auth-required' | 'completed' | 'failed'
  outcome: 'success' | 'partial' | 'failed' | 'cancelled' | null
  productIds: string[]
  retryProductIds?: string[]
  products: Array<{ id: string; name: string }>
  activeProductIds: string[]
  total: number
  completed: number
  attempt: number
  retryIndex: number
  nextAttemptAt: string | null
  message: string
  error: string
  results: RunItem[]
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type CaptureQueueStatus = {
  running: boolean
  pendingCount: number
  completedCount: number
  authRequiredCount?: number
  retentionSeconds: number
  jobs: CaptureQueueJob[]
}

export type ModelChannel = 'stable' | 'fast' | 'custom'

export type ModelChannelState = {
  model: string
  imageModel: string
  hasApiKey: boolean
  apiKeyMasked: string
  apiKeySource: 'saved' | 'environment' | 'none'
  lastTestedAt: string | null
  lastTestStatus: 'success' | 'unverified' | 'failed' | null
  lastTestTarget: ModelConfigTestTarget | null
  testStates: Record<ModelConfigTestTarget, {
    lastTestedAt: string | null
    lastTestStatus: 'success' | 'unverified' | 'failed' | null
  }>
}

export type ModelConfig = {
  channel: ModelChannel
  channelStates: Record<ModelChannel, ModelChannelState>
  customBaseUrl: string
  model: string
  imageModel: string
  apiKeyMasked: string
  hasApiKey: boolean
  apiKeySource: 'saved' | 'environment' | 'none'
  lastTestedAt: string | null
  lastTestStatus: 'success' | 'unverified' | 'failed' | null
  lastTestTarget: ModelConfigTestTarget | null
}

export type ModelConfigPatch = {
  channel?: ModelChannel
  customBaseUrl?: string
  model?: string
  imageModel?: string
  apiKey?: string
  clearApiKey?: boolean
}

export type ModelConfigTestTarget = 'image' | 'prompt'

export type ModelConfigTestPayload = Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'model' | 'imageModel' | 'apiKey'> & {
  target?: ModelConfigTestTarget
}

export type ModelCatalogRequest = Pick<ModelConfigPatch, 'channel' | 'customBaseUrl' | 'model' | 'imageModel' | 'apiKey'>

export type ModelCatalog = {
  channel: ModelChannel
  promptModels: string[]
  imageModels: string[]
  fetchedAt: string
}

export type ModelConfigTestResult = {
  ok: boolean
  status: 'success' | 'unverified'
  target: ModelConfigTestTarget
  model: string
  channel: ModelChannel
  latencyMs: number
  testedAt: string
  message: string
}

export type ImageGenerationRequest = {
  clientRequestId?: string
  prompt: string
  negativePrompt?: string
  ratio: '1:1' | '4:5' | '3:4' | '2:3' | '9:16' | '4:3' | '3:2' | '16:9' | 'custom'
  customWidth?: number
  customHeight?: number
  resolution: '1k' | '2k' | '4k'
  quality: 'low' | 'medium' | 'high'
  format: 'png' | 'jpeg' | 'webp'
  background: 'auto' | 'opaque' | 'transparent'
  compression?: number
  count: number
  sourceImageId?: string
  editMode?: 'mask' | 'annotation'
  editIntent?: 'local' | 'background' | 'outpaint' | 'redraw'
  compositionMode?: 'keep' | 'smart'
  copyText?: string
  copyPosition?: 'top' | 'center' | 'bottom'
  copyStyle?: 'light' | 'dark'
  copyScale?: 'small' | 'medium' | 'large'
}

export type ImageLibraryItem = {
  id: string
  src?: string
  thumbnailSrc?: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  prompt: string
  negativePrompt?: string
  ratio: ImageGenerationRequest['ratio']
  customWidth?: number
  customHeight?: number
  resolution: ImageGenerationRequest['resolution']
  quality: ImageGenerationRequest['quality']
  format: ImageGenerationRequest['format']
  background: ImageGenerationRequest['background']
  model: string
  createdAt: string
  width?: number
  height?: number
  nativeSize?: string
  outputSize?: string
  upscaled?: boolean
  processing?: 'native' | 'cropped' | 'upscaled' | 'fitted'
  validation?: {
    score: number
    passed: boolean
    changedRatio?: number
    meanDelta?: number
    protectedChangedRatio?: number
    protectedMeanDelta?: number
  }
  isFavorite: boolean
  isArchived: boolean
  revisedPrompt?: string
  parentImageId?: string | null
  referenceImageCount?: number
  maskApplied?: boolean
  editIntent?: ImageGenerationRequest['editIntent']
  compositionMode?: ImageGenerationRequest['compositionMode']
  productMaskConfidence?: number
  copy?: {
    text: string
    position: NonNullable<ImageGenerationRequest['copyPosition']>
    style: NonNullable<ImageGenerationRequest['copyStyle']>
    scale: NonNullable<ImageGenerationRequest['copyScale']>
  }
}

export type ImageGenerationResponse = {
  images: ImageLibraryItem[]
  model: string
  size: string
  durationMs: number
  createdAt: string
  warnings?: string[]
  appliedOptions?: {
    mode: 'generate' | 'edit'
    referenceImageCount: number
    maskApplied: boolean
    editIntent?: ImageGenerationRequest['editIntent'] | null
    compositionMode?: ImageGenerationRequest['compositionMode'] | null
    candidateRankingApplied?: boolean
    outpaintPrepared?: boolean
    productMaskConfidence?: number | null
    ratio: ImageGenerationRequest['ratio']
    resolution: ImageGenerationRequest['resolution']
    nativeSize: string
    outputSize: string
  }
}

export type ImageGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type ImageGenerationJob = {
  id: string
  clientRequestId: string | null
  status: ImageGenerationJobStatus
  createdAt: string
  queuedAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  finishedAt?: string | null
  attempt: number
  request: ImageGenerationRequest
  referenceImageCount: number
  maskApplied: boolean
  queuePosition: number | null
  position?: number | null
  durationMs?: number | null
  message?: string
  result: ImageGenerationResponse | null
  error: {
    code: string
    message: string
    retryable: boolean
  } | null
}

export type PhotoshopOpenResult = {
  imageId: string
  reused: boolean
  applicationName: string
}

export type PhotoshopSyncResult = {
  image: ImageLibraryItem
  modifiedAt: string
}

export type LocalImportPreview = {
  importId: string
  savedFile: string
  sourceFile?: string
  localFirst?: {
    sourceSaved: boolean
    sourceSanitized: boolean
    parsedFromDisk: boolean
    networkAccessed: boolean
  }
  inputType: 'json' | 'jsonp' | 'html' | 'text'
  accountType: 'normal' | 'gift' | 'vip88'
  itemId: string
  title: string
  shopName: string
  canCommit: boolean
  resolutionStatus: PriceResolutionStatus
  skuCount: number
  verifiedSkuCount: number
  price: number | null
  priceRange: [number, number] | null
  warnings: string[]
  skuPrices: Snapshot['skuPrices']
}

export type LocalImportCommitResult = {
  created: boolean
  alreadyCommitted: boolean
  savedFile: string
  sourceFile?: string
  product: Product
  snapshot: Snapshot
  run: RunRecord
}

export type RawDataCaptureResult = {
  ok: true
  evidenceId: string
  itemId: string
  accountType: 'normal' | 'gift' | 'vip88'
  capturedAt: string
  sourceFile: string
  byteSize: number
  skuCount: number
  verifiedSkuCount: number
  sanitized: true
  jsonText: string
}

export type LocalEvidenceStatus = {
  directory: string
  defaultDirectory: string
  fileCount: number
  sourceFileCount: number
  totalBytes: number
  directoryPickerAvailable: boolean
}

export type ExcelSyncStatus = {
  enabled: true
  path: string
  exists: boolean
  size: number
  modifiedAt: string | null
  indexPath: string
  indexExists: boolean
  indexSize: number
  lastSyncedAt: string | null
  lastError: string
  calculationMs: number | null
  indexLookupMs: number | null
  workbookMs: number | null
}

export type ExcelSyncResult = {
  path: string
  currentRows: number
  historyRows: number
  promotionRows: number
  indexRows: number
  indexPath: string
  indexLookupMs: number
  calculationMs: number
  workbookMs: number
  syncedAt: string
}

export type Overview = {
  products: Product[]
  snapshots: Snapshot[]
  analyses: Analysis[]
  authSessions: AuthSession[]
  runs: RunRecord[]
  captureQueue: CaptureQueueStatus
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
  modelConfig: ModelConfig
  monitor: {
    intervalMinutes: number
    running: boolean
    lastRunAt: string | null
    nextRunAt: string | null
  }
  feishu: {
    enabled: boolean
    webhookConfigured: boolean
    webhookUrlMasked: string
    signingSecretConfigured: boolean
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
    status: 'sent' | 'failed'
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
