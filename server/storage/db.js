import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.ECOM_MONITOR_DATA_DIR || path.resolve(__dirname, "../data"));
const dbPath = path.join(dataDir, "db.json");

const initialData = {
  products: [],
  snapshots: [],
  authSessions: [],
  analyses: [],
  runs: [],
  feishu: {
    enabled: false,
    webhookUrlEncrypted: "",
    signingSecretEncrypted: "",
    cooldownEnabled: true,
    cooldownMinutes: 120,
    lastTestedAt: null,
    documentEnabled: false,
    documentId: "",
    documentUrl: "",
    lastDocumentSyncAt: null,
  },
  notificationLogs: [],
  modelConfig: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4.1-mini",
  },
  monitor: {
    intervalMinutes: 60,
    captureProtectionMinutes: 3,
    captureProtectionByAccount: {
      normal: null,
      vip88: null,
      gift: null,
    },
    running: true,
    lastRunAt: null,
    nextRunAt: null,
  },
};

async function ensureDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(initialData, null, 2), "utf8");
  }
}

export async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    ...initialData,
    ...parsed,
    monitor: {
      ...initialData.monitor,
      ...(parsed.monitor || {}),
      captureProtectionByAccount: {
        ...initialData.monitor.captureProtectionByAccount,
        ...(parsed.monitor?.captureProtectionByAccount || {}),
      },
    },
    modelConfig: { ...initialData.modelConfig, ...(parsed.modelConfig || {}) },
    feishu: { ...initialData.feishu, ...(parsed.feishu || {}) },
    runs: parsed.runs || [],
    notificationLogs: parsed.notificationLogs || [],
  };
}

export async function writeDb(data) {
  await ensureDb();
  await fs.writeFile(dbPath, JSON.stringify(data, null, 2), "utf8");
  return data;
}

export async function updateDb(mutator) {
  const data = await readDb();
  const next = await mutator(data);
  return writeDb(next ?? data);
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
