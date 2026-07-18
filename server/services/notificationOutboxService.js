import { newId, readDb, updateDb } from "../storage/db.js";
import { createNotificationLog, sendFeishuNotification } from "./feishuService.js";
import { appendPriceDocument } from "./larkCliService.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DELIVERY_LEASE_MS = 2 * 60_000;
const WORKER_INTERVAL_MS = 30_000;

let drainPromise = null;
let workerTimer = null;
const deliveredAwaitingAck = new Map();

function isoTime(value = Date.now()) {
  return new Date(value).toISOString();
}

function compactProduct(product, snapshot) {
  return {
    id: product.id,
    name: product.name || "",
    shopName: product.shopName || snapshot?.shopName || "",
    model: product.model || snapshot?.model || "",
    url: product.url || "",
    accountType: product.accountType || snapshot?.primaryAccountType || "normal",
    skuMonitorPrices: structuredClone(product.skuMonitorPrices || {}),
    skuMonitorRules: structuredClone(product.skuMonitorRules || {}),
    lastSnapshot: snapshot ? {
      capturedAt: snapshot.capturedAt || isoTime(),
      accessMode: snapshot.accessMode,
      shopName: snapshot.shopName,
      model: snapshot.model,
      primaryAccountType: snapshot.primaryAccountType,
      primaryAccountSessionId: snapshot.primaryAccountSessionId,
      accountCaptures: structuredClone(snapshot.accountCaptures || []),
      skuPrices: structuredClone(snapshot.skuPrices || []),
    } : undefined,
  };
}

function alertDedupeKey(plan) {
  const rules = plan.pending
    .map((item) => [item.skuId, item.channel, item.event, item.priceCents, item.thresholdCents].join(":"))
    .sort()
    .join("|");
  return `threshold:${plan.product.id}:${plan.accountType}:${plan.snapshotCapturedAt || "unknown"}:${rules}`;
}

function documentDedupeKey(product, snapshot) {
  return `document:${product.id}:${snapshot?.capturedAt || "unknown"}`;
}

function createOutboxJob(kind, dedupeKey, payload, source, now) {
  const createdAt = isoTime(now);
  return {
    id: newId("notify"),
    kind,
    dedupeKey,
    payload,
    source,
    status: "pending",
    attempts: 0,
    nextAttemptAt: createdAt,
    leaseUntil: null,
    lastError: "",
    createdAt,
    updatedAt: createdAt,
  };
}

function thresholdPayload(plan) {
  const snapshot = {
    ...(plan.product.lastSnapshot || {}),
    capturedAt: plan.snapshotCapturedAt || plan.product.lastSnapshot?.capturedAt || isoTime(),
  };
  return {
    accountType: plan.accountType,
    product: compactProduct(plan.product, snapshot),
    items: plan.pending.map((item) => ({
      skuId: String(item.skuId),
      skuName: item.sku?.name || String(item.skuId),
      channel: item.channel,
      resolvedChannel: item.resolvedChannel,
      event: item.event,
      priceCents: item.priceCents,
      thresholdCents: item.thresholdCents,
      priceLabel: item.priceLabel,
    })),
  };
}

function documentPayload(product, snapshot) {
  const compact = compactProduct(product, snapshot);
  return {
    product: compact,
    snapshot: compact.lastSnapshot,
  };
}

export function enqueuePostCommitNotifications(current, { alertPlans = [], documentPlans = [], source = "monitor", now = Date.now() } = {}) {
  current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
  const existing = new Set(current.notificationOutbox.map((job) => job.dedupeKey).filter(Boolean));
  const created = [];

  for (const plan of alertPlans) {
    if (!plan?.pending?.length) continue;
    const dedupeKey = alertDedupeKey(plan);
    if (existing.has(dedupeKey)) continue;
    const job = createOutboxJob("threshold-alert", dedupeKey, thresholdPayload(plan), plan.source || source, now);
    current.notificationOutbox.push(job);
    existing.add(dedupeKey);
    created.push(job);
  }

  for (const item of documentPlans) {
    if (!item?.product || !item?.snapshot) continue;
    const dedupeKey = documentDedupeKey(item.product, item.snapshot);
    if (existing.has(dedupeKey)) continue;
    const job = createOutboxJob("document-sync", dedupeKey, documentPayload(item.product, item.snapshot), source, now);
    current.notificationOutbox.push(job);
    existing.add(dedupeKey);
    created.push(job);
  }

  return created;
}

export function nextNotificationRetryAt(attempts, now = Date.now()) {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(Number(attempts) - 1, 0), RETRY_DELAYS_MS.length - 1)];
  return isoTime(now + delay);
}

function isDue(job, now) {
  const timestamp = Date.parse(job.status === "processing" ? job.leaseUntil : job.nextAttemptAt);
  if (!Number.isFinite(timestamp)) return job.status === "pending";
  if (job.status === "processing") return timestamp <= now;
  return job.status === "pending" && timestamp <= now;
}

async function claimNextJob(now) {
  const snapshot = await readDb();
  const candidateId = (snapshot.notificationOutbox || [])
    .filter((item) => isDue(item, now))
    .sort((left, right) => Date.parse(left.nextAttemptAt || left.createdAt || 0) - Date.parse(right.nextAttemptAt || right.createdAt || 0))[0]?.id;
  if (!candidateId) return null;
  let claimed = null;
  await updateDb((current) => {
    current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
    const job = current.notificationOutbox.find((item) => item.id === candidateId && isDue(item, now));
    if (!job) return current;
    job.status = "processing";
    job.leaseUntil = isoTime(now + DELIVERY_LEASE_MS);
    job.updatedAt = isoTime(now);
    claimed = structuredClone(job);
    return current;
  });
  return claimed;
}

function thresholdDetails(job) {
  const items = job.payload.items || [];
  return {
    type: "below-threshold",
    product: job.payload.product,
    price: Math.min(...items.map((item) => Number(item.priceCents) / 100)),
    priceLabel: [...new Set(items.map((item) => item.priceLabel))].join("、") || "当前价格",
    threshold: null,
    skuName: items.map((item) => item.skuName || item.skuId).join("、"),
    triggeredSkuIds: [...new Set(items.map((item) => item.skuId))],
    triggeredRules: items.map((item) => ({
      skuId: item.skuId,
      channel: item.channel,
      resolvedChannel: item.resolvedChannel,
      event: item.event,
      priceCents: item.priceCents,
      thresholdCents: item.thresholdCents,
      priceLabel: item.priceLabel,
    })),
  };
}

function thresholdLogs(job, status, message) {
  return (job.payload.items || []).map((item) => createNotificationLog({
    productId: job.payload.product.id,
    skuId: item.skuId,
    type: "below-threshold",
    status,
    message: status === "sent"
      ? `SKU「${item.skuName || item.skuId}」${item.event === "new-low" ? "出现新低" : "首次跌破监控价"}：${item.priceLabel} ¥${(Number(item.priceCents) / 100).toFixed(2)}，飞书预警已发送。`
      : message,
    price: Number(item.priceCents) / 100,
    threshold: Number(item.thresholdCents) / 100,
    source: job.source,
  }));
}

async function deliverJob(job, feishu, dependencies) {
  if (job.kind === "threshold-alert") {
    if (!feishu.enabled) return { outcome: "deferred", reason: "飞书机器人提醒已关闭。", logs: [] };
    await dependencies.sendFeishuNotification(feishu, thresholdDetails(job));
    return { outcome: "sent", logs: thresholdLogs(job, "sent", "") };
  }
  if (job.kind === "document-sync") {
    if (!feishu.documentEnabled || !feishu.documentId) return { outcome: "deferred", reason: "飞书文档自动写入已关闭。", logs: [] };
    await dependencies.appendPriceDocument(feishu.documentId, job.payload.product, job.payload.snapshot);
    return {
      outcome: "sent",
      documentSynced: true,
      logs: [createNotificationLog({
        productId: job.payload.product.id,
        type: "document-sync",
        status: "sent",
        message: "价格快照已写入飞书文档。",
        source: job.source,
      })],
    };
  }
  return { outcome: "cancelled", logs: [] };
}

async function finishJob(job, result, now) {
  let settled = false;
  await updateDb((current) => {
    current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
    const index = current.notificationOutbox.findIndex((item) => item.id === job.id);
    if (index < 0) {
      settled = true;
      return current;
    }
    const stored = current.notificationOutbox[index];
    if (stored.status !== "processing" || stored.leaseUntil !== job.leaseUntil) return current;

    if (result.outcome === "sent" || result.outcome === "cancelled") {
      current.notificationOutbox.splice(index, 1);
      if (result.logs?.length) current.notificationLogs.push(...result.logs);
      current.notificationLogs = current.notificationLogs.slice(-500);
      if (result.documentSynced) current.feishu.lastDocumentSyncAt = isoTime(now);
      settled = true;
      return current;
    }

    if (result.outcome === "deferred") {
      stored.status = "pending";
      stored.nextAttemptAt = isoTime(now + RETRY_DELAYS_MS.at(-1));
      stored.leaseUntil = null;
      stored.lastError = result.reason || "通知通道暂未启用。";
      stored.updatedAt = isoTime(now);
      settled = true;
      return current;
    }

    stored.status = "pending";
    stored.attempts = Number(stored.attempts || 0) + 1;
    stored.nextAttemptAt = nextNotificationRetryAt(stored.attempts, now);
    stored.leaseUntil = null;
    stored.lastError = result.error;
    stored.updatedAt = isoTime(now);
    if (stored.attempts === 1) {
      const logs = stored.kind === "threshold-alert"
        ? thresholdLogs(stored, "failed", `飞书发送失败，已进入自动重试：${result.error}`)
        : [createNotificationLog({
          productId: stored.payload.product.id,
          type: "document-sync",
          status: "failed",
          message: `飞书文档写入失败，已进入自动重试：${result.error}`,
          source: stored.source,
        })];
      current.notificationLogs.push(...logs);
      current.notificationLogs = current.notificationLogs.slice(-500);
    }
    settled = true;
    return current;
  });
  return settled;
}

async function flushDeliveredAcks() {
  for (const [jobId, delivery] of deliveredAwaitingAck) {
    const settled = await finishJob(delivery.job, delivery.result, Date.now());
    if (settled) deliveredAwaitingAck.delete(jobId);
  }
}

async function drainUnlocked({ now = Date.now, send = sendFeishuNotification, append = appendPriceDocument } = {}) {
  const currentTime = typeof now === "function" ? now : () => now;
  await flushDeliveredAcks();
  let processed = 0;
  while (true) {
    const job = await claimNextJob(currentTime());
    if (!job) break;
    const db = await readDb();
    let result;
    try {
      result = await deliverJob(job, db.feishu, { sendFeishuNotification: send, appendPriceDocument: append });
    } catch (error) {
      await finishJob(job, { outcome: "failed", error: error?.message || String(error) }, Date.now());
      processed += 1;
      continue;
    }
    try {
      await finishJob(job, result, Date.now());
    } catch (error) {
      if (result.outcome === "sent") deliveredAwaitingAck.set(job.id, { job, result });
      throw error;
    }
    processed += 1;
  }
  return processed;
}

export function drainNotificationOutbox(options = {}) {
  if (drainPromise) return drainPromise;
  drainPromise = drainUnlocked(options).finally(() => { drainPromise = null; });
  return drainPromise;
}

export function startNotificationOutboxWorker() {
  if (workerTimer) return;
  void drainNotificationOutbox().catch((error) => console.error("[notification-outbox]", error));
  workerTimer = setInterval(() => {
    void drainNotificationOutbox().catch((error) => console.error("[notification-outbox]", error));
  }, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}

export async function resumeNotificationOutbox({
  thresholdAlerts = false,
  documentSync = false,
  now = Date.now(),
  send,
  append,
} = {}) {
  if (!thresholdAlerts && !documentSync) return 0;
  let resumed = 0;
  await updateDb((current) => {
    current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
    for (const job of current.notificationOutbox) {
      const enabledKind = (thresholdAlerts && job.kind === "threshold-alert")
        || (documentSync && job.kind === "document-sync");
      if (!enabledKind || job.status !== "pending") continue;
      job.nextAttemptAt = isoTime(now);
      job.lastError = "";
      job.updatedAt = isoTime(now);
      resumed += 1;
    }
    return current;
  });
  if (resumed) await drainNotificationOutbox({
    ...((send || append) ? { now } : { now: Date.now }),
    ...(send ? { send } : {}),
    ...(append ? { append } : {}),
  });
  return resumed;
}

export async function stopNotificationOutboxWorker({ timeoutMs = 5_000 } = {}) {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  if (!drainPromise) return true;
  let timeout;
  try {
    return await Promise.race([
      drainPromise.then(() => true, () => true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
