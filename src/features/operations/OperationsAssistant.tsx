import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleHelp,
  ClipboardPaste,
  Cloud,
  Clock3,
  Database,
  FileSpreadsheet,
  GripVertical,
  Layers3,
  LoaderCircle,
  PenLine,
  Search,
  Send,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { categoryContributionTotals } from "./categoryContribution";
import type {
  OperationsAnalysis,
  OperationsBusinessEntity,
  OperationsComparison,
  OperationsComparisonEntity,
  OperationsComparisonId,
  OperationsPeriodKind,
  OperationsReport,
  OperationsReportInputType,
  OperationsReportType,
  OperationsSourcePeriodKind,
  OperationsWorkspace,
} from "../../types/domain";

type OperationsAssistantProps = {
  workspace: OperationsWorkspace;
  onUpload: (
    file: File,
    payload: {
      type: OperationsReportInputType;
      storeName?: string;
      reportDate?: string;
      periodKind?: OperationsPeriodKind;
      periodStart?: string;
      periodEnd?: string;
      sourceName?: string;
    },
  ) => Promise<OperationsWorkspace>;
  onUploadProductCatalog: (file: File) => Promise<OperationsWorkspace>;
  onSaveProductCatalogEntry: (payload: {
    storeName: string;
    productId: string;
    category?: string;
    model?: string;
  }) => Promise<OperationsWorkspace>;
  onExportProductCatalog: () => Promise<void>;
  onPreview: (
    file: File,
  ) => Promise<{
    fileName: string;
    kind: "xls" | "xlsx" | "csv" | "json" | "screenshot";
      columns: string[];
      rowCount?: number;
      period?: { start: string; end: string; label: string } | null;
      detectedType?: OperationsReportType | null;
      sampleRows: Array<Record<string, unknown>>;
  }>;
  onDeleteReport: (id: string) => Promise<void>;
  onRenameReport: (id: string, fileName: string) => Promise<OperationsWorkspace>;
  onCreateStore: (name: string) => Promise<OperationsWorkspace>;
  onDeleteStore: (name: string) => Promise<OperationsWorkspace>;
  onAssignReportsStore: (ids: string[], storeName: string) => Promise<OperationsWorkspace>;
  onSaveSalesDeduction: (payload: {
    storeName: string;
    reportDate: string;
    amount: number;
    note?: string;
  }) => Promise<OperationsWorkspace>;
  onDeleteSalesDeduction: (id: string) => Promise<OperationsWorkspace>;
  onAnalyze: () => Promise<OperationsAnalysis>;
  onClearAnalyses: () => Promise<void>;
  onRunDailyReport: () => Promise<{
    analysis: OperationsAnalysis;
    sent: boolean;
    sendError: string;
  }>;
  onLoadWorkspace: (filters: {
    periodKind?: "all" | OperationsPeriodKind;
    sourcePeriodKind?: OperationsSourcePeriodKind;
    start?: string;
    end?: string;
    storeName?: string;
  }) => Promise<OperationsWorkspace>;
  onLoadArchive: () => Promise<{
    reports: OperationsReport[];
    archive: OperationsWorkspace["archive"];
  }>;
  onActivateCloudSync: (payload: { endpoint?: string; code: string; deviceName?: string }) => Promise<OperationsWorkspace>;
  onRunCloudSync: () => Promise<OperationsWorkspace>;
  onDisconnectCloudSync: () => Promise<OperationsWorkspace>;
};

// A browser tab can briefly be paired with an older local server while Vite
// has already loaded a newer client. Keep the data workspace usable until the
// server is restarted instead of letting an optional cloud-sync field crash
// both operations pages.
const disconnectedCloudSync: OperationsWorkspace["cloudSync"] = {
  endpoint: "https://jvspp.cloud",
  deviceId: "",
  deviceName: "",
  teamId: "",
  teamName: "",
  storeNames: [],
  lastCursor: 0,
  scopeVersion: 0,
  lastSyncAt: null,
  lastSyncResult: "",
  lastError: "",
  connected: false,
  deviceTokenMasked: "",
};

type View = "store" | "category" | "product" | "warehouse";
type WarehousePanel = "import" | "archive" | "catalog" | "cloud";
type DashboardDatePreset = "today" | "yesterday" | "last-7-days" | "last-15-days" | "this-week" | "last-week" | "this-month" | "last-month" | "custom";

type ReportPreview = {
  fileName: string;
  kind: "xls" | "xlsx" | "csv" | "json" | "screenshot";
  columns: string[];
  rowCount: number;
  exactRowCount: boolean;
  period?: { start: string; end: string; label: string } | null;
  detectedType?: OperationsReportType | null;
};

type ReportBatchStatus = "previewing" | "ready" | "preview-error" | "uploading" | "success" | "upload-error";

type ReportBatchItem = {
  id: string;
  file: File;
  preview: ReportPreview | null;
  reportType: OperationsReportType | "";
  periodKind: OperationsPeriodKind;
  periodStart: string;
  periodEnd: string;
  status: ReportBatchStatus;
  error: string;
  reportId?: string;
  importedRowCount?: number;
};

type CustomMetricId = "grossRevenue" | "refundAmount" | "revenue" | "spend" | "promotionRevenue"
  | "managementRoi" | "roi" | "feeRate" | "visitors" | "paidBuyers" | "conversionRate"
  | "clicks" | "impressions" | "orders" | "pageViews" | "favorites" | "cartUsers"
  | "cartItems" | "paidItems" | "cpc" | "costPerCollectCart";
type StoreTrendMetric = CustomMetricId;
type CardMetricId = CustomMetricId | "linkedCount" | "salesOnlyCount" | "promotionOnlyCount";
type CustomCardPanel = "store" | "category" | "product";
type EntityPanel = Exclude<CustomCardPanel, "store">;
type CustomCardConfig = { id: string; metricId: CustomMetricId; comparisonIds?: OperationsComparisonId[] };
type CoreMetricCard = {
  id: string;
  metricId: CardMetricId;
  label: string;
  value: string;
  detail: string;
  tone: "slate" | "emerald" | "blue" | "amber" | "rose";
  emphasis?: boolean;
  selected?: boolean;
  onClick?: () => void;
};
type ComparableMetricRecord = Pick<OperationsComparisonEntity,
  "grossRevenue" | "refundAmount" | "revenue" | "spend" | "promotionRevenue" | "visitors"
  | "paidBuyers" | "clicks" | "impressions" | "orders" | "pageViews" | "favorites"
  | "cartUsers" | "cartItems" | "paidItems" | "salesCount" | "promotionCount"
  | "refundDataAvailable" | "promotionCoverageComplete">;

const COMPARISON_OPTIONS: Array<{ id: OperationsComparisonId; label: string }> = [
  { id: "day", label: "日环比" },
  { id: "week", label: "周环比" },
  { id: "last7", label: "近 7 天" },
  { id: "last15", label: "近 15 天" },
  { id: "month", label: "月环比" },
  { id: "custom", label: "区间环比" },
];

const CUSTOM_METRICS: Array<{
  id: CustomMetricId;
  label: string;
  kind: "money" | "number" | "ratio" | "percent";
  tone: "slate" | "emerald" | "blue" | "amber" | "rose";
  description: string;
}> = [
  { id: "grossRevenue", label: "支付金额", kind: "money", tone: "slate", description: "退款前支付金额" },
  { id: "refundAmount", label: "成功退款金额", kind: "money", tone: "rose", description: "售中售后成功退款" },
  { id: "revenue", label: "净 GSV", kind: "money", tone: "emerald", description: "支付金额 - 成功退款" },
  { id: "spend", label: "推广花费", kind: "money", tone: "blue", description: "当前口径推广消耗" },
  { id: "promotionRevenue", label: "推广成交", kind: "money", tone: "blue", description: "推广平台归因成交" },
  { id: "managementRoi", label: "经营 ROI", kind: "ratio", tone: "amber", description: "净 GSV ÷ 推广花费" },
  { id: "roi", label: "推广 ROI", kind: "ratio", tone: "amber", description: "推广成交 ÷ 推广花费" },
  { id: "feeRate", label: "推广费率", kind: "percent", tone: "rose", description: "推广花费 ÷ 净 GSV" },
  { id: "visitors", label: "访客数", kind: "number", tone: "slate", description: "经营报表访客" },
  { id: "paidBuyers", label: "支付买家数", kind: "number", tone: "emerald", description: "完成支付的买家" },
  { id: "conversionRate", label: "支付转化率", kind: "percent", tone: "emerald", description: "支付买家数 ÷ 访客数" },
  { id: "clicks", label: "点击量", kind: "number", tone: "blue", description: "推广点击量" },
  { id: "impressions", label: "展现量", kind: "number", tone: "slate", description: "推广展现量" },
  { id: "orders", label: "推广订单", kind: "number", tone: "emerald", description: "推广归因订单" },
  { id: "pageViews", label: "浏览量", kind: "number", tone: "slate", description: "经营报表浏览量" },
  { id: "favorites", label: "收藏人数", kind: "number", tone: "slate", description: "收藏商品人数" },
  { id: "cartUsers", label: "加购人数", kind: "number", tone: "amber", description: "加入购物车人数" },
  { id: "cartItems", label: "加购件数", kind: "number", tone: "amber", description: "加入购物车商品件数" },
  { id: "paidItems", label: "支付件数", kind: "number", tone: "emerald", description: "支付商品件数" },
  { id: "cpc", label: "平均点击花费", kind: "money", tone: "blue", description: "推广花费 ÷ 点击量" },
  { id: "costPerCollectCart", label: "收藏加购成本", kind: "money", tone: "amber", description: "推广花费 ÷ 加购人数" },
];

const CUSTOM_CARD_STORAGE_KEY = "operations-custom-cards-v1";
const COMPARISON_VISIBILITY_STORAGE_KEY = "operations-comparison-visibility-v1";
const MATRIX_METRIC_STORAGE_KEY = "operations-matrix-metrics-v1";
const MATRIX_CUSTOM_METRIC_LIMIT = 8;
const MATRIX_FIXED_METRIC_IDS = new Set<CustomMetricId>([
  "grossRevenue", "refundAmount", "revenue", "spend", "promotionRevenue", "roi", "feeRate",
]);

function loadCustomCards(panel: CustomCardPanel) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_CARD_STORAGE_KEY) || "{}");
    return Array.isArray(parsed?.[panel]) ? parsed[panel] as CustomCardConfig[] : [];
  } catch {
    return [];
  }
}

function saveCustomCards(panel: CustomCardPanel, cards: CustomCardConfig[]) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_CARD_STORAGE_KEY) || "{}");
    window.localStorage.setItem(CUSTOM_CARD_STORAGE_KEY, JSON.stringify({ ...parsed, [panel]: cards }));
  } catch {
    // A disabled localStorage must not block the operations dashboard.
  }
}

function loadComparisonVisibility(panel: CustomCardPanel) {
  if (panel === "store") return true;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPARISON_VISIBILITY_STORAGE_KEY) || "{}");
    return parsed?.[panel] !== false;
  } catch {
    return true;
  }
}

function saveComparisonVisibility(panel: CustomCardPanel, visible: boolean) {
  if (panel === "store") return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPARISON_VISIBILITY_STORAGE_KEY) || "{}");
    window.localStorage.setItem(COMPARISON_VISIBILITY_STORAGE_KEY, JSON.stringify({ ...parsed, [panel]: visible }));
  } catch {
    // A disabled localStorage must not block the operations dashboard.
  }
}

function loadMatrixMetrics(panel: EntityPanel) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MATRIX_METRIC_STORAGE_KEY) || "{}");
    const stored = Array.isArray(parsed?.[panel])
      ? parsed[panel]
      : loadCustomCards(panel).map((card) => card.metricId);
    const knownIds = new Set(CUSTOM_METRICS.map((metric) => metric.id));
    return [...new Set(stored)]
      .filter((metricId): metricId is CustomMetricId => knownIds.has(metricId) && !MATRIX_FIXED_METRIC_IDS.has(metricId))
      .slice(0, MATRIX_CUSTOM_METRIC_LIMIT);
  } catch {
    return [];
  }
}

function saveMatrixMetrics(panel: EntityPanel, metricIds: CustomMetricId[]) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MATRIX_METRIC_STORAGE_KEY) || "{}");
    window.localStorage.setItem(MATRIX_METRIC_STORAGE_KEY, JSON.stringify({
      ...parsed,
      [panel]: metricIds.slice(0, MATRIX_CUSTOM_METRIC_LIMIT),
    }));
  } catch {
    // A disabled localStorage must not block the operations dashboard.
  }
}

function metricRecordFromBusiness(entity: OperationsBusinessEntity): ComparableMetricRecord {
  return {
    grossRevenue: entity.grossRevenue,
    refundAmount: entity.refundAmount,
    revenue: entity.revenue,
    spend: entity.spend,
    promotionRevenue: entity.promotionRevenue,
    visitors: entity.visitors,
    paidBuyers: entity.paidBuyers,
    clicks: entity.clicks,
    impressions: entity.impressions,
    orders: entity.orders,
    pageViews: entity.sales.pageViews,
    favorites: entity.sales.favorites,
    cartUsers: entity.sales.cartUsers,
    cartItems: entity.sales.cartItems,
    paidItems: entity.sales.paidItems,
    salesCount: entity.salesCount,
    promotionCount: entity.promotionCount,
    refundDataAvailable: entity.refundDataAvailable,
    promotionCoverageComplete: entity.promotionCoverageComplete,
  };
}

function aggregateComparableMetrics(records: ComparableMetricRecord[]) {
  const rateAvailable = records.length > 0 && records.every((item) => (
    item.salesCount > 0 && item.promotionCount > 0
    && item.refundDataAvailable && item.promotionCoverageComplete
  ));
  const totals = records.reduce((result, item) => {
    for (const key of Object.keys(result) as Array<keyof typeof result>) {
      result[key] += Number(item[key]) || 0;
    }
    return result;
  }, {
    grossRevenue: 0, refundAmount: 0, revenue: 0, spend: 0, promotionRevenue: 0,
    visitors: 0, paidBuyers: 0, clicks: 0, impressions: 0, orders: 0, pageViews: 0,
    favorites: 0, cartUsers: 0, cartItems: 0, paidItems: 0,
  });
  return {
    ...totals,
    managementRoi: rateAvailable && totals.spend > 0 ? totals.revenue / totals.spend : null,
    roi: totals.spend > 0 ? totals.promotionRevenue / totals.spend : null,
    feeRate: rateAvailable && totals.revenue > 0 ? totals.spend / totals.revenue : null,
    conversionRate: totals.visitors > 0 ? totals.paidBuyers / totals.visitors : null,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : null,
    costPerCollectCart: totals.cartUsers > 0 ? totals.spend / totals.cartUsers : null,
  };
}

function customMetricValue(records: ComparableMetricRecord[], metricId: CustomMetricId) {
  return aggregateComparableMetrics(records)[metricId];
}

function cardMetricValue(records: ComparableMetricRecord[], metricId: CardMetricId) {
  if (metricId === "linkedCount") return records.filter((item) => item.salesCount > 0 && item.promotionCount > 0).length;
  if (metricId === "salesOnlyCount") return records.filter((item) => item.salesCount > 0 && item.promotionCount <= 0).length;
  if (metricId === "promotionOnlyCount") return records.filter((item) => item.salesCount <= 0 && item.promotionCount > 0).length;
  return customMetricValue(records, metricId);
}

function formatCustomMetric(metricId: CustomMetricId, value: number | null) {
  const metric = CUSTOM_METRICS.find((item) => item.id === metricId);
  if (value === null || !Number.isFinite(value)) return "--";
  if (metric?.kind === "money") return money(value);
  if (metric?.kind === "percent") return percent(value);
  if (metric?.kind === "ratio") return fixed(value);
  return count(value);
}

const TREND_COLORS = [
  "#0f766e", "#2563eb", "#d97706", "#e11d48", "#7c3aed", "#0891b2", "#4f46e5",
  "#be123c", "#15803d", "#b45309", "#0e7490", "#1d4ed8", "#6d28d9", "#047857",
  "#9f1239", "#0369a1", "#a16207", "#4338ca", "#0f766e", "#c2410c", "#1e40af",
];

const STORE_TREND_METRICS = Object.fromEntries(CUSTOM_METRICS.map((metric, index) => [metric.id, {
  label: metric.label,
  color: TREND_COLORS[index % TREND_COLORS.length],
  dataKey: metric.id,
  kind: metric.kind,
}])) as Record<StoreTrendMetric, {
  label: string;
  color: string;
  dataKey: StoreTrendMetric;
  kind: "money" | "number" | "ratio" | "percent";
}>;

function automaticComparisonId(preset: DashboardDatePreset): OperationsComparisonId {
  if (preset === "last-7-days") return "last7";
  if (preset === "last-15-days") return "last15";
  if (preset === "this-week" || preset === "last-week") return "week";
  if (preset === "this-month" || preset === "last-month") return "month";
  if (preset === "custom") return "custom";
  return "day";
}

const WAREHOUSE_PANEL_OPTIONS: Array<{
  id: WarehousePanel;
  label: string;
  description: string;
  icon: typeof Upload;
  activeClassName: string;
}> = [
  { id: "import", label: "导入报表", description: "上传并写入本地公式", icon: Upload, activeClassName: "border-teal-700 bg-teal-700 text-white shadow-[0_10px_22px_rgba(15,118,110,0.2)]" },
  { id: "archive", label: "本地数据仓", description: "查看、筛选与批量管理", icon: Database, activeClassName: "border-blue-700 bg-blue-700 text-white shadow-[0_10px_22px_rgba(29,78,216,0.18)]" },
  { id: "catalog", label: "商品资料库", description: "维护店铺、ID、型号与品类", icon: FileSpreadsheet, activeClassName: "border-amber-500 bg-amber-500 text-white shadow-[0_10px_22px_rgba(217,119,6,0.18)]" },
  { id: "cloud", label: "云端同步", description: "绑定团队并同步共享报表", icon: Cloud, activeClassName: "border-sky-700 bg-sky-700 text-white shadow-[0_10px_22px_rgba(3,105,161,0.18)]" },
];

type CategorySelectionHistoryItem = {
  id: string;
  name: string;
  categoryNames: string[];
  updatedAt: string;
};

type EntityTableSortKey = CustomMetricId | "name" | "model" | "productId" | "promotionCount";

const CATEGORY_SELECTION_HISTORY_LIMIT = 3;
const PRODUCT_CATALOG_PAGE_SIZE = 60;

function categorySelectionStorageKey(kind: "category" | "product") {
  return `ecommerce-monitor-operations-category-selections-v1:${kind}`;
}

function categorySelectionSignature(names: Iterable<string>) {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .join("\u0001");
}

function selectionHistoryLabel(categoryNames: string[]) {
  if (categoryNames.length <= 2) return categoryNames.join("、");
  return `${categoryNames.slice(0, 2).join("、")}等 ${categoryNames.length} 个`;
}

function hasVisibleBusinessData(item: OperationsBusinessEntity) {
  return [item.grossRevenue, item.refundAmount, item.revenue, item.spend, item.promotionRevenue]
    .some((value) => Math.abs(Number(value) || 0) >= 0.005);
}

function loadCategorySelectionHistory(kind: "category" | "product") {
  try {
    const raw = window.localStorage.getItem(categorySelectionStorageKey(kind));
    const saved = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item): item is Partial<CategorySelectionHistoryItem> => Boolean(item) && typeof item === "object")
      .filter((item) => (item as { source?: string }).source !== "auto")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        name: typeof item.name === "string" ? item.name.trim().slice(0, 32) : "",
        categoryNames: Array.isArray(item.categoryNames)
          ? [...new Set(item.categoryNames.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean))].slice(0, 100)
          : [],
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      }))
      .filter((item) => item.id && item.categoryNames.length)
      .slice(0, CATEGORY_SELECTION_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveCategorySelectionHistory(kind: "category" | "product", items: CategorySelectionHistoryItem[]) {
  try {
    window.localStorage.setItem(categorySelectionStorageKey(kind), JSON.stringify(items));
  } catch {
    // A restricted browser storage must not stop table filters from working.
  }
}

function upsertCategorySelectionHistory(
  current: CategorySelectionHistoryItem[],
  categoryNames: Iterable<string>,
  manualName = "",
) {
  const names = [...new Set([...categoryNames].map((name) => name.trim()).filter(Boolean))];
  if (!names.length) return current;
  const signature = categorySelectionSignature(names);
  const existing = current.find((item) => categorySelectionSignature(item.categoryNames) === signature);
  const entry: CategorySelectionHistoryItem = {
    id: existing?.id || `category-selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: manualName.trim().slice(0, 32) || existing?.name || selectionHistoryLabel(names),
    categoryNames: names,
    updatedAt: new Date().toISOString(),
  };
  const retained = current.filter((item) => item.id !== existing?.id);
  return [entry, ...retained].slice(0, CATEGORY_SELECTION_HISTORY_LIMIT);
}

const reportTypeLabels: Record<OperationsReportType, string> = {
  category: "品类360",
  product: "商品排行",
  scenario: "类目付费",
  promotion: "类目付费",
  campaign: "单品付费",
  market: "大盘数据",
  audience: "人群数据",
  competitor: "竞品人群",
};

const importGuide = [
  {
    type: "category" as const,
    source: "生意参谋 > 品类 > 品类360",
    selection: "选择：品类360",
    purpose: "导入支付金额、成功退款金额，计算品类净 GSV。",
  },
  {
    type: "product" as const,
    source: "生意参谋 > 商品 > 商品排行",
    selection: "选择：商品排行",
    purpose: "导入商品销售、退款与访客等经营数据。",
  },
  {
    type: "campaign" as const,
    source: "万相台 / 阿里妈妈 > 报表 > 商品报表 > 下载管理",
    selection: "选择：单品付费",
    purpose: "导入商品推广花费、成交、渠道和计划明细。",
  },
];

const importSelectLabels: Partial<Record<OperationsReportType, string>> = {
  category: "品类360（生意参谋·品类360）",
  product: "商品排行（生意参谋·商品排行）",
  campaign: "单品付费（万相台·商品报表）",
};

const manualReportTypes: OperationsReportType[] = [
  "category",
  "product",
  "campaign",
];

const periodKindLabels: Record<OperationsPeriodKind, string> = {
  day: "日报",
  week: "周报",
  month: "月报",
  custom: "自定义",
};
function money(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? `¥${numeric.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "--";
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "--";
}

function fixed(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined) return "--";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "--";
}

function count(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.round(numeric).toLocaleString("zh-CN")
    : "--";
}

function timestamp(value: string | null | undefined) {
  if (!value) return "未导入";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString("zh-CN", { hour12: false })
    : "未导入";
}

function localDate(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function shiftCalendarDate(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function dashboardDateRange(preset: Exclude<DashboardDatePreset, "custom">, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "today") return { start: localDate(today), end: localDate(today) };
  if (preset === "yesterday") {
    const yesterday = shiftCalendarDate(today, -1);
    return { start: localDate(yesterday), end: localDate(yesterday) };
  }
  if (preset === "last-7-days") {
    const end = shiftCalendarDate(today, -1);
    return { start: localDate(shiftCalendarDate(end, -6)), end: localDate(end) };
  }
  if (preset === "last-15-days") {
    const end = shiftCalendarDate(today, -1);
    return { start: localDate(shiftCalendarDate(end, -14)), end: localDate(end) };
  }
  if (preset === "this-week") {
    const mondayOffset = (today.getDay() + 6) % 7;
    const monday = shiftCalendarDate(today, -mondayOffset);
    return { start: localDate(monday), end: localDate(today) };
  }
  if (preset === "last-week") {
    const mondayOffset = (today.getDay() + 6) % 7;
    const previousMonday = shiftCalendarDate(today, -mondayOffset - 7);
    const previousSunday = shiftCalendarDate(previousMonday, 6);
    return { start: localDate(previousMonday), end: localDate(previousSunday) };
  }
  if (preset === "this-month") {
    return { start: localDate(new Date(today.getFullYear(), today.getMonth(), 1)), end: localDate(today) };
  }
  return {
    start: localDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
    end: localDate(new Date(today.getFullYear(), today.getMonth(), 0)),
  };
}

function periodKindForRange(startDate: string, endDate: string): OperationsPeriodKind {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const days = Number.isFinite(start) && Number.isFinite(end)
    ? Math.floor((end - start) / 86_400_000) + 1
    : 1;
  if (days <= 1) return "day";
  if (days <= 8) return "week";
  if (days >= 28 && days <= 32) return "month";
  return "custom";
}

type OperationsDataReport = OperationsWorkspace["reports"][number];

function reportRowCount(report: OperationsDataReport) {
  return Number.isFinite(report.rowCount) ? Number(report.rowCount) : report.rows.length;
}

type ReportDateGroup = {
  key: string;
  label: string;
  scopeLabel: "统计日期" | "统计周期";
  sortDate: string;
  reports: OperationsDataReport[];
  totalRows: number;
};

type ReportStoreGroup = {
  key: string;
  label: string;
  reports: OperationsDataReport[];
  dateGroups: ReportDateGroup[];
  totalRows: number;
};

function reportStoreName(report: OperationsDataReport) {
  return report.storeName?.trim() || "未归属店铺";
}

function reportPeriodGroup(report: OperationsDataReport) {
  const start = report.periodStart || report.reportDate || "";
  const end = report.periodEnd || report.reportDate || "";
  if (!start && !end) {
    return {
      key: "未设置日期",
      label: "未设置日期",
      scopeLabel: "统计日期" as const,
      sortDate: "",
    };
  }
  const normalizedStart = start || end;
  const normalizedEnd = end || start;
  const isRange = normalizedStart !== normalizedEnd;
  return {
    key: `${normalizedStart}\u0000${normalizedEnd}`,
    label: report.periodLabel || (isRange ? `${normalizedStart} 至 ${normalizedEnd}` : normalizedEnd),
    scopeLabel: isRange ? "统计周期" as const : "统计日期" as const,
    sortDate: normalizedEnd,
  };
}

function groupReportsByStatisticsDate(
  reports: OperationsDataReport[],
): ReportDateGroup[] {
  const groups = new Map<string, {
    label: string;
    scopeLabel: ReportDateGroup["scopeLabel"];
    sortDate: string;
    reports: OperationsDataReport[];
  }>();
  for (const report of reports) {
    const period = reportPeriodGroup(report);
    const current = groups.get(period.key);
    if (current) {
      current.reports.push(report);
      continue;
    }
    groups.set(period.key, { ...period, reports: [report] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      scopeLabel: group.scopeLabel,
      sortDate: group.sortDate,
      reports: group.reports.slice().sort((left, right) =>
        String(right.importedAt || "").localeCompare(String(left.importedAt || "")),
      ),
      totalRows: group.reports.reduce((sum, report) => sum + reportRowCount(report), 0),
    }))
    .sort((left, right) => {
      if (!left.sortDate) return 1;
      if (!right.sortDate) return -1;
      return right.sortDate.localeCompare(left.sortDate) || right.label.localeCompare(left.label);
    });
}

function groupReportsByStoreAndStatisticsDate(
  reports: OperationsDataReport[],
): ReportStoreGroup[] {
  const stores = new Map<string, OperationsDataReport[]>();
  for (const report of reports) {
    const storeName = reportStoreName(report);
    const current = stores.get(storeName);
    if (current) current.push(report);
    else stores.set(storeName, [report]);
  }
  return [...stores.entries()]
    .map(([storeName, storeReports]) => ({
      key: storeName,
      label: storeName,
      reports: storeReports,
      dateGroups: groupReportsByStatisticsDate(storeReports),
      totalRows: storeReports.reduce((sum, report) => sum + reportRowCount(report), 0),
    }))
    .sort((left, right) => {
      if (left.label === "未归属店铺") return 1;
      if (right.label === "未归属店铺") return -1;
      return left.label.localeCompare(right.label, "zh-CN");
    });
}

function pastedDataFile(value: string) {
  const source = value.trim();
  if (!source) return null;
  if (source.startsWith("[") || source.startsWith("{"))
    return new File([source], "粘贴运营数据.json", {
      type: "application/json",
    });
  const csv = source.includes("\t")
    ? source
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) =>
          line
            .split("\t")
            .map((cell) => `"${cell.replace(/"/g, '""')}"`)
            .join(","),
        )
        .join("\n")
    : source;
  return new File([csv], "粘贴运营数据.csv", { type: "text/csv" });
}

function matchLabel(status: OperationsBusinessEntity["matchStatus"]) {
  if (status === "id")
    return {
      text: "ID 已关联",
      className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    };
  if (status === "name")
    return {
      text: "名称已关联",
      className: "bg-blue-50 text-blue-700 ring-blue-200",
    };
  if (status === "sales-only")
    return {
      text: "待补推广数据",
      className: "bg-amber-50 text-amber-700 ring-amber-200",
    };
  if (status === "promotion-only")
    return {
      text: "待补经营数据",
      className: "bg-orange-50 text-orange-700 ring-orange-200",
    };
  return {
    text: "暂无关联数据",
    className: "bg-slate-100 text-slate-600 ring-slate-200",
  };
}

function MatchBadge({
  status,
}: {
  status: OperationsBusinessEntity["matchStatus"];
}) {
  const value = matchLabel(status);
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium ring-1 ${value.className}`}
    >
      {value.text}
    </span>
  );
}

function MetricTile({
  label,
  value,
  detail,
  comparison,
  tone = "slate",
  emphasis = false,
  selected = false,
  onClick,
  surfaceClassName,
}: {
  label: string;
  value: string;
  detail: string;
  comparison?: ReactNode;
  tone?: "slate" | "emerald" | "blue" | "amber" | "rose";
  emphasis?: boolean;
  selected?: boolean;
  onClick?: () => void;
  surfaceClassName?: string;
}) {
  const tones = {
    slate: "border-slate-200 before:bg-slate-500",
    emerald: "border-emerald-200 before:bg-emerald-600",
    blue: "border-blue-200 before:bg-sky-600",
    amber: "border-amber-200 before:bg-amber-500",
    rose: "border-rose-200 before:bg-rose-500",
  };
  const compactValue = value.length > 11;
  const content = (
    <>
      <div className={`text-xs font-semibold text-slate-500 ${selected ? "pr-12" : ""}`}>{label}</div>
      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1.5">
        <div
          className={`whitespace-nowrap font-semibold tracking-normal text-slate-950 ${emphasis && !compactValue ? "text-3xl" : emphasis ? "text-xl" : "text-2xl"}`}
        >
          {value}
        </div>
        {comparison && <div className="flex min-w-0 flex-wrap items-center gap-1">{comparison}</div>}
      </div>
      <div className="mt-2 truncate text-xs leading-5 text-slate-500">{detail}</div>
      {selected && (
        <span className="absolute right-3 top-3 inline-flex h-5 items-center gap-1 border border-teal-700 bg-teal-700 px-1.5 text-[10px] font-semibold text-white">
          <Check className="h-3 w-3" />
          已选
        </span>
      )}
    </>
  );
  const className = `relative min-w-0 overflow-hidden border px-4 py-4 text-left shadow-[0_8px_24px_rgba(15,23,42,0.045)] backdrop-blur-sm before:absolute before:inset-x-0 before:top-0 before:h-1 ${tones[tone]} ${selected ? "z-10 !border-teal-600 !bg-teal-50 ring-2 ring-inset ring-teal-500 shadow-[0_12px_28px_rgba(13,148,136,0.18)]" : (surfaceClassName || "bg-white/92")}`;
  if (onClick) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`切换${label}趋势`}
        onClick={onClick}
        className={`${className} cursor-pointer transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2`}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={className}>
      {content}
    </div>
  );
}

function comparisonTone(change: number) {
  if (!Number.isFinite(change) || change === 0) return "border-slate-200 bg-slate-50 text-slate-500";
  return change > 0
    ? "border-red-200 bg-red-50 text-red-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function comparisonRowsForPanel(panel: CustomCardPanel, comparison: OperationsComparison | undefined, side: "current" | "previous", currentEntities: OperationsBusinessEntity[]) {
  const snapshot = comparison?.[side];
  if (!snapshot) return [];
  if (panel === "store") return snapshot.store ? [snapshot.store] : [];
  const source = panel === "category" ? snapshot.categories : snapshot.products;
  const identities = new Set(currentEntities.flatMap((item) => [item.key, item.productId || "", item.name, `${item.category || ""}\u0000${item.model || ""}`].filter(Boolean)));
  return source.filter((item) => panel === "category"
    ? identities.has(item.key) || identities.has(item.name)
    : identities.has(item.key) || identities.has(item.productId) || identities.has(`${item.category || ""}\u0000${item.model || ""}`));
}

function CardComparisonBadges({ panel, metricId, comparisonIds, comparisons, currentEntities }: {
  panel: CustomCardPanel;
  metricId: CardMetricId;
  comparisonIds: OperationsComparisonId[];
  comparisons: OperationsWorkspace["dashboard"]["comparisons"];
  currentEntities: OperationsBusinessEntity[];
}) {
  if (!comparisonIds.length) return null;
  if (!comparisons) {
    return <span className="inline-flex border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="本地前端已更新，但后端仍是旧进程">请重启应用</span>;
  }
  const metric = CUSTOM_METRICS.find((item) => item.id === metricId);
  return comparisonIds.map((comparisonId) => {
    const comparison = comparisons?.[comparisonId];
    const currentRows = comparisonRowsForPanel(panel, comparison, "current", currentEntities);
    const previousRows = comparisonRowsForPanel(panel, comparison, "previous", currentEntities);
    const available = Boolean(comparison?.currentAvailable && comparison?.previousAvailable && currentRows.length && previousRows.length);
    const currentValue = available ? cardMetricValue(currentRows, metricId) : null;
    const previousValue = available ? cardMetricValue(previousRows, metricId) : null;
    const delta = currentValue !== null && previousValue !== null && Number.isFinite(currentValue) && Number.isFinite(previousValue) ? currentValue - previousValue : null;
    const relative = delta !== null && previousValue !== null && previousValue !== 0 ? delta / Math.abs(previousValue) : null;
    const label = comparison?.label || COMPARISON_OPTIONS.find((item) => item.id === comparisonId)?.label || comparisonId;
    if (delta === null) return <span key={comparisonId} className="inline-flex border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400" title="当前或同期报表不完整">{label} 暂无</span>;
    const display = relative === null
      ? (delta === 0 ? "持平" : "新增")
      : metric?.kind === "percent"
        ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp · ${relative >= 0 ? "+" : ""}${(relative * 100).toFixed(1)}%`
        : `${relative >= 0 ? "+" : ""}${(relative * 100).toFixed(1)}%`;
    return <span key={comparisonId} className={`inline-flex border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${comparisonTone(delta)}`} title={`${comparison?.currentStart} 至 ${comparison?.currentEnd} 对比 ${comparison?.previousStart} 至 ${comparison?.previousEnd}`}>{label} {display}</span>;
  });
}

function MetricCardGrid({ panel, coreCards, currentEntities, comparisons, comparisonId, trendMetrics = [], onToggleTrendMetric }: {
  panel: CustomCardPanel;
  coreCards: CoreMetricCard[];
  currentEntities: OperationsBusinessEntity[];
  comparisons: OperationsWorkspace["dashboard"]["comparisons"];
  comparisonId: OperationsComparisonId;
  trendMetrics?: StoreTrendMetric[];
  onToggleTrendMetric?: (metric: StoreTrendMetric) => void;
}) {
  const [cards, setCards] = useState<CustomCardConfig[]>(() => loadCustomCards(panel));
  const [showComparisons, setShowComparisons] = useState(() => loadComparisonVisibility(panel));
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => saveCustomCards(panel, cards), [cards, panel]);
  useEffect(() => saveComparisonVisibility(panel, showComparisons), [panel, showComparisons]);
  const currentRecords = useMemo(() => currentEntities.map(metricRecordFromBusiness), [currentEntities]);
  const coreMetricIds = useMemo(() => new Set(coreCards.map((card) => card.metricId)), [coreCards]);
  const customCards = cards.filter((card) => !coreMetricIds.has(card.metricId));
  const selectedMetricIds = new Set(customCards.map((card) => card.metricId));
  const toggleCustomMetric = (metricId: CustomMetricId) => {
    setCards((current) => {
      const withoutCoreMetrics = current.filter((card) => !coreMetricIds.has(card.metricId));
      if (withoutCoreMetrics.some((card) => card.metricId === metricId)) {
        return withoutCoreMetrics.filter((card) => card.metricId !== metricId);
      }
      return [...withoutCoreMetrics, { id: `${panel}-${metricId}`, metricId }];
    });
  };
  const panelLabel = panel === "store" ? "整店总览" : panel === "category" ? "品类 360" : "商品排行";
  const comparison = showComparisons
    ? (metricId: CardMetricId) => <CardComparisonBadges panel={panel} metricId={metricId} comparisonIds={[comparisonId]} comparisons={comparisons} currentEntities={currentEntities} />
    : undefined;
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5">
        {panel !== "store" && (
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 border border-slate-200 bg-white px-2 text-[11px] font-semibold text-slate-600 shadow-sm" title={`${showComparisons ? "关闭" : "开启"}${panelLabel}环比展示`}>
            <span>环比</span>
            <input type="checkbox" checked={showComparisons} onChange={(event) => setShowComparisons(event.target.checked)} className="peer sr-only" />
            <span className="relative h-4 w-7 bg-slate-200 transition-colors peer-checked:bg-teal-600 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-1 after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:bg-white after:transition-transform peer-checked:after:translate-x-3" />
          </label>
        )}
        <Button type="button" size="sm" variant="secondary" title="设置指标卡片" aria-label="设置指标卡片" className="h-7 w-7 p-0" onClick={() => setSettingsOpen(true)}><Settings2 className="h-4 w-4" /></Button>
      </div>
      <section className="grid gap-px overflow-hidden border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-4">
        {coreCards.map((card) => <MetricTile key={card.id} {...card} comparison={comparison?.(card.metricId)} />)}
        {customCards.map((card) => {
          const metric = CUSTOM_METRICS.find((item) => item.id === card.metricId) || CUSTOM_METRICS[0];
          const trendEnabled = panel === "store" && Boolean(onToggleTrendMetric);
          return <MetricTile key={card.id} label={metric.label} value={formatCustomMetric(card.metricId, customMetricValue(currentRecords, card.metricId))} detail={metric.description} tone={metric.tone} selected={trendEnabled && trendMetrics.includes(card.metricId)} onClick={trendEnabled ? () => onToggleTrendMetric?.(card.metricId) : undefined} comparison={comparison?.(card.metricId)} />;
        })}
      </section>
      {settingsOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/35 p-4" role="dialog" aria-modal="true" aria-label={`${panelLabel}指标卡片设置`}>
          <section className="max-h-[88vh] w-full max-w-4xl overflow-y-auto border border-slate-200 bg-white shadow-2xl">
            <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4"><div><h3 className="text-base font-semibold text-slate-950">{panelLabel}指标卡片</h3><p className="mt-1 text-xs text-slate-500">环比跟随当前统计范围自动计算；自定义卡片从数据表可计算字段中新增。</p></div><Button type="button" size="sm" variant="ghost" title="关闭" className="h-8 w-8 p-0" onClick={() => setSettingsOpen(false)}><X className="h-4 w-4" /></Button></header>
            <div className="space-y-5 p-5">
              <section className={`border p-4 ${showComparisons ? "border-blue-200 bg-blue-50/55" : "border-slate-200 bg-slate-50"}`}><div className={`text-sm font-semibold ${showComparisons ? "text-blue-950" : "text-slate-700"}`}>{showComparisons ? `环比已自动匹配：${COMPARISON_OPTIONS.find((option) => option.id === comparisonId)?.label}` : "当前已隐藏环比"}</div><div className={`mt-1 text-xs leading-5 ${showComparisons ? "text-blue-700" : "text-slate-500"}`}>{panel === "store" ? "切换日期范围后，全部卡片会立即使用对应公式重算。" : `可在卡片右上角独立${showComparisons ? "关闭" : "开启"}${panelLabel}环比；设置会在下次打开时保留。`}</div></section>
              <section><div className="mb-3"><h4 className="text-sm font-semibold text-slate-900">自定义数据卡片</h4><p className="mt-1 text-xs text-slate-500">默认指标固定保留；其余经营与付费字段直接勾选，已选 {customCards.length} 项。每项都会使用当前周期的同口径环比。</p></div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CUSTOM_METRICS.filter((metric) => !coreMetricIds.has(metric.id)).map((metric) => { const selected = selectedMetricIds.has(metric.id); return <label key={metric.id} className={`flex cursor-pointer items-start gap-3 border p-3 transition-colors ${selected ? "border-teal-300 bg-teal-50/70" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}><input type="checkbox" checked={selected} onChange={() => toggleCustomMetric(metric.id)} className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600" /><span className="min-w-0"><span className="block text-sm font-semibold text-slate-800">{metric.label}</span><span className="mt-1 block text-[11px] leading-4 text-slate-500">{metric.description}</span></span></label>; })}</div></section>
            </div>
            <footer className="sticky bottom-0 flex justify-end border-t border-slate-200 bg-white px-5 py-3"><Button type="button" onClick={() => setSettingsOpen(false)}>完成</Button></footer>
          </section>
        </div>
      )}
    </div>
  );
}

function DashboardBarChart({
  title,
  hint,
  data,
  formatter,
  color,
  emptyText,
}: {
  title: string;
  hint: string;
  data: Array<{ key?: string; id?: string; name: string; value: number }>;
  formatter: (value: number) => string;
  color: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const hasItemId = data.some((item) => Boolean(item.id));
  const visibleData = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return data;
    return data.filter((item) =>
      `${item.id || ""} ${item.name}`.toLowerCase().includes(keyword),
    );
  }, [data, query]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-1 max-w-xl text-xs leading-5 text-slate-500">{hint}</div>
        </div>
        {hasItemId && (
          <label className="relative shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索商品 ID / 名称"
            className="h-8 w-44 border border-slate-200 bg-white/90 pl-8 pr-2 text-xs text-slate-700 outline-none transition-colors focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
            />
          </label>
        )}
      </div>
      {visibleData.length ? (
        <>
          <div
            className="h-64 overflow-y-scroll overscroll-contain pr-2 [scrollbar-gutter:stable]"
            title="可使用鼠标滚轮查看完整排名"
          >
            <div style={{ height: `${Math.max(264, visibleData.length * 44)}px` }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={visibleData} layout="vertical" margin={{ top: 0, right: 86, left: 0, bottom: 0 }} barCategoryGap="18%">
                  <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={(value) => value >= 10000 ? `${(value / 10000).toFixed(0)}万` : String(value)} />
                  <YAxis type="category" tickLine={false} axisLine={false} dataKey="name" tick={{ fill: "#475569", fontSize: 11 }} width={172} />
                  <Tooltip cursor={{ fill: "#f1f5f9" }} formatter={(value) => [formatter(Number(value)), title]} contentStyle={{ borderRadius: 6, borderColor: "#e2e8f0", boxShadow: "0 12px 30px rgba(15, 23, 42, .1)" }} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={24}>
                    {visibleData.map((item) => <Cell key={item.key || item.name} fill={color} fillOpacity={0.9} />)}
                    <LabelList dataKey="value" position="right" fill="#334155" fontSize={11} formatter={(value) => formatter(Number(value))} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-[390px] items-center justify-center px-8 text-center text-sm leading-6 text-slate-500">
          {query ? "没有找到对应的商品 ID 或名称。" : emptyText || "导入同统计周期的对应报表后显示对比"}
        </div>
      )}
    </div>
  );
}

function CategoryContributionPanel({
  categories,
}: {
  categories: OperationsBusinessEntity[];
}) {
  const activeCategories = useMemo(
    () =>
      categories.filter(
        (item) =>
          Math.abs(Number(item.revenue) || 0) >= 0.005 ||
          Math.abs(Number(item.spend) || 0) >= 0.005,
      ),
    [categories],
  );
  const rankedCategories = useMemo(
    () =>
      [...activeCategories]
        .sort(
          (left, right) =>
            right.revenue - left.revenue || right.spend - left.spend,
        )
        .slice(0, 10),
    [activeCategories],
  );
  const totals = useMemo(
    () => categoryContributionTotals(activeCategories),
    [activeCategories],
  );
  const maxRevenue = Math.max(1, ...rankedCategories.map((item) => Number(item.revenue) || 0));
  const maxSpend = Math.max(1, ...rankedCategories.map((item) => Number(item.spend) || 0));
  const share = (value: number, total: number) =>
    total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const rateClassName = (value: number | null) => {
    if (value === null) return "border-slate-200 bg-slate-100 text-slate-500";
    if (value <= 0.08)
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (value <= 0.12)
      return "border-amber-200 bg-amber-50 text-amber-700";
    return "border-rose-200 bg-rose-50 text-rose-700";
  };

  if (!activeCategories.length) return null;

  return (
    <Card className="overflow-hidden border-sky-200">
      <CardHeader className="gap-4 border-b border-slate-200 bg-sky-50/50 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-sky-700">经营结构</div>
          <CardTitle className="mt-1">类目销售贡献与推广效率</CardTitle>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            按净 GSV 排名，金额、占比和费率均跟随当前日期、口径与店铺筛选。
          </p>
        </div>
        <dl className="grid min-w-0 overflow-hidden border border-sky-200 bg-white sm:grid-cols-3 xl:min-w-[560px]">
          <div className="min-w-0 px-3 py-2.5">
            <dt className="text-[10px] font-semibold text-slate-500">有效类目净 GSV</dt>
            <dd className="mt-1 truncate text-sm font-semibold text-slate-900" title={money(totals.revenue)}>
              {money(totals.revenue)}
            </dd>
          </div>
          <div className="min-w-0 border-t border-sky-100 px-3 py-2.5 sm:border-l sm:border-t-0">
            <dt className="text-[10px] font-semibold text-slate-500">有效类目推广花费</dt>
            <dd className="mt-1 truncate text-sm font-semibold text-slate-900" title={money(totals.spend)}>
              {money(totals.spend)}
            </dd>
          </div>
          <div className="min-w-0 border-t border-sky-100 px-3 py-2.5 sm:border-l sm:border-t-0">
            <dt className="text-[10px] font-semibold text-slate-500">类目整体推广费率</dt>
            <dd className="mt-1">
              <span className={`inline-flex border px-2 py-1 text-xs font-semibold ${rateClassName(totals.feeRate)}`}>
                {percent(totals.feeRate)}
              </span>
              <span className="ml-2 text-[10px] font-medium text-slate-500">
                {totals.feeRateCategoryCount} / {activeCategories.length} 个类目参与计算
              </span>
            </dd>
          </div>
        </dl>
      </CardHeader>

      <div className="grid gap-px border-b border-sky-100 bg-sky-100 lg:grid-cols-3">
        {[
          ["销售占比", "类目净 GSV ÷ 有效类目净 GSV 合计"],
          ["花费占比", "类目推广花费 ÷ 有效类目推广花费合计"],
          ["类目推广费率", "类目推广花费 ÷ 类目净 GSV"],
        ].map(([label, formula]) => (
          <div key={label} className="flex min-w-0 items-center gap-2 bg-sky-50/70 px-4 py-2">
            <span className="shrink-0 text-[10px] font-semibold text-sky-800">{label}</span>
            <span className="truncate text-[10px] text-slate-500" title={formula}>{formula}</span>
          </div>
        ))}
      </div>

      <div className="hidden min-h-10 grid-cols-[minmax(150px,0.8fr)_minmax(210px,1fr)_minmax(210px,1fr)_minmax(130px,0.6fr)] items-center gap-5 border-b border-slate-200 bg-slate-50 px-5 text-[10px] font-semibold text-slate-500 lg:grid">
        <span>排名 / 类目</span>
        <span>净 GSV / 销售占比</span>
        <span>推广花费 / 花费占比</span>
        <span>类目推广费率</span>
      </div>
      <div className="divide-y divide-slate-100">
        {rankedCategories.map((item, index) => {
          const revenueShare = share(item.revenue, totals.revenue);
          const spendShare = share(item.spend, totals.spend);
          return (
            <div
              key={item.key}
              className="grid gap-4 px-4 py-4 transition-colors hover:bg-sky-50/35 lg:grid-cols-[minmax(150px,0.8fr)_minmax(210px,1fr)_minmax(210px,1fr)_minmax(130px,0.6fr)] lg:items-center lg:gap-5 lg:px-5 lg:py-3.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center border border-sky-200 bg-sky-50 text-[10px] font-semibold text-sky-800">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <span className="text-[9px] font-semibold text-slate-400 lg:hidden">类目</span>
                  <strong className="block truncate text-sm font-semibold text-slate-800" title={item.name}>
                    {item.name || "--"}
                  </strong>
                </div>
              </div>

              {[
                {
                  label: "净 GSV",
                  value: money(item.revenue),
                  shareLabel: "销售占比",
                  shareValue: revenueShare,
                  scaleValue: Math.max(0, Math.min(1, item.revenue / maxRevenue)),
                  barClassName: "bg-emerald-600",
                },
                {
                  label: "推广花费",
                  value: money(item.spend),
                  shareLabel: "花费占比",
                  shareValue: spendShare,
                  scaleValue: Math.max(0, Math.min(1, item.spend / maxSpend)),
                  barClassName: "bg-blue-600",
                },
              ].map((metric) => (
                <div key={metric.label} className="min-w-0">
                  <div className="mb-1.5 flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <span className="block text-[9px] font-semibold text-slate-400 lg:hidden">{metric.label}</span>
                      <strong className="block truncate text-xs font-semibold text-slate-800" title={metric.value}>{metric.value}</strong>
                    </div>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {metric.shareLabel} <b className="text-sky-800">{percent(metric.shareValue)}</b>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden bg-slate-100">
                    <div
                      className={`category-contribution-bar h-full ${metric.barClassName}`}
                      style={{ width: `${(metric.scaleValue * 100).toFixed(2)}%` }}
                    />
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 lg:block lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                <span className="block text-[10px] font-semibold text-slate-500">类目推广费率</span>
                <span className={`inline-flex border px-2 py-1 text-xs font-semibold lg:mt-1.5 ${rateClassName(item.feeRate)}`}>
                  {percent(item.feeRate)}
                </span>
                <span className="hidden text-[9px] text-slate-400 lg:mt-1 lg:block">花费 ÷ 净 GSV</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-2 text-[10px] text-slate-500">
        <span>展示前 {rankedCategories.length} 个类目</span>
        <span>{activeCategories.length} 个有效类目参与占比计算</span>
      </div>
    </Card>
  );
}

function DashboardLineChart({
  data,
  selectedMetrics,
}: {
  data: OperationsWorkspace["dashboard"]["trend"];
  selectedMetrics: StoreTrendMetric[];
}) {
  if (!data.length)
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400">
        持续导入日报、周报或月报后展示趋势
      </div>
    );
  const chartData = data.map((item) => ({
    ...item,
    managementRoi: item.roi,
    roi: item.spend > 0 ? item.promotionRevenue / item.spend : null,
  }));
  const selectedLabel = selectedMetrics.map((metric) => STORE_TREND_METRICS[metric].label).join("、");
  const latest = chartData.at(-1);
  const trendValue = (metric: StoreTrendMetric) => {
    if (!latest) return "--";
    const value = latest[metric as keyof typeof latest];
    return formatCustomMetric(metric, typeof value === "number" ? value : null);
  };
  const formatTooltip = (value: number, name: string) => {
    const metric = name as StoreTrendMetric;
    const definition = STORE_TREND_METRICS[metric];
    return [formatCustomMetric(metric, value), definition?.label || name];
  };
  return (
    <div className="flex h-[286px] min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">经营趋势</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">
            {selectedLabel} · 按已导入报表的统计周期自动聚合
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
          {selectedMetrics.map((metric) => {
            const definition = STORE_TREND_METRICS[metric];
            return (
              <div key={metric} className="inline-flex items-baseline gap-1.5 text-xs">
                <span className="h-2 w-2 shrink-0" style={{ backgroundColor: definition.color }} />
                <span className="text-slate-500">{definition.label}</span>
                <span className="font-semibold text-slate-900">{trendValue(metric)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
          data={chartData}
          margin={{ top: 4, right: 10, left: 10, bottom: 0 }}
        >
          <CartesianGrid
            vertical={false}
            stroke="#e2e8f0"
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#64748b", fontSize: 10 }}
          />
          {selectedMetrics.map((metric) => <YAxis key={metric} yAxisId={metric} hide domain={["auto", "auto"]} />)}
          <Tooltip
            formatter={(value, name) => formatTooltip(Number(value), String(name))}
            contentStyle={{
              borderRadius: 6,
              borderColor: "#e2e8f0",
              boxShadow: "0 12px 30px rgba(15, 23, 42, .1)",
            }}
          />
          {selectedMetrics.map((metric) => {
            const definition = STORE_TREND_METRICS[metric];
            return (
              <Line
                key={metric}
                yAxisId={metric}
                type="monotone"
                dataKey={definition.dataKey}
                name={definition.dataKey}
                stroke={definition.color}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                activeDot={{ r: 4 }}
                connectNulls={false}
              />
            );
          })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const RecentImportList = memo(function RecentImportList({
  reports,
  selectedIds,
  busy,
  onSelectAll,
  onSelectDate,
  onToggleReport,
  onClearSelection,
  onDeleteSelected,
  onDelete,
}: {
  reports: OperationsWorkspace["reports"];
  selectedIds: Set<string>;
  busy: string;
  onSelectAll: (selected: boolean) => void;
  onSelectDate: (reports: OperationsDataReport[], selected: boolean) => void;
  onToggleReport: (id: string, selected: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onDelete: (id: string) => void;
}) {
  const storeGroups = useMemo(
    () => groupReportsByStoreAndStatisticsDate(reports),
    [reports],
  );
  const [expandedStore, setExpandedStore] = useState("");
  const [expandedPeriod, setExpandedPeriod] = useState("");
  const selectedReports = useMemo(
    () => reports.filter((report) => selectedIds.has(report.id)),
    [reports, selectedIds],
  );
  const allSelected = reports.length > 0 && selectedReports.length === reports.length;

  useEffect(() => {
    setExpandedStore((current) =>
      storeGroups.some((group) => group.key === current)
        ? current
        : (storeGroups[0]?.key || ""),
    );
    setExpandedPeriod((current) =>
      storeGroups.some((store) =>
        store.dateGroups.some((group) => `${store.key}\u0001${group.key}` === current),
      )
        ? current
        : "",
    );
  }, [storeGroups]);

  if (!reports.length)
    return (
      <div className="py-2 text-xs text-slate-400">
        暂无已导入报表。
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50 px-2.5 py-2">
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
          <input
            type="checkbox"
            aria-label="选择所有已导入报表"
            checked={allSelected}
            onChange={(event) => onSelectAll(event.target.checked)}
          />
          全选已导入
        </label>
        {selectedReports.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-500">已选 {selectedReports.length} 份</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-slate-600"
              onClick={onClearSelection}
            >
              取消选择
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 px-2 text-xs"
              disabled={busy === "delete-imported-selected"}
              onClick={onDeleteSelected}
            >
              {busy === "delete-imported-selected" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              批量删除
            </Button>
          </div>
        )}
      </div>
      {storeGroups.map((store) => {
        const storeExpanded = expandedStore === store.key;
        const storeSelected = store.reports.every((report) => selectedIds.has(report.id));
        return (
          <div key={store.key} className="border border-blue-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 bg-blue-50/80 px-2.5 py-2.5 hover:bg-blue-50">
              <input
                type="checkbox"
                aria-label={`选择店铺 ${store.label} 的所有报表`}
                checked={storeSelected}
                onChange={(event) => onSelectDate(store.reports, event.target.checked)}
              />
              <button
                type="button"
                aria-expanded={storeExpanded}
                onClick={() => {
                  setExpandedStore(storeExpanded ? "" : store.key);
                  setExpandedPeriod("");
                }}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {storeExpanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-blue-600" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-blue-600" />
                )}
                <span className="truncate text-xs font-semibold text-blue-950">
                  店铺 · {store.label}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-blue-600/80">
                  {store.dateGroups.length} 个日期 · {store.reports.length} 份
                </span>
              </button>
            </div>
            {storeExpanded && (
              <div className="space-y-1 border-t border-blue-100 p-1.5">
                {store.dateGroups.map((group) => {
                  const periodKey = `${store.key}\u0001${group.key}`;
                  const expanded = expandedPeriod === periodKey;
                  const groupSelected = group.reports.every((report) => selectedIds.has(report.id));
                  return (
                    <div key={periodKey} className="border border-slate-200 bg-white">
                      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          aria-label={`选择${store.label} ${group.scopeLabel} ${group.label}的所有报表`}
                          checked={groupSelected}
                          onChange={(event) => onSelectDate(group.reports, event.target.checked)}
                        />
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedPeriod(expanded ? "" : periodKey)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                          <span className="truncate text-xs font-semibold text-slate-700">{group.scopeLabel} {group.label}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-slate-400">{group.reports.length} 份 · {group.totalRows} 行</span>
                        </button>
                      </div>
                      {expanded && <div className="border-t border-slate-100 px-1 py-1">{group.reports.map((report) => (
                        <div key={report.id} className="flex min-w-0 items-center gap-2 px-2 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${report.fileName}`}
                      checked={selectedIds.has(report.id)}
                      onChange={(event) => onToggleReport(report.id, event.target.checked)}
                    />
                    <span className="text-emerald-600">
                      <FileSpreadsheet className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                      {report.fileName}
                    </span>
                    <span className="shrink-0 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {reportTypeLabels[report.type]}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {reportRowCount(report)} 行
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                      title={`删除 ${report.fileName}`}
                      aria-label={`删除 ${report.fileName}`}
                      disabled={busy === `delete-report-${report.id}`}
                      onClick={() => onDelete(report.id)}
                    >
                      {busy === `delete-report-${report.id}` ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                        </div>
                      ))}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const ArchiveReportRows = memo(function ArchiveReportRows({
  groups,
  selectedIds,
  busy,
  editingReportId,
  reportNameDraft,
  onSelectDate,
  onToggleReport,
  onBeginRename,
  onDraftChange,
  onSaveRename,
  onCancelRename,
  onDelete,
}: {
  groups: ReportStoreGroup[];
  selectedIds: Set<string>;
  busy: string;
  editingReportId: string;
  reportNameDraft: string;
  onSelectDate: (reports: OperationsDataReport[], selected: boolean) => void;
  onToggleReport: (id: string, selected: boolean) => void;
  onBeginRename: (id: string, fileName: string) => void;
  onDraftChange: (value: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onDelete: (id: string) => void;
}) {
  const [expandedStore, setExpandedStore] = useState("");
  const [expandedPeriod, setExpandedPeriod] = useState("");

  useEffect(() => {
    setExpandedStore((current) =>
      groups.some((group) => group.key === current)
        ? current
        : (groups[0]?.key || ""),
    );
    setExpandedPeriod((current) =>
      groups.some((store) =>
        store.dateGroups.some((group) => `${store.key}\u0001${group.key}` === current),
      )
        ? current
        : "",
    );
  }, [groups]);

  return (
    <tbody>
      {groups.length ? (
        groups.map((store) => {
          const storeExpanded = expandedStore === store.key;
          const storeSelected = store.reports.every((report) => selectedIds.has(report.id));
          return (
            <Fragment key={store.key}>
              <tr className="border-b border-blue-200 bg-blue-50/90">
                <td className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`选择店铺 ${store.label} 的所有文件`}
                    checked={storeSelected}
                    onChange={(event) => onSelectDate(store.reports, event.target.checked)}
                  />
                </td>
                <td colSpan={5} className="p-0">
                  <button
                    type="button"
                    aria-expanded={storeExpanded}
                    onClick={() => {
                      setExpandedStore((current) => current === store.key ? "" : store.key);
                      setExpandedPeriod("");
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-blue-100/70"
                  >
                    {storeExpanded ? <ChevronDown className="h-4 w-4 shrink-0 text-blue-600" /> : <ChevronRight className="h-4 w-4 shrink-0 text-blue-600" />}
                    <span className="font-semibold text-blue-950">店铺 · {store.label}</span>
                    <span className="text-xs text-blue-600/80">{store.dateGroups.length} 个日期 · {store.reports.length} 份文件 · {store.totalRows} 行</span>
                  </button>
                </td>
              </tr>
              {storeExpanded && store.dateGroups.map((group) => {
                const periodKey = `${store.key}\u0001${group.key}`;
                const expanded = expandedPeriod === periodKey;
                const groupSelected = group.reports.every((report) => selectedIds.has(report.id));
                return (
                  <Fragment key={periodKey}>
                    <tr className="border-b border-slate-200 bg-slate-50/80">
                      <td className="px-4 py-2 pl-8">
                        <input
                          type="checkbox"
                          aria-label={`选择${store.label} ${group.scopeLabel} ${group.label}的所有文件`}
                          checked={groupSelected}
                          onChange={(event) => onSelectDate(group.reports, event.target.checked)}
                        />
                      </td>
                      <td colSpan={5} className="p-0">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedPeriod((current) => current === periodKey ? "" : periodKey)}
                          className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-100"
                        >
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                          <span className="font-semibold text-slate-700">{group.scopeLabel} {group.label}</span>
                          <span className="text-xs text-slate-400">{group.reports.length} 份文件 · {group.totalRows} 行数据</span>
                        </button>
                      </td>
                    </tr>
                    {expanded && group.reports.map((report) => (
                <tr key={report.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${report.fileName}`}
                      checked={selectedIds.has(report.id)}
                      onChange={(event) => onToggleReport(report.id, event.target.checked)}
                    />
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-emerald-600"><FileSpreadsheet className="h-4 w-4" /></span>
                      {editingReportId === report.id ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <input
                            autoFocus
                            value={reportNameDraft}
                            onChange={(event) => onDraftChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                onSaveRename();
                              }
                              if (event.key === "Escape") onCancelRename();
                            }}
                            aria-label={`修改 ${report.fileName} 的归档名称`}
                            className="h-8 min-w-0 flex-1 border border-slate-300 bg-white px-2 text-sm text-slate-800"
                          />
                          <Button type="button" size="sm" className="h-8 w-8 shrink-0 p-0" title="保存归档名称" aria-label="保存归档名称" disabled={busy === `rename-report-${report.id}`} onClick={onSaveRename}>
                            {busy === `rename-report-${report.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" className="h-8 w-8 shrink-0 p-0" title="取消修改" aria-label="取消修改" onClick={onCancelRename}>
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <button type="button" className="group flex min-w-0 flex-1 items-center gap-1 text-left" title="点击修改归档显示名称" onClick={() => onBeginRename(report.id, report.fileName)}>
                          <span className="truncate font-medium text-slate-800 group-hover:text-blue-700">{report.fileName}</span>
                          <PenLine className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-blue-600" />
                        </button>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{timestamp(report.importedAt)}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {report.periodLabel || report.reportDate}
                    <div className="mt-1 text-xs text-slate-400">{periodKindLabels[report.periodKind]} · {reportStoreName(report)}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {reportTypeLabels[report.type]}
                    <div className="mt-1 text-xs text-slate-400">{report.sourceName || "未标记来源"}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{reportRowCount(report)} 行</td>
                  <td className="px-4 py-3 text-right">
                    <Button type="button" size="sm" variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" disabled={busy === `delete-report-${report.id}`} onClick={() => onDelete(report.id)}>
                      {busy === `delete-report-${report.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      删除
                    </Button>
                  </td>
                </tr>
                    ))}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })
      ) : (
        <tr>
          <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">暂无符合筛选条件的归档记录。</td>
        </tr>
      )}
    </tbody>
  );
});

export function OperationsAssistant({
  workspace,
  onUpload,
  onUploadProductCatalog,
  onSaveProductCatalogEntry,
  onExportProductCatalog,
  onPreview,
  onDeleteReport,
  onRenameReport,
  onCreateStore,
  onDeleteStore,
  onAssignReportsStore,
  onSaveSalesDeduction,
  onDeleteSalesDeduction,
  onAnalyze,
  onClearAnalyses,
  onRunDailyReport,
  onLoadWorkspace,
  onLoadArchive,
  onActivateCloudSync,
  onRunCloudSync,
  onDisconnectCloudSync,
}: OperationsAssistantProps) {
  const cloudSync = workspace.cloudSync || disconnectedCloudSync;
  const [view, setView] = useState<View>("store");
  const [warehousePanel, setWarehousePanel] = useState<WarehousePanel>("import");
  const [reportType, setReportType] = useState<OperationsReportType | "">("");
  const [reportTypePickerOpen, setReportTypePickerOpen] = useState(false);
  const [uploadGuideOpen, setUploadGuideOpen] = useState(false);
  const [periodKind, setPeriodKind] = useState<OperationsPeriodKind>("day");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [storeName, setStoreName] = useState("");
  const [newStoreName, setNewStoreName] = useState("");
  const [addingStore, setAddingStore] = useState(false);
  const [storeDeleteCandidate, setStoreDeleteCandidate] = useState("");
  const [storePickerOpen, setStorePickerOpen] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const [selectedReport, setSelectedReport] = useState<File | null>(null);
  const [reportPreview, setReportPreview] = useState<ReportPreview | null>(null);
  const [reportBatch, setReportBatch] = useState<ReportBatchItem[]>([]);
  const [activeReportId, setActiveReportId] = useState("");
  const [reportBatchProgress, setReportBatchProgress] = useState({ completed: 0, total: 0 });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedData, setPastedData] = useState("");
  const [archiveType, setArchiveType] = useState<OperationsReportType | "all">(
    "all",
  );
  const [archiveStore, setArchiveStore] = useState("all");
  const [datePreset, setDatePreset] = useState<DashboardDatePreset>("yesterday");
  const [displayStart, setDisplayStart] = useState(
    () => dashboardDateRange("yesterday").start,
  );
  const [displayEnd, setDisplayEnd] = useState(
    () => dashboardDateRange("yesterday").end,
  );
  const [appliedDateRange, setAppliedDateRange] = useState(() =>
    dashboardDateRange("yesterday"),
  );
  const [customDatePickerOpen, setCustomDatePickerOpen] = useState(false);
  const [displayStore, setDisplayStore] = useState("");
  const [sourcePeriodKind, setSourcePeriodKind] = useState<OperationsSourcePeriodKind>("auto");
  const [selectedTrendMetrics, setSelectedTrendMetrics] = useState<StoreTrendMetric[]>(["revenue"]);
  const [analysis, setAnalysis] = useState<OperationsAnalysis | null>(
    workspace.analyses[0] || null,
  );
  const [uploadFeedback, setUploadFeedback] = useState<{
    id: string;
    fileName: string;
    rowCount: number;
    successCount?: number;
    failureCount?: number;
  } | null>(null);
  const [selectedArchiveIds, setSelectedArchiveIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedImportedReportIds, setSelectedImportedReportIds] = useState<
    Set<string>
  >(new Set());
  const [archiveData, setArchiveData] = useState(() => ({
    reports: workspace.reports,
    archive: workspace.archive,
  }));
  const [archiveAssignmentStore, setArchiveAssignmentStore] = useState("");
  const [storeFeedback, setStoreFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [editingReportId, setEditingReportId] = useState("");
  const [reportNameDraft, setReportNameDraft] = useState("");
  const [deductionPanelOpen, setDeductionPanelOpen] = useState(false);
  const [deductionStore, setDeductionStore] = useState("");
  const [deductionDate, setDeductionDate] = useState("");
  const [deductionAmount, setDeductionAmount] = useState("");
  const [deductionNote, setDeductionNote] = useState("");
  const [selectedCatalogFile, setSelectedCatalogFile] = useState<File | null>(null);
  const [catalogStoreName, setCatalogStoreName] = useState("");
  const [catalogProductId, setCatalogProductId] = useState("");
  const [catalogCategory, setCatalogCategory] = useState("");
  const [catalogModel, setCatalogModel] = useState("");
  const [catalogFeedback, setCatalogFeedback] = useState("");
  const [catalogPage, setCatalogPage] = useState(0);
  const [cloudEndpoint, setCloudEndpoint] = useState(cloudSync.endpoint || "https://jvspp.cloud");
  const [cloudCode, setCloudCode] = useState("");
  const [cloudDeviceName, setCloudDeviceName] = useState(cloudSync.deviceName || "");
  const [cloudSetupOpen, setCloudSetupOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const reportFileInput = useRef<HTMLInputElement>(null);
  const catalogFileInput = useRef<HTMLInputElement>(null);

  const uploadRequirements = useMemo(
    () => [
      !selectedReport || !reportPreview ? "数据文件" : "",
      !reportType ? "报表类型" : "",
      !storeName ? "归属店铺" : "",
      !periodStart || !periodEnd || periodStart > periodEnd ? "有效统计日期" : "",
    ].filter(Boolean),
    [periodEnd, periodStart, reportPreview, reportType, selectedReport, storeName],
  );
  const pendingReportBatch = reportBatch.filter((item) => item.status !== "success");
  const invalidReportBatch = pendingReportBatch.filter((item) => (
    !item.preview
    || !item.reportType
    || !item.periodStart
    || !item.periodEnd
    || item.periodStart > item.periodEnd
    || item.status === "preview-error"
    || item.status === "previewing"
  ));
  const canUploadReport =
    reportBatch.length > 0 &&
    pendingReportBatch.length > 0 &&
    invalidReportBatch.length === 0 &&
    Boolean(storeName) &&
    busy !== "upload" &&
    busy !== "preview-reports";
  const showUploadRequirements = reportBatch.length > 0;

  useEffect(
    () => setAnalysis(workspace.analyses[0] || null),
    [workspace.analyses],
  );
  useEffect(() => {
    setCloudEndpoint(cloudSync.endpoint || "https://jvspp.cloud");
    setCloudDeviceName((current) => current || cloudSync.deviceName || "");
  }, [cloudSync.deviceName, cloudSync.endpoint]);
  useEffect(
    () =>
      setSelectedArchiveIds(
        (current) =>
          new Set(
            [...current].filter((id) =>
              archiveData.reports.some((report) => report.id === id),
            ),
          ),
      ),
    [archiveData.reports],
  );

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作未完成。");
    } finally {
      setBusy("");
    }
  }, []);

  const refreshArchive = useCallback(async () => {
    setArchiveData(await onLoadArchive());
  }, [onLoadArchive]);

  useEffect(() => {
    if (view !== "warehouse") return;
    void run("load-archive", refreshArchive);
  }, [refreshArchive, run, view]);

  const selectedDateRange = appliedDateRange;

  useEffect(() => {
    const { start, end } = selectedDateRange;
    if (!start || !end || start > end) return;
    const filters = workspace.filters;
    if (
      filters?.periodKind === "custom" &&
      (filters.sourcePeriodKind || "all") === sourcePeriodKind &&
      filters.start === start &&
      filters.end === end &&
      (filters.storeName || "") === displayStore
    ) {
      return;
    }
    void run("scope", async () => {
      await onLoadWorkspace({
        periodKind: "custom",
        sourcePeriodKind,
        start,
        end,
        storeName: displayStore,
      });
    });
  }, [
    displayStore,
    onLoadWorkspace,
    run,
    selectedDateRange.end,
    selectedDateRange.start,
    workspace.filters,
    sourcePeriodKind,
  ]);

  function updateReportBatchItem(id: string, changes: Partial<ReportBatchItem>) {
    setReportBatch((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  function activateReportItem(item: ReportBatchItem | null) {
    setActiveReportId(item?.id || "");
    setSelectedReport(item?.file || null);
    setReportPreview(item?.preview || null);
    setReportType(item?.reportType || "");
    setPeriodKind(item?.periodKind || "day");
    setPeriodStart(item?.periodStart || "");
    setPeriodEnd(item?.periodEnd || "");
    setReportTypePickerOpen(false);
  }

  function removeReportBatchItem(id: string) {
    if (busy === "upload" || busy === "preview-reports") return;
    const nextBatch = reportBatch.filter((item) => item.id !== id);
    setReportBatch(nextBatch);
    if (activeReportId === id) activateReportItem(nextBatch[0] || null);
  }

  async function previewReportItem(item: ReportBatchItem, activateWhenReady = false) {
    try {
      const preview = await onPreview(item.file);
      if (preview.kind === "screenshot") {
        throw new Error("请选择可计算数据文件，支持 XLS、XLSX、CSV 或 JSON。");
      }
      const exactRowCount = Number.isFinite(preview.rowCount);
      const rowCount = exactRowCount ? Number(preview.rowCount) : preview.sampleRows.length;
      if (!rowCount || !preview.columns.length) {
        throw new Error("没有识别到可计算的数据行，请确认文件第一行是表头。");
      }
      const normalizedPreview: ReportPreview = { ...preview, rowCount, exactRowCount };
      const detectedType = preview.detectedType && manualReportTypes.includes(preview.detectedType)
        ? preview.detectedType
        : "";
      const nextItem: ReportBatchItem = {
        ...item,
        preview: normalizedPreview,
        reportType: detectedType,
        periodKind: preview.period ? periodKindForRange(preview.period.start, preview.period.end) : "day",
        periodStart: preview.period?.start || "",
        periodEnd: preview.period?.end || "",
        status: "ready",
        error: "",
      };
      updateReportBatchItem(item.id, nextItem);
      if (activateWhenReady || activeReportId === item.id) activateReportItem(nextItem);
      return nextItem;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "文件识别失败，请重试。";
      const failedItem: ReportBatchItem = { ...item, preview: null, status: "preview-error", error: message };
      updateReportBatchItem(item.id, failedItem);
      if (activateWhenReady || activeReportId === item.id) activateReportItem(failedItem);
      return failedItem;
    }
  }

  async function inspectReports(files: File[]) {
    if (!files.length || busy === "upload" || busy === "preview-reports") return;
    const known = new Set(reportBatch.map((item) => `${item.file.name}\u0000${item.file.size}\u0000${item.file.lastModified}`));
    const additions = files
      .filter((file) => !known.has(`${file.name}\u0000${file.size}\u0000${file.lastModified}`))
      .map<ReportBatchItem>((file) => ({
        id: `local-report-${crypto.randomUUID()}`,
        file,
        preview: null,
        reportType: "",
        periodKind: "day",
        periodStart: "",
        periodEnd: "",
        status: "previewing",
        error: "",
      }));
    if (!additions.length) {
      setError("所选文件已经在批量清单中；如需重新选择，请先从清单移除。");
      return;
    }
    const activateFirst = !activeReportId;
    setError("");
    setUploadFeedback(null);
    setReportBatch((current) => [...current, ...additions]);
    if (activateFirst) activateReportItem(additions[0]);
    setBusy("preview-reports");
    setReportBatchProgress({ completed: 0, total: additions.length });
    try {
      for (let index = 0; index < additions.length; index += 1) {
        await previewReportItem(additions[index], activateFirst && index === 0);
        setReportBatchProgress({ completed: index + 1, total: additions.length });
      }
    } finally {
      setBusy("");
    }
  }

  async function retryReportPreview(item: ReportBatchItem) {
    if (busy) return;
    updateReportBatchItem(item.id, { status: "previewing", error: "" });
    setBusy("preview-reports");
    setReportBatchProgress({ completed: 0, total: 1 });
    try {
      await previewReportItem({ ...item, status: "previewing", error: "" }, activeReportId === item.id);
      setReportBatchProgress({ completed: 1, total: 1 });
    } finally {
      setBusy("");
    }
  }

  const uploadPayload = (
    type: OperationsReportType = reportType || "market",
    item?: Pick<ReportBatchItem, "periodKind" | "periodStart" | "periodEnd">,
  ) => ({
    type,
    storeName,
    reportDate: item?.periodEnd ?? periodEnd,
    periodKind: item?.periodKind ?? periodKind,
    periodStart: item?.periodStart ?? periodStart,
    periodEnd: item?.periodEnd ?? periodEnd,
    sourceName,
  });

  async function createStore() {
    const name = newStoreName.trim();
    if (!name) {
      setError("请输入要新增的店铺名称。");
      return;
    }
    setStoreFeedback(null);
    await run("create-store", async () => {
      try {
        await onCreateStore(name);
        setStoreName(name);
        setNewStoreName("");
        setAddingStore(false);
        setStoreFeedback({ tone: "success", message: `已添加“${name}”，当前已选中。` });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "店铺添加失败，请重试。";
        setStoreFeedback({ tone: "error", message });
        throw reason;
      }
    });
  }

  async function deleteStore() {
    const name = storeDeleteCandidate.trim();
    if (!name || name === "未归属店铺") return;
    setStoreFeedback(null);
    await run("delete-store", async () => {
      try {
        await onDeleteStore(name);
        setStoreName((current) => current === name ? "" : current);
        setDisplayStore((current) => current === name ? "" : current);
        setArchiveStore((current) => current === name ? "all" : current);
        setCatalogStoreName((current) => current === name ? "" : current);
        setStoreDeleteCandidate("");
        await refreshArchive();
        setStoreFeedback({ tone: "success", message: `已删除“${name}”；关联数据已转为未归属店铺。` });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "店铺删除失败，请重试。";
        setStoreFeedback({ tone: "error", message });
        throw reason;
      }
    });
  }

  async function uploadReport() {
    if (!storeName) {
      setError("请选择归属店铺；没有时可先新增店铺。");
      return;
    }
    const pending = reportBatch.filter((item) => item.status !== "success");
    if (!pending.length) {
      setError("请先批量选择要导入的数据文件。");
      return;
    }
    const invalid = pending.find((item) => (
      !item.preview
      || !item.reportType
      || !item.periodStart
      || !item.periodEnd
      || item.periodStart > item.periodEnd
      || item.status === "preview-error"
      || item.status === "previewing"
    ));
    if (invalid) {
      activateReportItem(invalid);
      setError(`请先补全“${invalid.file.name}”的报表类型和有效统计日期。`);
      return;
    }
    setBusy("upload");
    setError("");
    setReportBatchProgress({ completed: 0, total: pending.length });
    let successCount = 0;
    let failureCount = 0;
    let lastSuccess: { id: string; fileName: string; rowCount: number } | null = null;
    let firstFailureItem: ReportBatchItem | null = null;
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      updateReportBatchItem(item.id, { status: "uploading", error: "" });
      try {
        const next = await onUpload(item.file, uploadPayload(item.reportType as OperationsReportType, item));
        const report = next.reports.find((candidate) => candidate.fileName === item.file.name) || next.reports[0];
        const importedRowCount = report ? reportRowCount(report) : item.preview?.rowCount || 0;
        updateReportBatchItem(item.id, {
          status: "success",
          error: "",
          reportId: report?.id || "",
          importedRowCount,
        });
        lastSuccess = { id: report?.id || "", fileName: item.file.name, rowCount: importedRowCount };
        successCount += 1;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "导入失败，请修正后重试。";
        updateReportBatchItem(item.id, { status: "upload-error", error: message });
        firstFailureItem ||= { ...item, status: "upload-error", error: message };
        failureCount += 1;
      }
      setReportBatchProgress({ completed: index + 1, total: pending.length });
    }
    try {
      await refreshArchive();
    } catch (reason) {
      setError(reason instanceof Error ? `报表已导入，但数据仓刷新失败：${reason.message}` : "报表已导入，但数据仓刷新失败，请重新进入数据仓库。");
    } finally {
      setBusy("");
    }
    if (lastSuccess) {
      setUploadFeedback({
        ...lastSuccess,
        successCount,
        failureCount,
      });
    }
    if (failureCount) {
      setError(`${failureCount} 份报表导入失败；已成功的不会重复导入，修正失败项后可直接重试。`);
      if (firstFailureItem) activateReportItem(firstFailureItem);
    }
  }

  async function uploadCatalog() {
    if (!selectedCatalogFile) {
      setError("请选择包含店铺名、ID、品类名、型号的 ID 型号表。" );
      return;
    }
    await run("catalog-upload", async () => {
      const next = await onUploadProductCatalog(selectedCatalogFile);
      const added = Math.max(0, next.productCatalog.length - (workspace.productCatalog?.length ?? 0));
      setCatalogFeedback(`已追加 ${added || "新的"} 条资料；当前版本已联动商品与品类数据。`);
      setSelectedCatalogFile(null);
    });
  }

  async function saveCatalogEntry() {
    const store = catalogStoreName.trim();
    const productId = catalogProductId.trim();
    const category = catalogCategory.trim();
    const model = catalogModel.trim();
    if (!store || !productId || (!category && !model)) {
      setError("请填写店铺、商品 ID，以及至少一项品类或型号。" );
      return;
    }
    await run("catalog-save", async () => {
      await onSaveProductCatalogEntry({ storeName: store, productId, category, model });
      setCatalogFeedback(`已保存 ${store} / ${productId} 的新版本，历史记录已保留。`);
      setCatalogProductId("");
      setCatalogCategory("");
      setCatalogModel("");
    });
  }

  async function exportCatalog() {
    await run("catalog-export", onExportProductCatalog);
  }

  async function uploadPastedData() {
    const file = pastedDataFile(pastedData);
    if (!file) {
      setError("请先粘贴 Excel/WPS 表格或 JSON 数据。");
      return;
    }
    if (!reportType) {
      setError("请选择报表类型后再导入，系统不会自动猜测。 ");
      return;
    }
    if (!storeName) {
      setError("请选择归属店铺；没有时可先新增店铺。");
      return;
    }
    await run("paste", async () => {
      const next = await onUpload(file, uploadPayload(reportType));
      const report = next.reports[0];
      setUploadFeedback({
        id: report?.id || "",
        fileName: report?.fileName || file.name,
        rowCount: report ? reportRowCount(report) : 0,
      });
      await refreshArchive();
      setPastedData("");
      setPasteOpen(false);
    });
  }

  async function deleteImportedReport(id: string) {
    await run(`delete-report-${id}`, async () => {
      await onDeleteReport(id);
      await refreshArchive();
      setSelectedImportedReportIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setSelectedArchiveIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (uploadFeedback?.id === id) setUploadFeedback(null);
    });
  }

  async function deleteSelectedImportedReports() {
    const ids = recentDataReports
      .filter((report) => selectedImportedReportIds.has(report.id))
      .map((report) => report.id);
    if (!ids.length) return;
    await run("delete-imported-selected", async () => {
      for (const id of ids) await onDeleteReport(id);
      await refreshArchive();
      setSelectedImportedReportIds(new Set());
      setSelectedArchiveIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      if (uploadFeedback?.id && ids.includes(uploadFeedback.id)) {
        setUploadFeedback(null);
      }
    });
  }

  function beginReportRename(id: string, fileName: string) {
    setEditingReportId(id);
    setReportNameDraft(fileName);
  }

  async function saveReportRename() {
    const fileName = reportNameDraft.trim();
    if (!editingReportId || !fileName) {
      setError("请输入归档显示名称。");
      return;
    }
    const id = editingReportId;
    await run(`rename-report-${id}`, async () => {
      await onRenameReport(id, fileName);
      await refreshArchive();
      setEditingReportId("");
      setReportNameDraft("");
    });
  }
  async function deleteSelectedReports() {
    await run("delete-selected", async () => {
      for (const id of selectedArchiveIds) await onDeleteReport(id);
      await refreshArchive();
      setSelectedArchiveIds(new Set());
    });
  }
  async function assignSelectedReportsStore() {
    if (!selectedArchiveIds.size) return;
    if (!archiveAssignmentStore) {
      setError("请选择要归属的已有店铺。");
      return;
    }
    await run("assign-report-store", async () => {
      await onAssignReportsStore([...selectedArchiveIds], archiveAssignmentStore);
      await refreshArchive();
      setSelectedArchiveIds(new Set());
      setArchiveAssignmentStore("");
    });
  }
  function chooseDatePreset(next: DashboardDatePreset) {
    setDatePreset(next);
    if (next === "custom") {
      setDisplayStart(appliedDateRange.start);
      setDisplayEnd(appliedDateRange.end);
      setCustomDatePickerOpen(true);
      return;
    }
    setCustomDatePickerOpen(false);
    const range = dashboardDateRange(next);
    setDisplayStart(range.start);
    setDisplayEnd(range.end);
    setAppliedDateRange(range);
  }
  function applyCustomDateRange() {
    if (!displayStart || !displayEnd || displayStart > displayEnd) {
      setError("请选择有效的自定义日期范围。");
      return;
    }
    setError("");
    setAppliedDateRange({ start: displayStart, end: displayEnd });
    setCustomDatePickerOpen(false);
  }
  function toggleTrendMetric(metric: StoreTrendMetric) {
    setSelectedTrendMetrics((current) => {
      if (current.includes(metric)) {
        return current.length === 1 ? current : current.filter((item) => item !== metric);
      }
      return [...current, metric];
    });
  }
  function openSalesDeductionPanel() {
    setDeductionStore((current) => current || dashboardStores[0] || "");
    setDeductionDate((current) => current || workspace.currentDate || new Date().toISOString().slice(0, 10));
    setDeductionPanelOpen(true);
  }

  async function saveSalesDeduction() {
    const amount = Number(deductionAmount);
    if (!deductionStore) {
      setError("请先选择要扣除销售的店铺。");
      return;
    }
    if (!deductionDate) {
      setError("请选择这笔销售对应的统计日期。");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("请输入大于 0 的扣除金额。");
      return;
    }
    await run("sales-deduction", async () => {
      await onSaveSalesDeduction({
        storeName: deductionStore,
        reportDate: deductionDate,
        amount,
        note: deductionNote.trim(),
      });
      setDeductionAmount("");
      setDeductionNote("");
    });
  }

  async function deleteSalesDeduction(id: string) {
    if (!window.confirm("删除这笔销售扣除？经营指标会立即按原始报表重新计算。")) return;
    await run(`sales-deduction-${id}`, async () => {
      await onDeleteSalesDeduction(id);
    });
  }

  async function clearAnalyses() {
    if (!window.confirm("确定清空全部运营分析？原始报表、经营数据、推广建议备注和 Agent 对话都会保留。")) return;
    await run("clear-analyses", async () => {
      await onClearAnalyses();
      setAnalysis(null);
    });
  }

  const tabs: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
    { id: "store", label: "店铺经营", icon: BarChart3 },
    { id: "category", label: "品类360", icon: Layers3 },
    { id: "product", label: "商品排行", icon: Target },
    { id: "warehouse", label: "数据仓库", icon: Database },
  ];
  const dashboard = workspace.dashboard;
  const store = dashboard.store;
  const storePromotionCoverageComplete = dashboard.sourceCoverage?.storePromotionComplete !== false;
  const stores = dashboard.stores;
  const products = dashboard.products;
  const categories = dashboard.categories;
  const archive = archiveData.archive || {
    days: [],
    totalReports: archiveData.reports.length,
    totalRows: archiveData.reports.reduce(
      (sum, report) => sum + reportRowCount(report),
      0,
    ),
  };
  const storeOptions = [
    ...new Set([
      ...(workspace.storeNames || []),
      ...workspace.reports.map((report) => report.storeName).filter(Boolean),
      ...archiveData.reports.map((report) => report.storeName).filter(Boolean),
    ]),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  // Older local workspaces predate the product catalog. Keep those records
  // readable while the server normalizes them on the next persistence cycle.
  const productCatalog = useMemo(
    () => Array.isArray(workspace.productCatalog) ? workspace.productCatalog : [],
    [workspace.productCatalog],
  );
  const activeProductCatalog = useMemo(() => {
    const latest = new Map<string, OperationsWorkspace["productCatalog"][number]>();
    for (const entry of [...productCatalog].reverse()) {
      const key = `${entry.storeName.trim().toLowerCase()}\u0000${entry.productId.trim()}`;
      if (!latest.has(key)) latest.set(key, entry);
    }
    return [...latest.values()].sort((left, right) => (
      left.storeName.localeCompare(right.storeName, "zh-CN")
      || left.category.localeCompare(right.category, "zh-CN")
      || left.productId.localeCompare(right.productId)
    ));
  }, [productCatalog]);
  const catalogPageCount = Math.max(
    1,
    Math.ceil(activeProductCatalog.length / PRODUCT_CATALOG_PAGE_SIZE),
  );
  const visibleProductCatalog = useMemo(() => {
    const safePage = Math.min(catalogPage, catalogPageCount - 1);
    const start = safePage * PRODUCT_CATALOG_PAGE_SIZE;
    return activeProductCatalog.slice(start, start + PRODUCT_CATALOG_PAGE_SIZE);
  }, [activeProductCatalog, catalogPage, catalogPageCount]);
  const catalogVersionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of productCatalog) {
      const key = `${entry.storeName.trim().toLowerCase()}\u0000${entry.productId.trim()}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [productCatalog]);

  useEffect(() => {
    setCatalogPage((current) => Math.min(current, catalogPageCount - 1));
  }, [catalogPageCount]);
  const archiveStores = [
    ...new Set([
      ...storeOptions,
      ...archiveData.reports.map((report) => report.storeName).filter(Boolean),
    ]),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const filteredReports = useMemo(
    () =>
      archiveData.reports.filter(
        (report) =>
          report.kind !== "screenshot" &&
          (archiveType === "all" || report.type === archiveType) &&
          (archiveStore === "all" ||
            (report.storeName || "未标记店铺") === archiveStore),
      ),
    [archiveData.reports, archiveStore, archiveType],
  );
  const filteredReportGroups = useMemo(
    () => groupReportsByStoreAndStatisticsDate(filteredReports),
    [filteredReports],
  );
  const recentDataReports = useMemo(
    () => archiveData.reports.filter((report) => report.kind !== "screenshot"),
    [archiveData.reports],
  );
  const importedDataCount = archiveData.reports.filter(
    (report) => report.kind !== "screenshot",
  ).length;
  const dashboardStores = [
    ...new Set(
      [...storeOptions, ...workspace.reports.map((report) => report.storeName)].filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const analysisOutdated = Boolean(
    analysis &&
      workspace.freshness.latestAt &&
      Date.parse(analysis.createdAt) < Date.parse(workspace.freshness.latestAt),
  );
  const productRevenueBars = products
    .slice()
    .filter((item) => Number.isFinite(item.revenue) && item.revenue > 0)
    .sort((left, right) => right.revenue - left.revenue)
    .map((item) => ({
      key: item.key,
      id: item.productId,
      name: item.model || "型号待补",
      value: item.revenue,
    }));
  const productSpendBars = products
    .slice()
    .filter((item) => Number.isFinite(item.spend) && item.spend > 0)
    .sort((left, right) => right.spend - left.spend)
    .map((item) => ({
      key: item.key,
      id: item.productId,
      name: item.model || "型号待补",
      value: item.spend,
    }));
  const categoryRevenueBars = categories
    .slice()
    .filter((item) => Number.isFinite(item.revenue) && item.revenue > 0)
    .sort((left, right) => right.revenue - left.revenue)
    .map((item) => ({
      key: item.key,
      name: item.name,
      value: item.revenue,
    }));
  const categoryFeeRateBars = categories
    .filter((item) => item.feeRate !== null && Number(item.feeRate) > 0)
    .sort((left, right) => Number(right.feeRate) - Number(left.feeRate))
    .map((item) => ({
      key: item.key,
      name: item.name,
      value: Number(item.feeRate) * 100,
    }));

  const selectedAllVisible =
    filteredReports.length > 0 &&
    filteredReports.every((report) => selectedArchiveIds.has(report.id));

  function setArchiveDateSelection(
    reports: OperationsDataReport[],
    selected: boolean,
  ) {
    setSelectedArchiveIds((current) => {
      const next = new Set(current);
      for (const report of reports) {
        if (selected) next.add(report.id);
        else next.delete(report.id);
      }
      return next;
    });
  }

  function setImportedDateSelection(
    reports: OperationsDataReport[],
    selected: boolean,
  ) {
    setSelectedImportedReportIds((current) => {
      const next = new Set(current);
      for (const report of reports) {
        if (selected) next.add(report.id);
        else next.delete(report.id);
      }
      return next;
    });
  }

  const activeScope = workspace.filters?.start && workspace.filters?.end
    ? `${workspace.filters.start} 至 ${workspace.filters.end}`
    : "最新统计周期";
  const activeScopeRows = workspace.reports.reduce((sum, report) => sum + reportRowCount(report), 0);

  return (
    <div className="space-y-6">
      <section className={`relative border border-teal-100 bg-white/95 shadow-[0_12px_36px_rgba(15,23,42,0.06)] backdrop-blur-md ${customDatePickerOpen ? "z-40 overflow-visible" : "overflow-hidden"}`}>
        <div className="flex flex-col gap-3 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="运营数据视图" className="flex w-full gap-1 overflow-x-auto border border-slate-200 bg-slate-50/80 p-1 lg:w-auto lg:shrink-0">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = tab.id === view;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setView(tab.id);
                    if (tab.id === "warehouse") setWarehousePanel("import");
                  }}
                  aria-pressed={active}
                  className={`inline-flex h-10 shrink-0 items-center gap-1.5 border px-2.5 text-sm font-semibold transition-colors ${active ? "border-teal-700 bg-teal-700 text-white shadow-sm" : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-white hover:text-slate-800"}`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
          <div className="flex flex-wrap gap-2">
            <div className="group relative">
              <Button
                type="button"
                variant="secondary"
                onClick={openSalesDeductionPanel}
                disabled={Boolean(busy) || !dashboardStores.length}
                aria-label="销售扣除"
                title={dashboardStores.length ? "扣除指定日期的大单销售，自动重算整店经营指标" : "请先导入带店铺名称的经营报表"}
                className="h-10 w-10 px-0"
              >
                <PenLine className="h-4 w-4" />
              </Button>
              <span role="tooltip" className="pointer-events-none absolute right-0 top-[calc(100%+0.4rem)] z-20 hidden whitespace-nowrap border border-slate-200 bg-slate-900 px-2 py-1 text-xs text-white shadow-lg group-hover:block group-focus-within:block">
                销售扣除{dashboard.totalSalesDeduction > 0 ? ` ${money(dashboard.totalSalesDeduction)}` : ""}
              </span>
            </div>
            <div className="group relative">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void run("daily", async () => {
                    const result = await onRunDailyReport();
                    setAnalysis(result.analysis);
                    if (!result.sent && result.sendError)
                      setError(result.sendError);
                  })
                }
                disabled={Boolean(busy)}
                aria-label="发送日报"
                title="按当前数据生成并发送日报"
                className="h-10 w-10 px-0"
              >
                <Send className="h-4 w-4" />
              </Button>
              <span role="tooltip" className="pointer-events-none absolute right-0 top-[calc(100%+0.4rem)] z-20 hidden whitespace-nowrap border border-slate-200 bg-slate-900 px-2 py-1 text-xs text-white shadow-lg group-hover:block group-focus-within:block">
                发送日报
              </span>
            </div>
            <Button
              type="button"
              onClick={() =>
                void run("analyze", async () => setAnalysis(await onAnalyze()))
              }
              disabled={Boolean(busy) || !workspace.reports.length}
            >
              {busy === "analyze" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              运行分析
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-teal-100 bg-teal-50/35 px-5 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold text-slate-500">统计范围</span>
            {([
              ["today", "今天"],
              ["yesterday", "昨天"],
              ["last-7-days", "近 7 日"],
              ["last-15-days", "近 15 日"],
              ["this-week", "本周"],
              ["last-week", "上周"],
              ["this-month", "本月"],
              ["last-month", "上月"],
              ["custom", "自定义"],
            ] as Array<[DashboardDatePreset, string]>).map(([value, label]) => (
              <div key={value} className={value === "custom" ? "relative" : undefined}>
                <button
                  type="button"
                  onClick={() => chooseDatePreset(value)}
                  disabled={busy === "scope"}
                  className={`h-8 border px-2.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${datePreset === value ? "border-teal-700 bg-teal-700 text-white shadow-sm" : "border-slate-200 bg-white/90 text-slate-700 hover:border-teal-400 hover:text-teal-800"}`}
                >
                  {label}
                </button>
                {value === "custom" && customDatePickerOpen && (
                  <div className="absolute left-0 top-10 z-50 w-[332px] border border-teal-200 bg-white p-3 shadow-xl">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-slate-700">自定义统计日期</span>
                      <button
                        type="button"
                        onClick={() => setCustomDatePickerOpen(false)}
                        aria-label="关闭自定义日期"
                        className="grid h-6 w-6 place-items-center text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <label className="space-y-1 text-xs font-semibold text-slate-500">
                        <span>开始</span>
                        <input
                          type="date"
                          value={displayStart}
                          onChange={(event) => setDisplayStart(event.target.value)}
                          className="block h-8 w-full border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-semibold text-slate-500">
                        <span>结束</span>
                        <input
                          type="date"
                          value={displayEnd}
                          onChange={(event) => setDisplayEnd(event.target.value)}
                          className="block h-8 w-full border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        onClick={applyCustomDateRange}
                        disabled={busy === "scope"}
                        className="h-8 gap-1 px-2.5"
                      >
                        {busy === "scope" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        确定
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-1 text-xs font-semibold text-slate-500">
              <span>口径</span>
              <select
                value={sourcePeriodKind}
                onChange={(event) => setSourcePeriodKind(event.target.value as OperationsSourcePeriodKind)}
                className="block h-8 min-w-28 border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
              >
                <option value="auto">自动匹配</option>
                <option value="day">日报</option>
                <option value="week">周报</option>
                <option value="month">月报</option>
                <option value="custom">自定义周期</option>
                <option value="all">全部口径</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs font-semibold text-slate-500">
              <span>店铺</span>
              <select
                value={displayStore}
                onChange={(event) => setDisplayStore(event.target.value)}
                className="block h-8 min-w-32 border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
              >
                <option value="">全部店铺</option>
                {dashboardStores.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <div className="flex h-8 items-center gap-1.5 border-l border-teal-100 pl-2 text-xs text-slate-500">
              {busy === "scope" ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />同步中</> : <><Check className="h-3.5 w-3.5 text-emerald-600" />已纳入 {workspace.reports.length} 份 / {activeScopeRows} 行</>}
            </div>
            <span
              className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium ${workspace.freshness.fresh ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}
              title={`最近导入 ${timestamp(workspace.freshness.latestAt)} · ${importedDataCount} 份可计算报表`}
            >
              <Clock3 className="h-3.5 w-3.5" />
              {workspace.freshness.fresh ? "数据可用" : "数据已过期"}
            </span>
            <span className="hidden text-xs font-medium text-slate-600 2xl:inline">{activeScope}</span>
          </div>
        </div>
      </section>
      {error && (
        <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {view === "store" && (
        <div className="space-y-5">
          <MetricCardGrid
            panel="store"
            coreCards={[
              { id: "store-revenue", metricId: "revenue", label: "整店净 GSV", value: money(store.revenue), detail: store.refundDataAvailable ? `支付 ${money(store.grossRevenue)} · 退款 ${money(store.refundAmount)}${store.salesDeduction > 0 ? ` · 扣除 ${money(store.salesDeduction)}` : ""}` : "当前报表缺退款字段，需重新导入商品经营报表", tone: "emerald", emphasis: true, selected: selectedTrendMetrics.includes("revenue"), onClick: () => toggleTrendMetric("revenue") },
              { id: "store-spend", metricId: "spend", label: "推广花费", value: money(store.spend), detail: storePromotionCoverageComplete ? "单品推广消耗" : "已导入单品推广消耗，非完整周期", tone: "blue", emphasis: true, selected: selectedTrendMetrics.includes("spend"), onClick: () => toggleTrendMetric("spend") },
              { id: "store-roi", metricId: "managementRoi", label: "整店经营 ROI", value: fixed(store.managementRoi), detail: storePromotionCoverageComplete ? "净 GSV ÷ 推广花费" : "缺少同周期单品付费，暂不计算", tone: "amber", emphasis: true, selected: selectedTrendMetrics.includes("managementRoi"), onClick: () => toggleTrendMetric("managementRoi") },
              { id: "store-fee-rate", metricId: "feeRate", label: "推广费率", value: percent(store.feeRate), detail: storePromotionCoverageComplete ? "推广花费 ÷ 净 GSV" : "缺少同周期单品付费，暂不计算", tone: "rose", emphasis: true, selected: selectedTrendMetrics.includes("feeRate"), onClick: () => toggleTrendMetric("feeRate") },
            ]}
            currentEntities={[store]}
            comparisons={dashboard.comparisons}
            comparisonId={automaticComparisonId(datePreset)}
            trendMetrics={selectedTrendMetrics}
            onToggleTrendMetric={toggleTrendMetric}
          />
          {dashboard.sourceWarnings.storePromotion && (
            <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{dashboard.sourceWarnings.storePromotion}</span>
            </div>
          )}
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
            <Card>
              <CardContent className="p-5">
                <DashboardLineChart data={dashboard.trend} selectedMetrics={selectedTrendMetrics} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>店铺口径核对</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  多店铺时，各店销售与推广只在同名店铺内计算。
                </p>
              </CardHeader>
              <div className="divide-y divide-slate-100">
                {stores.length ? (
                  stores.map((item) => (
                    <div
                      key={item.key}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">
                          {item.name}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          净 GSV {money(item.revenue)} · 退款 {money(item.refundAmount)}{item.salesDeduction > 0 ? ` · 扣除 ${money(item.salesDeduction)}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-900">
                          经营 ROI {fixed(item.managementRoi)}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          费率 {percent(item.feeRate)}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-5 py-12 text-center text-sm text-slate-400">
                    导入商品经营与单品推广报表后显示店铺口径。
                  </div>
                )}
              </div>
            </Card>
          </section>
          <CategoryContributionPanel categories={categories} />
          <AnalysisBlock
            analysis={analysis}
            outdated={analysisOutdated}
            busy={busy}
            onAnalyze={() =>
              void run("analyze", async () => setAnalysis(await onAnalyze()))
            }
            onClear={() => void clearAnalyses()}
          />
        </div>
      )}

      {view === "category" && (
        <div className="space-y-5">
          <section className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <DashboardBarChart
                  title="品类360 净 GSV 排行"
                  hint={`支付金额减退款后的真实销售，滚轮查看全部 ${categoryRevenueBars.length} 个品类`}
                  data={categoryRevenueBars}
                  formatter={money}
                  color="#0f766e"
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <DashboardBarChart
                  title="类目费率排行"
                  hint={dashboard.sourceWarnings.categoryPromotion || `按当前范围已关联的品类计算，滚轮查看全部 ${categoryFeeRateBars.length} 个品类`}
                  data={categoryFeeRateBars}
                  formatter={(value) => `${value.toFixed(1)}%`}
                  color="#d97706"
                  emptyText={dashboard.sourceWarnings.categoryPromotion || undefined}
                />
              </CardContent>
            </Card>
          </section>
          <EntityTable
            title="品类360 经营矩阵"
            subtitle={dashboard.sourceWarnings.categoryPromotion || "净 GSV = 支付金额 - 售中售后成功退款金额；未关联项不计算费率。"}
            items={categories}
            kind="category"
            comparisons={dashboard.comparisons}
            comparisonId={automaticComparisonId(datePreset)}
          />
        </div>
      )}

      {view === "product" && (
        <div className="space-y-5">
          <section className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <DashboardBarChart
                  title="单品净 GSV 排行"
                  hint={`支付金额减成功退款金额，滚轮查看全部 ${productRevenueBars.length} 个单品`}
                  data={productRevenueBars}
                  formatter={money}
                  color="#0f766e"
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <DashboardBarChart
                  title="单品推广花费排行"
                  hint={`按推广消耗排序，滚轮查看全部 ${productSpendBars.length} 个单品`}
                  data={productSpendBars}
                  formatter={money}
                  color="#2563eb"
                />
              </CardContent>
            </Card>
          </section>
          <EntityTable
            title="商品排行经营矩阵"
            subtitle="每行保留支付、退款、净 GSV、推广成交与推广花费，支持直接核对关联状态。"
            items={products}
            kind="product"
            comparisons={dashboard.comparisons}
            comparisonId={automaticComparisonId(datePreset)}
          />
        </div>
      )}

      {view === "warehouse" && (
        <div className="space-y-5">
          <section aria-label="数据仓工作区导航" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {WAREHOUSE_PANEL_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.id === warehousePanel;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setWarehousePanel(option.id)}
                  className={`group flex min-w-0 items-center gap-3 border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 ${active ? option.activeClassName : "border-slate-200 bg-white/90 text-slate-800 shadow-sm hover:border-teal-300 hover:bg-teal-50/50"}`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center border ${active ? "border-white/40 bg-white/15 text-white" : "border-slate-200 bg-slate-50 text-slate-600 group-hover:border-teal-200 group-hover:text-teal-700"}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className={`mt-0.5 block truncate text-xs ${active ? "text-white/80" : "text-slate-500"}`}>{option.description}</span>
                  </span>
                </button>
              );
            })}
          </section>
          {warehousePanel === "cloud" && <Card className="border-sky-200 bg-sky-50/40">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border ${cloudSync.connected ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                  <Cloud className="h-4.5 w-4.5" />
                </div>
                <div>
                  <CardTitle>云端团队数据</CardTitle>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    云端只下发管理员上传的报表；本机上传的数据保留并按来源去重，不会回传。
                  </p>
                </div>
              </div>
              {cloudSync.connected ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800">
                    {cloudSync.teamName || "已绑定团队"}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() => void run("cloud-sync", async () => {
                      await onRunCloudSync();
                      await refreshArchive();
                    })}
                  >
                    {busy === "cloud-sync" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
                    同步云端数据
                  </Button>
                </div>
              ) : (
                <Button type="button" size="sm" onClick={() => setCloudSetupOpen((current) => !current)}>
                  <Cloud className="h-4 w-4" />
                  绑定团队授权
                </Button>
              )}
            </CardHeader>
            {cloudSync.connected ? (
              <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-slate-100 pt-4">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
                  <span>本机：<strong className="font-medium text-slate-900">{cloudSync.deviceName || "当前应用"}</strong></span>
                  <span>可同步店铺：<strong className="font-medium text-slate-900">{cloudSync.storeNames.join("、") || "--"}</strong></span>
                  <span>上次同步：<strong className="font-medium text-slate-900">{timestamp(cloudSync.lastSyncAt)}</strong></span>
                  {cloudSync.lastSyncResult && <span className="text-emerald-700">{cloudSync.lastSyncResult}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCloudSetupOpen((current) => !current)}>
                    查看连接
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!window.confirm("断开后不会删除本机已有数据。确认断开云端团队？")) return;
                      void run("cloud-disconnect", async () => {
                        await onDisconnectCloudSync();
                        setCloudCode("");
                        setCloudSetupOpen(false);
                      });
                    }}
                  >
                    <Unplug className="h-4 w-4" />
                    断开
                  </Button>
                </div>
              </CardContent>
            ) : null}
            {(cloudSetupOpen || !cloudSync.connected) && (
              <CardContent className="grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-[1.4fr_1fr_1fr_auto]">
                <label className="space-y-1 text-xs font-medium text-slate-600">
                  <span>云端地址</span>
                  <input value={cloudEndpoint} onChange={(event) => setCloudEndpoint(event.target.value)} placeholder="https://jvspp.cloud" className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800" />
                </label>
                <label className="space-y-1 text-xs font-medium text-slate-600">
                  <span>团队授权码</span>
                  <input value={cloudCode} onChange={(event) => setCloudCode(event.target.value.toUpperCase())} placeholder="例如 AB12-CD34-EF56" className="h-10 w-full border border-slate-200 bg-white px-3 font-mono text-sm text-slate-800" />
                </label>
                <label className="space-y-1 text-xs font-medium text-slate-600">
                  <span>本机名称</span>
                  <input value={cloudDeviceName} onChange={(event) => setCloudDeviceName(event.target.value)} placeholder="例如 志明的电脑" className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800" />
                </label>
                <div className="flex items-end">
                  <Button
                    type="button"
                    className="h-10 w-full"
                    disabled={busy === "cloud-activate" || !cloudCode.trim()}
                    onClick={() => void run("cloud-activate", async () => {
                      await onActivateCloudSync({ endpoint: cloudEndpoint, code: cloudCode, deviceName: cloudDeviceName });
                      setCloudCode("");
                      setCloudSetupOpen(false);
                    })}
                  >
                    {busy === "cloud-activate" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    绑定并保存
                  </Button>
                </div>
                <div className="md:col-span-4 text-xs leading-5 text-slate-500">
                  团队码可给多台电脑使用，数量由云端团队设备上限控制。授权凭证仅加密保存在本机，不会显示或上传到运营数据。
                </div>
              </CardContent>
            )}
            {cloudSync.lastError && (
              <div className="mx-6 mb-4 flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                <CircleAlert className="h-4 w-4 shrink-0" />
                {cloudSync.lastError}
              </div>
            )}
          </Card>}
          {warehousePanel === "import" && <Card className="border-teal-200 bg-white/95">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>导入运营数据</CardTitle>
                <button
                  type="button"
                  title="查看三类报表的下载与导入说明"
                  aria-label="查看三类报表的下载与导入说明"
                  aria-expanded={uploadGuideOpen}
                  onClick={() => setUploadGuideOpen((current) => !current)}
                  className="inline-flex h-6 w-6 items-center justify-center text-slate-400 transition-colors hover:text-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                >
                  <CircleHelp className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                数据保存在本机，导入后立即参与本地公式计算。
              </p>
              {uploadGuideOpen && (
                <div className="mt-4 overflow-x-auto border border-teal-200 bg-teal-50/60">
                  <table className="min-w-[680px] w-full text-left text-xs">
                    <thead className="border-b border-teal-200 bg-teal-100/70 text-teal-950">
                      <tr>
                        <th className="px-3 py-2 font-semibold">数据</th>
                        <th className="px-3 py-2 font-semibold">下载路径</th>
                        <th className="px-3 py-2 font-semibold">导入时选择</th>
                        <th className="px-3 py-2 font-semibold">写入用途</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-teal-100 text-slate-700">
                      {importGuide.map((item) => (
                        <tr key={item.type}>
                          <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-900">
                            {reportTypeLabels[item.type]}
                          </td>
                          <td className="px-3 py-2.5">{item.source}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-medium text-teal-800">{item.selection}</td>
                          <td className="px-3 py-2.5 text-slate-600">{item.purpose}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div
                className={`space-y-1 text-xs font-medium ${
                  showUploadRequirements && !reportType
                    ? "text-red-700"
                    : "text-slate-600"
                }`}
              >
                <span>报表类型{showUploadRequirements && !reportType ? "（必选）" : ""}</span>
                <div className="relative">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={reportTypePickerOpen}
                    onClick={() => setReportTypePickerOpen((current) => !current)}
                    className={`flex h-10 w-full items-center justify-between gap-2 border bg-white px-3 text-left text-sm text-slate-800 outline-none transition-colors hover:border-teal-400 focus:border-teal-600 focus:ring-2 focus:ring-teal-100 ${
                      showUploadRequirements && !reportType ? "border-red-400" : "border-slate-200"
                    }`}
                  >
                    <span className="truncate">
                      {reportType
                        ? importSelectLabels[reportType] || reportTypeLabels[reportType]
                        : "请选择报表类型"}
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${reportTypePickerOpen ? "rotate-180" : ""}`} />
                  </button>
                  {reportTypePickerOpen && (
                    <div
                      role="listbox"
                      aria-label="报表类型"
                      className="absolute z-40 mt-1 min-w-[280px] overflow-hidden border border-slate-300 bg-white py-1 shadow-lg"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={!reportType}
                        onClick={() => {
                          setReportType("");
                          if (activeReportId) updateReportBatchItem(activeReportId, { reportType: "" });
                          setReportTypePickerOpen(false);
                        }}
                        className={`flex h-9 w-full items-center whitespace-nowrap px-3 text-left text-sm ${
                          !reportType
                            ? "bg-slate-100 font-medium text-slate-900"
                            : "text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        请选择报表类型
                      </button>
                      {manualReportTypes.map((value) => {
                        const selected = reportType === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              setReportType(value);
                              if (activeReportId) updateReportBatchItem(activeReportId, { reportType: value });
                              setReportTypePickerOpen(false);
                            }}
                            className={`flex h-9 w-full items-center whitespace-nowrap px-3 text-left text-sm ${
                              selected
                                ? "bg-slate-100 font-medium text-slate-900"
                                : "text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            {importSelectLabels[value] || reportTypeLabels[value]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>统计口径</span>
                <select
                  value={periodKind}
                  onChange={(event) => {
                    const next = event.target.value as OperationsPeriodKind;
                    setPeriodKind(next);
                    const nextEnd = next === "day" ? periodStart : periodEnd;
                    if (next === "day") setPeriodEnd(nextEnd);
                    if (activeReportId) updateReportBatchItem(activeReportId, { periodKind: next, periodEnd: nextEnd });
                  }}
                  className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800"
                >
                  {Object.entries(periodKindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>{periodKind === "day" ? "统计日期" : "统计开始"}</span>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(event) => {
                    const nextStart = event.target.value;
                    const nextEnd = periodKind === "day" ? nextStart : periodEnd;
                    setPeriodStart(nextStart);
                    if (periodKind === "day") setPeriodEnd(nextEnd);
                    if (activeReportId) updateReportBatchItem(activeReportId, { periodStart: nextStart, periodEnd: nextEnd });
                  }}
                  className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800"
                />
                <span className="block font-normal text-slate-400">
                  选择文件后优先按报表内日期自动填写
                </span>
              </label>
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>统计结束</span>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(event) => {
                    setPeriodEnd(event.target.value);
                    if (activeReportId) updateReportBatchItem(activeReportId, { periodEnd: event.target.value });
                  }}
                  className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800"
                />
              </label>
              <div
                className={`space-y-1 text-xs font-medium ${
                  showUploadRequirements && !storeName
                    ? "text-red-700"
                    : "text-slate-600"
                }`}
              >
                <span>店铺{showUploadRequirements && !storeName ? "（必选）" : ""}</span>
                <div className="relative">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={storePickerOpen}
                    onClick={() => setStorePickerOpen((current) => !current)}
                    className={`flex h-10 w-full items-center justify-between gap-2 border bg-white px-3 text-left text-sm text-slate-800 outline-none transition-colors hover:border-teal-400 focus:border-teal-600 focus:ring-2 focus:ring-teal-100 ${
                      showUploadRequirements && !storeName ? "border-red-400" : "border-slate-200"
                    }`}
                  >
                    <span className="truncate">{addingStore ? "新增店铺" : storeName || "请选择归属店铺"}</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${storePickerOpen ? "rotate-180" : ""}`} />
                  </button>
                  {storePickerOpen && (
                    <div role="listbox" aria-label="归属店铺" className="absolute z-40 mt-1 w-full overflow-hidden border border-slate-300 bg-white py-1 shadow-lg">
                      <button
                        type="button"
                        role="option"
                        aria-selected={!storeName && !addingStore}
                        onClick={() => {
                          setStoreName("");
                          setAddingStore(false);
                          setStoreDeleteCandidate("");
                          setStorePickerOpen(false);
                        }}
                        className="flex h-8 w-full items-center px-3 text-left text-sm text-slate-600 hover:bg-slate-50"
                      >
                        请选择归属店铺
                      </button>
                      {storeOptions.map((name) => {
                        const selected = name === storeName && !addingStore;
                        return (
                          <div key={name} className={`flex h-8 items-center ${selected ? "bg-slate-100" : ""}`}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => {
                                setStoreName(name);
                                setAddingStore(false);
                                setStoreDeleteCandidate("");
                                setStorePickerOpen(false);
                              }}
                              className={`min-w-0 flex-1 truncate px-3 text-left text-sm ${selected ? "font-medium text-slate-900" : "text-slate-700 hover:bg-slate-50"}`}
                              title={name}
                            >
                              {name}
                            </button>
                            {name !== "未归属店铺" && (
                              <button
                                type="button"
                                onClick={() => {
                                  setStoreDeleteCandidate(name);
                                  setStorePickerOpen(false);
                                }}
                                title={`删除店铺“${name}”`}
                                aria-label={`删除店铺“${name}”`}
                                className="grid h-8 w-9 shrink-0 place-items-center text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        role="option"
                        aria-selected={addingStore}
                        onClick={() => {
                          setStoreName("");
                          setAddingStore(true);
                          setStoreDeleteCandidate("");
                          setStorePickerOpen(false);
                        }}
                        className="flex h-8 w-full items-center border-t border-slate-100 px-3 text-left text-sm font-medium text-teal-700 hover:bg-teal-50"
                      >
                        + 新增店铺
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {storeDeleteCandidate && (
                <div className="flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 md:col-span-2 xl:col-span-5">
                  <span>删除“{storeDeleteCandidate}”后，关联报表、商品资料和销售扣除会保留，并归为未归属店铺。</span>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" variant="secondary" className="h-8" onClick={() => setStoreDeleteCandidate("")}>取消</Button>
                    <Button type="button" className="h-8 border-red-700 bg-red-700 hover:bg-red-800" disabled={busy === "delete-store"} onClick={() => void deleteStore()}>
                      {busy === "delete-store" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      确认删除
                    </Button>
                  </div>
                </div>
              )}
              {addingStore && (
                <div className="space-y-1.5 md:col-span-2">
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1 space-y-1 text-xs font-medium text-slate-600">
                      <span>新店铺名称</span>
                      <input
                        autoFocus
                        value={newStoreName}
                        onChange={(event) => setNewStoreName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void createStore();
                          }
                        }}
                        placeholder="例如：本店、对面店铺"
                        className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800"
                      />
                    </label>
                    <Button
                      type="button"
                      className="h-10 shrink-0"
                      disabled={busy === "create-store"}
                      onClick={() => void createStore()}
                    >
                      {busy === "create-store" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      添加店铺
                    </Button>
                  </div>
                  {storeFeedback && (
                    <div className={`flex items-center gap-1.5 text-xs ${storeFeedback.tone === "success" ? "text-emerald-700" : "text-red-700"}`}>
                      {storeFeedback.tone === "success" ? <Check className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
                      {storeFeedback.message}
                    </div>
                  )}
                </div>
              )}
              <label className="space-y-1 text-xs font-medium text-slate-600 md:col-span-2 xl:col-span-5">
                <span>来源备注</span>
                <input
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                  placeholder="可选：万相台、生意参谋、达摩盘等"
                  className="h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-800"
                />
              </label>
            </CardContent>
            <div className="border-t border-slate-100">
              <section className="space-y-3 px-6 py-5">
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    可计算报表
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">
                    支持
                    Excel、WPS、CSV、TSV、TXT、JSON；导入后立即进入本地公式计算。
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => reportFileInput.current?.click()}
                    disabled={busy === "upload" || busy === "preview-reports"}
                    className="flex h-10 min-w-0 flex-1 items-center gap-2 border border-dashed border-emerald-300 bg-emerald-50/40 px-3 text-left text-sm text-emerald-800 hover:border-emerald-500"
                  >
                    <FileSpreadsheet className="h-4 w-4 shrink-0" />
                    <span className="truncate">
                      {reportBatch.length ? `继续添加报表（当前 ${reportBatch.length} 份）` : "批量选择数据文件"}
                    </span>
                  </button>
                  <input
                    ref={reportFileInput}
                    type="file"
                    multiple
                    accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,.json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      event.target.value = "";
                      void inspectReports(files);
                    }}
                  />
                    <Button
                      type="button"
                      onClick={() => void uploadReport()}
                      disabled={!canUploadReport}
                  >
                    {busy === "upload" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    {busy === "upload"
                      ? `正在导入 ${reportBatchProgress.completed}/${reportBatchProgress.total}`
                      : `批量导入${pendingReportBatch.length ? ` ${pendingReportBatch.length} 份` : "报表"}`}
                    </Button>
                  </div>
                  {busy === "preview-reports" && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-800"
                    >
                      <div className="flex items-center gap-2 font-semibold">
                        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
                        正在逐份读取并识别报表（{reportBatchProgress.completed}/{reportBatchProgress.total}）
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden bg-blue-100">
                        <div className="h-full w-2/3 animate-pulse bg-blue-600" />
                      </div>
                      <div className="mt-1.5 text-blue-700">正在检查报表类型、数据行和统计日期，请稍候。</div>
                    </div>
                  )}
                  {reportBatch.length > 0 && (
                    <div className="border border-slate-200 bg-slate-50/70">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-600">
                        <span>文件清单 · 点击某一份单独修正上方报表类型与统计日期</span>
                        <strong className="text-slate-800">
                          {reportBatch.filter((item) => item.status === "success").length} 已导入 · {pendingReportBatch.length} 待处理
                        </strong>
                      </div>
                      <div className="max-h-64 divide-y divide-slate-200 overflow-y-auto">
                        {reportBatch.map((item, index) => {
                          const active = item.id === activeReportId;
                          const statusLabel = item.status === "previewing" ? "识别中"
                            : item.status === "ready" ? "待导入"
                              : item.status === "preview-error" ? "识别失败"
                                : item.status === "uploading" ? "导入中"
                                  : item.status === "success" ? "已导入"
                                    : "导入失败";
                          const statusClass = item.status === "success" ? "bg-emerald-100 text-emerald-800"
                            : item.status === "ready" ? "bg-blue-100 text-blue-800"
                              : item.status === "previewing" || item.status === "uploading" ? "bg-amber-100 text-amber-800"
                                : "bg-red-100 text-red-800";
                          return (
                            <div key={item.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-2 ${active ? "bg-white ring-1 ring-inset ring-teal-500" : ""}`}>
                              <button
                                type="button"
                                onClick={() => activateReportItem(item)}
                                className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 px-1 text-left"
                              >
                                <span className="grid h-6 w-6 place-items-center bg-slate-200 text-[10px] font-bold text-slate-600">{index + 1}</span>
                                <span className="min-w-0">
                                  <strong className="block truncate text-xs text-slate-900" title={item.file.name}>{item.file.name}</strong>
                                  <small className="mt-0.5 block truncate text-[10px] text-slate-500">
                                    {item.reportType ? reportTypeLabels[item.reportType] : "待选报表类型"} · {item.periodStart && item.periodEnd ? (item.periodStart === item.periodEnd ? item.periodEnd : `${item.periodStart} 至 ${item.periodEnd}`) : "待选统计日期"}{item.preview ? ` · ${item.preview.rowCount} 行` : ""}
                                  </small>
                                  {item.error && <em className="mt-0.5 block truncate text-[10px] not-italic text-red-700" title={item.error}>{item.error}</em>}
                                </span>
                                <span className={`shrink-0 px-2 py-1 text-[10px] font-semibold ${statusClass}`}>{statusLabel}</span>
                              </button>
                              <div className="flex items-center gap-1">
                                {item.status === "preview-error" && (
                                  <button
                                    type="button"
                                    onClick={() => void retryReportPreview(item)}
                                    disabled={Boolean(busy)}
                                    className="h-7 px-2 text-[10px] font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                                  >
                                    重新识别
                                  </button>
                                )}
                                {item.status !== "uploading" && (
                                  <button
                                    type="button"
                                    onClick={() => removeReportBatchItem(item.id)}
                                    disabled={busy === "upload" || busy === "preview-reports"}
                                    aria-label={`移除 ${item.file.name}`}
                                    title="从批量清单移除"
                                    className="grid h-7 w-7 place-items-center text-slate-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {showUploadRequirements && uploadRequirements.length > 0 && (
                    <div
                      role="status"
                      className="flex items-center gap-1.5 text-xs text-amber-800"
                    >
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                      还需要选择：{uploadRequirements.join("、")}
                    </div>
                  )}
                  {invalidReportBatch.length > 0 && (
                    <div role="status" className="flex items-center gap-1.5 text-xs text-amber-800">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                      批量清单还有 {invalidReportBatch.length} 份需要补全或重新识别；点击对应文件逐份处理。
                    </div>
                  )}
                  {reportPreview && (
                  <div className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    <div className="font-semibold">
                      预检通过：已读取{" "}
                      {reportPreview.exactRowCount
                        ? reportPreview.rowCount
                        : `至少 ${reportPreview.rowCount}`}{" "}
                      条数据
                    </div>
                    <div className="mt-1 leading-5">
                      字段：{reportPreview.columns.slice(0, 8).join("、")}
                      {reportPreview.columns.length > 8
                        ? ` 等 ${reportPreview.columns.length} 列`
                        : ""}
                    </div>
                    {reportPreview.detectedType && manualReportTypes.includes(reportPreview.detectedType) ? (
                      <div className="mt-2 flex items-center gap-1.5 border-t border-emerald-200/70 pt-2 font-medium text-emerald-900">
                        <Check className="h-3.5 w-3.5" />
                        已识别报表类型：{reportTypeLabels[reportPreview.detectedType]}
                      </div>
                    ) : (
                      <div className="mt-2 flex items-start gap-1.5 border-t border-amber-200 pt-2 text-amber-900">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>未能确认报表类型，请在上方手动选择。</span>
                      </div>
                    )}
                    {reportPreview.period ? (
                      <div className="mt-2 flex items-center gap-1.5 font-medium text-emerald-900">
                        <Check className="h-3.5 w-3.5" />
                        已按报表内容识别统计周期：{reportPreview.period.label}
                      </div>
                    ) : (
                      <div className="mt-2 flex items-start gap-1.5 text-amber-900">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>报表内未提供统计日期，请在上方选择后导入。文件下载时间不会参与统计。</span>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
            {uploadFeedback && (
              <div
                role="status"
                className="mx-6 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800"
              >
                <Check className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  {uploadFeedback.successCount && uploadFeedback.successCount > 1
                    ? `本次已导入 ${uploadFeedback.successCount} 份报表`
                    : `已导入 ${uploadFeedback.fileName}`}
                </span>
                <span>
                  {uploadFeedback.failureCount
                    ? `${uploadFeedback.failureCount} 份失败，可在文件清单直接重试`
                    : `最后一份识别 ${uploadFeedback.rowCount} 条可计算数据`}
                </span>
                {uploadFeedback.id && (!uploadFeedback.successCount || uploadFeedback.successCount === 1) && (
                  <button
                    type="button"
                    onClick={() => void deleteImportedReport(uploadFeedback.id)}
                    className="ml-auto inline-flex items-center gap-1 text-red-700 hover:text-red-900"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </button>
                )}
              </div>
            )}
            <div className="border-t border-slate-100 bg-slate-50/60">
              <section className="px-6 py-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      已导入报表
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      参与本地指标计算
                    </div>
                  </div>
                  <span className="text-xs text-slate-400">
                    {
                      workspace.reports.filter(
                        (report) => report.kind !== "screenshot",
                      ).length
                    }{" "}
                    项
                  </span>
                </div>
                <RecentImportList
                  reports={recentDataReports}
                  selectedIds={selectedImportedReportIds}
                  busy={busy}
                  onSelectAll={(selected) =>
                    setSelectedImportedReportIds(
                      selected
                        ? new Set(recentDataReports.map((report) => report.id))
                        : new Set(),
                    )
                  }
                  onSelectDate={setImportedDateSelection}
                  onToggleReport={(id, selected) =>
                    setSelectedImportedReportIds((current) => {
                      const next = new Set(current);
                      if (selected) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                  onClearSelection={() => setSelectedImportedReportIds(new Set())}
                  onDeleteSelected={() => void deleteSelectedImportedReports()}
                  onDelete={(id) => void deleteImportedReport(id)}
                />
              </section>
            </div>
            {pasteOpen && (
              <div className="border-t border-slate-100 bg-slate-50/70 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      粘贴表格数据
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      从 Excel/WPS
                      复制包含表头的数据区域，粘贴后直接导入；也支持 JSON。
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    title="关闭粘贴区"
                    aria-label="关闭粘贴区"
                    onClick={() => setPasteOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <textarea
                  autoFocus
                  value={pastedData}
                  onChange={(event) => setPastedData(event.target.value)}
                  rows={7}
                  placeholder={
                    "商品名称\t消耗\t成交金额\t订单数\n示例商品\t100\t500\t8"
                  }
                  className="w-full resize-y border border-slate-200 bg-white p-3 font-mono text-xs leading-5 text-slate-800"
                />
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => void uploadPastedData()}
                    disabled={busy === "paste" || !pastedData.trim()}
                  >
                    {busy === "paste" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    导入粘贴数据
                  </Button>
                </div>
              </div>
            )}
            <div className="border-t border-slate-100 px-6 py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPasteOpen((current) => !current)}
              >
                <ClipboardPaste className="h-4 w-4" />
                {pasteOpen ? "收起粘贴导入" : "粘贴表格导入"}
              </Button>
            </div>
          </Card>}
          {warehousePanel === "archive" && <Card className="border-blue-200 bg-white/95">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>本机运营数据仓</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  先按店铺归档，再按统计日期或周期从新到旧排列，支持整店、整期和单份报表批量操作。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="space-y-1 text-xs font-medium text-slate-600">
                  <span>数据表</span>
                  <select
                    value={archiveType}
                    onChange={(event) =>
                      setArchiveType(
                        event.target.value as OperationsReportType | "all",
                      )
                    }
                    className="block h-8 border border-slate-200 bg-white px-2 text-xs text-slate-800"
                  >
                    <option value="all">全部数据表</option>
                    {manualReportTypes.map((value) => (
                      <option key={value} value={value}>
                        {importSelectLabels[value] || reportTypeLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium text-slate-600">
                  <span>店铺</span>
                  <select
                    value={archiveStore}
                    onChange={(event) => setArchiveStore(event.target.value)}
                    className="block h-8 border border-slate-200 bg-white px-2 text-xs text-slate-800"
                  >
                    <option value="all">全部店铺</option>
                    {archiveStores.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedArchiveIds.size > 0 && (
                  <div className="mt-4 flex items-center gap-2">
                    <select
                      aria-label="为已选报表选择店铺"
                      value={archiveAssignmentStore}
                      onChange={(event) => setArchiveAssignmentStore(event.target.value)}
                      className="h-8 min-w-32 border border-slate-200 bg-white px-2 text-xs text-slate-800"
                    >
                      <option value="">归属到已有店铺</option>
                      {storeOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void assignSelectedReportsStore()}
                      disabled={!archiveAssignmentStore || busy === "assign-report-store"}
                    >
                      {busy === "assign-report-store" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      归属 {selectedArchiveIds.size} 项
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void deleteSelectedReports()}
                      disabled={busy === "delete-selected"}
                    >
                      {busy === "delete-selected" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      删除 {selectedArchiveIds.size} 项
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="归档天数"
                value={count(archive.days.length)}
                detail={`最新：${workspace.currentDate || "--"}`}
                tone="emerald"
                surfaceClassName="bg-emerald-50/65"
              />
              <MetricTile
                label="上传记录"
                value={count(importedDataCount)}
                detail="已入库的数据文件"
                tone="blue"
                surfaceClassName="bg-blue-50/65"
              />
              <MetricTile
                label="可计算数据行"
                value={count(archive.totalRows)}
                detail="本地公式汇总"
                tone="amber"
                surfaceClassName="bg-amber-50/65"
              />
            </CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label="选择所有当前数据"
                        checked={selectedAllVisible}
                        onChange={(event) =>
                          setSelectedArchiveIds(
                            event.target.checked
                              ? new Set(
                                  filteredReports.map((report) => report.id),
                                )
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th className="px-4 py-3 font-medium">文件</th>
                    <th className="px-4 py-3 font-medium">统计周期</th>
                    <th className="px-4 py-3 font-medium">数据表</th>
                    <th className="px-4 py-3 font-medium">数据</th>
                    <th className="px-4 py-3 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <ArchiveReportRows
                  groups={filteredReportGroups}
                  selectedIds={selectedArchiveIds}
                  busy={busy}
                  editingReportId={editingReportId}
                  reportNameDraft={reportNameDraft}
                  onSelectDate={setArchiveDateSelection}
                  onToggleReport={(id, selected) =>
                    setSelectedArchiveIds((current) => {
                      const next = new Set(current);
                      if (selected) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                  onBeginRename={beginReportRename}
                  onDraftChange={setReportNameDraft}
                  onSaveRename={() => void saveReportRename()}
                  onCancelRename={() => {
                    setEditingReportId("");
                    setReportNameDraft("");
                  }}
                  onDelete={(id) => void deleteImportedReport(id)}
                />
              </table>
            </div>
          </Card>}
          {warehousePanel === "catalog" && <Card className="border-amber-200 bg-white/95 [content-visibility:auto] [contain-intrinsic-size:auto_900px]">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>商品 ID 与型号资料库</CardTitle>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  按店铺 + 商品 ID 维护。单品付费会据此归集品类；每次导入或修改都会追加版本，当前页面始终使用最新资料。
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={() => void exportCatalog()} disabled={busy === "catalog-export" || !activeProductCatalog.length}>
                {busy === "catalog-export" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                导出当前表
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="border border-slate-200 bg-slate-50/60 p-4">
                  <div className="text-sm font-semibold text-slate-900">批量更新</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">支持 XLS、XLSX、CSV、TSV、TXT；表头使用店铺名、ID、品类名、型号。</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => catalogFileInput.current?.click()}
                      className="flex h-10 min-w-0 flex-1 items-center gap-2 border border-dashed border-teal-300 bg-white px-3 text-left text-sm text-teal-800 hover:border-teal-500"
                    >
                      <FileSpreadsheet className="h-4 w-4 shrink-0" />
                      <span className="truncate">{selectedCatalogFile?.name || "选择 ID 型号表"}</span>
                    </button>
                    <input
                      ref={catalogFileInput}
                      type="file"
                      accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
                      className="hidden"
                      onChange={(event) => {
                        setSelectedCatalogFile(event.target.files?.[0] || null);
                        event.target.value = "";
                        setCatalogFeedback("");
                      }}
                    />
                    <Button type="button" onClick={() => void uploadCatalog()} disabled={!selectedCatalogFile || busy === "catalog-upload"}>
                      {busy === "catalog-upload" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      更新资料库
                    </Button>
                  </div>
                </div>
                <div className="border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">新增或修改一条</div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs font-medium text-slate-600">
                      <span>店铺</span>
                      <input list="operations-catalog-stores" value={catalogStoreName} onChange={(event) => setCatalogStoreName(event.target.value)} placeholder="选择或输入店铺" className="h-9 w-full border border-slate-200 bg-white px-2 text-sm text-slate-800" />
                      <datalist id="operations-catalog-stores">{storeOptions.map((name) => <option key={name} value={name} />)}</datalist>
                    </label>
                    <label className="space-y-1 text-xs font-medium text-slate-600">
                      <span>商品 ID</span>
                      <input value={catalogProductId} onChange={(event) => setCatalogProductId(event.target.value.replace(/\s+/g, ""))} placeholder="例如 123456789" className="h-9 w-full border border-slate-200 bg-white px-2 text-sm text-slate-800" />
                    </label>
                    <label className="space-y-1 text-xs font-medium text-slate-600">
                      <span>品类</span>
                      <input value={catalogCategory} onChange={(event) => setCatalogCategory(event.target.value)} placeholder="例如 电饭煲" className="h-9 w-full border border-slate-200 bg-white px-2 text-sm text-slate-800" />
                    </label>
                    <label className="space-y-1 text-xs font-medium text-slate-600">
                      <span>型号</span>
                      <input value={catalogModel} onChange={(event) => setCatalogModel(event.target.value)} placeholder="例如 SY-50" className="h-9 w-full border border-slate-200 bg-white px-2 text-sm text-slate-800" />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button type="button" size="sm" onClick={() => void saveCatalogEntry()} disabled={busy === "catalog-save"}>
                      {busy === "catalog-save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      保存为新版本
                    </Button>
                  </div>
                </div>
              </div>
              {catalogFeedback && <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><Check className="h-4 w-4 shrink-0" />{catalogFeedback}</div>}
              {activeProductCatalog.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                  <span>
                    共 {activeProductCatalog.length} 条，当前展示 {catalogPage * PRODUCT_CATALOG_PAGE_SIZE + 1}-{Math.min((catalogPage + 1) * PRODUCT_CATALOG_PAGE_SIZE, activeProductCatalog.length)} 条
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button type="button" size="sm" variant="secondary" className="h-8" disabled={catalogPage === 0} onClick={() => setCatalogPage((current) => Math.max(0, current - 1))}>上一页</Button>
                    <span className="min-w-14 text-center">{catalogPage + 1} / {catalogPageCount}</span>
                    <Button type="button" size="sm" variant="secondary" className="h-8" disabled={catalogPage >= catalogPageCount - 1} onClick={() => setCatalogPage((current) => Math.min(catalogPageCount - 1, current + 1))}>下一页</Button>
                  </div>
                </div>
              )}
              <div className="overflow-auto border border-slate-200">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 font-medium">店铺</th><th className="px-4 py-3 font-medium">商品 ID</th><th className="px-4 py-3 font-medium">品类</th><th className="px-4 py-3 font-medium">型号</th><th className="px-4 py-3 font-medium">当前版本</th><th className="px-4 py-3 font-medium text-right">操作</th></tr></thead>
                  <tbody>
                    {activeProductCatalog.length ? visibleProductCatalog.map((entry) => {
                      const key = `${entry.storeName.trim().toLowerCase()}\u0000${entry.productId.trim()}`;
                      return <tr key={entry.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70"><td className="px-4 py-3 text-slate-700">{entry.storeName}</td><td className="px-4 py-3 font-mono text-xs text-slate-700">{entry.productId}</td><td className="px-4 py-3 text-slate-700">{entry.category || "--"}</td><td className="px-4 py-3 text-slate-700">{entry.model || "--"}</td><td className="px-4 py-3 text-xs text-slate-500">{catalogVersionCounts.get(key) || 1} 版 · {timestamp(entry.createdAt)}</td><td className="px-4 py-3 text-right"><Button type="button" size="sm" variant="ghost" onClick={() => { setCatalogStoreName(entry.storeName); setCatalogProductId(entry.productId); setCatalogCategory(entry.category); setCatalogModel(entry.model); setCatalogFeedback(""); }}><PenLine className="h-3.5 w-3.5" />修改</Button></td></tr>;
                    }) : <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">上传 ID 型号表后，商品排行会自动展示型号和品类。</td></tr>}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>}
        </div>
      )}
      {deductionPanelOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/30 p-3 sm:p-5"
          role="presentation"
          onMouseDown={() => setDeductionPanelOpen(false)}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="sales-deduction-title"
            className="ml-auto flex h-full w-full max-w-md flex-col border border-slate-200 bg-white shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 id="sales-deduction-title" className="text-base font-semibold text-slate-950">
                  销售扣除
                </h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  用于剔除大单。保存后自动重算整店净 GSV、经营 ROI 和推广费率。
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭销售扣除"
                title="关闭"
                onClick={() => setDeductionPanelOpen(false)}
                className="grid h-8 w-8 shrink-0 place-items-center border border-slate-200 text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs font-medium text-slate-600">
                  <span>店铺</span>
                  <select
                    value={deductionStore}
                    onChange={(event) => setDeductionStore(event.target.value)}
                    className="block h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-600"
                  >
                    <option value="">选择店铺</option>
                    {dashboardStores.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5 text-xs font-medium text-slate-600">
                  <span>统计日期</span>
                  <input
                    type="date"
                    value={deductionDate}
                    onChange={(event) => setDeductionDate(event.target.value)}
                    className="block h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-600"
                  />
                </label>
              </div>
              <label className="mt-4 block space-y-1.5 text-xs font-medium text-slate-600">
                <span>扣除金额</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={deductionAmount}
                  onChange={(event) => setDeductionAmount(event.target.value)}
                  placeholder="例如 10000"
                  className="block h-10 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-600"
                />
              </label>
              <label className="mt-4 block space-y-1.5 text-xs font-medium text-slate-600">
                <span>备注</span>
                <textarea
                  value={deductionNote}
                  onChange={(event) => setDeductionNote(event.target.value.slice(0, 240))}
                  rows={3}
                  placeholder="例如：渠道大单，不计入日常经营销售"
                  className="block w-full resize-none border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-600"
                />
              </label>
              <div className="mt-6 border-t border-slate-200 pt-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">销售扣除历史</div>
                    <div className="mt-1 text-xs text-slate-500">
                      历史共 {(workspace.salesDeductionHistory || workspace.salesDeductions).length} 笔 · 当前口径 {workspace.salesDeductions.length} 笔 / {money(dashboard.totalSalesDeduction)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">
                  {(workspace.salesDeductionHistory || workspace.salesDeductions).length ? (
                    (workspace.salesDeductionHistory || workspace.salesDeductions).map((item) => {
                      const active = workspace.salesDeductions.some((current) => current.id === item.id);
                      return (
                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                            <span className="truncate">{item.storeName}</span>
                            <span className="shrink-0 text-xs font-normal text-slate-500">{item.reportDate}</span>
                            <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                              {active ? "当前口径" : "历史"}
                            </span>
                          </div>
                          {item.note && <div className="mt-1 break-words text-xs leading-5 text-slate-500">{item.note}</div>}
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="pt-1 text-sm font-semibold text-emerald-700">-{money(item.amount)}</span>
                          <button
                            type="button"
                            aria-label={`删除 ${item.storeName} 的销售扣除`}
                            title="删除"
                            onClick={() => void deleteSalesDeduction(item.id)}
                            disabled={busy === `sales-deduction-${item.id}`}
                            className="grid h-7 w-7 place-items-center border border-slate-200 text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            {busy === `sales-deduction-${item.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                      );
                    })
                  ) : (
                    <div className="py-6 text-center text-sm text-slate-400">还没有销售扣除记录。</div>
                  )}
                </div>
              </div>
              <p className="mt-5 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                扣除仅作用于整店经营口径，不会虚构分摊到商品排行或品类360；原始报表数据始终保留。
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <Button type="button" variant="secondary" onClick={() => setDeductionPanelOpen(false)}>取消</Button>
              <Button type="button" onClick={() => void saveSalesDeduction()} disabled={busy === "sales-deduction"}>
                {busy === "sales-deduction" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                保存并重算
              </Button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function AnalysisBlock({
  analysis,
  outdated,
  busy,
  onAnalyze,
  onClear,
}: {
  analysis: OperationsAnalysis | null;
  outdated: boolean;
  busy: string;
  onAnalyze: () => void;
  onClear: () => void;
}) {
  if (!analysis || outdated)
    return (
      <Card className="border-amber-200 bg-amber-50/70">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>经营结论待更新</CardTitle>
            <p className="mt-1 text-xs text-amber-800">
              数据更新后，旧结论已隐藏，避免混用不同周期与不同来源。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {analysis && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-slate-500 hover:bg-red-50 hover:text-red-700"
                onClick={onClear}
                disabled={Boolean(busy)}
                title="清空全部运营分析"
              >
                {busy === "clear-analyses" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                清空分析
              </Button>
            )}
            <Button type="button" onClick={onAnalyze} disabled={Boolean(busy)}>
              {busy === "analyze" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              运行分析
            </Button>
          </div>
        </CardHeader>
      </Card>
    );
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>经营结论</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            {analysis.mode === "ai" ? "模型分析" : "本地公式"} ·{" "}
            {timestamp(analysis.createdAt)}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-slate-500 hover:bg-red-50 hover:text-red-700"
          onClick={onClear}
          disabled={Boolean(busy)}
          title="清空全部运营分析"
        >
          {busy === "clear-analyses" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          清空分析
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
        <div>
          <p className="text-sm leading-6 text-slate-800">{analysis.summary}</p>
          {analysis.insights.length > 0 && (
            <div className="mt-4 space-y-2">
              {analysis.insights.map((item) => (
                <div
                  key={item}
                  className="border-l-2 border-teal-500 pl-3 text-sm leading-5 text-slate-600"
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-slate-100 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="text-xs font-semibold text-slate-500">优先行动</div>
          <div className="mt-3 space-y-2">
            {analysis.actions.slice(0, 5).map((item, index) => (
              <div
                key={item}
                className="flex gap-2 text-sm leading-5 text-slate-700"
              >
                <span className="font-semibold text-teal-700">{index + 1}</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function entityIdentityKeys(kind: EntityPanel, item: Pick<OperationsComparisonEntity, "key" | "name" | "productId" | "storeName" | "category" | "model">) {
  const storeName = item.storeName.trim().toLowerCase();
  const keys = item.key ? [`key:${item.key}`] : [];
  if (kind === "category") {
    if (storeName && item.name) keys.push(`store-category:${storeName}\u0000${item.name}`);
    if (!storeName && item.name) keys.push(`category:${item.name}`);
    return keys;
  }
  if (item.productId) {
    if (storeName) keys.push(`store-product:${storeName}\u0000${item.productId}`);
    else keys.push(`product:${item.productId}`);
  }
  if (storeName && item.name) keys.push(`store-name:${storeName}\u0000${item.name}`);
  if (!storeName && item.category && item.model) keys.push(`model:${item.category}\u0000${item.model}`);
  return keys;
}

function previousEntityIndex(kind: EntityPanel, items: OperationsComparisonEntity[]) {
  const index = new Map<string, OperationsComparisonEntity>();
  for (const item of items) {
    for (const key of entityIdentityKeys(kind, item)) {
      if (!index.has(key)) index.set(key, item);
    }
  }
  return index;
}

function previousEntityForItem(kind: EntityPanel, item: OperationsBusinessEntity, index: Map<string, OperationsComparisonEntity>) {
  for (const key of entityIdentityKeys(kind, {
    key: item.key,
    name: item.name,
    productId: item.productId || "",
    storeName: item.storeName || "",
    category: item.category || "",
    model: item.model || "",
  })) {
    const previous = index.get(key);
    if (previous) return previous;
  }
  return null;
}

function entityMetricValue(item: OperationsBusinessEntity | OperationsComparisonEntity, metricId: CustomMetricId) {
  const record = "sales" in item ? metricRecordFromBusiness(item) : item;
  return customMetricValue([record], metricId);
}

function EntityComparisonBadge({
  item,
  previousItem,
  metricId,
  comparison,
}: {
  item: OperationsBusinessEntity;
  previousItem: OperationsComparisonEntity | null;
  metricId: CustomMetricId;
  comparison: OperationsComparison | undefined;
}) {
  const label = comparison?.label || "环比";
  const current = comparison?.currentAvailable ? entityMetricValue(item, metricId) : null;
  const previous = comparison?.previousAvailable && previousItem ? entityMetricValue(previousItem, metricId) : null;
  const delta = current !== null && previous !== null ? current - previous : null;
  const relative = delta !== null && previous !== null && previous !== 0 ? delta / Math.abs(previous) : null;
  const metric = CUSTOM_METRICS.find((definition) => definition.id === metricId);
  const title = comparison
    ? `${comparison.currentStart} 至 ${comparison.currentEnd} 对比 ${comparison.previousStart} 至 ${comparison.previousEnd}`
    : "当前或同期报表不完整";
  if (delta === null) {
    return <span title={title} className="inline-flex border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">{label} --</span>;
  }
  const display = relative === null
    ? (delta === 0 ? "持平" : "新增")
    : metric?.kind === "percent"
      ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`
      : `${relative >= 0 ? "+" : ""}${(relative * 100).toFixed(1)}%`;
  const tone = delta > 0
    ? "border-rose-200 bg-rose-50 text-rose-600"
    : delta < 0
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-slate-200 bg-slate-50 text-slate-500";
  return <span title={title} className={`inline-flex border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${tone}`}>{label} {display}</span>;
}

function EntityTable({
  title,
  subtitle,
  items,
  kind,
  comparisons,
  comparisonId,
}: {
  title: string;
  subtitle: string;
  items: OperationsBusinessEntity[];
  kind: EntityPanel;
  comparisons: OperationsWorkspace["dashboard"]["comparisons"];
  comparisonId: OperationsComparisonId;
}) {
  const [keyword, setKeyword] = useState("");
  const [sortKey, setSortKey] = useState<EntityTableSortKey>("revenue");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<Set<string>>(
    new Set(),
  );
  const [categoryPickerQuery, setCategoryPickerQuery] = useState("");
  const [categorySelectionHistory, setCategorySelectionHistory] = useState<CategorySelectionHistoryItem[]>(() => loadCategorySelectionHistory(kind));
  const [showHistorySave, setShowHistorySave] = useState(false);
  const [historySaveName, setHistorySaveName] = useState("");
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(new Set());
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [expandedPromotionKey, setExpandedPromotionKey] = useState("");
  const [matrixMetricIds, setMatrixMetricIds] = useState<CustomMetricId[]>(() => loadMatrixMetrics(kind));
  const [matrixMetricSettingsOpen, setMatrixMetricSettingsOpen] = useState(false);
  const [draggingMatrixMetricId, setDraggingMatrixMetricId] = useState<CustomMetricId | null>(null);
  const [showComparisons, setShowComparisons] = useState(() => loadComparisonVisibility(kind));
  useEffect(() => saveMatrixMetrics(kind, matrixMetricIds), [kind, matrixMetricIds]);
  useEffect(() => saveComparisonVisibility(kind, showComparisons), [kind, showComparisons]);
  const dataItems = useMemo(() => items.filter(hasVisibleBusinessData), [items]);
  const categoryOptions = useMemo(
    () =>
      [...new Set(dataItems.flatMap((item) => {
        const value = kind === "product" ? item.category : item.name;
        return value ? [value] : [];
      }))].sort((left, right) =>
        left.localeCompare(right, "zh-CN"),
      ),
    [dataItems, kind],
  );
  const selectableCategoryOptions = useMemo(() => {
    const query = categoryPickerQuery.trim().toLowerCase();
    return query
      ? categoryOptions.filter((name) => name.toLowerCase().includes(query))
      : categoryOptions;
  }, [categoryOptions, categoryPickerQuery]);
  const modelOptions = useMemo(
    () => kind === "product"
      ? [...new Set(dataItems.map((item) => item.model || "型号待补"))].sort((left, right) => left.localeCompare(right, "zh-CN"))
      : [],
    [dataItems, kind],
  );
  const selectableModelOptions = useMemo(() => {
    const query = modelPickerQuery.trim().toLowerCase();
    return query
      ? modelOptions.filter((name) => name.toLowerCase().includes(query))
      : modelOptions;
  }, [modelOptions, modelPickerQuery]);
  const visibleItems = useMemo(() => {
    const search = keyword.trim().toLowerCase();
    return dataItems
      .filter((item) => !search || `${item.name} ${item.productId || ""}`.toLowerCase().includes(search))
      .filter(
        (item) =>
          !["category", "product"].includes(kind) ||
          selectedCategoryNames.size === 0 ||
          selectedCategoryNames.has((kind === "product" ? item.category : item.name) || ""),
      )
      .filter((item) => kind !== "product" || selectedModelNames.size === 0 || selectedModelNames.has(item.model || "型号待补"))
      .slice()
      .sort((left, right) => {
        const textSort = sortKey === "name" || sortKey === "model" || sortKey === "productId";
        const leftValue = textSort
          ? String(sortKey === "name" ? left.name : sortKey === "model" ? left.model || "" : left.productId || "")
          : sortKey === "promotionCount"
            ? left.promotionCount
            : entityMetricValue(left, sortKey);
        const rightValue = textSort
          ? String(sortKey === "name" ? right.name : sortKey === "model" ? right.model || "" : right.productId || "")
          : sortKey === "promotionCount"
            ? right.promotionCount
            : entityMetricValue(right, sortKey);
        const compare = typeof leftValue === "string"
          ? leftValue.localeCompare(String(rightValue), "zh-CN")
          : Number(leftValue ?? 0) - Number(rightValue ?? 0);
        return sortDirection === "asc" ? compare : -compare;
      });
  }, [dataItems, keyword, kind, selectedCategoryNames, selectedModelNames, sortKey, sortDirection]);
  const selectionSummary = useMemo(() => {
    const totals = visibleItems.reduce(
      (result, item) => ({
        grossRevenue: result.grossRevenue + item.grossRevenue,
        refundAmount: result.refundAmount + item.refundAmount,
        revenue: result.revenue + item.revenue,
        spend: result.spend + item.spend,
        promotionRevenue: result.promotionRevenue + item.promotionRevenue,
        refundDataAvailable: result.refundDataAvailable && item.refundDataAvailable,
      }),
      {
        grossRevenue: 0,
        refundAmount: 0,
        revenue: 0,
        spend: 0,
        promotionRevenue: 0,
        refundDataAvailable: true,
      },
    );
    return {
      ...totals,
      roi:
        totals.spend > 0 ? totals.promotionRevenue / totals.spend : null,
      feeRate:
        totals.refundDataAvailable && totals.revenue > 0
          ? totals.spend / totals.revenue
          : null,
    };
  }, [visibleItems]);
  const toggleCategorySelection = (name: string) => {
    setSelectedCategoryNames((current) => {
      if (categoryPickerQuery.trim()) return current.has(name) ? new Set() : new Set([name]);
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const toggleModelSelection = (name: string) => {
    setSelectedModelNames((current) => {
      if (modelPickerQuery.trim()) return current.has(name) ? new Set() : new Set([name]);
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const applyCategorySelection = useCallback((names: Iterable<string>) => {
    const available = new Set(categoryOptions);
    setSelectedCategoryNames(new Set([...names].filter((name) => available.has(name))));
    setCategoryPickerQuery("");
  }, [categoryOptions]);
  const saveCurrentCategorySelection = () => {
    if (!selectedCategoryNames.size) return;
    setCategorySelectionHistory((current) => {
      const next = upsertCategorySelectionHistory(current, selectedCategoryNames, historySaveName);
      saveCategorySelectionHistory(kind, next);
      return next;
    });
    setHistorySaveName("");
    setShowHistorySave(false);
  };
  const deleteCategorySelectionHistory = (id: string) => {
    setCategorySelectionHistory((current) => {
      const next = current.filter((entry) => entry.id !== id);
      saveCategorySelectionHistory(kind, next);
      return next;
    });
  };
  const applySort = useCallback((nextKey: EntityTableSortKey) => {
    if (nextKey === sortKey) setSortDirection((direction) => direction === "desc" ? "asc" : "desc");
    else {
      setSortKey(nextKey);
      setSortDirection("desc");
    }
  }, [sortKey]);
  const togglePromotionExpansion = useCallback((key: string) => {
    setExpandedPromotionKey((current) => current === key ? "" : key);
  }, []);
  useEffect(() => {
    if (expandedPromotionKey && !visibleItems.some((item) => item.key === expandedPromotionKey)) {
      setExpandedPromotionKey("");
    }
  }, [expandedPromotionKey, visibleItems]);
  const activeComparison = comparisons?.[comparisonId];
  const previousItems = useMemo(
    () => activeComparison?.previous[kind === "category" ? "categories" : "products"] || [],
    [activeComparison, kind],
  );
  const previousIndex = useMemo(() => previousEntityIndex(kind, previousItems), [kind, previousItems]);
  const matrixMetricOptions = CUSTOM_METRICS.filter((metric) => !MATRIX_FIXED_METRIC_IDS.has(metric.id));
  const toggleMatrixMetric = (metricId: CustomMetricId) => {
    setMatrixMetricIds((current) => {
      if (current.includes(metricId)) return current.filter((id) => id !== metricId);
      if (current.length >= MATRIX_CUSTOM_METRIC_LIMIT) return current;
      return [...current, metricId];
    });
  };
  const reorderMatrixMetric = (sourceId: CustomMetricId, targetId: CustomMetricId) => {
    setMatrixMetricIds((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = current.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };
  const moveMatrixMetric = (metricId: CustomMetricId, offset: -1 | 1) => {
    setMatrixMetricIds((current) => {
      const sourceIndex = current.indexOf(metricId);
      const targetIndex = sourceIndex + offset;
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
      return next;
    });
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={kind === "product" ? "搜索商品或 ID" : "搜索品类"}
              className="h-8 w-36 border border-slate-200 bg-white pl-8 pr-2 text-xs text-slate-700 outline-none focus:border-teal-500"
            />
          </label>
          {["category", "product"].includes(kind) && (
            <details className="group relative">
              <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:border-teal-400 hover:text-teal-700 [&::-webkit-details-marker]:hidden">
                <Layers3 className="h-3.5 w-3.5" />
                <span>
                  {selectedCategoryNames.size
                    ? `已选 ${selectedCategoryNames.size} 个类目`
                    : "选择类目"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="absolute right-0 top-10 z-30 w-80 border border-slate-200 bg-white p-3 shadow-lg">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    <Check className="h-3.5 w-3.5 text-teal-700" />
                    已保存组合 {categorySelectionHistory.length}/{CATEGORY_SELECTION_HISTORY_LIMIT}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowHistorySave((value) => !value)}
                    disabled={selectedCategoryNames.size === 0}
                    className="text-xs font-medium text-teal-700 hover:text-teal-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    保存当前
                  </button>
                </div>
                {showHistorySave && (
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2 border border-teal-100 bg-teal-50/60 p-2">
                    <input
                      value={historySaveName}
                      onChange={(event) => setHistorySaveName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveCurrentCategorySelection();
                        }
                      }}
                      placeholder="给这组类目命名"
                      className="h-8 min-w-0 border border-teal-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-teal-500"
                    />
                    <button type="button" onClick={saveCurrentCategorySelection} className="inline-flex h-8 items-center gap-1 bg-teal-700 px-2 text-xs font-medium text-white hover:bg-teal-800">
                      <Check className="h-3.5 w-3.5" />保存
                    </button>
                  </div>
                )}
                {categorySelectionHistory.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {categorySelectionHistory.map((entry) => (
                      <div key={entry.id} className="inline-flex max-w-full items-stretch border border-slate-200 bg-slate-50 text-xs text-slate-600 transition-colors hover:border-teal-400 hover:bg-teal-50 hover:text-teal-800">
                        <button
                          type="button"
                          onClick={() => applyCategorySelection(entry.categoryNames)}
                          title={`应用：${entry.categoryNames.join("、")}`}
                          className="inline-flex min-w-0 items-center gap-1 py-1 pl-2 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
                        >
                          <Check className="h-3 w-3 shrink-0 text-teal-700" />
                          <span className="truncate">{entry.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteCategorySelectionHistory(entry.id)}
                          title={`删除“${entry.name}”`}
                          aria-label={`删除已保存组合“${entry.name}”`}
                          className="inline-flex w-6 shrink-0 items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-slate-400">暂无已保存组合。选择类目后点击“保存当前”。</p>
                )}
                <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                  <label className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      value={categoryPickerQuery}
                      onChange={(event) => setCategoryPickerQuery(event.target.value)}
                      placeholder="搜索要负责的类目"
                      className="h-8 w-full border border-slate-200 bg-white pl-8 pr-2 text-xs text-slate-700 outline-none focus:border-teal-500"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryNames(new Set(selectableCategoryOptions))}
                    className="shrink-0 text-xs text-teal-700 hover:text-teal-900"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryNames(new Set())}
                    disabled={selectedCategoryNames.size === 0}
                    className="shrink-0 text-xs text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    清除
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">搜索后勾选会替换旧选择；清空搜索后可继续多选。</p>
                <div className="mt-2 max-h-60 space-y-1 overflow-y-auto border-t border-slate-100 pt-2">
                  {selectableCategoryOptions.length ? (
                    selectableCategoryOptions.map((name) => (
                      <label
                        key={name}
                        className="flex cursor-pointer items-center gap-2 px-1.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedCategoryNames.has(name)}
                          onChange={() => toggleCategorySelection(name)}
                          className="h-3.5 w-3.5 accent-teal-600"
                        />
                        <span className="min-w-0 truncate" title={name}>
                          {name}
                        </span>
                      </label>
                    ))
                  ) : (
                    <div className="px-1.5 py-4 text-center text-xs text-slate-400">
                      没有匹配的类目
                    </div>
                  )}
                </div>
              </div>
            </details>
          )}
          {kind === "product" && (
            <details className="group relative">
              <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:border-teal-400 hover:text-teal-700 [&::-webkit-details-marker]:hidden">
                <Target className="h-3.5 w-3.5" />
                <span>{selectedModelNames.size ? `已选 ${selectedModelNames.size} 个型号` : "选择型号"}</span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="absolute right-0 top-10 z-30 w-72 border border-slate-200 bg-white p-3 shadow-lg">
                <div className="flex items-center gap-2">
                  <label className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      value={modelPickerQuery}
                      onChange={(event) => setModelPickerQuery(event.target.value)}
                      placeholder="搜索型号"
                      className="h-8 w-full border border-slate-200 bg-white pl-8 pr-2 text-xs text-slate-700 outline-none focus:border-teal-500"
                    />
                  </label>
                  <button type="button" onClick={() => setSelectedModelNames(new Set(selectableModelOptions))} className="shrink-0 text-xs text-teal-700 hover:text-teal-900">全选</button>
                  <button type="button" onClick={() => setSelectedModelNames(new Set())} disabled={selectedModelNames.size === 0} className="shrink-0 text-xs text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40">清除</button>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">搜索后勾选会替换旧选择；清空搜索后可继续多选。</p>
                <div className="mt-2 max-h-60 space-y-1 overflow-y-auto border-t border-slate-100 pt-2">
                  {selectableModelOptions.length ? selectableModelOptions.map((name) => (
                    <label key={name} className="flex cursor-pointer items-center gap-2 px-1.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                      <input type="checkbox" checked={selectedModelNames.has(name)} onChange={() => toggleModelSelection(name)} className="h-3.5 w-3.5 accent-teal-600" />
                      <span className="min-w-0 truncate" title={name}>{name}</span>
                    </label>
                  )) : <div className="px-1.5 py-4 text-center text-xs text-slate-400">没有匹配的型号</div>}
                </div>
              </div>
            </details>
          )}
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 hover:border-teal-400 hover:text-teal-800" title={`${showComparisons ? "关闭" : "开启"}${kind === "category" ? "品类" : "商品"}矩阵环比`}>
            <span>环比</span>
            <input type="checkbox" checked={showComparisons} onChange={(event) => setShowComparisons(event.target.checked)} className="peer sr-only" />
            <span className="relative h-4 w-7 bg-slate-200 transition-colors peer-checked:bg-teal-600 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-1 after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:bg-white after:transition-transform peer-checked:after:translate-x-3" />
          </label>
          <button
            type="button"
            onClick={() => setMatrixMetricSettingsOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 hover:border-teal-400 hover:text-teal-800"
          >
            <Settings2 className="h-3.5 w-3.5" />
            自定义数据 {matrixMetricIds.length}/{MATRIX_CUSTOM_METRIC_LIMIT}
          </button>
          <span className="inline-flex items-center gap-1 bg-slate-100 px-2 py-1 text-xs text-slate-600">
            <Layers3 className="h-3.5 w-3.5" />
            {visibleItems.length}/{dataItems.length} 项
          </span>
        </div>
      </CardHeader>
      {["category", "product"].includes(kind) && (
        <div className="grid border-y border-slate-200 bg-slate-50 sm:grid-cols-4 xl:grid-cols-7">
          <div className="border-b border-slate-200 px-4 py-3 sm:col-span-2 xl:col-span-1 xl:border-b-0 xl:border-r">
            <div className="text-xs font-medium text-slate-500">当前汇总</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">
              {kind === "product"
                ? `${visibleItems.length} 个商品${selectedCategoryNames.size ? ` · ${selectedCategoryNames.size} 个类目` : ""}${selectedModelNames.size ? ` · ${selectedModelNames.size} 个型号` : ""}`
                : `${visibleItems.length} 个类目`}
            </div>
          </div>
          <div className="border-b border-slate-200 px-4 py-3 sm:col-span-2 xl:col-span-1 xl:border-b-0 xl:border-r">
            <div className="text-xs font-medium text-slate-500">支付 / 退款</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">
              {money(selectionSummary.grossRevenue)}
            </div>
            <div className="mt-0.5 text-xs text-emerald-600">
              - {money(selectionSummary.refundAmount)}
            </div>
          </div>
          <SummaryMetric label="净 GSV" value={money(selectionSummary.revenue)} />
          <SummaryMetric label="推广花费" value={money(selectionSummary.spend)} />
          <SummaryMetric label="推广成交" value={money(selectionSummary.promotionRevenue)} />
          <SummaryMetric label="ROI" value={fixed(selectionSummary.roi)} />
          <SummaryMetric
            label="费率"
            value={percent(selectionSummary.feeRate)}
            detail={
              selectionSummary.refundDataAvailable
                ? "推广花费 ÷ 净 GSV"
                : "存在未提供退款的数据"
            }
          />
        </div>
      )}
      <div className="max-h-[530px] overflow-auto">
        <table className="w-full text-left text-sm" style={{ minWidth: `${1320 + matrixMetricIds.length * 145}px` }}>
          <thead className="sticky top-0 z-10 border-y border-slate-100 bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">
                <EntitySortHeader label={kind === "product" ? "商品" : "品类"} sortKey="name" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} />
              </th>
              {kind === "product" && (
                <th className="px-4 py-3 font-medium"><EntitySortHeader label="商品 ID" sortKey="productId" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              )}
              {kind === "product" && (
                <th className="px-4 py-3 font-medium"><EntitySortHeader label="型号 / 品类" sortKey="model" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              )}
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="支付 / 退款" sortKey="grossRevenue" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="净 GSV" sortKey="revenue" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="推广花费" sortKey="spend" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="推广成交" sortKey="promotionRevenue" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="ROI" sortKey="roi" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="费率" sortKey="feeRate" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              {matrixMetricIds.map((metricId) => {
                const metric = CUSTOM_METRICS.find((definition) => definition.id === metricId);
                return metric ? <th key={metricId} className="px-4 py-3 font-medium"><EntitySortHeader label={metric.label} sortKey={metricId} activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th> : null;
              })}
              <th className="px-4 py-3 font-medium"><EntitySortHeader label="推广类型 / 计划" sortKey="promotionCount" activeSortKey={sortKey} direction={sortDirection} onSort={applySort} /></th>
              <th className="px-4 py-3 font-medium">关联状态</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.length ? (
              visibleItems.map((item) => (
                <EntityTableRow
                  key={item.key}
                  item={item}
                  kind={kind}
                  expanded={expandedPromotionKey === item.key}
                  onToggle={togglePromotionExpansion}
                  previousItem={previousEntityForItem(kind, item, previousIndex)}
                  comparison={activeComparison}
                  showComparisons={showComparisons}
                  customMetricIds={matrixMetricIds}
                />
              ))
            ) : (
              <tr>
                <td
                  colSpan={(kind === "product" ? 11 : 9) + matrixMetricIds.length}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                >
                  {items.length ? "没有符合当前筛选条件的数据。" : "导入对应报表后展示关联矩阵。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {matrixMetricSettingsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-label={`${kind === "category" ? "品类" : "商品"}矩阵自定义数据`}>
          <section className="max-h-[88vh] w-full max-w-4xl overflow-y-auto border border-slate-200 bg-white shadow-2xl">
            <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-slate-950">{kind === "category" ? "品类 360" : "商品排行"}矩阵自定义数据</h3>
                <p className="mt-1 text-xs text-slate-500">固定经营指标始终保留，可额外选择最多 {MATRIX_CUSTOM_METRIC_LIMIT} 项；每项按当前日期范围自动计算环比。</p>
              </div>
              <button type="button" title="关闭" aria-label="关闭" onClick={() => setMatrixMetricSettingsOpen(false)} className="grid h-8 w-8 shrink-0 place-items-center text-slate-500 hover:bg-slate-100 hover:text-slate-900"><X className="h-4 w-4" /></button>
            </header>
            <div className="border-b border-slate-200 bg-slate-50/70 p-5">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-slate-800">已选列顺序</h4>
                <span className="text-xs tabular-nums text-slate-500">{matrixMetricIds.length}/{MATRIX_CUSTOM_METRIC_LIMIT}</span>
              </div>
              {matrixMetricIds.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2" role="list" aria-label="自定义列顺序">
                  {matrixMetricIds.map((metricId, index) => {
                    const metric = CUSTOM_METRICS.find((item) => item.id === metricId);
                    if (!metric) return null;
                    return (
                      <div
                        key={metric.id}
                        draggable
                        role="listitem"
                        aria-label={`${metric.label}，第 ${index + 1} 列`}
                        title="拖动调整列顺序"
                        onDragStart={(event) => {
                          setDraggingMatrixMetricId(metric.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", metric.id);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const sourceId = (draggingMatrixMetricId || event.dataTransfer.getData("text/plain")) as CustomMetricId;
                          if (sourceId) reorderMatrixMetric(sourceId, metric.id);
                          setDraggingMatrixMetricId(null);
                        }}
                        onDragEnd={() => setDraggingMatrixMetricId(null)}
                        className={`flex min-w-0 items-center gap-2 border bg-white p-2.5 transition ${draggingMatrixMetricId === metric.id ? "border-teal-400 opacity-60" : "border-slate-200 hover:border-teal-300"}`}
                      >
                        <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-400" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <strong className="block truncate text-xs text-slate-800">{index + 1}. {metric.label}</strong>
                          <span className="mt-0.5 block truncate text-[10px] text-slate-500">{metric.description}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button type="button" disabled={index === 0} onClick={() => moveMatrixMetric(metric.id, -1)} title={`上移${metric.label}`} aria-label={`上移${metric.label}`} className="grid h-7 w-7 place-items-center border border-slate-200 text-slate-500 hover:border-teal-300 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
                          <button type="button" disabled={index === matrixMetricIds.length - 1} onClick={() => moveMatrixMetric(metric.id, 1)} title={`下移${metric.label}`} aria-label={`下移${metric.label}`} className="grid h-7 w-7 place-items-center border border-slate-200 text-slate-500 hover:border-teal-300 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">尚未选择自定义列</div>
              )}
            </div>
            <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {matrixMetricOptions.map((metric) => {
                const selected = matrixMetricIds.includes(metric.id);
                const disabled = !selected && matrixMetricIds.length >= MATRIX_CUSTOM_METRIC_LIMIT;
                return (
                  <label key={metric.id} className={`flex items-start gap-3 border p-3 transition-colors ${disabled ? "cursor-not-allowed border-slate-100 bg-slate-50 opacity-50" : selected ? "cursor-pointer border-teal-300 bg-teal-50/70" : "cursor-pointer border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}>
                    <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleMatrixMetric(metric.id)} className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">{metric.label}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-slate-500">{metric.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <footer className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-3">
              <span className="text-xs text-slate-500">已选择 {matrixMetricIds.length}/{MATRIX_CUSTOM_METRIC_LIMIT} 项</span>
              <Button type="button" onClick={() => setMatrixMetricSettingsOpen(false)}>完成</Button>
            </footer>
          </section>
        </div>
      )}
    </Card>
  );
}

function EntitySortHeader({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: EntityTableSortKey;
  activeSortKey: EntityTableSortKey;
  direction: "asc" | "desc";
  onSort: (key: EntityTableSortKey) => void;
}) {
  const active = sortKey === activeSortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      title={active ? `当前${direction === "desc" ? "从高到低" : "从低到高"}，点击切换` : `按${label}排序`}
      className={`inline-flex items-center gap-1 text-left transition-colors hover:text-teal-700 ${active ? "font-semibold text-teal-800" : "text-slate-500"}`}
    >
      {label}
      <ArrowDownUp className={`h-3 w-3 ${active ? "text-teal-700" : "text-slate-300"}`} />
    </button>
  );
}

const EntityTableRow = memo(function EntityTableRow({
  item,
  kind,
  expanded,
  onToggle,
  previousItem,
  comparison,
  showComparisons,
  customMetricIds,
}: {
  item: OperationsBusinessEntity;
  kind: EntityPanel;
  expanded: boolean;
  onToggle: (key: string) => void;
  previousItem: OperationsComparisonEntity | null;
  comparison: OperationsComparison | undefined;
  showComparisons: boolean;
  customMetricIds: CustomMetricId[];
}) {
  const promotionTypeCount = item.promotionChannels.length;
  const promotionPlanCount = promotionPlanCountFor(item.promotionChannels);
  const promotionSummary = promotionTypeSummary(item.promotionChannels);
  const columnCount = (kind === "product" ? 11 : 9) + customMetricIds.length;
  const comparisonBadge = (metricId: CustomMetricId) => showComparisons
    ? <EntityComparisonBadge item={item} previousItem={previousItem} metricId={metricId} comparison={comparison} />
    : null;
  return (
    <Fragment>
      <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
        <td className="max-w-sm px-4 py-3">
          <div className="truncate font-medium text-slate-900" title={item.name}>{item.name}</div>
          <div className="mt-1 text-xs text-slate-400">
            经营 {item.salesCount} 行 · 推广 {item.promotionCount} 行{promotionTypeCount ? ` · ${promotionTypeCount} 类 ${promotionPlanCount} 个计划` : ""}
          </div>
        </td>
        {kind === "product" && (
          <td className="px-4 py-3 font-mono text-xs text-slate-600">{item.productId || "--"}</td>
        )}
        {kind === "product" && (
          <td className="px-4 py-3 text-xs text-slate-600">
            <div className="font-medium text-slate-700">{item.model || "型号待补"}</div>
            <div className="mt-1 text-slate-400">{item.category || "品类待补"}</div>
          </td>
        )}
        <td className="px-4 py-3 text-slate-700">
          <div className="flex flex-wrap items-center gap-1.5"><span>{money(item.grossRevenue)}</span>{comparisonBadge("grossRevenue")}</div>
          {item.refundDataAvailable ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-emerald-600"><span>- {money(item.refundAmount)}</span>{comparisonBadge("refundAmount")}</div>
          ) : (
            <div className="mt-1 text-xs text-amber-600">待补退款字段</div>
          )}
        </td>
        <td className="px-4 py-3 font-medium text-slate-900"><div>{money(item.revenue)}</div>{showComparisons && <div className="mt-1">{comparisonBadge("revenue")}</div>}</td>
        <td className="px-4 py-3 text-slate-700"><div>{money(item.spend)}</div>{showComparisons && <div className="mt-1">{comparisonBadge("spend")}</div>}</td>
        <td className="px-4 py-3 text-slate-700"><div>{money(item.promotionRevenue)}</div>{showComparisons && <div className="mt-1">{comparisonBadge("promotionRevenue")}</div>}</td>
        <td className="px-4 py-3 font-medium text-slate-800"><div>{fixed(item.roi)}</div>{showComparisons && <div className="mt-1">{comparisonBadge("roi")}</div>}</td>
        <td className="px-4 py-3 font-medium text-slate-800"><div>{percent(item.feeRate)}</div>{showComparisons && <div className="mt-1">{comparisonBadge("feeRate")}</div>}</td>
        {customMetricIds.map((metricId) => (
          <td key={metricId} className="px-4 py-3 text-slate-700">
            <div className="font-medium text-slate-800">{formatCustomMetric(metricId, entityMetricValue(item, metricId))}</div>
            {showComparisons && <div className="mt-1">{comparisonBadge(metricId)}</div>}
          </td>
        ))}
        <td className="px-4 py-3">
          {promotionTypeCount ? (
            <button
              type="button"
              onClick={() => onToggle(item.key)}
              title={promotionSummary}
              className="inline-flex min-h-8 max-w-[240px] items-start gap-1.5 border border-slate-200 bg-white px-2 py-1.5 text-left text-xs leading-4 text-slate-700 transition-colors hover:border-teal-400 hover:text-teal-800"
            >
              {expanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>{promotionSummary}</span>
            </button>
          ) : <span className="text-xs text-slate-400">暂无付费数据</span>}
        </td>
        <td className="px-4 py-3"><MatchBadge status={item.matchStatus} /></td>
      </tr>
      {expanded && promotionTypeCount > 0 && (
        <tr className="border-b border-slate-100 bg-slate-50/70">
          <td colSpan={columnCount} className="px-4 py-3">
            <PromotionChannelBreakdown
              channels={item.promotionChannels}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
});

function promotionPlanCountFor(channels: OperationsBusinessEntity["promotionChannels"]) {
  return channels.reduce((total, type) => total + (Number.isFinite(type.planCount) ? type.planCount : type.plans?.length || 0), 0);
}

function promotionTypeSummary(channels: OperationsBusinessEntity["promotionChannels"]) {
  const totalPlans = promotionPlanCountFor(channels);
  const listed = channels.slice(0, 2).map((type) => `${type.name} ${Number.isFinite(type.planCount) ? type.planCount : type.plans?.length || 0} 个计划`);
  if (channels.length <= 2) return listed.join(" · ");
  return `${listed.join(" · ")} · 等 ${channels.length} 类 / ${totalPlans} 个计划`;
}

const promotionTypeTones = [
  { border: "border-emerald-200", header: "bg-emerald-50 text-emerald-950", dot: "bg-emerald-600", meta: "text-emerald-700" },
  { border: "border-amber-200", header: "bg-amber-50 text-amber-950", dot: "bg-amber-500", meta: "text-amber-700" },
  { border: "border-sky-200", header: "bg-sky-50 text-sky-950", dot: "bg-sky-600", meta: "text-sky-700" },
  { border: "border-rose-200", header: "bg-rose-50 text-rose-950", dot: "bg-rose-600", meta: "text-rose-700" },
] as const;

function promotionTypeTone(name: string) {
  if (/全站/.test(name)) return { border: "border-blue-200", header: "bg-blue-50 text-blue-950", dot: "bg-blue-600", meta: "text-blue-700" };
  if (/关键词/.test(name)) return { border: "border-violet-200", header: "bg-violet-50 text-violet-950", dot: "bg-violet-600", meta: "text-violet-700" };
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return promotionTypeTones[hash % promotionTypeTones.length];
}

const PromotionChannelBreakdown = memo(function PromotionChannelBreakdown({
  channels,
}: {
  channels: OperationsBusinessEntity["promotionChannels"];
}) {
  return (
    <div className="space-y-3">
      {channels.map((type) => {
        const tone = promotionTypeTone(type.name);
        const plans = type.plans?.length ? type.plans : [{
          name: "未分组计划",
          rowCount: type.rowCount,
          spend: type.spend,
          promotionRevenue: type.promotionRevenue,
          roi: type.roi,
          clicks: type.clicks,
          impressions: type.impressions,
          orders: type.orders,
          linkedRevenue: type.linkedRevenue,
          linkedProductCount: type.linkedProductCount,
          feeRate: type.feeRate,
        }];
        return (
          <section key={type.name} className={`overflow-x-auto border bg-white ${tone.border}`}>
            <div className={`flex min-w-[820px] items-center justify-between gap-4 border-b px-3 py-2.5 ${tone.border} ${tone.header}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" title={type.name}>{type.name}</div>
                  <div className={`mt-0.5 text-[11px] font-medium ${tone.meta}`}>{type.planCount || plans.length} 个计划</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-right text-xs">
                <div><div className="text-[10px] opacity-70">花费</div><div className="mt-0.5 font-semibold">{money(type.spend)}</div></div>
                <div><div className="text-[10px] opacity-70">关联净 GSV</div><div className="mt-0.5 font-semibold">{money(type.linkedRevenue)}</div></div>
                <div><div className="text-[10px] opacity-70">成交</div><div className="mt-0.5 font-semibold">{money(type.promotionRevenue)}</div></div>
                <div><div className="text-[10px] opacity-70">ROI</div><div className="mt-0.5 font-semibold">{fixed(type.roi)}</div></div>
                <div><div className="text-[10px] opacity-70">推广费率</div><div className="mt-0.5 font-semibold">{percent(type.feeRate)}</div></div>
              </div>
            </div>
            <div className="min-w-[820px]">
              <div className="grid grid-cols-[minmax(220px,1.7fr)_repeat(4,minmax(76px,0.7fr))] border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
                <span>计划名称</span>
                <span className="text-right">花费</span>
                <span className="text-right">计划成交</span>
                <span className="text-right">ROI</span>
                <span className="text-right">计划费率</span>
              </div>
              {plans.map((plan, index) => (
                <div key={`${plan.name}-${index}`} className="grid grid-cols-[minmax(220px,1.7fr)_repeat(4,minmax(76px,0.7fr))] border-b border-slate-100 px-3 py-2 last:border-b-0 text-xs text-slate-600">
                  <span className="truncate font-medium text-slate-800" title={plan.name}>{plan.name}</span>
                  <span className="text-right font-medium text-slate-800">{money(plan.spend)}</span>
                  <span className="text-right font-medium text-slate-800">{money(plan.promotionRevenue)}</span>
                  <span className="text-right font-medium text-slate-800">{fixed(plan.roi)}</span>
                  <span className="text-right font-medium text-slate-800">{percent(plan.feeRate)}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
});

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="border-b border-slate-200 px-4 py-3 sm:col-span-2 xl:col-span-1 xl:border-b-0 xl:border-r last:border-r-0">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
      {detail && <div className="mt-0.5 truncate text-[11px] text-slate-400">{detail}</div>}
    </div>
  );
}
