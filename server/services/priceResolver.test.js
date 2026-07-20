import test from "node:test";
import assert from "node:assert/strict";
import { applyItemScopedNewCustomerGift, applyPriceResolution, resolveEmbeddedPromotionPriceEvidence, resolveEmbeddedSkuPriceEvidence, resolveSkuPriceEvidence, selectAuthoritativePriceResolution } from "./priceResolver.js";

test("missing authoritative evidence clears list and guessed prices", () => {
  const sku = applyPriceResolution({
    skuId: "sku-no-evidence",
    price: 319,
    normalPrice: 319,
    originalPrice: 529,
    surprisePrice: 299,
    priceTitle: "标价",
    priceLayers: [{ label: "标价", value: 529, kind: "original" }],
  }, {
    matched: false,
    status: "unavailable",
    reason: "supported-endpoint-not-observed",
    evidence: [],
  });

  assert.equal(sku.price, null);
  assert.equal(sku.normalPrice, null);
  assert.equal(sku.originalPrice, null);
  assert.equal(sku.surprisePrice, null);
  assert.equal(sku.priceTitle, "价格待核对");
  assert.deepEqual(sku.priceLayers, []);
  assert.equal(sku.resolutionStatus, "unavailable");
});

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

const currentPressureCookerCases = [
  ["6198474471056", "689", "428", [
    { promotionName: "commonItemDiscount", amount: 10400 },
    { promotionName: "spsd4plan", amount: 12600 },
    { promotionName: "spsd4jzjj", amount: 3100 },
  ], 459, 428],
  ["6198474471057", "609", "369", [
    { promotionName: "commonItemDiscount", amount: 9200 },
    { promotionName: "spsd4plan", amount: 10800 },
    { promotionName: "spsd4jzjj", amount: 4000 },
  ], 409, 369],
  ["6198474471058", "669", "438.99", [
    { promotionName: "commonItemDiscount", amount: 10100 },
    { promotionName: "spsd4plan", amount: 12900 },
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
  assert.equal(resolution.campaignKind, "billion");
  assert.equal(resolution.channels.billion.status, "verified");
  assert.equal(resolution.channels.seckill.status, "unavailable");
  assert.equal(sku.originalPrice, 569);
  assert.equal(sku.normalPrice, 391);
  assert.equal(sku.priceTitle, "百亿补贴价");
  assert.equal(sku.billionPrice, 391);
  assert.equal(sku.billionStatus, "available");
  assert.equal(sku.priceCalculation.normal, "标价 569.00 - 百亿补贴 170.00 - 百亿补贴加补 8.00 = 百亿补贴价 391.00");
  assert.equal(sku.priceCalculation.billion, sku.priceCalculation.normal);
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
  assert.equal(resolution.campaignKind, "seckill");
  assert.equal(resolution.channels.seckill.status, "verified");
  assert.equal(resolution.channels.billion.status, "unavailable");
  assert.equal(resolution.normalLabel, "淘宝秒杀价");
  assert.equal(sku.normalPrice, 54.92);
  assert.equal(sku.priceTitle, "淘宝秒杀价");
  assert.equal(sku.seckillPrice, 54.92);
  assert.equal(sku.seckillStatus, "available");
  assert.equal(sku.priceCalculation.normal, "标价 295.00 - 淘宝秒杀补贴 236.00 - 淘宝秒杀加补 4.08 = 淘宝秒杀价 54.92");
  assert.equal(sku.priceCalculation.seckill, sku.priceCalculation.normal);
});

test("campaign labels flow through every downstream price formula", () => {
  const skuId = "seckill-full-stack";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "120", [
    { promotionName: "spsd4hjmssjbt", amount: 5000 },
    { promotionName: "zflj", amount: 1000 },
    { promotionName: "spsd4jzjj", amount: 500 },
    { promotionName: "coupon2PlatRed", amount: 500 },
    { promotionName: "coupon288vipcard", amount: 500 },
    { promotionName: "uppAcrossPromotion", amount: 500 },
  ])], { itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);

  assert.equal(sku.priceCalculation.government, "淘宝秒杀价 150.00 - 政府补贴 10.00 = 国补价 140.00");
  assert.equal(sku.priceCalculation.surprise, "国补价 140.00 - 惊喜立减 5.00 = 惊喜立减价 135.00");
  assert.equal(sku.priceCalculation.gift, "惊喜立减价 135.00 - 平台礼金 5.00 = 平台礼金价 130.00");
  assert.equal(sku.priceCalculation.vip88, "平台礼金价 130.00 - 88VIP优惠 5.00 = 88VIP价 125.00");
  assert.equal(sku.priceCalculation.coin, "88VIP价 125.00 - 淘金币抵扣 5.00 = 淘金币价 120.00");
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

for (const [skuId, price1, price2, promotions, normalPrice, surprisePrice] of currentPressureCookerCases) {
  test(`resolves current item-discount formula for SKU ${skuId}`, () => {
    const resolution = resolveSkuPriceEvidence([payload(skuId, price1, price2, promotions)], {
      itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true, capturedAt: "2026-07-18T00:00:00.000Z",
    });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(resolution.status, "verified");
    assert.equal(sku.normalPrice, normalPrice);
    assert.equal(sku.surprisePrice, surprisePrice);
    assert.match(sku.priceCalculation.normal, /商品优惠/);
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

test("88VIP recognizes an explicit first-order gift without applying unknown promotions", () => {
  const skuId = "6274971435306";
  const promotions = [
    { promotionName: "saleCjmj", amount: 8000 },
    { promotionName: "1", amount: 1000 },
    { promotionName: "spsd4plan", amount: 19200 },
    { promotionName: "spsd4cjmj", amount: 4800 },
  ];
  const resolution = resolveSkuPriceEvidence([payload(skuId, "319", "69", promotions)], {
    itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true,
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 79);
  assert.equal(sku.giftPrice, 69);
  assert.equal(sku.surprisePrice, null);
  assert.match(sku.priceCalculation.gift, /首单礼金 10\.00/);
  assert.equal(sku.discountItems.some((item) => item.source === "price-resolver:unknown"), false);
  assert.equal(sku.discountItems.some((item) => item.source === "price-resolver:gift"), true);
});

test("first-order gift code 1 is exposed only to an 88VIP account", () => {
  const skuId = "first-order-account-scope";
  const promotions = [
    { promotionName: "spsd4plan", amount: 5000 },
    { promotionName: "1", amount: 1000 },
  ];

  for (const accountType of ["normal", "gift"]) {
    const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "140", promotions)], {
      itemId: "843315272519", skuId, accountType, selectedSkuVerified: true,
    });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(resolution.status, "verified", accountType);
    assert.equal(sku.normalPrice, 150, accountType);
    assert.equal(sku.giftPrice, null, accountType);
    assert.equal(sku.priceResolution.channels.gift.reason, "different-account-promotion", accountType);
  }

  const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "140", promotions)], {
    itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true,
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 150);
  assert.equal(sku.giftPrice, 140);
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

test("normal, gift and 88VIP accounts all expose an exact new-customer gift formula", () => {
  const skuId = "6110642712271";
  for (const accountType of ["normal", "gift", "vip88"]) {
    const resolution = resolveSkuPriceEvidence([payload(skuId, "309", "94", [
      { promotionName: "coupon2RedForNewUser", amount: 1500 },
      { promotionName: "spsd4plan", amount: 15300 },
      { promotionName: "spsd4cjmj", amount: 4700 },
    ])], { itemId: "843315272519", skuId, accountType, selectedSkuVerified: true });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(sku.normalPrice, 109, accountType);
    assert.equal(sku.giftPrice, 94, accountType);
    assert.equal(sku.priceResolution.channels.gift.label, "新客礼金价", accountType);
    assert.match(sku.priceCalculation.gift, /新客礼金 15\.00.*新客礼金价 94\.00/, accountType);
  }
});

test("a mixed gift formula is exposed only when the account can use every gift code", () => {
  const skuId = "mixed-gift-capabilities";
  const promotions = [
    { promotionName: "spsd4plan", amount: 5000 },
    { promotionName: "coupon2RedForNewUser", amount: 1000 },
    { promotionName: "1", amount: 500 },
  ];

  for (const accountType of ["normal", "gift"]) {
    const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "135", promotions)], {
      itemId: "843315272519", skuId, accountType, selectedSkuVerified: true,
    });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(resolution.status, "verified", accountType);
    assert.equal(sku.normalPrice, 150, accountType);
    assert.equal(sku.giftPrice, null, accountType);
    assert.equal(sku.priceResolution.channels.gift.reason, "different-account-promotion", accountType);
  }

  const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "135", promotions)], {
    itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true,
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(sku.normalPrice, 150);
  assert.equal(sku.giftPrice, 135);
  assert.match(sku.priceCalculation.gift, /新客礼金 10\.00.*首单礼金 5\.00.*礼金价 135\.00/);
});

test("resolves a verified item-scoped new-customer gift for every eligible SKU", () => {
  const itemId = "613114976305";
  const skuId = "6012220507404";
  const component = {
    trackParams: { itemId, skuId, price1: "589", price2: "243" },
    xsRedPocketParams: {
      tbShopRedPocket: JSON.stringify({
        itemId,
        detailExtraParam: {},
        umpInfo: {
          umpPromotionList: [
            { promotionName: "coupon2RedForNewUser", amount: 2600, threshold: 2601 },
            { toolCode: "spsd4cjmj", promotionName: "spsd4cjmj", amount: 7100, threshold: 0 },
            { toolCode: "spsd4price", promotionName: "spsd4price", amount: 24900, threshold: 0 },
          ],
        },
      }),
    },
  };

  const resolution = resolveEmbeddedPromotionPriceEvidence(component, {
    itemId, skuId, accountType: "normal", capturedAt: "2026-07-20T07:45:50.160Z",
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.endpoint, "tmall-ssr-promotion");
  assert.equal(sku.normalPrice, 269);
  assert.equal(sku.giftPrice, 243);
  assert.equal(sku.priceCalculation.normal, "标价 589.00 - 超级立减 71.00 - 平台立减 249.00 = 普通价 269.00");
  assert.equal(sku.priceCalculation.gift, "普通价 269.00 - 新客礼金 26.00 = 新客礼金价 243.00");

  const siblingSkuId = "5925291249025";
  const siblingResolution = resolveEmbeddedPromotionPriceEvidence(component, {
    itemId, skuId: siblingSkuId, accountType: "normal", capturedAt: "2026-07-20T07:45:50.160Z",
  });
  const sibling = applyPriceResolution({ skuId: siblingSkuId, giftPrice: 217, priceLayers: [] }, siblingResolution);
  assert.equal(siblingResolution.matched, false);
  assert.equal(siblingResolution.reason, "embedded-promotion-identity-mismatch");
  assert.equal(sibling.giftPrice, null);

  const siblingBase = resolveEmbeddedSkuPriceEvidence({
    skuId: siblingSkuId,
    originalPrice: 609,
    normalPrice: 270,
    priceTitle: "平台加补后",
    priceLayers: [
      { label: "优惠前", value: 609, kind: "original" },
      { label: "平台加补后", value: 270, kind: "price" },
    ],
  }, { itemId, skuId: siblingSkuId, accountType: "normal", capturedAt: "2026-07-20T07:45:50.160Z" });
  const siblingScoped = applyItemScopedNewCustomerGift(siblingBase, component, {
    itemId, skuId: siblingSkuId, accountType: "normal", capturedAt: "2026-07-20T07:45:50.160Z",
  });
  const siblingWithGift = applyPriceResolution({ skuId: siblingSkuId, priceLayers: [] }, siblingScoped);
  assert.equal(siblingWithGift.normalPrice, 270);
  assert.equal(siblingWithGift.giftPrice, 244);
  assert.equal(siblingWithGift.priceResolution.channels.gift.label, "新客礼金价");
  assert.equal(siblingWithGift.priceCalculation.gift, "普通价 270.00 - 新客礼金 26.00 = 新客礼金价 244.00");
  assert.equal(siblingWithGift.priceEvidence.some((item) => item.scope === "item" && item.skuId === siblingSkuId), true);

  const restrictedComponent = structuredClone(component);
  const restrictedPocket = JSON.parse(restrictedComponent.xsRedPocketParams.tbShopRedPocket);
  restrictedPocket.umpInfo.umpPromotionList[0].skuIds = [skuId];
  restrictedComponent.xsRedPocketParams.tbShopRedPocket = JSON.stringify(restrictedPocket);
  const restricted = applyItemScopedNewCustomerGift(siblingBase, restrictedComponent, {
    itemId, skuId: siblingSkuId, accountType: "normal",
  });
  assert.equal(restricted.channels.gift.status, "unavailable");

  const belowThresholdBase = resolveEmbeddedSkuPriceEvidence({
    skuId: "below-threshold",
    originalPrice: 50,
    normalPrice: 25,
    priceTitle: "平台加补后",
    priceLayers: [
      { label: "优惠前", value: 50, kind: "original" },
      { label: "平台加补后", value: 25, kind: "price" },
    ],
  }, { itemId, skuId: "below-threshold", accountType: "normal" });
  const belowThreshold = applyItemScopedNewCustomerGift(belowThresholdBase, component, {
    itemId, skuId: "below-threshold", accountType: "normal",
  });
  assert.equal(belowThreshold.channels.gift.status, "unavailable");

  const otherItem = applyItemScopedNewCustomerGift(siblingBase, component, {
    itemId: "999999999999", skuId: siblingSkuId, accountType: "normal",
  });
  assert.equal(otherItem.channels.gift.status, "unavailable");
});

test("a normal account exposes verified new-customer gift evidence", () => {
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
  assert.equal(sku.priceResolution.channels.gift.status, "verified");
  assert.equal(sku.surprisePrice, null);
  assert.equal(sku.discountItems.some((item) => item.source === "price-resolver:gift"), true);
});

test("a gift account keeps public surprise, gift and coin channels", () => {
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
  assert.equal(sku.giftDiscountAmount, 15);
  assert.equal(sku.coinPrice, 84.91);
  assert.equal(sku.coinDiscountAmount, 4.09);
  assert.equal(sku.discountItems.some((item) => item.source === "price-resolver:gift"), true);
  assert.equal(sku.discountItems.some((item) => item.source === "price-resolver:coin"), true);
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

test("an 88VIP account keeps gift and 88VIP channels when both are explicit", () => {
  const skuId = "mixed-account-benefits";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "114", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
    { promotionName: "coupon2RedForNewUser", amount: 1000 },
    { promotionName: "88vipDiscount", amount: 1000 },
    { promotionName: "uppAcrossPromotion", amount: 500 },
  ])], { itemId: "843315272519", skuId, accountType: "vip88", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.giftPrice, 129);
  assert.equal(sku.vipPrice, 119);
  assert.equal(sku.vipDiscountAmount, 10);
  assert.equal(sku.coinPrice, 114);
  assert.equal(sku.coinDiscountAmount, 5);
  assert.match(sku.priceCalculation.vip88, /礼金价 129\.00 - 88VIP优惠 10\.00 = 88VIP价 119\.00/);
});

test("resolves the current coupon2PlatRed gift formula on top of shared public prices", () => {
  const skuId = "6198474471056";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "689", "388", [
    { promotionName: "coupon2PlatRed", amount: 4000 },
    { promotionName: "commonItemDiscount", amount: 10400 },
    { promotionName: "spsd4plan", amount: 12600 },
    { promotionName: "spsd4jzjj", amount: 3100 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 459);
  assert.equal(sku.surprisePrice, 428);
  assert.equal(sku.giftPrice, 388);
  assert.equal(sku.giftDiscountAmount, 40);
  assert.match(sku.priceCalculation.gift, /平台礼金 40\.00/);
});

test("resolves the real 668 VIP stack without losing any evidence layer", () => {
  const skuId = "668-real-stack";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "705", "338", [
    { promotionName: "coupon288vipcard", amount: 2225 },
    { promotionName: "coupon2PlatRed", amount: 2500 },
    { promotionName: "commonItemDiscount", amount: 8500 },
    { promotionName: "spsd4price", amount: 17500 },
    { promotionName: "spsd4jzjj", amount: 10 },
    { promotionName: "zflj", amount: 5965 },
  ], {
    url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId: "668945261101", skuId }))}`,
  })], {
    itemId: "668945261101", skuId, accountType: "vip88", selectedSkuVerified: true,
    capturedAt: "2026-07-18T00:00:00.000Z",
  });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);

  assert.equal(resolution.status, "verified");
  assert.deepEqual({
    normal: sku.normalPrice,
    government: sku.governmentPrice,
    surprise: sku.surprisePrice,
    gift: sku.giftPrice,
    vip: sku.vipPrice,
    coin: sku.coinPrice,
  }, { normal: 445, government: 385.35, surprise: 385.25, gift: 360.25, vip: 338, coin: null });
  assert.equal(sku.priceCalculation.government, "普通价 445.00 - 政府补贴 59.65 = 国补价 385.35");
  assert.equal(sku.priceCalculation.surprise, "国补价 385.35 - 惊喜立减 0.10 = 惊喜立减价 385.25");
  assert.equal(sku.priceCalculation.gift, "惊喜立减价 385.25 - 平台礼金 25.00 = 平台礼金价 360.25");
  assert.equal(sku.priceCalculation.vip88, "平台礼金价 360.25 - 88VIP优惠 22.25 = 88VIP价 338.00");
});

test("a normal account exposes coin price through a verified new-customer gift layer", () => {
  const skuId = "coin-after-new-customer-gift";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "130", [
    { promotionName: "spsd4plan", amount: 5000 },
    { promotionName: "coupon2RedForNewUser", amount: 1000 },
    { promotionName: "uppAcrossPromotion", amount: 1000 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);

  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 150);
  assert.equal(sku.giftPrice, 140);
  assert.equal(sku.coinPrice, 130);
  assert.equal(sku.giftStatus, "available");
  assert.equal(sku.coinStatus, "available");
  assert.deepEqual(sku.discountItems.map((item) => item.source), [
    "price-resolver:public",
    "price-resolver:gift",
    "price-resolver:coin",
  ]);
});

test("does not expose a coin price derived through an invisible 88VIP layer", () => {
  const skuId = "coin-hidden-vip";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "200", "130", [
    { promotionName: "spsd4plan", amount: 5000 },
    { promotionName: "88vipDiscount", amount: 1000 },
    { promotionName: "uppAcrossPromotion", amount: 1000 },
  ])], { itemId: "843315272519", skuId, accountType: "gift", selectedSkuVerified: true });
  const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);

  assert.equal(resolution.status, "verified");
  assert.equal(sku.normalPrice, 150);
  assert.equal(sku.vipPrice, null);
  assert.equal(sku.coinPrice, null);
  assert.equal(sku.coinStatus, "none");
  assert.equal(sku.priceResolution.channels.coin.reason, "depends-on-different-account-channel");
  assert.deepEqual(sku.discountItems.map((item) => item.source), ["price-resolver:public"]);
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

test("a gift account exposes government, surprise, gift and coin", () => {
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

test("government subsidy stays independent for normal, gift and 88VIP accounts", () => {
  const cases = [
    { accountType: "normal", displayed: "119", accountPromotion: null, field: null },
    { accountType: "gift", displayed: "109", accountPromotion: { promotionName: "coupon2RedForNewUser", amount: 1000 }, field: "giftPrice" },
    { accountType: "vip88", displayed: "109", accountPromotion: { promotionName: "88vipDiscount", amount: 1000 }, field: "vipPrice" },
  ];
  for (const { accountType, displayed, accountPromotion, field } of cases) {
    const skuId = `government-${accountType}`;
    const promotions = [
      { promotionName: "spsd4plan", amount: 6000 },
      { promotionName: "zflj", amount: 2000 },
      ...(accountPromotion ? [accountPromotion] : []),
    ];
    const resolution = resolveSkuPriceEvidence([payload(skuId, "199", displayed, promotions)], {
      itemId: "843315272519", skuId, accountType, selectedSkuVerified: true,
    });
    const sku = applyPriceResolution({ skuId, priceLayers: [] }, resolution);
    assert.equal(resolution.status, "verified");
    assert.equal(sku.normalPrice, 139);
    assert.equal(sku.governmentPrice, 119);
    if (field) assert.equal(sku[field], 109);
  }
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

test("ambiguous resolution clears stale displayable price fields", () => {
  const skuId = "clear-ambiguous-prices";
  const resolution = resolveSkuPriceEvidence([payload(skuId, "199", "138.99", [
    { promotionName: "spsd4plan", amount: 3000 },
    { promotionName: "spsd4cjmj", amount: 3000 },
  ])], { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true });
  const sku = applyPriceResolution({
    skuId,
    price: 138.99,
    normalPrice: 138.99,
    originalPrice: 199,
    governmentPrice: 119,
    surprisePrice: 109,
    giftPrice: 99,
    vipPrice: 89,
    coinPrice: 79,
    seckillPrice: 69,
    billionPrice: 59,
    priceLayers: [{ label: "普通价", value: 138.99 }],
    priceCalculation: { normal: "旧公式", coin: "旧淘金币公式" },
  }, resolution);

  assert.equal(sku.resolutionStatus, "ambiguous");
  for (const field of ["price", "normalPrice", "originalPrice", "governmentPrice", "surprisePrice", "giftPrice", "vipPrice", "coinPrice", "seckillPrice", "billionPrice"]) {
    assert.equal(sku[field], null, field);
  }
  assert.deepEqual(sku.priceLayers, []);
  assert.match(sku.priceCalculation.normal, /未通过验证/);
});

test("response order does not change a verified result", () => {
  const [skuId, price1, price2, promotions] = pressureCookerCases[0];
  const valid = payload(skuId, price1, price2, promotions);
  const unrelated = payload("another-sku", "100", "100", []);
  const options = { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true, capturedAt: "2026-07-13T00:00:00.000Z" };
  assert.deepEqual(resolveSkuPriceEvidence([valid, unrelated], options), resolveSkuPriceEvidence([unrelated, valid], options));
});

test("verified responses with different campaign kinds fail closed even at the same price", () => {
  const skuId = "same-price-different-campaign";
  const ordinary = payload(skuId, "200", "150", [
    { promotionName: "spsd4plan", amount: 5000 },
  ]);
  const seckill = payload(skuId, "200", "150", [
    { promotionName: "spsd4hjmssjbt", amount: 5000 },
  ]);
  const resolution = resolveSkuPriceEvidence([ordinary, seckill], {
    itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true,
  });

  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.reason, "conflicting-verified-responses");
});

test("verified responses with different list evidence fail closed even at the same price", () => {
  const skuId = "same-price-different-list";
  const discounted = payload(skuId, "200", "150", [
    { promotionName: "spsd4plan", amount: 5000 },
  ]);
  const undiscounted = payload(skuId, "150", "150", undefined);
  const resolution = resolveSkuPriceEvidence([discounted, undiscounted], {
    itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true,
  });

  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.reason, "conflicting-verified-responses");
});

test("different visible new-customer gift results create a real conflict", () => {
  const skuId = "normal-with-conflicting-new-customer-gift";
  const first = payload(skuId, "199", "102", [
    { promotionName: "spsd4plan", amount: 6000 },
    { promotionName: "coupon2RedForNewUser", amount: 3700 },
  ]);
  const second = payload(skuId, "199", "99", [
    { promotionName: "spsd4plan", amount: 6000 },
    { promotionName: "coupon2RedForNewUser", amount: 4000 },
  ]);
  const options = { itemId: "843315272519", skuId, accountType: "normal", selectedSkuVerified: true, capturedAt: "2026-07-16T00:00:00.000Z" };
  const forward = resolveSkuPriceEvidence([first, second], options);
  const reverse = resolveSkuPriceEvidence([second, first], options);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.status, "ambiguous");
  assert.equal(forward.reason, "conflicting-verified-responses");
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

test("keeps embedded platform top-up evidence as the public baseline for every account", () => {
  for (const accountType of ["gift", "vip88"]) {
    const resolution = resolveEmbeddedSkuPriceEvidence(embeddedSku(), { ...embeddedOptions, accountType });
    const sku = applyPriceResolution(embeddedSku(), resolution);
    assert.equal(resolution.status, "verified");
    assert.equal(sku.normalPrice, 241.31);
    assert.equal(sku.priceResolution.channels.normal.status, "verified");
    assert.equal(sku.priceResolution.channels.gift.status, "unavailable");
    assert.equal(sku.priceResolution.channels.vip88.status, "unavailable");
  }
});

test("rejects embedded SSR prices without the explicit platform top-up label", () => {
  const resolution = resolveEmbeddedSkuPriceEvidence(embeddedSku({ priceTitle: "到手价" }), embeddedOptions);
  assert.equal(resolution.matched, false);
});

test("rejects an explicit list-only SKU because it is not current-price evidence", () => {
  const sku = embeddedSku({
    normalPrice: 609,
    originalPrice: 609,
    priceTitle: "普通价",
    priceLayers: [{ label: "优惠前", value: 609, kind: "original" }],
  });
  const resolution = resolveEmbeddedSkuPriceEvidence(sku, { ...embeddedOptions, accountType: "gift" });
  assert.equal(resolution.matched, false);
  assert.equal(resolution.status, "unavailable");
  assert.equal(resolution.reason, "supported-label-not-observed");
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

test("authoritative selection uses exact current-SKU SSR evidence when the price endpoint is absent", () => {
  const embedded = resolveEmbeddedSkuPriceEvidence(embeddedSku(), embeddedOptions);
  const unavailable = { matched: false, status: "unavailable", reason: "supported-endpoint-not-observed" };
  const ambiguous = { matched: true, status: "ambiguous", reason: "formula-does-not-close" };

  assert.equal(selectAuthoritativePriceResolution(unavailable, embedded).status, "verified");
  assert.equal(selectAuthoritativePriceResolution(ambiguous, embedded).reason, "formula-does-not-close");
});

test("authoritative selection falls back after a stale SKU transport response", () => {
  const embedded = resolveEmbeddedSkuPriceEvidence(embeddedSku(), embeddedOptions);
  const staleResponse = { matched: true, status: "ambiguous", reason: "response-sku-mismatch" };
  assert.equal(selectAuthoritativePriceResolution(staleResponse, embedded).status, "verified");
  assert.equal(selectAuthoritativePriceResolution(staleResponse, embedded).source, "embedded-ssr");
});
