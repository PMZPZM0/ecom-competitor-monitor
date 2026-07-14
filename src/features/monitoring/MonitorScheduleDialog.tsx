import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarClock, CircleAlert, Save, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import type { Overview, Product } from '../../types/domain'
import { productTitle } from '../products/productDisplayUtils'
import { scheduleInputParts } from '../products/productSchedule'

type Props = {
  product: Product
  monitor: Overview['monitor']
  onClose: () => void
  onSave: (mode: NonNullable<Product['monitorScheduleMode']>, intervalMinutes: number, monitorStartAt: string | null) => Promise<void>
}

export function MonitorScheduleDialog({ product, monitor, onClose, onSave }: Props) {
  const initialInterval = product.monitorIntervalMinutes ?? monitor.intervalMinutes
  const initial = scheduleInputParts(product.monitorStartAt, product.nextMonitorAt, initialInterval)
  const [mode, setMode] = useState<NonNullable<Product['monitorScheduleMode']>>(product.monitorScheduleMode === 'once' ? 'once' : 'interval')
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [interval, setIntervalValue] = useState(String(initialInterval))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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

  async function save() {
    const intervalMinutes = Number(interval)
    const startAt = new Date(`${date}T${time}:00`)
    if (mode === 'interval' && (!Number.isInteger(intervalMinutes) || intervalMinutes < 30 || intervalMinutes > 1440)) {
      setError('抓取周期必须是 30 至 1440 分钟的整数。')
      return
    }
    if (mode === 'once' && (!date || !time || Number.isNaN(startAt.getTime()))) {
      setError('请选择有效的开始日期和时间。')
      return
    }
    if (mode === 'once' && startAt.getTime() <= Date.now()) {
      setError('单次定时必须选择未来时间。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(mode, intervalMinutes, mode === 'once' ? startAt.toISOString() : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存抓取计划失败。')
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-[1px] sm:p-6" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" className="flex w-full max-w-xl flex-col overflow-hidden rounded-md bg-white shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0"><h2 id="schedule-dialog-title" className="flex items-center gap-2 text-base font-semibold text-slate-950"><CalendarClock className="h-5 w-5 text-emerald-600" />设置本商品抓取计划</h2><p className="mt-1 truncate text-sm text-slate-500" title={productTitle(product)}>{productTitle(product)}</p></div>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} title="关闭" aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1" role="radiogroup" aria-label="抓取计划模式">
            <button type="button" role="radio" aria-checked={mode === 'once'} onClick={() => setMode('once')} className={`rounded px-3 py-2 text-sm font-medium ${mode === 'once' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>单次定时</button>
            <button type="button" role="radio" aria-checked={mode === 'interval'} onClick={() => setMode('interval')} className={`rounded px-3 py-2 text-sm font-medium ${mode === 'interval' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>循环监控</button>
          </div>
          {mode === 'once' ? <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
            <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">开始日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-400" /></label>
            <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">具体时间</span><input type="time" step={60} value={time} onChange={(event) => setTime(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-400" /></label>
          </div> : <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">抓取周期（分钟）</span><input type="number" min={30} max={1440} step={1} value={interval} onChange={(event) => setIntervalValue(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-400" /><span className="mt-1.5 block text-xs text-slate-500">保存后从当前时间开始，每隔 30 至 1440 分钟抓取一次。</span></label>}
          <div className="border-l-4 border-sky-400 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">{mode === 'once' ? '只在所选日期和时间执行一次，完成后自动暂停本商品，不会再按分钟循环。' : '只按分钟周期循环抓取，日期和时间不会生效。'}</div>
          {(!monitor.running || !product.enabled) && <div className="flex items-start gap-2 border-l-4 border-amber-400 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"><CircleAlert className="mt-1 h-4 w-4 shrink-0" /><span>计划可以正常保存，但还需{[!monitor.running ? '开启全局自动监控' : '', !product.enabled ? '启用本商品' : ''].filter(Boolean).join('、')}后才会执行。</span></div>}
          {error && <div className="flex items-start gap-2 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert"><CircleAlert className="mt-1 h-4 w-4 shrink-0" />{error}</div>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="button" className="border-emerald-600 bg-emerald-600 hover:bg-emerald-700" onClick={save} disabled={saving}><Save className="h-4 w-4" />{saving ? '保存中' : '保存计划'}</Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
