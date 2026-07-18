import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "price-shadow-integration-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  runBuyerShowOnce,
  runMonitorOnce,
  runProductOnce,
  stopCaptureQueue,
} = await import("./monitorService.js");
const { readDb, updateDb } = await import("../storage/db.js");

after(async () => {
  stopCaptureQueue();
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

const normalSession = {
  id: "shadow-normal",
  name: "普通测试账号",
  accountType: "normal",
  source: "taobao-browser",
  enabled: true,
  active: true,
  loginStatus: "valid",
};

const giftSession = {
  ...normalSession,
  id: "shadow-gift",
  name: "礼金测试账号",
  accountType: "gift",
};

function verifiedSnapshot(itemId, price = 139) {
  return {
    capturedAt: new Date().toISOString(),
    accessMode: "authenticated",
    resolutionStatus: "verified",
    parserVersion: "shadow-integration-v1",
    itemId,
    title: `商品 ${itemId}`,
    shopName: "影子测试店铺",
    mainImage800: `https://img.alicdn.com/${itemId}.jpg`,
    price,
    priceRange: `¥${price.toFixed(2)}`,
    skuPrices: [{
      skuId: "sku-1",
      name: "标准款",
      price,
      normalPrice: price,
      resolutionStatus: "verified",
      priceResolution: {
        status: "verified",
        parserVersion: "shadow-integration-v1",
        channels: {
          normal: { status: "verified", valueCents: Math.round(price * 100), evidenceIds: ["private-evidence"] },
        },
      },
    }],
    buyerShows: [],
    buyerShowCapture: { status: "skipped", items: [] },
    rawSignals: { observedSkuCount: 1, outputSkuCount: 1, verifiedPriceSkuCount: 1 },
    localFirst: { sourceSaved: true, parsedFromDisk: true },
  };
}

async function seedProduct(id, itemId) {
  await updateDb((db) => {
    db.products.push({
      id,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: `商品 ${itemId}`,
      accountType: "normal",
      enabled: true,
      skuMonitorRules: {},
    });
    return db;
  });
}

async function setNinthCleanRound() {
  await updateDb((db) => {
    db.priceEngine = {
      mode: "shadow",
      requiredShadowRounds: 10,
      shadowRoundsCompleted: 9,
      consecutiveCleanShadowRounds: 9,
      shadowRoundsAttempted: 9,
      shadowRounds: [],
    };
    return db;
  });
}

test("price orchestration records only current price work and audits account views", async () => {
  await seedProduct("shadow-single", "100000000001");
  await seedProduct("shadow-failure", "100000000002");
  await seedProduct("shadow-batch-good", "100000000003");
  await seedProduct("shadow-batch-bad", "100000000004");
  await updateDb((db) => {
    db.authSessions = [normalSession, giftSession];
    return db;
  });

  await setNinthCleanRound();
  const clean = await runProductOnce("shadow-single", {
    source: "shadow-clean-price",
    captureKind: "price",
    accountMode: "all",
    authSessions: [normalSession, giftSession],
    scraper: async (product) => verifiedSnapshot(product.itemId),
  });
  assert.equal(clean.run.status, "success");
  let db = await readDb();
  assert.equal(db.priceEngine.mode, "active");
  assert.equal(db.priceEngine.shadowRoundsCompleted, 10);
  assert.equal(db.priceEngine.shadowRounds.at(-1).verifiedChannels, 3);
  assert.equal(db.priceEngine.shadowRounds.at(-1).failedProducts, 0);

  await setNinthCleanRound();
  await runProductOnce("shadow-single", {
    source: "shadow-account-mismatch",
    captureKind: "price",
    accountMode: "all",
    authSessions: [normalSession, giftSession],
    scraper: async (product, session) => {
      const snapshot = verifiedSnapshot(product.itemId);
      if (session.accountType === "gift") {
        snapshot.skuPrices[0].price = 138.99;
        snapshot.skuPrices[0].normalPrice = 138.99;
      }
      return snapshot;
    },
  });
  db = await readDb();
  assert.equal(db.priceEngine.mode, "shadow");
  assert.equal(db.priceEngine.shadowRoundsCompleted, 0);
  assert.equal(db.priceEngine.shadowRounds.at(-1).mismatches, 1);

  const beforeNonPrice = structuredClone(db.priceEngine);
  await assert.rejects(runProductOnce("shadow-single", {
    source: "shadow-full",
    captureKind: "full",
    authSessions: [normalSession],
    scraper: async (product) => verifiedSnapshot(product.itemId),
  }), /不支持的抓取类型/);
  assert.deepEqual((await readDb()).priceEngine, beforeNonPrice);

  await runProductOnce("shadow-single", {
    source: "shadow-materials",
    captureKind: "materials",
    authSessions: [normalSession],
    scraper: async (product) => ({
      capturedAt: new Date().toISOString(),
      itemId: product.itemId,
      mainImage800: "https://img.alicdn.com/material-only.jpg",
      skuPrices: [],
    }),
  });
  assert.deepEqual((await readDb()).priceEngine, beforeNonPrice);

  await runBuyerShowOnce("shadow-single", {
    source: "shadow-buyer-show",
    authSessions: [normalSession],
    scraper: async () => ({
      capture: {
        status: "complete",
        source: "integration-test",
        itemId: "100000000001",
        items: [],
        mediaCount: 0,
        textOnlyCount: 0,
        capturedAt: new Date().toISOString(),
      },
      items: [],
      interactions: [],
    }),
  });
  assert.deepEqual((await readDb()).priceEngine, beforeNonPrice);

  await setNinthCleanRound();
  await runProductOnce("shadow-failure", {
    source: "shadow-failed-price",
    captureKind: "price",
    authSessions: [normalSession],
    scraper: async () => { throw new Error("临时抓取失败"); },
  });
  db = await readDb();
  assert.equal(db.priceEngine.mode, "shadow");
  assert.equal(db.priceEngine.shadowRoundsCompleted, 0);
  assert.equal(db.priceEngine.shadowRounds.at(-1).products, 0);
  assert.equal(db.priceEngine.shadowRounds.at(-1).failedProducts, 1);

  await setNinthCleanRound();
  await runMonitorOnce({
    source: "manual-batch",
    productIds: ["shadow-batch-good", "shadow-batch-bad"],
    includeDisabled: true,
    captureKind: "price",
    scraper: async (product) => {
      if (product.id === "shadow-batch-bad") throw new Error("批量临时失败");
      return verifiedSnapshot(product.itemId);
    },
  });
  db = await readDb();
  assert.equal(db.priceEngine.mode, "shadow");
  assert.equal(db.priceEngine.shadowRoundsCompleted, 0);
  assert.equal(db.priceEngine.shadowRounds.at(-1).products, 1);
  assert.equal(db.priceEngine.shadowRounds.at(-1).failedProducts, 1);
  assert.equal(db.priceEngine.shadowRounds.at(-1).verifiedChannels, 2);
});
