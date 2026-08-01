import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import {
  analyzeOperationsWorkspace,
  askOperationsAgent,
  buildOperationsLedger,
  buildOperationsWorkspace,
  clearOperationsAnalyses,
  createProductCatalogEntries,
  createOperationsReport,
  operationsAgentContextText,
  normalizeOperationsState,
  unassignOperationsStore,
  normalizeUploadedFilename,
  lockQwenPawBuiltinTools,
  parseOperationsFile,
  parseProductCatalogFile,
  qwenPawBootstrapPlan,
  qwenPawRuntimeStatus,
  qwenPawSyncPlan,
  qwenPawWorkspaceAgentInstructions,
} from "./operationsAssistantService.js";
import { updateModelConfig } from "./modelConfigService.js";

async function promotionReport(rows, { importedAt = new Date("2026-07-23T08:00:00.000Z") } = {}) {
  const source = ["商品名称,商品阶段,消耗,成交金额,订单数,点击量,计划名称,店铺名称", ...rows].join("\n");
  const file = { originalname: "推广报表.csv", buffer: Buffer.from(source, "utf8") };
  const parsed = await parseOperationsFile(file);
  return createOperationsReport({ type: "promotion", reportDate: "2026-07-23", sourceName: "万相台" }, parsed, { file, now: importedAt });
}

test("operations assistant calculates local fee rate and budget advice from imported rows", async () => {
  const report = await promotionReport([
    "新品锅具,新品,100,150,1,100,计划A,店铺A",
    "成熟锅具,老品,100,500,8,120,计划B,店铺A",
  ]);
  const workspace = buildOperationsWorkspace({
    reports: [report],
    targets: {
      新品锅具: { targetRoi: 2, maxFeeRate: 0.3, dailyBudgetCap: 0 },
      成熟锅具: { targetRoi: 2, maxFeeRate: 0.3, dailyBudgetCap: 0 },
    },
  }, { now: new Date("2026-07-23T12:00:00.000Z") });

  assert.equal(workspace.totals.spend, 200);
  assert.equal(workspace.totals.revenue, 650);
  assert.equal(workspace.totals.roi, 3.25);
  assert.equal(workspace.totals.feeRate, null);
  assert.equal(workspace.products.find((item) => item.name === "新品锅具")?.productStage, "new");
  assert.equal(workspace.products.find((item) => item.name === "成熟锅具")?.productStage, "mature");
  assert.equal(workspace.suggestions.find((item) => item.productName === "新品锅具")?.action, "降预算");
  assert.equal(workspace.suggestions.find((item) => item.productName === "成熟锅具")?.action, "加预算");
  assert.equal(workspace.suggestions.find((item) => item.productName === "新品锅具")?.feeRate, null);
});

test("clearing operations analyses preserves local reports, source data, and Agent chat", async () => {
  const report = await promotionReport(["锅具A,新品,100,300,3,100,计划A,店铺A"]);
  const state = normalizeOperationsState({
    reports: [report],
    chat: [{ id: "chat-1", role: "assistant", content: "保留这段对话", createdAt: "2026-07-23T08:00:00.000Z" }],
    analyses: [{ id: "analysis-1", source: "manual", mode: "ai", summary: "待清空", insights: [], actions: [], createdAt: "2026-07-23T08:00:00.000Z" }],
  });
  const cleared = clearOperationsAnalyses(state);
  assert.deepEqual(cleared.analyses, []);
  assert.equal(cleared.reports.length, 1);
  assert.equal(cleared.reports[0]?.rows.length, 1);
  assert.equal(cleared.chat[0]?.content, "保留这段对话");
});

test("operations assistant parses uploaded XLSX reports into locally computable rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("推广报表");
  sheet.addRow(["商品名称", "消耗", "成交金额", "订单数"]);
  sheet.addRow(["测试锅具", 120, 600, 6]);
  const buffer = await workbook.xlsx.writeBuffer();
  const parsed = await parseOperationsFile({ originalname: "推广报表.xlsx", buffer: Buffer.from(buffer) });

  assert.equal(parsed.kind, "xlsx");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].productName, "测试锅具");
  assert.equal(parsed.rows[0].spend, 120);
  assert.equal(parsed.rows[0].revenue, 600);
});

test("operations assistant restores UTF-8 Chinese filenames and keeps ordinary ASCII names unchanged", () => {
  const garbled = Buffer.from("推广报表.xls", "utf8").toString("latin1");
  const doubleGarbled = Buffer.from(garbled, "utf8").toString("latin1");
  assert.equal(normalizeUploadedFilename(garbled), "推广报表.xls");
  assert.equal(normalizeUploadedFilename(doubleGarbled), "推广报表.xls");
  assert.equal(normalizeUploadedFilename("promotion-report.xlsx"), "promotion-report.xlsx");
  assert.equal(normalizeOperationsState({ reports: [{ id: "ops-1", type: "promotion", fileName: garbled, rows: [] }] }).reports[0].fileName, "推广报表.xls");
});

test("operations warehouse keeps manually added stores available before a report is uploaded", () => {
  const state = normalizeOperationsState({
    storeNames: ["本店", "对面店铺"],
    reports: [{ id: "ops-1", type: "product", storeName: "本店", fileName: "商品报表.csv", rows: [] }],
  });
  assert.deepEqual(state.storeNames, ["本店", "对面店铺"]);
  const workspace = buildOperationsWorkspace(state);
  assert.deepEqual(workspace.storeNames, ["本店", "对面店铺"]);
});

test("removing an operations store keeps its reports, catalog, and deductions as unassigned", () => {
  const state = normalizeOperationsState({
    storeNames: ["本店", "对面店铺"],
    reports: [{
      id: "ops-store-remove",
      type: "product",
      storeName: "本店",
      reportDate: "2026-07-30",
      fileName: "商品报表.csv",
      rows: [{ productId: "1001", productName: "测试商品", storeName: "旧导出店铺", revenue: 100 }],
    }],
    productCatalog: [{ id: "catalog-store-remove", storeName: "本店", productId: "1001", category: "测试品类", model: "A1", sourceName: "ID型号表", createdAt: "2026-07-30T00:00:00.000Z" }],
    salesDeductions: [{ id: "deduction-store-remove", storeName: "本店", reportDate: "2026-07-30", amount: 50, note: "大单扣除", createdAt: "2026-07-30T00:00:00.000Z" }],
  });

  const result = unassignOperationsStore(state, "本店");
  assert.ok(result);
  assert.equal(result.reportCount, 1);
  assert.equal(result.productCatalogCount, 1);
  assert.equal(result.salesDeductionCount, 1);
  assert.equal(result.state.reports[0].storeName, "未归属店铺");
  assert.equal(result.state.productCatalog[0].storeName, "未归属店铺");
  assert.equal(result.state.salesDeductions[0].storeName, "未归属店铺");
  assert.ok(!result.state.storeNames.includes("本店"));
  assert.ok(result.state.storeNames.includes("未归属店铺"));
  assert.equal(buildOperationsWorkspace(result.state, { filters: { storeName: "未归属店铺" } }).reports.length, 1);
  assert.equal(unassignOperationsStore(result.state, "未归属店铺"), null);
});

test("operations assistant imports WPS GBK CSV exports and tabular text with a detected header", async () => {
  const gbkCsv = Buffer.from([
    0xc9, 0xcc, 0xc6, 0xb7, 0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xcf, 0xfb, 0xba, 0xc4,
    0x2c, 0xb3, 0xc9, 0xbd, 0xbb, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xb9, 0xf8, 0xbe,
    0xdf, 0x2c, 0x31, 0x30, 0x30, 0x2c, 0x35, 0x30, 0x30,
  ]);
  const parsed = await parseOperationsFile({ originalname: "营销场景报表.csv", buffer: gbkCsv });

  assert.equal(parsed.kind, "csv");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].productName, "锅具");
  assert.equal(parsed.rows[0].spend, 100);
  assert.equal(parsed.rows[0].revenue, 500);
});

test("operations warehouse keeps the operator-selected report type and keeps weekly batches out of daily views", async () => {
  const source = [
    "日期,计划ID,计划名字,主体ID,主体名称,花费,总成交金额,总成交笔数,点击量,展现量",
    "2026-07-20,1,全站推广,2,测试锅具,100,800,4,100,2000",
    "2026-07-26,1,全站推广,2,测试锅具,120,960,5,120,2500",
  ].join("\n");
  const file = { originalname: "商品报表_20260727.csv", buffer: Buffer.from(source, "utf8") };
  const parsed = await parseOperationsFile(file);
  const report = createOperationsReport({ type: "campaign", periodKind: "week" }, parsed, { file });

  assert.deepEqual(parsed.period, { start: "2026-07-20", end: "2026-07-26", label: "2026-07-20 至 2026-07-26" });
  assert.equal(report.type, "campaign");
  assert.equal(report.detectedType, "campaign");
  assert.equal(report.periodKind, "week");
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "day" } }).reports.length, 0);
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "week" } }).reports.length, 1);
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "custom", start: "2026-07-20", end: "2026-07-26" } }).reports.length, 1);
});

test("operations ledger backfills raw reports and calculates workspace metrics only from local ledger rows", async () => {
  const productFile = {
    originalname: "商品排行.csv",
    buffer: Buffer.from([
      "商品ID,商品名称,支付金额,成功退款金额",
      "1001,电饭煲A,1000,100",
      "1001,电饭煲A,500,50",
      "合计,合计,1500,150",
    ].join("\n"), "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from([
      "商品ID,主体名称,推广渠道,消耗,总成交金额",
      "1001,电饭煲A,全站推广,100,600",
      "1001,电饭煲A,关键词推广,50,300",
    ].join("\n"), "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });

  const state = normalizeOperationsState({ reports: [product, campaign] });
  const productLedger = state.ledger.find((row) => row.sourceReportId === product.id && row.productId === "1001");
  assert.equal(state.ledgerVersion, 2);
  assert.match(state.ledgerSourceSignature, /^[a-f0-9]{64}$/);
  assert.equal(product.rows.length, 3);
  assert.equal(productLedger?.rowCount, 2);
  assert.equal(productLedger?.grossRevenue, 1500);
  assert.equal(productLedger?.refundAmount, 150);
  assert.equal(productLedger?.revenue, 1350);
  assert.equal(state.ledger.filter((row) => row.sourceReportId === campaign.id).length, 2);

  const workspace = buildOperationsWorkspace(state, {
    filters: { periodKind: "custom", sourcePeriodKind: "day", start: "2026-07-26", end: "2026-07-26" },
  });
  assert.equal(workspace.reports.find((report) => report.id === product.id)?.rows.length, 3);
  assert.equal(workspace.dashboard.products.find((item) => item.productId === "1001")?.revenue, 1350);
  assert.equal(workspace.dashboard.products.find((item) => item.productId === "1001")?.spend, 150);
  assert.deepEqual(
    workspace.dashboard.products.find((item) => item.productId === "1001")?.promotionChannels.map((item) => item.name).sort(),
    ["全站推广", "关键词推广"],
  );
});

test("operations ledger isolates report periods and ignores superseded imports in the same source period", async () => {
  const file = (amount) => ({
    originalname: "商品排行.csv",
    buffer: Buffer.from(`商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,${amount},0\n`, "utf8"),
  });
  const dayOriginalFile = file(100);
  const dayOriginal = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26", periodKind: "day" }, await parseOperationsFile(dayOriginalFile), {
    file: dayOriginalFile,
    now: new Date("2026-07-27T08:00:00.000Z"),
  });
  const dayReplacementFile = file(200);
  const dayReplacement = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26", periodKind: "day" }, await parseOperationsFile(dayReplacementFile), {
    file: dayReplacementFile,
    now: new Date("2026-07-27T09:00:00.000Z"),
  });
  const weekFile = file(700);
  const week = createOperationsReport({
    type: "product", storeName: "店铺A", periodKind: "week", periodStart: "2026-07-20", periodEnd: "2026-07-26",
  }, await parseOperationsFile(weekFile), { file: weekFile });

  const state = normalizeOperationsState({ reports: [dayOriginal, dayReplacement, week] });
  const dayWorkspace = buildOperationsWorkspace(state, {
    filters: { periodKind: "custom", sourcePeriodKind: "day", start: "2026-07-20", end: "2026-07-26" },
  });
  const weekWorkspace = buildOperationsWorkspace(state, {
    filters: { periodKind: "custom", sourcePeriodKind: "week", start: "2026-07-20", end: "2026-07-26" },
  });
  assert.equal(dayWorkspace.dashboard.store.revenue, 200);
  assert.equal(weekWorkspace.dashboard.store.revenue, 700);

  const afterDelete = normalizeOperationsState({
    ...state,
    reports: state.reports.filter((report) => report.id !== dayReplacement.id),
  });
  assert.equal(afterDelete.ledger.some((row) => row.sourceReportId === dayReplacement.id), false);
  assert.equal(buildOperationsWorkspace(afterDelete, {
    filters: { periodKind: "custom", sourcePeriodKind: "day", start: "2026-07-26", end: "2026-07-26" },
  }).dashboard.store.revenue, 100);
  assert.deepEqual(
    buildOperationsLedger(afterDelete.reports).map((row) => ({ source: row.sourceReportId, revenue: row.revenue })),
    afterDelete.ledger.map((row) => ({ source: row.sourceReportId, revenue: row.revenue })),
  );
});

test("a selected date range aggregates matching daily product and campaign reports instead of keeping only the latest day", async () => {
  const productFile = {
    originalname: "商品排行.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,1000,100\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,消耗,总成交金额\n1001,电饭煲A,100,500\n", "utf8"),
  };
  const productDayOne = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaignDayOne = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const productDayTwo = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-27" }, await parseOperationsFile({
    ...productFile,
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,2000,200\n", "utf8"),
  }), { file: productFile });
  const campaignDayTwo = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-27" }, await parseOperationsFile({
    ...campaignFile,
    buffer: Buffer.from("商品ID,主体名称,消耗,总成交金额\n1001,电饭煲A,200,900\n", "utf8"),
  }), { file: campaignFile });
  const workspace = buildOperationsWorkspace({
    reports: [productDayOne, campaignDayOne, productDayTwo, campaignDayTwo],
  }, { filters: { periodKind: "custom", start: "2026-07-26", end: "2026-07-27" } });

  assert.equal(workspace.reports.length, 4);
  assert.equal(workspace.dashboard.store.grossRevenue, 3000);
  assert.equal(workspace.dashboard.store.refundAmount, 300);
  assert.equal(workspace.dashboard.store.revenue, 2700);
  assert.equal(workspace.dashboard.store.spend, 300);
  assert.equal(workspace.dashboard.store.feeRate, 300 / 2700);
  assert.equal(workspace.dashboard.store.managementRoi, 2700 / 300);
  assert.deepEqual(workspace.dashboard.trend.map((item) => item.date), ["2026-07-26", "2026-07-27"]);
});

test("a selected date range keeps sales from a day whose promotion report has not been imported without fabricating a cross-period rate", async () => {
  const productFile = {
    originalname: "商品排行.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,1000,100\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,消耗,总成交金额\n1001,电饭煲A,100,500\n", "utf8"),
  };
  const productDayOne = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaignDayOne = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const productDayTwo = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-27" }, await parseOperationsFile({
    ...productFile,
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,2000,200\n", "utf8"),
  }), { file: productFile });
  const workspace = buildOperationsWorkspace({
    reports: [productDayOne, campaignDayOne, productDayTwo],
  }, { filters: { periodKind: "custom", start: "2026-07-26", end: "2026-07-27" } });

  assert.equal(workspace.dashboard.store.grossRevenue, 3000);
  assert.equal(workspace.dashboard.store.revenue, 2700);
  assert.equal(workspace.dashboard.store.spend, 100);
  assert.equal(workspace.dashboard.store.feeRate, null);
  assert.equal(workspace.dashboard.store.managementRoi, null);
  assert.equal(workspace.dashboard.store.promotionCoverageComplete, false);
  assert.equal(workspace.dashboard.products[0]?.feeRate, null);
  assert.equal(workspace.dashboard.products[0]?.revenue, 2700);
  assert.equal(workspace.suggestions.length, 0);
  assert.match(workspace.dashboard.sourceWarnings.storePromotion || "", /2026-07-27/);
  assert.match(workspace.dashboard.sourceWarnings.storePromotion || "", /ROI 和费率不计算/);
  assert.equal(workspace.dashboard.trend.find((item) => item.date === "2026-07-27")?.feeRate, null);
  assert.deepEqual(workspace.dashboard.trend.map((item) => item.date), ["2026-07-26", "2026-07-27"]);
});

test("a manually confirmed monthly range stays monthly when the report only contains its month-end date", async () => {
  const file = {
    originalname: "品类-标准类目-2026-06-30.csv",
    buffer: Buffer.from("统计日期,一级类目名称,二级类目名称,支付金额,成功退款金额\n2026-06-30,厨房电器,电饭煲,1200,100\n", "utf8"),
  };
  const parsed = await parseOperationsFile(file);
  const report = createOperationsReport({
    type: "category",
    periodKind: "month",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
  }, parsed, { file });

  assert.deepEqual(parsed.period, { start: "2026-06-30", end: "2026-06-30", label: "2026-06-30" });
  assert.equal(report.periodKind, "month");
  assert.equal(report.periodStart, "2026-06-01");
  assert.equal(report.periodEnd, "2026-06-30");
  assert.equal(report.periodLabel, "2026-06-01 至 2026-06-30");
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "month" } }).reports.length, 1);
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "day" } }).reports.length, 0);
  assert.equal(buildOperationsWorkspace({ reports: [report] }, { filters: { periodKind: "custom", start: "2026-06-01", end: "2026-06-30" } }).reports.length, 1);
});

test("automatic source selection never presents a monthly rate when only one daily promotion ledger is available", async () => {
  const productFile = {
    originalname: "商品排行.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,3000,300\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,消耗,总成交金额\n1001,电饭煲A,100,500\n", "utf8"),
  };
  const monthlyProduct = createOperationsReport({
    type: "product", storeName: "店铺A", periodKind: "month", periodStart: "2026-06-01", periodEnd: "2026-06-30",
  }, await parseOperationsFile(productFile), { file: productFile });
  const duplicateDailyProduct = createOperationsReport({
    type: "product", storeName: "店铺A", reportDate: "2026-06-30",
  }, await parseOperationsFile({ ...productFile, buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,999,99\n", "utf8") }), { file: productFile });
  const dailyCampaign = createOperationsReport({
    type: "campaign", storeName: "店铺A", reportDate: "2026-06-30",
  }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const workspace = buildOperationsWorkspace({ reports: [monthlyProduct, duplicateDailyProduct, dailyCampaign] }, {
    filters: { periodKind: "custom", sourcePeriodKind: "auto", start: "2026-06-01", end: "2026-06-30" },
  });

  assert.deepEqual(workspace.reports.map((report) => report.id).sort(), [monthlyProduct.id, dailyCampaign.id].sort());
  assert.equal(workspace.dashboard.store.grossRevenue, 3000);
  assert.equal(workspace.dashboard.store.refundAmount, 300);
  assert.equal(workspace.dashboard.store.revenue, 2700);
  assert.equal(workspace.dashboard.store.spend, 100);
  assert.equal(workspace.dashboard.store.feeRate, null);
  assert.equal(workspace.dashboard.store.managementRoi, null);
  assert.match(workspace.dashboard.sourceWarnings.storePromotion || "", /ROI 和费率不计算/);
});

test("monthly category ledger supplies store GSV when product ranking was not imported", async () => {
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from([
      "一级类目名称,二级类目名称,支付金额,成功退款金额",
      "厨房电器,厨房电器,厨房电器,9999,999",
      "厨房电器,电饭煲,1200,100",
      "厨房电器,电水壶,800,50",
    ].join("\n"), "utf8"),
  };
  const monthlyCategory = createOperationsReport({
    type: "category", storeName: "店铺A", periodKind: "month", periodStart: "2026-06-01", periodEnd: "2026-06-30",
  }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const workspace = buildOperationsWorkspace({ reports: [monthlyCategory] }, {
    filters: { periodKind: "custom", sourcePeriodKind: "auto", start: "2026-06-01", end: "2026-06-30" },
  });

  assert.equal(workspace.dashboard.store.grossRevenue, 2000);
  assert.equal(workspace.dashboard.store.refundAmount, 150);
  assert.equal(workspace.dashboard.store.revenue, 1850);
  assert.equal(workspace.dashboard.sources.storeSales?.type, "category");
  assert.match(workspace.dashboard.sourceWarnings.storePromotion || "", /尚未导入对应的单品付费报表/);
});

test("operations assistant never treats an export filename date as the report date", async () => {
  const file = {
    originalname: "分类目场景分析_本店_2026-07-27 20_52_49.xlsx",
    buffer: Buffer.from("类目,消耗,总成交金额\n电饭锅,120,580\n", "utf8"),
  };
  const parsed = await parseOperationsFile(file);

  assert.equal(parsed.period, null);
  assert.throws(
    () => createOperationsReport({ type: "scenario" }, parsed, { file }),
    /未检测到报表统计日期/,
  );

  const confirmed = createOperationsReport({ type: "scenario", reportDate: "2026-07-26" }, parsed, { file });
  assert.equal(confirmed.reportDate, "2026-07-26");
  assert.equal(confirmed.periodStart, "2026-07-26");
  assert.equal(confirmed.periodEnd, "2026-07-26");
});

test("operations upload preview recognizes supported report types and dates from report content", async () => {
  const cases = [
    {
      file: {
        originalname: "品类-标准类目-2026-07-26.csv",
        buffer: Buffer.from("统计日期,一级类目名称,二级类目名称,支付金额,成功退款金额\n2026-07-26,厨房电器,电饭煲,1200,100\n", "utf8"),
      },
      type: "category",
      period: { start: "2026-07-26", end: "2026-07-26", label: "2026-07-26" },
    },
    {
      file: {
        originalname: "【生意参谋平台】商品_全部_2026-07-20_2026-07-26.csv",
        buffer: Buffer.from("统计日期,商品ID,商品名称,支付金额,成功退款金额\n2026-07-26,1001,电饭煲A,1000,100\n", "utf8"),
      },
      type: "product",
      period: { start: "2026-07-26", end: "2026-07-26", label: "2026-07-26" },
    },
    {
      file: {
        originalname: "商品报表_20260727.csv",
        buffer: Buffer.from("统计日期,商品ID,计划名称,推广方式,消耗,总成交金额\n2026-07-26,1001,计划A,全站推广,100,500\n", "utf8"),
      },
      type: "campaign",
      period: { start: "2026-07-26", end: "2026-07-26", label: "2026-07-26" },
    },
  ];

  for (const { file, type, period } of cases) {
    const parsed = await parseOperationsFile(file);
    assert.equal(parsed.detectedType, type, file.originalname);
    assert.deepEqual(parsed.period, period, file.originalname);
  }
});

test("category scenario exports unify the former duplicate category-spend type", async () => {
  const scenarioFile = {
    originalname: "分类目场景分析_本店_2026-07-29.csv",
    buffer: Buffer.from("类目,无界一级场景,消耗,总成交金额\n电饭锅,关键词推广,120,580\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,售中售后成功退款金额\n厨房电器,电饭锅,1200,100\n", "utf8"),
  };
  const parsedScenario = await parseOperationsFile(scenarioFile);
  const importedWithFormerLabel = createOperationsReport(
    { type: "promotion", storeName: "店铺A", reportDate: "2026-07-28" },
    parsedScenario,
    { file: scenarioFile },
  );
  const normalizedLegacy = normalizeOperationsState({
    reports: [{ ...importedWithFormerLabel, type: "promotion", detectedType: "promotion" }],
  }).reports[0];
  const category = createOperationsReport(
    { type: "category", storeName: "店铺A", reportDate: "2026-07-28" },
    await parseOperationsFile(categoryFile),
    { file: categoryFile },
  );
  const workspace = buildOperationsWorkspace({ reports: [category, normalizedLegacy] });

  assert.equal(importedWithFormerLabel.type, "scenario");
  assert.equal(normalizedLegacy.type, "scenario");
  assert.equal(workspace.dashboard.categories.find((item) => item.name === "电饭锅")?.spend, 0);
  assert.equal(workspace.dashboard.sources.categoryPromotion, null);
});

test("category promotion is derived from item promotion IDs and keeps every channel separate", async () => {
  const productFile = {
    originalname: "商品经营.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭锅A,1000,100\n1002,电饭锅B,600,60\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,场景名字,计划名字,花费,总成交金额\n1001,电饭锅A,全站推广,计划A,100,500\n1001,电饭锅A,关键词推广,计划B,20,80\n1002,电饭锅B,关键词推广,计划C,40,120\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,成功退款金额\n厨房电器,电饭煲,1600,160\n", "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const catalog = createProductCatalogEntries([
    { storeName: "店铺A", productId: "1001", category: "电饭煲", model: "A1" },
    { storeName: "店铺A", productId: "1002", category: "电饭煲", model: "A2" },
  ], { now: new Date("2026-07-26T08:00:00.000Z") });
  const workspace = buildOperationsWorkspace({ reports: [product, campaign, category], productCatalog: catalog });

  assert.equal(workspace.dashboard.store.spend, 160);
  assert.equal(workspace.dashboard.categories.find((item) => item.name === "电饭煲")?.spend, 160);
  assert.equal(workspace.dashboard.categories.find((item) => item.name === "电饭煲")?.feeRate, 160 / 1440);
  assert.equal(workspace.dashboard.products.length, 2);
  assert.equal(workspace.dashboard.products.reduce((sum, item) => sum + item.spend, 0), 160);
  const productA = workspace.dashboard.products.find((item) => item.productId === "1001");
  assert.equal(productA?.model, "A1");
  assert.deepEqual(productA?.promotionChannels.map((item) => [item.name, item.spend]), [["全站推广", 100], ["关键词推广", 20]]);
  assert.deepEqual(productA?.promotionChannels.map((item) => [item.name, item.planCount, item.plans.map((plan) => plan.name)]), [["全站推广", 1, ["计划A"]], ["关键词推广", 1, ["计划B"]]]);
  assert.deepEqual(campaign.rows.map((row) => row.campaignName), ["计划A", "计划B", "计划C"]);
});

test("promotion plans stay under their reported promotion type and legacy plan-only rows remain unclassified", async () => {
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,场景名字,计划名字,花费,总成交金额\n1001,电饭煲A,全站推广,计划A,100,500\n1001,电饭煲A,全站推广,计划B,40,120\n1001,电饭煲A,关键词推广,计划C,20,80\n", "utf8"),
  };
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const legacyCampaign = {
    ...campaign,
    id: "legacy-campaign",
    rows: [{ ...campaign.rows[0], channel: "计划旧版", campaignName: "计划旧版" }],
  };
  const workspace = buildOperationsWorkspace({ reports: [campaign] });
  const product = workspace.dashboard.products.find((item) => item.productId === "1001");
  assert.deepEqual(product?.promotionChannels.map((item) => [item.name, item.planCount]), [["全站推广", 2], ["关键词推广", 1]]);
  const legacy = buildOperationsWorkspace({ reports: [legacyCampaign] }).dashboard.products.find((item) => item.productId === "1001");
  assert.deepEqual(legacy?.promotionChannels.map((item) => [item.name, item.planCount, item.plans[0]?.name]), [["未识别推广类型", 1, "计划旧版"]]);

  const recoverableLegacy = {
    ...campaign,
    id: "recoverable-legacy-campaign",
    rows: [{ ...campaign.rows[0], channel: "计划A", campaignName: "计划A" }],
  };
  const repaired = normalizeOperationsState({ reports: [campaign, recoverableLegacy] });
  assert.equal(repaired.reports.find((report) => report.id === "recoverable-legacy-campaign")?.rows[0]?.channel, "全站推广");

  const staleLedger = repaired.ledger.map((row) => (
    row.sourceReportId === "recoverable-legacy-campaign" ? { ...row, channel: "计划A" } : row
  ));
  const rebuilt = normalizeOperationsState({ ...repaired, ledgerVersion: 1, ledger: staleLedger });
  assert.equal(rebuilt.ledger.find((row) => row.sourceReportId === "recoverable-legacy-campaign")?.channel, "全站推广");
});

test("promotion imports prefer the verified secondary scenario over a plan-level scene name", async () => {
  const file = {
    originalname: "商品报表.csv",
    buffer: Buffer.from("商品ID,主体名称,场景名字,原二级场景名字,计划名字,花费,总成交金额\n1001,电饭煲A,电饭煲计划,关键词推广,计划A,100,500\n", "utf8"),
  };
  const parsed = await parseOperationsFile(file);
  assert.deepEqual(parsed.rows.map((row) => [row.campaignName, row.channel]), [["计划A", "关键词推广"]]);
  const report = createOperationsReport({ type: "campaign", reportDate: "2026-07-26" }, parsed, { file });
  const product = buildOperationsWorkspace({ reports: [report] }).dashboard.products.find((item) => item.productId === "1001");
  assert.deepEqual(product?.promotionChannels.map((item) => item.name), ["关键词推广"]);
});

test("category promotion aligns catalog categories with unique category 360 composite names", async () => {
  const productFile = {
    originalname: "商品经营.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电磁炉A,1000,100\n1002,电蒸锅A,800,80\n1003,电火锅A,600,60\n1004,绞肉机A,400,40\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,场景名字,花费,总成交金额\n1001,电磁炉A,关键词推广,100,500\n1002,电蒸锅A,全站推广,80,320\n1003,电火锅A,全站推广,60,240\n1004,绞肉机A,关键词推广,40,160\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,成功退款金额\n厨房电器,电磁炉/陶炉,1000,100\n厨房电器,电蒸锅/台式电蒸箱/肠粉机,800,80\n厨房电器,电热火锅/煎锅,600,60\n厨房电器,绞肉/碎肉/绞菜机/佐料机,400,40\n", "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const catalog = createProductCatalogEntries([
    { storeName: "店铺A", productId: "1001", category: "电磁炉" },
    { storeName: "店铺A", productId: "1002", category: "电蒸锅" },
    { storeName: "店铺A", productId: "1003", category: "电火锅" },
    { storeName: "店铺A", productId: "1004", category: "绞肉机" },
  ], { now: new Date("2026-07-26T08:00:00.000Z") });
  const workspace = buildOperationsWorkspace({ reports: [product, campaign, category], productCatalog: catalog });

  assert.deepEqual(
    workspace.dashboard.categories.map((item) => [item.name, item.spend]),
    [
      ["电磁炉/陶炉", 100],
      ["电蒸锅/台式电蒸箱/肠粉机", 80],
      ["电热火锅/煎锅", 60],
      ["绞肉/碎肉/绞菜机/佐料机", 40],
    ],
  );
  assert.equal(workspace.dashboard.categories.reduce((sum, item) => sum + item.spend, 0), 280);
  assert.equal(workspace.dashboard.categories.some((item) => ["电磁炉", "电蒸锅", "电火锅", "绞肉机"].includes(item.name)), false);
  assert.deepEqual(workspace.dashboard.categories.find((item) => item.name === "电磁炉/陶炉")?.promotionChannels.map((item) => item.name), ["关键词推广"]);
  assert.deepEqual(workspace.dashboard.products.find((item) => item.productId === "1001")?.promotionChannels.map((item) => item.name), ["关键词推广"]);
});

test("ambiguous composite categories never duplicate a promotion spend", async () => {
  const campaignFile = {
    originalname: "单品付费.csv",
    buffer: Buffer.from("商品ID,主体名称,花费,总成交金额\n1001,电磁炉A,100,500\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,成功退款金额\n厨房电器,电磁炉/陶炉,1000,100\n厨房电器,电磁炉/商用灶,800,80\n", "utf8"),
  };
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const catalog = createProductCatalogEntries([
    { storeName: "店铺A", productId: "1001", category: "电磁炉" },
  ], { now: new Date("2026-07-26T08:00:00.000Z") });
  const workspace = buildOperationsWorkspace({ reports: [campaign, category], productCatalog: catalog });

  assert.equal(workspace.dashboard.categories.reduce((sum, item) => sum + item.spend, 0), 100);
  assert.equal(workspace.dashboard.categories.find((item) => item.name === "电磁炉")?.spend, 100);
});

test("product catalog retains versions while the latest store and ID mapping wins", async () => {
  const oldVersion = createProductCatalogEntries([{ storeName: "店铺A", productId: "1001", category: "旧品类", model: "旧型号" }], { now: new Date("2026-07-20T08:00:00.000Z") });
  const currentVersion = createProductCatalogEntries([{ storeName: "店铺A", productId: "1001", category: "新品类", model: "新型号" }], { now: new Date("2026-07-26T08:00:00.000Z") });
  const otherStore = createProductCatalogEntries([{ storeName: "店铺B", productId: "1001", category: "另一品类", model: "B型号" }], { now: new Date("2026-07-26T08:00:00.000Z") });
  const file = { originalname: "单品付费.csv", buffer: Buffer.from("商品ID,主体名称,花费,总成交金额\n1001,商品A,20,80\n", "utf8") };
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(file), { file });
  const workspace = buildOperationsWorkspace({ reports: [campaign], productCatalog: [...oldVersion, ...currentVersion, ...otherStore] });

  assert.equal(workspace.productCatalog.length, 3);
  assert.equal(workspace.dashboard.products[0]?.category, "新品类");
  assert.equal(workspace.dashboard.products[0]?.model, "新型号");
});

test("product catalog parser accepts the four-column ID mapping table", async () => {
  const file = { originalname: "ID型号表.csv", buffer: Buffer.from("店铺名,ID,品类名,型号\n店铺A,1001,电饭煲,A1\n", "utf8") };
  const parsed = await parseProductCatalogFile(file);
  assert.deepEqual(parsed.entries, [{ storeName: "店铺A", productId: "1001", category: "电饭煲", model: "A1", sourceName: "", createdAt: "", id: parsed.entries[0].id }]);
});

test("operations assistant prefers the date inside a report over its export filename", async () => {
  const file = {
    originalname: "商品报表_20260727_205132.csv",
    buffer: Buffer.from("统计日期,商品名称,消耗,总成交金额\n2026-07-26,测试锅具,120,580\n", "utf8"),
  };
  const parsed = await parseOperationsFile(file);

  assert.deepEqual(parsed.period, { start: "2026-07-26", end: "2026-07-26", label: "2026-07-26" });
});

test("store overview keeps store GMV and advertising efficiency in their verified source reports", async () => {
  const product = await promotionReport(["全店商品,新品,0,1000,20,0,商品经营,店铺A"]);
  product.type = "product";
  product.periodLabel = "2026-07-20 至 2026-07-26";
  const campaign = await promotionReport(["投放商品,新品,100,500,5,100,全站推广,店铺A"]);
  campaign.type = "campaign";
  campaign.periodLabel = "2026-07-20 至 2026-07-26";
  const workspace = buildOperationsWorkspace({ reports: [product, campaign] });

  assert.equal(workspace.storeOverview.revenue.revenue, 1000);
  assert.equal(workspace.storeOverview.revenueSource?.type, "product");
  assert.equal(workspace.storeOverview.performance.spend, 100);
  assert.equal(workspace.storeOverview.performance.roi, 5);
  assert.equal(workspace.storeOverview.performanceSource?.type, "campaign");
});

test("store sales deductions recalculate only the explicit management scope", async () => {
  const productFile = {
    originalname: "商品经营.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额\n1001,电饭锅A,1000,100\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品推广.csv",
    buffer: Buffer.from("商品ID,主体名称,花费,总成交金额\n1001,电饭锅A,100,500\n", "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const workspace = buildOperationsWorkspace({
    reports: [product, campaign],
    salesDeductions: [
      { id: "deduction-a", storeName: "店铺A", reportDate: "2026-07-26", amount: 200, note: "渠道大单", createdAt: "2026-07-27T00:00:00.000Z" },
      { id: "deduction-other-store", storeName: "店铺B", reportDate: "2026-07-26", amount: 99, note: "不应混入", createdAt: "2026-07-27T00:00:00.000Z" },
    ],
  });

  assert.equal(workspace.dashboard.store.revenue, 700);
  assert.equal(workspace.dashboard.store.salesDeduction, 200);
  assert.equal(workspace.dashboard.store.managementRoi, 7);
  assert.equal(workspace.dashboard.store.feeRate, 100 / 700);
  assert.equal(workspace.dashboard.products.find((item) => item.productId === "1001")?.revenue, 900);
  assert.equal(workspace.dashboard.totalSalesDeduction, 200);
  assert.equal(workspace.salesDeductions.length, 1);
  assert.equal(workspace.salesDeductionHistory.length, 2);
  assert.equal(workspace.storeOverview.managementRoi, 7);
  assert.equal(workspace.storeOverview.performance.roi, 5);
});

test("rolling date ranges aggregate every included daily ledger", async () => {
  const productFile = (amount, refund) => ({
    originalname: "商品排行.csv",
    buffer: Buffer.from(`商品ID,商品名称,支付金额,成功退款金额\n1001,电饭煲A,${amount},${refund}\n`, "utf8"),
  });
  const campaignFile = (spend) => ({
    originalname: "单品付费.csv",
    buffer: Buffer.from(`商品ID,主体名称,消耗,总成交金额\n1001,电饭煲A,${spend},500\n`, "utf8"),
  });
  const reports = [];
  for (const [date, amount, refund, spend] of [
    ["2026-07-25", 1_000, 100, 100],
    ["2026-07-26", 2_000, 200, 200],
  ]) {
    const productSource = productFile(amount, refund);
    const campaignSource = campaignFile(spend);
    reports.push(
      createOperationsReport({ type: "product", storeName: "店铺A", reportDate: date }, await parseOperationsFile(productSource), { file: productSource }),
      createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: date }, await parseOperationsFile(campaignSource), { file: campaignSource }),
    );
  }

  const workspace = buildOperationsWorkspace({ reports }, {
    filters: { periodKind: "custom", sourcePeriodKind: "auto", start: "2026-07-20", end: "2026-07-26" },
  });

  assert.equal(workspace.reports.length, 4);
  assert.equal(workspace.dashboard.store.grossRevenue, 3_000);
  assert.equal(workspace.dashboard.store.refundAmount, 300);
  assert.equal(workspace.dashboard.store.revenue, 2_700);
  assert.equal(workspace.dashboard.store.spend, 300);
  assert.equal(workspace.dashboard.store.feeRate, 300 / 2_700);
  assert.equal(workspace.dashboard.trend.length, 2);
});

test("operations dashboard links product and category sources without mixing sales with attributed promotion revenue", async () => {
  const productFile = {
    originalname: "商品经营.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,商品访客数\n1001,电饭锅A,1000,300\n1002,未投放商品,200,30\n1003,同名但不同ID,400,40\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品推广.csv",
    buffer: Buffer.from("商品ID,主体名称,花费,总成交金额,总成交笔数\n1001,电饭锅A,100,500,5\n1004,同名但不同ID,10,80,1\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类经营.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额\n厨房电器,电饭锅,3000\n", "utf8"),
  };
  const scenarioFile = {
    originalname: "分类目场景.csv",
    buffer: Buffer.from("类目,消耗,总成交金额\n电饭锅,300,2400\n", "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const scenario = createOperationsReport({ type: "scenario", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(scenarioFile), { file: scenarioFile });
  const workspace = buildOperationsWorkspace({ reports: [product, campaign, category, scenario] });

  const item = workspace.dashboard.products.find((value) => value.productId === "1001");
  assert.equal(item?.matchStatus, "id");
  assert.equal(item?.revenue, 1000);
  assert.equal(item?.promotionRevenue, 500);
  assert.equal(item?.spend, 100);
  assert.equal(item?.roi, 5);
  assert.equal(item?.feeRate, null);
  const salesOnly = workspace.dashboard.products.find((value) => value.productId === "1002");
  assert.equal(salesOnly?.matchStatus, "sales-only");
  assert.equal(salesOnly?.roi, null);
  assert.equal(salesOnly?.feeRate, null);
  const sameNameDifferentId = workspace.dashboard.products.find((value) => value.productId === "1003");
  assert.equal(sameNameDifferentId?.matchStatus, "sales-only");
  assert.equal(sameNameDifferentId?.spend, 0);
  assert.equal(workspace.dashboard.products.find((value) => value.productId === "1004")?.matchStatus, "promotion-only");
  const categoryItem = workspace.dashboard.categories.find((value) => value.name === "电饭锅");
  assert.equal(categoryItem?.matchStatus, "sales-only");
  assert.equal(categoryItem?.revenue, 3000);
  assert.equal(categoryItem?.spend, 0);
  assert.equal(categoryItem?.roi, null);
  assert.equal(categoryItem?.feeRate, null);
});

test("operations dashboard calculates store, category, and product fee rates from net GSV", async () => {
  const productFile = {
    originalname: "商品经营.csv",
    buffer: Buffer.from("商品ID,商品名称,支付金额,成功退款金额,商品访客数\n1001,电饭锅A,1000,100,300\n1002,电饭锅B,200,50,30\n", "utf8"),
  };
  const campaignFile = {
    originalname: "单品推广.csv",
    buffer: Buffer.from("商品ID,主体名称,花费,总成交金额,总成交笔数\n1001,电饭锅A,100,500,5\n1002,电饭锅B,20,80,1\n", "utf8"),
  };
  const categoryFile = {
    originalname: "品类经营.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,售中售后成功退款金额\n厨房电器,电饭锅,1200,150\n", "utf8"),
  };
  const scenarioFile = {
    originalname: "分类目场景.csv",
    buffer: Buffer.from("类目,消耗,总成交金额\n电饭锅,120,580\n", "utf8"),
  };
  const product = createOperationsReport({ type: "product", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(productFile), { file: productFile });
  const campaign = createOperationsReport({ type: "campaign", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(campaignFile), { file: campaignFile });
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const scenario = createOperationsReport({ type: "scenario", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(scenarioFile), { file: scenarioFile });
  const workspace = buildOperationsWorkspace({ reports: [product, campaign, category, scenario] });

  const productItem = workspace.dashboard.products.find((item) => item.productId === "1001");
  assert.equal(productItem?.grossRevenue, 1000);
  assert.equal(productItem?.refundAmount, 100);
  assert.equal(productItem?.revenue, 900);
  assert.equal(productItem?.feeRate, 100 / 900);
  assert.equal(productItem?.roi, 5);
  assert.equal(workspace.dashboard.store.grossRevenue, 1200);
  assert.equal(workspace.dashboard.store.refundAmount, 150);
  assert.equal(workspace.dashboard.store.revenue, 1050);
  assert.equal(workspace.dashboard.store.feeRate, 120 / 1050);
  const categoryItem = workspace.dashboard.categories.find((item) => item.name === "电饭锅");
  assert.equal(categoryItem?.grossRevenue, 1200);
  assert.equal(categoryItem?.refundAmount, 150);
  assert.equal(categoryItem?.revenue, 1050);
  assert.equal(categoryItem?.feeRate, null);
  assert.equal(workspace.storeOverview.performance.feeRate, null);
  assert.equal(workspace.suggestions.find((item) => item.productName === "电饭锅A")?.feeRate, 100 / 900);
});

test("category reporting excludes primary-category summary rows from every category metric", async () => {
  const categoryFile = {
    originalname: "品类经营.csv",
    buffer: Buffer.from([
      "一级类目名称,二级类目名称,类目名称,支付金额,售中售后成功退款金额",
      "厨房电器,厨房电器,厨房电器,5000,500",
      "厨房电器,电饭锅,电饭锅,1200,100",
      "厨房电器,饮水机,饮水机,800,50",
      "其他,其他,其他,700,70",
    ].join("\n"), "utf8"),
  };
  const scenarioFile = {
    originalname: "分类目场景.csv",
    buffer: Buffer.from("类目,消耗,总成交金额\n电饭锅,120,1000\n饮水机,80,700\n", "utf8"),
  };
  const category = createOperationsReport({ type: "category", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const scenario = createOperationsReport({ type: "scenario", storeName: "店铺A", reportDate: "2026-07-26" }, await parseOperationsFile(scenarioFile), { file: scenarioFile });
  const workspace = buildOperationsWorkspace({ reports: [category, scenario] });
  const categoryDataset = workspace.datasets.find((item) => item.type === "category");

  assert.equal(categoryDataset?.rowCount, 2);
  assert.equal(categoryDataset?.metrics.grossRevenue, 2000);
  assert.equal(categoryDataset?.metrics.refundAmount, 150);
  assert.equal(categoryDataset?.metrics.revenue, 1850);
  assert.deepEqual(workspace.dashboard.categories.map((item) => item.name).sort(), ["电饭锅", "饮水机"]);
  assert.equal(workspace.dashboard.sources.categorySales?.rowCount, 2);
  assert.equal(workspace.dashboard.categories.some((item) => item.name === "厨房电器" || item.name === "其他"), false);
});

test("operations dashboard never joins category sales with a different-period category spend report", async () => {
  const categoryFile = {
    originalname: "品类360.csv",
    buffer: Buffer.from("一级类目名称,二级类目名称,支付金额,售中售后成功退款金额\n厨房电器,电饭锅,1200,100\n", "utf8"),
  };
  const scenarioFile = {
    originalname: "类目付费.csv",
    buffer: Buffer.from("类目,消耗,总成交金额\n电饭锅,120,580\n", "utf8"),
  };
  const category = createOperationsReport({ type: "category", reportDate: "2026-07-26" }, await parseOperationsFile(categoryFile), { file: categoryFile });
  const scenario = createOperationsReport({ type: "scenario", reportDate: "2026-07-27" }, await parseOperationsFile(scenarioFile), { file: scenarioFile });
  const workspace = buildOperationsWorkspace({ reports: [category, scenario] });
  const item = workspace.dashboard.categories.find((value) => value.name === "电饭锅");

  assert.equal(item?.matchStatus, "sales-only");
  assert.equal(item?.spend, 0);
  assert.equal(item?.feeRate, null);
  assert.equal(workspace.dashboard.sources.categoryPromotion, null);
  assert.match(workspace.dashboard.sourceWarnings.categoryPromotion || "", /尚未导入对应的单品付费报表/);
});

test("operations analysis safely handles incomplete targets and missing numeric fields", async () => {
  const report = await promotionReport(["锅具,新品,,,0,0,计划A,店铺A"]);
  const workspace = buildOperationsWorkspace({
    reports: [report],
    targets: { 锅具: { targetRoi: null, maxFeeRate: null, dailyBudgetCap: null } },
  }, { now: new Date("2026-07-23T12:00:00.000Z") });
  const analysis = await analyzeOperationsWorkspace({}, workspace, { reports: [report] });

  assert.equal(analysis.mode, "rule");
  assert.ok(analysis.insights.every((item) => typeof item === "string"));
});

test("operations data archive keeps daily snapshots separate and compares only the matching store and report type", async () => {
  const dayOne = await promotionReport(["锅具A,新品,100,300,3,100,计划A,店铺A"]);
  dayOne.reportDate = "2026-07-24";
  const dayTwo = await promotionReport(["锅具A,新品,120,480,5,130,计划A,店铺A"]);
  dayTwo.reportDate = "2026-07-25";
  const otherStore = await promotionReport(["锅具B,新品,80,160,2,80,计划B,店铺B"]);
  otherStore.reportDate = "2026-07-25";
  const workspace = buildOperationsWorkspace({ reports: [dayOne, dayTwo, otherStore] }, { now: new Date("2026-07-25T12:00:00.000Z") });

  assert.equal(workspace.currentDate, "2026-07-25");
  assert.equal(workspace.totals.spend, 200);
  assert.equal(workspace.archive.days.length, 2);
  const currentDay = workspace.archive.days.find((item) => item.date === "2026-07-25");
  const storeASnapshot = currentDay?.snapshots.find((item) => item.storeName === "店铺A");
  const storeBSnapshot = currentDay?.snapshots.find((item) => item.storeName === "店铺B");
  assert.equal(storeASnapshot?.comparison.previousDate, "2026-07-24");
  assert.equal(storeASnapshot?.comparison.revenueChange, 0.6);
  assert.equal(storeBSnapshot?.comparison.previousDate, null);
  const context = JSON.parse(operationsAgentContextText(workspace));
  assert.equal(context.archive.currentDate, "2026-07-25");
  assert.equal(context.archive.days.length, 2);
});

test("operations comparisons follow the selected end date and preserve natural period boundaries", () => {
  const reports = [];
  for (const month of ["2026-06", "2026-07"]) {
    const days = month === "2026-06" ? 30 : 31;
    for (let day = 1; day <= days; day += 1) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      reports.push({
        id: `product-${date}`,
        type: "product",
        storeName: "测试店铺",
        reportDate: date,
        periodKind: "day",
        periodStart: date,
        periodEnd: date,
        importedAt: `${date}T12:00:00.000Z`,
        rows: [{ productId: "1001", productName: "测试商品", storeName: "测试店铺", grossRevenue: 100, refundAmount: 10, revenue: 90, refundDataAvailable: true, visitors: 10, paidBuyers: 2 }],
      }, {
        id: `campaign-${date}`,
        type: "campaign",
        storeName: "测试店铺",
        reportDate: date,
        periodKind: "day",
        periodStart: date,
        periodEnd: date,
        importedAt: `${date}T12:00:00.000Z`,
        rows: [{ productId: "1001", productName: "测试商品", storeName: "测试店铺", spend: 10, revenue: 30, clicks: 5, orders: 1 }],
      });
    }
  }
  const workspace = buildOperationsWorkspace({ reports }, {
    filters: { sourcePeriodKind: "auto", storeName: "测试店铺", start: "2026-07-01", end: "2026-07-31" },
  });
  const comparisons = workspace.dashboard.comparisons;

  assert.deepEqual(
    [comparisons.day.currentStart, comparisons.day.currentEnd, comparisons.day.previousStart, comparisons.day.previousEnd],
    ["2026-07-31", "2026-07-31", "2026-07-30", "2026-07-30"],
  );
  assert.deepEqual(
    [comparisons.week.currentStart, comparisons.week.currentEnd, comparisons.week.previousStart, comparisons.week.previousEnd],
    ["2026-07-27", "2026-07-31", "2026-07-20", "2026-07-24"],
  );
  assert.deepEqual(
    [comparisons.last15.currentStart, comparisons.last15.currentEnd, comparisons.last15.previousStart, comparisons.last15.previousEnd],
    ["2026-07-17", "2026-07-31", "2026-07-02", "2026-07-16"],
  );
  assert.deepEqual(
    [comparisons.month.currentStart, comparisons.month.currentEnd, comparisons.month.previousStart, comparisons.month.previousEnd],
    ["2026-07-01", "2026-07-31", "2026-06-01", "2026-06-30"],
  );
  assert.equal(comparisons.day.current.store.revenue, 90);
  assert.equal(comparisons.week.current.store.revenue, 450);
  assert.equal(comparisons.last15.current.store.revenue, 1350);
  assert.equal(comparisons.month.current.store.revenue, 2790);
  assert.equal(comparisons.month.previous.store.revenue, 2700);
  assert.equal(comparisons.month.current.store.feeRate, 310 / 2790);
  assert.equal(comparisons.month.previous.store.feeRate, 300 / 2700);

  const customWorkspace = buildOperationsWorkspace({ reports }, {
    filters: { sourcePeriodKind: "auto", storeName: "测试店铺", start: "2026-07-20", end: "2026-07-29" },
  });
  const customComparison = customWorkspace.dashboard.comparisons.custom;
  assert.deepEqual(
    [customComparison.currentStart, customComparison.currentEnd, customComparison.previousStart, customComparison.previousEnd],
    ["2026-07-20", "2026-07-29", "2026-07-10", "2026-07-19"],
  );
  assert.equal(customComparison.currentAvailable, true);
  assert.equal(customComparison.previousAvailable, true);
  assert.equal(customComparison.current.store.revenue, 900);
  assert.equal(customComparison.previous.store.revenue, 900);
});

test("operations comparisons mark a missing prior period unavailable instead of fabricating zero", () => {
  const date = "2026-07-31";
  const workspace = buildOperationsWorkspace({ reports: [{
    id: "single-day-product",
    type: "product",
    storeName: "测试店铺",
    reportDate: date,
    periodKind: "day",
    periodStart: date,
    periodEnd: date,
    importedAt: `${date}T12:00:00.000Z`,
    rows: [{ productId: "1001", productName: "测试商品", storeName: "测试店铺", grossRevenue: 100, refundAmount: 10, revenue: 90, refundDataAvailable: true }],
  }] }, { filters: { sourcePeriodKind: "auto", start: date, end: date } });

  assert.equal(workspace.dashboard.comparisons.day.currentAvailable, true);
  assert.equal(workspace.dashboard.comparisons.day.previousAvailable, false);
  assert.equal(workspace.dashboard.comparisons.day.previous.store.available, false);
});

test("operations assistant parses legacy XLS reports with export notes before the real header", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["数据说明：从生意参谋导出的报表"],
    [],
    ["统计日期", "一级类目名称", "商品访客数", "支付金额", "支付转化率"],
    ["2026-07-26", "厨房电器", 25333, 265002.84, "1.46%"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "类目报表");
  const buffer = XLSX.write(workbook, { bookType: "biff8", type: "buffer" });
  const parsed = await parseOperationsFile({ originalname: "品类报表.xls", buffer: Buffer.from(buffer) });

  assert.equal(parsed.kind, "xls");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].category, "厨房电器");
  assert.equal(parsed.rows[0].revenue, 265002.84);
  assert.equal(parsed.rows[0].conversionRate, 0.0146);
  assert.equal(parsed.rows[0].productName, "");
});

test("operations assistant stops producing budget advice when local data is stale", async () => {
  const report = await promotionReport(["锅具,新品,100,500,5,100,计划A,店铺A"], {
    importedAt: new Date("2026-07-20T08:00:00.000Z"),
  });
  const workspace = buildOperationsWorkspace({ reports: [report] }, { now: new Date("2026-07-23T12:00:00.000Z") });

  assert.equal(workspace.freshness.fresh, false);
  assert.deepEqual(workspace.suggestions, []);
});

test("operations assistant remains usable without a model key", async () => {
  const report = await promotionReport(["锅具,新品,100,500,5,100,计划A,店铺A"]);
  const workspace = buildOperationsWorkspace({ reports: [report] }, { now: new Date("2026-07-23T12:00:00.000Z") });
  const analysis = await analyzeOperationsWorkspace({}, workspace, { reports: [report] });

  assert.equal(analysis.mode, "rule");
  assert.match(analysis.summary, /本地/);
  assert.ok(analysis.actions.length > 0);
});

test("operations agent keeps chat local when no text model is configured", async () => {
  const report = await promotionReport(["锅具,新品,100,500,5,100,计划A,店铺A"]);
  const workspace = buildOperationsWorkspace({ reports: [report] }, { now: new Date("2026-07-23T12:00:00.000Z") });
  const answer = await askOperationsAgent({}, workspace, "这个单品应该加预算吗？", { reports: [report] });

  assert.match(answer, /设置中心配置文字模型/);
});

test("QwenPaw receives a compact text-safe local operations context", () => {
  const workspace = buildOperationsWorkspace({
    reports: [],
    principles: "新品优先验证转化，再逐步放量。",
  }, { now: new Date("2026-07-23T12:00:00.000Z") });

  const context = JSON.parse(operationsAgentContextText(workspace));
  assert.equal(context.source, "经营罗盘本机运营数据");
  assert.equal(context.principles, "新品优先验证转化，再逐步放量。");
  assert.ok(Array.isArray(context.products));
  assert.ok(context.products.length <= 15);
  assert.ok(context.categories.length <= 12);
  assert.ok(context.audiences.length <= 12);
});

test("QwenPaw selected install directory remains part of the local operations state", () => {
  const directory = path.resolve("D:/自定义/QwenPaw");
  assert.equal(normalizeOperationsState({ qwenPawInstallDirectory: directory }).qwenPawInstallDirectory, directory);
});

test("QwenPaw fails closed when its official builtin tool inventory is incomplete", () => {
  assert.throws(() => lockQwenPawBuiltinTools({ builtin_tools: {} }), /工具清单不完整/);
  const tools = lockQwenPawBuiltinTools({
    builtin_tools: {
      view_image: { enabled: false },
      execute_shell_command: { enabled: true },
      browser_visible: { enabled: true },
    },
  });
  assert.equal(tools.builtin_tools.view_image.enabled, true);
  assert.equal(tools.builtin_tools.execute_shell_command.enabled, false);
  assert.equal(tools.builtin_tools.browser_visible.enabled, false);
});

test("operations agent uses the active Settings text model instead of a separate configuration", async () => {
  const report = await promotionReport(["锅具,新品,100,500,5,100,计划A,店铺A"]);
  const workspace = buildOperationsWorkspace({ reports: [report] }, { now: new Date("2026-07-23T12:00:00.000Z") });
  const config = updateModelConfig({}, {
    channel: "custom",
    customBaseUrl: "https://operations-model.example/v1",
    model: "operations-text-model",
    apiKey: "operations-key",
  });
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: "基于本地数据，建议保持预算。" }) };
  };
  try {
    const answer = await askOperationsAgent(config, workspace, "给出今天的预算建议", { reports: [report] });
    assert.equal(answer, "基于本地数据，建议保持预算。");
    assert.equal(request.url, "https://operations-model.example/v1/responses");
    assert.equal(request.options.headers.authorization, "Bearer operations-key");
    assert.equal(JSON.parse(request.options.body).model, "operations-text-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("QwenPaw operations sync receives the Settings text model without putting its key on the command line", () => {
  const config = updateModelConfig({}, {
    channel: "custom",
    customBaseUrl: "https://operations-model.example/v1",
    model: "operations-text-model",
    apiKey: "operations-key",
  });
  const directory = path.join(os.tmpdir(), "ecom-qwenpaw");
  const plan = qwenPawSyncPlan(directory, config, "新品先验证转化，再逐步放量。");

  assert.deepEqual(plan.args, []);
  assert.equal(plan.environment.ECOM_QWENPAW_API_KEY, undefined);
  assert.equal(plan.environment.QWENPAW_WORKING_DIR, path.join(directory, "data"));
  assert.equal(plan.environment.ECOM_QWENPAW_CONTEXT_URL, "http://127.0.0.1:4317/api/operations/agent-context");
  assert.equal(plan.environment.ECOM_QWENPAW_OPERATING_PRINCIPLES, "新品先验证转化，再逐步放量。");
  assert.equal(plan.environment.ECOM_QWENPAW_APP_URL, "http://127.0.0.1:4317");
  assert.match(plan.environment.ECOM_QWENPAW_MCP_SERVER_PATH, /ecommerce-agent-mcp\.js$/);
  assert.match(plan.environment.ECOM_QWENPAW_AGENT_TOOL_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  assert.doesNotMatch(plan.args.join(" "), /operations-key/);
  assert.match(plan.signature, /^[a-f0-9]{64}$/);
});

test("QwenPaw sync plan changes when the saved operating principles change", () => {
  const config = updateModelConfig({}, {
    channel: "custom",
    customBaseUrl: "https://operations-model.example/v1",
    model: "operations-text-model",
    apiKey: "operations-key",
  });

  const first = qwenPawSyncPlan("C:/temp/ecom-qwenpaw", config, "新品先验证点击率。");
  const second = qwenPawSyncPlan("C:/temp/ecom-qwenpaw", config, "新品先验证转化率。");

  assert.notEqual(first.signature, second.signature);
});

test("QwenPaw instructions require complete per-SKU verified price reporting", () => {
  const instructions = qwenPawWorkspaceAgentInstructions("新品先验证转化，再逐步放量。");
  assert.match(instructions, /完整 SKU 价格矩阵/);
  assert.match(instructions, /全部 skuRows/);
  assert.match(instructions, /每个 SKU 的每个账号视角/);
  assert.match(instructions, /不得猜测/);
});

test("QwenPaw official bootstrap selects Windows x64 and Apple Silicon without cross-architecture fallback", () => {
  assert.deepEqual(qwenPawBootstrapPlan({ platform: "win32", arch: "x64" }), {
    platform: "win32",
    arch: "x64",
    manifestPlatform: "win-tauri",
    packageType: "exe",
    universal: false,
  });
  assert.deepEqual(qwenPawBootstrapPlan({ platform: "darwin", arch: "arm64" }), {
    platform: "darwin",
    arch: "arm64",
    manifestPlatform: "mac-tauri",
    packageType: "zip",
    universal: false,
  });
  assert.throws(() => qwenPawBootstrapPlan({ platform: "darwin", arch: "x64" }), /Intel Mac/);
});

test("QwenPaw status reports the selected install directory without falling back to system Python", () => {
  const directory = path.resolve("C:/temp/ecom-qwenpaw-official");
  const status = qwenPawRuntimeStatus(directory);
  assert.equal(status.installDirectory, directory);
  assert.equal(status.installed, false);
  assert.match(status.message, /尚未安装/);
});
