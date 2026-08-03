#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const TOOL_TOKEN = String(process.env.ECOM_AGENT_TOOL_TOKEN || "").trim();
const WORKSPACE_DIR = path.resolve(String(process.env.ECOM_AGENT_WORKSPACE_DIR || process.cwd()));
const MEDIA_DIR = path.resolve(String(process.env.ECOM_AGENT_MEDIA_DIR || path.join(WORKSPACE_DIR, "media")));
const APP_BASE_URL = normalizeLocalBaseUrl(process.env.ECOM_AGENT_APP_URL || "");
const DEFAULT_IMAGE_REQUEST = Object.freeze({
  ratio: "1:1",
  resolution: "2k",
  quality: "high",
  format: "png",
  background: "auto",
  count: 1,
});
const OPERATIONS_ENTITY_TYPES = Object.freeze(["all", "store", "category", "product", "audience"]);
const OPERATIONS_METRICS = Object.freeze([
  "gross_revenue", "refund_amount", "gsv", "promotion_spend", "promotion_revenue", "fee_rate",
  "management_roi", "platform_roi", "visitors", "paid_buyers", "conversion_rate", "clicks",
  "impressions", "orders", "page_views", "favorites", "cart_users", "cart_items", "paid_items",
  "collection_cart_rate", "cpc", "cost_per_collect_cart", "sales_rows", "promotion_rows",
]);
const registeredReferenceImages = new Map();

const PRICE_CHANNELS = Object.freeze([
  { key: "normal", label: "普通价" },
  { key: "gift", label: "礼金价" },
  { key: "government", label: "国补价" },
  { key: "coin", label: "淘金币价" },
  { key: "seckill", label: "淘宝秒杀价" },
  { key: "billion", label: "百亿补贴价" },
  { key: "surprise", label: "惊喜立减价" },
  { key: "vip88", label: "88VIP价" },
]);

function normalizeLocalBaseUrl(value) {
  const parsed = new URL(String(value || ""));
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Agent 工具只能连接本机应用服务。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("本机应用服务地址无效。");
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function jsonSchema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function operationsQueryProperties() {
  return {
    period_kind: { type: "string", enum: ["all", "day", "week", "month", "custom"], description: "展示周期；一般保持 all。" },
    source_period_kind: { type: "string", enum: ["auto", "all", "day", "week", "month", "custom"], description: "报表原始周期。指定日期范围时优先使用 auto，避免把月报和日报混算。" },
    start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "开始日期，YYYY-MM-DD。" },
    end: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "结束日期，YYYY-MM-DD。" },
    store_name: { type: "string", maxLength: 80, description: "店铺名称；必须使用数据字典或查询结果中的准确名称。" },
    entity_type: { type: "string", enum: OPERATIONS_ENTITY_TYPES, description: "查询对象层级。传 entity_ids 时不能使用 all。" },
    entity_ids: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 80, description: "精确对象标识，可使用商品 ID、型号、名称、品类名或店铺名。" },
    metrics: { type: "array", items: { type: "string", enum: OPERATIONS_METRICS }, maxItems: OPERATIONS_METRICS.length, description: "需要返回或重点分析的指标；为空时返回全部指标。" },
  };
}

function creationRequestProperties() {
  return {
    user_request: { type: "string", minLength: 1, maxLength: 4_000, description: "用户原始创作需求，不要自行补造品牌、型号、价格或活动信息。" },
    creation_mode: { type: "string", enum: ["product", "free"], description: "商品模式必须先登记至少一张产品参考图。" },
    ratio: { type: "string", enum: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9"] },
    resolution: { type: "string", enum: ["1k", "2k", "4k"] },
    quality: { type: "string", enum: ["low", "medium", "high"] },
    background: { type: "string", enum: ["auto", "opaque", "transparent"] },
    reference_image_ids: { type: "array", items: { type: "string" }, maxItems: 3, description: "upload_reference_image 返回的产品参考图 ID。" },
  };
}

const tools = [
  {
    name: "get_workspace_state",
    description: "读取本机商品监控、登录状态、抓取队列和最近运行结果。仅查询，不会操作账号或浏览器。",
    inputSchema: jsonSchema(),
  },
  {
    name: "find_products",
    description: "按商品名称、店铺名、商品 ID 或分组在本机监控列表中查找商品。",
    inputSchema: jsonSchema({ query: { type: "string", description: "可为空；为空时返回最近商品。" }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  },
  {
    name: "get_product_prices",
    description: "读取某个已监控商品的当前本地已验证价格矩阵。结果逐 SKU、逐账号视角完整列出所有已验证渠道；不会发起新的网页采集，也不会用历史价格替代当前结果。",
    inputSchema: jsonSchema({ product_id: { type: "string" }, item_id: { type: "string" } }),
  },
  {
    name: "capture_product_price",
    description: "使用本机已授权浏览器采集商品价格。采集后必须先保存脱敏证据到本地并从文件重读解析；返回全部 SKU 的已验证结果。默认仅使用主账号，all 会依次调用已登录账号。",
    inputSchema: jsonSchema({
      product_url_or_id: { type: "string", description: "淘宝/天猫商品链接、商品 ID，或已存在的产品 ID。" },
      platform: { type: "string", enum: ["taobao", "tmall"], description: "只传商品 ID 时使用，默认 taobao。" },
      account_type: { type: "string", enum: ["normal", "gift", "vip88"], description: "新建监控商品时的默认账号类型。" },
      account_mode: { type: "string", enum: ["primary", "all"], description: "默认 primary。" },
    }, ["product_url_or_id"]),
  },
  {
    name: "set_product_monitoring",
    description: "直接启用或暂停一个已存在商品的监控。不会删除商品或历史快照。",
    inputSchema: jsonSchema({ product_id: { type: "string" }, enabled: { type: "boolean" }, group: { type: "string" } }, ["product_id", "enabled"]),
  },
  {
    name: "set_sku_monitor_price",
    description: "设置或清空指定 SKU、指定价格通道的监控价。设置后立即保存到本机。",
    inputSchema: jsonSchema({
      product_id: { type: "string" }, sku_id: { type: "string" }, value: { type: ["number", "null"] },
      channel: { type: "string", enum: ["lowest", "normal", "gift", "government", "coin", "seckill", "billion", "surprise", "vip88"] },
    }, ["product_id", "sku_id", "value"]),
  },
  {
    name: "retry_local_product_data",
    description: "只对已经落盘的本地证据做二次解析，或重试买家秀、素材和搜索主图。不会直接请求淘宝或天猫接口。",
    inputSchema: jsonSchema({
      product_id: { type: "string" },
      kind: { type: "string", enum: ["price", "buyer-show", "materials", "search-main-image"] },
    }, ["product_id", "kind"]),
  },
  {
    name: "get_capture_queue",
    description: "读取本机抓取队列、等待授权、成功和失败任务的状态。",
    inputSchema: jsonSchema(),
  },
  {
    name: "capture_products_batch",
    description: "对本机已存在的多个商品执行一次价格、买家秀或素材抓取。价格仍严格走授权浏览器取证和本地证据解析。",
    inputSchema: jsonSchema({ product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, kind: { type: "string", enum: ["price", "buyer-show", "materials"] } }, ["product_ids"]),
  },
  {
    name: "set_global_monitor",
    description: "直接启用或暂停全局监控，也可以调整间隔分钟数。不会改动各商品的价格阈值。",
    inputSchema: jsonSchema({ running: { type: "boolean" }, interval_minutes: { type: "integer", minimum: 30, maximum: 1440 } }),
  },
  {
    name: "sync_product_to_feishu",
    description: "将一个商品的最新已验证价格和状态同步到应用已配置的飞书通知目标。",
    inputSchema: jsonSchema({ product_id: { type: "string" } }, ["product_id"]),
  },
  {
    name: "get_local_evidence_status",
    description: "读取本机证据文件的保存位置、容量与清理策略。不会打开或上传证据文件。",
    inputSchema: jsonSchema(),
  },
  {
    name: "get_operations_schema",
    description: "读取经营罗盘可查询的店铺/品类/商品/人群层级、全部指标、单位和正式计算公式。分析前不确定字段或公式时必须先调用。",
    inputSchema: jsonSchema(),
  },
  {
    name: "get_operations_data",
    description: "按店铺、日期、报表周期、对象和指标精准读取本机运营数据。返回明确查询口径、未匹配对象和服务端重新汇总后的指标。",
    inputSchema: jsonSchema(operationsQueryProperties()),
  },
  {
    name: "analyze_operations_data",
    description: "按店铺、日期、报表周期、对象和指标范围生成经营分析。金额和比率由正式汇总引擎计算，不会修改推广计划。",
    inputSchema: jsonSchema(operationsQueryProperties()),
  },
  {
    name: "preview_operations_report",
    description: "检查 QwenPaw 工作区 media 目录中的报表或截图，返回可识别字段、样例行和建议分类；适合飞书附件自动归档前调用。",
    inputSchema: jsonSchema({ file_path: { type: "string" } }, ["file_path"]),
  },
  {
    name: "import_operations_report",
    description: "将 QwenPaw 工作区 media 目录中的生意参谋、达摩盘、推广、人群、市场或竞品附件导入本机。导入后立即返回更新后的数据工作区。",
    inputSchema: jsonSchema({
      file_path: { type: "string" }, report_type: { type: "string", enum: ["promotion", "market", "audience", "competitor"] },
      store_name: { type: "string" }, report_date: { type: "string" }, source_name: { type: "string" },
    }, ["file_path", "report_type"]),
  },
  {
    name: "get_image_queue",
    description: "读取本机 AI 生图队列、结果和失败原因。",
    inputSchema: jsonSchema(),
  },
  {
    name: "get_image_library",
    description: "读取本机 AI 图片相册，可按全部、收藏、活动或已归档筛选。",
    inputSchema: jsonSchema({ scope: { type: "string", enum: ["all", "active", "favorites", "archived"] } }),
  },
  {
    name: "update_image_library_item",
    description: "收藏、取消收藏、归档或恢复本机图片相册中的图片；不会删除图片文件。",
    inputSchema: jsonSchema({ image_id: { type: "string" }, favorite: { type: "boolean" }, archived: { type: "boolean" } }, ["image_id"]),
  },
  {
    name: "upload_reference_image",
    description: "把QwenPaw工作区media目录中的图片登记为安全参考图句柄。不会读取media目录之外的文件；后续提示词或生图任务使用返回的 reference_image_id。",
    inputSchema: jsonSchema({ file_path: { type: "string" }, role: { type: "string", enum: ["reference", "mask"] } }, ["file_path"]),
  },
  {
    name: "analyze_creation_request",
    description: "理解用户的一句话创作需求，结合已登记参考图确定任务类型、产品事实、修改边界和推荐方案；不提交生图任务。",
    inputSchema: jsonSchema(creationRequestProperties(), ["user_request"]),
  },
  {
    name: "create_prompt_plan",
    description: "根据用户需求和已登记参考图生成安全、商业、创意三套可执行提示词方案，可保存到AI创作历史。",
    inputSchema: jsonSchema({ ...creationRequestProperties(), save_history: { type: "boolean" } }, ["user_request"]),
  },
  {
    name: "create_image_task",
    description: "把用户确认的创作需求提交到本机 AI 生图队列。返回任务 ID 和状态，不会访问账号或文件系统。",
    inputSchema: jsonSchema({
      prompt: { type: "string" }, negative_prompt: { type: "string" }, ratio: { type: "string", enum: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "custom"] },
      custom_width: { type: "integer", minimum: 512, maximum: 4096 }, custom_height: { type: "integer", minimum: 512, maximum: 4096 },
      resolution: { type: "string", enum: ["1k", "2k", "4k"] }, quality: { type: "string", enum: ["low", "medium", "high"] }, count: { type: "integer", minimum: 1, maximum: 4 },
      format: { type: "string", enum: ["png", "jpeg", "webp"] }, background: { type: "string", enum: ["auto", "opaque", "transparent"] }, compression: { type: "integer", minimum: 0, maximum: 100 },
      source_image_id: { type: "string" }, edit_intent: { type: "string", enum: ["local", "background", "outpaint", "redraw"] }, composition_mode: { type: "string", enum: ["keep", "smart"] },
      reference_image_ids: { type: "array", items: { type: "string" }, maxItems: 4 }, mask_image_id: { type: "string" },
      copy_text: { type: "string", maxLength: 500 }, copy_position: { type: "string", enum: ["top", "center", "bottom"] },
      copy_style: { type: "string", enum: ["light", "dark"] }, copy_scale: { type: "string", enum: ["small", "medium", "large"] },
    }, ["prompt"]),
  },
  {
    name: "retry_image_task",
    description: "重试一个失败或已取消的AI生图任务，复用原任务参数和已保存参考图。",
    inputSchema: jsonSchema({ job_id: { type: "string" } }, ["job_id"]),
  },
  {
    name: "cancel_image_task",
    description: "取消一个排队中或运行中的AI生图任务；已生成图片不会删除。",
    inputSchema: jsonSchema({ job_id: { type: "string" } }, ["job_id"]),
  },
  {
    name: "open_image_in_photoshop",
    description: "把图片相册中的指定图片打开到本机Photoshop工作文件。",
    inputSchema: jsonSchema({ image_id: { type: "string" } }, ["image_id"]),
  },
  {
    name: "sync_image_from_photoshop",
    description: "将Photoshop工作文件中的最新修改同步回经营罗盘图片相册。",
    inputSchema: jsonSchema({ image_id: { type: "string" } }, ["image_id"]),
  },
  {
    name: "get_agent_activity",
    description: "读取本机 QwenPaw Agent 最近执行过的应用动作与结果。",
    inputSchema: jsonSchema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function safeValue(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(cookie|token|secret|authorization|api[_-]?key|signature|password|loginbundle)/i.test(key))
      .slice(0, 100)
      .map(([key, item]) => [key, safeValue(item, depth + 1)]));
  }
  if (typeof value === "string") return value.slice(0, 4_000);
  return value;
}

async function localApi(pathname, { method = "GET", body, form } = {}) {
  const url = new URL(pathname, APP_BASE_URL);
  const headers = { "x-ecom-agent-token": TOOL_TOKEN };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(180_000) });
  const source = await response.text();
  let parsed = source;
  try { parsed = source ? JSON.parse(source) : null; } catch { /* keep text */ }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed ? parsed.message || parsed.error?.message : source;
    const error = new Error(message || `本机应用请求失败：${response.status}`);
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

function compactProduct(product = {}) {
  return safeValue({
    id: product.id,
    itemId: product.itemId,
    name: product.name,
    shopName: product.shopName,
    group: product.group,
    accountType: product.accountType,
    enabled: product.enabled,
    lastStatus: product.lastStatus,
    lastError: product.lastError,
    updatedAt: product.updatedAt,
    skuCount: Array.isArray(product.lastSnapshot?.skuPrices) ? product.lastSnapshot.skuPrices.length : undefined,
  });
}

function textValue(value, limit = 500) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function verifiedPriceChannels(priceResolution = {}) {
  const channels = priceResolution?.channels && typeof priceResolution.channels === "object"
    ? priceResolution.channels
    : {};
  return PRICE_CHANNELS.flatMap(({ key, label }) => {
    const resolution = channels[key];
    const valueCents = resolution?.valueCents;
    if (resolution?.status !== "verified" || typeof valueCents !== "number" || !Number.isInteger(valueCents) || valueCents < 0) return [];
    return [{
      key,
      label: textValue(resolution.label, 80) || label,
      value: valueCents / 100,
      valueCents,
      evidenceCount: Array.isArray(resolution.evidenceIds) ? resolution.evidenceIds.length : 0,
    }];
  });
}

function unavailablePriceChannels(priceResolution = {}) {
  const channels = priceResolution?.channels && typeof priceResolution.channels === "object"
    ? priceResolution.channels
    : {};
  return PRICE_CHANNELS.flatMap(({ key, label }) => {
    const resolution = channels[key];
    if (resolution?.status === "verified" && typeof resolution?.valueCents === "number" && Number.isInteger(resolution.valueCents)) return [];
    return [{
      key,
      label,
      status: textValue(resolution?.status, 40) || "unavailable",
      reason: textValue(resolution?.reason, 240) || "no-verified-evidence",
    }];
  });
}

function priceViewForSku(sku = {}, snapshot = {}, product = {}, accountPrice = null) {
  const view = accountPrice && typeof accountPrice === "object" ? accountPrice : sku;
  const priceResolution = view.priceResolution || {};
  return {
    account: {
      sessionId: textValue(view.sessionId || snapshot.primaryAccountSessionId || product.primaryAccountSessionId, 160),
      name: textValue(view.accountName, 160) || "当前账号",
      type: textValue(view.accountType || snapshot.primaryAccountType || product.accountType, 40) || "normal",
      capturedAt: textValue(view.capturedAt || snapshot.capturedAt, 80),
    },
    verifiedChannels: verifiedPriceChannels(priceResolution),
    unavailableChannels: unavailablePriceChannels(priceResolution),
  };
}

function currentVerifiedPriceReport(product = {}) {
  const snapshot = product.lastSnapshot && typeof product.lastSnapshot === "object" ? product.lastSnapshot : null;
  const skus = Array.isArray(snapshot?.skuPrices) ? snapshot.skuPrices : [];
  const accountScope = Array.isArray(snapshot?.accountCaptures) ? snapshot.accountCaptures.map((capture) => ({
    sessionId: textValue(capture?.sessionId, 160),
    name: textValue(capture?.accountName, 160) || "当前账号",
    type: textValue(capture?.accountType, 40) || "normal",
    capturedAt: textValue(capture?.capturedAt || snapshot?.capturedAt, 80),
  })) : [];
  const rows = skus.map((sku) => {
    const accountPrices = Array.isArray(sku?.accountPrices) ? sku.accountPrices.filter((view) => view && typeof view === "object") : [];
    return {
      skuId: textValue(sku?.skuId, 160),
      skuName: textValue(sku?.name, 600) || "未命名 SKU",
      accountViews: (accountPrices.length ? accountPrices : [null]).map((accountPrice) => priceViewForSku(sku, snapshot, product, accountPrice)),
    };
  });
  return {
    kind: "current_verified_sku_price_matrix",
    product: compactProduct(product),
    snapshot: snapshot ? {
      capturedAt: textValue(snapshot.capturedAt, 80),
      source: "current-local-snapshot",
      localEvidence: {
        saved: Boolean(snapshot.localFirst?.sourceSaved),
        sanitized: Boolean(snapshot.localFirst?.sourceSanitized),
        readFromDisk: Boolean(snapshot.localFirst?.parsedFromDisk),
      },
    } : null,
    accountScope,
    skuCount: rows.length,
    skuRows: rows,
    reportingRule: "必须逐 SKU 列出 verifiedChannels；unavailableChannels 仅表示当前没有通过证据校验，不能猜价或使用历史价格替代。",
  };
}

function candidateItemId(value) {
  return String(value || "").match(/^\d{6,20}$/)?.[0] || "";
}

function productMatches(product, value) {
  const query = String(value || "").trim().toLowerCase();
  if (!query) return false;
  return [product.id, product.itemId, product.name, product.shopName, product.group]
    .filter(Boolean).some((item) => String(item).toLowerCase().includes(query));
}

async function workspaceOverview() {
  return localApi("/api/overview");
}

async function resolveProduct(value) {
  const overview = await workspaceOverview();
  const candidates = (overview.products || []).filter((product) => productMatches(product, value));
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error("本机监控列表中没有找到该商品。请提供商品链接、商品 ID 或先用查价工具新建它。");
  throw new Error(`找到 ${candidates.length} 个匹配商品，请改用明确的 product_id：${candidates.map((item) => item.id).join("、")}`);
}

async function ensureProduct(value, input) {
  try {
    return await resolveProduct(value);
  } catch (error) {
    if (!/^本机监控列表中没有找到/.test(error.message || "")) throw error;
  }
  const raw = String(value || "").trim();
  const itemId = candidateItemId(raw);
  const platform = input.platform === "tmall" ? "tmall" : "taobao";
  const url = itemId
    ? `https://${platform === "tmall" ? "detail.tmall.com" : "item.taobao.com"}/item.htm?id=${itemId}`
    : raw;
  try {
    return await localApi("/api/products", {
      method: "POST",
      body: {
        url,
        name: itemId ? `商品 ${itemId}` : "",
        group: "Agent 查价",
        accountType: input.account_type || "normal",
        captureBuyerShows: false,
        captureMediaAssets: false,
      },
    });
  } catch (error) {
    if (error.status === 409 && error.payload?.productId) return resolveProduct(error.payload.productId);
    throw error;
  }
}

function safeWorkspace(workspace = {}) {
  return safeValue({
    freshness: workspace.freshness,
    totals: workspace.totals,
    products: workspace.products,
    stores: workspace.stores,
    categories: workspace.categories,
    audiences: workspace.audiences,
    suggestions: workspace.suggestions,
    reports: (workspace.reports || []).map((report) => ({ id: report.id, type: report.type, storeName: report.storeName, reportDate: report.reportDate, sourceName: report.sourceName, fileName: report.fileName, importedAt: report.importedAt })),
  });
}

async function resolveAttachmentPath(value) {
  const mediaDirectory = await fs.realpath(MEDIA_DIR);
  const requested = await fs.realpath(path.resolve(String(value || "")));
  const relative = path.relative(mediaDirectory, requested);
  if (!requested || (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error("只允许导入 QwenPaw 工作区 media 目录中的附件。");
  }
  const stat = await fs.stat(requested);
  if (!stat.isFile()) throw new Error("附件路径不是可读取的文件。");
  return requested;
}

function mimeType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({ ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extension] || "application/octet-stream";
}

async function reportForm(filePath, fields = {}) {
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType(filePath) }), path.basename(filePath));
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value || ""));
  return form;
}

function operationsQueryBody(input = {}) {
  return {
    ...(input.period_kind ? { periodKind: input.period_kind } : {}),
    ...(input.source_period_kind ? { sourcePeriodKind: input.source_period_kind } : {}),
    ...(input.start ? { start: input.start } : {}),
    ...(input.end ? { end: input.end } : {}),
    ...(input.store_name ? { storeName: input.store_name } : {}),
    ...(input.entity_type ? { entityType: input.entity_type } : {}),
    ...(Array.isArray(input.entity_ids) ? { entityIds: input.entity_ids } : {}),
    ...(Array.isArray(input.metrics) ? { metrics: input.metrics } : {}),
  };
}

async function registerReferenceImage(filePath, role = "reference") {
  const resolved = await resolveAttachmentPath(filePath);
  const type = mimeType(resolved);
  if (!type.startsWith("image/")) throw new Error("参考文件必须是 PNG、JPEG 或 WebP 图片。");
  const stat = await fs.stat(resolved);
  if (stat.size > 8 * 1024 * 1024) throw new Error("单张参考图不能超过 8 MB。");
  const signature = `${resolved}\0${stat.size}\0${stat.mtimeMs}`;
  const id = `reference_${createHash("sha256").update(signature).digest("hex").slice(0, 20)}`;
  const record = { id, filePath: resolved, fileName: path.basename(resolved), mimeType: type, role, size: stat.size, signature };
  registeredReferenceImages.set(id, record);
  return record;
}

async function registeredReferenceImage(id, expectedRole = "reference") {
  const record = registeredReferenceImages.get(String(id || ""));
  if (!record) throw new Error(`参考图句柄不存在或Agent已重启，请重新调用 upload_reference_image：${id || "未提供 ID"}`);
  if (record.role !== expectedRole) throw new Error(expectedRole === "mask" ? "请选择登记为 mask 的蒙版图片。" : "蒙版图片不能作为普通产品参考图。" );
  const resolved = await resolveAttachmentPath(record.filePath);
  const stat = await fs.stat(resolved);
  const signature = `${resolved}\0${stat.size}\0${stat.mtimeMs}`;
  if (signature !== record.signature) throw new Error(`参考图 ${record.fileName} 已发生变化，请重新登记。`);
  return record;
}

async function registeredReferenceList(ids = [], role = "reference") {
  return Promise.all([...new Set(ids || [])].map((id) => registeredReferenceImage(id, role)));
}

async function appendRegisteredImages(form, field, records) {
  for (const record of records) {
    const buffer = await fs.readFile(record.filePath);
    form.append(field, new Blob([buffer], { type: record.mimeType }), record.fileName);
  }
}

function promptParameters(input = {}) {
  return {
    ratio: input.ratio || "1:1",
    resolution: input.resolution || "2k",
    quality: input.quality || "high",
    background: input.background || "auto",
  };
}

async function quickPromptForm(input, { saveHistory = false } = {}) {
  const references = await registeredReferenceList(input.reference_image_ids || [], "reference");
  const form = new FormData();
  form.append("request", JSON.stringify({
    userRequest: String(input.user_request || "").trim(),
    parameters: promptParameters(input),
    creationMode: input.creation_mode || (references.length ? "product" : "free"),
    saveHistory,
  }));
  await appendRegisteredImages(form, "productImages", references);
  return form;
}

async function imageTaskForm(request, referenceIds = [], maskId = "") {
  const references = await registeredReferenceList(referenceIds, "reference");
  const mask = maskId ? await registeredReferenceImage(maskId, "mask") : null;
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  await appendRegisteredImages(form, "referenceImages", references);
  if (mask) await appendRegisteredImages(form, "maskImage", [mask]);
  return { form, referenceCount: references.length, maskApplied: Boolean(mask) };
}

async function executeTool(name, input = {}) {
  switch (name) {
    case "get_workspace_state": {
      const overview = await workspaceOverview();
      return safeValue({
        products: (overview.products || []).slice(0, 50).map(compactProduct),
        authSessions: (overview.authSessions || []).map(({ id, name, accountType, loginStatus, healthStatus, tmallPriceStatus, checkedAt }) => ({ id, name, accountType, loginStatus, healthStatus, tmallPriceStatus, checkedAt })),
        monitor: overview.monitor,
        captureQueue: overview.captureQueue,
        recentRuns: (overview.runs || []).slice(0, 12),
      });
    }
    case "find_products": {
      const overview = await workspaceOverview();
      const query = String(input.query || "").trim();
      const limit = Math.min(50, Math.max(1, Number(input.limit) || 12));
      const products = query ? (overview.products || []).filter((product) => productMatches(product, query)) : (overview.products || []);
      return { query, total: products.length, products: products.slice(0, limit).map(compactProduct) };
    }
    case "get_product_prices": {
      const product = await resolveProduct(input.product_id || input.item_id);
      return currentVerifiedPriceReport(product);
    }
    case "capture_product_price": {
      const product = await ensureProduct(input.product_url_or_id, input);
      const allAccounts = input.account_mode === "all";
      const capture = await localApi(`/api/products/${encodeURIComponent(product.id)}/${allAccounts ? "capture-all-accounts" : "capture"}`, {
        method: "POST",
        ...(allAccounts ? {} : { body: { captureKind: "price" } }),
      });
      const latestProduct = await resolveProduct(capture.product?.id || product.id).catch(() => capture.product || product);
      return {
        action: "price_capture",
        accountMode: allAccounts ? "all" : "primary",
        product: compactProduct(latestProduct),
        run: safeValue(capture.run),
        priceReport: currentVerifiedPriceReport(latestProduct),
      };
    }
    case "set_product_monitoring": {
      const product = await localApi(`/api/products/${encodeURIComponent(input.product_id)}`, { method: "PATCH", body: { enabled: input.enabled, ...(input.group ? { group: input.group } : {}) } });
      return { action: input.enabled ? "monitor_enabled" : "monitor_paused", product: compactProduct(product) };
    }
    case "set_sku_monitor_price": {
      const product = await localApi(`/api/products/${encodeURIComponent(input.product_id)}/sku-monitor-price`, { method: "PATCH", body: { skuId: input.sku_id, value: input.value, channel: input.channel || "lowest" } });
      return { action: "sku_monitor_price_saved", product: compactProduct(product), skuId: input.sku_id, channel: input.channel || "lowest", value: input.value };
    }
    case "retry_local_product_data": {
      const kind = input.kind;
      let result;
      if (kind === "buyer-show") result = await localApi(`/api/products/${encodeURIComponent(input.product_id)}/buyer-shows/retry`, { method: "POST", body: {} });
      else if (kind === "search-main-image") result = await localApi(`/api/products/${encodeURIComponent(input.product_id)}/search-main-image`, { method: "POST", body: { force: true } });
      else result = await localApi(`/api/products/${encodeURIComponent(input.product_id)}/reparse-local-evidence`, { method: "POST", body: { kind } });
      return safeValue({ action: "local_retry", kind, result });
    }
    case "get_capture_queue":
      return safeValue(await localApi("/api/capture-queue"));
    case "capture_products_batch":
      return safeValue(await localApi("/api/products/batch-capture", { method: "POST", body: { ids: [...new Set(input.product_ids || [])], captureKind: input.kind || "price" } }));
    case "set_global_monitor": {
      const body = {};
      if (typeof input.running === "boolean") body.running = input.running;
      if (input.interval_minutes !== undefined) body.intervalMinutes = Number(input.interval_minutes);
      return safeValue(await localApi("/api/monitor/settings", { method: "PATCH", body }));
    }
    case "sync_product_to_feishu":
      return safeValue(await localApi(`/api/products/${encodeURIComponent(input.product_id)}/feishu-sync`, { method: "POST", body: {} }));
    case "get_local_evidence_status":
      return safeValue(await localApi("/api/local-evidence"));
    case "get_operations_schema":
      return safeValue(await localApi("/api/agent-tools/operations/schema"));
    case "get_operations_data":
      return safeValue(await localApi("/api/agent-tools/operations/query", { method: "POST", body: operationsQueryBody(input) }));
    case "analyze_operations_data": {
      const result = await localApi("/api/agent-tools/operations/analyze", { method: "POST", body: operationsQueryBody(input) });
      return safeValue(result);
    }
    case "preview_operations_report": {
      const filePath = await resolveAttachmentPath(input.file_path);
      return safeValue(await localApi("/api/operations/reports/preview", { method: "POST", form: await reportForm(filePath) }));
    }
    case "import_operations_report": {
      const filePath = await resolveAttachmentPath(input.file_path);
      const result = await localApi("/api/operations/reports", {
        method: "POST",
        form: await reportForm(filePath, { type: input.report_type, storeName: input.store_name, reportDate: input.report_date, sourceName: input.source_name }),
      });
      return safeValue({ action: "operations_report_imported", report: result.report, workspace: safeWorkspace(result.workspace) });
    }
    case "get_image_queue":
      return safeValue(await localApi("/api/image-jobs"));
    case "get_image_library":
      return safeValue(await localApi(`/api/images?scope=${encodeURIComponent(input.scope || "all")}`));
    case "update_image_library_item": {
      const body = {};
      if (typeof input.favorite === "boolean") body.isFavorite = input.favorite;
      if (typeof input.archived === "boolean") body.isArchived = input.archived;
      return safeValue(await localApi(`/api/images/${encodeURIComponent(input.image_id)}`, { method: "PATCH", body }));
    }
    case "upload_reference_image": {
      const reference = await registerReferenceImage(input.file_path, input.role || "reference");
      return safeValue({
        action: "reference_image_registered",
        reference_image_id: reference.id,
        file_name: reference.fileName,
        mime_type: reference.mimeType,
        bytes: reference.size,
        role: reference.role,
        lifetime: "current_agent_session",
      });
    }
    case "analyze_creation_request": {
      const result = await localApi("/api/prompt-studio/quick-generate", {
        method: "POST",
        form: await quickPromptForm(input, { saveHistory: false }),
      });
      return safeValue({
        action: "creation_request_analyzed",
        request: result.request || result.interpretedRequest,
        warnings: result.warnings || [],
        recommendedVariantKey: result.recommendedVariantKey,
        model: result.model,
      });
    }
    case "create_prompt_plan": {
      const result = await localApi("/api/prompt-studio/quick-generate", {
        method: "POST",
        form: await quickPromptForm(input, { saveHistory: input.save_history !== false }),
      });
      return safeValue({ action: "prompt_plan_created", plan: result });
    }
    case "create_image_task": {
      const request = {
        ...DEFAULT_IMAGE_REQUEST,
        prompt: String(input.prompt || "").trim(),
        ...(input.negative_prompt ? { negativePrompt: input.negative_prompt } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.count ? { count: Number(input.count) } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.background ? { background: input.background } : {}),
        ...(input.compression !== undefined ? { compression: Number(input.compression) } : {}),
        ...(input.custom_width ? { customWidth: Number(input.custom_width) } : {}),
        ...(input.custom_height ? { customHeight: Number(input.custom_height) } : {}),
        ...(input.source_image_id ? { sourceImageId: input.source_image_id, editMode: input.mask_image_id ? "mask" : "annotation" } : {}),
        ...(input.edit_intent ? { editIntent: input.edit_intent } : {}),
        ...(input.composition_mode ? { compositionMode: input.composition_mode } : {}),
        ...(input.copy_text ? { copyText: input.copy_text } : {}),
        ...(input.copy_position ? { copyPosition: input.copy_position } : {}),
        ...(input.copy_style ? { copyStyle: input.copy_style } : {}),
        ...(input.copy_scale ? { copyScale: input.copy_scale } : {}),
      };
      const references = input.reference_image_ids || [];
      if (!references.length && !input.mask_image_id) {
        return safeValue({ action: "image_task_created", job: await localApi("/api/image-jobs", { method: "POST", body: request }) });
      }
      const prepared = await imageTaskForm(request, references, input.mask_image_id);
      return safeValue({
        action: "image_task_created",
        referenceCount: prepared.referenceCount,
        maskApplied: prepared.maskApplied,
        job: await localApi("/api/image-jobs", { method: "POST", form: prepared.form }),
      });
    }
    case "retry_image_task":
      return safeValue({ action: "image_task_retried", job: await localApi(`/api/image-jobs/${encodeURIComponent(input.job_id)}/retry`, { method: "POST", body: {} }) });
    case "cancel_image_task":
      return safeValue({ action: "image_task_cancelled", job: await localApi(`/api/image-jobs/${encodeURIComponent(input.job_id)}`, { method: "DELETE" }) });
    case "open_image_in_photoshop":
      return safeValue({ action: "photoshop_opened", result: await localApi(`/api/images/${encodeURIComponent(input.image_id)}/photoshop/open`, { method: "POST", body: {} }) });
    case "sync_image_from_photoshop":
      return safeValue({ action: "photoshop_synced", result: await localApi(`/api/images/${encodeURIComponent(input.image_id)}/photoshop/sync`, { method: "POST", body: {} }) });
    case "get_agent_activity":
      return safeValue(await localApi(`/api/agent-tools/audit?limit=${Math.min(200, Math.max(1, Number(input.limit) || 50))}`));
    default:
      throw new Error(`未支持的本机工具：${name}`);
  }
}

async function writeAudit(action, input, status, summary) {
  try {
    await localApi("/api/agent-tools/audit", {
      method: "POST",
      body: { action, status, target: input.product_id || input.product_url_or_id || input.file_path || "", summary, details: input },
    });
  } catch {
    // An audit write must not mask the original action result.
  }
}

async function respond(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  try {
    if (message.method === "initialize") {
      return writeMessage({ jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ecommerce-monitor-local-tools", version: "1.0.0" } } });
    }
    if (message.method === "tools/list") return writeMessage({ jsonrpc: "2.0", id, result: { tools } });
    if (message.method !== "tools/call") return writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const name = String(message.params?.name || "");
    const input = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
    try {
      const result = await executeTool(name, input);
      await writeAudit(name, input, "succeeded", "本机工具执行完成。");
      return writeMessage({ jsonrpc: "2.0", id, result: textResult(result) });
    } catch (error) {
      const summary = error?.message || "本机工具执行失败。";
      await writeAudit(name, input, "failed", summary);
      return writeMessage({ jsonrpc: "2.0", id, result: textResult({ ok: false, message: summary, status: error?.status || 500, details: safeValue(error?.payload) }, true) });
    }
  } catch (error) {
    return writeMessage({ jsonrpc: "2.0", id, error: { code: -32603, message: error?.message || "MCP 服务异常" } });
  }
}

function writeMessage(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { void respond(JSON.parse(line)); } catch { /* malformed input is ignored */ }
  }
});

process.stdin.on("end", () => process.exit(0));
