import { getRenderedHtml } from "../server/services/browserService.js";
import { extractBuyerShowItems } from "../server/services/tmallScraper.js";
import { readDb } from "../server/storage/db.js";

function parseBody(body) {
  const source = String(body || "").trim();
  const json = source.startsWith("{") ? source : source.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function arraySchemas(value, path = "$", result = [], depth = 0) {
  if (!value || depth > 8) return result;
  if (typeof value === "string" && /^[{[]/.test(value.trim())) {
    try {
      return arraySchemas(JSON.parse(value), path, result, depth + 1);
    } catch {
      return result;
    }
  }
  if (Array.isArray(value)) {
    const keys = value[0] && typeof value[0] === "object" ? Object.keys(value[0]).sort() : [];
    if (keys.some((key) => /rate|review|comment|content|pic|image|video|append/i.test(key))) result.push({ path, length: value.length, keys });
    value.slice(0, 2).forEach((item, index) => arraySchemas(item, `${path}[${index}]`, result, depth + 1));
    return result;
  }
  if (typeof value === "object") Object.entries(value).forEach(([key, item]) => arraySchemas(item, `${path}.${key}`, result, depth + 1));
  return result;
}

const itemId = process.argv[2];
const accountType = process.argv[3] || "normal";
if (!itemId) throw new Error("Usage: node scripts/inspect-buyer-show.mjs <itemId> [accountType]");
const db = await readDb();
const session = db.authSessions.find((item) => item.accountType === accountType && (item.enabled ?? item.active ?? true));
if (!session) throw new Error(`No enabled ${accountType} account session`);
const page = await getRenderedHtml(`https://detail.tmall.com/item.htm?id=${encodeURIComponent(itemId)}`, session, { captureBuyerShow: true });
const payloads = page.buyerShowPayloads || [];
const parsedItems = extractBuyerShowItems("", payloads);
console.log(JSON.stringify({
  itemId,
  payloadCount: payloads.length,
  parsedCount: parsedItems.length,
  mediaCount: parsedItems.reduce((sum, item) => sum + item.images.length + item.videoUrls.length, 0),
  payloads: payloads.map((payload) => {
    const url = new URL(payload.url);
    const parsed = parseBody(payload.body);
    return {
      endpoint: `${url.hostname}${url.pathname}`,
      api: url.searchParams.get("api") || "",
      bytes: payload.body.length,
      topKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [],
      arrays: arraySchemas(parsed).slice(0, 12),
    };
  }),
}, null, 2));
process.exit(0);
