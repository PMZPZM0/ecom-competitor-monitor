import assert from "node:assert/strict";
import test from "node:test";
import {
  auditPriceEngineShadowRound,
  recordPriceEngineShadowRound,
} from "./priceEngineShadowService.js";

function resolution(parserVersion, channels) {
  return { status: "verified", parserVersion, channels };
}

function verified(valueCents) {
  return { status: "verified", valueCents, evidenceIds: ["private-evidence-id"] };
}

test("shadow audit compares verified top-level and account-view prices without retaining identifiers", () => {
  const round = auditPriceEngineShadowRound([{
    productId: "private-product-id",
    itemId: "private-item-id",
    shopName: "private-shop-name",
    parserVersion: "snapshot-v1",
    skuPrices: [{
      skuId: "private-sku-id",
      normalPrice: 139,
      price: 139,
      governmentPrice: 129,
      coinPrice: 128.98,
      priceResolution: resolution("resolver-v1", {
        normal: verified(13900),
        government: verified(12899),
        gift: { status: "unavailable", valueCents: null },
        coin: verified(12899),
      }),
      accountPrices: [{
        sessionId: "private-session-id",
        normalPrice: "139.00",
        price: 139,
        vipPrice: 119,
        priceResolution: resolution("resolver-v2", {
          normal: verified(13900),
          vip88: verified(11900),
          coin: { status: "unavailable", valueCents: null },
        }),
      }],
    }],
  }], { recordedAt: "2026-07-18T08:00:00+08:00", accessToken: "do-not-store" });

  assert.deepEqual(round, {
    recordedAt: "2026-07-18T00:00:00.000Z",
    products: 1,
    failedProducts: 0,
    skus: 1,
    verifiedChannels: 5,
    mismatches: 2,
    unavailable: 2,
    parserVersions: { "resolver-v1": 3, "resolver-v2": 2 },
  });
  const persisted = JSON.stringify(round);
  for (const secret of ["private-product-id", "private-item-id", "private-shop-name", "private-sku-id", "private-session-id", "private-evidence-id", "do-not-store"]) {
    assert.equal(persisted.includes(secret), false);
  }
});

test("normal channel requires every populated display alias to agree to the cent", () => {
  const base = {
    skuPrices: [{
      normalPrice: 138.99,
      price: 139,
      priceResolution: resolution("one-cent-v1", { normal: verified(13899) }),
    }],
  };
  assert.equal(auditPriceEngineShadowRound([base]).mismatches, 1);
  assert.equal(auditPriceEngineShadowRound([{ ...base, skuPrices: [{ ...base.skuPrices[0], price: 138.99 }] }]).mismatches, 0);
  assert.equal(auditPriceEngineShadowRound([{ skuPrices: [{ priceResolution: base.skuPrices[0].priceResolution }] }]).mismatches, 1);
});

test("recording activates only after consecutive clean evidence rounds and resets on mismatch", () => {
  const cleanSnapshot = [{ skuPrices: [{ normalPrice: 139, price: 139, priceResolution: resolution("clean-v1", { normal: verified(13900) }) }] }];
  const mismatchedSnapshot = [{ skuPrices: [{ normalPrice: 138.99, price: 138.99, priceResolution: resolution("clean-v1", { normal: verified(13900) }) }] }];
  const unavailableSnapshot = [{ skuPrices: [{ priceResolution: resolution("clean-v1", { normal: { status: "unavailable", valueCents: null } }) }] }];

  const ninth = recordPriceEngineShadowRound(
    { mode: "shadow", shadowRoundsCompleted: 8, requiredShadowRounds: 10 },
    cleanSnapshot,
    { now: "2026-07-18T01:00:00.000Z" },
  );
  assert.equal(ninth.mode, "shadow");
  assert.equal(ninth.consecutiveCleanShadowRounds, 9);
  assert.equal(ninth.shadowRoundsCompleted, 9);
  assert.equal(ninth.shadowRoundsAttempted, 9);

  const active = recordPriceEngineShadowRound(ninth, cleanSnapshot, { now: "2026-07-18T02:00:00.000Z" });
  assert.equal(active.mode, "active");
  assert.equal(active.consecutiveCleanShadowRounds, 10);
  assert.equal(active.shadowRoundsAttempted, 10);

  const reset = recordPriceEngineShadowRound(active, mismatchedSnapshot, { now: "2026-07-18T03:00:00.000Z" });
  assert.equal(reset.mode, "shadow");
  assert.equal(reset.consecutiveCleanShadowRounds, 0);
  assert.equal(reset.shadowRoundsCompleted, 0);

  const noEvidence = recordPriceEngineShadowRound(
    { ...reset, shadowRoundsCompleted: 8, consecutiveCleanShadowRounds: 8 },
    unavailableSnapshot,
    { now: "2026-07-18T04:00:00.000Z" },
  );
  assert.equal(noEvidence.mode, "shadow");
  assert.equal(noEvidence.consecutiveCleanShadowRounds, 0);
  assert.equal(noEvidence.shadowRoundsAttempted, 12);

  const failed = recordPriceEngineShadowRound(
    { ...reset, shadowRoundsCompleted: 9, consecutiveCleanShadowRounds: 9 },
    cleanSnapshot,
    { now: "2026-07-18T05:00:00.000Z", failedProducts: 1 },
  );
  assert.equal(failed.mode, "shadow");
  assert.equal(failed.consecutiveCleanShadowRounds, 0);
  assert.equal(failed.shadowRounds.at(-1).failedProducts, 1);
});

test("recording keeps at most thirty sanitized rounds and updates legacy rounds fields", () => {
  const cleanSnapshot = [{ skuPrices: [{ normalPrice: 1.01, price: 1.01, priceResolution: resolution("stable-v1", { normal: verified(101) }) }] }];
  let config = { mode: "shadow", rounds: 0, requiredShadowRounds: 50 };
  for (let index = 0; index < 35; index += 1) {
    config = recordPriceEngineShadowRound(config, cleanSnapshot, { now: new Date(Date.UTC(2026, 6, 18, index)).toISOString() });
  }

  assert.equal(config.mode, "shadow");
  assert.equal(config.rounds, 35);
  assert.equal(config.shadowRoundsCompleted, 35);
  assert.equal(config.consecutiveCleanShadowRounds, 35);
  assert.equal(config.shadowRoundsAttempted, 35);
  assert.equal(config.shadowRounds.length, 30);
  assert.equal(config.shadowRounds[0].recordedAt, "2026-07-18T05:00:00.000Z");
  assert.equal(config.lastShadowAt, "2026-07-19T10:00:00.000Z");

  const imported = recordPriceEngineShadowRound({
    rounds: [{ ...config.shadowRounds[0], productId: "must-be-removed", mismatchDetails: ["secret"] }],
    requiredShadowRounds: 2,
  }, cleanSnapshot, { now: "2026-07-20T00:00:00.000Z" });
  assert.equal(imported.rounds.length, 2);
  assert.equal(JSON.stringify(imported).includes("must-be-removed"), false);
  assert.equal(JSON.stringify(imported).includes("secret"), false);
});
