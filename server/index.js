import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import JSZip from "jszip";
import multer from "multer";
import sharp from "sharp";
import { loadEnv } from "./utils/env.js";
import { dbRuntimeInfo, newId, readDb, updateDb } from "./storage/db.js";
import { analyzeData } from "./services/analysisService.js";
import { buildTaobaoOAuthUrl } from "./services/authService.js";
import { clearFailedCaptureJobs, clearFinishedCaptureJobs, clearStaleCaptureQueueJobs, deleteCaptureQueueJob, getCaptureQueueStatus, recoverCaptureQueue, rescheduleMonitor, resumeAuthRequiredCaptureJobs, resumeCaptureJob, runBuyerShowOnce, runCaptureBatchOnce, runProductOnce, scheduleProduct, sessionsForProduct, setSkuMonitorPrice, snapshotHasVerifiedNormalPrice, startScheduler, stopCaptureQueue, stopScheduler, withProtectedBrowserCapture } from "./services/monitorService.js";
import { monitorChannelSupported } from "./services/monitorRuleService.js";
import { createNotificationLog, effectivePriceForSku, publicFeishuConfig, sendFeishuNotification, updateFeishuConfig } from "./services/feishuService.js";
import { appendPriceDocument, cliStatus, createPriceDocument, readAuthQr, startCliLogin, startCliSetup } from "./services/larkCliService.js";
import { browserRuntimeInfo, checkTaobaoSession, closeAccountBrowser, findAvailableBrowserPort, getTaobaoAuthState, isTaobaoLoginUrl, keepAccountBrowserWarm, minimizeAccountBrowser, openProductInAccountChrome, openTaobaoLogin, openTmallLogin, resetTmallSession } from "./services/browserService.js";
import { scrapeTmallProduct, SCRAPER_VERSION } from "./services/tmallScraper.js";
import { normalizeProductUrl } from "./utils/productUrl.js";
import { checkForUpdate } from "./services/updateService.js";
import {
  deleteGeneratedImage,
  imageGenerationLimits,
  listGeneratedImages,
  readGeneratedImageFile,
  updateGeneratedImage,
} from "./services/imageGenerationService.js";
import {
  cancelImageJob,
  enqueueImageJob,
  getImageJob,
  listImageJobs,
  parseImageGenerationRequest,
  retryImageJob,
  startImageJobQueue,
  stopImageJobQueue,
  waitForImageJob,
} from "./services/imageJobService.js";
import { clearPhotoshopWorkfile, openGeneratedImageInPhotoshop, syncPhotoshopWorkfile } from "./services/photoshopService.js";
import { discoverAvailableModels, MODEL_CHANNEL_IDS, ModelApiError, publicModelConfig, recordModelTestResult, resolveModelConfig, testImageModel, testPromptModel, updateModelConfig } from "./services/modelConfigService.js";
import { analyzeProductImages, generatePromptSet, generatePromptSetLocally, interpretQuickPrompt, interpretQuickPromptLocally, normalizePromptStudioState, productFactsSchema, promptLibraryTemplateIdSchema, QUICK_PROMPT_PIPELINE_VERSION, styleSchema, validatePromptStudioInput, validateQuickPromptInput, writeFreeformImagePrompt } from "./services/promptStudioService.js";
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
import { cleanupEvidenceRetention } from "./services/evidenceRetentionService.js";
import { resumeNotificationOutbox, startNotificationOutboxWorker, stopNotificationOutboxWorker } from "./services/notificationOutboxService.js";
import {
  isTmallPriceGateError,
  TMALL_PRICE_STATUS,
} from "./services/tmallPriceCircuitService.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const packagePath = path.join(projectRoot, "package.json");
const packageInfo = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const startedAt = new Date().toISOString();

function currentVersion() {
  if (process.env.NODE_ENV === "production") return packageInfo.version;
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || packageInfo.version;
  } catch {
    return packageInfo.version;
  }
}

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
    version: currentVersion(),
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
const pendingQuickPromptRequests = new Map();
const pendingBrowserPorts = new Set();
const QUICK_PROMPT_STAGE_TIMEOUT_MS = 25_000;
const QUICK_PROMPT_TOTAL_TIMEOUT_MS = 45_000;
let authCheckActive = false;
let imageGenerationActive = false;
let staticMiddleware = null;
let schedulerStarted = false;
let evidenceCleanupTimer = null;

async function rememberPendingScan(pending) {
  pendingScans.set(pending.profileKey, pending);
  try {
    await updateDb((db) => {
      db.pendingAuthScans = [
        ...(Array.isArray(db.pendingAuthScans) ? db.pendingAuthScans : []).filter((item) => item.profileKey !== pending.profileKey),
        pending,
      ];
      return db;
    });
  } catch (error) {
    pendingScans.delete(pending.profileKey);
    throw error;
  }
}

async function forgetPendingScan(profileKey) {
  pendingScans.delete(profileKey);
  await updateDb((db) => {
    db.pendingAuthScans = (Array.isArray(db.pendingAuthScans) ? db.pendingAuthScans : []).filter((item) => item.profileKey !== profileKey);
    return db;
  });
}

function startEvidenceCleanup() {
  const run = () => cleanupEvidenceRetention({ dryRun: false })
    .then((result) => {
      if (result.deleted || result.errors.length) console.log("[evidence-retention]", result);
    })
    .catch((error) => console.error("[evidence-retention]", error));
  void run();
  evidenceCleanupTimer ||= setInterval(run, 24 * 60 * 60 * 1_000);
  evidenceCleanupTimer.unref?.();
}

function stopEvidenceCleanup() {
  if (evidenceCleanupTimer) clearInterval(evidenceCleanupTimer);
  evidenceCleanupTimer = null;
}
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
const promptStudioUploadFields = imageUpload.fields([
  { name: "productImages", maxCount: 3 },
  { name: "styleImages", maxCount: 1 },
]);

function parseImageGenerationUpload(req, res, next) {
  let parsing = true;
  let uploadAborted = false;
  const releaseAbortedUpload = () => {
    if (parsing) uploadAborted = true;
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
    next(uploadError);
  });
}

function parsePromptStudioUpload(req, res, next) {
  promptStudioUploadFields(req, res, (error) => {
    if (error && !(error instanceof multer.MulterError) && !error.status) {
      error.status = 400;
      error.code = "PROMPT_STUDIO_UPLOAD_INVALID";
    }
    next(error);
  });
}

const promptProductProfileSchema = productFactsSchema.extend({ name: z.string().trim().min(1).max(120) }).strict();
const promptStylePresetSchema = styleSchema.extend({ name: z.string().trim().min(1).max(100) }).strict();
const promptProductProfilePatchSchema = promptProductProfileSchema.partial().refine((value) => Object.keys(value).length > 0, "请选择要更新的产品档案字段。");
const promptStylePresetPatchSchema = promptStylePresetSchema.partial().refine((value) => Object.keys(value).length > 0, "请选择要更新的风格方案字段。");
const promptLibraryFavoritePatchSchema = z.object({ favorite: z.boolean() }).strict();

function promptStudioMultipartRequest(req) {
  const raw = req.body?.request;
  if (typeof raw !== "string") throw Object.assign(new Error("缺少提示词请求内容。"), { status: 400, code: "PROMPT_STUDIO_REQUEST_MISSING" });
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("提示词请求不是有效 JSON。"), { status: 400, code: "PROMPT_STUDIO_REQUEST_INVALID" });
  }
}

function reserveImageGeneration(req, res, next) {
  if (imageGenerationActive) {
    res.status(409).json({ message: "已有图片正在生成，请等待完成后再提交下一次任务。" });
    return;
  }
  imageGenerationActive = true;
  parseImageGenerationUpload(req, res, (error) => {
    if (error) imageGenerationActive = false;
    next(error);
  });
}

function publicAuthSession(session) {
  const result = {
    ...session,
    cookie: session.cookie ? "configured" : "",
    // `loginStatus` is the Taobao identity check. Price capability is kept
    // separate and starts unknown until a real, local-evidence price capture.
    tmallPriceStatus: session.tmallPriceStatus === TMALL_PRICE_STATUS.COOLDOWN
      ? TMALL_PRICE_STATUS.UNKNOWN
      : session.tmallPriceStatus || TMALL_PRICE_STATUS.UNKNOWN,
  };
  delete result.cooldownUntil;
  if (result.healthStatus === "cooldown") result.healthStatus = "degraded";
  return result;
}

function tmallPriceStatePatch(session = {}) {
  return {
    tmallPriceStatus: session.tmallPriceStatus || TMALL_PRICE_STATUS.UNKNOWN,
    tmallPriceCheckedAt: session.tmallPriceCheckedAt || null,
    tmallPriceCooldownUntil: session.tmallPriceCooldownUntil || null,
    tmallPriceDeviceCooldownUntil: session.tmallPriceDeviceCooldownUntil || null,
    tmallPriceLastFailureAt: session.tmallPriceLastFailureAt || null,
    tmallPriceFailureReason: session.tmallPriceFailureReason || null,
    tmallPriceFailureCount: Number(session.tmallPriceFailureCount || 0),
  };
}

async function persistTmallPriceState(session) {
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((item) => item.id === session.id
      ? { ...item, ...tmallPriceStatePatch(session) }
      : item);
    return db;
  });
}

app.use((req, res, next) => {
  if (isAllowedLocalRequest({ origin: req.get("origin"), host: req.get("host"), secFetchSite: req.get("sec-fetch-site") })) return next();
  return res.status(403).json({ message: "只允许本机软件访问该接口。" });
});
app.use(cors(localCorsOptions));
app.use(express.json({ limit: "2mb" }));

app.get("/api/runtime/update", async (_req, res) => {
  try {
    res.json(await checkForUpdate(currentVersion()));
  } catch (error) {
    console.error("[update]", error.message);
    res.status(502).json({ message: `无法连接 GitHub 检查更新：${error.message}` });
  }
});

app.get("/api/capture-queue", async (_req, res) => {
  res.json(await getCaptureQueueStatus());
});

app.delete("/api/capture-queue/completed", async (_req, res) => {
  res.json({ removed: await clearFinishedCaptureJobs() });
});

app.delete("/api/capture-queue/failed", async (_req, res) => {
  res.json({ removed: await clearFailedCaptureJobs() });
});

app.delete("/api/capture-queue/:id", async (req, res) => {
  const removed = await deleteCaptureQueueJob(req.params.id);
  if (!removed) return res.status(404).json({ message: "抓取任务不存在或已删除。" });
  res.status(204).end();
});

app.post("/api/capture-queue/:id/resume", async (req, res) => {
  const job = await resumeCaptureJob(req.params.id);
  if (!job) return res.status(404).json({ message: "没有找到可恢复的待授权任务。" });
  res.json(job);
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
  return /(^|\.)alicdn\.com$|(^|\.)tbcdn\.cn$/i.test(url.hostname)
    || /^cloud\.video\.taobao\.com$/i.test(url.hostname)
    || /(^|\.)cloudvideocdn\.taobao\.com$/i.test(url.hostname);
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
    captureQueue: await getCaptureQueueStatus(),
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
  let captured;
  try {
    captured = await withProtectedBrowserCapture(session, () => scraper(captureCandidate, session));
  } catch (error) {
    if (isTmallPriceGateError(error)) {
      error.status ||= 409;
      await persistTmallPriceState(session);
    }
    throw error;
  }
  if (captured.localFirst?.sourceSaved !== true
    || captured.localFirst?.sourceSanitized !== true
    || captured.localFirst?.parsedFromDisk !== true
    || !captured.browserEvidenceFile) {
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
  let followupRuns = [];
  if (created.length) {
    const createdIds = created.map((product) => product.id);
    queueResult = await runCaptureBatchOnce({ source: "manual-batch", productIds: createdIds, includeDisabled: true, captureKind: "price" });
    const successfulIds = (queueResult.run?.items || []).filter((item) => item.status !== "failed").map((item) => item.productId);
    if (successfulIds.length) {
      const followups = [];
      if (parsed.captureMediaAssets) followups.push(runCaptureBatchOnce({ source: "manual-batch-materials", productIds: successfulIds, includeDisabled: true, captureKind: "materials" }));
      if (parsed.captureBuyerShows) followups.push(runCaptureBatchOnce({ source: "manual-batch-buyer-show", productIds: successfulIds, includeDisabled: true, captureKind: "buyer-show" }));
      followupRuns = (await Promise.all(followups)).map((result) => result.run);
    }
  }
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
    followupRuns,
    items: queueResult?.run?.items || [],
    message: `提交 ${uniqueUrls.length} 条，新建 ${created.length} 条，价格抓取成功 ${success} 条，失败 ${results.length - success} 条，重复跳过 ${uniqueUrls.length - created.length} 条。${followupRuns.length ? ` 已分别完成 ${followupRuns.length} 类独立素材任务。` : ""}`,
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
    db.notificationOutbox = (db.notificationOutbox || []).filter((job) => !selectedIds.has(job.payload?.product?.id));
    for (const productId of selectedIds) delete db.alertStates?.[productId];
    return db;
  });
  await clearStaleCaptureQueueJobs();
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
    skuMonitorRules: z.record(z.string().min(1), z.object({
      lowest: z.number().positive().optional(),
      normal: z.number().positive().optional(),
      billion: z.number().positive().optional(),
      seckill: z.number().positive().optional(),
      government: z.number().positive().optional(),
      surprise: z.number().positive().optional(),
      gift: z.number().positive().optional(),
      vip88: z.number().positive().optional(),
      coin: z.number().positive().optional(),
    })).optional(),
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
      const accountType = patch.accountType || product.accountType || "normal";
      const monitorRules = patch.skuMonitorRules || product.skuMonitorRules || {};
      const unsupportedChannel = Object.values(monitorRules)
        .flatMap((rules) => Object.keys(rules || {}))
        .find((channel) => !monitorChannelSupported(accountType, channel));
      if ((patch.skuMonitorRules || patch.accountType) && unsupportedChannel) {
        throw Object.assign(new Error(`主账号类型 ${accountType} 不支持 ${unsupportedChannel} 监控口径，请先清除该规则。`), { status: 409, code: "MONITOR_CHANNEL_NOT_SUPPORTED" });
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
  const { skuId, value, channel } = z.object({
    skuId: z.string().min(1),
    value: z.number().positive().nullable(),
    channel: z.enum(["lowest", "normal", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"]).optional().default("lowest"),
  }).parse(req.body);
  let updated = null;
  await updateDb((db) => {
    db.products = db.products.map((product) => {
      if (product.id !== req.params.id) return product;
      if (value !== null && !monitorChannelSupported(product.accountType || "normal", channel)) {
        throw Object.assign(new Error("该价格口径不属于商品主账号，不能设为自动监控条件。请切回主账号视角。"), { status: 409, code: "MONITOR_CHANNEL_NOT_SUPPORTED" });
      }
      updated = { ...setSkuMonitorPrice(product, skuId, value, channel), updatedAt: new Date().toISOString() };
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
  void resumeNotificationOutbox({
    thresholdAlerts: config.enabled,
    documentSync: config.documentEnabled,
  }).catch((error) => console.error("[notification-outbox-resume]", error));
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
  void resumeNotificationOutbox({ documentSync: true })
    .catch((error) => console.error("[notification-outbox-resume]", error));
  res.status(201).json(document);
});

function lowestVerifiedSnapshotPrice(product, snapshot = product?.lastSnapshot) {
  const accountType = snapshot?.primaryAccountType || product?.accountType || "normal";
  return (snapshot?.skuPrices || []).reduce((lowest, sku) => {
    const effective = effectivePriceForSku(sku, accountType);
    if (!effective || !Number.isFinite(effective.value) || effective.value <= 0) return lowest;
    const candidate = {
      price: effective.value,
      priceLabel: effective.label || "普通价",
      skuName: sku.name || "",
      skuId: sku.skuId,
    };
    return !lowest || candidate.price < lowest.price ? candidate : lowest;
  }, null);
}

app.post("/api/feishu/test", async (_req, res) => {
  const db = await readDb();
  const product = db.products[0] || { name: "测试商品", shopName: "测试店铺", model: "测试型号", url: "http://localhost:5173" };
  const snapshot = product.lastSnapshot;
  const effective = lowestVerifiedSnapshotPrice(product, snapshot);
  const price = effective?.price ?? 0;
  try {
    await sendFeishuNotification(db.feishu, { type: "manual-sync", product, price, priceLabel: effective?.priceLabel, threshold: product.monitorPrice ?? null, skuName: effective?.skuName || "" });
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
  const current = lowestVerifiedSnapshotPrice(product, snapshot) || { price: 0, priceLabel: "当前价格", skuName: "" };
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
    db.notificationOutbox = (db.notificationOutbox || []).filter((job) => job.payload?.product?.id !== req.params.id);
    delete db.alertStates?.[req.params.id];
    return db;
  });
  await clearStaleCaptureQueueJobs();
  await rescheduleMonitor();
  res.status(204).end();
});

app.post("/api/products/:id/capture", async (req, res) => {
  const { captureKind } = z.object({ captureKind: z.enum(["price", "buyer-show", "materials"]).optional().default("price") }).parse(req.body || {});
  const source = captureKind === "materials" ? "manual-materials" : captureKind === "buyer-show" ? "manual-buyer-show" : "manual-product";
  res.json(await runProductOnce(req.params.id, { source, captureKind }));
});

app.post("/api/products/:id/capture-all-accounts", async (req, res) => {
  res.json(await runProductOnce(req.params.id, { source: "manual-account-views", accountMode: "all", captureKind: "price" }));
});

app.post("/api/products/:id/buyer-shows/retry", async (req, res) => {
  res.json(await runBuyerShowOnce(req.params.id, { source: "manual-buyer-show" }));
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
    || sessionsForProduct(activeSessions, accountType, 0, "all", product.primaryAccountSessionId)[0];
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
  const { ids, captureKind } = z.object({
    ids: z.array(z.string().min(1)).min(1).max(20),
    captureKind: z.enum(["price", "buyer-show", "materials"]).optional().default("price"),
  }).parse(req.body);
  const result = await runCaptureBatchOnce({ source: captureKind === "price" ? "manual-batch" : `manual-batch-${captureKind}`, productIds: [...new Set(ids)], includeDisabled: true, captureKind });
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

app.get("/api/prompt-studio", async (_req, res) => {
  const db = await readDb();
  const state = normalizePromptStudioState(db.promptStudio);
  res.json({ productProfiles: state.productProfiles, stylePresets: state.stylePresets, history: state.records, libraryFavorites: state.libraryFavorites });
});

app.patch("/api/prompt-studio/library-favorites/:templateId", async (req, res) => {
  const templateId = promptLibraryTemplateIdSchema.parse(req.params.templateId);
  const { favorite } = promptLibraryFavoritePatchSchema.parse(req.body || {});
  let libraryFavorites = [];
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    const nextFavorites = favorite
      ? [templateId, ...state.libraryFavorites.filter((id) => id !== templateId)]
      : state.libraryFavorites.filter((id) => id !== templateId);
    db.promptStudio = normalizePromptStudioState({ ...state, libraryFavorites: nextFavorites });
    libraryFavorites = db.promptStudio.libraryFavorites;
    return db;
  });
  res.json({ libraryFavorites });
});

app.post("/api/prompt-studio/product-profiles", async (req, res) => {
  const parsed = promptProductProfileSchema.parse(req.body || {});
  const profile = { id: newId("prompt_product"), ...parsed, updatedAt: new Date().toISOString() };
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    db.promptStudio = normalizePromptStudioState({ ...state, productProfiles: [profile, ...state.productProfiles] });
    return db;
  });
  res.status(201).json(profile);
});

app.patch("/api/prompt-studio/product-profiles/:id", async (req, res) => {
  const parsed = promptProductProfilePatchSchema.parse(req.body || {});
  let profile = null;
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.productProfiles.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("产品档案不存在或已删除。"), { status: 404, code: "PROMPT_PRODUCT_PROFILE_NOT_FOUND" });
    }
    const updatedAt = new Date().toISOString();
    db.promptStudio = normalizePromptStudioState({
      ...state,
      productProfiles: state.productProfiles.map((item) => {
        if (item.id !== req.params.id) return item;
        profile = { ...item, ...parsed, updatedAt };
        return profile;
      }),
    });
    return db;
  });
  res.json(profile);
});

app.delete("/api/prompt-studio/product-profiles/:id", async (req, res) => {
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.productProfiles.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("产品档案不存在或已删除。"), { status: 404, code: "PROMPT_PRODUCT_PROFILE_NOT_FOUND" });
    }
    db.promptStudio = normalizePromptStudioState({ ...state, productProfiles: state.productProfiles.filter((item) => item.id !== req.params.id) });
    return db;
  });
  res.status(204).end();
});

app.post("/api/prompt-studio/style-presets", async (req, res) => {
  const parsed = promptStylePresetSchema.parse(req.body || {});
  const preset = { id: newId("prompt_style"), ...parsed, updatedAt: new Date().toISOString() };
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    db.promptStudio = normalizePromptStudioState({ ...state, stylePresets: [preset, ...state.stylePresets] });
    return db;
  });
  res.status(201).json(preset);
});

app.patch("/api/prompt-studio/style-presets/:id", async (req, res) => {
  const parsed = promptStylePresetPatchSchema.parse(req.body || {});
  let preset = null;
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.stylePresets.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("风格方案不存在或已删除。"), { status: 404, code: "PROMPT_STYLE_PRESET_NOT_FOUND" });
    }
    const updatedAt = new Date().toISOString();
    db.promptStudio = normalizePromptStudioState({
      ...state,
      stylePresets: state.stylePresets.map((item) => {
        if (item.id !== req.params.id) return item;
        preset = { ...item, ...parsed, updatedAt };
        return preset;
      }),
    });
    return db;
  });
  res.json(preset);
});

app.delete("/api/prompt-studio/style-presets/:id", async (req, res) => {
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.stylePresets.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("风格方案不存在或已删除。"), { status: 404, code: "PROMPT_STYLE_PRESET_NOT_FOUND" });
    }
    db.promptStudio = normalizePromptStudioState({ ...state, stylePresets: state.stylePresets.filter((item) => item.id !== req.params.id) });
    return db;
  });
  res.status(204).end();
});

app.post("/api/prompt-studio/analyze-product", parsePromptStudioUpload, async (req, res) => {
  const input = promptStudioMultipartRequest(req);
  const productImages = req.files?.productImages || [];
  if (!productImages.length) throw Object.assign(new Error("请至少上传一张产品参考图。"), { status: 400, code: "PROMPT_PRODUCT_IMAGE_MISSING" });
  const db = await readDb();
  res.json(await analyzeProductImages(db.modelConfig, input, productImages));
});

function createPromptHistoryItem(input, result, selectedVariantKey = "safe") {
  const createdAt = result.createdAt || new Date().toISOString();
  const rawName = input.copy?.title || input.userRequest || "未命名提示词";
  return {
    id: newId("prompt"),
    name: String(rawName).trim().slice(0, 80) || "未命名提示词",
    category: input.category,
    request: input,
    variants: result.variants,
    riskChecks: result.riskChecks,
    selectedVariantKey,
    isFavorite: false,
    createdAt,
    model: result.model,
  };
}

async function savePromptHistory(input, result, selectedVariantKey = "safe") {
  const historyItem = createPromptHistoryItem(input, result, selectedVariantKey);
  await updateDb((current) => {
    const state = normalizePromptStudioState(current.promptStudio);
    current.promptStudio = normalizePromptStudioState({ ...state, records: [historyItem, ...state.records] });
    return current;
  });
  return { createdAt: historyItem.createdAt, historyItem };
}

function quickPromptFingerprint(input, productImages) {
  const { clientRequestId: _clientRequestId, ...request } = input;
  const hash = createHash("sha256").update(JSON.stringify({ pipelineVersion: QUICK_PROMPT_PIPELINE_VERSION, request }));
  for (const file of productImages) {
    hash.update("\0").update(String(file.mimetype || "")).update("\0").update(String(file.size || 0)).update("\0");
    hash.update(file.buffer);
  }
  return hash.digest("hex");
}

function quickPromptConflict() {
  return Object.assign(new Error("这个提示词请求 ID 已用于另一组内容，请重新提交。"), {
    status: 409,
    code: "PROMPT_REQUEST_ID_CONFLICT",
  });
}

function quickPromptFallbackWarning(error) {
  if (!(error instanceof ModelApiError)) return "";
  if (error.code === "MODEL_API_KEY_MISSING") return "未配置可用的提示词模型，已使用开放式本地保底生成可编辑版本；配置并检测文字模型后可获得完整 AI 创意策划。";
  if (error.status === 524) return "提示词通道上游响应超时（524），已改用本地规则生成可编辑版本；没有切换通道，也没有再次提交这次超时请求，请检查后继续生图。";
  if (error.code === "MODEL_API_TIMEOUT") return `提示词整理等待超过 ${Math.round(QUICK_PROMPT_STAGE_TIMEOUT_MS / 1_000)} 秒，已停止等待并改用本地规则生成可编辑版本；请检查后继续生图。`;
  if (error.code === "MODEL_API_NETWORK_ERROR") return "提示词通道连接异常，已在同一通道有限重试后改用本地规则生成可编辑版本；请检查后继续生图。";
  if ([502, 503, 504].includes(error.status)) return `提示词通道暂时不可用（${error.status}），已在同一通道有限重试后改用本地规则生成可编辑版本；请检查后继续生图。`;
  return "";
}

function quickPromptInterpretationError(error) {
  if (!(error instanceof ModelApiError)) return error;
  const cause = error.status === 524
    ? "提示词通道上游响应超时（524）"
    : error.code === "MODEL_API_TIMEOUT"
      ? `提示词理解等待超过 ${Math.round(QUICK_PROMPT_STAGE_TIMEOUT_MS / 1_000)} 秒，已停止等待`
      : error.code === "MODEL_API_NETWORK_ERROR"
        ? "提示词通道连接异常"
        : [502, 503, 504].includes(error.status)
          ? `提示词通道暂时不可用（${error.status}）`
          : "";
  if (!cause) return error;
  return new ModelApiError(`${cause}；参考图模式无法安全猜测产品事实，因此没有切换通道或伪造结果。输入和参考图均已保留，请稍后重试。`, {
    code: "PROMPT_UPSTREAM_TEMPORARY",
    status: 503,
  });
}

async function buildQuickPromptResponse(quickInput, productImages) {
  const db = await readDb();
  const configuredModel = resolveModelConfig(db.modelConfig).model;
  const requestKey = quickInput.clientRequestId || newId("prompt_upstream");
  const signal = AbortSignal.timeout(QUICK_PROMPT_TOTAL_TIMEOUT_MS);
  let interpreted;
  let interpretationWarning = "";
  try {
    interpreted = await interpretQuickPrompt(db.modelConfig, quickInput, {
      productImages,
      signal,
      timeoutMs: QUICK_PROMPT_STAGE_TIMEOUT_MS,
      idempotencyKey: `${requestKey}.interpret`,
    });
  } catch (error) {
    if (productImages.length || quickInput.creationMode === "product") {
      throw quickPromptInterpretationError(error);
    }
    interpretationWarning = quickPromptFallbackWarning(error);
    if (!interpretationWarning) throw error;
    interpreted = interpretQuickPromptLocally(quickInput);
  }
  let result;
  const warnings = [...interpreted.warnings, ...(interpretationWarning ? [interpretationWarning] : [])];
  try {
    result = await generatePromptSet(db.modelConfig, interpreted.input, {
      productImages,
      signal,
      timeoutMs: QUICK_PROMPT_STAGE_TIMEOUT_MS,
      idempotencyKey: `${requestKey}.generate`,
    });
  } catch (error) {
    const fallbackWarning = quickPromptFallbackWarning(error);
    if (!fallbackWarning) throw error;
    result = generatePromptSetLocally(interpreted.input, {
      configuredModel,
      productImageCount: productImages.length,
    });
    warnings.push(fallbackWarning);
  }
  const selectedVariantKey = interpreted.recommendedVariantKey || "safe";
  const historyItem = quickInput.saveHistory
    ? createPromptHistoryItem(interpreted.input, result, selectedVariantKey)
    : null;
  const response = {
    ...result,
    ...(historyItem ? { createdAt: historyItem.createdAt, id: historyItem.id, historyItem } : {}),
    request: interpreted.input,
    interpretedRequest: interpreted.input,
    warnings,
    recommendedVariantKey: selectedVariantKey,
  };
  return { historyItem, response };
}

async function persistQuickPromptResponse({ id, fingerprint, response, historyItem }) {
  await updateDb((current) => {
    const state = normalizePromptStudioState(current.promptStudio);
    const existing = id ? state.quickRequests.find((entry) => entry.id === id) : null;
    if (existing?.pipelineVersion === QUICK_PROMPT_PIPELINE_VERSION && existing.fingerprint !== fingerprint) throw quickPromptConflict();
    if (existing?.pipelineVersion === QUICK_PROMPT_PIPELINE_VERSION) return current;
    current.promptStudio = normalizePromptStudioState({
      ...state,
      records: historyItem ? [historyItem, ...state.records] : state.records,
      quickRequests: id
        ? [{ id, fingerprint, response, createdAt: new Date().toISOString(), pipelineVersion: QUICK_PROMPT_PIPELINE_VERSION }, ...state.quickRequests.filter((entry) => entry.id !== id)]
        : state.quickRequests,
    });
    return current;
  });
}

async function runQuickPromptRequest(quickInput, productImages) {
  const id = quickInput.clientRequestId;
  if (!id) {
    const produced = await buildQuickPromptResponse(quickInput, productImages);
    if (produced.historyItem) await persistQuickPromptResponse({ fingerprint: "", ...produced });
    return produced.response;
  }

  const fingerprint = quickPromptFingerprint(quickInput, productImages);
  const running = pendingQuickPromptRequests.get(id);
  if (running) {
    if (running.fingerprint !== fingerprint) throw quickPromptConflict();
    return running.promise;
  }

  const promise = (async () => {
    const state = normalizePromptStudioState((await readDb()).promptStudio);
    const cached = state.quickRequests.find((entry) => entry.id === id);
    if (cached?.pipelineVersion === QUICK_PROMPT_PIPELINE_VERSION) {
      if (cached.fingerprint !== fingerprint) throw quickPromptConflict();
      return cached.response;
    }
    const produced = await buildQuickPromptResponse(quickInput, productImages);
    await persistQuickPromptResponse({ id, fingerprint, ...produced });
    return produced.response;
  })();
  pendingQuickPromptRequests.set(id, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (pendingQuickPromptRequests.get(id)?.promise === promise) pendingQuickPromptRequests.delete(id);
  }
}

app.post("/api/prompt-studio/quick-generate", parsePromptStudioUpload, async (req, res) => {
  const quickInput = validateQuickPromptInput(promptStudioMultipartRequest(req));
  const productImages = req.files?.productImages || [];
  res.json(await runQuickPromptRequest(quickInput, productImages));
});

app.post("/api/prompt-studio/enhance", parsePromptStudioUpload, async (req, res) => {
  const input = validateQuickPromptInput(promptStudioMultipartRequest(req));
  const db = await readDb();
  res.json(await writeFreeformImagePrompt(db.modelConfig, input, {
    productImages: req.files?.productImages || [],
    idempotencyKey: input.clientRequestId || "",
  }));
});

app.post("/api/prompt-studio/generate", parsePromptStudioUpload, async (req, res) => {
  const input = validatePromptStudioInput(promptStudioMultipartRequest(req));
  const db = await readDb();
  const result = await generatePromptSet(db.modelConfig, input, {
    productImages: req.files?.productImages || [],
    styleImages: req.files?.styleImages || [],
  });
  const selectedVariantKey = result.recommendedVariantKey || "safe";
  const saved = await savePromptHistory(input, result, selectedVariantKey);
  res.json({ ...result, ...saved, id: saved.historyItem.id, historyItem: saved.historyItem });
});

app.patch("/api/prompt-studio/history/:id", async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    isFavorite: z.boolean().optional(),
    selectedVariantKey: z.enum(["safe", "commercial", "creative"]).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "请选择要更新的提示词字段。").parse(req.body || {});
  let record = null;
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.records.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("提示词历史不存在或已删除。"), { status: 404, code: "PROMPT_HISTORY_NOT_FOUND" });
    }
    db.promptStudio = normalizePromptStudioState({
      ...state,
      records: state.records.map((item) => {
        if (item.id !== req.params.id) return item;
        record = { ...item, ...parsed };
        return record;
      }),
    });
    return db;
  });
  res.json(record);
});

app.delete("/api/prompt-studio/history/:id", async (req, res) => {
  await updateDb((db) => {
    const state = normalizePromptStudioState(db.promptStudio);
    if (!state.records.some((item) => item.id === req.params.id)) {
      throw Object.assign(new Error("提示词历史不存在或已删除。"), { status: 404, code: "PROMPT_HISTORY_NOT_FOUND" });
    }
    db.promptStudio = normalizePromptStudioState({ ...state, records: state.records.filter((item) => item.id !== req.params.id) });
    return db;
  });
  res.status(204).end();
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

app.post("/api/model-config/models", async (req, res) => {
  const schema = z.object({
    channel: z.enum(MODEL_CHANNEL_IDS).optional(),
    customBaseUrl: z.string().trim().min(1).max(500).optional(),
    apiKey: z.string().max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
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
  res.json(await discoverAvailableModels(draft));
});

app.post("/api/model-config/test", async (req, res) => {
  const schema = z.object({
    target: z.enum(["image", "prompt"]).optional().default("image"),
    channel: z.enum(MODEL_CHANNEL_IDS).optional(),
    customBaseUrl: z.string().trim().min(1).max(500).optional(),
    baseUrl: z.string().trim().min(1).max(500).optional(),
    apiKey: z.string().max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    imageModel: z.string().trim().min(1).max(200).optional(),
  }).strict();
  const parsed = schema.parse(req.body || {});
  const { target, ...configPatch } = parsed;
  const db = await readDb();
  let draft;
  try {
    draft = updateModelConfig(db.modelConfig, configPatch);
  } catch (error) {
    throw new ModelApiError(error.message || "模型配置无效。", { code: "MODEL_CONFIG_INVALID", status: 400 });
  }
  const started = Date.now();
  try {
    const result = target === "prompt" ? await testPromptModel(draft) : await testImageModel(draft);
    const tested = resolveModelConfig(draft);
    let testingStoredConfig = false;
    try {
      const stored = resolveModelConfig(db.modelConfig, { channel: tested.channel });
      const sameModel = target === "prompt" ? stored.model === tested.model : stored.imageModel === tested.imageModel;
      testingStoredConfig = !String(configPatch.apiKey || "").trim() && stored.baseUrl === tested.baseUrl && sameModel;
    } catch {
      testingStoredConfig = false;
    }
    if (testingStoredConfig) await updateDb((current) => {
      current.modelConfig = recordModelTestResult(current.modelConfig, { channel: tested.channel, target, status: result.status, testedAt: result.testedAt });
      return current;
    });
    res.json({
      ok: result.ok,
      status: result.status,
      target,
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
      const sameModel = target === "prompt" ? stored.model === tested.model : stored.imageModel === tested.imageModel;
      testingStoredConfig = !String(configPatch.apiKey || "").trim() && stored.baseUrl === tested.baseUrl && sameModel;
    } catch {
      testingStoredConfig = false;
    }
    if (testingStoredConfig) await updateDb((current) => {
      current.modelConfig = recordModelTestResult(current.modelConfig, { channel: tested.channel, target, status: "failed" });
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
  const releaseDisconnectedLegacyRequest = () => { imageGenerationActive = false; };
  req.once("aborted", releaseDisconnectedLegacyRequest);
  try {
    const parsed = parseImageGenerationRequest(req.body, { multipart: Boolean(req.is("multipart/form-data")) });
    const referenceImages = Array.isArray(req.files?.referenceImages) ? req.files.referenceImages : [];
    const maskImage = Array.isArray(req.files?.maskImage) ? req.files.maskImage[0] : null;
    const job = await enqueueImageJob(parsed, { referenceImages, maskImage });
    const result = await waitForImageJob(job.id, { onExecutionSettled: releaseDisconnectedLegacyRequest });
    if (!res.destroyed) res.json(result);
  } finally {
    req.off("aborted", releaseDisconnectedLegacyRequest);
    imageGenerationActive = false;
  }
});

app.post("/api/image-jobs", parseImageGenerationUpload, async (req, res) => {
  const parsed = parseImageGenerationRequest(req.body, { multipart: Boolean(req.is("multipart/form-data")) });
  const referenceImages = Array.isArray(req.files?.referenceImages) ? req.files.referenceImages : [];
  const maskImage = Array.isArray(req.files?.maskImage) ? req.files.maskImage[0] : null;
  res.status(202).json(await enqueueImageJob(parsed, { referenceImages, maskImage }));
});

app.get("/api/image-jobs", async (_req, res) => {
  res.json(await listImageJobs());
});

app.get("/api/image-jobs/:id", async (req, res) => {
  res.json(await getImageJob(req.params.id));
});

app.post("/api/image-jobs/:id/retry", async (req, res) => {
  res.status(202).json(await retryImageJob(req.params.id));
});

app.delete("/api/image-jobs/:id", async (req, res) => {
  res.json(await cancelImageJob(req.params.id));
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
    ...(Array.isArray(db.pendingAuthScans) ? db.pendingAuthScans.map((scan) => scan.browserPort) : []),
    ...Array.from(pendingScans.values(), (scan) => scan.browserPort),
    ...pendingBrowserPorts,
  ].filter(Boolean));
  pendingBrowserPorts.add(browserPort);
  try {
    const login = await openTaobaoLogin({ profileKey, port: browserPort });
    await rememberPendingScan({ ...parsed, profileKey, browserPort, loginTargetId: login.targetId, createdAt: Date.now() });
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
  await resetTmallSession({ profileKey: session.browserProfileKey, port: session.browserPort });
  const login = await openTmallLogin({ profileKey: session.browserProfileKey, port: session.browserPort });
  await rememberPendingScan({
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
  const data = await readDb();
  const pending = pendingScans.get(profileKey)
    || (Array.isArray(data.pendingAuthScans) ? data.pendingAuthScans.find((scan) => scan.profileKey === profileKey) : null);
  const existing = data.authSessions.find((session) => session.browserProfileKey === profileKey);
  if (!pending) return existing ? { status: "synced", session: existing } : { status: "expired" };
  if (existing && !pending.sessionId) {
    await forgetPendingScan(profileKey);
    return { status: "synced", session: existing };
  }
  pendingScans.set(profileKey, pending);
  const authState = await getTaobaoAuthState({ profileKey: pending.profileKey, port: pending.browserPort });
  if (authState.browserClosed) {
    await forgetPendingScan(profileKey);
    return { status: "cancelled" };
  }
  const loginTarget = authState.targets?.find((target) => target.id === pending.loginTargetId);
  if (loginTarget && isTaobaoLoginUrl(loginTarget.url)) return { status: "waiting" };
  if (!authState.loggedIn || !authState.cookie) {
    if (!loginTarget) {
      await forgetPendingScan(profileKey);
      return { status: "cancelled" };
    }
    return { status: "waiting" };
  }

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
          // Reauthorizing clears the Tmall session. Do not claim price access
          // until a real product response has been captured and parsed from
          // the sanitized local evidence file.
          tmallPriceStatus: TMALL_PRICE_STATUS.UNKNOWN,
          tmallPriceCheckedAt: null,
          tmallPriceCooldownUntil: null,
          tmallPriceDeviceCooldownUntil: null,
          tmallPriceLastFailureAt: null,
          tmallPriceFailureReason: null,
          tmallPriceFailureCount: 0,
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
        tmallPriceStatus: TMALL_PRICE_STATUS.UNKNOWN,
        tmallPriceCheckedAt: null,
        tmallPriceCooldownUntil: null,
        tmallPriceDeviceCooldownUntil: null,
        tmallPriceLastFailureAt: null,
        tmallPriceFailureReason: null,
        tmallPriceFailureCount: 0,
        lastCheckedAt: new Date().toISOString(),
        healthStatus: "healthy",
        createdAt: new Date().toISOString(),
      };
      db.authSessions.unshift(session);
    }
    db.pendingAuthScans = (Array.isArray(db.pendingAuthScans) ? db.pendingAuthScans : []).filter((item) => item.profileKey !== profileKey);
    return db;
  });
  pendingScans.delete(profileKey);
  await minimizeAccountBrowser({ profileKey: pending.profileKey, port: pending.browserPort }).catch((error) => console.error("[browser-minimize]", error.message));
  await resumeAuthRequiredCaptureJobs();
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
  const tmallPriceStatus = status === "expired"
    ? TMALL_PRICE_STATUS.UNKNOWN
    : session.tmallPriceStatus === TMALL_PRICE_STATUS.COOLDOWN
      ? TMALL_PRICE_STATUS.UNKNOWN
      : session.tmallPriceStatus || TMALL_PRICE_STATUS.UNKNOWN;
  let updated;
  await updateDb((db) => {
    db.authSessions = db.authSessions.map((item) => {
      if (item.id !== session.id) return item;
      updated = {
        ...item,
        cookie: status === "valid" ? state.cookie : item.cookie,
        loginStatus,
        tmallPriceStatus,
        ...(status === "expired" ? {
          tmallPriceCheckedAt: null,
          tmallPriceCooldownUntil: null,
          tmallPriceDeviceCooldownUntil: null,
        } : {}),
        lastCheckedAt: checkedAt,
        healthStatus: status === "valid" ? "healthy" : "degraded",
        consecutiveFailures: status === "valid" && tmallPriceStatus === TMALL_PRICE_STATUS.VALID ? 0 : item.consecutiveFailures,
      };
      return updated;
    });
    return db;
  });
  const message = status === "valid"
    ? tmallPriceStatus === TMALL_PRICE_STATUS.VALID
      ? "淘宝登录有效；天猫价格能力已通过真实商品价格响应验证。"
      : "淘宝登录有效；天猫价格能力尚未验证，需通过真实商品价格响应确认。"
    : status === "expired"
      ? "登录已明确失效，请重新授权。"
      : "账号浏览器仍保留，检测页面暂时异常；本次仅标记为待复检，不会清除登录状态。";
  return { id: session.id, status, loginStatus, tmallPriceStatus, checkedAt, message, session: publicAuthSession(updated) };
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
  const data = await readDb();
  const pending = pendingScans.get(parsed.profileKey)
    || (Array.isArray(data.pendingAuthScans) ? data.pendingAuthScans.find((scan) => scan.profileKey === parsed.profileKey) : null);
  if (pending) {
    await forgetPendingScan(parsed.profileKey);
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
  await resumeAuthRequiredCaptureJobs();
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
  if (activated.enabled) await resumeAuthRequiredCaptureJobs();
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
          billionPrice: sku.billionPrice,
          seckillPrice: sku.seckillPrice,
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
  if (!isAllowedMediaHost(url)) {
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
    await recoverCaptureQueue();
    startScheduler();
    schedulerStarted = true;
  }
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(port, host, () => resolve(instance));
      instance.once("error", reject);
    });
    await startImageJobQueue();
    startNotificationOutboxWorker();
    startEvidenceCleanup();
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    await stopImageJobQueue().catch((stopError) => console.error("[image-job-stop]", stopError));
    await stopNotificationOutboxWorker();
    stopEvidenceCleanup();
    stopCaptureQueue();
    stopScheduler();
    schedulerStarted = false;
    throw error;
  }
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
  stopCaptureQueue();
  stopScheduler();
  await stopNotificationOutboxWorker();
  stopEvidenceCleanup();
  schedulerStarted = false;
  const closeServer = server?.listening
    ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    : Promise.resolve();
  let queueError = null;
  try {
    await stopImageJobQueue();
  } catch (error) {
    queueError = error;
  }
  await closeServer;
  if (queueError) throw queueError;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error("[startup]", error);
    process.exitCode = 1;
  });
}
