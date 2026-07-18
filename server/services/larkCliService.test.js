import assert from "node:assert/strict";
import test from "node:test";
import { reportXml } from "./larkCliService.js";

test("Feishu document rows keep account price channels independent", () => {
  const xml = reportXml({
    accountType: "gift",
    shopName: "测试&店铺",
    model: "GIFT-1",
    url: "https://detail.tmall.com/item.htm?id=1",
    skuMonitorPrices: { gift1: 75 },
  }, {
    capturedAt: "2026-07-12T08:00:00.000Z",
    accessMode: "authenticated",
    skuPrices: [{
      skuId: "gift1",
      name: "礼金款",
      normalPrice: 79,
      seckillPrice: 75,
      seckillStatus: "available",
      billionPrice: null,
      billionStatus: "none",
      giftPrice: 69,
      giftStatus: "available",
      surprisePrice: null,
      vipPrice: null,
      coinPrice: null,
      coinStatus: "none",
      resolutionStatus: "verified",
      priceResolution: {
        status: "verified",
        channels: {
          seckill: { status: "verified", valueCents: 7500, evidenceIds: ["seckill"] },
          billion: { status: "unavailable", valueCents: null, evidenceIds: [] },
        },
      },
    }],
  });

  assert.match(xml, /测试&amp;店铺/);
  assert.match(xml, /<b>价格身份：<\/b>礼金账号/);
  assert.match(xml, /¥79\.00/);
  assert.match(xml, /淘宝秒杀价/);
  assert.match(xml, /¥75\.00/);
  assert.match(xml, /百亿补贴价/);
  assert.match(xml, /无百亿补贴/);
  assert.match(xml, /¥69\.00/);
  assert.match(xml, /不适用/);
  assert.match(xml, /无淘金币/);
  assert.doesNotMatch(xml, /NaN/);
});
