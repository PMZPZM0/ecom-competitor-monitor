import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import JSZip from "jszip";
import multer from "multer";
import sharp from "sharp";
import { loadEnv } from "./utils/env.js";
import { dbRuntimeInfo, newId, readDb, updateDb } from "./storage/db.js";
import { analyzeData } from "./services/analysisService.js";
import { buildTaobaoOAuthUrl } from "./services/authService.js";
import { clearFinishedCaptureJobs, getCaptureQueueStatus, preserveBuyerShowHistory, rescheduleMonitor, runMonitorOnce, runProductOnce, scheduleProduct, sessionsForProduct, setSkuMonitorPrice, snapshotHasVerifiedNormalPrice, startScheduler, stopScheduler, withAccountCaptureLock } from "./services/monitorService.js";
import { createNotificationLog, effectivePriceForSku, publicFeishuConfig, sendFeishuNotification, updateFeishuConfig } from "./services/feishuService.js";
import { appendPriceDocument, cliStatus, createPriceDocument, readAuthQr, startCliLogin, startCliSetup } from "./services/larkCliService.js";
import { browserRuntimeInfo, checkTaobaoSession, closeAccountBrowser, findAvailableBrowserPort, getTaobaoAuthState, isTaobaoLoginUrl, keepAccountBrowserWarm, minimizeAccountBrowser, openProductInAccountChrome, openTaobaoLogin } from "./services/browserService.js";
import { scrapeTmallBuyerShows, scrapeTmallProduct, SCRAPER_VERSION } from "./services/tmallScraper.js";
import { normalizeProductUrl } from "./utils/productUrl.js";
import { checkForUpdate } from "./services/updateService.js";
import {
  deleteGeneratedImage,
  generateImages,
  imageGenerationLimits,
  listGeneratedImages,
  readGeneratedImageFile,
  saveGeneratedImages,
  updateGeneratedImage,
} from "./services/imageGenerationService.js";
import { clearPhotoshopWorkfile, openGeneratedImageInPhotoshop, syncPhotoshopWorkfile } from "./services/photoshopService.js";
import { MODEL_CHANNEL_IDS, ModelApiError, publicModelConfig, recordModelTestResult, resolveModelConfig, testImageModel, updateModelConfig } from "./services/modelConfigService.js";
import {
  clearLocalEvidenceFiles,
  createLocalImport,
  getLocalEvidenceStorageOverview,
  loadLocalImportRecord,
  LOCAL_IMPORT_MAX_BYTES,
  mergeLocalImportSnapshot,
  saveCapturedSnapshotLocalEvidence,
  validateLocalEvidenceDirectory,
} from "./services/localImportService.js";
import { isAllowedLocalRequest, localCorsOptions } from "./utils/localOrigin.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const startedAt = new Date().toISOString();

function resolveBuildCommit() {
  if (process.env.ECOM_MONITOR_BUILD_COMMIT) return process.env.ECOM_MONITOR_BUILD_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return packageInfo.buildCommit || "packaged-unknown";
  }
}

function runtimeInfo() {
  return {
    version: packageInfo.version,
    buildCommit: resolveBuildCommit(),
    scraperVersion: SCRAPER_VERSION,
    startedAt,
    processId: process.pid,
    mode: process.versions.electron ? "desktop" : "development",
    ...dbRuntimeInfo(),
    ...browserRuntimeInfo(),
  };
}

export const app = express();
const pendingScans = new Map();
const pendingBrowserPorts = new Set();
let authCheckActive = false;
let imageGenerationActive = false;
let staticMiddleware = null;
let schedulerStarted = false;
const localImportCommits = new Map();
const rawDataCaptures = new Map();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: imageGenerationLimits.maxReferenceBytes,
    files: imageGenerationLimits.maxReferenceFiles + 1,
    fields: 2,
    parts: imageGenerationLimits.maxReferenceFiles + 3,
  },
  fileFilter: (_req, file, callback) => {
    const type = String(file.mimetype || "").toLowerCase();
    if (["image/png", "image/jpeg", "image/webp"].includes(type)) return callback(null, true);
    return callback(Object.assign(new Error("参考图只支持 PNG、JPEG 或 WEBP。"), {
      status: 400,
      code: "IMAGE_REFERENCE_TYPE_INVALID",
    }));
  },
});
const imageUploadFields = imageUpload.fields([
  { name: "referenceImages", maxCount: imageGenerationLimits.maxReferenceFiles },
  { name: "maskImage", maxCount: 1 },
]);

function reserveImageGeneration(req, res, next) {
  if (imageGenerationActive) {
    res.status(409).json({ message: "已有图片正在生成，请等待完成后再提交下一次任务。" });
    return;
  }
  imageGenerationActive = true;
  let parsing = true;
  let uploadAborted = false;
  const releaseAbortedUpload = () => {
    if (parsing) {
      uploadAborted = true;
      imageGenerationActive = false;
    }
  };
  req.once("aborted", releaseAbortedUpload);
  imageUploadFields(req, res, (error) => {
    parsing = false;
    req.off("aborted", releaseAbortedUpload);
    const uploadError = error || (uploadAborted
      ? Object.assign(new Error("参考图上传已中断。"), { status: 400, code: "IMAGE_MULTIPART_ABORTED" })
      : null);
    if (uploadError && !(uploadError instanceof multer.MulterError) && !uploadError.status) {
      uploadError.status = 400;
      uploadError.code = "IMAGE_MULTIPART_INVALID";
    }
    if (uploadError) imageGenerationActive = false;
    next(uploadError);
  });
}

function publicAuthSession(session) {
  const result = { ...session, cookie: session.cookie ? "configured" : "" };
  delete result.cooldownUntil;
  if (result.healthStatus === "cooldown") result.healthStatus = "degraded";
  return result;
}

app.use((req, res, next) => {
  if (isAllowedLocalRequest({ origin: req.get("origin"), host: req.get("host"), secFetchSite: req.get("sec-fetch-site") })) return next();
  return res.status(403).json({ message: "只允许本机软件访问该接口。" });
});
app.use(cors(localCorsOptions));
app.use(express.json({ limit: "2mb" }));

app.get("/api/runtime/update", async (_req, res) => {
  try {
    res.json(await checkForUpdate(packageInfo.version));
  } catch (error) {
    console.error("[update]", error.message);
    res.status(502).json({ message: `无法连接 GitHub 检查更新：${error.message}` });
  }
});

app.get("/api/capture-queue", (_req, res) => {
  res.json(getCaptureQueueStatus());
});

app.delete("/api/capture-queue/completed", (_req, res) => {
  res.json({ removed: clearFinishedCaptureJobs() });
});

const productSchema = z.object({
  name: z.string().trim().optional().default(""),
  url: z.string().url(),
  group: z.string().optional().default("默认分组"),
  accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
  captureBuyerShows: z.boolean().default(true),
  captureMediaAssets: z.boolean().default(false),
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

export async function fetchRemoteMedia(urlValue) {
  if (!urlValue) return false;
  let url = new URL(cleanMediaUrl(urlValue));
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isAllowedMediaHost(url)) return false;
    response = await fetch(url.toString(), {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://detail.tmall.com/" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirects === 3) return false;
    url = new URL(location, url);
  }
  if (!response) return false;
  const finalUrl = response.url ? new URL(response.url) : url;
  if (!isAllowedMediaHost(finalUrl)) return false;
  if (!response.ok) return false;
  const contentType = response.headers.get("content-type") || "";
  const contentLength = Number(response.headers.get("content-length") || 0);
  const allowedType = /^(?:image\/(?:jpeg|png|webp|gif)|video\/mp4|application\/(?:octet-stream|vnd\.apple\.mpegurl|x-mpegurl))/i.test(contentType);
  if (!allowedType || contentLength > 120_000_000) return false;
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 120_000_000) return false;
  return { url: finalUrl, contentType, data };
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

export function validBuyerShows(snapshot) {
  const source = snapshot?.buyerShowCapture?.status === "failed" && !(snapshot?.buyerShows || []).length
    ? snapshot?.buyerShowCachedItems || []
    : snapshot?.buyerShows || [];
  return source.filter((item) => item && (item.text || item.images?.length || item.videoUrls?.length));
}

export async function addBuyerShowsToZip(zip, snapshot, folderPrefix = "买家秀") {
  const items = validBuyerShows(snapshot);
  const tasks = [];
  for (const [index, item] of items.entries()) {
    const folder = `${folderPrefix}/${String(index + 1).padStart(3, "0")}`;
    if (item.text) zip.folder(folder).file("文案.txt", String(item.text));
    for (const [imageIndex, url] of (item.images || []).map(cleanMediaUrl).filter(Boolean).entries()) {
      tasks.push({ folder, url, filename: `${String(imageIndex + 1).padStart(2, "0")}_图片`, convertImageToJpeg: true, itemId: item.id });
    }
    for (const [videoIndex, url] of (item.videoUrls || []).map(cleanMediaUrl).filter(Boolean).entries()) {
      tasks.push({ folder, url, filename: `${String(videoIndex + 1).padStart(2, "0")}_视频`, convertImageToJpeg: false, itemId: item.id });
    }
  }
  let nextTask = 0;
  let downloaded = 0;
  const failures = [];
  const worker = async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      try {
        const ok = await addRemoteMedia(zip, task.folder, task.url, task.filename, { convertImageToJpeg: task.convertImageToJpeg });
        if (ok) downloaded += 1;
        else failures.push({ buyerShowId: task.itemId, url: task.url, reason: "媒体不可用或格式不受支持" });
      } catch (error) {
        failures.push({ buyerShowId: task.itemId, url: task.url, reason: error.message || "下载失败" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, worker));
  return { count: items.length, requested: tasks.length, downloaded, failures };
}

app.get("/api/health", async (_req, res) => {
  const db = await readDb();
  res.json({ ok: true, monitor: db.monitor, runtime: runtimeInfo(), time: new Date().toISOString() });
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
    modelConfig: publicModelConfig(db.modelConfig),
    feishu: publicFeishuConfig(db.feishu),
    notificationLogs: db.notificationLogs.filter((log) => log.status !== "suppressed").slice(-80).reverse(),
    monitor: db.monitor,
    captureQueue: getCaptureQueueStatus(),
    runtime: runtimeInfo(),
  });
});

app.get("/api/local-evidence", async (_req, res) => {
  const db = await readDb();
  res.json(await getLocalEvidenceStorageOverview(db.localEvidence?.directory));
});

app.patch("/api/local-evidence", async (req, res) => {
  const { directory } = z.object({ directory: z.string().trim().max(2048).nullable() }).parse(req.body);
  const restoreDefault = directory == null || directory === "";
  const validatedDirectory = await validateLocalEvidenceDirectory(directory);
  await updateDb((db) => {
    db.localEvidence = { directory: restoreDefault ? "" : validatedDirectory };
    return db;
  });
  res.json(await getLocalEvidenceStorageOverview(restoreDefault ? "" : validatedDirectory));
});

app.delete("/api/local-evidence", async (_req, res) => {
  const db = await readDb();
  const result = await clearLocalEvidenceFiles(db.localEvidence?.directory);
  const deletedIds = new Set(result.deletedImportIds);
  const deletedCaptureIds = new Set(result.deletedCaptureIds || []);
  if (deletedIds.size || deletedCaptureIds.size) {
    const clearDeletedReference = (snapshot) => {
      if (!snapshot || (!deletedIds.has(snapshot.localImportId) && !deletedCaptureIds.has(snapshot.browserEvidenceId) && !deletedCaptureIds.has(snapshot.buyerShowEvidenceId))) return snapshot;
      const cleaned = { ...snapshot };
      if (deletedIds.has(snapshot.localImportId)) {
        delete cleaned.localImportId;
        delete cleaned.localImportFile;
      }
      if (deletedCaptureIds.has(snapshot.browserEvidenceId)) {
        delete cleaned.browserEvidenceId;
        delete cleaned.browserEvidenceFile;
        delete cleaned.localFirst;
      }
      if (deletedCaptureIds.has(snapshot.buyerShowEvidenceId)) {
        delete cleaned.buyerShowEvidenceId;
        delete cleaned.buyerShowEvidenceFile;
        delete cleaned.buyerShowLocalFirst;
      }
      return cleaned;
    };
    await updateDb((current) => {
      current.snapshots = current.snapshots.map(clearDeletedReference);
      current.products = current.products.map((product) => ({
        ...product,
        lastSnapshot: clearDeletedReference(product.lastSnapshot),
      }));
      return current;
    });
  }
  const { deletedImportIds: _deletedImportIds, deletedCaptureIds: _deletedCaptureIds, ...response } = result;
  res.json(response);
});

app.post("/api/local-evidence/select-directory", async (_req, res) => {
  if (!process.versions.electron) return res.status(501).json({ message: "网页版请直接填写证据保存目录。" });
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  res.json({ directory: result.canceled ? null : result.filePaths[0] || null });
});

app.post("/api/local-evidence/open-directory", async (_req, res) => {
  if (!process.versions.electron) return res.status(501).json({ message: "网页版无法调用系统文件管理器。" });
  const db = await readDb();
  const directory = await validateLocalEvidenceDirectory(db.localEvidence?.directory);
  const { shell } = await import("electron");
  const error = await shell.openPath(directory);
  if (error) throw localImportError("OPEN_EVIDENCE_DIRECTORY_FAILED", error, 500);
  res.json({ ok: true, directory });
});

function localImportError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function existingLocalImportResult(data, record) {
  const snapshot = data.snapshots.find((item) => item.localImportId === record.importId);
  if (!snapshot) return null;
  const product = data.products.find((item) => item.id === snapshot.productId);
  if (!product) return null;
  const run = [...data.runs].reverse().find((item) => item.source === "local-import" && item.items?.some((entry) => entry.productId === product.id)) || {
    id: `existing_${record.importId}`,
    source: "local-import",
    scope: product.id,
    status: "success",
    startedAt: snapshot.capturedAt,
    finishedAt: snapshot.capturedAt,
    total: 1,
    success: 1,
    failed: 0,
    items: [],
    message: "该本地数据已经导入，未重复写入价格记录。",
  };
  return { created: false, alreadyCommitted: true, savedFile: record.savedFile, sourceFile: record.sourceFile || "", product, snapshot, run };
}

async function commitLocalImportRecord(importId) {
  const record = await loadLocalImportRecord(importId);
  if (!record.canCommit) {
    throw localImportError("LOCAL_IMPORT_UNVERIFIED", `当前内容不能写入监控：${record.blockingReasons.join("；") || "没有可核验的 SKU 价格"}。`, 409);
  }

  const previous = existingLocalImportResult(await readDb(), record);
  if (previous) return previous;

  let productId = "";
  let created = false;
  const now = new Date().toISOString();
  await updateDb((data) => {
    const existing = data.products.find((product) => String(product.itemId || itemIdFromUrl(product.url)) === record.itemId);
    if (existing) {
      productId = existing.id;
      existing.captureMode = "local-only";
      existing.enabled = false;
      existing.nextMonitorAt = null;
      existing.updatedAt = now;
      return data;
    }
    const product = {
      id: newId("prod"),
      name: record.snapshot.title || `本地导入商品 ${record.itemId}`,
      shopName: record.snapshot.shopName || "",
      model: record.snapshot.model || "",
      itemId: record.itemId,
      url: normalizeProductUrl(record.snapshot.finalUrl || `https://detail.tmall.com/item.htm?id=${record.itemId}`),
      group: "本地导入",
      accountType: record.accountType,
      captureBuyerShows: false,
      captureMediaAssets: false,
      captureMode: "local-only",
      enabled: false,
      mainImage: "",
      lastStatus: "pending",
      lastError: "",
      createdAt: now,
      updatedAt: now,
    };
    productId = product.id;
    created = true;
    data.products.unshift(product);
    return data;
  });

  const localSnapshot = {
    ...structuredClone(record.snapshot),
    localImportId: record.importId,
    localImportFile: record.savedFile,
  };
  const accountLabels = { normal: "普通", gift: "礼金", vip88: "88VIP" };
  const pseudoSession = {
    id: `local_${record.importId.slice(6, 18)}`,
    name: `本地${accountLabels[record.accountType]}数据`,
    cookie: "",
    source: "manual-cookie",
    accountType: record.accountType,
    active: true,
    enabled: true,
    healthStatus: "healthy",
    loginStatus: "valid",
    createdAt: record.createdAt,
  };
  const result = await runProductOnce(productId, {
    source: "local-import",
    authSessions: [pseudoSession],
    scraper: async (product) => {
      const expectedItemId = String(product.itemId || itemIdFromUrl(product.url));
      if (expectedItemId !== record.itemId) throw localImportError("LOCAL_IMPORT_ITEM_MISMATCH", "本地数据与目标商品 ID 不一致，已停止写入。", 409);
      return mergeLocalImportSnapshot(product, localSnapshot);
    },
  });
  if (!result.snapshot) {
    throw localImportError("LOCAL_IMPORT_COMMIT_FAILED", result.product.lastError || "本地数据写入失败。", 422);
  }
  await rescheduleMonitor();
  return { created, alreadyCommitted: false, savedFile: record.savedFile, sourceFile: record.sourceFile || "", product: result.product, snapshot: result.snapshot, run: result.run };
}

app.post("/api/local-imports/preview", express.text({ type: "text/plain", limit: LOCAL_IMPORT_MAX_BYTES }), async (req, res) => {
  const options = z.object({
    accountType: z.enum(["normal", "gift", "vip88"]).default("normal"),
    itemIdHint: z.string().regex(/^\d{6,20}$/).optional(),
  }).parse(req.query);
  res.status(201).json(await createLocalImport(req.body, options));
});

app.post("/api/local-imports/:id/commit", async (req, res) => {
  let operation = localImportCommits.get(req.params.id);
  if (!operation) {
    operation = commitLocalImportRecord(req.params.id).finally(() => localImportCommits.delete(req.params.id));
    localImportCommits.set(req.params.id, operation);
  }
  res.json(await operation);
});

export async function captureSanitizedDataPreview(input, { scraper = scrapeTmallProduct } = {}) {
  const data = await readDb();
  const session = data.authSessions.find((item) => item.id === input.sessionId);
  if (!session || session.source !== "taobao-browser" || !session.browserProfileKey || !session.browserPort) {
    throw localImportError("BROWSER_SESSION_NOT_FOUND", "请选择一个已经扫码授权的账号浏览器。", 409);
  }
  if (!(session.enabled ?? session.active ?? true) || session.loginStatus === "expired") {
    throw localImportError("BROWSER_SESSION_UNAVAILABLE", "该账号当前不可用，请先检测登录或重新授权。", 409);
  }
  const url = input.url;
  const itemId = input.itemId;
  const captureCandidate = {
    id: `raw_${itemId}`,
    name: `数据查看 ${itemId}`,
    itemId,
    url,
    group: "数据查看器",
    accountType: session.accountType || "normal",
    captureBuyerShows: false,
    captureMediaAssets: false,
  };
  const captured = await withAccountCaptureLock(session, () => scraper(captureCandidate, session));
  if (captured.localFirst?.sourceSaved !== true || captured.localFirst?.parsedFromDisk !== true || !captured.browserEvidenceFile) {
    throw localImportError("LOCAL_FIRST_CAPTURE_INCOMPLETE", "浏览器数据没有完成脱敏落盘和重新读盘，无法生成查看数据。", 422);
  }
  if (!snapshotHasVerifiedNormalPrice(captured)) {
    throw localImportError("RAW_DATA_PRICE_UNVERIFIED", "本地文件没有解析出可验证的 SKU 普通价；未创建或修改监控商品。", 422);
  }
  const accountType = session.accountType || "normal";
  const preview = await saveCapturedSnapshotLocalEvidence({ ...captured, primaryAccountType: accountType });
  const exported = {
    schemaVersion: 1,
    dataType: "sanitized-price-evidence",
    sanitized: true,
    itemId,
    accountType,
    capturedAt: captured.capturedAt,
    title: preview.title,
    shopName: preview.shopName,
    resolutionStatus: preview.resolutionStatus,
    price: preview.price,
    priceRange: preview.priceRange,
    skuPrices: preview.skuPrices,
    warnings: preview.warnings,
  };
  const jsonText = JSON.stringify(exported, null, 2);
  const byteSize = Buffer.byteLength(jsonText, "utf8");
  if (byteSize > LOCAL_IMPORT_MAX_BYTES) {
    throw localImportError("RAW_DATA_TOO_LARGE", "脱敏数据超过 8 MB，已保留本地证据，但不在界面中返回不完整内容。", 413);
  }
  return {
    ok: true,
    evidenceId: preview.importId,
    itemId,
    accountType,
    capturedAt: captured.capturedAt,
    sourceFile: preview.savedFile,
    byteSize,
    skuCount: preview.skuPrices.length,
    verifiedSkuCount: preview.verifiedSkuCount,
    sanitized: true,
    jsonText,
  };
}

app.post("/api/raw-data/capture", async (req, res) => {
  const input = z.object({
    sessionId: z.string().trim().min(1),
    url: z.string().trim().url().optional(),
    itemId: z.string().regex(/^\d{6,20}$/).optional(),
    platform: z.enum(["tmall", "taobao"]).default("tmall"),
  }).refine((value) => Boolean(value.url || value.itemId), { message: "请填写商品链接或商品 ID。" }).parse(req.body);
  let url;
  let itemId;
  try {
    url = normalizeProductUrl(input.url || `https://${input.platform === "taobao" ? "item.taobao.com" : "detail.tmall.com"}/item.htm?id=${input.itemId}`);
    itemId = itemIdFromUrl(url);
  } catch {
    throw localImportError("INVALID_PRODUCT_URL", "请填写有效的淘宝或天猫商品链接，或 6 至 20 位商品 ID。", 400);
  }
  if (input.url && input.itemId && input.itemId !== itemId) {
    throw localImportError("PRODUCT_ID_MISMATCH", "商品链接与填写的商品 ID 不一致，请核对后重试。", 400);
  }
  const normalizedInput = { ...input, url, itemId };
  const key = `${input.sessionId}:${itemId}`;
  let operation = rawDataCaptures.get(key);
  if (!operation) {
    operation = captureSanitizedDataPreview(normalizedInput).finally(() => rawDataCaptures.delete(key));
    rawDataCaptures.set(key, operation);
  }
  res.status(201).json(await operation);
});

app.post("/api/products", async (req, res) => {
  const parsed = productSchema.parse(req.body);
  parsed.url = normalizeProductUrl(parsed.url);
  parsed.name ||= `待识别商品 ${itemIdFromUrl(parsed.url)}`;
  const product = {
    id: newId("prod"),
    ...parsed,
    enabled: false,
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
    captureBuyerShows: z.boolean().default(true),
    captureMediaAssets: z.boolean().default(false),
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
    captureBuyerShows: parsed.captureBuyerShows,
    captureMediaAssets: parsed.captureMediaAssets,
    enabled: false,
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
    run: queueResult?.run || null,
    items: queueResult?.run?.items || [],
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
    captureBuyerShows: z.boolean().optional(),
    captureMediaAssets: z.boolean().optional(),
    enabled: z.boolean().optional(),
    monitorScheduleMode: z.enum(["once", "interval"]).optional(),
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
      if (product.captureMode === "local-only" && patch.enabled === true) {
        throw localImportError("LOCAL_ONLY_MONITOR_DISABLED", "该商品使用本地数据模式，不能启用浏览器定时抓取。请通过“本地数据导入”更新价格。", 409);
      }
      scheduleChanged = patch.enabled !== undefined || patch.monitorScheduleMode !== undefined || patch.monitorIntervalMinutes !== undefined || patch.monitorStartAt !== undefined;
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

app.patch("/api/products/:id/sku-monitor-price", async (req, res) => {
  const { skuId, value } = z.object({ skuId: z.string().min(1), value: z.number().positive().nullable() }).parse(req.body);
  let updated = null;
  await updateDb((db) => {
    db.products = db.products.map((product) => {
      if (product.id !== req.params.id) return product;
      updated = { ...setSkuMonitorPrice(product, skuId, value), updatedAt: new Date().toISOString() };
      return updated;
    });
    return db;
  });
  if (!updated) return res.status(404).json({ message: "商品不存在。" });
  res.json(updated);
});

app.patch("/api/feishu/settings", async (req, res) => {
  const schema = z.object({
    enabled: z.boolean().optional(),
    webhookUrl: z.string().url().optional(),
    signingSecret: z.string().min(1).max(500).optional(),
    clearSigningSecret: z.boolean().optional(),
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
    const effective = effectivePriceForSku(sku, snapshot?.primaryAccountType || product.accountType || "normal");
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

app.post("/api/products/:id/buyer-shows/retry", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product) return res.status(404).json({ message: "商品不存在。" });
  if (product.captureMode === "local-only") return res.status(409).json({ message: "该商品使用本地数据模式，已阻止买家秀网页抓取。" });
  if (!product.lastSnapshot) return res.status(409).json({ message: "商品还没有价格快照，请先完成首次抓取。" });

  const activeSessions = db.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const sessionCandidates = sessionsForProduct(activeSessions, accountType);
  if (!sessionCandidates.length) return res.status(409).json({ message: "没有可用的淘宝登录账号，请先到账号授权页面登录。" });

  const captures = [];
  const interactions = [];
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await scrapeTmallBuyerShows(product, sessionCandidates[attempt % sessionCandidates.length]);
    captures.push(result.capture);
    interactions.push(...result.interactions.map((interaction) => ({ ...interaction, retryAttempt: attempt + 1 })));
    if (result.capture.status !== "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  result.capture.attempts = captures.flatMap((capture) => capture.attempts || []);
  result.interactions = interactions;
  const nextSnapshot = preserveBuyerShowHistory({
    ...structuredClone(product.lastSnapshot),
    buyerShowCapture: result.capture,
    buyerShows: result.items,
    ...(result.browserEvidenceFile ? {
      buyerShowEvidenceId: result.browserEvidenceId,
      buyerShowEvidenceFile: result.browserEvidenceFile,
      buyerShowLocalFirst: result.localFirst,
    } : {}),
    rawSignals: {
      ...(product.lastSnapshot.rawSignals || {}),
      buyerShowCount: result.items.length,
      buyerShowInteractions: result.interactions,
      buyerShowEvidenceSourceSaved: result.localFirst?.sourceSaved === true,
      buyerShowEvidenceParsedFromDisk: result.localFirst?.parsedFromDisk === true,
    },
  }, product.lastSnapshot);
  nextSnapshot.rawSignals.buyerShowCount = nextSnapshot.buyerShows?.length || 0;
  let updatedProduct;
  await updateDb((current) => {
    const productIndex = current.products.findIndex((item) => item.id === product.id);
    if (productIndex >= 0) {
      updatedProduct = { ...current.products[productIndex], lastSnapshot: nextSnapshot, updatedAt: new Date().toISOString() };
      current.products[productIndex] = updatedProduct;
    }
    for (let index = current.snapshots.length - 1; index >= 0; index -= 1) {
      if (current.snapshots[index].productId !== product.id) continue;
      current.snapshots[index] = { ...current.snapshots[index], ...nextSnapshot };
      break;
    }
    return current;
  });
  res.json({ ok: result.capture.status !== "failed", product: updatedProduct, capture: nextSnapshot.buyerShowCapture });
});

app.post("/api/products/:id/open", async (req, res) => {
  const db = await readDb();
  const product = db.products.find((item) => item.id === req.params.id);
  if (!product) {
    res.status(404).json({ message: "商品不存在。" });
    return;
  }
  const accountType = product.lastSnapshot?.primaryAccountType || product.accountType || "normal";
  const requestedSessionId = z.object({ sessionId: z.string().optional() }).parse(req.body || {}).sessionId;
  const activeSessions = db.authSessions.filter((session) => session.source === "taobao-browser" && (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired" && session.browserProfileKey && session.browserPort);
  const authSession = activeSessions.find((session) => session.id === requestedSessionId)
    || activeSessions.find((session) => session.id === product.lastSnapshot?.primaryAccountSessionId)
    || sessionsForProduct(activeSessions, accountType)[0];
  if (!authSession) {
    const accountLabel = accountType === "gift" ? "礼金" : accountType === "vip88" ? "88VIP" : "普通";
    res.status(409).json({ message: `没有可用的${accountLabel}账号登录态，也没有其他可回退的扫码账号，请先在账号授权页面登录。` });
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
  res.json({ ok: true, run: result.run });
});

app.patch("/api/monitor/settings", async (req, res) => {
  const schema = z.object({
    intervalMinutes: z.number().int().min(30).max(1440).optional(),
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
      nextRunAt: running ? new Date(Date.now() + intervalMinutes * 60_000).toISOString() : null,
    };
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
    channel: z.enum(MODEL_CHANNEL_IDS).optional(),
    customBaseUrl: z.string().trim().min(1).max(500).optional(),
    baseUrl: z.string().trim().min(1).max(500).optional(),
    apiKey: z.string().max(500).optional(),
    clearApiKey: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    imageModel: z.string().trim().min(1).max(200).optional(),
  }).strict();
  const parsed = schema.parse(req.body || {});
  let config;
  try {
    await updateDb((db) => {
      db.modelConfig = updateModelConfig(db.modelConfig, parsed);
      config = db.modelConfig;
      return db;
    });
  } catch (error) {
    throw new ModelApiError(error.message || "模型配置无效。", { code: "MODEL_CONFIG_INVALID", status: 400 });
  }
  res.json(publicModelConfig(config));
});

app.post("/api/model-config/test", async (req, res) => {
  const schema = z.object({
    channel: z.enum(MODEL_CHANNEL_IDS).optional(),
    customBaseUrl: z.string().trim().min(1).max(500).optional(),
    baseUrl: z.string().trim().min(1).max(500).optional(),
    apiKey: z.string().max(500).optional(),
    imageModel: z.string().trim().min(1).max(200).optional(),
  }).strict();
  const parsed = schema.parse(req.body || {});
  const db = await readDb();
  let draft;
  try {
    draft = updateModelConfig(db.modelConfig, parsed);
  } catch (error) {
    throw new ModelApiError(error.message || "模型配置无效。", { code: "MODEL_CONFIG_INVALID", status: 400 });
  }
  const started = Date.now();
  try {
    const result = await testImageModel(draft);
    const tested = resolveModelConfig(draft);
    let testingStoredConfig = false;
    try {
      const stored = resolveModelConfig(db.modelConfig, { channel: tested.channel });
      testingStoredConfig = !String(parsed.apiKey || "").trim() && stored.baseUrl === tested.baseUrl && stored.imageModel === tested.imageModel;
    } catch {
      testingStoredConfig = false;
    }
    if (testingStoredConfig) await updateDb((current) => {
      current.modelConfig = recordModelTestResult(current.modelConfig, { channel: tested.channel, status: result.status, testedAt: result.testedAt });
      return current;
    });
    res.json({
      ok: result.ok,
      status: result.status,
      model: result.model,
      channel: tested.channel,
      latencyMs: Date.now() - started,
      testedAt: result.testedAt,
      message: result.message,
    });
  } catch (error) {
    const tested = resolveModelConfig(draft);
    let testingStoredConfig = false;
    try {
      const stored = resolveModelConfig(db.modelConfig, { channel: tested.channel });
      testingStoredConfig = !String(parsed.apiKey || "").trim() && stored.baseUrl === tested.baseUrl && stored.imageModel === tested.imageModel;
    } catch {
      testingStoredConfig = false;
    }
    if (testingStoredConfig) await updateDb((current) => {
      current.modelConfig = recordModelTestResult(current.modelConfig, { channel: tested.channel, status: "failed" });
      return current;
    });
    throw error;
  }
});

app.get("/api/images", async (req, res) => {
  const { scope } = z.object({ scope: z.enum(["all", "active", "favorites", "archived"]).default("all") }).parse(req.query);
  res.json(await listGeneratedImages({ scope }));
});

app.get("/api/images/:id/file", async (req, res) => {
  const thumbnail = req.query.thumbnail === "1";
  const image = await readGeneratedImageFile(req.params.id, { thumbnail });
  res.setHeader("content-type", image.mimeType);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`);
  res.send(image.buffer);
});

app.patch("/api/images/:id", async (req, res) => {
  const patch = z.object({ isFavorite: z.boolean().optional(), isArchived: z.boolean().optional() })
    .refine((value) => value.isFavorite !== undefined || value.isArchived !== undefined, "请选择要更新的图片状态。")
    .parse(req.body);
  res.json(await updateGeneratedImage(req.params.id, patch));
});

app.delete("/api/images/:id", async (req, res) => {
  await deleteGeneratedImage(req.params.id);
  await clearPhotoshopWorkfile(req.params.id);
  res.status(204).end();
});

app.post("/api/images/:id/photoshop/open", async (req, res) => {
  const { imageId, reused, applicationName } = await openGeneratedImageInPhotoshop(req.params.id);
  res.json({ imageId, reused, applicationName });
});

app.post("/api/images/:id/photoshop/sync", async (req, res) => {
  const { image, modifiedAt } = await syncPhotoshopWorkfile(req.params.id);
  res.json({ image, modifiedAt });
});

app.post("/api/images/generate", reserveImageGeneration, async (req, res) => {
  const started = Date.now();
  try {
    const schema = z.object({
      prompt: z.string().trim().min(1, "请输入正向提示词。").max(4_000),
      negativePrompt: z.string().trim().max(2_000).optional(),
      ratio: z.enum(["1:1", "3:4", "4:3", "16:9"]),
      quality: z.enum(["low", "medium", "high"]),
      format: z.enum(["png", "jpeg", "webp"]),
      background: z.enum(["auto", "opaque", "transparent"]),
      compression: z.number().int().min(0).max(100).optional(),
      count: z.number().int().min(1).max(4),
      resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
      sourceImageId: z.string().trim().max(80).optional(),
      editMode: z.enum(["mask", "annotation"]).optional(),
    });
    let requestBody = req.body;
    if (req.is("multipart/form-data")) {
      try {
        requestBody = JSON.parse(String(req.body?.request || ""));
      } catch {
        throw Object.assign(new Error("参考图生图请求缺少有效的 request JSON 字段。"), { status: 400, code: "IMAGE_MULTIPART_REQUEST_INVALID" });
      }
    }
    const parsed = schema.parse(requestBody);
    const referenceImages = Array.isArray(req.files?.referenceImages) ? req.files.referenceImages : [];
    const maskImage = Array.isArray(req.files?.maskImage) ? req.files.maskImage[0] : null;
    const db = await readDb();
    const generated = await generateImages(db.modelConfig, parsed, {
      referenceImages,
      maskImage,
    });
    const createdAt = new Date().toISOString();
    const images = await saveGeneratedImages(generated.images, {
      ...parsed,
      model: generated.model,
      createdAt,
      referenceImageCount: generated.appliedOptions.referenceImageCount,
      maskApplied: generated.appliedOptions.maskApplied,
    });
    if (!res.destroyed) {
      res.json({
        images,
        model: generated.model,
        size: generated.size,
        durationMs: Date.now() - started,
        createdAt,
        warnings: generated.warnings,
        appliedOptions: generated.appliedOptions,
      });
    }
  } finally {
    imageGenerationActive = false;
  }
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
  const db = await readDb();
  const browserPort = await findAvailableBrowserPort([
    ...db.authSessions.map((session) => session.browserPort),
    ...Array.from(pendingScans.values(), (scan) => scan.browserPort),
    ...pendingBrowserPorts,
  ].filter(Boolean));
  pendingBrowserPorts.add(browserPort);
  try {
    const login = await openTaobaoLogin({ profileKey, port: browserPort });
    pendingScans.set(profileKey, { ...parsed, profileKey, browserPort, loginTargetId: login.targetId, createdAt: Date.now() });
    res.json(login);
  } catch (error) {
    await closeAccountBrowser({ profileKey, port: browserPort }).catch(() => undefined);
    throw error;
  } finally {
    pendingBrowserPorts.delete(browserPort);
  }
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
  await minimizeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort }).catch((error) => console.error("[browser-minimize]", error.message));
  return { status: "synced", session };
}

async function checkAuthSession(session) {
  if (session.source !== "taobao-browser" || !session.browserProfileKey || !session.browserPort) {
    return { id: session.id, loginStatus: "manual", message: "手动 Cookie 无法无损检测，请通过实际抓取或重新粘贴 Cookie 更新。" };
  }
  const state = await checkTaobaoSession({ profileKey: session.browserProfileKey, port: session.browserPort });
  const checkedAt = new Date().toISOString();
  const status = state.status || (state.loggedIn && state.cookie ? "valid" : "degraded");
  const loginStatus = status === "valid" ? "valid" : status === "expired" ? "expired" : session.loginStatus || "valid";
  let updated;
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((item) => {
      if (item.id !== session.id) return item;
      updated = {
        ...item,
        cookie: status === "valid" ? state.cookie : item.cookie,
        loginStatus,
        lastCheckedAt: checkedAt,
        healthStatus: status === "valid" ? "healthy" : "degraded",
        consecutiveFailures: status === "valid" ? 0 : item.consecutiveFailures,
      };
      return updated;
    });
    return db;
  });
  const message = status === "valid"
    ? "账号登录有效。"
    : status === "expired"
      ? "登录已明确失效，请重新授权。"
      : "账号浏览器仍保留，检测页面暂时异常；本次仅标记为待复检，不会清除登录状态。";
  return { id: session.id, status, loginStatus, checkedAt, message, session: publicAuthSession(updated) };
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
    res.json({
      total: results.length,
      valid: results.filter((result) => result.status === "valid").length,
      degraded: results.filter((result) => result.status === "degraded").length,
      expired: results.filter((result) => result.status === "expired").length,
      manual: results.filter((result) => result.loginStatus === "manual").length,
      results,
    });
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
    if (pending.sessionId) await minimizeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort }).catch((error) => console.error("[browser-minimize]", error.message));
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
    else await minimizeAccountBrowser({ profileKey: activated.browserProfileKey, port: activated.browserPort }).catch((error) => console.error("[browser-minimize]", error.message));
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
  if (product && product.captureMediaAssets !== true) {
    res.status(409).json({ message: "该商品未开启完整素材抓取，请先在商品卡片开启并重新抓取。" });
    return;
  }
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
  zip.file("买家秀清单.json", JSON.stringify({ productId: product.id, title: snapshot.title, capturedAt: snapshot.capturedAt, capture: snapshot.buyerShowCapture, items: validBuyerShows(snapshot), requested: result.requested, downloaded: result.downloaded, failures: result.failures }, null, 2));
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
  zip.file("买家秀清单.json", JSON.stringify({ productId: product.id, title: snapshot.title, capturedAt: snapshot.capturedAt, item, requested: result.requested, downloaded: result.downloaded, failures: result.failures }, null, 2));
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
    manifest.push({ productId: product.id, title: product.lastSnapshot.title, count: result.count, requested: result.requested, downloaded: result.downloaded, failures: result.failures });
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
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "每张参考图或蒙版不能超过 8 MB。"
      : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
        ? "参考图最多 4 张，批注蒙版最多 1 张。"
        : "参考图上传内容过多或格式无效。";
    res.status(413).json({ message, error: { code: `IMAGE_UPLOAD_${err.code}`, message } });
    return;
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  if (status >= 500) console.error("[api]", err);
  res.status(status).json({ message: err.message || "服务端运行失败。", ...(err.code ? { error: { code: err.code, message: err.message } } : {}) });
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
  console.log("[runtime]", runtimeInfo());
  const eagerBrowserWarmup = process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP === "1"
    || (process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP !== "0" && process.platform !== "darwin");
  if (eagerBrowserWarmup) {
    const warmupTimer = setTimeout(() => {
      readDb()
        .then(async (db) => {
          for (const session of db.authSessions.filter((item) => item.source === "taobao-browser" && (item.enabled ?? item.active ?? true))) {
            try {
              await keepAccountBrowserWarm(session);
            } catch (firstError) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              try {
                await keepAccountBrowserWarm(session);
              } catch (error) {
                console.error(`[browser-warmup] ${session.id}:`, error.message || firstError.message);
              }
            }
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
