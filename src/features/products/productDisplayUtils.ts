import { currency } from '../../lib/utils'
import type { Product } from '../../types/domain'

export type SkuPrice = NonNullable<Product['lastSnapshot']>['skuPrices'][number]

export function verifiedPriceChannel(sku: SkuPrice, channel: 'normal' | 'government' | 'surprise' | 'gift' | 'vip88' | 'coin') {
  return sku.resolutionStatus === 'verified' && sku.priceResolution?.channels?.[channel]?.status === 'verified'
}

export function displayPriceLabel(rawLabel = '', accountType?: Product['accountType']) {
  if (/政府补贴|国家补贴|国补/.test(rawLabel)) return '国补价'
  if (/惊喜立减|惊喜价/.test(rawLabel)) return '惊喜立减价'
  if (/淘金币|金币/.test(rawLabel)) return '淘金币价'
  if (/88\s*VIP/i.test(rawLabel)) return '88VIP价'
  if (/礼金/.test(rawLabel)) return '礼金价'
  // Account type is only a fallback for account-price records that have no
  // captured label. Do not relabel ordinary/activity layers as account prices.
  if (!rawLabel.trim()) {
    if (accountType === 'vip88') return '88VIP价'
    if (accountType === 'gift') return '礼金价'
  }
  return '普通价'
}

export function normalPriceForSku(sku: SkuPrice) {
  if (sku.normalPrice) return sku.normalPrice
  const normalLayer = sku.priceLayers?.find((layer) => (
    layer.kind !== 'discount' &&
    layer.kind !== 'original' &&
    !/政府补贴|国家补贴|国补|淘金币|金币|首单|礼金|88|会员|VIP/i.test(layer.label)
  ))
  return normalLayer?.value || sku.price
}

export function coinPriceForSku(sku: SkuPrice) {
  if (!verifiedPriceChannel(sku, 'coin')) return null
  if (sku.coinPrice) return sku.coinPrice
  return sku.priceLayers?.find((layer) => /淘金币|金币/i.test(layer.label))?.value || null
}

export function surprisePriceForSku(sku: SkuPrice) {
  if (!verifiedPriceChannel(sku, 'surprise')) return null
  if (sku.surprisePrice) return sku.surprisePrice
  return sku.priceLayers?.find((layer) => /惊喜立减|惊喜价/i.test(layer.label))?.value || null
}

export function surpriseBenefitForSku(sku: SkuPrice) {
  if (!verifiedPriceChannel(sku, 'surprise')) return { available: false, price: null, discountAmount: null }
  const price = surprisePriceForSku(sku)
  const normalPrice = normalPriceForSku(sku)
  const discountAmount = Number(sku.surpriseDiscountAmount) > 0
    ? Number(sku.surpriseDiscountAmount)
    : price && price < normalPrice
      ? Number((normalPrice - price).toFixed(2))
      : null
  return { available: sku.surpriseStatus === 'available' || Boolean(price), price, discountAmount }
}

export function accountBenefitForSku(sku: SkuPrice, accountType: Product['accountType']) {
  if (accountType === 'gift') {
    if (!verifiedPriceChannel(sku, 'gift')) return { label: '礼金价', available: false, price: null, discountAmount: null }
    const price = sku.giftPrice || sku.accountPrices?.find((item) => item.accountType === 'gift')?.giftPrice || null
    const normalPrice = normalPriceForSku(sku)
    const discountAmount = Number(sku.giftDiscountAmount) > 0
      ? Number(sku.giftDiscountAmount)
      : price && price < normalPrice ? Number((normalPrice - price).toFixed(2)) : null
    return { label: '礼金价', available: sku.giftStatus === 'available' || Boolean(price), price, discountAmount }
  }
  if (accountType === 'vip88') {
    if (!verifiedPriceChannel(sku, 'vip88')) return { label: '88VIP价', available: false, price: null, discountAmount: null }
    const price = sku.vipPrice || sku.accountPrices?.find((item) => item.accountType === 'vip88')?.vipPrice || null
    const normalPrice = normalPriceForSku(sku)
    const discountAmount = Number(sku.vipDiscountAmount) > 0
      ? Number(sku.vipDiscountAmount)
      : price && price < normalPrice ? Number((normalPrice - price).toFixed(2)) : null
    return { label: '88VIP价', available: sku.vipStatus === 'available' || Boolean(price), price, discountAmount }
  }
  return { label: '惊喜立减价', ...surpriseBenefitForSku(sku) }
}

export function coinBenefitForSku(sku: SkuPrice) {
  if (!verifiedPriceChannel(sku, 'coin')) return { available: false, price: null, discountAmount: null, items: [] }
  const price = coinPriceForSku(sku)
  const items = (sku.discountItems || []).filter((item) => /淘金币|金币/i.test(`${item.label} ${item.text}`))
  const layerExists = (sku.priceLayers || []).some((layer) => /淘金币|金币/i.test(layer.label))
  const normalPrice = normalPriceForSku(sku)
  const itemDiscount = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
  const discountAmount = Number(sku.coinDiscountAmount) > 0
    ? Number(sku.coinDiscountAmount)
    : itemDiscount > 0
      ? itemDiscount
      : price && price < normalPrice
        ? Number((normalPrice - price).toFixed(2))
        : null
  const available = sku.coinStatus === 'available' || Boolean(price || items.length || layerExists)
  return { available, price, discountAmount, items }
}

export function productHasCoinBenefit(product: Product) {
  return Boolean(product.lastSnapshot?.skuPrices?.some((sku) => coinBenefitForSku(sku).available))
}

export function priceLayersForSku(sku: SkuPrice, options: { includeOriginal?: boolean } = {}) {
  const capturedLayers = sku.priceLayers?.length
    ? sku.priceLayers
    : [
        { label: sku.priceTitle || '到手价', value: sku.price, kind: 'price' as const },
        ...(sku.originalPrice && sku.originalPrice !== sku.price ? [{ label: '优惠前', value: sku.originalPrice, kind: 'original' as const }] : []),
      ]
  const layers = [
    ...(sku.normalPrice ? [{ label: '普通价', value: sku.normalPrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...(sku.governmentPrice ? [{ label: '国补价', value: sku.governmentPrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...(sku.surprisePrice ? [{ label: '惊喜立减价', value: sku.surprisePrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...(sku.giftPrice ? [{ label: '礼金价', value: sku.giftPrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...(sku.vipPrice ? [{ label: '88VIP价', value: sku.vipPrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...(sku.coinPrice ? [{ label: '淘金币价', value: sku.coinPrice, kind: 'price' as const, source: 'normalized' }] : []),
    ...capturedLayers,
  ]
  const order = (label: string, kind?: string) => {
    if (kind === 'original' || label === '标价') return 0
    if (/普通价|店铺优惠后|到手价|券后|平台/.test(label)) return 1
    if (/政府补贴|国家补贴|国补/.test(label)) return 2
    if (/惊喜立减|惊喜价/.test(label)) return 3
    if (/首单|礼金/.test(label)) return 4
    if (/88\s*VIP/i.test(label)) return 5
    if (/淘金币|金币/.test(label)) return 6
    return 7
  }
  const seen = new Set<string>()
  return layers
    .map((layer) => ({ ...layer, label: layer.label === '优惠前' ? '标价' : layer.label }))
    .filter((layer) => layer.value)
    .filter((layer) => options.includeOriginal !== false || (layer.kind !== 'original' && layer.label !== '标价'))
    .filter((layer) => {
      const key = `${layer.label}:${layer.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => order(left.label, left.kind) - order(right.label, right.kind))
}

export function layerClass(kind?: string, label?: string) {
  if (kind === 'original' || label === '优惠前' || label === '标价') return 'border-slate-200 bg-white text-slate-400'
  if (/88\s*VIP/i.test(label || '')) return 'border-violet-100 bg-violet-50 text-violet-700'
  if (/礼金/.test(label || '')) return 'border-orange-100 bg-orange-50 text-orange-700'
  if (/淘金币|金币/.test(label || '')) return 'border-amber-100 bg-amber-50 text-amber-700'
  if (/惊喜立减|惊喜价/.test(label || '')) return 'border-rose-100 bg-rose-50 text-rose-700'
  if (/政府补贴|国家补贴|国补/.test(label || '')) return 'border-teal-100 bg-teal-50 text-teal-700'
  if (/普通价/.test(label || '')) return 'border-sky-100 bg-sky-50 text-sky-700'
  if (kind === 'discount') return 'border-amber-100 bg-amber-50 text-amber-700'
  return 'border-emerald-100 bg-emerald-50 text-emerald-700'
}

export function downloadHref(src: string, name: string) {
  return `/api/download-image?url=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`
}

export function downloadMediaBundleHref(productId: string) {
  return `/api/products/${encodeURIComponent(productId)}/download-media`
}

export function downloadBuyerShowsHref(productId: string) {
  return `/api/products/${encodeURIComponent(productId)}/download-buyer-shows`
}

export function downloadBuyerShowItemHref(productId: string, buyerShowId: string) {
  return `/api/products/${encodeURIComponent(productId)}/download-buyer-shows/${encodeURIComponent(buyerShowId)}`
}

export function downloadBuyerShowsBatchHref(productIds: string[]) {
  return `/api/products/buyer-shows/download?ids=${encodeURIComponent(productIds.join(','))}`
}

export function isUsefulProductImage(src?: string) {
  if (!src) return false
  if (/avatar|sns|user|flag|logo\?type|safe|loading|sprite|icon|wangwang|qrcode|QRCode|tps-\d{1,3}-\d{1,3}|6000000004257-2-tps-174-106/i.test(src)) {
    return false
  }
  return /\/\/(gw|img)\.alicdn\.com\/(imgextra|bao\/uploaded)/i.test(src)
}

export function cleanShopName(name?: string) {
  if (!name) return '未知店铺'
  const compact = name.replace(/\s+/g, '').replace(/天猫Tmall|淘宝|Taobao/gi, '')
  const match = compact.match(/^(.{2,40}?(?:旗舰店|专卖店|专营店|官方店|企业店|店铺|店))/)
  const cleaned = (match?.[1] || compact)
    .replace(/(?:综合体验|体验分|宝贝描述|物流服务|服务态度|客服满意|好评率|粉丝|关注|进店|全部商品|优惠券|平均|小时发货|VIP|%|>|¥|\d+(?:\.\d+)?).*$/i, '')
    .slice(0, 40)
  return cleaned || '未知店铺'
}

export function inferModel(text?: string) {
  if (!text) return ''
  const normalized = text.replace(/\s+/g, ' ')
  const explicit = normalized.match(/(?:型号|货号|款号|系列|版本|规格)[:： ]{0,3}([A-Za-z0-9][A-Za-z0-9\-_/]{1,24})/i)
  if (explicit?.[1]) return explicit[1]
  const token = normalized.match(/\b([A-Z]{1,5}[-_]?\d{2,5}[A-Z0-9\-_/]{0,12}|\d{2,5}[A-Z]{1,5}[A-Z0-9\-_/]{0,12})\b/)
  return token?.[1] || ''
}

export function cleanProductTitle(title?: string) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-_—|]*\s*(tmall\.com)?\s*天猫\s*$/i, '')
    .replace(/\s*[-_—|]*\s*淘宝网?\s*$/i, '')
    .replace(/\s*[-_—|]*\s*Tmall\s*$/i, '')
    .trim()
}

export function productTitle(product: Product) {
  return cleanProductTitle(product.lastSnapshot?.title || product.name) || product.name
}

export function productShopName(product: Product) {
  return cleanShopName(product.shopName || product.lastSnapshot?.shopName)
}

export function productModel(product: Product) {
  return product.model || product.lastSnapshot?.model || inferModel(product.name) || '未识别型号'
}

export function productItemId(product: Product) {
  const captured = product.itemId || product.lastSnapshot?.itemId
  if (captured) return captured
  try {
    const url = new URL(product.url)
    return url.searchParams.get('id') || url.searchParams.get('itemId') || ''
  } catch {
    return product.url.match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})/i)?.[1] || ''
  }
}

export function productImages(product: Product) {
  const snapshot = product.lastSnapshot
  const explicitPrimary = snapshot?.mainImage800
  const imageIdentity = (src: string) => src.replace(/^https?:\/\/(?:gw|img)\.alicdn\.com/i, 'alicdn').replace(/[?#].*$/, '').toLowerCase()
  const explicitGallery = Array.from(new Map((snapshot?.gallery750Images || [])
    .filter(isUsefulProductImage)
    .map((image) => [imageIdentity(image), image])).values()).slice(0, 5)
  if (explicitPrimary) {
    return { primary: explicitPrimary, gallery: explicitGallery, secondary: explicitGallery }
  }
  const snapshotImages = snapshot?.mainImages?.length ? snapshot.mainImages : []
  const candidates = [...snapshotImages, snapshot?.mainImage, product.mainImage].filter(isUsefulProductImage) as string[]
  const unique = Array.from(new Set(candidates))
  const primary = unique[0] || ''
  const gallery = unique.slice(1, 6)
  return { primary, gallery, secondary: gallery }
}

export function productDetailImages(product: Product) {
  return Array.from(new Set((product.lastSnapshot?.detailImages || []).filter(isUsefulProductImage))).slice(0, 80)
}

export function productVideos(product: Product) {
  const seen = new Set<string>()
  const videos: string[] = []
  const imageOwners = new Set<string>()
  const mediaImages = [
    product.lastSnapshot?.mainImage,
    ...(product.lastSnapshot?.mainImages || []),
    ...(product.lastSnapshot?.skuImages || []),
  ].filter(Boolean) as string[]
  for (const image of mediaImages) {
    const pathOwner = image.match(/\/i\d\/(\d{6,})\//i)?.[1]
    const suffixOwner = image.match(/!!(\d{6,})(?:[.!_?#]|$)/)?.[1]
    if (pathOwner) imageOwners.add(pathOwner)
    if (suffixOwner) imageOwners.add(suffixOwner)
  }
  for (const video of product.lastSnapshot?.videoUrls || []) {
    const normalized = video.replace(/^http:\/\//i, 'https://')
    let parsed: URL
    try {
      parsed = new URL(normalized)
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:') continue
    if (!/(^|\.)(taobao\.com|alicdn\.com)$/i.test(parsed.hostname)) continue
    if (!/\.(mp4|m3u8)$/i.test(parsed.pathname)) continue
    if (/\/(?:u|user)\/(?:null|undefined|0)\//i.test(parsed.pathname)) continue
    if (/placeholder|default|loading|sample|preview|test/i.test(parsed.pathname)) continue
    const videoOwner = parsed.pathname.match(/\/(?:u|user)\/(\d{6,})\//i)?.[1]
    if (imageOwners.size && videoOwner && !imageOwners.has(videoOwner)) continue
    const key = parsed.pathname.match(/\/(\d{8,})\.(?:mp4|m3u8)$/i)?.[1] || `${parsed.hostname}${parsed.pathname}`
    if (seen.has(key)) continue
    seen.add(key)
    videos.push(parsed.toString())
  }
  return videos.slice(0, 6)
}

export function priceRangeText(product: Product) {
  const range = product.lastSnapshot?.priceRange
  if (range) return `${currency(range[0])} - ${currency(range[1])}`
  return currency(product.lastSnapshot?.price)
}
