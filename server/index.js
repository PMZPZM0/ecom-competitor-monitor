import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import JSZip from "jszip";
import sharp from "sharp";
import { loadEnv } from "./utils/env.js";
import { newId, readDb, updateDb } from "./storage/db.js";
import { analyzeData } from "./services/analysisService.js";
import { buildTaobaoOAuthUrl, maskSecret } from "./services/authService.js";
import { rescheduleMonitor, resolveCaptureProtectionMinutes, runMonitorOnce, runProductOnce, scheduleProduct, startScheduler, stopScheduler } from "./services/monitorService.js";
import { createNotificationLog, effectivePriceForSku, publicFeishuConfig, sendFeishuNotification, updateFeishuConfig } from "./services/feishuService.js";
import { appendPriceDocument, cliStatus, createPriceDocument, readAuthQr, startCliLogin, startCliSetup } from "./services/larkCliService.js";
import { checkTaobaoSession, closeAccountBrowser, getTaobaoAuthState, isTaobaoLoginUrl, keepAccountBrowserWarm, minimizeAccountBrowser, openProductInAccountChrome, openTaobaoLogin } from "./services/browserService.js";
import { normalizeProductUrl } from "./utils/productUrl.js";

loadEnv();

export const app = express();
const pendingScans = new Map();
let authCheckActive = false;
let staticMiddleware = null;
let schedulerStarted = false;

function publicAuthSession(session) {
  return { ...session, cookie: session.cookie ? "configured" : "" };
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const productSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  group: z.string().optional().default("默认分组"),
  accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
});

function safeFilename(value, fallback = "tmall") {
  return String(value || fallback)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function isAllowedMediaHost(url) {
  return /(^|\.)alicdn\.com$|(^|\.)taobao\.com$|(^|\.)tbcdn\.cn$/i.test(url.hostname);
}

function cleanMediaUrl(value) {
  if (!value) return "";
  return String(value)
    .replace(/^\/\//, "https://")
    .replace(/^http:\/\//i, "https://")
    .replace(/\.(jpg|jpeg|png|webp|gif)\.(jpg|jpeg|png|webp|gif)(?=([?#]|$))/i, ".$1");
}

function mediaKey(value) {
  return cleanMediaUrl(value)
    .replace(/[?#].*$/, "")
    .replace(/^https?:\/\/(?:gw|img)\.alicdn\.com/i, "alicdn")
    .replace(/\.(jpg|jpeg|png|webp|gif)\.\1$/i, ".$1")
    .toLowerCase();
}

function itemIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get("id") || url.searchParams.get("itemId") || "";
  } catch {
    return String(value || "").match(/(?:[?&]|\b)(?:id|itemId)=(\d{6,20})/i)?.[1] || "";
  }
}

function extensionFromContentType(contentType, fallbackUrl) {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/gif/i.test(contentType)) return "gif";
  if (/mp4/i.test(contentType)) return "mp4";
  if (/mpegurl|m3u8/i.test(contentType)) return "m3u8";
  const match = fallbackUrl.pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1] || "jpg";
}

async function fetchRemoteMedia(urlValue) {
  if (!urlValue) return false;
  const url = new URL(cleanMediaUrl(urlValue));
  if (!isAllowedMediaHost(url)) return false;
  const response = await fetch(url.toString(), { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) return false;
  const contentType = response.headers.get("content-type") || "";
  const data = Buffer.from(await response.arrayBuffer());
  return { url, contentType, data };
}

async function addRemoteMedia(zip, folder, urlValue, filenameBase, { convertImageToJpeg = false } = {}) {
  const media = await fetchRemoteMedia(urlValue);
  if (!media) return false;
  if (convertImageToJpeg) {
    const jpeg = await sharp(media.data, { animated: false }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    zip.folder(folder).file(`${safeFilename(filenameBase)}.jpg`, jpeg);
    return true;
  }
  const ext = extensionFromContentType(media.contentType, media.url);
  zip.folder(folder).file(`${safeFilename(filenameBase)}.${ext}`, media.data);
  return true;
}

function validBuyerShows(snapshot) {
  return (snapshot?.buyerShows || []).filter((item) => item && (item.text || item.images?.length || item.videoUrls?.length));
}

async function addBuyerShowsToZip(zip, snapshot, folderPrefix = "买家秀") {
  const items = validBuyerShows(snapshot);
  let downloaded = 0;
  for (const [index, item] of items.entries()) {
    const folder = `${folderPrefix}/${String(index + 1).padStart(3, "0")}`;
    if (item.text) zip.folder(folder).file("文案.txt", String(item.text));
    for (const [imageIndex, url] of (item.images || []).map(cleanMediaUrl).filter(Boolean).entries()) {
      try {
        if (await addRemoteMedia(zip, folder, url, `${String(imageIndex + 1).padStart(2, "0")}_图片`, { convertImageToJpeg: true })) downloaded += 1;
      } catch {
        // Skip one unavailable buyer-show asset without failing the whole ZIP.
      }
    }
    for (const [videoIndex, url] of (item.videoUrls || []).map(cleanMediaUrl).filter(Boolean).entries()) {
      try {
        if (await addRemoteMedia(zip, folder, url, `${String(videoIndex + 1).padStart(2, "0")}_视频`)) downloaded += 1;
      } catch {
        // Skip one unavailable buyer-show asset without failing the whole ZIP.
      }
    }
  }
  return { count: items.length, downloaded };
}

app.get("/api/health", async (_req, res) => {
  const db = await readDb();
  res.json({ ok: true, monitor: db.monitor, time: new Date().toISOString() });
});

app.get("/api/overview", async (_req, res) => {
  const db = await readDb();
  const latestSnapshots = db.snapshots.slice(-100).reverse();
  res.json({
    products: db.products,
    snapshots: latestSnapshots,
    analyses: db.analyses.slice(-8).reverse(),
    authSessions: db.authSessions.map(publicAuthSession),
    runs: db.runs.slice(-50).reverse(),
  modelConfig: {
      baseUrl: db.modelConfig.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: db.modelConfig.model || process.env.OPENAI_MODEL || "gpt-4.1-mini",
      apiKey: db.modelConfig.apiKey ? maskSecret(db.modelConfig.apiKey) : "",
      hasApiKey: Boolean(db.modelConfig.apiKey || process.env.OPENAI_API_KEY),
  },
    feishu: publicFeishuConfig(db.feishu),
    notificationLogs: db.notificationLogs.slice(-80).reverse(),
    monitor: db.monitor,
  });
});

app.post("/api/products", async (req, res) => {
  const parsed = productSchema.parse(req.body);
  parsed.url = normalizeProductUrl(parsed.url);
  const product = {
    id: newId("prod"),
    ...parsed,
    enabled: true,
    mainImage: "",
    lastStatus: "pending",
    lastError: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateDb((db) => {
    db.products.unshift(product);
    return db;
  });
  await rescheduleMonitor();
  res.status(201).json(product);
});

app.post("/api/products/batch", async (req, res) => {
  const schema = z.object({
    urls: z.array(z.string().url()).min(1).max(30),
    group: z.string().min(1).default("核心竞品"),
    accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
  });
  const parsed = schema.parse(req.body);
  const uniqueUrls = [...new Set(parsed.urls.map(normalizeProductUrl))];
  for (const value of uniqueUrls) {
    const hostname = new URL(value).hostname;
    if (!/(^|\.)(taobao|tmall)\.com$/i.test(hostname)) return res.status(400).json({ message: `不是淘宝或天猫商品链接：${value}` });
  }
  const db = await readDb();
  const existingUrls = new Set(db.products.map((product) => product.url));
  const created = uniqueUrls.filter((url) => !existingUrls.has(url)).map((url, index) => ({
    id: newId("prod"),
    name: `批量商品 ${index + 1}`,
    url,
    group: parsed.group,
    accountType: parsed.accountType,
    enabled: true,
    mainImage: "",
    lastStatus: "pending",
    lastError: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  await updateDb((current) => {
    current.products.unshift(...created);
    return current;
  });
  let queueResult = null;
  if (created.length) queueResult = await runMonitorOnce({ source: "manual-batch", productIds: created.map((product) => product.id), includeDisabled: true });
  await rescheduleMonitor();
  const results = queueResult?.results || [];
  const success = results.filter((result) => result.snapshot).length;
  res.status(201).json({
    total: uniqueUrls.length,
    created: created.length,
    skipped: uniqueUrls.length - created.length,
    success,
    failed: results.length - success,
    results,
    message: `提交 ${uniqueUrls.length} 条，新建 ${created.length} 条，抓取成功 ${success} 条，失败 ${results.length - success} 条，重复跳过 ${uniqueUrls.length - created.length} 条。`,
  });
});

app.post("/api/products/batch-delete", async (req, res) => {
  const { ids } = z.object({
    ids: z.array(z.string().min(1)).min(1).max(500),
  }).parse(req.body);
  const selectedIds = new Set(ids);
  let deleted = 0;
  await updateDb((db) => {
    deleted = db.products.filter((product) => selectedIds.has(product.id)).length;
    db.products = db.products.filter((product) => !selectedIds.has(product.id));
    db.snapshots = db.snapshots.filter((snapshot) => !selectedIds.has(snapshot.productId));
    db.notificationLogs = db.notificationLogs.filter((log) => !selectedIds.has(log.productId));
    return db;
  });
  await rescheduleMonitor();
  res.json({ requested: selectedIds.size, deleted });
});

app.patch("/api/products/:id", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    group: z.string().min(1).optional(),
    accountType: z.enum(["normal", "gift", "vip88"]).optional(),
    enabled: z.boolean().optional(),
    monitorIntervalMinutes: z.number().int().min(30).max(1440).nullable().optional(),
    monitorStartAt: z.string().datetime().nullable().optional(),
    monitorPrice: z.number().positive().nullable().optional(),
    skuMonitorPrices: z.record(z.string().min(1), z.number().positive()).optional(),
  });
  const patch = schema.parse(req.body);
  if (patch.url) patch.url = normalizeProductUrl(patch.url);
  let updated = null;
  let scheduleChanged = false;
  await updateDb((db) => {
    db.products = db.products.map((product) => {
      if (product.id !== req.params.id) return product;
      scheduleChanged = patch.enabled !== undefined || patch.monitorIntervalMinutes !== undefined || patch.monitorStartAt !== undefined;
      updated = { ...product, ...patch, updatedAt: new Date().toISOString() };
      if (scheduleChanged) updated = scheduleProduct(updated, db.monitor, { reset: true });
      return updated;
    });
    return db;
  });
  if (!updated) {
    res.status(404).json({ message: "商品不存在。" });
    return;
  }
  if (scheduleChanged) await rescheduleMonitor();
  res.json(updated);
});

app.patch("/api/feishu/settings", async (req, res) => {
  const schema = z.object({
    enabled: z.boolean().optional(),
    webhookUrl: z.string().url().optional(),
    signingSecret: z.string().min(1).max(500).optional(),
    clearSigningSecret: z.boolean().optional(),
    cooldownEnabled: z.boolean().optional(),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
    documentEnabled: z.boolean().optional(),
  });
  const patch = schema.parse(req.body);
  let config;
  await updateDb((db) => {
    db.feishu = updateFeishuConfig(db.feishu, patch);
    if (db.feishu.enabled && !publicFeishuConfig(db.feishu).webhookConfigured) {
      throw new Error("请先填写并保存飞书自定义机器人的 Webhook 地址，再开启自动提醒。");
    }
    if (db.feishu.documentEnabled && !db.feishu.documentId) throw new Error("请先扫码授权并创建飞书价格文档，再开启自动写入。");
    config = db.feishu;
    return db;
  });
  res.json(publicFeishuConfig(config));
});

app.get("/api/feishu/cli/status", async (_req, res) => {
  res.json(await cliStatus());
});

app.post("/api/feishu/cli/setup", async (_req, res) => {
  res.json(startCliSetup());
});

app.post("/api/feishu/cli/login", async (_req, res) => {
  res.json(await startCliLogin());
});

app.get("/api/feishu/cli/qrcode", async (_req, res) => {
  try {
    const data = await readAuthQr();
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "no-store");
    res.send(data);
  } catch {
    res.status(404).json({ message: "二维码尚未生成。" });
  }
});

app.post("/api/feishu/document/create", async (_req, res) => {
  const db = await readDb();
  const products = db.products.filter((product) => product.lastSnapshot);
  if (!products.length) return res.status(409).json({ message: "暂无商品快照，请先抓取商品。" });
  const document = await createPriceDocument(products[0]);
  for (const product of products.slice(1)) await appendPriceDocument(document.documentId, product, product.lastSnapshot);
  await updateDb((current) => {
    current.feishu.documentId = document.documentId;
    current.feishu.documentUrl = document.documentUrl;
    current.feishu.documentEnabled = true;
    current.feishu.lastDocumentSyncAt = new Date().toISOString();
    return current;
  });
  res.status(201).json(document);
});

app.post("/api/feishu/test", async (_req, res) => {
  const db = await readDb();
  const product = db.products[0] || { name: "测试商品", shopName: "测试店铺", model: "测试型号", url: "http://localhost:5173" };
  const snapshot = product.lastSnapshot;
  const price = Number(snapshot?.price) || Number(snapshot?.skuPrices?.[0]?.normalPrice ?? snapshot?.skuPrices?.[0]?.price) || 0;
  try {
    await sendFeishuNotification(db.feishu, { type: "manual-sync", product, price, threshold: product.monitorPrice ?? null, skuName: "" });
    const log = createNotificationLog({ productId: product.id || "", type: "test", status: "sent", message: "飞书连接测试消息已发送。", price, threshold: product.monitorPrice ?? null, source: "manual-test" });
    await updateDb((current) => {
      current.feishu.lastTestedAt = log.createdAt;
      current.notificationLogs.push(log);
      current.notificationLogs = current.notificationLogs.slice(-300);
      return current;
    });
    res.json({ ok: true, log });
  } catch (error) {
    const log = createNotificationLog({ productId: product.id || "", type: "test", status: "failed", message: error.message, price, threshold: product.monitorPrice ?? null, source: "manual-test" });
    await updateDb((current) => {
      current.notificationLogs.push(log);
      current.notificationLogs = current.notificationLogs.slice(-300);
      return current;
    });
    res.status(502).json({ message: error.message, log });
  }
});

app.post("/api/products/:id/feishu-sync", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product) return res.status(404).json({ message: "商品不存在。" });
  const snapshot = product.lastSnapshot;
  const candidates = (snapshot?.skuPrices || []).map((sku) => {
    const effective = effectivePriceForSku(sku, product.accountType || "normal");
    return { price: effective?.value, priceLabel: effective?.label || "普通价", skuName: sku.name || "", skuId: sku.skuId };
  }).filter((item) => Number.isFinite(item.price));
  const current = candidates.sort((left, right) => left.price - right.price)[0] || { price: Number(snapshot?.price) || 0, skuName: "" };
  const logs = [];
  if (db.feishu.webhookUrlEncrypted) {
    try {
      await sendFeishuNotification(db.feishu, { type: "manual-sync", product, price: current.price, priceLabel: current.priceLabel, threshold: product.monitorPrice ?? null, skuName: current.skuName });
      logs.push(createNotificationLog({ productId: product.id, type: "manual-sync", status: "sent", message: "商品价格卡片已同步至飞书机器人。", price: current.price, threshold: product.monitorPrice ?? null, source: "manual-product" }));
    } catch (error) {
      logs.push(createNotificationLog({ productId: product.id, type: "manual-sync", status: "failed", message: `飞书机器人：${error.message}`, price: current.price, threshold: product.monitorPrice ?? null, source: "manual-product" }));
    }
  }
  if (db.feishu.documentEnabled && db.feishu.documentId) {
    try {
      await appendPriceDocument(db.feishu.documentId, product, snapshot);
      logs.push(createNotificationLog({ productId: product.id, type: "document-sync", status: "sent", message: "商品价格已写入飞书文档。", source: "manual-product" }));
    } catch (error) {
      logs.push(createNotificationLog({ productId: product.id, type: "document-sync", status: "failed", message: `飞书文档：${error.message}`, source: "manual-product" }));
    }
  }
  if (!logs.length) return res.status(409).json({ message: "请先配置飞书机器人 Webhook，或扫码授权并开启飞书文档自动写入。" });
  await updateDb((data) => {
    data.notificationLogs.push(...logs);
    if (logs.some((log) => log.type === "document-sync" && log.status === "sent")) data.feishu.lastDocumentSyncAt = new Date().toISOString();
    data.notificationLogs = data.notificationLogs.slice(-300);
    return data;
  });
  const failed = logs.filter((log) => log.status === "failed");
  if (failed.length === logs.length) return res.status(502).json({ message: failed.map((log) => log.message).join("；"), logs });
  res.json({ ok: true, logs, partial: failed.length > 0 });
});

app.delete("/api/products/:id", async (req, res) => {
  await updateDb((db) => {
    db.products = db.products.filter((product) => product.id !== req.params.id);
    db.snapshots = db.snapshots.filter((snapshot) => snapshot.productId !== req.params.id);
    db.notificationLogs = db.notificationLogs.filter((log) => log.productId !== req.params.id);
    return db;
  });
  await rescheduleMonitor();
  res.status(204).end();
});

app.post("/api/products/:id/capture", async (req, res) => {
  res.json(await runProductOnce(req.params.id, { source: "manual-product" }));
});

app.post("/api/products/:id/open", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product) {
    res.status(404).json({ message: "商品不存在。" });
    return;
  }
  const accountType = product.accountType || "normal";
  const authSession = db.authSessions.find((session) =>
    (session.enabled ?? session.active ?? true)
    && (session.accountType || "normal") === accountType
    && session.browserProfileKey
    && session.browserPort,
  );
  if (!authSession) {
    const accountLabel = accountType === "gift" ? "礼金" : accountType === "vip88" ? "88VIP" : "普通";
    res.status(409).json({ message: `没有可用的${accountLabel}账号登录态，请先在账号授权页面登录。` });
    return;
  }
  res.json(await openProductInAccountChrome(product.url, authSession));
});

app.get("/api/products/:id/snapshots", async (req, res) => {
  const db = await readDb();
  const limit = Math.min(240, Math.max(12, Number(req.query.limit) || 96));
  const snapshots = db.snapshots.filter((snapshot) => snapshot.productId === req.params.id);
  res.json(snapshots.slice(-limit).reverse());
});

app.post("/api/products/batch-capture", async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(20) }).parse(req.body);
  const result = await runMonitorOnce({ source: "manual-batch", productIds: [...new Set(ids)], includeDisabled: true });
  res.json({ ok: true, ...result });
});

app.patch("/api/monitor/settings", async (req, res) => {
  const schema = z.object({
    intervalMinutes: z.number().int().min(30).max(1440).optional(),
    captureProtectionMinutes: z.number().int().min(0).max(120).optional(),
    captureProtectionByAccount: z.object({
      normal: z.number().int().min(0).max(120).nullable().optional(),
      vip88: z.number().int().min(0).max(120).nullable().optional(),
      gift: z.number().int().min(0).max(120).nullable().optional(),
    }).optional(),
    running: z.boolean().optional(),
  });
  const parsed = schema.parse(req.body);
  let monitor;
  await updateDb((db) => {
    const running = parsed.running ?? db.monitor.running;
    const intervalMinutes = parsed.intervalMinutes ?? db.monitor.intervalMinutes;
    db.monitor = {
      ...db.monitor,
      ...parsed,
      captureProtectionByAccount: {
        ...(db.monitor.captureProtectionByAccount || {}),
        ...(parsed.captureProtectionByAccount || {}),
      },
      nextRunAt: running ? new Date(Date.now() + intervalMinutes * 60_000).toISOString() : null,
    };
    db.authSessions = db.authSessions.map((session) => {
      const accountType = session.accountType || "normal";
      if (resolveCaptureProtectionMinutes(db.monitor, accountType) !== 0) return session;
      return {
        ...session,
        cooldownUntil: null,
        healthStatus: session.healthStatus === "cooldown" ? "degraded" : session.healthStatus,
      };
    });
    if (parsed.running !== undefined) {
      // The global switch is a scheduler master gate. Keep each card's own
      // enabled state so a global pause/resume cannot undo per-product choices.
      db.products = db.products.map((product) => scheduleProduct(product, db.monitor, { reset: true }));
    } else if (parsed.intervalMinutes !== undefined) {
      db.products = db.products.map((product) => product.monitorIntervalMinutes == null
        ? scheduleProduct(product, db.monitor, { reset: true })
        : product);
    }
    monitor = db.monitor;
    return db;
  });
  await rescheduleMonitor();
  const db = await readDb();
  monitor = db.monitor;
  res.json(monitor);
});

app.post("/api/analysis/run", async (_req, res) => {
  const db = await readDb();
  const analysis = await analyzeData({ products: db.products, snapshots: db.snapshots, modelConfig: db.modelConfig });
  const record = { id: newId("analysis"), ...analysis };
  await updateDb((current) => {
    current.analyses.push(record);
    return current;
  });
  res.json(record);
});

app.patch("/api/model-config", async (req, res) => {
  const schema = z.object({
    baseUrl: z.string().url().optional().or(z.literal("")),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
  });
  const parsed = schema.parse(req.body);
  let config;
  await updateDb((db) => {
    db.modelConfig = {
      ...db.modelConfig,
      baseUrl: parsed.baseUrl ?? db.modelConfig.baseUrl,
      model: parsed.model ?? db.modelConfig.model,
      apiKey: parsed.apiKey === undefined || parsed.apiKey === "" ? db.modelConfig.apiKey : parsed.apiKey,
    };
    config = db.modelConfig;
    return db;
  });
  res.json({
    baseUrl: config.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: config.model || process.env.OPENAI_MODEL || "gpt-4.1-mini",
    apiKey: config.apiKey ? maskSecret(config.apiKey) : "",
    hasApiKey: Boolean(config.apiKey || process.env.OPENAI_API_KEY),
  });
});

app.get("/api/auth/taobao/oauth-url", (_req, res) => {
  res.json(buildTaobaoOAuthUrl());
});

app.post("/api/auth/taobao/scan/start", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(40).default("淘宝扫码账号"),
    accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
  });
  const parsed = schema.parse(req.body || {});
  const profileKey = newId("taobao");
  const browserPort = 9300 + Math.floor(Math.random() * 500);
  const login = await openTaobaoLogin({ profileKey, port: browserPort });
  pendingScans.set(profileKey, { ...parsed, profileKey, browserPort, loginTargetId: login.targetId, createdAt: Date.now() });
  res.json(login);
});

app.post("/api/auth/sessions/:id/reauthorize", async (req, res) => {
  const db = await readDb();
  const session = db.authSessions.find((item) => item.id === req.params.id);
  if (!session) return res.status(404).json({ message: "账号不存在。" });
  if (session.source !== "taobao-browser" || !session.browserProfileKey || !session.browserPort) {
    return res.status(400).json({ message: "手动 Cookie 账号请在左侧重新粘贴 Cookie；只有扫码账号支持重新授权。" });
  }
  const login = await openTaobaoLogin({ profileKey: session.browserProfileKey, port: session.browserPort });
  pendingScans.set(session.browserProfileKey, {
    sessionId: session.id,
    name: session.name,
    accountType: session.accountType || "normal",
    profileKey: session.browserProfileKey,
    browserPort: session.browserPort,
    loginTargetId: login.targetId,
    createdAt: Date.now(),
  });
  res.json(login);
});

async function syncPendingScan(profileKey) {
  const pending = pendingScans.get(profileKey);
  const existing = (await readDb()).authSessions.find((session) => session.browserProfileKey === profileKey);
  if (!pending) return existing ? { status: "synced", session: existing } : { status: "expired" };
  const authState = await getTaobaoAuthState({ profileKey: pending.profileKey, port: pending.browserPort });
  if (authState.browserClosed) {
    pendingScans.delete(profileKey);
    return { status: "cancelled" };
  }
  const loginTarget = authState.targets?.find((target) => target.id === pending.loginTargetId);
  if (!loginTarget) {
    pendingScans.delete(profileKey);
    return { status: "cancelled" };
  }
  if (isTaobaoLoginUrl(loginTarget.url)) return { status: "waiting" };
  if (!authState.loggedIn || !authState.cookie) return { status: "waiting" };

  let session;
  await updateDb((db) => {
    if (pending.sessionId) {
      db.authSessions = db.authSessions.map((item) => {
        if (item.id !== pending.sessionId) return item;
        session = {
          ...item,
          cookie: authState.cookie,
          active: true,
          enabled: true,
          loginStatus: "valid",
          lastCheckedAt: new Date().toISOString(),
          healthStatus: "healthy",
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastFailureAt: null,
        };
        return session;
      });
    } else {
      session = {
        id: newId("auth"),
        name: pending.name || authState.nickname || "淘宝扫码账号",
        accountType: pending.accountType,
        cookie: authState.cookie,
        source: "taobao-browser",
        browserProfileKey: pending.profileKey,
        browserPort: pending.browserPort,
        active: true,
        enabled: true,
        loginStatus: "valid",
        lastCheckedAt: new Date().toISOString(),
        healthStatus: "healthy",
        createdAt: new Date().toISOString(),
      };
      db.authSessions.unshift(session);
    }
    return db;
  });
  pendingScans.delete(profileKey);
  minimizeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort });
  return { status: "synced", session };
}

async function checkAuthSession(session) {
  if (session.source !== "taobao-browser" || !session.browserProfileKey || !session.browserPort) {
    return { id: session.id, loginStatus: "manual", message: "手动 Cookie 无法无损检测，请通过实际抓取或重新粘贴 Cookie 更新。" };
  }
  const state = await checkTaobaoSession({ profileKey: session.browserProfileKey, port: session.browserPort });
  const checkedAt = new Date().toISOString();
  const loginStatus = state.loggedIn && state.cookie ? "valid" : "expired";
  let updated;
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((item) => {
      if (item.id !== session.id) return item;
      updated = {
        ...item,
        cookie: loginStatus === "valid" ? state.cookie : item.cookie,
        loginStatus,
        lastCheckedAt: checkedAt,
        healthStatus: loginStatus === "valid" ? "healthy" : "degraded",
        cooldownUntil: loginStatus === "valid" ? null : item.cooldownUntil,
        consecutiveFailures: loginStatus === "valid" ? 0 : item.consecutiveFailures,
      };
      return updated;
    });
    return db;
  });
  return { id: session.id, loginStatus, checkedAt, message: loginStatus === "valid" ? "账号登录有效。" : "登录已失效，请重新授权。", session: publicAuthSession(updated) };
}

app.post("/api/auth/sessions/check-all", async (_req, res) => {
  if (authCheckActive) return res.status(409).json({ message: "账号检测正在进行中。" });
  authCheckActive = true;
  try {
    const db = await readDb();
    const results = [];
    for (const session of db.authSessions) {
      results.push(await checkAuthSession(session));
      if (session !== db.authSessions.at(-1)) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    res.json({ total: results.length, valid: results.filter((result) => result.loginStatus === "valid").length, expired: results.filter((result) => result.loginStatus === "expired").length, manual: results.filter((result) => result.loginStatus === "manual").length, results });
  } finally {
    authCheckActive = false;
  }
});

app.post("/api/auth/sessions/:id/check", async (req, res) => {
  if (authCheckActive) return res.status(409).json({ message: "账号检测正在进行中。" });
  const db = await readDb();
  const session = db.authSessions.find((item) => item.id === req.params.id);
  if (!session) return res.status(404).json({ message: "账号不存在。" });
  authCheckActive = true;
  try {
    res.json(await checkAuthSession(session));
  } finally {
    authCheckActive = false;
  }
});

app.post("/api/auth/sessions/:id/release-cooldown", async (req, res) => {
  let updated;
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((session) => {
      if (session.id !== req.params.id) return session;
      if (session.loginStatus === "expired") return session;
      updated = {
        ...session,
        cooldownUntil: null,
        healthStatus: "healthy",
        consecutiveFailures: 0,
      };
      return updated;
    });
    return db;
  });
  if (!updated) return res.status(404).json({ message: "账号不存在，或登录已失效，请重新授权。" });
  res.json(publicAuthSession(updated));
});

app.post("/api/auth/taobao/scan/status", async (req, res) => {
  const schema = z.object({ profileKey: z.string().min(1) });
  const parsed = schema.parse(req.body);
  const result = await syncPendingScan(parsed.profileKey);
  if (result.status === "expired") {
    res.status(410).json({ message: "扫码会话已失效，请重新打开扫码登录。" });
    return;
  }
  res.json({
    ...result,
    session: result.session ? publicAuthSession(result.session) : undefined,
  });
});

app.post("/api/auth/taobao/scan/cancel", async (req, res) => {
  const schema = z.object({ profileKey: z.string().min(1) });
  const parsed = schema.parse(req.body);
  const pending = pendingScans.get(parsed.profileKey);
  if (pending) {
    pendingScans.delete(parsed.profileKey);
    if (pending.sessionId) minimizeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort });
    else await closeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort });
  }
  res.json({ ok: true });
});

app.post("/api/auth/taobao/scan/sync", async (req, res) => {
  const schema = z.object({ profileKey: z.string().min(1) });
  const parsed = schema.parse(req.body);
  const result = await syncPendingScan(parsed.profileKey);
  if (result.status !== "synced") {
    res.status(400).json({ message: "未读取到 taobao/tmall Cookie，请确认扫码登录已完成。" });
    return;
  }
  res.status(201).json(publicAuthSession(result.session));
});

app.get("/api/auth/taobao/callback", (req, res) => {
  res.send(`淘宝授权回调已收到 code。请按业务需要接入淘宝开放平台换 token。\n\ncode=${req.query.code || ""}`);
});

app.post("/api/auth/sessions", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    cookie: z.string().min(8),
    accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
  });
  const parsed = schema.parse(req.body);
  const session = {
    id: newId("auth"),
    name: parsed.name,
    cookie: parsed.cookie,
    source: "manual-cookie",
    accountType: parsed.accountType,
    active: true,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  await updateDb((db) => {
    db.authSessions.unshift(session);
    return db;
  });
  res.status(201).json(publicAuthSession(session));
});

app.delete("/api/auth/sessions/:id", async (req, res) => {
  const current = (await readDb()).authSessions.find((session) => session.id === req.params.id);
  await updateDb((db) => {
    db.authSessions = db.authSessions.filter((session) => session.id !== req.params.id);
    return db;
  });
  if (current?.browserProfileKey && current?.browserPort) {
    await closeAccountBrowser({ profileKey: current.browserProfileKey, port: current.browserPort });
  }
  res.status(204).end();
});

app.post("/api/auth/sessions/:id/activate", async (req, res) => {
  let activated = null;
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((session) => {
      if (session.id !== req.params.id) return session;
      const enabled = !(session.enabled ?? session.active ?? true);
      activated = { ...session, accountType: session.accountType || "normal", active: enabled, enabled };
      return activated;
    });
    return db;
  });
  if (!activated) {
    res.status(404).json({ message: "会话不存在。" });
    return;
  }
  if (activated.source === "taobao-browser" && activated.browserProfileKey && activated.browserPort) {
    if (activated.enabled) await keepAccountBrowserWarm(activated);
    else await closeAccountBrowser({ profileKey: activated.browserProfileKey, port: activated.browserPort });
  }
  res.json(publicAuthSession(activated));
});

app.get("/api/export/snapshots.csv", async (_req, res) => {
  const db = await readDb();
  const rows = [
    ["capturedAt", "productId", "shopName", "shopLogo", "model", "autoGroup", "title", "price", "priceRange", "skuPriceCount", "skuPriceLayers", "mainImage", "source"],
    ...db.snapshots.map((snapshot) => [
      snapshot.capturedAt,
      snapshot.productId,
      snapshot.shopName ?? "",
      snapshot.shopLogo ?? "",
      snapshot.model ?? "",
      snapshot.autoGroup ?? "",
      snapshot.title,
      snapshot.price ?? "",
      snapshot.priceRange ? snapshot.priceRange.join("-") : "",
      snapshot.skuPrices?.length ?? 0,
      JSON.stringify(
        (snapshot.skuPrices || []).map((sku) => ({
          skuId: sku.skuId,
          name: sku.name,
          price: sku.price,
          normalPrice: sku.normalPrice,
          coinPrice: sku.coinPrice,
          layers: sku.priceLayers || [],
        })),
      ),
      snapshot.mainImage ?? "",
      snapshot.source ?? "",
    ]),
  ];
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", "attachment; filename=tmall-snapshots.csv");
  res.send(`\uFEFF${csv}`);
});

app.get("/api/download-image", async (req, res) => {
  const schema = z.object({ url: z.string().url(), name: z.string().optional() });
  const parsed = schema.parse(req.query);
  const url = new URL(parsed.url);
  if (!/(^|\.)alicdn\.com$|(^|\.)taobao\.com$|(^|\.)tbcdn\.cn$/i.test(url.hostname)) {
    res.status(400).json({ message: "只支持下载淘宝/天猫图片。" });
    return;
  }
  const media = await fetchRemoteMedia(url.toString());
  if (!media) {
    res.status(502).json({ message: "图片下载失败。" });
    return;
  }
  if (/video|mp4|mpegurl|m3u8/i.test(media.contentType) || /\.(mp4|m3u8)(?:[?#]|$)/i.test(media.url.toString())) {
    const ext = extensionFromContentType(media.contentType, media.url);
    const filename = `${(parsed.name || "tmall-video").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 60)}.${ext}`;
    res.setHeader("content-type", media.contentType || "video/mp4");
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(media.data);
    return;
  }
  const jpeg = await sharp(media.data, { animated: false }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const filename = `${(parsed.name || "tmall-image").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 60)}.jpg`;
  res.setHeader("content-type", "image/jpeg");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(jpeg);
});

app.get("/api/products/:id/download-media", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product?.lastSnapshot) {
    res.status(404).json({ message: "商品暂无可下载的抓取素材。" });
    return;
  }

  const snapshot = product.lastSnapshot;
  const zip = new JSZip();
  const itemId = product.itemId || itemIdFromUrl(product.url);
  if (itemId && snapshot.itemId && String(itemId) !== String(snapshot.itemId)) {
    res.status(409).json({ message: "当前快照商品 ID 与监控商品不一致，请重新抓取后再下载。" });
    return;
  }
  const title = safeFilename(snapshot.title || product.name || product.id);
  const mainImage800 = cleanMediaUrl(snapshot.mainImage800 || snapshot.mainImage || snapshot.mainImages?.[0]);
  const videoUrls = Array.from(new Set((snapshot.videoUrls || []).map(cleanMediaUrl).filter(Boolean)));
  const skuImages = Array.from(
    new Map(
      [
        ...(snapshot.skuImages || []).map((url, index) => [cleanMediaUrl(url), { url: cleanMediaUrl(url), name: `${String(index + 1).padStart(2, "0")}_SKU图` }]),
        ...(snapshot.skuPrices || []).map((sku, index) => [cleanMediaUrl(sku.image), { url: cleanMediaUrl(sku.image), name: `${String(index + 1).padStart(2, "0")}_${sku.name || sku.skuId}` }]),
      ].filter(([url]) => url).map(([, item]) => [mediaKey(item.url), item]),
    ).values(),
  );
  const skuImageKeys = new Set(skuImages.map((item) => mediaKey(item.url)));
  const gallery750Images = Array.from(
    new Map(
      (snapshot.gallery750Images || snapshot.mainImages?.slice(1, 6) || [])
        .map(cleanMediaUrl)
        .filter((url) => url && !skuImageKeys.has(mediaKey(url)))
        .map((url) => [mediaKey(url), url]),
    ).values(),
  ).slice(0, 5);
  const protectedImageKeys = new Set([mainImage800, ...gallery750Images, ...skuImages.map((item) => item.url)].map(mediaKey));
  const detailImages = Array.from(
    new Map(
      (snapshot.detailImages || [])
        .map(cleanMediaUrl)
        .filter((url) => url && !protectedImageKeys.has(mediaKey(url)))
        .map((url) => [mediaKey(url), url]),
    ).values(),
  );

  const added = [];
  if (mainImage800) {
    const ok = await addRemoteMedia(zip, "01_800主图", mainImage800, "01_800主图", { convertImageToJpeg: true });
    if (ok) added.push(mainImage800);
  }
  for (const [index, url] of gallery750Images.entries()) {
    const ok = await addRemoteMedia(zip, "02_750主图", url, `${String(index + 1).padStart(2, "0")}_750主图`, { convertImageToJpeg: true });
    if (ok) added.push(url);
  }
  for (const [index, item] of skuImages.entries()) {
    const ok = await addRemoteMedia(zip, "03_SKU图", item.url, `${String(index + 1).padStart(2, "0")}_${item.name}`, { convertImageToJpeg: true });
    if (ok) added.push(item.url);
  }
  for (const [index, url] of detailImages.entries()) {
    const ok = await addRemoteMedia(zip, "04_详情图", url, `${String(index + 1).padStart(2, "0")}_详情图`, { convertImageToJpeg: true });
    if (ok) added.push(url);
  }
  for (const [index, url] of videoUrls.entries()) {
    const ok = await addRemoteMedia(zip, "05_视频", url, `${String(index + 1).padStart(2, "0")}_视频`);
    if (ok) added.push(url);
  }

  zip.file(
    "素材清单.json",
    JSON.stringify(
      {
        productId: product.id,
        monitoredItemId: itemId,
        snapshotItemId: snapshot.itemId || "",
        productUrl: product.url,
        title: snapshot.title,
        capturedAt: snapshot.capturedAt,
        counts: {
          mainImage800: mainImage800 ? 1 : 0,
          gallery750Images: gallery750Images.length,
          skuImages: skuImages.length,
          detailImages: detailImages.length,
          videos: videoUrls.length,
          downloaded: added.length,
        },
        mainImage800,
        gallery750Images,
        skuImages,
        detailImages,
        videoUrls,
      },
      null,
      2,
    ),
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${title}_${itemId || product.id}_素材包.zip`)}`);
  res.send(buffer);
});

app.get("/api/products/:id/download-buyer-shows", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product?.lastSnapshot) {
    res.status(404).json({ message: "商品暂无买家秀抓取数据，请先抓取商品。" });
    return;
  }
  const snapshot = product.lastSnapshot;
  if (!validBuyerShows(snapshot).length) {
    res.status(404).json({ message: "当前快照没有图片、视频或文案形式的买家秀。" });
    return;
  }
  const zip = new JSZip();
  const title = safeFilename(snapshot.title || product.name || product.id);
  const result = await addBuyerShowsToZip(zip, snapshot);
  zip.file("买家秀清单.json", JSON.stringify({ productId: product.id, title: snapshot.title, capturedAt: snapshot.capturedAt, items: validBuyerShows(snapshot), downloaded: result.downloaded }, null, 2));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${title}_买家秀.zip`)}`);
  res.send(buffer);
});

app.get("/api/products/:id/download-buyer-shows/:buyerShowId", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  const snapshot = product?.lastSnapshot;
  const items = validBuyerShows(snapshot);
  const itemIndex = items.findIndex((item) => String(item.id) === String(req.params.buyerShowId));
  if (!product || !snapshot || itemIndex < 0) {
    res.status(404).json({ message: "没有找到这条买家秀，请重新抓取后再试。" });
    return;
  }
  const item = items[itemIndex];
  const zip = new JSZip();
  const title = safeFilename(snapshot.title || product.name || product.id);
  const result = await addBuyerShowsToZip(zip, { ...snapshot, buyerShows: [item] });
  zip.file("买家秀清单.json", JSON.stringify({ productId: product.id, title: snapshot.title, capturedAt: snapshot.capturedAt, item, downloaded: result.downloaded }, null, 2));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${title}_买家秀_${String(itemIndex + 1).padStart(2, "0")}.zip`)}`);
  res.send(buffer);
});

app.get("/api/products/buyer-shows/download", async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100);
  const db = await readDb();
  const products = ids.map((id) => db.products.find((product) => product.id === id)).filter((product) => product?.lastSnapshot && validBuyerShows(product.lastSnapshot));
  if (!products.length) {
    res.status(404).json({ message: "选中的商品没有可下载的买家秀。" });
    return;
  }
  const zip = new JSZip();
  const manifest = [];
  for (const [index, product] of products.entries()) {
    const title = safeFilename(product.lastSnapshot.title || product.name || product.id);
    const result = await addBuyerShowsToZip(zip, product.lastSnapshot, `${String(index + 1).padStart(2, "0")}_${title}`);
    manifest.push({ productId: product.id, title: product.lastSnapshot.title, count: result.count, downloaded: result.downloaded });
  }
  zip.file("买家秀清单.json", JSON.stringify({ products: manifest, generatedAt: new Date().toISOString() }, null, 2));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent("批量买家秀.zip")}`);
  res.send(buffer);
});

app.delete("/api/snapshots", async (_req, res) => {
  await updateDb((db) => {
    db.snapshots = [];
    db.products = db.products.map((product) => ({
      ...product,
      lastSnapshot: undefined,
      lastStatus: "pending",
      lastError: "",
      updatedAt: new Date().toISOString(),
    }));
    return db;
  });
  res.status(204).end();
});

app.use((req, res, next) => {
  if (!staticMiddleware) return next();
  return staticMiddleware(req, res, (error) => {
    if (error) return next(error);
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    return res.sendFile(path.join(staticMiddleware.directory, "index.html"));
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ message: err.issues.map((issue) => issue.message).join("；") });
    return;
  }
  console.error("[api]", err);
  res.status(500).json({ message: err.message || "服务端运行失败。" });
});

export async function startServer({ host = "127.0.0.1", port = Number(process.env.PORT || 4317), staticDir = "" } = {}) {
  if (staticDir) {
    const directory = path.resolve(staticDir);
    staticMiddleware = express.static(directory);
    staticMiddleware.directory = directory;
  }
  if (!schedulerStarted) {
    startScheduler();
    schedulerStarted = true;
  }

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.once("error", reject);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`电商竞品监控服务已启动：http://${host}:${actualPort}`);
  const eagerBrowserWarmup = process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP === "1"
    || (process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP !== "0" && process.platform !== "darwin");
  if (eagerBrowserWarmup) {
    const warmupTimer = setTimeout(() => {
      readDb()
        .then(async (db) => {
          for (const session of db.authSessions.filter((item) => item.source === "taobao-browser" && (item.enabled ?? item.active ?? true))) {
            await keepAccountBrowserWarm(session);
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        })
        .catch((error) => console.error("[browser-warmup]", error));
    }, 3000);
    warmupTimer.unref?.();
  }
  return server;
}

export async function stopServer(server) {
  stopScheduler();
  schedulerStarted = false;
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error("[startup]", error);
    process.exitCode = 1;
  });
}
