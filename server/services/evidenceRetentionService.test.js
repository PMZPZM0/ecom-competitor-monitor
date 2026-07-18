import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupEvidenceRetention } from "./evidenceRetentionService.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-retention-"));
  const root = path.join(dataDir, "capture-evidence");
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const write = async (name, content = name) => {
    const file = path.join(root, name);
    await fs.writeFile(file, content);
    return `capture-evidence/${name}`;
  };
  return { dataDir, root, write };
}

function snapshot({ capturedAt, file, field = "browserEvidenceFile", status = "verified", buyerStatus = "complete" }) {
  return {
    capturedAt,
    resolutionStatus: status,
    [field]: file,
    ...(field === "buyerShowEvidenceFile" ? { buyerShowCapture: { status: buyerStatus, capturedAt } } : {}),
  };
}

test("applies 7/30 day retention and never touches current, outside, or unknown files", async (t) => {
  const { dataDir, root, write } = await fixture(t);
  const now = Date.parse("2026-07-18T08:00:00.000Z");
  const oldSuccess = await write("old-success.json");
  const recentSuccess = await write("recent-success.json");
  const recentFailure = await write("recent-failure.txt");
  const oldFailure = await write("old-failure.txt");
  const shared = await write("shared-current.json");
  await write("unknown-unreferenced.txt");
  const outside = path.join(dataDir, "outside.txt");
  await fs.writeFile(outside, "outside");
  const at = (days) => new Date(now - days * DAY_MS).toISOString();
  const db = {
    localEvidence: { directory: "", successRetentionDays: 7, failureRetentionDays: 30, maxBytes: 1024 ** 3 },
    snapshots: [
      snapshot({ capturedAt: at(8), file: oldSuccess }),
      snapshot({ capturedAt: at(2), file: recentSuccess, field: "localImportFile" }),
      snapshot({ capturedAt: at(20), file: recentFailure, field: "buyerShowEvidenceFile", buyerStatus: "failed" }),
      snapshot({ capturedAt: at(31), file: oldFailure, field: "buyerShowEvidenceFile", buyerStatus: "failed" }),
      snapshot({ capturedAt: at(40), file: shared }),
      snapshot({ capturedAt: at(40), file: outside }),
    ],
    products: [{ lastSnapshot: snapshot({ capturedAt: at(1), file: shared }) }],
  };

  const preview = await cleanupEvidenceRetention({ db, dataDir, now, dryRun: true });
  assert.equal(preview.deleted, 0);
  assert.equal(preview.planned, 2);
  assert.equal((await fs.readdir(root)).length, 6);

  const result = await cleanupEvidenceRetention({ db, dataDir, now, dryRun: false });
  assert.equal(result.scanned, 6);
  assert.equal(result.deleted, 2);
  assert.equal(result.errors.length, 0);
  assert.ok(result.reclaimed > 0);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "recent-failure.txt",
    "recent-success.json",
    "shared-current.json",
    "unknown-unreferenced.txt",
  ]);
  assert.equal(await fs.readFile(outside, "utf8"), "outside");
});

test("size cap removes the oldest historical evidence but protects the current snapshot", async (t) => {
  const { dataDir, write } = await fixture(t);
  const now = Date.parse("2026-07-18T08:00:00.000Z");
  const oldest = await write("oldest.json", "12345678");
  const newer = await write("newer.json", "12345678");
  const current = await write("current.json", "12345678");
  const at = (days) => new Date(now - days * DAY_MS).toISOString();
  const db = {
    localEvidence: { successRetentionDays: 7, failureRetentionDays: 30, maxBytes: 16 },
    snapshots: [snapshot({ capturedAt: at(3), file: oldest }), snapshot({ capturedAt: at(2), file: newer })],
    products: [{ lastSnapshot: snapshot({ capturedAt: at(1), file: current }) }],
  };

  const result = await cleanupEvidenceRetention({ db, dataDir, now, dryRun: false });
  assert.equal(result.deleted, 1);
  assert.equal(result.reclaimed, 8);
  await assert.rejects(fs.access(path.join(dataDir, oldest)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(dataDir, newer), "utf8"), "12345678");
  assert.equal(await fs.readFile(path.join(dataDir, current), "utf8"), "12345678");
});

test("deletion failures are reported without claiming reclaimed bytes", async (t) => {
  const { dataDir, write } = await fixture(t);
  const file = await write("locked.json", "locked");
  const db = {
    localEvidence: { successRetentionDays: 7, failureRetentionDays: 30, maxBytes: 1024 },
    snapshots: [snapshot({ capturedAt: "2026-06-01T00:00:00.000Z", file })],
    products: [],
  };
  const fileSystem = {
    ...fs,
    rm: async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); },
  };

  const result = await cleanupEvidenceRetention({ db, dataDir, now: Date.parse("2026-07-18T08:00:00.000Z"), dryRun: false, fileSystem });
  assert.equal(result.deleted, 0);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(await fs.readFile(path.join(dataDir, file), "utf8"), "locked");
});

test("accepts an absolute configured evidence root without granting access to its parent", async (t) => {
  const { dataDir } = await fixture(t);
  const customRoot = path.join(dataDir, "custom-evidence");
  await fs.mkdir(customRoot);
  const inside = path.join(customRoot, "inside.json");
  const parentFile = path.join(dataDir, "parent.json");
  await fs.writeFile(inside, "inside");
  await fs.writeFile(parentFile, "parent");
  const db = {
    localEvidence: { directory: customRoot, successRetentionDays: 7, failureRetentionDays: 30, maxBytes: 1024 },
    snapshots: [
      snapshot({ capturedAt: "2026-06-01T00:00:00.000Z", file: inside }),
      snapshot({ capturedAt: "2026-06-01T00:00:00.000Z", file: parentFile }),
    ],
    products: [],
  };

  const result = await cleanupEvidenceRetention({ db, dataDir, now: Date.parse("2026-07-18T08:00:00.000Z"), dryRun: false });
  assert.equal(result.deleted, 1);
  await assert.rejects(fs.access(inside), { code: "ENOENT" });
  assert.equal(await fs.readFile(parentFile, "utf8"), "parent");
});
