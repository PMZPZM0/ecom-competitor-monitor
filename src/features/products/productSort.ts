import type { Product } from '../../types/domain'
import { productModel, productShopName } from './productDisplayUtils'

export type ProductSortKey = 'updated-desc' | 'updated-asc' | 'name-asc' | 'shop-asc' | 'model-asc' | 'price-asc' | 'price-desc' | 'sku-desc'

export const productSortOptions: Array<{ value: ProductSortKey; label: string }> = [
  { value: 'updated-desc', label: '最近更新' },
  { value: 'updated-asc', label: '最早更新' },
  { value: 'name-asc', label: '商品名称' },
  { value: 'shop-asc', label: '店铺名称' },
  { value: 'model-asc', label: '商品型号' },
  { value: 'price-asc', label: '最低价从低到高' },
  { value: 'price-desc', label: '最低价从高到低' },
  { value: 'sku-desc', label: 'SKU 数量从多到少' },
]

function minimumPrice(product: Product) {
  const prices = product.lastSnapshot?.skuPrices
    ?.map((sku) => sku.normalPrice ?? sku.price)
    .filter((price) => Number.isFinite(price) && price > 0) || []
  return prices.length ? Math.min(...prices) : null
}

export function sortProducts(products: Product[], sortKey: ProductSortKey) {
  return [...products].sort((left, right) => {
    if (sortKey === 'updated-desc' || sortKey === 'updated-asc') {
      const difference = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()
      return sortKey === 'updated-desc' ? -difference : difference
    }
    if (sortKey === 'name-asc') return left.name.localeCompare(right.name, 'zh-CN')
    if (sortKey === 'shop-asc') return productShopName(left).localeCompare(productShopName(right), 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN')
    if (sortKey === 'model-asc') return productModel(left).localeCompare(productModel(right), 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN')
    if (sortKey === 'sku-desc') return (right.lastSnapshot?.skuPrices?.length || 0) - (left.lastSnapshot?.skuPrices?.length || 0) || left.name.localeCompare(right.name, 'zh-CN')

    const leftPrice = minimumPrice(left)
    const rightPrice = minimumPrice(right)
    if (leftPrice === null && rightPrice === null) return left.name.localeCompare(right.name, 'zh-CN')
    if (leftPrice === null) return 1
    if (rightPrice === null) return -1
    return sortKey === 'price-asc' ? leftPrice - rightPrice : rightPrice - leftPrice
  })
}
