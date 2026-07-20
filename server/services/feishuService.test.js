import assert from "node:assert/strict";
import test from "node:test";
import { accountPriceContext, buildPriceCard, effectivePriceForSku, publicFeishuConfig, updateFeishuConfig } from "./feishuService.js";

function verifiedSku(sku, channels) {
  return {
    ...sku,
    resolutionStatus: "verified",
    priceResolution: {
      status: "verified",
      channels: Object.fromEntries(channels.map((kind) => [kind, { status: "verified", valueCents: Math.round(Number(kind === "normal" ? sku.normalPrice : kind === "surprise" ? sku.surprisePrice : kind === "gift" ? sku.giftPrice : kind === "vip88" ? sku.vipPrice : sku.coinPrice) * 100), evidenceIds: [`${kind}-evidence`] }])),
    },
  };
}

test("Feishu config removes legacy reminder cooldown fields", () => {
  const updated = updateFeishuConfig({ cooldownEnabled: true, cooldownMinutes: 120 }, { enabled: true });
  assert.equal("cooldownEnabled" in updated, false);
  assert.equal("cooldownMinutes" in updated, false);
  assert.equal("cooldownEnabled" in publicFeishuConfig(updated), false);
  assert.equal("cooldownMinutes" in publicFeishuConfig(updated), false);
});

test("buildPriceCard renders every SKU and highlights triggered SKUs", () => {
  const card = buildPriceCard({
    type: "below-threshold",
    product: {
      url: "https://detail.tmall.com/item.htm?id=1",
      shopName: "测试店铺",
      model: "MODEL-1",
      skuMonitorPrices: { sku1: 100, sku2: 200 },
      lastSnapshot: {
        skuPrices: [
          verifiedSku({ skuId: "sku1", name: "白色款", price: 90, normalPrice: 90, coinPrice: 88 }, ["normal", "coin"]),
          verifiedSku({ skuId: "sku2", name: "黑色款", price: 220, normalPrice: 220, coinPrice: null }, ["normal"]),
        ],
      },
    },
    price: 88,
    threshold: 100,
    skuName: "白色款",
    triggeredSkuIds: ["sku1"],
  });

  assert.equal(card.header.title.content, "价格监控预警");
  assert.equal(card.header.template, "orange");
  const markdown = card.body.elements
    .filter((element) => element.tag === "markdown")
    .map((element) => element.content)
    .join("\n");
  assert.match(markdown, /白色款/);
  assert.match(markdown, /黑色款/);
  assert.match(markdown, /低于监控价/);
  assert.match(markdown, /¥88\.00/);
});

test("Feishu alert card names the exact monitor channel and state transition", () => {
  const product = {
    url: "https://detail.tmall.com/item.htm?id=1",
    shopName: "测试店铺",
    model: "MODEL-1",
    skuMonitorRules: { sku1: { normal: 100, coin: 90 } },
    lastSnapshot: {
      skuPrices: [verifiedSku({ skuId: "sku1", name: "白色款", price: 90, normalPrice: 90, coinPrice: 88 }, ["normal", "coin"])],
    },
  };
  const card = buildPriceCard({
    type: "below-threshold",
    product,
    triggeredSkuIds: ["sku1"],
    triggeredRules: [{ skuId: "sku1", channel: "normal", resolvedChannel: "normal", event: "crossing-below", priceCents: 9000, thresholdCents: 10000, priceLabel: "普通价" }],
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /首次跌破/);
  assert.match(serialized, /普通价/);
  assert.match(serialized, /¥90\.00 < ¥100\.00/);
  assert.match(serialized, /普通价 ¥100\.00/);
  assert.match(serialized, /淘金币价 ¥90\.00/);
});

test("price channels stay isolated to the product account type", () => {
  const product = {
    accountType: "gift",
    shopName: "礼金店铺",
    model: "GIFT-1",
    url: "https://detail.tmall.com/item.htm?id=2",
    lastSnapshot: {
      accountCaptures: [{ accountType: "gift", accountName: "礼金账号" }],
      skuPrices: [verifiedSku({ skuId: "gift1", name: "礼金款", price: 79, normalPrice: 79, giftPrice: 69, surprisePrice: null, vipPrice: null, coinPrice: null, giftStatus: "available", surpriseStatus: "none", vipStatus: "none", coinStatus: "none" }, ["normal", "gift"])],
    },
  };
  const card = buildPriceCard({ type: "manual-sync", product, price: 69, threshold: null });
  const markdown = card.body.elements.filter((element) => element.tag === "markdown").map((element) => element.content).join("\n");
  const serialized = JSON.stringify(card);
  assert.match(markdown, /礼金账号/);
  assert.match(serialized, /礼金价/);
  assert.match(serialized, /¥69\.00/);
  assert.match(serialized, /惊喜立减价/);
  assert.match(serialized, /不适用/);
  assert.match(serialized, /本次未验证/);
  assert.deepEqual(effectivePriceForSku(product.lastSnapshot.skuPrices[0], "gift"), { label: "礼金价", value: 69 });
});

test("effective price follows normal to surprise to coin chain", () => {
  const sku = verifiedSku({ price: 529, normalPrice: 529, surprisePrice: 489, coinPrice: 479.91 }, ["normal", "surprise", "coin"]);
  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "淘金币价", value: 479.91 });
  assert.deepEqual(effectivePriceForSku(verifiedSku({ price: 529, normalPrice: 529, surprisePrice: 489 }, ["normal", "surprise"]), "normal"), { label: "惊喜立减价", value: 489 });
  assert.deepEqual(effectivePriceForSku(verifiedSku({ price: 529, normalPrice: 529 }, ["normal"]), "normal"), { label: "普通价", value: 529 });
  assert.equal(effectivePriceForSku({ price: 1, normalPrice: 1 }, "normal"), null);
});

test("a normal account uses a verified new-customer gift in lowest price and Feishu output", () => {
  const sku = verifiedSku({
    skuId: "new-customer-gift",
    name: "新客款",
    price: 139,
    normalPrice: 139,
    giftPrice: 113,
    giftStatus: "available",
  }, ["normal", "gift"]);
  sku.priceResolution.promotions = [{ code: "coupon2RedForNewUser", kind: "gift", label: "新客礼金" }];
  sku.priceResolution.channels.gift.label = "新客礼金价";
  sku.giftPrice = 1;

  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "新客礼金价", value: 113 });

  const card = buildPriceCard({
    type: "manual-sync",
    product: {
      accountType: "normal",
      shopName: "新客店铺",
      model: "NEW-1",
      url: "https://detail.tmall.com/item.htm?id=5",
      lastSnapshot: { primaryAccountType: "normal", skuPrices: [sku] },
    },
    price: 113,
    priceLabel: "新客礼金价",
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /新客礼金价/);
  assert.match(serialized, /¥113\.00/);
  assert.doesNotMatch(serialized, /¥1\.00/);
});

test("code 1 remains restricted to 88VIP even if a stale resolver marked the gift channel verified", () => {
  const sku = verifiedSku({
    skuId: "first-order-verified",
    name: "首单款",
    price: 139,
    normalPrice: 139,
    giftPrice: 99,
    giftStatus: "available",
  }, ["normal", "gift"]);
  sku.priceResolution.promotions = [{ code: "1", kind: "gift", label: "首单礼金" }];
  sku.priceResolution.channels.gift.label = "首单礼金价";

  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "普通价", value: 139 });
  assert.deepEqual(effectivePriceForSku(sku, "gift"), { label: "普通价", value: 139 });
  assert.deepEqual(effectivePriceForSku(sku, "vip88"), { label: "首单礼金价", value: 99 });
});

test("a restricted first-order gift cannot leak from a stale normal-account field", () => {
  const sku = verifiedSku({
    skuId: "first-order-gift",
    name: "首单款",
    price: 139,
    normalPrice: 139,
    giftPrice: 99,
    giftStatus: "none",
  }, ["normal"]);
  sku.priceResolution.promotions = [{ code: "1", kind: "gift", label: "首单礼金" }];
  sku.priceResolution.channels.gift = {
    status: "unavailable",
    valueCents: null,
    reason: "different-account-promotion",
    evidenceIds: [],
  };

  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "普通价", value: 139 });
  const card = buildPriceCard({
    type: "manual-sync",
    product: {
      accountType: "normal",
      url: "https://detail.tmall.com/item.htm?id=6",
      lastSnapshot: { primaryAccountType: "normal", skuPrices: [sku] },
    },
    price: 139,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /不适用/);
  assert.doesNotMatch(serialized, /¥99\.00/);
});

test("campaign channels keep explicit labels in effective price and Feishu output", () => {
  const sku = {
    skuId: "campaign-1",
    name: "活动款",
    price: 150,
    normalPrice: 150,
    seckillPrice: 150,
    seckillStatus: "available",
    billionPrice: null,
    billionStatus: "none",
    resolutionStatus: "verified",
    priceResolution: {
      status: "verified",
      channels: {
        normal: { status: "verified", valueCents: 15000, evidenceIds: ["normal"] },
        seckill: { status: "verified", valueCents: 15000, evidenceIds: ["seckill"] },
        billion: { status: "unavailable", valueCents: null, evidenceIds: [] },
      },
    },
  };
  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "淘宝秒杀价", value: 150 });

  const card = buildPriceCard({
    type: "manual-sync",
    product: {
      accountType: "normal",
      url: "https://detail.tmall.com/item.htm?id=4",
      skuMonitorRules: { "campaign-1": { seckill: 155, billion: 145 } },
      lastSnapshot: { skuPrices: [sku] },
    },
    price: 150,
    threshold: null,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /淘宝秒杀价/);
  assert.match(serialized, /百亿补贴价/);
  assert.match(serialized, /¥150\.00/);
  assert.match(serialized, /淘宝秒杀价 ¥155\.00/);
  assert.match(serialized, /百亿补贴价 ¥145\.00/);
});

test("gift and 88VIP effective prices include every supported verified channel", () => {
  const gift = verifiedSku({ normalPrice: 139, surprisePrice: 119, giftPrice: 109 }, ["normal", "surprise", "gift"]);
  assert.deepEqual(effectivePriceForSku(gift, "gift"), { label: "礼金价", value: 109 });
  const vip = verifiedSku({ normalPrice: 139, surprisePrice: 119, giftPrice: 109, vipPrice: 99 }, ["normal", "surprise", "gift", "vip88"]);
  assert.deepEqual(effectivePriceForSku(vip, "vip88"), { label: "88VIP价", value: 99 });
});

test("monitoring and Feishu stay on the explicit primary account view", () => {
  const snapshot = {
    primaryAccountSessionId: "gift-session",
    primaryAccountType: "gift",
    accountCaptures: [
      { sessionId: "normal-session", accountName: "普通 A", accountType: "normal" },
      { sessionId: "gift-session", accountName: "礼金 B", accountType: "gift", primary: true },
    ],
  };
  assert.deepEqual(accountPriceContext({ accountType: "normal", lastSnapshot: snapshot }, snapshot), {
    accountType: "gift",
    account: { account: "礼金账号", benefit: "礼金价", field: "giftPrice", status: "giftStatus" },
    accountName: "礼金 B",
  });
  const primarySku = verifiedSku({
    normalPrice: 139,
    accountPrices: [{ sessionId: "vip-session", accountType: "vip88", normalPrice: 99, vipPrice: 79 }],
  }, ["normal"]);
  assert.deepEqual(effectivePriceForSku(primarySku, "normal"), { label: "普通价", value: 139 });
});

test("large Feishu cards keep SKUs beyond the visual price grid", () => {
  const skuPrices = Array.from({ length: 12 }, (_, index) => verifiedSku({ skuId: `sku${index + 1}`, name: `型号${index + 1}`, price: 100 + index, normalPrice: 100 + index }, ["normal"]));
  const card = buildPriceCard({
    type: "manual-sync",
    product: { accountType: "normal", shopName: "测试店铺", model: "MODEL", url: "https://detail.tmall.com/item.htm?id=3", lastSnapshot: { skuPrices } },
    price: 100,
    threshold: null,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /更多 SKU/);
  assert.match(serialized, /型号12/);
});
