import { getRenderedHtml, skuIdFromNetworkUrl } from "../server/services/browserService.js";
import { saveBrowserCaptureSource, readBrowserCaptureSource } from "../server/services/localImportService.js";
import { resolveSkuPriceEvidence } from "../server/services/priceResolver.js";
import { buildBrowserCaptureEvidence } from "../server/services/tmallScraper.js";
import { readDb } from "../server/storage/db.js";

function parsePayload(body) {
  const source = String(body || "").trim();
  const json = source.startsWith("{") ? source : source.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeJson(value) {
  if (typeof value !== "string") return value;
  const source = value.trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return value;
  try {
    return JSON.parse(source);
  } catch {
    return value;
  }
}

function collectEvidence(value, path = "$", result = [], depth = 0) {
  if (!value || depth > 12) return result;
  const decoded = decodeJson(value);
  if (decoded !== value) return collectEvidence(decoded, path, result, depth + 1);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEvidence(item, `${path}[${index}]`, result, depth + 1));
    return result;
  }
  if (typeof value !== "object") return result;

  const trackParams = decodeJson(value.trackParams);
  const pocket = decodeJson(value.tbShopRedPocket);
  const promotionList = pocket?.umpInfo?.umpPromotionList || value?.umpInfo?.umpPromotionList;
  if (trackParams?.skuId || Array.isArray(promotionList)) {
    result.push({
      path,
      trackParams: trackParams && typeof trackParams === "object" ? {
        skuId: trackParams.skuId,
        price1: trackParams.price1,
        price2: trackParams.price2,
        pricedetails1: trackParams.pricedetails1,
        promotionType: trackParams.promotionType,
      } : null,
      promotions: Array.isArray(promotionList) ? promotionList.map((item) => ({
        promotionName: item.promotionName,
        amount: item.amount,
      })) : [],
    });
  }
  for (const [key, item] of Object.entries(value)) collectEvidence(item, `${path}.${key}`, result, depth + 1);
  return result;
}

const itemId = process.argv[2];
const accountType = process.argv[3] || "normal";
const selectionArguments = process.argv.slice(4);
const selectSkuNames = selectionArguments.filter((argument) => argument.startsWith("name=")).map((argument) => argument.slice(5)).filter(Boolean);
const selections = selectionArguments.filter((argument) => !argument.startsWith("name=")).map((argument) => {
  const [skuId, ids = ""] = argument.split(":");
  return { skuId, valueIds: ids.split(",").filter(Boolean) };
});
if (!itemId || (!selections.length && !selectSkuNames.length)) {
  console.error("Usage: node scripts/inspect-price-evidence.mjs <itemId> <normal|gift|vip88> <skuId:valueId,valueId|name=SKU名称> [...]");
  process.exit(1);
}

const db = await readDb();
const session = db.authSessions.find((item) => item.accountType === accountType && (item.enabled ?? item.active ?? true));
if (!session) throw new Error(`No enabled ${accountType} account session`);

const product = { itemId, url: `https://detail.tmall.com/item.htm?id=${itemId}` };
const capturedAt = new Date().toISOString();
let saved = null;
const page = await getRenderedHtml(product.url, session, {
  ...(selections.length ? { selectSkus: selections } : { selectSkuNames }),
  persistEvidenceBeforeClose: async (observedPage) => {
    saved = await saveBrowserCaptureSource(buildBrowserCaptureEvidence({
      product,
      accountType,
      itemId,
      page: observedPage,
      promotionCapture: { networkPayloads: [], selectionResults: observedPage.selectionResults || [] },
      capturedAt,
    }));
  },
});
// Keep diagnostic adapters that do not implement the hook compatible while
// preserving the same local-only parse boundary.
if (!saved) saved = await saveBrowserCaptureSource(buildBrowserCaptureEvidence({
  product,
  accountType,
  itemId,
  page,
  promotionCapture: { networkPayloads: [], selectionResults: page.selectionResults || [] },
  capturedAt,
}));
const stored = await readBrowserCaptureSource(saved.captureId);
const localPage = stored.page || {};
const responses = (localPage.networkPayloads || [])
  .filter((payload) => /mtop\.taobao\.pcdetail\.data\.adjust/i.test(payload.url || ""))
  .map((payload) => {
    const parsed = parsePayload(payload.body);
    return {
      endpoint: "mtop.taobao.pcdetail.data.adjust",
      requestSkuId: payload.requestSkuId || "",
      responseSkuId: payload.responseSkuId || "",
      groupedSkuId: payload.skuId || "",
      ret: parsed?.ret || [],
      topKeys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
      dataKeys: parsed?.data && typeof parsed.data === "object" ? Object.keys(parsed.data) : [],
      evidence: collectEvidence(parsed),
    };
  });
const resolutionSkuIds = selections.length
  ? selections.map((item) => item.skuId)
  : Array.from(new Set((localPage.networkPayloads || []).map((payload) => skuIdFromNetworkUrl(payload.url)).filter(Boolean)));
const resolutions = resolutionSkuIds.map((skuId) => {
  const selection = (localPage.selectionResults || []).find((item) => item.skuId === skuId);
  const payloads = (localPage.networkPayloads || []).filter((payload) => skuIdFromNetworkUrl(payload.url) === skuId);
  const result = resolveSkuPriceEvidence(payloads, {
    itemId,
    skuId,
    accountType,
    selectedSkuVerified: Boolean(selection?.responseReceivedAfterSelection),
    capturedAt: "diagnostic",
  });
  return {
    skuId,
    status: result.status,
    reason: result.reason || "",
    normalCents: result.channels?.normal?.valueCents || null,
    surpriseCents: result.channels?.surprise?.valueCents || null,
    giftCents: result.channels?.gift?.valueCents || null,
    vip88Cents: result.channels?.vip88?.valueCents || null,
    attempts: result.attempts || [],
  };
});

console.log(JSON.stringify({ itemId, accountType, sourceFile: stored.sourceFile, localFirst: stored.localFirst, selectionResults: localPage.selectionResults, responses, resolutions }, null, 2));
process.exit(0);
