import fs from "node:fs/promises";
import path from "node:path";

const MAX_RECORDS = 500;
const MAX_VALUE_LENGTH = 1_200;
let writeQueue = Promise.resolve();

function auditPath(dataDir) {
  return path.join(dataDir, "operations", "agent-actions.ndjson");
}

function safeText(value, limit = MAX_VALUE_LENGTH) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function cleanDetails(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => cleanDetails(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(cookie|token|secret|authorization|api[_-]?key|signature|password)/i.test(key))
      .slice(0, 40)
      .map(([key, item]) => [safeText(key, 80), cleanDetails(item, depth + 1)]));
  }
  if (typeof value === "string") return safeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return safeText(value);
}

export function normalizeAgentAuditRecord(value = {}) {
  const status = ["succeeded", "failed"].includes(value.status) ? value.status : "succeeded";
  return {
    id: safeText(value.id || `agent_${Date.now().toString(36)}`, 80),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    action: safeText(value.action, 120) || "unknown",
    status,
    target: safeText(value.target, 240),
    summary: safeText(value.summary, 800),
    details: cleanDetails(value.details),
  };
}

export function recordAgentAction(dataDir, value) {
  const record = normalizeAgentAuditRecord(value);
  const operation = writeQueue.then(async () => {
    const destination = auditPath(dataDir);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const handle = await fs.open(destination, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return record;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function listAgentActions(dataDir, limit = 80) {
  const normalizedLimit = Math.min(MAX_RECORDS, Math.max(1, Number(limit) || 80));
  let source = "";
  try {
    source = await fs.readFile(auditPath(dataDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return source.split(/\r?\n/)
    .filter(Boolean)
    .slice(-MAX_RECORDS)
    .flatMap((line) => {
      try {
        return [normalizeAgentAuditRecord(JSON.parse(line))];
      } catch {
        return [];
      }
    })
    .slice(-normalizedLimit)
    .reverse();
}
