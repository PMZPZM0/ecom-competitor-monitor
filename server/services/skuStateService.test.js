import assert from "node:assert/strict";
import test from "node:test";
import { applySkuVerificationHistory, updateSkuLifecycle } from "./skuStateService.js";

function sku(skuId, price, status = "verified") {
  return {
    skuId,
    name: `SKU ${skuId}`,
    normalPrice: price,
    resolutionStatus: status,
    priceResolution: {
      channels: {
        normal: { status, valueCents: Math.round(price * 100), evidenceIds: [`normal-${skuId}`] },
      },
    },
  };
}

test("unverified SKU keeps the last verified value only as stale metadata", () => {
  const previous = { itemId: "1", capturedAt: "2026-07-18T08:00:00.000Z", skuPrices: [sku("a", 139)] };
  const current = { itemId: "1", capturedAt: "2026-07-18T11:00:00.000Z", skuPrices: [sku("a", 999, "ambiguous")] };
  const merged = applySkuVerificationHistory(current, previous);
  assert.equal(merged.skuPrices[0].normalPrice, 999);
  assert.deepEqual(merged.skuPrices[0].stalePrices.normal, {
    value: 139,
    verifiedAt: previous.capturedAt,
    evidenceIds: ["normal-a"],
    field: "normalPrice",
  });
});

test("verified current prices never inherit stale values", () => {
  const previous = { itemId: "1", capturedAt: "2026-07-18T08:00:00.000Z", skuPrices: [sku("a", 139)] };
  const current = { itemId: "1", capturedAt: "2026-07-18T11:00:00.000Z", skuPrices: [sku("a", 138.99)] };
  assert.deepEqual(applySkuVerificationHistory(current, previous).skuPrices[0].stalePrices, {});
});

test("missing SKUs are archived and lifecycle follows real skuId", () => {
  const previous = { itemId: "1", capturedAt: "2026-07-18T08:00:00.000Z", skuPrices: [sku("a", 139), sku("b", 159)] };
  const current = { itemId: "1", capturedAt: "2026-07-18T11:00:00.000Z", skuPrices: [sku("a", 138.99)] };
  const merged = applySkuVerificationHistory(current, previous);
  assert.equal(merged.archivedSkuPrices[0].skuId, "b");
  const lifecycle = updateSkuLifecycle(updateSkuLifecycle({}, previous), current);
  assert.equal(lifecycle.a.status, "active");
  assert.equal(lifecycle.b.status, "archived");
  assert.equal(lifecycle.b.archivedAt, current.capturedAt);
});
