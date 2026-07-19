import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-auto-evidence-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const { readDb, updateDb } = await import("../storage/db.js");
const { getCaptureQueueStatus, runBuyerShowOnce, runProductOnce } = await import("./monitorService.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("single capture automatically persists sanitized local evidence and local import does not recurse", async () => {
  const productId = "product-auto-evidence";
  const itemId = "843315272577";
  const skuId = "6274971435777";
  const session = {
    id: "real-session-secret",
    name: "真实账号昵称",
    source: "taobao-browser",
    accountType: "normal",
    active: true,
    enabled: true,
    loginStatus: "valid",
    healthStatus: "healthy",
    createdAt: "2026-07-16T07:00:00.000Z",
  };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      name: "待识别商品",
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      group: "默认分组",
      accountType: "normal",
      skuMonitorRules: { [skuId]: { normal: 140 } },
      enabled: false,
      captureBuyerShows: false,
      captureMediaAssets: false,
      lastStatus: "pending",
      createdAt: "2026-07-16T07:00:00.000Z",
      updatedAt: "2026-07-16T07:00:00.000Z",
    });
    db.authSessions.push(session);
    return db;
  });

  let scraperCalls = 0;
  const scraper = async () => {
    scraperCalls += 1;
    const capturedAt = new Date().toISOString();
    const priceResolution = {
      status: "verified",
      parserVersion: "evidence-integration",
      channels: {
        normal: { status: "verified", valueCents: 13900, formula: "标价 199.00 - 立减 60.00 = 普通价 139.00", evidenceIds: ["normal-evidence"] },
      },
    };
    return {
      parserVersion: "evidence-integration",
      resolutionStatus: "verified",
      capturedAt,
      source: "browser",
      accessMode: "authenticated",
      itemId,
      title: "自动证据集成商品",
      shopName: "测试店铺",
      model: "MODEL-1",
      mainImage: "https://img.alicdn.com/private-main.jpg",
      mainImage800: "https://img.alicdn.com/private-main.jpg",
      mainImages: ["https://img.alicdn.com/private-main.jpg"],
      gallery750Images: [],
      detailImages: [],
      videoUrls: [],
      skuImages: ["https://img.alicdn.com/private-sku.jpg"],
      skuPrices: [{
        skuId,
        name: "白色 5L",
        image: "https://img.alicdn.com/private-sku.jpg",
        price: 139,
        normalPrice: 139,
        resolutionStatus: "verified",
        priceResolution,
        priceEvidence: [{
          id: "normal-evidence",
          itemId,
          skuId,
          accountType: "normal",
          kind: "normal",
          valueCents: 13900,
          source: "api-formula",
          endpoint: "https://h5api.m.tmall.com/h5/price?sign=secret",
          sourcePath: "$.data.price",
          promotionCodes: [],
          selectedSkuVerified: true,
          capturedAt,
        }],
      }],
      price: 139,
      priceRange: [139, 139],
      buyerShows: [],
      buyerShowCapture: { status: "skipped", source: "disabled", itemId, reportedTotal: 0, pageCount: 0, requestCount: 0, items: [], mediaCount: 0, textOnlyCount: 0, capturedAt },
      rawSignals: { htmlBytes: 100, imageCount: 2, skuImageCount: 1, priceCount: 1, observedSkuCount: 1, outputSkuCount: 1, verifiedPriceSkuCount: 1 },
      localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true },
    };
  };

  const first = await runProductOnce(productId, { source: "manual-product", scraper, authSessions: [session] });
  assert.equal(first.product.lastStatus, "ok");
  assert.match(first.product.lastSnapshot.localImportFile, /^capture-evidence\/local_[a-f0-9]{32}\.json$/);
  assert.match(first.run.message, /本地价格证据已自动保存 1 份/);
  const savedPath = path.join(dataDir, first.product.lastSnapshot.localImportFile);
  const saved = await fs.readFile(savedPath, "utf8");
  assert.doesNotMatch(saved, /real-session-secret|真实账号昵称|private-main|private-sku|sign=secret/);
  const persisted = await readDb();
  assert.equal(persisted.products[0].lastSnapshot.localImportFile, first.product.lastSnapshot.localImportFile);
  assert.equal(persisted.snapshots[0].localImportFile, first.product.lastSnapshot.localImportFile);
  assert.equal(persisted.products[0].skuLifecycle[skuId].status, "active");
  assert.equal(persisted.alertStates[productId].normal[skuId].normal.relation, "below");

  const evidenceDirectory = path.join(dataDir, "capture-evidence");
  const before = await fs.readdir(evidenceDirectory);
  const replay = await runProductOnce(productId, { source: "local-import", scraper, authSessions: [session] });
  const afterReplay = await fs.readdir(evidenceDirectory);
  assert.equal(replay.snapshot.localImportFile, undefined);
  assert.equal(afterReplay.length, before.length);
  assert.equal(scraperCalls, 2);

  const buyerShowResult = await runBuyerShowOnce(productId, {
    source: "manual-buyer-show",
    authSessions: [session],
    scraper: async () => ({
      capture: {
        status: "partial",
        source: "verified-dom",
        itemId,
        reportedTotal: 1,
        pageCount: 1,
        requestCount: 1,
        items: [{ id: "buyer-1", text: "使用方便", images: ["https://img.alicdn.com/review.jpg"], videoUrls: [] }],
        mediaCount: 1,
        textOnlyCount: 0,
        capturedAt: new Date().toISOString(),
      },
      items: [{ id: "buyer-1", text: "使用方便", images: ["https://img.alicdn.com/review.jpg"], videoUrls: [] }],
      interactions: [],
    }),
  });
  assert.equal(buyerShowResult.ok, true);
  assert.equal(buyerShowResult.product.lastSnapshot.buyerShows.length, 1);
  assert.equal(buyerShowResult.product.lastSnapshot.skuPrices[0].normalPrice, 139);
  const buyerJob = (await getCaptureQueueStatus()).jobs.find((job) => job.source === "manual-buyer-show");
  assert.equal(buyerJob.status, "completed");
  assert.equal(buyerJob.stage, "completed");
});
