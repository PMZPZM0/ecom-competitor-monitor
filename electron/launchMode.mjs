import fs from "node:fs";
import path from "node:path";

export const DESKTOP_MODE = "desktop";
export const WEB_MODE = "web";

export function normalizeLaunchMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["desktop", "app"].includes(mode)) return DESKTOP_MODE;
  if (["web", "browser"].includes(mode)) return WEB_MODE;
  return null;
}

export function launchModeFromArgs(argv = []) {
  const argument = argv.find((value) => String(value).startsWith("--launch-mode="));
  return normalizeLaunchMode(argument?.slice("--launch-mode=".length));
}

export function shouldResetLaunchMode(argv = []) {
  return argv.includes("--reset-launch-mode");
}

export function readLaunchMode(filePath) {
  try {
    return normalizeLaunchMode(JSON.parse(fs.readFileSync(filePath, "utf8")).mode);
  } catch {
    return null;
  }
}

export function writeLaunchMode(filePath, mode) {
  const normalized = normalizeLaunchMode(mode);
  if (!normalized) throw new Error("Unsupported launch mode.");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ mode: normalized }, null, 2)}\n`, "utf8");
  return normalized;
}

export function clearLaunchMode(filePath) {
  fs.rmSync(filePath, { force: true });
}
