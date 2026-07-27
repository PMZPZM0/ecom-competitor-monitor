import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import {
  analyzeOperationsWorkspace,
  askOperationsAgent,
  buildOperationsWorkspace,
  createOperationsReport,
  operationsAgentContextText,
  normalizeOperationsState,
  lockQwenPawBuiltinTools,
  parseOperationsFile,
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
  assert.equal(Number(workspace.totals.feeRate.toFixed(4)), Number((200 / 650).toFixed(4)));
  assert.equal(workspace.products.find((item) => item.name === "新品锅具")?.productStage, "new");
  assert.equal(workspace.products.find((item) => item.name === "成熟锅具")?.productStage, "mature");
  assert.equal(workspace.suggestions.find((item) => item.productName === "新品锅具")?.action, "降预算");
  assert.equal(workspace.suggestions.find((item) => item.productName === "成熟锅具")?.action, "加预算");
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
  assert.equal(context.source, "电商竞品监控本机运营数据");
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
