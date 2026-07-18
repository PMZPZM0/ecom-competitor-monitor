import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DB_SCHEMA_VERSION, migrateDbDocument } from "./db.js";
import { decryptSecret } from "../services/secretService.js";
import { MODEL_CHANNELS } from "../services/modelConfigService.js";

let temporaryDbImportId = 0;

async function createTemporaryDb(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-monitor-db-"));
  const previousDirectory = process.env.ECOM_MONITOR_DATA_DIR;
  process.env.ECOM_MONITOR_DATA_DIR = directory;
  const moduleUrl = new URL("./db.js", import.meta.url);
  moduleUrl.searchParams.set("test", `${process.pid}-${temporaryDbImportId += 1}`);
  const db = await import(moduleUrl.href);
  await db.readDb();
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
    else process.env.ECOM_MONITOR_DATA_DIR = previousDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { db, directory, dbPath: path.join(directory, "db.json") };
}

function injectedFsError(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

test("database migration preserves user data and marks legacy snapshots", () => {
  const original = {
    products: [{ id: "p1", name: "商品", lastSnapshot: { capturedAt: "2026-01-01", price: 10 } }],
    snapshots: [{ id: "s1", productId: "p1", capturedAt: "2026-01-01", price: 10 }],
    authSessions: [{ id: "a1", cookie: "configured" }],
    feishu: { enabled: true, cooldownEnabled: true, cooldownMinutes: 120, documentId: "doc-1" },
    modelConfig: { baseUrl: MODEL_CHANNELS.stable.baseUrl, model: "gpt-4.1-mini", apiKey: "legacy-secret" },
  };
  const migration = migrateDbDocument(original);

  assert.equal(migration.migrated, true);
  assert.equal(migration.data.schemaVersion, DB_SCHEMA_VERSION);
  assert.equal(migration.data.products[0].name, "商品");
  assert.equal(migration.data.products[0].lastSnapshot.parserVersion, "legacy");
  assert.equal(migration.data.snapshots[0].resolutionStatus, "legacy");
  assert.deepEqual(migration.data.authSessions, original.authSessions);
  assert.equal(migration.data.feishu.enabled, true);
  assert.equal(migration.data.feishu.documentId, "doc-1");
  assert.equal("cooldownEnabled" in migration.data.feishu, false);
  assert.equal("cooldownMinutes" in migration.data.feishu, false);
  assert.equal("apiKey" in migration.data.modelConfig, false);
  assert.equal("apiKeyEncrypted" in migration.data.modelConfig, false);
  assert.equal(migration.data.modelConfig.channel, "stable");
  assert.equal(decryptSecret(migration.data.modelConfig.channelStates.stable.apiKeyEncrypted), "legacy-secret");
  assert.equal(migration.data.modelConfig.channelStates.fast.apiKeyEncrypted, "");
  assert.equal(migration.data.modelConfig.channelStates.custom.apiKeyEncrypted, "");
  assert.equal(migration.data.modelConfig.channelStates.stable.lastTestTarget, null);
  assert.equal(migration.data.modelConfig.imageModel, "gpt-image-2");
  assert.deepEqual(migration.data.localEvidence, {
    directory: "",
    successRetentionDays: 7,
    failureRetentionDays: 30,
    maxBytes: 10 * 1024 ** 3,
  });
  assert.deepEqual(migration.data.promptStudio, { productProfiles: [], stylePresets: [], records: [], quickRequests: [], libraryFavorites: [] });
  assert.deepEqual(migration.data.captureJobs, []);
  assert.deepEqual(migration.data.pendingAuthScans, []);
  assert.deepEqual(migration.data.alertStates, {});
  assert.deepEqual(migration.data.notificationOutbox, []);
  assert.deepEqual(migration.data.priceEngine, { mode: "shadow", shadowRoundsCompleted: 0, requiredShadowRounds: 10 });
  assert.deepEqual(migration.data.monitor.scheduleWindows, ["08:00", "11:00", "14:00", "17:00", "20:00", "23:00"]);
  assert.deepEqual(migration.data.products[0].skuMonitorRules, {});
  assert.deepEqual(migration.data.products[0].skuLifecycle, {});
  assert.equal(original.products[0].lastSnapshot.parserVersion, undefined);
});

test("database migration filters malformed prompt studio assets", () => {
  const migration = migrateDbDocument({
    schemaVersion: 6,
    products: [],
    snapshots: [],
    promptStudio: {
      productProfiles: [{ id: "product_1", name: "压力锅", facts: { appearance: "圆形锅体" }, updatedAt: "2026-07-17T00:00:00.000Z" }],
      stylePresets: [{ id: "style_1", name: "明亮厨房", scene: "现代厨房", updatedAt: "2026-07-17T00:00:00.000Z" }],
      records: [{ id: "prompt_1", title: "厨房场景", category: "product-scene", createdAt: "2026-07-17T00:00:00.000Z" }],
      libraryFavorites: ["campaign-poster", "campaign-poster", "INVALID"],
    },
  });
  assert.deepEqual(migration.data.promptStudio, { productProfiles: [], stylePresets: [], records: [], quickRequests: [], libraryFavorites: ["campaign-poster"] });
});

test("database migration maps all legal legacy model URLs without crossing keys", () => {
  const cases = [
    [MODEL_CHANNELS.stable.baseUrl, "stable"],
    [MODEL_CHANNELS.fast.baseUrl, "fast"],
    ["https://custom.example.com/v1/images/generations", "custom"],
  ];
  for (const [baseUrl, channel] of cases) {
    const migration = migrateDbDocument({
      schemaVersion: 5,
      products: [],
      snapshots: [],
      modelConfig: { baseUrl, apiKey: `key-${channel}`, lastTestStatus: "success", lastTestedAt: "2026-07-17T00:00:00.000Z" },
    });
    assert.equal(migration.data.modelConfig.channel, channel);
    assert.equal(decryptSecret(migration.data.modelConfig.channelStates[channel].apiKeyEncrypted), `key-${channel}`);
    assert.equal(migration.data.modelConfig.channelStates[channel].lastTestStatus, "success");
    assert.equal(migration.data.modelConfig.channelStates[channel].lastTestTarget, null);
    for (const other of ["stable", "fast", "custom"].filter((value) => value !== channel)) {
      assert.equal(migration.data.modelConfig.channelStates[other].apiKeyEncrypted, "");
    }
    assert.equal(migration.data.modelConfig.customBaseUrl, channel === "custom" ? "https://custom.example.com/v1" : "");
  }
});

test("invalid legacy model URLs are quarantined instead of assigned to a fixed channel", () => {
  const migration = migrateDbDocument({
    schemaVersion: 5,
    products: [],
    snapshots: [],
    modelConfig: { baseUrl: "http://remote.example.com/v1", apiKey: "unsafe-key" },
  });
  assert.equal(migration.data.modelConfig.channel, "stable");
  assert.equal(migration.data.modelConfig.channelStates.stable.apiKeyEncrypted, "");
  assert.equal(migration.data.modelConfig.channelStates.fast.apiKeyEncrypted, "");
  assert.equal(migration.data.modelConfig.channelStates.custom.apiKeyEncrypted, "");
  assert.equal(decryptSecret(migration.data.modelConfig.legacyConfig.apiKeyEncrypted), "unsafe-key");
});

test("database migration preserves only an absolute local evidence directory", () => {
  const directory = path.resolve("custom-evidence");
  const valid = migrateDbDocument({ schemaVersion: 4, products: [], snapshots: [], localEvidence: { directory } });
  const invalid = migrateDbDocument({ schemaVersion: 4, products: [], snapshots: [], localEvidence: { directory: "../unsafe" } });

  assert.deepEqual(valid.data.localEvidence, {
    directory,
    successRetentionDays: 7,
    failureRetentionDays: 30,
    maxBytes: 10 * 1024 ** 3,
  });
  assert.deepEqual(invalid.data.localEvidence, {
    directory: "",
    successRetentionDays: 7,
    failureRetentionDays: 30,
    maxBytes: 10 * 1024 ** 3,
  });
});

test("schema v8 adds durable queue and monitoring defaults without replacing existing values", () => {
  const captureJobs = [{ id: "job-1", status: "queued" }];
  const alertStates = { "p1:s1:lowest": { state: "below", lastPrice: 99.99 } };
  const migration = migrateDbDocument({
    schemaVersion: 7,
    products: [],
    snapshots: [],
    captureJobs,
    alertStates,
    priceEngine: { mode: "active", shadowRoundsCompleted: 4 },
    monitor: { intervalMinutes: 90, scheduleWindows: ["09:15", "21:45"] },
    localEvidence: { successRetentionDays: 14, failureRetentionDays: 60, maxBytes: 1024 },
  });

  assert.deepEqual(migration.data.captureJobs, captureJobs);
  assert.deepEqual(migration.data.alertStates, alertStates);
  assert.deepEqual(migration.data.notificationOutbox, []);
  assert.deepEqual(migration.data.priceEngine, { mode: "active", shadowRoundsCompleted: 4, requiredShadowRounds: 10 });
  assert.equal(migration.data.monitor.intervalMinutes, 90);
  assert.deepEqual(migration.data.monitor.scheduleWindows, ["09:15", "21:45"]);
  assert.deepEqual(migration.data.localEvidence, {
    directory: "",
    successRetentionDays: 14,
    failureRetentionDays: 60,
    maxBytes: 1024,
  });
});

test("schema v8 expands legacy SKU thresholds into typed rules without data loss", () => {
  const original = {
    schemaVersion: 7,
    products: [{
      id: "p1",
      skuMonitorPrices: { sku1: 139, sku2: 0.01 },
      skuMonitorRules: {
        sku1: { lowest: 128, normal: 150 },
        sku3: { coin: 88 },
      },
      skuLifecycle: { retiredSku: { status: "retired" } },
    }],
    snapshots: [],
  };
  const migration = migrateDbDocument(original);
  const product = migration.data.products[0];

  assert.deepEqual(product.skuMonitorPrices, { sku1: 139, sku2: 0.01 });
  assert.deepEqual(product.skuMonitorRules, {
    sku1: { lowest: 128, normal: 150 },
    sku2: { lowest: 0.01 },
    sku3: { coin: 88 },
  });
  assert.deepEqual(product.skuLifecycle, { retiredSku: { status: "retired" } });
  assert.deepEqual(original.products[0].skuMonitorRules.sku1, { lowest: 128, normal: 150 });
  assert.equal(original.products[0].skuMonitorRules.sku2, undefined);
});

test("pending account authorization metadata survives database writes", async (t) => {
  const { db } = await createTemporaryDb(t);
  const pending = {
    name: "88VIP账号",
    accountType: "vip88",
    profileKey: "taobao_pending",
    browserPort: 9555,
    loginTargetId: "target-1",
    createdAt: 1,
  };

  await db.updateDb((data) => ({ ...data, pendingAuthScans: [pending] }));

  assert.deepEqual((await db.readDb()).pendingAuthScans, [pending]);
});

test("database migration is idempotent", () => {
  const first = migrateDbDocument({
    schemaVersion: 7,
    products: [{ id: "p1", skuMonitorPrices: { sku1: 99.99 } }],
    snapshots: [],
  });
  const second = migrateDbDocument(first.data);

  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.data, first.data);
  assert.deepEqual(second.data.products[0].skuMonitorRules, { sku1: { lowest: 99.99 } });
});

test("atomic database replacement handles Windows rename failures safely", async (t) => {
  await t.test("retries transient EPERM and EBUSY failures before committing", async (t) => {
    const { db, directory, dbPath } = await createTemporaryDb(t);
    const originalRename = fs.rename.bind(fs);
    let calls = 0;
    t.mock.method(fs, "rename", async (source, destination) => {
      calls += 1;
      if (calls === 1) throw injectedFsError("EPERM");
      if (calls === 2) throw injectedFsError("EBUSY");
      return originalRename(source, destination);
    });

    await db.updateDb((data) => ({ ...data, atomicWriteMarker: "committed" }));

    assert.equal(calls, 3);
    assert.equal(JSON.parse(await fs.readFile(dbPath, "utf8")).atomicWriteMarker, "committed");
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });

  await t.test("does not retry or replace the database for other errors", async (t) => {
    const { db, directory, dbPath } = await createTemporaryDb(t);
    const original = await fs.readFile(dbPath, "utf8");
    const injected = injectedFsError("EACCES");
    let calls = 0;
    t.mock.method(fs, "rename", async () => {
      calls += 1;
      throw injected;
    });

    await assert.rejects(
      db.updateDb((data) => ({ ...data, atomicWriteMarker: "must-not-commit" })),
      (error) => error === injected,
    );

    assert.equal(calls, 1);
    assert.equal(await fs.readFile(dbPath, "utf8"), original);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });

  await t.test("stops after the bounded retry budget and preserves the old database", async (t) => {
    const { db, directory, dbPath } = await createTemporaryDb(t);
    const original = await fs.readFile(dbPath, "utf8");
    const injected = injectedFsError("EBUSY");
    let calls = 0;
    t.mock.method(fs, "rename", async () => {
      calls += 1;
      throw injected;
    });

    await assert.rejects(
      db.updateDb((data) => ({ ...data, atomicWriteMarker: "must-not-commit" })),
      (error) => error === injected,
    );

    assert.equal(calls, 6);
    assert.equal(await fs.readFile(dbPath, "utf8"), original);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });
});
