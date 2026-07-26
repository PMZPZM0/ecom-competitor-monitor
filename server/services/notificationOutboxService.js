import { newId, readDb, updateDb } from "../storage/db.js";
import { createNotificationLog, sendFeishuNotification } from "./feishuService.js";
import { appendPriceDocument } from "./larkCliService.js";
import { deleteQwenPawLoginQr, normalizeQwenPawAlerts, qwenPawLoginExpiredMessage, qwenPawThresholdMessage, readQwenPawLoginQr, retractQwenPawFeishuQr, sendQwenPawFeishuQr, sendQwenPawFeishuText, targetKey } from "./qwenPawFeishuService.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DELIVERY_LEASE_MS = 2 * 60_000;
const WORKER_INTERVAL_MS = 30_000;
const QWENPAW_OUTBOX_TTL_MS = 24 * 60 * 60 * 1_000;
const QWENPAW_QR_TTL_MS = 5 * 60 * 1_000;

let drainPromise = null;
let workerTimer = null;
const deliveredAwaitingAck = new Map();
let qwenPawLoginQrProvider = null;

export function configureQwenPawLoginQrProvider(provider) {
  qwenPawLoginQrProvider = typeof provider === "function" ? provider : null;
}

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

function qwenPawAlertConfig(current) {
  return normalizeQwenPawAlerts(current.operations?.qwenPawAlerts);
}

function qwenPawDeliveryJob(kind, dedupeKey, payload, source, now) {
  return {
    ...createOutboxJob(kind, dedupeKey, payload, source, now),
    expiresAt: isoTime(now + QWENPAW_OUTBOX_TTL_MS),
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
    if (current.feishu?.enabled && !existing.has(dedupeKey)) {
      const job = createOutboxJob("threshold-alert", dedupeKey, thresholdPayload(plan), plan.source || source, now);
      current.notificationOutbox.push(job);
      existing.add(dedupeKey);
      created.push(job);
    }

    const alertConfig = qwenPawAlertConfig(current);
    for (const target of alertConfig.belowThresholdTargets) {
      const qwenKey = `qwenpaw:${dedupeKey}:${targetKey(target)}`;
      if (existing.has(qwenKey)) continue;
      const qwenJob = qwenPawDeliveryJob("qwenpaw-threshold-alert", qwenKey, {
        ...thresholdPayload(plan),
        target,
      }, plan.source || source, now);
      current.notificationOutbox.push(qwenJob);
      existing.add(qwenKey);
      created.push(qwenJob);
    }
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

export function enqueueQwenPawLoginExpiryNotifications(current, { source = "auth-check", now = Date.now() } = {}) {
  current.qwenPawAlertStates = current.qwenPawAlertStates && typeof current.qwenPawAlertStates === "object"
    ? current.qwenPawAlertStates
    : {};
  current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
  const existing = new Set(current.notificationOutbox.map((job) => job.dedupeKey).filter(Boolean));
  const targets = qwenPawAlertConfig(current).loginExpiredTargets;
  const created = [];
  const activeIds = new Set();
  for (const session of current.authSessions || []) {
    if (!session?.id) continue;
    activeIds.add(session.id);
    const prior = current.qwenPawAlertStates[session.id]?.loginStatus;
    const status = session.loginStatus === "expired" ? "expired" : "valid";
    current.qwenPawAlertStates[session.id] = { loginStatus: status, updatedAt: isoTime(now) };
    if (prior !== "valid" || status !== "expired") continue;
    for (const target of targets) {
      const dedupeKey = `qwenpaw:login-expired:${session.id}:${Date.parse(session.lastFailureAt || "") || now}:${targetKey(target)}`;
      if (existing.has(dedupeKey)) continue;
      const job = qwenPawDeliveryJob("qwenpaw-login-expired", dedupeKey, {
        session: {
          id: session.id,
          name: session.name || "",
          accountType: session.accountType || "normal",
          browserEngine: session.browserEngine || "",
          browserProfileKey: session.browserProfileKey || "",
        },
        target,
      }, source, now);
      current.notificationOutbox.push(job);
      existing.add(dedupeKey);
      created.push(job);
    }
  }
  for (const sessionId of Object.keys(current.qwenPawAlertStates)) {
    if (!activeIds.has(sessionId)) delete current.qwenPawAlertStates[sessionId];
  }
  return created;
}

export function enqueueQwenPawLoginQrNotifications(current, { sessionId, qrFileId, source = "auth-check", now = Date.now() } = {}) {
  if (!sessionId || !qrFileId) return [];
  current.notificationOutbox = Array.isArray(current.notificationOutbox) ? current.notificationOutbox : [];
  const existing = new Set(current.notificationOutbox.map((job) => job.dedupeKey).filter(Boolean));
  const expiresAt = isoTime(now + QWENPAW_QR_TTL_MS);
  const created = [];
  for (const target of qwenPawAlertConfig(current).loginExpiredTargets) {
    const dedupeKey = `qwenpaw:login-qr:${sessionId}:${qrFileId}:${targetKey(target)}`;
    if (existing.has(dedupeKey)) continue;
    const job = {
      ...qwenPawDeliveryJob("qwenpaw-login-qr", dedupeKey, { sessionId, qrFileId, target }, source, now),
      expiresAt,
    };
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

function qwenPawLogs(job, status, message) {
  if (job.kind === "qwenpaw-login-qr") {
    return [createNotificationLog({
      productId: "",
      type: "account-login-qr",
      status,
      message: status === "sent"
        ? "QwenPaw 已向飞书目标发送限时淘宝登录二维码。"
        : message,
      price: null,
      threshold: null,
      source: job.source,
    })];
  }
  if (job.kind === "qwenpaw-login-qr-retract") {
    return [createNotificationLog({
      productId: "",
      type: "account-login-qr-retract",
      status,
      message: status === "sent" ? "已撤回过期的淘宝登录二维码。" : message,
      price: null,
      threshold: null,
      source: job.source,
    })];
  }
  if (job.kind === "qwenpaw-login-expired") {
    return [createNotificationLog({
      productId: "",
      type: "account-login-expired",
      status,
      message: status === "sent"
        ? `QwenPaw 已向飞书目标发送账号「${job.payload.session?.name || "淘宝账号"}」掉线提醒。`
        : message,
      price: null,
      threshold: null,
      source: job.source,
    })];
  }
  return (job.payload.items || []).map((item) => createNotificationLog({
    productId: job.payload.product.id,
    skuId: item.skuId,
    type: "qwenpaw-below-threshold",
    status,
    message: status === "sent"
      ? `SKU「${item.skuName || item.skuId}」${item.event === "new-low" ? "出现新低" : "首次跌破监控价"}：QwenPaw 飞书提醒已发送。`
      : message,
    price: Number(item.priceCents) / 100,
    threshold: Number(item.thresholdCents) / 100,
    source: job.source,
  }));
}

async function deliverJob(job, db, dependencies, now = Date.now()) {
  if (job.expiresAt && Date.parse(job.expiresAt) <= now) {
    if (job.kind === "qwenpaw-login-qr") await dependencies.deleteQwenPawLoginQr(job.payload.qrFileId).catch(() => undefined);
    const message = job.kind === "qwenpaw-login-qr"
      ? "淘宝登录二维码已过期，未再发送。"
      : "QwenPaw 飞书通知超过 24 小时未送达，已停止补发。";
    return { outcome: "cancelled", logs: qwenPawLogs(job, "failed", message) };
  }
  const feishu = db.feishu || {};
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
  if (job.kind === "qwenpaw-threshold-alert") {
    await dependencies.sendQwenPawFeishuText(db.operations?.qwenPawInstallDirectory, job.payload.target, qwenPawThresholdMessage(job.payload));
    return { outcome: "sent", logs: qwenPawLogs(job, "sent", "") };
  }
  if (job.kind === "qwenpaw-login-expired") {
    await dependencies.sendQwenPawFeishuText(db.operations?.qwenPawInstallDirectory, job.payload.target, qwenPawLoginExpiredMessage(job.payload));
    const qwenQrFileId = qwenPawLoginQrProvider
      ? await qwenPawLoginQrProvider(job.payload.session)
      : "";
    return { outcome: "sent", qwenQrFileId, logs: qwenPawLogs(job, "sent", "") };
  }
  if (job.kind === "qwenpaw-login-qr") {
    const image = await dependencies.readQwenPawLoginQr(job.payload.qrFileId);
    const delivery = await dependencies.sendQwenPawFeishuQr(db.operations?.qwenPawInstallDirectory, job.payload.target, image);
    const messageId = String(delivery?.message_id || "").trim();
    if (!messageId) throw new Error("QwenPaw 未返回飞书二维码消息标识。");
    return { outcome: "sent", qwenQrMessageId: messageId, logs: qwenPawLogs(job, "sent", "") };
  }
  if (job.kind === "qwenpaw-login-qr-retract") {
    await dependencies.retractQwenPawFeishuQr(db.operations?.qwenPawInstallDirectory, job.payload.messageId);
    await dependencies.deleteQwenPawLoginQr(job.payload.qrFileId).catch(() => undefined);
    return { outcome: "sent", logs: qwenPawLogs(job, "sent", "") };
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
      if (result.outcome === "sent" && stored.kind === "qwenpaw-login-qr" && result.qwenQrMessageId) {
        const retractionKey = `qwenpaw:login-qr-retract:${stored.id}:${result.qwenQrMessageId}`;
        if (!current.notificationOutbox.some((item) => item.dedupeKey === retractionKey)) {
          const dueAt = stored.expiresAt || isoTime(now + QWENPAW_QR_TTL_MS);
          current.notificationOutbox.push({
            ...qwenPawDeliveryJob("qwenpaw-login-qr-retract", retractionKey, {
              messageId: result.qwenQrMessageId,
              qrFileId: stored.payload.qrFileId,
              sessionId: stored.payload.sessionId,
            }, stored.source, now),
            nextAttemptAt: dueAt,
            expiresAt: isoTime(Date.parse(dueAt) + QWENPAW_OUTBOX_TTL_MS),
          });
        }
      }
      if (result.outcome === "sent" && stored.kind === "qwenpaw-login-expired" && result.qwenQrFileId) {
        const qrKey = `qwenpaw:login-qr:${stored.payload.session?.id}:${result.qwenQrFileId}:${targetKey(stored.payload.target)}`;
        if (!current.notificationOutbox.some((item) => item.dedupeKey === qrKey)) {
          current.notificationOutbox.push({
            ...qwenPawDeliveryJob("qwenpaw-login-qr", qrKey, {
              sessionId: stored.payload.session?.id,
              qrFileId: result.qwenQrFileId,
              target: stored.payload.target,
            }, stored.source, now),
            expiresAt: isoTime(now + QWENPAW_QR_TTL_MS),
          });
        }
      }
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
        : stored.kind.startsWith("qwenpaw-")
          ? qwenPawLogs(stored, "failed", `QwenPaw 飞书发送失败，已进入自动重试：${result.error}`)
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

async function drainUnlocked({ now = Date.now, send = sendFeishuNotification, append = appendPriceDocument, sendQwen = sendQwenPawFeishuText, sendQwenQr = sendQwenPawFeishuQr, retractQwenQr = retractQwenPawFeishuQr, readQwenQr = readQwenPawLoginQr, deleteQwenQr = deleteQwenPawLoginQr } = {}) {
  const currentTime = typeof now === "function" ? now : () => now;
  await flushDeliveredAcks();
  let processed = 0;
  while (true) {
    const job = await claimNextJob(currentTime());
    if (!job) break;
    const db = await readDb();
    let result;
    try {
      result = await deliverJob(job, db, {
        sendFeishuNotification: send,
        appendPriceDocument: append,
        sendQwenPawFeishuText: sendQwen,
        sendQwenPawFeishuQr: sendQwenQr,
        retractQwenPawFeishuQr: retractQwenQr,
        readQwenPawLoginQr: readQwenQr,
        deleteQwenPawLoginQr: deleteQwenQr,
      }, currentTime());
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
  sendQwen,
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
    ...((send || append || sendQwen) ? { now } : { now: Date.now }),
    ...(send ? { send } : {}),
    ...(append ? { append } : {}),
    ...(sendQwen ? { sendQwen } : {}),
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
