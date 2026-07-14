import assert from "node:assert/strict";
import test from "node:test";
import { canReuseBrowser, isBuyerShowResponseUrl, isTaobaoLoginDocument, isTaobaoLoginUrl, skuIdFromNetworkBody, skuIdFromNetworkUrl } from "./browserService.js";

test("buyer-show response classifier ignores unrelated generic feeds", () => {
  assert.equal(isBuyerShowResponseUrl("https://h5api.m.tmall.com/h5/mtop.taobao.rate.detaillist.get/6.0/"), true);
  assert.equal(isBuyerShowResponseUrl("https://h5api.m.tmall.com/h5/mtop.taobao.social.feed.list/1.0/"), false);
});

test("background capture reuses a visible account browser without mode restart", () => {
  assert.equal(canReuseBrowser(false, true), true);
  assert.equal(canReuseBrowser(true, true), true);
  assert.equal(canReuseBrowser(true, false), false);
  assert.equal(canReuseBrowser(false, false), true);
});

test("skuIdFromNetworkUrl reads the exact SKU from pcdetail adjust requests", () => {
  const data = encodeURIComponent(JSON.stringify({ id: "123", exParams: JSON.stringify({ skuId: "6198474471058", modules: "skuClick" }) }));
  assert.equal(skuIdFromNetworkUrl(`https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`), "6198474471058");
  assert.equal(skuIdFromNetworkUrl("https://example.com/no-data"), "");
});

test("skuIdFromNetworkBody uses the authoritative pcdetail response SKU", () => {
  const body = JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { skuId: "6198474471057" } } } } });
  assert.equal(skuIdFromNetworkBody(body), "6198474471057");
  assert.equal(skuIdFromNetworkBody(JSON.stringify({ data: { skuId: "wrong-level" } })), "");
});

test("isTaobaoLoginUrl recognizes Taobao login redirects", () => {
  assert.equal(isTaobaoLoginUrl("https://login.taobao.com/havanaone/login/login.htm?redirectURL=x"), true);
  assert.equal(isTaobaoLoginUrl("https://detail.tmall.com/item.htm?id=1"), false);
});

test("isTaobaoLoginDocument rejects login and verification pages", () => {
  assert.equal(isTaobaoLoginDocument("https://i.taobao.com/my_taobao.htm", "手机扫码登录"), true);
  const detailLoginBridge = `
    <script>
      localStorage.x5referer = window.location.href;
      const jump = "/wow/z/app/tbpc/pc-detail-ssr-2025/home/page/login_jump";
      window.WindVane.call("aluWVJSBridge", "sdkLogin", {});
      const config = { "action": "login" };
    </script>
  `;
  assert.equal(isTaobaoLoginDocument("https://detail.tmall.com/item.htm?id=1", detailLoginBridge), true);
  assert.equal(isTaobaoLoginDocument("https://detail.tmall.com/item.htm?id=1", `${detailLoginBridge}<script>window.skuCore = {}</script>`), false);
  assert.equal(isTaobaoLoginDocument("https://i.taobao.com/my_taobao.htm", "我的淘宝"), false);
});
