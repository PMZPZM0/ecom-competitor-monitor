import { useRef, useState } from 'react'
import { Check, Image as ImageIcon, LoaderCircle, RefreshCw, Trash2, Upload } from 'lucide-react'
import { deleteCustomWallpaper, normalizeCustomWallpaper, saveCustomWallpaper } from './customWallpaperStore'
import { APP_WALLPAPERS, CUSTOM_APP_WALLPAPER_ID, type AppWallpaperId } from './wallpapers'

type AppearanceSettingsProps = {
  wallpaperId: AppWallpaperId
  customWallpaperUrl: string
  onWallpaperChange: (wallpaperId: AppWallpaperId) => void
  onCustomWallpaperSaved: (blob: Blob) => void
  onCustomWallpaperDeleted: () => void
}

export function AppearanceSettings({
  wallpaperId,
  customWallpaperUrl,
  onWallpaperChange,
  onCustomWallpaperSaved,
  onCustomWallpaperDeleted,
}: AppearanceSettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [processing, setProcessing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function handleFile(file: File | undefined) {
    if (!file || processing) return
    setProcessing(true)
    setMessage('正在适配壁纸…')
    setError('')
    try {
      const wallpaper = await normalizeCustomWallpaper(file)
      await saveCustomWallpaper(wallpaper)
      onCustomWallpaperSaved(wallpaper.blob)
      onWallpaperChange(CUSTOM_APP_WALLPAPER_ID)
      setMessage(`已适配为 ${wallpaper.width} × ${wallpaper.height}，并保存在当前电脑。`)
    } catch (reason) {
      setMessage('')
      setError(reason instanceof Error ? reason.message : '上传壁纸失败。')
    } finally {
      setProcessing(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function removeCustomWallpaper() {
    if (processing) return
    setProcessing(true)
    setError('')
    try {
      await deleteCustomWallpaper()
      onCustomWallpaperDeleted()
      setMessage('自定义壁纸已删除，已恢复“朱砂纳福”。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除壁纸失败。')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <section className="mx-auto w-full max-w-4xl" aria-labelledby="appearance-settings-heading">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-rose-50 text-rose-700"><ImageIcon className="h-5 w-5" /></span>
        <div>
          <h3 id="appearance-settings-heading" className="text-base font-semibold text-slate-950">应用壁纸</h3>
          <p className="mt-1 text-sm leading-6 text-slate-500">选择后立即生效。自定义图片会自动裁成 16:9 并只保存在当前电脑，不会上传到服务器。</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="选择应用壁纸">
        {APP_WALLPAPERS.map((wallpaper) => {
          const selected = wallpaper.id === wallpaperId
          return (
            <button
              key={wallpaper.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onWallpaperChange(wallpaper.id)}
              className={`group overflow-hidden rounded-md border bg-white text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'}`}
            >
              <span
                className="relative block aspect-[16/9] overflow-hidden bg-slate-100 bg-cover"
                style={wallpaper.src
                  ? { backgroundImage: `url(${wallpaper.src})`, backgroundPosition: wallpaper.position }
                  : { background: 'linear-gradient(135deg, #ffffff 0%, #f4f7f9 100%)' }}
              >
                {!wallpaper.src && <span className="absolute inset-0 bg-[linear-gradient(90deg,transparent_49%,rgba(148,163,184,0.12)_50%,transparent_51%)] bg-[length:24px_24px]" />}
                <SelectionMark selected={selected} />
              </span>
              <WallpaperLabel label={wallpaper.label} description={wallpaper.description} swatch={wallpaper.swatch} />
            </button>
          )
        })}

        <div className={`overflow-hidden rounded-md border bg-white transition ${wallpaperId === CUSTOM_APP_WALLPAPER_ID ? 'border-blue-500 ring-2 ring-blue-100' : 'border-dashed border-slate-300'}`}>
          {customWallpaperUrl ? (
            <button
              type="button"
              role="radio"
              aria-checked={wallpaperId === CUSTOM_APP_WALLPAPER_ID}
              onClick={() => onWallpaperChange(CUSTOM_APP_WALLPAPER_ID)}
              className="relative block aspect-[16/9] w-full overflow-hidden bg-cover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
              style={{ backgroundImage: `url(${customWallpaperUrl})`, backgroundPosition: 'center' }}
            >
              <SelectionMark selected={wallpaperId === CUSTOM_APP_WALLPAPER_ID} />
            </button>
          ) : (
            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 bg-slate-50 text-sm text-slate-600 transition hover:bg-slate-100" disabled={processing}>
              {processing ? <LoaderCircle className="h-6 w-6 animate-spin text-blue-600" /> : <Upload className="h-6 w-6 text-slate-400" />}
              <span>{processing ? '正在处理' : '上传自定义壁纸'}</span>
            </button>
          )}
          <div className="flex min-h-[54px] items-center gap-2 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">我的壁纸</span>
              <span className="mt-0.5 block truncate text-xs text-slate-500">PNG / JPG / WebP，最大 12 MB</span>
            </span>
            {customWallpaperUrl && <>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={processing} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50" title="替换壁纸" aria-label="替换自定义壁纸"><RefreshCw className={`h-4 w-4 ${processing ? 'animate-spin' : ''}`} /></button>
              <button type="button" onClick={removeCustomWallpaper} disabled={processing} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50" title="删除壁纸" aria-label="删除自定义壁纸"><Trash2 className="h-4 w-4" /></button>
            </>}
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => handleFile(event.target.files?.[0])} />
      {(message || error) && <p className={`mt-3 text-sm ${error ? 'text-red-600' : 'text-emerald-700'}`} role={error ? 'alert' : 'status'}>{error || message}</p>}
    </section>
  )
}

function SelectionMark({ selected }: { selected: boolean }) {
  return <span className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/80 shadow-sm ${selected ? 'bg-blue-600 text-white' : 'bg-white/85 text-transparent'}`}><Check className="h-4 w-4" /></span>
}

function WallpaperLabel({ label, description, swatch }: { label: string; description: string; swatch: string }) {
  return <span className="flex min-h-[54px] items-center gap-3 px-3 py-2.5"><span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: swatch }} /><span className="min-w-0"><span className="block text-sm font-medium text-slate-900">{label}</span><span className="mt-0.5 block text-xs text-slate-500">{description}</span></span></span>
}
