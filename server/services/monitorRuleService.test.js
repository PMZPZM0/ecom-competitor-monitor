import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMonitorAlert,
  evaluateSkuMonitorRules,
  monitorChannelSupported,
  monitorChannelsForAccount,
  resolveMonitorPriceCents,
} from "./monitorRuleService.js";

function sku(skuId, channels) {
  return {
    skuId,
    price: 0.01,
    normalPrice: 0.01,
    priceResolution: {
      status: "verified",
      channels: Object.fromEntries(Object.entries(channels).map(([channel, valueCents]) => [
        channel,
        { status: "verified", valueCents, evidenceIds: [`${channel}-evidence`] },
      ])),
    },
  };
}

test("monitor channels are constrained by the product primary account type", () => {
  assert.deepEqual(monitorChannelsForAccount("normal"), ["lowest", "normal", "billion", "seckill", "government", "surprise", "coin"]);
  assert.equal(monitorChannelSupported("normal", "gift"), false);
  assert.equal(monitorChannelSupported("gift", "gift"), true);
  assert.equal(monitorChannelSupported("gift", "vip88"), false);
  assert.equal(monitorChannelSupported("vip88", "vip88"), true);
  assert.equal(monitorChannelSupported("normal", "billion"), true);
  assert.equal(monitorChannelSupported("normal", "seckill"), true);
});

test("reads only verified integer-cent channel evidence", () => {
  const item = sku("sku-1", { normal: 13900 });
  item.priceResolution.channels.surprise = { status: "unavailable", valueCents: 9900, evidenceIds: [] };
  item.priceResolution.channels.coin = { status: "verified", valueCents: 9899.5, evidenceIds: ["bad"] };

  assert.equal(resolveMonitorPriceCents(item, "normal", "normal"), 13900);
  assert.equal(resolveMonitorPriceCents(item, "normal", "surprise"), null);
  assert.equal(resolveMonitorPriceCents(item, "normal", "coin"), null);
  assert.equal(resolveMonitorPriceCents({ ...item, priceResolution: undefined }, "normal", "normal"), null);
});

test("lowest price includes only channels supported by the current account", () => {
  const item = sku("sku-1", {
    normal: 13900,
    billion: 12900,
    seckill: 12500,
    government: 12900,
    surprise: 11900,
    gift: 10900,
    vip88: 9900,
    coin: 11400,
  });

  assert.equal(resolveMonitorPriceCents(item, "normal", "lowest"), 11400);
  assert.equal(resolveMonitorPriceCents(item, "normal", "billion"), 12900);
  assert.equal(resolveMonitorPriceCents(item, "normal", "seckill"), 12500);
  assert.equal(resolveMonitorPriceCents(item, "gift", "lowest"), 10900);
  assert.equal(resolveMonitorPriceCents(item, "vip88", "lowest"), 9900);
  assert.equal(resolveMonitorPriceCents(item, "normal", "gift"), null);
  assert.equal(resolveMonitorPriceCents(item, "gift", "vip88"), null);
});

test("compares exact cents and treats equality as recovered", () => {
  const oneCentBelow = evaluateMonitorAlert({ priceCents: 9999, threshold: 100 });
  assert.equal(oneCentBelow.event, "crossing-below");

  const equal = evaluateMonitorAlert({ priceCents: 10000, threshold: 100, previousState: oneCentBelow.nextState });
  assert.equal(equal.event, "recovered");
  assert.equal(equal.nextState.relation, "at-or-above");

  const oneCentAbove = evaluateMonitorAlert({ priceCents: 10001, threshold: 100 });
  assert.equal(oneCentAbove.event, "none");
});

test("sustained low prices notify only when a new episode low is reached", () => {
  const crossed = evaluateMonitorAlert({ priceCents: 9000, threshold: "100.00" });
  const same = evaluateMonitorAlert({ priceCents: 9000, threshold: "100.00", previousState: crossed.nextState });
  const higherButLow = evaluateMonitorAlert({ priceCents: 9500, threshold: "100.00", previousState: same.nextState });
  const lowerThanLastButNotNewLow = evaluateMonitorAlert({ priceCents: 9400, threshold: "100.00", previousState: higherButLow.nextState });
  const oneCentLower = evaluateMonitorAlert({ priceCents: 8999, threshold: "100.00", previousState: lowerThanLastButNotNewLow.nextState });

  assert.equal(crossed.event, "crossing-below");
  assert.equal(same.event, "none");
  assert.equal(higherButLow.event, "none");
  assert.equal(lowerThanLastButNotNewLow.event, "none");
  assert.equal(oneCentLower.event, "new-low");
  assert.equal(oneCentLower.nextState.episodeLowCents, 8999);
});

test("recovery resets the episode so a later drop crosses again", () => {
  const crossed = evaluateMonitorAlert({ priceCents: 9000, threshold: 100 });
  const recovered = evaluateMonitorAlert({ priceCents: 10100, threshold: 100, previousState: crossed.nextState });
  const crossedAgain = evaluateMonitorAlert({ priceCents: 9500, threshold: 100, previousState: recovered.nextState });

  assert.equal(recovered.event, "recovered");
  assert.equal(recovered.nextState.episodeLowCents, null);
  assert.equal(crossedAgain.event, "crossing-below");
});

test("unavailable evidence preserves alert position without a phantom repeat", () => {
  const crossed = evaluateMonitorAlert({ priceCents: 9000, threshold: 100 });
  const unavailable = evaluateMonitorAlert({ priceCents: null, threshold: 100, previousState: crossed.nextState });
  const persistedState = JSON.parse(JSON.stringify(unavailable.nextState));
  const restored = evaluateMonitorAlert({ priceCents: 9000, threshold: 100, previousState: persistedState });

  assert.equal(unavailable.event, "unavailable");
  assert.equal(unavailable.nextState.relation, "below");
  assert.equal(unavailable.nextState.available, false);
  assert.equal(restored.event, "none");
});

test("a changed threshold starts a fresh alert lifecycle", () => {
  const crossed = evaluateMonitorAlert({ priceCents: 9000, threshold: 100 });
  const changedBelow = evaluateMonitorAlert({ priceCents: 9000, threshold: 95, previousState: crossed.nextState });
  const changedAbove = evaluateMonitorAlert({ priceCents: 9000, threshold: 85, previousState: crossed.nextState });

  assert.equal(changedBelow.event, "crossing-below");
  assert.equal(changedAbove.event, "none");
});

test("evaluates nested SKU channel rules and returns matching persistent state", () => {
  const item = sku("sku-1", { normal: 13900, gift: 10900 });
  const result = evaluateSkuMonitorRules({
    skuPrices: [item],
    accountType: "normal",
    skuMonitorRules: {
      "sku-1": { lowest: 140, normal: 139, gift: 120, unknown: 1, coin: 0 },
      "missing-sku": { normal: 100 },
    },
  });

  assert.deepEqual(result.evaluations.map(({ skuId, channel, event, resolvedChannel }) => ({ skuId, channel, event, resolvedChannel })), [
    { skuId: "sku-1", channel: "lowest", event: "crossing-below", resolvedChannel: "normal" },
    { skuId: "sku-1", channel: "normal", event: "none", resolvedChannel: "normal" },
    { skuId: "sku-1", channel: "gift", event: "unavailable", resolvedChannel: null },
    { skuId: "missing-sku", channel: "normal", event: "unavailable", resolvedChannel: null },
  ]);
  assert.deepEqual(Object.keys(result.nextStates["sku-1"]), ["lowest", "normal", "gift"]);
  assert.equal(result.nextStates["missing-sku"].normal.available, false);
});

test("rejects invalid direct thresholds", () => {
  assert.throws(() => evaluateMonitorAlert({ priceCents: 100, threshold: 0 }), /positive amount/);
  assert.throws(() => evaluateMonitorAlert({ priceCents: 100, threshold: Number.NaN }), /positive amount/);
});
