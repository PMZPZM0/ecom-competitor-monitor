import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOperationsWorkspace } from "./operationsAssistantService.js";
import { buildOperationsWorkspace as buildBrowserWorkspace } from "../../shared/operationsCore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function report(type, rows) {
  return {
    id: `${type}-daily`,
    type,
    storeName: "验证店",
    periodKind: "day",
    periodStart: "2026-07-29",
    periodEnd: "2026-07-29",
    periodLabel: "2026-07-29",
    importedAt: "2026-07-30T00:00:00.000Z",
    kind: "csv",
    columns: [],
    rows,
  };
}

test("browser-local and desktop operations workspaces use the identical core formulas", () => {
  const reports = [
    report("product", [{
      storeName: "验证店", productId: "1001", productName: "验证产品", category: "厨房小家电",
      spend: null, grossRevenue: 1_000, revenue: 880, refundAmount: 120, refundDataAvailable: true,
      roi: null,
    }]),
    report("campaign", [{
      storeName: "验证店", productId: "1001", productName: "验证产品", channel: "全站推广",
      spend: 176, grossRevenue: 704, revenue: 704, refundAmount: 0, refundDataAvailable: true,
      roi: 4,
    }]),
  ];
  const input = { reports, storeNames: ["验证店"] };
  const options = { filters: { sourcePeriodKind: "auto" } };
  const desktop = buildOperationsWorkspace(input, options);
  const browser = buildBrowserWorkspace(input, options);

  assert.deepEqual(browser.dashboard, desktop.dashboard);
  assert.equal(browser.dashboard.store.revenue, 880);
  assert.equal(browser.dashboard.store.spend, 176);
  assert.equal(browser.dashboard.store.feeRate, 0.2);
  assert.equal(browser.dashboard.store.roi, 4);
});

test("promotion type uses linked net GSV while plans use their own promotion revenue", () => {
  const reports = [
    report("product", [
      {
        storeName: "验证店", productId: "1001", productName: "压力锅 A", category: "电压力锅",
        grossRevenue: 10_000, revenue: 10_000, refundAmount: 0, refundDataAvailable: true,
      },
      {
        storeName: "验证店", productId: "1002", productName: "压力锅 B", category: "电压力锅",
        grossRevenue: 20_000, revenue: 20_000, refundAmount: 0, refundDataAvailable: true,
      },
    ]),
    report("category", [{
      storeName: "验证店", primaryCategory: "厨房电器", secondaryCategory: "电压力锅", category: "电压力锅",
      grossRevenue: 30_000, revenue: 30_000, refundAmount: 0, refundDataAvailable: true,
    }]),
    report("campaign", [
      {
        storeName: "验证店", productId: "1001", productName: "压力锅 A", category: "电压力锅",
        channel: "全站推广", campaignName: "计划 A", spend: 1_000, revenue: 4_000,
      },
      {
        storeName: "验证店", productId: "1002", productName: "压力锅 B", category: "电压力锅",
        channel: "全站推广", campaignName: "计划 B", spend: 1_000, revenue: 5_000,
      },
    ]),
  ];

  const workspace = buildOperationsWorkspace({ reports }, { filters: { sourcePeriodKind: "auto" } });
  const category = workspace.dashboard.categories.find((item) => item.name === "电压力锅");
  const channel = category?.promotionChannels.find((item) => item.name === "全站推广");
  const planA = channel?.plans.find((item) => item.name === "计划 A");
  const planB = channel?.plans.find((item) => item.name === "计划 B");

  assert.equal(category?.feeRate, 2_000 / 30_000);
  assert.equal(channel?.feeRate, 2_000 / 30_000);
  assert.equal(planA?.linkedRevenue, 10_000);
  assert.equal(planA?.feeRate, 1_000 / 4_000);
  assert.equal(planB?.linkedRevenue, 20_000);
  assert.equal(planB?.feeRate, 1_000 / 5_000);
  assert.notEqual(planA?.feeRate, 1_000 / 30_000);
  assert.notEqual(planA?.feeRate, 1_000 / 10_000);
});

test("promotion plan fee rate remains based on its own promotion revenue when link matching is unavailable", () => {
  const reports = [
    report("product", [{
      storeName: "验证店", productId: "1001", productName: "压力锅 A", category: "电压力锅",
      grossRevenue: 10_000, revenue: 10_000, refundAmount: 0, refundDataAvailable: true,
    }]),
    report("category", [{
      storeName: "验证店", primaryCategory: "厨房电器", secondaryCategory: "电压力锅", category: "电压力锅",
      grossRevenue: 10_000, revenue: 10_000, refundAmount: 0, refundDataAvailable: true,
    }]),
    report("campaign", [{
      storeName: "验证店", productId: "9999", productName: "不存在的链接", category: "电压力锅",
      channel: "全站推广", campaignName: "无关联计划", spend: 1_000, revenue: 4_000,
    }]),
  ];

  const workspace = buildOperationsWorkspace({ reports }, { filters: { sourcePeriodKind: "auto" } });
  const category = workspace.dashboard.categories.find((item) => item.name === "电压力锅");
  const plan = category?.promotionChannels[0]?.plans[0];

  assert.equal(plan?.linkedRevenue, null);
  assert.equal(plan?.feeRate, 0.25);
});

test("a keyword channel aggregates outside while each plan uses its own promotion revenue", () => {
  const reports = [
    report("product", [{
      storeName: "验证店", productId: "1001", productName: "压力锅 A", category: "电压力锅",
      grossRevenue: 10_000, revenue: 10_000, refundAmount: 0, refundDataAvailable: true,
    }]),
    report("campaign", [
      { storeName: "验证店", productId: "1001", productName: "压力锅 A", channel: "关键词推广", campaignName: "关键词计划 A", spend: 50, revenue: 300 },
      { storeName: "验证店", productId: "1001", productName: "压力锅 A", channel: "关键词推广", campaignName: "关键词计划 B", spend: 50, revenue: 300 },
    ]),
  ];
  const workspace = buildOperationsWorkspace({ reports }, { filters: { sourcePeriodKind: "auto" } });
  const keyword = workspace.dashboard.products[0]?.promotionChannels.find((item) => item.name === "关键词推广");

  assert.equal(keyword?.linkedRevenue, 10_000);
  assert.equal(keyword?.feeRate, 0.01);
  assert.deepEqual(keyword?.plans.map((plan) => ({ spend: plan.spend, rate: plan.feeRate })), [
    { spend: 50, rate: 50 / 300 },
    { spend: 50, rate: 50 / 300 },
  ]);
  assert.notEqual(keyword?.feeRate, 100 / 20_000);
});

test("the browser-served core is copied byte-for-byte from the shared operations core", async () => {
  const [shared, served] = await Promise.all([
    fs.readFile(path.join(root, "shared", "operationsCore.js"), "utf8"),
    fs.readFile(path.join(root, "cloud-data-hub", "public", "operationsCore.js"), "utf8"),
  ]);
  assert.equal(served, shared);
});
