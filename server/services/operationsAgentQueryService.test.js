import assert from "node:assert/strict";
import test from "node:test";
import {
  operationsAgentQueryPayload,
  operationsAgentSchema,
  projectOperationsWorkspaceForAgent,
} from "./operationsAgentQueryService.js";

function metric(values = {}) {
  return {
    spend: 0, grossRevenue: 0, refundAmount: 0, netGsv: 0, refundDataAvailable: false, revenue: 0,
    orders: 0, clicks: 0, impressions: 0, visitors: 0, pageViews: 0, favorites: 0, cartUsers: 0,
    cartItems: 0, paidBuyers: 0, paidItems: 0, feeRate: null, roi: null, conversionRate: null,
    collectionCartRate: null, cpc: null, costPerCollectCart: null,
    ...values,
  };
}

function product({ id, model, revenue, spend, promotionRevenue }) {
  const sales = metric({
    grossRevenue: revenue + 50,
    refundAmount: 50,
    revenue,
    netGsv: revenue,
    refundDataAvailable: true,
    visitors: revenue / 10,
    paidBuyers: revenue / 100,
  });
  const promotion = metric({ spend, revenue: promotionRevenue, netGsv: promotionRevenue, clicks: spend * 2, impressions: spend * 20, orders: spend / 10 });
  return {
    key: `product:${id}`,
    name: `商品 ${model}`,
    productId: id,
    model,
    category: "锅具",
    storeName: "测试店",
    matchStatus: "id",
    sales,
    promotion,
    salesCount: 1,
    promotionCount: 1,
    revenue,
    grossRevenue: sales.grossRevenue,
    refundAmount: sales.refundAmount,
    refundDataAvailable: true,
    spend,
    promotionRevenue,
    promotionChannels: [],
    promotionCoverageComplete: true,
    roi: promotionRevenue / spend,
    feeRate: spend / revenue,
    visitors: sales.visitors,
    paidBuyers: sales.paidBuyers,
    conversionRate: sales.paidBuyers / sales.visitors,
    clicks: promotion.clicks,
    impressions: promotion.impressions,
    orders: promotion.orders,
    salesDeduction: 0,
    managementRoi: revenue / spend,
  };
}

function workspace() {
  const products = [
    product({ id: "1001", model: "A1", revenue: 1_000, spend: 100, promotionRevenue: 600 }),
    product({ id: "1002", model: "B2", revenue: 500, spend: 100, promotionRevenue: 300 }),
  ];
  const store = {
    ...products[0],
    key: "store:test",
    name: "测试店",
    productId: "",
    model: "",
    category: "",
  };
  return {
    filters: { periodKind: "all", sourcePeriodKind: "auto", start: "2026-07-01", end: "2026-07-31", storeName: "测试店" },
    freshness: { fresh: true, latestAt: "2026-07-31T00:00:00.000Z" },
    reports: [{ id: "report-1", type: "product", storeName: "测试店", periodKind: "month", periodStart: "2026-07-01", periodEnd: "2026-07-31", reportDate: "2026-07-31", sourceName: "商品排行", fileName: "商品.xlsx", importedAt: "2026-08-01T00:00:00.000Z" }],
    dashboard: {
      store,
      stores: [store],
      products,
      categories: [],
      sourceCoverage: { storePromotionComplete: true, categoryPromotionComplete: true },
      sourceWarnings: { storePromotion: null, categoryPromotion: null },
    },
    storeOverview: { revenue: store.sales, performance: store.promotion, managementRoi: store.managementRoi, salesDeduction: 0 },
    totals: store.sales,
    products: [],
    categories: [],
    audiences: [],
    suggestions: [],
  };
}

test("operations Agent schema documents the audited GSV and fee-rate formulas", () => {
  const schema = operationsAgentSchema();
  assert.ok(schema.metrics.some((metric) => metric.key === "gsv" && /支付金额 - 成功退款金额/.test(metric.formula)));
  assert.ok(schema.metrics.some((metric) => metric.key === "fee_rate" && /推广花费 \/ 净 GSV/.test(metric.formula)));
  assert.ok(schema.rules.some((rule) => /绝不平均各行比率/.test(rule)));
});

test("operations Agent product selection recomputes ratios from summed numerators and denominators", () => {
  const result = operationsAgentQueryPayload(workspace(), {
    entityType: "product",
    entityIds: ["1001", "B2", "missing"],
    metrics: ["gsv", "promotion_spend", "fee_rate", "management_roi", "platform_roi"],
  });

  assert.equal(result.entities.product.matchedCount, 2);
  assert.deepEqual(result.matched.missingEntityIds, ["missing"]);
  assert.equal(result.summary.gsv, 1_500);
  assert.equal(result.summary.promotion_spend, 200);
  assert.equal(result.summary.fee_rate, 200 / 1_500);
  assert.equal(result.summary.management_roi, 1_500 / 200);
  assert.equal(result.summary.platform_roi, 900 / 200);
  assert.deepEqual(Object.keys(result.entities.product.items[0].metrics), ["gsv", "promotion_spend", "fee_rate", "management_roi", "platform_roi"]);
});

test("operations Agent analysis workspace contains only the explicitly selected entity scope", () => {
  const projected = projectOperationsWorkspaceForAgent(workspace(), {
    entityType: "product",
    entityIds: ["1002"],
    metrics: ["gsv", "fee_rate"],
  });

  assert.equal(projected.dashboard.products.length, 1);
  assert.equal(projected.dashboard.products[0].productId, "1002");
  assert.equal(projected.storeOverview.revenue.revenue, 500);
  assert.equal(projected.storeOverview.performance.spend, 100);
  assert.equal(projected.storeOverview.performance.feeRate, 0.2);
  assert.equal(projected.agentQuery.entityType, "product");
});
