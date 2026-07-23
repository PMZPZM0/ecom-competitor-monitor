import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  benchmarkPriceIndex,
  benchmarkFormulaEntries,
  buildExcelSyncDataset,
  buildPriceIndexRows,
  calculateFormulaEntry,
  excelSyncPath,
  priceIndexPath,
  syncPriceWorkbook,
} from "./excelSyncService.js";

function verified(valueCents, formula) {
  return { status: "verified", valueCents, formula, evidenceIds: [formula] };
}

function unavailable() {
  return { status: "unavailable", valueCents: null, evidenceIds: [] };
}

function database(directory) {
  const capturedAt = "2026-07-21T08:00:00.000Z";
  const resolution = {
    status: "verified",
    displayedCents: 13400,
    promotions: [
      { code: "commonItemDiscount", kind: "public", label: "商品优惠", amountCents: 1000 },
      { code: "spsd4jzjj", kind: "surprise", label: "惊喜立减", amountCents: 2000 },
      { code: "12", kind: "coin", label: "淘金币抵扣", amountCents: 500 },
    ],
    evidence: [{ kind: "list", valueCents: 16900 }],
    channels: {
      normal: verified(15900, "标价 169.00 - 商品优惠 10.00 = 普通价 159.00"),
      billion: unavailable(),
      seckill: unavailable(),
      government: unavailable(),
      surprise: verified(13900, "普通价 159.00 - 惊喜立减 20.00 = 惊喜立减价 139.00"),
      gift: unavailable(),
      vip88: unavailable(),
      coin: verified(13400, "惊喜立减价 139.00 - 淘金币抵扣 5.00 = 淘金币价 134.00"),
    },
  };
  const snapshot = {
    id: "snapshot-1",
    productId: "product-1",
    itemId: "10001",
    title: "测试商品",
    capturedAt,
    primaryAccountType: "normal",
    browserEvidenceFile: path.join(directory, "capture.json"),
    skuPrices: [{
      skuId: "sku-1",
      name: "标准款",
      originalPrice: 169,
      normalPrice: 159,
      surprisePrice: 139,
      coinPrice: 134,
      resolutionStatus: "verified",
      priceResolution: resolution,
    }],
  };
  return {
    localEvidence: { directory },
    products: [{ id: "product-1", itemId: "10001", name: "测试商品", accountType: "normal", lastSnapshot: snapshot }],
    snapshots: [snapshot],
  };
}

test("Excel formula dataset matches promotion codes by SKU and account", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "excel-sync-dataset-"));
  const dataset = buildExcelSyncDataset(database(directory));
  assert.equal(dataset.current.length, 1);
  assert.equal(dataset.promotions.length, 3);
  const result = calculateFormulaEntry(dataset.current[0]);
  assert.equal(result.calculated.normal, 159);
  assert.equal(result.calculated.surprise, 139);
  assert.equal(result.calculated.coin, 134);
  assert.equal(result.calculated.final, 134);
  const benchmark = benchmarkFormulaEntries(dataset.current);
  assert.equal(benchmark.rows, 1);
  assert.equal(benchmark.verified, 1);
  assert.equal(benchmark.mismatched, 0);
  assert.ok(benchmark.elapsedMs >= 0);
  const indexRows = buildPriceIndexRows(dataset.current);
  assert.equal(indexRows.length, 9);
  assert.equal(indexRows.find((row) => row.channel === "normal").value, 159);
  assert.equal(indexRows.find((row) => row.channel === "government").status, "unavailable");
  const indexBenchmark = benchmarkPriceIndex(dataset.current, indexRows, 100);
  assert.equal(indexBenchmark.lookups, 900);
  assert.equal(indexBenchmark.hits, 400);
  assert.ok(indexBenchmark.elapsedMs < 100);
});

test("formula engine isolates all price channels across normal, gift, and vip88 accounts", () => {
  const entries = [
    {
      accountType: "normal",
      prices: { list: 200, normal: 190, billion: 170, seckill: null, government: 155, surprise: 150, gift: 140, vip88: null, coin: 137 },
      promotions: [
        { code: "commonItemDiscount", amountCents: 1000 },
        { code: "spsd4bybt", amountCents: 2000 },
        { code: "zflj", amountCents: 1500 },
        { code: "spsd4jzjj", amountCents: 500 },
        { code: "coupon2RedForNewUser", amountCents: 1000 },
        { code: "12", amountCents: 300 },
      ],
    },
    {
      accountType: "gift",
      prices: { list: 300, normal: 290, billion: null, seckill: 270, government: 240, surprise: 230, gift: 210, vip88: null, coin: 205 },
      promotions: [
        { code: "spsd4price", amountCents: 1000 },
        { code: "spsd4hjmssjbt", amountCents: 2000 },
        { code: "zflj", amountCents: 3000 },
        { code: "spsd4jzjj", amountCents: 1000 },
        { code: "coupon2PlatRed", amountCents: 2000 },
        { code: "uppAcrossPromotion", amountCents: 500 },
      ],
    },
    {
      accountType: "vip88",
      prices: { list: 400, normal: 380, billion: 350, seckill: null, government: 330, surprise: 320, gift: 280, vip88: 260, coin: 250 },
      promotions: [
        { code: "spsd4autopri", amountCents: 2000 },
        { code: "spsd4bybtjb", amountCents: 3000 },
        { code: "zflj", amountCents: 2000 },
        { code: "spsd4jzjj", amountCents: 1000 },
        { code: "1", amountCents: 4000 },
        { code: "22", amountCents: 2000 },
        { code: "12", amountCents: 1000 },
      ],
    },
  ];

  for (const entry of entries) {
    const result = calculateFormulaEntry(entry);
    for (const kind of ["normal", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"]) {
      assert.equal(result.calculated[kind], entry.prices[kind], `${entry.accountType}:${kind}`);
    }
  }
  const benchmarkEntries = Array.from({ length: 144 }, (_, index) => entries[index % entries.length]);
  const benchmark = benchmarkFormulaEntries(benchmarkEntries, 100);
  assert.equal(benchmark.verified, 14_400);
  assert.equal(benchmark.mismatched, 0);
  assert.ok(benchmark.elapsedMs < 1_000);
});

test("Excel sync writes visible XLOOKUP and SUMIFS formulas atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "excel-sync-workbook-"));
  const db = database(directory);
  const result = await syncPriceWorkbook(db);
  assert.equal(result.currentRows, 1);
  assert.equal(result.promotionRows, 3);
  assert.equal(result.indexRows, 9);
  assert.equal(result.path, excelSyncPath(db));
  assert.equal(result.indexPath, priceIndexPath(db));
  assert.ok(result.indexLookupMs < 100);

  const indexDocument = JSON.parse(await fs.readFile(result.indexPath, "utf8"));
  assert.equal(indexDocument.keyFormat, "itemId|skuId|accountType|channel");
  assert.equal(indexDocument.rows.length, 9);
  assert.equal(indexDocument.rows.find((row) => row.channel === "normal").value, 159);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.path);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "价格索引", "当前价格", "价格历史", "原始优惠数据", "优惠码规则", "公式计算", "同步说明",
  ]);
  assert.match(workbook.getWorksheet("当前价格").getCell("L2").formula, /^XLOOKUP\(/);
  assert.equal(workbook.getWorksheet("当前价格").getCell("L2").result, 159);
  assert.equal(workbook.getWorksheet("价格索引").getCell("I2").numFmt, "¥#,##0.00");
  assert.match(workbook.getWorksheet("原始优惠数据").getCell("I2").formula, /^XLOOKUP\(/);
  assert.match(workbook.getWorksheet("公式计算").getCell("I2").formula, /^SUMIFS\(/);
  assert.equal(workbook.getWorksheet("公式计算").getCell("Q2").result, 159);
  assert.equal(workbook.getWorksheet("公式计算").getCell("U2").result, 139);
  assert.equal(workbook.getWorksheet("公式计算").getCell("X2").result, 134);
  assert.equal(workbook.getWorksheet("公式计算").getCell("AQ2").result, "通过");
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
});
