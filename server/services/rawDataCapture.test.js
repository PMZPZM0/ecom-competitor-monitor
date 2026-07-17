import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-raw-data-capture-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";

const { captureSanitizedDataPreview } = await import("../index.js");
const { readDb, updateDb } = await import("../storage/db.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("raw data capture writes evidence without mutating products, snapshots, runs or notifications", async () => {
  const itemId = "843315272688";
  const skuId = "6274971436888";
  const session = {
    id: "raw-viewer-session-secret",
    name: "敏感账号昵称",
    source: "taobao-browser",
    accountType: "vip88",
    browserProfileKey: "raw-viewer-profile-secret",
    browserPort: 9444,
    active: true,
    enabled: true,
    loginStatus: "valid",
    healthStatus: "healthy",
    createdAt: "2026-07-17T08:00:00.000Z",
  };
  await updateDb((db) => {
    db.authSessions.push(session);
    db.products.push({ id: "existing-product", itemId: "975159294607", url: "https://detail.tmall.com/item.htm?id=975159294607", name: "已有商品", enabled: false });
    return db;
  });
  const before = structuredClone(await readDb());
  let scraperCalls = 0;
  const capturedAt = "2026-07-17T08:01:00.000Z";
  const scraper = async (product, usedSession) => {
    scraperCalls += 1;
    assert.equal(product.id, `raw_${itemId}`);
    assert.equal(product.captureBuyerShows, false);
    assert.equal(product.captureMediaAssets, false);
    assert.equal(usedSession.id, session.id);
    return {
      parserVersion: "raw-viewer-test",
      resolutionStatus: "verified",
      capturedAt,
      source: "browser",
      accessMode: "authenticated",
      itemId,
      title: "只读数据商品",
      shopName: "测试店铺",
      model: "MODEL-RAW",
      mainImage: "https://img.alicdn.com/private-main.jpg",
      skuPrices: [{
        skuId,
        name: "标准款",
        image: "https://img.alicdn.com/private-sku.jpg",
        price: 139,
        normalPrice: 139,
        resolutionStatus: "verified",
        priceResolution: {
          status: "verified",
          parserVersion: "raw-viewer-test",
          channels: { normal: { status: "verified", valueCents: 13900, formula: "199.00 - 60.00 = 139.00", evidenceIds: ["normal-1"] } },
        },
        priceEvidence: [{ id: "normal-1", itemId, skuId, accountType: "vip88", kind: "normal", valueCents: 13900, source: "api-formula", endpoint: "https://h5api.m.tmall.com/h5/price?sign=secret", sourcePath: "$.data.price", promotionCodes: [], selectedSkuVerified: true, capturedAt }],
      }],
      price: 139,
      priceRange: [139, 139],
      browserEvidenceId: "capture_00000000000000000000000000000000",
      browserEvidenceFile: "capture-evidence/capture_00000000000000000000000000000000.source.txt",
      localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessedAfterCapture: false },
      rawSignals: { verifiedPriceSkuCount: 1 },
    };
  };

  const result = await captureSanitizedDataPreview({ sessionId: session.id, itemId, url: `https://detail.tmall.com/item.htm?id=${itemId}`, platform: "tmall" }, { scraper });
  const afterDb = await readDb();
  assert.deepEqual(afterDb, before);
  assert.equal(scraperCalls, 1);
  assert.equal(result.itemId, itemId);
  assert.equal(result.accountType, "vip88");
  assert.equal(result.verifiedSkuCount, 1);
  assert.equal(result.sanitized, true);
  assert.match(result.sourceFile, /capture-evidence[\\/]local_[a-f0-9]{32}\.json$/);
  assert.doesNotMatch(result.jsonText, /raw-viewer-session-secret|敏感账号昵称|raw-viewer-profile-secret|private-main|private-sku|sign=secret/);
  const exported = JSON.parse(result.jsonText);
  assert.equal(exported.dataType, "sanitized-price-evidence");
  assert.equal(exported.skuPrices[0].normalPrice, 139);
  assert.equal(exported.skuPrices[0].image, "");
});
