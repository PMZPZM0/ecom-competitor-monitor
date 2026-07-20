import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-image-jobs-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";
process.env.MODEL_STABLE_API_KEY = "sk-image-job-test";

const { startServer, stopServer } = await import("../index.js");
const { waitForImageJobQueueIdle } = await import("./imageJobService.js");

const request = {
  prompt: "generate a clean product image",
  negativePrompt: "watermark",
  ratio: "1:1",
  resolution: "1k",
  quality: "medium",
  format: "png",
  background: "auto",
  count: 1,
};

async function waitForJob(fetchImpl, baseUrl, id, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchImpl(`${baseUrl}/api/image-jobs/${id}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for image job ${id}`);
}

async function enqueueJson(fetchImpl, baseUrl, prompt) {
  const response = await fetchImpl(`${baseUrl}/api/image-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, prompt }),
  });
  assert.equal(response.status, 202);
  return response.json();
}

test("persistent image job routes enqueue immediately, serialize work, recover and retry safely", async (t) => {
  let server = await startServer({ port: 0 });
  let address = server.address();
  let baseUrl = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: "#557799" } }).png().toBuffer();
  const successResponse = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    let releaseFirst;
    let firstStarted;
    const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        firstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return successResponse();
    };

    const multipart = new FormData();
    multipart.append("request", JSON.stringify({ ...request, prompt: "first queued edit" }));
    multipart.append("referenceImages", new Blob([png], { type: "image/png" }), "reference.png");
    const firstResponse = await nativeFetch(`${baseUrl}/api/image-jobs`, { method: "POST", body: multipart });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    assert.match(first.id, /^image_job_/);
    assert.equal(first.referenceImageCount, 1);
    assert.ok(["queued", "running"].includes(first.status));

    await firstStartedPromise;
    const second = await enqueueJson(nativeFetch, baseUrl, "second queued generation");
    assert.equal(upstreamCalls, 1, "the second task must not start while the first is running");

    const listedResponse = await nativeFetch(`${baseUrl}/api/image-jobs`);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.equal(listed.length, 2);
    assert.equal(listed.find((job) => job.id === first.id).status, "running");
    const listedSecond = listed.find((job) => job.id === second.id);
    assert.equal(listedSecond.status, "queued");
    assert.equal(listedSecond.queuePosition, 1);
    assert.equal(listedSecond.position, 1);
    assert.match(listedSecond.message, /排队第 1 位/);

    releaseFirst();
    const firstDone = await waitForJob(nativeFetch, baseUrl, first.id, (job) => job.status === "succeeded");
    const secondDone = await waitForJob(nativeFetch, baseUrl, second.id, (job) => job.status === "succeeded");
    assert.equal(upstreamCalls, 2);
    assert.equal(firstDone.result.images.length, 1);
    assert.equal(firstDone.result.appliedOptions.mode, "edit");
    assert.equal(secondDone.result.appliedOptions.mode, "generate");
    assert.equal(firstDone.finishedAt, firstDone.completedAt);
    assert.ok(Number.isFinite(firstDone.durationMs));

    let releaseSourceBlocker;
    let sourceBlockerStarted;
    const sourceBlockerStartedPromise = new Promise((resolve) => { sourceBlockerStarted = resolve; });
    let sourceSnapshotCalls = 0;
    let sourceEditRequest;
    globalThis.fetch = async (url, init) => {
      sourceSnapshotCalls += 1;
      if (sourceSnapshotCalls === 1) {
        sourceBlockerStarted();
        await new Promise((resolve) => { releaseSourceBlocker = resolve; });
      } else {
        sourceEditRequest = { url: String(url), init };
      }
      return successResponse();
    };
    const sourceBlocker = await enqueueJson(nativeFetch, baseUrl, "hold source snapshot edit");
    await sourceBlockerStartedPromise;
    const sourceClientRequestId = crypto.randomUUID();
    const sourceEditPayload = {
      ...request,
      prompt: "edit from the queued source snapshot",
      sourceImageId: firstDone.result.images[0].id,
      clientRequestId: sourceClientRequestId,
    };
    const sourceEditResponse = await nativeFetch(`${baseUrl}/api/image-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sourceEditPayload),
    });
    assert.equal(sourceEditResponse.status, 202);
    const sourceEditJob = await sourceEditResponse.json();
    assert.equal(sourceEditJob.clientRequestId, sourceClientRequestId);
    assert.equal((await nativeFetch(`${baseUrl}/api/images/${firstDone.result.images[0].id}`, { method: "DELETE" })).status, 204);
    const duplicateSourceEditResponse = await nativeFetch(`${baseUrl}/api/image-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sourceEditPayload),
    });
    assert.equal(duplicateSourceEditResponse.status, 202);
    assert.equal((await duplicateSourceEditResponse.json()).id, sourceEditJob.id, "the same client request must return the original job");
    const conflictingReplay = await nativeFetch(`${baseUrl}/api/image-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sourceEditPayload, prompt: "different payload with a reused request id" }),
    });
    assert.equal(conflictingReplay.status, 409);
    assert.equal((await conflictingReplay.json()).error.code, "IMAGE_JOB_IDEMPOTENCY_CONFLICT");
    releaseSourceBlocker();
    await waitForJob(nativeFetch, baseUrl, sourceBlocker.id, (job) => job.status === "succeeded");
    await waitForJob(nativeFetch, baseUrl, sourceEditJob.id, (job) => job.status === "succeeded");
    assert.equal(sourceSnapshotCalls, 2, "an idempotent replay must not call the model twice");
    assert.match(sourceEditRequest.url, /\/images\/edits$/);
    assert.ok(sourceEditRequest.init.body instanceof FormData);
    assert.ok(sourceEditRequest.init.body.get("image") || sourceEditRequest.init.body.getAll("image[]").length > 0);

    let releaseShutdownUpstream;
    let shutdownUpstreamStarted;
    const shutdownUpstreamStartedPromise = new Promise((resolve) => { shutdownUpstreamStarted = resolve; });
    globalThis.fetch = async () => {
      shutdownUpstreamStarted();
      await new Promise((resolve) => { releaseShutdownUpstream = resolve; });
      return successResponse();
    };
    const shutdownRaceJob = await enqueueJson(nativeFetch, baseUrl, "shutdown receipt ownership barrier");
    await shutdownUpstreamStartedPromise;
    const shutdownReceiptPath = path.join(dataDir, "image-jobs", "completions", `${shutdownRaceJob.id}.json`);
    const shutdownOriginalRename = fs.rename.bind(fs);
    let shutdownReceiptWrites = 0;
    let releaseSucceededReceipt;
    let succeededReceiptWritten;
    const succeededReceiptWrittenPromise = new Promise((resolve) => { succeededReceiptWritten = resolve; });
    t.mock.method(fs, "rename", async (source, destination) => {
      const result = await shutdownOriginalRename(source, destination);
      if (path.resolve(destination) === path.resolve(shutdownReceiptPath)) {
        shutdownReceiptWrites += 1;
        if (shutdownReceiptWrites === 2) {
          succeededReceiptWritten();
          await new Promise((resolve) => { releaseSucceededReceipt = resolve; });
        }
      }
      return result;
    });
    releaseShutdownUpstream();
    await succeededReceiptWrittenPromise;
    const stoppingServer = stopServer(server);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSucceededReceipt();
    await stoppingServer;
    t.mock.restoreAll();
    server = await startServer({ port: 0 });
    address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const shutdownRaceFinal = await waitForJob(nativeFetch, baseUrl, shutdownRaceJob.id, (job) => job.status === "failed" || job.status === "succeeded");
    if (shutdownRaceFinal.status === "succeeded") {
      assert.equal((await nativeFetch(`${baseUrl}${shutdownRaceFinal.result.images[0].src}`)).status, 200, "a succeeded shutdown job must retain its image");
    } else {
      assert.equal(shutdownRaceFinal.error.retryable, false);
      const shutdownLibrary = await (await nativeFetch(`${baseUrl}/api/images`)).json();
      assert.equal(shutdownLibrary.some((image) => image.prompt === "shutdown receipt ownership barrier"), false, "an interrupted shutdown job must not leave a deleted result marked succeeded");
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "temporary upstream failure" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    const failed = await enqueueJson(nativeFetch, baseUrl, "retry this task");
    const failedDone = await waitForJob(nativeFetch, baseUrl, failed.id, (job) => job.status === "failed");
    assert.match(failedDone.error.message, /temporary upstream failure|503/);
    assert.equal(failedDone.error.retryable, true);

    globalThis.fetch = async () => successResponse();
    const retryResponse = await nativeFetch(`${baseUrl}/api/image-jobs/${failed.id}/retry`, { method: "POST" });
    assert.equal(retryResponse.status, 202);
    const retried = await waitForJob(nativeFetch, baseUrl, failed.id, (job) => job.status === "succeeded");
    assert.equal(retried.attempt, 2);

    let releaseCancellationBlocker;
    let cancellationBlockerStarted;
    const cancellationBlockerStartedPromise = new Promise((resolve) => { cancellationBlockerStarted = resolve; });
    let cancellationCalls = 0;
    globalThis.fetch = async () => {
      cancellationCalls += 1;
      if (cancellationCalls === 1) {
        cancellationBlockerStarted();
        await new Promise((resolve) => { releaseCancellationBlocker = resolve; });
      }
      return successResponse();
    };
    const blocker = await enqueueJson(nativeFetch, baseUrl, "block cancellation queue");
    await cancellationBlockerStartedPromise;
    const cancelledCandidate = await enqueueJson(nativeFetch, baseUrl, "cancel while queued");
    const cancelResponse = await nativeFetch(`${baseUrl}/api/image-jobs/${cancelledCandidate.id}`, { method: "DELETE" });
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).status, "cancelled");
    releaseCancellationBlocker();
    await waitForJob(nativeFetch, baseUrl, blocker.id, (job) => job.status === "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cancellationCalls, 1, "a cancelled queued task must never call the model API");
    const queuedCancelRetry = await nativeFetch(`${baseUrl}/api/image-jobs/${cancelledCandidate.id}/retry`, { method: "POST" });
    assert.equal(queuedCancelRetry.status, 202);
    await waitForJob(nativeFetch, baseUrl, cancelledCandidate.id, (job) => job.status === "succeeded");

    let releaseRunningCancellation;
    let runningCancellationStarted;
    let runningCancellationReturned;
    const runningCancellationStartedPromise = new Promise((resolve) => { runningCancellationStarted = resolve; });
    const runningCancellationReturnedPromise = new Promise((resolve) => { runningCancellationReturned = resolve; });
    globalThis.fetch = async () => {
      runningCancellationStarted();
      await new Promise((resolve) => { releaseRunningCancellation = resolve; });
      runningCancellationReturned();
      return successResponse();
    };
    const runningCancellation = await enqueueJson(nativeFetch, baseUrl, "cancel while model ignores abort");
    await runningCancellationStartedPromise;
    const runningCancelResponse = await nativeFetch(`${baseUrl}/api/image-jobs/${runningCancellation.id}`, { method: "DELETE" });
    assert.equal(runningCancelResponse.status, 200);
    const runningCancelled = await runningCancelResponse.json();
    assert.equal(runningCancelled.status, "cancelled");
    assert.equal(runningCancelled.error.retryable, false);
    releaseRunningCancellation();
    await runningCancellationReturnedPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const libraryAfterCancellation = await (await nativeFetch(`${baseUrl}/api/images`)).json();
    assert.equal(libraryAfterCancellation.some((image) => image.prompt === "cancel while model ignores abort"), false);

    globalThis.fetch = async () => successResponse();
    const runningCancelRetry = await nativeFetch(`${baseUrl}/api/image-jobs/${runningCancellation.id}/retry`, { method: "POST" });
    assert.equal(runningCancelRetry.status, 409);

    let releaseInterrupted;
    let interruptedStarted;
    const interruptedStartedPromise = new Promise((resolve) => { interruptedStarted = resolve; });
    globalThis.fetch = async () => {
      interruptedStarted();
      await new Promise((resolve) => { releaseInterrupted = resolve; });
      return successResponse();
    };
    const interrupted = await enqueueJson(nativeFetch, baseUrl, "interrupted during shutdown");
    await interruptedStartedPromise;
    const recoverableQueued = await enqueueJson(nativeFetch, baseUrl, "continue after restart");
    await stopServer(server);

    const diskManifest = JSON.parse(await fs.readFile(path.join(dataDir, "image-jobs", "manifest.json"), "utf8"));
    const interruptedOnDisk = diskManifest.jobs.find((job) => job.id === interrupted.id);
    const queuedOnDisk = diskManifest.jobs.find((job) => job.id === recoverableQueued.id);
    assert.equal(interruptedOnDisk.status, "failed");
    assert.equal(interruptedOnDisk.error.code, "IMAGE_JOB_INTERRUPTED");
    assert.match(interruptedOnDisk.error.message, /避免重复计费/);
    assert.equal(queuedOnDisk.status, "queued");

    releaseInterrupted();
    await new Promise((resolve) => setTimeout(resolve, 30));
    globalThis.fetch = async () => successResponse();
    server = await startServer({ port: 0 });
    address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    await waitForJob(nativeFetch, baseUrl, recoverableQueued.id, (job) => job.status === "succeeded");
    const interruptedAfterRestart = await waitForJob(nativeFetch, baseUrl, interrupted.id, (job) => job.status === "failed");
    assert.equal(interruptedAfterRestart.error.code, "IMAGE_JOB_INTERRUPTED");

    let releaseFinalizeFixture;
    let finalizeFixtureStarted;
    let finalizeUpstreamCalls = 0;
    const finalizeFixtureStartedPromise = new Promise((resolve) => { finalizeFixtureStarted = resolve; });
    globalThis.fetch = async () => {
      finalizeUpstreamCalls += 1;
      finalizeFixtureStarted();
      await new Promise((resolve) => { releaseFinalizeFixture = resolve; });
      return successResponse();
    };
    const finalizeRecoveryJob = await enqueueJson(nativeFetch, baseUrl, "recover completion after manifest failure");
    await finalizeFixtureStartedPromise;
    const finalizeManifestPath = path.join(dataDir, "image-jobs", "manifest.json");
    const finalizeOriginalRename = fs.rename.bind(fs);
    let finalizeManifestWrites = 0;
    let finalizeRecoveryFailed;
    const finalizeRecoveryFailedPromise = new Promise((resolve) => { finalizeRecoveryFailed = resolve; });
    t.mock.method(fs, "rename", async (source, destination) => {
      if (path.resolve(destination) === path.resolve(finalizeManifestPath)) {
        finalizeManifestWrites += 1;
        if ([2, 3].includes(finalizeManifestWrites)) {
          if (finalizeManifestWrites === 3) finalizeRecoveryFailed();
          throw Object.assign(new Error("fail final job commit until worker retry"), { code: "EIO" });
        }
      }
      return finalizeOriginalRename(source, destination);
    });
    releaseFinalizeFixture();
    await finalizeRecoveryFailedPromise;
    const completedCancel = await nativeFetch(`${baseUrl}/api/image-jobs/${finalizeRecoveryJob.id}`, { method: "DELETE" });
    assert.equal(completedCancel.status, 409);
    assert.ok(["IMAGE_JOB_ALREADY_COMPLETED", "IMAGE_JOB_NOT_CANCELLABLE"].includes((await completedCancel.json()).error.code));
    const completedRetry = await nativeFetch(`${baseUrl}/api/image-jobs/${finalizeRecoveryJob.id}/retry`, { method: "POST" });
    assert.equal(completedRetry.status, 409);
    const recoveredFinalize = await waitForJob(nativeFetch, baseUrl, finalizeRecoveryJob.id, (job) => job.status === "succeeded");
    assert.equal(recoveredFinalize.result.images.length, 1);
    assert.ok(finalizeManifestWrites >= 4, "a completion receipt must recover through worker backoff without an app restart");
    assert.equal(finalizeUpstreamCalls, 1, "cancel or retry during completion recovery must not call the model again");
    t.mock.restoreAll();

    await stopServer(server);
    const restartRecoveryManifest = JSON.parse(await fs.readFile(finalizeManifestPath, "utf8"));
    const restartRecoveryRecord = restartRecoveryManifest.jobs.find((job) => job.id === finalizeRecoveryJob.id);
    restartRecoveryRecord.status = "saving";
    restartRecoveryRecord.result = null;
    restartRecoveryRecord.completedAt = null;
    await fs.writeFile(finalizeManifestPath, JSON.stringify(restartRecoveryManifest, null, 2));
    const orphanJobId = `image_job_${"f".repeat(32)}`;
    const orphanInputDirectory = path.join(dataDir, "image-jobs", "inputs", orphanJobId);
    const orphanReceipt = path.join(dataDir, "image-jobs", "completions", `${orphanJobId}.json`);
    await fs.mkdir(orphanInputDirectory, { recursive: true });
    await fs.writeFile(path.join(orphanInputDirectory, "reference-1.png"), png);
    await fs.writeFile(orphanReceipt, JSON.stringify({ version: 1, jobId: orphanJobId, phase: "saving" }));
    server = await startServer({ port: 0 });
    address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    const restartRecovered = await waitForJob(nativeFetch, baseUrl, finalizeRecoveryJob.id, (job) => job.status === "succeeded");
    assert.equal(restartRecovered.result.images[0].id, recoveredFinalize.result.images[0].id, "restart recovery must reuse the saved result without another model call");
    await assert.rejects(fs.stat(orphanInputDirectory), { code: "ENOENT" });
    await assert.rejects(fs.stat(orphanReceipt), { code: "ENOENT" });

    let releaseFailedFinalize;
    let failedFinalizeStarted;
    let failedFinalizeCalls = 0;
    const failedFinalizeStartedPromise = new Promise((resolve) => { failedFinalizeStarted = resolve; });
    globalThis.fetch = async () => {
      failedFinalizeCalls += 1;
      failedFinalizeStarted();
      await new Promise((resolve) => { releaseFailedFinalize = resolve; });
      return new Response(JSON.stringify({ error: { message: "upstream rejected once" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    };
    const failedFinalizeJob = await enqueueJson(nativeFetch, baseUrl, "persist one upstream failure without rerunning it");
    await failedFinalizeStartedPromise;
    const failedFinalizeOriginalRename = fs.rename.bind(fs);
    let failedFinalizeWrites = 0;
    t.mock.method(fs, "rename", async (source, destination) => {
      if (path.resolve(destination) === path.resolve(finalizeManifestPath)) {
        failedFinalizeWrites += 1;
        if (failedFinalizeWrites <= 2) throw Object.assign(new Error("fail failed-state commit until worker retry"), { code: "EIO" });
      }
      return failedFinalizeOriginalRename(source, destination);
    });
    releaseFailedFinalize();
    const finalizedFailure = await waitForJob(nativeFetch, baseUrl, failedFinalizeJob.id, (job) => job.status === "failed");
    assert.match(finalizedFailure.error.message, /upstream rejected once|503/);
    assert.ok(failedFinalizeWrites >= 3);
    assert.equal(failedFinalizeCalls, 1, "retrying failed-state persistence must not call the model again");
    t.mock.restoreAll();

    let releaseReceiptFailure;
    let receiptFailureStarted;
    let receiptFailureCalls = 0;
    const receiptFailureStartedPromise = new Promise((resolve) => { receiptFailureStarted = resolve; });
    globalThis.fetch = async () => {
      receiptFailureCalls += 1;
      receiptFailureStarted();
      await new Promise((resolve) => { releaseReceiptFailure = resolve; });
      return successResponse();
    };
    const receiptFailureJob = await enqueueJson(nativeFetch, baseUrl, "receipt and final state both fail once");
    await receiptFailureStartedPromise;
    const receiptFailureOriginalRename = fs.rename.bind(fs);
    const receiptFailurePath = path.join(dataDir, "image-jobs", "completions", `${receiptFailureJob.id}.json`);
    let receiptWrites = 0;
    let receiptFailureManifestWrites = 0;
    let failedUnknownCommit;
    const failedUnknownCommitPromise = new Promise((resolve) => { failedUnknownCommit = resolve; });
    t.mock.method(fs, "rename", async (source, destination) => {
      if (path.resolve(destination) === path.resolve(receiptFailurePath)) {
        receiptWrites += 1;
        if (receiptWrites === 2) throw Object.assign(new Error("fail succeeded receipt"), { code: "EIO" });
      }
      if (path.resolve(destination) === path.resolve(finalizeManifestPath)) {
        receiptFailureManifestWrites += 1;
        if (receiptFailureManifestWrites === 2) {
          failedUnknownCommit();
          throw Object.assign(new Error("fail unknown-result final state"), { code: "EIO" });
        }
      }
      return receiptFailureOriginalRename(source, destination);
    });
    releaseReceiptFailure();
    await failedUnknownCommitPromise;
    const unsafeCancel = await nativeFetch(`${baseUrl}/api/image-jobs/${receiptFailureJob.id}`, { method: "DELETE" });
    assert.equal(unsafeCancel.status, 409);
    const unsafeRetry = await nativeFetch(`${baseUrl}/api/image-jobs/${receiptFailureJob.id}/retry`, { method: "POST" });
    assert.equal(unsafeRetry.status, 409);
    const unknownResultJob = await waitForJob(nativeFetch, baseUrl, receiptFailureJob.id, (job) => job.status === "failed");
    assert.equal(unknownResultJob.error.retryable, false);
    assert.equal(receiptFailureCalls, 1, "an unknown saved result must never be generated a second time");
    t.mock.restoreAll();

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "copy-on-write fixture" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    const copyOnWriteJob = await enqueueJson(nativeFetch, baseUrl, "copy-on-write remains stable");
    await waitForJob(nativeFetch, baseUrl, copyOnWriteJob.id, (job) => job.status === "failed");
    await waitForImageJobQueueIdle();
    const manifestPath = path.join(dataDir, "image-jobs", "manifest.json");
    const beforeFailureDisk = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const beforeFailureInputs = await fs.readdir(path.join(dataDir, "image-jobs", "inputs"));
    const originalRename = fs.rename.bind(fs);
    let forcedManifestFailures = 0;
    t.mock.method(fs, "rename", async (source, destination) => {
      if (path.resolve(destination) === path.resolve(manifestPath)) {
        forcedManifestFailures += 1;
        throw Object.assign(new Error("forced manifest write failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    const failedRetryResponse = await nativeFetch(`${baseUrl}/api/image-jobs/${copyOnWriteJob.id}/retry`, { method: "POST" });
    assert.equal(failedRetryResponse.status, 500);
    const afterFailedRetry = await (await nativeFetch(`${baseUrl}/api/image-jobs/${copyOnWriteJob.id}`)).json();
    assert.equal(afterFailedRetry.status, "failed", "failed persistence must not mutate in-memory state");
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")), beforeFailureDisk);

    const failedEnqueueResponse = await nativeFetch(`${baseUrl}/api/image-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, prompt: "must not become an in-memory ghost" }),
    });
    assert.equal(failedEnqueueResponse.status, 500);
    const afterFailedEnqueue = await (await nativeFetch(`${baseUrl}/api/image-jobs`)).json();
    assert.equal(afterFailedEnqueue.some((job) => job.request.prompt === "must not become an in-memory ghost"), false);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "image-jobs", "inputs")), beforeFailureInputs);
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")), beforeFailureDisk);
    assert.equal(forcedManifestFailures, 2);
    t.mock.restoreAll();
  } finally {
    globalThis.fetch = nativeFetch;
    await stopServer(server);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
