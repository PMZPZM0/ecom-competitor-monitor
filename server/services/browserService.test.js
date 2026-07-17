import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCommandMatchesContext,
  browserRuntimeInfo,
  canReuseBrowser,
  classifyTaobaoSessionCheck,
  cookieHeaderForUrls,
  findAvailableBrowserPort,
  isBuyerShowResponseUrl,
  isTaobaoLoginDocument,
  isTaobaoLoginUrl,
  shouldPreserveCaptureCache,
  skuIdFromNetworkBody,
  skuIdFromNetworkUrl,
  taobaoCookieStateForUrls,
} from "./browserService.js";

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
  assert.equal(isTaobaoLoginUrl("https://passport.taobao.com/ac/password_find.htm"), true);
  assert.equal(isTaobaoLoginUrl("https://login.m.tmall.com/login.htm"), true);
  assert.equal(isTaobaoLoginUrl("https://detail.tmall.com/item.htm?id=1"), false);
  assert.equal(isTaobaoLoginUrl("https://detail.tmall.com/login-promotion.htm?id=1"), false);
});

test("local browser capture preserves the user's normal cache", () => {
  assert.equal(shouldPreserveCaptureCache({ localCapture: true }), true);
  assert.equal(shouldPreserveCaptureCache({ preserveCache: true }), true);
  assert.equal(shouldPreserveCaptureCache({}), false);
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
  assert.equal(isTaobaoLoginDocument("https://detail.tmall.com/item.htm?id=1", "<script>window.skuCore = {}</script><div hidden>安全验证</div>"), false);
  assert.equal(isTaobaoLoginDocument("https://i.taobao.com/my_taobao.htm", "我的淘宝"), false);
});

test("session checks distinguish explicit expiry from temporary degradation", () => {
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: true, hasCookie: true, loginPage: false }), "valid");
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: false, hasCookie: false, loginPage: true, explicitLogin: true }), "expired");
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: true, hasCookie: true, loginPage: true, explicitLogin: true }), "expired");
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: false, hasCookie: false, loginPage: true }), "degraded");
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: true, hasCookie: true, loginPage: true }), "degraded");
  assert.equal(classifyTaobaoSessionCheck({ authLoggedIn: false, hasCookie: false, loginPage: false }), "degraded");
});

test("cookie headers are URL scoped and de-duplicate cookie names", () => {
  const now = Date.parse("2026-07-16T00:00:00.000Z");
  const cookies = [
    { name: "sid", value: "broad", domain: ".taobao.com", path: "/", secure: true },
    { name: "sid", value: "exact", domain: "i.taobao.com", path: "/", secure: true },
    { name: "tmallOnly", value: "skip", domain: ".tmall.com", path: "/", secure: true },
    { name: "expired", value: "skip", domain: ".taobao.com", path: "/", secure: true, expires: now / 1000 - 1 },
    { name: "tracknick", value: "tester", domain: ".taobao.com", path: "/", secure: true },
  ];
  const header = cookieHeaderForUrls(cookies, ["https://i.taobao.com/my_taobao.htm"], now);
  assert.equal(header, "sid=exact; tracknick=tester");
});

test("Tmall request cookies stay scoped while Taobao identity remains valid", () => {
  const cookies = [
    { name: "tracknick", value: "signed-in", domain: ".taobao.com", path: "/", secure: true },
    { name: "_m_h5_tk", value: "tmall-token", domain: ".tmall.com", path: "/", secure: true },
    { name: "tmall_pref", value: "target-only", domain: "detail.tmall.com", path: "/", secure: true },
  ];
  const state = taobaoCookieStateForUrls(cookies, ["https://detail.tmall.com/item.htm?id=1"]);
  assert.equal(state.loggedIn, true);
  assert.equal(state.nickname, "signed-in");
  assert.equal(state.cookie, "tmall_pref=target-only; _m_h5_tk=tmall-token");
  assert.doesNotMatch(state.cookie, /tracknick/);
});

test("browser command ownership requires both the expected profile and port", () => {
  const context = { profilePath: "C:\\Users\\tester\\account-profiles\\account_a", port: 9517 };
  const command = 'chrome.exe --remote-debugging-port=9517 --user-data-dir="C:\\Users\\tester\\account-profiles\\account_a" --start-minimized';
  assert.equal(browserCommandMatchesContext(command, context), true);
  assert.equal(browserCommandMatchesContext(command, { ...context, port: 9518 }), false);
  assert.equal(browserCommandMatchesContext(command, { ...context, profilePath: "C:\\Users\\tester\\account-profiles\\account_b" }), false);
});

test("browser port allocation skips reserved and occupied ports", async () => {
  const checked = [];
  const port = await findAvailableBrowserPort([9300], {
    start: 9300,
    end: 9303,
    random: () => 0,
    isAvailable: async (candidate) => {
      checked.push(candidate);
      return candidate === 9302;
    },
  });
  assert.equal(port, 9302);
  assert.deepEqual(checked, [9301, 9302]);
});

test("account browsers remain persistent after capture", () => {
  assert.equal(browserRuntimeInfo().captureBrowserIdleMs, 0);
});
