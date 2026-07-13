import assert from "node:assert/strict";
import test from "node:test";
import {
  dueProductIds,
  earliestProductSchedule,
  historicalAccountPriceSnapshot,
  historicalPrimaryImages,
  historicalProductMedia,
  isFeishuAlertCoolingDown,
  mergeBuyerShowHistory,
  nextProductScheduleAt,
  orderedCaptureCandidates,
  preserveVerifiedAccountPrices,
  resolveCaptureProtectionMinutes,
  resolveProductIntervalMinutes,
  riskCooldownMs,
  runInCaptureGroups,
  scheduleProduct,
  snapshotAllowsPriceAlerts,
} from "./monitorService.js";

test("per-product schedules inherit the global interval and allow an override", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const monitor = { running: true, intervalMinutes: 60 };
  assert.equal(resolveProductIntervalMinutes({}, 60), 60);
  assert.equal(resolveProductIntervalMinutes({ monitorIntervalMinutes: 120 }, 60), 120);
  assert.equal(scheduleProduct({ id: "a", enabled: true }, monitor, { now }).nextMonitorAt, "2026-07-12T09:00:00.000Z");
  assert.equal(scheduleProduct({ id: "b", enabled: true, monitorIntervalMinutes: 120 }, monitor, { now }).nextMonitorAt, "2026-07-12T10:00:00.000Z");
  assert.equal(scheduleProduct({ id: "c", enabled: false }, monitor, { now }).nextMonitorAt, null);
  assert.equal(scheduleProduct({ id: "d", enabled: true }, { ...monitor, running: false }, { now }).enabled, true);
});

test("per-product schedule uses a date/time anchor and advances past missed intervals", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const future = { enabled: true, monitorIntervalMinutes: 120, monitorStartAt: "2026-07-12T08:30:00.000Z" };
  const past = { enabled: true, monitorIntervalMinutes: 120, monitorStartAt: "2026-07-12T05:00:00.000Z" };
  assert.equal(nextProductScheduleAt(future, 60, now), "2026-07-12T08:30:00.000Z");
  assert.equal(nextProductScheduleAt(past, 60, now), "2026-07-12T09:00:00.000Z");
  assert.equal(nextProductScheduleAt({ enabled: true }, 60, now), "2026-07-12T09:00:00.000Z");
});

test("global pause preserves the product anchor and resume recalculates from it", () => {
  const anchor = "2026-07-12T05:00:00.000Z";
  const product = { id: "anchored", enabled: true, monitorIntervalMinutes: 120, monitorStartAt: anchor };
  const paused = scheduleProduct(product, { running: false, intervalMinutes: 60 }, { reset: true, now: Date.parse("2026-07-12T08:00:00.000Z") });
  assert.equal(paused.monitorStartAt, anchor);
  assert.equal(paused.nextMonitorAt, null);
  const resumed = scheduleProduct(paused, { running: true, intervalMinutes: 60 }, { reset: true, now: Date.parse("2026-07-12T10:00:00.000Z") });
  assert.equal(resumed.monitorStartAt, anchor);
  assert.equal(resumed.nextMonitorAt, "2026-07-12T11:00:00.000Z");
});

test("due product selection is ordered and excludes paused or future products", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const products = [
    { id: "future", enabled: true, nextMonitorAt: "2026-07-12T08:30:00.000Z" },
    { id: "second", enabled: true, nextMonitorAt: "2026-07-12T07:59:00.000Z" },
    { id: "first", enabled: true, nextMonitorAt: "2026-07-12T07:58:00.000Z" },
    { id: "paused", enabled: false, nextMonitorAt: "2026-07-12T07:00:00.000Z" },
  ];
  assert.deepEqual(dueProductIds(products, now), ["first", "second"]);
  assert.equal(earliestProductSchedule(products, { running: true, intervalMinutes: 60 }, now), "2026-07-12T07:58:00.000Z");
  assert.equal(earliestProductSchedule(products, { running: false, intervalMinutes: 60 }, now), null);
});

test("riskCooldownMs uses the configured local capture protection duration", () => {
  assert.equal(riskCooldownMs(0), 0);
  assert.equal(riskCooldownMs(1), 1 * 60_000);
  assert.equal(riskCooldownMs(5), 5 * 60_000);
  assert.equal(riskCooldownMs(30), 30 * 60_000);
  assert.equal(riskCooldownMs(999), 120 * 60_000);
});

test("orderedCaptureCandidates preserves the requested batch order", () => {
  const products = [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: true }];
  assert.deepEqual(orderedCaptureCandidates(products, ["c", "a", "b"], true).map((product) => product.id), ["c", "a", "b"]);
});

test("historicalPrimaryImages recovers canonical search images without activity images", () => {
  const canonical = "https://img.alicdn.com/imgextra/i4/1/example-0-item_pic.jpg";
  const activity = "https://gw.alicdn.com/imgextra/example-0-picasso.jpg";
  assert.deepEqual(historicalPrimaryImages([
    { productId: "a", capturedAt: "2026-07-11T11:00:00.000Z", mainImage800: canonical },
    { productId: "a", capturedAt: "2026-07-11T12:00:00.000Z", mainImage800: activity },
    { productId: "b", capturedAt: "2026-07-11T13:00:00.000Z", mainImage800: "https://img.alicdn.com/imgextra/i4/2/other-0-item_pic.jpg" },
  ], "a"), [canonical]);
});

test("historicalProductMedia preserves verified gallery and video assets", () => {
  assert.deepEqual(historicalProductMedia([
    { productId: "p1", capturedAt: "2026-01-01", gallery750Images: ["g1", "g2"], videoUrls: ["v1"] },
    { productId: "p1", capturedAt: "2026-01-02", gallery750Images: ["g1"], videoUrls: [] },
    { productId: "p2", capturedAt: "2026-01-03", gallery750Images: ["other"], videoUrls: ["other"] },
  ], "p1"), {
    galleryImages: ["g1", "g2"],
    videoUrls: ["v1"],
  });
});

test("missing account prices preserve the latest verified SKU scenario", () => {
  const previous = { capturedAt: "2026-01-01", skuPrices: [{ skuId: "a", price: 529, normalPrice: 529, surprisePrice: 489, coinPrice: 479.91, priceCalculation: { normal: "n", surprise: "s", coin: "c" } }] };
  const current = { capturedAt: "2026-01-02", skuPrices: [{ skuId: "a", price: 489, normalPrice: 489, surprisePrice: null, coinPrice: 479.91 }], rawSignals: {} };
  const restored = preserveVerifiedAccountPrices(current, previous, "normal");
  assert.equal(restored.skuPrices[0].normalPrice, 529);
  assert.equal(restored.skuPrices[0].surprisePrice, 489);
  assert.equal(restored.skuPrices[0].coinPrice, 479.91);
  assert.equal(restored.rawSignals.preservedAccountPriceCount, 1);
  assert.equal(historicalAccountPriceSnapshot([{ productId: "p", ...current }, { productId: "p", ...previous }], "p", "normal").capturedAt, "2026-01-01");
});

test("resolveCaptureProtectionMinutes prefers an account pool override", () => {
  const monitor = { captureProtectionMinutes: 3, captureProtectionByAccount: { normal: 10, gift: null, vip88: 0 } };
  assert.equal(resolveCaptureProtectionMinutes(monitor, "normal"), 10);
  assert.equal(resolveCaptureProtectionMinutes(monitor, "gift"), 3);
  assert.equal(resolveCaptureProtectionMinutes(monitor, "vip88"), 0);
  assert.equal(resolveCaptureProtectionMinutes({ captureProtectionMinutes: 0 }, "normal"), 0);
});

test("anonymous public-price snapshots never trigger account price alerts", () => {
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "anonymous" }), false);
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "authenticated" }), true);
});

test("Feishu reminder cooldown can be disabled without affecting capture scheduling", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const logs = [{ productId: "p1", skuId: "s1", type: "below-threshold", status: "sent", createdAt: "2026-07-12T07:30:00.000Z" }];
  assert.equal(isFeishuAlertCoolingDown({ cooldownEnabled: true, cooldownMinutes: 120 }, logs, "p1", "s1", now), true);
  assert.equal(isFeishuAlertCoolingDown({ cooldownEnabled: false, cooldownMinutes: 120 }, logs, "p1", "s1", now), false);
  assert.equal(scheduleProduct({ id: "p1", enabled: true }, { running: true, intervalMinutes: 60 }, { now }).nextMonitorAt, "2026-07-12T09:00:00.000Z");
});

test("buyer-show history is retained when a new capture only sees sparse text", () => {
  const previous = [{ id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: ["old.mp4"], author: "买家" }];
  const current = [{ id: "stable-1", text: "很好用", images: [], videoUrls: [] }, { id: "rate-1", text: "新评价", images: [], videoUrls: [] }];
  assert.deepEqual(mergeBuyerShowHistory(current, previous), [
    { id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: ["old.mp4"], author: "买家", sku: "", createdAt: "" },
    { id: "rate-1", text: "新评价", images: [], videoUrls: [] },
  ]);
});

test("runInCaptureGroups limits concurrency to five and preserves order", async () => {
  let active = 0;
  let maximum = 0;
  const results = await runInCaptureGroups(Array.from({ length: 12 }, (_, index) => index), async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, (12 - value) % 3));
    active -= 1;
    return value;
  });
  assert.equal(maximum, 5);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index));
});
