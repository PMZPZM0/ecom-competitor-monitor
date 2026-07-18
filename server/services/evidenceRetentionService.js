import fs from "node:fs/promises";
import path from "node:path";
import { dbRuntimeInfo, readDb } from "../storage/db.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SUCCESS_STATUSES = new Set(["verified", "partial", "complete", "success"]);
const EVIDENCE_FIELDS = Object.freeze([
  ["browserEvidenceFile", "price"],
  ["localImportFile", "price"],
  ["buyerShowEvidenceFile", "buyer-show"],
  ["materialEvidenceFile", "material"],
]);

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function retentionConfig(config = {}) {
  return {
    directory: typeof config.directory === "string" && path.isAbsolute(config.directory)
      ? path.normalize(config.directory)
      : "",
    successRetentionDays: positiveInteger(config.successRetentionDays, 7),
    failureRetentionDays: positiveInteger(config.failureRetentionDays, 30),
    maxBytes: positiveInteger(config.maxBytes, 10 * 1024 ** 3),
  };
}

function normalizedKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function referenceTime(snapshot, kind) {
  const value = kind === "buyer-show"
    ? snapshot?.buyerShowCapture?.capturedAt || snapshot?.capturedAt
    : kind === "material" ? snapshot?.materialCapturedAt || snapshot?.capturedAt : snapshot?.capturedAt;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function referenceSucceeded(snapshot, kind) {
  const status = kind === "buyer-show"
    ? snapshot?.buyerShowCapture?.status
    : kind === "material" ? snapshot?.materialCapturedAt ? "success" : "failed" : snapshot?.resolutionStatus;
  return SUCCESS_STATUSES.has(String(status || "").toLowerCase());
}

function collectReferences(db, dataDir, config) {
  const byFile = new Map();
  const addSnapshot = (snapshot, current = false) => {
    if (!snapshot || typeof snapshot !== "object") return;
    for (const [field, kind] of EVIDENCE_FIELDS) {
      const stored = snapshot[field];
      if (typeof stored !== "string" || !stored.trim()) continue;
      const file = path.isAbsolute(stored) ? path.resolve(stored) : path.resolve(dataDir, stored);
      const key = normalizedKey(file);
      const reference = {
        current,
        succeeded: referenceSucceeded(snapshot, kind),
        timestamp: referenceTime(snapshot, kind),
      };
      const entry = byFile.get(key) || { file, references: [] };
      entry.references.push(reference);
      byFile.set(key, entry);
    }
  };

  for (const snapshot of db?.snapshots || []) addSnapshot(snapshot);
  for (const product of db?.products || []) addSnapshot(product?.lastSnapshot, true);

  const roots = [path.join(dataDir, "capture-evidence"), config.directory]
    .filter(Boolean)
    .map((root) => path.resolve(root))
    .filter((root, index, values) => values.findIndex((candidate) => normalizedKey(candidate) === normalizedKey(root)) === index);
  return { references: [...byFile.values()], roots };
}

async function existingRoots(roots, fileSystem) {
  const result = [];
  for (const root of roots) {
    try {
      const stat = await fileSystem.lstat(root);
      if (!stat.isDirectory()) continue;
      result.push({ lexical: root, real: await fileSystem.realpath(root) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function inspectEvidence(entry, roots, fileSystem, config, now) {
  const lexicalRoot = roots.find((root) => isInside(root.lexical, entry.file));
  if (!lexicalRoot) return null;
  const stat = await fileSystem.lstat(entry.file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const realFile = await fileSystem.realpath(entry.file);
  if (!isInside(lexicalRoot.real, realFile)) return null;

  let expiresAt = 0;
  let lastReferencedAt = 0;
  let hasUnknownTime = false;
  for (const reference of entry.references) {
    if (reference.timestamp === null) {
      hasUnknownTime = true;
      continue;
    }
    lastReferencedAt = Math.max(lastReferencedAt, reference.timestamp);
    const days = reference.succeeded ? config.successRetentionDays : config.failureRetentionDays;
    expiresAt = Math.max(expiresAt, reference.timestamp + days * DAY_MS);
  }
  return {
    ...entry,
    file: realFile,
    size: stat.size,
    protected: entry.references.some((reference) => reference.current) || hasUnknownTime,
    expired: !hasUnknownTime && expiresAt > 0 && expiresAt < now,
    lastReferencedAt,
  };
}

async function removeEvidence(record, roots, fileSystem) {
  const stat = await fileSystem.lstat(record.file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("证据文件已变更，已停止删除。");
  const realFile = await fileSystem.realpath(record.file);
  if (!roots.some((root) => isInside(root.real, realFile))) throw new Error("证据文件已移出允许目录，已停止删除。");
  await fileSystem.rm(realFile);
}

export async function cleanupEvidenceRetention({
  db: providedDb,
  dataDir: providedDataDir,
  dryRun = true,
  now = Date.now(),
  fileSystem = fs,
} = {}) {
  const db = providedDb || await readDb();
  const dataDir = path.resolve(providedDataDir || dbRuntimeInfo().dataDir);
  const config = retentionConfig(db?.localEvidence);
  const { references, roots: configuredRoots } = collectReferences(db, dataDir, config);
  const stats = { scanned: 0, deleted: 0, reclaimed: 0, errors: [], planned: 0, reclaimable: 0 };
  let roots;
  try {
    roots = await existingRoots(configuredRoots, fileSystem);
  } catch (error) {
    stats.errors.push({ file: "", message: error?.message || String(error) });
    return stats;
  }

  const records = [];
  for (const entry of references) {
    stats.scanned += 1;
    try {
      const record = await inspectEvidence(entry, roots, fileSystem, config, Number(now));
      if (record) records.push(record);
    } catch (error) {
      if (error?.code !== "ENOENT") stats.errors.push({ file: entry.file, message: error?.message || String(error) });
    }
  }

  const selected = new Map();
  for (const record of records) {
    if (record.expired && !record.protected) selected.set(normalizedKey(record.file), record);
  }

  let remainingBytes = records.reduce((total, record) => total + record.size, 0)
    - [...selected.values()].reduce((total, record) => total + record.size, 0);
  if (remainingBytes > config.maxBytes) {
    const oldest = records
      .filter((record) => !record.protected && !selected.has(normalizedKey(record.file)))
      .sort((left, right) => left.lastReferencedAt - right.lastReferencedAt || left.file.localeCompare(right.file));
    for (const record of oldest) {
      if (remainingBytes <= config.maxBytes) break;
      selected.set(normalizedKey(record.file), record);
      remainingBytes -= record.size;
    }
  }

  stats.planned = selected.size;
  stats.reclaimable = [...selected.values()].reduce((total, record) => total + record.size, 0);
  if (dryRun) return stats;

  for (const record of selected.values()) {
    try {
      await removeEvidence(record, roots, fileSystem);
      stats.deleted += 1;
      stats.reclaimed += record.size;
    } catch (error) {
      stats.errors.push({ file: record.file, message: error?.message || String(error) });
    }
  }
  return stats;
}
