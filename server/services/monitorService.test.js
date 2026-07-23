import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-service-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  accountCaptureDiagnostic,
  buildRunRecord,
  captureAttemptProductIds,
  captureCommitConflict,
  captureJobAllowsAutomaticRetry,
  captureJobCanRequireAuthorization,
  captureFailureRequiresManualRetry,
  captureWithTransientLoginRetry,
  captureProduct,
  captureQueueLane,
  clearFinishedCaptureJobs,
  completeScheduledProduct,
  dueProductIds,
  duplicateCaptureProductIds,
  earliestProductSchedule,
  enqueueCaptureOperation,
  explainPriceCaptureFailure,
  getCaptureQueueStatus,
  historicalAccountPriceSnapshot,
  historicalPrimaryImages,
  historicalProductMedia,
  isExplicitLoginExpiryError,
  mergeAccountSnapshots,
  mergeCapturedMaterials,
  mergeCapturedProduct,
  mergeBuyerShowHistory,
  notifyBelowThreshold,
  preserveBuyerShowHistory,
  nextProductScheduleAt,
  nextCaptureRetry,
  nextWindowScheduleAt,
  orderedCaptureCandidates,
  preserveVerifiedAccountPrices,
  productWindowOffsetMinutes,
  reparseProductLocalEvidence,
  resolveProductIntervalMinutes,
  resolveProductScheduleMode,
  resumeCaptureJob,
  runCaptureBatchOnce,
  runMonitorOnce,
  runProductOnce,
  runSearchMainImageOnce,
  runInCaptureGroups,
  scheduleProduct,
  setSkuMonitorPrice,
  sessionsForProduct,
  snapshotHasVerifiedNormalPrice,
  snapshotHasCompleteVerifiedNormalPrices,
  snapshotPriceCoverage,
  snapshotAllowsPriceAlerts,
  shouldRunCaptureRetry,
  withAccountCaptureLock,
  withProtectedBrowserCapture,
} = await import("./monitorService.js");
const { updateFeishuConfig } = await import("./feishuService.js");
const { saveBrowserCaptureSource } = await import("./localImportService.js");
const { markTmallPriceGate, resetTmallPriceCircuitForTests } = await import("./tmallPriceCircuitService.js");
const { readDb, updateDb } = await import("../storage/db.js");

after(async () => {
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

test("capture queue keeps running work and starts the next task in order", async () => {
  const events = [];
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const first = enqueueCaptureOperation({ source: "queue-test-one", productIds: ["p1"] }, async () => {
    events.push("first-start");
    markStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first-end");
    return { run: { status: "success", message: "first done", items: [{ productId: "p1", status: "success" }] } };
  });
  await firstStarted;
  const second = enqueueCaptureOperation({ source: "queue-test-two", productIds: ["p2"] }, async () => {
    events.push("second-start");
    return { run: { status: "success", message: "second done" } };
  });
  let during = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    during = (await getCaptureQueueStatus()).jobs;
    if (during.some((job) => job.source === "queue-test-two")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(during.find((job) => job.source === "queue-test-one")?.status, "running");
  assert.equal(during.find((job) => job.source === "queue-test-two")?.status, "queued");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
  assert.deepEqual((await getCaptureQueueStatus()).jobs.find((job) => job.source === "queue-test-one")?.results, [{ productId: "p1", status: "success" }]);
  assert.equal((await getCaptureQueueStatus()).jobs.find((job) => job.source === "queue-test-two")?.status, "completed");
  assert.equal((await getCaptureQueueStatus()).jobs.some((job) => job.source.startsWith("queue-test-")), true);
  assert.equal(await clearFinishedCaptureJobs(), 2);
  assert.equal((await getCaptureQueueStatus()).jobs.some((job) => job.source.startsWith("queue-test-")), false);
});

test("buyer-show and price operations use independent FIFO lanes", async () => {
  let releaseBuyerShow;
  let buyerShowStarted;
  const buyerShowReady = new Promise((resolve) => { buyerShowStarted = resolve; });
  const buyerShow = enqueueCaptureOperation({ source: "lane-buyer-show", productIds: ["buyer-product"], captureKind: "buyer-show" }, async () => {
    buyerShowStarted();
    await new Promise((resolve) => { releaseBuyerShow = resolve; });
    return { run: { status: "success", items: [{ productId: "buyer-product", status: "success" }] } };
  });
  await buyerShowReady;

  let priceStarted = false;
  const price = enqueueCaptureOperation({ source: "lane-price", productIds: ["price-product"], captureKind: "price" }, async () => {
    priceStarted = true;
    return { run: { status: "success", items: [{ productId: "price-product", status: "success" }] } };
  });
  await Promise.race([price, new Promise((_, reject) => setTimeout(() => reject(new Error("价格队列被买家秀阻塞")), 250))]);
  assert.equal(priceStarted, true);
  releaseBuyerShow();
  await buyerShow;
  assert.equal(captureQueueLane("materials"), "materials");
  assert.equal(captureQueueLane("full"), "invalid");
  await clearFinishedCaptureJobs();
});

test("active recovered scope prevents a duplicate scheduled product job", () => {
  const recovered = [{ id: "recovering", status: "queued", stage: "queued", operationType: "monitor", captureKind: "price", productIds: ["p1", "p2"] }];
  assert.deepEqual(duplicateCaptureProductIds(recovered, ["p2", "p3"], "price", "monitor"), ["p2"]);
  assert.deepEqual(duplicateCaptureProductIds(recovered, ["p2"], "buyer-show", "buyer-show"), []);
});

test("each batch retry reads the latest persisted failed product subset", () => {
  const job = { productIds: ["a", "b", "c"], retryProductIds: ["a", "b"] };
  assert.deepEqual(captureAttemptProductIds(job), ["a", "b"]);
  job.retryProductIds = ["b"];
  assert.deepEqual(captureAttemptProductIds(job), ["b"]);
  job.retryProductIds = [];
  assert.deepEqual(captureAttemptProductIds(job), ["a", "b", "c"]);
});

test("scheduled retries stop when the global monitor is paused", () => {
  assert.equal(shouldRunCaptureRetry({ source: "scheduled" }, { running: false }), false);
  assert.equal(shouldRunCaptureRetry({ source: "scheduled" }, { running: true }), true);
  assert.equal(shouldRunCaptureRetry({ source: "manual-product" }, { running: false }), true);
});

test("auth-required jobs can be resumed from their persisted scope", async () => {
  await enqueueCaptureOperation({ source: "auth-resume-test", operationType: "monitor", productIds: ["auth-product"] }, async () => ({
    run: { status: "failed", items: [{ productId: "auth-product", status: "failed", message: "没有可用的普通账号，请先授权" }] },
  }));
  const paused = (await getCaptureQueueStatus()).jobs.find((job) => job.source === "auth-resume-test");
  assert.equal(paused?.status, "auth-required");

  await resumeCaptureJob(paused.id, { operation: async () => ({
    run: { status: "success", items: [{ productId: "auth-product", status: "success" }] },
  }) });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const resumed = (await getCaptureQueueStatus()).jobs.find((job) => job.id === paused.id);
    if (resumed?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal((await getCaptureQueueStatus()).jobs.find((job) => job.id === paused.id)?.status, "completed");
  await clearFinishedCaptureJobs();
});

test("a Tmall price authorization failure pauses instead of entering timed retries", async () => {
  await enqueueCaptureOperation({ source: "tmall-auth-required-test", operationType: "monitor", productIds: ["tmall-auth-product"] }, async () => ({
    run: { status: "failed", items: [{ productId: "tmall-auth-product", status: "failed", message: "淘宝账号仍在线，但天猫优惠价格授权未同步；本次未保存价格，请在账号授权中重新授权后重试。" }] },
  }));
  const paused = (await getCaptureQueueStatus()).jobs.find((job) => job.source === "tmall-auth-required-test");
  assert.equal(paused?.status, "auth-required");
  assert.equal(paused?.nextAttemptAt, null);
  await clearFinishedCaptureJobs();
});

test("an optional media login failure stops once without becoming an auth task", async () => {
  await enqueueCaptureOperation({ source: "optional-materials-no-retry", operationType: "product", productIds: ["media-product"], captureKind: "materials" }, async () => ({
    run: { status: "failed", items: [{ productId: "media-product", status: "failed", message: "账号登录已明确失效：商品页跳转到淘宝登录页。" }] },
  }));
  const job = (await getCaptureQueueStatus()).jobs.find((item) => item.source === "optional-materials-no-retry");
  assert.equal(job?.status, "failed");
  assert.equal(job?.attempt, 1);
  assert.equal(job?.nextAttemptAt, null);
  assert.match(job?.message || "", /未自动重试/);
  await clearFinishedCaptureJobs();
});

test("a temporary product login redirect never enters automatic retries", async () => {
  assert.equal(captureFailureRequiresManualRetry("商品页临时跳转登录/验证，但账号检测仍有效，本次未保存价格。"), true);
  await enqueueCaptureOperation({ source: "temporary-login-no-retry", operationType: "product", productIds: ["price-product"], captureKind: "price" }, async () => ({
    run: { status: "failed", items: [{ productId: "price-product", status: "failed", message: "商品页临时跳转登录/验证，但账号检测仍有效，本次未保存价格。" }] },
  }));
  const job = (await getCaptureQueueStatus()).jobs.find((item) => item.source === "temporary-login-no-retry");
  assert.equal(job?.status, "failed");
  assert.equal(job?.attempt, 1);
  assert.equal(job?.nextAttemptAt, null);
  assert.match(job?.message || "", /未自动重试/);
  await clearFinishedCaptureJobs();
});

test("platform access restrictions never enter automatic retries", () => {
  assert.equal(captureFailureRequiresManualRetry("淘宝已限制当前账号访问，本次抓取已停止。"), true);
  assert.equal(captureFailureRequiresManualRetry("访问行为存在异常，涉嫌不当获取使用平台商业信息，包括爬虫工具、违规浏览器插件。"), true);
  assert.equal(captureFailureRequiresManualRetry("TAOBAO_ACCESS_RESTRICTED"), true);
});

test("transient capture retries use the fixed 1, 5, and 15 minute sequence", () => {
  const now = Date.parse("2026-07-18T08:00:00.000Z");
  assert.deepEqual(nextCaptureRetry(0, now), { waitMs: 60_000, nextAttemptAt: "2026-07-18T08:01:00.000Z" });
  assert.deepEqual(nextCaptureRetry(1, now), { waitMs: 300_000, nextAttemptAt: "2026-07-18T08:05:00.000Z" });
  assert.deepEqual(nextCaptureRetry(2, now), { waitMs: 900_000, nextAttemptAt: "2026-07-18T08:15:00.000Z" });
  assert.equal(nextCaptureRetry(3, now), null);
});

test("optional media captures never auto-retry or pause for authorization", () => {
  for (const captureKind of ["materials", "buyer-show"]) {
    assert.equal(captureJobAllowsAutomaticRetry({ captureKind }), false);
    assert.equal(captureJobCanRequireAuthorization({ captureKind }), false);
  }
  assert.equal(captureJobAllowsAutomaticRetry({ captureKind: "price" }), true);
  assert.equal(captureJobCanRequireAuthorization({ captureKind: "price" }), true);
});

test("material merge updates media without changing any price evidence", () => {
  const previous = {
    capturedAt: "2026-07-18T08:00:00.000Z",
    mainImage800: "https://img.alicdn.com/old.jpg",
    normalPrice: 139,
    skuPrices: [{ skuId: "sku-1", name: "标准款", normalPrice: 139, image: "https://img.alicdn.com/old-sku.jpg", priceResolution: { channels: { normal: { status: "verified", valueCents: 13900 } } } }],
  };
  const captured = {
    capturedAt: "2026-07-18T09:00:00.000Z",
    mainImage800: "https://img.alicdn.com/new.jpg",
    gallery750Images: ["https://img.alicdn.com/gallery.jpg"],
    videoUrls: ["https://cloud.video.taobao.com/video.mp4"],
    normalPrice: 1,
    browserEvidenceId: "material-evidence",
    browserEvidenceFile: "capture-evidence/material.source.txt",
    skuPrices: [{ skuId: "sku-1", normalPrice: 1, image: "https://img.alicdn.com/new-sku.jpg" }],
  };

  const merged = mergeCapturedMaterials(previous, captured);
  assert.equal(merged.capturedAt, previous.capturedAt);
  assert.equal(merged.normalPrice, 139);
  assert.equal(merged.skuPrices[0].normalPrice, 139);
  assert.equal(merged.skuPrices[0].priceResolution.channels.normal.valueCents, 13900);
  assert.equal(merged.skuPrices[0].image, "https://img.alicdn.com/new-sku.jpg");
  assert.equal(merged.mainImage800, "https://img.alicdn.com/new.jpg");
  assert.equal(merged.materialEvidenceFile, "capture-evidence/material.source.txt");
});

test("batch material orchestration never changes price history, alerts, Feishu state, or shadow rounds", async () => {
  const productId = "material-isolation-product";
  const itemId = "880001";
  const originalSnapshot = {
    id: "material-isolation-snapshot",
    productId,
    ...verifiedSnapshot(itemId, 139),
    capturedAt: "2026-07-18T08:00:00.000Z",
    mainImage800: "https://img.alicdn.com/old-main.jpg",
    gallery750Images: ["https://img.alicdn.com/old-gallery.jpg"],
    detailImages: ["https://img.alicdn.com/old-detail.jpg"],
    videoUrls: [],
  };
  const alertState = { normal: { [`${itemId}-sku`]: { normal: { below: true, lowestCents: 13900 } } } };
  const notification = { id: "material-isolation-log", productId, status: "sent", message: "existing" };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "素材隔离商品",
      accountType: "normal",
      enabled: false,
      mainImage: originalSnapshot.mainImage800,
      lastSnapshot: structuredClone(originalSnapshot),
    });
    db.snapshots.push(structuredClone(originalSnapshot));
    db.alertStates[productId] = structuredClone(alertState);
    db.notificationLogs.push(notification);
    db.priceEngine = { ...db.priceEngine, shadowRoundsCompleted: 7, lastShadowRunAt: "2026-07-18T07:00:00.000Z" };
    db.feishu = { ...db.feishu, enabled: true, documentEnabled: true, documentId: "doc-existing", lastDocumentSyncAt: "2026-07-18T07:30:00.000Z" };
    db.monitor.lastRunAt = "2026-07-18T07:45:00.000Z";
    return db;
  });
  const before = await readDb();
  const session = { id: "material-isolation-session", name: "普通账号", accountType: "normal", source: "taobao-browser", enabled: true, loginStatus: "valid" };
  let receivedCandidate = null;
  const result = await runCaptureBatchOnce({
    source: "material-isolation-test",
    productIds: [productId],
    includeDisabled: true,
    captureKind: "materials",
    authSessions: [session],
    scraper: async (candidate) => {
      receivedCandidate = candidate;
      return {
        itemId,
        capturedAt: "2026-07-18T09:00:00.000Z",
        mainImage800: "https://img.alicdn.com/new-main.jpg",
        gallery750Images: ["https://img.alicdn.com/new-gallery.jpg"],
        detailImages: ["https://img.alicdn.com/new-detail.jpg"],
        videoUrls: ["https://cloud.video.taobao.com/new-video.mp4"],
        price: 1,
        skuPrices: [{ skuId: `${itemId}-sku`, normalPrice: 1, image: "https://img.alicdn.com/new-sku.jpg" }],
      };
    },
  });
  const after = await readDb();
  const beforeProduct = before.products.find((product) => product.id === productId);
  const afterProduct = after.products.find((product) => product.id === productId);
  const beforeSnapshots = before.snapshots.filter((snapshot) => snapshot.productId === productId);
  const afterSnapshots = after.snapshots.filter((snapshot) => snapshot.productId === productId);
  const priceProjection = (snapshot) => ({
    capturedAt: snapshot.capturedAt,
    price: snapshot.price,
    priceRange: snapshot.priceRange,
    skuPrices: snapshot.skuPrices.map(({ image: _image, ...sku }) => sku),
  });

  assert.equal(result.run.status, "success");
  assert.equal(receivedCandidate.captureBuyerShows, false);
  assert.equal(receivedCandidate.captureMediaAssets, true);
  assert.equal(afterSnapshots.length, beforeSnapshots.length);
  assert.deepEqual(priceProjection(afterProduct.lastSnapshot), priceProjection(beforeProduct.lastSnapshot));
  assert.deepEqual(priceProjection(afterSnapshots[0]), priceProjection(beforeSnapshots[0]));
  assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
  assert.deepEqual(after.notificationLogs, before.notificationLogs);
  assert.deepEqual(after.feishu, before.feishu);
  assert.deepEqual(after.priceEngine, before.priceEngine);
  assert.equal(after.monitor.lastRunAt, before.monitor.lastRunAt);
  assert.equal(afterProduct.lastSnapshot.mainImage800, "https://img.alicdn.com/new-main.jpg");
  assert.deepEqual(afterProduct.lastSnapshot.detailImages, ["https://img.alicdn.com/new-detail.jpg"]);
  assert.deepEqual(afterProduct.lastSnapshot.videoUrls, ["https://cloud.video.taobao.com/new-video.mp4"]);
  await assert.rejects(runMonitorOnce({ productIds: [productId], captureKind: "materials" }), /只接受 price/);
  await clearFinishedCaptureJobs();
});

test("runProductOnce routes buyer-show work to its isolated scraper without adding a price trend point", async () => {
  const productId = "buyer-show-dispatch-product";
  const itemId = "880002";
  const snapshot = { id: "buyer-show-dispatch-snapshot", productId, ...verifiedSnapshot(itemId, 159) };
  await updateDb((db) => {
    db.products.push({ id: productId, itemId, url: `https://detail.tmall.com/item.htm?id=${itemId}`, name: "买家秀隔离商品", accountType: "normal", enabled: false, lastSnapshot: structuredClone(snapshot) });
    db.snapshots.push(structuredClone(snapshot));
    return db;
  });
  const before = await readDb();
  let calls = 0;
  const result = await runProductOnce(productId, {
    captureKind: "buyer-show",
    authSessions: [{ id: "buyer-show-session", name: "普通账号", accountType: "normal", source: "taobao-browser", enabled: true, loginStatus: "valid" }],
    scraper: async () => {
      calls += 1;
      const items = [{ id: "rate-real", text: "真实评价", images: ["https://img.alicdn.com/rate.jpg"], videoUrls: [] }];
      return { capture: { status: "complete", source: "test", itemId, items, capturedAt: new Date().toISOString() }, items, interactions: [] };
    },
  });
  const after = await readDb();

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.capture.status, "complete");
  assert.equal(after.snapshots.filter((item) => item.productId === productId).length, before.snapshots.filter((item) => item.productId === productId).length);
  assert.equal(after.products.find((product) => product.id === productId).lastSnapshot.skuPrices[0].normalPrice, 159);
  assert.equal(after.products.find((product) => product.id === productId).lastSnapshot.buyerShows[0].id, "rate-real");
  await assert.rejects(runProductOnce(productId, { captureKind: "full" }), /不支持的抓取类型/);
  await clearFinishedCaptureJobs();
});

test("search main image updates only its independent product channel", async () => {
  const productId = "search-main-image-product";
  const itemId = "1062991546966";
  const snapshot = { id: "search-main-image-snapshot", productId, ...verifiedSnapshot(itemId, 139) };
  const session = { id: "search-image-session", name: "普通账号", accountType: "normal", source: "taobao-browser", enabled: true, loginStatus: "valid" };
  await updateDb((db) => {
    db.products.push({ id: productId, itemId, url: `https://detail.tmall.com/item.htm?id=${itemId}`, name: "搜索主图隔离商品", accountType: "normal", enabled: false, lastSnapshot: structuredClone(snapshot) });
    db.snapshots.push(structuredClone(snapshot));
    return db;
  });
  const before = await readDb();
  const result = await runSearchMainImageOnce(productId, {
    authSessions: [session],
    scraper: async () => ({
      searchMainImage: "https://img.alicdn.com/bao/uploaded/i2/search-main.jpg",
      searchMainImageStatus: "verified",
      searchMainImageSource: "taobao-search-exact-item-card",
      searchMainImageCapturedAt: "2026-07-21T00:00:00.000Z",
      searchMainImageEvidenceId: "capture_1234567890abcdef1234567890abcdef",
      searchMainImageEvidenceFile: "capture-evidence/search.source.txt",
      searchMainImageLocalFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessedAfterCapture: false },
      searchMainImageError: "",
    }),
  });
  const after = await readDb();
  const saved = after.products.find((product) => product.id === productId);
  assert.equal(result.ok, true);
  assert.equal(saved.searchMainImage, "https://img.alicdn.com/bao/uploaded/i2/search-main.jpg");
  assert.deepEqual(saved.lastSnapshot, before.products.find((product) => product.id === productId).lastSnapshot);
  assert.equal(after.snapshots.filter((item) => item.productId === productId).length, before.snapshots.filter((item) => item.productId === productId).length);
  const cached = await runSearchMainImageOnce(productId, {
    authSessions: [],
    scraper: async () => { throw new Error("不应再次打开搜索页"); },
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.product.searchMainImage, saved.searchMainImage);
});

test("local material reparse reads saved evidence and changes media fields only", async () => {
  const productId = "local-reparse-material-product";
  const itemId = "880011";
  const skuId = `${itemId}-sku`;
  const originalSnapshot = {
    id: "local-reparse-material-snapshot",
    productId,
    ...verifiedSnapshot(itemId, 139),
    materialEvidenceId: null,
    mainImage800: "https://img.alicdn.com/imgextra/i1/2200000000000/old-main.jpg",
    detailImages: ["https://img.alicdn.com/imgextra/i2/2200000000000/old-detail.jpg"],
  };
  const mainImage = "https://img.alicdn.com/imgextra/i1/2200000000000/new-main-item_pic.jpg";
  const detailImage = "https://img.alicdn.com/imgextra/i2/2200000000000/new-detail.jpg";
  const videoUrl = "https://cloud.video.taobao.com/play/u/2200000000000/p/2/e/6/t/1/material.mp4";
  const savedEvidence = await saveBrowserCaptureSource({
    evidencePurpose: "materials",
    itemId,
    capturedAt: "2026-07-21T09:00:00.000Z",
    page: {
      html: `<html><body><div class="gallery"><img class="thumbnailPic" src="${mainImage}"></div><div class="descV8"><img src="${detailImage}"><video src="${videoUrl}"></video></div><script>window.__DATA__=${JSON.stringify({ skuBase: { props: [], skus: [{ skuId, propPath: "" }] }, skuCore: { sku2info: { [skuId]: { quantity: 8 } } } })}</script></body></html>`,
      visibleText: "素材本地解析",
      finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
      statusCode: 200,
      source: "browser",
      accessVerified: true,
      networkPayloads: [],
      mediaObservations: { galleryImages: [mainImage], detailImages: [detailImage], videoUrls: [videoUrl] },
    },
  });
  const alertState = { normal: { [skuId]: { normal: { below: true, lowestCents: 13900 } } } };
  const notification = { id: "local-reparse-material-log", productId, status: "sent", message: "existing" };
  await updateDb((db) => {
    originalSnapshot.materialEvidenceId = savedEvidence.captureId;
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "素材本地重解析商品",
      accountType: "normal",
      enabled: false,
      skuMonitorRules: { [skuId]: { normal: 138 } },
      lastSnapshot: structuredClone(originalSnapshot),
    });
    db.snapshots.push(structuredClone(originalSnapshot));
    db.alertStates[productId] = structuredClone(alertState);
    db.notificationLogs.push(notification);
    return db;
  });
  const before = await readDb();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("local material reparse must not use the network");
  };
  try {
    const result = await reparseProductLocalEvidence(productId, "materials");
    const after = await readDb();
    const beforeProduct = before.products.find((item) => item.id === productId);
    const afterProduct = after.products.find((item) => item.id === productId);
    assert.equal(result.ok, true);
    assert.equal(networkCalls, 0);
    assert.match(result.message, /未访问淘宝，价格和提醒未改动/);
    assert.equal(afterProduct.lastSnapshot.normalPrice, beforeProduct.lastSnapshot.normalPrice);
    assert.deepEqual(afterProduct.lastSnapshot.skuPrices.map(({ image: _image, ...sku }) => sku), beforeProduct.lastSnapshot.skuPrices.map(({ image: _image, ...sku }) => sku));
    assert.deepEqual(afterProduct.skuMonitorRules, beforeProduct.skuMonitorRules);
    assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
    assert.deepEqual(after.notificationLogs, before.notificationLogs);
    assert.deepEqual(after.feishu, before.feishu);
    assert.equal(after.snapshots.filter((item) => item.productId === productId).length, 1);
    assert.equal(afterProduct.lastSnapshot.mainImage800, mainImage);
    assert.deepEqual(afterProduct.lastSnapshot.detailImages, [detailImage]);
    assert.deepEqual(afterProduct.lastSnapshot.videoUrls, [videoUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local buyer-show reparse updates reviews without changing price, thresholds, or alerts", async () => {
  const productId = "local-reparse-buyer-show-product";
  const itemId = "880012";
  const skuId = `${itemId}-sku`;
  const reviewImage = "https://img.alicdn.com/imgextra/i3/2200000000000/review.jpg";
  const savedEvidence = await saveBrowserCaptureSource({
    evidencePurpose: "buyer-show",
    itemId,
    capturedAt: "2026-07-21T09:05:00.000Z",
    page: {
      html: `<html><body><script>window.__DATA__={"sellerId":"2200000000000"}</script></body></html>`,
      visibleText: "买家秀本地解析",
      finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
      statusCode: 200,
      source: "browser",
      accessVerified: true,
      networkPayloads: [{
        url: `https://rate.tmall.com/list_detail_rate.htm?itemId=${itemId}`,
        responseKind: "buyer-show",
        body: JSON.stringify({ rateDetail: { rateCount: { total: 1 }, rateList: [{ id: "review-local-1", feedback: "实拍效果很好，细节清楚。", feedPicList: [reviewImage], skuValueStr: "标准款" }] } }),
      }],
    },
  });
  const snapshot = {
    id: "local-reparse-buyer-show-snapshot",
    productId,
    ...verifiedSnapshot(itemId, 159),
    buyerShowEvidenceId: savedEvidence.captureId,
    buyerShows: [],
  };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "买家秀本地重解析商品",
      accountType: "normal",
      enabled: false,
      skuMonitorRules: { [skuId]: { normal: 158 } },
      lastSnapshot: structuredClone(snapshot),
    });
    db.snapshots.push(structuredClone(snapshot));
    db.alertStates[productId] = { normal: { [skuId]: { normal: { below: false, lowestCents: 15900 } } } };
    return db;
  });
  const before = await readDb();
  const result = await reparseProductLocalEvidence(productId, "buyer-show");
  const after = await readDb();
  const beforeProduct = before.products.find((item) => item.id === productId);
  const afterProduct = after.products.find((item) => item.id === productId);
  assert.equal(result.ok, true);
  assert.match(result.message, /未访问淘宝，价格和提醒未改动/);
  assert.equal(afterProduct.lastSnapshot.buyerShows[0].id, "review-local-1");
  assert.deepEqual(afterProduct.lastSnapshot.buyerShows[0].images, [reviewImage]);
  assert.equal(afterProduct.lastSnapshot.normalPrice, beforeProduct.lastSnapshot.normalPrice);
  assert.deepEqual(afterProduct.lastSnapshot.skuPrices, beforeProduct.lastSnapshot.skuPrices);
  assert.deepEqual(afterProduct.skuMonitorRules, beforeProduct.skuMonitorRules);
  assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
  assert.deepEqual(after.feishu, before.feishu);
  assert.equal(after.snapshots.filter((item) => item.productId === productId).length, 1);
});

test("local search-image reparse updates only the exact product image channel", async () => {
  const productId = "local-reparse-search-image-product";
  const itemId = "880013";
  const exactImage = "https://g-search1.alicdn.com/img/bao/uploaded/i2/exact-local-search.jpg";
  const savedEvidence = await saveBrowserCaptureSource({
    evidencePurpose: "search-main-image",
    itemId,
    capturedAt: "2026-07-21T09:10:00.000Z",
    page: {
      html: `<main><article><a href="https://detail.tmall.com/item.htm?id=${itemId}"><img data-src="${exactImage}_400x400.jpg_.webp"></a></article></main>`,
      visibleText: "搜索结果本地解析",
      finalUrl: "https://s.taobao.com/search?q=local-test",
      statusCode: 200,
      source: "browser",
      accessVerified: true,
      networkPayloads: [],
    },
  });
  const snapshot = { id: "local-reparse-search-image-snapshot", productId, ...verifiedSnapshot(itemId, 179) };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "搜索主图本地重解析商品",
      accountType: "normal",
      enabled: false,
      searchMainImage: "",
      searchMainImageEvidenceId: savedEvidence.captureId,
      lastSnapshot: structuredClone(snapshot),
    });
    db.snapshots.push(structuredClone(snapshot));
    return db;
  });
  const before = await readDb();
  const result = await reparseProductLocalEvidence(productId, "search-main-image");
  const after = await readDb();
  const beforeProduct = before.products.find((item) => item.id === productId);
  const afterProduct = after.products.find((item) => item.id === productId);
  assert.equal(result.ok, true);
  assert.match(result.message, /未访问淘宝/);
  assert.equal(afterProduct.searchMainImage, exactImage);
  assert.equal(afterProduct.searchMainImageStatus, "verified");
  assert.deepEqual(afterProduct.lastSnapshot, beforeProduct.lastSnapshot);
  assert.deepEqual(afterProduct.skuMonitorRules, beforeProduct.skuMonitorRules);
  assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
  assert.deepEqual(after.feishu, before.feishu);
  assert.equal(after.snapshots.filter((item) => item.productId === productId).length, 1);
});

test("local evidence reparse implementation cannot invoke a browser capture path", () => {
  const source = reparseProductLocalEvidence.toString();
  assert.doesNotMatch(source, /scrapeTmall|withProtectedBrowserCapture|fetch\s*\(/);
  assert.doesNotMatch(source, /notifyBelowThreshold|prepareThresholdAlert|drainNotificationOutbox|syncPriceWorkbook/);
  assert.match(source, /readBrowserCaptureSource/);
});

test("a material access restriction stops fallback and buyer shows in the same browser environment", async () => {
  resetTmallPriceCircuitForTests();
  const productId = "cross-lane-restriction-product";
  const itemId = "880003";
  const snapshot = { id: "cross-lane-restriction-snapshot", productId, ...verifiedSnapshot(itemId, 169) };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "跨队列保护商品",
      accountType: "normal",
      enabled: false,
      lastSnapshot: structuredClone(snapshot),
    });
    db.snapshots.push(structuredClone(snapshot));
    return db;
  });
  const sessions = [
    { id: "restricted-material-a", source: "taobao-browser", accountType: "normal", browserProfileKey: "restricted-material-a", browserPort: 9241, browserEngine: "uc", loginStatus: "valid" },
    { id: "restricted-material-b", source: "taobao-browser", accountType: "normal", browserProfileKey: "restricted-material-b", browserPort: 9242, browserEngine: "uc", loginStatus: "valid" },
  ];
  let materialCalls = 0;
  const materials = await runCaptureBatchOnce({
    source: "cross-lane-restriction-materials",
    productIds: [productId],
    includeDisabled: true,
    captureKind: "materials",
    authSessions: sessions,
    scraper: async () => {
      materialCalls += 1;
      const error = new Error("淘宝已限制当前账号访问，本次抓取已停止；全局自动监控保持原设置。");
      error.code = "TAOBAO_ACCESS_RESTRICTED";
      error.retryAfterMs = 60_000;
      throw error;
    },
  });
  assert.equal(materialCalls, 1);
  assert.equal(materials.run.status, "failed");

  let buyerShowCalls = 0;
  const buyerShow = await runProductOnce(productId, {
    source: "cross-lane-restriction-buyer-show",
    captureKind: "buyer-show",
    authSessions: [{ id: "restricted-buyer-c", source: "taobao-browser", accountType: "normal", browserProfileKey: "restricted-buyer-c", browserPort: 9243, browserEngine: "uc", loginStatus: "valid" }],
    scraper: async () => {
      buyerShowCalls += 1;
      return { capture: { status: "complete", items: [] }, items: [], interactions: [] };
    },
  });
  assert.equal(buyerShowCalls, 0);
  assert.equal(buyerShow.ok, false);
  resetTmallPriceCircuitForTests();
  await clearFinishedCaptureJobs();
});

function verifiedSku(sku, channels = ["normal"]) {
  const fields = { normal: "normalPrice", government: "governmentPrice", surprise: "surprisePrice", gift: "giftPrice", vip88: "vipPrice", coin: "coinPrice" };
  return {
    ...sku,
    resolutionStatus: "verified",
    priceResolution: {
      status: "verified",
      channels: Object.fromEntries(channels.map((kind) => [kind, { status: "verified", valueCents: Math.round(Number(sku[fields[kind]] ?? sku.price) * 100), evidenceIds: [`${kind}-evidence`] }])),
    },
  };
}

function completePriceSnapshot(skuPrices, extra = {}) {
  const verifiedPriceSkuCount = skuPrices.filter((sku) => sku.resolutionStatus === "verified" && sku.priceResolution?.channels?.normal?.status === "verified").length;
  return {
    accessMode: "authenticated",
    resolutionStatus: "verified",
    ...extra,
    skuPrices,
    rawSignals: {
      ...(extra.rawSignals || {}),
      observedSkuCount: skuPrices.length,
      outputSkuCount: skuPrices.length,
      verifiedPriceSkuCount,
    },
    localFirst: extra.localFirst || { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true },
  };
}

function verifiedSnapshot(itemId, price = 99) {
  const sku = verifiedSku({ skuId: `${itemId}-sku`, name: "标准款", price, normalPrice: price });
  return completePriceSnapshot([sku], {
    capturedAt: new Date().toISOString(),
    itemId,
    title: `商品 ${itemId}`,
    shopName: "测试店铺",
    price,
    priceRange: `¥${price.toFixed(2)}`,
    buyerShows: [],
    buyerShowCapture: { status: "skipped", items: [] },
  });
}

function browserPriceEvidence(itemId, skuCases, capturedSkuIds = skuCases.map(({ skuId }) => skuId)) {
  const allSkuIds = skuCases.map(({ skuId }) => skuId);
  const priceBySku = new Map(skuCases.map((item) => [item.skuId, item.price]));
  const htmlFor = (selectedSkuId) => `<script>window.__DATA__=${JSON.stringify({
    itemId,
    skuBase: { props: [], skus: allSkuIds.map((skuId) => ({ skuId, propPath: "" })) },
    skuCore: {
      sku2info: Object.fromEntries(allSkuIds.map((skuId) => [skuId, {
        price: { priceText: "199", priceTitle: "优惠前" },
        ...(skuId === selectedSkuId ? { subPrice: { priceText: String(priceBySku.get(skuId)), priceTitle: "店铺优惠后" } } : {}),
        quantity: 1,
      }])),
    },
  })}</script>`;
  return {
    itemId,
    accountType: "normal",
    requestedUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
    finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
    page: {
      html: htmlFor(capturedSkuIds.at(-1) || allSkuIds[0]),
      visibleText: "本地价格重放证据",
      finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
      statusCode: 200,
      source: "browser",
      accessVerified: true,
      networkPayloads: [],
      selectionResults: [],
      skuSnapshots: capturedSkuIds.map((skuId, index) => ({
        skuId,
        selected: true,
        capturedAt: `2026-07-22T09:00:0${index}.000Z`,
        html: htmlFor(skuId),
        visibleText: `${skuId} 店铺优惠后 ${priceBySku.get(skuId)}`,
        finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
      })),
    },
  };
}

function partialPriceSnapshot({ productId, itemId, evidenceId, evidenceFile, skuCases }) {
  const [first, second] = skuCases;
  return completePriceSnapshot([
    verifiedSku({ skuId: first.skuId, name: first.name, price: 99, normalPrice: 99, image: "https://img.alicdn.com/old-first.jpg", accountPrices: [
      { sessionId: "price-replay-normal", accountName: "普通账号", accountType: "normal", capturedAt: "2026-07-22T08:00:00.000Z", price: 99, normalPrice: 99, resolutionStatus: "verified", priceResolution: { status: "verified", channels: { normal: { status: "verified", valueCents: 9900 } } } },
      { sessionId: "price-replay-gift", accountName: "礼金账号", accountType: "gift", capturedAt: "2026-07-22T08:00:00.000Z", price: 91, normalPrice: 99, giftPrice: 91, resolutionStatus: "verified", priceResolution: { status: "verified", channels: { normal: { status: "verified", valueCents: 9900 }, gift: { status: "verified", valueCents: 9100 } } } },
    ] }, ["normal"]),
    {
      skuId: second.skuId,
      name: second.name,
      price: null,
      normalPrice: null,
      image: "https://img.alicdn.com/old-second.jpg",
      resolutionStatus: "unavailable",
      priceResolution: {
        status: "unavailable",
        reason: "supported-endpoint-not-observed",
        channels: { normal: { status: "unavailable", valueCents: null } },
      },
    },
  ], {
    id: `${productId}-snapshot`,
    productId,
    itemId,
    title: "已有商品标题",
    shopName: "已有店铺",
    model: "已有型号",
    price: 99,
    priceRange: [99, 99],
    capturedAt: "2026-07-22T08:00:00.000Z",
    resolutionStatus: "partial",
    browserEvidenceId: evidenceId,
    browserEvidenceFile: evidenceFile,
    mainImage800: "https://img.alicdn.com/old-main.jpg",
    detailImages: ["https://img.alicdn.com/old-detail.jpg"],
    buyerShows: [{ id: "saved-review", text: "保留的买家秀", images: [], videoUrls: [] }],
    buyerShowCapture: { status: "complete", items: [{ id: "saved-review", text: "保留的买家秀", images: [], videoUrls: [] }] },
    primaryAccountType: "normal",
    primaryAccountSessionId: "price-replay-normal",
    accountCaptures: [
      { sessionId: "price-replay-normal", accountName: "普通账号", accountType: "normal", primary: true, capturedAt: "2026-07-22T08:00:00.000Z", price: 99, priceRange: [99, 99], resolutionStatus: "partial", skuCount: 2, verifiedSkuCount: 1 },
      { sessionId: "price-replay-gift", accountName: "礼金账号", accountType: "gift", primary: false, capturedAt: "2026-07-22T08:00:00.000Z", price: 91, priceRange: [91, 91], resolutionStatus: "verified", skuCount: 2, verifiedSkuCount: 2 },
    ],
    rawSignals: {
      observedSkuCount: 2,
      outputSkuCount: 2,
      verifiedPriceSkuCount: 1,
      materialImageCount: 2,
      buyerShowCount: 1,
    },
  });
}

test("local price reparse repairs a partial card only from its saved browser evidence", async () => {
  const productId = "local-reparse-price-product";
  const itemId = "880014";
  const skuCases = [
    { skuId: "62749714800141", name: "标准款", price: 139 },
    { skuId: "62749714800142", name: "加大款", price: 169 },
  ];
  const savedEvidence = await saveBrowserCaptureSource(browserPriceEvidence(itemId, skuCases));
  const partialSnapshot = partialPriceSnapshot({ productId, itemId, evidenceId: savedEvidence.captureId, evidenceFile: savedEvidence.sourceFile, skuCases });
  const alertState = { normal: { [skuCases[0].skuId]: { normal: { below: false, lowestCents: 9900 } } } };
  const notification = { id: "local-reparse-price-notification", productId, status: "sent", message: "existing" };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "已有商品标题",
      shopName: "已有店铺",
      model: "已有型号",
      accountType: "normal",
      enabled: true,
      monitorIntervalMinutes: 45,
      skuMonitorPrices: { [skuCases[0].skuId]: 120 },
      skuMonitorRules: { [skuCases[0].skuId]: { normal: 120, gift: 90 } },
      lastStatus: "error",
      lastError: "2 个 SKU 中仅 1 个已验证",
      lastSnapshot: structuredClone(partialSnapshot),
    });
    db.snapshots.push(structuredClone(partialSnapshot));
    db.alertStates[productId] = structuredClone(alertState);
    db.notificationLogs.push(notification);
    db.feishu = { ...db.feishu, enabled: true, documentEnabled: true, documentId: "doc-local-replay" };
    db.runs.push({ id: "local-reparse-price-run", source: "existing" });
    return db;
  });
  const before = await readDb();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("local price reparse must not access the network");
  };
  try {
    const result = await reparseProductLocalEvidence(productId, "price");
    const after = await readDb();
    const afterProduct = after.products.find((item) => item.id === productId);
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(networkCalls, 0);
    assert.deepEqual(result.coverage, { applicable: true, totalSkuCount: 2, verifiedSkuCount: 2, unresolvedSkuCount: 0, complete: true });
    assert.match(result.message, /未打开浏览器、未触发提醒或飞书/);
    assert.equal(afterProduct.lastStatus, "ok");
    assert.equal(afterProduct.lastError, "");
    assert.deepEqual(afterProduct.skuMonitorPrices, before.products.find((item) => item.id === productId).skuMonitorPrices);
    assert.deepEqual(afterProduct.skuMonitorRules, before.products.find((item) => item.id === productId).skuMonitorRules);
    assert.equal(afterProduct.monitorIntervalMinutes, 45);
    assert.deepEqual(afterProduct.lastSnapshot.skuPrices.map((sku) => [sku.skuId, sku.normalPrice]), skuCases.map((sku) => [sku.skuId, sku.price]));
    assert.equal(afterProduct.lastSnapshot.resolutionStatus, "verified");
    assert.equal(afterProduct.lastSnapshot.mainImage800, partialSnapshot.mainImage800);
    assert.deepEqual(afterProduct.lastSnapshot.detailImages, partialSnapshot.detailImages);
    assert.deepEqual(afterProduct.lastSnapshot.buyerShows, partialSnapshot.buyerShows);
    assert.equal(afterProduct.lastSnapshot.skuPrices[0].image, "https://img.alicdn.com/old-first.jpg");
    assert.equal(afterProduct.lastSnapshot.skuPrices[0].accountPrices.find((view) => view.sessionId === "price-replay-normal").normalPrice, 139);
    assert.equal(afterProduct.lastSnapshot.skuPrices[0].accountPrices.find((view) => view.sessionId === "price-replay-gift").giftPrice, 91);
    assert.equal(afterProduct.lastSnapshot.accountCaptures.find((capture) => capture.sessionId === "price-replay-normal").resolutionStatus, "verified");
    assert.equal(after.snapshots.filter((snapshot) => snapshot.productId === productId).length, 1);
    assert.deepEqual(after.snapshots.find((snapshot) => snapshot.productId === productId).skuPrices.map((sku) => [sku.skuId, sku.normalPrice]), skuCases.map((sku) => [sku.skuId, sku.price]));
    assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
    assert.deepEqual(after.notificationLogs, before.notificationLogs);
    assert.deepEqual(after.feishu, before.feishu);
    assert.deepEqual(after.runs, before.runs);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local price reparse keeps the current card untouched when saved evidence is still incomplete", async () => {
  const productId = "local-reparse-price-incomplete-product";
  const itemId = "880015";
  const skuCases = [
    { skuId: "62749714800151", name: "标准款", price: 139 },
    { skuId: "62749714800152", name: "加大款", price: 169 },
  ];
  const savedEvidence = await saveBrowserCaptureSource(browserPriceEvidence(itemId, skuCases, [skuCases[0].skuId]));
  const partialSnapshot = partialPriceSnapshot({ productId, itemId, evidenceId: savedEvidence.captureId, evidenceFile: savedEvidence.sourceFile, skuCases });
  await updateDb((db) => {
    db.products.push({
      id: productId,
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      name: "不可覆盖的部分卡片",
      accountType: "normal",
      enabled: true,
      skuMonitorRules: { [skuCases[0].skuId]: { normal: 120 } },
      lastStatus: "error",
      lastError: "旧的部分解析失败",
      lastSnapshot: structuredClone(partialSnapshot),
    });
    db.snapshots.push(structuredClone(partialSnapshot));
    db.alertStates[productId] = { normal: { [skuCases[0].skuId]: { normal: { below: false, lowestCents: 9900 } } } };
    return db;
  });
  const before = await readDb();
  const result = await reparseProductLocalEvidence(productId, "price");
  const after = await readDb();
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.coverage.complete, false);
  assert.match(result.message, /未覆盖现有卡片、监控价、历史快照或提醒/);
  assert.deepEqual(after.products.find((item) => item.id === productId), before.products.find((item) => item.id === productId));
  assert.deepEqual(after.snapshots.filter((snapshot) => snapshot.productId === productId), before.snapshots.filter((snapshot) => snapshot.productId === productId));
  assert.deepEqual(after.alertStates[productId], before.alertStates[productId]);
});

test("deleted products and changed identities reject an in-flight capture before commit", async () => {
  const session = { id: "commit-session", name: "普通测试账号", accountType: "normal", source: "taobao-browser", active: true, enabled: true, loginStatus: "valid" };

  async function runConflictCase({ productId, initialItemId, mutate }) {
    const initialUrl = `https://detail.tmall.com/item.htm?id=${initialItemId}`;
    await updateDb((db) => {
      db.products.push({ id: productId, url: initialUrl, itemId: initialItemId, name: productId, accountType: "normal", enabled: false, skuMonitorRules: {} });
      return db;
    });
    let release;
    let started;
    const captureStarted = new Promise((resolve) => { started = resolve; });
    const capture = runProductOnce(productId, {
      source: `commit-conflict-${productId}`,
      authSessions: [session],
      scraper: async () => {
        started();
        await new Promise((resolve) => { release = resolve; });
        return verifiedSnapshot(initialItemId);
      },
    });
    await captureStarted;
    await updateDb((db) => {
      mutate(db);
      return db;
    });
    release();
    const result = await capture;
    assert.equal(result.run.status, "failed");
    assert.match(result.run.items[0].message, /抓取期间|旧结果未保存/);
    return readDb();
  }

  const afterDelete = await runConflictCase({
    productId: "deleted-during-capture",
    initialItemId: "10001",
    mutate: (db) => { db.products = db.products.filter((product) => product.id !== "deleted-during-capture"); },
  });
  assert.equal(afterDelete.snapshots.some((snapshot) => snapshot.productId === "deleted-during-capture"), false);
  assert.equal(afterDelete.alertStates?.["deleted-during-capture"], undefined);

  const afterChange = await runConflictCase({
    productId: "changed-during-capture",
    initialItemId: "20001",
    mutate: (db) => {
      db.products = db.products.map((product) => product.id === "changed-during-capture"
        ? { ...product, url: "https://detail.tmall.com/item.htm?id=20002", itemId: "20002" }
        : product);
    },
  });
  assert.equal(afterChange.snapshots.some((snapshot) => snapshot.productId === "changed-during-capture"), false);
  assert.equal(afterChange.products.find((product) => product.id === "changed-during-capture")?.itemId, "20002");
  assert.match(captureCommitConflict(afterChange.products.find((product) => product.id === "changed-during-capture"), { product: { url: "https://detail.tmall.com/item.htm?id=20001" }, snapshot: { itemId: "20001" } }), /变化/);
  await clearFinishedCaptureJobs();
});

test("per-product schedules inherit the global interval and allow an override", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const monitor = { running: true, intervalMinutes: 60 };
  assert.equal(resolveProductIntervalMinutes({}, 60), 60);
  assert.equal(resolveProductIntervalMinutes({ monitorIntervalMinutes: 120 }, 60), 120);
  assert.equal(scheduleProduct({ id: "a", enabled: true }, monitor, { now }).nextMonitorAt, "2026-07-12T09:00:00.000Z");
  assert.equal(scheduleProduct({ id: "b", enabled: true, monitorIntervalMinutes: 120 }, monitor, { now }).nextMonitorAt, "2026-07-12T10:00:00.000Z");
  assert.equal(scheduleProduct({ id: "c", enabled: false }, monitor, { now }).nextMonitorAt, null);
  assert.equal(scheduleProduct({ id: "d", enabled: true }, { ...monitor, running: false }, { now }).enabled, true);
  assert.deepEqual(scheduleProduct({ id: "local", enabled: true, captureMode: "local-only" }, monitor, { now }), {
    id: "local",
    enabled: false,
    captureMode: "local-only",
    nextMonitorAt: null,
  });
});

test("default schedules use six daily windows with a stable per-product spread", () => {
  const localNow = new Date(2026, 6, 18, 7, 30, 0, 0).getTime();
  const monitor = { running: true, intervalMinutes: 60, scheduleWindows: ["08:00", "11:00", "14:00", "17:00", "20:00", "23:00"] };
  const product = { id: "stable-product", enabled: true };
  const offset = productWindowOffsetMinutes(product);
  const expected = new Date(2026, 6, 18, 8, offset, 0, 0).toISOString();
  assert.equal(scheduleProduct(product, monitor, { now: localNow }).nextMonitorAt, expected);
  assert.equal(nextWindowScheduleAt(product, monitor.scheduleWindows, localNow), expected);
  assert.equal(productWindowOffsetMinutes(product), offset);
  assert.ok(offset >= 0 && offset < 25);
});

test("explicit intervals continue to override window scheduling", () => {
  const now = Date.parse("2026-07-18T00:00:00.000Z");
  const product = { id: "interval-product", enabled: true, monitorIntervalMinutes: 90 };
  const monitor = { running: true, intervalMinutes: 60, scheduleWindows: ["08:00"] };
  assert.equal(scheduleProduct(product, monitor, { now }).nextMonitorAt, "2026-07-18T01:30:00.000Z");
});

test("single-run and interval schedules are mutually exclusive", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const once = { enabled: true, monitorScheduleMode: "once", monitorIntervalMinutes: 120, monitorStartAt: "2026-07-12T08:30:00.000Z" };
  const interval = { enabled: true, monitorScheduleMode: "interval", monitorIntervalMinutes: 120, monitorStartAt: "2026-07-12T05:00:00.000Z" };
  assert.equal(resolveProductScheduleMode(once), "once");
  assert.equal(resolveProductScheduleMode({}), "interval");
  assert.equal(nextProductScheduleAt(once, 60, now), "2026-07-12T08:30:00.000Z");
  assert.equal(nextProductScheduleAt(interval, 60, now), "2026-07-12T10:00:00.000Z");
  assert.equal(nextProductScheduleAt({ enabled: true }, 60, now), "2026-07-12T09:00:00.000Z");
});

test("capture completion preserves monitor prices and settings saved while capture was running", () => {
  const current = {
    id: "p1",
    name: "旧标题",
    enabled: false,
    accountType: "vip88",
    captureBuyerShows: false,
    captureMediaAssets: true,
    monitorScheduleMode: "once",
    monitorStartAt: "2026-07-16T10:00:00.000Z",
    skuMonitorPrices: { sku1: 139.99, sku2: 159 },
  };
  const captured = {
    ...current,
    name: "抓取后的标题",
    enabled: true,
    accountType: "normal",
    captureBuyerShows: true,
    captureMediaAssets: false,
    skuMonitorPrices: {},
    mainImage: "main.jpg",
    lastStatus: "ok",
    lastError: "",
    lastSnapshot: { capturedAt: "2026-07-16T09:00:00.000Z" },
    updatedAt: "2026-07-16T09:00:00.000Z",
  };

  const merged = mergeCapturedProduct(current, captured);

  assert.equal(merged.name, "抓取后的标题");
  assert.equal(merged.mainImage, "main.jpg");
  assert.equal(merged.lastStatus, "ok");
  assert.deepEqual(merged.skuMonitorPrices, { sku1: 139.99, sku2: 159 });
  assert.equal(merged.enabled, false);
  assert.equal(merged.accountType, "vip88");
  assert.equal(merged.captureBuyerShows, false);
  assert.equal(merged.captureMediaAssets, true);
  assert.equal(merged.monitorScheduleMode, "once");
});

test("SKU monitor price updates merge independently and support clearing one SKU", () => {
  const first = setSkuMonitorPrice({ id: "p1", monitorPrice: 99, skuMonitorPrices: { sku1: 139 } }, "sku2", 159);
  const second = setSkuMonitorPrice(first, "sku1", 138.99);
  const cleared = setSkuMonitorPrice(second, "sku2", null);

  assert.deepEqual(first.skuMonitorPrices, { sku1: 139, sku2: 159 });
  assert.deepEqual(second.skuMonitorPrices, { sku1: 138.99, sku2: 159 });
  assert.deepEqual(cleared.skuMonitorPrices, { sku1: 138.99 });
  assert.equal(cleared.monitorPrice, null);
});

test("global pause preserves a single-run time and resume restores that exact time", () => {
  const anchor = "2026-07-12T05:00:00.000Z";
  const product = { id: "anchored", enabled: true, monitorScheduleMode: "once", monitorIntervalMinutes: 120, monitorStartAt: anchor };
  const paused = scheduleProduct(product, { running: false, intervalMinutes: 60 }, { reset: true, now: Date.parse("2026-07-12T08:00:00.000Z") });
  assert.equal(paused.monitorStartAt, anchor);
  assert.equal(paused.nextMonitorAt, null);
  const resumed = scheduleProduct(paused, { running: true, intervalMinutes: 60 }, { reset: true, now: Date.parse("2026-07-12T10:00:00.000Z") });
  assert.equal(resumed.monitorStartAt, anchor);
  assert.equal(resumed.nextMonitorAt, anchor);
});

test("a completed single-run schedule pauses only that product", () => {
  const once = { id: "once", enabled: true, monitorScheduleMode: "once", monitorStartAt: "2026-07-12T08:30:00.000Z", nextMonitorAt: "2026-07-12T08:30:00.000Z" };
  const completed = completeScheduledProduct(once, { running: true, intervalMinutes: 60 }, Date.parse("2026-07-12T08:31:00.000Z"));
  assert.equal(completed.enabled, false);
  assert.equal(completed.monitorStartAt, null);
  assert.equal(completed.nextMonitorAt, null);
});

test("due product selection is ordered and excludes paused or future products", () => {
  const now = Date.parse("2026-07-12T08:00:00.000Z");
  const products = [
    { id: "future", enabled: true, nextMonitorAt: "2026-07-12T08:30:00.000Z" },
    { id: "second", enabled: true, nextMonitorAt: "2026-07-12T07:59:00.000Z" },
    { id: "first", enabled: true, nextMonitorAt: "2026-07-12T07:58:00.000Z" },
    { id: "paused", enabled: false, nextMonitorAt: "2026-07-12T07:00:00.000Z" },
  ];
  assert.deepEqual(dueProductIds(products, now), ["first", "second"]);
  assert.equal(earliestProductSchedule(products, { running: true, intervalMinutes: 60 }, now), "2026-07-12T07:58:00.000Z");
  assert.equal(earliestProductSchedule(products, { running: false, intervalMinutes: 60 }, now), null);
});

test("orderedCaptureCandidates preserves the requested batch order", () => {
  const products = [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "c", enabled: true }];
  assert.deepEqual(orderedCaptureCandidates(products, ["c", "a", "b"], true).map((product) => product.id), ["c", "a", "b"]);
});

test("historicalPrimaryImages recovers canonical search images without activity images", () => {
  const canonical = "https://img.alicdn.com/imgextra/i4/1/example-0-item_pic.jpg";
  const activity = "https://gw.alicdn.com/imgextra/example-0-picasso.jpg";
  assert.deepEqual(historicalPrimaryImages([
    { productId: "a", capturedAt: "2026-07-11T11:00:00.000Z", mainImage800: canonical },
    { productId: "a", capturedAt: "2026-07-11T12:00:00.000Z", mainImage800: activity },
    { productId: "b", capturedAt: "2026-07-11T13:00:00.000Z", mainImage800: "https://img.alicdn.com/imgextra/i4/2/other-0-item_pic.jpg" },
  ], "a"), [canonical]);
});

test("historicalProductMedia preserves verified gallery and video assets", () => {
  assert.deepEqual(historicalProductMedia([
    { productId: "p1", capturedAt: "2026-01-01", gallery750Images: ["g1", "g2"], videoUrls: ["v1"] },
    { productId: "p1", capturedAt: "2026-01-02", gallery750Images: ["g1"], videoUrls: [] },
    { productId: "p2", capturedAt: "2026-01-03", gallery750Images: ["other"], videoUrls: ["other"] },
  ], "p1"), {
    galleryImages: ["g1", "g2"],
    videoUrls: ["v1"],
  });
});

test("a failed current capture never inherits a historical verified price", () => {
  const previous = { productId: "p", capturedAt: "2026-01-01", skuPrices: [verifiedSku({ skuId: "a", price: 529, normalPrice: 529, surprisePrice: 489 }, ["normal", "surprise"])] };
  const current = { productId: "p", capturedAt: "2026-01-02", skuPrices: [{ skuId: "a", price: 489, normalPrice: 489, resolutionStatus: "ambiguous" }], rawSignals: {} };
  assert.equal(preserveVerifiedAccountPrices(current, previous, "normal"), current);
  assert.equal(current.skuPrices[0].normalPrice, 489);
  assert.equal(historicalAccountPriceSnapshot([previous, current], "p", "normal").capturedAt, "2026-01-01");
});

test("stale or invalid account benefits are not inherited by a new capture", () => {
  const previous = { capturedAt: "2026-01-01", skuPrices: [{ skuId: "a", price: 179, normalPrice: 179, giftPrice: 126, giftInference: { normalPrice: 179 } }] };
  const current = { capturedAt: "2026-01-02", skuPrices: [{ skuId: "a", price: 629, normalPrice: 629, giftPrice: null }], rawSignals: {} };
  const restored = preserveVerifiedAccountPrices(current, previous, "gift");

  assert.equal(restored.skuPrices[0].normalPrice, 629);
  assert.equal(restored.skuPrices[0].giftPrice, null);
  assert.equal(historicalAccountPriceSnapshot([{ productId: "p", capturedAt: "2026-01-03", skuPrices: [{ skuId: "a", normalPrice: 179, giftPrice: 629 }] }], "p", "gift"), null);
});

test("historical lookup ignores newer unverified snapshots", () => {
  const verified = { productId: "p", capturedAt: "2026-07-12", skuPrices: [verifiedSku({ skuId: "a", normalPrice: 459 })] };
  const ambiguous = { productId: "p", capturedAt: "2026-07-13", skuPrices: [{ skuId: "a", normalPrice: 489, resolutionStatus: "ambiguous" }] };
  assert.equal(historicalAccountPriceSnapshot([verified, ambiguous], "p", "normal"), verified);
});

test("account merge accepts explicit gift evidence and never uses a bare cross-account difference", () => {
  const normal = {
    price: 139,
    priceRange: [139, 159],
    skuPrices: [139, 159].map((normalPrice, index) => verifiedSku({ skuId: `sku-${index + 1}`, price: normalPrice, normalPrice, priceLayers: [], discountItems: [] }, ["normal"])),
    rawSignals: {},
  };
  const gift = {
    price: 139,
    priceRange: [139, 159],
    skuPrices: [126, 146].map((giftPrice, index) => verifiedSku({ skuId: `sku-${index + 1}`, price: [139, 159][index], normalPrice: [139, 159][index], giftPrice, giftStatus: "available", giftDiscountAmount: 13, priceLayers: [], discountItems: [] }, ["normal", "gift"])),
    rawSignals: {},
  };
  const normalSession = { id: "normal", name: "普通账号", accountType: "normal" };
  const giftSession = { id: "gift", name: "礼金账号", accountType: "gift" };
  const merged = mergeAccountSnapshots([
    { session: giftSession, snapshot: gift },
    { session: normalSession, snapshot: normal },
  ]);

  assert.deepEqual(merged.skuPrices.map((sku) => ({ normal: sku.normalPrice, gift: sku.giftPrice })), [
    { normal: 139, gift: 126 },
    { normal: 159, gift: 146 },
  ]);
  const guessed = mergeAccountSnapshots([
    { session: giftSession, snapshot: { ...gift, skuPrices: [{ skuId: "sku-1", price: 126, normalPrice: 126 }] } },
    { session: normalSession, snapshot: normal },
  ]);
  assert.equal(guessed.skuPrices[0].giftPrice, undefined);
});

test("account merge keeps the primary SKU unchanged and stores each account as an isolated view", () => {
  const resolution = (accountType, giftCents) => ({
    status: "verified",
    accountType,
    channels: {
      normal: { status: "verified", valueCents: 10900, evidenceIds: [`${accountType}-normal`] },
      gift: { status: "verified", valueCents: giftCents, evidenceIds: [`${accountType}-gift`] },
    },
    evidence: [
      { id: `${accountType}-normal`, kind: "normal", valueCents: 10900 },
      { id: `${accountType}-gift`, kind: "gift", valueCents: giftCents },
    ],
  });
  const normalSku = { skuId: "sku-1", price: 109, normalPrice: 109, giftPrice: 102, resolutionStatus: "verified", priceResolution: resolution("normal", 10200), priceLayers: [{ label: "普通价", value: 109 }, { label: "礼金价", value: 102 }] };
  const giftSku = { skuId: "sku-1", price: 109, normalPrice: 109, giftPrice: 94, resolutionStatus: "verified", priceResolution: resolution("gift", 9400), priceLayers: [{ label: "普通价", value: 109 }, { label: "礼金价", value: 94 }] };
  const snapshot = mergeAccountSnapshots([
    { session: { id: "normal", accountType: "normal" }, snapshot: { skuPrices: [normalSku], rawSignals: {} } },
    { session: { id: "gift", accountType: "gift" }, snapshot: { skuPrices: [giftSku], rawSignals: {} } },
  ], { primarySessionId: "normal" });
  const [merged] = snapshot.skuPrices;

  assert.equal(snapshot.primaryAccountSessionId, "normal");
  assert.equal(merged.giftPrice, 102);
  assert.equal(merged.priceResolution.channels.gift.valueCents, 10200);
  assert.equal(merged.accountPrices[0].priceResolution.channels.gift.valueCents, 10200);
  assert.equal(merged.accountPrices[1].priceResolution.channels.gift.valueCents, 9400);
  assert.deepEqual(merged.priceResolution.evidence.filter((item) => item.kind === "gift").map((item) => item.valueCents), [10200]);
  assert.deepEqual(merged.priceLayers.filter((item) => item.label === "礼金价").map((item) => item.value), [102]);
});

test("switchable account views keep their own public and benefit channels", () => {
  const normalSku = verifiedSku({
    skuId: "sku-1", normalPrice: 139, governmentPrice: 119, governmentStatus: "available",
    priceCalculation: { government: "普通账号国补 119" },
    priceLayers: [{ label: "普通价", value: 139 }, { label: "国补价", value: 119 }],
  }, ["normal", "government"]);
  const giftSku = verifiedSku({
    skuId: "sku-1", normalPrice: 139, governmentPrice: 109, governmentStatus: "available", giftPrice: 99,
    priceCalculation: { government: "礼金账号国补 109", gift: "礼金价 99" },
    priceLayers: [{ label: "普通价", value: 139 }, { label: "国补价", value: 109 }, { label: "礼金价", value: 99 }],
  }, ["normal", "government", "gift"]);
  const [merged] = mergeAccountSnapshots([
    { session: { id: "normal", accountType: "normal" }, snapshot: { skuPrices: [normalSku], rawSignals: {} } },
    { session: { id: "gift", accountType: "gift" }, snapshot: { skuPrices: [giftSku], rawSignals: {} } },
  ], { primarySessionId: "gift" }).skuPrices;

  assert.equal(merged.normalPrice, 139);
  assert.equal(merged.governmentPrice, 109);
  assert.equal(merged.priceCalculation.government, "礼金账号国补 109");
  assert.deepEqual(merged.priceLayers.filter((item) => item.label === "国补价").map((item) => item.value), [109]);
  const normalView = merged.accountPrices.find((view) => view.sessionId === "normal");
  const giftView = merged.accountPrices.find((view) => view.sessionId === "gift");
  assert.equal(normalView.governmentPrice, 119);
  assert.equal(normalView.giftPrice, null);
  assert.equal(giftView.governmentPrice, 109);
  assert.equal(giftView.giftPrice, 99);
});

test("a secondary account list price never replaces the primary account price", () => {
  const normal = { price: 179, priceRange: [179, 179], skuPrices: [{ skuId: "sku-1", price: 179, normalPrice: 179, priceLayers: [], discountItems: [] }], rawSignals: {} };
  const gift = { price: 629, priceRange: [629, 629], skuPrices: [{ skuId: "sku-1", price: 629, normalPrice: 629, originalPrice: 629, giftPrice: 629, giftStatus: "available", priceLayers: [{ label: "礼金价", value: 629, kind: "price" }], discountItems: [] }], rawSignals: {} };
  const [sku] = mergeAccountSnapshots([
    { session: { id: "gift", accountType: "gift" }, snapshot: gift },
    { session: { id: "normal", accountType: "normal" }, snapshot: normal },
  ], { primarySessionId: "normal" }).skuPrices;

  assert.equal(sku.normalPrice, 179);
  assert.equal(sku.giftPrice, undefined);
  assert.equal(sku.accountPrices.find((view) => view.sessionId === "gift").normalPrice, 629);
});

test("daily capture selects only the requested account type while full view selection stays explicit", () => {
  const sessions = [
    { id: "n1", accountType: "normal" },
    { id: "n2", accountType: "normal" },
    { id: "g1", accountType: "gift" },
    { id: "v1", accountType: "vip88" },
  ];
  assert.deepEqual(sessionsForProduct(sessions, "gift").map((session) => session.id), ["g1"]);
  assert.deepEqual(sessionsForProduct(sessions, "vip88").map((session) => session.id), ["v1"]);
  assert.deepEqual(sessionsForProduct(sessions, "gift", 0, "all").map((session) => session.id), ["g1", "v1", "n1", "n2"]);
});

test("capture refuses anonymous fallback when no scanned account is available", async () => {
  const normal = await captureProduct({ id: "p-normal", accountType: "normal" }, []);
  assert.equal(normal.snapshot, null);
  assert.match(normal.product.lastError, /没有可用的普通账号/);
});

test("incomplete public price evidence keeps the scanned account online", async () => {
  const session = {
    id: "session-public-shell",
    name: "扫码账号",
    accountType: "normal",
    source: "taobao-browser",
    browserProfileKey: "profile-public-shell",
    browserPort: 9517,
    loginStatus: "valid",
    healthStatus: "healthy",
  };
  const result = await captureProduct({ id: "p-public-shell", accountType: "normal" }, [session], {
    scraper: async () => ({
      accessMode: "authenticated",
      resolutionStatus: "unavailable",
      capturedAt: "2026-07-22T08:00:00.000Z",
      itemId: "1059717807069",
      buyerShows: [],
      buyerShowCapture: { status: "skipped", items: [] },
      localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true },
      rawSignals: { observedSkuCount: 1, outputSkuCount: 1, verifiedPriceSkuCount: 0 },
      skuPrices: [{
        skuId: "sku-1",
        normalPrice: null,
        resolutionStatus: "unavailable",
        priceResolution: { status: "unavailable", channels: { normal: { status: "unavailable", valueCents: null } } },
      }],
    }),
  });

  assert.equal(result.snapshot.skuPrices[0].normalPrice, null);
  assert.equal(result.snapshot.skuPrices[0].resolutionStatus, "unavailable");
  assert.match(result.product.lastError, /1 个 SKU 中仅 0 个具备当前可闭合价格证据/);
  assert.equal(session.loginStatus, "valid");
  assert.equal(session.healthStatus, "healthy");
});

for (const accountType of ["normal", "gift", "vip88"]) {
  test(`${accountType} capture rejects a Tmall price-login gate without erasing the previous snapshot`, async () => {
    const previousSnapshot = { capturedAt: "2026-07-17T08:00:00.000Z", skuPrices: [{ skuId: "old-sku", normalPrice: 139 }] };
    const session = {
      id: `session-${accountType}`,
      name: `${accountType}账号`,
      accountType,
      source: "taobao-browser",
      loginStatus: "valid",
      healthStatus: "healthy",
    };
    const result = await captureProduct({ id: `product-${accountType}`, accountType, lastSnapshot: previousSnapshot }, [session], {
      scraper: async () => {
        const error = new Error("淘宝账号仍在线，但天猫优惠价格授权未同步；本次未保存价格，请在账号授权中重新授权后重试。");
        error.code = "TMALL_PRICE_AUTH_REQUIRED";
        throw error;
      },
    });

    assert.equal(result.snapshot, null);
    assert.equal(result.product.lastSnapshot, previousSnapshot);
    assert.equal(result.product.lastStatus, "error");
    assert.match(result.product.lastError, /天猫优惠价格授权未同步/);
    assert.equal(session.loginStatus, "valid");
    assert.equal(session.healthStatus, "degraded");
    assert.equal(session.tmallPriceStatus, undefined);
    assert.equal(session.tmallPriceCooldownUntil, undefined);
    resetTmallPriceCircuitForTests();
  });
}

test("a Tmall price gate retries the next account on every capture", async () => {
  resetTmallPriceCircuitForTests();
  const sessions = [
    { id: "gate-primary", name: "普通账号 A", accountType: "normal", source: "taobao-browser", browserProfileKey: "gate-profile-a", browserPort: 9517, loginStatus: "valid" },
    { id: "gate-fallback", name: "普通账号 B", accountType: "normal", source: "taobao-browser", browserProfileKey: "gate-profile-b", browserPort: 9518, loginStatus: "valid" },
  ];
  let scraperCalls = 0;
  const gateScraper = async () => {
    scraperCalls += 1;
    const error = new Error("淘宝账号仍在线，但天猫优惠价格授权未同步；本次未保存价格。");
    error.code = "TMALL_PRICE_AUTH_REQUIRED";
    throw error;
  };

  const first = await captureProduct({ id: "gate-product-1", accountType: "normal" }, sessions, { scraper: gateScraper });
  const second = await captureProduct({ id: "gate-product-2", accountType: "normal" }, sessions, { scraper: gateScraper });

  assert.equal(first.snapshot, null);
  assert.equal(second.snapshot, null);
  assert.equal(scraperCalls, 4);
  assert.match(second.product.lastError, /天猫优惠价格授权未同步/);
  assert.equal(sessions[0].loginStatus, "valid");
  assert.equal(sessions[0].tmallPriceStatus, undefined);
  assert.equal(sessions[1].tmallPriceStatus, undefined);
  resetTmallPriceCircuitForTests();
});

test("an account access restriction blocks later attempts in the same browser environment", async () => {
  resetTmallPriceCircuitForTests();
  const sessions = [
    { id: "restricted-primary", name: "普通账号 A", accountType: "normal", source: "taobao-browser", browserProfileKey: "restricted-profile-a", browserPort: 9521, browserEngine: "uc", loginStatus: "valid" },
    { id: "restricted-fallback", name: "普通账号 B", accountType: "normal", source: "taobao-browser", browserProfileKey: "restricted-profile-b", browserPort: 9522, browserEngine: "uc", loginStatus: "valid" },
  ];
  let scraperCalls = 0;
  const restrictedScraper = async () => {
    scraperCalls += 1;
    const error = new Error("淘宝已限制当前账号访问，本次抓取已停止；全局自动监控保持原设置。");
    error.code = "TAOBAO_ACCESS_RESTRICTED";
    error.retryAfterMs = 60_000;
    throw error;
  };

  const first = await captureProduct({ id: "restricted-product-1", accountType: "normal" }, sessions, { scraper: restrictedScraper });
  const second = await captureProduct({ id: "restricted-product-2", accountType: "normal" }, sessions, { scraper: restrictedScraper });

  assert.equal(first.snapshot, null);
  assert.equal(second.snapshot, null);
  assert.equal(scraperCalls, 1);
  assert.equal(sessions[0].tmallPriceFailureReason, "TAOBAO_ACCESS_RESTRICTED");
  assert.match(second.product.lastError, /淘宝访问限制保护中/);
  assert.equal(sessions[1].tmallPriceStatus, "cooldown");
  resetTmallPriceCircuitForTests();
});

test("browser price evidence is rejected unless the reloaded local source was sanitized", async () => {
  resetTmallPriceCircuitForTests();
  const session = {
    id: "unsanitized-account",
    name: "普通账号",
    accountType: "normal",
    source: "taobao-browser",
    browserProfileKey: "unsanitized-profile",
    browserPort: 9523,
    loginStatus: "valid",
  };
  const snapshot = verifiedSnapshot("unsanitized-product", 99);
  snapshot.localFirst.sourceSanitized = false;

  const result = await captureProduct({ id: "unsanitized-product", accountType: "normal" }, [session], {
    scraper: async () => snapshot,
  });

  assert.equal(result.snapshot, null);
  assert.match(result.product.lastError, /未完成脱敏落盘和本地重新解析/);
  resetTmallPriceCircuitForTests();
});

test("local-only products never invoke the browser scraper", async () => {
  let scraperCalls = 0;
  const result = await captureProduct({
    id: "local-only-product",
    name: "本地数据商品",
    captureMode: "local-only",
    accountType: "normal",
  }, [{ id: "session-1", name: "账号", accountType: "normal" }], {
    scraper: async () => {
      scraperCalls += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(scraperCalls, 0);
  assert.equal(result.snapshot, null);
  assert.match(result.product.lastError, /本地数据模式.*阻止浏览器抓取/);
});

test("daily capture never lets another account type replace the configured primary account", async () => {
  const sessions = [
    { id: "normal", name: "普通账号", accountType: "normal", loginStatus: "valid" },
    { id: "vip", name: "88VIP账号", accountType: "vip88", loginStatus: "valid" },
    { id: "gift", name: "礼金账号", accountType: "gift", loginStatus: "valid", healthStatus: "healthy" },
  ];
  const attempts = [];
  const scraper = async (candidate, session) => {
    attempts.push({ accountType: session.accountType, buyerShows: candidate.captureBuyerShows, media: candidate.captureMediaAssets });
    if (session.accountType === "normal") throw new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
    if (session.accountType === "gift") throw new Error("页面未返回可验证的 SKU 普通价。");
    return {
      accessMode: "authenticated",
      capturedAt: "2026-07-16T08:00:00.000Z",
      title: "测试商品",
      skuPrices: [verifiedSku({ skuId: "sku-1", name: "白色", normalPrice: 139, surprisePrice: 129 }, ["normal", "surprise"])],
      buyerShows: [],
      rawSignals: {},
    };
  };

  const result = await captureProduct({ id: "p-fallback", accountType: "normal", captureBuyerShows: true, captureMediaAssets: true }, sessions, { scraper });

  assert.equal(result.product.lastStatus, "error");
  assert.equal(result.product.accountType, "normal");
  assert.equal(result.snapshot, null);
  assert.deepEqual(attempts, [
    { accountType: "normal", buyerShows: true, media: true },
  ]);
  assert.equal(sessions[0].loginStatus, "expired");
  assert.equal(sessions[2].healthStatus, "healthy");
});

test("explicit all-account capture keeps the configured primary and stores secondary views only", async () => {
  const sessions = [
    { id: "normal", name: "普通账号", accountType: "normal", loginStatus: "valid" },
    { id: "vip", name: "88VIP账号", accountType: "vip88", loginStatus: "valid" },
    { id: "gift", name: "礼金账号", accountType: "gift", loginStatus: "valid" },
  ];
  const attempts = [];
  const scraper = async (candidate, session) => {
    attempts.push({ accountType: session.accountType, buyerShows: candidate.captureBuyerShows, media: candidate.captureMediaAssets });
    if (session.accountType === "gift") throw new Error("礼金页面临时未返回价格数据。");
    const channels = session.accountType === "vip88" ? ["normal", "vip88"] : ["normal"];
    return completePriceSnapshot([verifiedSku({ skuId: "sku-1", name: "白色", normalPrice: 139, vipPrice: session.accountType === "vip88" ? 129 : null }, channels)], {
      capturedAt: "2026-07-18T08:00:00.000Z",
      title: "测试商品",
      buyerShows: [],
    });
  };

  const result = await captureProduct({ id: "p-all", accountType: "normal", captureBuyerShows: true, captureMediaAssets: true }, sessions, { scraper, accountMode: "all" });

  assert.equal(result.product.lastStatus, "ok");
  assert.equal(result.product.accountType, "normal");
  assert.equal(result.snapshot.primaryAccountSessionId, "normal");
  assert.deepEqual(result.snapshot.accountCaptures.map((capture) => capture.sessionId), ["normal", "vip"]);
  assert.deepEqual(attempts, [
    { accountType: "normal", buyerShows: true, media: true },
    { accountType: "vip88", buyerShows: false, media: false },
    { accountType: "gift", buyerShows: false, media: false },
  ]);
  assert.equal(result.snapshot.accountErrors[0].accountName, "礼金账号");
});

test("a partial SKU round saves verified SKUs while keeping unresolved SKUs unavailable", async () => {
  const productId = "partial-preserve-product";
  const itemId = "843315272777";
  const session = { id: "partial-preserve-session", name: "普通账号", accountType: "normal", source: "taobao-browser", loginStatus: "valid", healthStatus: "healthy" };
  await updateDb((db) => {
    db.products.push({
      id: productId,
      name: "完整性测试商品",
      itemId,
      url: `https://detail.tmall.com/item.htm?id=${itemId}`,
      accountType: "normal",
      enabled: false,
      skuMonitorRules: {
        [`${itemId}-sku`]: { normal: 100 },
        [`${itemId}-missing`]: { normal: 200 },
      },
    });
    return db;
  });

  const first = await runProductOnce(productId, { source: "complete-before-partial", authSessions: [session], scraper: async () => verifiedSnapshot(itemId, 90) });
  assert.ok(first.snapshot);
  const before = await readDb();
  const snapshotCount = before.snapshots.filter((snapshot) => snapshot.productId === productId).length;
  const verified = verifiedSku({ skuId: `${itemId}-sku`, name: "标准款", normalPrice: 89 });
  const incomplete = completePriceSnapshot([
    verified,
    { skuId: `${itemId}-missing`, name: "未核验规格", normalPrice: null, resolutionStatus: "unavailable", priceResolution: { status: "unavailable", channels: {} } },
  ], { itemId, capturedAt: new Date().toISOString(), resolutionStatus: "partial", buyerShows: [] });

  const second = await runProductOnce(productId, { source: "partial-after-complete", authSessions: [session], scraper: async () => incomplete });
  assert.ok(second.snapshot, second.product.lastError);
  assert.equal(second.product.lastStatus, "error");
  assert.match(second.product.lastError, /2 个 SKU 中仅 1 个/);
  assert.equal(session.loginStatus, "valid");
  assert.equal(session.tmallPriceStatus, "degraded");
  assert.equal(session.tmallPriceFailureReason, "PARTIAL_SKU_PRICE_EVIDENCE:1/2");
  assert.equal(second.snapshot.resolutionStatus, "partial");
  assert.equal(second.snapshot.skuPrices.find((sku) => sku.skuId === `${itemId}-sku`).normalPrice, 89);
  assert.equal(second.snapshot.skuPrices.find((sku) => sku.skuId === `${itemId}-missing`).normalPrice, null);
  const after = await readDb();
  assert.equal(after.snapshots.filter((snapshot) => snapshot.productId === productId).length, snapshotCount + 1);
  assert.equal(after.products.find((product) => product.id === productId).lastSnapshot.resolutionStatus, "partial");
  assert.equal(after.alertStates[productId].normal[`${itemId}-sku`].normal.lastPriceCents, 8900);
  assert.equal(after.alertStates[productId].normal[`${itemId}-missing`].normal.available, false);
  assert.equal(after.alertStates[productId].normal[`${itemId}-missing`].normal.lastPriceCents, null);
});

test("only an explicit Taobao login redirect expires an account", () => {
  assert.equal(isExplicitLoginExpiryError("账号登录已明确失效：商品页跳转到淘宝登录页。"), true);
  assert.equal(isExplicitLoginExpiryError("账号页面需要安全验证，本次抓取已停止，登录状态保留待复检。"), false);
});

test("a product login redirect never retries or mutates the session in the same capture", async () => {
  const session = { tmallPriceStatus: "valid" };
  const attempts = [];
  await assert.rejects(captureWithTransientLoginRetry(session, async (attempt) => {
    attempts.push(attempt);
    throw new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
  }, {
    confirmExpiry: async () => false,
  }), /明确失效/);

  assert.deepEqual(attempts, [0]);
  assert.equal(session.tmallPriceStatus, "valid");
  assert.equal(session.tmallPriceFailureReason, undefined);
});

test("a browser capture login redirect does not open another identity probe or expire the account", async () => {
  const session = {
    browserProfileKey: "profile-88vip",
    browserPort: 9338,
    tmallPriceStatus: "valid",
  };
  const error = await captureWithTransientLoginRetry(session, async () => {
    throw new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
  }).catch((caught) => caught);

  assert.equal(error.captureSessionExpiryChecked, true);
  assert.equal(error.captureSessionExpired, false);
  assert.equal(session.tmallPriceStatus, "valid");
});

test("a product login redirect reports Tmall session degradation without claiming identity expiry", () => {
  const error = new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
  error.captureSessionExpiryChecked = true;
  error.captureSessionExpired = false;

  const failure = explainPriceCaptureFailure(error);
  assert.equal(failure.code, "CAPTURE_TMALL_SESSION_DEGRADED");
  assert.equal(failure.stage, "capture");
  assert.match(failure.message, /账号浏览器保持原样/);
  assert.doesNotMatch(failure.message, /自动重试/);
  assert.doesNotMatch(failure.message, /重新扫码/);
});

test("an explicitly expired account and unrelated failures are never retried", async () => {
  let expiredAttempts = 0;
  await assert.rejects(captureWithTransientLoginRetry({}, async () => {
    expiredAttempts += 1;
    throw new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
  }, { confirmExpiry: async () => true, wait: async () => {} }), /明确失效/);
  assert.equal(expiredAttempts, 1);

  let unrelatedAttempts = 0;
  await assert.rejects(captureWithTransientLoginRetry({}, async () => {
    unrelatedAttempts += 1;
    throw new Error("价格公式未闭合");
  }, { confirmExpiry: async () => false, wait: async () => {} }), /公式未闭合/);
  assert.equal(unrelatedAttempts, 1);
});

test("account capture diagnostics expose failed formulas and unknown promotion codes", () => {
  const diagnostic = accountCaptureDiagnostic([{ session: { accountType: "vip88" }, snapshot: { skuPrices: [{
    skuId: "sku-1",
    resolutionStatus: "ambiguous",
    priceResolution: { reason: "formula-does-not-close", formulaInputs: { promotions: [{ code: "new-code", kind: "unknown" }] } },
  }] } }]);
  assert.match(diagnostic, /vip88 0\/1/);
  assert.match(diagnostic, /formula-does-not-close/);
  assert.match(diagnostic, /new-code/);
});

test("anonymous public-price snapshots never trigger account price alerts", () => {
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "anonymous", resolutionStatus: "verified" }), false);
  assert.equal(snapshotAllowsPriceAlerts({ accessMode: "authenticated", resolutionStatus: "legacy" }), false);
  assert.equal(snapshotAllowsPriceAlerts(completePriceSnapshot([verifiedSku({ skuId: "s1", normalPrice: 90 })])), true);
});

test("verified thresholds notify on first drop, new low, and a new drop after recovery", async () => {
  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  globalThis.fetch = async () => {
    sendCount += 1;
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  try {
    const current = {
      feishu: updateFeishuConfig({}, { enabled: true, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test" }),
      notificationLogs: [],
    };
    const product = { id: "p1", accountType: "normal", name: "测试商品", url: "https://detail.tmall.com/item.htm?id=1", skuMonitorPrices: { s1: 100 } };
    const snapshot = completePriceSnapshot([verifiedSku({ skuId: "s1", name: "标准款", price: 90, normalPrice: 90 })]);

    const firstLogs = await notifyBelowThreshold(current, product, snapshot, "test-first");
    current.notificationLogs.push(...firstLogs);
    const secondLogs = await notifyBelowThreshold(current, product, snapshot, "test-second");
    const lowerLogs = await notifyBelowThreshold(current, product, { ...snapshot, skuPrices: [verifiedSku({ skuId: "s1", name: "标准款", price: 89, normalPrice: 89 })] }, "test-lower");
    await notifyBelowThreshold(current, product, { ...snapshot, skuPrices: [verifiedSku({ skuId: "s1", name: "标准款", price: 100, normalPrice: 100 })] }, "test-recovered");
    const droppedAgainLogs = await notifyBelowThreshold(current, product, snapshot, "test-dropped-again");

    assert.equal(sendCount, 3);
    assert.deepEqual(firstLogs.map((log) => log.status), ["sent"]);
    assert.deepEqual(secondLogs, []);
    assert.deepEqual(lowerLogs.map((log) => log.status), ["sent"]);
    assert.deepEqual(droppedAgainLogs.map((log) => log.status), ["sent"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("alert episodes stay independent when the product primary account type changes", async () => {
  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  globalThis.fetch = async () => {
    sendCount += 1;
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  try {
    const current = {
      feishu: updateFeishuConfig({}, { enabled: true, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test" }),
      notificationLogs: [],
      alertStates: {},
    };
    const product = { id: "account-state", accountType: "normal", name: "测试商品", url: "https://detail.tmall.com/item.htm?id=1", skuMonitorRules: { s1: { normal: 100 } } };
    const normalSnapshot = completePriceSnapshot([verifiedSku({ skuId: "s1", name: "标准款", price: 90, normalPrice: 90 })], { primaryAccountType: "normal" });
    const giftSnapshot = { ...normalSnapshot, primaryAccountType: "gift" };

    assert.equal((await notifyBelowThreshold(current, product, normalSnapshot, "normal-first")).length, 1);
    assert.equal((await notifyBelowThreshold(current, { ...product, accountType: "gift" }, giftSnapshot, "gift-first")).length, 1);
    assert.equal((await notifyBelowThreshold(current, { ...product, accountType: "gift" }, giftSnapshot, "gift-repeat")).length, 0);
    assert.equal(sendCount, 2);
    assert.ok(current.alertStates[product.id].normal.s1.normal);
    assert.ok(current.alertStates[product.id].gift.s1.normal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed Feishu send rolls back the episode so the next success still alerts", async () => {
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 500, text: async () => "temporary failure" };
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  };
  try {
    const current = {
      feishu: updateFeishuConfig({}, { enabled: true, webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test" }),
      notificationLogs: [],
      alertStates: {},
    };
    const product = { id: "feishu-retry", accountType: "normal", name: "测试商品", url: "https://detail.tmall.com/item.htm?id=1", skuMonitorRules: { s1: { normal: 100 } } };
    const snapshot = completePriceSnapshot([verifiedSku({ skuId: "s1", name: "标准款", price: 90, normalPrice: 90 })], { primaryAccountType: "normal" });

    assert.deepEqual((await notifyBelowThreshold(current, product, snapshot, "failed-send")).map((log) => log.status), ["failed"]);
    assert.deepEqual((await notifyBelowThreshold(current, product, snapshot, "successful-retry")).map((log) => log.status), ["sent"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buyer-show history is retained when a new capture only sees sparse text", () => {
  const previous = [{ id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: ["old.mp4"], author: "买家" }];
  const current = [{ id: "stable-1", text: "很好用", images: [], videoUrls: [] }, { id: "rate-1", text: "新评价", images: [], videoUrls: [] }];
  assert.deepEqual(mergeBuyerShowHistory(current, previous), [
    { id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: ["old.mp4"], author: "买家", sku: "", createdAt: "" },
    { id: "rate-1", text: "新评价", images: [], videoUrls: [] },
  ]);
});

test("buyer-show capture keeps same-item history and survives a later failure", () => {
  const previous = {
    itemId: "123",
    capturedAt: "2026-07-12T08:00:00.000Z",
    buyerShows: [{ id: "stable-1", text: "很好用", images: ["old.jpg"], videoUrls: [] }],
    buyerShowCapture: { status: "partial", capturedAt: "2026-07-12T08:00:00.000Z" },
  };
  const partial = preserveBuyerShowHistory({
    itemId: "123",
    capturedAt: "2026-07-13T08:00:00.000Z",
    buyerShows: [{ id: "rate-1", text: "新评价", images: [], videoUrls: [] }],
    buyerShowCapture: { status: "partial", items: [], mediaCount: 0, textOnlyCount: 0, capturedAt: "2026-07-13T08:00:00.000Z" },
  }, previous);
  assert.equal(partial.buyerShows.length, 2);
  assert.equal(partial.buyerShowCapture.items.length, 2);

  const failed = preserveBuyerShowHistory({
    itemId: "123",
    buyerShows: [],
    buyerShowCapture: { status: "failed", items: [] },
  }, partial);
  assert.equal(failed.buyerShowCachedItems.length, 2);
  assert.equal(failed.buyerShowCapture.lastSuccessfulAt, "2026-07-13T08:00:00.000Z");
});

test("buyer-show history is never reused after the monitored item changes", () => {
  const snapshot = preserveBuyerShowHistory({
    itemId: "new",
    buyerShows: [],
    buyerShowCapture: { status: "failed", items: [] },
  }, { itemId: "old", buyerShows: [{ id: "old-review", images: ["old.jpg"], videoUrls: [] }] });
  assert.deepEqual(snapshot.buyerShowCachedItems, []);
});

test("run record is partial when price succeeds but buyer-show capture fails", () => {
  const run = buildRunRecord({
    source: "manual-product",
    scope: "p1",
    startedAt: "2026-07-13T08:00:00.000Z",
    results: [{ snapshot: { buyerShowCapture: { status: "failed" } } }],
  });
  assert.equal(run.status, "partial");
  assert.match(run.message, /买家秀本次未获取/);
  assert.equal(run.items[0].status, "partial");
  assert.match(run.items[0].message, /买家秀失败/);
});

test("run record permanently keeps each failed product reason", () => {
  const run = buildRunRecord({
    source: "manual-batch",
    scope: "selected-products",
    startedAt: "2026-07-15T08:00:00.000Z",
    results: [{
      product: {
        id: "p1",
        name: "失败商品",
        url: "https://detail.tmall.com/item.htm?id=1006331369273",
        accountType: "vip88",
        lastError: "商品身份校验失败：避免串品。",
        updatedAt: "2026-07-15T08:01:00.000Z",
      },
      snapshot: null,
    }],
  });
  assert.deepEqual(run.items[0], {
    productId: "p1",
    requestedItemId: "1006331369273",
    itemId: "",
    name: "失败商品",
    accountType: "vip88",
    status: "failed",
    message: "商品身份校验失败：避免串品。",
    capturedAt: "2026-07-15T08:01:00.000Z",
  });
});

test("run record reports exact partial SKU coverage instead of success", () => {
  const snapshot = completePriceSnapshot([
    verifiedSku({ skuId: "sku-1", normalPrice: 409 }, ["normal"]),
    { skuId: "sku-2", normalPrice: null, resolutionStatus: "unavailable", priceResolution: { status: "unavailable", channels: {} } },
    { skuId: "sku-3", normalPrice: null, resolutionStatus: "ambiguous", priceResolution: { status: "ambiguous", channels: {} } },
  ], {
    resolutionStatus: "partial",
    rawSignals: {
      observedSkuCount: 3,
      outputSkuCount: 3,
      timingsMs: { browserAcquisition: 37_400, localParse: 8 },
    },
  });
  const run = buildRunRecord({
    source: "manual-product",
    scope: "p1",
    startedAt: "2026-07-22T08:00:00.000Z",
    results: [{ product: { id: "p1", accountType: "normal" }, snapshot }],
  });

  assert.equal(run.status, "partial");
  assert.equal(run.success, 0);
  assert.equal(run.partial, 1);
  assert.equal(run.failed, 0);
  assert.match(run.items[0].message, /3 个 SKU，1 个已验证，2 个缺少当前优惠证据/);
  assert.match(run.items[0].message, /浏览器取证 37\.4 秒；本地解析 8 毫秒/);
  assert.deepEqual(snapshotPriceCoverage(snapshot), {
    applicable: true,
    totalSkuCount: 3,
    verifiedSkuCount: 1,
    unresolvedSkuCount: 2,
    complete: false,
  });
  assert.equal(snapshotHasCompleteVerifiedNormalPrices(snapshot), false);
});

test("verified-price guard accepts every account type only with normal SKU evidence", () => {
  for (const accountType of ["normal", "gift", "vip88"]) {
    const complete = completePriceSnapshot([verifiedSku({ skuId: "sku-1", normalPrice: 139 }, ["normal"])], { accountType });
    assert.equal(snapshotHasVerifiedNormalPrice(complete), true);
    assert.equal(snapshotHasCompleteVerifiedNormalPrices(complete), true);
    assert.equal(snapshotHasVerifiedNormalPrice({ ...completePriceSnapshot([verifiedSku({ skuId: "sku-partial", normalPrice: 139 }, ["normal"])], { accountType }), resolutionStatus: "partial" }), true);
    assert.equal(snapshotHasVerifiedNormalPrice({ accessMode: "authenticated", accountType, skuPrices: [{ skuId: "sku-1", resolutionStatus: "ambiguous" }] }), false);
    assert.equal(snapshotHasVerifiedNormalPrice({ ...completePriceSnapshot([verifiedSku({ skuId: "sku-1", normalPrice: 139 }, ["normal"])], { accountType }), accessMode: "anonymous" }), false);
    assert.equal(snapshotHasVerifiedNormalPrice({
      accessMode: "authenticated",
      resolutionStatus: "partial",
      accountType,
      skuPrices: [verifiedSku({ skuId: "sku-1", normalPrice: 139 }, ["normal"]), { skuId: "sku-2", normalPrice: 159, resolutionStatus: "ambiguous" }],
      rawSignals: { observedSkuCount: 2, outputSkuCount: 2, verifiedPriceSkuCount: 1 },
    }), true);
    assert.equal(snapshotHasVerifiedNormalPrice({
      accessMode: "authenticated",
      resolutionStatus: "partial",
      accountType,
      skuPrices: [{ skuId: "sku-2", normalPrice: null, resolutionStatus: "unavailable", priceResolution: { status: "unavailable", channels: {} } }],
      rawSignals: { observedSkuCount: 1, outputSkuCount: 1, verifiedPriceSkuCount: 0 },
    }), false);
  }
});

test("runInCaptureGroups limits concurrency to five and preserves order", async () => {
  let active = 0;
  let maximum = 0;
  const results = await runInCaptureGroups(Array.from({ length: 12 }, (_, index) => index), async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, (12 - value) % 3));
    active -= 1;
    return value;
  });
  assert.equal(maximum, 5);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index));
});

test("account capture lock serializes one browser while other accounts stay parallel", async () => {
  const events = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const sharedBrowserA = { id: "normal", accountType: "normal", browserProfileKey: "shared", browserPort: 9223 };
  const sharedBrowserB = { id: "gift", accountType: "gift", browserProfileKey: "shared", browserPort: 9223 };
  const otherBrowser = { id: "vip", accountType: "vip88", browserProfileKey: "other", browserPort: 9224 };

  const first = withAccountCaptureLock(sharedBrowserA, async () => {
    events.push("shared-first-start");
    markFirstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("shared-first-end");
  });
  await firstStarted;
  const second = withAccountCaptureLock(sharedBrowserB, async () => { events.push("shared-second"); });
  const other = withAccountCaptureLock(otherBrowser, async () => { events.push("other-account"); });
  await other;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["shared-first-start", "other-account"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["shared-first-start", "other-account", "shared-first-end", "shared-second"]);
});

test("account capture lock releases the browser after a failed capture", async () => {
  const session = { id: "normal", browserProfileKey: "recovery", browserPort: 9225 };
  await assert.rejects(withAccountCaptureLock(session, async () => { throw new Error("capture failed"); }), /capture failed/);
  assert.equal(await withAccountCaptureLock(session, async () => "recovered"), "recovered");
});

test("different account profiles capture serially on one device", async () => {
  resetTmallPriceCircuitForTests();
  const events = [];
  let releaseFirst;
  let firstStarted;
  const ready = new Promise((resolve) => { firstStarted = resolve; });
  const firstSession = { id: "protected-a", source: "taobao-browser", browserProfileKey: "protected-a", browserPort: 9231, browserEngine: "uc" };
  const secondSession = { id: "protected-b", source: "taobao-browser", browserProfileKey: "protected-b", browserPort: 9232, browserEngine: "uc" };
  const first = withProtectedBrowserCapture(firstSession, async () => {
    events.push("first-start");
    firstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first-end");
  });
  await ready;
  const second = withProtectedBrowserCapture(secondSession, async () => { events.push("second-start"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
  resetTmallPriceCircuitForTests();
});

test("a stale software price cooldown never blocks a capture", async () => {
  resetTmallPriceCircuitForTests();
  const session = { id: "manual-retry", source: "taobao-browser", browserProfileKey: "manual-retry", browserPort: 9234, browserEngine: "uc" };
  markTmallPriceGate(session, { now: Date.now(), accountCooldownMs: 60_000 });
  let calls = 0;
  const result = await withProtectedBrowserCapture(session, async () => {
    calls += 1;
    return "retried";
  });
  assert.equal(result, "retried");
  assert.equal(calls, 1);
  resetTmallPriceCircuitForTests();
});

test("a persisted access-restriction marker blocks a new attempt in the same browser environment", async () => {
  resetTmallPriceCircuitForTests();
  const session = { id: "restricted-retry", source: "taobao-browser", browserProfileKey: "restricted-retry", browserPort: 9235, browserEngine: "uc" };
  markTmallPriceGate(session, {
    now: Date.now(),
    accountCooldownMs: 60_000,
    deviceCooldownMs: 60_000,
    reason: "TAOBAO_ACCESS_RESTRICTED",
  });
  let calls = 0;
  await assert.rejects(withProtectedBrowserCapture(session, async () => {
    calls += 1;
  }), /淘宝访问限制保护中/);
  assert.equal(calls, 0);
  resetTmallPriceCircuitForTests();
});

test("an account access restriction fails only the current capture", async () => {
  resetTmallPriceCircuitForTests();
  const productId = "restriction-pauses-monitor";
  const before = await readDb();
  const previousMonitor = structuredClone(before.monitor);
  const nextRunAt = new Date(Date.now() + 60_000).toISOString();
  const nextMonitorAt = new Date(Date.now() + 60_000).toISOString();
  await updateDb((db) => {
    db.monitor = { ...db.monitor, running: true, nextRunAt };
    db.products.push({
      id: productId,
      itemId: "880099",
      enabled: true,
      nextMonitorAt,
    });
    return db;
  });

  try {
    const session = { id: "restricted-monitor", source: "taobao-browser", browserProfileKey: "restricted-monitor", browserPort: 9233, browserEngine: "uc" };
    await assert.rejects(withProtectedBrowserCapture(session, async () => {
      const error = new Error("淘宝已限制当前账号访问，本次抓取已停止；全局自动监控保持原设置。");
      error.code = "TAOBAO_ACCESS_RESTRICTED";
      error.retryAfterMs = 60_000;
      throw error;
    }), /本次抓取已停止；全局自动监控保持原设置/);

    const after = await readDb();
    assert.equal(after.monitor.running, true);
    assert.equal(after.monitor.nextRunAt, nextRunAt);
    assert.equal(after.products.find((product) => product.id === productId).enabled, true);
    assert.equal(after.products.find((product) => product.id === productId).nextMonitorAt, nextMonitorAt);
  } finally {
    resetTmallPriceCircuitForTests();
    await updateDb((db) => {
      db.monitor = previousMonitor;
      db.products = db.products.filter((product) => product.id !== productId);
      return db;
    });
  }
});
