import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-create-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";

const { app } = await import("../index.js");

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function jsonRequest(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

test("new products persist their canonical item ID and reject an identity duplicate", async () => {
  const itemId = "843315272701";
  const created = await jsonRequest("/api/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://detail.tmall.com/item.htm?id=${itemId}`, accountType: "normal", captureBuyerShows: false, captureMediaAssets: false }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.itemId, itemId);

  const duplicate = await jsonRequest("/api/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://item.taobao.com/item.htm?id=${itemId}`, accountType: "normal", captureBuyerShows: false, captureMediaAssets: false }),
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.message, /已在监控列表/);

  const overview = await jsonRequest("/api/overview");
  assert.equal(overview.body.products.filter((product) => product.itemId === itemId).length, 1);
});

test("a failed first capture rolls back the empty product and remains gone after refresh", async () => {
  const itemId = "843315272702";
  const created = await jsonRequest("/api/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://detail.tmall.com/item.htm?id=${itemId}`, accountType: "normal", captureBuyerShows: false, captureMediaAssets: false }),
  });
  assert.equal(created.status, 201);

  const capture = await jsonRequest(`/api/products/${created.body.id}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ captureKind: "price", rollbackUninitialized: true }),
  });
  assert.equal(capture.status, 422);
  assert.equal(capture.body.rolledBack, true);
  assert.match(capture.body.message, /自动撤销空商品/);

  const firstRefresh = await jsonRequest("/api/overview");
  const secondRefresh = await jsonRequest("/api/overview");
  assert.equal(firstRefresh.body.products.some((product) => product.id === created.body.id), false);
  assert.equal(secondRefresh.body.products.some((product) => product.itemId === itemId), false);
  assert.equal(secondRefresh.body.captureQueue.jobs.some((job) => job.productIds?.includes(created.body.id)), false);
});

test("batch capture failures do not leave placeholder products behind", async () => {
  const itemIds = ["843315272703", "843315272704"];
  const response = await jsonRequest("/api/products/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      urls: itemIds.map((itemId) => `https://detail.tmall.com/item.htm?id=${itemId}`),
      accountType: "normal",
      group: "失败回滚测试",
      captureBuyerShows: false,
      captureMediaAssets: false,
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.created, 0);
  assert.equal(response.body.failed, 2);
  assert.match(response.body.message, /未留下空商品/);

  const overview = await jsonRequest("/api/overview");
  assert.equal(overview.body.products.some((product) => itemIds.includes(product.itemId)), false);
});
