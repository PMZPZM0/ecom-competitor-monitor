import { Component, type ErrorInfo, type ReactNode } from 'react'
import { CircleAlert, PackageSearch, RefreshCw } from 'lucide-react'

const ACTIVE_PAGE_KEY = 'tmall-monitor-active-page'
const AI_CREATION_VIEW_KEY = 'ecommerce-monitor-ai-creation-view'

type Props = { children: ReactNode }
type State = { error: Error | null }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[render-error]', error, info.componentStack)
  }

  private returnToMonitoring = () => {
    window.localStorage.setItem(ACTIVE_PAGE_KEY, 'monitoring')
    window.localStorage.setItem(AI_CREATION_VIEW_KEY, 'compose')
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    const moduleLoadFailed = /dynamically imported module|loading chunk|failed to fetch/i.test(this.state.error.message)
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4 text-slate-900">
        <section className="w-full max-w-lg rounded-md border border-red-100 bg-white p-6 shadow-xl" role="alert" aria-labelledby="render-error-title">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-600"><CircleAlert className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h1 id="render-error-title" className="text-lg font-semibold">当前界面加载失败</h1>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {moduleLoadFailed ? '界面模块在更新或切换时没有加载成功。后台任务和本地数据不会丢失，重新加载即可恢复。' : '某个界面组件运行异常。后台任务和本地数据不会丢失，可以重新加载或返回商品监控。'}
              </p>
            </div>
          </div>
          <p className="mt-4 break-words rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">{this.state.error.message || '未知界面错误'}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={this.returnToMonitoring} className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"><PackageSearch className="h-4 w-4" />返回商品监控</button>
            <button type="button" onClick={() => window.location.reload()} className="inline-flex h-10 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"><RefreshCw className="h-4 w-4" />重新加载</button>
          </div>
        </section>
      </main>
    )
  }
}
