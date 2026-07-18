import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-queue-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";

const { app } = await import("../index.js");
const { createCaptureJob, getCaptureJobs, patchCaptureJob } = await import("./captureJobService.js");

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("capture queue DELETE removes non-running jobs and rejects a running job", async () => {
  const queued = await createCaptureJob({ source: "route-queued" });
  const deleted = await fetch(`${baseUrl}/api/capture-queue/${queued.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal((await getCaptureJobs()).some((job) => job.id === queued.id), false);

  const running = await createCaptureJob({ source: "route-running" });
  await patchCaptureJob(running.id, { stage: "opening" });
  const rejected = await fetch(`${baseUrl}/api/capture-queue/${running.id}`, { method: "DELETE" });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "CAPTURE_JOB_RUNNING");
  assert.equal((await getCaptureJobs()).some((job) => job.id === running.id), true);
  await patchCaptureJob(running.id, { stage: "failed" });
});

test("capture queue failed cleanup includes retrying and auth-required jobs", async () => {
  const retrying = await createCaptureJob({ source: "route-retrying" });
  await patchCaptureJob(retrying.id, { stage: "retrying", nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  const authRequired = await createCaptureJob({ source: "route-auth" });
  await patchCaptureJob(authRequired.id, { stage: "auth-required" });
  const completed = await createCaptureJob({ source: "route-completed" });
  await patchCaptureJob(completed.id, { stage: "completed" });

  const response = await fetch(`${baseUrl}/api/capture-queue/failed`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, 3);
  const retainedIds = new Set((await getCaptureJobs()).map((job) => job.id));
  assert.equal(retainedIds.has(retrying.id), false);
  assert.equal(retainedIds.has(authRequired.id), false);
  assert.equal(retainedIds.has(completed.id), true);
});
