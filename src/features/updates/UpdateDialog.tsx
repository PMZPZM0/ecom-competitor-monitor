import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, CloudDownload, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { UpdateInfo } from '../../types/domain'

type Props = {
  currentVersion: string
  info: UpdateInfo | null
  checking: boolean
  error: string
  onCheck: () => void
  onClose: () => void
}

export function UpdateDialog({ currentVersion, info, checking, error, onCheck, onClose }: Props) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const platformLabel = info?.platform === 'win32' ? 'Windows x64' : info?.platform === 'darwin' && info.arch === 'arm64' ? 'macOS Apple Silicon' : info?.platform === 'darwin' ? 'macOS Intel' : `${info?.platform || ''} ${info?.arch || ''}`

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-[1px] sm:p-6" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-md bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div><h2 id="update-dialog-title" className="flex items-center gap-2 text-base font-semibold text-slate-950"><CloudDownload className="h-5 w-5 text-blue-600" />版本更新</h2><p className="mt-1 text-sm text-slate-500">从项目 GitHub Releases 检查并下载正式安装包。</p></div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} title="关闭版本更新" aria-label="关闭版本更新"><X className="h-4 w-4" /></button>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-3"><div className="text-xs text-slate-500">当前版本</div><div className="mt-1 text-xl font-semibold text-slate-900">v{currentVersion}</div></div>
            <div className={`border-l-4 px-4 py-3 ${info?.updateAvailable ? 'border-emerald-500 bg-emerald-50' : 'border-blue-400 bg-blue-50'}`}><div className="text-xs text-slate-500">GitHub 最新版本</div><div className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900">{info ? `v${info.latestVersion}` : '等待检查'}{info && <Badge className={info.updateAvailable ? 'border-emerald-200 bg-white text-emerald-700' : 'border-blue-200 bg-white text-blue-700'}>{info.updateAvailable ? '可更新' : '已是最新'}</Badge>}</div></div>
          </div>

          {checking && <div className="mt-4 flex items-center gap-2 bg-blue-50 px-4 py-3 text-sm text-blue-800" role="status"><LoaderCircle className="h-4 w-4 animate-spin" />正在连接 GitHub Releases 检查版本...</div>}
          {error && !checking && <div className="mt-4 flex items-start gap-2 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><div><div>{error}</div><div className="mt-1 text-xs text-red-600">这不会影响本地抓取和监控，可稍后重新检查。</div></div></div>}
          {info && !checking && !error && <>
            <div className={`mt-4 flex items-start gap-2 px-4 py-3 text-sm ${info.updateAvailable ? 'bg-emerald-50 text-emerald-800' : 'bg-blue-50 text-blue-800'}`}>{info.updateAvailable ? <CloudDownload className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}<div><div className="font-medium">{info.updateAvailable ? `发现新版本 v${info.latestVersion}` : '当前已经是最新版本'}</div><div className="mt-1 text-xs">{platformLabel}{info.assetName ? ` · ${info.assetName}` : ' · 请在 Releases 页面选择安装包'}{info.publishedAt ? ` · 发布于 ${new Date(info.publishedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</div></div></div>
            <section className="mt-4"><h3 className="text-sm font-semibold text-slate-900">更新说明</h3><div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap border-y border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-600">{info.notes}</div></section>
            {info.updateAvailable && <div className="mt-4 text-xs leading-5 text-slate-500">下载安装包后先退出软件，再覆盖安装。商品、历史价格、账号浏览器目录和飞书配置保存在用户数据目录，不会因覆盖安装被删除。</div>}
          </>}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <Button type="button" variant="secondary" onClick={onCheck} disabled={checking}><RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />重新检查</Button>
          <div className="flex items-center gap-2"><Button type="button" variant="secondary" onClick={onClose}>关闭</Button>{info?.updateAvailable && <a href={info.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-blue-600 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"><CloudDownload className="h-4 w-4" />{info.assetName ? '下载新版安装包' : '打开 GitHub Releases'}</a>}</div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
