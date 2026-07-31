import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { requestModelApiJson, resolveModelConfig } from "./modelConfigService.js";
import {
  qwenPawBackendUrl,
  qwenPawLocalRuntimeStatus,
  normalizeQwenPawInstallDirectory,
  qwenPawOfficialPackagePlan,
  qwenPawWorkingDirectory as officialQwenPawWorkingDirectory,
  startQwenPawBackend,
  stopQwenPawBackend,
} from "./qwenPawRuntimeService.js";
import { normalizeQwenPawAlerts } from "./qwenPawFeishuService.js";
import { normalizeCloudSync, publicCloudSync } from "./cloudSyncService.js";
import { buildOperationsWorkspace as buildOperationsWorkspaceCore } from "../../shared/operationsCore.js";

// Report type is inferred from the export's contents.  The older generic types
// remain valid so that existing local data keeps working after the warehouse
// upgrade.
export const OPERATIONS_REPORT_TYPES = Object.freeze([
  // This order is intentional: it is also the manual import order in the UI.
  "category", "product", "scenario", "promotion", "campaign",
  "market", "audience", "competitor",
]);
export const OPERATIONS_REPORT_INPUT_TYPES = OPERATIONS_REPORT_TYPES;
export const OPERATIONS_PERIOD_KINDS = Object.freeze(["day", "week", "month", "custom"]);
export const OPERATIONS_UNASSIGNED_STORE_NAME = "未归属店铺";
// Exported operational reports can be large, especially when WPS includes
// full campaign dimensions. Keep this high enough for normal exports while
// retaining a bounded in-memory upload.
export const OPERATIONS_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REPORTS = 180;
const MAX_ROWS_PER_REPORT = 5_000;
const MAX_SCREENSHOTS_PER_ANALYSIS = 3;
const MAX_CHAT_MESSAGES = 80;
const MAX_SALES_DEDUCTIONS = 500;
// Version 2 rebuilds the local ledger after the promotion-type field repair.
// Otherwise a previously cached ledger can keep the old, mis-mapped channel.
const OPERATIONS_LEDGER_VERSION = 2;

const DEFAULT_TARGETS = Object.freeze({ targetRoi: 2, maxFeeRate: 0.3, dailyBudgetCap: 0 });
const DEFAULT_DAILY_REPORT = Object.freeze({ enabled: false, time: "09:30", lastRunAt: null, lastSentAt: null, lastError: "" });
const QWENPAW_OPERATIONS_AGENT_ID = "default";
const QWENPAW_OPERATIONS_CONFIG_REVISION = "operations-agent-official-runtime-v1";
const QWENPAW_PROVIDER_ID = "ecommerce-monitor-model";
const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
let qwenPawOperationsContextUrl = "http://127.0.0.1:4317/api/operations/agent-context";
const qwenPawAgentToolToken = crypto.randomBytes(32).toString("base64url");
let qwenPawConsoleStart = null;
let qwenPawConsoleStartSignature = "";

const FIELD_ALIASES = Object.freeze({
  reportDate: ["统计日期", "日期", "数据日期", "报表日期", "统计周期", "统计时间", "数据周期", "date", "reportdate"],
  storeName: ["店铺", "店铺名称", "所属店铺", "storename", "store", "shop"],
  productId: ["商品id", "宝贝id", "主体id", "itemid", "productid", "商品编号"],
  productName: ["商品名称", "宝贝名称", "推广商品", "主体名称", "产品名称", "productname", "商品", "宝贝", "product"],
  productStage: ["商品阶段", "产品阶段", "新品老品", "productstage", "stage"],
  // "场景名字" is the promotion type, not the plan name. Keeping it out of
  // this list means an export without a plan column still retains its type.
  campaignName: ["计划名称", "计划名字", "推广计划", "campaignname", "计划", "campaign"],
  // A product promotion export may contain both a plan name and the platform
  // channel (for example 全站推广 / 关键词推广). Keep them separate: plans are
  // not a stable channel dimension and must never be used to relabel spend.
  // Some historical Wanxiangtai exports put a plan-level value in
  // "场景名字" and the real promotion type in "原二级场景名字". Prefer the
  // latter whenever it exists; current exports where the two values agree are
  // unaffected.
  channel: ["推广渠道", "原二级场景名字", "场景名字", "推广场景", "一级场景", "营销场景", "推广类型", "投放渠道", "渠道", "场景", "channel"],
  category: ["类目名称", "二级类目名称", "一级类目名称", "类目", "商品类目", "一级类目", "category"],
  primaryCategory: ["一级类目名称", "一级类目", "primarycategory"],
  secondaryCategory: ["二级类目名称", "二级类目", "secondarycategory"],
  audienceName: ["人群名称", "定向人群", "audiencename", "人群", "audience"],
  spend: ["消耗", "花费", "推广花费", "广告消耗", "cost", "spend"],
  revenue: ["总成交金额", "支付金额", "支付成交金额", "成交金额", "成交额", "成交金额元", "gmv", "revenue"],
  refundAmount: ["售中售后成功退款金额", "成功退款金额", "退款金额", "退款总金额", "退款", "refundamount", "refund"],
  roi: ["roi", "投入产出比", "投产"],
  orders: ["总成交笔数", "支付订单数", "订单数", "成交订单数", "成交笔数", "orders"],
  clicks: ["点击量", "点击次数", "clicks"],
  impressions: ["展现量", "曝光量", "impressions"],
  conversionRate: ["转化率", "成交转化率", "conversionrate", "cvr"],
  audienceSize: ["人群规模", "覆盖人数", "人群数", "覆盖量", "audiencesize"],
  visitors: ["商品访客数", "访客数", "访客", "uv", "visitors"],
  pageViews: ["商品浏览量", "浏览量", "浏览", "pv", "pageviews"],
  favorites: ["商品收藏人数", "收藏人数", "收藏量", "favorites"],
  cartUsers: ["商品加购人数", "加购人数", "加购用户数", "cartusers"],
  cartItems: ["商品加购件数", "加购件数", "cartitems"],
  paidBuyers: ["支付买家数", "成交买家数", "paidbuyers"],
  paidItems: ["支付件数", "成交件数", "paiditems"],
  bounceRate: ["商品详情页跳出率", "跳出率", "bouncerate"],
  collectionCartRate: ["收藏加购率", "访问加购转化率", "加购转化率", "collectioncartrate"],
  averageDwellSeconds: ["平均停留时长", "平均停留时间", "averagedwell"],
  cpc: ["单次点击成本", "平均点击花费", "点击单价", "cpc"],
  costPerCollectCart: ["单次收加成本", "收藏加购成本", "costpercollectcart"],
});

const PRODUCT_CATALOG_ALIASES = Object.freeze({
  storeName: ["店铺名", "店铺名称", "所属店铺", "店铺", "storename", "store", "shop"],
  productId: ["商品ID", "宝贝ID", "ID", "主体ID", "itemid", "productid", "商品编号"],
  category: ["品类名", "类目名称", "商品类目", "类目", "category"],
  model: ["型号", "商品型号", "产品型号", "款式型号", "model"],
});

const EXACT_MATCH_ALIASES = new Set(["商品", "宝贝", "product", "店铺", "shop", "计划", "campaign", "类目", "category", "人群", "audience"]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function uniqueStrings(values, limit = 60) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function text(value, limit = 160) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function finiteNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function fixedNumber(value, digits = 2, fallback = "--") {
  const numericValue = finiteNumber(value);
  return numericValue === null ? fallback : numericValue.toFixed(digits);
}

function percentNumber(value, digits = 1, fallback = "--") {
  const numericValue = finiteNumber(value);
  return numericValue === null ? fallback : `${(numericValue * 100).toFixed(digits)}%`;
}

export function normalizeUploadedFilename(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "未命名文件";
  // Multipart implementations do not agree on whether a non-ASCII filename
  // is raw UTF-8, Latin-1 decoded UTF-8, or double-decoded. Select the best
  // recovery instead of assuming a single browser/server pairing.
  const score = (candidate) => {
    const value = String(candidate || "");
    const chinese = (value.match(/[\u3400-\u9FFF]/g) || []).length;
    const mojibake = (value.match(/[\u00C2\u00C3\u00E5\u00E6\u00E7\u00E8\u00E9]/g) || []).length;
    const replacement = (value.match(/\uFFFD/g) || []).length;
    return chinese * 12 - mojibake * 5 - replacement * 40;
  };
  const candidates = new Set([raw]);
  let current = raw;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const recovered = Buffer.from(current, "latin1").toString("utf8");
      if (!recovered || recovered.includes("\uFFFD") || recovered === current) break;
      candidates.add(recovered);
      current = recovered;
    } catch {
      break;
    }
  }
  return [...candidates].sort((left, right) => score(right) - score(left) || left.length - right.length)[0] || raw;
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
  const entries = Object.entries(row || {}).filter(([header, value]) => headerKey(header) && value !== "" && value !== null && value !== undefined);
  // The field priority is intentional.  A promotion export can include both
  // "总成交金额" and several pre-sale/attribution columns; the exact business
  // metric must win rather than whichever column happens to be first.
  for (const alias of normalizedAliases) {
    const exact = entries.find(([header]) => headerKey(header) === alias);
    if (exact) return exact[1];
  }
  for (const alias of normalizedAliases) {
    if (EXACT_MATCH_ALIASES.has(alias)) continue;
    const fuzzy = entries.find(([header]) => {
      const key = headerKey(header);
      return key.includes(alias) || alias.includes(key);
    });
    if (fuzzy) return fuzzy[1];
  }
  return undefined;
}

function rowHasColumn(row, aliases) {
  const normalizedAliases = aliases.map((alias) => headerKey(alias));
  return Object.keys(row || {}).some((header) => {
    const key = headerKey(header);
    return normalizedAliases.some((alias) => key === alias || (!EXACT_MATCH_ALIASES.has(alias) && (key.includes(alias) || alias.includes(key))));
  });
}

function dateOnly(value, fallback = new Date()) {
  const candidate = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  const parsed = Date.parse(candidate);
  const date = Number.isFinite(parsed) ? new Date(parsed) : fallback;
  // Imported dates and dashboard filters are business-calendar dates. Using
  // UTC here can move a locally imported late-night value into the next day.
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function isoDate(value) {
  const candidate = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function dateStrings(value) {
  const source = String(value || "");
  return [...source.matchAll(/20\d{2}[./年-]\d{1,2}[./月-]\d{1,2}/g)]
    .map((match) => match[0].replace(/[./年月]/g, "-").replace(/-+$/g, ""))
    .map((item) => {
      const parts = item.split("-").map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return "";
      const [year, month, day] = parts;
      if (month < 1 || month > 12 || day < 1 || day > 31) return "";
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    })
    .filter(Boolean);
}

function detectReportPeriod(rows) {
  const values = [];
  for (const row of rows.slice(0, 5_000)) {
    const suppliedDate = rowValue(row, FIELD_ALIASES.reportDate);
    if (suppliedDate !== undefined) values.push(String(suppliedDate));
  }
  const dates = values.flatMap(dateStrings).sort();
  if (!dates.length) return null;
  const start = dates[0];
  const end = dates.at(-1) || start;
  return { start, end, label: start === end ? start : `${start} 至 ${end}` };
}

function periodKindFor(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  const days = Number.isFinite(startTime) && Number.isFinite(endTime)
    ? Math.floor((endTime - startTime) / 86_400_000) + 1
    : 1;
  if (days <= 1) return "day";
  if (days <= 8) return "week";
  if (days >= 28 && days <= 32) return "month";
  return "custom";
}

function totalRow(row) {
  return /^(合计|汇总|总计|total)$/i.test(text(row.productName || row.campaignName || row.audienceName || row.category));
}

function isStoredNormalizedRow(row) {
  return Boolean(row && typeof row === "object" && [
    "storeName", "productId", "productName", "spend", "grossRevenue", "revenue", "refundAmount", "refundDataAvailable", "roi",
  ].every((field) => Object.hasOwn(row, field)));
}

function normalizeStoredRow(row) {
  const spend = numeric(row.spend);
  const grossRevenue = numeric(row.grossRevenue);
  const refundDataAvailable = Boolean(row.refundDataAvailable);
  const refundAmount = refundDataAvailable ? numeric(row.refundAmount) ?? 0 : null;
  const revenue = numeric(row.revenue) ?? (Number.isFinite(grossRevenue) ? grossRevenue - (refundAmount || 0) : null);
  const computedRoi = Number.isFinite(spend) && spend > 0 && Number.isFinite(grossRevenue) ? grossRevenue / spend : null;
  return {
    storeName: text(row.storeName, 80),
    productId: text(row.productId, 80),
    productName: text(row.productName, 120),
    productStage: ["new", "mature", "unknown"].includes(row.productStage) ? row.productStage : "unknown",
    campaignName: text(row.campaignName, 120),
    channel: text(row.channel, 120),
    category: text(row.category, 80),
    primaryCategory: text(row.primaryCategory, 80),
    secondaryCategory: text(row.secondaryCategory, 80),
    audienceName: text(row.audienceName, 120),
    spend,
    grossRevenue,
    revenue,
    refundAmount,
    refundDataAvailable,
    roi: numeric(row.roi) ?? computedRoi,
    orders: numeric(row.orders),
    clicks: numeric(row.clicks),
    impressions: numeric(row.impressions),
    conversionRate: numeric(row.conversionRate, { percent: true }),
    audienceSize: numeric(row.audienceSize),
    visitors: numeric(row.visitors),
    pageViews: numeric(row.pageViews),
    favorites: numeric(row.favorites),
    cartUsers: numeric(row.cartUsers),
    cartItems: numeric(row.cartItems),
    paidBuyers: numeric(row.paidBuyers),
    paidItems: numeric(row.paidItems),
    bounceRate: numeric(row.bounceRate, { percent: true }),
    collectionCartRate: numeric(row.collectionCartRate, { percent: true }),
    averageDwellSeconds: numeric(row.averageDwellSeconds),
    cpc: numeric(row.cpc),
    costPerCollectCart: numeric(row.costPerCollectCart),
  };
}

function normalizeRow(row) {
  const normalizedRecord = Object.hasOwn(row || {}, "grossRevenue") || Object.hasOwn(row || {}, "refundAmount");
  const spend = numeric(rowValue(row, FIELD_ALIASES.spend));
  const suppliedRevenue = normalizedRecord
    ? numeric(row.grossRevenue)
    : numeric(rowValue(row, FIELD_ALIASES.revenue));
  const refundDataAvailable = normalizedRecord
    ? Boolean(row.refundDataAvailable)
    : rowHasColumn(row, FIELD_ALIASES.refundAmount);
  const suppliedRefundAmount = normalizedRecord
    ? numeric(row.refundAmount)
    : numeric(rowValue(row, FIELD_ALIASES.refundAmount));
  const refundAmount = refundDataAvailable ? suppliedRefundAmount ?? 0 : null;
  const suppliedRoi = numeric(rowValue(row, FIELD_ALIASES.roi));
  const grossRevenue = Number.isFinite(suppliedRevenue)
    ? suppliedRevenue
    : Number.isFinite(spend) && Number.isFinite(suppliedRoi) ? spend * suppliedRoi : null;
  const revenue = normalizedRecord
    ? numeric(row.revenue)
    : Number.isFinite(grossRevenue) ? grossRevenue - (refundAmount || 0) : null;
  const computedRoi = Number.isFinite(spend) && spend > 0 && Number.isFinite(grossRevenue) ? grossRevenue / spend : null;
  const productStageText = text(rowValue(row, FIELD_ALIASES.productStage), 30).toLowerCase();
  return {
    storeName: text(rowValue(row, FIELD_ALIASES.storeName), 80),
    productId: text(rowValue(row, FIELD_ALIASES.productId), 80),
    productName: text(rowValue(row, FIELD_ALIASES.productName), 120),
    productStage: /新|^new$/.test(productStageText) ? "new" : /老|成熟|^mature$/.test(productStageText) ? "mature" : "unknown",
    campaignName: text(rowValue(row, FIELD_ALIASES.campaignName), 120),
    channel: text(rowValue(row, FIELD_ALIASES.channel), 120),
    category: text(rowValue(row, FIELD_ALIASES.category), 80),
    primaryCategory: text(rowValue(row, FIELD_ALIASES.primaryCategory), 80),
    secondaryCategory: text(rowValue(row, FIELD_ALIASES.secondaryCategory), 80),
    audienceName: text(rowValue(row, FIELD_ALIASES.audienceName), 120),
    spend,
    revenue,
    grossRevenue,
    refundAmount,
    refundDataAvailable,
    roi: Number.isFinite(computedRoi) ? computedRoi : suppliedRoi,
    orders: numeric(rowValue(row, FIELD_ALIASES.orders)),
    clicks: numeric(rowValue(row, FIELD_ALIASES.clicks)),
    impressions: numeric(rowValue(row, FIELD_ALIASES.impressions)),
    conversionRate: numeric(rowValue(row, FIELD_ALIASES.conversionRate), { percent: true }),
    audienceSize: numeric(rowValue(row, FIELD_ALIASES.audienceSize)),
    visitors: numeric(rowValue(row, FIELD_ALIASES.visitors)),
    pageViews: numeric(rowValue(row, FIELD_ALIASES.pageViews)),
    favorites: numeric(rowValue(row, FIELD_ALIASES.favorites)),
    cartUsers: numeric(rowValue(row, FIELD_ALIASES.cartUsers)),
    cartItems: numeric(rowValue(row, FIELD_ALIASES.cartItems)),
    paidBuyers: numeric(rowValue(row, FIELD_ALIASES.paidBuyers)),
    paidItems: numeric(rowValue(row, FIELD_ALIASES.paidItems)),
    bounceRate: numeric(rowValue(row, FIELD_ALIASES.bounceRate), { percent: true }),
    collectionCartRate: numeric(rowValue(row, FIELD_ALIASES.collectionCartRate), { percent: true }),
    averageDwellSeconds: numeric(rowValue(row, FIELD_ALIASES.averageDwellSeconds)),
    cpc: numeric(rowValue(row, FIELD_ALIASES.cpc)),
    costPerCollectCart: numeric(rowValue(row, FIELD_ALIASES.costPerCollectCart)),
  };
}

function normalizedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .slice(0, MAX_ROWS_PER_REPORT)
    .map((row) => isStoredNormalizedRow(row) ? normalizeStoredRow(row) : normalizeRow(row))
    .filter((row) => Object.values(row).some((value) => value !== "" && value !== null && value !== "unknown"));
}

function promotionMappingKey(report, row, { includeStore = true } = {}) {
  const productId = text(row?.productId, 80).replace(/\s+/g, "");
  const planName = text(row?.campaignName, 120);
  if (!productId || !planName) return "";
  const storeName = text(row?.storeName || report?.storeName, 80);
  return [includeStore ? storeName : "", productId, planName].map(joinKey).join("\u0000");
}

function looksLikePromotionType(value) {
  const label = text(value, 120);
  if (!label || /计划|商品|产品/.test(label)) return false;
  return /全站|关键词|直通车|万相台|引力魔方|超级推荐|品销宝|钻展|淘客|推广|营销/.test(label);
}

/**
 * Early local imports stored a plan name in both `campaignName` and `channel`.
 * Recover only a single promotion type verified by another local source row
 * with the same store/product/plan identity. Ambiguous data is never guessed.
 */
function repairLegacyPromotionChannels(reports) {
  const mappings = new Map();
  const addMapping = (key, channel) => {
    if (!key || !channel) return;
    if (!mappings.has(key)) mappings.set(key, new Set());
    mappings.get(key).add(channel);
  };
  for (const report of reports) {
    if (!["campaign", "promotion"].includes(report.type)) continue;
    for (const row of report.rows) {
      const channel = text(row.channel, 120);
      const planName = text(row.campaignName, 120);
      if (!channel || !planName || channel === planName) continue;
      addMapping(promotionMappingKey(report, row), channel);
      addMapping(promotionMappingKey(report, row, { includeStore: false }), channel);
    }
  }
  const resolve = (report, row) => {
    const channel = text(row.channel, 120);
    const planName = text(row.campaignName, 120);
    if (!channel || channel !== planName || looksLikePromotionType(channel)) return channel;
    for (const key of [
      promotionMappingKey(report, row),
      promotionMappingKey(report, row, { includeStore: false }),
    ]) {
      const candidates = mappings.get(key);
      if (candidates?.size === 1) return [...candidates][0];
    }
    return channel;
  };
  return reports.map((report) => {
    if (!["campaign", "promotion"].includes(report.type)) return report;
    let changed = false;
    const rows = report.rows.map((row) => {
      const channel = resolve(report, row);
      if (channel === row.channel) return row;
      changed = true;
      return { ...row, channel };
    });
    return changed ? { ...report, rows } : report;
  });
}

function decodeCsv(buffer) {
  const candidates = ["utf-8", "gb18030", "gbk"].flatMap((encoding) => {
    try {
      return [{ encoding, value: new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, "") }];
    } catch {
      return [];
    }
  });
  const score = (value) => {
    const printable = (value.match(/[\u4E00-\u9FFFA-Za-z0-9_\s,;|\t]/g) || []).length;
    const replacement = (value.match(/\uFFFD/g) || []).length;
    const mojibake = (value.match(/[\u00C2\u00C3\u00E5\u00E6\u00E7\u00E8\u00E9]/g) || []).length;
    return printable - replacement * 120 - mojibake * 8;
  };
  return candidates.sort((left, right) => score(right.value) - score(left.value))[0]?.value || "";
}

function csvDelimiter(textValue) {
  const firstLine = String(textValue || "").split(/\r?\n/, 1)[0] || "";
  const candidates = [",", "\t", ";", "|"];
  return candidates.map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter || ",";
}

function parseCsv(textValue) {
  const source = String(textValue || "").replace(/^\uFEFF/, "");
  if (!source.trim()) return [];
  const delimiter = csvDelimiter(source);
  const records = [];
  let row = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && quoted && source[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(current.trim());
      current = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(current.trim());
      if (row.some(Boolean)) records.push(row);
      row = [];
      current = "";
    } else {
      current += character;
    }
  }
  row.push(current.trim());
  if (row.some(Boolean)) records.push(row);
  if (!records.length) return [];
  const headerIndex = records.slice(0, 60).map((values, index) => ({ index, matches: headerMatchCount(values), populated: values.filter(Boolean).length }))
    .filter((candidate) => candidate.populated > 0)
    .sort((left, right) => (right.matches - left.matches) || (right.populated - left.populated) || (left.index - right.index))[0]?.index ?? 0;
  const headers = uniqueHeaders(records[headerIndex]);
  return records.slice(headerIndex + 1)
    .filter((values) => values.some((value) => String(value || "").trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function spreadsheetCellValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("text" in value) return value.text;
  if ("result" in value) return value.result;
  if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
  return value;
}

function uniqueHeaders(values) {
  const seen = new Map();
  return values.map((value, column) => {
    const base = text(value, 80) || `column_${column + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function headerMatchCount(values) {
  const aliases = Object.values(FIELD_ALIASES).flat().map((alias) => headerKey(alias));
  return values.reduce((count, value) => {
    const key = headerKey(value);
    return key && aliases.some((alias) => key === alias || (!EXACT_MATCH_ALIASES.has(alias) && (key.includes(alias) || alias.includes(key)))) ? count + 1 : count;
  }, 0);
}

function parseSpreadsheetRows(grid) {
  const rows = (Array.isArray(grid) ? grid : []).map((row) => Array.isArray(row) ? row : []);
  const candidates = rows.slice(0, 60).map((values, index) => {
    const populated = values.filter((value) => text(value)).length;
    const matches = headerMatchCount(values);
    return { index, populated, matches, score: matches * 100 + populated };
  }).filter((candidate) => candidate.populated > 0);
  if (!candidates.length) return [];

  // 生意参谋等导出文件常在前面放说明行；选择最像字段名的一行，而不是盲目拿第一行。
  const ranked = candidates.filter((candidate) => candidate.matches > 0 && candidate.populated >= 2)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const headerIndex = (ranked[0] || candidates[0]).index;
  const headers = uniqueHeaders(rows[headerIndex]);

  return rows.slice(headerIndex + 1)
    .filter((values) => values.some((value) => value !== null && value !== undefined && text(value)))
    .map((values) => Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])));
}

async function parseWorkbook(buffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const grid = [];
    sheet.eachRow({ includeEmpty: false }, (row, index) => {
      const values = row.values.slice(1).map(spreadsheetCellValue);
      grid[index - 1] = values;
    });
    return parseSpreadsheetRows(grid);
  } catch {
    // WPS can label an otherwise valid workbook as XLSM/XLSX while using
    // features ExcelJS does not load. SheetJS is our compatibility fallback.
    return parseLegacyWorkbook(buffer);
  }
}

function parseLegacyWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    throw Object.assign(new Error("无法读取此 XLS 文件，请从 Excel/WPS 重新导出后再上传。"), { status: 400 });
  }
  const sheetName = workbook.SheetNames.find((name) => workbook.Sheets[name]);
  if (!sheetName) return [];
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
  return parseSpreadsheetRows(grid);
}

function extensionOf(file = {}) {
  const name = normalizeUploadedFilename(file.originalname || "");
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function reportKind(file) {
  const extension = extensionOf(file);
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return "screenshot";
  if (["xlsx", "xlsm", "xltx", "xltm"].includes(extension)) return "xlsx";
  if (["xls", "xlsb", "ods"].includes(extension)) return "xls";
  if (["csv", "tsv", "txt"].includes(extension)) return "csv";
  if (extension === "json") return "json";
  return "";
}

export function isSupportedOperationsFile(file) {
  return Boolean(reportKind(file));
}

async function parseTabularOperationsFile(file) {
  const kind = reportKind(file);
  let rows;
  if (kind === "xlsx") rows = await parseWorkbook(file.buffer);
  else if (kind === "xls") rows = parseLegacyWorkbook(file.buffer);
  else if (kind === "csv") rows = parseCsv(decodeCsv(file.buffer));
  else {
    const parsed = JSON.parse(file.buffer.toString("utf8"));
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
  }
  return { kind, rows };
}

export async function parseOperationsFile(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("请选择有效的数据文件或截图。"), { status: 400 });
  if (file.buffer.length > OPERATIONS_MAX_UPLOAD_BYTES) throw Object.assign(new Error("运营数据文件不能超过 64 MB。"), { status: 413 });
  const kind = reportKind(file);
  if (!kind) throw Object.assign(new Error("支持 Excel、WPS、CSV、TSV、TXT、JSON、PNG、JPG 或 WEBP。"), { status: 400 });
  if (kind === "screenshot") return { kind, columns: [], rows: [], period: null };
  const parsedFile = await parseTabularOperationsFile(file);
  const rows = parsedFile.rows;
  if (!rows.length) throw Object.assign(new Error("报表中没有可识别的数据行。"), { status: 400 });
  const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row || {})), 200);
  const normalized = normalizedRows(rows);
  if (!normalized.length) throw Object.assign(new Error("已读取文件，但没有识别到可计算的经营数据。"), { status: 400 });
  return {
    kind,
    columns,
    rows: normalized,
    // A download/export timestamp belongs to the filename or workbook
    // metadata, not necessarily to the business data. Only report fields
    // such as \"统计日期\" or \"统计周期\" may determine this period.
    period: detectReportPeriod(rows),
    detectedType: detectOperationsReportType({
      fileName: file.originalname,
      columns,
      rows,
    }),
  };
}

function catalogEntryKey(storeName, productId) {
  return `${joinKey(storeName)}:${text(productId, 80).replace(/\s+/g, "")}`;
}

function normalizeProductCatalogEntries(entries) {
  const normalized = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const storeName = text(entry?.storeName, 80);
    const productId = text(entry?.productId, 80).replace(/\s+/g, "");
    const category = text(entry?.category, 80);
    const model = text(entry?.model, 80);
    if (!productId || (!category && !model)) continue;
    normalized.push({
      // Legacy catalog records had no identity or timestamp. Preserve their
      // original array order as version order so migrating local data never
      // replaces a newer mapping with an older one.
      id: text(entry?.id, 80) || `catalog_legacy_${crypto.createHash("sha256").update(`${storeName}\n${productId}\n${category}\n${model}\n${index}`).digest("hex").slice(0, 20)}`,
      storeName,
      productId,
      category,
      model,
      sourceName: text(entry?.sourceName, 160),
      createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : "",
    });
  }
  return normalized.slice(-20_000);
}

export function createProductCatalogEntries(entries, { sourceName = "", now = new Date() } = {}) {
  const createdAt = nowIso(now);
  return normalizeProductCatalogEntries(entries).map((entry) => ({
    ...entry,
    id: `catalog_${crypto.randomUUID()}`,
    sourceName: text(sourceName || entry.sourceName, 160),
    createdAt,
  }));
}

export async function parseProductCatalogFile(file) {
  if (!file?.buffer?.length) throw Object.assign(new Error("请选择 ID 型号表。"), { status: 400 });
  if (file.buffer.length > OPERATIONS_MAX_UPLOAD_BYTES) throw Object.assign(new Error("ID 型号表不能超过 64 MB。"), { status: 413 });
  const kind = reportKind(file);
  if (!kind || kind === "screenshot" || kind === "json") {
    throw Object.assign(new Error("ID 型号表支持 Excel、WPS、CSV、TSV 或 TXT。"), { status: 400 });
  }
  const parsedFile = await parseTabularOperationsFile(file);
  if (!parsedFile.rows.length) throw Object.assign(new Error("ID 型号表中没有可识别的数据行。"), { status: 400 });
  const columns = uniqueStrings(parsedFile.rows.flatMap((row) => Object.keys(row || {})), 200);
  const entries = normalizeProductCatalogEntries(parsedFile.rows.map((row) => ({
    storeName: text(rowValue(row, PRODUCT_CATALOG_ALIASES.storeName), 80),
    productId: text(rowValue(row, PRODUCT_CATALOG_ALIASES.productId), 80),
    category: text(rowValue(row, PRODUCT_CATALOG_ALIASES.category), 80),
    model: text(rowValue(row, PRODUCT_CATALOG_ALIASES.model), 80),
  })));
  if (!entries.length) {
    throw Object.assign(new Error("未识别到有效商品 ID。请确认表头包含 ID，且每行至少提供型号或品类。"), { status: 400 });
  }
  return {
    kind: parsedFile.kind,
    columns,
    entries,
    skippedRows: Math.max(0, parsedFile.rows.length - entries.length),
  };
}

function isCategorySpendSource({ fileName = "", columns = [], rows = [] } = {}) {
  const name = normalizeUploadedFilename(fileName);
  if (/(?:分类目场景|类目场景|营销场景|类目付费)/.test(name)) return true;

  const headers = uniqueStrings([
    ...(Array.isArray(columns) ? columns : []),
    ...((Array.isArray(rows) ? rows : []).slice(0, 5).flatMap((row) => Object.keys(row || {}))),
  ], 200).map(headerKey);
  const hasCategory = headers.some((header) => ["类目", "类目名称", "二级类目名称", "商品类目"].includes(header));
  const hasScenario = headers.some((header) => /(?:场景|推广渠道|一级场景)/.test(header));
  const hasProductIdentity = headers.some((header) => ["商品id", "宝贝id", "主体id", "商品名称", "宝贝名称"].includes(header));
  return hasCategory && hasScenario && !hasProductIdentity;
}

function canonicalOperationsReportType(type, source = {}) {
  // “品类付费” was a duplicate label for the same category-level spend
  // dataset. Keep the legacy identifier readable, but route actual category
  // scenario exports to the single `scenario` calculation path.
  if (type === "promotion" && isCategorySpendSource(source)) return "scenario";
  return type;
}

function detectOperationsReportType({ fileName = "", columns = [], rows = [] } = {}) {
  const name = normalizeUploadedFilename(fileName).toLowerCase();
  const headers = uniqueStrings([
    ...(Array.isArray(columns) ? columns : []),
    ...((Array.isArray(rows) ? rows : []).slice(0, 5).flatMap((row) => Object.keys(row || {}))),
  ], 200).map(headerKey);
  const hasHeader = (pattern) => headers.some((header) => pattern.test(header));
  const hasProduct = hasHeader(/^(?:商品id|宝贝id|主体id|商品名称|宝贝名称|推广商品|主体名称)$/);
  const hasCategory = hasHeader(/^(?:一级类目名称|二级类目名称|类目名称|商品类目|类目)$/);
  const hasSpend = hasHeader(/^(?:花费|消耗|推广花费|费用)$/);
  const hasRefund = hasHeader(/(?:退款)/);
  const hasRevenue = hasHeader(/(?:支付金额|成交金额|总成交金额|交易金额|销售金额)/);
  const hasPromotionDimension = hasHeader(/(?:计划|推广方式|推广渠道|场景|资源位)/);

  // Keep the category-paid legacy export manual. It has a distinct accounting
  // meaning but is intentionally not exposed in the current three-type uploader.
  if (isCategorySpendSource({ fileName, columns, rows })) return null;
  if (hasCategory && hasRevenue && (hasRefund || /(?:品类360|标准类目|品类报表)/.test(name))) return "category";
  if (hasProduct && hasSpend && (hasPromotionDimension || /(?:商品报表|单品付费|商品推广|推广报表)/.test(name))) return "campaign";
  if (hasProduct && hasRevenue && !hasSpend && /(?:商品.*全部|商品排行|生意参谋.*商品)/.test(name)) return "product";
  if (hasProduct && hasRevenue && !hasSpend) return "product";
  return null;
}

export function normalizeOperationsState(value = {}) {
  const normalizedReports = (Array.isArray(value?.reports) ? value.reports : [])
    .filter((report) => report && OPERATIONS_REPORT_TYPES.includes(report.type))
    .slice(-MAX_REPORTS)
    .map((report) => {
      const fileName = text(normalizeUploadedFilename(report.fileName), 160);
      const columns = uniqueStrings(report.columns, 200);
      const rows = normalizedRows(report.rows);
      const type = canonicalOperationsReportType(report.type, { fileName, columns, rows });
      const detectedType = OPERATIONS_REPORT_TYPES.includes(report.detectedType)
        ? canonicalOperationsReportType(report.detectedType, { fileName, columns, rows })
        : type;
      const dataSignature = normalizedReportDataSignature(report, rows);
      return {
        id: text(report.id, 80),
        type,
        storeName: text(report.storeName, 80),
        reportDate: dateOnly(report.reportDate),
        periodStart: dateOnly(report.periodStart || report.reportDate),
        periodEnd: dateOnly(report.periodEnd || report.reportDate),
        periodLabel: text(report.periodLabel, 80),
        periodKind: OPERATIONS_PERIOD_KINDS.includes(report.periodKind)
          ? report.periodKind
          : periodKindFor(dateOnly(report.periodStart || report.reportDate), dateOnly(report.periodEnd || report.reportDate)),
        detectedType,
        sourceName: text(report.sourceName, 80),
        fileName,
        kind: ["xls", "xlsx", "csv", "json", "screenshot"].includes(report.kind) ? report.kind : "csv",
        columns,
        rows,
        screenshotPath: typeof report.screenshotPath === "string" ? report.screenshotPath : "",
        screenshotMimeType: text(report.screenshotMimeType, 80),
        importedAt: typeof report.importedAt === "string" ? report.importedAt : nowIso(),
        dataSignature,
        cloudOrigin: report?.cloudOrigin && typeof report.cloudOrigin === "object"
          ? {
            endpoint: text(report.cloudOrigin.endpoint, 300),
            teamId: text(report.cloudOrigin.teamId, 120),
            remoteReportId: text(report.cloudOrigin.remoteReportId, 120),
            revision: Math.max(0, Math.floor(Number(report.cloudOrigin.revision) || 0)),
            syncedAt: typeof report.cloudOrigin.syncedAt === "string" ? report.cloudOrigin.syncedAt : null,
          }
          : null,
      };
    });
  const reports = repairLegacyPromotionChannels(normalizedReports);
  const ledgerSourceSignature = operationsLedgerSourceSignature(reports);
  const storedLedgerVersion = Number(value?.ledgerVersion || 0);
  const ledger = storedLedgerVersion === OPERATIONS_LEDGER_VERSION
    && value?.ledgerSourceSignature === ledgerSourceSignature
    ? normalizeOperationsLedger(value?.ledger, reports)
    : buildOperationsLedger(reports);
  const productCatalog = normalizeProductCatalogEntries(value?.productCatalog);
  const storeNames = uniqueStrings([
    ...(Array.isArray(value?.storeNames) ? value.storeNames : []),
    ...reports.map((report) => report.storeName),
    ...productCatalog.map((entry) => entry.storeName),
  ], 80);
  const catalogSource = value?.productCatalogSource || {};
  const productCatalogSource = productCatalog.length
    ? {
      fileName: text(normalizeUploadedFilename(catalogSource.fileName), 160),
      updatedAt: typeof catalogSource.updatedAt === "string" ? catalogSource.updatedAt : null,
    }
    : { fileName: "", updatedAt: null };
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
  const salesDeductions = (Array.isArray(value?.salesDeductions) ? value.salesDeductions : [])
    .map((item) => {
      const reportDate = dateOnly(item?.reportDate);
      const amount = numeric(item?.amount);
      return {
        id: text(item?.id, 80),
        storeName: text(item?.storeName, 80),
        reportDate,
        amount,
        note: text(item?.note, 240),
        createdAt: typeof item?.createdAt === "string" ? item.createdAt : nowIso(),
      };
    })
    .filter((item) => item.id && item.storeName && item.reportDate && Number.isFinite(item.amount) && item.amount > 0)
    .slice(-MAX_SALES_DEDUCTIONS);
  const schedule = value?.dailyReport || {};
  return {
    reports,
    ledgerVersion: OPERATIONS_LEDGER_VERSION,
    ledgerSourceSignature,
    ledger,
    storeNames,
    productCatalog,
    productCatalogSource,
    targets,
    feedback,
    chat,
    salesDeductions,
    principles: text(value?.principles, 4_000),
    qwenPawInstallDirectory: normalizeQwenPawInstallDirectory(value?.qwenPawInstallDirectory),
    qwenPawAlerts: normalizeQwenPawAlerts(value?.qwenPawAlerts),
    cloudSync: normalizeCloudSync(value?.cloudSync),
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

/** Clears generated operating analyses while retaining every source dataset and chat record. */
export function clearOperationsAnalyses(stateInput) {
  const state = normalizeOperationsState(stateInput);
  return { ...state, analyses: [] };
}

/**
 * A store name is only a local assignment. Removing it must not erase source
 * reports or catalog rows, so their explicit assignment becomes unassigned.
 */
export function unassignOperationsStore(stateInput, storeName) {
  const state = normalizeOperationsState(stateInput);
  const target = text(storeName, 80);
  if (!target || target === OPERATIONS_UNASSIGNED_STORE_NAME) return null;
  const matchesTarget = (value) => String(value || "").localeCompare(target, "zh-CN", { sensitivity: "accent" }) === 0;
  if (!state.storeNames.some(matchesTarget)) return null;

  let reportCount = 0;
  let productCatalogCount = 0;
  let salesDeductionCount = 0;
  const reports = state.reports.map((report) => {
    if (!matchesTarget(report.storeName)) return report;
    reportCount += 1;
    return { ...report, storeName: OPERATIONS_UNASSIGNED_STORE_NAME };
  });
  const productCatalog = state.productCatalog.map((entry) => {
    if (!matchesTarget(entry.storeName)) return entry;
    productCatalogCount += 1;
    return { ...entry, storeName: OPERATIONS_UNASSIGNED_STORE_NAME };
  });
  const salesDeductions = state.salesDeductions.map((deduction) => {
    if (!matchesTarget(deduction.storeName)) return deduction;
    salesDeductionCount += 1;
    return { ...deduction, storeName: OPERATIONS_UNASSIGNED_STORE_NAME };
  });

  return {
    state: normalizeOperationsState({
      ...state,
      reports,
      productCatalog,
      salesDeductions,
      storeNames: state.storeNames.filter((name) => !matchesTarget(name)),
    }),
    reportCount,
    productCatalogCount,
    salesDeductionCount,
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
  // Report category is chosen by the operator.  Do not infer it from a file
  // name or a loose header match: a wrong automatic classification is worse
  // than asking for one deliberate manual selection.
  const requestedType = OPERATIONS_REPORT_TYPES.includes(input?.type) ? input.type : "market";
  const type = canonicalOperationsReportType(requestedType, {
    fileName: file?.originalname,
    columns: parsed?.columns,
    rows: parsed?.rows,
  });
  const id = `ops_${crypto.randomUUID()}`;
  const detectedPeriod = parsed?.period || null;
  const requestedPeriodKind = OPERATIONS_PERIOD_KINDS.includes(input?.periodKind) ? input.periodKind : "";
  const requestedDate = isoDate(text(input?.reportDate, 40));
  const requestedStart = isoDate(input?.periodStart);
  const requestedEnd = isoDate(input?.periodEnd);
  const isScreenshot = parsed?.kind === "screenshot";
  // For data files, a date is part of the data contract. Never turn an
  // unknown reporting day into the import day or the export filename date.
  const periodStart = requestedStart
    || ((!requestedPeriodKind || requestedPeriodKind === "day") && requestedDate)
    || detectedPeriod?.start
    || (isScreenshot ? dateOnly(now) : "");
  const periodEnd = requestedEnd || requestedDate || detectedPeriod?.end || (isScreenshot ? dateOnly(now) : "");
  if (!periodStart || !periodEnd) {
    throw Object.assign(new Error("未检测到报表统计日期。请选择统计日期或统计区间后再导入；下载日期不会作为统计日期使用。"), { status: 400 });
  }
  const periodKind = OPERATIONS_PERIOD_KINDS.includes(input?.periodKind)
    ? input.periodKind
    : periodKindFor(periodStart, periodEnd);
  return {
    id,
    type,
    storeName: text(input?.storeName, 80),
    reportDate: periodEnd,
    periodStart,
    periodEnd,
    periodLabel: periodStart === periodEnd ? periodEnd : `${periodStart} 至 ${periodEnd}`,
    periodKind,
    detectedType: type,
    sourceName: text(input?.sourceName, 80),
    fileName: text(normalizeUploadedFilename(file?.originalname), 160),
    kind: parsed.kind,
    columns: parsed.columns,
    rows: parsed.rows,
    screenshotPath,
    screenshotMimeType: parsed.kind === "screenshot" ? String(file?.mimetype || "image/png") : "",
    importedAt: nowIso(now),
    // The data hash lets the local ledger invalidate itself without repeatedly
    // serializing every raw report on each page switch.
    dataSignature: crypto.createHash("sha256").update(JSON.stringify(parsed.rows || [])).digest("hex"),
  };
}

function normalizedReportDataSignature(report, rows) {
  const saved = text(report?.dataSignature, 80).toLowerCase();
  if (/^[a-f0-9]{64}$/.test(saved)) return saved;
  return crypto.createHash("sha256").update(JSON.stringify(rows || [])).digest("hex");
}

function operationsLedgerSourceSignature(reports) {
  const source = reports.map((report) => [
    report.id,
    report.type,
    report.storeName,
    report.periodKind,
    report.periodStart,
    report.periodEnd,
    report.importedAt,
    report.dataSignature,
  ]);
  return crypto.createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function ledgerEntityFor(report, row) {
  const type = report.type;
  const productId = text(row.productId, 80).replace(/\s+/g, "");
  const productName = text(row.productName, 120);
  const category = text(row.secondaryCategory || row.category || row.primaryCategory, 80);
  const audienceName = text(row.audienceName, 120);
  if (["product", "campaign", "promotion"].includes(type) && (productId || productName)) {
    return { entityType: "product", entityKey: productId ? `id:${productId}` : `name:${joinKey(productName)}` };
  }
  if (["category", "scenario"].includes(type) && category) {
    return { entityType: "category", entityKey: `category:${joinKey(category)}` };
  }
  if (["audience", "competitor"].includes(type) && audienceName) {
    return { entityType: "audience", entityKey: `audience:${joinKey(audienceName)}` };
  }
  const fallback = productName || category || audienceName || row.campaignName || "未归类";
  return { entityType: "generic", entityKey: `generic:${joinKey(fallback) || "unknown"}` };
}

function ledgerStoreName(report, row) {
  // The selected report store is the operator's explicit assignment. It must
  // win over a stale store name embedded in a downloaded export.
  return text(report.storeName || row.storeName || reportSnapshotStore(report), 80);
}

function newLedgerLine(report, row, entity, storeName) {
  return {
    sourceReportId: report.id,
    type: report.type,
    entityType: entity.entityType,
    entityKey: entity.entityKey,
    storeName,
    periodKind: report.periodKind,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    reportDate: report.reportDate,
    productId: text(row.productId, 80).replace(/\s+/g, ""),
    productName: text(row.productName, 120),
    productStage: row.productStage,
    campaignName: text(row.campaignName, 120),
    // Promotion rows retain the channel dimension so a product's full
    // channel breakdown remains available after ledger aggregation.
    channel: text(row.channel, 120),
    category: text(row.category, 80),
    primaryCategory: text(row.primaryCategory, 80),
    secondaryCategory: text(row.secondaryCategory, 80),
    audienceName: text(row.audienceName, 120),
    spend: 0,
    grossRevenue: 0,
    revenue: 0,
    refundAmount: 0,
    refundDataAvailable: false,
    orders: 0,
    clicks: 0,
    impressions: 0,
    visitors: 0,
    pageViews: 0,
    favorites: 0,
    cartUsers: 0,
    cartItems: 0,
    paidBuyers: 0,
    paidItems: 0,
    audienceSize: 0,
    averageDwellSeconds: 0,
    rowCount: 0,
    _revenueRows: 0,
    _refundDataRows: 0,
  };
}

function addLedgerRow(line, row) {
  const sumFields = [
    "spend", "grossRevenue", "revenue", "refundAmount", "orders", "clicks",
    "impressions", "visitors", "pageViews", "favorites", "cartUsers", "cartItems",
    "paidBuyers", "paidItems", "audienceSize", "averageDwellSeconds",
  ];
  for (const field of sumFields) {
    if (Number.isFinite(row[field])) line[field] += row[field];
  }
  if (Number.isFinite(row.revenue)) {
    line._revenueRows += 1;
    if (row.refundDataAvailable) line._refundDataRows += 1;
  }
  line.rowCount += 1;
}

function finalizeLedgerLine(line) {
  const { _revenueRows, _refundDataRows, ...stored } = line;
  return {
    ...stored,
    refundDataAvailable: _revenueRows > 0 && _refundDataRows === _revenueRows,
    roi: stored.spend > 0 ? stored.revenue / stored.spend : null,
  };
}

export function buildOperationsLedger(reports = []) {
  const grouped = new Map();
  for (const report of reports) {
    if (!report?.id || report.kind === "screenshot") continue;
    for (const rawRow of report.rows || []) {
      const row = normalizeStoredRow(rawRow);
      if (totalRow(row) || (report.type === "category" && !categoryDetailRow(row))) continue;
      const entity = ledgerEntityFor(report, row);
      const storeName = ledgerStoreName(report, row);
      const channel = ["campaign", "promotion"].includes(report.type) ? text(row.channel, 120) : "";
      const campaignName = ["campaign", "promotion"].includes(report.type) ? text(row.campaignName, 120) : "";
      const key = [
        report.id,
        report.type,
        storeName,
        report.periodKind,
        report.periodStart,
        report.periodEnd,
        entity.entityType,
        entity.entityKey,
        channel,
        campaignName,
      ].join("\u0000");
      if (!grouped.has(key)) grouped.set(key, newLedgerLine(report, row, entity, storeName));
      addLedgerRow(grouped.get(key), row);
    }
  }
  return [...grouped.values()].map(finalizeLedgerLine);
}

function normalizeOperationsLedger(ledger, reports) {
  const reportsById = new Map(reports.map((report) => [report.id, report]));
  const normalized = [];
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    const report = reportsById.get(text(entry?.sourceReportId, 80));
    if (!report) continue;
    const row = normalizeStoredRow(entry);
    const entityType = ["product", "category", "audience", "generic"].includes(entry?.entityType)
      ? entry.entityType
      : ledgerEntityFor(report, row).entityType;
    const entityKey = text(entry?.entityKey, 240) || ledgerEntityFor(report, row).entityKey;
    const rowCount = Math.max(1, Math.min(MAX_ROWS_PER_REPORT, Math.floor(numeric(entry?.rowCount) || 1)));
    const draft = newLedgerLine(report, row, { entityType, entityKey }, ledgerStoreName(report, row));
    const { _revenueRows, _refundDataRows, ...base } = draft;
    normalized.push({
      ...base,
      ...row,
      sourceReportId: report.id,
      type: report.type,
      entityType,
      entityKey,
      storeName: ledgerStoreName(report, row),
      periodKind: report.periodKind,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      reportDate: report.reportDate,
      rowCount,
      refundDataAvailable: Boolean(entry?.refundDataAvailable),
      roi: Number.isFinite(row.spend) && row.spend > 0 && Number.isFinite(row.revenue) ? row.revenue / row.spend : null,
    });
  }
  return normalized;
}

function ledgerBackedReports(reports, ledger) {
  const rowsByReport = new Map();
  for (const row of ledger) {
    if (!rowsByReport.has(row.sourceReportId)) rowsByReport.set(row.sourceReportId, []);
    rowsByReport.get(row.sourceReportId).push(row);
  }
  return reports.map((report) => ({
    ...report,
    sourceRowCount: report.rows.length,
    rows: rowsByReport.get(report.id) || [],
  }));
}

function reportSnapshotDate(report) {
  const candidate = String(report?.reportDate || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : dateOnly(report?.importedAt);
}

function reportSnapshotStore(report) {
  const explicit = text(report?.storeName, 80);
  if (explicit) return explicit;
  const inferred = uniqueStrings((report?.rows || []).map((row) => row?.storeName), 2);
  return inferred.length === 1 ? inferred[0] : "未标记店铺";
}

function promotionRows(state, reportDate = "") {
  const rows = state.reports
    .filter((report) => report.type === "promotion" && (!reportDate || reportSnapshotDate(report) === reportDate))
    .flatMap((report) => report.rows.map((row) => ({ ...row, report })));
  const details = rows.filter((item) => !totalRow(item));
  return details.length ? details : rows;
}

function aggregate(rows) {
  const values = rows.reduce((result, row) => ({
    spend: result.spend + (Number.isFinite(row.spend) ? row.spend : 0),
    revenue: result.revenue + (Number.isFinite(row.revenue) ? row.revenue : 0),
    grossRevenue: result.grossRevenue + (Number.isFinite(row.grossRevenue) ? row.grossRevenue : Number.isFinite(row.revenue) ? row.revenue : 0),
    refundAmount: result.refundAmount + (Number.isFinite(row.refundAmount) ? row.refundAmount : 0),
    revenueRows: result.revenueRows + (Number.isFinite(row.revenue) ? 1 : 0),
    refundDataRows: result.refundDataRows + (row.refundDataAvailable ? 1 : 0),
    orders: result.orders + (Number.isFinite(row.orders) ? row.orders : 0),
    clicks: result.clicks + (Number.isFinite(row.clicks) ? row.clicks : 0),
    impressions: result.impressions + (Number.isFinite(row.impressions) ? row.impressions : 0),
    visitors: result.visitors + (Number.isFinite(row.visitors) ? row.visitors : 0),
    pageViews: result.pageViews + (Number.isFinite(row.pageViews) ? row.pageViews : 0),
    favorites: result.favorites + (Number.isFinite(row.favorites) ? row.favorites : 0),
    cartUsers: result.cartUsers + (Number.isFinite(row.cartUsers) ? row.cartUsers : 0),
    cartItems: result.cartItems + (Number.isFinite(row.cartItems) ? row.cartItems : 0),
    paidBuyers: result.paidBuyers + (Number.isFinite(row.paidBuyers) ? row.paidBuyers : 0),
    paidItems: result.paidItems + (Number.isFinite(row.paidItems) ? row.paidItems : 0),
  }), {
    spend: 0, revenue: 0, grossRevenue: 0, refundAmount: 0, revenueRows: 0, refundDataRows: 0,
    orders: 0, clicks: 0, impressions: 0,
    visitors: 0, pageViews: 0, favorites: 0, cartUsers: 0, cartItems: 0, paidBuyers: 0, paidItems: 0,
  });
  const { revenueRows: _revenueRows, refundDataRows: _refundDataRows, ...totals } = values;
  return {
    ...totals,
    netGsv: values.revenue,
    refundDataAvailable: values.revenueRows > 0 && values.refundDataRows === values.revenueRows,
    feeRate: values.refundDataAvailable && values.revenue > 0 ? values.spend / values.revenue : null,
    roi: values.spend > 0 ? values.revenue / values.spend : null,
    conversionRate: values.clicks > 0
      ? values.orders / values.clicks
      : values.visitors > 0 ? values.paidBuyers / values.visitors : null,
    collectionCartRate: values.visitors > 0 ? values.cartUsers / values.visitors : null,
    cpc: values.clicks > 0 ? values.spend / values.clicks : null,
    costPerCollectCart: values.cartUsers > 0 ? values.spend / values.cartUsers : null,
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
      const rawTarget = { ...DEFAULT_TARGETS, ...(state.targets[product.key] || state.targets[product.name] || {}) };
      const target = {
        targetRoi: finiteNumber(rawTarget.targetRoi, DEFAULT_TARGETS.targetRoi),
        maxFeeRate: finiteNumber(rawTarget.maxFeeRate, DEFAULT_TARGETS.maxFeeRate),
        dailyBudgetCap: finiteNumber(rawTarget.dailyBudgetCap, DEFAULT_TARGETS.dailyBudgetCap),
      };
      const spend = finiteNumber(product.spend, 0);
      const roi = finiteNumber(product.roi);
      const feeRate = finiteNumber(product.feeRate);
      let action = "保持";
      let change = 0;
      let reason = "ROI 与费率处于设定范围内，继续观察。";
      if (target.dailyBudgetCap > 0 && spend > target.dailyBudgetCap) {
        action = "降预算";
        change = -20;
        reason = `当日消耗 ${fixedNumber(spend)} 已超过预算上限 ${fixedNumber(target.dailyBudgetCap)}。`;
      } else if (product.orders === 0 && spend >= 50) {
        action = "暂停观察";
        change = -100;
        reason = `已消耗 ${fixedNumber(spend)}，仍未产生订单。`;
      } else if (roi !== null && roi < target.targetRoi) {
        action = "降预算";
        change = -20;
        reason = `ROI ${fixedNumber(roi)} 低于保本目标 ${fixedNumber(target.targetRoi)}。`;
      } else if (feeRate !== null && feeRate > target.maxFeeRate) {
        action = "降预算";
        change = -15;
        reason = `费率 ${percentNumber(feeRate)} 高于上限 ${percentNumber(target.maxFeeRate)}。`;
      } else if (roi !== null && feeRate !== null
        && roi >= target.targetRoi * 1.2 && feeRate <= target.maxFeeRate * 0.8) {
        action = "加预算";
        change = 15;
        reason = `ROI ${fixedNumber(roi)} 高于目标且费率 ${percentNumber(feeRate)} 有余量。`;
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

function relativeChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function buildOperationsArchive(reports) {
  const groups = new Map();
  for (const report of reports) {
    const date = reportSnapshotDate(report);
    const storeName = reportSnapshotStore(report);
    const key = [date, report.type, storeName].join("|");
    if (!groups.has(key)) groups.set(key, { key, date, type: report.type, storeName, reports: [], rows: [], rowCount: 0 });
    const group = groups.get(key);
    group.reports.push(report);
    group.rows.push(...report.rows);
    group.rowCount += Number(report.sourceRowCount) || report.rows.length;
  }

  const snapshots = [...groups.values()].map((group) => ({
    key: group.key,
    date: group.date,
    type: group.type,
    storeName: group.storeName,
    reportCount: group.reports.length,
    rowCount: group.rowCount,
    sources: uniqueStrings(group.reports.map((report) => report.sourceName || report.fileName), 8),
    metrics: aggregate(group.rows),
    comparison: { previousDate: null, spendChange: null, revenueChange: null, roiChange: null, feeRateChange: null },
  }));

  const tracks = new Map();
  for (const snapshot of snapshots) {
    const key = [snapshot.type, snapshot.storeName].join("|");
    if (!tracks.has(key)) tracks.set(key, []);
    tracks.get(key).push(snapshot);
  }
  for (const items of tracks.values()) {
    items.sort((left, right) => left.date.localeCompare(right.date));
    for (let index = 1; index < items.length; index += 1) {
      const current = items[index];
      const previous = items[index - 1];
      current.comparison = {
        previousDate: previous.date,
        spendChange: relativeChange(current.metrics.spend, previous.metrics.spend),
        revenueChange: relativeChange(current.metrics.revenue, previous.metrics.revenue),
        roiChange: Number.isFinite(current.metrics.roi) && Number.isFinite(previous.metrics.roi) ? current.metrics.roi - previous.metrics.roi : null,
        feeRateChange: Number.isFinite(current.metrics.feeRate) && Number.isFinite(previous.metrics.feeRate) ? current.metrics.feeRate - previous.metrics.feeRate : null,
      };
    }
  }

  const dayGroups = new Map();
  for (const snapshot of snapshots) {
    if (!dayGroups.has(snapshot.date)) dayGroups.set(snapshot.date, { date: snapshot.date, snapshots: [] });
    dayGroups.get(snapshot.date).snapshots.push(snapshot);
  }
  const days = [...dayGroups.values()]
    .map((day) => ({
      date: day.date,
      reportCount: day.snapshots.reduce((sum, snapshot) => sum + snapshot.reportCount, 0),
      rowCount: day.snapshots.reduce((sum, snapshot) => sum + snapshot.rowCount, 0),
      types: uniqueStrings(day.snapshots.map((snapshot) => snapshot.type), 8),
      stores: uniqueStrings(day.snapshots.map((snapshot) => snapshot.storeName).filter((name) => name !== "未标记店铺"), 12),
      snapshots: day.snapshots.sort((left, right) => left.type.localeCompare(right.type) || left.storeName.localeCompare(right.storeName)),
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
  return {
    days,
    totalReports: reports.length,
    totalRows: reports.reduce((sum, report) => sum + (Number(report.sourceRowCount) || report.rows.length), 0),
  };
}

function datasetGroupKey(type, row) {
  if (type === "category" || type === "scenario") return row.category || row.campaignName || row.productName;
  if (type === "promotion") return row.campaignName || row.productName || row.category;
  if (type === "audience" || type === "competitor") return row.audienceName || row.productName || row.campaignName;
  return row.productName || row.campaignName || row.productId || row.category;
}

// 生意参谋的标准类目导出会在同一张表中附带一级类目的汇总行。
// 例如“厨房电器 / 厨房电器 / 厨房电器”并不是一个可经营的二级
// 类目，而是其下全部明细的合计。它若参与聚合，会让类目 GMV、
// 退款、费率和 Top 图全部重复计算。因此这类行在任何类目入口都
// 必须直接排除，不能在没有明细时再作为兜底数据展示。
function categoryParentSummaryRow(row) {
  const primary = joinKey(row?.primaryCategory);
  const secondary = joinKey(row?.secondaryCategory);
  return Boolean(primary && secondary && primary === secondary);
}

function categoryDetailRow(row) {
  return !categoryParentSummaryRow(row);
}

function buildDatasetViews(state) {
  return OPERATIONS_REPORT_TYPES.map((type) => {
    const typeReports = state.reports.filter((report) => report.type === type && report.kind !== "screenshot");
    const reportDate = typeReports.map(reportSnapshotDate).sort().at(-1) || "";
    const reports = typeReports.filter((report) => reportSnapshotDate(report) === reportDate);
    const rows = reports.flatMap((report) => report.rows.map((row) => ({ ...row, report }))).filter((row) => !totalRow(row));
    // Parent summary rows must never flow into a dataset: other surfaces (the
    // warehouse, overview cards and generic category table) also consume this
    // result, not only the category dashboard.
    const effectiveRows = type === "category"
      ? rows.filter(categoryDetailRow)
      : rows.length ? rows : reports.flatMap((report) => report.rows.map((row) => ({ ...row, report })));
    const groups = groupedRows(effectiveRows, "_dataset", (row) => datasetGroupKey(type, row))
      .sort((left, right) => (right.revenue - left.revenue) || (right.spend - left.spend) || (right.visitors - left.visitors))
      .slice(0, 50);
    return {
      type,
      date: reportDate,
      period: reports[0]?.periodLabel || reportDate,
      reportCount: reports.length,
      rowCount: effectiveRows.length,
      metrics: aggregate(effectiveRows),
      groups,
      columns: uniqueStrings(reports.flatMap((report) => report.columns), 200),
    };
  }).filter((dataset) => dataset.reportCount > 0);
}

function firstDataset(datasets, types) {
  return types.map((type) => datasets.find((dataset) => dataset.type === type)).find(Boolean) || null;
}

function datasetSource(dataset) {
  return dataset ? { type: dataset.type, period: dataset.period, rowCount: dataset.rowCount } : null;
}

function joinKey(value) {
  return text(value, 240).toLowerCase().replace(/[\s\-_/\\()[\]{}（）【】,.，。:：;；'"`~!！@#￥$%^&*+=|<>?？]/g, "");
}

function joinedRow(report, row) {
  return {
    ...row,
    report,
    storeName: row.storeName || reportSnapshotStore(report),
  };
}

function latestReportsForTypes(reports, types) {
  const result = [];
  for (const type of types) {
    const items = reports.filter((report) => report.type === type && report.kind !== "screenshot");
    const date = items.map(reportSnapshotDate).sort().at(-1);
    if (date) result.push(...items.filter((report) => reportSnapshotDate(report) === date));
  }
  return result;
}

function reportsForDashboardScope(reports, types, filters = {}) {
  const items = reports.filter((report) => types.includes(report.type) && report.kind !== "screenshot");
  // Without an explicit date range, preserve the landing view's existing
  // latest-snapshot behavior. A date preset, however, represents a requested
  // calculation range and must aggregate each included reporting period.
  if (!String(filters.start || "") || !String(filters.end || "")) {
    return latestReportsForTypes(items, types);
  }
  const latestByScope = new Map();
  for (const report of items) {
    const key = [report.type, joinKey(reportSnapshotStore(report)), reportPeriodKey(report)].join("\u0000");
    const current = latestByScope.get(key);
    if (!current || String(report.importedAt || "") >= String(current.importedAt || "")) {
      latestByScope.set(key, report);
    }
  }
  return [...latestByScope.values()].sort((left, right) => (
    reportPeriodKey(left).localeCompare(reportPeriodKey(right))
    || String(left.type).localeCompare(String(right.type))
    || reportSnapshotStore(left).localeCompare(reportSnapshotStore(right), "zh-CN")
  ));
}

function reportPeriodKey(report) {
  const date = reportSnapshotDate(report);
  const start = String(report?.periodStart || date);
  const end = String(report?.periodEnd || date);
  return `${start}:${end}`;
}

function sourcePeriodCoverage(referenceReports, availableReports) {
  const referencePeriods = [...new Set(referenceReports.map(reportPeriodKey))].sort();
  const availablePeriods = [...new Set(availableReports.map(reportPeriodKey))].sort();
  const complete = referencePeriods.length > 0
    && referencePeriods.length === availablePeriods.length
    && referencePeriods.every((value, index) => value === availablePeriods[index]);
  return {
    complete,
    referencePeriods,
    availablePeriods,
    missingPeriods: referencePeriods.filter((value) => !availablePeriods.includes(value)),
    extraPeriods: availablePeriods.filter((value) => !referencePeriods.includes(value)),
  };
}

function sourcePeriodWarning(referenceReports, availableReports, label) {
  const coverage = sourcePeriodCoverage(referenceReports, availableReports);
  const { referencePeriods, availablePeriods } = coverage;
  if (!referencePeriods.length || coverage.complete) return null;
  const labels = (reports, periods) => periods
    .map((period) => reports.find((report) => reportPeriodKey(report) === period))
    .filter(Boolean)
    .map((report) => report.periodLabel || reportSnapshotDate(report));
  const details = [
    coverage.missingPeriods.length ? `经营有 ${labels(referenceReports, coverage.missingPeriods).join("、")}` : "",
    coverage.extraPeriods.length ? `${label}有 ${labels(availableReports, coverage.extraPeriods).join("、")}` : "",
  ].filter(Boolean).join("；");
  if (!availablePeriods.length) return `${details}，尚未导入对应的${label}报表；推广花费、ROI 和费率不会凭空补算。`;
  return `${details}。净 GSV 与已导入花费会分别展示；ROI 和费率不计算，避免跨周期误导。`;
}

function detailRows(reports) {
  return reports.flatMap((report) => report.rows.map((row) => joinedRow(report, row))).filter((row) => !totalRow(row));
}

function categoryDetailRows(reports) {
  return reports.flatMap((report) => {
    return report.rows
      .map((row) => joinedRow(report, row))
      .filter((row) => !totalRow(row) && categoryDetailRow(row));
  });
}

function categoryName(row) {
  return text(row.secondaryCategory || row.category || row.primaryCategory, 120);
}

function entityMetric(rows) {
  return aggregate(rows || []);
}

function newEntity(name, key, { productId = "", storeName = "", model = "", category = "", matchStatus = "unmatched" } = {}) {
  return {
    key,
    name: name || "未命名对象",
    productId,
    storeName,
    model,
    category,
    matchStatus,
    sales: entityMetric([]),
    promotion: entityMetric([]),
    salesCount: 0,
    promotionCount: 0,
  };
}

function hydrateEntity(entity, salesRows, promotionRows, matchStatus, periodCoverage = sourcePeriodCoverage(
  salesRows.map((row) => row.report).filter(Boolean),
  promotionRows.map((row) => row.report).filter(Boolean),
)) {
  const sales = entityMetric(salesRows);
  const promotion = entityMetric(promotionRows);
  const revenue = sales.revenue;
  const spend = promotion.spend;
  const rateAvailable = periodCoverage.complete
    && sales.refundDataAvailable
    && salesRows.length > 0
    && promotionRows.length > 0
    && revenue > 0;
  return {
    ...entity,
    matchStatus,
    sales,
    promotion,
    salesCount: salesRows.length,
    promotionCount: promotionRows.length,
    revenue,
    grossRevenue: sales.grossRevenue,
    refundAmount: sales.refundAmount,
    refundDataAvailable: sales.refundDataAvailable,
    spend,
    promotionRevenue: promotion.revenue,
    promotionChannels: buildPromotionChannels(promotionRows),
    promotionCoverageComplete: periodCoverage.complete,
    roi: promotion.roi,
    feeRate: rateAvailable ? spend / revenue : null,
    visitors: sales.visitors,
    paidBuyers: sales.paidBuyers,
    conversionRate: sales.conversionRate,
    clicks: promotion.clicks,
    impressions: promotion.impressions,
    orders: promotion.orders,
    salesDeduction: 0,
    managementRoi: rateAvailable && spend > 0 ? sales.revenue / spend : null,
  };
}

function promotionPlanName(row) {
  return text(row?.campaignName, 120) || text(row?.channel, 120) || "未命名计划";
}

function promotionChannelName(row) {
  const channel = text(row?.channel, 120);
  const planName = text(row?.campaignName, 120);
  // A source may legitimately omit the plan column. Its promotion type must
  // remain visible rather than being mistaken for a damaged legacy row.
  if (channel && (!planName || channel !== planName || looksLikePromotionType(channel))) return channel;
  return "未识别推广类型";
}

function buildPromotionPlans(rows) {
  const grouped = groupByJoinValue(rows, promotionPlanName);
  return [...grouped.values()]
    .map((group) => {
      const metrics = aggregate(group.rows);
      return {
        name: group.value,
        rowCount: group.rows.length,
        spend: metrics.spend,
        promotionRevenue: metrics.revenue,
        roi: metrics.roi,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        orders: metrics.orders,
      };
    })
    .sort((left, right) => right.spend - left.spend || right.promotionRevenue - left.promotionRevenue || left.name.localeCompare(right.name, "zh-CN"));
}

function buildPromotionChannels(rows) {
  const grouped = groupByJoinValue(rows, promotionChannelName);
  return [...grouped.values()]
    .map((group) => {
      const metrics = aggregate(group.rows);
      return {
        name: group.value,
        rowCount: group.rows.length,
        planCount: new Set(group.rows.map(promotionPlanName)).size,
        spend: metrics.spend,
        promotionRevenue: metrics.revenue,
        roi: metrics.roi,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        orders: metrics.orders,
        plans: buildPromotionPlans(group.rows),
      };
    })
    .sort((left, right) => right.spend - left.spend || right.promotionRevenue - left.promotionRevenue || left.name.localeCompare(right.name, "zh-CN"));
}

function deductionMatchesPeriod(deduction, storeName, periodStart, periodEnd) {
  return deduction.storeName === storeName
    && deduction.reportDate >= periodStart
    && deduction.reportDate <= periodEnd;
}

function deductionTotal(deductions, storeName, periodStart, periodEnd) {
  return deductions
    .filter((deduction) => deductionMatchesPeriod(deduction, storeName, periodStart, periodEnd))
    .reduce((total, deduction) => total + deduction.amount, 0);
}

function applyStoreSalesDeduction(entity, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return entity;
  const revenue = Math.max(0, entity.revenue - amount);
  const sales = { ...entity.sales, revenue, netGsv: revenue };
  const managementRoi = entity.promotionCoverageComplete && entity.spend > 0 ? revenue / entity.spend : null;
  const feeRate = entity.promotionCoverageComplete && entity.refundDataAvailable && entity.spend > 0 && revenue > 0
    ? entity.spend / revenue
    : entity.refundDataAvailable && entity.spend === 0 && revenue > 0
      ? 0
      : null;
  return { ...entity, sales, revenue, salesDeduction: amount, managementRoi, feeRate };
}

function groupByJoinValue(rows, valueFor) {
  const groups = new Map();
  for (const row of rows) {
    const value = text(valueFor(row), 240);
    const key = joinKey(value);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, value, rows: [] });
    groups.get(key).rows.push(row);
  }
  return groups;
}

function buildProductCatalogIndex(entries) {
  const exact = new Map();
  const entriesByProductId = new Map();
  for (const entry of entries || []) {
    exact.set(catalogEntryKey(entry.storeName, entry.productId), entry);
    const current = entriesByProductId.get(entry.productId) || [];
    current.push(entry);
    entriesByProductId.set(entry.productId, current);
  }
  return { exact, entriesByProductId };
}

function findProductCatalogEntry(index, productId, storeName) {
  if (!productId) return null;
  const exact = index.exact.get(catalogEntryKey(storeName, productId));
  if (exact) return exact;
  const storeAgnostic = index.exact.get(catalogEntryKey("", productId));
  if (storeAgnostic) return storeAgnostic;
  const entries = index.entriesByProductId.get(productId) || [];
  return entries.length === 1 ? entries[0] : null;
}

function applyProductCatalog(rows, productCatalog) {
  const catalogIndex = buildProductCatalogIndex(productCatalog);
  return rows.map((row) => {
    const mapping = findProductCatalogEntry(catalogIndex, row.productId, row.storeName);
    return {
      ...row,
      // A manually maintained mapping is the operator's explicit category
      // definition. The report category remains a fallback for unmapped IDs.
      category: mapping?.category || row.category,
      model: mapping?.model || row.model || "",
    };
  });
}

// Product joins use item ID first. A name match is intentionally only a
// fallback for exports without a shared ID; unmatched records stay visible.
function productJoinKey(row, value = row?.productId || row?.productName) {
  return `${joinKey(row?.storeName)}:${joinKey(value)}`;
}

function buildProductMatrix(salesRows, promotionRows, productCatalog = [], periodCoverage) {
  const salesById = groupByJoinValue(salesRows.filter((row) => row.productId), (row) => productJoinKey(row, row.productId));
  const salesByName = groupByJoinValue(salesRows.filter((row) => row.productName), (row) => productJoinKey(row, row.productName));
  const promotionsById = groupByJoinValue(promotionRows.filter((row) => row.productId), (row) => productJoinKey(row, row.productId));
  const promotionsByName = groupByJoinValue(promotionRows.filter((row) => row.productName), (row) => productJoinKey(row, row.productName));
  const consumedPromotionGroups = new Set();
  const entities = [];

  for (const salesGroup of salesById.values()) {
    const sample = salesGroup.rows[0] || {};
    const promotions = promotionsById.get(salesGroup.key)?.rows || [];
    if (promotions.length) consumedPromotionGroups.add(`id:${salesGroup.key}`);
    entities.push(hydrateEntity(
      newEntity(sample.productName || sample.productId, `product:${salesGroup.key}`, { productId: sample.productId, storeName: sample.storeName }),
      salesGroup.rows,
      promotions,
      promotions.length ? "id" : "sales-only",
      periodCoverage,
    ));
  }

  for (const salesGroup of salesByName.values()) {
    const sample = salesGroup.rows[0] || {};
    // Rows carrying an ID were already represented above.
    if (sample.productId) continue;
    const promotionGroup = promotionsByName.get(salesGroup.key);
    const promotions = promotionGroup?.rows || [];
    if (promotions.length) consumedPromotionGroups.add(`name:${promotionGroup.key}`);
    entities.push(hydrateEntity(
      newEntity(sample.productName, `product-name:${salesGroup.key}`, { storeName: sample.storeName }),
      salesGroup.rows,
      promotions,
      promotions.length ? "name" : "sales-only",
      periodCoverage,
    ));
  }

  for (const promotionGroup of promotionsById.values()) {
    if (consumedPromotionGroups.has(`id:${promotionGroup.key}`)) continue;
    const sample = promotionGroup.rows[0] || {};
    entities.push(hydrateEntity(
      newEntity(sample.productName || sample.productId, `promotion:${promotionGroup.key}`, { productId: sample.productId, storeName: sample.storeName }),
      [],
      promotionGroup.rows,
      "promotion-only",
      periodCoverage,
    ));
  }

  for (const promotionGroup of promotionsByName.values()) {
    if (consumedPromotionGroups.has(`name:${promotionGroup.key}`)) continue;
    const sample = promotionGroup.rows[0] || {};
    // groupByJoinValue normalizes its key once more, so the lookup must use
    // the same normalized key. Without this, every ID-backed promotion row
    // was emitted again as a name-backed entity and doubled item totals.
    if (sample.productId && promotionsById.has(joinKey(productJoinKey(sample, sample.productId)))) continue;
    const salesGroup = salesByName.get(promotionGroup.key);
    entities.push(hydrateEntity(
      newEntity(sample.productName, `promotion-name:${promotionGroup.key}`, { storeName: sample.storeName }),
      salesGroup?.rows || [],
      promotionGroup.rows,
      salesGroup?.rows?.length ? "name" : "promotion-only",
      periodCoverage,
    ));
  }

  const catalogIndex = buildProductCatalogIndex(productCatalog);
  const sourceByProductId = new Map();
  for (const row of [...salesRows, ...promotionRows]) {
    if (row.productId && !sourceByProductId.has(productJoinKey(row, row.productId))) {
      sourceByProductId.set(productJoinKey(row, row.productId), row);
    }
  }
  return entities
    .map((entity) => {
      const source = sourceByProductId.get(productJoinKey(entity, entity.productId)) || {};
      const mapping = findProductCatalogEntry(catalogIndex, entity.productId, entity.storeName || source.storeName);
      return {
        ...entity,
        model: mapping?.model || "",
        category: mapping?.category || text(source.category, 80),
      };
    })
    .sort((left, right) => (right.spend - left.spend) || (right.revenue - left.revenue) || left.name.localeCompare(right.name));
}

const CATEGORY_PART_ALIASES = new Map([
  ["电热火锅", "电火锅"],
  ["绞肉", "绞肉机"],
]);

function categoryPartKeys(value) {
  return new Set(text(value, 240)
    .split(/[/／、,，]+/)
    .map((part) => joinKey(part))
    .filter(Boolean)
    .map((part) => CATEGORY_PART_ALIASES.get(part) || part));
}

function categoryGroupsMatch(left, right) {
  const leftParts = categoryPartKeys(left);
  const rightParts = categoryPartKeys(right);
  return [...leftParts].some((part) => rightParts.has(part));
}

function alignPromotionCategories(salesByCategory, promotionByCategory) {
  const aligned = new Map();
  for (const promotionGroup of promotionByCategory.values()) {
    let target = salesByCategory.get(promotionGroup.key);
    if (!target) {
      const candidates = [...salesByCategory.values()]
        .filter((salesGroup) => categoryGroupsMatch(promotionGroup.value, salesGroup.value));
      // A promotion row must belong to exactly one category. Ambiguous names
      // stay separate so a single spend can never be counted twice.
      if (candidates.length === 1) target = candidates[0];
    }
    const key = target?.key || promotionGroup.key;
    const current = aligned.get(key) || {
      key,
      value: target?.value || promotionGroup.value,
      rows: [],
    };
    current.rows.push(...promotionGroup.rows);
    aligned.set(key, current);
  }
  return aligned;
}

function buildCategoryMatrix(salesRows, promotionRows, periodCoverage) {
  const salesByCategory = groupByJoinValue(salesRows, categoryName);
  const promotionByCategory = alignPromotionCategories(
    salesByCategory,
    groupByJoinValue(promotionRows, categoryName),
  );
  const keys = new Set([...salesByCategory.keys(), ...promotionByCategory.keys()]);
  return [...keys].map((key) => {
    const salesGroup = salesByCategory.get(key);
    const promotionGroup = promotionByCategory.get(key);
    const sample = salesGroup?.rows[0] || promotionGroup?.rows[0] || {};
    const sales = salesGroup?.rows || [];
    const promotion = promotionGroup?.rows || [];
    return hydrateEntity(
      newEntity(categoryName(sample), `category:${key}`),
      sales,
      promotion,
      sales.length && promotion.length ? "name" : sales.length ? "sales-only" : "promotion-only",
      periodCoverage,
    );
  }).sort((left, right) => (right.revenue - left.revenue) || (right.spend - left.spend) || left.name.localeCompare(right.name));
}

function buildStoreMatrix(productRows, campaignRows, fallbackStoreName = "") {
  const salesByStore = groupByJoinValue(productRows, (row) => row.storeName || fallbackStoreName || "未标记店铺");
  const promotionByStore = groupByJoinValue(campaignRows, (row) => row.storeName || fallbackStoreName || "未标记店铺");
  const keys = new Set([...salesByStore.keys(), ...promotionByStore.keys()]);
  return [...keys].map((key) => {
    const salesGroup = salesByStore.get(key);
    const promotionGroup = promotionByStore.get(key);
    const sample = salesGroup?.rows[0] || promotionGroup?.rows[0] || {};
    const sales = salesGroup?.rows || [];
    const promotion = promotionGroup?.rows || [];
    return hydrateEntity(
      newEntity(sample.storeName || fallbackStoreName || "未标记店铺", `store:${key}`),
      sales,
      promotion,
      sales.length && promotion.length ? "name" : sales.length ? "sales-only" : "promotion-only",
    );
  }).sort((left, right) => (right.revenue - left.revenue) || (right.spend - left.spend));
}

function buildStoreTrend(reports, salesDeductions) {
  const grouped = new Map();
  for (const report of reports.filter((item) => ["product", "category", "campaign"].includes(item.type) && item.kind !== "screenshot")) {
    const date = reportSnapshotDate(report);
    if (!grouped.has(date)) grouped.set(date, {
      date,
      product: [],
      category: [],
      campaign: [],
      productReports: [],
      categoryReports: [],
      campaignReports: [],
    });
    grouped.get(date)[report.type].push(...report.rows.filter((row) => !totalRow(row)));
    grouped.get(date)[`${report.type}Reports`].push(report);
  }
  return [...grouped.values()].map((item) => {
    const salesReports = item.productReports.length ? item.productReports : item.categoryReports;
    const sales = entityMetric(item.product.length ? item.product : item.category.filter(categoryDetailRow));
    const promotion = entityMetric(item.campaign);
    const coverage = sourcePeriodCoverage(salesReports, item.campaignReports);
    const storeRows = item.product.length ? item.product : item.category.filter(categoryDetailRow);
    const storeNames = new Set(storeRows.map((row) => row.storeName).filter(Boolean));
    const salesDeduction = salesDeductions
      .filter((deduction) => deduction.reportDate === item.date && storeNames.has(deduction.storeName))
      .reduce((total, deduction) => total + deduction.amount, 0);
    const revenue = Math.max(0, sales.revenue - salesDeduction);
    return {
      date: item.date,
      revenue,
      grossRevenue: sales.grossRevenue,
      refundAmount: sales.refundAmount,
      salesDeduction,
      spend: promotion.spend,
      promotionRevenue: promotion.revenue,
      promotionCoverageComplete: coverage.complete,
      roi: coverage.complete && promotion.spend > 0 ? revenue / promotion.spend : null,
      feeRate: coverage.complete && sales.refundDataAvailable && revenue > 0 ? promotion.spend / revenue : null,
    };
  }).sort((left, right) => left.date.localeCompare(right.date));
}

function buildOperationsDashboard(state) {
  const scopedReports = reportsForDashboardScope(
    state.reports,
    ["product", "category", "campaign"],
    state.filters,
  );
  const scopedProductReports = scopedReports.filter((report) => report.type === "product");
  const scopedCategoryReports = scopedReports.filter((report) => report.type === "category");
  const scopedCampaignReports = scopedReports.filter((report) => report.type === "campaign");
  // The selected range is the calculation boundary. Every report inside it
  // contributes to its own source metric; a missing promotion export must
  // never make that day's confirmed sales disappear from GSV, charts, or
  // product/category rankings.
  const productReports = scopedProductReports;
  const campaignReports = scopedCampaignReports;
  const categoryReports = scopedCategoryReports;
  const categoryCampaignReports = scopedCampaignReports;
  const productRows = detailRows(productReports);
  const campaignRows = detailRows(campaignReports);
  const categoryRows = categoryDetailRows(categoryReports);
  // Product ranking is the preferred store-sales source. A category report is
  // still an audited sales ledger, so use it only when the selected period
  // has no product report at all (for example a historical monthly import).
  const storeSalesReports = productReports.length ? productReports : categoryReports;
  const storeSalesRows = productReports.length ? productRows : categoryRows;
  const storePromotionCoverage = sourcePeriodCoverage(storeSalesReports, campaignReports);
  const categoryPromotionCoverage = sourcePeriodCoverage(categoryReports, categoryCampaignReports);
  const mappedCampaignRows = applyProductCatalog(detailRows(categoryCampaignReports), state.productCatalog);
  const storeName = reportSnapshotStore(storeSalesReports[0] || campaignReports[0] || {});
  const sourcePeriodStart = String(state.filters?.start || storeSalesReports.map((report) => report.periodStart).sort()[0] || "");
  const sourcePeriodEnd = String(state.filters?.end || storeSalesReports.map((report) => report.periodEnd).sort().at(-1) || "");
  const stores = buildStoreMatrix(storeSalesRows, campaignRows, storeName).map((store) => applyStoreSalesDeduction(
    store,
    deductionTotal(state.salesDeductions, store.name, sourcePeriodStart, sourcePeriodEnd),
  ));
  const products = buildProductMatrix(productRows, campaignRows, state.productCatalog, storePromotionCoverage);
  // Category spend now comes exclusively from item-level promotion exports
  // grouped by the current ID catalog. This makes the category sum reconcile
  // exactly to the store's item-level promotion spend.
  const categories = buildCategoryMatrix(categoryRows, mappedCampaignRows, categoryPromotionCoverage);
  const linkedProducts = products.filter((item) => item.matchStatus === "id" || item.matchStatus === "name");
  const linkedCategories = categories.filter((item) => item.matchStatus === "name");
  return {
    store: stores[0] || hydrateEntity(newEntity(storeName || "本店", "store:empty"), [], [], "unmatched"),
    stores,
    products,
    categories,
    coverage: {
      products: { linked: linkedProducts.length, salesOnly: products.filter((item) => item.matchStatus === "sales-only").length, promotionOnly: products.filter((item) => item.matchStatus === "promotion-only").length },
      categories: { linked: linkedCategories.length, salesOnly: categories.filter((item) => item.matchStatus === "sales-only").length, promotionOnly: categories.filter((item) => item.matchStatus === "promotion-only").length },
    },
    trend: buildStoreTrend(scopedReports, state.salesDeductions),
    salesDeductions: state.salesDeductions.filter((deduction) => (
      deduction.reportDate >= sourcePeriodStart
      && deduction.reportDate <= sourcePeriodEnd
      && stores.some((store) => store.name === deduction.storeName)
    )),
    totalSalesDeduction: stores.reduce((total, store) => total + store.salesDeduction, 0),
    sources: {
      storeSales: storeSalesReports[0] ? datasetSource({ type: storeSalesReports[0].type, period: storeSalesReports[0].periodLabel, rowCount: storeSalesRows.length }) : null,
      storePromotion: campaignReports[0] ? datasetSource({ type: "campaign", period: campaignReports[0].periodLabel, rowCount: campaignRows.length }) : null,
      categorySales: categoryReports[0] ? datasetSource({ type: "category", period: categoryReports[0].periodLabel, rowCount: categoryRows.length }) : null,
      categoryPromotion: categoryCampaignReports[0] ? datasetSource({ type: "campaign", period: categoryCampaignReports[0].periodLabel, rowCount: mappedCampaignRows.length }) : null,
    },
    sourceWarnings: {
      storePromotion: sourcePeriodWarning(storeSalesReports, scopedCampaignReports, "单品付费"),
      categoryPromotion: sourcePeriodWarning(scopedCategoryReports, scopedCampaignReports, "单品付费"),
    },
    sourceCoverage: {
      storePromotionComplete: storePromotionCoverage.complete,
      categoryPromotionComplete: categoryPromotionCoverage.complete,
    },
  };
}

function reportMatchesWorkspaceFilters(report, filters = {}) {
  const sourcePeriodKind = String(filters.sourcePeriodKind || "");
  const legacyPeriodKind = String(filters.periodKind || "all");
  // `periodKind` historically doubled as the display range mode. Keep that
  // behaviour for existing callers, while `sourcePeriodKind` now explicitly
  // selects daily, weekly, monthly or custom source ledgers.
  const periodKind = sourcePeriodKind || legacyPeriodKind;
  if (periodKind !== "all" && periodKind !== "auto" && (sourcePeriodKind || periodKind !== "custom") && report.periodKind !== periodKind) return false;
  const storeName = text(filters.storeName, 80);
  if (storeName && storeName !== "all" && reportSnapshotStore(report) !== storeName) return false;
  const start = String(filters.start || "");
  const end = String(filters.end || "");
  if (start && report.periodEnd < start) return false;
  if (end && report.periodStart > end) return false;
  return true;
}

function dateRangePeriodKind(start, end) {
  if (!start || !end || start > end) return "custom";
  if (start === end) return "day";
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  const isCalendarWeek = ((startDate.getDay() + 6) % 7) === 0 && days === 7;
  if (isCalendarWeek) return "week";
  const lastOfMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  if (startDate.getDate() === 1 && startDate.getFullYear() === endDate.getFullYear()
    && startDate.getMonth() === endDate.getMonth() && endDate.getDate() === lastOfMonth) return "month";
  return "custom";
}

function reportsForAutomaticSource(reports, filters = {}) {
  const start = String(filters.start || "");
  const end = String(filters.end || "");
  if (!start || !end) return reports;
  const preferredKind = dateRangePeriodKind(start, end);
  const groups = new Map();
  for (const report of reports) {
    const key = [report.type, joinKey(reportSnapshotStore(report))].join("\u0000");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  const selected = [];
  for (const candidates of groups.values()) {
    const contained = candidates.filter((report) => report.periodStart >= start && report.periodEnd <= end);
    const preferred = contained.filter((report) => report.periodKind === preferredKind);
    // A complete month/week/custom export is authoritative for that group.
    // When it is absent, aggregate daily exports instead of mixing ledgers.
    if (preferred.length) {
      selected.push(...preferred);
      continue;
    }
    const daily = contained.filter((report) => report.periodKind === "day");
    if (daily.length) {
      selected.push(...daily);
      continue;
    }
    const exact = contained.filter((report) => report.periodStart === start && report.periodEnd === end);
    if (exact.length) selected.push(...exact);
  }
  return selected;
}

function buildOperationsWorkspaceLegacy(value = {}, { now = new Date(), filters = {} } = {}) {
  const normalized = normalizeOperationsState(value);
  const matchedReports = normalized.reports.filter((report) => reportMatchesWorkspaceFilters(report, filters));
  const selectedReports = String(filters.sourcePeriodKind || "") === "auto"
    ? reportsForAutomaticSource(matchedReports, filters)
    : matchedReports;
  const state = {
    ...normalized,
    filters,
    // All calculations below operate exclusively on locally aggregated
    // ledger rows. Raw report rows remain in `normalized.reports` for
    // warehouse preview, renaming and deletion.
    reports: ledgerBackedReports(selectedReports, normalized.ledger),
  };
  const currentDate = state.reports.map(reportSnapshotDate).sort().at(-1) || "";
  const dashboard = buildOperationsDashboard(state);
  const datasets = buildDatasetViews(state);
  // The dashboard has already guaranteed period alignment.  Reuse that exact
  // source pair for the Agent and summary logic instead of independently
  // picking each report type's latest date.
  const storeOverview = {
    revenue: dashboard.store.sales,
    performance: {
      ...dashboard.store.promotion,
      ...(dashboard.store.salesDeduction > 0 ? { feeRate: dashboard.store.feeRate } : {}),
    },
    // Platform ROI remains attributable-revenue / spend. This second metric
    // is the management ROI after the operator's approved sales exclusions.
    managementRoi: dashboard.store.managementRoi,
    salesDeduction: dashboard.store.salesDeduction,
    revenueSource: dashboard.sources.storeSales,
    performanceSource: dashboard.sourceWarnings.storePromotion ? null : dashboard.sources.storePromotion,
  };
  const preferredDataset = firstDataset(datasets, ["campaign", "promotion", "scenario", "product", "category"]);
  const rows = preferredDataset
    ? state.reports.filter((report) => report.type === preferredDataset.type && reportSnapshotDate(report) === preferredDataset.date)
      .flatMap((report) => report.rows.map((row) => ({ ...row, report })))
      .filter((row) => !totalRow(row) && (preferredDataset.type !== "category" || categoryDetailRow(row)))
    : promotionRows(state, currentDate);
  const total = aggregate(rows);
  const productGroups = groupedRows(rows, "productName", (row) => row.campaignName || row.productId).map((item) => {
    const members = rows.filter((row) => (row.productName || row.campaignName || row.productId || "未归类") === item.name);
    const representative = members[0] || {};
    return { ...item, key: representative.productId || item.name, productStage: representative.productStage || "unknown" };
  }).sort((left, right) => right.spend - left.spend);
  const freshness = hasFreshData(state.reports, now);
  // A period-wide budget action needs the same sales and promotion periods.
  // Partial promotion exports remain visible as imported spend, but never
  // drive a seemingly complete ROI or fee-rate recommendation.
  const joinedSuggestionProducts = dashboard.products.filter((item) => (
    (item.matchStatus === "id" || item.matchStatus === "name")
    && item.promotionCoverageComplete
  ));
  const suggestionProducts = joinedSuggestionProducts.length
    ? joinedSuggestionProducts
    : !dashboard.sources.storeSales || dashboard.sourceCoverage.storePromotionComplete
      ? productGroups.map((item) => ({ ...item, feeRate: null }))
      : [];
  const suggestions = freshness.fresh
    ? buildSuggestions(suggestionProducts, state, currentDate || now.toISOString().slice(0, 10))
    : [];
  const audienceReports = state.reports.filter((report) => ["audience", "competitor"].includes(report.type) && (!currentDate || reportSnapshotDate(report) === currentDate));
  const audienceRows = audienceReports.flatMap((report) => report.rows.map((row) => ({ ...row, report })));
  const audienceGroups = groupedRows(audienceRows, "audienceName", (row) => row.productName || row.campaignName)
    .sort((left, right) => (right.revenue - left.revenue) || (right.audienceSize || 0) - (left.audienceSize || 0)).slice(0, 12);
  const feedbackBySuggestion = Object.fromEntries(state.feedback.map((item) => [item.suggestionId, item]));
  return {
    reports: selectedReports.slice().sort((left, right) => Date.parse(right.importedAt) - Date.parse(left.importedAt)),
    storeNames: uniqueStrings([
      ...state.storeNames,
    ], 80),
    // Keep the full append-only catalog available to the warehouse UI. The
    // dashboard resolves only the latest record for each store + item ID.
    productCatalog: state.productCatalog.slice().reverse(),
    productCatalogSource: state.productCatalogSource,
    currentDate,
    datasets,
    dashboard,
    archive: buildOperationsArchive(state.reports),
    profile: { principles: state.principles, dailyReport: state.dailyReport, targets: state.targets },
    salesDeductions: dashboard.salesDeductions,
    freshness,
    totals: total,
    products: productGroups.slice(0, 50),
    storeOverview,
    stores: groupedRows(rows, "storeName", () => "未标记店铺").sort((left, right) => right.spend - left.spend),
    categories: groupedRows(rows, "category", () => "未标记类目").sort((left, right) => right.spend - left.spend).slice(0, 20),
    audiences: audienceGroups,
    suggestions: suggestions.map((item) => ({ ...item, feedback: feedbackBySuggestion[item.id] || null })),
    analyses: state.analyses.slice().reverse(),
    chat: state.chat,
    qwenPawAlerts: state.qwenPawAlerts,
    cloudSync: publicCloudSync(state.cloudSync),
    filters: {
      periodKind: ["all", ...OPERATIONS_PERIOD_KINDS].includes(String(filters.periodKind || "")) ? String(filters.periodKind || "all") : "all",
      sourcePeriodKind: ["auto", "all", ...OPERATIONS_PERIOD_KINDS].includes(String(filters.sourcePeriodKind || ""))
        ? String(filters.sourcePeriodKind || "all")
        : "all",
      start: String(filters.start || ""),
      end: String(filters.end || ""),
      storeName: text(filters.storeName, 80),
    },
  };
}

// This is the single ledger/dashboard implementation used by desktop, the
// cloud hub, and the browser-local operations workspace.
export function buildOperationsWorkspace(value = {}, options = {}) {
  return buildOperationsWorkspaceCore(value, options);
}

export function operationsAgentContextText(workspace) {
  // QwenPaw's web_fetch accepts webpage/text responses, but rejects JSON MIME
  // types. Keep this compact so an ordinary data question has one small local
  // tool read before the model answers.
  return JSON.stringify({
    source: "经营罗盘本机运营数据",
    freshness: workspace.freshness,
    storeOverview: workspace.storeOverview,
    totals: workspace.totals,
    products: workspace.products.slice(0, 15),
    categories: workspace.categories.slice(0, 12),
    audiences: workspace.audiences.slice(0, 12),
    suggestions: workspace.suggestions.slice(0, 15),
    archive: { currentDate: workspace.currentDate, days: workspace.archive?.days?.slice(0, 30) || [] },
    principles: text(workspace.profile?.principles, 2_000),
  });
}

function localOperationsAnalysis(workspace) {
  if (!workspace.freshness.fresh) {
    return { mode: "rule", summary: "运营数据已过期，未生成预算调整结论。请先导入最新报表。", insights: [], actions: [], createdAt: nowIso() };
  }
  const total = workspace.totals;
  const overview = workspace.storeOverview || { revenue: total, performance: total, revenueSource: null, performanceSource: null };
  const revenueSource = overview.revenueSource?.type || "当前报表";
  const performanceSource = overview.performanceSource?.type || "当前报表";
  const promotionCoverageIncomplete = Boolean(workspace.dashboard?.sources?.storeSales)
    && workspace.dashboard?.sourceCoverage?.storePromotionComplete === false;
  const coverageWarning = workspace.dashboard?.sourceWarnings?.storePromotion;
  if (promotionCoverageIncomplete) {
    return {
      mode: "rule",
      summary: "本地销售与单品付费报表统计周期未对齐，暂不生成整周期费率、ROI 或预算调整建议。",
      insights: [
        `整店净 GSV ${fixedNumber(overview.revenue.revenue)}（支付 ${fixedNumber(overview.revenue.grossRevenue)} - 退款 ${fixedNumber(overview.revenue.refundAmount)}；来源：${revenueSource}）。`,
        `已导入单品推广消耗 ${fixedNumber(overview.performance.spend)}；${coverageWarning || "缺少对应周期的单品付费报表"}。`,
      ],
      actions: [],
      createdAt: nowIso(),
    };
  }
  const managementRoi = overview.managementRoi ?? overview.performance.roi;
  const insights = [
    `整店净 GSV ${fixedNumber(overview.revenue.revenue)}（支付 ${fixedNumber(overview.revenue.grossRevenue)} - 退款 ${fixedNumber(overview.revenue.refundAmount)}；来源：${revenueSource}）；推广消耗 ${fixedNumber(overview.performance.spend)}，ROI ${fixedNumber(overview.performance.roi)}（来源：${performanceSource}）。`,
    `经营 ROI ${fixedNumber(managementRoi)}、推广费率 ${percentNumber(overview.performance.feeRate)}（净 GSV ÷ 推广花费；推广花费 ÷ 净 GSV），已覆盖 ${workspace.products.length} 个可优化单品。`,
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
    storeOverview: workspace.storeOverview,
    totals: workspace.totals,
    products: workspace.products.slice(0, 20),
    categories: workspace.categories.slice(0, 12),
    audiences: workspace.audiences.slice(0, 12),
    deterministicSuggestions: workspace.suggestions.slice(0, 12),
    archive: { currentDate: workspace.currentDate, days: workspace.archive?.days?.slice(0, 30) || [] },
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
          text: "你是严谨的电商运营助手。只能根据提供的数据与截图分析，不得补造数据或声称看到了未给出的后台信息。金额、费率与 ROI 已由本地公式计算，你只解释原因、风险和优先级。历史对比只能使用 archive 中同店铺、同报表类型、comparison.previousDate 存在的记录；口径不一致或没有前日记录必须明确说明无法比较。尊重运营人员的经营原则。输出 JSON：{summary:string,insights:string[],actions:string[]}。每条行动都应包含对象、建议动作和依据。",
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
    archive: { currentDate: workspace.currentDate, days: workspace.archive?.days?.slice(0, 30) || [] },
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
          text: "你是电商运营 Agent。只能基于提供的本地运营数据、截图和对话上下文回答。不要补造数据、不要访问任何平台、不要修改预算或发送消息。金额、ROI 和费率以本地计算结果为准。对比历史数据时，只能比较 archive 中同店铺、同报表类型且带有 comparison.previousDate 的记录；没有可比口径时明确说明。数据过期时，明确说明不能给出预算调整结论。用简洁中文回答，先给结论，再给可核对依据和下一步。",
        }],
      }, ...messages.map((item) => ({ role: item.role, content: [{ type: "input_text", text: item.content }] })), {
        role: "user",
        content: [{ type: "input_text", text: `当前本地数据：${JSON.stringify(context)}\n\n问题：${message}` }, ...images],
      }],
    },
  });
  return text(outputText(response), 4_000) || "Agent 未返回可用内容，请稍后重试。";
}

function qwenPawWorkingDirectory(installDirectory) {
  return officialQwenPawWorkingDirectory(installDirectory);
}

export function qwenPawBootstrapPlan({ platform = process.platform, arch = process.arch } = {}) {
  return qwenPawOfficialPackagePlan({ platform, arch });
}

function qwenPawOperationsWorkspace(dataDir) {
  return path.join(qwenPawWorkingDirectory(dataDir), "workspaces", QWENPAW_OPERATIONS_AGENT_ID);
}

function qwenPawOperationsSkillPath(dataDir) {
  return path.join(qwenPawOperationsWorkspace(dataDir), "skills", "ecommerce-operations-assistant", "SKILL.md");
}

function qwenPawToolBridgeSourcePath() {
  return path.join(serviceDirectory, "..", "scripts", "ecommerce-agent-mcp.js");
}

function qwenPawToolBridgePath(dataDir) {
  return path.join(qwenPawWorkingDirectory(dataDir), "ecommerce-agent-mcp.js");
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

export function qwenPawSyncPlan(installDirectory, modelConfig, operatingPrinciples = "") {
  const resolved = resolveModelConfig(modelConfig);
  if (!resolved.apiKey) throw Object.assign(new Error("请先在设置中心配置文字模型 API Key 后再打开运营 Agent。"), { status: 400 });
  const normalizedPrinciples = text(operatingPrinciples, 4_000);
  const signature = crypto.createHash("sha256")
    .update(`${QWENPAW_OPERATIONS_CONFIG_REVISION}\n${resolved.baseUrl}\n${resolved.model}\n${resolved.apiKey}\n${qwenPawOperationsContextUrl}\n${qwenPawAgentToolToken}\n${normalizedPrinciples}`)
    .digest("hex");
  return {
    model: resolved.model,
    signature,
    args: [],
    environment: qwenPawRuntimeEnvironment(installDirectory, { operatingPrinciples: normalizedPrinciples }),
    resolved,
  };
}

async function qwenPawApi(runtime, pathname, options = {}) {
  const response = await fetch(qwenPawBackendUrl(runtime, pathname), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.detail || parsed.message || body;
    } catch {
      // Preserve text returned by the local QwenPaw backend.
    }
    throw Object.assign(new Error(text(detail, 600) || `QwenPaw 本地接口返回 ${response.status}。`), { status: 502 });
  }
  return body ? JSON.parse(body) : null;
}

export function qwenPawWorkspaceAgentInstructions(operatingPrinciples = "") {
  const principles = text(operatingPrinciples, 4_000);
  const principlesBlock = principles
    ? `## 当前运营思路（必须遵循）\n\n${principles}\n\n每一项运营建议都必须按上述思路作为判断约束。若它与当前本地数据冲突，要明确指出冲突、说明依据并给出替代方案。\n\n`
    : "## 当前运营思路\n\n暂未设置额外运营思路；仍须严格依据本地数据回答。\n\n";
  return `# 电商运营助手\n\n${principlesBlock}你是经营罗盘应用的本机运营 Agent。通过 ecommerce_monitor MCP 工具查询和执行应用任务。
普通业务动作可直接执行并说明结果，包括查价、启停监控、设置监控价、重试本地解析、导入报表、经营分析和创建生图任务。
删除商品、清空记录、删除账号、修改模型密钥和账号登录资料必须要求用户明确确认。
价格任务必须调用 capture_product_price 或 get_product_prices，严禁访问淘宝、天猫、浏览器、Cookie、外部网页或任意本地文件。
查价工具返回 current_verified_sku_price_matrix 时，它是当前本地快照的完整 SKU 价格矩阵。必须逐条处理全部 skuRows，不能只报最低价、部分 SKU、第一条 SKU 或历史快照。
每个 SKU 的每个账号视角都必须完整列出 verifiedChannels 中的所有渠道和金额；只有 verifiedChannels 可以报为价格。若一个 SKU 没有已验证渠道，也要单独列出并说明 unavailableChannels 的原因。
查价完成后必须注明账号范围、SKU 覆盖（已列出数/工具返回 skuCount）、证据时间和不可用原因；未验证价格不得猜测、不得用历史价替代当前价。
所有金额、费率和 ROI 以工具返回的本地计算结果为准；历史数据只能按相同店铺、相同报表类型和相同统计口径比较，口径不一致或没有前序数据时必须明确说明；数据过期或缺失时必须明确说明。
回答使用简洁中文：先给结论，再列依据、执行回执、风险和下一步。
`;
}

async function writeQwenPawWorkspace(installDirectory, operatingPrinciples) {
  const workspace = qwenPawOperationsWorkspace(installDirectory);
  await fs.mkdir(workspace, { recursive: true });
  await fs.rm(path.join(workspace, "BOOTSTRAP.md"), { force: true });
  await fs.writeFile(path.join(workspace, "AGENTS.md"), qwenPawWorkspaceAgentInstructions(operatingPrinciples), "utf8");
  await fs.writeFile(path.join(workspace, "SOUL.md"), "你是严谨的电商运营助手。把已导入的经营数据转成可核对、可执行的建议，不能补造数据或把推测说成事实。\n", "utf8");

  const skillsDirectory = path.join(workspace, "skills");
  await fs.mkdir(skillsDirectory, { recursive: true });
  for (const entry of await fs.readdir(skillsDirectory, { withFileTypes: true })) {
    if (entry.name !== "ecommerce-operations-assistant") await fs.rm(path.join(skillsDirectory, entry.name), { recursive: true, force: true });
  }
  const skillDirectory = path.join(skillsDirectory, "ecommerce-operations-assistant");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: ecommerce-operations-assistant\ndescription: Analyze only the local ecommerce operations context supplied by 经营罗盘.\n---\n\n# 电商运营数据分析\n\n需要本机数据或动作时，只能调用 ecommerce_monitor MCP 工具。工具结果是唯一事实来源。\n", "utf8");
  await fs.writeFile(path.join(workspace, "skill.json"), `${JSON.stringify({ schema_version: "workspace-skill-manifest.v1", version: 0, skills: { "ecommerce-operations-assistant": { enabled: true, channels: ["all"], source: "customized" } } }, null, 2)}\n`, "utf8");
  return workspace;
}

function qwenPawApplicationMcp(installDirectory, workspace) {
  const mediaDirectory = path.join(workspace, "media");
  const environment = {
    ECOM_AGENT_APP_URL: qwenPawAppUrl(),
    ECOM_AGENT_TOOL_TOKEN: qwenPawAgentToolToken,
    ECOM_AGENT_WORKSPACE_DIR: workspace,
    ECOM_AGENT_MEDIA_DIR: mediaDirectory,
  };
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
  return {
    clients: {
      ecommerce_monitor: {
        name: "ecommerce_monitor",
        description: "经营罗盘本机商品、价格、监控、运营数据和 AI 创作工具。",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [qwenPawToolBridgePath(installDirectory)],
        env: environment,
        cwd: workspace,
        tools: [
          "get_workspace_state", "find_products", "get_product_prices", "capture_product_price", "set_product_monitoring",
          "set_sku_monitor_price", "retry_local_product_data", "get_capture_queue", "capture_products_batch", "set_global_monitor",
          "sync_product_to_feishu", "get_local_evidence_status", "get_operations_data", "analyze_operations_data",
          "preview_operations_report", "import_operations_report", "get_image_queue", "get_image_library", "update_image_library_item",
          "create_image_task", "get_agent_activity",
        ],
      },
    },
  };
}

async function configureQwenPawProvider(runtime, plan) {
  const providers = await qwenPawApi(runtime, "/api/models");
  let provider = providers.find((item) => item.id === QWENPAW_PROVIDER_ID);
  if (!provider) {
    provider = await qwenPawApi(runtime, "/api/models/custom-providers", {
      method: "POST",
      body: JSON.stringify({
        id: QWENPAW_PROVIDER_ID,
        name: "经营罗盘文字模型",
        default_base_url: plan.resolved.baseUrl,
        api_key_prefix: "",
        chat_model: "OpenAIChatModel",
        models: [{ id: plan.model, name: plan.model, supports_multimodal: true }],
      }),
    });
  }
  const models = [...(provider.models || []), ...(provider.extra_models || [])];
  if (!models.some((item) => item.id === plan.model)) {
    await qwenPawApi(runtime, `/api/models/${encodeURIComponent(QWENPAW_PROVIDER_ID)}/models`, {
      method: "POST",
      body: JSON.stringify({ id: plan.model, name: plan.model, supports_multimodal: true }),
    });
  }
  await qwenPawApi(runtime, `/api/models/${encodeURIComponent(QWENPAW_PROVIDER_ID)}/config`, {
    method: "PUT",
    body: JSON.stringify({ api_key: plan.resolved.apiKey, base_url: plan.resolved.baseUrl, chat_model: "OpenAIChatModel" }),
  });
}

export function lockQwenPawBuiltinTools(tools) {
  const builtinTools = tools?.builtin_tools;
  if (!builtinTools || typeof builtinTools !== "object" || !Object.keys(builtinTools).length || !builtinTools.view_image) {
    throw new Error("QwenPaw 内置工具清单不完整，已停止配置，避免误开放通用工具权限。");
  }
  for (const [name, tool] of Object.entries(builtinTools)) tool.enabled = name === "view_image";
  return tools;
}

async function configureQwenPawAgent(runtime, installDirectory, plan, operatingPrinciples) {
  const workspace = await writeQwenPawWorkspace(installDirectory, operatingPrinciples);
  await qwenPawToolBridgeScriptPath(installDirectory);
  const agent = await qwenPawApi(runtime, `/api/agents/${QWENPAW_OPERATIONS_AGENT_ID}`);
  agent.name = "运营助手";
  agent.description = "管理本机商品监控、经营数据分析与 AI 创作任务。";
  agent.workspace_dir = workspace;
  agent.language = "zh";
  agent.active_model = { provider_id: QWENPAW_PROVIDER_ID, model: plan.model };
  agent.approval_level = "AUTO";
  agent.system_prompt_files = ["AGENTS.md", "SOUL.md"];
  agent.channels ||= {};
  agent.channels.console ||= {};
  agent.channels.console.enabled = true;
  agent.channels.feishu ||= {};
  agent.channels.feishu.require_mention = true;
  agent.channels.feishu.share_session_in_group = false;
  agent.channels.feishu.media_dir ||= path.join(workspace, "media");
  agent.mcp = qwenPawApplicationMcp(installDirectory, workspace);
  agent.tools = lockQwenPawBuiltinTools(agent.tools);
  agent.heartbeat = null;
  agent.acp = null;
  agent.plan = { ...(agent.plan || {}), enabled: false };
  agent.coding_mode = { ...(agent.coding_mode || {}), enabled: false };
  agent.running ||= {};
  agent.running.auto_title_config = { ...(agent.running.auto_title_config || {}), enabled: false };
  agent.running.max_iters = 8;
  agent.running.max_input_length = 16_000;
  agent.running.context_manager_backend = "light";
  agent.running.memory_manager_backend = "none";
  agent.running.light_context_config ||= {};
  agent.running.light_context_config.strategy = "native";
  agent.running.light_context_config.context_compact_config = {
    ...(agent.running.light_context_config.context_compact_config || {}),
    enabled: true,
    compact_threshold_ratio: 0.6,
    reserve_threshold_ratio: 0.15,
  };
  agent.running.light_context_config.tool_result_pruning_config = {
    ...(agent.running.light_context_config.tool_result_pruning_config || {}),
    enabled: true,
    pruning_recent_n: 1,
    pruning_recent_msg_max_bytes: 12_000,
    pruning_old_msg_max_bytes: 2_000,
  };
  await qwenPawApi(runtime, `/api/agents/${QWENPAW_OPERATIONS_AGENT_ID}`, { method: "PUT", body: JSON.stringify(agent) });
  const agents = await qwenPawApi(runtime, "/api/agents");
  for (const item of agents.agents || []) {
    if (item.id !== QWENPAW_OPERATIONS_AGENT_ID && item.enabled) {
      await qwenPawApi(runtime, `/api/agents/${encodeURIComponent(item.id)}/toggle`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    }
  }
  return workspace;
}

async function syncQwenPawOperationsAgent(installDirectory, modelConfig, operatingPrinciples = "", preparedPlan = null) {
  const status = qwenPawLocalRuntimeStatus(installDirectory);
  if (!status.installed) throw Object.assign(new Error("尚未安装 QwenPaw，请先在运营思路旁点击安装。"), { status: 503 });
  const plan = preparedPlan || qwenPawSyncPlan(status.installDirectory, modelConfig, operatingPrinciples);
  const runtime = await startQwenPawBackend(status.installDirectory);
  await configureQwenPawProvider(runtime, plan);
  const workspace = await configureQwenPawAgent(runtime, status.installDirectory, plan, operatingPrinciples);
  return {
    ...status,
    installed: true,
    skillReady: true,
    directory: qwenPawWorkingDirectory(status.installDirectory),
    agentId: QWENPAW_OPERATIONS_AGENT_ID,
    model: plan.model,
    signature: plan.signature,
    skillPath: path.join(workspace, "skills", "ecommerce-operations-assistant", "SKILL.md"),
    runtime,
  };
}

export async function stopQwenPawOperationsConsole() {
  qwenPawConsoleStart = null;
  qwenPawConsoleStartSignature = "";
  await stopQwenPawBackend();
}

export async function startQwenPawOperationsConsole(installDirectory, modelConfig, operatingPrinciples = "") {
  const status = qwenPawLocalRuntimeStatus(installDirectory);
  if (!status.installed) throw Object.assign(new Error("尚未安装 QwenPaw，请先完成安装。"), { status: 503 });
  const plan = qwenPawSyncPlan(status.installDirectory, modelConfig, operatingPrinciples);
  if (qwenPawConsoleStart && qwenPawConsoleStartSignature === plan.signature) return qwenPawConsoleStart;

  const startup = (async () => {
    const synced = await syncQwenPawOperationsAgent(status.installDirectory, modelConfig, operatingPrinciples, plan);
    return {
      ...synced,
      running: true,
      consoleUrl: qwenPawBackendUrl(synced.runtime, "/console"),
    };
  })();
  qwenPawConsoleStart = startup;
  qwenPawConsoleStartSignature = plan.signature;
  try {
    return await startup;
  } finally {
    if (qwenPawConsoleStart === startup) {
      qwenPawConsoleStart = null;
      qwenPawConsoleStartSignature = "";
    }
  }
}

export function qwenPawRuntimeStatus(installDirectory = "") {
  const status = qwenPawLocalRuntimeStatus(installDirectory);
  status.skillReady = existsSync(qwenPawOperationsSkillPath(status.installDirectory));
  return status;
}

export async function prepareQwenPawOperationsSkill(installDirectory, modelConfig, operatingPrinciples = "") {
  const synced = await syncQwenPawOperationsAgent(installDirectory, modelConfig, operatingPrinciples);
  const { runtime: _runtime, ...payload } = synced;
  return { ...payload, skillReady: existsSync(qwenPawOperationsSkillPath(installDirectory)) };
}
