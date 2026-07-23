import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-job-service-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  CAPTURE_JOB_LIMIT,
  CAPTURE_JOB_RETENTION_MS,
  clearFailedCaptureJobs,
  clearFinishedCaptureJobs,
  clearStaleCaptureJobs,
  createCaptureJob,
  deleteCaptureJob,
  getCaptureJobs,
  patchCaptureJob,
  pruneCaptureJobs,
  recoverInterruptedCaptureJobs,
} = await import("./captureJobService.js");

after(async () => {
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("recoverInterruptedCaptureJobs requeues only running jobs without mutating input", () => {
  const now = "2026-07-18T08:00:00.000Z";
  const jobs = [
    { id: "running", status: "running", stage: "capturing", attempt: 2, nextAttemptAt: "2026-07-18T09:00:00.000Z", results: [{ skuId: "1" }] },
    { id: "completed", status: "completed", stage: "completed", finishedAt: "2026-07-18T07:00:00.000Z" },
    { id: "failed", status: "failed", stage: "failed", finishedAt: "2026-07-18T07:00:00.000Z" },
  ];

  const recovered = recoverInterruptedCaptureJobs(jobs, now);

  assert.deepEqual(recovered[0], {
    ...jobs[0],
    status: "queued",
    stage: "queued",
    queuedAt: now,
    updatedAt: now,
    nextAttemptAt: null,
    finishedAt: null,
    completedAt: null,
    failedAt: null,
  });
  assert.deepEqual(recovered[1], jobs[1]);
  assert.deepEqual(recovered[2], jobs[2]);
  assert.equal(jobs[0].status, "running");
});

test("pruneCaptureJobs removes old terminal history without ever dropping active work", () => {
  const now = Date.parse("2026-07-18T08:00:00.000Z");
  const old = new Date(now - CAPTURE_JOB_RETENTION_MS - 1).toISOString();
  const recent = new Date(now - CAPTURE_JOB_RETENTION_MS).toISOString();
  const retained = pruneCaptureJobs([
    { id: "old", status: "completed", finishedAt: old },
    { id: "boundary", status: "failed", finishedAt: recent },
  ], now);
  const capped = pruneCaptureJobs([
    { id: "finished", status: "completed", finishedAt: recent },
    ...Array.from({ length: CAPTURE_JOB_LIMIT + 5 }, (_, index) => ({ id: `job-${index}`, status: "queued", createdAt: recent })),
  ], now);

  assert.deepEqual(retained.map((job) => job.id), ["boundary"]);
  assert.equal(capped.length, CAPTURE_JOB_LIMIT + 5);
  assert.equal(capped.some((job) => job.id === "finished"), false);
  assert.equal(capped.filter((job) => job.status === "queued").length, CAPTURE_JOB_LIMIT + 5);
});

test("persistent capture job API stores lifecycle, attempts, results, and cleanup in an isolated database", async () => {
  const job = await createCaptureJob({ source: "manual", scope: "p1", productIds: ["p1"] });
  assert.equal(job.status, "queued");
  assert.equal(job.stage, "queued");
  assert.equal(job.attempt, 0);
  assert.deepEqual(job.results, []);

  const opening = await patchCaptureJob(job.id, { stage: "opening", message: "正在打开商品" });
  assert.equal(opening.status, "running");
  assert.equal(opening.attempt, 1);
  assert.ok(opening.startedAt);

  const capturing = await patchCaptureJob(job.id, { stage: "capturing" });
  assert.equal(capturing.status, "running");
  assert.equal(capturing.attempt, 1);

  const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
  const retrying = await patchCaptureJob(job.id, { stage: "retrying", nextAttemptAt });
  assert.equal(retrying.status, "queued");
  assert.equal(retrying.nextAttemptAt, nextAttemptAt);

  const secondAttempt = await patchCaptureJob(job.id, { stage: "opening" });
  assert.equal(secondAttempt.attempt, 2);
  assert.equal(secondAttempt.nextAttemptAt, null);

  const completed = await patchCaptureJob(job.id, { stage: "completed", results: [{ productId: "p1", status: "ok" }] });
  assert.equal(completed.status, "completed");
  assert.ok(completed.completedAt);
  assert.ok(completed.finishedAt);
  assert.deepEqual(completed.results, [{ productId: "p1", status: "ok" }]);
  assert.equal((await getCaptureJobs()).length, 1);
  assert.equal(await clearFinishedCaptureJobs(), 1);
  assert.deepEqual(await getCaptureJobs(), []);
  assert.equal(await patchCaptureJob("missing", { stage: "queued" }), null);
});

test("patchCaptureJob rejects inconsistent or malformed lifecycle updates", async () => {
  const job = await createCaptureJob({ source: "validation-test" });
  await assert.rejects(() => patchCaptureJob(job.id, { stage: "capturing", status: "failed" }), /不匹配/);
  await assert.rejects(() => patchCaptureJob(job.id, { stage: "unknown" }), /未知抓取阶段/);
  await assert.rejects(() => patchCaptureJob(job.id, { stage: "retrying", nextAttemptAt: "not-a-date" }), /重试时间无效/);
});

test("auth-required is a durable paused state", async () => {
  const job = await createCaptureJob({ source: "auth-test" });
  const paused = await patchCaptureJob(job.id, { stage: "auth-required", message: "请重新授权账号" });
  assert.equal(paused.status, "auth-required");
  assert.equal(paused.stage, "auth-required");
  assert.ok(paused.pausedAt);
});

test("deleteCaptureJob removes every non-running state and rejects running work", async () => {
  await clearFailedCaptureJobs();
  await clearFinishedCaptureJobs();
  const queued = await createCaptureJob({ source: "delete-queued" });
  const retrying = await createCaptureJob({ source: "delete-retrying" });
  await patchCaptureJob(retrying.id, { stage: "retrying", nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  const authRequired = await createCaptureJob({ source: "delete-auth" });
  await patchCaptureJob(authRequired.id, { stage: "auth-required" });
  const failed = await createCaptureJob({ source: "delete-failed" });
  await patchCaptureJob(failed.id, { stage: "failed" });
  const completed = await createCaptureJob({ source: "delete-completed" });
  await patchCaptureJob(completed.id, { stage: "completed" });
  const running = await createCaptureJob({ source: "delete-running" });
  await patchCaptureJob(running.id, { stage: "opening" });

  for (const job of [queued, retrying, authRequired, failed, completed]) {
    assert.equal((await deleteCaptureJob(job.id))?.id, job.id);
  }
  await assert.rejects(() => deleteCaptureJob(running.id), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "CAPTURE_JOB_RUNNING");
    return true;
  });
  assert.equal((await getCaptureJobs()).some((job) => job.id === running.id), true);
  await patchCaptureJob(running.id, { stage: "failed" });
  await deleteCaptureJob(running.id);
  assert.equal(await deleteCaptureJob("missing"), null);
});

test("clearFailedCaptureJobs removes failed, auth-required, and retrying jobs only", async () => {
  await clearFailedCaptureJobs();
  await clearFinishedCaptureJobs();
  const queued = await createCaptureJob({ source: "clear-queued" });
  const retrying = await createCaptureJob({ source: "clear-retrying" });
  await patchCaptureJob(retrying.id, { stage: "retrying", nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  const authRequired = await createCaptureJob({ source: "clear-auth" });
  await patchCaptureJob(authRequired.id, { stage: "auth-required" });
  const failed = await createCaptureJob({ source: "clear-failed" });
  await patchCaptureJob(failed.id, { stage: "failed" });
  const completed = await createCaptureJob({ source: "clear-completed" });
  await patchCaptureJob(completed.id, { stage: "completed" });
  const running = await createCaptureJob({ source: "clear-running" });
  await patchCaptureJob(running.id, { stage: "opening" });

  assert.equal(await clearFailedCaptureJobs(), 3);
  const retainedIds = new Set((await getCaptureJobs()).map((job) => job.id));
  assert.equal(retainedIds.has(queued.id), true);
  assert.equal(retainedIds.has(completed.id), true);
  assert.equal(retainedIds.has(running.id), true);
  assert.equal(retainedIds.has(retrying.id), false);
  assert.equal(retainedIds.has(authRequired.id), false);
  assert.equal(retainedIds.has(failed.id), false);

  await deleteCaptureJob(queued.id);
  await deleteCaptureJob(completed.id);
  await patchCaptureJob(running.id, { stage: "failed" });
  await deleteCaptureJob(running.id);
});

test("clearStaleCaptureJobs retains failed diagnostics when a temporary product card is gone", async () => {
  const existingProductIds = (await getCaptureJobs()).flatMap((job) => job.productIds || []);
  const validProductIds = [...new Set([...existingProductIds, "valid-product"])];
  const staleQueued = await createCaptureJob({ source: "stale-queued", productIds: ["deleted-product"] });
  const staleRetrying = await createCaptureJob({ source: "stale-retrying", productIds: ["deleted-product"] });
  await patchCaptureJob(staleRetrying.id, { stage: "retrying", nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  const staleAuth = await createCaptureJob({ source: "stale-auth", productIds: ["deleted-product"] });
  await patchCaptureJob(staleAuth.id, { stage: "auth-required" });
  const staleCompleted = await createCaptureJob({ source: "stale-completed", productIds: ["deleted-product"] });
  await patchCaptureJob(staleCompleted.id, { stage: "completed" });
  const staleFailed = await createCaptureJob({ source: "stale-failed", productIds: ["deleted-product"] });
  await patchCaptureJob(staleFailed.id, { stage: "failed", error: "首次抓取失败" });
  const staleRunning = await createCaptureJob({ source: "stale-running", productIds: ["deleted-product"] });
  await patchCaptureJob(staleRunning.id, { stage: "opening" });
  const partialScope = await createCaptureJob({ source: "partial-scope", productIds: ["deleted-product", "valid-product"] });
  const noScope = await createCaptureJob({ source: "no-scope" });

  const removed = await clearStaleCaptureJobs(validProductIds);
  assert.deepEqual(new Set(removed.map((job) => job.id)), new Set([staleQueued.id, staleRetrying.id, staleAuth.id, staleCompleted.id]));
  const retainedIds = new Set((await getCaptureJobs()).map((job) => job.id));
  assert.equal(retainedIds.has(staleRunning.id), true);
  assert.equal(retainedIds.has(staleFailed.id), true);
  assert.equal(retainedIds.has(partialScope.id), true);
  assert.equal(retainedIds.has(noScope.id), true);

  await patchCaptureJob(staleRunning.id, { stage: "failed" });
  await deleteCaptureJob(staleRunning.id);
  await deleteCaptureJob(staleFailed.id);
  await deleteCaptureJob(partialScope.id);
  await deleteCaptureJob(noScope.id);
});
