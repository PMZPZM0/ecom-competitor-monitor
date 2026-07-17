import { CheckCircle2, CircleAlert, Download, ExternalLink, FolderOpen, LoaderCircle, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { api } from '../../lib/api'
import { currency } from '../../lib/utils'
import type { LocalEvidenceStatus, Product, Snapshot } from '../../types/domain'

type Props = {
  snapshots: Snapshot[]
  products: Product[]
  onClear: () => Promise<void>
  onEvidenceChanged: () => Promise<void>
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DataRecords({ snapshots, products, onClear, onEvidenceChanged }: Props) {
  const [evidence, setEvidence] = useState<LocalEvidenceStatus | null>(null)
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState<'load' | 'pick' | 'open' | 'save' | 'reset' | 'delete' | null>('load')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deletePhrase, setDeletePhrase] = useState('')
  const productName = new Map(products.map((product) => [product.id, product.name]))
  const shopName = new Map(products.map((product) => [product.id, product.shopName]))
  const modelName = new Map(products.map((product) => [product.id, product.model]))
  const autoGroup = new Map(products.map((product) => [product.id, product.autoGroup]))

  useEffect(() => {
    let active = true
    api.localEvidence()
      .then((result) => {
        if (!active) return
        setEvidence(result)
        setDirectory(result.directory)
      })
      .catch((error) => {
        if (active) setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '读取本地证据设置失败' })
      })
      .finally(() => { if (active) setBusy(null) })
    return () => { active = false }
  }, [])

  function applyEvidence(result: LocalEvidenceStatus, message: string) {
    setEvidence(result)
    setDirectory(result.directory)
    setFeedback({ tone: 'success', message })
  }

  async function selectDirectory() {
    setBusy('pick')
    setFeedback(null)
    try {
      const result = await api.selectLocalEvidenceDirectory()
      if (result.directory) {
        setDirectory(result.directory)
        setFeedback({ tone: 'success', message: '文件夹已选择，点击“保存目录”后生效。' })
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '选择文件夹失败' })
    } finally {
      setBusy(null)
    }
  }

  async function openDirectory() {
    setBusy('open')
    setFeedback(null)
    try {
      await api.openLocalEvidenceDirectory()
      setFeedback({ tone: 'success', message: '当前证据目录已在系统文件管理器中打开。' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '打开证据目录失败' })
    } finally {
      setBusy(null)
    }
  }

  async function saveDirectory() {
    const nextDirectory = directory.trim()
    if (!nextDirectory) {
      setFeedback({ tone: 'error', message: '请输入本地证据保存目录，或点击“恢复默认”。' })
      return
    }
    setBusy('save')
    setFeedback(null)
    try {
      applyEvidence(await api.updateLocalEvidenceSettings(nextDirectory), '保存目录已更新，后续抓取证据将写入新目录。')
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '保存目录失败' })
    } finally {
      setBusy(null)
    }
  }

  async function restoreDefaultDirectory() {
    setBusy('reset')
    setFeedback(null)
    try {
      applyEvidence(await api.updateLocalEvidenceSettings(null), '已恢复默认保存目录。')
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '恢复默认目录失败' })
    } finally {
      setBusy(null)
    }
  }

  async function deleteEvidence() {
    if (deletePhrase !== '删除全部证据') return
    setBusy('delete')
    setFeedback(null)
    try {
      applyEvidence(await api.deleteLocalEvidence(), '当前目录中的本地证据已全部删除，保存目录和监控数据未改变。')
      await onEvidenceChanged().catch(() => undefined)
      setDeleteConfirming(false)
      setDeletePhrase('')
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '删除本地证据失败' })
    } finally {
      setBusy(null)
    }
  }

  async function exportCsv() {
    const response = await fetch('/api/export/snapshots.csv')
    if (!response.ok) throw new Error('导出 CSV 失败')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'tmall-snapshots.csv'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><FolderOpen className="h-4 w-4 text-blue-600" />本地价格证据</CardTitle>
            <div className="mt-1 text-sm text-slate-500">抓取成功后自动保存脱敏证据；修改目录只影响后续保存。</div>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
            {busy === 'load' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : evidence ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <CircleAlert className="h-3.5 w-3.5 text-red-500" />}
            {busy === 'load' ? '正在读取' : evidence ? `${evidence.sourceFileCount} 份原始 + ${evidence.fileCount} 份解析 · ${fileSize(evidence.totalBytes)}` : '读取失败'}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="local-evidence-directory">保存目录</label>
            <div className="flex flex-col gap-2 lg:flex-row">
              <Input id="local-evidence-directory" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="输入本机文件夹的完整路径" disabled={Boolean(busy)} className="min-w-0 flex-1" />
              <div className="flex flex-wrap gap-2">
                {evidence?.directoryPickerAvailable && <Button type="button" variant="secondary" onClick={() => void selectDirectory()} disabled={Boolean(busy)}>
                  {busy === 'pick' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}{busy === 'pick' ? '选择中' : '选择文件夹'}
                </Button>}
                {evidence?.directoryPickerAvailable && <Button type="button" variant="secondary" onClick={() => void openDirectory()} disabled={Boolean(busy)} title="打开已保存的当前目录">
                  {busy === 'open' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}{busy === 'open' ? '打开中' : '打开当前目录'}
                </Button>}
                <Button type="button" onClick={() => void saveDirectory()} disabled={Boolean(busy) || directory.trim() === evidence?.directory}>
                  {busy === 'save' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{busy === 'save' ? '保存中' : '保存目录'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => void restoreDefaultDirectory()} disabled={Boolean(busy) || evidence?.directory === evidence?.defaultDirectory}>
                  {busy === 'reset' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}恢复默认
                </Button>
                <Button type="button" variant="danger" onClick={() => { setDeleteConfirming(true); setDeletePhrase(''); setFeedback(null) }} disabled={Boolean(busy) || !((evidence?.fileCount || 0) + (evidence?.sourceFileCount || 0))}>
                  <Trash2 className="h-4 w-4" />清空当前目录
                </Button>
              </div>
            </div>
          </div>
          {evidence?.defaultDirectory && <div className="break-all text-xs text-slate-400">默认目录：{evidence.defaultDirectory}</div>}
          {deleteConfirming && (
            <div className="flex flex-col gap-3 rounded-md border border-red-200 bg-red-50 p-3 sm:flex-row sm:items-end" role="alert">
              <label className="min-w-0 flex-1 text-sm font-medium text-red-800" htmlFor="delete-local-evidence-confirmation">
                此操作不可恢复。请输入“删除全部证据”确认
                <Input id="delete-local-evidence-confirmation" value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} className="mt-1.5 border-red-200 bg-white" autoFocus />
              </label>
              <div className="flex gap-2">
                <Button type="button" variant="danger" onClick={() => void deleteEvidence()} disabled={busy === 'delete' || deletePhrase !== '删除全部证据'}>
                  {busy === 'delete' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{busy === 'delete' ? '删除中' : '确认删除'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => { setDeleteConfirming(false); setDeletePhrase('') }} disabled={busy === 'delete'}>取消</Button>
              </div>
            </div>
          )}
          {feedback && <div className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${feedback.tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`} role={feedback.tone === 'error' ? 'alert' : 'status'} aria-live="polite">{feedback.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}<span>{feedback.message}</span></div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>价格与 SKU 历史记录</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => void exportCsv()}>
              <Download className="h-4 w-4" />
              导出 CSV
            </Button>
            <Button type="button" variant="danger" onClick={onClear}>
              <Trash2 className="h-4 w-4" />
              清空历史
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3">时间</th>
              <th className="px-4 py-3">商品</th>
              <th className="px-4 py-3">店铺</th>
              <th className="px-4 py-3">型号 / 自动分类</th>
              <th className="px-4 py-3">价格</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">图片</th>
              <th className="px-4 py-3">来源</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {snapshots.map((snapshot) => (
              <tr key={snapshot.id}>
                <td className="px-4 py-3 text-slate-500">{new Date(snapshot.capturedAt).toLocaleString()}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{productName.get(snapshot.productId) || snapshot.title}</td>
                <td className="px-4 py-3 text-slate-600">{shopName.get(snapshot.productId) || snapshot.shopName || '--'}</td>
                <td className="px-4 py-3 text-slate-600">
                  <div>{modelName.get(snapshot.productId) || snapshot.model || '--'}</div>
                  <div className="text-xs text-slate-400">{autoGroup.get(snapshot.productId) || snapshot.autoGroup || '--'}</div>
                </td>
                <td className="px-4 py-3 font-semibold text-emerald-700">{currency(snapshot.price)}</td>
                <td className="px-4 py-3">{snapshot.skuPrices?.length ?? 0} 个价格</td>
                <td className="px-4 py-3">{snapshot.rawSignals.imageCount} 主图 / {snapshot.rawSignals.skuImageCount} SKU 图</td>
                <td className="px-4 py-3">{snapshot.source === 'browser' ? '浏览器登录态' : snapshot.source === 'local-import' ? '本地数据导入' : '直接请求'}</td>
              </tr>
            ))}
            {snapshots.length === 0 && (
              <tr>
                <td className="px-4 py-12 text-center text-slate-400" colSpan={8}>暂无历史记录。</td>
              </tr>
            )}
          </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
