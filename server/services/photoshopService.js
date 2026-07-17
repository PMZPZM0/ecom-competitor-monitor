import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { dbRuntimeInfo } from "../storage/db.js";
import { deleteGeneratedImage, readGeneratedImageFile, saveGeneratedImages } from "./imageGenerationService.js";

const IMAGE_ID_PATTERN = /^image_[a-f0-9]{32}$/;
const MAX_WORK_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const syncQueues = new Map();

function photoshopError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function workPaths(imageId) {
  if (!IMAGE_ID_PATTERN.test(String(imageId || ""))) throw photoshopError("图片记录 ID 无效。", "PHOTOSHOP_IMAGE_ID_INVALID");
  const directory = path.join(dbRuntimeInfo().dataDir, "generated-images", "photoshop-work");
  return {
    directory,
    image: path.join(directory, `${imageId}.png`),
    metadata: path.join(directory, `${imageId}.json`),
  };
}

async function atomicWrite(destination, data) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function regularFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function applicationDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return [];
    throw error;
  }
}

export async function findPhotoshopApplication({
  platform = process.platform,
  env = process.env,
  windowsRoots,
  macRoots,
} = {}) {
  if (platform === "win32") {
    const roots = windowsRoots || [...new Set([env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean))];
    const candidates = [];
    for (const root of roots) {
      const adobe = path.join(root, "Adobe");
      const entries = await directoryEntries(adobe);
      for (const entry of entries) {
        if (entry.isDirectory() && /^Adobe Photoshop/i.test(entry.name)) candidates.push(path.join(adobe, entry.name, "Photoshop.exe"));
      }
    }
    candidates.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const candidate of candidates) {
      if (await regularFile(candidate)) return { kind: "windows", path: candidate, name: path.basename(path.dirname(candidate)) };
    }
    return null;
  }

  if (platform === "darwin") {
    const roots = macRoots || ["/Applications", path.join(os.homedir(), "Applications")];
    const candidates = [];
    for (const root of roots) {
      const entries = await directoryEntries(root);
      for (const entry of entries) {
        if (entry.isDirectory() && /^Adobe Photoshop.*\.app$/i.test(entry.name)) candidates.push(path.join(root, entry.name));
      }
    }
    candidates.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const candidate of candidates) {
      if (await applicationDirectory(candidate)) return { kind: "macos", path: candidate, name: path.basename(candidate, ".app") };
    }
  }
  return null;
}

async function launchDetached(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function readWorkMetadata(file, imageId) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value?.version === 1 && value.imageId === imageId ? value : null;
  } catch (error) {
    if (["ENOENT", "SyntaxError"].includes(error?.code || error?.name)) return null;
    throw error;
  }
}

export async function preparePhotoshopWorkfile(imageId) {
  const paths = workPaths(imageId);
  const existing = await regularFile(paths.image);
  if (existing) {
    if (existing.size > MAX_WORK_BYTES) throw photoshopError("PS 工作副本超过 32 MB，请删除工作副本后重试。", "PHOTOSHOP_WORKFILE_TOO_LARGE", 413);
    return { imageId, workFile: paths.image, reused: true };
  }

  const source = await readGeneratedImageFile(imageId);
  let workBuffer;
  try {
    workBuffer = await sharp(source.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().png({ compressionLevel: 6 }).toBuffer();
  } catch {
    throw photoshopError("原图无法转换为 Photoshop 工作副本。", "PHOTOSHOP_SOURCE_INVALID", 422);
  }
  if (workBuffer.length > MAX_WORK_BYTES) throw photoshopError("PS 工作副本超过 32 MB，无法自动打开。", "PHOTOSHOP_WORKFILE_TOO_LARGE", 413);
  const hash = crypto.createHash("sha256").update(workBuffer).digest("hex");
  await atomicWrite(paths.image, workBuffer);
  try {
    await atomicWrite(paths.metadata, JSON.stringify({ version: 1, imageId, createdAt: new Date().toISOString(), lastSyncedHash: hash }, null, 2));
  } catch (error) {
    await fs.rm(paths.image, { force: true }).catch(() => undefined);
    throw error;
  }
  return { imageId, workFile: paths.image, reused: false };
}

export async function openGeneratedImageInPhotoshop(imageId, { application, launcher = launchDetached } = {}) {
  const photoshop = application || await findPhotoshopApplication();
  if (!photoshop) throw photoshopError("未检测到 Adobe Photoshop。请先安装 Photoshop，再重新点击。", "PHOTOSHOP_NOT_FOUND", 409);
  const work = await preparePhotoshopWorkfile(imageId);
  try {
    if (photoshop.kind === "windows") await launcher(photoshop.path, [work.workFile]);
    else await launcher("/usr/bin/open", ["-a", photoshop.path, "--", work.workFile]);
  } catch {
    throw photoshopError("Photoshop 启动失败，请确认安装完整且当前用户有权限运行。", "PHOTOSHOP_LAUNCH_FAILED", 500);
  }
  return { ...work, applicationName: photoshop.name };
}

async function syncPhotoshopWorkfileNow(imageId) {
  const paths = workPaths(imageId);
  const stat = await regularFile(paths.image);
  if (!stat) throw photoshopError("没有找到 PS 工作副本，请先点击“Photoshop 编辑”。", "PHOTOSHOP_WORKFILE_NOT_FOUND", 404);
  if (stat.size > MAX_WORK_BYTES) throw photoshopError("PS 工作副本超过 32 MB，无法同步。", "PHOTOSHOP_WORKFILE_TOO_LARGE", 413);
  const source = await readGeneratedImageFile(imageId);
  const workBuffer = await fs.readFile(paths.image);
  const hash = crypto.createHash("sha256").update(workBuffer).digest("hex");
  const metadata = await readWorkMetadata(paths.metadata, imageId);
  if (metadata?.lastSyncedHash === hash) throw photoshopError("PS 工作副本还没有新变化。请在 Photoshop 中保存后再同步。", "PHOTOSHOP_WORKFILE_UNCHANGED", 409);

  let normalized;
  try {
    normalized = await sharp(workBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  } catch {
    throw photoshopError("PS 工作副本不是可读取的 PNG 图片。请在 Photoshop 中直接保存，不要另存为 PSD。", "PHOTOSHOP_WORKFILE_INVALID", 422);
  }
  if (!normalized.info.width || !normalized.info.height || normalized.info.width * normalized.info.height > MAX_INPUT_PIXELS) {
    throw photoshopError("PS 工作副本尺寸无效或超过 4000 万像素。", "PHOTOSHOP_WORKFILE_PIXELS_EXCEEDED", 422);
  }

  const size = `${normalized.info.width}x${normalized.info.height}`;
  const [saved] = await saveGeneratedImages([{
    buffer: normalized.data,
    mimeType: "image/png",
    nativeSize: size,
    outputSize: size,
    width: normalized.info.width,
    height: normalized.info.height,
    upscaled: false,
    processing: "native",
  }], {
    prompt: source.record.prompt,
    negativePrompt: source.record.negativePrompt,
    ratio: source.record.ratio,
    resolution: source.record.resolution,
    quality: source.record.quality,
    background: source.record.background,
    model: "Adobe Photoshop",
    sourceImageId: imageId,
    referenceImageCount: 0,
    maskApplied: false,
    createdAt: new Date().toISOString(),
  });
  try {
    await atomicWrite(paths.metadata, JSON.stringify({ version: 1, imageId, createdAt: metadata?.createdAt || new Date().toISOString(), lastSyncedHash: hash, lastSyncedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    await deleteGeneratedImage(saved.id).catch(() => undefined);
    throw error;
  }
  return { image: saved, workFile: paths.image, modifiedAt: stat.mtime.toISOString() };
}

export function syncPhotoshopWorkfile(imageId) {
  const previous = syncQueues.get(imageId) || Promise.resolve();
  const operation = previous.then(
    () => syncPhotoshopWorkfileNow(imageId),
    () => syncPhotoshopWorkfileNow(imageId),
  );
  syncQueues.set(imageId, operation);
  return operation.finally(() => {
    if (syncQueues.get(imageId) === operation) syncQueues.delete(imageId);
  });
}

export async function clearPhotoshopWorkfile(imageId) {
  const paths = workPaths(imageId);
  await Promise.all([paths.image, paths.metadata].map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
}
