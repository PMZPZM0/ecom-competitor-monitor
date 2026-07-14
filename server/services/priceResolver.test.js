import test from "node:test";
import assert from "node:assert/strict";
import { applyPriceResolution, resolveSkuPriceEvidence } from "./priceResolver.js";

function payload(skuId, price1, price2, promotions, extra = {}) {
  const data = JSON.stringify({ itemId: "843315272519", skuId });
  return {
    url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(data)}`,
    skuId,
    body: JSON.stringify({
      data: {
        componentsVO: {
          xsRedPacketParamVO: {
            trackParams: { skuId, price1, price2 },
            xsRedPocketParams: {
              tbShopRedPocket: JSON.stringify({ umpInfo: { umpPromotionList: promotions } }),
            },
          },
        },
      },
    }),
    ...extra,
  };
}

const pressureCookerCases = [
  ["6198474471056", "689", "428", [
    { promotionName: "spsd4plan", amount: 13000 },
    { promotionName: "spsd4cjmj", amount: 10000 },
    { promotionName: "spsd4jzjj", amount: 3100 },
  ], 459, 428],
  ["6198474471057", "609", "369", [
    { promotionName: "spsd4plan", amount: 10000 },
    { promotionName: "spsd4cjmj", amount: 10000 },
    { promotionName: "spsd4jzjj", amount: 4000 },
  ], 409, 369],
  ["6198474471058", "669", "438.99", [
    { promotionName: "spsd4plan", amount: 13000 },
    { promotionName: "spsd4cjmj", amount: 10000 },
    { promotionName: "spsd4jzjj", amount: 1 },
  ], 439, 438.99],
];

for (const [skuId, price1, price2, promotions, normalPrice, surprisePrice] of pressureCookerCases) {
  test(`resolves real pcdetail formula for SKU ${skuId}`, () => {
    const resolution = resolveSkuPriceEvidence([payload(skuId, price1, price2, promotions)], {
      itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true, capturedAt: "2026-07-13T00:00:00.000Z",
    });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(resolution.status, "verified");
    assert.equal(sku.normalPrice, normalPrice);
    assert.equal(sku.surprisePrice, surprisePrice);
    assert.equal(sku.resolutionStatus, "verified");
  });
}

test("resolves the real subsidy and coin formula for the meat grinder", () => {
  const skuId = "6070797216579";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "219", "94.62", [
    { promotionName: "spsd4bybt", amount: 12000 },
    { promotionName: "uppAcrossPromotion", amount: 438 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 99);
  assert.equal(sku.coinPrice, 94.62);
  assert.match(sku.priceCalculation.normal, /百亿补贴 120\.00/);
  assert.match(sku.priceCalculation.coin, /淘金币抵扣 4\.38/);
});

test("gift formula ignores non-applied unknown promotions and requires explicit gift code", () => {
  const skuId = "6274971435306";
  const promotions = [
    { promotionName: "saleCjmj", amount: 8000 },
    { promotionName: "1", amount: 1000 },
    { promotionName: "spsd4plan", amount: 19200 },
    { promotionName: "spsd4cjmj", amount: 4800 },
  ];
  const resolution = resolveSkuPriceEvidence([payload(skuId, "319", "69", promotions)], {
    itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true,
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 79);
  assert.equal(sku.giftPrice, 69);
  assert.equal(sku.surprisePrice, null);
  assert.match(sku.priceCalculation.gift, /首单礼金 10\.00/);
});

test("gift account without an explicit gift promotion does not invent a gift price", () => {
  const skuId = "no-gift-sku";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "139", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.giftPrice, null);
  assert.equal(sku.giftStatus, "none");
});

test("verifies a no-promotion product when list and displayed prices are identical", () => {
  const skuId = "no-promotion-list";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "139", "139", undefined)], {
    itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true,
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.surprisePrice, null);
});

test("rejects a discounted response when its promotion list is missing", () => {
  const skuId = "missing-promotion-list";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "139", undefined)], {
    itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true,
  });
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.reason, "promotion-list-missing");
});

test("resolves the real coupon2RedForNewUser gift formula", () => {
  const skuId = "6110642712271";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "309", "94", [
    { promotionName: "coupon2RedForNewUser", amount: 1500 },
    { promotionName: "spsd4plan", amount: 15300 },
    { promotionName: "spsd4cjmj", amount: 4700 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 109);
  assert.equal(sku.giftPrice, 94);
  assert.match(sku.priceCalculation.gift, /首单礼金 15\.00/);
});

test("a normal account can verify the public baseline when Taobao also returns an explicit gift benefit", () => {
  const skuId = "6110642712271";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "309", "102", [
    { promotionName: "coupon2RedForNewUser", amount: 700 },
    { promotionName: "spsd4plan", amount: 15300 },
    { promotionName: "spsd4cjmj", amount: 4700 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 109);
  assert.equal(sku.giftPrice, 102);
  assert.equal(sku.surprisePrice, null);
});

test("resolves independently stacked surprise, gift and coin prices", () => {
  const skuId = "stacked-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "309", "84.91", [
    { promotionName: "spsd4plan", amount: 15300 },
    { promotionName: "spsd4cjmj", amount: 4700 },
    { promotionName: "spsd4jzjj", amount: 500 },
    { promotionName: "coupon2RedForNewUser", amount: 1500 },
    { promotionName: "uppAcrossPromotion", amount: 409 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 109);
  assert.equal(sku.surprisePrice, 104);
  assert.equal(sku.giftPrice, 89);
  assert.equal(sku.coinPrice, 84.91);
});

test("resolves an explicit 88VIP benefit without reusing gift or surprise fields", () => {
  const skuId = "vip-benefit";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "129", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
    { promotionName: "88vipDiscount", amount: 1000 },
  ])], { itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, giftPrice: 119, surprisePrice: 109, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.vipPrice, 129);
  assert.equal(sku.giftPrice, null);
  assert.equal(sku.surprisePrice, null);
});

test("rejects a response that mixes gift and 88VIP account benefits", () => {
  const skuId = "mixed-account-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "119", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
    { promotionName: "coupon2RedForNewUser", amount: 1000 },
    { promotionName: "88vipDiscount", amount: 1000 },
  ])], { itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true });
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.reason, "mixed-account-benefits");
});

test("clears legacy account prices when the verified response has no matching evidence", () => {
  const skuId = "no-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "139", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, surprisePrice: 129, giftPrice: 119, vipPrice: 109, coinPrice: 99, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.surprisePrice, null);
  assert.equal(sku.giftPrice, null);
  assert.equal(sku.vipPrice, null);
  assert.equal(sku.coinPrice, null);
});

test("resolves normal, surprise and coin prices from uppAcrossPromotion", () => {
  const skuId = "6270249535967";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "909", "479.91", [
    { promotionName: "spsd4plan", amount: 24300 },
    { promotionName: "spsd4cjmj", amount: 13700 },
    { promotionName: "spsd4jzjj", amount: 4000 },
    { promotionName: "uppAcrossPromotion", amount: 909 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 529);
  assert.equal(sku.surprisePrice, 489);
  assert.equal(sku.coinPrice, 479.91);
  assert.match(sku.priceCalculation.coin, /淘金币抵扣 9\.09/);
});

test("fails closed when the formula does not equal price2", () => {
  const skuId = "bad-formula";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "138.99", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.reason, "formula-does-not-close");
});

test("response order does not change a verified result", () => {
  const [skuId, price1, price2, promotions] = pressureCookerCases[0];
  const valid = payload(skuId, price1, price2, promotions);
  const unrelated = payload("another-sku", "100", "100", []);
  const options = { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true, capturedAt: "2026-07-13T00:00:00.000Z" };
  assert.deepEqual(resolveSkuPriceEvidence([valid, unrelated], options), resolveSkuPriceEvidence([unrelated, valid], options));
});
