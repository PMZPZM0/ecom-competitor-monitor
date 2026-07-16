import assert from "node:assert/strict";
import test from "node:test";
import { DB_SCHEMA_VERSION, migrateDbDocument } from "./db.js";

test("database migration preserves user data and marks legacy snapshots", () => {
  const original = {
    products: [{ id: "p1", name: "商品", lastSnapshot: { capturedAt: "2026-01-01", price: 10 } }],
    snapshots: [{ id: "s1", productId: "p1", capturedAt: "2026-01-01", price: 10 }],
    authSessions: [{ id: "a1", cookie: "configured" }],
    feishu: { enabled: true, cooldownEnabled: true, cooldownMinutes: 120, documentId: "doc-1" },
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
  assert.equal(original.products[0].lastSnapshot.parserVersion, undefined);
});

test("database migration is idempotent", () => {
  const current = { schemaVersion: DB_SCHEMA_VERSION, products: [], snapshots: [] };
  const migration = migrateDbDocument(current);
  assert.equal(migration.migrated, false);
  assert.equal(migration.data, current);
});
