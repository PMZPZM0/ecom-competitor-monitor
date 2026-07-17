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
