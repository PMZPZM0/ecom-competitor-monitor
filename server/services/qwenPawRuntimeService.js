import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const QWENPAW_CDN_ORIGIN = "https://download.qwenpaw.agentscope.io";
const QWENPAW_DESKTOP_INDEX = `${QWENPAW_CDN_ORIGIN}/metadata/apps/desktop/index.json`;
const INSTALL_METADATA_FILE = ".ecom-qwenpaw-install.json";
const ECOMMERCE_QR_PLUGIN_ID = "ecommerce-qr-delivery";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_READY_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;

let installTask = idleInstallTask();
let installPromise = null;
let backendRuntime = null;

function nowIso() {
  return new Date().toISOString();
}

function idleInstallTask() {
  return {
    state: "idle",
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    message: "尚未开始安装。",
    error: "",
    version: "",
    installDirectory: "",
    startedAt: null,
    finishedAt: null,
  };
}

function updateInstallTask(patch) {
  installTask = { ...installTask, ...patch };
  return { ...installTask };
}

function cleanAbsoluteDirectory(value) {
  const source = String(value || "").trim();
  if (!source || !path.isAbsolute(source)) return "";
  return path.normalize(source);
}

export function defaultQwenPawInstallDirectory({ platform = process.platform, homeDirectory = os.homedir() } = {}) {
  if (platform === "win32") return "D:\\电商监控数据\\QwenPaw";
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "电商竞品监控", "QwenPaw");
  throw new Error(`当前系统暂不支持运营 Agent：${platform}`);
}

export function normalizeQwenPawInstallDirectory(value, options = {}) {
  return cleanAbsoluteDirectory(value) || defaultQwenPawInstallDirectory(options);
}

export function qwenPawOfficialPackagePlan({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32" && arch === "x64") {
    return { platform: "win32", arch, manifestPlatform: "win-tauri", packageType: "exe", universal: false };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { platform: "darwin", arch, manifestPlatform: "mac-tauri", packageType: "zip", universal: false };
  }
  if (platform === "darwin" && arch === "x64") {
    throw new Error("QwenPaw 官网当前只提供 Apple Silicon 版；Intel Mac 暂不能自动安装运营 Agent。");
  }
  throw new Error(`当前系统架构暂不支持运营 Agent：${platform}/${arch}`);
}

function officialUrl(value) {
  const url = new URL(String(value || ""), QWENPAW_CDN_ORIGIN);
  if (url.protocol !== "https:" || url.origin !== QWENPAW_CDN_ORIGIN) {
    throw new Error("QwenPaw 下载地址不属于官方 CDN，已停止安装。");
  }
  return url.toString();
}

async function officialFetch(url, options = {}) {
  const response = await fetch(officialUrl(url), {
    ...options,
    headers: { accept: "application/json, application/octet-stream", "user-agent": "ecommerce-competitor-monitor", ...options.headers },
    signal: options.signal || AbortSignal.timeout(120_000),
  });
  officialUrl(response.url);
  if (!response.ok) throw new Error(`QwenPaw 官方下载服务返回 ${response.status}。`);
  return response;
}

export function selectQwenPawOfficialPackage(index, plan = qwenPawOfficialPackagePlan()) {
  const platform = index?.platforms?.[plan.manifestPlatform];
  const file = platform?.latest ? index?.files?.[platform.latest] : null;
  if (!file || file.platform !== plan.manifestPlatform || file.type !== plan.packageType) {
    throw new Error(`官方清单没有 ${plan.platform}/${plan.arch} 对应的稳定安装包。`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || ""))) throw new Error("官方安装包缺少有效的 SHA-256 校验值。");
  return {
    id: String(file.id),
    version: String(file.version),
    filename: path.basename(String(file.filename)),
    url: officialUrl(file.url),
    sizeBytes: Number(file.size_bytes) || 0,
    sha256: String(file.sha256).toLowerCase(),
    packageType: plan.packageType,
    platform: plan.platform,
    arch: plan.arch,
    universal: plan.universal,
  };
}

export async function resolveQwenPawOfficialPackage(options = {}) {
  const response = await officialFetch(QWENPAW_DESKTOP_INDEX, { signal: AbortSignal.timeout(30_000) });
  return selectQwenPawOfficialPackage(await response.json(), qwenPawOfficialPackagePlan(options));
}

function metadataPath(installDirectory) {
  return path.join(installDirectory, INSTALL_METADATA_FILE);
}

export function qwenPawWorkingDirectory(installDirectory) {
  return path.join(normalizeQwenPawInstallDirectory(installDirectory), "data");
}

export function qwenPawBundledPluginSource({
  sourceDirectory = __dirname,
  unpackedDirectory = process.env.ECOM_MONITOR_UNPACKED_DIR,
  platform = process.platform,
} = {}) {
  // Electron keeps source files in app.asar. QwenPaw's Python runtime needs
  // a normal directory, so production uses Electron's app.asar.unpacked copy.
  // Use the target platform's path rules: release tests intentionally verify
  // a Windows packaged path while running on macOS.
  const pathApi = platform === "win32" ? path.win32 : path;
  if (String(unpackedDirectory || "").trim()) {
    return pathApi.join(pathApi.resolve(String(unpackedDirectory)), "server", "qwenpaw-plugins", ECOMMERCE_QR_PLUGIN_ID);
  }
  return pathApi.resolve(sourceDirectory, "../qwenpaw-plugins", ECOMMERCE_QR_PLUGIN_ID);
}

async function installBundledQwenPawPlugins(installDirectory) {
  const source = qwenPawBundledPluginSource();
  if (!existsSync(path.join(source, "plugin.json"))) {
    throw new Error(`内置 QwenPaw 二维码插件缺失：${source}`);
  }
  const destination = path.join(qwenPawWorkingDirectory(installDirectory), "plugins", ECOMMERCE_QR_PLUGIN_ID);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

export function qwenPawRuntimePaths(installDirectory, { platform = process.platform } = {}) {
  const root = normalizeQwenPawInstallDirectory(installDirectory, { platform });
  const resourceRoot = platform === "win32"
    ? root
    : path.join(root, "QwenPaw Desktop.app", "Contents", "Resources");
  const backendRoot = path.join(resourceRoot, "binaries", "qwenpaw-backend");
  const pythonRoot = path.join(resourceRoot, "binaries", "python-runtime", "python");
  const nodeRoot = path.join(resourceRoot, "binaries", "node-runtime");
  return {
    root,
    resourceRoot,
    backend: path.join(backendRoot, platform === "win32" ? "qwenpaw-backend.exe" : "qwenpaw-backend"),
    cli: path.join(backendRoot, platform === "win32" ? "qwenpaw.exe" : "qwenpaw"),
    python: platform === "win32" ? path.join(pythonRoot, "python.exe") : path.join(pythonRoot, "bin", "python3"),
    nodeRoot,
    node: platform === "win32" ? path.join(nodeRoot, "node.exe") : path.join(nodeRoot, "bin", "node"),
  };
}

async function readInstallMetadata(installDirectory) {
  try {
    return JSON.parse(await fs.readFile(metadataPath(installDirectory), "utf8"));
  } catch {
    return {};
  }
}

export function qwenPawLocalRuntimeStatus(installDirectory, options = {}) {
  const directory = normalizeQwenPawInstallDirectory(installDirectory, options);
  const paths = qwenPawRuntimePaths(directory, options);
  const installed = existsSync(paths.backend);
  const taskForDirectory = !installTask.installDirectory || path.normalize(installTask.installDirectory) === directory
    ? { ...installTask, installDirectory: installTask.installDirectory || directory }
    : { ...idleInstallTask(), installDirectory: directory };
  return {
    installed,
    version: "",
    message: installed ? "QwenPaw 官方运行时已就绪。" : "尚未安装 QwenPaw 官方运行时。",
    skillReady: false,
    signature: "",
    installDirectory: directory,
    defaultInstallDirectory: defaultQwenPawInstallDirectory(options),
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    updateAvailable: false,
    latestVersion: "",
    installTask: taskForDirectory,
  };
}

export async function qwenPawRuntimeStatus(installDirectory, { checkLatest = false, ...options } = {}) {
  const status = qwenPawLocalRuntimeStatus(installDirectory, options);
  const metadata = await readInstallMetadata(status.installDirectory);
  status.version = String(metadata.version || "");
  status.skillReady = existsSync(path.join(qwenPawWorkingDirectory(status.installDirectory), "workspaces", "default", "skills", "ecommerce-operations-assistant", "SKILL.md"));
  if (checkLatest) {
    try {
      const latest = await resolveQwenPawOfficialPackage(options);
      status.latestVersion = latest.version;
      // A runtime installed before this integration has no local metadata.
      // Offer an in-place repair so it can enter the verified update track.
      status.updateAvailable = Boolean(status.installed && status.version !== latest.version);
    } catch (error) {
      status.latestCheckError = error instanceof Error ? error.message : String(error);
    }
  }
  return status;
}

export async function downloadQwenPawOfficialPackage(pkg, destination) {
  const response = await officialFetch(pkg.url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.body) throw new Error("QwenPaw 官方安装包没有可下载内容。");
  const totalBytes = Number(response.headers.get("content-length")) || pkg.sizeBytes || 0;
  const hash = crypto.createHash("sha256");
  let downloadedBytes = 0;
  let lastProgress = -1;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      const percentage = totalBytes ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)) : 0;
      if (percentage !== lastProgress) {
        lastProgress = percentage;
        updateInstallTask({ state: "downloading", progress: percentage, downloadedBytes, totalBytes, message: `正在从 QwenPaw 官网下载 ${pkg.version}…` });
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(destination));
    const actual = hash.digest("hex");
    if (actual !== pkg.sha256) throw new Error("QwenPaw 安装包校验失败，文件已删除，请重试。");
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function runCommand(command, args, { timeoutMs = INSTALL_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    const output = [];
    const collect = (chunk) => {
      output.push(Buffer.from(chunk));
      if (output.length > 20) output.shift();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("QwenPaw 安装超时，请检查磁盘空间后重试。"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = Buffer.concat(output).toString("utf8").trim().slice(-1_200);
      reject(new Error(detail || `QwenPaw 安装程序退出，状态码 ${code ?? "未知"}。`));
    });
  });
}

async function findMacApp(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name === "QwenPaw Desktop.app") return current;
    if (entry.isDirectory()) {
      const nested = await findMacApp(current);
      if (nested) return nested;
    }
  }
  return "";
}

async function installMacPackage(archivePath, installDirectory, stagingDirectory) {
  const extracted = path.join(stagingDirectory, "extracted");
  await fs.mkdir(extracted, { recursive: true });
  await runCommand("ditto", ["-x", "-k", archivePath, extracted]);
  const app = await findMacApp(extracted);
  if (!app) throw new Error("QwenPaw macOS 安装包中未找到应用程序。");
  await fs.mkdir(installDirectory, { recursive: true });
  const target = path.join(installDirectory, "QwenPaw Desktop.app");
  const backup = `${target}.previous-${Date.now()}`;
  if (existsSync(target)) await fs.rename(target, backup);
  try {
    await fs.rename(app, target);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(backup) && !existsSync(target)) await fs.rename(backup, target);
    throw error;
  }
}

async function installOfficialPackage(pkg, installDirectory, stagingDirectory) {
  const archivePath = path.join(stagingDirectory, pkg.filename);
  await downloadQwenPawOfficialPackage(pkg, archivePath);
  updateInstallTask({ state: "installing", progress: 99, message: "安装包校验通过，正在原路径安装…" });
  await stopQwenPawBackend();
  if (pkg.platform === "win32") {
    await fs.mkdir(installDirectory, { recursive: true });
    await runCommand(archivePath, ["/S", "/NO_QWENPAW_PATH", `/D=${installDirectory}`]);
  } else {
    await installMacPackage(archivePath, installDirectory, stagingDirectory);
  }
  const paths = qwenPawRuntimePaths(installDirectory, { platform: pkg.platform });
  if (!existsSync(paths.backend)) throw new Error("安装完成后未找到 QwenPaw 官方后端，请重新安装。");
  await installBundledQwenPawPlugins(installDirectory);
  await fs.writeFile(metadataPath(installDirectory), `${JSON.stringify({ version: pkg.version, packageId: pkg.id, sha256: pkg.sha256, installedAt: nowIso(), platform: pkg.platform, arch: pkg.arch }, null, 2)}\n`, "utf8");
}

export function qwenPawInstallTaskStatus() {
  return { ...installTask };
}

export function startQwenPawInstall(installDirectory, options = {}) {
  if (installPromise) return { ...installTask };
  const directory = normalizeQwenPawInstallDirectory(installDirectory, options);
  installTask = {
    ...idleInstallTask(),
    state: "resolving",
    message: "正在读取 QwenPaw 官方版本清单…",
    installDirectory: directory,
    startedAt: nowIso(),
  };
  installPromise = (async () => {
    const pkg = await resolveQwenPawOfficialPackage(options);
    updateInstallTask({ version: pkg.version, totalBytes: pkg.sizeBytes });
    const parent = path.dirname(directory);
    await fs.mkdir(parent, { recursive: true });
    const stagingDirectory = await fs.mkdtemp(path.join(parent, ".qwenpaw-install-"));
    try {
      await installOfficialPackage(pkg, directory, stagingDirectory);
    } finally {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    updateInstallTask({ state: "completed", progress: 100, message: `QwenPaw ${pkg.version} 已安装完成。`, error: "", finishedAt: nowIso() });
  })().catch((error) => {
    updateInstallTask({ state: "failed", message: "QwenPaw 安装未完成。", error: error instanceof Error ? error.message : String(error), finishedAt: nowIso() });
  }).finally(() => {
    installPromise = null;
  });
  return { ...installTask };
}

function backendEnvironment(installDirectory, extra = {}) {
  const paths = qwenPawRuntimePaths(installDirectory);
  const existingPath = process.env[process.platform === "win32" ? "Path" : "PATH"] || "";
  return {
    ...process.env,
    ...extra,
    QWENPAW_WORKING_DIR: qwenPawWorkingDirectory(installDirectory),
    QWENPAW_DESKTOP_APP: "1",
    QWENPAW_DESKTOP_PY_RUNTIME: paths.python,
    QWENPAW_DESKTOP_NODE_RUNTIME: paths.nodeRoot,
    [process.platform === "win32" ? "Path" : "PATH"]: `${path.dirname(paths.backend)}${path.delimiter}${existingPath}`,
  };
}

export async function startQwenPawBackend(installDirectory, extraEnvironment = {}) {
  const directory = normalizeQwenPawInstallDirectory(installDirectory);
  if (backendRuntime?.child?.exitCode === null && backendRuntime.installDirectory === directory) return backendRuntime;
  await stopQwenPawBackend();
  const paths = qwenPawRuntimePaths(directory);
  if (!existsSync(paths.backend)) throw Object.assign(new Error("尚未安装 QwenPaw，请先完成安装。"), { status: 503 });
  await fs.mkdir(qwenPawWorkingDirectory(directory), { recursive: true });
  await installBundledQwenPawPlugins(directory);
  const shutdownToken = crypto.randomUUID();
  const child = spawn(paths.backend, [], {
    cwd: path.dirname(paths.backend),
    env: backendEnvironment(directory, { ...extraEnvironment, QWENPAW_DESKTOP_SHUTDOWN_TOKEN: shutdownToken }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let recentError = "";
  child.stderr.on("data", (chunk) => { recentError = String(chunk).trim().slice(-1_000); });
  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(recentError || "QwenPaw 官方后端启动超时。")), BACKEND_READY_TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(recentError || `QwenPaw 官方后端已退出（${code ?? "未知"}）。`)));
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4_000);
      const line = stdout.split(/\r?\n/).find((item) => item.includes("QWENPAW_BACKEND_READY"));
      const matched = line?.match(/\{[^\n]*"port"\s*:\s*(\d+)[^\n]*\}/);
      if (!matched) return;
      clearTimeout(timer);
      resolve(Number(matched[1]));
    });
  }).catch((error) => {
    child.kill();
    throw error;
  });
  backendRuntime = { child, port, installDirectory: directory, shutdownToken };
  child.once("exit", () => {
    if (backendRuntime?.child === child) backendRuntime = null;
  });
  return backendRuntime;
}

export async function stopQwenPawBackend() {
  const runtime = backendRuntime;
  backendRuntime = null;
  if (!runtime?.child || runtime.child.exitCode !== null || runtime.child.killed) return;
  try {
    await fetch(`http://127.0.0.1:${runtime.port}/api/desktop/shutdown`, {
      method: "POST",
      headers: { "X-QwenPaw-Desktop-Shutdown-Token": runtime.shutdownToken },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    runtime.child.kill();
  }
  await Promise.race([
    new Promise((resolve) => runtime.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (runtime.child.exitCode === null) runtime.child.kill();
}

export function qwenPawBackendUrl(runtime, pathname = "") {
  const suffix = String(pathname || "").startsWith("/") ? pathname : `/${pathname}`;
  return `http://127.0.0.1:${runtime.port}${suffix}`;
}
