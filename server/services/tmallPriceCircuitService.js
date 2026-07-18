// Keeps Tmall price authorization separate from the broader Taobao login state.
// A login cookie proves identity only; a verified local price snapshot proves
// that the account can currently receive Tmall price data.

export const TMALL_PRICE_STATUS = Object.freeze({
  UNKNOWN: "unknown",
  VALID: "valid",
  COOLDOWN: "cooldown",
});

const DEFAULT_ACCOUNT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_DEVICE_COOLDOWN_MS = 5 * 60 * 1000;
const LOCAL_DEVICE_KEY = "local-device";

const deviceCooldowns = new Map();

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function tmallPriceDeviceKey(session = {}) {
  if (session.browserProfileKey || session.browserPort) return LOCAL_DEVICE_KEY;
  if (session.id) return `session:${session.id}`;
  return "";
}

function rememberPersistedCooldown(session, now) {
  const key = tmallPriceDeviceKey(session);
  if (!key) return 0;
  const persisted = timestamp(session.tmallPriceDeviceCooldownUntil);
  if (persisted > now) {
    deviceCooldowns.set(key, Math.max(deviceCooldowns.get(key) || 0, persisted));
  }
  return deviceCooldowns.get(key) || 0;
}

export function hydrateTmallPriceCircuits(sessions = [], now = Date.now()) {
  for (const session of Array.isArray(sessions) ? sessions : []) rememberPersistedCooldown(session, now);
  return sessions;
}

export function tmallPriceCooldownRemaining(session = {}, now = Date.now()) {
  const key = tmallPriceDeviceKey(session);
  const deviceUntil = Math.max(rememberPersistedCooldown(session, now), key ? (deviceCooldowns.get(key) || 0) : 0);
  const accountUntil = timestamp(session.tmallPriceCooldownUntil);
  return Math.max(0, Math.max(deviceUntil, accountUntil) - now);
}

export function tmallPriceCircuitOpen(session = {}, now = Date.now()) {
  const remaining = tmallPriceCooldownRemaining(session, now);
  return remaining > 0;
}

export function createTmallPriceCooldownError(session = {}, now = Date.now()) {
  const remaining = tmallPriceCooldownRemaining(session, now);
  const error = new Error(remaining > 0
    ? `天猫价格能力正在冷却，请等待 ${Math.ceil(remaining / 60_000)} 分钟后再试；淘宝登录状态未清除。`
    : "天猫价格能力暂不可用，请先通过真实商品抓取验证后再试。");
  error.code = "TMALL_PRICE_COOLDOWN";
  error.status = 409;
  error.retryAfterMs = remaining;
  return error;
}

export function isTmallPriceGateError(error) {
  return String(error?.code || "") === "TMALL_PRICE_AUTH_REQUIRED"
    || /天猫优惠价格授权未同步|登录查看更多优惠/.test(String(error?.message || ""));
}

export function isTmallPriceCooldownError(error) {
  return String(error?.code || "") === "TMALL_PRICE_COOLDOWN";
}

export function markTmallPriceGate(session, {
  now = Date.now(),
  accountCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS,
  deviceCooldownMs = DEFAULT_DEVICE_COOLDOWN_MS,
} = {}) {
  const accountUntil = now + Math.max(1_000, finitePositive(accountCooldownMs) || DEFAULT_ACCOUNT_COOLDOWN_MS);
  const deviceUntil = now + Math.max(1_000, finitePositive(deviceCooldownMs) || DEFAULT_DEVICE_COOLDOWN_MS);
  const key = tmallPriceDeviceKey(session);
  if (key) deviceCooldowns.set(key, Math.max(deviceCooldowns.get(key) || 0, deviceUntil));
  session.tmallPriceStatus = TMALL_PRICE_STATUS.COOLDOWN;
  session.tmallPriceCooldownUntil = new Date(accountUntil).toISOString();
  session.tmallPriceDeviceCooldownUntil = new Date(deviceUntil).toISOString();
  session.tmallPriceLastFailureAt = new Date(now).toISOString();
  session.tmallPriceFailureCount = Number(session.tmallPriceFailureCount || 0) + 1;
  session.tmallPriceFailureReason = "TMALL_PRICE_AUTH_REQUIRED";
  return { accountUntil, deviceUntil, remainingMs: Math.max(accountUntil, deviceUntil) - now };
}

export function markTmallPriceSuccess(session, now = Date.now()) {
  const key = tmallPriceDeviceKey(session);
  if (key) deviceCooldowns.delete(key);
  session.tmallPriceStatus = TMALL_PRICE_STATUS.VALID;
  session.tmallPriceCheckedAt = new Date(now).toISOString();
  session.tmallPriceCooldownUntil = null;
  session.tmallPriceDeviceCooldownUntil = null;
  session.tmallPriceLastFailureAt = null;
  session.tmallPriceFailureReason = null;
  session.tmallPriceFailureCount = 0;
  return session;
}

export function markTmallPriceUnknown(session, now = Date.now()) {
  const key = tmallPriceDeviceKey(session);
  if (key) deviceCooldowns.delete(key);
  session.tmallPriceStatus = TMALL_PRICE_STATUS.UNKNOWN;
  session.tmallPriceCheckedAt = null;
  session.tmallPriceCooldownUntil = null;
  session.tmallPriceDeviceCooldownUntil = null;
  session.tmallPriceLastFailureAt = null;
  session.tmallPriceFailureReason = null;
  session.tmallPriceFailureCount = 0;
  session.tmallPriceStateChangedAt = new Date(now).toISOString();
  return session;
}

export function refreshTmallPriceCircuit(session, now = Date.now()) {
  if (!tmallPriceCircuitOpen(session, now) && session.tmallPriceStatus === TMALL_PRICE_STATUS.COOLDOWN) {
    session.tmallPriceStatus = TMALL_PRICE_STATUS.UNKNOWN;
    session.tmallPriceCooldownUntil = null;
    session.tmallPriceDeviceCooldownUntil = null;
    session.tmallPriceFailureReason = null;
  }
  return session;
}

export function resetTmallPriceCircuitForTests() {
  deviceCooldowns.clear();
}

export const tmallPriceCooldownDefaults = Object.freeze({
  accountCooldownMs: DEFAULT_ACCOUNT_COOLDOWN_MS,
  deviceCooldownMs: DEFAULT_DEVICE_COOLDOWN_MS,
});
