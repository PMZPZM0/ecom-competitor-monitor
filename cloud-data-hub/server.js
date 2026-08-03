import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import { z } from "zod";
import {
  buildOperationsWorkspace,
  createProductCatalogEntries,
  createOperationsReport,
  OPERATIONS_REPORT_INPUT_TYPES,
  OPERATIONS_PERIOD_KINDS,
  parseOperationsFile,
  parseProductCatalogFile,
} from "../server/services/operationsAssistantService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4328);
const DATA_DIR = path.resolve(process.env.CLOUD_HUB_DATA_DIR || path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "hub.json");
const SESSION_COOKIE = "ecom_hub_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_TEAM_MEMBER_LIMIT = 500;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const MANAGED_CODE_ENCRYPTION_SECRET = String(process.env.MANAGED_CODE_ENCRYPTION_SECRET || process.env.CLOUD_ADMIN_PASSWORD || randomToken(48));
const LOGIN_USERNAME_PATTERN = /^(?=.{2,40}$)(?=.*[\p{Script=Han}A-Za-z0-9])[\p{Script=Han}A-Za-z0-9._-]+$/u;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const initialState = {
  schemaVersion: 5,
  platform: { allowTeamCreation: true },
  users: [],
  // A user account is global, while access and administration rights belong to
  // one specific team. Keeping this relationship separate lets one person join
  // several teams without leaking data or permissions between them.
  teamMemberships: [],
  teams: [],
  stores: [],
  devices: [],
  activationCodes: [],
  emailCodes: [],
  invitations: [],
  reports: [],
  // Team reports are stored separately because their raw files participate in
  // quota and retention.  The two operator-maintained ledgers below are small
  // structured records, but they must travel with reports into the same core
  // calculation to keep cloud and desktop GSV/fee-rate results identical.
  teamOperations: [],
  changes: [],
  audit: [],
  nextRevision: 1,
};

let dbReady = null;
let writeQueue = Promise.resolve();

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const key = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return { salt, key };
}

function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const candidate = hashPassword(password, user.passwordSalt).key;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(user.passwordHash));
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function normalizeLoginUsername(value) {
  const username = String(value || "").trim().normalize("NFKC");
  if (!LOGIN_USERNAME_PATTERN.test(username)) {
    throw Object.assign(new Error("用户名需为 2-40 位中文、字母、数字或 . _ -，并至少包含一个中文、字母或数字。"), { status: 400, code: "USERNAME_INVALID" });
  }
  return username;
}

function loginKey(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function accountByLoginName(db, value) {
  const key = loginKey(value);
  return db.users.find((user) => loginKey(user.username) === key || loginKey(user.email) === key) || null;
}

function normalizeDisplayName(value, fallback = "用户") {
  const accountName = String(fallback || "用户").trim();
  const fallbackName = (accountName.includes("@") ? accountName.split("@")[0] : accountName) || "用户";
  return (String(value || "").trim().replace(/\s+/g, " ") || fallbackName).slice(0, 40);
}

function managedCodeKey() {
  if (!MANAGED_CODE_ENCRYPTION_SECRET) {
    throw Object.assign(new Error("授权码加密服务尚未配置，请联系平台管理员。"), { status: 503, code: "MANAGED_CODE_ENCRYPTION_UNAVAILABLE" });
  }
  return crypto.createHash("sha256").update(MANAGED_CODE_ENCRYPTION_SECRET).digest();
}

function encryptManagedCode(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", managedCodeKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptManagedCode(value) {
  try {
    const [iv, tag, ciphertext] = String(value || "").split(".");
    if (!iv || !tag || !ciphertext) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", managedCodeKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function deviceCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const units = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  return `${units.slice(0, 4).join("")}-${units.slice(4, 8).join("")}-${units.slice(8).join("")}`;
}

function normalizeState(value = {}) {
  const teams = Array.isArray(value.teams) ? value.teams.map((team) => ({
    ...team,
    memberLimit: positiveInteger(team.memberLimit, defaultMemberLimit(team.plan)),
    storageQuotaBytes: positiveInteger(team.storageQuotaBytes, DEFAULT_STORAGE_QUOTA_BYTES),
  })) : [];
  // Deleted reports are intentionally absent from the normalized data model.
  // A user deletion is permanent; old soft-deleted rows are removed at startup.
  const reports = Array.isArray(value.reports) ? value.reports
    .filter((report) => report?.status !== "deleted" && report?.status !== "purged")
    .map((report) => ({
    ...report,
    rawBytes: Math.max(0, Number(report.rawBytes) || 0),
    createdByUserId: String(report.createdByUserId || ""),
    createdByUsername: String(report.createdByUsername || ""),
  })) : [];
  const teamOperations = Array.isArray(value.teamOperations) ? value.teamOperations
    .filter((item) => item && typeof item === "object" && String(item.teamId || "").trim())
    .map((item) => ({
      teamId: String(item.teamId).trim(),
      productCatalog: Array.isArray(item.productCatalog) ? item.productCatalog.slice(-20_000) : [],
      productCatalogSource: item.productCatalogSource && typeof item.productCatalogSource === "object"
        ? item.productCatalogSource
        : { fileName: "", updatedAt: null },
      salesDeductions: Array.isArray(item.salesDeductions) ? item.salesDeductions.slice(-2_000) : [],
    })) : [];
  const sourceUsers = Array.isArray(value.users) ? value.users : [];
  const platformAdminUserIds = new Set(sourceUsers.filter((user) => user?.role === "platform-admin").map((user) => String(user.id || "")));
  const validTeamIds = new Set(teams.map((team) => team.id));
  const membershipByKey = new Map();
  for (const source of Array.isArray(value.teamMemberships) ? value.teamMemberships : []) {
    if (!source || !validTeamIds.has(String(source.teamId || "")) || !String(source.userId || "").trim() || platformAdminUserIds.has(String(source.userId || ""))) continue;
    const userId = String(source.userId).trim();
    const teamId = String(source.teamId).trim();
    const key = `${userId}\u0000${teamId}`;
    if (membershipByKey.has(key)) continue;
    membershipByKey.set(key, {
      id: String(source.id || id("membership")),
      userId,
      teamId,
      role: source.role === "team-admin" ? "team-admin" : "member",
      status: source.status === "suspended" ? "suspended" : "active",
      note: String(source.note || "").trim().slice(0, 80),
      joinedAt: source.joinedAt || source.createdAt || now(),
      createdAt: source.createdAt || source.joinedAt || now(),
      updatedAt: source.updatedAt || source.joinedAt || now(),
    });
  }
  // Migrate every pre-membership account exactly once. `teamId` stays in the
  // user record only as a temporary compatibility mirror for old local clients.
  for (const source of sourceUsers) {
    if (source?.role === "platform-admin") continue;
    const legacyTeamId = String(source?.teamId || "").trim();
    if (!legacyTeamId || !validTeamIds.has(legacyTeamId) || !source?.id) continue;
    const key = `${source.id}\u0000${legacyTeamId}`;
    if (!membershipByKey.has(key)) {
      membershipByKey.set(key, {
        id: id("membership"), userId: source.id, teamId: legacyTeamId,
        role: source.role === "team-admin" ? "team-admin" : "member",
        status: "active", note: "", joinedAt: source.createdAt || now(),
        createdAt: source.createdAt || now(), updatedAt: now(),
      });
    }
  }
  const teamMemberships = [...membershipByKey.values()];
  const users = sourceUsers.map((source) => {
    const memberships = teamMemberships.filter((membership) => membership.userId === source.id && membership.status === "active" && teamById({ teams }, membership.teamId));
    const requestedActiveTeamId = String(source.activeTeamId || source.teamId || "").trim();
    const activeTeamId = memberships.some((membership) => membership.teamId === requestedActiveTeamId)
      ? requestedActiveTeamId
      : (memberships[0]?.teamId || "");
    return {
      ...source,
      role: source.role === "platform-admin" ? "platform-admin" : "member",
      displayName: normalizeDisplayName(source.displayName, source.username || source.email),
      activeTeamId,
      // Kept until all deployed clients have received the membership-aware UI.
      teamId: activeTeamId,
    };
  });
  return {
    ...initialState,
    ...value,
    schemaVersion: initialState.schemaVersion,
    platform: {
      ...initialState.platform,
      ...(value.platform && typeof value.platform === "object" ? value.platform : {}),
      allowTeamCreation: value.platform?.allowTeamCreation !== false,
    },
    users,
    teamMemberships,
    teams,
    stores: Array.isArray(value.stores) ? value.stores : [],
    devices: Array.isArray(value.devices) ? value.devices : [],
    activationCodes: Array.isArray(value.activationCodes) ? value.activationCodes : [],
    emailCodes: Array.isArray(value.emailCodes) ? value.emailCodes
      .filter((record) => record && typeof record === "object" && String(record.email || "").trim())
      .slice(-10_000) : [],
    reports,
    teamOperations,
    invitations: Array.isArray(value.invitations) ? value.invitations.map((invitation) => {
      const legacySingleUse = Boolean(invitation?.acceptedAt) && !Array.isArray(invitation?.acceptedUserIds);
      return {
        ...invitation,
        acceptanceCount: Math.max(0, Number(invitation?.acceptanceCount) || (invitation?.acceptedAt ? 1 : 0)),
        acceptedUserIds: Array.isArray(invitation?.acceptedUserIds) ? invitation.acceptedUserIds.slice(-MAX_TEAM_MEMBER_LIMIT) : [],
        lastAcceptedAt: invitation?.lastAcceptedAt || invitation?.acceptedAt || null,
        exhaustedAt: invitation?.exhaustedAt || (legacySingleUse ? invitation.acceptedAt : null),
      };
    }) : [],
    changes: Array.isArray(value.changes) ? value.changes : [],
    audit: Array.isArray(value.audit) ? value.audit : [],
    nextRevision: positiveInteger(value.nextRevision, 1),
  };
}

async function writeAtomic(value) {
  const temp = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  // Windows can keep a just-read file briefly locked. Retrying the final rename
  // preserves the all-or-nothing write without turning a transient lock into a
  // visible failed action in the management UI.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(temp, DB_PATH);
      return;
    } catch (error) {
      const retryable = error?.code === "EPERM" || error?.code === "EBUSY";
      if (!retryable || attempt === 4) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}

async function ensureDb() {
  if (dbReady) return dbReady;
  dbReady = (async () => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
      const legacyDeletedPaths = Array.isArray(raw.reports)
        ? raw.reports.filter((report) => report?.status === "deleted" || report?.status === "purged").map((report) => report.rawPath).filter(Boolean)
        : [];
      const existing = normalizeState(raw);
      await writeAtomic(existing);
      await Promise.all(legacyDeletedPaths.map((rawPath) => fs.rm(rawPath, { force: true }).catch(() => undefined)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeAtomic(initialState);
    }
  })().catch((error) => {
    dbReady = null;
    throw error;
  });
  return dbReady;
}

async function readDb() {
  await ensureDb();
  return normalizeState(JSON.parse(await fs.readFile(DB_PATH, "utf8")));
}

async function updateDb(mutator) {
  const task = writeQueue.then(async () => {
    const current = await readDb();
    const result = await mutator(current) || current;
    await writeAtomic(normalizeState(result));
    return result;
  });
  writeQueue = task.catch(() => undefined);
  return task;
}

function logAudit(db, { actor = "system", action, teamId = "", summary = "" }) {
  db.audit.push({ id: id("audit"), at: now(), actor, action, teamId, summary: String(summary).slice(0, 240) });
  db.audit = db.audit.slice(-600);
}

function appendChange(db, { teamId, kind, remoteReportId }) {
  const revision = db.nextRevision;
  db.nextRevision += 1;
  db.changes.push({ revision, at: now(), teamId, kind, remoteReportId });
  db.changes = db.changes.slice(-20_000);
  return revision;
}

function teamRecordById(db, teamId) {
  return db.teams.find((team) => team.id === teamId) || null;
}

function teamById(db, teamId) {
  const team = teamRecordById(db, teamId);
  return team?.status === "active" ? team : null;
}

function membershipsForUser(db, userId) {
  const user = db.users.find((item) => item.id === userId);
  if (!user || user.role === "platform-admin") return [];
  return db.teamMemberships.filter((membership) => membership.userId === userId);
}

function membershipsForTeam(db, teamId) {
  return db.teamMemberships.filter((membership) => {
    if (membership.teamId !== teamId) return false;
    const user = db.users.find((item) => item.id === membership.userId);
    return Boolean(user && user.role !== "platform-admin");
  });
}

function membershipForUser(db, userId, teamId) {
  return membershipsForUser(db, userId).find((membership) => membership.teamId === teamId) || null;
}

function activeMembershipForUser(db, user, teamId) {
  const membership = membershipForUser(db, user.id, teamId);
  return membership?.status === "active" && teamById(db, teamId) ? membership : null;
}

function setActiveTeamForUser(db, user, teamId) {
  const membership = teamId ? activeMembershipForUser(db, user, teamId) : null;
  user.activeTeamId = membership?.teamId || "";
  // Legacy local clients read teamId; keep it synchronized during the rollout.
  user.teamId = user.activeTeamId;
  return membership;
}

function firstAvailableMembership(db, user) {
  return membershipsForUser(db, user.id).find((membership) => (
    membership.status === "active" && Boolean(teamById(db, membership.teamId))
  )) || null;
}

function publicMembership(db, membership) {
  const team = teamRecordById(db, membership.teamId);
  return {
    id: membership.id,
    teamId: membership.teamId,
    teamName: team?.name || "已删除团队",
    teamStatus: team?.status || "deleted",
    role: membership.role,
    status: membership.status,
    note: membership.note || "",
    joinedAt: membership.joinedAt,
  };
}

function storesForTeam(db, teamId) {
  return db.stores.filter((store) => store.teamId === teamId && store.status === "active");
}

function reportsForTeam(db, teamId, { includeDeleted = false } = {}) {
  return db.reports.filter((report) => report.teamId === teamId && (includeDeleted || report.status === "active"));
}

function teamOperationsFor(db, teamId, { create = false } = {}) {
  let record = db.teamOperations.find((item) => item.teamId === teamId) || null;
  if (!record && create) {
    record = {
      teamId,
      productCatalog: [],
      productCatalogSource: { fileName: "", updatedAt: null },
      salesDeductions: [],
    };
    db.teamOperations.push(record);
  }
  return record;
}

function operationsInputForTeam(db, teamId) {
  const operations = teamOperationsFor(db, teamId);
  return {
    productCatalog: operations?.productCatalog || [],
    productCatalogSource: operations?.productCatalogSource || { fileName: "", updatedAt: null },
    salesDeductions: operations?.salesDeductions || [],
  };
}

function workspaceForTeam(db, teamId, filters = {}) {
  return buildOperationsWorkspace({
    reports: reportsForTeam(db, teamId).map((item) => item.report),
    storeNames: storesForTeam(db, teamId).map((item) => item.name),
    ...operationsInputForTeam(db, teamId),
  }, { filters });
}

function latestProductCatalogEntries(entries = []) {
  const latest = new Map();
  const replacedIds = new Set(entries.map((entry) => entry.replacesId).filter(Boolean));
  for (const entry of entries) {
    if (replacedIds.has(entry.id)) continue;
    const key = `${String(entry.storeName || "").trim().toLocaleLowerCase("zh-CN")}\u0000${String(entry.productId || "").trim()}`;
    latest.set(key, entry);
  }
  return [...latest.values()].sort((left, right) => (
    String(left.storeName || "").localeCompare(String(right.storeName || ""), "zh-CN")
    || String(left.category || "").localeCompare(String(right.category || ""), "zh-CN")
    || String(left.productId || "").localeCompare(String(right.productId || ""))
  ));
}

function findActiveStoreByName(db, teamId, name) {
  const normalized = String(name || "").trim();
  return storesForTeam(db, teamId).find((store) => store.name.localeCompare(normalized, "zh-CN", { sensitivity: "accent" }) === 0) || null;
}

function ensureActiveStoreByName(db, teamId, name) {
  const normalized = String(name || "").trim();
  if (!normalized) return null;
  const existing = findActiveStoreByName(db, teamId, normalized);
  if (existing) return existing;
  const store = { id: id("store"), teamId, name: normalized, status: "active", createdAt: now() };
  db.stores.push(store);
  return store;
}

function storageForTeam(db, teamId) {
  // Current and superseded versions remain part of the archive. User-deleted
  // files have already been removed from both disk and the database.
  const usedBytes = db.reports
    .filter((report) => report.teamId === teamId)
    .reduce((total, report) => total + Math.max(0, Number(report.rawBytes) || 0), 0);
  const quotaBytes = positiveInteger(teamById(db, teamId)?.storageQuotaBytes, DEFAULT_STORAGE_QUOTA_BYTES);
  return {
    usedBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    usageRatio: quotaBytes ? usedBytes / quotaBytes : 0,
  };
}

function assertStorageAvailable(db, teamId, additionalBytes) {
  const storage = storageForTeam(db, teamId);
  if (storage.usedBytes + additionalBytes > storage.quotaBytes) {
    throw Object.assign(new Error(`团队云空间不足：当前已使用 ${formatBytes(storage.usedBytes)}，剩余 ${formatBytes(storage.remainingBytes)}。请清理不需要的历史报表后重试。`), { status: 413, code: "TEAM_STORAGE_LIMIT" });
  }
  return storage;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function publicTeam(db, team) {
  const stores = storesForTeam(db, team.id);
  const devices = db.devices.filter((device) => device.teamId === team.id && !device.revokedAt);
  const reports = reportsForTeam(db, team.id);
  const storage = storageForTeam(db, team.id);
  const memberCount = membershipsForTeam(db, team.id).length;
  const memberLimit = Number.isInteger(Number(team.memberLimit)) && Number(team.memberLimit) > 0 ? Number(team.memberLimit) : null;
  return {
    id: team.id,
    name: team.name,
    plan: team.plan,
    deviceLimit: team.deviceLimit,
    memberCount,
    memberLimit,
    status: team.status,
    createdAt: team.createdAt,
    storeCount: stores.length,
    activeDeviceCount: devices.length,
    reportCount: reports.length,
    storage,
  };
}

function teamMemberCapacity(db, team) {
  const memberCount = membershipsForTeam(db, team.id).length;
  const memberLimit = Number.isInteger(Number(team.memberLimit)) && Number(team.memberLimit) > 0 ? Number(team.memberLimit) : null;
  return { memberCount, memberLimit, available: memberLimit === null || memberCount < memberLimit };
}

function exhaustTeamInvitations(db, teamId) {
  const exhaustedAt = now();
  for (const invitation of db.invitations.filter((item) => item.teamId === teamId && !item.revokedAt && !item.exhaustedAt)) {
    invitation.exhaustedAt = exhaustedAt;
  }
}

function publicInvitation(invitation) {
  const code = decryptManagedCode(invitation.codeCipher);
  return {
    id: invitation.id,
    label: invitation.label,
    createdByUsername: invitation.createdByUsername,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptanceCount: Number(invitation.acceptanceCount) || 0,
    lastAcceptedAt: invitation.lastAcceptedAt || null,
    exhaustedAt: invitation.exhaustedAt || null,
    revokedAt: invitation.revokedAt || null,
    code: code || null,
    recoverable: Boolean(code),
  };
}

function publicActivationCode(code) {
  const rawCode = decryptManagedCode(code.codeCipher);
  return {
    id: code.id,
    label: code.label,
    mode: code.mode,
    maxActivations: code.maxActivations,
    activationCount: code.activationCount || 0,
    expiresAt: code.expiresAt,
    revokedAt: code.revokedAt || null,
    createdAt: code.createdAt,
    storeIds: code.storeIds || [],
    code: rawCode || null,
    recoverable: Boolean(rawCode),
  };
}

function publicStore(store) {
  return { id: store.id, name: store.name, status: store.status, createdAt: store.createdAt };
}

function publicDevice(db, device) {
  const names = new Map(storesForTeam(db, device.teamId).map((store) => [store.id, store.name]));
  return {
    id: device.id,
    label: device.label,
    storeIds: device.storeIds || [],
    storeNames: (device.storeIds || []).map((storeId) => names.get(storeId)).filter(Boolean),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    revokedAt: device.revokedAt || null,
    scopeVersion: device.scopeVersion || 1,
  };
}

function publicReport(db, stored) {
  const store = db.stores.find((item) => item.id === stored.storeId);
  return {
    id: stored.id,
    storeId: stored.storeId,
    storeName: store?.name || stored.storeName || "",
    type: stored.report.type,
    fileName: stored.report.fileName,
    periodKind: stored.report.periodKind,
    periodStart: stored.report.periodStart,
    periodEnd: stored.report.periodEnd,
    periodLabel: stored.report.periodLabel,
    rowCount: stored.report.rows?.length || 0,
    version: stored.version,
    status: stored.status,
    rawBytes: Math.max(0, Number(stored.rawBytes) || 0),
    createdByUserId: stored.createdByUserId || "",
    createdByUsername: stored.createdByUsername || "",
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function publicUser(db, user) {
  return {
    id: user.id,
    username: user.username,
    displayName: normalizeDisplayName(user.displayName, user.username || user.email),
    role: user.role,
    teamId: user.activeTeamId || user.teamId || "",
    memberships: membershipsForUser(db, user.id)
      .map((membership) => publicMembership(db, membership))
      .filter((membership) => membership.teamStatus !== "deleted"),
    status: user.status || "active",
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function publicPlatformSettings(db) {
  return { allowTeamCreation: db.platform?.allowTeamCreation !== false };
}

function sessionFromRequest(req) {
  const raw = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const sessionId = raw.slice(`${SESSION_COOKIE}=`.length);
  return sessionId || null;
}

function sessions() {
  return globalThis.__ecomHubSessions ||= new Map();
}

function getSession(req) {
  const entry = sessions().get(sessionFromRequest(req));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

function setSession(res, user) {
  const sessionId = randomToken(32);
  // Role and team are reloaded for every request. A stale session must never
  // retain a revoked team permission after a member transfer or role change.
  sessions().set(sessionId, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  const secure = process.env.COOKIE_SECURE !== "false";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${secure ? "; Secure" : ""}`);
}

function clearSession(req, res) {
  const sessionId = sessionFromRequest(req);
  if (sessionId) sessions().delete(sessionId);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.COOKIE_SECURE !== "false" ? "; Secure" : ""}`);
}

function dropSessions(match) {
  for (const [sessionId, session] of sessions()) {
    if (match(session)) sessions().delete(sessionId);
  }
}

async function removeUploadedFiles(paths) {
  const uploadRoot = `${path.resolve(UPLOAD_DIR)}${path.sep}`;
  await Promise.all([...new Set(paths)]
    .map((rawPath) => path.resolve(String(rawPath || "")))
    .filter((rawPath) => rawPath.startsWith(uploadRoot))
    .map((rawPath) => fs.rm(rawPath, { force: true }).catch(() => undefined)));
}

async function deleteTeamAndPreserveAccounts({ teamId, confirmName, actor, auditAction }) {
  const paths = [];
  let removed = null;
  let actorAfterDeletion = null;
  await updateDb((next) => {
    const team = teamRecordById(next, teamId);
    if (!team) throw Object.assign(new Error("团队不存在。"), { status: 404 });
    if (confirmName !== team.name) throw Object.assign(new Error("确认名称不匹配，未执行永久删除。"), { status: 400 });
    const members = membershipsForTeam(next, team.id);
    const memberCount = members.length;
    const reportRows = next.reports.filter((report) => report.teamId === team.id);
    const deletedAt = now();
    paths.push(...reportRows.map((report) => report.rawPath));
    removed = { name: team.name, members: memberCount, reports: reportRows.length };
    next.teams = next.teams.filter((item) => item.id !== team.id);
    next.stores = next.stores.filter((item) => item.teamId !== team.id);
    next.devices = next.devices.filter((item) => item.teamId !== team.id);
    next.activationCodes = next.activationCodes.filter((item) => item.teamId !== team.id);
    next.invitations = next.invitations.filter((item) => item.teamId !== team.id);
    next.reports = next.reports.filter((item) => item.teamId !== team.id);
    next.teamOperations = next.teamOperations.filter((item) => item.teamId !== team.id);
    next.changes = next.changes.filter((item) => item.teamId !== team.id);
    next.teamMemberships = next.teamMemberships.filter((membership) => membership.teamId !== team.id);
    for (const user of next.users) {
      if (user.activeTeamId !== team.id && user.teamId !== team.id) continue;
      const fallback = firstAvailableMembership(next, user);
      setActiveTeamForUser(next, user, fallback?.teamId || "");
      user.leftTeamAt = deletedAt;
      user.teamDeletedAt = deletedAt;
      if (user.id === actor.id) actorAfterDeletion = user;
    }
    logAudit(next, {
      actor: actor.username,
      action: auditAction,
      teamId: team.id,
      summary: `永久删除团队：${team.name}；已保留 ${memberCount} 个成员账号，报表 ${reportRows.length} 份`,
    });
    return next;
  });
  await removeUploadedFiles(paths);
  return { removed, actorAfterDeletion };
}

async function requireUser(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ message: "请先登录云端管理后台。" });
  const db = await readDb();
  const user = db.users.find((item) => item.id === session.userId);
  if (!user) return res.status(401).json({ message: "登录已失效，请重新登录。" });
  if (user.status !== "active") {
    sessions().delete(sessionFromRequest(req));
    clearSession(req, res);
    return res.status(403).json({ message: "该账号已被停用，无法登录。", code: "ACCOUNT_SUSPENDED" });
  }
  const active = activeMembershipForUser(db, user, user.activeTeamId || user.teamId);
  if ((user.activeTeamId || user.teamId) && !active && user.role !== "platform-admin") {
    const fallback = firstAvailableMembership(db, user);
    await updateDb((next) => {
      const target = next.users.find((item) => item.id === user.id);
      if (target) setActiveTeamForUser(next, target, fallback?.teamId || "");
      return next;
    });
    const refreshed = await readDb();
    const target = refreshed.users.find((item) => item.id === user.id);
    req.hub = { db: refreshed, user: target, session };
    return next();
  }
  req.hub = { db, user, session };
  next();
}

function canManageTeam(db, user, teamId) {
  return user.role === "platform-admin" || activeMembershipForUser(db, user, teamId)?.role === "team-admin";
}

function canAccessTeam(db, user, teamId) {
  return user.role === "platform-admin" || Boolean(activeMembershipForUser(db, user, teamId));
}

function canDeleteReport(db, user, report) {
  return canManageTeam(db, user, report.teamId) || report.createdByUserId === user.id;
}

function requireTeamMember(req, res, next) {
  const teamId = req.params.teamId;
  if (!canAccessTeam(req.hub.db, req.hub.user, teamId)) return res.status(403).json({ message: "你不属于此团队，不能查看或上传团队数据。" });
  if (!teamById(req.hub.db, teamId)) return res.status(404).json({ message: "团队不存在或已停用。" });
  next();
}

function requireTeamManager(req, res, next) {
  const teamId = req.params.teamId;
  if (!canManageTeam(req.hub.db, req.hub.user, teamId)) return res.status(403).json({ message: "你没有管理此团队的权限。" });
  const team = teamRecordById(req.hub.db, teamId);
  if (!team) return res.status(404).json({ message: "团队不存在。" });
  if (team.status !== "active" && req.hub.user.role !== "platform-admin") return res.status(403).json({ message: "团队已被封禁。" });
  req.hub.team = team;
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (req.hub.user.role !== "platform-admin") return res.status(403).json({ message: "需要平台管理员权限。" });
  next();
}

function cleanupExpiredCodes(db) {
  const at = Date.now();
  db.activationCodes = db.activationCodes.map((code) => (
    !code.revokedAt && Date.parse(code.expiresAt || "") <= at ? { ...code, revokedAt: now(), revokedReason: "expired" } : code
  ));
}

async function ensureInitialAdmin() {
  await updateDb((db) => {
    if (db.users.some((user) => user.role === "platform-admin" && user.status === "active")) return db;
    const username = String(process.env.CLOUD_ADMIN_USERNAME || "owner").trim() || "owner";
    const generated = String(process.env.CLOUD_ADMIN_PASSWORD || randomToken(20));
    const password = hashPassword(generated);
    db.users.push({ id: id("user"), username, displayName: normalizeDisplayName("", username), role: "platform-admin", teamId: "", passwordHash: password.key, passwordSalt: password.salt, status: "active", createdAt: now() });
    logAudit(db, { action: "platform.bootstrap", summary: `已创建平台管理员 ${username}` });
    if (!process.env.CLOUD_ADMIN_PASSWORD) console.log(`[cloud-hub] 初始管理员密码（仅显示一次）: ${generated}`);
    return db;
  });
}

function parseManagedInput(input) {
  return z.object({
    name: z.string().trim().min(2).max(80),
    plan: z.enum(["personal", "team"]),
    memberLimit: z.coerce.number().int().min(2).max(MAX_TEAM_MEMBER_LIMIT),
    storageQuotaBytes: z.coerce.number().int().min(256 * 1024 * 1024).max(100 * 1024 ** 3).optional(),
  }).parse(input);
}

function defaultDeviceLimit(plan) {
  return plan === "personal" ? 2 : 6;
}

function defaultMemberLimit(_plan) {
  return 6;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.get("/api/health", async (_req, res) => {
  const db = await readDb();
  res.json({ ok: true, service: "ecom-operations-cloud-hub", teams: db.teams.filter((team) => team.status === "active").length, revision: db.nextRevision - 1, time: now() });
});

app.get("/api/public/settings", async (_req, res) => {
  const db = await readDb();
  res.json(publicPlatformSettings(db));
});

app.get("/api/templates/product-catalog.xlsx", requireUser, async (_req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "经营罗盘";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("商品资料", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  sheet.columns = [
    { header: "店铺名", key: "storeName", width: 28 },
    { header: "商品ID", key: "productId", width: 22, style: { numFmt: "@" } },
    { header: "品类名", key: "category", width: 20 },
    { header: "型号", key: "model", width: 24 },
  ];
  sheet.addRow({ storeName: "示例店铺", productId: "1234567890", category: "电饭煲", model: "示例型号-01" });
  sheet.autoFilter = "A1:D2";
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563C8" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
  sheet.getRow(2).height = 24;
  sheet.getRow(2).eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF43566F" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F7FF" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD9E5F4" } } };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%E5%95%86%E5%93%81%E8%B5%84%E6%96%99%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx");
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(buffer));
});

app.post("/api/auth/email-code", async (req, res) => {
  res.status(410).json({ message: "当前仅支持团队邀请码注册，不再发送邮箱验证码。", code: "EMAIL_REGISTRATION_DISABLED" });
});

app.post("/api/auth/register", async (req, res) => {
  const input = z.object({
    username: z.string().trim().min(2).max(40),
    inviteCode: z.string().trim().min(8).max(80),
    password: z.string().min(10).max(240),
  }).strict().parse(req.body || {});
  const username = normalizeLoginUsername(input.username);
  const password = hashPassword(input.password);
  let created;
  await updateDb((db) => {
    if (accountByLoginName(db, username)) {
      throw Object.assign(new Error("该用户名已被使用，请换一个用户名。"), { status: 409, code: "USERNAME_ALREADY_REGISTERED" });
    }
    const invitation = db.invitations.find((item) => item.codeHash === sha256(input.inviteCode));
    if (!invitation || invitation.revokedAt || invitation.exhaustedAt || Date.parse(invitation.expiresAt || "") <= Date.now() || !teamById(db, invitation.teamId)) {
      throw Object.assign(new Error("团队邀请码无效、已使用或已过期。"), { status: 400, code: "INVITATION_INVALID" });
    }
    if (invitation) {
      const capacity = teamMemberCapacity(db, teamById(db, invitation.teamId));
      if (!capacity.available) {
        exhaustTeamInvitations(db, invitation.teamId);
        throw Object.assign(new Error("该团队成员名额已满，邀请码已自动失效。"), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
      }
    }
    created = {
      id: id("user"), username, displayName: username, role: "member", teamId: invitation.teamId, activeTeamId: invitation.teamId,
      passwordHash: password.key, passwordSalt: password.salt, status: "active", createdAt: now(),
    };
    db.users.push(created);
    db.teamMemberships.push({
      id: id("membership"), userId: created.id, teamId: invitation.teamId, role: "member", status: "active", note: "",
      joinedAt: now(), createdAt: now(), updatedAt: now(),
    });
    {
      invitation.acceptanceCount = Number(invitation.acceptanceCount || 0) + 1;
      invitation.lastAcceptedAt = now();
      invitation.acceptedUserIds = [...(invitation.acceptedUserIds || []), created.id].slice(-MAX_TEAM_MEMBER_LIMIT);
      if (!teamMemberCapacity(db, teamById(db, invitation.teamId)).available) exhaustTeamInvitations(db, invitation.teamId);
      logAudit(db, { actor: created.username, action: "team.invite.register", teamId: invitation.teamId, summary: "通过团队邀请码免验证码注册并加入团队" });
      logAudit(db, { actor: created.username, action: "auth.register", teamId: invitation.teamId, summary: "通过团队邀请码注册并加入团队" });
    }
    return db;
  });
  setSession(res, created);
  const db = await readDb();
  res.status(201).json({ user: publicUser(db, created) });
});

app.post("/api/teams", requireUser, async (req, res) => {
  if (!publicPlatformSettings(req.hub.db).allowTeamCreation) {
    return res.status(403).json({ message: "当前仅开放邀请码加入团队，暂不开放自助创建个人或团队空间。", code: "TEAM_CREATION_DISABLED" });
  }
  if (req.hub.user.role !== "member") {
    return res.status(409).json({ message: "平台管理员不需要通过此入口创建团队。" });
  }
  const input = z.object({
    name: z.string().trim().min(2).max(80),
    plan: z.enum(["personal", "team"]).default("team"),
    memberLimit: z.coerce.number().int().min(2).max(MAX_TEAM_MEMBER_LIMIT).optional(),
  }).parse(req.body || {});
  let created;
  let primaryStore;
  let promoted;
  await updateDb((db) => {
    if (db.teams.some((team) => team.name.localeCompare(input.name, "zh-CN", { sensitivity: "accent" }) === 0 && team.status === "active")) {
      throw Object.assign(new Error("团队名称已存在。"), { status: 409 });
    }
    const deviceLimit = defaultDeviceLimit(input.plan);
    created = {
      id: id("team"), name: input.name, plan: input.plan, deviceLimit,
      memberLimit: input.memberLimit || defaultMemberLimit(input.plan),
      storageQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES, status: "active", createdAt: now(), updatedAt: now(),
    };
    primaryStore = { id: id("store"), teamId: created.id, name: created.name, status: "active", createdAt: now() };
    const user = db.users.find((item) => item.id === req.hub.user.id);
    if (!user) throw Object.assign(new Error("当前账号状态已变化，请刷新后重试。"), { status: 409 });
    user.activeTeamId = created.id;
    user.teamId = created.id;
    db.teamMemberships.push({ id: id("membership"), userId: user.id, teamId: created.id, role: "team-admin", status: "active", note: "", joinedAt: now(), createdAt: now(), updatedAt: now() });
    promoted = user;
    db.teams.push(created);
    db.stores.push(primaryStore);
    logAudit(db, { actor: user.username, action: "team.self-create", teamId: created.id, summary: `创建团队并成为管理员：${created.name}` });
    return db;
  });
  setSession(res, promoted);
  const db = await readDb();
  res.status(201).json({ team: publicTeam(db, created), user: publicUser(db, promoted) });
});

app.post("/api/teams/:teamId/invitations", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ label: z.string().trim().min(1).max(80).optional().default("团队成员邀请"), expiresInDays: z.coerce.number().int().min(1).max(30).optional().default(7) }).parse(req.body || {});
  const rawCode = deviceCode();
  let invitation;
  await updateDb((db) => {
    const team = teamById(db, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已停用。"), { status: 404 });
    const capacity = teamMemberCapacity(db, team);
    if (!capacity.available) throw Object.assign(new Error("团队成员名额已满，无法生成新邀请码。"), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
    invitation = {
      id: id("invite"), teamId: req.params.teamId, label: input.label, codeHash: sha256(rawCode), codeCipher: encryptManagedCode(rawCode),
      createdByUserId: req.hub.user.id, createdByUsername: req.hub.user.username,
      createdAt: now(), expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000).toISOString(), acceptanceCount: 0, acceptedUserIds: [], lastAcceptedAt: null, exhaustedAt: null, revokedAt: null,
    };
    db.invitations.push(invitation);
    logAudit(db, { actor: req.hub.user.username, action: "team.invite.create", teamId: invitation.teamId, summary: `生成多人邀请码：${invitation.label}` });
    return db;
  });
  res.status(201).json({ id: invitation.id, code: rawCode, expiresAt: invitation.expiresAt, message: "邀请码已安全保存，可在团队管理中继续查看、复制或撤销。" });
});

app.post("/api/teams/:teamId/leave", requireUser, requireTeamMember, async (req, res) => {
  let updatedUser;
  await updateDb((db) => {
    const user = db.users.find((item) => item.id === req.hub.user.id);
    const membership = activeMembershipForUser(db, user, req.params.teamId);
    if (!user || !membership) throw Object.assign(new Error("你当前不属于这个团队。"), { status: 409 });
    const otherAdmins = membershipsForTeam(db, req.params.teamId).filter((item) => item.role === "team-admin" && item.status === "active" && item.userId !== user.id);
    if (membership.role === "team-admin" && !otherAdmins.length) {
      throw Object.assign(new Error("你是当前唯一的团队管理员。请先新增另一位团队管理员，或由平台管理员删除团队。"), { status: 409, code: "LAST_TEAM_ADMIN" });
    }
    db.teamMemberships = db.teamMemberships.filter((item) => item.id !== membership.id);
    setActiveTeamForUser(db, user, firstAvailableMembership(db, user)?.teamId || "");
    user.leftTeamAt = now();
    updatedUser = user;
    logAudit(db, { actor: user.username, action: "team.leave", teamId: req.params.teamId, summary: "成员主动退出团队" });
    return db;
  });
  setSession(res, updatedUser);
  const db = await readDb();
  res.json({ user: publicUser(db, updatedUser), message: "已退出团队，账号和登录凭据已保留。" });
});

app.delete("/api/teams/:teamId/invitations/:invitationId", requireUser, requireTeamManager, async (req, res) => {
  await updateDb((db) => {
    const invitation = db.invitations.find((item) => item.id === req.params.invitationId && item.teamId === req.params.teamId && !item.revokedAt);
    if (!invitation) throw Object.assign(new Error("邀请不存在或已撤销。"), { status: 404 });
    invitation.revokedAt = now();
    logAudit(db, { actor: req.hub.user.username, action: "team.invite.revoke", teamId: invitation.teamId, summary: `撤销成员邀请：${invitation.label}` });
    return db;
  });
  res.status(204).end();
});

app.post("/api/auth/invitations/accept", requireUser, async (req, res) => {
  const input = z.object({ code: z.string().trim().min(8).max(40) }).parse(req.body || {});
  let updatedUser;
  let capacityError = null;
  await updateDb((db) => {
    const invitation = db.invitations.find((item) => item.codeHash === sha256(input.code));
    if (!invitation || invitation.revokedAt || invitation.exhaustedAt || Date.parse(invitation.expiresAt || "") <= Date.now()) throw Object.assign(new Error("邀请码无效或已过期。"), { status: 401 });
    const team = teamById(db, invitation.teamId);
    if (!team) throw Object.assign(new Error("邀请所属团队不可用。"), { status: 403 });
    if (!teamMemberCapacity(db, team).available) {
      exhaustTeamInvitations(db, team.id);
      capacityError = Object.assign(new Error("该团队成员名额已满，邀请码已自动失效。"), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
      return db;
    }
    const user = db.users.find((item) => item.id === req.hub.user.id);
    if (!user) throw Object.assign(new Error("当前账号状态已变化，请刷新后重试。"), { status: 409 });
    const existing = membershipForUser(db, user.id, team.id);
    if (existing?.status === "active") throw Object.assign(new Error("你已经加入这个团队。"), { status: 409 });
    db.teamMemberships = db.teamMemberships.filter((item) => item.id !== existing?.id);
    db.teamMemberships.push({ id: id("membership"), userId: user.id, teamId: team.id, role: "member", status: "active", note: "", joinedAt: now(), createdAt: now(), updatedAt: now() });
    setActiveTeamForUser(db, user, team.id);
    invitation.acceptanceCount = Number(invitation.acceptanceCount || 0) + 1;
    invitation.lastAcceptedAt = now();
    invitation.acceptedUserIds = [...(invitation.acceptedUserIds || []), user.id].slice(-MAX_TEAM_MEMBER_LIMIT);
    if (!teamMemberCapacity(db, team).available) exhaustTeamInvitations(db, team.id);
    updatedUser = user;
    logAudit(db, { actor: user.username, action: "team.invite.accept", teamId: team.id, summary: "通过邀请码加入团队" });
    return db;
  });
  if (capacityError) throw capacityError;
  setSession(res, updatedUser);
  const db = await readDb();
  res.json({ user: publicUser(db, updatedUser) });
});

app.post("/api/auth/login", async (req, res) => {
  const input = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(240) }).parse(req.body || {});
  const db = await readDb();
  const user = accountByLoginName(db, input.username);
  if (!user || !verifyPassword(input.password, user)) return res.status(401).json({ message: "账号或密码不正确。" });
  if (user.status !== "active") return res.status(403).json({ message: "该账号已被停用，无法登录。", code: "ACCOUNT_SUSPENDED" });
  const fallback = user.role === "platform-admin" ? null : firstAvailableMembership(db, user);
  if (fallback && (user.activeTeamId || user.teamId) !== fallback.teamId) {
    setActiveTeamForUser(db, user, fallback.teamId);
  }
  setSession(res, user);
  await updateDb((next) => {
    const target = next.users.find((item) => item.id === user.id);
    if (target) target.lastLoginAt = now();
    logAudit(next, { actor: user.username, action: "auth.login", teamId: user.activeTeamId || "", summary: "登录管理后台" });
    return next;
  });
  const refreshed = await readDb();
  res.json({ user: publicUser(refreshed, refreshed.users.find((item) => item.id === user.id) || user) });
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.status(204).end();
});

app.get("/api/session", requireUser, (req, res) => {
  res.json({ user: publicUser(req.hub.db, req.hub.user) });
});

app.patch("/api/account/profile", requireUser, async (req, res) => {
  const input = z.object({ displayName: z.string().trim().min(1).max(40) }).strict().parse(req.body || {});
  const db = await updateDb((next) => {
    const user = next.users.find((item) => item.id === req.hub.user.id);
    if (!user) throw Object.assign(new Error("账号不存在。"), { status: 404 });
    user.displayName = normalizeDisplayName(input.displayName, user.username || user.email);
    user.updatedAt = now();
    logAudit(next, { actor: user.username, action: "account.profile.update", teamId: user.activeTeamId || "", summary: `修改显示名称：${user.displayName}` });
    return next;
  });
  const user = db.users.find((item) => item.id === req.hub.user.id);
  res.json({ user: publicUser(db, user), message: "个人名称已更新，登录账号保持不变。" });
});

app.post("/api/session/team", requireUser, async (req, res) => {
  const input = z.object({ teamId: z.string().trim().min(1) }).strict().parse(req.body || {});
  const db = await updateDb((next) => {
    const user = next.users.find((item) => item.id === req.hub.user.id);
    if (!user) throw Object.assign(new Error("账号不存在。"), { status: 401 });
    if (user.role !== "platform-admin" && !activeMembershipForUser(next, user, input.teamId)) {
      throw Object.assign(new Error("你没有加入这个团队，或该团队已暂停。"), { status: 403 });
    }
    if (user.role === "platform-admin") {
      const team = teamById(next, input.teamId);
      if (!team) throw Object.assign(new Error("团队不存在或已停用。"), { status: 404 });
      user.activeTeamId = input.teamId;
      user.teamId = input.teamId;
    } else {
      setActiveTeamForUser(next, user, input.teamId);
    }
    logAudit(next, { actor: user.username, action: "team.switch", teamId: input.teamId, summary: "切换当前工作团队" });
    return next;
  });
  const user = db.users.find((item) => item.id === req.hub.user.id);
  res.json({ user: publicUser(db, user), message: `已切换到${publicMembership(db, membershipForUser(db, user.id, input.teamId) || { teamId: input.teamId, role: "platform-admin", status: "active", note: "" }).teamName}。` });
});

app.get("/api/admin/overview", requireUser, async (req, res) => {
  const db = await readDb();
  const teams = req.hub.user.role === "platform-admin"
    ? db.teams
    : db.teams.filter((team) => membershipsForUser(db, req.hub.user.id).some((membership) => membership.teamId === team.id && membership.status === "active") && team.status === "active");
  res.json({
    teams: teams.map((team) => publicTeam(db, team)),
    audit: db.audit.filter((item) => req.hub.user.role === "platform-admin" || membershipsForUser(db, req.hub.user.id).some((membership) => membership.teamId === item.teamId)).slice(-80).reverse(),
    platform: req.hub.user.role === "platform-admin" ? publicPlatformSettings(db) : undefined,
  });
});

app.patch("/api/admin/platform/settings", requireUser, requirePlatformAdmin, async (req, res) => {
  const input = z.object({ allowTeamCreation: z.boolean() }).parse(req.body || {});
  const db = await updateDb((next) => {
    next.platform = { ...publicPlatformSettings(next), allowTeamCreation: input.allowTeamCreation };
    logAudit(next, { actor: req.hub.user.username, action: "platform.team-creation.update", summary: input.allowTeamCreation ? "开启普通用户自助创建团队" : "关闭普通用户自助创建团队" });
    return next;
  });
  res.json({ platform: publicPlatformSettings(db), message: input.allowTeamCreation ? "已开启普通用户自助创建团队。" : "已关闭普通用户自助创建团队，普通用户只能通过邀请码加入。" });
});

app.post("/api/admin/teams", requireUser, requirePlatformAdmin, async (req, res) => {
  const input = parseManagedInput(req.body || {});
  const team = {
    id: id("team"), ...input,
    deviceLimit: defaultDeviceLimit(input.plan),
    storageQuotaBytes: input.storageQuotaBytes || DEFAULT_STORAGE_QUOTA_BYTES,
    status: "active", createdAt: now(), updatedAt: now(),
  };
  const primaryStore = { id: id("store"), teamId: team.id, name: team.name, status: "active", createdAt: now() };
  const db = await updateDb((next) => {
    const duplicate = next.teams.some((item) => item.name.localeCompare(team.name, "zh-CN", { sensitivity: "accent" }) === 0 && item.status === "active");
    if (duplicate) throw Object.assign(new Error("团队名称已存在。"), { status: 409 });
    next.teams.push(team);
    next.stores.push(primaryStore);
    logAudit(next, { actor: req.hub.user.username, action: "team.create", teamId: team.id, summary: `创建团队：${team.name}` });
    return next;
  });
  res.status(201).json({ team: publicTeam(db, team) });
});

app.post("/api/admin/teams/:teamId/suspend", requireUser, requirePlatformAdmin, async (req, res) => {
  const input = z.object({ reason: z.string().trim().max(180).optional().default("") }).parse(req.body || {});
  const db = await updateDb((next) => {
    const team = teamRecordById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在。"), { status: 404 });
    if (team.status === "suspended") return next;
    team.status = "suspended";
    team.suspendedAt = now();
    team.suspendedByUserId = req.hub.user.id;
    team.suspensionReason = input.reason;
    team.updatedAt = now();
    logAudit(next, { actor: req.hub.user.username, action: "team.suspend", teamId: team.id, summary: `封禁团队：${team.name}${input.reason ? `；原因：${input.reason}` : ""}` });
    return next;
  });
  res.json({ team: publicTeam(db, teamRecordById(db, req.params.teamId)), message: "团队已封禁，成员和团队管理员的下一次访问会立即退出。" });
});

app.post("/api/admin/teams/:teamId/activate", requireUser, requirePlatformAdmin, async (req, res) => {
  const db = await updateDb((next) => {
    const team = teamRecordById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在。"), { status: 404 });
    team.status = "active";
    team.suspendedAt = null;
    team.suspendedByUserId = "";
    team.suspensionReason = "";
    team.updatedAt = now();
    logAudit(next, { actor: req.hub.user.username, action: "team.activate", teamId: team.id, summary: `解除团队封禁：${team.name}` });
    return next;
  });
  res.json({ team: publicTeam(db, teamRecordById(db, req.params.teamId)), message: "团队已恢复，可重新登录。" });
});

app.delete("/api/admin/teams/:teamId", requireUser, requirePlatformAdmin, async (req, res) => {
  const input = z.object({ confirmName: z.string().trim().min(1).max(80) }).parse(req.body || {});
  const { removed } = await deleteTeamAndPreserveAccounts({
    teamId: req.params.teamId,
    confirmName: input.confirmName,
    actor: req.hub.user,
    auditAction: "team.delete",
  });
  res.json({ message: `团队“${removed.name}”已永久删除，${removed.members} 个成员账号已保留并可重新加入团队。`, removed });
});

app.delete("/api/teams/:teamId/dissolve", requireUser, requireTeamManager, async (req, res) => {
  if (!canManageTeam(req.hub.db, req.hub.user, req.params.teamId) || req.hub.user.role === "platform-admin") {
    return res.status(403).json({ message: "仅当前团队管理员可以解散自己的团队。" });
  }
  const input = z.object({ confirmName: z.string().trim().min(1).max(80) }).parse(req.body || {});
  const { removed, actorAfterDeletion } = await deleteTeamAndPreserveAccounts({
    teamId: req.params.teamId,
    confirmName: input.confirmName,
    actor: req.hub.user,
    auditAction: "team.dissolve",
  });
  if (actorAfterDeletion) setSession(res, actorAfterDeletion);
  const latestDb = await readDb();
  res.json({
    user: actorAfterDeletion ? publicUser(latestDb, actorAfterDeletion) : publicUser(latestDb, req.hub.user),
    message: `团队“${removed.name}”已解散，团队数据已删除；${removed.members} 个成员账号均已保留，可重新创建或加入团队。`,
    removed,
  });
});

app.patch("/api/admin/teams/:teamId", requireUser, requireTeamManager, async (req, res) => {
  const input = parseManagedInput(req.body || {});
  if (input.storageQuotaBytes !== undefined && req.hub.user.role !== "platform-admin") {
    return res.status(403).json({ message: "仅平台管理员可以调整团队云空间额度。" });
  }
  const db = await updateDb((next) => {
    const team = teamRecordById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在。"), { status: 404 });
    const capacity = teamMemberCapacity(next, team);
    if (input.memberLimit < capacity.memberCount) throw Object.assign(new Error(`当前已有 ${capacity.memberCount} 位成员，团队人数上限不能低于当前人数。`), { status: 409, code: "TEAM_MEMBER_LIMIT_TOO_LOW" });
    Object.assign(team, { ...input, ...(input.storageQuotaBytes === undefined ? {} : { storageQuotaBytes: input.storageQuotaBytes }), updatedAt: now() });
    if (!teamMemberCapacity(next, team).available) exhaustTeamInvitations(next, team.id);
    logAudit(next, { actor: req.hub.user.username, action: "team.update", teamId: team.id, summary: `更新团队：${team.name}` });
    return next;
  });
  res.json({ team: publicTeam(db, teamRecordById(db, req.params.teamId)) });
});

app.post("/api/admin/teams/:teamId/admins", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ username: z.string().trim().min(2).max(80), password: z.string().min(10).max(240) }).parse(req.body || {});
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已停用。"), { status: 404 });
    let account = accountByLoginName(next, input.username);
    if (account?.role === "platform-admin") {
      throw Object.assign(new Error("平台超级管理员不能加入团队，也不占用团队成员名额。"), { status: 403, code: "PLATFORM_ADMIN_MEMBERSHIP_FORBIDDEN" });
    }
    const prior = account ? membershipForUser(next, account.id, req.params.teamId) : null;
    if (!prior && !teamMemberCapacity(next, team).available) throw Object.assign(new Error("团队成员名额已满，无法新增管理员。"), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
    if (!account) {
      const password = hashPassword(input.password);
      account = { id: id("user"), username: input.username, displayName: normalizeDisplayName("", input.username), role: "member", teamId: req.params.teamId, activeTeamId: req.params.teamId, passwordHash: password.key, passwordSalt: password.salt, status: "active", createdAt: now() };
      next.users.push(account);
    }
    if (prior) {
      prior.role = "team-admin";
      prior.status = "active";
      prior.updatedAt = now();
    } else {
      next.teamMemberships.push({ id: id("membership"), userId: account.id, teamId: req.params.teamId, role: "team-admin", status: "active", note: "", joinedAt: now(), createdAt: now(), updatedAt: now() });
    }
    if (!account.activeTeamId) setActiveTeamForUser(next, account, req.params.teamId);
    if (!teamMemberCapacity(next, team).available) exhaustTeamInvitations(next, team.id);
    logAudit(next, { actor: req.hub.user.username, action: "team-admin.create", teamId: req.params.teamId, summary: `创建团队管理员：${input.username}` });
    return next;
  });
  res.status(201).json({ admins: membershipsForTeam(db, req.params.teamId).filter((item) => item.role === "team-admin" && item.status === "active").map((item) => {
    const account = db.users.find((user) => user.id === item.userId);
    return { id: account?.id || item.userId, username: account?.username || "", displayName: normalizeDisplayName(account?.displayName, account?.username), createdAt: account?.createdAt || item.createdAt };
  }) });
});

app.get("/api/admin/teams/:teamId", requireUser, requireTeamManager, async (req, res) => {
  const db = await readDb();
  const team = teamRecordById(db, req.params.teamId);
  const memberDirectory = req.hub.user.role === "platform-admin"
    ? db.users.filter((user) => user.role !== "platform-admin" && user.status === "active").map((user) => publicUser(db, user))
    : [];
  res.json({
    team: publicTeam(db, team),
    stores: storesForTeam(db, team.id).map(publicStore),
    devices: db.devices.filter((device) => device.teamId === team.id).map((device) => publicDevice(db, device)).sort((left, right) => Number(Boolean(left.revokedAt)) - Number(Boolean(right.revokedAt)) || String(right.createdAt).localeCompare(String(left.createdAt))),
    reports: db.reports.filter((report) => report.teamId === team.id).map((report) => publicReport(db, report)).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 200),
    codes: db.activationCodes.filter((code) => code.teamId === team.id && !code.revokedAt).map(publicActivationCode).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    admins: membershipsForTeam(db, team.id).filter((item) => item.role === "team-admin" && item.status === "active").map((membership) => db.users.find((item) => item.id === membership.userId)).filter(Boolean).map((item) => publicUser(db, item)),
    members: membershipsForTeam(db, team.id).map((membership) => {
      const member = db.users.find((item) => item.id === membership.userId);
      return member ? { ...publicUser(db, member), membership: publicMembership(db, membership) } : null;
    }).filter(Boolean),
    memberDirectory,
    invitations: db.invitations.filter((item) => item.teamId === team.id && !item.revokedAt).map(publicInvitation).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 80),
    storage: storageForTeam(db, team.id),
  });
});

// Membership administration is deliberately separate from the global account.
// A platform administrator may add a user to any team; a team administrator may
// only change that user's role/note inside a team they manage.
app.put("/api/admin/members/:userId/membership", requireUser, async (req, res) => {
  const input = z.object({
    teamId: z.string().trim().min(1),
    role: z.enum(["member", "team-admin"]).default("member"),
    note: z.string().trim().max(80).optional().default(""),
  }).strict().parse(req.body || {});
  let membership;
  const db = await updateDb((next) => {
    const account = next.users.find((item) => item.id === req.params.userId && item.role !== "platform-admin");
    const team = teamById(next, input.teamId);
    if (!account) throw Object.assign(new Error("用户不存在，或该账号是不能加入团队的平台超级管理员。"), { status: 404, code: "PLATFORM_ADMIN_MEMBERSHIP_FORBIDDEN" });
    if (!team) throw Object.assign(new Error("团队不存在或已停用。"), { status: 404 });
    if (!canManageTeam(next, req.hub.user, input.teamId)) throw Object.assign(new Error("你没有管理该团队成员的权限。"), { status: 403 });
    membership = membershipForUser(next, account.id, team.id);
    if (!membership) {
      if (!teamMemberCapacity(next, team).available) throw Object.assign(new Error("团队成员名额已满。"), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
      membership = { id: id("membership"), userId: account.id, teamId: team.id, role: input.role, status: "active", note: input.note, joinedAt: now(), createdAt: now(), updatedAt: now() };
      next.teamMemberships.push(membership);
    } else {
      if (membership.role === "team-admin" && membership.status === "active" && input.role !== "team-admin") {
        const otherAdmins = membershipsForTeam(next, team.id).filter((item) => item.id !== membership.id && item.role === "team-admin" && item.status === "active");
        if (!otherAdmins.length) throw Object.assign(new Error("当前成员是团队最后一位管理员，请先设置另一位管理员。"), { status: 409, code: "LAST_TEAM_ADMIN" });
      }
      membership.role = input.role;
      membership.status = "active";
      membership.note = input.note;
      membership.updatedAt = now();
    }
    if (!account.activeTeamId) setActiveTeamForUser(next, account, team.id);
    logAudit(next, { actor: req.hub.user.username, action: "membership.update", teamId: team.id, summary: `调整成员 ${account.username}：${input.role === "team-admin" ? "团队管理员" : "成员"}${input.note ? `；备注：${input.note}` : ""}` });
    return next;
  });
  const account = db.users.find((item) => item.id === req.params.userId);
  res.json({ user: publicUser(db, account), membership: publicMembership(db, membership), message: "成员团队权限已更新。" });
});

// Cross-store access is a platform-level operation. Each selected store is a
// separate team membership, so the same account can switch stores without any
// report data crossing team boundaries.
app.put("/api/admin/members/:userId/team-access", requireUser, requirePlatformAdmin, async (req, res) => {
  const input = z.object({
    teamIds: z.array(z.string().trim().min(1)).max(500),
    currentTeamId: z.string().trim().min(1),
    currentRole: z.enum(["member", "team-admin"]).default("member"),
    currentNote: z.string().trim().max(80).optional().default(""),
  }).strict().parse(req.body || {});
  const requestedTeamIds = [...new Set(input.teamIds)];
  let account;
  const db = await updateDb((next) => {
    account = next.users.find((item) => item.id === req.params.userId && item.role !== "platform-admin");
    if (!account) throw Object.assign(new Error("成员账号不存在或不能修改平台管理员权限。"), { status: 404 });
    const requestedTeams = requestedTeamIds.map((teamId) => teamById(next, teamId));
    if (requestedTeams.some((team) => !team)) throw Object.assign(new Error("可查看店铺中包含已停用或不存在的团队。"), { status: 400 });
    if (!requestedTeamIds.includes(input.currentTeamId)) {
      throw Object.assign(new Error("当前店铺必须保留勾选后才能保存备注和角色。"), { status: 400 });
    }

    const existing = membershipsForUser(next, account.id);
    const requestedSet = new Set(requestedTeamIds);
    for (const membership of existing.filter((item) => !requestedSet.has(item.teamId))) {
      if (membership.role === "team-admin" && membership.status === "active") {
        const otherAdmins = membershipsForTeam(next, membership.teamId).filter((item) => item.id !== membership.id && item.role === "team-admin" && item.status === "active");
        if (!otherAdmins.length) throw Object.assign(new Error(`不能移除 ${teamRecordById(next, membership.teamId)?.name || "该店铺"} 的唯一管理员。`), { status: 409, code: "LAST_TEAM_ADMIN" });
      }
    }
    for (const team of requestedTeams) {
      const membership = membershipForUser(next, account.id, team.id);
      if (!membership && !teamMemberCapacity(next, team).available) {
        throw Object.assign(new Error(`店铺“${team.name}”已达到团队人数上限。`), { status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
      }
    }

    next.teamMemberships = next.teamMemberships.filter((membership) => membership.userId !== account.id || requestedSet.has(membership.teamId));
    for (const team of requestedTeams) {
      let membership = membershipForUser(next, account.id, team.id);
      if (!membership) {
        membership = { id: id("membership"), userId: account.id, teamId: team.id, role: "member", status: "active", note: "", joinedAt: now(), createdAt: now(), updatedAt: now() };
        next.teamMemberships.push(membership);
      } else {
        membership.status = "active";
        membership.updatedAt = now();
      }
      if (team.id === input.currentTeamId) {
        if (membership.role === "team-admin" && input.currentRole !== "team-admin") {
          const otherAdmins = membershipsForTeam(next, team.id).filter((item) => item.id !== membership.id && item.role === "team-admin" && item.status === "active");
          if (!otherAdmins.length) throw Object.assign(new Error("当前成员是该店铺唯一管理员，请先设置另一位管理员。"), { status: 409, code: "LAST_TEAM_ADMIN" });
        }
        membership.role = input.currentRole;
        membership.note = input.currentNote;
      }
    }
    setActiveTeamForUser(next, account, activeMembershipForUser(next, account, account.activeTeamId)?.teamId || firstAvailableMembership(next, account)?.teamId || "");
    for (const team of requestedTeams) if (!teamMemberCapacity(next, team).available) exhaustTeamInvitations(next, team.id);
    logAudit(next, { actor: req.hub.user.username, action: "member.store-access.update", teamId: input.currentTeamId, summary: `更新成员 ${account.username} 的可查看店铺：${requestedTeams.map((team) => team.name).join("、") || "无"}` });
    return next;
  });
  res.json({ user: publicUser(db, account), message: "成员可查看店铺、角色和备注已保存。" });
});

app.post("/api/admin/teams/:teamId/members/:userId/suspend", requireUser, requireTeamManager, async (req, res) => {
  const db = await updateDb((next) => {
    const membership = membershipForUser(next, req.params.userId, req.params.teamId);
    const user = next.users.find((item) => item.id === req.params.userId);
    if (!membership || !user) throw Object.assign(new Error("团队成员不存在。"), { status: 404 });
    if (membership.role === "team-admin" && membership.status === "active") {
      const otherAdmins = membershipsForTeam(next, req.params.teamId).filter((item) => item.id !== membership.id && item.role === "team-admin" && item.status === "active");
      if (!otherAdmins.length) throw Object.assign(new Error("当前成员是团队最后一位管理员，不能停用。"), { status: 409, code: "LAST_TEAM_ADMIN" });
    }
    membership.status = "suspended";
    membership.updatedAt = now();
    if (user.activeTeamId === req.params.teamId) setActiveTeamForUser(next, user, firstAvailableMembership(next, user)?.teamId || "");
    logAudit(next, { actor: req.hub.user.username, action: "member.suspend", teamId: req.params.teamId, summary: `停用成员：${user.username}` });
    return next;
  });
  res.json({ members: membershipsForTeam(db, req.params.teamId).map((membership) => { const user = db.users.find((item) => item.id === membership.userId); return user ? { ...publicUser(db, user), membership: publicMembership(db, membership) } : null; }).filter(Boolean), message: "成员已停用，仅影响当前团队。" });
});

app.post("/api/admin/teams/:teamId/members/:userId/activate", requireUser, requireTeamManager, async (req, res) => {
  const db = await updateDb((next) => {
    const membership = membershipForUser(next, req.params.userId, req.params.teamId);
    const user = next.users.find((item) => item.id === req.params.userId);
    if (!membership || !user) throw Object.assign(new Error("团队成员不存在。"), { status: 404 });
    membership.status = "active";
    membership.updatedAt = now();
    if (!user.activeTeamId) setActiveTeamForUser(next, user, req.params.teamId);
    logAudit(next, { actor: req.hub.user.username, action: "member.activate", teamId: req.params.teamId, summary: `恢复成员：${user.username}` });
    return next;
  });
  res.json({ members: membershipsForTeam(db, req.params.teamId).map((membership) => { const user = db.users.find((item) => item.id === membership.userId); return user ? { ...publicUser(db, user), membership: publicMembership(db, membership) } : null; }).filter(Boolean), message: "成员已恢复，仅影响当前团队。" });
});

app.delete("/api/admin/teams/:teamId/members/:userId", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ confirmUsername: z.string().trim().min(1).max(80) }).parse(req.body || {});
  let username = "";
  await updateDb((next) => {
    const membership = membershipForUser(next, req.params.userId, req.params.teamId);
    const user = next.users.find((item) => item.id === req.params.userId);
    if (!membership || !user) throw Object.assign(new Error("团队成员不存在。"), { status: 404 });
    if (input.confirmUsername !== user.username) throw Object.assign(new Error("确认账号不匹配，未移出团队。"), { status: 400 });
    if (membership.role === "team-admin" && membership.status === "active") {
      const otherAdmins = membershipsForTeam(next, req.params.teamId).filter((item) => item.id !== membership.id && item.role === "team-admin" && item.status === "active");
      if (!otherAdmins.length) throw Object.assign(new Error("当前成员是团队最后一位管理员，不能移出。"), { status: 409, code: "LAST_TEAM_ADMIN" });
    }
    username = user.username;
    next.teamMemberships = next.teamMemberships.filter((item) => item.id !== membership.id);
    setActiveTeamForUser(next, user, firstAvailableMembership(next, user)?.teamId || "");
    logAudit(next, { actor: req.hub.user.username, action: "member.remove", teamId: req.params.teamId, summary: `移出团队成员：${username}` });
    return next;
  });
  res.json({ message: `成员“${username}”已移出当前团队，账号和其他团队关系已保留。` });
});

app.post("/api/admin/teams/:teamId/stores", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body || {});
  const store = { id: id("store"), teamId: req.params.teamId, name: input.name, status: "active", createdAt: now() };
  const db = await updateDb((next) => {
    const team = teamById(next, store.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已停用。"), { status: 404 });
    if (storesForTeam(next, store.teamId).length) throw Object.assign(new Error("一个店铺对应一个独立团队。当前团队已有店铺，请新建店铺团队。"), { status: 409, code: "ONE_STORE_PER_TEAM" });
    if (next.stores.some((item) => item.teamId === store.teamId && item.name.localeCompare(store.name, "zh-CN", { sensitivity: "accent" }) === 0 && item.status === "active")) throw Object.assign(new Error("该团队已经有同名店铺。"), { status: 409 });
    next.stores.push(store);
    logAudit(next, { actor: req.hub.user.username, action: "store.create", teamId: store.teamId, summary: `新增店铺：${store.name}` });
    return next;
  });
  res.status(201).json({ store: publicStore(store), stores: storesForTeam(db, store.teamId).map(publicStore) });
});

app.patch("/api/admin/teams/:teamId/stores/:storeId", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body || {});
  const db = await updateDb((next) => {
    const store = next.stores.find((item) => item.id === req.params.storeId && item.teamId === req.params.teamId && item.status === "active");
    if (!store) throw Object.assign(new Error("店铺不存在。"), { status: 404 });
    const priorName = store.name;
    store.name = input.name;
    next.reports.filter((report) => report.storeId === store.id).forEach((report) => {
      report.storeName = store.name;
      report.report = { ...report.report, storeName: store.name };
    });
    const operations = teamOperationsFor(next, store.teamId, { create: true });
    operations.productCatalog = operations.productCatalog.map((entry) => entry.storeName === priorName ? { ...entry, storeName: store.name } : entry);
    operations.salesDeductions = operations.salesDeductions.map((deduction) => deduction.storeName === priorName ? { ...deduction, storeName: store.name } : deduction);
    logAudit(next, { actor: req.hub.user.username, action: "store.rename", teamId: store.teamId, summary: `重命名店铺：${store.name}` });
    return next;
  });
  res.json({ stores: storesForTeam(db, req.params.teamId).map(publicStore) });
});

app.delete("/api/admin/teams/:teamId/stores/:storeId", requireUser, requireTeamManager, async (req, res) => {
  const db = await updateDb((next) => {
    const store = next.stores.find((item) => item.id === req.params.storeId && item.teamId === req.params.teamId && item.status === "active");
    if (!store) throw Object.assign(new Error("店铺不存在或已移除。"), { status: 404 });
    store.status = "removed";
    store.removedAt = now();
    const unassigned = "未归属店铺";
    next.reports.filter((report) => report.storeId === store.id).forEach((report) => {
      report.storeId = "";
      report.storeName = unassigned;
      report.report = { ...report.report, storeName: unassigned };
    });
    const operations = teamOperationsFor(next, store.teamId, { create: true });
    operations.productCatalog = operations.productCatalog.map((entry) => entry.storeName === store.name ? { ...entry, storeName: unassigned } : entry);
    operations.salesDeductions = operations.salesDeductions.map((deduction) => deduction.storeName === store.name ? { ...deduction, storeName: unassigned } : deduction);
    for (const device of next.devices.filter((item) => item.teamId === store.teamId && !item.revokedAt)) {
      if (!device.storeIds?.includes(store.id)) continue;
      device.storeIds = device.storeIds.filter((storeId) => storeId !== store.id);
      device.scopeVersion = (device.scopeVersion || 1) + 1;
    }
    for (const code of next.activationCodes.filter((item) => item.teamId === store.teamId && !item.revokedAt)) {
      code.storeIds = (code.storeIds || []).filter((storeId) => storeId !== store.id);
      if (!code.storeIds.length) { code.revokedAt = now(); code.revokedReason = "store-removed"; }
    }
    logAudit(next, { actor: req.hub.user.username, action: "store.remove", teamId: store.teamId, summary: `移除店铺：${store.name}` });
    return next;
  });
  res.json({ stores: storesForTeam(db, req.params.teamId).map(publicStore), message: "店铺已移除；历史数据已改为未归属店铺。" });
});

app.post("/api/admin/teams/:teamId/codes", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ label: z.string().trim().max(80).optional().default("团队同步授权"), mode: z.enum(["personal", "team"]), storeIds: z.array(z.string().min(1)).min(1).max(80), expiresInDays: z.coerce.number().int().min(1).max(60).optional().default(7) }).parse(req.body || {});
  const rawCode = deviceCode();
  await updateDb((next) => {
    cleanupExpiredCodes(next);
    const team = teamById(next, req.params.teamId);
    const stores = storesForTeam(next, team.id);
    if (input.storeIds.some((storeId) => !stores.some((store) => store.id === storeId))) throw Object.assign(new Error("授权店铺中包含无效店铺。"), { status: 400 });
    const code = {
      id: id("code"), teamId: team.id, label: input.label || "团队同步授权", mode: input.mode,
      codeHash: sha256(rawCode), codeCipher: encryptManagedCode(rawCode), storeIds: input.storeIds,
      maxActivations: input.mode === "personal" ? 1 : team.deviceLimit,
      activationCount: 0, createdAt: now(), expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000).toISOString(), revokedAt: null,
    };
    next.activationCodes.push(code);
    logAudit(next, { actor: req.hub.user.username, action: "code.create", teamId: team.id, summary: `生成${input.mode === "team" ? "团队" : "个人"}授权码` });
    return next;
  });
  res.status(201).json({ code: rawCode, expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000).toISOString(), message: "授权码已安全保存，可在团队管理中继续查看、复制或撤销。" });
});

app.delete("/api/admin/teams/:teamId/codes/:codeId", requireUser, requireTeamManager, async (req, res) => {
  await updateDb((next) => {
    const code = next.activationCodes.find((item) => item.id === req.params.codeId && item.teamId === req.params.teamId);
    if (!code) throw Object.assign(new Error("授权码不存在。"), { status: 404 });
    code.revokedAt = now();
    code.revokedReason = "manual";
    logAudit(next, { actor: req.hub.user.username, action: "code.revoke", teamId: code.teamId, summary: "撤销授权码" });
    return next;
  });
  res.status(204).end();
});

app.patch("/api/admin/teams/:teamId/devices/:deviceId", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({ storeIds: z.array(z.string().min(1)).min(1).max(80), label: z.string().trim().min(1).max(80).optional() }).parse(req.body || {});
  const db = await updateDb((next) => {
    const device = next.devices.find((item) => item.id === req.params.deviceId && item.teamId === req.params.teamId && !item.revokedAt);
    if (!device) throw Object.assign(new Error("设备不存在或已移除。"), { status: 404 });
    const validIds = new Set(storesForTeam(next, device.teamId).map((store) => store.id));
    if (input.storeIds.some((storeId) => !validIds.has(storeId))) throw Object.assign(new Error("设备权限中包含无效店铺。"), { status: 400 });
    device.storeIds = input.storeIds;
    if (input.label) device.label = input.label;
    device.scopeVersion = (device.scopeVersion || 1) + 1;
    logAudit(next, { actor: req.hub.user.username, action: "device.scope.update", teamId: device.teamId, summary: `调整设备权限：${device.label}` });
    return next;
  });
  res.json({ device: publicDevice(db, db.devices.find((item) => item.id === req.params.deviceId)) });
});

app.delete("/api/admin/teams/:teamId/devices/:deviceId", requireUser, requireTeamManager, async (req, res) => {
  await updateDb((next) => {
    const device = next.devices.find((item) => item.id === req.params.deviceId && item.teamId === req.params.teamId && !item.revokedAt);
    if (!device) throw Object.assign(new Error("设备不存在或已移除。"), { status: 404 });
    device.revokedAt = now();
    device.tokenHash = "";
    logAudit(next, { actor: req.hub.user.username, action: "device.revoke", teamId: device.teamId, summary: `移除设备：${device.label}` });
    return next;
  });
  res.status(204).end();
});

app.post("/api/teams/:teamId/reports/preview", requireUser, requireTeamMember, upload.single("file"), async (req, res) => {
  if (!req.file) throw Object.assign(new Error("请选择要检查的报表。"), { status: 400 });
  const parsed = await parseOperationsFile(req.file);
  if (parsed.kind === "screenshot") throw Object.assign(new Error("云端数据中枢只接收可计算的表格数据，不接收截图。"), { status: 400 });
  res.json({
    fileName: req.file.originalname,
    kind: parsed.kind,
    columns: parsed.columns,
    rowCount: parsed.rows.length,
    period: parsed.period || null,
    detectedType: parsed.detectedType || null,
  });
});

app.post("/api/teams/:teamId/product-catalog/import", requireUser, requireTeamManager, upload.single("file"), async (req, res) => {
  if (!req.file) throw Object.assign(new Error("请选择 ID 型号表。"), { status: 400 });
  const parsed = await parseProductCatalogFile(req.file);
  const sourceName = String(req.file.originalname || "ID型号表").slice(0, 160);
  const entries = createProductCatalogEntries(parsed.entries, { sourceName });
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
    for (const entry of entries) ensureActiveStoreByName(next, team.id, entry.storeName);
    const operations = teamOperationsFor(next, team.id, { create: true });
    operations.productCatalog = [...operations.productCatalog, ...entries].slice(-20_000);
    operations.productCatalogSource = { fileName: sourceName, updatedAt: now() };
    logAudit(next, { actor: req.hub.user.username, action: "catalog.import", teamId: team.id, summary: `更新商品资料 ${entries.length} 条：${sourceName}` });
    return next;
  });
  res.status(201).json({
    importedCount: entries.length,
    skippedRows: parsed.skippedRows,
    workspace: workspaceForTeam(db, req.params.teamId),
  });
});

app.post("/api/teams/:teamId/product-catalog", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({
    storeName: z.string().trim().min(1).max(80),
    productId: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(80),
  }).strict().parse(req.body || {});
  const [entry] = createProductCatalogEntries([input], { sourceName: "网页手工维护" });
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
    const operations = teamOperationsFor(next, team.id, { create: true });
    if (latestProductCatalogEntries(operations.productCatalog).some((current) => (
      String(current.storeName || "").trim().localeCompare(entry.storeName, "zh-CN", { sensitivity: "accent" }) === 0
      && String(current.productId || "").trim() === entry.productId
    ))) throw Object.assign(new Error("该店铺下的商品 ID 已存在，请勿重复新增。"), { status: 409, code: "PRODUCT_CATALOG_DUPLICATE" });
    ensureActiveStoreByName(next, team.id, entry.storeName);
    operations.productCatalog = [...operations.productCatalog, entry].slice(-20_000);
    operations.productCatalogSource = { fileName: "网页手工维护", updatedAt: entry.createdAt };
    logAudit(next, { actor: req.hub.user.username, action: "catalog.save", teamId: team.id, summary: `维护商品资料：${entry.storeName} / ${entry.productId}` });
    return next;
  });
  res.status(201).json({ entry, workspace: workspaceForTeam(db, req.params.teamId) });
});

app.patch("/api/teams/:teamId/product-catalog/bulk", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({
    ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500),
    changes: z.object({
      storeName: z.string().trim().min(1).max(80).optional(),
      category: z.string().trim().min(1).max(80).optional(),
      model: z.string().trim().min(1).max(80).optional(),
    }).strict(),
  }).strict().refine((value) => Object.keys(value.changes).length > 0, { message: "请至少填写一项要修改的内容。", path: ["changes"] }).parse(req.body || {});
  const requestedIds = [...new Set(input.ids)];
  let updatedEntries = [];
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
    if (input.changes.storeName && !findActiveStoreByName(next, team.id, input.changes.storeName)) {
      throw Object.assign(new Error("目标店铺不属于当前团队，请刷新后重新选择。"), { status: 400, code: "PRODUCT_CATALOG_STORE_INVALID" });
    }
    const operations = teamOperationsFor(next, team.id, { create: true });
    const currentEntries = latestProductCatalogEntries(operations.productCatalog);
    const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]));
    const selected = requestedIds.map((entryId) => currentById.get(entryId));
    if (selected.some((entry) => !entry)) {
      throw Object.assign(new Error("部分商品资料已更新，请刷新页面后重新选择。"), { status: 409, code: "PRODUCT_CATALOG_STALE_SELECTION" });
    }
    updatedEntries = createProductCatalogEntries(selected.map((entry) => ({
      ...entry,
      ...input.changes,
      replacesId: entry.id,
    })), { sourceName: "网页批量维护" });
    const selectedIds = new Set(requestedIds);
    const proposed = [...currentEntries.filter((entry) => !selectedIds.has(entry.id)), ...updatedEntries];
    const uniqueKeys = new Map();
    for (const entry of proposed) {
      const key = `${String(entry.storeName || "").trim().toLocaleLowerCase("zh-CN")}\u0000${String(entry.productId || "").trim()}`;
      if (uniqueKeys.has(key)) {
        throw Object.assign(new Error(`批量修改后“${entry.storeName} + ${entry.productId}”将重复，未保存任何修改。`), { status: 409, code: "PRODUCT_CATALOG_DUPLICATE" });
      }
      uniqueKeys.set(key, entry.id);
    }
    operations.productCatalog = [...operations.productCatalog, ...updatedEntries].slice(-20_000);
    operations.productCatalogSource = { fileName: "网页批量维护", updatedAt: updatedEntries[0]?.createdAt || now() };
    logAudit(next, { actor: req.hub.user.username, action: "catalog.bulk-update", teamId: team.id, summary: `批量维护商品资料 ${updatedEntries.length} 条` });
    return next;
  });
  res.json({ updatedCount: updatedEntries.length, entries: updatedEntries, workspace: workspaceForTeam(db, req.params.teamId) });
});

app.delete("/api/teams/:teamId/product-catalog", requireUser, requireTeamManager, async (req, res) => {
  let removedCount = 0;
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
    const operations = teamOperationsFor(next, team.id, { create: true });
    removedCount = latestProductCatalogEntries(operations.productCatalog).length;
    operations.productCatalog = [];
    operations.productCatalogSource = { fileName: "", updatedAt: now() };
    logAudit(next, { actor: req.hub.user.username, action: "catalog.clear", teamId: team.id, summary: `清空商品资料 ${removedCount} 条` });
    return next;
  });
  res.json({ removedCount, message: "商品资料已清空。", workspace: workspaceForTeam(db, req.params.teamId) });
});

app.get("/api/teams/:teamId/product-catalog/export", requireUser, requireTeamMember, async (req, res) => {
  const db = await readDb();
  const team = teamById(db, req.params.teamId);
  if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
  const csvValue = (value) => {
    const source = String(value ?? "");
    return /[",\r\n]/.test(source) ? `"${source.replace(/"/g, '""')}"` : source;
  };
  const rows = latestProductCatalogEntries(operationsInputForTeam(db, team.id).productCatalog);
  const csv = [
    ["店铺名", "ID", "品类名", "型号"].join(","),
    ...rows.map((entry) => [entry.storeName, entry.productId, entry.category, entry.model].map(csvValue).join(",")),
  ].join("\r\n");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%E5%95%86%E5%93%81ID%E5%9E%8B%E5%8F%B7%E8%A1%A8-%E6%9C%80%E6%96%B0.csv");
  res.type("text/csv; charset=utf-8").send(`\uFEFF${csv}`);
});

app.post("/api/teams/:teamId/sales-deductions", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({
    storeName: z.string().trim().min(1).max(80),
    reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.coerce.number().positive().max(1_000_000_000),
    note: z.string().trim().max(240).optional().default(""),
  }).strict().parse(req.body || {});
  const deduction = { id: id("deduction"), ...input, createdAt: now() };
  const db = await updateDb((next) => {
    const team = teamById(next, req.params.teamId);
    if (!team) throw Object.assign(new Error("团队不存在或已被封禁。"), { status: 404 });
    if (!findActiveStoreByName(next, team.id, deduction.storeName)) {
      throw Object.assign(new Error("请选择当前团队的有效店铺。"), { status: 400 });
    }
    const operations = teamOperationsFor(next, team.id, { create: true });
    operations.salesDeductions = [...operations.salesDeductions, deduction].slice(-2_000);
    logAudit(next, { actor: req.hub.user.username, action: "sales-deduction.create", teamId: team.id, summary: `销售扣除 ${deduction.storeName} ${deduction.reportDate} ¥${deduction.amount}` });
    return next;
  });
  res.status(201).json({ deduction, workspace: workspaceForTeam(db, req.params.teamId) });
});

app.delete("/api/teams/:teamId/sales-deductions/:deductionId", requireUser, requireTeamManager, async (req, res) => {
  const deductionId = z.string().trim().min(1).max(100).parse(req.params.deductionId);
  let removed = false;
  const db = await updateDb((next) => {
    const operations = teamOperationsFor(next, req.params.teamId, { create: true });
    operations.salesDeductions = operations.salesDeductions.filter((item) => {
      const keep = item.id !== deductionId;
      if (!keep) removed = true;
      return keep;
    });
    if (!removed) throw Object.assign(new Error("未找到该销售扣除记录。"), { status: 404 });
    logAudit(next, { actor: req.hub.user.username, action: "sales-deduction.delete", teamId: req.params.teamId, summary: `删除销售扣除：${deductionId}` });
    return next;
  });
  res.json({ workspace: workspaceForTeam(db, req.params.teamId) });
});

app.post("/api/teams/:teamId/reports", requireUser, requireTeamMember, upload.single("file"), async (req, res) => {
  if (!req.file) throw Object.assign(new Error("请选择要上传的报表。"), { status: 400 });
  const input = z.object({
    storeId: z.string().min(1), type: z.enum(OPERATIONS_REPORT_INPUT_TYPES),
    reportDate: z.string().trim().max(40).optional().default(""), periodKind: z.enum(OPERATIONS_PERIOD_KINDS).optional(),
    periodStart: z.string().trim().max(40).optional().default(""), periodEnd: z.string().trim().max(40).optional().default(""), sourceName: z.string().trim().max(80).optional().default("云端管理后台"),
  }).parse(req.body || {});
  const db = await readDb();
  const store = db.stores.find((item) => item.id === input.storeId && item.teamId === req.params.teamId && item.status === "active");
  if (!store) throw Object.assign(new Error("请选择当前团队的店铺。"), { status: 400 });
  const parsed = await parseOperationsFile(req.file);
  if (parsed.kind === "screenshot") throw Object.assign(new Error("云端数据中枢只接收可计算的表格数据，不接收截图。"), { status: 400 });
  const normalized = createOperationsReport({ ...input, storeName: store.name }, parsed, { file: req.file });
  const alreadyStored = db.reports.find((item) => item.teamId === req.params.teamId && item.storeId === store.id && item.status === "active" && item.report.dataSignature === normalized.dataSignature);
  if (alreadyStored) return res.json({ duplicate: true, report: publicReport(db, alreadyStored), storage: storageForTeam(db, req.params.teamId), message: "该文件内容已经入库，已跳过重复版本。" });
  assertStorageAvailable(db, req.params.teamId, req.file.size);
  const remoteId = id("report");
  const storedRawPath = path.join(UPLOAD_DIR, `${remoteId}${path.extname(req.file.originalname).toLowerCase() || ".bin"}`);
  await fs.writeFile(storedRawPath, req.file.buffer);
  let result;
  try {
    result = await updateDb((next) => {
      assertStorageAvailable(next, req.params.teamId, req.file.size);
      const duplicate = next.reports.find((item) => item.teamId === req.params.teamId && item.storeId === store.id && item.status === "active" && item.report.dataSignature === normalized.dataSignature);
      if (duplicate) {
        logAudit(next, { actor: req.hub.user.username, action: "report.duplicate", teamId: req.params.teamId, summary: `跳过重复报表：${normalized.fileName}` });
        return next;
      }
      const sameScope = next.reports.filter((item) => item.teamId === req.params.teamId && item.storeId === store.id && item.status === "active" && item.report.type === normalized.type && item.report.periodKind === normalized.periodKind && item.report.periodStart === normalized.periodStart && item.report.periodEnd === normalized.periodEnd);
      for (const prior of sameScope) {
        prior.status = "superseded";
        prior.updatedAt = now();
        appendChange(next, { teamId: prior.teamId, kind: "remove", remoteReportId: prior.id });
      }
      const record = {
        id: remoteId, teamId: req.params.teamId, storeId: store.id, storeName: store.name,
        report: normalized, rawPath: storedRawPath, rawBytes: req.file.size, status: "active",
        version: sameScope.length ? Math.max(...sameScope.map((item) => Number(item.version) || 1)) + 1 : 1,
        createdByUserId: req.hub.user.id, createdByUsername: req.hub.user.username,
        createdAt: now(), updatedAt: now(), revision: 0,
      };
      record.revision = appendChange(next, { teamId: record.teamId, kind: "upsert", remoteReportId: record.id });
      next.reports.push(record);
      logAudit(next, { actor: req.hub.user.username, action: "report.upload", teamId: record.teamId, summary: `上传 ${normalized.type}：${normalized.fileName}` });
      return next;
    });
  } catch (error) {
    await fs.rm(storedRawPath, { force: true });
    throw error;
  }
  const stored = result.reports.find((item) => item.id === remoteId);
  if (!stored) {
    await fs.rm(storedRawPath, { force: true });
    return res.json({ duplicate: true, message: "该文件内容已经入库，已跳过重复版本。" });
  }
  res.status(201).json({ duplicate: false, report: publicReport(result, stored), storage: storageForTeam(result, req.params.teamId), message: sameScopeMessage(result, stored) });
});

function sameScopeMessage(db, report) {
  const superseded = db.reports.filter((item) => item.teamId === report.teamId && item.storeId === report.storeId && item.status === "superseded" && item.report.type === report.report.type && item.report.periodStart === report.report.periodStart && item.updatedAt === report.updatedAt).length;
  return superseded ? "已作为同周期新版入库，旧版会在下次本地同步时自动替换。" : "报表已入库，可在本地应用点击“同步云端数据”。";
}

app.delete("/api/teams/:teamId/reports/:reportId", requireUser, requireTeamMember, async (req, res) => {
  let rawPath = "";
  await updateDb((next) => {
    const report = next.reports.find((item) => item.id === req.params.reportId && item.teamId === req.params.teamId && item.status === "active");
    if (!report) throw Object.assign(new Error("报表不存在或已经不是当前版本。"), { status: 404 });
    if (!canDeleteReport(req.hub.db, req.hub.user, report)) throw Object.assign(new Error("你只能删除自己上传的报表。"), { status: 403 });
    rawPath = report.rawPath || "";
    appendChange(next, { teamId: report.teamId, kind: "remove", remoteReportId: report.id });
    next.reports = next.reports.filter((item) => item.id !== report.id);
    logAudit(next, { actor: req.hub.user.username, action: "report.delete", teamId: report.teamId, summary: `永久删除报表：${report.report.fileName}` });
    return next;
  });
  // Commit the removal before unlinking its source file. A failed unlink never
  // resurrects data that the user explicitly deleted.
  await fs.rm(rawPath, { force: true }).catch(() => undefined);
  res.status(204).end();
});

// Keep named report actions before the generic :reportId endpoint. Express
// matches routes in declaration order, so this must remain above rename.
app.patch("/api/teams/:teamId/reports/bulk-store", requireUser, requireTeamManager, async (req, res) => {
  const input = z.object({
    ids: z.array(z.string().trim().min(1)).min(1).max(200),
    storeId: z.string().trim().min(1),
  }).strict().parse(req.body || {});
  const selectedIds = new Set(input.ids);
  let updatedCount = 0;
  const db = await updateDb((next) => {
    const store = next.stores.find((item) => item.id === input.storeId && item.teamId === req.params.teamId && item.status === "active");
    if (!store) throw Object.assign(new Error("请选择当前团队的有效店铺。"), { status: 400 });
    for (const report of next.reports) {
      if (!selectedIds.has(report.id) || report.teamId !== req.params.teamId || report.status !== "active") continue;
      report.storeId = store.id;
      report.storeName = store.name;
      report.report = { ...report.report, storeName: store.name };
      report.updatedAt = now();
      updatedCount += 1;
    }
    if (!updatedCount) throw Object.assign(new Error("没有可调整归属的当前报表。"), { status: 404 });
    logAudit(next, { actor: req.hub.user.username, action: "report.bulk-store", teamId: req.params.teamId, summary: `批量调整 ${updatedCount} 份报表归属：${store.name}` });
    return next;
  });
  res.json({ updatedCount, workspace: workspaceForTeam(db, req.params.teamId) });
});

app.patch("/api/teams/:teamId/reports/:reportId", requireUser, requireTeamMember, async (req, res) => {
  const input = z.object({ fileName: z.string().trim().min(1).max(160) }).strict().parse(req.body || {});
  const db = await updateDb((next) => {
    const report = next.reports.find((item) => item.id === req.params.reportId && item.teamId === req.params.teamId && item.status === "active");
    if (!report) throw Object.assign(new Error("报表不存在或已不是当前版本。"), { status: 404 });
    if (!canDeleteReport(req.hub.db, req.hub.user, report)) throw Object.assign(new Error("你只能修改自己上传的报表名称。"), { status: 403 });
    report.report = { ...report.report, fileName: input.fileName };
    report.updatedAt = now();
    logAudit(next, { actor: req.hub.user.username, action: "report.rename", teamId: report.teamId, summary: `修改归档名称：${input.fileName}` });
    return next;
  });
  const report = db.reports.find((item) => item.id === req.params.reportId);
  res.json({ report: publicReport(db, report), workspace: workspaceForTeam(db, req.params.teamId) });
});

app.get("/api/web/workspace", requireUser, async (req, res) => {
  const input = z.object({
    teamId: z.string().trim().optional().default(""),
    periodKind: z.enum(["all", ...OPERATIONS_PERIOD_KINDS]).optional().default("all"),
    sourcePeriodKind: z.enum(["auto", "all", ...OPERATIONS_PERIOD_KINDS]).optional().default("auto"),
    start: z.string().trim().max(20).optional().default(""),
    end: z.string().trim().max(20).optional().default(""),
    storeName: z.string().trim().max(80).optional().default(""),
  }).parse(req.query || {});
  const db = await readDb();
  const teamId = req.hub.user.role === "platform-admin" ? input.teamId : (input.teamId || req.hub.user.activeTeamId || req.hub.user.teamId);
  if (!teamId) return res.json({ hasTeam: false, user: publicUser(db, req.hub.user) });
  const team = teamById(db, teamId);
  if (!team || !canAccessTeam(db, req.hub.user, teamId)) return res.status(403).json({ message: "没有访问该团队运营数据的权限。" });
  const workspace = workspaceForTeam(db, team.id, {
    periodKind: input.periodKind,
    sourcePeriodKind: input.sourcePeriodKind,
    start: input.start,
    end: input.end,
    storeName: input.storeName,
  });
  const warehouse = db.reports
    .filter((report) => report.teamId === team.id)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map((report) => ({
      ...publicReport(db, report),
      canDelete: canDeleteReport(db, req.hub.user, report) && report.status === "active",
    }));
  res.json({
    hasTeam: true,
    user: publicUser(db, req.hub.user),
    team: publicTeam(db, team),
    stores: storesForTeam(db, team.id).map(publicStore),
    permissions: {
      canManageTeam: canManageTeam(db, req.hub.user, team.id),
      canUpload: canAccessTeam(db, req.hub.user, team.id),
      canDeleteAnyReport: canManageTeam(db, req.hub.user, team.id),
    },
    storage: storageForTeam(db, team.id),
    workspace,
    warehouse,
  });
});

function deviceFromRequest(db, req) {
  const supplied = String(req.get("x-ecom-cloud-device-token") || "");
  if (!supplied) return null;
  const hashed = sha256(supplied);
  return db.devices.find((device) => !device.revokedAt && device.tokenHash && crypto.timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hashed))) || null;
}

app.post("/api/device/activate", async (req, res) => {
  const input = z.object({ code: z.string().trim().min(8).max(40), deviceId: z.string().trim().min(8).max(120), deviceName: z.string().trim().min(1).max(80), appVersion: z.string().trim().max(40).optional().default("") }).parse(req.body || {});
  const token = randomToken(36);
  const db = await updateDb((next) => {
    cleanupExpiredCodes(next);
    const code = next.activationCodes.find((item) => !item.revokedAt && item.codeHash === sha256(input.code));
    if (!code) throw Object.assign(new Error("授权码无效、已过期或已被撤销。"), { status: 401 });
    const team = teamById(next, code.teamId);
    if (!team) throw Object.assign(new Error("授权团队不可用。"), { status: 403 });
    let device = next.devices.find((item) => item.teamId === team.id && item.clientDeviceId === input.deviceId && !item.revokedAt);
    const activeDevices = next.devices.filter((item) => item.teamId === team.id && !item.revokedAt);
    if (!device && activeDevices.length >= team.deviceLimit) throw Object.assign(new Error(`该团队已达到 ${team.deviceLimit} 台设备上限，请让管理员先移除旧设备。`), { status: 409, code: "DEVICE_LIMIT" });
    if (!device && (code.activationCount || 0) >= code.maxActivations) throw Object.assign(new Error("该授权码的绑定次数已用完，请联系管理员生成新码。"), { status: 409, code: "CODE_LIMIT" });
    if (!device) {
      device = { id: id("device"), teamId: team.id, clientDeviceId: input.deviceId, label: input.deviceName, storeIds: code.storeIds, tokenHash: sha256(token), scopeVersion: 1, appVersion: input.appVersion, createdAt: now(), lastSeenAt: now(), revokedAt: null };
      next.devices.push(device);
      code.activationCount = (code.activationCount || 0) + 1;
    } else {
      device.label = input.deviceName;
      device.appVersion = input.appVersion;
      device.tokenHash = sha256(token);
      device.lastSeenAt = now();
    }
    logAudit(next, { actor: `设备：${input.deviceName}`, action: "device.activate", teamId: team.id, summary: "绑定本地应用" });
    return next;
  });
  const device = db.devices.find((item) => item.clientDeviceId === input.deviceId && item.tokenHash === sha256(token));
  const team = teamById(db, device.teamId);
  res.json({ endpoint: req.protocol + "://" + req.get("host"), token, device: publicDevice(db, device), team: publicTeam(db, team), cursor: db.nextRevision - 1 });
});

app.get("/api/device/sync", async (req, res) => {
  const input = z.object({ cursor: z.coerce.number().int().min(0).optional().default(0), scopeVersion: z.coerce.number().int().min(0).optional().default(0) }).parse(req.query || {});
  const db = await readDb();
  const device = deviceFromRequest(db, req);
  if (!device) return res.status(401).json({ message: "设备凭证无效或已被管理员移除。", code: "DEVICE_REVOKED" });
  const team = teamById(db, device.teamId);
  if (!team) return res.status(403).json({ message: "所属团队不可用。" });
  const allowedStores = new Set(device.storeIds || []);
  const full = input.cursor === 0 || input.scopeVersion !== (device.scopeVersion || 1);
  const allActive = db.reports.filter((report) => report.teamId === team.id && report.status === "active" && allowedStores.has(report.storeId));
  const activeById = new Map(allActive.map((report) => [report.id, report]));
  const changes = full ? [] : db.changes.filter((change) => change.teamId === team.id && change.revision > input.cursor);
  const upserts = full ? allActive : changes.filter((change) => change.kind === "upsert").map((change) => activeById.get(change.remoteReportId)).filter(Boolean);
  const removedIds = full ? [] : changes.filter((change) => change.kind === "remove").map((change) => change.remoteReportId);
  await updateDb((next) => {
    const current = next.devices.find((item) => item.id === device.id);
    if (current) current.lastSeenAt = now();
    return next;
  });
  res.json({
    team: { id: team.id, name: team.name },
    device: { id: device.id, label: device.label, scopeVersion: device.scopeVersion || 1, stores: storesForTeam(db, team.id).filter((store) => allowedStores.has(store.id)).map(publicStore) },
    full,
    cursor: db.nextRevision - 1,
    activeRemoteIds: full ? allActive.map((report) => report.id) : undefined,
    removedIds,
    reports: upserts.map((stored) => ({ remoteId: stored.id, revision: stored.revision, updatedAt: stored.updatedAt, storeName: stored.storeName, report: stored.report })),
  });
});

app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  etag: true,
  maxAge: 0,
  setHeaders(response) {
    response.setHeader("Cache-Control", "no-store");
  },
}));
app.use((error, _req, res, _next) => {
  const status = error instanceof z.ZodError ? 400 : Number(error?.status || error?.statusCode || 500);
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "文件不能超过 64 MB。" });
  if (status >= 500) console.error("[cloud-hub]", error);
  const validationMessage = error instanceof z.ZodError ? "提交内容不完整或格式不正确，请检查后重试。" : "";
  res.status(status).json({ message: validationMessage || error?.message || "服务器处理失败，请稍后重试。", code: error?.code || "" });
});

await ensureInitialAdmin();
app.listen(PORT, "127.0.0.1", () => console.log(`[cloud-hub] listening on 127.0.0.1:${PORT}`));
