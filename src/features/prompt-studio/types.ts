export type PromptCategory =
  | 'white-background'
  | 'product-scene'
  | 'campaign-poster'
  | 'detail-page'
  | 'local-edit'
  | 'background-swap'
  | 'product-retouch'

export type PromptVariantKey = 'safe' | 'commercial' | 'creative'
export type PromptRiskStatus = 'pass' | 'warning' | 'error'
export type PromptCopyMode = 'none' | 'reserved' | 'exact'

export type PromptProductFacts = {
  productType: string
  appearance: string
  colorsMaterials: string
  components: string[]
  logo: string
  existingText: string[]
  mustPreserve: string[]
  forbiddenChanges: string[]
}

export type PromptStyle = {
  name: string
  description: string
  lighting: string
  composition: string
  palette: string
  camera: string
  forbidden: string[]
}

export type PromptCopy = {
  mode: PromptCopyMode
  title: string
  subtitle: string
  sellingPoints: string[]
  price: string
  campaignInfo: string
  additionalText: string[]
}

export type PromptParameters = {
  ratio: '1:1' | '3:4' | '4:3' | '16:9'
  resolution: '1k' | '2k' | '4k'
  quality: 'low' | 'medium' | 'high'
  background: 'auto' | 'opaque' | 'transparent'
}

export type PromptEditBoundary = {
  targetAreas: string[]
  changes: string[]
  preserveAreas: string[]
}

export type PromptGenerationRequest = {
  category: PromptCategory
  userRequest: string
  productFacts: PromptProductFacts
  style: PromptStyle
  copy: PromptCopy
  parameters: PromptParameters
  editBoundary: PromptEditBoundary
}

export type QuickPromptRequest = {
  clientRequestId?: string
  userRequest: string
  parameters: PromptParameters
  creationMode?: 'product' | 'free'
  saveHistory?: boolean
}

export type PromptVariant = {
  title: string
  prompt: string
  negativePrompt: string
  rationale: string
  recommendedParameters?: Partial<PromptParameters>
}

export type PromptRiskCheck = {
  id: string
  label: string
  status: PromptRiskStatus
  message: string
}

export type PromptProductProfile = PromptProductFacts & {
  id: string
  name: string
  updatedAt: string
}

export type PromptStylePreset = PromptStyle & {
  id: string
  updatedAt: string
}

export type PromptHistoryItem = {
  id: string
  name: string
  category: PromptCategory
  request: PromptGenerationRequest
  variants: Record<PromptVariantKey, PromptVariant>
  riskChecks: PromptRiskCheck[]
  selectedVariantKey: PromptVariantKey
  isFavorite: boolean
  createdAt: string
  model: string
}

export type PromptGenerationResult = {
  id?: string
  variants: Record<PromptVariantKey, PromptVariant>
  riskChecks: PromptRiskCheck[]
  createdAt: string
  model: string
  historyItem?: PromptHistoryItem
}

export type QuickPromptGenerationResult = PromptGenerationResult & {
  request: PromptGenerationRequest
  warnings: string[]
  recommendedVariantKey: PromptVariantKey
}

export type PromptEnhancementResult = {
  prompt: string
  model: string
}

export type ProductRecognitionResult = {
  facts: PromptProductFacts
  confidence?: number
  warnings?: string[]
}

export type PromptStudioWorkspace = {
  productProfiles: PromptProductProfile[]
  stylePresets: PromptStylePreset[]
  history: PromptHistoryItem[]
  libraryFavorites: string[]
}

export type PromptSyncPayload = {
  category: PromptCategory
  variantKey: PromptVariantKey
  prompt: string
  negativePrompt: string
  ratio: PromptParameters['ratio']
  resolution: PromptParameters['resolution']
  quality: PromptParameters['quality']
  format: 'png'
  background: PromptParameters['background']
  referenceFiles: File[]
}

export type PromptReferenceFiles = {
  productReferenceFiles: File[]
  styleReferenceFiles: File[]
}

export type PromptStudioDraft = {
  category: PromptCategory
  productProfileId: string
  stylePresetId: string
  userRequest: string
  productFacts: PromptProductFacts
  style: PromptStyle
  copy: PromptCopy
  parameters: PromptParameters
  taskFields: Record<string, string>
  factsConfirmed: boolean
}
