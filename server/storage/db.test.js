import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DB_SCHEMA_VERSION, migrateDbDocument } from "./db.js";
import { decryptSecret } from "../services/secretService.js";
import { MODEL_CHANNELS } from "../services/modelConfigService.js";

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
  assert.equal(migration.data.modelConfig.imageModel, "gpt-image-2");
  assert.deepEqual(migration.data.localEvidence, { directory: "" });
  assert.equal(original.products[0].lastSnapshot.parserVersion, undefined);
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

  assert.deepEqual(valid.data.localEvidence, { directory });
  assert.deepEqual(invalid.data.localEvidence, { directory: "" });
});

test("database migration is idempotent", () => {
  const current = { schemaVersion: DB_SCHEMA_VERSION, products: [], snapshots: [] };
  const migration = migrateDbDocument(current);
  assert.equal(migration.migrated, false);
  assert.equal(migration.data, current);
});
