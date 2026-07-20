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
          normal: { status: "verified", valueCents: 7900, evidenceIds: ["normal"] },
          seckill: { status: "verified", valueCents: 7500, evidenceIds: ["seckill"] },
          billion: { status: "unavailable", valueCents: null, evidenceIds: [] },
          gift: { status: "verified", valueCents: 6900, evidenceIds: ["gift"] },
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

test("Feishu document identifies a verified normal-account new-customer gift", () => {
  const xml = reportXml({
    accountType: "normal",
    shopName: "新客店铺",
    model: "NEW-1",
    url: "https://detail.tmall.com/item.htm?id=2",
  }, {
    capturedAt: "2026-07-20T08:00:00.000Z",
    accessMode: "authenticated",
    primaryAccountType: "normal",
    skuPrices: [{
      skuId: "new-gift",
      name: "新客款",
      normalPrice: 139,
      giftPrice: 1,
      giftStatus: "available",
      resolutionStatus: "verified",
      priceResolution: {
        status: "verified",
        promotions: [{ code: "coupon2RedForNewUser", kind: "gift", label: "新客礼金" }],
        channels: {
          normal: { status: "verified", valueCents: 13900, evidenceIds: ["normal"] },
          gift: { status: "verified", valueCents: 11300, label: "新客礼金价", evidenceIds: ["gift"] },
        },
      },
    }],
  });

  assert.match(xml, /<b>价格身份：<\/b>普通账号/);
  assert.match(xml, /新客礼金价 ¥113\.00/);
  assert.doesNotMatch(xml, /¥1\.00/);
});

test("Feishu document does not display a restricted first-order gift from a stale field", () => {
  const xml = reportXml({
    accountType: "normal",
    url: "https://detail.tmall.com/item.htm?id=3",
  }, {
    accessMode: "authenticated",
    primaryAccountType: "normal",
    skuPrices: [{
      skuId: "first-order-gift",
      normalPrice: 139,
      giftPrice: 99,
      giftStatus: "none",
      resolutionStatus: "verified",
      priceResolution: {
        status: "verified",
        promotions: [{ code: "1", kind: "gift", label: "首单礼金" }],
        channels: {
          normal: { status: "verified", valueCents: 13900, evidenceIds: ["normal"] },
          gift: { status: "verified", valueCents: 9900, label: "首单礼金价", evidenceIds: ["stale-gift"] },
        },
      },
    }],
  });

  assert.match(xml, /不适用/);
  assert.doesNotMatch(xml, /¥99\.00/);
});
