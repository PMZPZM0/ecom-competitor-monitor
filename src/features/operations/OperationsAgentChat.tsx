import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, Download, FolderOpen, Lightbulb, LoaderCircle, RefreshCw, Save, Settings2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import type { ModelConfig, OperationsWorkspace, QwenPawInstallTask } from '../../types/domain'
import { QwenPawChatEmbed } from './QwenPawChatEmbed'
import { OperationsThoughtDrawer } from './OperationsThoughtDrawer'

type OperationsAgentChatProps = {
  active: boolean
  workspace: OperationsWorkspace
  modelConfig: ModelConfig
  onOpenModelSettings: () => void
  onUpdateProfile: (payload: { principles?: string, dailyReport?: { enabled?: boolean, time?: string } }) => Promise<void>
  onDeleteReport: (id: string) => Promise<void>
}

const activeInstallStates = new Set(['resolving', 'downloading', 'verifying', 'installing'])

const idleInstallTask: QwenPawInstallTask = {
  state: 'idle',
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  message: '尚未开始安装。',
  error: '',
  version: '',
  installDirectory: '',
  startedAt: null,
  finishedAt: null,
}

function bytes(value: number) {
  if (!value) return ''
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

export function OperationsAgentChat({ active, workspace, modelConfig, onOpenModelSettings, onUpdateProfile, onDeleteReport }: OperationsAgentChatProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [runtimeStatus, setRuntimeStatus] = useState(workspace.qwenPaw)
  const [directory, setDirectory] = useState(workspace.qwenPaw.installDirectory || workspace.qwenPaw.defaultInstallDirectory || '')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const activeModel = modelConfig.channelStates?.[modelConfig.channel]
  const modelConfigured = activeModel?.hasApiKey ?? modelConfig.hasApiKey
  const modelName = activeModel?.model || modelConfig.model
  // Older app/server combinations may not have the installer fields yet.
  // Keep the Agent page usable while the fresh runtime status is loading.
  const task = runtimeStatus.installTask || idleInstallTask
  const installing = activeInstallStates.has(task.state)
  const runtimeKey = `${modelConfig.channel}|${modelConfig.customBaseUrl}|${modelName}|${modelConfigured}|${runtimeStatus.installDirectory}|${runtimeStatus.version}|${workspace.qwenPaw.signature || ''}`

  useEffect(() => {
    setRuntimeStatus(workspace.qwenPaw)
    setDirectory(workspace.qwenPaw.installDirectory || workspace.qwenPaw.defaultInstallDirectory || '')
  }, [workspace.qwenPaw])

  const refreshRuntime = useCallback(async () => {
    const next = await api.qwenPawStatus()
    setRuntimeStatus(next)
    setDirectory(next.installDirectory || next.defaultInstallDirectory || '')
    return next
  }, [])

  useEffect(() => {
    if (!active) return
    void refreshRuntime().catch((reason) => setError(reason instanceof Error ? reason.message : 'QwenPaw 状态读取失败。'))
  }, [active, refreshRuntime])

  useEffect(() => {
    if (!installing) return undefined
    const timer = window.setInterval(() => {
      void api.qwenPawInstallTask().then(async (nextTask) => {
        setRuntimeStatus((current) => ({ ...current, installTask: nextTask }))
        if (nextTask.state === 'completed') await refreshRuntime()
        if (nextTask.state === 'failed') setError(nextTask.error || 'QwenPaw 安装未完成。')
      }).catch((reason) => setError(reason instanceof Error ? reason.message : '安装进度读取失败。'))
    }, 800)
    return () => window.clearInterval(timer)
  }, [installing, refreshRuntime])

  const pathChanged = useMemo(() => String(directory || '').trim() !== (runtimeStatus.installDirectory || ''), [directory, runtimeStatus.installDirectory])

  async function saveDirectory(nextDirectory = directory) {
    const value = String(nextDirectory || '').trim()
    if (!value) return
    setBusy('path')
    setError('')
    try {
      const next = await api.updateQwenPawInstallDirectory(value)
      setRuntimeStatus(next)
      setDirectory(next.installDirectory || next.defaultInstallDirectory || value)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '安装路径保存失败。')
      throw reason
    } finally {
      setBusy('')
    }
  }

  async function chooseDirectory() {
    setBusy('choose')
    setError('')
    try {
      const result = await api.selectQwenPawInstallDirectory()
      if (result.directory) {
        setDirectory(result.directory)
        await saveDirectory(result.directory)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '目录选择器未打开；可以直接填写本机绝对路径。')
    } finally {
      setBusy('')
    }
  }

  async function installOrUpdate() {
    setBusy('install')
    setError('')
    try {
      if (pathChanged) await saveDirectory()
      const nextTask = await api.installQwenPaw()
      setRuntimeStatus((current) => ({ ...current, installTask: nextTask }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'QwenPaw 安装未启动。')
    } finally {
      setBusy('')
    }
  }

  const installLabel = runtimeStatus.updateAvailable
    ? runtimeStatus.version ? `更新至 ${runtimeStatus.latestVersion}` : `修复并更新至 ${runtimeStatus.latestVersion}`
    : runtimeStatus.installed
      ? `已安装 ${runtimeStatus.version || 'QwenPaw'}`
      : '安装 QwenPaw'

  return <div className="space-y-3">
    <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
      <div className="grid items-center gap-3 px-3 py-3 lg:grid-cols-[auto_minmax(280px,1fr)_auto]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-50 text-blue-700"><Bot className="h-4 w-4" /></span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setThinkingOpen(true)} className="gap-1.5 px-2 text-slate-700 hover:bg-amber-50 hover:text-amber-800"><Lightbulb className="h-4 w-4" />运营思路</Button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor="qwenpaw-install-directory" className="shrink-0 text-xs font-medium text-slate-500">安装路径</label>
          <input id="qwenpaw-install-directory" value={directory} disabled={installing} onChange={(event) => setDirectory(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && pathChanged) void saveDirectory() }} className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs text-slate-700 outline-none transition focus:border-blue-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60" />
          <Button type="button" size="sm" variant="ghost" className="h-9 w-9 p-0" title="选择安装目录" aria-label="选择 QwenPaw 安装目录" disabled={installing || busy === 'choose'} onClick={() => void chooseDirectory()}><FolderOpen className="h-4 w-4" /></Button>
          {pathChanged && <Button type="button" size="sm" variant="ghost" className="h-9 w-9 p-0" title="保存安装路径" aria-label="保存 QwenPaw 安装路径" disabled={busy === 'path'} onClick={() => void saveDirectory()}>{busy === 'path' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}</Button>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" title="检查 QwenPaw 更新" disabled={installing} onClick={() => void refreshRuntime()}><RefreshCw className="h-4 w-4" /></Button>
          <Button type="button" size="sm" variant="secondary" onClick={onOpenModelSettings}><Settings2 className="h-4 w-4" />配置模型</Button>
          <Button type="button" size="sm" disabled={installing || (runtimeStatus.installed && !runtimeStatus.updateAvailable)} onClick={() => void installOrUpdate()}>
            {installing || busy === 'install' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : runtimeStatus.installed && !runtimeStatus.updateAvailable ? <CheckCircle2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {installing ? `${task.progress || 0}%` : installLabel}
          </Button>
        </div>
      </div>
      {installing && <div className="border-t border-slate-100 px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-3 text-xs text-slate-500"><span>{task.message}</span><span>{task.downloadedBytes ? `${bytes(task.downloadedBytes)}${task.totalBytes ? ` / ${bytes(task.totalBytes)}` : ''}` : ''}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-blue-600 transition-[width] duration-300" style={{ width: `${Math.max(2, task.progress || 0)}%` }} /></div>
      </div>}
      {(error || task.error) && <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{error || task.error}</div>}
    </section>
    <QwenPawChatEmbed active={active} modelConfigured={modelConfigured} runtimeInstalled={runtimeStatus.installed} modelRuntimeKey={runtimeKey} onOpenModelSettings={onOpenModelSettings} />
    <OperationsThoughtDrawer open={thinkingOpen} workspace={workspace} onClose={() => setThinkingOpen(false)} onUpdateProfile={onUpdateProfile} onDeleteReport={onDeleteReport} />
  </div>
}
