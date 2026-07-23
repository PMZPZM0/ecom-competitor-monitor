import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dbRuntimeInfo } from "../storage/db.js";

export const AUTH_BUNDLE_FORMAT = "ecom-monitor-auth-bundle";
export const AUTH_BUNDLE_VERSION = 1;
export const AUTH_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

const AUTH_BUNDLE_AAD = Buffer.from(`${AUTH_BUNDLE_FORMAT}:v${AUTH_BUNDLE_VERSION}`, "utf8");
const COOKIE_DOMAINS = ["taobao.com", "tmall.com", "tmall.hk"];

function bundleError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function isAllowedCookieDomain(value = "") {
  const domain = String(value).trim().toLowerCase().replace(/^\./, "");
  return COOKIE_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function normalizedPartitionKey(value) {
  if (!value || typeof value !== "object" || typeof value.topLevelSite !== "string") return null;
  try {
    const site = new URL(value.topLevelSite);
    if (site.protocol !== "https:" || site.username || site.password || site.port || !isAllowedCookieDomain(site.hostname)) return null;
    return {
      topLevelSite: site.origin,
      hasCrossSiteAncestor: Boolean(value.hasCrossSiteAncestor),
    };
  } catch {
    return null;
  }
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== "object") return null;
  const name = String(cookie.name || "");
  const value = String(cookie.value || "");
  const domain = String(cookie.domain || "").trim().toLowerCase();
  if (!name || name.length > 512 || value.length > 16_384 || !isAllowedCookieDomain(domain)) return null;
  const normalized = {
    name,
    value,
    domain,
    path: String(cookie.path || "/").slice(0, 2048) || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (Number.isFinite(cookie.expires) && Number(cookie.expires) > 0) normalized.expires = Number(cookie.expires);
  if (["Strict", "Lax", "None"].includes(cookie.sameSite)) normalized.sameSite = cookie.sameSite;
  if (["Low", "Medium", "High"].includes(cookie.priority)) normalized.priority = cookie.priority;
  if (typeof cookie.sameParty === "boolean") normalized.sameParty = cookie.sameParty;
  if (["Unset", "NonSecure", "Secure"].includes(cookie.sourceScheme)) normalized.sourceScheme = cookie.sourceScheme;
  if (Number.isInteger(cookie.sourcePort) && cookie.sourcePort >= -1 && cookie.sourcePort <= 65535) normalized.sourcePort = cookie.sourcePort;
  const partitionKey = normalizedPartitionKey(cookie.partitionKey);
  if (partitionKey) normalized.partitionKey = partitionKey;
  return normalized;
}

export function normalizeAuthBundleCookies(cookies = []) {
  if (!Array.isArray(cookies)) throw bundleError("AUTH_BUNDLE_INVALID", "登录包 Cookie 数据无效。");
  const normalized = cookies.map(normalizeCookie).filter(Boolean);
  if (!normalized.length) throw bundleError("AUTH_BUNDLE_EMPTY", "当前浏览器没有可导出的淘宝/天猫登录 Cookie，请先完成扫码登录并检测账号。");
  if (normalized.length > 1000) throw bundleError("AUTH_BUNDLE_TOO_LARGE", "登录包 Cookie 数量异常，已停止导出。");
  return normalized;
}

async function readOrCreateMachineKey() {
  const keyPath = path.join(dbRuntimeInfo().dataDir, "auth-bundle.key");
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length !== 32) throw bundleError("AUTH_BUNDLE_KEY_INVALID", "本机登录包密钥损坏，请重新扫码授权后导出新的登录包。", 500);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const created = crypto.randomBytes(32);
  try {
    const handle = await fs.open(keyPath, "wx", 0o600);
    try {
      await handle.writeFile(created);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return created;
  } catch (error) {
    if (error?.code === "EEXIST") return fs.readFile(keyPath);
    throw error;
  }
}

function machineKeyId(key) {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, 16);
}

export async function createAuthBundle({ cookies, session }, options = {}) {
  const key = options.key || await readOrCreateMachineKey();
  if (!Buffer.isBuffer(key) || key.length !== 32) throw bundleError("AUTH_BUNDLE_KEY_INVALID", "登录包加密密钥无效。", 500);
  const payload = {
    exportedAt: new Date().toISOString(),
    originSessionId: String(session?.id || "").slice(0, 160),
    name: String(session?.name || "淘宝扫码账号").slice(0, 40),
    accountType: ["normal", "gift", "vip88"].includes(session?.accountType) ? session.accountType : "normal",
    browserEngine: ["uc", "360", "qq", "sogou", "edge"].includes(session?.browserEngine) ? session.browserEngine : "uc",
    cookies: normalizeAuthBundleCookies(cookies),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AUTH_BUNDLE_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    format: AUTH_BUNDLE_FORMAT,
    version: AUTH_BUNDLE_VERSION,
    cipher: "AES-256-GCM",
    keyId: machineKeyId(key),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export async function openAuthBundle(input, options = {}) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "utf8");
  if (!raw.length || raw.length > AUTH_BUNDLE_MAX_BYTES) throw bundleError("AUTH_BUNDLE_SIZE_INVALID", "登录包为空或超过 2MB。");
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    throw bundleError("AUTH_BUNDLE_INVALID_JSON", "请选择由本应用导出的登录包 JSON 文件。");
  }
  if (document?.format !== AUTH_BUNDLE_FORMAT || document?.version !== AUTH_BUNDLE_VERSION || document?.cipher !== "AES-256-GCM") {
    throw bundleError("AUTH_BUNDLE_VERSION_UNSUPPORTED", "登录包格式或版本不受支持，请使用当前应用重新导出。");
  }
  const key = options.key || await readOrCreateMachineKey();
  if (document.keyId !== machineKeyId(key)) {
    throw bundleError("AUTH_BUNDLE_MACHINE_MISMATCH", "这个登录包不是由本机当前应用生成的，不能导入。请在本机重新扫码授权。", 409);
  }
  let payload;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(document.iv, "base64url"));
    decipher.setAAD(AUTH_BUNDLE_AAD);
    decipher.setAuthTag(Buffer.from(document.tag, "base64url"));
    payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(document.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw bundleError("AUTH_BUNDLE_AUTH_FAILED", "登录包已损坏或被修改，不能导入。", 409);
  }
  return {
    exportedAt: String(payload?.exportedAt || ""),
    originSessionId: String(payload?.originSessionId || "").slice(0, 160),
    name: String(payload?.name || "淘宝扫码账号").slice(0, 40),
    accountType: ["normal", "gift", "vip88"].includes(payload?.accountType) ? payload.accountType : "normal",
    browserEngine: ["uc", "360", "qq", "sogou", "edge"].includes(payload?.browserEngine) ? payload.browserEngine : "uc",
    cookies: normalizeAuthBundleCookies(payload?.cookies),
  };
}
