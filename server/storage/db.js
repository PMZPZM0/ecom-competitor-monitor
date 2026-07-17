import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secureStoredModelConfig } from "../services/modelConfigService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ECOM_MONITOR_DATA_DIR || path.resolve(__dirname, "../data"));
const dbPath = path.join(dataDir, "db.json");
export const DB_SCHEMA_VERSION = 6;

let readyPromise = null;
let mutationQueue = Promise.resolve();

const initialData = {
  schemaVersion: DB_SCHEMA_VERSION,
  products: [],
  snapshots: [],
  authSessions: [],
  analyses: [],
  runs: [],
  feishu: {
    enabled: false,
    webhookUrlEncrypted: "",
    signingSecretEncrypted: "",
    lastTestedAt: null,
    documentEnabled: false,
    documentId: "",
    documentUrl: "",
    lastDocumentSyncAt: null,
  },
  notificationLogs: [],
  modelConfig: {
    channel: "stable",
    customBaseUrl: "",
    channelStates: {
      stable: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null },
      fast: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null },
      custom: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null },
    },
    model: "gpt-4.1-mini",
    imageModel: "gpt-image-2",
  },
  monitor: {
    intervalMinutes: 60,
    running: true,
    lastRunAt: null,
    nextRunAt: null,
  },
  localEvidence: {
    directory: "",
  },
};

function markLegacySnapshot(snapshot) {
  if (!snapshot || snapshot.parserVersion) return snapshot;
  return { ...snapshot, parserVersion: "legacy", resolutionStatus: snapshot.resolutionStatus || "legacy" };
}

function normalizeStoredModelConfig(config = {}) {
  return secureStoredModelConfig(config);
}

function normalizeStoredLocalEvidence(config = {}) {
  const directory = typeof config?.directory === "string" ? config.directory.trim() : "";
  return { directory: directory && path.isAbsolute(directory) ? path.normalize(directory) : "" };
}

export function migrateDbDocument(parsed) {
  const fromVersion = Number(parsed?.schemaVersion || 1);
  if (fromVersion >= DB_SCHEMA_VERSION) return { data: parsed, migrated: false, fromVersion };
  const feishu = { ...(parsed.feishu || {}) };
  delete feishu.cooldownEnabled;
  delete feishu.cooldownMinutes;
  const data = {
    ...parsed,
    schemaVersion: DB_SCHEMA_VERSION,
    snapshots: (parsed.snapshots || []).map(markLegacySnapshot),
    products: (parsed.products || []).map((product) => ({
      ...product,
      lastSnapshot: markLegacySnapshot(product.lastSnapshot),
    })),
    modelConfig: normalizeStoredModelConfig(parsed.modelConfig),
    localEvidence: normalizeStoredLocalEvidence(parsed.localEvidence),
    feishu,
  };
  return { data, migrated: true, fromVersion };
}

async function atomicWrite(data) {
  const temporaryPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporaryPath, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, dbPath);
}

async function initializeDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await atomicWrite(initialData);
    return;
  }
  const parsed = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const migration = migrateDbDocument(parsed);
  if (!migration.migrated) return;
  const backupPath = `${dbPath}.v${migration.fromVersion}.bak`;
  try {
    await fs.access(backupPath);
  } catch {
    await fs.copyFile(dbPath, backupPath);
  }
  await atomicWrite(migration.data);
}

async function ensureDb() {
  readyPromise ||= initializeDb().catch((error) => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

export async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, "utf8");
  const parsed = JSON.parse(raw);
  const monitor = { ...initialData.monitor, ...(parsed.monitor || {}) };
  delete monitor.captureProtectionMinutes;
  delete monitor.captureProtectionByAccount;
  const authSessions = (parsed.authSessions || []).map((session) => {
    const normalized = { ...session };
    delete normalized.cooldownUntil;
    if (normalized.healthStatus === "cooldown") normalized.healthStatus = "degraded";
    return normalized;
  });
  return {
    ...initialData,
    ...parsed,
    schemaVersion: DB_SCHEMA_VERSION,
    authSessions,
    monitor,
    modelConfig: normalizeStoredModelConfig(parsed.modelConfig),
    localEvidence: normalizeStoredLocalEvidence(parsed.localEvidence),
    feishu: { ...initialData.feishu, ...(parsed.feishu || {}) },
    runs: parsed.runs || [],
    notificationLogs: parsed.notificationLogs || [],
  };
}

async function writeDbNow(data) {
  await ensureDb();
  await atomicWrite({ ...data, schemaVersion: DB_SCHEMA_VERSION });
  return data;
}

export function writeDb(data) {
  const operation = mutationQueue.then(() => writeDbNow(data));
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function updateDb(mutator) {
  const operation = mutationQueue.then(async () => {
    const data = await readDb();
    const next = await mutator(data);
    return writeDbNow(next ?? data);
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function dbRuntimeInfo() {
  return { dataDir, dbPath, schemaVersion: DB_SCHEMA_VERSION };
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
