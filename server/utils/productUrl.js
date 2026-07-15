export function itemIdFromProductUrl(value) {
  const raw = String(value || "").trim();
  const candidate = raw.match(/https?:\/\/[^\s]+/i)?.[0] || raw;
  const url = new URL(candidate);
  if (!/(^|\.)(taobao|tmall)\.com$/i.test(url.hostname)) throw new Error("请填写淘宝或天猫商品链接。");
  const itemId = url.searchParams.get("id") || url.searchParams.get("itemId") || candidate.match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})/i)?.[1];
  if (!itemId || !/^\d{6,20}$/.test(itemId)) throw new Error("商品链接中缺少有效的商品 ID。");
  return itemId;
}

export function normalizeProductUrl(value) {
  const raw = String(value || "").trim();
  const candidate = raw.match(/https?:\/\/[^\s]+/i)?.[0] || raw;
  const url = new URL(candidate);
  const itemId = itemIdFromProductUrl(candidate);
  const host = /(^|\.)tmall\.com$/i.test(url.hostname) ? "detail.tmall.com" : "item.taobao.com";
  return `https://${host}/item.htm?id=${itemId}`;
}

export function assertMatchingProductId(requestedUrl, capturedItemId, finalUrl = "") {
  const requestedItemId = itemIdFromProductUrl(requestedUrl);
  const actualItemId = String(capturedItemId || "");
  if (!actualItemId) {
    throw new Error(`商品身份校验失败：页面未返回商品 ID ${requestedItemId}，本次结果已拒绝保存。`);
  }
  if (actualItemId !== requestedItemId) {
    throw new Error(`商品身份校验失败：输入商品 ID ${requestedItemId}，页面最终返回 ${actualItemId}。本次结果已拒绝保存，避免串品；请检查链接是否已失效或跳转到其他商品。${finalUrl ? ` 最终地址：${finalUrl}` : ""}`);
  }
  return requestedItemId;
}
