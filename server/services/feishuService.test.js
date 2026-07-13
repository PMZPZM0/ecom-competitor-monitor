import assert from "node:assert/strict";
import test from "node:test";
import { buildPriceCard, effectivePriceForSku, publicFeishuConfig, updateFeishuConfig } from "./feishuService.js";

test("Feishu cooldown switch defaults on and persists an explicit off state", () => {
  assert.equal(publicFeishuConfig({}).cooldownEnabled, true);
  const updated = updateFeishuConfig({ cooldownMinutes: 120 }, { cooldownEnabled: false });
  assert.equal(updated.cooldownEnabled, false);
  assert.equal(publicFeishuConfig(updated).cooldownEnabled, false);
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
          { skuId: "sku1", name: "白色款", price: 90, normalPrice: 90, coinPrice: 88 },
          { skuId: "sku2", name: "黑色款", price: 220, normalPrice: 220, coinPrice: null },
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
      skuPrices: [{ skuId: "gift1", name: "礼金款", price: 79, normalPrice: 79, giftPrice: 69, surprisePrice: null, vipPrice: null, coinPrice: null, giftStatus: "available", surpriseStatus: "none", vipStatus: "none", coinStatus: "none" }],
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
  assert.match(serialized, /无淘金币/);
  assert.deepEqual(effectivePriceForSku(product.lastSnapshot.skuPrices[0], "gift"), { label: "礼金价", value: 69 });
});

test("effective price follows normal to surprise to coin chain", () => {
  const sku = { price: 529, normalPrice: 529, surprisePrice: 489, coinPrice: 479.91 };
  assert.deepEqual(effectivePriceForSku(sku, "normal"), { label: "淘金币价", value: 479.91 });
  assert.deepEqual(effectivePriceForSku({ price: 529, normalPrice: 529, surprisePrice: 489 }, "normal"), { label: "惊喜立减价", value: 489 });
  assert.deepEqual(effectivePriceForSku({ price: 529, normalPrice: 529 }, "normal"), { label: "普通价", value: 529 });
});

test("large Feishu cards keep SKUs beyond the visual price grid", () => {
  const skuPrices = Array.from({ length: 12 }, (_, index) => ({ skuId: `sku${index + 1}`, name: `型号${index + 1}`, price: 100 + index, normalPrice: 100 + index }));
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
