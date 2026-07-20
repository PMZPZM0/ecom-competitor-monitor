import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-browser-local-capture-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const { buildBrowserCaptureEvidence, scrapeTmallProduct } = await import("./tmallScraper.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("Tmall scraper has no Node-side network escape hatch", async () => {
  const source = await fs.readFile(new URL("./tmallScraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "淘宝/天猫数据只能由账号浏览器采集后落盘解析");
});

test("browser service Node network calls only target local Chrome DevTools", async () => {
  const source = await fs.readFile(new URL("./browserService.js", import.meta.url), "utf8");
  const lines = source.split(/\r?\n/);
  const getJsonDeclaration = lines.findIndex((line) => line.trim() === "async function getJson(url) {");
  const delegatedFetch = lines.findIndex((line, index) => index > getJsonDeclaration && line.trim() === "const response = await fetch(url);");
  assert.ok(getJsonDeclaration >= 0 && delegatedFetch === getJsonDeclaration + 1, "getJson 必须保持为私有的本地调试包装器");
  assert.doesNotMatch(source, /\bexport\s+(?:async\s+)?function\s+getJson\b|\bexport\s*\{[^}]*\bgetJson\b/);

  const networkCallLines = lines.filter((line, index) => {
    const trimmed = line.trim();
    return /\b(?:fetch|getJson)\s*\(/.test(trimmed)
      && index !== getJsonDeclaration
      && index !== delegatedFetch;
  });

  assert.ok(networkCallLines.length > 0, "应检测到 Chrome DevTools 本地网络调用");
  for (const line of networkCallLines) {
    assert.match(line, /\b(?:fetch|getJson)\s*\(\s*`http:\/\/127\.0\.0\.1:\$\{context\.port\}\/json\//);
  }
  assert.doesNotMatch(source, /\b(?:fetch|getJson)\s*\(\s*[`'"]https?:\/\/(?:[^/]*\.)?(?:taobao|tmall)\.com\b/i);
});

test("browser capture rechecks access restrictions after interactive page actions", async () => {
  const source = await fs.readFile(new URL("./browserService.js", import.meta.url), "utf8");
  const helperAt = source.indexOf("const assertNoAccessRestriction = async");
  const skuLoopAt = source.indexOf("for (const selection of requestedSelections)");
  const finalCaptureAt = source.indexOf("const result = await cdp.send", skuLoopAt);
  const skuLoop = source.slice(skuLoopAt, finalCaptureAt);
  assert.ok(helperAt >= 0 && skuLoopAt > helperAt);
  assert.match(skuLoop, /await assertNoAccessRestriction\(\)/);
  assert.match(source.slice(finalCaptureAt), /isTaobaoAccessRestrictedDocument/);
});

test("browser evidence hook runs before the temporary tab is closed", async () => {
  const source = await fs.readFile(new URL("./browserService.js", import.meta.url), "utf8");
  const hookAt = source.indexOf("await renderOptions.persistEvidenceBeforeClose(capturedPage)");
  const closeAt = source.indexOf("if (tab?.id) await closeTab", hookAt);
  assert.ok(hookAt >= 0 && closeAt > hookAt);
});

test("Tmall SSO bridge runs in the browser and its one-time response never enters evidence", async () => {
  const source = await fs.readFile(new URL("./browserService.js", import.meta.url), "utf8");
  const bridgeAt = source.indexOf("await refreshTmallSsoFromCapturedLogin(cdp, priceResponses, url)");
  const captureAt = source.indexOf("const capturedPage =", bridgeAt);
  assert.ok(bridgeAt >= 0 && captureAt > bridgeAt);

  const evidence = buildBrowserCaptureEvidence({
    product: { url: "https://detail.tmall.com/item.htm?id=843315272699" },
    accountType: "normal",
    itemId: "843315272699",
    capturedAt: "2026-07-20T00:00:00.000Z",
    page: {
      finalUrl: "https://detail.tmall.com/item.htm?id=843315272699",
      authState: { loggedIn: true },
      networkPayloads: [{
        url: "https://login.taobao.com/newlogin/silentHasLogin.do?callback=x",
        mimeType: "application/javascript",
        responseKind: "price",
        body: 'callback({"content":{"data":{"asyncUrls":["https://pass.tmall.com/add?token=secret"]}}})',
      }],
    },
    promotionCapture: { networkPayloads: [], selectionResults: [] },
  });
  assert.deepEqual(evidence.page.networkPayloads, []);
  assert.doesNotMatch(JSON.stringify(evidence), /pass\.tmall\.com|token=secret/);
});

test("the price diagnostic script also saves and reloads browser evidence before parsing", async () => {
  const source = await fs.readFile(new URL("../../scripts/inspect-price-evidence.mjs", import.meta.url), "utf8");
  const saveAt = source.indexOf("saveBrowserCaptureSource");
  const readAt = source.indexOf("const stored = await readBrowserCaptureSource");
  const parseAt = source.indexOf("const result = resolveSkuPriceEvidence");
  assert.ok(saveAt >= 0 && saveAt < readAt && readAt < parseAt);
  assert.doesNotMatch(source, /page\.skuNetworkPayloads/);
});

test("account browser capture saves loaded data, re-reads disk, and never fetches Taobao from Node", async () => {
  const itemId = "843315272600";
  const skuId = "6274971436000";
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  const html = `<html><head><title>本地优先测试商品</title></head><body>国补活动</body><script>window.__DATA__=${JSON.stringify({
    skuBase: {
      props: [{ pid: "1", values: [{ vid: "10", name: "标准款" }] }],
      skus: [{ skuId, propPath: "1:10" }],
    },
    skuCore: {
      sku2info: {
        [skuId]: {
          subPrice: { priceText: "139", priceTitle: "平台优惠后" },
          price: { priceText: "199" },
          quantity: 10,
        },
      },
    },
  })}</script></html>`;
  const payload = {
    url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId, skuId }))}&sign=browser-sign-secret`,
    mimeType: "application/json",
    responseKind: "price",
    captureRunId: "selection-run-single",
    responseSequence: 1,
    body: JSON.stringify({
      data: {
        componentsVO: {
          xsRedPacketParamVO: {
            trackParams: { skuId, price1: "199", price2: "139" },
            xsRedPocketParams: {
              tbShopRedPocket: JSON.stringify({ umpInfo: { umpPromotionList: [{ promotionName: "spsd4plan", amount: 6000 }] } }),
            },
          },
        },
      },
    }),
  };
  let renderCalls = 0;
  const renderPage = async (_url, _session, options) => {
    renderCalls += 1;
    assert.equal(options.localCapture, true);
    assert.equal(options.preserveCache, true);
    return {
      html,
      visibleText: "国补活动",
      finalUrl: url,
      statusCode: 200,
      source: "browser",
      cookieHeader: "sid=browser-cookie-secret",
      authState: { loggedIn: true, cookie: "browser-cookie-secret" },
      networkPayloads: renderCalls === 2 ? [payload] : [],
      buyerShowPayloads: [],
      priceNetworkPayloads: renderCalls === 2 ? [payload] : [],
      skuNetworkPayloads: renderCalls === 2 ? { [skuId]: [payload] } : {},
      selectionResults: renderCalls === 2 ? [{
        skuId,
        selected: true,
        responseReceivedAfterSelection: true,
        captureRunId: "selection-run-single",
        responseSequenceStartExclusive: 0,
        responseSequenceEndInclusive: 1,
        reason: "response-received",
      }] : [],
      buyerShowInteractions: [],
    };
  };
  const originalFetch = globalThis.fetch;
  let nodeNetworkCalls = 0;
  globalThis.fetch = async () => {
    nodeNetworkCalls += 1;
    throw new Error("Node must not request Taobao after browser capture");
  };
  try {
    const snapshot = await scrapeTmallProduct({
      id: "product-local-flow",
      name: "待识别商品",
      itemId,
      url,
      captureBuyerShows: false,
      captureMediaAssets: false,
    }, {
      id: "session-secret-id",
      source: "taobao-browser",
      accountType: "normal",
      browserProfileKey: "profile-secret",
      browserPort: 9333,
    }, { renderPage });

    assert.equal(renderCalls, 2);
    assert.equal(nodeNetworkCalls, 0);
    assert.equal(snapshot.itemId, itemId);
    assert.equal(snapshot.skuPrices[0].skuId, skuId);
    assert.equal(snapshot.skuPrices[0].normalPrice, 139);
    assert.equal(snapshot.localFirst.sourceSaved, true);
    assert.equal(snapshot.localFirst.parsedFromDisk, true);
    assert.equal(snapshot.rawSignals.networkAccessedAfterLocalSave, false);
    const source = await fs.readFile(path.join(dataDir, snapshot.browserEvidenceFile), "utf8");
    assert.doesNotMatch(source, /browser-cookie-secret|session-secret-id|profile-secret|browser-sign-secret/);
    assert.match(source, /本地优先测试商品/);
    const stored = JSON.parse(source);
    assert.equal(stored.page.networkPayloads[0].url, `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?itemId=${itemId}&skuId=${skuId}`);
    assert.equal(Object.hasOwn(stored.page.networkPayloads[0], "requestSkuId"), false);
    assert.equal(Object.hasOwn(stored.page.networkPayloads[0], "responseSkuId"), false);
    assert.equal(Object.hasOwn(stored.page.networkPayloads[0], "skuId"), false);
    assert.equal(stored.page.networkPayloads[0].captureRunId, "selection-run-single");
    assert.equal(stored.page.networkPayloads[0].responseSequence, 1);
    assert.equal(Object.hasOwn(stored.page.selectionResults[0], "responseObserved"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one gated SKU is retried without discarding verified sibling prices", async () => {
  const itemId = "668945261101";
  const skuIds = ["6206877831711", "6096276240242"];
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  const html = `<html><head><title>逐 SKU 授权回归</title></head><body>正常商品页</body><script>window.__DATA__=${JSON.stringify({
    skuBase: {
      props: [{ pid: "1", values: [{ vid: "10", name: "款式一" }, { vid: "11", name: "款式二" }] }],
      skus: [
        { skuId: skuIds[0], propPath: "1:10" },
        { skuId: skuIds[1], propPath: "1:11" },
      ],
    },
    skuCore: {
      sku2info: {
        [skuIds[0]]: { subPrice: { priceText: "139", priceTitle: "平台加补后" }, price: { priceText: "199" }, quantity: 10 },
        [skuIds[1]]: { subPrice: { priceText: "159", priceTitle: "平台加补后" }, price: { priceText: "219" }, quantity: 10 },
      },
    },
  })}</script></html>`;
  const verifiedPayload = {
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    mimeType: "application/json",
    responseKind: "price",
    captureRunId: "mixed-selection-run",
    responseSequence: 1,
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: {
      trackParams: { itemId, skuId: skuIds[0], price1: "199", price2: "139" },
      xsRedPocketParams: { tbShopRedPocket: JSON.stringify({ umpInfo: { umpPromotionList: [{ promotionName: "spsd4plan", amount: 6000 }] } }) },
    } } } }),
  };
  const gatedPayload = (captureRunId, responseSequence) => ({
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    mimeType: "application/json",
    responseKind: "price",
    captureRunId,
    responseSequence,
    body: JSON.stringify({ data: { componentsVO: { priceVO: { price: { priceActionText: "登录查看更多优惠" } } } } }),
  });
  let renderCalls = 0;
  const renderPage = async () => {
    renderCalls += 1;
    const common = {
      html,
      visibleText: "正常商品页",
      finalUrl: url,
      statusCode: 200,
      source: "browser",
      authState: { loggedIn: true },
      buyerShowInteractions: [],
    };
    if (renderCalls === 1) return { ...common, networkPayloads: [], selectionResults: [] };
    if (renderCalls === 2) return {
      ...common,
      networkPayloads: [verifiedPayload, gatedPayload("mixed-selection-run", 2)],
      selectionResults: [
        { skuId: skuIds[0], selected: true, responseReceivedAfterSelection: true, captureRunId: "mixed-selection-run", responseSequenceStartExclusive: 0, responseSequenceEndInclusive: 1 },
        { skuId: skuIds[1], selected: true, responseReceivedAfterSelection: true, captureRunId: "mixed-selection-run", responseSequenceStartExclusive: 1, responseSequenceEndInclusive: 2 },
      ],
    };
    return {
      ...common,
      networkPayloads: [gatedPayload("gated-retry-run", 1)],
      selectionResults: [
        { skuId: skuIds[1], selected: true, responseReceivedAfterSelection: true, captureRunId: "gated-retry-run", responseSequenceStartExclusive: 0, responseSequenceEndInclusive: 1 },
      ],
    };
  };

  const snapshot = await scrapeTmallProduct({
    id: "product-partial-price-gate",
    itemId,
    url,
    captureBuyerShows: false,
    captureMediaAssets: false,
  }, {
    id: "session-partial-price-gate",
    source: "taobao-browser",
    accountType: "normal",
    browserProfileKey: "profile-partial-price-gate",
    browserPort: 9337,
  }, { renderPage });

  assert.equal(renderCalls, 3);
  assert.equal(snapshot.resolutionStatus, "verified");
  assert.equal(snapshot.skuPrices.length, 2);
  assert.deepEqual(snapshot.skuPrices.map((sku) => sku.normalPrice), [139, 159]);
  assert.equal(snapshot.skuPrices[0].priceResolution.endpoint, "mtop.taobao.pcdetail.data.adjust");
  assert.equal(snapshot.skuPrices[1].priceResolution.source, "embedded-ssr");
  assert.equal(snapshot.skuPrices[0].priceCalculation.normal, "标价 199.00 - 平台活动立减 60.00 = 普通价 139.00");
  assert.equal(snapshot.skuPrices[1].priceCalculation.normal, "标价 219.00 - 平台加补 60.00 = 普通价 159.00");
  assert.equal(snapshot.localFirst.parsedFromDisk, true);
});

test("local reload routes query-free pcdetail responses by matching body item and SKU identity", async () => {
  const itemId = "1050634180067";
  const skuIds = ["6078474296537", "6262746967201"];
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  const html = `<html><head><title>双 SKU 本地证据回归</title></head><body>正常商品页</body><script>window.__DATA__=${JSON.stringify({
    skuBase: {
      props: [{ pid: "1", values: [{ vid: "10", name: "款式一" }, { vid: "11", name: "款式二" }] }],
      skus: [
        { skuId: skuIds[0], propPath: "1:10" },
        { skuId: skuIds[1], propPath: "1:11" },
      ],
    },
    skuCore: {
      sku2info: {
        [skuIds[0]]: { subPrice: { priceText: "513.39", priceTitle: "平台加补后" }, price: { priceText: "749" }, quantity: 10 },
        [skuIds[1]]: { subPrice: { priceText: "368.15", priceTitle: "平台加补后" }, price: { priceText: "599" }, quantity: 10 },
      },
    },
  })}</script></html>`;
  const response = (responseItemId, skuId, price1, price2, coinAmount, responseSequence) => ({
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    mimeType: "application/json",
    responseKind: "price",
    captureRunId: "selection-run-multi",
    responseSequence,
    body: JSON.stringify({
      data: {
        componentsVO: {
          xsRedPacketParamVO: {
            trackParams: { itemId: responseItemId, skuId, price1, price2 },
            xsRedPocketParams: {
              tbShopRedPocket: JSON.stringify({
                umpInfo: {
                  umpPromotionList: [
                    { promotionName: "spsd4price", amount: 15000 },
                    { promotionName: "spsd4jzjj", amount: 5689 },
                    { promotionName: "uppAcrossPromotion", amount: coinAmount },
                  ],
                },
              }),
            },
          },
        },
      },
    }),
  });
  const payloads = [
    response(itemId, skuIds[0], "749", "513.39", 2872, 1),
    response(itemId, skuIds[1], "999", "791.11", 100, 2),
    response(itemId, skuIds[1], "599", "368.15", 2396, 3),
    response("9999999999999", skuIds[1], "999", "791.11", 100, 4),
  ];
  const pageStalePayload = {
    ...response(itemId, skuIds[0], "999", "791.11", 100, 1),
    captureRunId: "page-run-multi",
  };
  let renderCalls = 0;
  const renderPage = async () => {
    renderCalls += 1;
    return {
      html,
      visibleText: "正常商品页",
      finalUrl: url,
      statusCode: 200,
      source: "browser",
      authState: { loggedIn: true },
      networkPayloads: renderCalls === 1 ? [pageStalePayload] : payloads,
      selectionResults: renderCalls === 2
        ? [
          {
            skuId: skuIds[0],
            selected: true,
            responseReceivedAfterSelection: true,
            captureRunId: "selection-run-multi",
            responseSequenceStartExclusive: 0,
            responseSequenceEndInclusive: 1,
            reason: "response-received",
          },
          {
            skuId: skuIds[1],
            selected: true,
            responseReceivedAfterSelection: true,
            captureRunId: "selection-run-multi",
            responseSequenceStartExclusive: 2,
            responseSequenceEndInclusive: 3,
            reason: "response-received",
          },
        ]
        : [],
      buyerShowInteractions: [],
    };
  };

  const snapshot = await scrapeTmallProduct({
    id: "product-query-free-evidence",
    name: "双 SKU 本地证据回归",
    itemId,
    url,
    captureBuyerShows: false,
    captureMediaAssets: false,
  }, {
    id: "session-query-free-evidence",
    source: "taobao-browser",
    accountType: "normal",
    browserProfileKey: "profile-query-free-evidence",
    browserPort: 9335,
  }, { renderPage });

  const first = snapshot.skuPrices.find((sku) => sku.skuId === skuIds[0]);
  const second = snapshot.skuPrices.find((sku) => sku.skuId === skuIds[1]);
  assert.equal(renderCalls, 2);
  assert.deepEqual(
    [first.normalPrice, first.surprisePrice, first.coinPrice],
    [599, 542.11, 513.39],
  );
  assert.deepEqual(
    [second.normalPrice, second.surprisePrice, second.coinPrice],
    [449, 392.11, 368.15],
  );
  assert.equal(first.resolutionStatus, "verified");
  assert.equal(second.resolutionStatus, "verified");
  assert.equal(first.coinDiscountAmount, 28.72);
  assert.equal(second.coinDiscountAmount, 23.96);
  assert.deepEqual(first.discountItems.map(({ label, amount }) => ({ label, amount })), [
    { label: "平台立减", amount: 150 },
    { label: "惊喜立减", amount: 56.89 },
    { label: "淘金币抵扣", amount: 28.72 },
  ]);
  assert.deepEqual(second.priceLayers.map(({ label, value }) => ({ label, value })), [
    { label: "优惠前", value: 599 },
    { label: "普通价", value: 449 },
    { label: "惊喜立减价", value: 392.11 },
    { label: "淘金币价", value: 368.15 },
  ]);
  assert.equal(first.governmentPrice, null);
  assert.equal(second.giftPrice, null);
});

test("browser evidence keeps identical responses from distinct sequence positions", () => {
  const payload = {
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    mimeType: "application/json",
    responseKind: "price",
    captureRunId: "duplicate-sequence-run",
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId: "843315272699", skuId: "6274971436999", price1: "199", price2: "139" } } } } }),
  };
  const evidence = buildBrowserCaptureEvidence({
    product: { url: "https://detail.tmall.com/item.htm?id=843315272699" },
    accountType: "normal",
    itemId: "843315272699",
    capturedAt: "2026-07-20T00:00:00.000Z",
    page: { finalUrl: "https://detail.tmall.com/item.htm?id=843315272699", authState: { loggedIn: true }, networkPayloads: [] },
    promotionCapture: {
      networkPayloads: [{ ...payload, responseSequence: 1 }, { ...payload, responseSequence: 2 }],
      selectionResults: [{
        skuId: "6274971436999",
        selected: true,
        responseReceivedAfterSelection: true,
        captureRunId: "duplicate-sequence-run",
        responseSequenceStartExclusive: 1,
        responseSequenceEndInclusive: 2,
      }],
    },
  });

  assert.deepEqual(evidence.page.networkPayloads.map((item) => item.responseSequence), [1, 2]);
  assert.equal(evidence.page.selectionResults[0].responseSequenceStartExclusive, 1);
  assert.equal(evidence.page.selectionResults[0].responseSequenceEndInclusive, 2);
});

test("a locally reloaded price-login gate stops before refresh and SKU selection", async () => {
  const itemId = "843315272601";
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  const html = `<script>window.__DATA__=${JSON.stringify({
    skuBase: { props: [{ pid: "1", values: [{ vid: "10", name: "标准款" }] }], skus: [{ skuId: "6274971436001", propPath: "1:10" }] },
    skuCore: { sku2info: { "6274971436001": { price: { priceText: "199", priceTitle: "优惠前" } } } },
  })}</script>`;
  let renderCalls = 0;
  await assert.rejects(
    scrapeTmallProduct({ id: "product-gated", itemId, url, captureBuyerShows: false }, {
      id: "session-gated",
      source: "taobao-browser",
      accountType: "normal",
      browserProfileKey: "profile-gated",
      browserPort: 9334,
    }, {
      renderPage: async () => {
        renderCalls += 1;
        return {
          html,
          visibleText: "登录查看更多优惠",
          finalUrl: url,
          statusCode: 200,
          authState: { loggedIn: true },
          networkPayloads: [],
          selectionResults: [],
        };
      },
    }),
    (error) => error.code === "TMALL_PRICE_AUTH_REQUIRED",
  );
  assert.equal(renderCalls, 1);
});

test("an account restriction page stops after the first browser load", async () => {
  const itemId = "843315272602";
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  let renderCalls = 0;
  await assert.rejects(
    scrapeTmallProduct({ id: "product-restricted", itemId, url }, {
      id: "session-restricted",
      source: "taobao-browser",
      accountType: "normal",
      browserProfileKey: "profile-restricted",
      browserPort: 9335,
    }, {
      renderPage: async () => {
        renderCalls += 1;
        return {
          html: "<html>您的账户近期访问行为存在异常，系统将限制该账号的部分访问功能，预计 2099-07-19 17时 后恢复正常。</html>",
          visibleText: "访问行为存在异常",
          finalUrl: url,
          statusCode: 200,
          authState: { loggedIn: true },
          networkPayloads: [],
        };
      },
    }),
    (error) => error.code === "TAOBAO_ACCESS_RESTRICTED" && error.retryAfterMs > 0,
  );
  assert.equal(renderCalls, 1);
});

test("an access restriction raised after SKU interaction is never downgraded to empty promotion data", async () => {
  const itemId = "843315272603";
  const skuId = "6274971436003";
  const url = `https://detail.tmall.com/item.htm?id=${itemId}`;
  const html = `<script>window.__DATA__=${JSON.stringify({
    skuBase: { props: [{ pid: "1", values: [{ vid: "10", name: "标准款" }] }], skus: [{ skuId, propPath: "1:10" }] },
    skuCore: { sku2info: { [skuId]: { subPrice: { priceText: "139", priceTitle: "平台优惠后" }, price: { priceText: "199" } } } },
  })}</script>`;
  let renderCalls = 0;
  await assert.rejects(
    scrapeTmallProduct({ id: "product-restricted-after-sku", itemId, url, captureBuyerShows: false }, {
      id: "session-restricted-after-sku",
      source: "taobao-browser",
      accountType: "normal",
      browserProfileKey: "profile-restricted-after-sku",
      browserPort: 9336,
    }, {
      renderPage: async () => {
        renderCalls += 1;
        if (renderCalls === 2) {
          const error = new Error("淘宝已限制当前账号访问，本次抓取已停止；全局自动监控保持原设置。");
          error.code = "TAOBAO_ACCESS_RESTRICTED";
          error.retryAfterMs = 60_000;
          throw error;
        }
        return {
          html,
          visibleText: "正常商品页",
          finalUrl: url,
          statusCode: 200,
          authState: { loggedIn: true },
          networkPayloads: [],
          selectionResults: [],
        };
      },
    }),
    (error) => error.code === "TAOBAO_ACCESS_RESTRICTED",
  );
  assert.equal(renderCalls, 2);
});
