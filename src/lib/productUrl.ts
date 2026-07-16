export type ProductPlatform = 'tmall' | 'taobao'

export function itemIdFromProductInput(value: string) {
  return value.trim().match(/^\d{6,20}$/)?.[0]
    || value.match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})(?!\d)/i)?.[1]
    || ''
}

export function productUrlForItemId(value: string, platform: ProductPlatform) {
  const itemId = itemIdFromProductInput(value)
  if (!itemId) throw new Error('请输入 6 至 20 位商品 ID。')
  return platform === 'tmall'
    ? `https://detail.tmall.com/item.htm?id=${itemId}`
    : `https://item.taobao.com/item.htm?id=${itemId}`
}

export function normalizeProductUrl(value: string) {
  const candidate = value.trim().match(/https?:\/\/[^\s]+/i)?.[0] || value.trim()
  const url = new URL(candidate)
  if (!/(^|\.)(taobao|tmall)\.com$/i.test(url.hostname)) throw new Error('请填写淘宝或天猫商品链接。')
  const itemId = url.searchParams.get('id') || url.searchParams.get('itemId') || candidate.match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})/i)?.[1]
  if (!itemId || !/^\d{6,20}$/.test(itemId)) throw new Error('商品链接中缺少有效的商品 ID。')
  const host = /(^|\.)tmall\.com$/i.test(url.hostname) ? 'detail.tmall.com' : 'item.taobao.com'
  return `https://${host}/item.htm?id=${itemId}`
}

export function normalizeProductUrlIfPossible(value: string) {
  try {
    return normalizeProductUrl(value)
  } catch {
    return value.trim()
  }
}
