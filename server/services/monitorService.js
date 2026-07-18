import { newId, readDb, updateDb } from "../storage/db.js";
import { itemIdFromProductUrl } from "../utils/productUrl.js";
import { scrapeTmallBuyerShows, scrapeTmallProduct } from "./tmallScraper.js";
import { checkTaobaoSession } from "./browserService.js";
import { createNotificationLog, sendFeishuNotification } from "./feishuService.js";
import { saveCapturedSnapshotLocalEvidence } from "./localImportService.js";
import {
  CAPTURE_JOB_RETENTION_MS,
  clearFinishedCaptureJobs as clearPersistedCaptureJobs,
  clearStaleCaptureJobs as clearPersistedStaleCaptureJobs,
  createCaptureJob,
  deleteFailedCaptureJobs as deletePersistedFailedCaptureJobs,
  deleteCaptureJob as deletePersistedCaptureJob,
  getCaptureJobs,
  patchCaptureJob,
  pruneCaptureJobs,
  recoverInterruptedCaptureJobs,
} from "./captureJobService.js";
import { evaluateSkuMonitorRules } from "./monitorRuleService.js";
import { recordPriceEngineShadowRound } from "./priceEngineShadowService.js";
import { drainNotificationOutbox, enqueuePostCommitNotifications } from "./notificationOutboxService.js";
import { applySkuVerificationHistory, updateSkuLifecycle } from "./skuStateService.js";
import {
  createTmallPriceCooldownError,
  hydrateTmallPriceCircuits,
  isTmallPriceCooldownError,
  isTmallPriceGateError,
  markTmallPriceGate,
  markTmallPriceSuccess,
  refreshTmallPriceCircuit,
  tmallPriceCircuitOpen,
} from "./tmallPriceCircuitService.js";

let timer = null;
const captureQueueTails = new Map();
let captureAdmissionTail = Promise.resolve();
const accountCaptureTails = new Map();
const queueJobPatchTails = new Map();
const scheduledCaptureJobIds = new Set();
const captureRetryTimers = new Map();

const MIN_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MIN_DELAY_MS || 5000);
const MAX_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MAX_DELAY_MS || 12000);
const MAX_CAPTURE_CONCURRENCY = 5;
const CAPTURE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MIN_PRODUCT_INTERVAL_MINUTES = 30;
const MAX_PRODUCT_INTERVAL_MINUTES = 1440;
const PRICE_EVIDENCE_UNAVAILABLE_MESSAGE = "商品页本次只返回公开标价或未返回当前 SKU 的可验证普通价；账号登录态未清除，本次未保存价格，请稍后重试或到账号授权检测。";

export function nextCaptureRetry(retryIndex, now = Date.now()) {
  const waitMs = CAPTURE_RETRY_DELAYS_MS[Number(retryIndex)];
  return Number.isFinite(waitMs) ? { waitMs, nextAttemptAt: new Date(now + waitMs).toISOString() } : null;
}

export function captureQueueLane(captureKind = "price", operationType = "") {
  if (captureKind === "buyer-show" || operationType === "buyer-show") return "buyer-show";
  if (captureKind === "materials") return "materials";
  if (captureKind === "price") return "price";
  return "invalid";
}

function assertCaptureKind(captureKind = "price") {
  if (!["price", "buyer-show", "materials"].includes(captureKind)) {
    throw Object.assign(new TypeError(`不支持的抓取类型：${captureKind}`), { status: 400, code: "INVALID_CAPTURE_KIND" });
  }
  return captureKind;
}

function captureJobProductIds(job) {
  return [...new Set([
    ...(Array.isArray(job?.productIds) ? job.productIds : []),
    ...(job?.productId ? [job.productId] : []),
  ].map(String).filter(Boolean))];
}

function activeCaptureJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

export function duplicateCaptureProductIds(jobs, productIds, captureKind = "price", operationType = "") {
  const lane = captureQueueLane(captureKind, operationType);
  const occupied = new Set((Array.isArray(jobs) ? jobs : [])
    .filter(activeCaptureJob)
    .filter((job) => captureQueueLane(job.captureKind, job.operationType) === lane)
    .flatMap(captureJobProductIds));
  return [...new Set((productIds || []).map(String).filter((productId) => occupied.has(productId)))];
}

export function captureAttemptProductIds(job, fallbackProductIds = null) {
  if (Array.isArray(job?.retryProductIds) && job.retryProductIds.length) return [...job.retryProductIds];
  if (Array.isArray(job?.productIds) && job.productIds.length) return [...job.productIds];
  return fallbackProductIds;
}

export function shouldRunCaptureRetry(job, monitor) {
  return job?.source !== "scheduled" || monitor?.running === true;
}

export function captureCommitConflict(currentProduct, result) {
  if (!currentProduct) return "商品已在抓取期间删除，本次旧结果未保存。";
  const capturedProduct = result?.product || {};
  const capturedUrl = String(capturedProduct.url || "").trim();
  const currentUrl = String(currentProduct.url || "").trim();
  const capturedItemId = String(result?.snapshot?.itemId || capturedProduct.itemId || "").trim();
  const currentItemId = String(currentProduct.itemId || safeItemIdFromUrl(currentUrl) || "").trim();
  if ((capturedUrl && currentUrl && capturedUrl !== currentUrl)
    || (capturedItemId && currentItemId && capturedItemId !== currentItemId)) {
    return "商品链接或商品 ID 已在抓取期间变化，本次旧结果未保存，请重新抓取。";
  }
  return "";
}

function rejectCaptureCommit(result, currentProduct, message) {
  result.product = {
    ...(currentProduct || result.product),
    lastStatus: "error",
    lastError: message,
    updatedAt: new Date().toISOString(),
  };
  result.snapshot = null;
  result.commitConflict = message;
  return result;
}

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

async function confirmSessionExpiry(session, message) {
  if (!isExplicitLoginExpiryError(message)) return false;
  // Test/manual sessions do not have a browser to probe; keep their legacy
  // behavior. Real browser sessions require an independent login-page check
  // before the account is removed from the capture pool.
  if (!session?.browserProfileKey || !session?.browserPort) return true;
  try {
    const state = await checkTaobaoSession({
      profileKey: session.browserProfileKey,
      port: session.browserPort,
    });
    return state.status === "expired";
  } catch {
    // A failed probe is a degraded check, not proof that the account expired.
    return false;
  }
}

function shouldDegradeSessionForCaptureError(message = "") {
  return !/页面未返回可验证的 SKU 普通价|主账号没有返回可验证的 SKU 普通价|商品价格数据尚未加载完成|只返回公开标价或未返回当前 SKU/.test(String(message));
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

function scheduleWindowMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function productWindowOffsetMinutes(product, spreadMinutes = 25) {
  const source = String(product?.id || product?.itemId || "product");
  let hash = 0;
  for (const character of source) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % Math.max(1, spreadMinutes);
}

export function nextWindowScheduleAt(product, windows, now = Date.now()) {
  const validWindows = [...new Set((windows || []).map(scheduleWindowMinutes).filter(Number.isFinite))].sort((left, right) => left - right);
  if (!validWindows.length) return null;
  const offsetMinutes = productWindowOffsetMinutes(product);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const windowMinutes of validWindows) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(Math.floor(windowMinutes / 60), windowMinutes % 60 + offsetMinutes, 0, 0);
      if (candidate.getTime() > now) return candidate.toISOString();
    }
  }
  return null;
}

export function scheduleProduct(product, monitor, { reset = false, now = Date.now() } = {}) {
  if (product?.captureMode === "local-only") return { ...product, enabled: false, nextMonitorAt: null };
  if (!monitor?.running || !product?.enabled) return { ...product, nextMonitorAt: null };
  const existing = Date.parse(product.nextMonitorAt || "");
  if (!reset && Number.isFinite(existing)) return product;
  return {
    ...product,
    nextMonitorAt: resolveProductScheduleMode(product) !== "once"
      && product.monitorIntervalMinutes == null
      && monitor.scheduleWindows?.length
      ? nextWindowScheduleAt(product, monitor.scheduleWindows, now)
      : nextProductScheduleAt(product, monitor.intervalMinutes, now),
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

function mergeCapturedSnapshotState(currentProduct, result) {
  if (!result.snapshot) return { result, product: mergeCapturedProduct(currentProduct, result.product) };
  const previousSnapshot = currentProduct?.lastSnapshot;
  const sameItem = previousSnapshot && String(previousSnapshot.itemId || "") === String(result.snapshot.itemId || "");
  if (sameItem && snapshotHasVerifiedNormalPrice(previousSnapshot) && !snapshotHasVerifiedNormalPrice(result.snapshot)) {
    result.snapshot = null;
    result.product = {
      ...result.product,
      lastSnapshot: previousSnapshot,
      lastStatus: "error",
      lastError: "本轮 SKU 价格证据不完整，已保留上次完整快照。",
    };
    return { result, product: mergeCapturedProduct(currentProduct, result.product) };
  }
  preserveBuyerShowHistory(result.snapshot, previousSnapshot);
  if (sameItem) {
    for (const field of ["gallery750Images", "detailImages", "videoUrls", "materialCapturedAt", "materialEvidenceId", "materialEvidenceFile"]) {
      if (previousSnapshot[field] !== undefined) result.snapshot[field] = structuredClone(previousSnapshot[field]);
    }
    result.snapshot.rawSignals = {
      ...(result.snapshot.rawSignals || {}),
      ...Object.fromEntries(Object.entries(previousSnapshot.rawSignals || {}).filter(([key]) => key.startsWith("material"))),
    };
  }
  const snapshot = applySkuVerificationHistory(result.snapshot, currentProduct?.lastSnapshot);
  result.snapshot = snapshot;
  result.product = { ...result.product, lastSnapshot: snapshot };
  const product = {
    ...mergeCapturedProduct(currentProduct, result.product),
    lastSnapshot: snapshot,
    skuLifecycle: updateSkuLifecycle(currentProduct?.skuLifecycle, snapshot),
  };
  return { result, product };
}

function recordPriceShadowRun(current, captureKind, results) {
  if (captureKind !== "price" || !results.length) return;
  const snapshots = results.flatMap((result) => result.snapshot ? [result.snapshot] : []);
  current.priceEngine = recordPriceEngineShadowRound(current.priceEngine, snapshots, {
    failedProducts: results.length - snapshots.length,
  });
}

export function setSkuMonitorPrice(product, skuId, value, channel = "lowest") {
  const skuMonitorRules = structuredClone(product.skuMonitorRules || {});
  const rules = { ...(skuMonitorRules[skuId] || {}) };
  if (value === null) delete rules[channel];
  else rules[channel] = value;
  if (Object.keys(rules).length) skuMonitorRules[skuId] = rules;
  else delete skuMonitorRules[skuId];

  const skuMonitorPrices = { ...(product.skuMonitorPrices || {}) };
  if (channel === "lowest") {
    if (value === null) delete skuMonitorPrices[skuId];
    else skuMonitorPrices[skuId] = value;
  }
  return { ...product, skuMonitorRules, skuMonitorPrices, monitorPrice: null };
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
      tmallPriceStatus: health.tmallPriceStatus || session.tmallPriceStatus || "unknown",
      tmallPriceCheckedAt: health.tmallPriceCheckedAt || session.tmallPriceCheckedAt || null,
      tmallPriceCooldownUntil: health.tmallPriceCooldownUntil || null,
      tmallPriceDeviceCooldownUntil: health.tmallPriceDeviceCooldownUntil || null,
      tmallPriceLastFailureAt: health.tmallPriceLastFailureAt || null,
      tmallPriceFailureReason: health.tmallPriceFailureReason || null,
      tmallPriceFailureCount: Number(health.tmallPriceFailureCount || 0),
    };
  });
}

function publicCaptureJob(job) {
  return {
    id: job.id,
    operationType: job.operationType,
    source: job.source,
    scope: job.scope,
    status: job.status,
    stage: job.stage,
    outcome: job.outcome,
    productIds: job.productIds,
    retryProductIds: job.retryProductIds || [],
    products: job.products,
    activeProductIds: job.activeProductIds,
    total: job.total,
    completed: job.completed,
    attempt: job.attempt || 0,
    retryIndex: job.retryIndex || 0,
    nextAttemptAt: job.nextAttemptAt || null,
    message: job.message,
    error: job.error,
    results: job.results,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export async function getCaptureQueueStatus() {
  const captureJobs = await getCaptureJobs();
  return {
    running: captureJobs.some((job) => job.status === "running"),
    pendingCount: captureJobs.filter((job) => job.status === "queued").length,
    authRequiredCount: captureJobs.filter((job) => job.status === "auth-required").length,
    completedCount: captureJobs.filter((job) => job.status === "completed" || job.status === "failed").length,
    retentionSeconds: CAPTURE_JOB_RETENTION_MS / 1000,
    jobs: captureJobs.map(publicCaptureJob),
  };
}

export async function clearFinishedCaptureJobs() {
  return clearPersistedCaptureJobs();
}

export async function clearFailedCaptureJobs() {
  const removedJobs = await deletePersistedFailedCaptureJobs();
  for (const job of removedJobs) forgetCaptureQueueJob(job.id);
  return removedJobs.length;
}

function forgetCaptureQueueJob(jobId) {
  const retryTimer = captureRetryTimers.get(jobId);
  if (retryTimer) clearTimeout(retryTimer);
  captureRetryTimers.delete(jobId);
  scheduledCaptureJobIds.delete(jobId);
  queueJobPatchTails.delete(jobId);
}

export async function clearStaleCaptureQueueJobs(validProductIds = null) {
  const productIds = validProductIds || (await readDb()).products.map((product) => product.id);
  const removedJobs = await clearPersistedStaleCaptureJobs(productIds);
  for (const job of removedJobs) forgetCaptureQueueJob(job.id);
  return removedJobs.length;
}

export async function deleteCaptureQueueJob(jobId) {
  const removed = await deletePersistedCaptureJob(jobId);
  if (!removed) return null;
  forgetCaptureQueueJob(jobId);
  return publicCaptureJob(removed);
}

async function persistQueueJobPatch(job, patch) {
  if (!job?.id) return job;
  const previous = queueJobPatchTails.get(job.id) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const updated = await patchCaptureJob(job.id, patch);
    if (updated) Object.assign(job, updated);
    return updated;
  });
  queueJobPatchTails.set(job.id, current);
  try {
    return await current;
  } finally {
    if (queueJobPatchTails.get(job.id) === current) queueJobPatchTails.delete(job.id);
  }
}

function mergedJobResults(previous = [], current = []) {
  const byKey = new Map();
  for (const item of [...previous, ...current]) {
    const key = item?.productId || item?.itemId || `${byKey.size}`;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

function captureFailureNeedsAuthorization(message = "") {
  return /没有可用的.*账号|没有可用的扫码账号|请先.*账号授权|请先.*登录|账号登录已明确失效|天猫优惠价格授权未同步|天猫价格能力(?:正在冷却|暂不可用)|TMALL_PRICE_COOLDOWN/.test(String(message));
}

function failedCaptureItems(result) {
  return (result?.run?.items || []).filter((item) => item.status === "failed");
}

function operationForPersistedJob(job) {
  if (job.operationType === "monitor") {
    const captureKind = job.captureKind || "price";
    if (captureQueueLane(captureKind) === "invalid") return null;
    if (captureKind !== "price") {
      return (runtimeJob) => runSpecializedBatchUnlocked({
        source: job.source || `manual-batch-${captureKind}`,
        productIds: captureAttemptProductIds(runtimeJob),
        includeDisabled: job.includeDisabled === true,
        captureKind,
      }, runtimeJob);
    }
    return (runtimeJob) => runMonitorUnlocked({
      source: job.source || "manual",
      productIds: captureAttemptProductIds(runtimeJob),
      includeDisabled: job.includeDisabled === true,
      accountMode: job.accountMode || "primary",
    }, runtimeJob);
  }
  if (job.operationType === "product") {
    const productId = job.productId || job.retryProductIds?.[0] || job.productIds?.[0];
    if (!productId) return null;
    const captureKind = job.captureKind || "price";
    if (captureQueueLane(captureKind) === "invalid") return null;
    if (captureKind === "materials") {
      return (runtimeJob) => runMaterialUnlocked(productId, { source: job.source || "manual-materials" }, runtimeJob);
    }
    if (captureKind === "buyer-show") {
      return (runtimeJob) => runBuyerShowUnlocked(productId, { source: job.source || "manual-buyer-show" }, runtimeJob);
    }
    return (runtimeJob) => runProductUnlocked(productId, {
      source: job.source || "single-product",
      accountMode: job.accountMode || "primary",
    }, runtimeJob);
  }
  if (job.operationType === "buyer-show") {
    const productId = job.productId || job.retryProductIds?.[0] || job.productIds?.[0];
    if (!productId) return null;
    return (runtimeJob) => runBuyerShowUnlocked(productId, { source: job.source || "manual-buyer-show" }, runtimeJob);
  }
  return null;
}

function scheduleCaptureRetry(job, operation) {
  const waitMs = Math.max(0, Date.parse(job.nextAttemptAt || "") - Date.now());
  const existing = captureRetryTimers.get(job.id);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(async () => {
    captureRetryTimers.delete(job.id);
    const data = await readDb();
    if (!shouldRunCaptureRetry(job, data.monitor)) {
      await persistQueueJobPatch(job, {
        stage: "completed",
        outcome: "cancelled",
        activeProductIds: [],
        retryProductIds: [],
        message: "全局监控已暂停，本次定时重试已取消。",
      });
      return;
    }
    queueCaptureAttempt(job, operation).catch((error) => console.error("[capture-retry]", error));
  }, waitMs);
  handle.unref?.();
  captureRetryTimers.set(job.id, handle);
}

function queueCaptureAttempt(job, operation) {
  if (scheduledCaptureJobIds.has(job.id)) return Promise.resolve(null);
  scheduledCaptureJobIds.add(job.id);
  let retryPlan = null;
  const execute = async () => {
    const started = await persistQueueJobPatch(job, {
      stage: "opening",
      activeProductIds: [],
      message: job.attempt ? `正在进行第 ${job.attempt + 1} 次抓取。` : "抓取任务正在启动。",
      error: "",
    });
    if (!started) return null;
    try {
      const result = await operation(job);
      const currentItems = result?.run?.items || [];
      const results = mergedJobResults(job.results, currentItems);
      const failures = failedCaptureItems(result);
      const outcome = result?.run?.status || "success";
      if (!failures.length) {
        await persistQueueJobPatch(job, {
          stage: "completed",
          outcome,
          completed: job.total || results.length,
          activeProductIds: [],
          retryProductIds: [],
          results,
          message: result?.run?.message || "抓取任务已完成。",
        });
        return result;
      }

      const failureMessage = failures.map((item) => item.message).filter(Boolean).join("；");
      if (failures.some((item) => captureFailureNeedsAuthorization(item.message))) {
        await persistQueueJobPatch(job, {
          stage: "auth-required",
          outcome,
          activeProductIds: [],
          retryProductIds: failures.map((item) => item.productId).filter(Boolean),
          results,
          error: failureMessage,
          message: "抓取已暂停：需要重新检测或授权对应账号。",
        });
        return result;
      }

      const retryIndex = Number(job.retryIndex || 0);
      const retry = nextCaptureRetry(retryIndex);
      if (retry) {
        const { waitMs: wait, nextAttemptAt } = retry;
        retryPlan = await persistQueueJobPatch(job, {
          stage: "retrying",
          retryIndex: retryIndex + 1,
          nextAttemptAt,
          outcome,
          activeProductIds: [],
          retryProductIds: failures.map((item) => item.productId).filter(Boolean),
          results,
          error: failureMessage,
          message: `本次有 ${failures.length} 个商品失败，将在 ${Math.round(wait / 60_000)} 分钟后自动重试。`,
        });
        return result;
      }

      const hasSuccess = results.some((item) => item.status !== "failed");
      await persistQueueJobPatch(job, {
        stage: hasSuccess ? "completed" : "failed",
        outcome: hasSuccess ? "partial" : "failed",
        activeProductIds: [],
        results,
        error: failureMessage,
        message: hasSuccess ? "部分商品完成；失败商品已执行 1/5/15 分钟重试。" : "抓取失败；已执行 1/5/15 分钟重试。",
      });
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      await persistQueueJobPatch(job, {
        stage: captureFailureNeedsAuthorization(message) ? "auth-required" : "failed",
        outcome: "failed",
        activeProductIds: [],
        error: message,
        message,
      });
      throw error;
    } finally {
      scheduledCaptureJobIds.delete(job.id);
      if (retryPlan) scheduleCaptureRetry(retryPlan, operation);
    }
  };
  const lane = captureQueueLane(job.captureKind, job.operationType);
  const previous = captureQueueTails.get(lane) || Promise.resolve();
  const promise = previous.then(execute, execute);
  const tail = promise.catch(() => undefined);
  captureQueueTails.set(lane, tail);
  promise.finally(() => {
    if (captureQueueTails.get(lane) === tail) captureQueueTails.delete(lane);
  }).catch(() => undefined);
  return promise;
}

export async function enqueueCaptureOperation(meta, operation) {
  const captureKind = assertCaptureKind(meta.captureKind || "price");
  const admission = captureAdmissionTail.then(async () => {
    const requestedIds = [...new Set((meta.productIds || []).map(String).filter(Boolean))];
    const existingJobs = await getCaptureJobs();
    const duplicates = duplicateCaptureProductIds(existingJobs, requestedIds, captureKind, meta.operationType);
    const duplicateSet = new Set(duplicates);
    const productIds = requestedIds.filter((productId) => !duplicateSet.has(productId));
    if (requestedIds.length && !productIds.length) {
      throw Object.assign(new Error("相同商品和抓取类型已有任务在队列中，请等待当前任务完成。"), {
        status: 409,
        code: "CAPTURE_ALREADY_QUEUED",
        productIds: duplicates,
      });
    }
    return createCaptureJob({
      operationType: meta.operationType || "monitor",
      source: meta.source || "manual",
      scope: meta.scope || "selected-products",
      productId: meta.productId && productIds.includes(String(meta.productId)) ? meta.productId : null,
      productIds,
      deduplicatedProductIds: duplicates,
      retryProductIds: [],
      products: [],
      activeProductIds: [],
      total: productIds.length,
      originalTotal: productIds.length,
      completed: 0,
      retryIndex: 0,
      outcome: null,
      message: duplicates.length ? `已跳过 ${duplicates.length} 个同类型在途商品。` : "等待前面的抓取任务完成。",
      error: "",
      includeDisabled: meta.includeDisabled === true,
      accountMode: meta.accountMode || "primary",
      captureKind,
      recoverable: meta.recoverable !== false,
    });
  });
  captureAdmissionTail = admission.then(() => undefined, () => undefined);
  const job = await admission;
  return queueCaptureAttempt(job, operation);
}

export async function recoverCaptureQueue() {
  await clearStaleCaptureQueueJobs();
  let recovered = [];
  await updateDb((db) => {
    recovered = pruneCaptureJobs(recoverInterruptedCaptureJobs(db.captureJobs));
    db.captureJobs = recovered;
    return db;
  });
  for (const job of [...recovered].reverse()) {
    if (job.status !== "queued") continue;
    const operation = job.recoverable === false ? null : operationForPersistedJob(job);
    if (!operation) {
      await patchCaptureJob(job.id, { stage: "failed", error: "应用重启后无法恢复此抓取任务。", message: "任务无法恢复，请重新发起抓取。" });
      continue;
    }
    if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) scheduleCaptureRetry(job, operation);
    else queueCaptureAttempt(job, operation).catch((error) => console.error("[capture-recovery]", error));
  }
  return recovered.length;
}

export async function resumeCaptureJob(jobId, { operation: operationOverride = null } = {}) {
  const jobs = await getCaptureJobs();
  const job = jobs.find((item) => item.id === jobId);
  if (!job || job.status !== "auth-required") return null;
  const operation = operationOverride || (job.recoverable === false ? null : operationForPersistedJob(job));
  if (!operation) {
    const failed = await patchCaptureJob(job.id, {
      stage: "failed",
      error: "当前任务缺少可恢复的持久参数。",
      message: "任务无法恢复，请重新发起抓取。",
    });
    return failed ? publicCaptureJob(failed) : null;
  }
  const conflicts = duplicateCaptureProductIds(jobs.filter((item) => item.id !== job.id), captureJobProductIds(job), job.captureKind, job.operationType);
  if (conflicts.length) return publicCaptureJob(job);
  const resumed = await patchCaptureJob(job.id, {
    stage: "queued",
    activeProductIds: [],
    error: "",
    message: "账号已恢复，任务重新进入抓取队列。",
  });
  if (!resumed) return null;
  queueCaptureAttempt(resumed, operation).catch((error) => console.error("[capture-auth-resume]", error));
  return publicCaptureJob(resumed);
}

export async function resumeAuthRequiredCaptureJobs() {
  const jobs = await getCaptureJobs();
  const resumed = [];
  for (const job of [...jobs].reverse()) {
    if (job.status !== "auth-required") continue;
    const result = await resumeCaptureJob(job.id);
    if (result?.status === "queued") resumed.push(result);
  }
  return resumed;
}

export function stopCaptureQueue() {
  for (const handle of captureRetryTimers.values()) clearTimeout(handle);
  captureRetryTimers.clear();
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

function priceCapturePreferences() {
  return { captureBuyerShows: false, captureMediaAssets: false };
}

const MATERIAL_SNAPSHOT_FIELDS = Object.freeze([
  "mainImage",
  "mainImage800",
  "mainImages",
  "gallery750Images",
  "skuImages",
  "detailImages",
  "videoUrls",
]);

export function mergeCapturedMaterials(previousSnapshot, capturedSnapshot) {
  if (!previousSnapshot || !capturedSnapshot) return previousSnapshot || null;
  const next = structuredClone(previousSnapshot);
  for (const field of MATERIAL_SNAPSHOT_FIELDS) {
    if (capturedSnapshot[field] !== undefined) next[field] = structuredClone(capturedSnapshot[field]);
  }
  const capturedSkuImages = new Map((capturedSnapshot.skuPrices || []).map((sku) => [String(sku.skuId), sku.image]).filter(([, image]) => image));
  next.skuPrices = (next.skuPrices || []).map((sku) => capturedSkuImages.has(String(sku.skuId))
    ? { ...sku, image: capturedSkuImages.get(String(sku.skuId)) }
    : sku);
  next.materialCapturedAt = capturedSnapshot.capturedAt || new Date().toISOString();
  next.materialEvidenceId = capturedSnapshot.browserEvidenceId || null;
  next.materialEvidenceFile = capturedSnapshot.browserEvidenceFile || null;
  next.rawSignals = {
    ...(next.rawSignals || {}),
    materialCapturedAt: next.materialCapturedAt,
    materialImageCount: MATERIAL_SNAPSHOT_FIELDS
      .filter((field) => Array.isArray(next[field]))
      .reduce((total, field) => total + next[field].length, next.mainImage800 || next.mainImage ? 1 : 0),
    materialVideoCount: next.videoUrls?.length || 0,
  };
  return next;
}

export function mergeCapturedBuyerShows(previousSnapshot, capturedSnapshot) {
  if (!previousSnapshot || !capturedSnapshot) return previousSnapshot || null;
  const next = structuredClone(previousSnapshot);
  for (const field of ["buyerShowCapture", "buyerShows", "buyerShowCachedItems", "buyerShowEvidenceId", "buyerShowEvidenceFile", "buyerShowLocalFirst"]) {
    if (capturedSnapshot[field] !== undefined) next[field] = structuredClone(capturedSnapshot[field]);
  }
  const buyerSignals = Object.fromEntries(Object.entries(capturedSnapshot.rawSignals || {}).filter(([key]) => key.startsWith("buyerShow")));
  next.rawSignals = { ...(next.rawSignals || {}), ...buyerSignals };
  return next;
}

function capturedMaterialCount(snapshot) {
  return [
    snapshot?.mainImage800,
    snapshot?.mainImage,
    ...(snapshot?.mainImages || []),
    ...(snapshot?.gallery750Images || []),
    ...(snapshot?.skuImages || []),
    ...(snapshot?.detailImages || []),
    ...(snapshot?.videoUrls || []),
  ].filter(Boolean).length;
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
  const channel = sku?.priceResolution?.channels?.[kind];
  return channel?.status === "verified" && Number.isSafeInteger(channel.valueCents) && channel.valueCents > 0;
}

function accountPriceView(entry, sku) {
  return {
    sessionId: entry.session.id,
    accountName: entry.session.name || "已授权账号",
    accountType: entry.session.accountType || "normal",
    capturedAt: entry.snapshot.capturedAt,
    price: sku.price,
    normalPrice: sku.normalPrice,
    billionPrice: sku.billionPrice ?? null,
    billionStatus: sku.billionStatus || "none",
    seckillPrice: sku.seckillPrice ?? null,
    seckillStatus: sku.seckillStatus || "none",
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

export function sessionsForProduct(activeSessions, accountType = "normal", rotation = 0, accountMode = "primary", preferredSessionId = "") {
  const rotate = (sessions) => sessions.length
    ? [...sessions.slice(rotation % sessions.length), ...sessions.slice(0, rotation % sessions.length)]
    : [];
  const preferAssigned = (sessions) => {
    const preferred = sessions.find((session) => session.id === preferredSessionId);
    return preferred ? [preferred, ...sessions.filter((session) => session !== preferred)] : sessions;
  };
  if (accountMode !== "all") {
    return preferAssigned(rotate(activeSessions.filter((session) => (session.accountType || "normal") === accountType)));
  }
  const typeOrder = [...new Set([accountType, "vip88", "gift", "normal"])];
  return typeOrder.flatMap((type) => preferAssigned(rotate(activeSessions.filter((session) => (session.accountType || "normal") === type))));
}

export function snapshotHasVerifiedNormalPrice(snapshot) {
  const skus = snapshot?.skuPrices || [];
  const observedSkuCount = Number(snapshot?.rawSignals?.observedSkuCount);
  const outputSkuCount = Number(snapshot?.rawSignals?.outputSkuCount);
  const verifiedSkuCount = skus.filter((sku) => verifiedChannel(sku, "normal")).length;
  return snapshot?.accessMode === "authenticated"
    && snapshot?.resolutionStatus === "verified"
    && Number.isSafeInteger(observedSkuCount)
    && observedSkuCount > 0
    && observedSkuCount === outputSkuCount
    && outputSkuCount === skus.length
    && verifiedSkuCount === observedSkuCount;
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
  return snapshotHasVerifiedNormalPrice(snapshot);
}

function looksLikeAlertLeaf(value) {
  return value && typeof value === "object" && (Object.hasOwn(value, "thresholdCents") || Object.hasOwn(value, "relation"));
}

function looksLikeSkuAlertStates(value) {
  return value && typeof value === "object" && Object.values(value).some((channels) => (
    channels && typeof channels === "object" && Object.values(channels).some(looksLikeAlertLeaf)
  ));
}

function accountAlertStates(productStates, accountType) {
  if (looksLikeSkuAlertStates(productStates?.[accountType])) return productStates[accountType];
  if (["normal", "gift", "vip88"].some((type) => looksLikeSkuAlertStates(productStates?.[type]))) return {};
  return looksLikeSkuAlertStates(productStates) ? productStates : {};
}

function prepareThresholdAlert(current, product, snapshot, source) {
  if (!snapshotAllowsPriceAlerts(snapshot)) return { product, source, pending: [], previousStates: {}, stateChanged: false };
  const skuMonitorRules = Object.keys(product.skuMonitorRules || {}).length
    ? product.skuMonitorRules
    : Object.fromEntries(Object.entries(product.skuMonitorPrices || {}).map(([skuId, threshold]) => [skuId, { lowest: threshold }]));
  const accountType = snapshot.primaryAccountType || product.accountType || "normal";
  const storedProductStates = current.alertStates?.[product.id] || {};
  const previousStates = accountAlertStates(storedProductStates, accountType);
  const { evaluations, nextStates } = evaluateSkuMonitorRules({
    skuPrices: snapshot.skuPrices || [],
    skuMonitorRules,
    accountType,
    previousStates,
  });
  current.alertStates ||= {};
  const accountBuckets = ["normal", "gift", "vip88"].some((type) => looksLikeSkuAlertStates(storedProductStates?.[type]))
    ? storedProductStates
    : {};
  current.alertStates[product.id] = { ...accountBuckets, [accountType]: nextStates };

  const skuById = new Map((snapshot.skuPrices || []).map((sku) => [String(sku.skuId), sku]));
  const channelLabels = {
    normal: "普通价",
    billion: "百亿补贴价",
    seckill: "淘宝秒杀价",
    government: "国补价",
    surprise: "惊喜立减价",
    gift: "礼金价",
    vip88: "88VIP价",
    coin: "淘金币价",
  };
  const pending = evaluations
    .filter((item) => item.event === "crossing-below" || item.event === "new-low")
    .map((item) => ({
      ...item,
      sku: skuById.get(String(item.skuId)),
      price: item.priceCents / 100,
      priceLabel: item.channel === "lowest"
        ? `最低价（${channelLabels[item.resolvedChannel] || item.resolvedChannel || "已验证价格"}）`
        : channelLabels[item.channel] || item.channel,
    }));
  return {
    product,
    source,
    accountType,
    snapshotCapturedAt: snapshot.capturedAt,
    pending: current.feishu.enabled ? pending : [],
    previousStates,
    stateChanged: true,
  };
}

function rollbackThresholdAlertState(current, plan) {
  current.alertStates[plan.product.id] ||= {};
  current.alertStates[plan.product.id][plan.accountType] ||= {};
  const accountStates = current.alertStates[plan.product.id][plan.accountType];
  for (const item of plan.pending) {
    if (plan.previousStates?.[item.skuId]?.[item.channel]) {
      accountStates[item.skuId] ||= {};
      accountStates[item.skuId][item.channel] = plan.previousStates[item.skuId][item.channel];
    } else {
      delete accountStates?.[item.skuId]?.[item.channel];
    }
  }
}

async function deliverThresholdAlert(feishu, plan) {
  const alerts = [];
  if (!plan.pending.length) return { alerts, failed: false };
  try {
    await sendFeishuNotification(feishu, {
      type: "below-threshold",
      product: plan.product,
      price: Math.min(...plan.pending.map((item) => item.price)),
      priceLabel: [...new Set(plan.pending.map((item) => item.priceLabel))].join("、") || "当前价格",
      threshold: null,
      skuName: plan.pending.map((item) => item.sku?.name || item.skuId).join("、"),
      triggeredSkuIds: [...new Set(plan.pending.map((item) => item.skuId))],
      triggeredRules: plan.pending.map((item) => ({
        skuId: item.skuId,
        channel: item.channel,
        resolvedChannel: item.resolvedChannel,
        event: item.event,
        priceCents: item.priceCents,
        thresholdCents: item.thresholdCents,
        priceLabel: item.priceLabel,
      })),
    });
    for (const item of plan.pending) alerts.push(createNotificationLog({ productId: plan.product.id, skuId: item.skuId, type: "below-threshold", status: "sent", message: `SKU「${item.sku?.name || item.skuId}」${item.event === "new-low" ? "出现新低" : "首次跌破监控价"}：${item.priceLabel} ¥${item.price.toFixed(2)}，飞书预警已发送。`, price: item.price, threshold: item.threshold, source: plan.source }));
    return { alerts, failed: false };
  } catch (error) {
    for (const item of plan.pending) alerts.push(createNotificationLog({ productId: plan.product.id, skuId: item.skuId, type: "below-threshold", status: "failed", message: error.message, price: item.price, threshold: item.threshold, source: plan.source }));
    return { alerts, failed: true };
  }
}

export async function notifyBelowThreshold(current, product, snapshot, source) {
  const plan = prepareThresholdAlert(current, product, snapshot, source);
  const delivered = await deliverThresholdAlert(current.feishu, plan);
  if (delivered.failed) rollbackThresholdAlertState(current, plan);
  return delivered.alerts;
}

export async function captureProduct(product, authSessions = [], { scraper = scrapeTmallProduct, allowLocalOnly = false, accountMode = "primary" } = {}) {
  const { knownPrimaryImages: _knownPrimaryImages, knownGalleryImages: _knownGalleryImages, knownVideoUrls: _knownVideoUrls, knownPriceSnapshot: _knownPriceSnapshot, ...persistedProduct } = product;
  try {
    if (product.captureMode === "local-only" && !allowLocalOnly) {
      throw new Error("该商品使用本地数据模式，已阻止浏览器抓取。请通过“本地数据导入”更新价格。");
    }
    const targetAccountType = product.accountType || "normal";
    const sessions = [...authSessions].filter((session) => (session.accountType || "normal") === targetAccountType || accountMode === "all");
    hydrateTmallPriceCircuits(sessions);
    const primarySessions = sessions.filter((session) => (session.accountType || "normal") === targetAccountType);
    if (!primarySessions.length) {
      const accountLabel = targetAccountType === "gift" ? "礼金" : targetAccountType === "vip88" ? "88VIP" : "普通";
      throw new Error(`没有可用的${accountLabel}账号，已停止抓取。日常抓价不会静默换用其他账号类型，请先到账号授权重新检测或授权。`);
    }
    const snapshots = [];
    const accountErrors = [];
    const groupOrder = accountMode === "all"
      ? [...new Set([targetAccountType, ...sessions.map((session) => session.accountType || "normal")])]
      : [targetAccountType];
    const sessionGroups = groupOrder.map((type) => sessions.filter((session) => (session.accountType || "normal") === type)).filter((group) => group.length);
    for (const group of sessionGroups) {
      let groupCircuitOpened = false;
      const captureCandidate = snapshots.length === 0
        ? product
        : { ...product, captureBuyerShows: false, captureMediaAssets: false };
      const attempts = group.slice(0, 2);
      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        const session = attempts[attempt];
        try {
          const capturedSnapshot = await withAccountCaptureLock(session, async () => {
            if (session?.source === "taobao-browser") {
              refreshTmallPriceCircuit(session);
              if (tmallPriceCircuitOpen(session)) throw createTmallPriceCooldownError(session);
            }
            if (session) session.lastUsedAt = new Date().toISOString();
            return scraper(captureCandidate, session);
          });
          if (!snapshotHasVerifiedNormalPrice(capturedSnapshot)) {
            throw new Error(PRICE_EVIDENCE_UNAVAILABLE_MESSAGE);
          }
          if (session?.source === "taobao-browser"
            && (capturedSnapshot.localFirst?.sourceSaved !== true || capturedSnapshot.localFirst?.parsedFromDisk !== true)) {
            throw new Error("浏览器价格证据未完成脱敏落盘和本地重新解析，本次未保存价格。请稍后重试。");
          }
          // This transition is intentionally after local evidence verification.
          // A Taobao cookie/login check alone must never claim Tmall price access.
          if (session?.source === "taobao-browser") markTmallPriceSuccess(session);
          snapshots.push({
            session,
            snapshot: capturedSnapshot,
          });
          break;
        } catch (error) {
          const tmallGate = session?.source === "taobao-browser" && isTmallPriceGateError(error);
          const tmallCooldown = session?.source === "taobao-browser" && isTmallPriceCooldownError(error);
          let sessionExpired = false;
          if (session) {
            session.lastFailureAt = new Date().toISOString();
            session.consecutiveFailures = Number(session.consecutiveFailures || 0) + 1;
            if (shouldDegradeSessionForCaptureError(error.message)) session.healthStatus = "degraded";
            if (tmallGate) {
              markTmallPriceGate(session);
              session.healthStatus = "degraded";
              groupCircuitOpened = true;
            } else if (!tmallCooldown) {
              sessionExpired = await confirmSessionExpiry(session, error.message);
              if (sessionExpired) session.loginStatus = "expired";
            } else {
              groupCircuitOpened = true;
            }
          }
          const message = isExplicitLoginExpiryError(error.message) && !sessionExpired
            ? "商品页临时跳转登录/验证，但账号检测仍有效，本次未保存价格。"
            : tmallGate
              ? `${error.message} 已暂停该账号浏览器的连续重试，进入价格能力冷却。`
              : error.message;
          accountErrors.push({ sessionId: session.id, accountName: session.name || "已授权账号", attempt: attempt + 1, message });
          if (tmallGate || tmallCooldown) break;
        }
      }
      if (!snapshots.length && groupCircuitOpened) break;
      if (!snapshots.length) break;
    }
    if (!snapshots.length) throw new Error(accountErrors.map((error) => `${error.accountName}：${error.message}`).join("；"));
    const primaryEntry = snapshots[0];
    const primaryAccountType = targetAccountType;
    if (!hasTrustedAccountBaseline(snapshots, primaryAccountType)) throw new Error(PRICE_EVIDENCE_UNAVAILABLE_MESSAGE);
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

async function runMonitorUnlocked({ source = "manual", productIds = null, includeDisabled = false, accountMode = "primary", scraper = scrapeTmallProduct } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const activeSessions = data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const candidates = orderedCaptureCandidates(data.products, productIds, includeDisabled);
  const activeProductIds = new Set();
  const previouslyCompletedIds = new Set((queueJob?.results || [])
    .filter((item) => item?.status !== "failed")
    .map((item) => String(item.productId || ""))
    .filter(Boolean));
  let completedCount = previouslyCompletedIds.size;
  if (queueJob) {
    queueJob.total = queueJob.originalTotal || queueJob.total || candidates.length;
    if (!queueJob.products?.length) queueJob.products = candidates.map((product) => ({ id: product.id, name: product.name || product.itemId || product.id }));
    queueJob.completed = completedCount;
    await persistQueueJobPatch(queueJob, {
      stage: "capturing",
      total: queueJob.total,
      completed: completedCount,
      products: queueJob.products,
      activeProductIds: [],
      message: candidates.length ? `准备抓取 ${candidates.length} 个商品。` : "没有可抓取的商品。",
    });
  }
  const skipGroupDelay = source === "manual-batch";
  const results = await runInCaptureGroups(candidates, async (product, productIndex) => {
    if (queueJob) {
      activeProductIds.add(product.id);
      queueJob.message = `正在抓取 ${completedCount + 1}/${queueJob.total}：${product.name || product.itemId || product.id}`;
      await persistQueueJobPatch(queueJob, {
        stage: "capturing",
        activeProductIds: [...activeProductIds],
        message: queueJob.message,
      });
    }
    const captureCandidate = {
      ...product,
      ...priceCapturePreferences(),
      knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
      knownGalleryImages: [],
      knownVideoUrls: [],
    };
    const accountType = product.accountType || "normal";
    const productSessions = sessionsForProduct(activeSessions, accountType, productIndex, accountMode, product.primaryAccountSessionId);
    try {
      return await attachLocalPriceEvidence(await captureProduct(captureCandidate, productSessions, { accountMode, scraper }), source);
    } finally {
      if (queueJob) {
        activeProductIds.delete(product.id);
        completedCount += 1;
        await persistQueueJobPatch(queueJob, {
          stage: "capturing",
          activeProductIds: [...activeProductIds],
          completed: completedCount,
          message: `已完成 ${completedCount}/${queueJob.total} 个商品。`,
        });
      }
    }
  }, { concurrency: MAX_CAPTURE_CONCURRENCY, delayBetweenGroups: skipGroupDelay ? null : randomProductDelay });

  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "parsing", message: "正在整理本轮价格与 SKU 结果。" });

  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "verifying", message: "正在核对价格证据与监控规则。" });

  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "saving", message: "正在保存价格快照与提醒状态。" });
  const alertPlans = [];
  const documentPlans = [];
  let runRecord = null;
  await updateDb((current) => {
    persistSessionHealth(current, activeSessions);
    for (const result of results) {
      const index = current.products.findIndex((product) => product.id === result.product.id);
      const currentProduct = index >= 0 ? current.products[index] : null;
      const conflict = captureCommitConflict(currentProduct, result);
      if (conflict) {
        rejectCaptureCommit(result, currentProduct, conflict);
        continue;
      }
      let savedProduct = result.product;
      const merged = mergeCapturedSnapshotState(currentProduct, result);
      savedProduct = merged.product;
      current.products[index] = savedProduct;
      if (result.snapshot) {
        current.snapshots.push(result.snapshot);
        const alertPlan = prepareThresholdAlert(current, savedProduct, result.snapshot, source);
        if (alertPlan.pending.length) alertPlans.push(alertPlan);
        if (snapshotAllowsPriceAlerts(result.snapshot) && current.feishu.documentEnabled && current.feishu.documentId) {
          documentPlans.push({ product: savedProduct, snapshot: result.snapshot });
        }
      }
    }
    recordPriceShadowRun(current, "price", results);
    enqueuePostCommitNotifications(current, { alertPlans, documentPlans, source });
    runRecord = buildRunRecord({
      source,
      scope: productIds ? "selected-products" : includeDisabled ? "all-products" : "all-enabled-products",
      startedAt,
      results,
      message: results.length ? undefined : productIds ? "没有选中可抓取的商品。" : "没有可抓取的商品。",
    });
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });
  void drainNotificationOutbox().catch((error) => console.error("[notification-outbox]", error));

  return { run: runRecord, results };
}

export async function runMonitorOnce(options = {}) {
  const captureKind = assertCaptureKind(options.captureKind || "price");
  if (captureKind !== "price") {
    throw Object.assign(new TypeError("价格监控入口只接受 price；买家秀和完整素材必须使用各自独立队列。"), { status: 400, code: "CAPTURE_KIND_MISMATCH" });
  }
  return enqueueCaptureOperation({
    operationType: "monitor",
    source: options.source || "manual",
    scope: options.productIds ? "selected-products" : options.includeDisabled ? "all-products" : "all-enabled-products",
    productIds: options.productIds || [],
    includeDisabled: options.includeDisabled === true,
    accountMode: options.accountMode || "primary",
    captureKind: "price",
  }, (job) => runMonitorUnlocked({
    ...options,
    productIds: captureAttemptProductIds(job, options.productIds),
  }, job));
}

function specializedBatchRun({ source, captureKind, startedAt, items }) {
  const failed = items.filter((item) => item.status === "failed").length;
  const success = items.length - failed;
  const label = captureKind === "materials" ? "完整素材" : "买家秀";
  return {
    id: newId("run"),
    source,
    scope: "selected-products",
    status: failed ? (success ? "partial" : "failed") : "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    total: items.length,
    success,
    failed,
    items,
    message: `${label}批量任务完成：成功 ${success} 个，失败 ${failed} 个；价格快照、趋势、告警和飞书状态未改动。`,
  };
}

async function runSpecializedBatchUnlocked({ source, productIds, includeDisabled = false, captureKind, scraper, authSessions } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const candidates = orderedCaptureCandidates(data.products, productIds, includeDisabled);
  const activeProductIds = new Set();
  const previouslyCompletedIds = new Set((queueJob?.results || [])
    .filter((item) => item?.status !== "failed")
    .map((item) => String(item.productId || ""))
    .filter(Boolean));
  let completedCount = previouslyCompletedIds.size;
  if (queueJob) {
    queueJob.total = queueJob.originalTotal || queueJob.total || candidates.length;
    if (!queueJob.products?.length) queueJob.products = candidates.map((product) => ({ id: product.id, name: product.name || product.itemId || product.id }));
    await persistQueueJobPatch(queueJob, {
      stage: "capturing",
      total: queueJob.total,
      completed: completedCount,
      products: queueJob.products,
      activeProductIds: [],
      message: `准备单独抓取 ${candidates.length} 个商品的${captureKind === "materials" ? "完整素材" : "买家秀"}。`,
    });
  }

  const outputs = await runInCaptureGroups(candidates, async (product) => {
    activeProductIds.add(product.id);
    if (queueJob) await persistQueueJobPatch(queueJob, {
      stage: "capturing",
      activeProductIds: [...activeProductIds],
      message: `正在抓取 ${completedCount + 1}/${queueJob.total}：${product.name || product.itemId || product.id}`,
    });
    try {
      return captureKind === "materials"
        ? await runMaterialUnlocked(product.id, { source, scraper, authSessions, persistRun: false })
        : await runBuyerShowUnlocked(product.id, { source, scraper, authSessions, persistRun: false });
    } catch (error) {
      const message = error?.message || String(error);
      return {
        product: { ...product, lastError: message },
        snapshot: null,
        run: { items: [{ productId: product.id, requestedItemId: safeItemIdFromUrl(product.url), itemId: product.itemId || "", name: product.name || product.itemId || product.id, accountType: product.accountType || "normal", status: "failed", message, capturedAt: new Date().toISOString() }] },
      };
    } finally {
      activeProductIds.delete(product.id);
      completedCount += 1;
      if (queueJob) await persistQueueJobPatch(queueJob, {
        stage: "capturing",
        activeProductIds: [...activeProductIds],
        completed: completedCount,
        message: `已完成 ${completedCount}/${queueJob.total} 个商品。`,
      });
    }
  }, { concurrency: MAX_CAPTURE_CONCURRENCY, delayBetweenGroups: source === "manual-batch" ? null : randomProductDelay });

  const items = outputs.flatMap((output) => output.run?.items || []);
  const run = specializedBatchRun({ source, captureKind, startedAt, items });
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "saving", activeProductIds: [], message: `正在保存${captureKind === "materials" ? "完整素材" : "买家秀"}批量结果。` });
  await updateDb((current) => {
    current.runs.push(run);
    current.runs = current.runs.slice(-200);
    return current;
  });
  return { run, results: outputs };
}

export async function runCaptureBatchOnce(options = {}) {
  const captureKind = assertCaptureKind(options.captureKind || "price");
  if (captureKind === "price") return runMonitorOnce({ ...options, captureKind: "price" });
  return enqueueCaptureOperation({
    operationType: "monitor",
    source: options.source || `manual-batch-${captureKind}`,
    scope: "selected-products",
    productIds: options.productIds || [],
    includeDisabled: options.includeDisabled === true,
    captureKind,
    recoverable: !options.scraper && !options.authSessions,
  }, (job) => runSpecializedBatchUnlocked({
    ...options,
    source: options.source || `manual-batch-${captureKind}`,
    captureKind,
    productIds: captureAttemptProductIds(job, options.productIds),
  }, job));
}

async function runMaterialUnlocked(productId, { source = "manual-materials", scraper = scrapeTmallProduct, authSessions: providedAuthSessions = null, persistRun = true } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const product = data.products.find((item) => item.id === productId);
  if (!product) throw Object.assign(new Error("商品不存在。"), { status: 404 });
  if (product.captureMode === "local-only") throw Object.assign(new Error("该商品使用本地数据模式，已阻止完整素材网页抓取。"), { status: 409 });
  if (!product.lastSnapshot) throw Object.assign(new Error("商品还没有价格快照，请先完成首次价格抓取。"), { status: 409 });
  const activeSessions = Array.isArray(providedAuthSessions)
    ? providedAuthSessions
    : data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const sessionCandidates = sessionsForProduct(activeSessions, accountType, 0, "primary", product.primaryAccountSessionId).slice(0, 2);
  if (!sessionCandidates.length) throw Object.assign(new Error(`没有可用的${accountType === "vip88" ? "88VIP" : accountType === "gift" ? "礼金" : "普通"}账号，请先到账号授权页面登录。`), { status: 409 });

  if (queueJob) await persistQueueJobPatch(queueJob, {
    stage: "capturing",
    total: 1,
    completed: 0,
    products: [{ id: product.id, name: product.name || product.itemId || product.id }],
    activeProductIds: [product.id],
    message: "正在单独抓取主图、详情图和视频素材。",
  });

  const candidate = {
    ...product,
    captureBuyerShows: false,
    captureMediaAssets: true,
    knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
    knownGalleryImages: Array.from(new Set([...(product.lastSnapshot?.gallery750Images || []), ...historicalProductMedia(data.snapshots, product.id).galleryImages])),
    knownVideoUrls: Array.from(new Set([...(product.lastSnapshot?.videoUrls || []), ...historicalProductMedia(data.snapshots, product.id).videoUrls])),
  };
  let capturedSnapshot = null;
  let failureMessage = "完整素材页面本次没有返回可验证的图片或视频。";
  for (const session of sessionCandidates) {
    session.lastUsedAt = new Date().toISOString();
    try {
      const captured = await withAccountCaptureLock(session, () => scraper(candidate, session));
      if (!capturedMaterialCount(captured)) throw new Error(failureMessage);
      capturedSnapshot = captured;
      session.lastSuccessAt = new Date().toISOString();
      session.consecutiveFailures = 0;
      session.healthStatus = "healthy";
      break;
    } catch (error) {
      failureMessage = error?.message || String(error);
      session.lastFailureAt = new Date().toISOString();
      if (await confirmSessionExpiry(session, failureMessage)) session.loginStatus = "expired";
      else if (shouldDegradeSessionForCaptureError(failureMessage)) session.healthStatus = "degraded";
    }
  }

  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "parsing", completed: 1, activeProductIds: [], message: "正在整理完整素材结果。" });
  let updatedProduct = product;
  let savedSnapshot = null;
  let runRecord = null;
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "saving", message: "正在保存素材；价格与提醒不会改动。" });
  await updateDb((current) => {
    persistSessionHealth(current, activeSessions);
    const productIndex = current.products.findIndex((item) => item.id === product.id);
    const currentProduct = productIndex >= 0 ? current.products[productIndex] : null;
    const conflict = capturedSnapshot ? captureCommitConflict(currentProduct, { product, snapshot: capturedSnapshot }) : "";
    if (capturedSnapshot && !conflict && currentProduct?.lastSnapshot) {
      savedSnapshot = mergeCapturedMaterials(currentProduct.lastSnapshot, capturedSnapshot);
      updatedProduct = {
        ...currentProduct,
        mainImage: savedSnapshot.mainImage800 || savedSnapshot.mainImage || currentProduct.mainImage,
        lastSnapshot: savedSnapshot,
        updatedAt: new Date().toISOString(),
      };
      current.products[productIndex] = updatedProduct;
      for (let index = current.snapshots.length - 1; index >= 0; index -= 1) {
        if (current.snapshots[index].productId !== product.id) continue;
        current.snapshots[index] = { ...current.snapshots[index], ...savedSnapshot };
        break;
      }
    } else if (conflict) {
      failureMessage = conflict;
    }
    const result = savedSnapshot
      ? { product: updatedProduct, snapshot: savedSnapshot }
      : { product: { ...(currentProduct || product), lastError: failureMessage }, snapshot: null };
    runRecord = buildRunRecord({
      source,
      scope: productId,
      startedAt,
      results: [result],
      message: savedSnapshot
        ? `完整素材抓取完成，共识别 ${capturedMaterialCount(savedSnapshot)} 项图片或视频；价格、趋势和飞书提醒未改动。`
        : `${failureMessage} 价格、趋势和飞书提醒未改动。`,
    });
    if (persistRun) {
      current.runs.push(runRecord);
      current.runs = current.runs.slice(-200);
    }
    return current;
  });
  return { run: runRecord, product: updatedProduct, snapshot: savedSnapshot };
}

async function runProductUnlocked(productId, { source = "single-product", scraper = scrapeTmallProduct, authSessions: providedAuthSessions = null, accountMode = "primary" } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const product = data.products.find((item) => item.id === productId);
  if (!product) throw new Error("商品不存在。");
  if (queueJob) {
    queueJob.total = 1;
    queueJob.products = [{ id: product.id, name: product.name || product.itemId || product.id }];
    queueJob.activeProductIds = [product.id];
    queueJob.message = `正在抓取 1/1：${product.name || product.itemId || product.id}`;
    await persistQueueJobPatch(queueJob, {
      stage: "capturing",
      total: 1,
      completed: 0,
      products: queueJob.products,
      activeProductIds: queueJob.activeProductIds,
      message: queueJob.message,
    });
  }

  const activeSessions = Array.isArray(providedAuthSessions)
    ? providedAuthSessions
    : data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const productSessions = sessionsForProduct(activeSessions, accountType, 0, accountMode, product.primaryAccountSessionId);
  let result;
  try {
    result = await captureProduct({
      ...product,
      ...priceCapturePreferences(),
      knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
      knownGalleryImages: [],
      knownVideoUrls: [],
    }, productSessions, { scraper, allowLocalOnly: source === "local-import", accountMode });
    result = await attachLocalPriceEvidence(result, source);
  } finally {
    if (queueJob) {
      queueJob.activeProductIds = [];
      queueJob.completed = 1;
      await persistQueueJobPatch(queueJob, { stage: "parsing", activeProductIds: [], completed: 1, message: "正在整理价格与 SKU 结果。" });
    }
  }
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "verifying", message: "正在核对价格证据与监控规则。" });
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "saving", message: "正在保存价格快照与提醒状态。" });
  const alertPlans = [];
  const documentPlans = [];
  let runRecord = null;
  await updateDb((current) => {
    persistSessionHealth(current, activeSessions);
    const index = current.products.findIndex((item) => item.id === productId);
    const currentProduct = index >= 0 ? current.products[index] : null;
    const conflict = captureCommitConflict(currentProduct, result);
    if (conflict) rejectCaptureCommit(result, currentProduct, conflict);
    let savedProduct = result.product;
    if (!conflict) {
      const merged = mergeCapturedSnapshotState(currentProduct, result);
      savedProduct = merged.product;
      current.products[index] = savedProduct;
    }
    if (result.snapshot) {
      current.snapshots.push(result.snapshot);
      const alertPlan = prepareThresholdAlert(current, savedProduct, result.snapshot, source);
      if (alertPlan.pending.length) alertPlans.push(alertPlan);
      if (snapshotAllowsPriceAlerts(result.snapshot) && current.feishu.documentEnabled && current.feishu.documentId) {
        documentPlans.push({ product: savedProduct, snapshot: result.snapshot });
      }
    }
    recordPriceShadowRun(current, "price", [result]);
    enqueuePostCommitNotifications(current, { alertPlans, documentPlans, source });
    runRecord = buildRunRecord({ source, scope: productId, startedAt, results: [result] });
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });
  void drainNotificationOutbox().catch((error) => console.error("[notification-outbox]", error));

  return { run: runRecord, ...result };
}

export async function runProductOnce(productId, options = {}) {
  const captureKind = assertCaptureKind(options.captureKind || "price");
  if (captureKind === "buyer-show") return runBuyerShowOnce(productId, options);
  return enqueueCaptureOperation({
    operationType: "product",
    source: options.source || "single-product",
    scope: productId,
    productId,
    productIds: [productId],
    accountMode: options.accountMode || "primary",
    captureKind,
    recoverable: !options.scraper && !options.authSessions,
  }, (job) => captureKind === "materials" ? runMaterialUnlocked(productId, options, job) : runProductUnlocked(productId, options, job));
}

async function runBuyerShowUnlocked(productId, { source = "manual-buyer-show", scraper = scrapeTmallBuyerShows, authSessions: providedAuthSessions = null, persistRun = true } = {}, queueJob = null) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const product = data.products.find((item) => item.id === productId);
  if (!product) throw Object.assign(new Error("商品不存在。"), { status: 404 });
  if (product.captureMode === "local-only") throw Object.assign(new Error("该商品使用本地数据模式，已阻止买家秀网页抓取。"), { status: 409 });
  if (!product.lastSnapshot) throw Object.assign(new Error("商品还没有价格快照，请先完成首次价格抓取。"), { status: 409 });
  const activeSessions = Array.isArray(providedAuthSessions)
    ? providedAuthSessions
    : data.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const sessionCandidates = sessionsForProduct(activeSessions, accountType, 0, "all", product.primaryAccountSessionId);
  if (!sessionCandidates.length) throw Object.assign(new Error("没有可用的淘宝登录账号，请先到账号授权页面登录。"), { status: 409 });
  if (queueJob) {
    await persistQueueJobPatch(queueJob, {
      stage: "capturing",
      total: 1,
      completed: 0,
      products: [{ id: product.id, name: product.name || product.itemId || product.id }],
      activeProductIds: [product.id],
      message: "正在单独抓取买家秀图片、视频和文案。",
    });
  }

  const captures = [];
  const interactions = [];
  let result = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = sessionCandidates[attempt % sessionCandidates.length];
    try {
      result = await withAccountCaptureLock(session, () => scraper(product, session));
    } catch (error) {
      result = {
        capture: {
          status: "failed",
          source: "verified-dom",
          failureCode: error.message || "buyer-show-capture-failed",
          itemId: product.itemId || "",
          reportedTotal: 0,
          pageCount: 0,
          requestCount: 0,
          items: [],
          mediaCount: 0,
          textOnlyCount: 0,
          capturedAt: new Date().toISOString(),
        },
        items: [],
        interactions: [],
      };
    }
    captures.push(result.capture);
    interactions.push(...(result.interactions || []).map((interaction) => ({ ...interaction, retryAttempt: attempt + 1 })));
    if (result.capture.status !== "failed") break;
    if (attempt === 0) await delay(800);
  }
  result.capture.attempts = captures.flatMap((capture) => capture.attempts || []);
  result.interactions = interactions;
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "parsing", completed: 1, activeProductIds: [], message: "正在整理买家秀结果。" });

  let nextSnapshot = preserveBuyerShowHistory({
    ...structuredClone(product.lastSnapshot),
    buyerShowCapture: result.capture,
    buyerShows: result.items,
    ...(result.browserEvidenceFile ? {
      buyerShowEvidenceId: result.browserEvidenceId,
      buyerShowEvidenceFile: result.browserEvidenceFile,
      buyerShowLocalFirst: result.localFirst,
    } : {}),
    rawSignals: {
      ...(product.lastSnapshot.rawSignals || {}),
      buyerShowCount: result.items.length,
      buyerShowInteractions: result.interactions,
      buyerShowEvidenceSourceSaved: result.localFirst?.sourceSaved === true,
      buyerShowEvidenceParsedFromDisk: result.localFirst?.parsedFromDisk === true,
    },
  }, product.lastSnapshot);
  nextSnapshot.rawSignals.buyerShowCount = nextSnapshot.buyerShows?.length || 0;
  let updatedProduct = { ...product, lastSnapshot: nextSnapshot, updatedAt: new Date().toISOString() };
  let succeeded = result.capture.status !== "failed";
  let runRecord = null;
  if (queueJob) await persistQueueJobPatch(queueJob, { stage: "saving", message: "正在保存买家秀结果。" });
  await updateDb((current) => {
    const productIndex = current.products.findIndex((item) => item.id === product.id);
    const currentProduct = productIndex >= 0 ? current.products[productIndex] : null;
    const conflict = captureCommitConflict(currentProduct, { product, snapshot: nextSnapshot });
    if (conflict) {
      succeeded = false;
      updatedProduct = { ...(currentProduct || product), lastStatus: "error", lastError: conflict };
    } else {
      nextSnapshot = mergeCapturedBuyerShows(currentProduct.lastSnapshot, nextSnapshot);
      updatedProduct = { ...currentProduct, lastSnapshot: nextSnapshot, updatedAt: new Date().toISOString() };
      current.products[productIndex] = updatedProduct;
      for (let index = current.snapshots.length - 1; index >= 0; index -= 1) {
        if (current.snapshots[index].productId !== product.id) continue;
        current.snapshots[index] = { ...current.snapshots[index], ...nextSnapshot };
        break;
      }
    }
    const failureMessage = conflict || `买家秀抓取失败：${result.capture.failureCode || "未知原因"}`;
    runRecord = buildRunRecord({
      source,
      scope: productId,
      startedAt,
      results: [{ product: succeeded ? updatedProduct : { ...updatedProduct, lastError: failureMessage }, snapshot: succeeded ? nextSnapshot : null }],
      message: succeeded
        ? `买家秀抓取完成，现有 ${nextSnapshot.buyerShows?.length || 0} 条有效内容；价格和素材未改动。`
        : `${failureMessage}。价格和素材未改动。`,
    });
    if (persistRun) {
      current.runs.push(runRecord);
      current.runs = current.runs.slice(-200);
    }
    return current;
  });
  return { ok: succeeded, product: updatedProduct, snapshot: succeeded ? nextSnapshot : null, capture: nextSnapshot.buyerShowCapture, run: runRecord };
}

export async function runBuyerShowOnce(productId, options = {}) {
  return enqueueCaptureOperation({
    operationType: "buyer-show",
    source: options.source || "manual-buyer-show",
    scope: productId,
    productId,
    productIds: [productId],
    captureKind: "buyer-show",
    recoverable: !options.scraper && !options.authSessions,
  }, (job) => runBuyerShowUnlocked(productId, options, job));
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
        const inFlightIds = new Set(duplicateCaptureProductIds(await getCaptureJobs(), dueIds, "price", "monitor"));
        dueIds = dueIds.filter((productId) => !inFlightIds.has(productId));
      }
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
