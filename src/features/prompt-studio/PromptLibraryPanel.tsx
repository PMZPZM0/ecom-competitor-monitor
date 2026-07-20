import { useMemo, useState } from 'react'
import {
  BookOpenText,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  FileText,
  Heart,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  builtInPromptTemplates,
  promptLibraryGroups,
  promptTemplateSearchText,
  type PromptLibraryGroup,
  type PromptLibraryTemplate,
} from './promptLibrary'
import { PromptGardenPanel } from './PromptGardenPanel'
import type { PromptGardenPrompt } from './promptGarden'
import { visibleNegativePrompt, visiblePrompt } from './promptLayers'
import type { PromptCategory, PromptHistoryItem, PromptVariantKey } from './types'

type LibraryView = 'templates' | 'garden' | 'history'
type GroupFilter = 'all' | PromptLibraryGroup

export type PromptLibraryPanelProps = {
  workspaceLoading: boolean
  history: PromptHistoryItem[]
  libraryFavoriteIds: string[]
  assetBusy: string
  onApplyTemplate: (template: PromptLibraryTemplate) => Promise<void>
  onApplyGardenPrompt: (prompt: PromptGardenPrompt) => Promise<boolean>
  onToggleLibraryFavorite: (templateId: string, favorite: boolean) => Promise<void>
  onReuseHistory: (item: PromptHistoryItem) => Promise<void>
  onToggleHistoryFavorite: (historyId: string, favorite: boolean) => Promise<void>
  onRenameHistory: (historyId: string, name: string) => Promise<void>
  onDeleteHistory: (historyId: string) => Promise<void>
}

const categoryLabels: Record<PromptCategory, string> = {
  'white-background': '白底主图',
  'product-scene': '产品场景',
  'campaign-poster': '活动海报',
  'detail-page': '详情配图',
  'local-edit': '局部改图',
  'background-swap': '换背景',
  'product-retouch': '产品精修',
}

const variantLabels: Record<PromptVariantKey, string> = {
  safe: '稳妥执行',
  commercial: '商业增强',
  creative: '创意方案',
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function historySearchText(item: PromptHistoryItem) {
  return [
    item.name,
    categoryLabels[item.category],
    variantLabels[item.selectedVariantKey],
    ...Object.values(item.variants).flatMap((variant) => [variant.title, visiblePrompt(variant.prompt), visibleNegativePrompt(variant.negativePrompt), variant.rationale]),
  ].join(' ').toLocaleLowerCase('zh-CN')
}

export function PromptLibraryPanel({
  workspaceLoading,
  history,
  libraryFavoriteIds,
  assetBusy,
  onApplyTemplate,
  onApplyGardenPrompt,
  onToggleLibraryFavorite,
  onReuseHistory,
  onToggleHistoryFavorite,
  onRenameHistory,
  onDeleteHistory,
}: PromptLibraryPanelProps) {
  const [view, setView] = useState<LibraryView>('templates')
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [group, setGroup] = useState<GroupFilter>('all')
  const [expandedTemplateId, setExpandedTemplateId] = useState('')
  const [renamingHistoryId, setRenamingHistoryId] = useState('')
  const [renameValue, setRenameValue] = useState('')

  const favoriteTemplateIds = useMemo(() => new Set(libraryFavoriteIds), [libraryFavoriteIds])
  const keyword = search.trim().toLocaleLowerCase('zh-CN')
  const visibleTemplates = useMemo(() => builtInPromptTemplates.filter((template) => {
    if (group !== 'all' && template.group !== group) return false
    if (favoritesOnly && !favoriteTemplateIds.has(template.id)) return false
    return !keyword || promptTemplateSearchText(template).includes(keyword)
  }), [favoriteTemplateIds, favoritesOnly, group, keyword])
  const visibleHistory = useMemo(() => history.filter((item) => {
    if (favoritesOnly && !item.isFavorite) return false
    return !keyword || historySearchText(item).includes(keyword)
  }), [favoritesOnly, history, keyword])
  const busy = Boolean(assetBusy)

  async function submitRename(item: PromptHistoryItem) {
    const name = renameValue.trim()
    if (!name || name === item.name) {
      setRenamingHistoryId('')
      return
    }
    await onRenameHistory(item.id, name)
    setRenamingHistoryId('')
  }

  async function confirmDelete(item: PromptHistoryItem) {
    if (!window.confirm(`删除提示词“${item.name}”？`)) return
    await onDeleteHistory(item.id)
  }

  return (
    <section className="min-w-0" aria-label="提示词库">
      <div className="grid grid-cols-3 bg-slate-50 p-1" role="tablist" aria-label="提示词库内容">
        <button
          id="prompt-library-templates-tab"
          type="button"
          role="tab"
          aria-label={`精选模板，共 ${builtInPromptTemplates.length} 个`}
          aria-selected={view === 'templates'}
          aria-controls="prompt-library-templates"
          title="精选模板"
          onClick={() => setView('templates')}
          className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'templates' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          <BookOpenText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">精选</span>
        </button>
        <button
          id="prompt-library-garden-tab"
          type="button"
          role="tab"
          aria-label="在线灵感库"
          aria-selected={view === 'garden'}
          aria-controls="prompt-library-garden"
          title="在线灵感库"
          onClick={() => setView('garden')}
          className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'garden' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          <Compass className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">灵感</span>
        </button>
        <button
          id="prompt-library-history-tab"
          type="button"
          role="tab"
          aria-label={`我的生成，共 ${history.length} 条`}
          aria-selected={view === 'history'}
          aria-controls="prompt-library-history"
          title="我的生成"
          onClick={() => setView('history')}
          className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'history' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">我的</span>
        </button>
      </div>

      <div className={`grid gap-2 border-y border-slate-100 px-3 py-3 ${view === 'garden' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_auto]'}`}>
        <label className="relative min-w-0">
          <span className="sr-only">搜索提示词</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={view === 'templates' ? '搜索模板、用途或标签' : view === 'garden' ? '搜索当前一批在线模板' : '搜索名称或提示词'}
            className="h-9 pl-8 text-xs"
          />
        </label>
        {view !== 'garden' && <button
          type="button"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((current) => !current)}
          className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${favoritesOnly ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          <Heart className={`h-3.5 w-3.5 ${favoritesOnly ? 'fill-current' : ''}`} />
          <span className="hidden sm:inline xl:hidden 2xl:inline">收藏</span>
        </button>}
      </div>

      {view === 'templates' ? (
        <div id="prompt-library-templates" role="tabpanel" aria-labelledby="prompt-library-templates-tab">
          <label className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-[11px] font-medium text-slate-500">
            <span className="shrink-0">用途类目</span>
            <select
              value={group}
              onChange={(event) => setGroup(event.target.value as GroupFilter)}
              className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {promptLibraryGroups.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>

          {visibleTemplates.length ? visibleTemplates.map((template) => {
            const favorite = favoriteTemplateIds.has(template.id)
            const expanded = expandedTemplateId === template.id
            const favoriteBusy = assetBusy === `library-favorite-${template.id}`
            return (
              <article key={template.id} className="border-b border-slate-100 px-3 py-3 last:border-b-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <h3 className="truncate text-sm font-semibold text-slate-900">{template.name}</h3>
                      {template.featured && <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">精选</span>}
                    </div>
                    <p className="mt-1 text-[11px] font-medium text-slate-500">{categoryLabels[template.category]}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={favorite ? `取消收藏${template.name}` : `收藏${template.name}`}
                    title={favorite ? '取消收藏' : '收藏'}
                    onClick={() => void onToggleLibraryFavorite(template.id, !favorite)}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${favorite ? 'bg-amber-50 text-amber-700' : 'text-slate-400 hover:bg-slate-50 hover:text-amber-600'}`}
                  >
                    {favoriteBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Heart className={`h-3.5 w-3.5 ${favorite ? 'fill-current' : ''}`} />}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-600">{template.summary}</p>
                <div className="mt-2 flex flex-wrap gap-1" aria-label="模板标签">
                  {template.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{tag}</span>)}
                </div>
                {expanded && <p id={`prompt-template-purpose-${template.id}`} className="mt-2 bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-700"><strong className="font-semibold text-slate-900">完整用途：</strong>{template.userRequest}</p>}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`prompt-template-purpose-${template.id}`}
                    onClick={() => setExpandedTemplateId(expanded ? '' : template.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md px-1 text-[11px] font-medium text-slate-500 outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {expanded ? '收起用途' : '查看用途'}
                  </button>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void onApplyTemplate(template)}>
                    {assetBusy === `apply-template-${template.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <WandSparkles className="h-3.5 w-3.5" />}
                    一键套用
                  </Button>
                </div>
              </article>
            )
          }) : <EmptyLibrary favoritesOnly={favoritesOnly} search={search} type="templates" />}
        </div>
      ) : view === 'garden' ? (
        <div id="prompt-library-garden" role="tabpanel" aria-labelledby="prompt-library-garden-tab">
          <PromptGardenPanel search={search} onApplyPrompt={onApplyGardenPrompt} />
        </div>
      ) : (
        <div id="prompt-library-history" role="tabpanel" aria-labelledby="prompt-library-history-tab">
          {workspaceLoading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 px-4 text-sm text-slate-500" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              正在读取提示词…
            </div>
          ) : visibleHistory.length ? visibleHistory.map((item) => {
            const selectedVariant = item.variants[item.selectedVariantKey]
            const favoriteBusy = assetBusy === `favorite-${item.id}`
            return (
              <article key={item.id} className="border-b border-slate-100 px-3 py-3 last:border-b-0">
                <div className="flex items-start justify-between gap-2">
                  {renamingHistoryId === item.id ? (
                    <div className="flex min-w-0 flex-1 gap-1.5">
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitRename(item)
                          if (event.key === 'Escape') setRenamingHistoryId('')
                        }}
                        aria-label={`重命名${item.name}`}
                        className="h-9 text-xs"
                      />
                      <button
                        type="button"
                        disabled={busy || !renameValue.trim()}
                        onClick={() => void submitRename(item)}
                        aria-label="保存名称"
                        title="保存名称"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white outline-none hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50"
                      >
                        {assetBusy === `rename-${item.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-slate-900">{item.name}</h3>
                      <p className="mt-1 text-[11px] text-slate-500">{categoryLabels[item.category]} · {variantLabels[item.selectedVariantKey]} · {formatDate(item.createdAt)}</p>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={item.isFavorite ? `取消收藏${item.name}` : `收藏${item.name}`}
                    title={item.isFavorite ? '取消收藏' : '收藏'}
                    onClick={() => void onToggleHistoryFavorite(item.id, !item.isFavorite)}
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 ${item.isFavorite ? 'bg-amber-50 text-amber-700' : 'text-slate-400 hover:bg-slate-50 hover:text-amber-600'}`}
                  >
                    {favoriteBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Heart className={`h-3.5 w-3.5 ${item.isFavorite ? 'fill-current' : ''}`} />}
                  </button>
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">{visiblePrompt(selectedVariant.prompt)}</p>
                <div className="mt-2 flex items-center gap-1">
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void onReuseHistory(item)}>
                    <RefreshCw className="h-3.5 w-3.5" />复用
                  </Button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setRenamingHistoryId(item.id); setRenameValue(item.name) }}
                    aria-label={`重命名${item.name}`}
                    title="重命名"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void confirmDelete(item)}
                    aria-label={`删除${item.name}`}
                    title="删除"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                  >
                    {assetBusy === `delete-${item.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </article>
            )
          }) : <EmptyLibrary favoritesOnly={favoritesOnly} search={search} type="history" />}
        </div>
      )}
    </section>
  )
}

function EmptyLibrary({ favoritesOnly, search, type }: { favoritesOnly: boolean; search: string; type: LibraryView }) {
  const filtered = Boolean(search.trim()) || favoritesOnly
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center">
      {type === 'templates' ? <BookOpenText className="h-6 w-6 text-slate-300" /> : <FileText className="h-6 w-6 text-slate-300" />}
      <p className="mt-3 text-sm font-medium text-slate-700">{filtered ? '没有匹配的提示词' : type === 'templates' ? '暂无精选模板' : '还没有生成记录'}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{filtered ? '换个关键词或关闭收藏筛选再试。' : type === 'history' ? '生成提示词后会自动保存在这里。' : '模板准备好后会显示在这里。'}</p>
    </div>
  )
}
