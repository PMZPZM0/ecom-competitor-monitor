import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dbRuntimeInfo, readDb } from "../storage/db.js";
import { PRICE_PARSER_VERSION } from "./priceResolver.js";
import { hydrateBrowserCapturePage, resolveLocalSkuPriceRows } from "./tmallScraper.js";

export const LOCAL_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const LOCAL_IMPORT_MAX_FILES = 200;
export const CAPTURE_EVIDENCE_MAX_FILES = 500;
export const BROWSER_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;

const accountTypes = new Set(["normal", "gift", "vip88"]);
// Keep this list aligned with priceResolver's channel contract. Local imports
// are parsed from the sanitized on-disk evidence, so every channel must be
// retained when the record is serialized.
const priceKinds = ["normal", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"];
const importIdPattern = /^local_[a-f0-9]{32}$/;
const automaticEvidenceFilenamePattern = /^(local_[a-f0-9]{32})\.json$/;
const localImportSourceFilenamePattern = /^(local_[a-f0-9]{32})\.source\.txt$/;
const browserCaptureIdPattern = /^capture_[a-f0-9]{32}$/;
const browserCaptureSourceFilenamePattern = /^(capture_[a-f0-9]{32})\.source\.txt$/;
const browserCaptureSkuSourceFilenamePattern = /^(capture_[a-f0-9]{32})\.sku-(\d{4})\.source\.txt$/;
const BROWSER_CAPTURE_MAX_SKU_SNAPSHOTS = 1000;
const BROWSER_CAPTURE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const itemIdPattern = /^\d{6,20}$/;
const skuIdPattern = /^\d{1,30}$/;
const discardedSourceKeyPattern = /^(?:body|content|rawContent|networkPayloads|payloads)$/i;
const identitySourceKeys = new Set([
  "nick", "nickname", "userid", "uid", "accountid", "loginid", "openid", "unionid",
  "unb", "munb", "wkunb", "wkcookie2", "tmsc", "opi", "pacc", "tracknick", "lgc", "login", "miid",
  "addresslist", "addressid", "areaid", "briefaddress", "detailaddress", "tel", "username", "displaynick",
]);
const sensitiveTextKeySource = String.raw`api[_-]?key|auth[_-]?key|authorization|cookie|password|passwd|secret|sign|signature|token|x5sec|_?m[_-]?h5[_-]?tk(?:[_-]?enc)?|_?tb[_-]?token_?|x[_-]?sign|x[_-]?sgext|x[_-]?mini[_-]?wua|nick|nickname|user[_-]?id|uid|account[_-]?id|login[_-]?id|open[_-]?id|union[_-]?id|mi[_-]?id|munb|unb|wk[_-]?unb|wk[_-]?cookie2|tmsc|opi|pacc|tracknick|lgc|login|address[_-]?id|area[_-]?id|brief[_-]?address|detail[_-]?address|tel|user[_-]?name|display[_-]?nick`;
const sensitiveQueryPattern = new RegExp(`((?:[?&]|&amp;)(?:${sensitiveTextKeySource})=)[^&#\\s"'<>]*`, "gi");
const sensitiveAssignmentPattern = new RegExp(`((?:^|[\\s,{;])["']?(?:${sensitiveTextKeySource})["']?\\s*[:=]\\s*)(?:"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\r\\n,;}]+)`, "gim");
const sensitiveEscapedStringAssignmentPattern = new RegExp(`((?:\\\\["'])(?:${sensitiveTextKeySource})(?:\\\\["'])\\s*:\\s*\\\\["'])(.*?)(\\\\["'])`, "gi");
const sensitiveEscapedScalarAssignmentPattern = new RegExp(`((?:\\\\["'])(?:${sensitiveTextKeySource})(?:\\\\["'])\\s*:\\s*)(-?\\d+(?:\\.\\d+)?|true|false|null)`, "gi");
const encodedCredentialQueryPattern = /((?:[?&]|&amp;)(?:data|ex[_-]?params)=)[^&#\s"'<>]*/gi;

function identityTextVariants(values = []) {
  const variants = new Set();
  const add = (value) => {
    const candidate = String(value || "").trim();
    // Very short values can be ordinary SKU or price characters. Structured
    // identity keys still redact them; plain-text hints require two characters.
    if (candidate.length >= 2) variants.add(candidate);
  };
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const decoded = (() => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    })();
    for (const candidate of new Set([raw, decoded])) {
      add(candidate);
      const encoded = encodeURIComponent(candidate);
      add(encoded);
      add(encoded.toLowerCase());
      add(candidate
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;"));
      add(JSON.stringify(candidate).slice(1, -1));
      add(Array.from(candidate, (character) => {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        return `\\u${high.toString(16)}\\u${low.toString(16)}`;
      }).join(""));
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function redactKnownIdentityText(value, variants) {
  let redacted = String(value);
  for (const variant of variants) redacted = redacted.split(variant).join("[REDACTED_ACCOUNT]");
  return redacted;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === "IMPORT_TOO_LARGE" ? 413 : ["IMPORT_NOT_FOUND", "IMPORT_SOURCE_NOT_FOUND"].includes(code) ? 404 : 400;
  return error;
}

function defaultLocalEvidenceDirectory() {
  return path.join(dbRuntimeInfo().dataDir, "capture-evidence");
}

function localImportDirectory() {
  return path.join(dbRuntimeInfo().dataDir, "local-imports");
}

function localImportSourceFile(importId) {
  return path.join(localImportDirectory(), `${importId}.source.txt`);
}

function resolveLocalEvidenceDirectory(value) {
  const configured = typeof value === "string" ? value.trim() : "";
  return configured && path.isAbsolute(configured) ? path.normalize(configured) : defaultLocalEvidenceDirectory();
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function configuredLocalEvidenceDirectory() {
  const db = await readDb();
  return resolveLocalEvidenceDirectory(db.localEvidence?.directory);
}

export async function validateLocalEvidenceDirectory(value) {
  const configured = typeof value === "string" ? value.trim() : "";
  if (value != null && typeof value !== "string") throw fail("INVALID_EVIDENCE_DIRECTORY", "证据保存目录格式无效。");
  if (configured && !path.isAbsolute(configured)) throw fail("INVALID_EVIDENCE_DIRECTORY", "证据保存目录必须使用绝对路径。");
  const requested = resolveLocalEvidenceDirectory(configured);
  let probe = "";
  try {
    await fs.mkdir(requested, { recursive: true });
    const directory = await fs.realpath(requested);
    probe = path.join(directory, `.ecom-monitor-write-test-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
    const handle = await fs.open(probe, "wx");
    await handle.close();
    await fs.rm(probe, { force: true });
    return directory;
  } catch {
    if (probe) await fs.rm(probe, { force: true }).catch(() => undefined);
    throw fail("EVIDENCE_DIRECTORY_UNWRITABLE", "无法创建或写入该证据保存目录，请选择有写入权限的文件夹。");
  }
}

function isSensitiveKey(key) {
  const normalized = String(key).replaceAll(/[_-]/g, "").toLowerCase();
  return identitySourceKeys.has(normalized)
    || /(?:apikey|authkey|authorization|cookie|password|passwd|secret|sign|signature|token|x5sec|mh5tk(?:enc)?|xsgext|xminiwua)$/.test(normalized);
}

function safeProductEvidenceUrl(value, itemId = "") {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    const observedItemId = url.searchParams.get("id") || url.searchParams.get("itemId") || "";
    const safeItemId = itemIdPattern.test(String(itemId)) ? String(itemId) : itemIdPattern.test(observedItemId) ? observedItemId : "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (safeItemId) url.searchParams.set("id", safeItemId);
    return url.toString();
  } catch {
    return "";
  }
}

function safeNetworkEvidenceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    const identity = requestIdentity(url.toString());
    const isPcdetailAdjust = /mtop\.taobao\.pcdetail\.data\.adjust/i.test(`${url.hostname}${url.pathname}`);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (isPcdetailAdjust && itemIdPattern.test(identity.itemId) && skuIdPattern.test(identity.skuId)) {
      url.searchParams.set("itemId", identity.itemId);
      url.searchParams.set("skuId", identity.skuId);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function redactBrowserEncodedQueries(value, depth = 0) {
  if (depth > 50 || value == null) return value;
  if (Array.isArray(value)) return value.map((child) => redactBrowserEncodedQueries(child, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactBrowserEncodedQueries(child, depth + 1)]));
  }
  return typeof value === "string" ? value.replace(encodedCredentialQueryPattern, "$1[REDACTED]") : value;
}

function sanitizeBrowserCaptureShape(capture) {
  const itemId = String(capture?.itemId || "");
  const page = capture?.page && typeof capture.page === "object" && !Array.isArray(capture.page) ? capture.page : {};
  const pageText = `${page.finalUrl || capture?.finalUrl || ""}\n${page.visibleText || ""}\n${page.html || ""}`;
  const loginOrVerificationPage = !/skuCore|skuBase|skuOptionsArea/i.test(pageText)
    && /(?:login|passport)\.(?:m\.)?(?:taobao|tmall)\.com|手机扫码登录|密码登录|短信登录|安全验证|请完成验证/i.test(pageText);
  return redactBrowserEncodedQueries({
    ...capture,
    requestedUrl: safeProductEvidenceUrl(capture?.requestedUrl, itemId),
    finalUrl: safeProductEvidenceUrl(capture?.finalUrl, itemId),
    page: {
      ...page,
      finalUrl: safeProductEvidenceUrl(page.finalUrl, itemId),
      // Login responses can contain short-lived QR credentials. They have no
      // product evidence value and must never be written to a local capture.
      networkPayloads: !loginOrVerificationPage && Array.isArray(page.networkPayloads)
        ? page.networkPayloads.map((payload) => {
          const captureRunId = String(payload?.captureRunId || "");
          const responseSequence = Number(payload?.responseSequence);
          return {
            url: safeNetworkEvidenceUrl(payload?.url),
            mimeType: String(payload?.mimeType || ""),
            responseKind: payload?.responseKind === "buyer-show" ? "buyer-show" : "price",
            body: String(payload?.body || ""),
            ...(/^[a-z0-9_-]{1,80}$/i.test(captureRunId) ? { captureRunId } : {}),
            ...(Number.isSafeInteger(responseSequence) && responseSequence > 0 ? { responseSequence } : {}),
          };
        })
        : [],
    },
  });
}

function parseJsonLike(value, depth = 0) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || depth > 3) return null;
  const source = value.trim();
  if (!source) return null;
  const json = source.startsWith("{") || source.startsWith("[")
    ? source
    : source.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "string" ? parseJsonLike(parsed, depth + 1) : parsed;
  } catch {
    return null;
  }
}

function inputTypeOf(content) {
  const source = content.trim();
  if (/^(?:<!doctype\s+html|<html|<head|<body|<script)\b/i.test(source)) return "html";
  if ((source.startsWith("{") || source.startsWith("[")) && parseJsonLike(source)) return "json";
  if (/^[\w$.]+\s*\([\s\S]*\)\s*;?$/.test(source) && parseJsonLike(source)) return "jsonp";
  return "text";
}

function requestIdentity(value) {
  try {
    const url = new URL(String(value || ""));
    const data = parseJsonLike(url.searchParams.get("data") || "") || {};
    const exParams = parseJsonLike(data.exParams) || {};
    return {
      itemId: String(exParams.itemId || exParams.itemNumId || data.itemId || data.itemNumId || url.searchParams.get("itemId") || url.searchParams.get("id") || ""),
      skuId: String(exParams.skuId || data.skuId || data.selectSkuId || url.searchParams.get("skuId") || ""),
    };
  } catch {
    return { itemId: "", skuId: "" };
  }
}

function responseTrackParams(value) {
  const parsed = parseJsonLike(value);
  const component = parsed?.data?.componentsVO?.xsRedPacketParamVO;
  return component ? parseJsonLike(component.trackParams) || component.trackParams || {} : null;
}

function collectItemIdCandidates(parsed, content) {
  const candidates = new Set();
  const add = (value) => {
    const candidate = String(value ?? "").trim();
    if (itemIdPattern.test(candidate)) candidates.add(candidate);
  };
  const stack = parsed && typeof parsed === "object" ? [parsed] : [];
  const seen = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:itemId|itemNumId)$/i.test(key)) add(child);
      if (/url/i.test(key) && typeof child === "string") add(requestIdentity(child).itemId);
      if (child && typeof child === "object") stack.push(child);
      else if (typeof child === "string") {
        const decoded = parseJsonLike(child);
        if (decoded && typeof decoded === "object") stack.push(decoded);
      }
    }
  }
  for (const match of content.matchAll(/(?:[?&]|&amp;)(?:id|itemId)=(\d{6,20})(?=[&#"'\s]|$)/gi)) add(match[1]);
  for (const match of content.matchAll(/["'](?:itemId|itemNumId)["']\s*:\s*["']?(\d{6,20})/gi)) add(match[1]);
  return candidates;
}

function selectItemId(candidates, hint) {
  if (hint != null && hint !== "" && !itemIdPattern.test(String(hint))) {
    throw fail("INVALID_ITEM_ID", "商品 ID 必须是 6 到 20 位数字。");
  }
  const itemIdHint = String(hint || "");
  const observed = [...candidates];
  if (observed.length > 1 || (itemIdHint && observed.length === 1 && observed[0] !== itemIdHint)) {
    throw fail("AMBIGUOUS_ITEM_ID", "导入内容包含互相冲突的商品 ID，已停止解析。");
  }
  return observed[0] || "";
}

function cleanPcdetailUrl(itemId, skuId) {
  const data = encodeURIComponent(JSON.stringify({ itemId, skuId }));
  return `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`;
}

function collectPricePayloads(parsed, itemId) {
  const payloads = [];
  const seenObjects = new Set();
  const seenPayloads = new Set();
  const add = (bodyValue, record = {}) => {
    const bodyObject = parseJsonLike(bodyValue);
    const trackParams = responseTrackParams(bodyObject);
    if (!trackParams) return;
    const originalIdentity = requestIdentity(record.url);
    const explicitItemId = String(record.itemId || record.itemNumId || "");
    const responseSkuId = String(trackParams.skuId || "");
    const itemIds = [originalIdentity.itemId, itemIdPattern.test(explicitItemId) ? explicitItemId : ""].filter(Boolean);
    const skuIds = [originalIdentity.skuId, record.requestSkuId, record.skuId].map(String).filter((value) => skuIdPattern.test(value));
    if (!itemIds.length && !skuIds.length) return;
    const requestItemId = itemIds[0] || "";
    const requestSkuId = skuIds[0] || "";
    const skuId = requestSkuId || responseSkuId;
    if (!skuIdPattern.test(skuId)) return;
    const body = JSON.stringify(bodyObject);
    const identityVerified = itemIdPattern.test(requestItemId)
      && skuIdPattern.test(requestSkuId)
      && responseSkuId === requestSkuId
      && new Set(itemIds).size === 1
      && new Set(skuIds).size === 1
      && (!itemId || requestItemId === itemId);
    const payload = {
      url: identityVerified ? cleanPcdetailUrl(requestItemId, requestSkuId) : "",
      body,
      skuId: identityVerified ? requestSkuId : "",
      requestSkuId: identityVerified ? requestSkuId : "",
      responseSkuId,
    };
    const fingerprint = crypto.createHash("sha256").update(`${String(record.url || "")}\n${body}`).digest("hex");
    if (seenPayloads.has(fingerprint)) return;
    seenPayloads.add(fingerprint);
    payloads.push({ skuId, payload: identityVerified ? payload : null, identityVerified });
  };
  const stack = parsed && typeof parsed === "object" ? [parsed] : [];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seenObjects.has(value)) continue;
    seenObjects.add(value);
    if (Object.hasOwn(value, "body")) add(value.body, value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "body") continue;
      if (child && typeof child === "object") stack.push(child);
      else if (typeof child === "string" && /(?:body|payload|response|network)/i.test(key)) {
        const decoded = parseJsonLike(child);
        if (decoded && typeof decoded === "object") stack.push(decoded);
      }
    }
  }
  return payloads;
}

function metadataFrom(parsed, content) {
  const wanted = {
    title: /^(?:itemTitle|productTitle|title)$/i,
    shopName: /^(?:shopName|shopTitle|storeName|sellerName|sellerNick)$/i,
    model: /^(?:model|modelName|productModel)$/i,
  };
  const result = { title: "", shopName: "", model: "" };
  const stack = parsed && typeof parsed === "object" ? [parsed] : [];
  const seen = new Set();
  while (stack.length && Object.values(result).some((value) => !value)) {
    const value = stack.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        for (const [field, pattern] of Object.entries(wanted)) {
          if (!result[field] && pattern.test(key)) result[field] = child.replace(/\s+/g, " ").trim().slice(0, 160);
        }
      } else if (child && typeof child === "object") stack.push(child);
    }
  }
  if (!result.title) {
    result.title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "";
  }
  return result;
}

function buildSnapshot({ content, parsed, itemId, accountType, capturedAt }) {
  const evidenceHtml = typeof parsed?.page?.html === "string" ? parsed.page.html : content;
  const browserPage = parsed?.captureType === "account-browser-local-source"
    ? hydrateBrowserCapturePage(parsed)
    : null;
  const normalizedPayloads = browserPage
    ? Object.entries(browserPage.skuNetworkPayloads || {}).flatMap(([skuId, payloads]) => (
      payloads.map((payload) => ({ skuId, payload, identityVerified: true }))
    ))
    : collectPricePayloads(parsed, itemId);
  const payloadsBySku = new Map();
  for (const entry of normalizedPayloads) {
    if (!entry.payload) continue;
    const entries = payloadsBySku.get(entry.skuId) || [];
    entries.push(entry.payload);
    payloadsBySku.set(entry.skuId, entries);
  }
  const localPage = browserPage || {
    html: evidenceHtml,
    skuNetworkPayloads: Object.fromEntries([...new Set(normalizedPayloads.map((entry) => entry.skuId).filter(Boolean))]
      .map((skuId) => [skuId, payloadsBySku.get(skuId) || []])),
    selectionResults: [...new Set(normalizedPayloads.map((entry) => entry.skuId).filter(Boolean))]
      .map((skuId) => ({ skuId, selected: true, responseObserved: true })),
    skuSnapshots: [],
  };
  const { structuredSku } = resolveLocalSkuPriceRows(localPage, { itemId, accountType, capturedAt });
  const skuPrices = structuredSku.skuPrices;
  const observedSkuCount = skuPrices.length;
  const verifiedSkuCount = skuPrices.filter((sku) => sku.resolutionStatus === "verified").length;
  const prices = skuPrices.filter((sku) => sku.resolutionStatus === "verified").map((sku) => Number(sku.normalPrice)).filter((price) => Number.isFinite(price) && price > 0);
  const metadata = metadataFrom(parsed, content);
  const priceRange = prices.length ? [Math.min(...prices), Math.max(...prices)] : null;
  return {
    parserVersion: PRICE_PARSER_VERSION,
    resolutionStatus: observedSkuCount > 0 && skuPrices.length === observedSkuCount && verifiedSkuCount === observedSkuCount ? "verified" : verifiedSkuCount ? "partial" : "unavailable",
    capturedAt,
    source: "local-import",
    accessMode: "authenticated",
    itemId,
    finalUrl: itemId ? `https://detail.tmall.com/item.htm?id=${itemId}` : "",
    title: metadata.title || (itemId ? `本地导入商品 ${itemId}` : "未识别商品"),
    shopName: metadata.shopName,
    model: metadata.model,
    mainImage: "",
    mainImage800: "",
    gallery750Images: [],
    mainImages: [],
    detailImages: [],
    videoUrls: [],
    skuImages: [],
    skuPrices,
    price: priceRange?.[0] ?? null,
    priceRange,
    buyerShows: [],
    buyerShowCapture: {
      status: "skipped",
      source: "disabled",
      failureCode: "LOCAL_IMPORT_NOT_INCLUDED",
      itemId,
      reportedTotal: 0,
      pageCount: 0,
      requestCount: 0,
      items: [],
      mediaCount: 0,
      textOnlyCount: 0,
      capturedAt,
    },
    primaryAccountType: accountType,
    rawSignals: {
      htmlBytes: Buffer.byteLength(content, "utf8"),
      imageCount: 0,
      skuImageCount: 0,
      priceCount: verifiedSkuCount,
      highResImageCount: 0,
      videoCount: 0,
      buyerShowCount: 0,
      detailImageCount: 0,
      inputBytes: Buffer.byteLength(content, "utf8"),
      observedPriceResponseCount: normalizedPayloads.length,
      skuCount: observedSkuCount,
      observedSkuCount,
      outputSkuCount: skuPrices.length,
      verifiedPriceSkuCount: verifiedSkuCount,
      skuHtmlSnapshotCount: new Set((browserPage?.skuSnapshots || []).filter((snapshot) => snapshot?.selected).map((snapshot) => String(snapshot.skuId))).size,
      unverifiedPriceSkuCount: observedSkuCount - verifiedSkuCount,
      originalContentDiscarded: true,
      localSourceStored: true,
      localSourceSanitized: true,
      buyerShowCaptureSkipped: true,
    },
  };
}

function redactDeep(value) {
  return JSON.parse(JSON.stringify(value, (key, child) => {
    if (discardedSourceKeyPattern.test(key)) return "[DISCARDED]";
    return isSensitiveKey(key) ? "[REDACTED]" : child;
  }));
}

function redactSensitiveText(value, identityVariants = []) {
  return redactKnownIdentityText(value, identityVariants)
    .replace(sensitiveQueryPattern, "$1[REDACTED]")
    .replace(sensitiveAssignmentPattern, "$1\"[REDACTED]\"")
    .replace(sensitiveEscapedStringAssignmentPattern, "$1[REDACTED]$3")
    .replace(sensitiveEscapedScalarAssignmentPattern, "$1\"[REDACTED]\"");
}

function sanitizeLocalSourceValue(value, depth = 0, identityVariants = []) {
  if (depth > 50) return "[DISCARDED_DEEP_CONTENT]";
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((child) => sanitizeLocalSourceValue(child, depth + 1, identityVariants));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : sanitizeLocalSourceValue(child, depth + 1, identityVariants),
    ]));
  }
  if (typeof value !== "string") return value;
  const nested = parseJsonLike(value);
  return nested && typeof nested === "object"
    ? JSON.stringify(sanitizeLocalSourceValue(nested, depth + 1, identityVariants))
    : redactSensitiveText(value, identityVariants);
}

function sanitizeLocalImportSource(content, identityHints = []) {
  const identityVariants = identityTextVariants(identityHints);
  const parsed = parseJsonLike(content);
  if (!parsed || typeof parsed !== "object") return redactSensitiveText(content, identityVariants);
  const serialized = JSON.stringify(sanitizeLocalSourceValue(parsed, 0, identityVariants));
  const callback = content.trim().match(/^([\w$.]+)\s*\(/)?.[1];
  return callback ? `${callback}(${serialized})` : serialized;
}

function safeText(value, maxLength = 160) {
  const cleaned = Array.from(String(value || ""), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safePriceResolution(resolution) {
  if (!resolution || typeof resolution !== "object") return null;
  const channels = {};
  for (const kind of priceKinds) {
    const channel = resolution.channels?.[kind];
    if (!channel || typeof channel !== "object") continue;
    channels[kind] = {
      status: ["verified", "ambiguous", "unavailable", "stale"].includes(channel.status) ? channel.status : "unavailable",
      valueCents: Number.isSafeInteger(channel.valueCents) && channel.valueCents > 0 ? channel.valueCents : null,
      ...(typeof channel.label === "string" ? { label: safeText(channel.label, 80) } : {}),
      ...(typeof channel.formula === "string" ? { formula: safeText(channel.formula, 500) } : {}),
      ...(typeof channel.reason === "string" ? { reason: safeText(channel.reason, 200) } : {}),
      evidenceIds: Array.isArray(channel.evidenceIds) ? channel.evidenceIds.map((id) => safeText(id, 80)).filter(Boolean).slice(0, 30) : [],
    };
  }
  return {
    status: ["verified", "partial", "ambiguous", "unavailable", "legacy"].includes(resolution.status) ? resolution.status : "unavailable",
    ...(typeof resolution.reason === "string" ? { reason: safeText(resolution.reason, 200) } : {}),
    ...(["billion", "seckill"].includes(resolution.campaignKind) ? { campaignKind: resolution.campaignKind } : {}),
    ...(typeof resolution.normalLabel === "string" ? { normalLabel: safeText(resolution.normalLabel, 80) } : {}),
    ...(typeof resolution.parserVersion === "string" ? { parserVersion: safeText(resolution.parserVersion, 80) } : {}),
    ...(typeof resolution.evidenceHash === "string" ? { evidenceHash: safeText(resolution.evidenceHash, 100) } : {}),
    channels,
  };
}

function verifiedNormalResolution(value) {
  const resolution = safePriceResolution(value?.priceResolution);
  return value?.resolutionStatus === "verified" && resolution?.status === "verified" && resolution.channels.normal?.status === "verified"
    ? resolution
    : null;
}

function safeEndpoint(value) {
  const source = String(value || "");
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 300);
  } catch {
    return safeText(source, 120);
  }
}

function safePriceDetails(value, resolution) {
  const normalPrice = resolution.channels.normal.valueCents / 100;
  const campaignFields = {
    billion: ["billionPrice", "billionStatus"],
    seckill: ["seckillPrice", "seckillStatus"],
  };
  const channelFields = {
    government: ["governmentPrice", "governmentStatus", "governmentDiscountAmount"],
    surprise: ["surprisePrice", "surpriseStatus", "surpriseDiscountAmount"],
    gift: ["giftPrice", "giftStatus", "giftDiscountAmount"],
    vip88: ["vipPrice", "vipStatus", "vipDiscountAmount"],
    coin: ["coinPrice", "coinStatus", "coinDiscountAmount"],
  };
  const result = {
    price: normalPrice,
    normalPrice,
    resolutionStatus: "verified",
    priceResolution: resolution,
    parserVersion: safeText(value.parserVersion || resolution.parserVersion || PRICE_PARSER_VERSION, 80),
    priceTitle: safeText(value.priceTitle || resolution.normalLabel || "普通价", 80),
    priceCalculation: Object.fromEntries(priceKinds.map((kind) => [kind, resolution.channels[kind]?.formula]).filter(([, formula]) => formula)),
    priceLayers: (value.priceLayers || []).map((layer) => ({
      label: safeText(layer.label, 100),
      value: Number(layer.value),
      ...(typeof layer.kind === "string" ? { kind: safeText(layer.kind, 30) } : {}),
      ...(typeof layer.source === "string" ? { source: safeText(layer.source, 80) } : {}),
    })).filter((layer) => layer.label && Number.isFinite(layer.value)).slice(0, 30),
    discountItems: (value.discountItems || []).map((item) => ({
      label: safeText(item.label, 100),
      ...(item.amount != null && Number.isFinite(Number(item.amount)) ? { amount: Number(item.amount) } : {}),
      ...(item.threshold != null && Number.isFinite(Number(item.threshold)) ? { threshold: Number(item.threshold) } : {}),
      text: safeText(item.text, 300),
      ...(typeof item.type === "string" ? { type: safeText(item.type, 30) } : {}),
      ...(typeof item.source === "string" ? { source: safeText(item.source, 80) } : {}),
    })).filter((item) => item.label || item.text).slice(0, 40),
  };
  if (Number.isFinite(Number(value.originalPrice)) && Number(value.originalPrice) > 0) result.originalPrice = Number(value.originalPrice);
  for (const [kind, [priceField, statusField]] of Object.entries(campaignFields)) {
    const channel = resolution.channels[kind];
    const available = channel?.status === "verified" && Number.isSafeInteger(channel.valueCents) && channel.valueCents > 0;
    result[priceField] = available ? channel.valueCents / 100 : null;
    result[statusField] = available ? "available" : "none";
  }
  for (const [kind, [priceField, statusField, discountField]] of Object.entries(channelFields)) {
    const channel = resolution.channels[kind];
    const available = channel?.status === "verified" && Number.isSafeInteger(channel.valueCents) && channel.valueCents > 0;
    result[priceField] = available ? channel.valueCents / 100 : null;
    result[statusField] = available ? "available" : "none";
    const discount = value[discountField] == null ? null : Number(value[discountField]);
    result[discountField] = available && Number.isFinite(discount) ? discount : null;
  }
  return result;
}

function unavailablePriceDetails(value) {
  const sourceResolution = safePriceResolution(value?.priceResolution);
  const reason = safeText(sourceResolution?.reason || "当前 SKU 缺少可闭合到分的价格证据", 200);
  const priceResolution = {
    status: "unavailable",
    reason,
    parserVersion: safeText(value?.parserVersion || sourceResolution?.parserVersion || PRICE_PARSER_VERSION, 80),
    channels: Object.fromEntries(priceKinds.map((kind) => [kind, {
      status: "unavailable",
      valueCents: null,
      reason,
      evidenceIds: [],
    }])),
  };
  return {
    price: null,
    normalPrice: null,
    originalPrice: null,
    billionPrice: null,
    billionStatus: "none",
    seckillPrice: null,
    seckillStatus: "none",
    governmentPrice: null,
    governmentStatus: "none",
    governmentDiscountAmount: null,
    surprisePrice: null,
    surpriseStatus: "none",
    surpriseDiscountAmount: null,
    giftPrice: null,
    giftStatus: "none",
    giftDiscountAmount: null,
    vipPrice: null,
    vipStatus: "none",
    vipDiscountAmount: null,
    coinPrice: null,
    coinStatus: "none",
    coinDiscountAmount: null,
    resolutionStatus: "unavailable",
    priceResolution,
    parserVersion: priceResolution.parserVersion,
    priceTitle: safeText(value?.priceTitle || "价格不可用", 80),
    priceCalculation: {},
    priceLayers: [],
    discountItems: [],
  };
}

function safeCapturedSku(value, itemId) {
  const skuId = safeText(value?.skuId, 80);
  const resolution = verifiedNormalResolution(value);
  if (!skuId) return null;
  const accountPrices = [];
  const seenAccountTypes = new Set();
  for (const accountPrice of resolution ? value.accountPrices || [] : []) {
    const accountType = accountTypes.has(accountPrice?.accountType) ? accountPrice.accountType : "normal";
    const accountResolution = verifiedNormalResolution(accountPrice);
    if (!accountResolution || seenAccountTypes.has(accountType)) continue;
    seenAccountTypes.add(accountType);
    accountPrices.push({
      sessionId: `captured-${accountType}`,
      accountName: `${accountType === "vip88" ? "88VIP" : accountType === "gift" ? "礼金" : "普通"}账号视角`,
      accountType,
      capturedAt: safeText(accountPrice.capturedAt, 40),
      ...safePriceDetails(accountPrice, accountResolution),
    });
  }
  const priceEvidence = (resolution ? value.priceEvidence || [] : []).map((evidence) => {
    if (!evidence || String(evidence.itemId) !== itemId || String(evidence.skuId) !== skuId || evidence.selectedSkuVerified !== true) return null;
    const valueCents = Number(evidence.valueCents);
    if (!Number.isSafeInteger(valueCents) || valueCents <= 0) return null;
    return {
      id: safeText(evidence.id, 100),
      itemId,
      skuId,
      accountType: accountTypes.has(evidence.accountType) ? evidence.accountType : "normal",
      kind: safeText(evidence.kind, 30),
      valueCents,
      source: safeText(evidence.source, 50),
      endpoint: safeEndpoint(evidence.endpoint),
      sourcePath: safeText(evidence.sourcePath, 300),
      promotionCodes: Array.isArray(evidence.promotionCodes) ? evidence.promotionCodes.map((code) => safeText(code, 80)).filter(Boolean).slice(0, 30) : [],
      selectedSkuVerified: true,
      capturedAt: safeText(evidence.capturedAt, 40),
      ...(typeof evidence.formula === "string" ? { formula: safeText(evidence.formula, 500) } : {}),
    };
  }).filter(Boolean);
  return {
    skuId,
    name: safeText(value.name || `SKU ${skuId}`, 240),
    image: "",
    ...(resolution ? safePriceDetails(value, resolution) : unavailablePriceDetails(value)),
    priceEvidence,
    accountPrices,
    quantity: Number.isFinite(Number(value.quantity)) && Number(value.quantity) >= 0 ? Number(value.quantity) : 0,
    ...(typeof value.quantityText === "string" ? { quantityText: safeText(value.quantityText, 100) } : {}),
    ...(typeof value.quantitySource === "string" ? { quantitySource: safeText(value.quantitySource, 50) } : {}),
  };
}

function capturedSnapshotRecord(snapshot) {
  const itemId = String(snapshot?.itemId || "").trim();
  if (!itemIdPattern.test(itemId)) throw fail("INVALID_CAPTURE_SNAPSHOT", "抓取结果缺少可靠商品 ID，未生成本地证据。");
  const observedSkuCount = (snapshot.skuPrices || []).length;
  const skuPrices = (snapshot.skuPrices || []).map((sku) => safeCapturedSku(sku, itemId)).filter(Boolean);
  if (!skuPrices.length) throw fail("INVALID_CAPTURE_SNAPSHOT", "抓取结果缺少可识别的 SKU，未生成本地证据。");
  const capturedAt = safeText(snapshot.capturedAt, 40) || new Date().toISOString();
  const verifiedSkuPrices = skuPrices.filter((sku) => sku.resolutionStatus === "verified");
  const prices = verifiedSkuPrices.map((sku) => sku.normalPrice);
  const verifiedSkuCount = verifiedSkuPrices.length;
  const unverifiedSkuCount = observedSkuCount - verifiedSkuCount;
  const accountType = accountTypes.has(snapshot.primaryAccountType) ? snapshot.primaryAccountType : "normal";
  return {
    schemaVersion: 1,
    importId: `local_${crypto.randomUUID().replaceAll("-", "")}`,
    savedFile: "",
    inputType: "json",
    createdAt: new Date().toISOString(),
    accountType,
    itemId,
    canCommit: verifiedSkuCount > 0,
    blockingReasons: verifiedSkuCount ? [] : ["没有 SKU 通过价格证据核验"],
    snapshot: {
      parserVersion: safeText(snapshot.parserVersion || PRICE_PARSER_VERSION, 80),
      resolutionStatus: observedSkuCount > 0 && verifiedSkuCount === observedSkuCount && skuPrices.length === observedSkuCount
        ? "verified"
        : verifiedSkuCount ? "partial" : "unavailable",
      capturedAt,
      source: "local-import",
      accessMode: "authenticated",
      itemId,
      finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
      title: safeText(snapshot.title || `本地抓取商品 ${itemId}`),
      shopName: safeText(snapshot.shopName),
      model: safeText(snapshot.model),
      mainImage: "",
      mainImage800: "",
      gallery750Images: [],
      mainImages: [],
      detailImages: [],
      videoUrls: [],
      skuImages: [],
      skuPrices,
      price: prices.length ? Math.min(...prices) : null,
      priceRange: prices.length ? [Math.min(...prices), Math.max(...prices)] : null,
      buyerShows: [],
      buyerShowCapture: {
        status: "skipped",
        source: "disabled",
        failureCode: "CAPTURE_EVIDENCE_NOT_INCLUDED",
        itemId,
        reportedTotal: 0,
        pageCount: 0,
        requestCount: 0,
        items: [],
        mediaCount: 0,
        textOnlyCount: 0,
        capturedAt,
      },
      primaryAccountType: accountType,
      rawSignals: {
        htmlBytes: 0,
        imageCount: 0,
        skuImageCount: 0,
        priceCount: verifiedSkuCount,
        highResImageCount: 0,
        videoCount: 0,
        buyerShowCount: 0,
        detailImageCount: 0,
        skuCount: observedSkuCount,
        observedSkuCount,
        outputSkuCount: skuPrices.length,
        verifiedPriceSkuCount: verifiedSkuCount,
        unverifiedPriceSkuCount: unverifiedSkuCount,
        originalContentDiscarded: true,
        automaticCaptureEvidence: true,
      },
    },
    sanitization: { originalContentStored: false, sensitiveFieldsRedacted: true, mediaStored: false, accountIdentityStored: false },
    origin: "automatic-capture",
  };
}

async function automaticEvidenceFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const importId = entry.isFile() ? entry.name.match(automaticEvidenceFilenamePattern)?.[1] : "";
    if (!importId) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue;
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (record?.origin !== "automatic-capture" || record.importId !== importId) continue;
      files.push({ importId, name: entry.name, file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Unreadable, malformed and user-owned files are never managed as evidence.
    }
  }
  return files;
}

function browserCaptureSkuSourceFilename(captureId, ordinal) {
  return `${captureId}.sku-${String(ordinal).padStart(4, "0")}.source.txt`;
}

async function browserCaptureArtifactFiles(directory, captureId) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const manifestFilename = `${captureId}.source.txt`;
  const files = [];
  for (const entry of entries) {
    const skuCaptureId = entry.name.match(browserCaptureSkuSourceFilenamePattern)?.[1] || "";
    if (!entry.isFile() || (entry.name !== manifestFilename && skuCaptureId !== captureId)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    files.push({ name: entry.name, file, size: stat.size });
  }
  return files;
}

async function removeBrowserCaptureArtifacts(directory, captureId) {
  const files = await browserCaptureArtifactFiles(directory, captureId);
  await Promise.all(files.map((file) => fs.rm(file.file, { force: true })));
}

async function browserCaptureSourceFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const captureId = entry.isFile() ? entry.name.match(browserCaptureSourceFilenamePattern)?.[1] : "";
    if (!captureId) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BROWSER_CAPTURE_MAX_BYTES) continue;
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (record?.captureType !== "account-browser-local-source" || record.captureId !== captureId) continue;
      const artifacts = await browserCaptureArtifactFiles(directory, captureId);
      const totalSize = artifacts.reduce((total, artifact) => total + artifact.size, 0);
      files.push({ captureId, name: entry.name, file, mtimeMs: stat.mtimeMs, size: totalSize || stat.size });
    } catch {
      // Unknown or user-owned files are not managed as browser evidence.
    }
  }
  return files;
}

async function pruneLocalImportFiles(directory, keepFilename, maxFiles = LOCAL_IMPORT_MAX_FILES, requiredOrigin = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const automaticEntries = requiredOrigin === "automatic-capture"
    ? entries.filter((entry) => entry.isFile() && automaticEvidenceFilenamePattern.test(entry.name))
    : [];
  if (requiredOrigin === "automatic-capture" && automaticEntries.length <= maxFiles) return;
  const candidates = requiredOrigin === "automatic-capture"
    ? await automaticEvidenceFiles(directory)
    : await Promise.all(entries
      .filter((entry) => entry.isFile() && importIdPattern.test(entry.name.replace(/\.json$/i, "")))
      .map(async (entry) => ({ name: entry.name, mtimeMs: (await fs.stat(path.join(directory, entry.name))).mtimeMs })));
  candidates.sort((left, right) => {
    if (left.name === keepFilename) return -1;
    if (right.name === keepFilename) return 1;
    return right.mtimeMs - left.mtimeMs;
  });
  await Promise.all(candidates.slice(maxFiles).flatMap((entry) => {
    const files = [fs.rm(path.join(directory, entry.name), { force: true })];
    const importId = entry.name.replace(/\.json$/i, "");
    if (!requiredOrigin && importIdPattern.test(importId)) files.push(fs.rm(localImportSourceFile(importId), { force: true }));
    return files;
  }));
}

async function pruneLocalImportSourceFiles(directory, keepFilename) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries
    .filter((entry) => entry.isFile() && localImportSourceFilenamePattern.test(entry.name))
    .map(async (entry) => ({ name: entry.name, mtimeMs: (await fs.stat(path.join(directory, entry.name))).mtimeMs })));
  sources.sort((left, right) => {
    if (left.name === keepFilename) return -1;
    if (right.name === keepFilename) return 1;
    return right.mtimeMs - left.mtimeMs;
  });
  await Promise.all(sources.slice(LOCAL_IMPORT_MAX_FILES).map((entry) => fs.rm(path.join(directory, entry.name), { force: true })));
}

async function pruneBrowserCaptureSourceFiles(directory, keepFilename) {
  const sources = await browserCaptureSourceFiles(directory);
  sources.sort((left, right) => {
    if (left.name === keepFilename) return -1;
    if (right.name === keepFilename) return 1;
    return right.mtimeMs - left.mtimeMs;
  });
  await Promise.all(sources.slice(CAPTURE_EVIDENCE_MAX_FILES).map((entry) => removeBrowserCaptureArtifacts(directory, entry.captureId)));
}

async function atomicSaveText(destination, content) {
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function saveBrowserCaptureSource(capture, { identityHints = [] } = {}) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    throw fail("INVALID_BROWSER_CAPTURE", "浏览器采集数据无效，未写入本地文件。");
  }
  const captureId = `capture_${crypto.randomUUID().replaceAll("-", "")}`;
  const sanitizedCapture = sanitizeBrowserCaptureShape(capture);
  const hasSkuSnapshots = Array.isArray(capture?.page?.skuSnapshots);
  const skuSnapshots = hasSkuSnapshots && Array.isArray(sanitizedCapture.page?.skuSnapshots)
    ? sanitizedCapture.page.skuSnapshots
    : [];
  if (skuSnapshots.length > BROWSER_CAPTURE_MAX_SKU_SNAPSHOTS) {
    throw fail("INVALID_BROWSER_CAPTURE", "浏览器 SKU 快照数量异常，未写入本地证据。");
  }
  const directory = await configuredLocalEvidenceDirectory();
  const filename = `${captureId}.source.txt`;
  const itemId = String(sanitizedCapture.itemId || "").trim();
  const snapshotFiles = [];
  const snapshotWrites = [];
  let snapshotTotalBytes = 0;
  if (hasSkuSnapshots) {
    if (!itemIdPattern.test(itemId)) throw fail("INVALID_CAPTURE_ITEM_ID", "浏览器 SKU 快照缺少可靠商品 ID，未写入本地证据。");
    for (let index = 0; index < skuSnapshots.length; index += 1) {
      const ordinal = index + 1;
      const snapshot = skuSnapshots[index];
      const skuId = String(snapshot?.skuId || "").trim();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !skuIdPattern.test(skuId)) {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 快照身份无效，未写入本地证据。`);
      }
      const skuFilename = browserCaptureSkuSourceFilename(captureId, ordinal);
      const envelope = {
        schemaVersion: 2,
        captureType: "account-browser-local-sku-source",
        captureId,
        itemId,
        ordinal,
        skuId,
        snapshot: {
          ...snapshot,
          skuId,
          finalUrl: safeProductEvidenceUrl(snapshot.finalUrl, itemId),
        },
      };
      const content = sanitizeLocalImportSource(JSON.stringify(envelope), identityHints);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > BROWSER_CAPTURE_MAX_BYTES) {
        throw fail("IMPORT_TOO_LARGE", `第 ${ordinal} 个 SKU 本地证据超过 32MB，未写入不完整文件。`);
      }
      snapshotTotalBytes += bytes;
      if (snapshotTotalBytes > BROWSER_CAPTURE_MAX_TOTAL_BYTES) {
        throw fail("IMPORT_TOO_LARGE", "本轮 SKU 本地证据合计超过 256MB，已停止写入不完整证据。");
      }
      snapshotFiles.push({
        ordinal,
        skuId,
        filename: skuFilename,
        bytes,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      });
      snapshotWrites.push({ destination: path.join(directory, skuFilename), content });
    }
  }
  const page = { ...(sanitizedCapture.page || {}) };
  delete page.skuSnapshots;
  const record = {
    ...sanitizedCapture,
    schemaVersion: hasSkuSnapshots ? 2 : 1,
    captureType: "account-browser-local-source",
    captureId,
    itemId,
    page: hasSkuSnapshots ? { ...page, skuSnapshotFiles: snapshotFiles } : page,
    localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: false, networkAccessedAfterCapture: false },
  };
  const manifest = sanitizeLocalImportSource(JSON.stringify(record), identityHints);
  if (Buffer.byteLength(manifest, "utf8") > BROWSER_CAPTURE_MAX_BYTES) {
    throw fail("IMPORT_TOO_LARGE", "浏览器已加载的数据超过 32MB，未写入不完整的本地证据。");
  }
  const writtenFiles = [];
  try {
    for (const write of snapshotWrites) {
      await atomicSaveText(write.destination, write.content);
      writtenFiles.push(write.destination);
    }
    // The manifest is the commit marker. Readers cannot observe a complete
    // schema-v2 capture until every independently atomic SKU file exists.
    await atomicSaveText(path.join(directory, filename), manifest);
  } catch (error) {
    await Promise.all(writtenFiles.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
    throw error;
  }
  await pruneBrowserCaptureSourceFiles(directory, filename).catch(() => undefined);
  return {
    captureId,
    sourceFile: samePath(directory, defaultLocalEvidenceDirectory()) ? `capture-evidence/${filename}` : path.join(directory, filename),
  };
}

export async function readBrowserCaptureSource(captureId) {
  if (!browserCaptureIdPattern.test(String(captureId || ""))) {
    throw fail("INVALID_BROWSER_CAPTURE_ID", "浏览器采集记录 ID 无效。");
  }
  const configuredDirectory = await configuredLocalEvidenceDirectory();
  const directories = [configuredDirectory, defaultLocalEvidenceDirectory()]
    .filter((directory, index, values) => values.findIndex((candidate) => samePath(candidate, directory)) === index);
  const filename = `${captureId}.source.txt`;
  let file = "";
  let stat;
  for (const directory of directories) {
    const candidate = path.join(directory, filename);
    try {
      stat = await fs.lstat(candidate);
      file = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!file) throw fail("IMPORT_SOURCE_NOT_FOUND", "浏览器本地采集文件不存在，无法解析。");
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail("INVALID_IMPORT_SOURCE", "浏览器本地采集文件无效。");
  if (stat.size > BROWSER_CAPTURE_MAX_BYTES) throw fail("IMPORT_TOO_LARGE", "浏览器本地采集文件超过 32MB，已停止解析。");
  const content = await fs.readFile(file, "utf8");
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    throw fail("INVALID_BROWSER_CAPTURE", "浏览器本地采集文件不是有效 JSON，已停止解析。");
  }
  if (record?.captureId !== captureId
    || record?.captureType !== "account-browser-local-source"
    || ![1, 2].includes(record?.schemaVersion)) {
    throw fail("INVALID_BROWSER_CAPTURE", "浏览器本地采集文件身份校验失败。");
  }
  let skuSnapshots = null;
  if (record.schemaVersion === 2) {
    const references = record.page?.skuSnapshotFiles;
    if (!Array.isArray(references) || references.length > BROWSER_CAPTURE_MAX_SKU_SNAPSHOTS) {
      throw fail("INVALID_BROWSER_CAPTURE", "浏览器 SKU 快照清单无效。");
    }
    skuSnapshots = [];
    const seenSkuFiles = new Set();
    let skuSnapshotTotalBytes = 0;
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      const ordinal = index + 1;
      const skuId = String(reference?.skuId || "").trim();
      const expectedFilename = browserCaptureSkuSourceFilename(captureId, ordinal);
      if (reference?.ordinal !== ordinal
        || reference?.filename !== expectedFilename
        || !skuIdPattern.test(skuId)
        || seenSkuFiles.has(expectedFilename)) {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 快照清单身份校验失败。`);
      }
      seenSkuFiles.add(expectedFilename);
      const skuFile = path.join(path.dirname(file), expectedFilename);
      let skuStat;
      try {
        skuStat = await fs.lstat(skuFile);
      } catch (error) {
        if (error?.code === "ENOENT") throw fail("IMPORT_SOURCE_NOT_FOUND", `第 ${ordinal} 个 SKU 本地采集文件不存在。`);
        throw error;
      }
      if (!skuStat.isFile() || skuStat.isSymbolicLink()) throw fail("INVALID_IMPORT_SOURCE", `第 ${ordinal} 个 SKU 本地采集文件无效。`);
      if (skuStat.size > BROWSER_CAPTURE_MAX_BYTES) throw fail("IMPORT_TOO_LARGE", `第 ${ordinal} 个 SKU 本地采集文件超过 32MB。`);
      if (!Number.isSafeInteger(reference.bytes) || reference.bytes !== skuStat.size || !/^[a-f0-9]{64}$/.test(String(reference.sha256 || ""))) {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 本地采集文件大小或摘要无效。`);
      }
      skuSnapshotTotalBytes += reference.bytes;
      if (skuSnapshotTotalBytes > BROWSER_CAPTURE_MAX_TOTAL_BYTES) {
        throw fail("IMPORT_TOO_LARGE", "SKU 本地采集文件合计超过 256MB，已停止解析。");
      }
      const skuContent = await fs.readFile(skuFile, "utf8");
      if (Buffer.byteLength(skuContent, "utf8") !== reference.bytes
        || crypto.createHash("sha256").update(skuContent).digest("hex") !== reference.sha256) {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 本地采集文件完整性校验失败。`);
      }
      let envelope;
      try {
        envelope = JSON.parse(skuContent);
      } catch {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 本地采集文件不是有效 JSON。`);
      }
      if (envelope?.schemaVersion !== 2
        || envelope?.captureType !== "account-browser-local-sku-source"
        || envelope?.captureId !== captureId
        || envelope?.itemId !== record.itemId
        || envelope?.ordinal !== ordinal
        || envelope?.skuId !== skuId
        || !envelope.snapshot
        || typeof envelope.snapshot !== "object"
        || Array.isArray(envelope.snapshot)
        || String(envelope.snapshot.skuId || "") !== skuId) {
        throw fail("INVALID_BROWSER_CAPTURE", `第 ${ordinal} 个 SKU 本地采集文件身份校验失败。`);
      }
      skuSnapshots.push(envelope.snapshot);
    }
  }
  return {
    ...record,
    page: skuSnapshots ? { ...(record.page || {}), skuSnapshots } : record.page,
    sourceFile: samePath(path.dirname(file), defaultLocalEvidenceDirectory()) ? `capture-evidence/${filename}` : file,
    localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessedAfterCapture: false },
  };
}

function reparseBrowserCaptureRecord(capture, { accountType, itemIdHint, sourceFile = "" }) {
  const itemId = String(capture?.itemId || "").trim();
  if (!itemIdPattern.test(itemId)) {
    throw fail("INVALID_CAPTURE_ITEM_ID", "浏览器证据缺少已核验的商品 ID，无法重新解析。");
  }
  if (itemIdHint && String(itemIdHint) !== itemId) {
    throw fail("CAPTURE_ITEM_MISMATCH", "浏览器证据与目标商品 ID 不一致，已停止解析。");
  }

  const capturedAt = safeText(capture.capturedAt, 40) || new Date().toISOString();
  const content = JSON.stringify(capture);
  const snapshot = {
    ...buildSnapshot({ content, parsed: capture, itemId, accountType, capturedAt }),
    source: "browser",
    browserEvidenceId: capture.captureId,
    browserEvidenceFile: sourceFile || capture.sourceFile || "",
    localFirst: { ...capture.localFirst },
  };
  return {
    snapshot,
    sourceFile: sourceFile || capture.sourceFile || "",
    localFirst: { ...capture.localFirst },
  };
}

export async function reparseBrowserCaptureSource(captureId, options = {}) {
  const { accountType, itemIdHint } = validateLocalImportOptions(options);
  const capture = await readBrowserCaptureSource(captureId);
  return reparseBrowserCaptureRecord(capture, { accountType, itemIdHint, sourceFile: capture.sourceFile || "" });
}

async function atomicSave(record, directoryName = "local-imports", maxFiles = LOCAL_IMPORT_MAX_FILES, requiredOrigin = "") {
  const directory = path.isAbsolute(directoryName) ? directoryName : path.join(dbRuntimeInfo().dataDir, directoryName);
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${record.importId}.json`);
  const temporary = path.join(directory, `.${record.importId}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(redactDeep(record), null, 2), "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await pruneLocalImportFiles(directory, `${record.importId}.json`, maxFiles, requiredOrigin).catch(() => undefined);
}

export async function saveCapturedSnapshotLocalEvidence(snapshot) {
  const record = capturedSnapshotRecord(snapshot);
  const directory = await configuredLocalEvidenceDirectory();
  record.savedFile = samePath(directory, defaultLocalEvidenceDirectory())
    ? `capture-evidence/${record.importId}.json`
    : path.join(directory, `${record.importId}.json`);
  record.localFirst = { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessed: false };
  await atomicSave(record, directory, CAPTURE_EVIDENCE_MAX_FILES, "automatic-capture");
  return localImportPublicPreview(await loadLocalImportRecord(record.importId));
}

export async function getLocalEvidenceStorageOverview(configuredDirectory) {
  const directory = configuredDirectory === undefined
    ? await configuredLocalEvidenceDirectory()
    : resolveLocalEvidenceDirectory(configuredDirectory);
  const files = await automaticEvidenceFiles(directory);
  const sourceFiles = await browserCaptureSourceFiles(directory);
  return {
    directory,
    defaultDirectory: defaultLocalEvidenceDirectory(),
    fileCount: files.length,
    sourceFileCount: sourceFiles.length,
    totalBytes: [...files, ...sourceFiles].reduce((total, file) => total + file.size, 0),
    directoryPickerAvailable: Boolean(process.versions.electron),
  };
}

export async function clearLocalEvidenceFiles(configuredDirectory) {
  const directory = configuredDirectory === undefined
    ? await configuredLocalEvidenceDirectory()
    : resolveLocalEvidenceDirectory(configuredDirectory);
  const files = await automaticEvidenceFiles(directory);
  const sourceFiles = await browserCaptureSourceFiles(directory);
  const deletedImportIds = [];
  const deletedCaptureIds = [];
  for (const file of files) {
    try {
      const record = JSON.parse(await fs.readFile(file.file, "utf8"));
      if (record?.origin !== "automatic-capture" || record.importId !== file.importId) continue;
      await fs.rm(file.file, { force: true });
      deletedImportIds.push(file.importId);
    } catch {
      // A file changed after scanning; leave it untouched instead of guessing ownership.
    }
  }
  for (const file of sourceFiles) {
    try {
      const record = JSON.parse(await fs.readFile(file.file, "utf8"));
      if (record?.captureType !== "account-browser-local-source" || record.captureId !== file.captureId) continue;
      await removeBrowserCaptureArtifacts(directory, file.captureId);
      deletedCaptureIds.push(file.captureId);
    } catch {
      // A file changed after scanning; leave it untouched instead of guessing ownership.
    }
  }
  return {
    ...(await getLocalEvidenceStorageOverview(configuredDirectory)),
    deletedCount: deletedImportIds.length + deletedCaptureIds.length,
    deletedImportIds,
    deletedCaptureIds,
  };
}

export function mergeLocalImportSnapshot(product, localSnapshot) {
  const previous = product.lastSnapshot || {};
  const previousSkuImages = new Map((previous.skuPrices || []).map((sku) => [String(sku.skuId), sku.image || ""]));
  const skuPrices = localSnapshot.skuPrices.map((sku) => ({
    ...structuredClone(sku),
    image: previousSkuImages.get(String(sku.skuId)) || "",
  }));
  const skuImages = [...new Set(skuPrices.map((sku) => sku.image).filter(Boolean))];
  const mainImage = previous.mainImage || previous.mainImage800 || product.mainImage || "";
  const mainImages = structuredClone(previous.mainImages || (mainImage ? [mainImage] : []));
  const detailImages = structuredClone(previous.detailImages || []);
  const videoUrls = structuredClone(previous.videoUrls || []);
  const buyerShows = structuredClone(previous.buyerShows?.length ? previous.buyerShows : previous.buyerShowCachedItems || []);
  const hasExistingTitle = product.name && !/^(?:待识别商品|批量商品|本地导入商品)(?:\s|$)/.test(product.name);
  return {
    ...structuredClone(localSnapshot),
    title: hasExistingTitle ? product.name : localSnapshot.title,
    shopName: product.shopName || localSnapshot.shopName,
    model: product.model || localSnapshot.model,
    mainImage,
    mainImage800: previous.mainImage800 || mainImage,
    gallery750Images: structuredClone(previous.gallery750Images || []),
    mainImages,
    detailImages,
    videoUrls,
    buyerShows,
    skuImages,
    skuPrices,
    rawSignals: {
      ...structuredClone(localSnapshot.rawSignals),
      imageCount: mainImages.length,
      skuImageCount: skuImages.length,
      highResImageCount: mainImage ? 1 : 0,
      videoCount: videoUrls.length,
      buyerShowCount: buyerShows.length,
      detailImageCount: detailImages.length,
    },
  };
}

export function localImportPublicPreview(record) {
  if (!record || typeof record !== "object") throw fail("INVALID_IMPORT_RECORD", "本地导入记录无效。");
  const snapshot = record.snapshot || {};
  const unverifiedCount = Number(snapshot.rawSignals?.unverifiedPriceSkuCount || 0);
  const preview = {
    importId: record.importId,
    savedFile: record.savedFile,
    sourceFile: record.sourceFile || "",
    localFirst: {
      sourceSaved: record.localFirst?.sourceSaved === true,
      sourceSanitized: record.localFirst?.sourceSanitized === true,
      parsedFromDisk: record.localFirst?.parsedFromDisk === true,
      networkAccessed: false,
    },
    inputType: record.inputType,
    accountType: record.accountType,
    itemId: record.itemId,
    title: snapshot.title || "",
    shopName: snapshot.shopName || "",
    canCommit: record.canCommit === true,
    resolutionStatus: snapshot.resolutionStatus || "unavailable",
    skuCount: Number(snapshot.rawSignals?.skuCount || 0),
    verifiedSkuCount: Number(snapshot.rawSignals?.verifiedPriceSkuCount || 0),
    price: Number.isFinite(snapshot.price) ? snapshot.price : null,
    priceRange: Array.isArray(snapshot.priceRange) ? snapshot.priceRange : null,
    warnings: [
      ...(Array.isArray(record.blockingReasons) ? record.blockingReasons : []),
      ...(unverifiedCount ? [`${unverifiedCount} 个 SKU 未通过价格证据核验，价格已保留为空；其他已核验 SKU 不受影响`] : []),
    ],
    skuPrices: Array.isArray(snapshot.skuPrices) ? snapshot.skuPrices : [],
  };
  return redactDeep(preview);
}

function validateLocalImportContent(content) {
  if (typeof content !== "string") throw fail("INVALID_CONTENT", "请粘贴 JSON、JSONP 或 HTML 文本。");
  const inputBytes = Buffer.byteLength(content, "utf8");
  if (inputBytes > LOCAL_IMPORT_MAX_BYTES) throw fail("IMPORT_TOO_LARGE", "导入内容不能超过 8MB。");
  if (!content.trim()) throw fail("EMPTY_IMPORT", "导入内容不能为空。");
}

function validateLocalImportOptions(options) {
  const accountType = options.accountType || "normal";
  if (!accountTypes.has(accountType)) throw fail("INVALID_ACCOUNT_TYPE", "账号类型仅支持 normal、gift 或 vip88。");
  if (options.itemIdHint != null && options.itemIdHint !== "" && !itemIdPattern.test(String(options.itemIdHint))) {
    throw fail("INVALID_ITEM_ID", "商品 ID 必须是 6 到 20 位数字。");
  }
  return { accountType, itemIdHint: options.itemIdHint };
}

export async function saveLocalImportSource(content) {
  validateLocalImportContent(content);
  const importId = `local_${crypto.randomUUID().replaceAll("-", "")}`;
  const sourceFile = `local-imports/${importId}.source.txt`;
  const destination = localImportSourceFile(importId);
  await atomicSaveText(destination, sanitizeLocalImportSource(content));
  await pruneLocalImportSourceFiles(path.dirname(destination), path.basename(destination)).catch(() => undefined);
  return { importId, sourceFile };
}

async function readLocalImportSource(importId) {
  if (!importIdPattern.test(String(importId || ""))) throw fail("INVALID_IMPORT_ID", "本地导入记录 ID 无效。");
  const file = localImportSourceFile(importId);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") throw fail("IMPORT_SOURCE_NOT_FOUND", "本地原始数据文件不存在，无法解析。");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail("INVALID_IMPORT_SOURCE", "本地原始数据文件无效。");
  if (stat.size > LOCAL_IMPORT_MAX_BYTES) throw fail("IMPORT_TOO_LARGE", "导入内容不能超过 8MB。");
  const content = await fs.readFile(file, "utf8");
  validateLocalImportContent(content);
  return content;
}

export async function createLocalImportFromSavedSource(importId, options = {}) {
  const { accountType, itemIdHint } = validateLocalImportOptions(options);
  const content = await readLocalImportSource(importId);

  const parsed = parseJsonLike(content);
  const itemId = selectItemId(collectItemIdCandidates(parsed, content), itemIdHint);
  const createdAt = new Date().toISOString();
  const snapshot = buildSnapshot({ content, parsed, itemId, accountType, capturedAt: createdAt });
  const verifiedPriceSkuCount = snapshot.rawSignals.verifiedPriceSkuCount;
  const blockingReasons = [];
  if (!itemId) blockingReasons.push("未可靠识别商品 ID");
  if (!verifiedPriceSkuCount) blockingReasons.push("没有 SKU 通过价格证据核验");
  const record = {
    schemaVersion: 1,
    importId,
    savedFile: "",
    sourceFile: `local-imports/${importId}.source.txt`,
    inputType: inputTypeOf(content),
    createdAt,
    accountType,
    itemId,
    canCommit: blockingReasons.length === 0,
    blockingReasons,
    snapshot,
    localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessed: false },
    sanitization: { originalContentStored: false, sourceContentStored: true, sourceSensitiveFieldsRedacted: true, parsedRecordSensitiveFieldsRedacted: true },
  };
  record.savedFile = `local-imports/${record.importId}.json`;
  await atomicSave(record);
  return localImportPublicPreview(record);
}

export async function createLocalImport(content, options = {}) {
  validateLocalImportOptions(options);
  const source = await saveLocalImportSource(content);
  return createLocalImportFromSavedSource(source.importId, options);
}

export async function loadLocalImportRecord(importId) {
  if (!importIdPattern.test(String(importId || ""))) throw fail("INVALID_IMPORT_ID", "本地导入记录 ID 无效。");
  let record;
  const evidenceDirectory = await configuredLocalEvidenceDirectory();
  const directories = [
    localImportDirectory(),
    evidenceDirectory,
    defaultLocalEvidenceDirectory(),
  ].filter((directory, index, values) => values.findIndex((candidate) => samePath(candidate, directory)) === index);
  for (const directory of directories) {
    const file = path.join(directory, `${importId}.json`);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail("INVALID_IMPORT_RECORD", "本地导入记录文件无效。");
      if (stat.size > LOCAL_IMPORT_MAX_BYTES) throw fail("IMPORT_TOO_LARGE", "本地导入记录超过 8MB，已停止读取。");
      record = JSON.parse(await fs.readFile(file, "utf8"));
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!record) throw fail("IMPORT_NOT_FOUND", "本地导入记录不存在。");
  if (record.importId !== importId) throw fail("INVALID_IMPORT_RECORD", "本地导入记录内容无效。");
  return redactDeep(record);
}

export async function loadLocalImport(importId) {
  return localImportPublicPreview(await loadLocalImportRecord(importId));
}
