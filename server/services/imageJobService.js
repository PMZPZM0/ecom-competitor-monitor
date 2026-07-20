import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dbRuntimeInfo, readDb } from "../storage/db.js";
import { deleteGeneratedImage, generateImages, readGeneratedImageFile, saveGeneratedImages } from "./imageGenerationService.js";

const MANIFEST_VERSION = 1;
const MAX_JOBS = 100;
const JOB_ID_PATTERN = /^image_job_[a-z0-9]{20,64}$/;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const ALLOWED_MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export const imageGenerationRequestSchema = z.object({
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
  clientRequestId: z.string().uuid("生图请求幂等 ID 无效。").optional(),
});

function jobError(message, { code = "IMAGE_JOB_INVALID", status = 400, retryable } = {}) {
  return Object.assign(new Error(message), { code, status, ...(retryable === undefined ? {} : { retryable }) });
}

export function parseImageGenerationRequest(body, { multipart = false } = {}) {
  let requestBody = body;
  if (multipart) {
    try {
      requestBody = JSON.parse(String(body?.request || ""));
    } catch {
      throw jobError("参考图生图请求缺少有效的 request JSON 字段。", {
        code: "IMAGE_MULTIPART_REQUEST_INVALID",
      });
    }
  }
  return imageGenerationRequestSchema.parse(requestBody);
}

function queuePaths() {
  const directory = path.join(dbRuntimeInfo().dataDir, "image-jobs");
  return {
    directory,
    inputs: path.join(directory, "inputs"),
    completions: path.join(directory, "completions"),
    manifest: path.join(directory, "manifest.json"),
  };
}

async function atomicWriteFile(destination, data) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, destination);
        break;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isoOrNull(value) {
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeStoredFile(file, fallbackName) {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  if (!file || !ALLOWED_MIME_TYPES.has(mimetype)) return null;
  const extension = ALLOWED_MIME_TYPES.get(mimetype);
  const filename = String(file.filename || fallbackName || "");
  if (!new RegExp(`^[a-z0-9-]+\\.${extension}$`).test(filename)) return null;
  return {
    filename,
    mimetype,
    originalname: path.basename(String(file.originalname || filename)).slice(0, 200),
    size: Math.max(0, Number(file.size) || 0),
  };
}

function normalizeStoredJob(job) {
  if (!job || !JOB_ID_PATTERN.test(String(job.id || ""))) return null;
  const parsedRequest = imageGenerationRequestSchema.safeParse(job.request);
  if (!parsedRequest.success) return null;
  const status = ["queued", "running", "saving", "succeeded", "failed", "cancelled"].includes(job.status)
    ? job.status
    : "failed";
  const references = (Array.isArray(job.files?.references) ? job.files.references : [])
    .map((file, index) => normalizeStoredFile(file, `reference-${index + 1}.png`))
    .filter(Boolean);
  const mask = normalizeStoredFile(job.files?.mask, "mask.png");
  const source = normalizeStoredFile(job.files?.source, "source.png");
  const createdAt = isoOrNull(job.createdAt) || new Date(0).toISOString();
  return {
    id: job.id,
    status,
    createdAt,
    queuedAt: isoOrNull(job.queuedAt) || createdAt,
    updatedAt: isoOrNull(job.updatedAt) || createdAt,
    startedAt: isoOrNull(job.startedAt),
    completedAt: isoOrNull(job.completedAt),
    attempt: Math.max(0, Number(job.attempt) || 0),
    request: parsedRequest.data,
    payloadFingerprint: /^[a-f0-9]{64}$/.test(String(job.payloadFingerprint || "")) ? job.payloadFingerprint : null,
    files: { references, mask, source },
    result: job.result && typeof job.result === "object" ? job.result : null,
    error: job.error && typeof job.error === "object"
      ? {
          code: String(job.error.code || "IMAGE_JOB_FAILED").slice(0, 100),
          message: String(job.error.message || "图片生成失败。").slice(0, 1_000),
          retryable: job.error.retryable !== false,
        }
      : null,
  };
}

async function readManifest() {
  const paths = queuePaths();
  await Promise.all([fs.mkdir(paths.inputs, { recursive: true }), fs.mkdir(paths.completions, { recursive: true })]);
  try {
    const parsed = JSON.parse(await fs.readFile(paths.manifest, "utf8"));
    return {
      version: MANIFEST_VERSION,
      jobs: (Array.isArray(parsed?.jobs) ? parsed.jobs : []).map(normalizeStoredJob).filter(Boolean),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: MANIFEST_VERSION, jobs: [] };
    if (error instanceof SyntaxError) {
      throw jobError("AI 生图任务队列索引损坏，请备份 image-jobs 目录后重试。", {
        code: "IMAGE_JOB_MANIFEST_CORRUPT",
        status: 500,
      });
    }
    throw error;
  }
}

async function writeManifest(manifest) {
  const paths = queuePaths();
  await Promise.all([fs.mkdir(paths.inputs, { recursive: true }), fs.mkdir(paths.completions, { recursive: true })]);
  await atomicWriteFile(paths.manifest, JSON.stringify({ version: MANIFEST_VERSION, jobs: manifest.jobs }, null, 2));
}

function completionReceiptPath(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) throw jobError("生图任务 ID 无效。", { code: "IMAGE_JOB_ID_INVALID" });
  return path.join(queuePaths().completions, `${jobId}.json`);
}

async function writeCompletionReceipt(jobId, receipt) {
  await fs.mkdir(queuePaths().completions, { recursive: true });
  await atomicWriteFile(completionReceiptPath(jobId), JSON.stringify({ version: 1, jobId, ...receipt }, null, 2));
}

async function readCompletionReceipt(jobId) {
  try {
    const parsed = JSON.parse(await fs.readFile(completionReceiptPath(jobId), "utf8"));
    if (parsed?.jobId !== jobId || !["saving", "succeeded"].includes(parsed?.phase)) return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeCompletionReceipt(jobId) {
  await fs.unlink(completionReceiptPath(jobId)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function cleanupQueueArtifacts(state) {
  const paths = queuePaths();
  const jobsById = new Map(state.jobs.map((job) => [job.id, job]));
  const inputEntries = await fs.readdir(paths.inputs, { withFileTypes: true }).catch(() => []);
  await Promise.all(inputEntries
    .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
    .filter((entry) => !jobsById.has(entry.name) || jobsById.get(entry.name).status === "succeeded")
    .map((entry) => fs.rm(path.join(paths.inputs, entry.name), { recursive: true, force: true })));
  const receiptEntries = await fs.readdir(paths.completions, { withFileTypes: true }).catch(() => []);
  await Promise.all(receiptEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => {
      const jobId = entry.name.slice(0, -5);
      return JOB_ID_PATTERN.test(jobId) && !jobsById.has(jobId);
    })
    .map((entry) => fs.unlink(path.join(paths.completions, entry.name)).catch(() => undefined)));
}

let manifest = null;
let stateMutation = Promise.resolve();
let queueActive = false;
let queueEpoch = 0;
let workerPromise = null;
let workerRetryTimer = null;
let workerFailureCount = 0;
let currentExecution = null;
const pendingFinalizations = new Map();
const executionSettledJobs = new Set();
const executionSettledListeners = new Map();

function notifyExecutionSettled(jobId) {
  executionSettledJobs.add(jobId);
  while (executionSettledJobs.size > 200) executionSettledJobs.delete(executionSettledJobs.values().next().value);
  for (const listener of executionSettledListeners.get(jobId) || []) listener();
  executionSettledListeners.delete(jobId);
}

function mutateState(operation) {
  const next = stateMutation.then(async () => {
    if (!manifest) manifest = await readManifest();
    return operation(manifest);
  });
  stateMutation = next.then(() => undefined, () => undefined);
  return next;
}

function commitState(operation) {
  const next = stateMutation.then(async () => {
    if (!manifest) manifest = await readManifest();
    const draft = structuredClone(manifest);
    const result = await operation(draft);
    await writeManifest(draft);
    manifest = draft;
    return result;
  });
  stateMutation = next.then(() => undefined, () => undefined);
  return next;
}

function reloadAndCommitState(operation) {
  const next = stateMutation.then(async () => {
    const draft = structuredClone(await readManifest());
    const result = await operation(draft);
    await writeManifest(draft);
    manifest = draft;
    return result;
  });
  stateMutation = next.then(() => undefined, () => undefined);
  return next;
}

function inputDirectory(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) throw jobError("生图任务 ID 无效。", { code: "IMAGE_JOB_ID_INVALID" });
  return path.join(queuePaths().inputs, jobId);
}

async function removeInputDirectory(jobId) {
  await fs.rm(inputDirectory(jobId), { recursive: true, force: true });
}

async function persistInputFiles(jobId, { referenceImages = [], maskImage = null, sourceImage = null } = {}) {
  const directory = inputDirectory(jobId);
  await fs.mkdir(directory, { recursive: true });
  const references = [];
  try {
    for (const [index, file] of referenceImages.entries()) {
      const mimetype = String(file?.mimetype || "").toLowerCase();
      const extension = ALLOWED_MIME_TYPES.get(mimetype);
      if (!extension || !Buffer.isBuffer(file?.buffer)) {
        throw jobError("参考图只支持 PNG、JPEG 或 WEBP。", { code: "IMAGE_REFERENCE_TYPE_INVALID" });
      }
      const filename = `reference-${index + 1}.${extension}`;
      await atomicWriteFile(path.join(directory, filename), file.buffer);
      references.push({
        filename,
        mimetype,
        originalname: path.basename(String(file.originalname || filename)).slice(0, 200),
        size: file.buffer.byteLength,
      });
    }
    let source = null;
    if (sourceImage) {
      const mimetype = String(sourceImage.mimetype || "").toLowerCase();
      const extension = ALLOWED_MIME_TYPES.get(mimetype);
      if (!extension || !Buffer.isBuffer(sourceImage.buffer)) {
        throw jobError("待编辑原图格式无效。", { code: "IMAGE_EDIT_SOURCE_INVALID" });
      }
      const filename = `source.${extension}`;
      await atomicWriteFile(path.join(directory, filename), sourceImage.buffer);
      source = {
        filename,
        mimetype,
        originalname: path.basename(String(sourceImage.originalname || filename)).slice(0, 200),
        size: sourceImage.buffer.byteLength,
      };
    }
    let mask = null;
    if (maskImage) {
      const mimetype = String(maskImage.mimetype || "").toLowerCase();
      const extension = ALLOWED_MIME_TYPES.get(mimetype);
      if (!extension || !Buffer.isBuffer(maskImage.buffer)) {
        throw jobError("批注蒙版只支持 PNG、JPEG 或 WEBP。", { code: "IMAGE_REFERENCE_TYPE_INVALID" });
      }
      const filename = `mask.${extension}`;
      await atomicWriteFile(path.join(directory, filename), maskImage.buffer);
      mask = {
        filename,
        mimetype,
        originalname: path.basename(String(maskImage.originalname || filename)).slice(0, 200),
        size: maskImage.buffer.byteLength,
      };
    }
    return { references, mask, source };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function loadInputFile(jobId, file) {
  if (!file) return null;
  const buffer = await fs.readFile(path.join(inputDirectory(jobId), file.filename));
  return {
    buffer,
    mimetype: file.mimetype,
    originalname: file.originalname,
    size: buffer.byteLength,
  };
}

async function loadJobInputs(job) {
  return {
    referenceImages: await Promise.all(job.files.references.map((file) => loadInputFile(job.id, file))),
    maskImage: await loadInputFile(job.id, job.files.mask),
    sourceImageOverride: await loadInputFile(job.id, job.files.source),
  };
}

function publicJob(job, jobs) {
  const publicStatus = job.status === "saving" ? "running" : job.status;
  const queued = jobs
    .filter((item) => item.status === "queued")
    .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
  const queueIndex = queued.findIndex((item) => item.id === job.id);
  const finishedAt = job.completedAt;
  const measuredDuration = job.startedAt
    ? Math.max(0, Date.parse(finishedAt || new Date().toISOString()) - Date.parse(job.startedAt))
    : null;
  const durationMs = Number.isFinite(job.result?.durationMs) ? job.result.durationMs : measuredDuration;
  const position = queueIndex >= 0 ? queueIndex + 1 : null;
  const message = job.status === "queued"
    ? `排队第 ${position} 位`
    : job.status === "running" || job.status === "saving"
      ? job.status === "saving" ? "模型已返回，正在保存生成结果" : "模型正在生成图片"
      : job.status === "succeeded"
        ? "图片生成完成"
        : job.status === "cancelled"
          ? job.error?.message || "任务已取消"
          : job.error?.message || "图片生成失败";
  return {
    id: job.id,
    status: publicStatus,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    finishedAt,
    attempt: job.attempt,
    request: job.request,
    clientRequestId: job.request.clientRequestId || null,
    referenceImageCount: job.files.references.length,
    maskApplied: Boolean(job.files.mask),
    queuePosition: position,
    position,
    durationMs,
    message,
    result: job.result,
    error: job.error,
  };
}

function publicJobs(jobs) {
  return [...jobs]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((job) => publicJob(job, jobs));
}

function normalizedFailure(error) {
  const aborted = error?.name === "AbortError" || error?.code === "ABORT_ERR";
  return {
    code: String(error?.code || (aborted ? "IMAGE_JOB_ABORTED" : "IMAGE_JOB_FAILED")).slice(0, 100),
    message: String(error?.message || (aborted ? "图片生成已取消。" : "图片生成失败。")).slice(0, 1_000),
    retryable: error?.retryable ?? error?.status !== 400,
  };
}

function imageJobPayloadFingerprint(request, { referenceImages = [], maskImage = null } = {}) {
  const hash = crypto.createHash("sha256");
  const { clientRequestId: _clientRequestId, ...generationRequest } = request;
  hash.update(JSON.stringify(generationRequest));
  for (const [index, file] of referenceImages.entries()) {
    hash.update(`\0reference:${index}:${String(file?.mimetype || "").toLowerCase()}\0`);
    if (Buffer.isBuffer(file?.buffer)) hash.update(file.buffer);
  }
  if (maskImage) {
    hash.update(`\0mask:${String(maskImage.mimetype || "").toLowerCase()}\0`);
    if (Buffer.isBuffer(maskImage.buffer)) hash.update(maskImage.buffer);
  }
  return hash.digest("hex");
}

function assertMatchingIdempotentPayload(existing, payloadFingerprint) {
  if (existing.payloadFingerprint && existing.payloadFingerprint !== payloadFingerprint) {
    throw jobError("相同的生图请求 ID 不能用于不同的提示词、参数或参考图。", {
      code: "IMAGE_JOB_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  }
}

async function pruneForNewJob(state) {
  const requiredSlots = state.jobs.length - MAX_JOBS + 1;
  if (requiredSlots <= 0) return [];
  const candidates = state.jobs
    .filter((job) => TERMINAL_STATUSES.has(job.status))
    .sort((left, right) => Date.parse(left.completedAt || left.updatedAt) - Date.parse(right.completedAt || right.updatedAt));
  if (candidates.length < requiredSlots) {
    throw jobError("生图队列已达到 100 个未完成任务，请等待部分任务结束后再提交。", {
      code: "IMAGE_JOB_QUEUE_FULL",
      status: 429,
    });
  }
  const removed = candidates.slice(0, requiredSlots).map((job) => job.id);
  const removedIds = new Set(removed);
  state.jobs = state.jobs.filter((job) => !removedIds.has(job.id));
  return removed;
}

export async function executeImageGeneration(request, {
  referenceImages = [],
  maskImage = null,
  sourceImageOverride = null,
  signal,
  shouldPersist = () => true,
  jobId = "",
  beforeSave,
  onImagesSaved,
} = {}) {
  const started = Date.now();
  if (!shouldPersist()) throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  const db = await readDb();
  if (!shouldPersist()) throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  const generated = await generateImages(db.modelConfig, request, { referenceImages, maskImage, sourceImageOverride, signal });
  if (!shouldPersist()) {
    throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  }
  if (beforeSave) {
    try {
      await beforeSave();
    } catch (error) {
      throw jobError("模型已经返回结果，但任务保存阶段无法落盘。为避免重复计费，请不要直接重试。", {
        code: "IMAGE_JOB_COMMIT_INTENT_FAILED",
        status: 500,
        retryable: false,
        cause: error,
      });
    }
  }
  if (!shouldPersist()) {
    throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  }
  if (jobId) {
    try {
      await writeCompletionReceipt(jobId, { phase: "saving", updatedAt: new Date().toISOString() });
    } catch {
      throw jobError("模型已经返回结果，但本地保存凭据写入失败。为避免重复计费，请不要直接重试。", {
        code: "IMAGE_JOB_COMMIT_INTENT_FAILED",
        status: 500,
        retryable: false,
      });
    }
  }
  const createdAt = new Date().toISOString();
  const images = await saveGeneratedImages(generated.images, {
    ...request,
    model: generated.model,
    createdAt,
    referenceImageCount: generated.appliedOptions.referenceImageCount,
    maskApplied: generated.appliedOptions.maskApplied,
  });
  onImagesSaved?.();
  const result = {
    images,
    model: generated.model,
    size: generated.size,
    durationMs: Date.now() - started,
    createdAt,
    warnings: generated.warnings,
    appliedOptions: generated.appliedOptions,
  };
  if (!shouldPersist()) {
    const cleanup = await Promise.allSettled(images.map((image) => deleteGeneratedImage(image.id)));
    cleanup.filter((result) => result.status === "rejected").forEach((result) => console.error("[image-job-cancel-cleanup]", result.reason));
    if (jobId) await removeCompletionReceipt(jobId).catch((error) => console.error("[image-job-cancel-cleanup]", error));
    throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  }
  if (jobId) {
    try {
      await writeCompletionReceipt(jobId, { phase: "succeeded", completedAt: new Date().toISOString(), result });
    } catch {
      throw jobError("图片已经生成并保存在历史中，但任务完成凭据写入失败。为避免重复计费，请不要直接重试。", {
        code: "IMAGE_JOB_COMPLETION_RECEIPT_FAILED",
        status: 500,
        retryable: false,
      });
    }
  }
  if (!shouldPersist()) {
    const cleanup = await Promise.allSettled(images.map((image) => deleteGeneratedImage(image.id)));
    cleanup.filter((entry) => entry.status === "rejected").forEach((entry) => console.error("[image-job-cancel-cleanup]", entry.reason));
    if (jobId) await removeCompletionReceipt(jobId).catch((error) => console.error("[image-job-cancel-cleanup]", error));
    throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
  }
  return result;
}

async function markJobSaving(jobId, epoch) {
  await commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "running" || !queueActive || epoch !== queueEpoch) {
      throw jobError("图片生成任务已取消。", { code: "IMAGE_JOB_CANCELLED", status: 409 });
    }
    job.status = "saving";
    job.updatedAt = new Date().toISOString();
  });
}

async function discardJobResult(jobId, result) {
  const images = Array.isArray(result?.images) ? result.images : [];
  const cleanup = await Promise.allSettled(images.map((image) => deleteGeneratedImage(image.id)));
  cleanup.filter((entry) => entry.status === "rejected").forEach((entry) => console.error("[image-job-cancel-cleanup]", entry.reason));
  await removeCompletionReceipt(jobId).catch((error) => console.error("[image-job-cancel-cleanup]", error));
}

async function claimNextJob(epoch) {
  return commitState(async (state) => {
    if (!queueActive || epoch !== queueEpoch) return null;
    const job = state.jobs
      .filter((item) => item.status === "queued")
      .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt))[0];
    if (!job) return null;
    const now = new Date().toISOString();
    job.status = "running";
    job.startedAt = now;
    job.completedAt = null;
    job.updatedAt = now;
    job.attempt += 1;
    job.error = null;
    return structuredClone(job);
  });
}

async function finishJob(jobId, epoch, result, error) {
  let cleanup = false;
  let discard = false;
  await commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (job?.status === "cancelled" && result) {
      discard = true;
      return;
    }
    if (!job || !["running", "saving"].includes(job.status)) return;
    if (!queueActive || epoch !== queueEpoch) {
      if (result && !error) {
        const completedAt = result.createdAt || new Date().toISOString();
        job.status = "succeeded";
        job.updatedAt = completedAt;
        job.completedAt = completedAt;
        job.result = result;
        job.error = null;
        cleanup = true;
      } else {
        markInterrupted(job, new Date().toISOString());
      }
      return;
    }
    const now = new Date().toISOString();
    const wasSaving = job.status === "saving";
    job.status = error ? "failed" : "succeeded";
    job.updatedAt = now;
    job.completedAt = now;
    job.result = error ? null : result;
    job.error = error
      ? wasSaving
        ? {
            code: "IMAGE_JOB_RESULT_UNKNOWN",
            message: "模型已经返回，但本地结果保存状态无法确认。为避免重复计费，此任务不能直接重试。",
            retryable: false,
          }
        : normalizedFailure(error)
      : null;
    cleanup = !error;
  });
  if (discard) await discardJobResult(jobId, result);
  if (cleanup) await removeInputDirectory(jobId).catch((error) => console.error("[image-job-cleanup]", error));
}

async function drainQueue(epoch) {
  await flushPendingFinalizations();
  await recoverActiveSucceededReceipts();
  while (queueActive && epoch === queueEpoch) {
    const job = await claimNextJob(epoch);
    if (!job) return;
    const controller = new AbortController();
    currentExecution = { jobId: job.id, controller, epoch, cancelled: false };
    let result = null;
    let executionError = null;
    let executionNotified = false;
    try {
      const inputs = await loadJobInputs(job);
      result = await executeImageGeneration(job.request, {
        ...inputs,
        signal: controller.signal,
        jobId: job.id,
        beforeSave: () => markJobSaving(job.id, epoch),
        onImagesSaved: () => {
          executionNotified = true;
          notifyExecutionSettled(job.id);
        },
        shouldPersist: () => queueActive
          && epoch === queueEpoch
          && currentExecution?.jobId === job.id
          && !currentExecution.cancelled
          && ["running", "saving"].includes(manifest?.jobs.find((item) => item.id === job.id)?.status),
      });
    } catch (error) {
      executionError = error;
    }
    if (!executionNotified) notifyExecutionSettled(job.id);
    pendingFinalizations.set(job.id, { epoch, result, error: executionError });
    try {
      await finishJob(job.id, epoch, result, executionError);
      pendingFinalizations.delete(job.id);
    } catch (error) {
      console.error("[image-job-finalize]", error);
      if (!executionError && currentExecution?.cancelled) {
        await discardJobResult(job.id, result);
        pendingFinalizations.delete(job.id);
      } else if (!executionError) {
        const recovered = await recoverSucceededReceipt(job.id);
        if (!recovered) throw error;
        pendingFinalizations.delete(job.id);
      } else {
        throw error;
      }
    } finally {
      if (currentExecution?.jobId === job.id && currentExecution?.epoch === epoch) currentExecution = null;
    }
  }
}

async function flushPendingFinalizations() {
  for (const [jobId, pending] of pendingFinalizations) {
    await flushPendingFinalization(jobId, pending);
  }
}

async function flushPendingFinalization(jobId, pending = pendingFinalizations.get(jobId)) {
  if (!pending) return false;
  await finishJob(jobId, pending.epoch, pending.result, pending.error);
  pendingFinalizations.delete(jobId);
  return true;
}

async function settleUnownedActiveJob(jobId) {
  if (currentExecution?.jobId === jobId) return false;
  return commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || !["running", "saving"].includes(job.status)) return false;
    markInterrupted(job, new Date().toISOString());
    return true;
  });
}

function scheduleWorker() {
  if (!queueActive || workerPromise || workerRetryTimer) return;
  const epoch = queueEpoch;
  queueMicrotask(() => {
    if (!queueActive || workerPromise || workerRetryTimer || epoch !== queueEpoch) return;
    let failed = false;
    workerPromise = drainQueue(epoch)
      .then(() => { workerFailureCount = 0; })
      .catch((error) => {
        failed = true;
        workerFailureCount += 1;
        console.error("[image-job-worker]", error);
        const delay = Math.min(30_000, 250 * (2 ** Math.min(workerFailureCount - 1, 7)));
        workerRetryTimer = setTimeout(() => {
          workerRetryTimer = null;
          scheduleWorker();
        }, delay);
        workerRetryTimer.unref?.();
      })
      .finally(() => {
        workerPromise = null;
        if (queueActive && !failed) {
          mutateState(async (state) => state.jobs.some((job) => job.status === "queued"))
            .then((hasQueued) => {
              if (hasQueued) scheduleWorker();
            })
            .catch((error) => console.error("[image-job-worker]", error));
        }
      });
  });
}

function markInterrupted(job, now) {
  const wasSaving = job.status === "saving";
  job.status = "failed";
  job.updatedAt = now;
  job.completedAt = now;
  job.error = {
    code: wasSaving ? "IMAGE_JOB_RESULT_UNKNOWN" : "IMAGE_JOB_INTERRUPTED",
    message: wasSaving
      ? "模型已返回，但本地结果状态未能确认。为避免重复计费，此任务不能直接重试；请先检查生成历史。"
      : "应用在图片生成过程中退出，结果状态未知。为避免重复计费，此任务不能直接重试；请先检查生成历史。",
    retryable: false,
  };
}

function applySucceededReceipt(job, receipt) {
  if (receipt?.phase !== "succeeded" || !receipt.result || typeof receipt.result !== "object") return false;
  const completedAt = isoOrNull(receipt.completedAt) || receipt.result.createdAt || new Date().toISOString();
  job.status = "succeeded";
  job.updatedAt = completedAt;
  job.completedAt = completedAt;
  job.result = receipt.result;
  job.error = null;
  return true;
}

async function recoverSucceededReceipt(jobId, { includeTerminal = false } = {}) {
  const receipt = await readCompletionReceipt(jobId);
  if (receipt?.phase !== "succeeded") return false;
  const imageRecords = Array.isArray(receipt.result?.images) ? receipt.result.images : [];
  if (!imageRecords.length) return false;
  const files = await Promise.allSettled(imageRecords.map((image) => readGeneratedImageFile(image.id)));
  if (files.some((file) => file.status === "rejected")) return false;
  const recovered = await commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    const recoverableStatuses = includeTerminal
      ? ["running", "saving", "failed", "cancelled"]
      : ["running", "saving"];
    if (!job || !recoverableStatuses.includes(job.status)) return false;
    return applySucceededReceipt(job, receipt);
  });
  if (recovered) {
    pendingFinalizations.delete(jobId);
    await removeInputDirectory(jobId).catch((error) => console.error("[image-job-cleanup]", error));
  }
  return recovered;
}

async function recoverActiveSucceededReceipts() {
  const activeIds = await mutateState(async (state) => state.jobs
    .filter((job) => ["running", "saving"].includes(job.status))
    .map((job) => job.id));
  const receipts = new Map();
  for (const jobId of activeIds) {
    const receipt = await readCompletionReceipt(jobId);
    if (receipt?.phase === "succeeded") receipts.set(jobId, receipt);
  }
  if (!receipts.size) return [];
  const recovered = await commitState(async (state) => {
    const ids = [];
    for (const job of state.jobs) {
      const receipt = receipts.get(job.id);
      if (receipt && ["running", "saving"].includes(job.status) && applySucceededReceipt(job, receipt)) ids.push(job.id);
    }
    return ids;
  });
  await Promise.all(recovered.map((id) => removeInputDirectory(id).catch((error) => console.error("[image-job-cleanup]", error))));
  return recovered;
}

async function recoverOrInterruptActiveJobs(state, now, { excludeRecoveryJobId = "" } = {}) {
  const recovered = [];
  for (const job of state.jobs) {
    if (!["running", "saving"].includes(job.status)) continue;
    const receipt = job.id === excludeRecoveryJobId ? null : await readCompletionReceipt(job.id);
    if (applySucceededReceipt(job, receipt)) recovered.push(job.id);
    else markInterrupted(job, now);
  }
  return recovered;
}

export async function startImageJobQueue() {
  if (queueActive) {
    scheduleWorker();
    return;
  }
  queueActive = true;
  queueEpoch += 1;
  const now = new Date().toISOString();
  let recovered;
  try {
    recovered = await reloadAndCommitState((state) => recoverOrInterruptActiveJobs(state, now));
  } catch (error) {
    queueActive = false;
    queueEpoch += 1;
    throw error;
  }
  await Promise.all(recovered.map((id) => removeInputDirectory(id).catch((error) => console.error("[image-job-cleanup]", error))));
  await cleanupQueueArtifacts(manifest).catch((error) => console.error("[image-job-cleanup]", error));
  scheduleWorker();
}

export async function stopImageJobQueue() {
  queueActive = false;
  queueEpoch += 1;
  if (workerRetryTimer) {
    clearTimeout(workerRetryTimer);
    workerRetryTimer = null;
  }
  workerFailureCount = 0;
  if (currentExecution) {
    currentExecution.cancelled = true;
    currentExecution.controller.abort();
  }
  const now = new Date().toISOString();
  if (workerPromise) {
    let shutdownTimer;
    try {
      await Promise.race([
        workerPromise,
        new Promise((resolve) => { shutdownTimer = setTimeout(resolve, 1_000); }),
      ]);
    } finally {
      clearTimeout(shutdownTimer);
    }
  }
  const ownedJobId = currentExecution?.jobId || "";
  const recovered = await commitState((state) => recoverOrInterruptActiveJobs(state, now, { excludeRecoveryJobId: ownedJobId }));
  await Promise.all(recovered.map((id) => removeInputDirectory(id).catch((error) => console.error("[image-job-cleanup]", error))));
  pendingFinalizations.clear();
}

export async function waitForImageJobQueueIdle({ timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeWorker = workerPromise;
    if (activeWorker) await activeWorker.catch(() => undefined);
    await stateMutation;

    // Let scheduleWorker's queued microtask and its final state read become visible.
    await new Promise((resolve) => setImmediate(resolve));
    await stateMutation;

    const hasActiveJobs = manifest?.jobs.some((job) => ["queued", "running", "saving"].includes(job.status));
    if (!workerPromise && !workerRetryTimer && !currentExecution && !hasActiveJobs) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the image job queue to become idle after ${timeoutMs}ms.`);
}

export async function enqueueImageJob(request, { referenceImages = [], maskImage = null } = {}) {
  if (!queueActive) {
    throw jobError("生图队列尚未启动或正在关闭，请稍后重试。", {
      code: "IMAGE_JOB_QUEUE_STOPPED",
      status: 503,
    });
  }
  const parsed = imageGenerationRequestSchema.parse(request);
  const payloadFingerprint = imageJobPayloadFingerprint(parsed, { referenceImages, maskImage });
  if (parsed.clientRequestId) {
    const existing = await mutateState(async (state) => state.jobs.find((job) => job.request.clientRequestId === parsed.clientRequestId));
    if (existing) {
      assertMatchingIdempotentPayload(existing, payloadFingerprint);
      return publicJob(existing, manifest.jobs);
    }
  }
  let sourceImage = null;
  if (parsed.sourceImageId) {
    const source = await readGeneratedImageFile(parsed.sourceImageId);
    sourceImage = {
      buffer: source.buffer,
      mimetype: source.record.mimeType,
      originalname: `source.${source.record.format === "jpeg" ? "jpg" : source.record.format}`,
    };
  }
  const jobId = `image_job_${crypto.randomUUID().replaceAll("-", "")}`;
  const files = await persistInputFiles(jobId, { referenceImages, maskImage, sourceImage });
  let removed = [];
  let deduplicated = false;
  try {
    const created = await commitState(async (state) => {
      const existing = parsed.clientRequestId
        ? state.jobs.find((job) => job.request.clientRequestId === parsed.clientRequestId)
        : null;
      if (existing) {
        assertMatchingIdempotentPayload(existing, payloadFingerprint);
        deduplicated = true;
        return publicJob(existing, state.jobs);
      }
      removed = await pruneForNewJob(state);
      const now = new Date().toISOString();
      const job = {
        id: jobId,
        status: "queued",
        createdAt: now,
        queuedAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        attempt: 0,
        request: parsed,
        payloadFingerprint,
        files,
        result: null,
        error: null,
      };
      state.jobs.push(job);
      return publicJob(job, state.jobs);
    });
    if (deduplicated) await removeInputDirectory(jobId).catch(() => undefined);
    await Promise.all(removed.flatMap((id) => [
      removeInputDirectory(id).catch(() => undefined),
      removeCompletionReceipt(id).catch(() => undefined),
    ]));
    if (!deduplicated) scheduleWorker();
    return created;
  } catch (error) {
    await removeInputDirectory(jobId).catch(() => undefined);
    throw error;
  }
}

export async function listImageJobs() {
  return mutateState(async (state) => publicJobs(state.jobs));
}

export async function getImageJob(id) {
  return mutateState(async (state) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw jobError("没有找到这个生图任务。", { code: "IMAGE_JOB_NOT_FOUND", status: 404 });
    return publicJob(job, state.jobs);
  });
}

export async function waitForImageJob(id, { pollMs = 25, onExecutionSettled } = {}) {
  if (onExecutionSettled) {
    if (executionSettledJobs.has(id)) onExecutionSettled();
    else executionSettledListeners.set(id, new Set([...(executionSettledListeners.get(id) || []), onExecutionSettled]));
  }
  try {
    for (;;) {
      const job = await getImageJob(id);
      if (job.status === "succeeded" && job.result) return job.result;
      if (job.status === "failed") {
        throw jobError(job.error?.message || "图片生成失败。", {
          code: job.error?.code || "IMAGE_JOB_FAILED",
          status: 502,
          retryable: job.error?.retryable,
        });
      }
      if (job.status === "cancelled") {
        throw jobError(job.error?.message || "图片生成任务已取消。", {
          code: job.error?.code || "IMAGE_JOB_CANCELLED",
          status: 409,
          retryable: job.error?.retryable !== false,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    executionSettledJobs.delete(id);
    const listeners = executionSettledListeners.get(id);
    listeners?.delete(onExecutionSettled);
    if (!listeners?.size) executionSettledListeners.delete(id);
  }
}

export async function retryImageJob(id) {
  if (JOB_ID_PATTERN.test(id)) await flushPendingFinalization(id);
  if (JOB_ID_PATTERN.test(id) && currentExecution?.jobId !== id && await recoverSucceededReceipt(id, { includeTerminal: true })) {
    throw jobError("任务实际上已经生成完成，不能再次重试。", { code: "IMAGE_JOB_ALREADY_COMPLETED", status: 409 });
  }
  const retried = await commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw jobError("没有找到这个生图任务。", { code: "IMAGE_JOB_NOT_FOUND", status: 404 });
    if (!["failed", "cancelled"].includes(job.status)) {
      throw jobError("只有失败或已取消的任务可以重试。", { code: "IMAGE_JOB_NOT_RETRYABLE", status: 409 });
    }
    if (job.error?.retryable === false) {
      throw jobError("此任务结果状态无法确认，为避免重复计费不能直接重试。请先检查生成历史。", {
        code: "IMAGE_JOB_RETRY_UNSAFE",
        status: 409,
      });
    }
    const now = new Date().toISOString();
    job.status = "queued";
    job.queuedAt = now;
    job.updatedAt = now;
    job.startedAt = null;
    job.completedAt = null;
    job.result = null;
    job.error = null;
    return publicJob(job, state.jobs);
  });
  scheduleWorker();
  return retried;
}

export async function cancelImageJob(id) {
  if (JOB_ID_PATTERN.test(id)) await flushPendingFinalization(id);
  if (JOB_ID_PATTERN.test(id) && currentExecution?.jobId !== id && await recoverSucceededReceipt(id, { includeTerminal: true })) {
    throw jobError("任务实际上已经生成完成，不能取消已保存的结果。", { code: "IMAGE_JOB_ALREADY_COMPLETED", status: 409 });
  }
  if (JOB_ID_PATTERN.test(id) && await settleUnownedActiveJob(id)) {
    throw jobError("任务结果状态无法确认，为避免重复计费不能取消后重试。请先检查生成历史。", {
      code: "IMAGE_JOB_RESULT_UNKNOWN",
      status: 409,
    });
  }
  let abort = false;
  const cancelled = await commitState(async (state) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw jobError("没有找到这个生图任务。", { code: "IMAGE_JOB_NOT_FOUND", status: 404 });
    if (!["queued", "running", "saving"].includes(job.status)) {
      throw jobError("只有排队中或生成中的任务可以取消。", { code: "IMAGE_JOB_NOT_CANCELLABLE", status: 409 });
    }
    abort = job.status === "running" || job.status === "saving";
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = {
      code: "IMAGE_JOB_CANCELLED",
      message: abort
        ? "已标记取消；模型服务可能已经计费。为避免重复扣费，此任务不能直接重试。"
        : "图片生成任务已取消。",
      retryable: !abort,
    };
    return publicJob(job, state.jobs);
  });
  if (abort && currentExecution?.jobId === id) {
    currentExecution.cancelled = true;
    currentExecution.controller.abort();
  }
  scheduleWorker();
  return cancelled;
}

export const imageJobLimits = Object.freeze({ maxJobs: MAX_JOBS });
