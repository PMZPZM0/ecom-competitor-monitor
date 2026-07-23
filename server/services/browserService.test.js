import assert from "node:assert/strict";
import test from "node:test";
import {
  browserCommandMatchesContext,
  browserRuntimeInfo,
  canReuseBrowser,
  captureRequestedSkuSelections,
  classifyPassiveTaobaoSession,
  classifyTaobaoSessionCheck,
  classifyTaobaoIdentityProbe,
  cookieHeaderForUrls,
  createTaobaoAccessRestrictedError,
  evaluateBrowserPage,
  findAvailableBrowserPort,
  itemIdFromNetworkBody,
  itemIdFromNetworkUrl,
  isBuyerShowResponseUrl,
  isTaobaoAccessRestrictedDocument,
  isTaobaoLoginDocument,
  isTaobaoIdentityLoginUrl,
  isTaobaoLoginUrl,
  isTmallLoginPageUrl,
  isTmallSilentLoginResponse,
  isTrustedTmallSilentLoginResponse,
  listBrowserEngines,
  shouldCaptureNetworkResponse,
  shouldPreserveCaptureCache,
  shouldRefreshTmallSso,
  selectReusableCaptureTarget,
  skuIdFromNetworkBody,
  skuIdFromNetworkUrl,
  taobaoCookieStateForUrls,
  tmallSsoSyncUrlsFromSilentLogin,
  refreshTmallSsoFromCapturedLogin,
  requestTmallSilentLoginBridge,
  waitForBrowserCaptureSignal,
  waitForBrowserDocumentSignal,
} from "./browserService.js";

test("capture work tabs reuse the exact product, then another product or blank, but never a login page", () => {
  const target = (id, url, type = "page") => ({ id, url, type, webSocketDebuggerUrl: `ws://127.0.0.1/${id}` });
  const targets = [
    target("login", "https://login.taobao.com/member/login.jhtml"),
    target("blank", "about:blank"),
    target("other", "https://detail.tmall.com/item.htm?id=760234834628"),
    target("exact", "https://item.taobao.com/item.htm?id=1059717807069"),
  ];

  assert.deepEqual(selectReusableCaptureTarget(targets, "https://detail.tmall.com/item.htm?id=1059717807069"), {
    target: targets[3],
    reuseLoadedDocument: true,
  });
  assert.deepEqual(selectReusableCaptureTarget(targets.slice(0, 3), "https://detail.tmall.com/item.htm?id=1059717807069"), {
    target: targets[2],
    reuseLoadedDocument: false,
  });
  assert.deepEqual(selectReusableCaptureTarget(targets.slice(0, 2), "https://detail.tmall.com/item.htm?id=1059717807069"), {
    target: targets[1],
    reuseLoadedDocument: false,
  });
  assert.equal(selectReusableCaptureTarget([targets[0]], "https://detail.tmall.com/item.htm?id=1059717807069"), null);
});

test("browser selection defaults to UC without exposing or falling back to Google", () => {
  const catalog = listBrowserEngines();
  assert.equal(catalog.defaultEngine, "uc");
  assert.deepEqual(catalog.engines.map((engine) => engine.id), ["uc", "360", "qq", "sogou", "edge"]);
  assert.equal(catalog.engines.some((engine) => "executablePath" in engine || "env" in engine), false);
});

test("one SKU runtime timeout does not erase successful sibling selections", async () => {
  let responseSequence = 0;
  let calls = 0;
  const observedTimeouts = [];
  const cdp = {
    async send(method, params, timeoutMs) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /hydrationDeadline = Date\.now\(\) \+ 1500/);
      assert.match(params.expression, /interactionDeadline = Date\.now\(\) \+ 6000/);
      assert.match(params.expression, /pointer\('pointerdown'\)/);
      assert.match(params.expression, /dispatchEvent\(new MouseEvent\('mousedown'/);
      assert.match(params.expression, /pointer\('pointerup'\)/);
      assert.match(params.expression, /clickable\.click\(\)/);
      observedTimeouts.push(timeoutMs);
      calls += 1;
      if (calls === 2) throw new Error("CDP 调用超时：Runtime.evaluate");
      responseSequence += 1;
      return { result: { value: { selected: true, clicked: [String(calls)] } } };
    },
  };

  const results = await captureRequestedSkuSelections({
    cdp,
    requestedSelections: [
      { skuId: "sku-success-before", valueIds: ["1"] },
      { skuId: "sku-timeout", valueIds: ["2"] },
      { skuId: "sku-success-after", valueIds: ["3"] },
      { skuId: "sku-missing-path", valueIds: [] },
    ],
    captureRunId: "selection-run",
    getResponseSequence: () => responseSequence,
    responseTimeoutMs: 0,
    responseSettleMs: 0,
    warmupSelection: false,
  });

  assert.equal(calls, 3);
  assert.deepEqual(observedTimeouts, [8000, 8000, 8000]);
  assert.deepEqual(results.map(({ skuId, reason }) => ({ skuId, reason })), [
    { skuId: "sku-success-before", reason: "response-received" },
    { skuId: "sku-timeout", reason: "runtime-timeout" },
    { skuId: "sku-success-after", reason: "response-received" },
    { skuId: "sku-missing-path", reason: "missing-selection-ids" },
  ]);
});

test("SKU capture keeps waiting until delayed responses become quiet", async () => {
  let clock = 0;
  let responseSequence = 0;
  let waitCount = 0;
  const cdp = {
    async send() {
      return { result: { value: { selected: true, clicked: ["1"] } } };
    },
  };
  const results = await captureRequestedSkuSelections({
    cdp,
    requestedSelections: [{ skuId: "sku-delayed-complete", valueIds: ["1"] }],
    captureRunId: "selection-delayed-run",
    getResponseSequence: () => responseSequence,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
      waitCount += 1;
      if (waitCount === 1) responseSequence = 1;
      if (waitCount === 5) responseSequence = 2;
    },
    responseTimeoutMs: 3000,
    responseSettleMs: 900,
  });

  assert.equal(results[0].responseReceivedAfterSelection, true);
  assert.equal(results[0].responseSequenceStartExclusive, 0);
  assert.equal(results[0].responseSequenceEndInclusive, 2);
  assert.equal(clock, 1400);
});

test("SKU warmup reuses the last SKU response and DOM snapshot in ordered results", async () => {
  let responseSequence = 0;
  const selectedValueIds = [];
  const snapshots = [];
  const cdp = {
    async send(_method, params) {
      const valueId = ["first", "second", "third", "last"].find((value) => params.expression.includes(`"${value}"`));
      assert.ok(valueId);
      selectedValueIds.push(valueId);
      responseSequence += 1;
      return { result: { value: { selected: true, clicked: [valueId] } } };
    },
  };
  const results = await captureRequestedSkuSelections({
    cdp,
    requestedSelections: [
      { skuId: "sku-first", valueIds: ["first"] },
      { skuId: "sku-second", valueIds: ["second"] },
      { skuId: "sku-third", valueIds: ["third"] },
      { skuId: "sku-last", valueIds: ["last"] },
    ],
    captureRunId: "selection-warmup-run",
    getResponseSequence: () => responseSequence,
    captureSelectedDocument: async (selection) => snapshots.push(selection),
    responseTimeoutMs: 0,
    responseSettleMs: 0,
  });

  assert.deepEqual(selectedValueIds, ["last", "first", "second", "third"]);
  assert.deepEqual(snapshots.map((item) => ({
    skuId: item.skuId,
    responseSequenceStartExclusive: item.responseSequenceStartExclusive,
    responseSequenceEndInclusive: item.responseSequenceEndInclusive,
  })), [
    { skuId: "sku-last", responseSequenceStartExclusive: 0, responseSequenceEndInclusive: 1 },
    { skuId: "sku-first", responseSequenceStartExclusive: 1, responseSequenceEndInclusive: 2 },
    { skuId: "sku-second", responseSequenceStartExclusive: 2, responseSequenceEndInclusive: 3 },
    { skuId: "sku-third", responseSequenceStartExclusive: 3, responseSequenceEndInclusive: 4 },
  ]);
  assert.deepEqual(results.map((item) => ({
    skuId: item.skuId,
    responseSequenceStartExclusive: item.responseSequenceStartExclusive,
    responseSequenceEndInclusive: item.responseSequenceEndInclusive,
    responseReceivedAfterSelection: item.responseReceivedAfterSelection,
    documentCaptured: item.documentCaptured,
  })), [
    {
      skuId: "sku-first",
      responseSequenceStartExclusive: 1,
      responseSequenceEndInclusive: 2,
      responseReceivedAfterSelection: true,
      documentCaptured: true,
    },
    {
      skuId: "sku-second",
      responseSequenceStartExclusive: 2,
      responseSequenceEndInclusive: 3,
      responseReceivedAfterSelection: true,
      documentCaptured: true,
    },
    {
      skuId: "sku-third",
      responseSequenceStartExclusive: 3,
      responseSequenceEndInclusive: 4,
      responseReceivedAfterSelection: true,
      documentCaptured: true,
    },
    {
      skuId: "sku-last",
      responseSequenceStartExclusive: 0,
      responseSequenceEndInclusive: 1,
      responseReceivedAfterSelection: true,
      documentCaptured: true,
    },
  ]);
});

test("each selected SKU captures its DOM before the next selection even without a price response", async () => {
  const events = [];
  const documents = [];
  const cdp = {
    async send(_method, params) {
      const valueId = params.expression.includes('"first"') ? "first" : "second";
      events.push(`select:${valueId}`);
      return { result: { value: { selected: true, clicked: [valueId] } } };
    },
  };

  const results = await captureRequestedSkuSelections({
    cdp,
    requestedSelections: [
      { skuId: "sku-first", valueIds: ["first"] },
      { skuId: "sku-second", valueIds: ["second"] },
    ],
    captureRunId: "selection-dom-run",
    getResponseSequence: () => 0,
    captureSelectedDocument: async (selection) => {
      events.push(`capture:${selection.skuId}`);
      documents.push({
        ...selection,
        html: `<html data-sku="${selection.skuId}"></html>`,
        visibleText: `SKU ${selection.skuId}`,
      });
    },
    responseTimeoutMs: 0,
    responseSettleMs: 0,
    warmupSelection: false,
  });

  assert.deepEqual(events, [
    "select:first",
    "capture:sku-first",
    "select:second",
    "capture:sku-second",
  ]);
  assert.deepEqual(documents.map((document) => document.skuId), ["sku-first", "sku-second"]);
  assert.deepEqual(results.map((result) => ({
    skuId: result.skuId,
    selected: result.selected,
    responseReceivedAfterSelection: result.responseReceivedAfterSelection,
    documentCaptured: result.documentCaptured,
    reason: result.reason,
  })), [
    {
      skuId: "sku-first",
      selected: true,
      responseReceivedAfterSelection: false,
      documentCaptured: true,
      reason: "document-captured",
    },
    {
      skuId: "sku-second",
      selected: true,
      responseReceivedAfterSelection: false,
      documentCaptured: true,
      reason: "document-captured",
    },
  ]);
});

test("browser capture continues immediately when the matching response arrives", async () => {
  const handlers = new Map();
  const cdp = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  const ready = waitForBrowserCaptureSignal(cdp, {
    timeoutMs: 1000,
    responseMatches: ({ response }) => /pcdetail/.test(response.url),
  });
  handlers.get("Network.responseReceived")({ response: { url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/" } });
  assert.equal(await ready, "matching-response");
  assert.equal(handlers.size, 0);
});

test("browser document readiness waits for a page lifecycle event", async () => {
  const handlers = new Map();
  const cdp = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  const ready = waitForBrowserDocumentSignal(cdp, { timeoutMs: 1000 });
  handlers.get("Page.domContentEventFired")({});
  assert.equal(await ready, "dom-content-loaded");
  assert.equal(handlers.size, 0);
});

test("browser page evaluation retries transient navigation failures only", async () => {
  let calls = 0;
  const waits = [];
  const result = await evaluateBrowserPage({
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      calls += 1;
      if (calls === 1) throw new Error("Execution context was destroyed, most likely because of a navigation.");
      return { result: { value: "ready" } };
    },
  }, { expression: "document.readyState", returnByValue: true }, {
    attempts: 3,
    retryDelayMs: 250,
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(result.result.value, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);

  await assert.rejects(evaluateBrowserPage({
    async send() {
      throw new Error("JavaScript exception");
    },
  }, { expression: "broken()" }, { attempts: 3, stage: "测试读取", wait: async () => undefined }), /测试读取失败：JavaScript exception/);
});

test("capture ignores silent-login JSONP so price collection cannot mutate the account session", () => {
  assert.equal(shouldCaptureNetworkResponse({
    url: "https://login.taobao.com/newlogin/silentHasLogin.do?callback=x",
    mimeType: "application/javascript",
    status: 200,
  }, "Script"), false);
  assert.equal(shouldCaptureNetworkResponse({
    url: "https://example.com/unrelated.js",
    mimeType: "application/javascript",
    status: 200,
  }, "Script"), false);
  assert.equal(shouldCaptureNetworkResponse({
    url: "https://login.taobao.com/newlogin/silentHasLogin.do?callback=x",
    mimeType: "application/javascript",
    status: 403,
  }, "Script"), false);
});

test("Tmall SSO bridge accepts only official one-time same-browser endpoints", () => {
  const body = `callback({"content":{"data":{"asyncUrls":[
    "https://pass.tmall.com/add?token=secret",
    "https://pass.tmall.hk/add?token=secret",
    "https://pass.tmall.com.evil.example/add?token=secret",
    "http://pass.tmall.com/add?token=secret",
    "https://pass.tmall.com/other?token=secret"
  ]}}})`;
  assert.deepEqual(tmallSsoSyncUrlsFromSilentLogin(body).map((value) => new URL(value).hostname), [
    "pass.tmall.com",
    "pass.tmall.hk",
  ]);
  assert.deepEqual(tmallSsoSyncUrlsFromSilentLogin("not-json"), []);
  assert.equal(isTrustedTmallSilentLoginResponse("https://login.taobao.com/newlogin/silentHasLogin.do?callback=x"), true);
  assert.equal(isTrustedTmallSilentLoginResponse("https://login.taobao.com.evil.example/newlogin/silentHasLogin.do"), false);
});

test("Tmall SSO bridge is consumed only inside the current browser target", async () => {
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Network.getResponseBody") {
        return { body: 'callback({"content":{"data":{"asyncUrls":["https://pass.tmall.com/add?token=one-time"]}}})' };
      }
      if (method === "Runtime.evaluate") return { result: { value: true } };
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };
  const refreshed = await refreshTmallSsoFromCapturedLogin(cdp, new Map([
    ["trusted", { url: "https://login.taobao.com/newlogin/silentHasLogin.do?callback=x" }],
    ["ignored", { url: "https://login.taobao.com.evil.example/newlogin/silentHasLogin.do" }],
  ]));
  assert.equal(refreshed, true);
  assert.deepEqual(calls.map(({ method }) => method), ["Network.getResponseBody", "Runtime.evaluate"]);
  assert.match(calls[1].params.expression, /https:\/\/pass\.tmall\.com\/add/);
  assert.doesNotMatch(calls[1].params.expression, /evil\.example/);
});

test("a missing Tmall bridge is requested by the authorized browser, never by Node", async () => {
  let expression = "";
  await requestTmallSilentLoginBridge({
    async send(method, params) {
      assert.equal(method, "Runtime.evaluate");
      expression = params.expression;
      return { result: { value: true } };
    },
  });
  assert.match(expression, /script\.src = 'https:\/\/login\.taobao\.com\/newlogin\/silentHasLogin\.do'/);
  assert.doesNotMatch(expression, /fetch\s*\(/);
});

test("Tmall SSO refresh retries degraded price access immediately without rebuilding the browser", () => {
  const now = Date.parse("2026-07-22T08:00:00.000Z");
  assert.equal(shouldRefreshTmallSso({ tmallPriceStatus: "degraded" }, { now }), true);
  assert.equal(shouldRefreshTmallSso({ tmallPriceStatus: "degraded" }, { now, lastRefreshAt: now - 60 * 1000 }), true);
  assert.equal(shouldRefreshTmallSso({ tmallPriceStatus: "degraded" }, { now, lastRefreshAt: now - 11 * 60 * 1000 }), true);
  assert.equal(shouldRefreshTmallSso({
    tmallPriceStatus: "valid",
    tmallPriceCheckedAt: "2026-07-22T07:00:00.000Z",
  }, { now }), false);
});

test("Tmall silent-login bridges stay out of persisted capture payloads", () => {
  assert.equal(isTmallSilentLoginResponse("https://login.taobao.com/newlogin/silentHasLogin.do"), true);
  assert.equal(isTmallSilentLoginResponse("https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/"), false);
});

test("stale Tmall login cleanup matches only the exact secure login page", () => {
  assert.equal(isTmallLoginPageUrl("https://login.tmall.com/?redirectURL=x"), true);
  assert.equal(isTmallLoginPageUrl("http://login.tmall.com/?redirectURL=x"), false);
  assert.equal(isTmallLoginPageUrl("https://login.tmall.com.evil.example/"), false);
  assert.equal(isTmallLoginPageUrl("https://detail.tmall.com/item.htm?id=1"), false);
  assert.equal(isTmallLoginPageUrl("https://login.taobao.com/member/login.jhtml"), false);
});

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
  const data = encodeURIComponent(JSON.stringify({ itemId: "843315272519", exParams: JSON.stringify({ skuId: "6198474471058", modules: "skuClick" }) }));
  assert.equal(skuIdFromNetworkUrl(`https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`), "6198474471058");
  assert.equal(itemIdFromNetworkUrl(`https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`), "843315272519");
  assert.equal(skuIdFromNetworkUrl("https://example.com/no-data"), "");
  assert.equal(itemIdFromNetworkUrl("https://example.com/no-data"), "");
});

test("skuIdFromNetworkBody uses the authoritative pcdetail response SKU", () => {
  const body = JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId: "843315272519", skuId: "6198474471057" } } } } });
  assert.equal(skuIdFromNetworkBody(body), "6198474471057");
  assert.equal(itemIdFromNetworkBody(body), "843315272519");
  assert.equal(skuIdFromNetworkBody(JSON.stringify({ data: { skuId: "wrong-level" } })), "");
  assert.equal(itemIdFromNetworkBody(JSON.stringify({ data: { itemId: "wrong-level" } })), "");
});

test("network body identity falls back to a self-identifying UMP price map", () => {
  const itemId = "1065716131860";
  const skuId = "6115959029488";
  const body = JSON.stringify({ data: { componentsVO: { umpPriceLogVO: {
    xobjectId: itemId,
    sid: skuId,
    map: `{${skuId}:{"price1":"909.00","price2":"599.00"}}`,
  } } } });
  assert.equal(itemIdFromNetworkBody(body), itemId);
  assert.equal(skuIdFromNetworkBody(body), skuId);
  assert.equal(skuIdFromNetworkBody(body.replace(`{${skuId}:`, "{different:")), "");
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
  assert.equal(shouldPreserveCaptureCache({ localCapture: true, preserveCache: false }), false);
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
  const restricted = "您的账户近期访问行为存在异常，涉嫌不当获取使用平台商业信息，系统将限制该账号的部分访问功能。";
  assert.equal(isTaobaoAccessRestrictedDocument(restricted), true);
  assert.equal(isTaobaoLoginDocument("https://detail.tmall.com/item.htm?id=1", `<script>window.skuCore = {}</script>${restricted}`), true);
  assert.equal(isTaobaoAccessRestrictedDocument("正常商品页面，访问与售后服务说明"), false);
  const now = Date.parse("2026-07-19T16:00:00+08:00");
  const restriction = createTaobaoAccessRestrictedError(`${restricted} 预计 2026-07-19 17时 后恢复正常。`, now);
  assert.equal(restriction.code, "TAOBAO_ACCESS_RESTRICTED");
  assert.equal(restriction.retryAfterMs, 65 * 60_000);
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

test("passive account checks do not treat a stale login tab as a logged-out profile", () => {
  assert.equal(classifyPassiveTaobaoSession({
    authLoggedIn: true,
    hasCookie: true,
    loginPageOpen: true,
  }), "valid");
  assert.equal(classifyPassiveTaobaoSession({
    authLoggedIn: false,
    hasCookie: false,
    loginPageOpen: true,
  }), "expired");
  assert.equal(classifyPassiveTaobaoSession({ browserClosed: true }), "degraded");
});

test("passive account checks treat a real My Taobao login redirect as expired even with stale cookies", () => {
  const identityLoginUrl = "https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&redirectURL=https%3A%2F%2Fi.taobao.com%2Fmy_itaobao";
  assert.equal(isTaobaoIdentityLoginUrl(identityLoginUrl), true);
  assert.equal(isTaobaoIdentityLoginUrl("https://login.taobao.com/member/login.jhtml"), false);
  assert.equal(classifyPassiveTaobaoSession({
    authLoggedIn: true,
    hasCookie: true,
    loginPageOpen: true,
    identityLoginRedirect: true,
  }), "expired");
});

test("a real identity-page login redirect overrides stale cookies", () => {
  const staleAuthState = { loggedIn: true, cookie: "stale-cookie" };
  assert.equal(classifyTaobaoIdentityProbe({
    authState: staleAuthState,
    finalUrl: "https://login.taobao.com/havanaone/login/login.htm?redirectURL=https%3A%2F%2Fi.taobao.com%2Fmy_itaobao",
    visibleText: "登录页面 密码登录 短信登录",
  }), "expired");
  assert.equal(classifyTaobaoIdentityProbe({
    authState: staleAuthState,
    finalUrl: "https://i.taobao.com/my_itaobao",
    visibleText: "我的淘宝",
  }), "valid");
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
  assert.equal(browserCommandMatchesContext(command, { ...context, profilePath: "C:\\Users\\tester\\account-profiles\\account" }), false);
});

test("browser command ownership normalizes native command quoting and path aliases", () => {
  const windowsContext = { profilePath: "C:\\Users\\Tester\\account-profiles\\account_a", port: 9517 };
  const windowsCommand = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:/Users/tester/account-profiles/alias/../account_a" --remote-debugging-port=9517';
  assert.equal(browserCommandMatchesContext(windowsCommand, windowsContext), true);

  const macContext = { profilePath: "/Users/tester/Library/Application Support/ecom/account_a", port: 9517 };
  const macCommand = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/tester/Library/Application\\ Support/ecom/profiles/../account_a --remote-debugging-port=9517";
  assert.equal(browserCommandMatchesContext(macCommand, macContext), true);
});

test("browser command ownership rejects ambiguous duplicate switches", () => {
  const context = { profilePath: "C:\\Users\\tester\\account-profiles\\account_a", port: 9517 };
  assert.equal(browserCommandMatchesContext(
    'chrome.exe --remote-debugging-port=9517 --user-data-dir="C:\\Users\\tester\\account-profiles\\account_a" --remote-debugging-port=9518',
    context,
  ), false);
  assert.equal(browserCommandMatchesContext(
    'chrome.exe --remote-debugging-port=9517 --user-data-dir="C:\\Users\\tester\\account-profiles\\account_a" --user-data-dir="C:\\Users\\tester\\account-profiles\\account_b"',
    context,
  ), false);
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
