import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunRecord,
  dueProductIds,
  earliestProductSchedule,
  historicalAccountPriceSnapshot,
  historicalPrimaryImages,
  historicalProductMedia,
  hasTrustedAccountBaseline,
  isFeishuAlertCoolingDown,
  mergeAccountSnapshots,
  mergeBuyerShowHistory,
  preserveBuyerShowHistory,
  nextProductScheduleAt,
  orderedCaptureCandidates,
  preserveVerifiedAccountPrices,
  resolveCaptureProtectionMinutes,
  resolveProductIntervalMinutes,
  riskCooldownMs,
  runInCaptureGroups,
  scheduleProduct,
  sessionsForProduct,
  snapshotAllowsPriceAlerts,
} from "./monitorService.js";

function verifiedSku(sku, channels = ["normal"]) {
  return {
    ...sku,
    resolutionStatus: "verified",
    priceResolution: {
      status: "verified",
      channels: Object.fromEntries(channels.map((kind) => [kind, { status: "verified", valueCents: 1, evidenceIds: [`${kind}-evidence`] }])),
    },
  };
}

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

test("a failed current capture never inherits a historical verified price", () => {
  const previous = { productId: "p", capturedAt: "2026-01-01", skuPrices: [verifiedSku({ skuId: "a", price: 529, normalPrice: 529, surprisePrice: 489 }, ["normal", "surprise"])] };
  const current = { productId: "p", capturedAt: "2026-01-02", skuPrices: [{ skuId: "a", price: 489, normalPrice: 489, resolutionStatus: "ambiguous" }], rawSignals: {} };
  assert.equal(preserveVerifiedAccountPrices(current, previous, "normal"), current);
  assert.equal(current.skuPrices[0].normalPrice, 489);
  assert.equal(historicalAccountPriceSnapshot([previous, current], "p", "normal").capturedAt, "2026-01-01");
});

test("stale or invalid account benefits are not inherited by a new capture", () => {
  const previous = { capturedAt: "2026-01-01", skuPrices: [{ skuId: "a", price: 179, normalPrice: 179, giftPrice: 126, giftInference: { normalPrice: 179 } }] };
  const current = { capturedAt: "2026-01-02", skuPrices: [{ skuId: "a", price: 629, normalPrice: 629, giftPrice: null }], rawSignals: {} };
  const restored = preserveVerifiedAccountPrices(current, previous, "gift");

  assert.equal(restored.skuPrices[0].normalPrice, 629);
  assert.equal(restored.skuPrices[0].giftPrice, null);
  assert.equal(historicalAccountPriceSnapshot([{ productId: "p", capturedAt: "2026-01-03", skuPrices: [{ skuId: "a", normalPrice: 179, giftPrice: 629 }] }], "p", "gift"), null);
});

test("historical lookup ignores newer unverified snapshots", () => {
  const verified = { productId: "p", capturedAt: "2026-07-12", skuPrices: [verifiedSku({ skuId: "a", normalPrice: 459 })] };
  const ambiguous = { productId: "p", capturedAt: "2026-07-13", skuPrices: [{ skuId: "a", normalPrice: 489, resolutionStatus: "ambiguous" }] };
  assert.equal(historicalAccountPriceSnapshot([verified, ambiguous], "p", "normal"), verified);
});

test("account merge accepts explicit gift evidence and never uses a bare cross-account difference", () => {
  const normal = {
    price: 139,
    priceRange: [139, 159],
    skuPrices: [139, 159].map((normalPrice, index) => verifiedSku({ skuId: `sku-${index + 1}`, price: normalPrice, normalPrice, priceLayers: [], discountItems: [] }, ["normal"])),
    rawSignals: {},
  };
  const gift = {
    price: 139,
    priceRange: [139, 159],
    skuPrices: [126, 146].map((giftPrice, index) => verifiedSku({ skuId: `sku-${index + 1}`, price: [139, 159][index], normalPrice: [139, 159][index], giftPrice, giftStatus: "available", giftDiscountAmount: 13, priceLayers: [], discountItems: [] }, ["normal", "gift"])),
    rawSignals: {},
  };
  const normalSession = { id: "normal", name: "普通账号", accountType: "normal" };
  const giftSession = { id: "gift", name: "礼金账号", accountType: "gift" };
  const merged = mergeAccountSnapshots([
    { session: giftSession, snapshot: gift },
    { session: normalSession, snapshot: normal },
  ]);

  assert.deepEqual(merged.skuPrices.map((sku) => ({ normal: sku.normalPrice, gift: sku.giftPrice })), [
    { normal: 139, gift: 126 },
    { normal: 159, gift: 146 },
  ]);
  const guessed = mergeAccountSnapshots([
    { session: giftSession, snapshot: { ...gift, skuPrices: [{ skuId: "sku-1", price: 126, normalPrice: 126 }] } },
    { session: normalSession, snapshot: normal },
  ]);
  assert.equal(guessed.skuPrices[0].giftPrice, undefined);
});

test("account merge keeps each account's evidence isolated while adopting the target channel", () => {
  const resolution = (accountType, giftCents) => ({
    status: "verified",
    accountType,
    channels: {
      normal: { status: "verified", valueCents: 10900, evidenceIds: [`${accountType}-normal`] },
      gift: { status: "verified", valueCents: giftCents, evidenceIds: [`${accountType}-gift`] },
    },
    evidence: [
      { id: `${accountType}-normal`, kind: "normal", valueCents: 10900 },
      { id: `${accountType}-gift`, kind: "gift", valueCents: giftCents },
    ],
  });
  const normalSku = { skuId: "sku-1", price: 109, normalPrice: 109, giftPrice: 102, resolutionStatus: "verified", priceResolution: resolution("normal", 10200), priceLayers: [{ label: "普通价", value: 109 }, { label: "礼金价", value: 102 }] };
  const giftSku = { skuId: "sku-1", price: 109, normalPrice: 109, giftPrice: 94, resolutionStatus: "verified", priceResolution: resolution("gift", 9400), priceLayers: [{ label: "普通价", value: 109 }, { label: "礼金价", value: 94 }] };
  const [merged] = mergeAccountSnapshots([
    { session: { id: "normal", accountType: "normal" }, snapshot: { skuPrices: [normalSku], rawSignals: {} } },
    { session: { id: "gift", accountType: "gift" }, snapshot: { skuPrices: [giftSku], rawSignals: {} } },
  ]).skuPrices;

  assert.equal(merged.giftPrice, 94);
  assert.equal(merged.priceResolution.channels.gift.valueCents, 9400);
  assert.equal(merged.accountPrices[0].priceResolution.channels.gift.valueCents, 10200);
  assert.equal(merged.accountPrices[1].priceResolution.channels.gift.valueCents, 9400);
  assert.deepEqual(merged.priceResolution.evidence.filter((item) => item.kind === "gift").map((item) => item.valueCents), [9400]);
  assert.deepEqual(merged.priceLayers.filter((item) => item.label === "礼金价").map((item) => item.value), [94]);
});

test("a target account list price never replaces the observed normal-account price", () => {
  const normal = { price: 179, priceRange: [179, 179], skuPrices: [{ skuId: "sku-1", price: 179, normalPrice: 179, priceLayers: [], discountItems: [] }], rawSignals: {} };
  const gift = { price: 629, priceRange: [629, 629], skuPrices: [{ skuId: "sku-1", price: 629, normalPrice: 629, originalPrice: 629, giftPrice: 629, giftStatus: "available", priceLayers: [{ label: "礼金价", value: 629, kind: "price" }], discountItems: [] }], rawSignals: {} };
  const [sku] = mergeAccountSnapshots([
    { session: { id: "gift", accountType: "gift" }, snapshot: gift },
    { session: { id: "normal", accountType: "normal" }, snapshot: normal },
  ]).skuPrices;

  assert.equal(sku.normalPrice, 179);
  assert.equal(sku.giftPrice, undefined);
});

test("gift and 88VIP products require both account snapshots but not a dedicated benefit", () => {
  const sessions = [
    { id: "n1", accountType: "normal" },
    { id: "n2", accountType: "normal" },
    { id: "g1", accountType: "gift" },
    { id: "v1", accountType: "vip88" },
  ];
  assert.deepEqual(sessionsForProduct(sessions, "gift").map((session) => session.id), ["n1", "n2", "g1"]);
  assert.deepEqual(sessionsForProduct(sessions, "vip88").map((session) => session.id), ["n1", "n2", "v1"]);
  const normal = { session: sessions[0], snapshot: { skuPrices: [verifiedSku({ skuId: "sku-1", normalPrice: 179 }, ["normal"])] } };
  const gift = { session: sessions[2], snapshot: { skuPrices: [verifiedSku({ skuId: "sku-1", normalPrice: 179, giftPrice: 126 }, ["normal", "gift"])] } };
  const vipWithoutBenefit = { session: sessions[3], snapshot: { skuPrices: [verifiedSku({ skuId: "sku-1", normalPrice: 179 }, ["normal"])] } };
  assert.equal(hasTrustedAccountBaseline([gift], "gift"), false);
  assert.equal(hasTrustedAccountBaseline([normal, { session: sessions[2], snapshot: { skuPrices: [{ skuId: "sku-1", normalPrice: 126 }] } }], "gift"), false);
  assert.equal(hasTrustedAccountBaseline([normal, gift], "gift"), true);
  assert.equal(hasTrustedAccountBaseline([normal], "vip88"), false);
  assert.equal(hasTrustedAccountBaseline([normal, vipWithoutBenefit], "vip88"), true);
});

test("resolveCaptureProtectionMinutes prefers an account pool override", () => {
  const monitor = { captureProtectionMinutes: 3, captureProtectionByAccount: { normal: 10, gift: null, vip88: 0 } };
  assert.equal(resolveCaptureProtectionMinutes(monitor, "normal"), 10);
  assert.equal(resolveCaptureProtectionMinutes(monitor, "gift"), 3);
  assert.equal(resolveCaptureProtectionMinutes(monitor, "vip88"), 0);
  assert.equal(resolveCaptureProtectionMinutes({ captureProtectionMinutes: 0 }, "normal"), 0);
});

test("anonymous public-price snapshots never trigger account price alerts", () => {
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "anonymous", resolutionStatus: "verified" }), false);
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "authenticated", resolutionStatus: "legacy" }), false);
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "authenticated", resolutionStatus: "verified" }), true);
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

test("buyer-show capture keeps same-item history and survives a later failure", () => {
  const previous = {
    itemId: "123",
    capturedAt: "2026-07-12T08:00:00.000Z",
    buyerShows: [{ id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: [] }],
    buyerShowCapture: { status: "partial", capturedAt: "2026-07-12T08:00:00.000Z" },
  };
  const partial = preserveBuyerShowHistory({
    itemId: "123",
    capturedAt: "2026-07-13T08:00:00.000Z",
    buyerShows: [{ id: "rate-1", text: "新评价", images: [], videoUrls: [] }],
    buyerShowCapture: { status: "partial", items: [], mediaCount: 0, textOnlyCount: 0, capturedAt: "2026-07-13T08:00:00.000Z" },
  }, previous);
  assert.equal(partial.buyerShows.length, 2);
  assert.equal(partial.buyerShowCapture.items.length, 2);

  const failed = preserveBuyerShowHistory({
    itemId: "123",
    buyerShows: [],
    buyerShowCapture: { status: "failed", items: [] },
  }, partial);
  assert.equal(failed.buyerShowCachedItems.length, 2);
  assert.equal(failed.buyerShowCapture.lastSuccessfulAt, "2026-07-13T08:00:00.000Z");
});

test("buyer-show history is never reused after the monitored item changes", () => {
  const snapshot = preserveBuyerShowHistory({
    itemId: "new",
    buyerShows: [],
    buyerShowCapture: { status: "failed", items: [] },
  }, { itemId: "old", buyerShows: [{ id: "old-review", images: ["old.jpg"], videoUrls: [] }] });
  assert.deepEqual(snapshot.buyerShowCachedItems, []);
});

test("run record is partial when price succeeds but buyer-show capture fails", () => {
  const run = buildRunRecord({
    source: "manual-product",
    scope: "p1",
    startedAt: "2026-07-13T08:00:00.000Z",
    results: [{ snapshot: { buyerShowCapture: { status: "failed" } } }],
  });
  assert.equal(run.status, "partial");
  assert.match(run.message, /买家秀本次未获取/);
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
