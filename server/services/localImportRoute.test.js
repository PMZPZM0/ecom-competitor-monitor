import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-local-import-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";

const { startServer, stopServer } = await import("../index.js");
const { updateDb } = await import("../storage/db.js");

function priceResponse(skuId) {
  return {
    data: {
      componentsVO: {
        xsRedPacketParamVO: {
          trackParams: { skuId, price1: "199", price2: "129" },
          xsRedPocketParams: {
            tbShopRedPocket: JSON.stringify({
              umpInfo: {
                umpPromotionList: [
                  { promotionName: "spsd4plan", amount: 6000 },
                  { promotionName: "spsd4jzjj", amount: 1000 },
                ],
              },
            }),
          },
        },
      },
    },
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("local import routes reject cross-site writes and commit verified prices idempotently", async () => {
  const server = await startServer({ port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const itemId = "843315272530";
  const skuId = "6198474471099";
  const content = JSON.stringify({
    itemId,
    request: {
      url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId, skuId }))}`,
      body: priceResponse(skuId),
    },
  });
  const previewUrl = `${baseUrl}/api/local-imports/preview?accountType=normal&itemIdHint=${itemId}`;

  try {
    const blocked = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      body: content,
    });
    assert.equal(blocked.status, 403);

    const barePreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `mtopjsonp1(${JSON.stringify(priceResponse(skuId))})`,
    });
    assert.equal(barePreview.status, 201);
    assert.equal(barePreview.body.canCommit, false);
    const bareCommit = await jsonRequest(`${baseUrl}/api/local-imports/${barePreview.body.importId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(bareCommit.status, 409);

    const missingBrowserSession = await jsonRequest(`${baseUrl}/api/raw-data/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, sessionId: "missing-session" }),
    });
    assert.equal(missingBrowserSession.status, 409);
    assert.equal(missingBrowserSession.body.error.code, "BROWSER_SESSION_NOT_FOUND");

    const invalidProductUrl = await jsonRequest(`${baseUrl}/api/raw-data/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://example.com/item.htm?id=${itemId}`, sessionId: "missing-session" }),
    });
    assert.equal(invalidProductUrl.status, 400);
    assert.equal(invalidProductUrl.body.error.code, "INVALID_PRODUCT_URL");

    const mismatchedProductId = await jsonRequest(`${baseUrl}/api/raw-data/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://detail.tmall.com/item.htm?id=${itemId}`, itemId: "843315272531", sessionId: "missing-session" }),
    });
    assert.equal(mismatchedProductId.status, 400);
    assert.equal(mismatchedProductId.body.error.code, "PRODUCT_ID_MISMATCH");

    const preview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    assert.equal(preview.status, 201);
    assert.equal(preview.body.canCommit, true);
    assert.equal(preview.body.verifiedSkuCount, 1);

    const firstCommit = await jsonRequest(`${baseUrl}/api/local-imports/${preview.body.importId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(firstCommit.status, 200);
    assert.equal(firstCommit.body.created, true);
    assert.equal(firstCommit.body.alreadyCommitted, false);
    assert.equal(firstCommit.body.product.captureMode, "local-only");
    assert.equal(firstCommit.body.product.enabled, false);
    assert.equal(firstCommit.body.sourceFile, preview.body.sourceFile);
    assert.equal(firstCommit.body.snapshot.source, "local-import");
    assert.equal(firstCommit.body.run.source, "local-import");

    const duplicate = await jsonRequest(`${baseUrl}/api/local-imports/${preview.body.importId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.alreadyCommitted, true);

    const monitorPrice = await jsonRequest(`${baseUrl}/api/products/${firstCommit.body.product.id}/sku-monitor-price`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skuId, value: 150 }),
    });
    assert.equal(monitorPrice.status, 200);

    const newCustomerGiftMonitor = await jsonRequest(`${baseUrl}/api/products/${firstCommit.body.product.id}/sku-monitor-price`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skuId, value: 120, channel: "gift" }),
    });
    assert.equal(newCustomerGiftMonitor.status, 200);
    assert.equal(newCustomerGiftMonitor.body.accountType, "normal");
    assert.equal(newCustomerGiftMonitor.body.skuMonitorRules[skuId].gift, 120);

    const nextPreview = await jsonRequest(previewUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    const secondCommit = await jsonRequest(`${baseUrl}/api/local-imports/${nextPreview.body.importId}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(secondCommit.status, 200);
    assert.equal(secondCommit.body.created, false);

    const overview = await jsonRequest(`${baseUrl}/api/overview`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.authSessions.length, 0);
    assert.equal(overview.body.products.length, 1);
    assert.equal(overview.body.snapshots.length, 2);
    assert.equal(overview.body.products[0].skuMonitorPrices[skuId], 150);
    assert.equal(overview.body.products[0].skuMonitorRules[skuId].gift, 120);
    assert.deepEqual(overview.body.runs.map((run) => run.source), ["local-import", "local-import"]);

    const enableLocalOnly = await jsonRequest(`${baseUrl}/api/products/${firstCommit.body.product.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enableLocalOnly.status, 409);
    assert.match(enableLocalOnly.body.message, /本地数据模式.*不能启用浏览器定时抓取/);

    const blockedCapture = await jsonRequest(`${baseUrl}/api/products/${firstCommit.body.product.id}/capture`, { method: "POST" });
    assert.equal(blockedCapture.status, 200);
    assert.equal(blockedCapture.body.snapshot, null);
    assert.match(blockedCapture.body.product.lastError, /本地数据模式.*阻止浏览器抓取/);

    const blockedBuyerShows = await jsonRequest(`${baseUrl}/api/products/${firstCommit.body.product.id}/buyer-shows/retry`, { method: "POST" });
    assert.equal(blockedBuyerShows.status, 409);
    assert.match(blockedBuyerShows.body.message, /本地数据模式.*阻止买家秀网页抓取/);

    const existingItemId = "843315272531";
    const existingSkuId = "6198474471100";
    const existingProduct = await jsonRequest(`${baseUrl}/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "已有浏览器商品", url: `https://detail.tmall.com/item.htm?id=${existingItemId}` }),
    });
    assert.equal(existingProduct.status, 201);
    const existingPreview = await jsonRequest(`${baseUrl}/api/local-imports/preview?accountType=normal&itemIdHint=${existingItemId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        itemId: existingItemId,
        request: {
          url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId: existingItemId, skuId: existingSkuId }))}`,
          body: priceResponse(existingSkuId),
        },
      }),
    });
    const existingCommit = await jsonRequest(`${baseUrl}/api/local-imports/${existingPreview.body.importId}/commit`, { method: "POST" });
    assert.equal(existingCommit.status, 200);
    assert.equal(existingCommit.body.created, false);
    assert.equal(existingCommit.body.product.id, existingProduct.body.id);
    assert.equal(existingCommit.body.product.captureMode, "local-only");
    assert.equal(existingCommit.body.product.enabled, false);
    assert.equal(existingCommit.body.product.nextMonitorAt, null);

    const initialEvidence = await jsonRequest(`${baseUrl}/api/local-evidence`);
    assert.equal(initialEvidence.status, 200);
    assert.equal(initialEvidence.body.fileCount, 0);
    assert.equal(initialEvidence.body.directoryPickerAvailable, false);

    const invalidDirectory = await jsonRequest(`${baseUrl}/api/local-evidence`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "relative/evidence" }),
    });
    assert.equal(invalidDirectory.status, 400);

    const customDirectory = path.join(dataDir, "custom-evidence");
    const updatedEvidence = await jsonRequest(`${baseUrl}/api/local-evidence`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: customDirectory }),
    });
    assert.equal(updatedEvidence.status, 200);
    const canonicalCustomDirectory = await fs.realpath(customDirectory);
    assert.equal(updatedEvidence.body.directory, canonicalCustomDirectory);
    const persistedEvidence = await jsonRequest(`${baseUrl}/api/local-evidence`);
    assert.equal(persistedEvidence.body.directory, canonicalCustomDirectory);

    const picker = await jsonRequest(`${baseUrl}/api/local-evidence/select-directory`, { method: "POST" });
    const opener = await jsonRequest(`${baseUrl}/api/local-evidence/open-directory`, { method: "POST" });
    assert.equal(picker.status, 501);
    assert.equal(opener.status, 501);

    const deletedEvidence = await jsonRequest(`${baseUrl}/api/local-evidence`, { method: "DELETE" });
    assert.equal(deletedEvidence.status, 200);
    assert.equal(deletedEvidence.body.fileCount, 0);
    const resetEvidence = await jsonRequest(`${baseUrl}/api/local-evidence`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: null }),
    });
    assert.equal(resetEvidence.status, 200);
    assert.equal(resetEvidence.body.directory, resetEvidence.body.defaultDirectory);
  } finally {
    await stopServer(server);
  }
});

test("local evidence reparse route accepts price and rejects unknown replay kinds", async () => {
  const server = await startServer({ port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const productId = "local-price-replay-route";
  try {
    await updateDb((db) => {
      db.products.push({
        id: productId,
        itemId: "843315272599",
        url: "https://detail.tmall.com/item.htm?id=843315272599",
        name: "本地重放路由测试",
        accountType: "normal",
        lastSnapshot: { itemId: "843315272599", skuPrices: [] },
      });
      return db;
    });
    const acceptedKind = await jsonRequest(`${baseUrl}/api/products/${productId}/reparse-local-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "price" }),
    });
    assert.equal(acceptedKind.status, 409);
    assert.match(acceptedKind.body.message, /价格本地证据/);

    const rejectedKind = await jsonRequest(`${baseUrl}/api/products/${productId}/reparse-local-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unsupported" }),
    });
    assert.equal(rejectedKind.status, 400);
  } finally {
    await stopServer(server);
  }
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
