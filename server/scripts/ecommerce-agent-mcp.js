#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

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
    description: "读取某个已监控商品的本地已验证价格快照、SKU 覆盖情况与价格证据状态。不会发起新的网页采集。",
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
    name: "get_operations_data",
    description: "读取本机已导入的推广、市场、人群、竞品报表及本地计算的费率、ROI、预算建议。",
    inputSchema: jsonSchema(),
  },
  {
    name: "analyze_operations_data",
    description: "基于本机已导入的经营数据和截图生成分析及推广建议。不会修改推广计划。",
    inputSchema: jsonSchema(),
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
    name: "create_image_task",
    description: "把用户确认的创作需求提交到本机 AI 生图队列。返回任务 ID 和状态，不会访问账号或文件系统。",
    inputSchema: jsonSchema({
      prompt: { type: "string" }, negative_prompt: { type: "string" }, ratio: { type: "string", enum: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "custom"] },
      custom_width: { type: "integer", minimum: 512, maximum: 4096 }, custom_height: { type: "integer", minimum: 512, maximum: 4096 },
      resolution: { type: "string", enum: ["1k", "2k", "4k"] }, quality: { type: "string", enum: ["low", "medium", "high"] }, count: { type: "integer", minimum: 1, maximum: 4 },
      source_image_id: { type: "string" }, edit_intent: { type: "string", enum: ["local", "background", "outpaint", "redraw"] }, composition_mode: { type: "string", enum: ["keep", "smart"] },
    }, ["prompt"]),
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
  if (depth > 5 || value === null || value === undefined) return null;
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
    skuCount: Array.isArray(product.lastSnapshot?.skus) ? product.lastSnapshot.skus.length : undefined,
  });
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
      const snapshots = await localApi(`/api/products/${encodeURIComponent(product.id)}/snapshots?limit=24`);
      return safeValue({ product: compactProduct(product), snapshots: (snapshots || []).slice(0, 12) });
    }
    case "capture_product_price": {
      const product = await ensureProduct(input.product_url_or_id, input);
      const allAccounts = input.account_mode === "all";
      const capture = await localApi(`/api/products/${encodeURIComponent(product.id)}/${allAccounts ? "capture-all-accounts" : "capture"}`, {
        method: "POST",
        ...(allAccounts ? {} : { body: { captureKind: "price" } }),
      });
      const snapshots = await localApi(`/api/products/${encodeURIComponent(product.id)}/snapshots?limit=8`);
      return safeValue({ action: "price_capture", accountMode: allAccounts ? "all" : "primary", product: compactProduct(capture.product || product), run: capture.run, snapshots: (snapshots || []).slice(0, 4) });
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
    case "get_operations_data":
      return safeWorkspace(await localApi("/api/operations"));
    case "analyze_operations_data": {
      const result = await localApi("/api/operations/analyze", { method: "POST", body: {} });
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
    case "create_image_task": {
      const request = {
        ...DEFAULT_IMAGE_REQUEST,
        prompt: String(input.prompt || "").trim(),
        ...(input.negative_prompt ? { negativePrompt: input.negative_prompt } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.count ? { count: Number(input.count) } : {}),
        ...(input.custom_width ? { customWidth: Number(input.custom_width) } : {}),
        ...(input.custom_height ? { customHeight: Number(input.custom_height) } : {}),
        ...(input.source_image_id ? { sourceImageId: input.source_image_id, editMode: "annotation" } : {}),
        ...(input.edit_intent ? { editIntent: input.edit_intent } : {}),
        ...(input.composition_mode ? { compositionMode: input.composition_mode } : {}),
      };
      return safeValue({ action: "image_task_created", job: await localApi("/api/image-jobs", { method: "POST", body: request }) });
    }
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
