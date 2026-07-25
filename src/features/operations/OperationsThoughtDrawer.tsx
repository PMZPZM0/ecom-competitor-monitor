import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Lightbulb, X } from 'lucide-react'
import type { OperationsWorkspace } from '../../types/domain'
import { OperationsPrinciples } from './OperationsPrinciples'

type OperationsThoughtDrawerProps = {
  open: boolean
  workspace: OperationsWorkspace
  onClose: () => void
  onUpdateProfile: (payload: { principles?: string, dailyReport?: { enabled?: boolean, time?: string } }) => Promise<void>
  onDeleteReport: (id: string) => Promise<void>
}

export function OperationsThoughtDrawer({ open, workspace, onClose, onUpdateProfile, onDeleteReport }: OperationsThoughtDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-slate-950/30"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside
        className="ml-auto flex h-[100dvh] w-full max-w-[680px] flex-col border-l border-slate-200 bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operations-thought-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700"><Lightbulb className="h-4 w-4" /></span>
            <div className="min-w-0">
              <h2 id="operations-thought-title" className="text-base font-semibold text-slate-950">运营思路</h2>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">维护自己的经营判断、日报节奏和已导入的数据。</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label="关闭运营思路"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <OperationsPrinciples workspace={workspace} onUpdateProfile={onUpdateProfile} onDeleteReport={onDeleteReport} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}
