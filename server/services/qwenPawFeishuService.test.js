import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeQwenPawAlerts,
  normalizeQwenPawFeishuTargets,
  qwenPawLoginExpiredMessage,
  qwenPawThresholdMessage,
} from "./qwenPawFeishuService.js";

test("QwenPaw Feishu targets accept only complete native Feishu chat identities", () => {
  const targets = normalizeQwenPawFeishuTargets([
    { channel: "feishu", userId: "ou_a", sessionId: "p2p_1" },
    { channel: "feishu", userId: "ou_a", sessionId: "p2p_1" },
    { channel: "console", userId: "user", sessionId: "session" },
    { channel: "feishu", userId: "", sessionId: "missing" },
  ]);
  assert.deepEqual(targets, [{ channel: "feishu", userId: "ou_a", sessionId: "p2p_1" }]);
  assert.deepEqual(normalizeQwenPawAlerts({ belowThresholdTargets: targets }), {
    belowThresholdTargets: targets,
    loginExpiredTargets: [],
  });
});

test("QwenPaw messages retain verified price facts and do not substitute historical values", () => {
  const text = qwenPawThresholdMessage({
    accountType: "vip88",
    product: { name: "压力锅", shopName: "测试店", url: "https://detail.tmall.com/item.htm?id=1" },
    items: [{ skuId: "sku-a", skuName: "5L", channel: "gift", priceLabel: "礼金价", event: "new-low", priceCents: 9989, thresholdCents: 10000 }],
  });
  assert.match(text, /礼金价 ¥99\.89 < 监控价 ¥100\.00/);
  assert.match(text, /继续降价/);
  assert.match(text, /本地已验证快照/);
  assert.match(qwenPawLoginExpiredMessage({ session: { name: "88VIP 主账号", accountType: "vip88" } }), /88VIP 主账号/);
});
