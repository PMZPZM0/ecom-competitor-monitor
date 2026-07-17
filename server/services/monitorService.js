import { newId, readDb, updateDb } from "../storage/db.js";
import { itemIdFromProductUrl } from "../utils/productUrl.js";
import { scrapeTmallProduct } from "./tmallScraper.js";
import { createNotificationLog, effectivePriceForSku, sendFeishuNotification } from "./feishuService.js";
import { appendPriceDocument } from "./larkCliService.js";
import { saveCapturedSnapshotLocalEvidence } from "./localImportService.js";

let timer = null;
let captureQueueTail = Promise.resolve();
const captureJobs = [];
const accountCaptureTails = new Map();

const MIN_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MIN_DELAY_MS || 5000);
const MAX_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MAX_DELAY_MS || 12000);
const MAX_CAPTURE_CONCURRENCY = 5;
const CAPTURE_JOB_RETENTION_MS = 5_000;
const MIN_PRODUCT_INTERVAL_MINUTES = 30;
const MAX_PRODUCT_INTERVAL_MINUTES = 1440;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomProductDelay() {
  const min = Math.max(0, MIN_PRODUCT_DELAY_MS);
  const max = Math.max(min, MAX_PRODUCT_DELAY_MS);
  return Math.round(min + Math.random() * (max - min));
}

export function resolveProductIntervalMinutes(product, fallbackMinutes = 60) {
  const requested = Number(product?.monitorIntervalMinutes);
  const fallback = Number(fallbackMinutes);
  const value = Number.isFinite(requested) && requested > 0
    ? requested
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : 60;
  return Math.min(MAX_PRODUCT_INTERVAL_MINUTES, Math.max(MIN_PRODUCT_INTERVAL_MINUTES, Math.round(value)));
}

export function isExplicitLoginExpiryError(message = "") {
  return /账号登录已明确失效/.test(String(message));
}

export function resolveProductScheduleMode(product) {
  return product?.monitorScheduleMode === "once" ? "once" : "interval";
}

export function nextProductScheduleAt(product, fallbackMinutes = 60, now = Date.now()) {
  if (resolveProductScheduleMode(product) === "once") {
    const scheduledAt = Date.parse(product?.monitorStartAt || "");
    return Number.isFinite(scheduledAt) ? new Date(scheduledAt).toISOString() : null;
  }
  const intervalMs = resolveProductIntervalMinutes(product, fallbackMinutes) * 60_000;
  return new Date(now + intervalMs).toISOString();
}

export function scheduleProduct(product, monitor, { reset = false, now = Date.now() } = {}) {
  if (product?.captureMode === "local-only") return { ...product, enabled: false, nextMonitorAt: null };
  if (!monitor?.running || !product?.enabled) return { ...product, nextMonitorAt: null };
  const existing = Date.parse(product.nextMonitorAt || "");
  if (!reset && Number.isFinite(existing)) return product;
  return {
    ...product,
    nextMonitorAt: nextProductScheduleAt(product, monitor.intervalMinutes, now),
  };
}

export function scheduleProducts(products, monitor, options = {}) {
  return products.map((product) => scheduleProduct(product, monitor, options));
}

export function mergeCapturedProduct(current, captured) {
  return {
    ...current,
    name: captured.name,
    shopName: captured.shopName,
    shopLogo: captured.shopLogo,
    model: captured.model,
    itemId: captured.itemId,
    autoGroup: captured.autoGroup,
    mainImage: captured.mainImage,
    lastStatus: captured.lastStatus,
    lastError: captured.lastError,
    lastSnapshot: captured.lastSnapshot,
    updatedAt: captured.updatedAt,
  };
}

export function setSkuMonitorPrice(product, skuId, value) {
  const skuMonitorPrices = { ...(product.skuMonitorPrices || {}) };
  if (value === null) delete skuMonitorPrices[skuId];
  else skuMonitorPrices[skuId] = value;
  return { ...product, skuMonitorPrices, monitorPrice: null };
}

export function dueProductIds(products, now = Date.now()) {
  return products
    .filter((product) => product.enabled && Number.isFinite(Date.parse(product.nextMonitorAt || "")) && Date.parse(product.nextMonitorAt) <= now)
    .sort((left, right) => Date.parse(left.nextMonitorAt) - Date.parse(right.nextMonitorAt))
    .map((product) => product.id);
}

export function earliestProductSchedule(products, monitor, now = Date.now()) {
  const scheduled = scheduleProducts(products, monitor, { now });
  const times = scheduled
    .filter((product) => product.enabled && product.nextMonitorAt)
    .map((product) => Date.parse(product.nextMonitorAt))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export async function runInCaptureGroups(items, worker, { concurrency = MAX_CAPTURE_CONCURRENCY, delayBetweenGroups = null } = {}) {
  const size = Math.min(MAX_CAPTURE_CONCURRENCY, Math.max(1, Number(concurrency) || MAX_CAPTURE_CONCURRENCY));
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    const group = items.slice(index, index + size);
    results.push(...await Promise.all(group.map((item, groupIndex) => worker(item, index + groupIndex))));
    if (index + size < items.length && delayBetweenGroups) await delay(delayBetweenGroups());
  }
  return results;
}

function accountCaptureKey(session) {
  if (!session) return "";
  if (session.browserProfileKey) return `browser:${session.browserProfileKey}:${session.browserPort || ""}`;
  return `session:${session.id}`;
}

export async function withAccountCaptureLock(session, operation) {
  const key = accountCaptureKey(session);
  if (!key) return operation();
  const previous = accountCaptureTails.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  accountCaptureTails.set(key, current);
  try {
    return await current;
  } finally {
    if (accountCaptureTails.get(key) === current) accountCaptureTails.delete(key);
  }
}

function persistSessionHealth(current, sessions) {
  const healthById = new Map(sessions.map((session) => [session.id, session]));
  current.authSessions = current.authSessions.map((session) => {
    const health = healthById.get(session.id);
    if (!health) return session;
    return {
      ...session,
      lastUsedAt: health.lastUsedAt || null,
      lastSuccessAt: health.lastSuccessAt || null,
      lastFailureAt: health.lastFailureAt || null,
      consecutiveFailures: health.consecutiveFailures || 0,
      healthStatus: health.healthStatus || "healthy",
      loginStatus: health.loginStatus || session.loginStatus,
    };
  });
}

function publicCaptureJob(job) {
  return {
    id: job.id,
    source: job.source,
    scope: job.scope,
    status: job.status,
    outcome: job.outcome,
    productIds: job.productIds,
    products: job.products,
    activeProductIds: job.activeProductIds,
    total: job.total,
    completed: job.completed,
    message: job.message,
    error: job.error,
    results: job.results,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function getCaptureQueueStatus(now = Date.now()) {
  const cutoff = now - CAPTURE_JOB_RETENTION_MS;
  for (let index = captureJobs.length - 1; index >= 0; index -= 1) {
    const job = captureJobs[index];
    if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) captureJobs.splice(index, 1);
  }
  return {
    running: captureJobs.some((job) => job.status === "running"),
    pendingCount: captureJobs.filter((job) => job.status === "queued").length,
    completedCount: captureJobs.filter((job) => job.status === "completed" || job.status === "failed").length,
    retentionSeconds: CAPTURE_JOB_RETENTION_MS / 1000,
    jobs: captureJobs.map(publicCaptureJob),
  };
}

export function clearFinishedCaptureJobs() {
  let removed = 0;
  for (let index = captureJobs.length - 1; index >= 0; index -= 1) {
    if (captureJobs[index].status === "completed" || captureJobs[index].status === "failed") {
      captureJobs.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

export function enqueueCaptureOperation(meta, operation) {
  const job = {
    id: newId("capture"),
    source: meta.source || "manual",
    scope: meta.scope || "selected-products",
    status: "queued",
    outcome: null,
    productIds: [...(meta.productIds || [])],
    products: [],
    activeProductIds: [],
    total: meta.productIds?.length || 0,
    completed: 0,
    message: "等待前面的抓取任务完成。",
    error: "",
    results: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  captureJobs.unshift(job);

  const execute = async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.message = "抓取任务正在运行。";
    try {
      const result = await operation(job);
      job.results = result?.run?.items || [];
      job.outcome = result?.run?.status || "success";
      job.status = job.outcome === "failed" ? "failed" : "completed";
      job.message = result?.run?.message || "抓取任务已完成。";
      return result;
    } catch (error) {
      job.status = "failed";
      job.outcome = "failed";
      job.error = error.message || String(error);
      job.message = job.error;
      throw error;
    } finally {
      job.activeProductIds = [];
      job.finishedAt = new Date().toISOString();
    }
  };
  const promise = captureQueueTail.then(execute, execute);
  captureQueueTail = promise.catch(() => undefined);
  return promise;
}

function summarizeResults(results) {
  const success = results.filter((result) => result.snapshot).length;
  const failed = results.length - success;
  return { total: results.length, success, failed };
}

function safeItemIdFromUrl(url) {
  try {
    return itemIdFromProductUrl(url);
  } catch {
    return "";
  }
}

export function captureResultItem(result) {
  const product = result?.product || {};
  const snapshot = result?.snapshot || null;
  const buyerShowFailed = snapshot?.buyerShowCapture?.status === "failed";
  const status = snapshot ? (buyerShowFailed ? "partial" : "success") : "failed";
  return {
    productId: product.id || "",
    requestedItemId: safeItemIdFromUrl(product.url),
    itemId: snapshot?.itemId || product.itemId || "",
    name: product.name || product.itemId || product.id || "未知商品",
    accountType: product.accountType || "normal",
    status,
    message: (status === "failed"
      ? product.lastError || "抓取失败，未返回可保存结果。"
      : buyerShowFailed
        ? `价格与素材已更新，买家秀失败：${snapshot.buyerShowCapture.failureCode || "未知原因"}`
        : "价格、SKU 与素材抓取成功。")
      + (snapshot?.browserEvidenceFile
        ? " 浏览器数据已先保存本地并重新读盘解析。"
        : snapshot?.localImportFile ? " 本地价格证据已自动保存。" : snapshot?.localImportError ? ` 本地价格证据保存失败：${snapshot.localImportError}` : ""),
    capturedAt: snapshot?.capturedAt || product.updatedAt || new Date().toISOString(),
  };
}

export function orderedCaptureCandidates(products, productIds, includeDisabled = false) {
  const allowed = (product) => includeDisabled || product.enabled;
  if (!productIds) return products.filter(allowed);
  const byId = new Map(products.map((product) => [product.id, product]));
  return productIds.map((id) => byId.get(id)).filter((product) => product && allowed(product));
}

export function historicalPrimaryImages(snapshots, productId) {
  return snapshots
    .filter((snapshot) => snapshot.productId === productId)
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime())
    .flatMap((snapshot) => [snapshot.mainImage800, snapshot.mainImage, ...(snapshot.mainImages || [])])
    .filter((image, index, images) => /item_pic\./i.test(image || "") && images.indexOf(image) === index);
}

export function historicalProductMedia(snapshots, productId) {
  const productSnapshots = snapshots
    .filter((snapshot) => snapshot.productId === productId)
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime());
  const unique = (items) => Array.from(new Set(items.filter(Boolean)));
  return {
    galleryImages: unique(productSnapshots.flatMap((snapshot) => snapshot.gallery750Images || [])).slice(0, 10),
    videoUrls: unique(productSnapshots.flatMap((snapshot) => snapshot.videoUrls || [])).slice(0, 10),
  };
}

export function historicalAccountPriceSnapshot(snapshots, productId, accountType = "normal") {
  const kind = accountType === "normal" ? "normal" : accountType;
  return snapshots
    .filter((snapshot) => snapshot.productId === productId && (snapshot.skuPrices || []).some((sku) => verifiedChannel(sku, kind)))
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime())[0] || null;
}

export function preserveVerifiedAccountPrices(snapshot) {
  return snapshot;
}

export function buildRunRecord({ source, scope, startedAt, results, message }) {
  const summary = summarizeResults(results);
  const buyerShowFailures = results.filter((result) => result.snapshot?.buyerShowCapture?.status === "failed").length;
  const browserEvidenceSaved = results.filter((result) => result.snapshot?.browserEvidenceFile).length;
  const localEvidenceSaved = results.filter((result) => !result.snapshot?.browserEvidenceFile && result.snapshot?.localImportFile).length;
  const localEvidenceFailed = results.filter((result) => result.snapshot?.localImportError).length;
  return {
    id: newId("run"),
    source,
    scope,
    status: summary.failed > 0 ? (summary.success > 0 ? "partial" : "failed") : buyerShowFailures > 0 ? "partial" : "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    ...summary,
    items: results.map(captureResultItem),
    message:
      message ||
      `抓取 ${summary.total} 个商品，成功 ${summary.success} 个，失败 ${summary.failed} 个。${buyerShowFailures ? ` 其中 ${buyerShowFailures} 个商品的买家秀本次未获取，价格与素材已正常更新。` : ""}${browserEvidenceSaved ? ` ${browserEvidenceSaved} 份浏览器数据已保存本地并重新读盘解析。` : ""}${localEvidenceSaved ? ` 本地价格证据已自动保存 ${localEvidenceSaved} 份。` : ""}${localEvidenceFailed ? ` ${localEvidenceFailed} 份本地证据保存失败，抓价结果仍已保留。` : ""}`,
  };
}

async function attachLocalPriceEvidence(result, source) {
  if (!result?.snapshot || source === "local-import" || result.snapshot.source === "local-import") return result;
  try {
    const preview = await saveCapturedSnapshotLocalEvidence(result.snapshot);
    const metadata = { localImportId: preview.importId, localImportFile: preview.savedFile };
    Object.assign(result.snapshot, metadata);
    if (result.product?.lastSnapshot) Object.assign(result.product.lastSnapshot, metadata);
  } catch (error) {
    const localImportError = String(error?.message || "本地证据写入失败").slice(0, 300);
    result.snapshot.localImportError = localImportError;
    if (result.product?.lastSnapshot) result.product.lastSnapshot.localImportError = localImportError;
    console.warn("[capture-evidence]", localImportError);
  }
  return result;
}

function verifiedChannel(sku, kind) {
  return sku?.resolutionStatus === "verified" && sku?.priceResolution?.channels?.[kind]?.status === "verified";
}

function accountPriceView(entry, sku) {
  return {
    sessionId: entry.session.id,
    accountName: entry.session.name || "已授权账号",
    accountType: entry.session.accountType || "normal",
    capturedAt: entry.snapshot.capturedAt,
    price: sku.price,
    normalPrice: sku.normalPrice,
    governmentPrice: sku.governmentPrice ?? null,
    governmentStatus: sku.governmentStatus || "none",
    governmentDiscountAmount: sku.governmentDiscountAmount ?? null,
    surprisePrice: sku.surprisePrice ?? null,
    surpriseStatus: sku.surpriseStatus || "none",
    surpriseDiscountAmount: sku.surpriseDiscountAmount ?? null,
    giftPrice: sku.giftPrice ?? null,
    giftStatus: sku.giftStatus || "none",
    giftDiscountAmount: sku.giftDiscountAmount ?? null,
    vipPrice: sku.vipPrice ?? null,
    vipStatus: sku.vipStatus || "none",
    vipDiscountAmount: sku.vipDiscountAmount ?? null,
    coinPrice: sku.coinPrice ?? null,
    coinStatus: sku.coinStatus || "none",
    coinDiscountAmount: sku.coinDiscountAmount ?? null,
    originalPrice: sku.originalPrice,
    priceTitle: sku.priceTitle,
    resolutionStatus: sku.resolutionStatus,
    priceResolution: structuredClone(sku.priceResolution),
    priceCalculation: structuredClone(sku.priceCalculation || {}),
    priceLayers: structuredClone(sku.priceLayers || []),
    discountItems: structuredClone(sku.discountItems || []),
  };
}

export function mergeAccountSnapshots(snapshots, { primarySessionId = "", primaryAccountType = "" } = {}) {
  const primary = snapshots.find((entry) => entry.session?.id === primarySessionId)
    || snapshots.find((entry) => (entry.session?.accountType || "normal") === primaryAccountType)
    || snapshots[0];
  if (!primary) throw new Error("没有可合并的账号价格快照。");
  const merged = structuredClone(primary.snapshot);
  const viewsBySku = new Map();
  for (const entry of snapshots) {
    for (const sku of entry.snapshot.skuPrices || []) {
      const skuId = String(sku.skuId);
      const views = viewsBySku.get(skuId) || [];
      views.push(accountPriceView(entry, sku));
      viewsBySku.set(skuId, views);
    }
  }
  merged.skuPrices = (primary.snapshot.skuPrices || []).map((sku) => ({
    ...structuredClone(sku),
    accountPrices: viewsBySku.get(String(sku.skuId)) || [],
  }));
  merged.primaryAccountSessionId = primary.session.id;
  merged.primaryAccountType = primary.session.accountType || "normal";
  merged.accountCaptures = snapshots.map((entry) => ({
    sessionId: entry.session.id,
    accountName: entry.session.name || "已授权账号",
    accountType: entry.session.accountType || "normal",
    primary: entry === primary,
    capturedAt: entry.snapshot.capturedAt,
    price: entry.snapshot.price,
    priceRange: entry.snapshot.priceRange,
    resolutionStatus: entry.snapshot.resolutionStatus,
    skuCount: entry.snapshot.skuPrices?.length || 0,
    verifiedSkuCount: (entry.snapshot.skuPrices || []).filter((sku) => verifiedChannel(sku, "normal")).length,
  }));
  merged.rawSignals = { ...merged.rawSignals, accountCaptureCount: snapshots.length };
  return merged;
}

export function sessionsForProduct(activeSessions, accountType = "normal", rotation = 0) {
  const rotate = (sessions) => sessions.length
    ? [...sessions.slice(rotation % sessions.length), ...sessions.slice(0, rotation % sessions.length)]
    : [];
  const typeOrder = [...new Set([accountType, "vip88", "gift", "normal"])];
  return typeOrder.flatMap((type) => rotate(activeSessions.filter((session) => (session.accountType || "normal") === type)));
}

export function snapshotHasVerifiedNormalPrice(snapshot) {
  return snapshot?.accessMode === "authenticated" && (snapshot?.skuPrices || []).some((sku) => verifiedChannel(sku, "normal"));
}

export function hasTrustedAccountBaseline(snapshots, accountType = "normal") {
  return snapshots.some((entry) => (entry.session?.accountType || "normal") === accountType && snapshotHasVerifiedNormalPrice(entry.snapshot));
}

export function accountCaptureDiagnostic(snapshots) {
  return snapshots.map(({ session, snapshot }) => {
    const skus = snapshot.skuPrices || [];
    const verified = skus.filter((sku) => verifiedChannel(sku, "normal")).length;
    const reasons = new Set();
    const unknownCodes = new Set();
    for (const sku of skus) {
      if (verifiedChannel(sku, "normal")) continue;
      if (sku.priceResolution?.reason) reasons.add(sku.priceResolution.reason);
      for (const promotion of sku.priceResolution?.formulaInputs?.promotions || []) {
        if (promotion.kind === "unknown") unknownCodes.add(promotion.code);
      }
    }
    const details = [
      `${session?.accountType || "normal"} ${verified}/${skus.length} 个 SKU 已验证`,
      reasons.size ? `原因 ${[...reasons].join(",")}` : "",
      unknownCodes.size ? `未识别促销码 ${[...unknownCodes].join(",")}` : "",
    ].filter(Boolean);
    return details.join("，");
  }).join("；");
}

export function completeScheduledProduct(product, monitor, now = Date.now()) {
  if (resolveProductScheduleMode(product) === "once") {
    return { ...product, enabled: false, monitorStartAt: null, nextMonitorAt: null };
  }
  return scheduleProduct(product, monitor, { reset: true, now });
}

function buyerShowKey(item) {
  const id = String(item?.id || "");
  if (id && !/^(?:buyer|rate)-\d+$/.test(id)) return `id:${id}`;
  return `content:${String(item?.text || "").trim()}|${(item?.images || []).join(",")}|${(item?.videoUrls || []).join(",")}`;
}

export function mergeBuyerShowHistory(currentItems = [], previousItems = []) {
  const merged = new Map();
  for (const item of [...currentItems, ...previousItems].filter(Boolean)) {
    const key = buyerShowKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, structuredClone(item));
      continue;
    }
    merged.set(key, {
      ...item,
      ...existing,
      text: existing.text || item.text || "",
      author: existing.author || item.author || "",
      sku: existing.sku || item.sku || "",
      createdAt: existing.createdAt || item.createdAt || "",
      images: Array.from(new Set([...(existing.images || []), ...(item.images || [])])).slice(0, 30),
      videoUrls: Array.from(new Set([...(existing.videoUrls || []), ...(item.videoUrls || [])])).slice(0, 10),
    });
  }
  return Array.from(merged.values()).slice(0, 100);
}

export function preserveBuyerShowHistory(snapshot, previousSnapshot) {
  const sameItem = previousSnapshot && String(previousSnapshot.itemId || "") === String(snapshot.itemId || "");
  const previousItems = sameItem
    ? (previousSnapshot.buyerShows?.length ? previousSnapshot.buyerShows : previousSnapshot.buyerShowCachedItems || [])
    : [];
  const capture = snapshot.buyerShowCapture;
  const succeeded = ["complete", "partial"].includes(capture?.status);

  if (succeeded) {
    snapshot.buyerShows = mergeBuyerShowHistory(snapshot.buyerShows || capture.items || [], previousItems);
    capture.items = snapshot.buyerShows;
    capture.mediaCount = snapshot.buyerShows.reduce((sum, item) => sum + (item.images?.length || 0) + (item.videoUrls?.length || 0), 0);
    capture.textOnlyCount = snapshot.buyerShows.filter((item) => item.text && !item.images?.length && !item.videoUrls?.length).length;
    snapshot.buyerShowCachedItems = [];
    return snapshot;
  }

  snapshot.buyerShowCachedItems = previousItems;
  if (capture && previousItems.length) {
    capture.lastSuccessfulAt = previousSnapshot.buyerShowCapture?.lastSuccessfulAt
      || previousSnapshot.buyerShowCapture?.capturedAt
      || previousSnapshot.capturedAt;
  }
  return snapshot;
}

export function snapshotAllowsPriceAlerts(snapshot) {
  return snapshot?.accessMode !== "anonymous" && ["verified", "partial"].includes(snapshot?.resolutionStatus);
}

export async function notifyBelowThreshold(current, product, snapshot, source) {
  if (!snapshotAllowsPriceAlerts(snapshot)) return [];
  if (!current.feishu.enabled) return [];
  const skuThresholds = product.skuMonitorPrices || {};
  const alerts = [];
  const pending = [];
  for (const sku of snapshot.skuPrices || []) {
    const threshold = Number(skuThresholds[sku.skuId]);
    const effective = effectivePriceForSku(sku, snapshot.primaryAccountType || product.accountType || "normal");
    const price = effective?.value;
    if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(price) || price >= threshold) continue;

    pending.push({ sku, price, threshold, priceLabel: effective.label });
  }
  if (!pending.length) return alerts;
  try {
    await sendFeishuNotification(current.feishu, {
      type: "below-threshold",
      product,
      price: Math.min(...pending.map((item) => item.price)),
      priceLabel: [...new Set(pending.map((item) => item.priceLabel))].join("、") || "当前价格",
      threshold: null,
      skuName: pending.map((item) => item.sku.name || item.sku.skuId).join("、"),
      triggeredSkuIds: pending.map((item) => item.sku.skuId),
    });
    for (const item of pending) alerts.push(createNotificationLog({ productId: product.id, skuId: item.sku.skuId, type: "below-threshold", status: "sent", message: `SKU「${item.sku.name || item.sku.skuId}」${item.priceLabel}低于监控价，飞书价格预警已发送。`, price: item.price, threshold: item.threshold, source }));
  } catch (error) {
    for (const item of pending) alerts.push(createNotificationLog({ productId: product.id, skuId: item.sku.skuId, type: "below-threshold", status: "failed", message: error.message, price: item.price, threshold: item.threshold, source }));
  }
  return alerts;
}

export async function captureProduct(product, authSessions = [], { scraper = scrapeTmallProduct, allowLocalOnly = false } = {}) {
  const { knownPrimaryImages: _knownPrimaryImages, knownGalleryImages: _knownGalleryImages, knownVideoUrls: _knownVideoUrls, knownPriceSnapshot: _knownPriceSnapshot, ...persistedProduct } = product;
  try {
    if (product.captureMode === "local-only" && !allowLocalOnly) {
      throw new Error("该商品使用本地数据模式，已阻止浏览器抓取。请通过“本地数据导入”更新价格。");
    }
    const targetAccountType = product.accountType || "normal";
    const sessions = [...authSessions];
    if (!sessions.length) throw new Error("没有可用的扫码账号，已停止抓取。请先到账号授权重新检测或授权。");
    const accountTypes = new Set(sessions.map((session) => session.accountType || "normal"));
    const preferredPrimaryAccountType = [targetAccountType, "vip88", "gift", "normal"].find((type) => accountTypes.has(type));
    const snapshots = [];
    const accountErrors = [];
    const groupOrder = [...new Set([preferredPrimaryAccountType, ...sessions.map((session) => session.accountType || "normal")])];
    const sessionGroups = groupOrder.map((type) => sessions.filter((session) => (session.accountType || "normal") === type)).filter((group) => group.length);
    for (const group of sessionGroups) {
      const captureCandidate = snapshots.length === 0
        ? product
        : { ...product, captureBuyerShows: false, captureMediaAssets: false };
      const attempts = group.slice(0, 2);
      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        const session = attempts[attempt];
        try {
          const capturedSnapshot = await withAccountCaptureLock(session, async () => {
            if (session) session.lastUsedAt = new Date().toISOString();
            return scraper(captureCandidate, session);
          });
          if (!snapshotHasVerifiedNormalPrice(capturedSnapshot)) {
            throw new Error("页面未返回可验证的 SKU 普通价。已丢弃本次页面结果并切换账号或重试。");
          }
          snapshots.push({
            session,
            snapshot: capturedSnapshot,
          });
          break;
        } catch (error) {
          accountErrors.push({ sessionId: session.id, accountName: session.name || "已授权账号", attempt: attempt + 1, message: error.message });
          if (session) {
            session.lastFailureAt = new Date().toISOString();
            session.consecutiveFailures = Number(session.consecutiveFailures || 0) + 1;
            session.healthStatus = "degraded";
            if (isExplicitLoginExpiryError(error.message)) session.loginStatus = "expired";
          }
        }
      }
    }
    if (!snapshots.length) throw new Error(accountErrors.map((error) => `${error.accountName}：${error.message}`).join("；"));
    const primaryEntry = snapshots[0];
    const primaryAccountType = primaryEntry.session.accountType || "normal";
    if (!hasTrustedAccountBaseline(snapshots, primaryAccountType)) throw new Error("主账号没有返回可验证的 SKU 普通价，本次结果已拒绝保存。");
    for (const { session } of snapshots) {
      if (!session) continue;
      session.lastSuccessAt = new Date().toISOString();
      session.consecutiveFailures = 0;
      session.healthStatus = "healthy";
      session.loginStatus = "valid";
    }
    const snapshot = mergeAccountSnapshots(snapshots, { primarySessionId: primaryEntry.session.id, primaryAccountType });
    preserveBuyerShowHistory(snapshot, product.lastSnapshot);
    if (snapshot.rawSignals) snapshot.rawSignals.buyerShowCount = snapshot.buyerShows.length;
    snapshot.accountErrors = accountErrors;
    return {
      product: {
        ...persistedProduct,
        name: snapshot.title || product.name,
        shopName: snapshot.shopName || product.shopName || "",
        shopLogo: snapshot.shopLogo || product.shopLogo || "",
        model: snapshot.model || product.model || "",
        itemId: snapshot.itemId || product.itemId || "",
        autoGroup: snapshot.autoGroup || product.autoGroup || "",
        mainImage: snapshot.mainImage || product.mainImage,
        accountType: primaryAccountType,
        primaryAccountSessionId: primaryEntry.session.id,
        lastStatus: "ok",
        lastError: "",
        lastSnapshot: snapshot,
        updatedAt: new Date().toISOString(),
      },
      snapshot: {
        id: newId("snap"),
        productId: product.id,
        ...snapshot,
      },
    };
  } catch (error) {
    return {
      product: {
        ...persistedProduct,
        lastStatus: "error",
        lastError: error.message,
        updatedAt: new Date().toISOString(),
      },
      snapshot: null,
    };
  }
}

async function runMonitorUnlocked({ source = "manual", productIds = null, includeDisabled = false } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const activeSessions = data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const candidates = orderedCaptureCandidates(data.products, productIds, includeDisabled);
  if (queueJob) {
    queueJob.total = candidates.length;
    queueJob.products = candidates.map((product) => ({ id: product.id, name: product.name || product.itemId || product.id }));
  }
  const skipGroupDelay = source === "manual-batch";
  const results = await runInCaptureGroups(candidates, async (product, productIndex) => {
    if (queueJob) {
      queueJob.activeProductIds = [...new Set([...queueJob.activeProductIds, product.id])];
      queueJob.message = `正在抓取 ${queueJob.completed + 1}/${queueJob.total}：${product.name || product.itemId || product.id}`;
    }
    const captureCandidate = {
      ...product,
      knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
      knownGalleryImages: product.captureMediaAssets === true ? Array.from(new Set([...(product.lastSnapshot?.gallery750Images || []), ...historicalProductMedia(data.snapshots, product.id).galleryImages])) : [],
      knownVideoUrls: product.captureMediaAssets === true ? Array.from(new Set([...(product.lastSnapshot?.videoUrls || []), ...historicalProductMedia(data.snapshots, product.id).videoUrls])) : [],
    };
    const accountType = product.accountType || "normal";
    const productSessions = sessionsForProduct(activeSessions, accountType, productIndex);
    try {
      return await attachLocalPriceEvidence(await captureProduct(captureCandidate, productSessions), source);
    } finally {
      if (queueJob) {
        queueJob.activeProductIds = queueJob.activeProductIds.filter((id) => id !== product.id);
        queueJob.completed += 1;
      }
    }
  }, { concurrency: MAX_CAPTURE_CONCURRENCY, delayBetweenGroups: skipGroupDelay ? null : randomProductDelay });

  const runRecord = buildRunRecord({
    source,
    scope: productIds ? "selected-products" : includeDisabled ? "all-products" : "all-enabled-products",
    startedAt,
    results,
    message: results.length ? undefined : productIds ? "没有选中可抓取的商品。" : "没有可抓取的商品。",
  });

  await updateDb(async (current) => {
    persistSessionHealth(current, activeSessions);
    for (const result of results) {
      const index = current.products.findIndex((product) => product.id === result.product.id);
      let savedProduct = result.product;
      if (index >= 0) {
        savedProduct = mergeCapturedProduct(current.products[index], result.product);
        current.products[index] = savedProduct;
      }
      if (result.snapshot) {
        current.snapshots.push(result.snapshot);
        const logs = await notifyBelowThreshold(current, savedProduct, result.snapshot, source);
        current.notificationLogs.push(...logs);
        if (snapshotAllowsPriceAlerts(result.snapshot) && current.feishu.documentEnabled && current.feishu.documentId) {
          try {
            await appendPriceDocument(current.feishu.documentId, savedProduct, result.snapshot);
            current.feishu.lastDocumentSyncAt = new Date().toISOString();
            current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "sent", message: "价格快照已写入飞书文档。", source }));
          } catch (error) {
            current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "failed", message: error.message, source }));
          }
        }
      }
    }
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });

  return { run: runRecord, results };
}

export async function runMonitorOnce(options = {}) {
  return enqueueCaptureOperation({
    source: options.source || "manual",
    scope: options.productIds ? "selected-products" : options.includeDisabled ? "all-products" : "all-enabled-products",
    productIds: options.productIds || [],
  }, (job) => runMonitorUnlocked(options, job));
}

async function runProductUnlocked(productId, { source = "single-product", scraper = scrapeTmallProduct, authSessions: providedAuthSessions = null } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const product = data.products.find((item) => item.id === productId);
  if (!product) throw new Error("商品不存在。");
  if (queueJob) {
    queueJob.total = 1;
    queueJob.products = [{ id: product.id, name: product.name || product.itemId || product.id }];
    queueJob.activeProductIds = [product.id];
    queueJob.message = `正在抓取 1/1：${product.name || product.itemId || product.id}`;
  }

  const activeSessions = Array.isArray(providedAuthSessions)
    ? providedAuthSessions
    : data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const productSessions = sessionsForProduct(activeSessions, accountType);
  let result;
  try {
    result = await captureProduct({
      ...product,
      knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
      knownGalleryImages: product.captureMediaAssets === true ? Array.from(new Set([...(product.lastSnapshot?.gallery750Images || []), ...historicalProductMedia(data.snapshots, product.id).galleryImages])) : [],
      knownVideoUrls: product.captureMediaAssets === true ? Array.from(new Set([...(product.lastSnapshot?.videoUrls || []), ...historicalProductMedia(data.snapshots, product.id).videoUrls])) : [],
    }, productSessions, { scraper, allowLocalOnly: source === "local-import" });
    result = await attachLocalPriceEvidence(result, source);
  } finally {
    if (queueJob) {
      queueJob.activeProductIds = [];
      queueJob.completed = 1;
    }
  }
  const runRecord = buildRunRecord({
    source,
    scope: productId,
    startedAt,
    results: [result],
  });

  await updateDb(async (current) => {
    persistSessionHealth(current, activeSessions);
    const index = current.products.findIndex((item) => item.id === productId);
    let savedProduct = result.product;
    if (index >= 0) {
      savedProduct = mergeCapturedProduct(current.products[index], result.product);
      current.products[index] = savedProduct;
    }
    if (result.snapshot) {
      current.snapshots.push(result.snapshot);
      const logs = await notifyBelowThreshold(current, savedProduct, result.snapshot, source);
      current.notificationLogs.push(...logs);
      if (snapshotAllowsPriceAlerts(result.snapshot) && current.feishu.documentEnabled && current.feishu.documentId) {
        try {
          await appendPriceDocument(current.feishu.documentId, savedProduct, result.snapshot);
          current.feishu.lastDocumentSyncAt = new Date().toISOString();
          current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "sent", message: "价格快照已写入飞书文档。", source }));
        } catch (error) {
          current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "failed", message: error.message, source }));
        }
      }
    }
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });

  return { run: runRecord, ...result };
}

export async function runProductOnce(productId, options = {}) {
  return enqueueCaptureOperation({
    source: options.source || "single-product",
    scope: productId,
    productIds: [productId],
  }, (job) => runProductUnlocked(productId, options, job));
}

async function scheduleNext() {
  if (timer) windowClearTimeout(timer);
  const data = await readDb();

  if (!data.monitor.running) {
    await updateDb((db) => {
      db.monitor.nextRunAt = null;
      return db;
    });
    return null;
  }
  const now = Date.now();
  const scheduledProducts = scheduleProducts(data.products, data.monitor, { now });
  const nextRunAt = earliestProductSchedule(scheduledProducts, data.monitor, now);
  await updateDb((db) => {
    const byId = new Map(scheduledProducts.map((product) => [product.id, product]));
    db.products = db.products.map((product) => {
      const scheduled = byId.get(product.id);
      return scheduled ? { ...product, nextMonitorAt: scheduled.nextMonitorAt } : product;
    });
    db.monitor.nextRunAt = nextRunAt;
    return db;
  });
  if (!nextRunAt) return null;
  const delayMs = Math.max(1000, Date.parse(nextRunAt) - Date.now());
  timer = setTimeout(async () => {
    let dueIds = [];
    try {
      const current = await readDb();
      dueIds = dueProductIds(current.products, Date.now());
      if (dueIds.length) {
        await runMonitorOnce({ source: "scheduled", productIds: dueIds });
        const completedAt = Date.now();
        await updateDb((db) => {
          db.products = db.products.map((product) => dueIds.includes(product.id)
            ? completeScheduledProduct(product, db.monitor, completedAt)
            : product);
          return db;
        });
      }
    } catch (error) {
      console.error("[monitor]", error);
      if (dueIds.length) {
        const retryAt = new Date(Date.now() + 60_000).toISOString();
        await updateDb((db) => {
          db.products = db.products.map((product) => dueIds.includes(product.id) && product.enabled
            ? { ...product, nextMonitorAt: retryAt }
            : product);
          return db;
        });
      }
    } finally {
      await scheduleNext();
    }
  }, delayMs);

  return timer;
}

function windowClearTimeout(handle) {
  clearTimeout(handle);
  timer = null;
}

export async function rescheduleMonitor() {
  return scheduleNext();
}

export function startScheduler() {
  rescheduleMonitor().catch((error) => console.error("[scheduler]", error));
}

export function stopScheduler() {
  if (timer) windowClearTimeout(timer);
}
