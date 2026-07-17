import crypto from "node:crypto";

const ENCRYPTION_VERSION = "model-v1";

function encryptionKey(env = process.env) {
  const source = env.MODEL_CONFIG_ENCRYPTION_KEY
    || env.CONFIG_ENCRYPTION_KEY
    || "ecom-monitor-local-model-config-key";
  return crypto.createHash("sha256").update(source).digest();
}

export function encryptSecret(value, { env = process.env } = {}) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value, { env = process.env } = {}) {
  if (!value) return "";
  const [version, ivValue, tagValue, encryptedValue] = String(value).split(".");
  if (version !== ENCRYPTION_VERSION || !ivValue || !tagValue || !encryptedValue) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function isEncryptedSecret(value) {
  return String(value || "").startsWith(`${ENCRYPTION_VERSION}.`);
}

export function maskSecret(value) {
  const secret = String(value || "");
  if (!secret) return "";
  if (secret.length <= 10) return `${secret.slice(0, 2)}***`;
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}
