import { useCallback, useEffect, useState } from 'react'
import { Bot, CircleAlert, ExternalLink, Lightbulb, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'

type QwenPawConsoleRuntime = {
  consoleUrl: string
  agentId: string
  model: string
}

type QwenPawChatEmbedProps = {
  active: boolean
  modelConfigured: boolean
  modelRuntimeKey: string
  onOpenThinking: () => void
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'QwenPaw 原生会话暂时无法连接。'
}

export function QwenPawChatEmbed({ active, modelConfigured, modelRuntimeKey, onOpenThinking }: QwenPawChatEmbedProps) {
  const [runtime, setRuntime] = useState<QwenPawConsoleRuntime | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const connect = useCallback(async () => {
    if (!modelConfigured) return
    setLoading(true)
    setLoaded(false)
    setError('')
    try {
      setRuntime(await api.qwenPawConsole())
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setLoading(false)
    }
  }, [modelConfigured])

  useEffect(() => {
    if (active && !runtime && !loading && !error) void connect()
  }, [active, connect, error, loading, runtime])

  useEffect(() => {
    setRuntime(null)
    setLoaded(false)
    setError('')
  }, [modelRuntimeKey])

  if (!modelConfigured) {
    return <section className="flex min-h-[420px] flex-col items-center justify-center border border-dashed border-amber-200 bg-amber-50/50 px-6 text-center">
      <Bot className="h-8 w-8 text-amber-600" />
      <div className="mt-3 text-base font-semibold text-slate-900">先配置文字模型</div>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-600">正在跳转至模型配置页。配置完成后，运营助手会自动使用当前文字模型。</p>
    </section>
  }

  if (error) {
    return <section className="flex min-h-[420px] flex-col items-center justify-center border border-red-200 bg-red-50/50 px-6 text-center">
      <CircleAlert className="h-8 w-8 text-red-600" />
      <div className="mt-3 text-base font-semibold text-slate-900">原生会话未连接</div>
      <p className="mt-2 max-w-xl text-sm leading-6 text-red-700">{error}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2"><Button type="button" variant="secondary" onClick={() => { setError(''); void connect() }}><RefreshCw className="h-4 w-4" />重新连接</Button></div>
    </section>
  }

  if (!runtime || loading) {
    return <section className="flex min-h-[420px] flex-col items-center justify-center border border-slate-200 bg-slate-50 px-6 text-center">
      <LoaderCircle className="h-7 w-7 animate-spin text-blue-600" />
      <div className="mt-3 text-sm font-medium text-slate-800">正在准备 QwenPaw 原生流式会话</div>
      <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">首次打开会自动下载并配置本机运行环境，无需安装 Python。请保持网络连接，完成后会自动进入会话。</p>
    </section>
  }

  return <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2"><span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200"><Bot className="h-3.5 w-3.5" />QwenPaw 原生流式会话</span><span className="truncate text-xs text-slate-500">{runtime.model}</span></div>
      <div className="flex items-center gap-1"><Button type="button" size="sm" variant="ghost" onClick={onOpenThinking} title="编辑运营思路" className="gap-1.5 px-2 text-slate-700 hover:bg-amber-50 hover:text-amber-800"><Lightbulb className="h-4 w-4" /><span>运营思路</span></Button><Button type="button" size="sm" variant="ghost" title="重新连接" onClick={() => void connect()}><RefreshCw className="h-4 w-4" /></Button><a href={runtime.consoleUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-800" title="在浏览器中打开"><ExternalLink className="h-4 w-4" /></a></div>
    </div>
    <div className="relative h-[calc(100vh-270px)] min-h-[620px] bg-white">
      {!loaded && <div className="absolute inset-0 z-10 flex items-center justify-center bg-white"><LoaderCircle className="h-6 w-6 animate-spin text-blue-600" /></div>}
      <iframe key={runtime.consoleUrl} title="QwenPaw 运营助手" src={runtime.consoleUrl} onLoad={() => setLoaded(true)} className="h-full w-full border-0" />
    </div>
  </section>
}
