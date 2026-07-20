import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  FileText,
  History,
  Images,
  LoaderCircle,
  Palette,
  Pencil,
  RefreshCw,
  Save,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Settings2,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input, Textarea } from '../../components/ui/input'
import type { ModelConfig } from '../../types/domain'
import { ReferenceImagePicker, type ReferenceImageFile } from '../image-generation/ReferenceImagePicker'
import { loadPromptDraft, loadReferenceGroups, savePromptDraft, saveReferenceGroups } from './promptDraftStorage'
import { PromptLibraryPanel } from './PromptLibraryPanel'
import type { PromptGardenPrompt } from './promptGarden'
import type { PromptLibraryTemplate } from './promptLibrary'
import {
  composeNegativePromptWithHidden,
  composePromptWithHidden,
  visibleNegativePrompt,
  visiblePrompt,
} from './promptLayers'
import type {
  ProductRecognitionResult,
  PromptCategory,
  PromptGenerationRequest,
  PromptGenerationResult,
  PromptHistoryItem,
  PromptProductFacts,
  PromptProductProfile,
  PromptReferenceFiles,
  PromptStudioDraft,
  PromptStudioWorkspace,
  PromptStyle,
  PromptStylePreset,
  PromptSyncPayload,
  PromptVariant,
  PromptVariantKey,
  QuickPromptGenerationResult,
  QuickPromptRequest,
} from './types'

const categories: Array<{
  id: PromptCategory
  label: string
  description: string
  icon: LucideIcon
}> = [
  { id: 'white-background', label: '白底主图', description: '干净背景、主体居中与真实阴影', icon: Images },
  { id: 'product-scene', label: '产品场景图', description: '场景、道具、光线与镜头语言', icon: Palette },
  { id: 'campaign-poster', label: '活动海报', description: 'AI 自由策划主题、文案与视觉层级', icon: FileText },
  { id: 'detail-page', label: '详情页配图', description: '卖点拆解与功能演示画面', icon: Sparkles },
  { id: 'local-edit', label: '局部改图', description: '只修改指定区域，其余完全保留', icon: Pencil },
  { id: 'background-swap', label: '换背景', description: '边缘融合、接触阴影与环境一致', icon: RefreshCw },
  { id: 'product-retouch', label: '产品精修', description: '优化材质、反射与清晰度', icon: WandSparkles },
]

const taskFields: Record<PromptCategory, Array<{ key: string; label: string; placeholder: string; multiline?: boolean }>> = {
  'white-background': [
    { key: 'angle', label: '产品角度', placeholder: '例如：正面略俯视 15 度' },
    { key: 'composition', label: '构图要求', placeholder: '例如：主体居中，占画面约 85%' },
    { key: 'shadow', label: '阴影方式', placeholder: '例如：自然柔和的接触阴影' },
    { key: 'backgroundPurity', label: '背景要求', placeholder: '例如：纯白 #FFFFFF，无渐变' },
  ],
  'product-scene': [
    { key: 'scene', label: '使用场景', placeholder: '例如：明亮整洁的现代厨房' },
    { key: 'props', label: '道具与环境', placeholder: '例如：少量原木厨具，不遮挡产品' },
    { key: 'lighting', label: '光线', placeholder: '例如：左侧自然窗光，反差柔和' },
    { key: 'camera', label: '镜头与机位', placeholder: '例如：50mm，平视三分构图' },
  ],
  'campaign-poster': [
    { key: 'campaignMood', label: '活动氛围', placeholder: '例如：清爽夏季大促，简洁有冲击力' },
    { key: 'copyArea', label: '文案区域', placeholder: '例如：画面右侧预留 35% 干净空间' },
    { key: 'visualFocus', label: '视觉重点', placeholder: '例如：产品为第一视觉，活动氛围为辅' },
  ],
  'detail-page': [
    { key: 'sellingPoint', label: '本屏核心卖点', placeholder: '一次只表达一个卖点，避免信息拥挤' },
    { key: 'demonstration', label: '功能如何演示', placeholder: '例如：用剖面或使用动作展示功能', multiline: true },
    { key: 'layout', label: '版式与留白', placeholder: '例如：上图下文，顶部预留标题区' },
  ],
  'local-edit': [
    { key: 'targetAreas', label: '修改位置', placeholder: '每行一个位置，例如：\n锅盖右上方配件', multiline: true },
    { key: 'changes', label: '具体修改', placeholder: '每行一个改动，必须与修改位置对应', multiline: true },
    { key: 'preserveAreas', label: '必须保持不变', placeholder: '例如：\n产品主体结构\nLogo 与面板文字\n未框选区域', multiline: true },
  ],
  'background-swap': [
    { key: 'targetScene', label: '目标背景', placeholder: '例如：干净明亮的家庭厨房', multiline: true },
    { key: 'edgeBlend', label: '边缘融合', placeholder: '例如：保留产品细小边缘，不出现白边' },
    { key: 'contactShadow', label: '接触关系', placeholder: '例如：补充符合光源的自然接触阴影' },
  ],
  'product-retouch': [
    { key: 'material', label: '材质优化', placeholder: '例如：增强金属拉丝，保持真实不过曝' },
    { key: 'reflection', label: '反射与光泽', placeholder: '例如：清理杂乱反射，保留自然高光' },
    { key: 'cleanup', label: '清理内容', placeholder: '例如：灰尘、划痕与轻微污渍' },
    { key: 'sharpness', label: '清晰度', placeholder: '例如：边缘清楚自然，不要过度锐化' },
  ],
}

const variantMeta: Record<PromptVariantKey, { label: string; note: string }> = {
  safe: { label: '稳妥执行', note: '还原优先，改动最少' },
  commercial: { label: '商业增强', note: '加强质感与电商表现' },
  creative: { label: '创意方案', note: '构图与场景变化更明显' },
}

const emptyFacts: PromptProductFacts = {
  productType: '',
  appearance: '',
  colorsMaterials: '',
  components: [],
  logo: '',
  existingText: [],
  mustPreserve: [],
  forbiddenChanges: [],
}

const emptyStyle: PromptStyle = {
  name: '',
  description: '',
  lighting: '',
  composition: '',
  palette: '',
  camera: '',
  forbidden: [],
}

const defaultDraft: PromptStudioDraft = {
  category: 'white-background',
  productProfileId: '',
  stylePresetId: '',
  userRequest: '',
  productFacts: emptyFacts,
  style: emptyStyle,
  copy: {
    mode: 'none',
    title: '',
    subtitle: '',
    sellingPoints: [],
    price: '',
    campaignInfo: '',
    additionalText: [],
  },
  parameters: { ratio: '1:1', resolution: '2k', quality: 'high', background: 'auto' },
  taskFields: {},
  factsConfirmed: false,
}

type Feedback = { tone: 'neutral' | 'success' | 'error'; message: string }
type ProductProfileInput = Omit<PromptProductProfile, 'id' | 'updatedAt'> & { id?: string }
type StylePresetInput = Omit<PromptStylePreset, 'id' | 'updatedAt'> & { id?: string }

export type PromptWorkbenchProps = {
  presentation?: 'standalone' | 'professional'
  config: ModelConfig
  onLoadWorkspace: () => Promise<PromptStudioWorkspace>
  onAnalyzeProduct: (files: PromptReferenceFiles, existingFacts: PromptProductFacts) => Promise<ProductRecognitionResult>
  onGenerate: (request: PromptGenerationRequest, files: PromptReferenceFiles) => Promise<PromptGenerationResult>
  onQuickGenerate: (request: QuickPromptRequest, files: PromptReferenceFiles) => Promise<QuickPromptGenerationResult>
  onOpenModelSettings: () => void
  onSaveProductProfile: (profile: ProductProfileInput) => Promise<PromptProductProfile>
  onDeleteProductProfile: (id: string) => Promise<void>
  onSaveStylePreset: (preset: StylePresetInput) => Promise<PromptStylePreset>
  onDeleteStylePreset: (id: string) => Promise<void>
  onToggleLibraryFavorite: (templateId: string, favorite: boolean) => Promise<{ libraryFavorites: string[] }>
  onToggleFavoriteHistory: (id: string, favorite: boolean) => Promise<PromptHistoryItem>
  onRenameHistory: (id: string, name: string) => Promise<PromptHistoryItem>
  onDeleteHistory: (id: string) => Promise<void>
  onSyncToImageWorkbench: (payload: PromptSyncPayload) => void
  onExitProfessional?: () => void
}

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function textLines(value: string[]) {
  return value.join('\n')
}

function copyValues(copy: PromptStudioDraft['copy']) {
  return [copy.title, copy.subtitle, ...copy.sellingPoints, copy.price, copy.campaignInfo, ...copy.additionalText]
    .map((item) => item.trim())
    .filter(Boolean)
}

function copyText(copy: PromptStudioDraft['copy']) {
  return copyValues(copy).join('\n')
}

function copyWithText(copy: PromptStudioDraft['copy'], value: string) {
  return {
    ...copy,
    title: '',
    subtitle: '',
    sellingPoints: [],
    price: '',
    campaignInfo: '',
    additionalText: lines(value),
  }
}

function copyForMode(copy: PromptStudioDraft['copy'], mode: PromptStudioDraft['copy']['mode']) {
  if (mode === 'exact') return { ...copy, mode }
  return {
    mode,
    title: '',
    subtitle: '',
    sellingPoints: [],
    price: '',
    campaignInfo: '',
    additionalText: [],
  }
}

function variantsForEditing(variants: Record<PromptVariantKey, PromptVariant>) {
  return Object.fromEntries(Object.entries(variants).map(([key, variant]) => [key, {
    ...variant,
    prompt: visiblePrompt(variant.prompt),
    negativePrompt: visibleNegativePrompt(variant.negativePrompt),
  }])) as Record<PromptVariantKey, PromptVariant>
}

function gardenPromptCategory(prompt: PromptGardenPrompt): PromptCategory {
  const text = [prompt.title, prompt.summary, ...prompt.tags, ...prompt.categoryPath].join(' ').toLocaleLowerCase('zh-CN')
  if (/局部|修改|替换|编辑|inpaint|local edit/.test(text)) return 'local-edit'
  if (/换背景|背景替换|background swap/.test(text)) return 'background-swap'
  if (/精修|材质|retouch/.test(text)) return 'product-retouch'
  if (/白底主图|商品白底|产品白底/.test(text)) return 'white-background'
  if (/详情|detail page/.test(text)) return 'detail-page'
  if (/海报|信息图|知识卡|流程图|poster|infographic/.test(text)) return 'campaign-poster'
  return 'product-scene'
}

function updatedList<T extends { id: string }>(items: T[], next: T) {
  return [next, ...items.filter((item) => item.id !== next.id)]
}

function revokeReferencePreviews(images: ReferenceImageFile[]) {
  images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function buildRequest(draft: PromptStudioDraft): PromptGenerationRequest {
  const details = taskFields[draft.category]
    .map((field) => draft.taskFields[field.key]?.trim() ? `${field.label}：${draft.taskFields[field.key].trim()}` : '')
    .filter(Boolean)
  return {
    category: draft.category,
    userRequest: [draft.userRequest.trim(), ...details].filter(Boolean).join('\n'),
    productFacts: draft.productFacts,
    style: draft.style,
    copy: ['campaign-poster', 'detail-page'].includes(draft.category)
      ? draft.copy
      : { ...draft.copy, mode: 'none', title: '', subtitle: '', sellingPoints: [], price: '', campaignInfo: '', additionalText: [] },
    parameters: draft.parameters,
    editBoundary: draft.category === 'local-edit'
      ? {
          targetAreas: lines(draft.taskFields.targetAreas || ''),
          changes: lines(draft.taskFields.changes || ''),
          preserveAreas: lines(draft.taskFields.preserveAreas || ''),
        }
      : draft.category === 'background-swap'
        ? {
            targetAreas: ['产品主体以外的背景区域'],
            changes: [
              draft.taskFields.targetScene?.trim() ? `目标背景：${draft.taskFields.targetScene.trim()}` : '',
              draft.taskFields.edgeBlend?.trim() ? `边缘融合：${draft.taskFields.edgeBlend.trim()}` : '',
              draft.taskFields.contactShadow?.trim() ? `接触关系：${draft.taskFields.contactShadow.trim()}` : '',
            ].filter(Boolean),
            preserveAreas: ['产品主体、结构、比例、位置、视角、Logo和既有文字', ...draft.productFacts.mustPreserve],
          }
        : { targetAreas: [], changes: [], preserveAreas: draft.productFacts.mustPreserve },
  }
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return <div><h3 className="text-sm font-semibold text-slate-900">{title}</h3>{note && <p className="mt-0.5 text-xs leading-5 text-slate-500">{note}</p>}</div>
}

function Field({ label, value, placeholder, onChange, multiline = false }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void; multiline?: boolean }) {
  return <label className="grid gap-1.5 text-sm font-medium text-slate-700"><span>{label}</span>{multiline ? <Textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-h-20 leading-6" /> : <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />}</label>
}

function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null
  const styles = feedback.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : feedback.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800'
  const Icon = feedback.tone === 'error' ? CircleAlert : feedback.tone === 'success' ? Check : LoaderCircle
  return <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${styles}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite"><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${feedback.tone === 'neutral' ? 'animate-spin motion-reduce:animate-none' : ''}`} /><span>{feedback.message}</span></div>
}

export function PromptWorkbench({
  presentation = 'standalone',
  config,
  onLoadWorkspace,
  onAnalyzeProduct,
  onGenerate,
  onQuickGenerate,
  onOpenModelSettings,
  onSaveProductProfile,
  onDeleteProductProfile,
  onSaveStylePreset,
  onDeleteStylePreset,
  onToggleLibraryFavorite,
  onToggleFavoriteHistory,
  onRenameHistory,
  onDeleteHistory,
  onSyncToImageWorkbench,
  onExitProfessional,
}: PromptWorkbenchProps) {
  const [mode, setMode] = useState<'simple' | 'advanced'>(() => presentation === 'professional' ? 'advanced' : 'simple')
  const [quickUserRequest, setQuickUserRequest] = useState('')
  const [quickGenerating, setQuickGenerating] = useState(false)
  const [quickResult, setQuickResult] = useState<QuickPromptGenerationResult | null>(null)
  const [quickReferencesOpen, setQuickReferencesOpen] = useState(false)
  const [draft, setDraft] = useState(() => loadPromptDraft(defaultDraft))
  const [workspace, setWorkspace] = useState<PromptStudioWorkspace>({ productProfiles: [], stylePresets: [], history: [], libraryFavorites: [] })
  const [productReferences, setProductReferences] = useState<ReferenceImageFile[]>([])
  const [styleReferences, setStyleReferences] = useState<ReferenceImageFile[]>([])
  const [filesHydrated, setFilesHydrated] = useState(false)
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [recognizing, setRecognizing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [assetBusy, setAssetBusy] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [result, setResult] = useState<PromptGenerationResult | null>(null)
  const [resultReferenceFiles, setResultReferenceFiles] = useState<PromptReferenceFiles | null>(null)
  const [resultDirty, setResultDirty] = useState(false)
  const [editableVariants, setEditableVariants] = useState<Record<PromptVariantKey, PromptVariant> | null>(null)
  const [selectedVariant, setSelectedVariant] = useState<PromptVariantKey>('safe')
  const [rightView, setRightView] = useState<'result' | 'history'>('result')
  const [productProfileName, setProductProfileName] = useState('')
  const filesHydratedRef = useRef(false)

  const filePayload = useCallback((): PromptReferenceFiles => ({
    productReferenceFiles: productReferences.map((image) => image.file),
    styleReferenceFiles: styleReferences.map((image) => image.file),
  }), [productReferences, styleReferences])

  function clearProductReferences() {
    setProductReferences((current) => {
      revokeReferencePreviews(current)
      return []
    })
  }

  function clearStyleReferences() {
    setStyleReferences((current) => {
      revokeReferencePreviews(current)
      return []
    })
  }

  useEffect(() => savePromptDraft(draft), [draft])

  useEffect(() => {
    let active = true
    void loadReferenceGroups()
      .then((groups) => {
        if (!active) return
        const restoredProductReferences = groups.product.slice(0, 3).map((item) => ({ ...item, previewUrl: URL.createObjectURL(item.file) }))
        setProductReferences(restoredProductReferences)
        if (restoredProductReferences.length) setQuickReferencesOpen(true)
        setStyleReferences(groups.style.slice(0, 1).map((item) => ({ ...item, previewUrl: URL.createObjectURL(item.file) })))
      })
      .catch(() => setFeedback({ tone: 'error', message: '上次保存的参考图无法恢复，请重新添加。' }))
      .finally(() => {
        if (!active) return
        filesHydratedRef.current = true
        setFilesHydrated(true)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!filesHydratedRef.current) return
    const timer = window.setTimeout(() => {
      void saveReferenceGroups({
        product: productReferences.map(({ id, file }) => ({ id, file })),
        style: styleReferences.map(({ id, file }) => ({ id, file })),
      }).catch(() => setFeedback({ tone: 'error', message: '参考图自动保存失败；当前页面仍可继续使用。' }))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [productReferences, styleReferences])

  useEffect(() => {
    let active = true
    setWorkspaceLoading(true)
    void onLoadWorkspace()
      .then((next) => { if (active) setWorkspace(next) })
      .catch((error) => { if (active) setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '提示词资产读取失败。' }) })
      .finally(() => { if (active) setWorkspaceLoading(false) })
    return () => { active = false }
  }, [onLoadWorkspace])

  function updateDraft(patch: Partial<PromptStudioDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function updateFacts(patch: Partial<PromptProductFacts>) {
    setDraft((current) => ({ ...current, productFacts: { ...current.productFacts, ...patch }, factsConfirmed: false }))
  }

  function updateStyle(patch: Partial<PromptStyle>) {
    setDraft((current) => ({ ...current, style: { ...current.style, ...patch }, stylePresetId: '' }))
  }

  function updateTaskField(key: string, value: string) {
    setDraft((current) => ({ ...current, taskFields: { ...current.taskFields, [key]: value } }))
  }

  function selectCategory(category: PromptCategory) {
    setDraft((current) => ({
      ...current,
      category,
    }))
    setFeedback({ tone: 'neutral', message: `已切换到“${categories.find((item) => item.id === category)?.label}”，当前草稿已自动保存。` })
  }

  function selectProductProfile(id: string) {
    if (id !== draft.productProfileId) clearProductReferences()
    const profile = workspace.productProfiles.find((item) => item.id === id)
    if (!profile) {
      updateDraft({ productProfileId: '' })
      setProductProfileName('')
      return
    }
    const { name, updatedAt: _updatedAt, id: profileId, ...facts } = profile
    void _updatedAt
    setProductProfileName(name)
    setDraft((current) => ({ ...current, productProfileId: profileId, productFacts: facts, factsConfirmed: true }))
    setFeedback({ tone: 'success', message: `已载入产品档案“${name}”。` })
  }

  function selectStylePreset(id: string) {
    if (id !== draft.stylePresetId) clearStyleReferences()
    const preset = workspace.stylePresets.find((item) => item.id === id)
    if (!preset) {
      updateDraft({ stylePresetId: '' })
      return
    }
    const { updatedAt: _updatedAt, id: presetId, ...style } = preset
    void _updatedAt
    setDraft((current) => ({ ...current, stylePresetId: presetId, style }))
    setFeedback({ tone: 'success', message: `已应用风格方案“${style.name}”。` })
  }

  async function analyzeProduct() {
    if (!productReferences.length) {
      setFeedback({ tone: 'error', message: '请先添加至少一张产品参考图，再识别产品事实。' })
      return
    }
    setRecognizing(true)
    setFeedback({ tone: 'neutral', message: '正在识别产品外形、材质、文字和必须保留项…' })
    try {
      const recognized = await onAnalyzeProduct(filePayload(), draft.productFacts)
      updateFacts(recognized.facts)
      const confidence = typeof recognized.confidence === 'number' ? ` 识别置信度 ${Math.round(recognized.confidence * 100)}%。` : ''
      const warnings = recognized.warnings?.length ? ` ${recognized.warnings.join('；')}` : ''
      setFeedback({ tone: recognized.warnings?.length ? 'neutral' : 'success', message: `产品事实已识别，请逐项核对后点击确认。${confidence}${warnings}` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '产品识别失败，请重试或手动填写。' })
    } finally {
      setRecognizing(false)
    }
  }

  function confirmFacts() {
    if (!draft.productFacts.productType.trim() || !draft.productFacts.appearance.trim() || !draft.productFacts.colorsMaterials.trim()) {
      setFeedback({ tone: 'error', message: '请填写产品类型、外形结构、颜色与材质，再确认产品事实。' })
      return
    }
    updateDraft({ factsConfirmed: true })
    setFeedback({ tone: 'success', message: '产品事实已确认。后续修改任一事实时会要求重新确认。' })
  }

  async function saveProductProfile() {
    const name = productProfileName.trim()
    if (!name) {
      setFeedback({ tone: 'error', message: '请先填写产品档案名称。' })
      return
    }
    if (!draft.factsConfirmed) {
      setFeedback({ tone: 'error', message: '请先确认产品事实，再保存产品档案。' })
      return
    }
    setAssetBusy('product-save')
    try {
      const saved = await onSaveProductProfile({ id: draft.productProfileId || undefined, name, ...draft.productFacts })
      setWorkspace((current) => ({ ...current, productProfiles: updatedList(current.productProfiles, saved) }))
      updateDraft({ productProfileId: saved.id })
      setFeedback({ tone: 'success', message: `产品档案“${saved.name}”已保存。` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '产品档案保存失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function deleteProductProfile() {
    if (!draft.productProfileId || !window.confirm('删除当前产品档案？历史提示词不会被删除。')) return
    setAssetBusy('product-delete')
    try {
      await onDeleteProductProfile(draft.productProfileId)
      setWorkspace((current) => ({ ...current, productProfiles: current.productProfiles.filter((item) => item.id !== draft.productProfileId) }))
      updateDraft({ productProfileId: '' })
      setProductProfileName('')
      setFeedback({ tone: 'success', message: '产品档案已删除。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '产品档案删除失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function saveStylePreset() {
    if (!draft.style.name.trim()) {
      setFeedback({ tone: 'error', message: '请先填写风格方案名称。' })
      return
    }
    setAssetBusy('style-save')
    try {
      const saved = await onSaveStylePreset({ id: draft.stylePresetId || undefined, ...draft.style })
      setWorkspace((current) => ({ ...current, stylePresets: updatedList(current.stylePresets, saved) }))
      updateDraft({ stylePresetId: saved.id })
      setFeedback({ tone: 'success', message: `风格方案“${saved.name}”已保存。` })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '风格方案保存失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function deleteStylePreset() {
    if (!draft.stylePresetId || !window.confirm('删除当前风格方案？历史提示词不会被删除。')) return
    setAssetBusy('style-delete')
    try {
      await onDeleteStylePreset(draft.stylePresetId)
      setWorkspace((current) => ({ ...current, stylePresets: current.stylePresets.filter((item) => item.id !== draft.stylePresetId) }))
      setDraft((current) => ({ ...current, stylePresetId: '', style: emptyStyle }))
      setFeedback({ tone: 'success', message: '风格方案已删除。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '风格方案删除失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function generateQuickPrompt() {
    const userRequest = quickUserRequest.trim()
    if (!userRequest) {
      setFeedback({ tone: 'error', message: '写一句你想要的效果，例如“把这张产品图做成干净的白底主图”。' })
      return
    }
    const channelState = config.channelStates?.[config.channel]
    if (!(channelState?.hasApiKey ?? config.hasApiKey)) {
      setFeedback({ tone: 'error', message: '提示词模型还没有配置，请先完成模型设置。' })
      onOpenModelSettings()
      return
    }
    const referenceSnapshot: PromptReferenceFiles = {
      productReferenceFiles: productReferences.map((image) => image.file),
      styleReferenceFiles: [],
    }
    setQuickGenerating(true)
    setFeedback({ tone: 'neutral', message: 'AI 正在理解你的要求并整理成可直接生图的提示词…' })
    try {
      const generated = await onQuickGenerate({ userRequest, parameters: draft.parameters }, referenceSnapshot)
      setQuickResult(generated)
      setResult(generated)
      setEditableVariants(variantsForEditing(generated.variants))
      setSelectedVariant(generated.recommendedVariantKey)
      setResultDirty(false)
      setResultReferenceFiles({
        productReferenceFiles: [...referenceSnapshot.productReferenceFiles],
        styleReferenceFiles: [],
      })
      setDraft((current) => ({
        ...current,
        category: generated.request.category,
        productProfileId: '',
        stylePresetId: '',
        userRequest: generated.request.userRequest,
        productFacts: generated.request.productFacts,
        style: generated.request.style,
        copy: generated.request.copy,
        parameters: generated.request.parameters,
        taskFields: {},
        factsConfirmed: true,
      }))
      if (generated.historyItem) setWorkspace((current) => ({ ...current, history: updatedList(current.history, generated.historyItem!) }))
      setRightView('result')
      setFeedback({
        tone: generated.warnings.length ? 'neutral' : 'success',
        message: generated.warnings.length ? `提示词已生成，有 ${generated.warnings.length} 项需要你留意。` : '提示词已生成，可以直接修改、复制或同步到 AI 创作。',
      })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '提示词生成失败，你填写的内容已保留。' })
    } finally {
      setQuickGenerating(false)
    }
  }

  async function generate() {
    const request = buildRequest(draft)
    if (!draft.factsConfirmed) {
      setFeedback({ tone: 'error', message: '请先确认产品事实，避免产品结构和文字被模型误改。' })
      return
    }
    if (!request.userRequest.trim()) {
      setFeedback({ tone: 'error', message: '请填写本次具体想改什么，或至少补充一项类目要求。' })
      return
    }
    if (!request.style.description.trim()) {
      setFeedback({ tone: 'error', message: '请填写整体风格，或先选择一个已保存的风格方案。' })
      return
    }
    if (['campaign-poster', 'detail-page'].includes(draft.category) && draft.copy.mode === 'exact' && !copyValues(draft.copy).length) {
      setFeedback({ tone: 'error', message: '直接生成文字模式至少要填写一条准确文案；不需要固定标题格式。' })
      return
    }
    if (draft.category === 'local-edit' && (!request.editBoundary.targetAreas.length || !request.editBoundary.changes.length || !request.editBoundary.preserveAreas.length)) {
      setFeedback({ tone: 'error', message: '局部改图必须分别填写修改位置、具体修改和保持不变区域。' })
      return
    }
    if (draft.category === 'background-swap' && !draft.taskFields.targetScene?.trim()) {
      setFeedback({ tone: 'error', message: '换背景必须填写目标背景，产品主体会自动加入保持不变区域。' })
      return
    }
    const referenceSnapshot = filePayload()
    setGenerating(true)
    setFeedback({ tone: 'neutral', message: '正在生成三套提示词并检查产品一致性、文字风险和修改边界…' })
    try {
      const generated = await onGenerate(request, referenceSnapshot)
      setQuickResult(null)
      setResult(generated)
      setResultReferenceFiles({
        productReferenceFiles: [...referenceSnapshot.productReferenceFiles],
        styleReferenceFiles: [...referenceSnapshot.styleReferenceFiles],
      })
      setResultDirty(false)
      setEditableVariants(variantsForEditing(generated.variants))
      setSelectedVariant('safe')
      setRightView('result')
      if (generated.historyItem) setWorkspace((current) => ({ ...current, history: updatedList(current.history, generated.historyItem!) }))
      const warningCount = generated.riskChecks.filter((item) => item.status !== 'pass').length
      setFeedback({ tone: warningCount ? 'neutral' : 'success', message: warningCount ? `三套提示词已生成，有 ${warningCount} 项需要确认。` : '三套提示词已生成并通过规则检查。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '提示词生成失败，全部输入已保留。' })
    } finally {
      setGenerating(false)
    }
  }

  function updateVariant(patch: Partial<PromptVariant>) {
    setEditableVariants((current) => current ? { ...current, [selectedVariant]: { ...current[selectedVariant], ...patch } } : current)
    if (patch.prompt !== undefined || patch.negativePrompt !== undefined) setResultDirty(true)
  }

  async function copyVariant() {
    const variant = editableVariants?.[selectedVariant]
    if (!variant) return
    try {
      await navigator.clipboard.writeText([`创意方案\n${variant.prompt}`, variant.negativePrompt ? `排除要求\n${variant.negativePrompt}` : ''].filter(Boolean).join('\n\n'))
      setFeedback({ tone: 'success', message: '当前创意方案已复制到剪贴板。' })
    } catch {
      setFeedback({ tone: 'error', message: '剪贴板写入失败，请手动选择文字复制。' })
    }
  }

  function syncVariant() {
    const variant = editableVariants?.[selectedVariant]
    if (!variant) return
    if (!resultReferenceFiles) {
      setFeedback({ tone: 'error', message: '这条历史提示词不包含参考图。请重新选择参考图并重新生成提示词，再同步到 AI 创作。' })
      return
    }
    if (resultDirty && !window.confirm('正向提示词或排除要求已被手动修改，原规则检查已经失效。请先人工核对产品、文字和修改边界。仍要同步这份修改后的提示词吗？')) {
      setFeedback({ tone: 'neutral', message: '已取消同步。当前内容已修改，原规则检查失效；重新生成后可获得新的检查结果。' })
      return
    }
    const parameters = { ...draft.parameters, ...variant.recommendedParameters }
    onSyncToImageWorkbench({
      category: draft.category,
      variantKey: selectedVariant,
      prompt: composePromptWithHidden(variant.prompt, result?.variants[selectedVariant]?.prompt),
      negativePrompt: composeNegativePromptWithHidden(variant.negativePrompt, result?.variants[selectedVariant]?.negativePrompt),
      ratio: parameters.ratio,
      resolution: parameters.resolution,
      quality: parameters.quality,
      format: 'png',
      background: parameters.background,
      referenceFiles: [...resultReferenceFiles.productReferenceFiles, ...resultReferenceFiles.styleReferenceFiles],
    })
    setFeedback({ tone: 'success', message: resultDirty ? '已按你的人工确认同步修改后的提示词、参数和本次结果绑定的参考图。' : '提示词、参数和本次结果绑定的参考图已填入 AI 创作；请确认后再开始生成。' })
  }

  function confirmTemplateReplacement(name: string) {
    const hasCurrentWork = Boolean(
      draft.userRequest.trim()
      || Object.values(draft.taskFields).some((value) => value.trim())
      || draft.style.name.trim()
      || draft.style.description.trim(),
    )
    return !hasCurrentWork || window.confirm(`套用“${name}”会替换本次创作要求、类目和风格；产品档案、产品事实与参考图会保留。继续吗？`)
  }

  function clearGeneratedResult() {
    setEditableVariants(null)
    setQuickResult(null)
    setResult(null)
    setResultReferenceFiles(null)
    setResultDirty(false)
    setRightView('result')
  }

  async function applyTemplate(template: PromptLibraryTemplate) {
    if (!confirmTemplateReplacement(template.name)) return

    setAssetBusy(`apply-template-${template.id}`)
    setDraft((current) => {
      const copyMode = template.copyMode || (copyValues(current.copy).length ? 'exact' : 'none')
      return {
        ...current,
        category: template.category,
        stylePresetId: '',
        userRequest: template.userRequest,
        taskFields: { ...(template.taskFields || {}) },
        style: {
          name: template.style?.name || template.name,
          description: template.style?.description || template.summary,
          lighting: template.style?.lighting || '',
          composition: template.style?.composition || '',
          palette: template.style?.palette || '',
          camera: template.style?.camera || '',
          forbidden: [...(template.style?.forbidden || [])],
        },
        copy: copyForMode(current.copy, copyMode),
        parameters: { ...current.parameters, ...template.parameters },
      }
    })
    clearGeneratedResult()
    setFeedback({ tone: 'success', message: `已套用“${template.name}”。产品事实与参考图保持不变，请补充本次细节后生成提示词。` })
    setAssetBusy('')
  }

  async function applyGardenPrompt(prompt: PromptGardenPrompt) {
    if (prompt.text.length > 4_000) throw new Error('这条在线模板超过当前工作台的 4000 字上限，无法完整套用。')
    if (!confirmTemplateReplacement(prompt.title)) return false

    const category = gardenPromptCategory(prompt)
    setDraft((current) => {
      const copyMode = copyValues(current.copy).length ? 'exact' : 'none'
      return {
        ...current,
        category,
        stylePresetId: '',
        userRequest: prompt.text,
        taskFields: {},
        style: {
          name: prompt.title,
          description: prompt.summary || '按套用的公开模板执行，保持主体、构图与画面要求一致。',
          lighting: '',
          composition: '',
          palette: '',
          camera: '',
          forbidden: [],
        },
        copy: copyForMode(current.copy, copyMode),
      }
    })
    clearGeneratedResult()
    const variables = prompt.variables.map((variable) => `{{${variable.name}}}`).join('、')
    setFeedback({
      tone: variables ? 'neutral' : 'success',
      message: variables
        ? `已套用“${prompt.title}”。请在中间的创作要求里替换 ${variables}，再生成提示词。`
        : `已套用“${prompt.title}”。产品事实与参考图保持不变，可继续生成提示词。`,
    })
    return true
  }

  async function toggleLibraryFavorite(templateId: string, favorite: boolean) {
    setAssetBusy(`library-favorite-${templateId}`)
    try {
      const saved = await onToggleLibraryFavorite(templateId, favorite)
      setWorkspace((current) => ({ ...current, libraryFavorites: saved.libraryFavorites }))
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '模板收藏状态更新失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function reuseHistory(item: PromptHistoryItem) {
    clearProductReferences()
    clearStyleReferences()
    setDraft({
      category: item.request.category,
      productProfileId: '',
      stylePresetId: '',
      userRequest: item.request.userRequest,
      productFacts: item.request.productFacts,
      style: item.request.style,
      copy: item.request.copy,
      parameters: item.request.parameters,
      taskFields: {},
      factsConfirmed: true,
    })
    setEditableVariants(variantsForEditing(item.variants))
    setSelectedVariant(item.selectedVariantKey)
    setResult({ variants: item.variants, riskChecks: item.riskChecks, createdAt: item.createdAt, model: item.model })
    setQuickResult(null)
    setResultReferenceFiles(null)
    setResultDirty(false)
    setRightView('result')
    setFeedback({ tone: 'neutral', message: `已复用“${item.name}”的文字内容。历史记录不保存参考图，当前参考图已清空；请重新选择参考图并重新生成后再同步。` })
  }

  async function toggleFavorite(historyId: string, favorite: boolean) {
    setAssetBusy(`favorite-${historyId}`)
    try {
      const saved = await onToggleFavoriteHistory(historyId, favorite)
      setWorkspace((current) => ({ ...current, history: current.history.map((entry) => entry.id === saved.id ? saved : entry) }))
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '收藏状态更新失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function renameHistory(historyId: string, name: string) {
    setAssetBusy(`rename-${historyId}`)
    try {
      const saved = await onRenameHistory(historyId, name)
      setWorkspace((current) => ({ ...current, history: current.history.map((entry) => entry.id === saved.id ? saved : entry) }))
      setFeedback({ tone: 'success', message: '提示词名称已更新。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '重命名失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  async function deleteHistory(historyId: string) {
    setAssetBusy(`delete-${historyId}`)
    try {
      await onDeleteHistory(historyId)
      setWorkspace((current) => ({ ...current, history: current.history.filter((entry) => entry.id !== historyId) }))
      setFeedback({ tone: 'success', message: '历史提示词已删除。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '历史提示词删除失败。' })
    } finally {
      setAssetBusy('')
    }
  }

  const activeCategory = categories.find((item) => item.id === draft.category) || categories[0]
  const ActiveCategoryIcon = activeCategory.icon
  const currentVariant = editableVariants?.[selectedVariant]
  const activeChannelState = config.channelStates?.[config.channel]
  const promptModelConfigured = activeChannelState?.hasApiKey ?? config.hasApiKey
  const promptTestStatus = activeChannelState?.testStates?.prompt.lastTestStatus
    || (activeChannelState?.lastTestTarget === 'prompt' ? activeChannelState.lastTestStatus : null)
  const promptModelStatus = promptTestStatus === 'success'
    ? '已验证'
    : promptTestStatus === 'failed'
      ? '验证失败'
      : promptModelConfigured
        ? '已配置'
        : '未配置'
  const channelLabel = config.channel === 'fast' ? '高速通道' : config.channel === 'custom' ? '自定义通道' : '稳定通道'

  if (mode === 'simple' && presentation !== 'professional') {
    return (
      <div className="min-w-0 space-y-4">
        <FeedbackBanner feedback={feedback} />

        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
          <section className="creative-surface min-w-0 overflow-hidden rounded-md border border-white/70 shadow-sm" aria-labelledby="quick-prompt-title">
            <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-2">
              <h3 id="quick-prompt-title" className="text-base font-semibold text-slate-950">你想做什么图？</h3>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => { setMode('advanced'); setRightView('history') }} className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  <History className="h-4 w-4" />历史
                </button>
                <button type="button" onClick={() => setMode('advanced')} className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  <SlidersHorizontal className="h-4 w-4" />高级
                </button>
              </div>
            </div>
            <div className="grid gap-5 p-5">
              <label className="grid gap-2 text-sm font-medium text-slate-800">
                你的要求
                <Textarea
                  autoFocus
                  value={quickUserRequest}
                  onChange={(event) => setQuickUserRequest(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void generateQuickPrompt()
                    }
                  }}
                  placeholder="例如：把这个电压力锅做成干净的白底主图，产品保持原样，背景纯白，阴影自然。"
                  className="min-h-28 resize-y text-base leading-7 sm:min-h-36"
                  maxLength={4000}
                />
                <span className="flex justify-between text-xs font-normal text-slate-400"><span>Ctrl/⌘ + Enter 生成</span><span>{quickUserRequest.length}/4000</span></span>
              </label>

              <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <button type="button" onClick={onOpenModelSettings} className={`order-2 flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 text-left transition sm:order-1 ${promptModelConfigured ? 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/40' : 'border-amber-200 bg-amber-50 hover:bg-amber-100/70'}`}>
                  <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${promptModelConfigured ? 'bg-blue-50 text-blue-700' : 'bg-white text-amber-700'}`}><Settings2 className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{channelLabel} · {config.model || '未选择模型'}</span><span className={`mt-0.5 block text-xs ${promptTestStatus === 'failed' || !promptModelConfigured ? 'text-amber-700' : 'text-slate-500'}`}>{promptModelStatus} · 去设置中心</span></span>
                </button>
                <Button type="button" onClick={() => void generateQuickPrompt()} disabled={quickGenerating || !quickUserRequest.trim()} className="order-1 h-12 min-w-44 px-5 text-sm shadow-sm sm:order-2">
                  {quickGenerating ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <WandSparkles className="h-4 w-4" />}
                  {quickGenerating ? '正在整理提示词…' : '帮我写提示词'}
                </Button>
              </div>

              <div className="flex flex-wrap gap-2" aria-label="常用要求示例">
                {[
                  '做成干净的白底主图，产品保持原样',
                  '换成明亮的厨房场景，产品不要变形',
                  '做一张有主题、有信息层次的活动海报，文字清晰有设计感',
                  '精修产品质感，清理杂乱反光和污渍',
                ].map((example) => <button key={example} type="button" onClick={() => setQuickUserRequest(example)} className="rounded-md bg-slate-100 px-3 py-2 text-left text-xs text-slate-600 transition hover:bg-blue-50 hover:text-blue-700">{example}</button>)}
              </div>

              <div className="border-t border-slate-100 pt-3">
                <button type="button" onClick={() => setQuickReferencesOpen((value) => !value)} className="flex h-10 w-full items-center justify-between rounded-md px-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-blue-700" aria-expanded={quickReferencesOpen}>
                  <span className="flex items-center gap-2"><Images className="h-4 w-4 text-slate-400" />添加参考图 <span className="text-xs font-normal text-slate-400">可选 · {productReferences.length}/3</span></span>
                  <span className="text-xs font-normal text-slate-400">{quickReferencesOpen ? '收起' : '展开'}</span>
                </button>
                {quickReferencesOpen && <div className="pt-3">
                  <ReferenceImagePicker
                    images={productReferences}
                    maxFiles={3}
                    disabled={!filesHydrated || quickGenerating}
                    onChange={setProductReferences}
                    onError={(message) => setFeedback({ tone: 'error', message })}
                  />
                </div>}
              </div>
            </div>
          </section>

          <section className="creative-surface min-w-0 overflow-hidden rounded-md border border-white/70 shadow-sm" aria-labelledby="quick-result-title">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div>
                <h3 id="quick-result-title" className="text-base font-semibold text-slate-950">AI 推荐方案</h3>
                {currentVariant && <p className="mt-1 text-xs text-slate-500">{activeCategory.label} · {variantMeta[selectedVariant].label} · {result?.model}</p>}
              </div>
              {currentVariant && <button type="button" onClick={() => void copyVariant()} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"><Copy className="h-3.5 w-3.5" />复制</button>}
            </div>

            {!currentVariant ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center px-8 text-center">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Sparkles className="h-6 w-6" /></span>
                <h4 className="mt-4 text-sm font-semibold text-slate-900">提示词会出现在这里</h4>
                <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">左边说清楚你想要的效果，AI 会判断任务类型并补全专业规范。</p>
              </div>
            ) : (
              <div className="grid gap-4 p-5">
                <label className="grid gap-2 text-sm font-medium text-slate-800">
                  创意方案（可以直接修改）
                  <Textarea value={currentVariant.prompt} onChange={(event) => updateVariant({ prompt: event.target.value })} className="min-h-64 resize-y text-sm leading-6" />
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button type="button" variant="secondary" onClick={() => void copyVariant()} className="h-11"><Copy className="h-4 w-4" />复制方案</Button>
                  <Button type="button" onClick={syncVariant} className="h-11"><WandSparkles className="h-4 w-4" />同步到 AI 创作</Button>
                </div>

                <details className="group border-t border-slate-100 pt-3">
                  <summary className="cursor-pointer list-none py-2 text-sm font-medium text-slate-700 hover:text-blue-700">查看排除要求、其他方案和检查结果</summary>
                  <div className="grid gap-4 pt-2">
                    <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="提示词方案">
                      {(Object.keys(variantMeta) as PromptVariantKey[]).map((key) => <button key={key} type="button" role="tab" aria-selected={selectedVariant === key} onClick={() => setSelectedVariant(key)} className={`min-h-10 rounded-md px-2 text-xs font-medium ${selectedVariant === key ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'}`}>{variantMeta[key].label}</button>)}
                    </div>
                    <Field label="排除要求（可以修改）" value={currentVariant.negativePrompt} onChange={(value) => updateVariant({ negativePrompt: value })} multiline />
                    {quickResult?.warnings.length ? <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><strong>请留意：</strong>{quickResult.warnings.join('；')}</div> : null}
                    <div className="grid gap-2">
                      {resultDirty ? <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />内容已修改，原检查结果已失效；同步前请人工确认。</div> : result?.riskChecks.filter((item) => item.status !== 'pass').map((item) => <div key={item.id} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5 ${item.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><strong>{item.label}：</strong>{item.message}</span></div>)}
                      {!resultDirty && result && !result.riskChecks.some((item) => item.status !== 'pass') && <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" />产品、文字和修改边界检查通过</div>}
                    </div>
                  </div>
                </details>
              </div>
            )}
          </section>
        </div>

      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-md border border-blue-100 bg-blue-50 px-4 py-3">
        <div><p className="text-sm font-semibold text-blue-950">{presentation === 'professional' ? '专业提示词' : '高级模式'}</p>{presentation !== 'professional' && <p className="mt-0.5 text-xs text-blue-700">用于需要逐项控制产品事实、风格、文案和修改边界的任务。</p>}</div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" onClick={onOpenModelSettings} className="h-9 shrink-0 px-2 sm:px-4" aria-label="去设置中心配置模型" title="去设置中心配置模型"><Settings2 className="h-4 w-4" /><span className="hidden sm:inline">设置中心</span></Button>
          {presentation === 'professional'
            ? <Button type="button" variant="secondary" onClick={onExitProfessional} className="h-9 shrink-0 px-2 sm:px-4" aria-label="返回 AI 创作" title="返回 AI 创作"><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">返回 AI 创作</span></Button>
            : <Button type="button" variant="secondary" onClick={() => setMode('simple')} className="h-9 shrink-0 px-2 sm:px-4" aria-label="返回简单模式" title="返回简单模式"><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">返回简单模式</span></Button>}
        </div>
      </div>
      <section className="creative-surface overflow-hidden rounded-md border border-white/70 shadow-sm" aria-labelledby="prompt-category-title">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 id="prompt-category-title" className="text-base font-semibold text-slate-950">先选本次要完成的图片任务</h2><p className="mt-0.5 text-xs text-slate-500">不同类目使用独立约束，减少偏题、产品变形和文字错误。</p></div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700"><ShieldCheck className="h-3.5 w-3.5" />草稿自动保存</span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4 xl:grid-cols-7" role="tablist" aria-label="提示词任务类目">
          {categories.map(({ id, label, description, icon: Icon }) => {
            const selected = draft.category === id
            return <button key={id} type="button" role="tab" aria-selected={selected} onClick={() => selectCategory(id)} className={`group min-h-20 bg-white/80 px-3 py-3 text-left outline-none transition focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${selected ? 'bg-blue-50/90' : 'hover:bg-white'}`}><span className={`flex items-center gap-2 text-sm font-semibold ${selected ? 'text-blue-800' : 'text-slate-800'}`}><Icon className={`h-4 w-4 ${selected ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600'}`} />{label}</span><span className="mt-1.5 block text-[11px] leading-4 text-slate-500">{description}</span></button>
          })}
        </div>
      </section>

      <FeedbackBanner feedback={feedback} />

      <div className="grid min-w-0 items-start gap-3 xl:min-h-[calc(100dvh-6rem)] xl:grid-cols-[minmax(240px,0.78fr)_minmax(340px,1.08fr)_minmax(320px,1fr)]">
        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <aside className="creative-surface scrollbar-thin min-w-0 overflow-hidden rounded-md border border-white/70 shadow-sm xl:max-h-[calc(100dvh-8rem)] xl:overflow-y-auto" aria-label="产品与风格资产">
          <div className="border-b border-slate-100 px-4 py-3"><SectionTitle title="产品与风格资产" note="产品图锁定身份，风格图只影响场景和构图。" /></div>

          <div className="space-y-4 border-b border-slate-100 p-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="prompt-product-profile">产品档案</label>
              <select id="prompt-product-profile" value={draft.productProfileId} onChange={(event) => selectProductProfile(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100">
                <option value="">新建或手动填写</option>
                {workspace.productProfiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <ReferenceImagePicker images={productReferences} maxFiles={3} disabled={!filesHydrated || recognizing} onChange={(images) => { setProductReferences(images); updateDraft({ factsConfirmed: false }) }} onError={(message) => setFeedback({ tone: 'error', message })} />
            <Button type="button" variant="secondary" onClick={() => void analyzeProduct()} disabled={recognizing || !productReferences.length} className="w-full">{recognizing ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ScanSearch className="h-4 w-4" />}AI 识别产品事实</Button>
          </div>

          <details open className="group border-b border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"><span>产品事实确认</span><span className={`rounded-md px-2 py-1 text-[11px] font-medium ${draft.factsConfirmed ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{draft.factsConfirmed ? '已确认' : '待确认'}</span></summary>
            <div className="grid gap-3 px-4 pb-4">
              <Field label="产品类型" value={draft.productFacts.productType} onChange={(value) => updateFacts({ productType: value })} placeholder="例如：电压力锅" />
              <Field label="外形结构" value={draft.productFacts.appearance} onChange={(value) => updateFacts({ appearance: value })} placeholder="描述轮廓、比例和关键结构" multiline />
              <Field label="颜色与材质" value={draft.productFacts.colorsMaterials} onChange={(value) => updateFacts({ colorsMaterials: value })} placeholder="例如：黑色上盖、不锈钢拉丝机身" multiline />
              <Field label="零部件（每行一项）" value={textLines(draft.productFacts.components)} onChange={(value) => updateFacts({ components: lines(value) })} multiline />
              <Field label="Logo" value={draft.productFacts.logo} onChange={(value) => updateFacts({ logo: value })} placeholder="没有则填写“无”" />
              <Field label="已有文字（每行一项）" value={textLines(draft.productFacts.existingText)} onChange={(value) => updateFacts({ existingText: lines(value) })} multiline />
              <Field label="必须保留（每行一项）" value={textLines(draft.productFacts.mustPreserve)} onChange={(value) => updateFacts({ mustPreserve: lines(value) })} multiline />
              <Field label="禁止修改（每行一项）" value={textLines(draft.productFacts.forbiddenChanges)} onChange={(value) => updateFacts({ forbiddenChanges: lines(value) })} multiline />
              <Button type="button" onClick={confirmFacts} variant={draft.factsConfirmed ? 'secondary' : 'primary'} className="w-full">{draft.factsConfirmed ? <Check className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}{draft.factsConfirmed ? '产品事实已确认' : '核对无误，确认产品事实'}</Button>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                <Input value={productProfileName} onChange={(event) => setProductProfileName(event.target.value)} placeholder="档案名称" aria-label="产品档案名称" />
                <button type="button" onClick={() => void saveProductProfile()} disabled={Boolean(assetBusy)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50" title="保存产品档案" aria-label="保存产品档案">{assetBusy === 'product-save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}</button>
                <button type="button" onClick={() => void deleteProductProfile()} disabled={!draft.productProfileId || Boolean(assetBusy)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-35" title="删除产品档案" aria-label="删除产品档案">{assetBusy === 'product-delete' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button>
              </div>
            </div>
          </details>

          <details className="group">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50">风格方案与参考图</summary>
            <div className="grid gap-3 px-4 pb-4">
              <select value={draft.stylePresetId} onChange={(event) => selectStylePreset(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100" aria-label="选择风格方案"><option value="">新建或手动填写</option>{workspace.stylePresets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
              <ReferenceImagePicker images={styleReferences} maxFiles={1} disabled={!filesHydrated} onChange={setStyleReferences} onError={(message) => setFeedback({ tone: 'error', message })} />
              <p className="rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">风格图只参考场景、光线和构图，不能改变产品结构、颜色、Logo 或原有文字。</p>
              <Field label="方案名称" value={draft.style.name} onChange={(value) => updateStyle({ name: value })} placeholder="例如：明亮厨房 · 自然窗光" />
              <Field label="整体风格" value={draft.style.description} onChange={(value) => updateStyle({ description: value })} multiline />
              <Field label="光线" value={draft.style.lighting} onChange={(value) => updateStyle({ lighting: value })} />
              <Field label="构图" value={draft.style.composition} onChange={(value) => updateStyle({ composition: value })} />
              <Field label="色彩" value={draft.style.palette} onChange={(value) => updateStyle({ palette: value })} />
              <Field label="镜头" value={draft.style.camera} onChange={(value) => updateStyle({ camera: value })} />
              <Field label="风格禁用项（每行一项）" value={textLines(draft.style.forbidden)} onChange={(value) => updateStyle({ forbidden: lines(value) })} multiline />
              <div className="grid grid-cols-[1fr_auto] gap-2"><Button type="button" variant="secondary" onClick={() => void saveStylePreset()} disabled={Boolean(assetBusy)}>{assetBusy === 'style-save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存风格方案</Button><button type="button" onClick={() => void deleteStylePreset()} disabled={!draft.stylePresetId || Boolean(assetBusy)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-35" title="删除风格方案" aria-label="删除风格方案">{assetBusy === 'style-delete' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button></div>
            </div>
          </details>
        </aside>
        </div>

        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <main className="creative-surface scrollbar-thin min-w-0 overflow-hidden rounded-md border border-white/70 shadow-sm xl:max-h-[calc(100dvh-8rem)] xl:overflow-y-auto" aria-label="结构化创作要求">
          <div className="border-b border-slate-100 px-4 py-3"><div className="flex items-center gap-2"><ActiveCategoryIcon className="h-4 w-4 text-blue-600" /><SectionTitle title={activeCategory.label} note={activeCategory.description} /></div></div>
          <div className="grid gap-4 p-4">
            <Field label="这次具体想做什么" value={draft.userRequest} onChange={(value) => updateDraft({ userRequest: value })} placeholder="只描述你想得到的结果；产品一致性、文字防错等规范会自动加入。" multiline />

            <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
              {taskFields[draft.category].map((field) => <Field key={field.key} label={field.label} value={draft.taskFields[field.key] || ''} onChange={(value) => updateTaskField(field.key, value)} placeholder={field.placeholder} multiline={field.multiline} />)}
            </div>

            {['campaign-poster', 'detail-page'].includes(draft.category) && (
              <section className="border-t border-slate-100 pt-4">
                <SectionTitle title="画面文字" note="AI 会先自由策划；只有必须逐字固定的文字才需要在这里填写。" />
                <div className="mt-3 grid gap-2 rounded-md bg-slate-100 p-1 sm:grid-cols-3">
                  <button type="button" aria-pressed={draft.copy.mode === 'none'} onClick={() => setDraft((current) => ({ ...current, copy: copyForMode(current.copy, 'none') }))} className={`min-h-12 rounded-md px-3 py-2 text-left text-sm font-medium ${draft.copy.mode === 'none' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                    AI 自由策划
                    <span className="mt-0.5 block text-[11px] font-normal text-slate-500">根据主题决定文案与层级</span>
                  </button>
                  <button type="button" aria-pressed={draft.copy.mode === 'exact'} onClick={() => setDraft((current) => ({ ...current, copy: copyForMode(current.copy, 'exact') }))} className={`min-h-12 rounded-md px-3 py-2 text-left text-sm font-medium ${draft.copy.mode === 'exact' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                    固定准确文字
                    <span className="mt-0.5 block text-[11px] font-normal text-slate-500">每行一条，逐字执行</span>
                  </button>
                  <button type="button" aria-pressed={draft.copy.mode === 'reserved'} onClick={() => setDraft((current) => ({ ...current, copy: copyForMode(current.copy, 'reserved') }))} className={`min-h-12 rounded-md px-3 py-2 text-left text-sm font-medium ${draft.copy.mode === 'reserved' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                    无字底图
                    <span className="mt-0.5 block text-[11px] font-normal text-slate-500">只留后期排版区域</span>
                  </button>
                </div>
                {draft.copy.mode === 'exact' && (
                  <div className="mt-3 grid gap-3">
                    <Field
                      label="需要逐字生成的文案（每行一条）"
                      value={copyText(draft.copy)}
                      onChange={(value) => setDraft((current) => ({ ...current, copy: copyWithText(current.copy, value) }))}
                      placeholder={'例如：\n夏日轻享\n清爽一刻，自然发生\n到手价 ¥459'}
                      multiline
                    />
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">只把必须准确出现的文字放进来。AI 会自行决定每条文字的大小、层级和位置；价格、品牌、活动规则和功效仍需你确认真实。</p>
                  </div>
                )}
              </section>
            )}

            <section className="border-t border-slate-100 pt-4"><SectionTitle title="推荐输出参数" note="同步到生图页后仍可调整，不会在这里直接产生费用。" /><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><label className="grid gap-1.5 text-xs font-medium text-slate-600">画面比例<select value={draft.parameters.ratio} onChange={(event) => setDraft((current) => ({ ...current, parameters: { ...current.parameters, ratio: event.target.value as typeof current.parameters.ratio } }))} className="h-10 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800"><option>1:1</option><option>3:4</option><option>4:3</option><option>16:9</option></select></label><label className="grid gap-1.5 text-xs font-medium text-slate-600">分辨率<select value={draft.parameters.resolution} onChange={(event) => setDraft((current) => ({ ...current, parameters: { ...current.parameters, resolution: event.target.value as typeof current.parameters.resolution } }))} className="h-10 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800"><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option></select></label><label className="grid gap-1.5 text-xs font-medium text-slate-600">质量<select value={draft.parameters.quality} onChange={(event) => setDraft((current) => ({ ...current, parameters: { ...current.parameters, quality: event.target.value as typeof current.parameters.quality } }))} className="h-10 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800"><option value="low">快速</option><option value="medium">标准</option><option value="high">精细</option></select></label><label className="grid gap-1.5 text-xs font-medium text-slate-600">背景<select value={draft.parameters.background} onChange={(event) => setDraft((current) => ({ ...current, parameters: { ...current.parameters, background: event.target.value as typeof current.parameters.background } }))} className="h-10 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800"><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></label></div></section>

            <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-slate-200 bg-white/95 p-4 backdrop-blur"><Button type="button" onClick={() => void generate()} disabled={generating} className="h-11 w-full text-sm shadow-sm">{generating ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <WandSparkles className="h-4 w-4" />}{generating ? '正在生成并检查…' : '生成三套提示词'}</Button><p className="mt-2 text-center text-[11px] leading-4 text-slate-500">只生成提示词，不会自动生图；生成期间仍可编辑其他内容。</p></div>
          </div>
        </main>
        </div>

        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <aside className="creative-surface scrollbar-thin min-w-0 overflow-hidden rounded-md border border-white/70 shadow-sm xl:max-h-[calc(100dvh-8rem)] xl:overflow-y-auto" aria-label="提示词结果与资产库">
          <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 p-1"><button type="button" onClick={() => setRightView('result')} className={`inline-flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium ${rightView === 'result' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}><Sparkles className="h-4 w-4" />生成结果</button><button type="button" onClick={() => setRightView('history')} className={`inline-flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium ${rightView === 'history' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}><FileText className="h-4 w-4" />提示词库 {workspace.history.length ? `(${workspace.history.length})` : ''}</button></div>

          {rightView === 'result' ? <div>
            <div className="grid grid-cols-3 border-b border-slate-100 bg-white" role="tablist" aria-label="提示词方案">
              {(Object.keys(variantMeta) as PromptVariantKey[]).map((key) => <button key={key} type="button" role="tab" aria-selected={selectedVariant === key} onClick={() => setSelectedVariant(key)} className={`min-h-16 border-b-2 px-2 py-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${selectedVariant === key ? 'border-blue-600 bg-blue-50/60 text-blue-800' : 'border-transparent text-slate-600 hover:bg-slate-50'}`}><span className="block text-sm font-semibold">{variantMeta[key].label}</span><span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{variantMeta[key].note}</span></button>)}
            </div>
            {!currentVariant ? <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center"><span className="inline-flex h-12 w-12 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Sparkles className="h-6 w-6" /></span><h3 className="mt-4 text-sm font-semibold text-slate-900">等待生成提示词</h3><p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">确认产品事实并填写本次要求后，系统会生成稳妥、商业增强和创意三套方案。</p></div> : <div className="grid gap-4 p-4">
              <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-900">{currentVariant.title || variantMeta[selectedVariant].label}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{currentVariant.rationale}</p></div><button type="button" onClick={() => void copyVariant()} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-800" title="复制当前方案" aria-label="复制当前方案"><Copy className="h-4 w-4" /></button></div>
              <Field label="创意方案（可修改）" value={currentVariant.prompt} onChange={(value) => updateVariant({ prompt: value })} multiline />
              <Field label="排除要求（可修改）" value={currentVariant.negativePrompt} onChange={(value) => updateVariant({ negativePrompt: value })} multiline />
              {currentVariant.recommendedParameters && <button type="button" onClick={() => setDraft((current) => ({ ...current, parameters: { ...current.parameters, ...currentVariant.recommendedParameters } }))} className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-left text-xs text-blue-800 hover:border-blue-200"><span className="font-semibold">应用本方案建议参数</span><span className="mt-0.5 block text-blue-600">{Object.entries(currentVariant.recommendedParameters).map(([key, value]) => `${key}: ${value}`).join(' · ')}</span></button>}
              <section className="border-t border-slate-100 pt-4"><div className="flex items-center justify-between gap-3"><SectionTitle title="规则检查" note={result ? `${result.model} · ${formatDate(result.createdAt)}` : undefined} />{result && <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${resultDirty ? 'bg-amber-50 text-amber-800' : result.riskChecks.some((item) => item.status === 'error') ? 'bg-red-50 text-red-700' : result.riskChecks.some((item) => item.status === 'warning') ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{resultDirty ? '检查已失效' : result.riskChecks.filter((item) => item.status !== 'pass').length ? `${result.riskChecks.filter((item) => item.status !== 'pass').length} 项待确认` : '全部通过'}</span>}</div><div className="mt-3 grid gap-2">{resultDirty ? <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" role="alert"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><strong>内容已修改：</strong>原规则检查只适用于生成时的文字，现已失效。重新生成可获得新检查；直接同步时系统会要求你再次人工确认。</span></div> : result?.riskChecks.map((item) => <div key={item.id} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5 ${item.status === 'error' ? 'bg-red-50 text-red-700' : item.status === 'warning' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>{item.status === 'pass' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}<span><strong>{item.label}：</strong>{item.message}</span></div>)}</div></section>
              {resultReferenceFiles ? <p className="rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600"><strong className="text-slate-800">结果参考图已锁定：</strong>产品图 {resultReferenceFiles.productReferenceFiles.length} 张，风格图 {resultReferenceFiles.styleReferenceFiles.length} 张。页面上重新选图不会改写这次结果。</p> : <p className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" role="alert"><strong>历史记录不带参考图：</strong>请重新选择参考图并重新生成，避免把文字方案配到错误产品。</p>}
              <Button type="button" onClick={syncVariant} className="h-11 w-full"><WandSparkles className="h-4 w-4" />同步到 AI 创作</Button><p className="-mt-2 text-center text-[11px] text-slate-500">只填入内容与参数，仍需人工确认后开始生成。</p>
            </div>}
          </div> : <PromptLibraryPanel
            workspaceLoading={workspaceLoading}
            history={workspace.history}
            libraryFavoriteIds={workspace.libraryFavorites}
            assetBusy={assetBusy}
            onApplyTemplate={applyTemplate}
            onApplyGardenPrompt={applyGardenPrompt}
            onToggleLibraryFavorite={toggleLibraryFavorite}
            onReuseHistory={reuseHistory}
            onToggleHistoryFavorite={toggleFavorite}
            onRenameHistory={renameHistory}
            onDeleteHistory={deleteHistory}
          />}
        </aside>
        </div>
      </div>
    </div>
  )
}
