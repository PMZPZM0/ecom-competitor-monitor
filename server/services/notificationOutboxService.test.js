import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "notification-outbox-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  drainNotificationOutbox,
  enqueuePostCommitNotifications,
  nextNotificationRetryAt,
  resumeNotificationOutbox,
} = await import("./notificationOutboxService.js");
const { updateFeishuConfig } = await import("./feishuService.js");
const { readDb, updateDb } = await import("../storage/db.js");

after(async () => {
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await updateDb((current) => {
    current.notificationOutbox = [];
    current.notificationLogs = [];
    current.alertStates = {};
    current.feishu = updateFeishuConfig(current.feishu, {
      enabled: true,
      webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
    });
    current.feishu.documentEnabled = true;
    current.feishu.documentId = "document-test";
    return current;
  });
});

function snapshot(price = 90) {
  return {
    capturedAt: "2026-07-18T08:00:00.000Z",
    accessMode: "authenticated",
    resolutionStatus: "verified",
    primaryAccountType: "normal",
    skuPrices: [{ skuId: "sku-1", name: "标准款", price, normalPrice: price, resolutionStatus: "verified" }],
  };
}

function product() {
  const lastSnapshot = snapshot();
  return {
    id: "product-1",
    name: "测试商品",
    shopName: "测试店铺",
    model: "A1",
    url: "https://detail.tmall.com/item.htm?id=1",
    accountType: "normal",
    skuMonitorRules: { "sku-1": { normal: 100 } },
    lastSnapshot,
    largeUnrelatedEvidence: "must-not-enter-outbox",
  };
}

function alertPlan() {
  const target = product();
  return {
    product: target,
    source: "scheduled",
    accountType: "normal",
    snapshotCapturedAt: target.lastSnapshot.capturedAt,
    pending: [{
      skuId: "sku-1",
      sku: target.lastSnapshot.skuPrices[0],
      channel: "normal",
      resolvedChannel: "normal",
      event: "crossing-below",
      priceCents: 9000,
      thresholdCents: 10000,
      priceLabel: "普通价",
    }],
  };
}

test("post-commit notifications are durable, compact, and deduplicated", async () => {
  await updateDb((current) => {
    const plan = alertPlan();
    enqueuePostCommitNotifications(current, {
      alertPlans: [plan, plan],
      documentPlans: [{ product: plan.product, snapshot: plan.product.lastSnapshot }],
      source: "scheduled",
      now: Date.parse("2026-07-18T08:00:01.000Z"),
    });
    enqueuePostCommitNotifications(current, { alertPlans: [plan], source: "scheduled" });
    return current;
  });

  const db = await readDb();
  assert.equal(db.notificationOutbox.length, 2);
  assert.deepEqual(db.notificationOutbox.map((job) => job.kind).sort(), ["document-sync", "threshold-alert"]);
  assert.equal(JSON.stringify(db.notificationOutbox).includes("must-not-enter-outbox"), false);
});

test("a failed webhook stays queued without rolling back the committed alert episode", async () => {
  await updateDb((current) => {
    current.alertStates = { "product-1": { normal: { "sku-1": { normal: { relation: "below" } } } } };
    enqueuePostCommitNotifications(current, { alertPlans: [alertPlan()], now: Date.now() });
    return current;
  });

  let attempts = 0;
  await drainNotificationOutbox({
    now: Date.now() + 1,
    send: async () => {
      attempts += 1;
      throw new Error("temporary outage");
    },
  });

  const failed = await readDb();
  assert.equal(attempts, 1);
  assert.equal(failed.notificationOutbox.length, 1);
  assert.equal(failed.notificationOutbox[0].status, "pending");
  assert.equal(failed.notificationOutbox[0].attempts, 1);
  assert.equal(failed.notificationOutbox[0].lastError, "temporary outage");
  assert.equal(failed.alertStates["product-1"].normal["sku-1"].normal.relation, "below");
  assert.equal(failed.notificationLogs[0].status, "failed");

  await drainNotificationOutbox({
    now: Date.parse(failed.notificationOutbox[0].nextAttemptAt),
    send: async () => { attempts += 1; },
  });
  const recovered = await readDb();
  assert.equal(attempts, 2);
  assert.equal(recovered.notificationOutbox.length, 0);
  assert.equal(recovered.notificationLogs.at(-1).status, "sent");
});

test("document and webhook jobs are delivered independently", async () => {
  await updateDb((current) => {
    const plan = alertPlan();
    enqueuePostCommitNotifications(current, {
      alertPlans: [plan],
      documentPlans: [{ product: plan.product, snapshot: plan.product.lastSnapshot }],
      now: Date.now(),
    });
    return current;
  });

  const delivered = [];
  await drainNotificationOutbox({
    now: Date.now() + 1,
    send: async (_config, details) => delivered.push(["webhook", details.triggeredRules[0].priceCents]),
    append: async (documentId, _product, captured) => delivered.push(["document", documentId, captured.capturedAt]),
  });

  const db = await readDb();
  assert.deepEqual(delivered, [
    ["webhook", 9000],
    ["document", "document-test", "2026-07-18T08:00:00.000Z"],
  ]);
  assert.equal(db.notificationOutbox.length, 0);
  assert.deepEqual(db.notificationLogs.map((log) => log.status), ["sent", "sent"]);
});

test("an expired processing lease is recovered after a restart", async () => {
  await updateDb((current) => {
    enqueuePostCommitNotifications(current, { alertPlans: [alertPlan()], now: Date.now() - 10_000 });
    current.notificationOutbox[0].status = "processing";
    current.notificationOutbox[0].leaseUntil = new Date(Date.now() - 1_000).toISOString();
    return current;
  });

  let delivered = 0;
  await drainNotificationOutbox({ now: Date.now(), send: async () => { delivered += 1; } });
  assert.equal(delivered, 1);
  assert.equal((await readDb()).notificationOutbox.length, 0);
});

test("disabled notification channels defer jobs instead of losing the alert", async () => {
  await updateDb((current) => {
    enqueuePostCommitNotifications(current, { alertPlans: [alertPlan()], now: Date.now() });
    current.feishu.enabled = false;
    return current;
  });

  let delivered = 0;
  await drainNotificationOutbox({ now: Date.now() + 1, send: async () => { delivered += 1; } });
  const deferred = await readDb();
  assert.equal(delivered, 0);
  assert.equal(deferred.notificationOutbox.length, 1);
  assert.equal(deferred.notificationOutbox[0].status, "pending");
  assert.equal(deferred.notificationOutbox[0].attempts, 0);

  await updateDb((current) => {
    current.feishu.enabled = true;
    return current;
  });
  await resumeNotificationOutbox({
    thresholdAlerts: true,
    now: Date.now() + 2,
    send: async () => { delivered += 1; },
  });
  assert.equal(delivered, 1);
  assert.equal((await readDb()).notificationOutbox.length, 0);
});

test("a delivered webhook is acknowledged without resending after a transient database failure", async (t) => {
  await updateDb((current) => {
    enqueuePostCommitNotifications(current, { alertPlans: [alertPlan()], now: Date.now() });
    return current;
  });

  const originalRename = fs.rename.bind(fs);
  let renameCalls = 0;
  let sends = 0;
  t.mock.method(fs, "rename", async (source, destination) => {
    renameCalls += 1;
    if (renameCalls >= 2 && renameCalls <= 7) throw Object.assign(new Error("database busy"), { code: "EBUSY" });
    return originalRename(source, destination);
  });

  await assert.rejects(drainNotificationOutbox({
    now: Date.now() + 1,
    send: async () => { sends += 1; },
  }), /database busy/);
  assert.equal(sends, 1);

  t.mock.restoreAll();
  await drainNotificationOutbox({ now: Date.now() + 2 });
  assert.equal(sends, 1);
  assert.equal((await readDb()).notificationOutbox.length, 0);
});

test("retry delays use the agreed 1, 5, and 15 minute backoff", () => {
  const now = Date.parse("2026-07-18T00:00:00.000Z");
  assert.equal(Date.parse(nextNotificationRetryAt(1, now)) - now, 60_000);
  assert.equal(Date.parse(nextNotificationRetryAt(2, now)) - now, 5 * 60_000);
  assert.equal(Date.parse(nextNotificationRetryAt(3, now)) - now, 15 * 60_000);
  assert.equal(Date.parse(nextNotificationRetryAt(8, now)) - now, 15 * 60_000);
});
