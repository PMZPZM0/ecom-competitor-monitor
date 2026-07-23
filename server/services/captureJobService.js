import { newId, readDb, updateDb } from "../storage/db.js";

export const CAPTURE_JOB_STAGES = Object.freeze([
  "queued",
  "opening",
  "capturing",
  "saving",
  "parsing",
  "verifying",
  "retrying",
  "auth-required",
  "completed",
  "failed",
]);

export const CAPTURE_JOB_LIMIT = 200;
export const CAPTURE_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const STAGES = new Set(CAPTURE_JOB_STAGES);
const STATUSES = new Set(["queued", "running", "auth-required", "completed", "failed"]);
const RUNNING_STAGES = new Set(["opening", "capturing", "saving", "parsing", "verifying"]);
const FINISHED_STATUSES = new Set(["completed", "failed"]);

function isoTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("抓取任务时间无效。");
  return date.toISOString();
}

function isFinished(job) {
  return FINISHED_STATUSES.has(job?.status) || FINISHED_STATUSES.has(job?.stage);
}

function isRunning(job) {
  return job?.status === "running" || RUNNING_STAGES.has(job?.stage);
}

export function isFailedCaptureJob(job) {
  if (isRunning(job)) return false;
  return job?.status === "failed"
    || job?.status === "auth-required"
    || job?.stage === "failed"
    || job?.stage === "auth-required"
    || job?.stage === "retrying";
}

function captureJobProductIds(job) {
  return [...new Set([
    ...(Array.isArray(job?.productIds) ? job.productIds : []),
    ...(job?.productId ? [job.productId] : []),
  ].map(String).filter(Boolean))];
}

function finishedAt(job) {
  return job?.finishedAt || job?.completedAt || job?.failedAt || job?.updatedAt || job?.createdAt || null;
}

function statusForStage(stage) {
  if (RUNNING_STAGES.has(stage)) return "running";
  if (stage === "auth-required") return "auth-required";
  if (stage === "completed" || stage === "failed") return stage;
  return "queued";
}

export function pruneCaptureJobs(jobs, now = Date.now()) {
  const cutoff = new Date(isoTime(now)).getTime() - CAPTURE_JOB_RETENTION_MS;
  const retained = (Array.isArray(jobs) ? jobs : []).filter((job) => {
    if (!isFinished(job)) return true;
    const timestamp = Date.parse(finishedAt(job));
    return !Number.isFinite(timestamp) || timestamp >= cutoff;
  });

  if (retained.length <= CAPTURE_JOB_LIMIT) return retained;
  const activeCount = retained.filter((job) => !isFinished(job)).length;
  let terminalBudget = Math.max(0, CAPTURE_JOB_LIMIT - activeCount);
  return retained.filter((job) => {
    if (!isFinished(job)) return true;
    if (terminalBudget <= 0) return false;
    terminalBudget -= 1;
    return true;
  });
}

export function recoverInterruptedCaptureJobs(jobs, now = Date.now()) {
  const recoveredAt = isoTime(now);
  return (Array.isArray(jobs) ? jobs : []).map((job) => {
    if (job?.status !== "running") return { ...job };
    return {
      ...job,
      status: "queued",
      stage: "queued",
      queuedAt: recoveredAt,
      updatedAt: recoveredAt,
      nextAttemptAt: null,
      finishedAt: null,
      completedAt: null,
      failedAt: null,
    };
  });
}

function createJobRecord(meta, now) {
  const details = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
  for (const key of [
    "id", "status", "stage", "attempt", "nextAttemptAt", "results", "createdAt", "updatedAt",
    "queuedAt", "startedAt", "finishedAt", "completedAt", "failedAt", "pausedAt",
  ]) delete details[key];
  return {
    ...details,
    id: newId("capture"),
    status: "queued",
    stage: "queued",
    attempt: 0,
    nextAttemptAt: null,
    results: [],
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    completedAt: null,
    failedAt: null,
    pausedAt: null,
  };
}

function applyJobPatch(job, patch, now) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("抓取任务更新内容无效。");
  const stage = patch.stage ?? (patch.status && patch.status !== job.status
    ? patch.status === "running" ? (RUNNING_STAGES.has(job.stage) ? job.stage : "opening") : patch.status
    : job.stage);
  if (!STAGES.has(stage)) throw new TypeError(`未知抓取阶段：${stage}`);
  const status = statusForStage(stage);
  if (patch.status !== undefined && (!STATUSES.has(patch.status) || patch.status !== status)) {
    throw new TypeError(`抓取状态 ${patch.status} 与阶段 ${stage} 不匹配。`);
  }
  if (patch.attempt !== undefined && (!Number.isInteger(patch.attempt) || patch.attempt < 0)) {
    throw new TypeError("抓取任务尝试次数无效。");
  }
  if (patch.results !== undefined && !Array.isArray(patch.results)) throw new TypeError("抓取任务结果必须是数组。");
  if (patch.nextAttemptAt !== undefined && patch.nextAttemptAt !== null && !Number.isFinite(Date.parse(patch.nextAttemptAt))) {
    throw new TypeError("抓取任务下次重试时间无效。");
  }

  const safePatch = { ...patch };
  for (const key of ["id", "createdAt", "updatedAt", "queuedAt", "startedAt", "finishedAt", "completedAt", "failedAt", "pausedAt"]) {
    delete safePatch[key];
  }
  const startingAttempt = status === "running" && job.status !== "running";
  const next = {
    ...job,
    ...safePatch,
    id: job.id,
    createdAt: job.createdAt,
    status,
    stage,
    attempt: patch.attempt ?? ((job.attempt || 0) + (startingAttempt ? 1 : 0)),
    results: patch.results === undefined ? (Array.isArray(job.results) ? job.results : []) : [...patch.results],
    updatedAt: now,
  };

  if (startingAttempt) next.startedAt = now;
  if (stage === "queued" || stage === "retrying") next.queuedAt = now;
  if (stage === "auth-required") next.pausedAt = now;
  if (status === "completed" || status === "failed") {
    next.finishedAt = now;
    next.completedAt = status === "completed" ? now : null;
    next.failedAt = status === "failed" ? now : null;
    next.nextAttemptAt = null;
  } else {
    next.finishedAt = null;
    next.completedAt = null;
    next.failedAt = null;
    if (stage !== "retrying") next.nextAttemptAt = null;
  }
  return next;
}

export async function createCaptureJob(meta = {}) {
  const now = isoTime();
  const job = createJobRecord(meta, now);
  await updateDb((db) => {
    db.captureJobs = pruneCaptureJobs([job, ...(Array.isArray(db.captureJobs) ? db.captureJobs : [])], now);
    return db;
  });
  return job;
}

export async function patchCaptureJob(id, patch) {
  if (!id) throw new TypeError("抓取任务 ID 不能为空。");
  const now = isoTime();
  let updated = null;
  await updateDb((db) => {
    const jobs = Array.isArray(db.captureJobs) ? [...db.captureJobs] : [];
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return db;
    jobs[index] = applyJobPatch(jobs[index], patch, now);
    db.captureJobs = pruneCaptureJobs(jobs, now);
    updated = jobs[index];
    return db;
  });
  return updated;
}

export async function getCaptureJobs() {
  const db = await readDb();
  const stored = Array.isArray(db.captureJobs) ? db.captureJobs : [];
  const jobs = pruneCaptureJobs(stored);
  if (jobs.length !== stored.length) {
    await updateDb((current) => {
      current.captureJobs = pruneCaptureJobs(current.captureJobs);
      return current;
    });
  }
  return jobs;
}

export async function clearFinishedCaptureJobs() {
  let removed = 0;
  await updateDb((db) => {
    const jobs = Array.isArray(db.captureJobs) ? db.captureJobs : [];
    const active = jobs.filter((job) => !isFinished(job));
    removed = jobs.length - active.length;
    db.captureJobs = pruneCaptureJobs(active);
    return db;
  });
  return removed;
}

export async function clearFailedCaptureJobs() {
  return (await deleteFailedCaptureJobs()).length;
}

export async function deleteFailedCaptureJobs() {
  const removed = [];
  await updateDb((db) => {
    const jobs = Array.isArray(db.captureJobs) ? db.captureJobs : [];
    const retained = jobs.filter((job) => {
      if (!isFailedCaptureJob(job)) return true;
      removed.push(job);
      return false;
    });
    db.captureJobs = pruneCaptureJobs(retained);
    return db;
  });
  return removed;
}

export async function clearStaleCaptureJobs(validProductIds) {
  const validIds = new Set((validProductIds || []).map(String).filter(Boolean));
  const removed = [];
  await updateDb((db) => {
    const jobs = Array.isArray(db.captureJobs) ? db.captureJobs : [];
    const retained = jobs.filter((job) => {
      if (isRunning(job)) return true;
      // A failed first capture can remove its temporary empty product card.
      // Keep the terminal diagnostic in the queue until normal retention or
      // an explicit clear, otherwise the failure disappears with the card.
      if (job?.status === "failed" || job?.stage === "failed") return true;
      const referencedIds = captureJobProductIds(job);
      const stale = referencedIds.length > 0 && !referencedIds.some((id) => validIds.has(id));
      if (stale) removed.push(job);
      return !stale;
    });
    db.captureJobs = pruneCaptureJobs(retained);
    return db;
  });
  return removed;
}

export async function deleteCaptureJob(id) {
  if (!id) throw new TypeError("抓取任务 ID 不能为空。");
  let removed = null;
  await updateDb((db) => {
    const jobs = Array.isArray(db.captureJobs) ? [...db.captureJobs] : [];
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return db;
    if (isRunning(jobs[index])) {
      throw Object.assign(new Error("抓取任务正在运行，不能删除；请等待任务结束后再清理。"), {
        status: 409,
        code: "CAPTURE_JOB_RUNNING",
      });
    }
    [removed] = jobs.splice(index, 1);
    db.captureJobs = pruneCaptureJobs(jobs);
    return db;
  });
  return removed;
}
