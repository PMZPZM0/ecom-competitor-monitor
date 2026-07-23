import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secureStoredModelConfig } from "../services/modelConfigService.js";
import { normalizePromptStudioState } from "../services/promptStudioService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ECOM_MONITOR_DATA_DIR || path.resolve(__dirname, "../data"));
const dbPath = path.join(dataDir, "db.json");
export const DB_SCHEMA_VERSION = 8;

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY"]);

const DEFAULT_SCHEDULE_WINDOWS = ["08:00", "11:00", "14:00", "17:00", "20:00", "23:00"];
const DEFAULT_PRICE_ENGINE = {
  mode: "shadow",
  shadowRoundsCompleted: 0,
  requiredShadowRounds: 10,
};
const DEFAULT_LOCAL_EVIDENCE = {
  directory: "",
  successRetentionDays: 7,
  failureRetentionDays: 30,
  maxBytes: 10 * 1024 ** 3,
};

let readyPromise = null;
let mutationQueue = Promise.resolve();

const initialData = {
  schemaVersion: DB_SCHEMA_VERSION,
  products: [],
  snapshots: [],
  authSessions: [],
  analyses: [],
  runs: [],
  captureJobs: [],
  pendingAuthScans: [],
  alertStates: {},
  priceEngine: { ...DEFAULT_PRICE_ENGINE },
  notificationOutbox: [],
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
  promptStudio: normalizePromptStudioState(),
  modelConfig: {
    channel: "stable",
    customBaseUrl: "",
    channelStates: {
      stable: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null, lastTestTarget: null, testStates: { image: { lastTestedAt: null, lastTestStatus: null }, prompt: { lastTestedAt: null, lastTestStatus: null } } },
      fast: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null, lastTestTarget: null, testStates: { image: { lastTestedAt: null, lastTestStatus: null }, prompt: { lastTestedAt: null, lastTestStatus: null } } },
      custom: { apiKeyEncrypted: "", lastTestedAt: null, lastTestStatus: null, lastTestTarget: null, testStates: { image: { lastTestedAt: null, lastTestStatus: null }, prompt: { lastTestedAt: null, lastTestStatus: null } } },
    },
    model: "gpt-5.5",
    imageModel: "gpt-image-2",
  },
  monitor: {
    intervalMinutes: 60,
    running: true,
    lastRunAt: null,
    nextRunAt: null,
    scheduleWindows: [...DEFAULT_SCHEDULE_WINDOWS],
  },
  localEvidence: { ...DEFAULT_LOCAL_EVIDENCE },
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
  return {
    directory: directory && path.isAbsolute(directory) ? path.normalize(directory) : "",
    successRetentionDays: Number.isInteger(config?.successRetentionDays) && config.successRetentionDays > 0
      ? config.successRetentionDays
      : DEFAULT_LOCAL_EVIDENCE.successRetentionDays,
    failureRetentionDays: Number.isInteger(config?.failureRetentionDays) && config.failureRetentionDays > 0
      ? config.failureRetentionDays
      : DEFAULT_LOCAL_EVIDENCE.failureRetentionDays,
    maxBytes: Number.isSafeInteger(config?.maxBytes) && config.maxBytes > 0
      ? config.maxBytes
      : DEFAULT_LOCAL_EVIDENCE.maxBytes,
  };
}

function normalizeMonitor(config = {}) {
  return {
    ...initialData.monitor,
    ...config,
    scheduleWindows: Array.isArray(config?.scheduleWindows)
      ? [...config.scheduleWindows]
      : [...DEFAULT_SCHEDULE_WINDOWS],
  };
}

function normalizePriceEngine(config = {}) {
  return { ...DEFAULT_PRICE_ENGINE, ...(config || {}) };
}

function migrateProductSchema(product) {
  const skuMonitorRules = { ...(product?.skuMonitorRules || {}) };
  for (const [skuId, threshold] of Object.entries(product?.skuMonitorPrices || {})) {
    const rule = skuMonitorRules[skuId] && typeof skuMonitorRules[skuId] === "object"
      ? { ...skuMonitorRules[skuId] }
      : {};
    if (!("lowest" in rule)) rule.lowest = threshold;
    skuMonitorRules[skuId] = rule;
  }
  return {
    ...product,
    lastSnapshot: markLegacySnapshot(product?.lastSnapshot),
    skuMonitorRules,
    skuLifecycle: product?.skuLifecycle && typeof product.skuLifecycle === "object"
      ? { ...product.skuLifecycle }
      : {},
  };
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
    products: (parsed.products || []).map(migrateProductSchema),
    captureJobs: Array.isArray(parsed.captureJobs) ? parsed.captureJobs : [],
    pendingAuthScans: Array.isArray(parsed.pendingAuthScans) ? parsed.pendingAuthScans : [],
    alertStates: parsed.alertStates && typeof parsed.alertStates === "object" && !Array.isArray(parsed.alertStates)
      ? parsed.alertStates
      : {},
    priceEngine: normalizePriceEngine(parsed.priceEngine),
    notificationOutbox: Array.isArray(parsed.notificationOutbox) ? parsed.notificationOutbox : [],
    monitor: normalizeMonitor(parsed.monitor),
    modelConfig: normalizeStoredModelConfig(parsed.modelConfig),
    localEvidence: normalizeStoredLocalEvidence(parsed.localEvidence),
    promptStudio: normalizePromptStudioState(parsed.promptStudio),
    feishu,
  };
  return { data, migrated: true, fromVersion };
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || delayMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function atomicWrite(data) {
  const temporaryPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await fs.open(temporaryPath, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporaryPath, dbPath);
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Database write failed and its temporary file could not be removed",
        { cause: error },
      );
    }
    throw error;
  }
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
  const monitor = normalizeMonitor(parsed.monitor);
  delete monitor.captureProtectionMinutes;
  delete monitor.captureProtectionByAccount;
  const authSessions = (parsed.authSessions || []).map((session) => {
    const normalized = { ...session };
    if (normalized.source === "taobao-browser" && !normalized.browserEngine) normalized.browserEngine = "legacy-google";
    delete normalized.cooldownUntil;
    if (normalized.healthStatus === "cooldown") normalized.healthStatus = "degraded";
    normalized.tmallPriceStatus ||= "unknown";
    const priceCooldownUntil = Date.parse(normalized.tmallPriceCooldownUntil || "");
    if (normalized.tmallPriceStatus === "cooldown" && (!Number.isFinite(priceCooldownUntil) || priceCooldownUntil <= Date.now())) {
      normalized.tmallPriceStatus = "unknown";
      normalized.tmallPriceCooldownUntil = null;
      normalized.tmallPriceDeviceCooldownUntil = null;
      normalized.tmallPriceFailureReason = null;
    }
    return normalized;
  });
  return {
    ...initialData,
    ...parsed,
    schemaVersion: DB_SCHEMA_VERSION,
    products: (parsed.products || []).map(migrateProductSchema),
    captureJobs: Array.isArray(parsed.captureJobs) ? parsed.captureJobs : [],
    pendingAuthScans: Array.isArray(parsed.pendingAuthScans) ? parsed.pendingAuthScans : [],
    alertStates: parsed.alertStates && typeof parsed.alertStates === "object" && !Array.isArray(parsed.alertStates)
      ? parsed.alertStates
      : {},
    priceEngine: normalizePriceEngine(parsed.priceEngine),
    notificationOutbox: Array.isArray(parsed.notificationOutbox) ? parsed.notificationOutbox : [],
    authSessions,
    monitor,
    modelConfig: normalizeStoredModelConfig(parsed.modelConfig),
    localEvidence: normalizeStoredLocalEvidence(parsed.localEvidence),
    promptStudio: normalizePromptStudioState(parsed.promptStudio),
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
