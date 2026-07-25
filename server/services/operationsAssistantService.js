import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { requestModelApiJson, resolveModelConfig } from "./modelConfigService.js";

export const OPERATIONS_REPORT_TYPES = Object.freeze(["promotion", "market", "audience", "competitor"]);
export const OPERATIONS_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_REPORTS = 180;
const MAX_ROWS_PER_REPORT = 5_000;
const MAX_SCREENSHOTS_PER_ANALYSIS = 3;
const MAX_CHAT_MESSAGES = 80;

const DEFAULT_TARGETS = Object.freeze({ targetRoi: 2, maxFeeRate: 0.3, dailyBudgetCap: 0 });
const DEFAULT_DAILY_REPORT = Object.freeze({ enabled: false, time: "09:30", lastRunAt: null, lastSentAt: null, lastError: "" });
const QWENPAW_OPERATIONS_AGENT_ID = "default";
const QWENPAW_CONSOLE_HOST = "127.0.0.1";
const QWENPAW_CONSOLE_PORT = 4318;
const QWENPAW_OPERATIONS_CONFIG_REVISION = "operations-agent-tools-v4";
const QWENPAW_VERSION = "2.0.0.post4";
const UV_RELEASE_API = "https://api.github.com/repos/astral-sh/uv/releases/latest";
const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
let qwenPawOperationsContextUrl = "http://127.0.0.1:4317/api/operations/agent-context";
let qwenPawConsoleProcess = null;
let qwenPawConsoleSignature = "";
let qwenPawConsoleLastError = "";
let qwenPawBootstrapPromise = null;
const qwenPawAgentToolToken = crypto.randomBytes(32).toString("base64url");

const FIELD_ALIASES = Object.freeze({
  storeName: ["店铺", "店铺名称", "所属店铺", "storename", "store", "shop"],
  productId: ["商品id", "宝贝id", "itemid", "productid", "商品编号"],
  productName: ["商品名称", "宝贝名称", "推广商品", "产品名称", "productname", "商品", "宝贝", "product"],
  productStage: ["商品阶段", "产品阶段", "新品老品", "productstage", "stage"],
  campaignName: ["计划名称", "推广计划", "campaignname", "计划", "campaign"],
  category: ["类目", "商品类目", "一级类目", "category"],
  audienceName: ["人群名称", "定向人群", "audiencename", "人群", "audience"],
  spend: ["消耗", "花费", "推广花费", "广告消耗", "cost", "spend"],
  revenue: ["成交金额", "支付金额", "成交额", "成交金额元", "gmv", "revenue"],
  roi: ["roi", "投入产出比", "投产"],
  orders: ["订单数", "成交订单数", "成交笔数", "orders"],
  clicks: ["点击量", "点击次数", "clicks"],
  impressions: ["展现量", "曝光量", "impressions"],
  conversionRate: ["转化率", "成交转化率", "conversionrate", "cvr"],
  audienceSize: ["人群规模", "覆盖人数", "人群数", "覆盖量", "audiencesize"],
});

function nowIso(now = new Date()) {
  return now.toISOString();
}

function uniqueStrings(values, limit = 60) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function text(value, limit = 160) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function headerKey(value) {
  return text(value, 80).toLowerCase().replace(/[\s_()（）【】[\]·-]/g, "");
}

function numeric(value, { percent = false } = {}) {
  if (typeof value === "number" && Number.isFinite(value)) return percent && value > 1 ? value / 100 : value;
  const source = String(value ?? "").replace(/[￥¥,\s]/g, "");
  const match = source.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const result = Number(match[0]);
  if (!Number.isFinite(result)) return null;
  return percent && (source.includes("%") || result > 1) ? result / 100 : result;
}

function rowValue(row, aliases) {
  const normalizedAliases = aliases.map((alias) => headerKey(alias));
  for (const [header, value] of Object.entries(row || {})) {
    const key = headerKey(header);
    if (!key) continue;
    if (value === "" || value === null || value === undefined) continue;
    if (normalizedAliases.some((alias) => key === alias || key.includes(alias) || alias.includes(key))) return value;
  }
  return undefined;
}

function dateOnly(value, fallback = new Date()) {
  const candidate = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  const parsed = Date.parse(candidate);
  const date = Number.isFinite(parsed) ? new Date(parsed) : fallback;
  return date.toISOString().slice(0, 10);
}

function totalRow(row) {
  return /^(合计|汇总|总计|total)$/i.test(text(row.productName || row.campaignName || row.audienceName));
}

function normalizeRow(row) {
  const spend = numeric(rowValue(row, FIELD_ALIASES.spend));
  const revenue = numeric(rowValue(row, FIELD_ALIASES.revenue));
  const suppliedRoi = numeric(rowValue(row, FIELD_ALIASES.roi));
  const computedRoi = Number.isFinite(spend) && spend > 0 && Number.isFinite(revenue) ? revenue / spend : null;
  const productStageText = text(rowValue(row, FIELD_ALIASES.productStage), 30).toLowerCase();
  return {
    storeName: text(rowValue(row, FIELD_ALIASES.storeName), 80),
    productId: text(rowValue(row, FIELD_ALIASES.productId), 80),
    productName: text(rowValue(row, FIELD_ALIASES.productName), 120),
    productStage: /新|^new$/.test(productStageText) ? "new" : /老|成熟|^mature$/.test(productStageText) ? "mature" : "unknown",
    campaignName: text(rowValue(row, FIELD_ALIASES.campaignName), 120),
    category: text(rowValue(row, FIELD_ALIASES.category), 80),
    audienceName: text(rowValue(row, FIELD_ALIASES.audienceName), 120),
    spend,
    revenue,
    roi: Number.isFinite(computedRoi) ? computedRoi : suppliedRoi,
    orders: numeric(rowValue(row, FIELD_ALIASES.orders)),
    clicks: numeric(rowValue(row, FIELD_ALIASES.clicks)),
    impressions: numeric(rowValue(row, FIELD_ALIASES.impressions)),
    conversionRate: numeric(rowValue(row, FIELD_ALIASES.conversionRate), { percent: true }),
    audienceSize: numeric(rowValue(row, FIELD_ALIASES.audienceSize)),
  };
}

function normalizedRows(rows) {
  return rows
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .slice(0, MAX_ROWS_PER_REPORT)
    .map(normalizeRow)
    .filter((row) => Object.values(row).some((value) => value !== "" && value !== null && value !== "unknown"));
}

function parseCsv(textValue) {
  const lines = String(textValue || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const values = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') quoted = !quoted;
      else if (character === "," && !quoted) {
        values.push(current);
        current = "";
      } else current += character;
    }
    values.push(current);
    return values.map((value) => value.trim());
  };
  const headers = parseLine(lines[0]).map((value, index) => value || `column_${index + 1}`);
  return lines.slice(1).map((line) => Object.fromEntries(parseLine(line).map((value, index) => [headers[index], value])));
}

async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  let headers = [];
  sheet.eachRow({ includeEmpty: false }, (row, index) => {
    const values = row.values.slice(1).map((value) => (value && typeof value === "object" && "text" in value ? value.text : value));
    if (index === 1) {
      headers = values.map((value, column) => text(value, 80) || `column_${column + 1}`);
      return;
    }
    if (headers.length && values.some((value) => value !== null && value !== undefined && text(value))) {
      rows.push(Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])));
    }
  });
  return rows;
}

function extensionOf(file = {}) {
  const match = String(file.originalname || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function reportKind(file) {
  const extension = extensionOf(file);
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return "screenshot";
  if (extension === "xlsx") return "xlsx";
  if (extension === "csv") return "csv";
  if (extension === "json") return "json";
  return "";
}

export function isSupportedOperationsFile(file) {
  return Boolean(reportKind(file));
}

export async function parseOperationsFile(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("请选择有效的数据文件或截图。"), { status: 400 });
  if (file.buffer.length > OPERATIONS_MAX_UPLOAD_BYTES) throw Object.assign(new Error("运营数据文件不能超过 16 MB。"), { status: 413 });
  const kind = reportKind(file);
  if (!kind) throw Object.assign(new Error("只支持 XLSX、CSV、JSON、PNG、JPG 或 WEBP。"), { status: 400 });
  if (kind === "screenshot") return { kind, columns: [], rows: [] };
  let rows;
  if (kind === "xlsx") rows = await parseWorkbook(file.buffer);
  else if (kind === "csv") rows = parseCsv(file.buffer.toString("utf8"));
  else {
    const parsed = JSON.parse(file.buffer.toString("utf8"));
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
  }
  if (!rows.length) throw Object.assign(new Error("报表中没有可识别的数据行。"), { status: 400 });
  const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row || {})), 200);
  return { kind, columns, rows: normalizedRows(rows) };
}

export function normalizeOperationsState(value = {}) {
  const reports = (Array.isArray(value?.reports) ? value.reports : [])
    .filter((report) => report && OPERATIONS_REPORT_TYPES.includes(report.type))
    .slice(-MAX_REPORTS)
    .map((report) => ({
      id: text(report.id, 80),
      type: report.type,
      storeName: text(report.storeName, 80),
      reportDate: dateOnly(report.reportDate),
      sourceName: text(report.sourceName, 80),
      fileName: text(report.fileName, 160),
      kind: ["xlsx", "csv", "json", "screenshot"].includes(report.kind) ? report.kind : "csv",
      columns: uniqueStrings(report.columns, 200),
      rows: normalizedRows(report.rows),
      screenshotPath: typeof report.screenshotPath === "string" ? report.screenshotPath : "",
      screenshotMimeType: text(report.screenshotMimeType, 80),
      importedAt: typeof report.importedAt === "string" ? report.importedAt : nowIso(),
    }));
  const targets = Object.fromEntries(Object.entries(value?.targets || {}).flatMap(([key, target]) => {
    const targetRoi = numeric(target?.targetRoi);
    const maxFeeRate = numeric(target?.maxFeeRate, { percent: true });
    const dailyBudgetCap = numeric(target?.dailyBudgetCap);
    return key.trim() ? [[key.trim().slice(0, 160), {
      targetRoi: Number.isFinite(targetRoi) && targetRoi > 0 ? targetRoi : DEFAULT_TARGETS.targetRoi,
      maxFeeRate: Number.isFinite(maxFeeRate) && maxFeeRate > 0 && maxFeeRate < 1 ? maxFeeRate : DEFAULT_TARGETS.maxFeeRate,
      dailyBudgetCap: Number.isFinite(dailyBudgetCap) && dailyBudgetCap > 0 ? dailyBudgetCap : 0,
    }]] : [];
  }));
  const feedback = (Array.isArray(value?.feedback) ? value.feedback : [])
    .filter((item) => item && ["adopted", "skipped", "outcome"].includes(item.status))
    .slice(-300)
    .map((item) => ({ id: text(item.id, 80), suggestionId: text(item.suggestionId, 100), status: item.status, note: text(item.note, 600), createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso() }));
  const chat = (Array.isArray(value?.chat) ? value.chat : [])
    .filter((item) => item && ["user", "assistant"].includes(item.role) && text(item.content, 4_000))
    .slice(-MAX_CHAT_MESSAGES)
    .map((item) => ({ id: text(item.id, 80), role: item.role, content: text(item.content, 4_000), createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso() }));
  const schedule = value?.dailyReport || {};
  return {
    reports,
    targets,
    feedback,
    chat,
    principles: text(value?.principles, 4_000),
    dailyReport: {
      ...DEFAULT_DAILY_REPORT,
      enabled: Boolean(schedule.enabled),
      time: /^\d{2}:\d{2}$/.test(String(schedule.time || "")) ? schedule.time : DEFAULT_DAILY_REPORT.time,
      lastRunAt: typeof schedule.lastRunAt === "string" ? schedule.lastRunAt : null,
      lastSentAt: typeof schedule.lastSentAt === "string" ? schedule.lastSentAt : null,
      lastError: text(schedule.lastError, 300),
    },
    analyses: (Array.isArray(value?.analyses) ? value.analyses : []).filter(Boolean).slice(-60),
  };
}

export async function persistOperationsScreenshot(file, { dataDir, reportId }) {
  const extension = extensionOf(file) === "jpg" ? "jpeg" : extensionOf(file);
  const directory = path.join(dataDir, "operations", "screenshots");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${reportId}.${extension}`);
  await fs.writeFile(filePath, file.buffer);
  return filePath;
}

export function createOperationsReport(input, parsed, { file, screenshotPath = "", now = new Date() } = {}) {
  const type = OPERATIONS_REPORT_TYPES.includes(input?.type) ? input.type : "promotion";
  const id = `ops_${crypto.randomUUID()}`;
  return {
    id,
    type,
    storeName: text(input?.storeName, 80),
    reportDate: dateOnly(input?.reportDate, now),
    sourceName: text(input?.sourceName, 80),
    fileName: text(file?.originalname, 160),
    kind: parsed.kind,
    columns: parsed.columns,
    rows: parsed.rows,
    screenshotPath,
    screenshotMimeType: parsed.kind === "screenshot" ? String(file?.mimetype || "image/png") : "",
    importedAt: nowIso(now),
  };
}

function promotionRows(state) {
  const rows = state.reports.filter((report) => report.type === "promotion").flatMap((report) => report.rows.map((row) => ({ ...row, report })));
  const details = rows.filter((item) => !totalRow(item));
  return details.length ? details : rows;
}

function aggregate(rows) {
  const values = rows.reduce((result, row) => ({
    spend: result.spend + (Number.isFinite(row.spend) ? row.spend : 0),
    revenue: result.revenue + (Number.isFinite(row.revenue) ? row.revenue : 0),
    orders: result.orders + (Number.isFinite(row.orders) ? row.orders : 0),
    clicks: result.clicks + (Number.isFinite(row.clicks) ? row.clicks : 0),
    impressions: result.impressions + (Number.isFinite(row.impressions) ? row.impressions : 0),
  }), { spend: 0, revenue: 0, orders: 0, clicks: 0, impressions: 0 });
  return {
    ...values,
    feeRate: values.revenue > 0 ? values.spend / values.revenue : null,
    roi: values.spend > 0 ? values.revenue / values.spend : null,
    conversionRate: values.clicks > 0 ? values.orders / values.clicks : null,
  };
}

function groupedRows(rows, key, fallback) {
  const groups = new Map();
  for (const row of rows) {
    const name = text(row[key] || fallback(row), 160) || "未归类";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, ...aggregate(items), count: items.length }));
}

function suggestionId(product, action, reportDate) {
  return `advice_${crypto.createHash("sha256").update(`${product.key}|${action}|${reportDate}`).digest("hex").slice(0, 16)}`;
}

function buildSuggestions(products, state, reportDate) {
  return products
    .filter((product) => product.spend > 0)
    .map((product) => {
      const target = { ...DEFAULT_TARGETS, ...(state.targets[product.key] || state.targets[product.name] || {}) };
      let action = "保持";
      let change = 0;
      let reason = "ROI 与费率处于设定范围内，继续观察。";
      if (target.dailyBudgetCap > 0 && product.spend > target.dailyBudgetCap) {
        action = "降预算";
        change = -20;
        reason = `当日消耗 ${product.spend.toFixed(2)} 已超过预算上限 ${target.dailyBudgetCap.toFixed(2)}。`;
      } else if (product.orders === 0 && product.spend >= 50) {
        action = "暂停观察";
        change = -100;
        reason = `已消耗 ${product.spend.toFixed(2)}，仍未产生订单。`;
      } else if (Number.isFinite(product.roi) && product.roi < target.targetRoi) {
        action = "降预算";
        change = -20;
        reason = `ROI ${product.roi.toFixed(2)} 低于保本目标 ${target.targetRoi.toFixed(2)}。`;
      } else if (Number.isFinite(product.feeRate) && product.feeRate > target.maxFeeRate) {
        action = "降预算";
        change = -15;
        reason = `费率 ${(product.feeRate * 100).toFixed(1)}% 高于上限 ${(target.maxFeeRate * 100).toFixed(1)}%。`;
      } else if (Number.isFinite(product.roi) && Number.isFinite(product.feeRate)
        && product.roi >= target.targetRoi * 1.2 && product.feeRate <= target.maxFeeRate * 0.8) {
        action = "加预算";
        change = 15;
        reason = `ROI ${product.roi.toFixed(2)} 高于目标且费率 ${(product.feeRate * 100).toFixed(1)}% 有余量。`;
      }
      return {
        id: suggestionId(product, action, reportDate),
        productKey: product.key,
        productName: product.name,
        productStage: product.productStage,
        action,
        change,
        reason,
        target,
        spend: product.spend,
        revenue: product.revenue,
        roi: product.roi,
        feeRate: product.feeRate,
        orders: product.orders,
      };
    })
    .sort((left, right) => (right.spend - left.spend) || Math.abs(right.change) - Math.abs(left.change))
    .slice(0, 20);
}

function hasFreshData(reports, now) {
  const latest = reports.map((report) => Date.parse(report.importedAt || "")).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0);
  return { latestAt: latest ? new Date(latest).toISOString() : null, fresh: latest > 0 && now.getTime() - latest <= 36 * 60 * 60 * 1_000 };
}

export function buildOperationsWorkspace(value = {}, { now = new Date() } = {}) {
  const state = normalizeOperationsState(value);
  const rows = promotionRows(state);
  const total = aggregate(rows);
  const productGroups = groupedRows(rows, "productName", (row) => row.campaignName || row.productId).map((item) => {
    const members = rows.filter((row) => (row.productName || row.campaignName || row.productId || "未归类") === item.name);
    const representative = members[0] || {};
    return { ...item, key: representative.productId || item.name, productStage: representative.productStage || "unknown" };
  }).sort((left, right) => right.spend - left.spend);
  const freshness = hasFreshData(state.reports, now);
  const reportDate = now.toISOString().slice(0, 10);
  const suggestions = freshness.fresh ? buildSuggestions(productGroups, state, reportDate) : [];
  const audienceReports = state.reports.filter((report) => ["audience", "competitor"].includes(report.type));
  const audienceRows = audienceReports.flatMap((report) => report.rows.map((row) => ({ ...row, report })));
  const audienceGroups = groupedRows(audienceRows, "audienceName", (row) => row.productName || row.campaignName)
    .sort((left, right) => (right.revenue - left.revenue) || (right.audienceSize || 0) - (left.audienceSize || 0)).slice(0, 12);
  const feedbackBySuggestion = Object.fromEntries(state.feedback.map((item) => [item.suggestionId, item]));
  return {
    reports: state.reports.slice().sort((left, right) => Date.parse(right.importedAt) - Date.parse(left.importedAt)),
    profile: { principles: state.principles, dailyReport: state.dailyReport, targets: state.targets },
    freshness,
    totals: total,
    products: productGroups.slice(0, 50),
    stores: groupedRows(rows, "storeName", () => "未标记店铺").sort((left, right) => right.spend - left.spend),
    categories: groupedRows(rows, "category", () => "未标记类目").sort((left, right) => right.spend - left.spend).slice(0, 20),
    audiences: audienceGroups,
    suggestions: suggestions.map((item) => ({ ...item, feedback: feedbackBySuggestion[item.id] || null })),
    analyses: state.analyses.slice().reverse(),
    chat: state.chat,
  };
}

export function operationsAgentContextText(workspace) {
  // QwenPaw's web_fetch accepts webpage/text responses, but rejects JSON MIME
  // types. Keep this compact so an ordinary data question has one small local
  // tool read before the model answers.
  return JSON.stringify({
    source: "电商竞品监控本机运营数据",
    freshness: workspace.freshness,
    totals: workspace.totals,
    products: workspace.products.slice(0, 15),
    categories: workspace.categories.slice(0, 12),
    audiences: workspace.audiences.slice(0, 12),
    suggestions: workspace.suggestions.slice(0, 15),
    principles: text(workspace.profile?.principles, 2_000),
  });
}

function localOperationsAnalysis(workspace) {
  if (!workspace.freshness.fresh) {
    return { mode: "rule", summary: "运营数据已过期，未生成预算调整结论。请先导入最新报表。", insights: [], actions: [], createdAt: nowIso() };
  }
  const total = workspace.totals;
  const insights = [
    `当前汇总消耗 ${total.spend.toFixed(2)}，成交 ${total.revenue.toFixed(2)}，ROI ${Number.isFinite(total.roi) ? total.roi.toFixed(2) : "--"}。`,
    `整体费率 ${Number.isFinite(total.feeRate) ? `${(total.feeRate * 100).toFixed(1)}%` : "--"}，已覆盖 ${workspace.products.length} 个单品。`,
  ];
  return {
    mode: "rule",
    summary: "已根据本地费率、ROI、预算上限和订单数据生成推广建议。",
    insights,
    actions: workspace.suggestions.slice(0, 5).map((item) => `${item.productName}：${item.action}${item.change ? ` ${item.change > 0 ? "+" : ""}${item.change}%` : ""}，${item.reason}`),
    createdAt: nowIso(),
  };
}

function outputText(response) {
  return String(response?.output_text || response?.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("\n") || "").trim();
}

function parseModelAnalysis(value, fallback) {
  const textValue = String(value || "").trim();
  const match = textValue.match(/\{[\s\S]*\}/);
  if (!match) return { ...fallback, mode: "ai", summary: textValue || fallback.summary };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      mode: "ai",
      summary: text(parsed.summary, 800) || fallback.summary,
      insights: uniqueStrings(parsed.insights, 12),
      actions: uniqueStrings(parsed.actions, 12),
      createdAt: nowIso(),
    };
  } catch {
    return { ...fallback, mode: "ai", summary: textValue || fallback.summary };
  }
}

async function screenshotContent(reports) {
  const images = [];
  for (const report of reports.filter((item) => item.kind === "screenshot" && item.screenshotPath).slice(0, MAX_SCREENSHOTS_PER_ANALYSIS)) {
    try {
      const buffer = await fs.readFile(report.screenshotPath);
      if (buffer.length > 8 * 1024 * 1024) continue;
      images.push({ type: "input_image", image_url: `data:${report.screenshotMimeType || "image/png"};base64,${buffer.toString("base64")}` });
    } catch {
      // A deleted local image must not make a data-only analysis fail.
    }
  }
  return images;
}

export async function analyzeOperationsWorkspace(modelConfig, workspace, { principles = "", reports = [] } = {}) {
  const fallback = localOperationsAnalysis(workspace);
  const resolved = resolveModelConfig(modelConfig);
  if (!resolved.apiKey) return fallback;
  const images = await screenshotContent(reports);
  const context = {
    freshness: workspace.freshness,
    totals: workspace.totals,
    products: workspace.products.slice(0, 20),
    categories: workspace.categories.slice(0, 12),
    audiences: workspace.audiences.slice(0, 12),
    deterministicSuggestions: workspace.suggestions.slice(0, 12),
    operatingPrinciples: text(principles, 4_000),
  };
  const response = await requestModelApiJson(`${resolved.baseUrl}/responses`, {
    apiKey: resolved.apiKey,
    label: "运营助手分析",
    timeoutMs: 90_000,
    body: {
      model: resolved.model,
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: "你是严谨的电商运营助手。只能根据提供的数据与截图分析，不得补造数据或声称看到了未给出的后台信息。金额、费率与 ROI 已由本地公式计算，你只解释原因、风险和优先级。尊重运营人员的经营原则。输出 JSON：{summary:string,insights:string[],actions:string[]}。每条行动都应包含对象、建议动作和依据。",
        }],
      }, {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(context) }, ...images],
      }],
    },
  });
  return parseModelAnalysis(outputText(response), fallback);
}

export async function askOperationsAgent(modelConfig, workspace, question, { principles = "", reports = [], history = [] } = {}) {
  const resolved = resolveModelConfig(modelConfig);
  const message = text(question, 2_000);
  if (!message) throw Object.assign(new Error("请输入要问运营 Agent 的问题。"), { status: 400 });
  if (!resolved.apiKey) {
    return "请先在设置中心配置文字模型后再发起 Agent 对话。当前运营数据仍仅保存在本机。";
  }
  const context = {
    freshness: workspace.freshness,
    totals: workspace.totals,
    products: workspace.products.slice(0, 30),
    stores: workspace.stores.slice(0, 12),
    categories: workspace.categories.slice(0, 12),
    audiences: workspace.audiences.slice(0, 12),
    deterministicSuggestions: workspace.suggestions.slice(0, 20),
    operatingPrinciples: text(principles, 4_000),
  };
  const messages = (Array.isArray(history) ? history : []).slice(-12)
    .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: text(item.content, 2_000) }))
    .filter((item) => item.content);
  const images = await screenshotContent(reports);
  const response = await requestModelApiJson(`${resolved.baseUrl}/responses`, {
    apiKey: resolved.apiKey,
    label: "运营 Agent 对话",
    timeoutMs: 90_000,
    body: {
      model: resolved.model,
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: "你是电商运营 Agent。只能基于提供的本地运营数据、截图和对话上下文回答。不要补造数据、不要访问任何平台、不要修改预算或发送消息。金额、ROI 和费率以本地计算结果为准。数据过期时，明确说明不能给出预算调整结论。用简洁中文回答，先给结论，再给可核对依据和下一步。",
        }],
      }, ...messages.map((item) => ({ role: item.role, content: [{ type: "input_text", text: item.content }] })), {
        role: "user",
        content: [{ type: "input_text", text: `当前本地数据：${JSON.stringify(context)}\n\n问题：${message}` }, ...images],
      }],
    },
  });
  return text(outputText(response), 4_000) || "Agent 未返回可用内容，请稍后重试。";
}

function qwenPawWorkingDirectory(dataDir) {
  return path.join(dataDir, "operations", "qwenpaw");
}

function qwenPawRuntimeDirectory(dataDir) {
  return path.join(qwenPawWorkingDirectory(dataDir), "runtime");
}

function qwenPawManagedPythonPath(dataDir) {
  return path.join(qwenPawRuntimeDirectory(dataDir), process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

export function qwenPawPythonExecutable(dataDir) {
  const managed = qwenPawManagedPythonPath(dataDir);
  return existsSync(managed) ? managed : process.platform === "win32" ? "py" : "python3";
}

export function qwenPawBootstrapPlan({ platform = process.platform, arch = process.arch } = {}) {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : "";
  if (!cpu) throw new Error(`当前 CPU 架构暂不支持自动部署运营 Agent：${arch}`);
  if (platform === "win32") return { archive: `uv-${cpu}-pc-windows-msvc.zip`, binary: "uv.exe" };
  if (platform === "darwin") return { archive: `uv-${cpu}-apple-darwin.tar.gz`, binary: "uv" };
  throw new Error(`当前系统暂不支持自动部署运营 Agent：${platform}`);
}

async function runRuntimeCommand(command, args, { timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const output = [];
    const collect = (chunk) => {
      output.push(Buffer.from(chunk));
      if (output.length > 12) output.shift();
    };
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = Buffer.concat(output).toString("utf8").trim().slice(-1_200);
      reject(new Error(detail || `${path.basename(command)} 退出，状态码 ${code ?? "未知"}。`));
    });
  });
}

async function downloadText(url) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "ecommerce-competitor-monitor" } });
  if (!response.ok) throw new Error(`下载运行环境清单失败（${response.status}）。`);
  return response.text();
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": "ecommerce-competitor-monitor" } });
  if (!response.ok) throw new Error(`下载运行环境失败（${response.status}）。`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function findFile(root, filename) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, filename);
      if (found) return found;
    }
  }
  return "";
}

async function ensureUvBootstrap(dataDir) {
  const plan = qwenPawBootstrapPlan();
  const bootstrapDirectory = path.join(qwenPawWorkingDirectory(dataDir), "bootstrap");
  const uvPath = path.join(bootstrapDirectory, plan.binary);
  if (existsSync(uvPath)) return uvPath;

  const stagingDirectory = `${bootstrapDirectory}.staging-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(stagingDirectory, { recursive: true });
    const release = JSON.parse(await downloadText(UV_RELEASE_API));
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const archive = assets.find((asset) => asset?.name === plan.archive);
    const checksum = assets.find((asset) => asset?.name === `${plan.archive}.sha256`);
    if (!archive?.browser_download_url || !checksum?.browser_download_url) throw new Error("自动部署所需的运行环境文件不完整。请检查网络后重试。");

    const archivePath = path.join(stagingDirectory, plan.archive);
    await downloadFile(archive.browser_download_url, archivePath);
    const expected = (await downloadText(checksum.browser_download_url)).match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
    const actual = crypto.createHash("sha256").update(await fs.readFile(archivePath)).digest("hex");
    if (!expected || expected !== actual) throw new Error("运行环境下载校验失败，已停止安装。请检查网络后重试。");

    const extracted = path.join(stagingDirectory, "extracted");
    await fs.mkdir(extracted);
    if (process.platform === "win32") {
      await runRuntimeCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archivePath, extracted]);
    } else {
      await runRuntimeCommand("tar", ["-xzf", archivePath, "-C", extracted]);
    }
    const extractedUv = await findFile(extracted, plan.binary);
    if (!extractedUv) throw new Error("运行环境解压后未找到启动文件。");
    await fs.mkdir(bootstrapDirectory, { recursive: true });
    await fs.copyFile(extractedUv, uvPath);
    if (process.platform !== "win32") await fs.chmod(uvPath, 0o755);
    return uvPath;
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installManagedQwenPawRuntime(dataDir) {
  const uvPath = await ensureUvBootstrap(dataDir);
  const runtimeDirectory = qwenPawRuntimeDirectory(dataDir);
  const pythonPath = qwenPawManagedPythonPath(dataDir);
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(runtimeDirectory), { recursive: true });
  await runRuntimeCommand(uvPath, ["venv", "--python", "3.12", runtimeDirectory], { timeoutMs: 300_000 });
  await runRuntimeCommand(uvPath, ["pip", "install", "--python", pythonPath, `qwenpaw==${QWENPAW_VERSION}`], { timeoutMs: 900_000 });
  const status = qwenPawRuntimeStatus(dataDir);
  if (!status.installed) throw new Error("运行环境已完成下载，但 QwenPaw 未能正常启动。");
  return status;
}

async function ensureQwenPawRuntime(dataDir) {
  const ready = qwenPawRuntimeStatus(dataDir);
  if (ready.installed) return ready;
  if (!qwenPawBootstrapPromise) {
    qwenPawBootstrapPromise = installManagedQwenPawRuntime(dataDir)
      .catch((error) => { throw new Error(`首次自动部署运营 Agent 失败：${error.message || error}`); })
      .finally(() => { qwenPawBootstrapPromise = null; });
  }
  return qwenPawBootstrapPromise;
}

function qwenPawOperationsWorkspace(dataDir) {
  return path.join(qwenPawWorkingDirectory(dataDir), "workspaces", QWENPAW_OPERATIONS_AGENT_ID);
}

function qwenPawOperationsSkillPath(dataDir) {
  return path.join(qwenPawOperationsWorkspace(dataDir), "skills", "ecommerce-operations-assistant", "SKILL.md");
}

function qwenPawOperationsAgentPath(dataDir) {
  return path.join(qwenPawOperationsWorkspace(dataDir), "agent.json");
}

function qwenPawConsoleUrl() {
  return `http://${QWENPAW_CONSOLE_HOST}:${QWENPAW_CONSOLE_PORT}/console`;
}

function qwenPawSyncScriptSourcePath() {
  return path.join(serviceDirectory, "..", "scripts", "sync-qwenpaw-operations.py");
}

function qwenPawToolBridgeSourcePath() {
  return path.join(serviceDirectory, "..", "scripts", "ecommerce-agent-mcp.js");
}

function qwenPawToolBridgePath(dataDir) {
  return path.join(qwenPawWorkingDirectory(dataDir), "ecommerce-agent-mcp.js");
}

async function qwenPawSyncScriptPath(dataDir) {
  const sourcePath = qwenPawSyncScriptSourcePath();
  const destinationPath = path.join(qwenPawWorkingDirectory(dataDir), "sync-qwenpaw-operations.py");
  const script = await fs.readFile(sourcePath, "utf8");
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const existing = await fs.readFile(destinationPath, "utf8").catch(() => "");
  if (existing !== script) await fs.writeFile(destinationPath, script, "utf8");
  return destinationPath;
}

async function qwenPawToolBridgeScriptPath(dataDir) {
  const sourcePath = qwenPawToolBridgeSourcePath();
  const destinationPath = qwenPawToolBridgePath(dataDir);
  const script = await fs.readFile(sourcePath, "utf8");
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const existing = await fs.readFile(destinationPath, "utf8").catch(() => "");
  if (existing !== script) await fs.writeFile(destinationPath, script, "utf8");
  return destinationPath;
}

function qwenPawAppUrl(contextUrl = qwenPawOperationsContextUrl) {
  return new URL(contextUrl).origin;
}

function qwenPawRuntimeEnvironment(dataDir, { apiKey = "", contextUrl = qwenPawOperationsContextUrl, operatingPrinciples = "" } = {}) {
  return {
    ...process.env,
    QWENPAW_WORKING_DIR: qwenPawWorkingDirectory(dataDir),
    ...(apiKey ? { ECOM_QWENPAW_API_KEY: apiKey } : {}),
    ECOM_QWENPAW_CONTEXT_URL: contextUrl,
    ECOM_QWENPAW_OPERATING_PRINCIPLES: text(operatingPrinciples, 4_000),
    ECOM_QWENPAW_MCP_SERVER_PATH: qwenPawToolBridgePath(dataDir),
    ECOM_QWENPAW_APP_URL: qwenPawAppUrl(contextUrl),
    ECOM_QWENPAW_AGENT_TOOL_TOKEN: qwenPawAgentToolToken,
    ECOM_QWENPAW_NODE_PATH: process.execPath,
    ECOM_QWENPAW_NODE_AS_NODE: process.versions.electron ? "1" : "",
  };
}

function qwenPawSafeMessage(value, apiKey = "") {
  const source = text(value, 600);
  return apiKey ? source.split(apiKey).join("[已隐藏]") : source;
}

export function setQwenPawOperationsContextUrl(value) {
  const next = String(value || "").trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/operations\/agent-context$/.test(next)) {
    throw new Error("QwenPaw 本地运营数据地址无效。");
  }
  qwenPawOperationsContextUrl = next;
}

export function qwenPawAgentToolAccessToken() {
  return qwenPawAgentToolToken;
}

export function qwenPawSyncPlan(dataDir, modelConfig, operatingPrinciples = "") {
  const resolved = resolveModelConfig(modelConfig);
  if (!resolved.apiKey) throw Object.assign(new Error("请先在设置中心配置文字模型 API Key 后再打开运营 Agent。"), { status: 400 });
  const normalizedPrinciples = text(operatingPrinciples, 4_000);
  const signature = crypto.createHash("sha256")
    .update(`${QWENPAW_OPERATIONS_CONFIG_REVISION}\n${resolved.baseUrl}\n${resolved.model}\n${resolved.apiKey}\n${qwenPawOperationsContextUrl}\n${qwenPawAgentToolToken}\n${normalizedPrinciples}`)
    .digest("hex");
  return {
    model: resolved.model,
    signature,
    args: ["--base-url", resolved.baseUrl, "--model", resolved.model],
    environment: qwenPawRuntimeEnvironment(dataDir, { apiKey: resolved.apiKey, operatingPrinciples: normalizedPrinciples }),
    resolved,
  };
}

async function syncQwenPawOperationsAgent(dataDir, modelConfig, operatingPrinciples = "") {
  const runtime = await ensureQwenPawRuntime(dataDir);
  if (!runtime.installed) throw Object.assign(new Error("未检测到 QwenPaw 本地运行时，请先安装后再打开运营 Agent。"), { status: 503 });
  await qwenPawToolBridgeScriptPath(dataDir);
  const plan = qwenPawSyncPlan(dataDir, modelConfig, operatingPrinciples);
  const scriptPath = await qwenPawSyncScriptPath(dataDir);
  const result = spawnSync(qwenPawPythonExecutable(dataDir), [scriptPath, "--base-url", plan.resolved.baseUrl, "--model", plan.model], {
    encoding: "utf8",
    timeout: 45_000,
    windowsHide: true,
    env: plan.environment,
  });
  if (result.error || result.status !== 0) {
    const message = qwenPawSafeMessage(result.stderr || result.stdout || result.error?.message, plan.resolved.apiKey);
    throw Object.assign(new Error(message || "QwenPaw 运营 Agent 同步失败。"), { status: 502 });
  }
  return {
    ...runtime,
    directory: qwenPawWorkingDirectory(dataDir),
    agentId: QWENPAW_OPERATIONS_AGENT_ID,
    model: plan.model,
    signature: plan.signature,
    skillPath: qwenPawOperationsSkillPath(dataDir),
  };
}

async function qwenPawConsoleReachable() {
  try {
    const response = await fetch(qwenPawConsoleUrl(), { signal: AbortSignal.timeout(1_200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForQwenPawConsole() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await qwenPawConsoleReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function stopQwenPawOperationsConsole() {
  const processHandle = qwenPawConsoleProcess;
  qwenPawConsoleProcess = null;
  qwenPawConsoleSignature = "";
  if (!processHandle || processHandle.exitCode !== null || processHandle.killed) return;
  const exited = new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

export async function startQwenPawOperationsConsole(dataDir, modelConfig, operatingPrinciples = "") {
  const synced = await syncQwenPawOperationsAgent(dataDir, modelConfig, operatingPrinciples);
  const sameRuntime = qwenPawConsoleProcess && qwenPawConsoleProcess.exitCode === null && qwenPawConsoleSignature === synced.signature;
  if (!sameRuntime) {
    qwenPawConsoleLastError = "";
    await stopQwenPawOperationsConsole();
    if (!(await qwenPawConsoleReachable())) {
      const child = spawn(qwenPawPythonExecutable(dataDir), ["-m", "qwenpaw", "app", "--host", QWENPAW_CONSOLE_HOST, "--port", String(QWENPAW_CONSOLE_PORT), "--log-level", "warning"], {
        env: qwenPawRuntimeEnvironment(dataDir, { operatingPrinciples }),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      qwenPawConsoleProcess = child;
      child.stderr.on("data", (chunk) => { qwenPawConsoleLastError = qwenPawSafeMessage(chunk, ""); });
      child.on("error", (error) => { qwenPawConsoleLastError = qwenPawSafeMessage(error?.message, ""); });
      child.on("exit", (code) => {
        if (code && code !== 0) qwenPawConsoleLastError ||= `QwenPaw 本地会话已退出（${code}）。`;
        if (qwenPawConsoleProcess === child) qwenPawConsoleProcess = null;
      });
    }
    qwenPawConsoleSignature = synced.signature;
  }
  if (!(await waitForQwenPawConsole())) {
    throw Object.assign(new Error(qwenPawConsoleLastError || "QwenPaw 原生会话启动超时。"), { status: 503 });
  }
  return {
    ...synced,
    running: true,
    consoleUrl: qwenPawConsoleUrl(),
  };
}

export function qwenPawRuntimeStatus(dataDir = "") {
  const options = { encoding: "utf8", timeout: 5_000, windowsHide: true };
  const skillPath = dataDir ? qwenPawOperationsSkillPath(dataDir) : "";
  const withSkillStatus = (status) => ({ ...status, skillReady: Boolean(skillPath && existsSync(skillPath)) });
  const managedPython = dataDir ? qwenPawManagedPythonPath(dataDir) : "";
  const candidates = [
    ...(managedPython && existsSync(managedPython) ? [{ executable: managedPython, source: "应用自动部署" }] : []),
    ...(process.platform === "win32" ? [{ executable: "py", source: "系统 Python" }, { executable: "python", source: "系统 Python" }] : [{ executable: "python3", source: "系统 Python" }]),
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.executable, ["-m", "qwenpaw", "--version"], options);
    if (!result.error && result.status === 0) {
      return withSkillStatus({ installed: true, version: text(result.stdout || result.stderr, 120).replace(/^qwenpaw,?\s*version\s*/i, ""), message: `${candidate.source}运行时已就绪。` });
    }
  }
  return withSkillStatus({ installed: false, version: "", message: "首次打开运营 Agent 时会自动部署本机运行环境。" });
}

export async function prepareQwenPawOperationsSkill(dataDir, modelConfig, operatingPrinciples = "") {
  const synced = await syncQwenPawOperationsAgent(dataDir, modelConfig, operatingPrinciples);
  // A running QwenPaw process reads its workspace instructions at startup.
  // Model saves must replace that process so obsolete generic skills cannot
  // keep inflating subsequent conversations.
  await stopQwenPawOperationsConsole();
  return { ...synced, skillReady: existsSync(qwenPawOperationsSkillPath(dataDir)) && existsSync(qwenPawOperationsAgentPath(dataDir)) };
}
