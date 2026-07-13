import { Download, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { currency } from '../../lib/utils'
import type { Product, Snapshot } from '../../types/domain'

type Props = {
  snapshots: Snapshot[]
  products: Product[]
  onClear: () => Promise<void>
}

export function DataRecords({ snapshots, products, onClear }: Props) {
  const productName = new Map(products.map((product) => [product.id, product.name]))
  const shopName = new Map(products.map((product) => [product.id, product.shopName]))
  const modelName = new Map(products.map((product) => [product.id, product.model]))
  const autoGroup = new Map(products.map((product) => [product.id, product.autoGroup]))

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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>价格与 SKU 历史记录</CardTitle>
        <div className="flex gap-2">
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
      <CardContent className="p-0">
        <table className="w-full text-left text-sm">
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
                <td className="px-4 py-3">{snapshot.source === 'browser' ? '浏览器登录态' : '直接请求'}</td>
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
  )
}
