import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-operations-agent-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";
process.env.MODEL_STABLE_API_KEY = "";

const { startServer, stopServer } = await import("../index.js");
const { readDb, updateDb } = await import("../storage/db.js");
const { normalizeOperationsState, qwenPawAgentToolAccessToken } = await import("./operationsAssistantService.js");

function report(id, type, rows) {
  return {
    id,
    type,
    storeName: "测试旗舰店",
    reportDate: "2026-07-31",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    periodLabel: "2026-07-01 至 2026-07-31",
    periodKind: "month",
    detectedType: type,
    sourceName: type === "product" ? "商品排行" : "单品付费",
    fileName: `${type}.xlsx`,
    kind: "tabular",
    columns: [],
    rows,
    importedAt: new Date().toISOString(),
  };
}

test("operations Agent HTTP routes enforce local authorization and preserve precise formula scope", async () => {
  const sales = report("sales", "product", [{
    productId: "1001",
    productName: "压力锅",
    storeName: "测试旗舰店",
    grossRevenue: 1_000,
    refundAmount: 100,
    revenue: 900,
    refundDataAvailable: true,
    visitors: 100,
    paidBuyers: 10,
  }]);
  const promotion = report("promotion", "campaign", [{
    productId: "1001",
    productName: "压力锅",
    storeName: "测试旗舰店",
    channel: "关键词推广",
    campaignName: "关键词计划 A",
    spend: 90,
    revenue: 450,
    clicks: 30,
    impressions: 3_000,
    orders: 5,
  }]);
  await updateDb((db) => {
    db.operations = normalizeOperationsState({
      reports: [sales, promotion],
      storeNames: ["测试旗舰店"],
      productCatalog: [{
        id: "catalog-1",
        storeName: "测试旗舰店",
        productId: "1001",
        model: "SY-1001",
        category: "压力锅",
        sourceName: "测试",
        createdAt: "2026-07-01T00:00:00.000Z",
      }],
    });
    return db;
  });

  const server = await startServer({ port: 0 });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = qwenPawAgentToolAccessToken();
  const payload = {
    sourcePeriodKind: "month",
    start: "2026-07-01",
    end: "2026-07-31",
    storeName: "测试旗舰店",
    entityType: "product",
    entityIds: ["1001"],
    metrics: ["gross_revenue", "refund_amount", "gsv", "promotion_spend", "fee_rate", "management_roi", "platform_roi"],
  };
  try {
    const unauthorized = await fetch(`${baseUrl}/api/agent-tools/operations/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(unauthorized.status, 403);

    const queryResponse = await fetch(`${baseUrl}/api/agent-tools/operations/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ecom-agent-token": token },
      body: JSON.stringify(payload),
    });
    assert.equal(queryResponse.status, 200);
    const queried = await queryResponse.json();
    assert.equal(queried.query.storeName, "测试旗舰店");
    assert.equal(queried.entities.product.matchedCount, 1);
    assert.equal(queried.summary.gross_revenue, 1_000);
    assert.equal(queried.summary.refund_amount, 100);
    assert.equal(queried.summary.gsv, 900);
    assert.equal(queried.summary.promotion_spend, 90);
    assert.equal(queried.summary.fee_rate, 0.1);
    assert.equal(queried.summary.management_roi, 10);
    assert.equal(queried.summary.platform_roi, 5);

    const analyzeResponse = await fetch(`${baseUrl}/api/agent-tools/operations/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ecom-agent-token": token },
      body: JSON.stringify(payload),
    });
    assert.equal(analyzeResponse.status, 200);
    const analyzed = await analyzeResponse.json();
    assert.equal(analyzed.analysis.source, "qwenpaw");
    assert.equal(analyzed.analysis.query.entityType, "product");
    assert.match(analyzed.analysis.insights.join("\n"), /所选商品净 GSV 900/);

    const db = await readDb();
    const saved = normalizeOperationsState(db.operations).analyses.at(-1);
    assert.equal(saved.source, "qwenpaw");
    assert.equal(saved.query.entityIds[0], "1001");
  } finally {
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
