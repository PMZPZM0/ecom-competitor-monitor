import crypto from "node:crypto";
import os from "node:os";
import { decryptSecret, encryptSecret, maskSecret } from "./secretService.js";

export const CLOUD_SYNC_DEFAULT_ENDPOINT = "https://jvspp.cloud";

function text(value, limit = 240) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function httpsEndpoint(value) {
  const candidate = text(value, 300) || CLOUD_SYNC_DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(candidate);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(loopback && process.env.NODE_ENV !== "production")) return "";
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function baseEndpoint(value) {
  return httpsEndpoint(value).toLowerCase();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableCloudReportId(endpoint, teamId, remoteId) {
  const hash = crypto.createHash("sha256").update(`${endpoint}\u0000${teamId}\u0000${remoteId}`).digest("hex");
  return `ops_cloud_${hash.slice(0, 28)}`;
}

function safeStoreNames(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string")
    .map((item) => text(item, 80))
    .filter(Boolean))].slice(0, 80);
}

function cloudOrigin(value) {
  const endpoint = baseEndpoint(value?.endpoint);
  const teamId = text(value?.teamId, 100);
  const remoteReportId = text(value?.remoteReportId, 120);
  if (!endpoint || !teamId || !remoteReportId) return null;
  return {
    endpoint,
    teamId,
    remoteReportId,
    revision: Math.max(0, Math.floor(Number(value?.revision) || 0)),
    syncedAt: typeof value?.syncedAt === "string" ? value.syncedAt : new Date().toISOString(),
  };
}

export function normalizeCloudSync(value = {}) {
  const endpoint = baseEndpoint(value?.endpoint) || CLOUD_SYNC_DEFAULT_ENDPOINT;
  const tokenEncrypted = text(value?.tokenEncrypted, 2_000);
  const connected = Boolean(tokenEncrypted && text(value?.deviceId, 120) && text(value?.teamId, 120));
  return {
    endpoint,
    deviceId: text(value?.deviceId, 120),
    deviceName: text(value?.deviceName, 80) || os.hostname().slice(0, 80) || "本地应用",
    tokenEncrypted,
    teamId: text(value?.teamId, 120),
    teamName: text(value?.teamName, 80),
    storeNames: safeStoreNames(value?.storeNames),
    lastCursor: Math.max(0, Math.floor(Number(value?.lastCursor) || 0)),
    scopeVersion: Math.max(0, Math.floor(Number(value?.scopeVersion) || 0)),
    lastSyncAt: typeof value?.lastSyncAt === "string" ? value.lastSyncAt : null,
    lastSyncResult: text(value?.lastSyncResult, 240),
    lastError: text(value?.lastError, 500),
    connected,
  };
}

export function publicCloudSync(value = {}) {
  const config = normalizeCloudSync(value);
  return {
    endpoint: config.endpoint,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    teamId: config.teamId,
    teamName: config.teamName,
    storeNames: config.storeNames,
    lastCursor: config.lastCursor,
    scopeVersion: config.scopeVersion,
    lastSyncAt: config.lastSyncAt,
    lastSyncResult: config.lastSyncResult,
    lastError: config.lastError,
    connected: config.connected,
    deviceTokenMasked: config.tokenEncrypted ? maskSecret(decryptSecret(config.tokenEncrypted)) : "",
  };
}

async function requestCloud(endpoint, path, { token = "", method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { "x-ecom-cloud-device-token": token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(text(payload?.message, 500) || `云端请求失败：${response.status}`);
      error.status = response.status;
      error.code = text(payload?.code, 80);
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("云端同步超时，请检查网络或稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function remoteReportToLocal(remote, config, syncedAt) {
  const report = remote?.report;
  if (!report || typeof report !== "object" || !Array.isArray(report.rows)) return null;
  const remoteId = text(remote.remoteId, 120);
  if (!remoteId) return null;
  return {
    ...report,
    id: stableCloudReportId(config.endpoint, config.teamId, remoteId),
    storeName: text(remote.storeName, 80) || text(report.storeName, 80),
    sourceName: `云端同步 · ${config.teamName || "团队数据"}`.slice(0, 80),
    importedAt: typeof remote.updatedAt === "string" ? remote.updatedAt : syncedAt,
    cloudOrigin: cloudOrigin({
      endpoint: config.endpoint,
      teamId: config.teamId,
      remoteReportId: remoteId,
      revision: remote.revision,
      syncedAt,
    }),
  };
}

function reportOrigin(report) {
  return cloudOrigin(report?.cloudOrigin);
}

export async function activateCloudSync(current, input = {}) {
  const baseline = normalizeCloudSync(current);
  const endpoint = baseEndpoint(input.endpoint || baseline.endpoint);
  if (!endpoint) throw Object.assign(new Error("云端地址必须是 HTTPS 根地址，例如 https://jvspp.cloud。"), { status: 400 });
  const code = text(input.code, 40);
  if (!code) throw Object.assign(new Error("请输入团队授权码。"), { status: 400 });
  const deviceId = baseline.deviceId || id("cloud-device");
  const deviceName = text(input.deviceName, 80) || baseline.deviceName || os.hostname().slice(0, 80) || "本地应用";
  const response = await requestCloud(endpoint, "/api/device/activate", {
    method: "POST",
    body: { code, deviceId, deviceName, appVersion: text(input.appVersion, 40) },
  });
  if (!text(response?.token, 200)) throw new Error("云端未返回有效设备凭证。请重新生成授权码后重试。");
  const now = new Date().toISOString();
  return normalizeCloudSync({
    endpoint,
    deviceId,
    deviceName,
    tokenEncrypted: encryptSecret(response.token),
    teamId: text(response?.team?.id, 120),
    teamName: text(response?.team?.name, 80),
    storeNames: safeStoreNames(response?.device?.storeNames),
    lastCursor: Math.max(0, Math.floor(Number(response?.cursor) || 0)),
    scopeVersion: Math.max(0, Math.floor(Number(response?.device?.scopeVersion) || 0)),
    lastSyncAt: null,
    lastSyncResult: "已完成团队绑定，点击“同步云端数据”开始入库。",
    lastError: "",
    connectedAt: now,
  });
}

export function disconnectCloudSync(current) {
  const config = normalizeCloudSync(current);
  return normalizeCloudSync({
    endpoint: config.endpoint,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    lastSyncResult: "已断开云端团队。保留的本地数据不会被删除。",
  });
}

export async function syncCloudReports({ cloudSync, reports }) {
  const config = normalizeCloudSync(cloudSync);
  if (!config.connected) throw Object.assign(new Error("请先使用团队授权码绑定云端数据。"), { status: 409, code: "CLOUD_NOT_CONNECTED" });
  const token = decryptSecret(config.tokenEncrypted);
  if (!token) throw Object.assign(new Error("本机云端设备凭证不可用，请重新绑定团队授权码。"), { status: 409, code: "CLOUD_TOKEN_INVALID" });
  const response = await requestCloud(config.endpoint, `/api/device/sync?cursor=${config.lastCursor}&scopeVersion=${config.scopeVersion}`, { token });
  const remoteTeamId = text(response?.team?.id, 120);
  if (!remoteTeamId || remoteTeamId !== config.teamId) throw new Error("云端返回的团队与本机绑定信息不一致，已拒绝导入。");
  const syncedAt = new Date().toISOString();
  const incoming = (Array.isArray(response?.reports) ? response.reports : [])
    .map((remote) => remoteReportToLocal(remote, config, syncedAt))
    .filter(Boolean);
  const incomingByRemoteId = new Map(incoming.map((report) => [report.cloudOrigin.remoteReportId, report]));
  const allLocal = Array.isArray(reports) ? reports : [];
  const remoteForTeam = (report) => {
    const origin = reportOrigin(report);
    return origin && origin.endpoint === config.endpoint && origin.teamId === config.teamId ? origin : null;
  };
  const removed = new Set((Array.isArray(response?.removedIds) ? response.removedIds : []).map((value) => text(value, 120)).filter(Boolean));
  const activeRemoteIds = new Set((Array.isArray(response?.activeRemoteIds) ? response.activeRemoteIds : []).map((value) => text(value, 120)).filter(Boolean));
  const explicitlyRemoved = allLocal.filter((report) => {
    const origin = remoteForTeam(report);
    if (!origin || incomingByRemoteId.has(origin.remoteReportId)) return false;
    return response?.full ? !activeRemoteIds.has(origin.remoteReportId) : removed.has(origin.remoteReportId);
  }).length;
  let retained = allLocal.filter((report) => {
    const origin = remoteForTeam(report);
    if (!origin) return true;
    if (response?.full && Array.isArray(response.activeRemoteIds)) return activeRemoteIds.has(origin.remoteReportId);
    return !removed.has(origin.remoteReportId) && !incomingByRemoteId.has(origin.remoteReportId);
  });
  const existingRemoteIds = new Set(allLocal.map((report) => remoteForTeam(report)?.remoteReportId).filter(Boolean));
  retained = [...retained, ...incoming];
  const inserted = incoming.filter((report) => !existingRemoteIds.has(report.cloudOrigin.remoteReportId)).length;
  const updated = incoming.length - inserted;
  const nextCloudSync = normalizeCloudSync({
    ...config,
    teamName: text(response?.team?.name, 80) || config.teamName,
    storeNames: safeStoreNames((response?.device?.stores || []).map((store) => store?.name)),
    lastCursor: Math.max(config.lastCursor, Math.floor(Number(response?.cursor) || 0)),
    scopeVersion: Math.max(config.scopeVersion, Math.floor(Number(response?.device?.scopeVersion) || 0)),
    lastSyncAt: syncedAt,
    lastSyncResult: `已同步：新增 ${inserted} 份，更新 ${updated} 份，移除 ${explicitlyRemoved} 份云端来源报表。`,
    lastError: "",
  });
  return { reports: retained, cloudSync: nextCloudSync, result: { inserted, updated, removed: explicitlyRemoved, full: Boolean(response?.full), total: incoming.length } };
}
