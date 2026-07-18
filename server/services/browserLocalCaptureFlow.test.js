import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-browser-local-capture-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const { scrapeTmallProduct } = await import("./tmallScraper.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("Tmall scraper has no Node-side network escape hatch", async () => {
  const source = await fs.readFile(new URL("./tmallScraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "淘宝/天猫数据只能由账号浏览器采集后落盘解析");
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
      selectionResults: renderCalls === 2 ? [{ skuId, selected: true, responseReceivedAfterSelection: true, reason: "response-received" }] : [],
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
    assert.equal(Object.hasOwn(stored.page.selectionResults[0], "responseObserved"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
