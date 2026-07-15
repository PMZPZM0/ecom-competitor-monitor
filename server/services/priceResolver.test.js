import test from "node:test";
import assert from "node:assert/strict";
import { applyPriceResolution, resolveEmbeddedSkuPriceEvidence, resolveSkuPriceEvidence } from "./priceResolver.js";

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

test("resolves the current billion-subsidy top-up code as a public promotion", () => {
  const resolution = resolveSkuPriceEvidence([payload("6079769816067", "569", "391", [
    { promotionName: "spsd4bybt", amount: 17000 },
    { promotionName: "spsd4bybtjb", amount: 800 },
  ])], {
    itemId: "843315272519",
    skuId: "6079769816067",
    accountType: "normal",
    selectedSkuVerified: true,
    capturedAt: "2026-07-14T00:00:00.000Z",
  });
  const sku = applyPriceResolution({ skuId: "6079769816067", priceLayers: [] }, resolution);

  assert.equal(resolution.status, "verified");
  assert.equal(sku.originalPrice, 569);
  assert.equal(sku.normalPrice, 391);
  assert.equal(sku.priceCalculation.normal, "标价 569.00 - 百亿补贴 170.00 - 百亿补贴加补 8.00 = 普通价 391.00");
});

test("resolves Taobao flash-sale subsidy and top-up as a verified flash-sale price", () => {
  const resolution = resolveSkuPriceEvidence([payload("5951880316886", "295", "54.92", [
    { promotionName: "spsd4hjmssjbt", amount: 23600 },
    { promotionName: "spsd4hjbt", amount: 408 },
  ])], {
    itemId: "843315272519",
    skuId: "5951880316886",
    accountType: "normal",
    selectedSkuVerified: true,
    capturedAt: "2026-07-14T00:00:00.000Z",
  });
  const sku = applyPriceResolution({ skuId: "5951880316886", priceTitle: "秒杀价", priceLayers: [] }, resolution);

  assert.equal(resolution.status, "verified");
  assert.equal(resolution.normalLabel, "淘宝秒杀价");
  assert.equal(sku.normalPrice, 54.92);
  assert.equal(sku.priceTitle, "淘宝秒杀价");
  assert.equal(sku.priceCalculation.normal, "标价 295.00 - 淘宝秒杀补贴 236.00 - 淘宝秒杀加补 4.08 = 淘宝秒杀价 54.92");
});

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

test("resolves stacked gift and 88VIP benefits as separate cumulative layers", () => {
  const skuId = "mixed-account-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "119", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
    { promotionName: "coupon2RedForNewUser", amount: 1000 },
    { promotionName: "88vipDiscount", amount: 1000 },
  ])], { itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.giftPrice, 129);
  assert.equal(sku.vipPrice, 119);
  assert.match(sku.priceCalculation.vip88, /礼金价 129\.00 - 88VIP优惠 10\.00 = 88VIP价 119\.00/);
});

test("clears legacy account prices when the verified response has no matching evidence", () => {
  const skuId = "no-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "139", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({
    skuId,
    surprisePrice: 129,
    giftPrice: 119,
    vipPrice: 109,
    coinPrice: 99,
    priceLayers: [{ label: "淘金币价", value: 99, source: "applied-coin" }],
    priceCalculation: { coin: "旧淘金币推算" },
  }, resolution);
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.surprisePrice, null);
  assert.equal(sku.giftPrice, null);
  assert.equal(sku.vipPrice, null);
  assert.equal(sku.coinPrice, null);
  assert.equal(sku.priceLayers.some((layer) => /淘金币|金币/.test(layer.label)), false);
  assert.equal(sku.priceCalculation.coin, "本次未获取明确淘金币证据");
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

test("resolves the observed platform, government, surprise, gift and coin formula independently", () => {
  const skuId = "986865193025-sku-1";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "1099", "478.56", [
    { promotionName: "spsd4cjmj", amount: 13200 },
    { promotionName: "spsd4autopri", amount: 3000 },
    { promotionName: "spsd4price", amount: 26800 },
    { promotionName: "zflj", amount: 8445 },
    { promotionName: "spsd4jzjj", amount: 5500 },
    { promotionName: "coupon2RedForNewUser", amount: 4000 },
    { promotionName: "uppAcrossPromotion", amount: 1099 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 669);
  assert.equal(sku.governmentPrice, 584.55);
  assert.equal(sku.surprisePrice, 529.55);
  assert.equal(sku.giftPrice, 489.55);
  assert.equal(sku.coinPrice, 478.56);
  assert.match(sku.priceCalculation.normal, /平台加补 30\.00.*平台立减 268\.00/);
  assert.match(sku.priceCalculation.government, /政府补贴 84\.45/);
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

function embeddedSku(extra = {}) {
  return {
    skuId: "5597954940729",
    name: "白色",
    normalPrice: 241.31,
    originalPrice: 379,
    priceTitle: "平台加补后",
    priceLayers: [
      { label: "平台加补后", value: 241.31, kind: "price" },
      { label: "优惠前", value: 379, kind: "original" },
    ],
    ...extra,
  };
}

const embeddedOptions = {
  itemId: "838302541852",
  skuId: "5597954940729",
  accountType: "normal",
  capturedAt: "2026-07-15T00:00:00.000Z",
};

test("verifies Tmall Supermarket platform top-up SSR evidence to the cent", () => {
  const resolution = resolveEmbeddedSkuPriceEvidence(embeddedSku(), embeddedOptions);
  const sku = applyPriceResolution(embeddedSku(), resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.promotions[0].amountCents, 13769);
  assert.equal(sku.originalPrice, 379);
  assert.equal(sku.normalPrice, 241.31);
  assert.equal(sku.priceCalculation.normal, "标价 379.00 - 平台加补 137.69 = 普通价 241.31");
  assert.equal(sku.priceLayers.at(-1).source, "embedded-ssr");
  assert.deepEqual(sku.priceLayers.map(({ label, value }) => ({ label, value })), [
    { label: "优惠前", value: 379 },
    { label: "普通价", value: 241.31 },
  ]);
});

test("rejects embedded platform top-up evidence outside a normal account capture", () => {
  const resolution = resolveEmbeddedSkuPriceEvidence(embeddedSku(), { ...embeddedOptions, accountType: "vip88" });
  assert.equal(resolution.status, "unavailable");
  assert.equal(resolution.reason, "normal-account-only");
});

test("rejects embedded SSR prices without the explicit platform top-up label", () => {
  const resolution = resolveEmbeddedSkuPriceEvidence(embeddedSku({ priceTitle: "到手价" }), embeddedOptions);
  assert.equal(resolution.matched, false);
});

test("rejects invalid or internally inconsistent embedded SSR prices", () => {
  assert.equal(resolveEmbeddedSkuPriceEvidence(embeddedSku({ normalPrice: 379 }), embeddedOptions).reason, "embedded-price-invalid");
  assert.equal(resolveEmbeddedSkuPriceEvidence(embeddedSku({
    priceLayers: [
      { label: "平台加补后", value: 241.3, kind: "price" },
      { label: "优惠前", value: 379, kind: "original" },
    ],
  }), embeddedOptions).reason, "embedded-price-layer-mismatch");
});
