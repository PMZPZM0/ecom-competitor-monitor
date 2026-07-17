import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import sharp from "sharp";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-photoshop-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  listGeneratedImages,
  readGeneratedImageFile,
  saveGeneratedImages,
} = await import("./imageGenerationService.js");
const {
  clearPhotoshopWorkfile,
  findPhotoshopApplication,
  openGeneratedImageInPhotoshop,
  preparePhotoshopWorkfile,
  syncPhotoshopWorkfile,
} = await import("./photoshopService.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function saveSource({ color = "#336699", format = "png", width = 18, height = 14 } = {}) {
  const pipeline = sharp({ create: { width, height, channels: 4, background: color } });
  const buffer = format === "jpeg" ? await pipeline.jpeg().toBuffer() : await pipeline.png().toBuffer();
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const [image] = await saveGeneratedImages([{
    buffer,
    mimeType,
    nativeSize: `${width}x${height}`,
    outputSize: `${width}x${height}`,
    width,
    height,
    upscaled: false,
    processing: "native",
  }], {
    prompt: "source product image",
    negativePrompt: "watermark",
    ratio: "1:1",
    resolution: "1k",
    quality: "high",
    background: "auto",
    model: "gpt-image-2",
  });
  return { image, buffer };
}

function metadataPath(workFile) {
  return workFile.replace(/\.png$/i, ".json");
}

test("Photoshop detection finds the newest standard Windows and macOS installations", async () => {
  const windowsRoot = path.join(dataDir, "fake-program-files");
  for (const version of ["2025", "2026"]) {
    const directory = path.join(windowsRoot, "Adobe", `Adobe Photoshop ${version}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "Photoshop.exe"), "fake");
  }
  assert.deepEqual(await findPhotoshopApplication({ platform: "win32", windowsRoots: [windowsRoot] }), {
    kind: "windows",
    path: path.join(windowsRoot, "Adobe", "Adobe Photoshop 2026", "Photoshop.exe"),
    name: "Adobe Photoshop 2026",
  });

  const macRoot = path.join(dataDir, "fake-applications");
  await Promise.all(["2025", "2026"].map((version) => fs.mkdir(
    path.join(macRoot, `Adobe Photoshop ${version}.app`),
    { recursive: true },
  )));
  assert.deepEqual(await findPhotoshopApplication({ platform: "darwin", macRoots: [macRoot] }), {
    kind: "macos",
    path: path.join(macRoot, "Adobe Photoshop 2026.app"),
    name: "Adobe Photoshop 2026",
  });

  assert.equal(await findPhotoshopApplication({ platform: "win32", windowsRoots: [path.join(dataDir, "missing")] }), null);
  assert.equal(await findPhotoshopApplication({ platform: "linux" }), null);
});

test("Photoshop launcher receives exact executable and argument arrays", async () => {
  const { image } = await saveSource();
  const launches = [];
  const launcher = async (command, args) => launches.push({ command, args });
  const windowsApp = { kind: "windows", path: "C:\\Adobe\\Photoshop.exe", name: "Adobe Photoshop" };
  const windowsResult = await openGeneratedImageInPhotoshop(image.id, { application: windowsApp, launcher });
  assert.deepEqual(launches[0], { command: windowsApp.path, args: [windowsResult.workFile] });

  await clearPhotoshopWorkfile(image.id);
  const macApp = { kind: "macos", path: "/Applications/Adobe Photoshop 2026.app", name: "Adobe Photoshop 2026" };
  const macResult = await openGeneratedImageInPhotoshop(image.id, { application: macApp, launcher });
  assert.deepEqual(launches[1], { command: "/usr/bin/open", args: ["-a", macApp.path, "--", macResult.workFile] });
  await clearPhotoshopWorkfile(image.id);
});

test("preparing a workfile converts to PNG and reuses unsynced edits", async () => {
  const { image } = await saveSource({ format: "jpeg" });
  const prepared = await preparePhotoshopWorkfile(image.id);
  assert.equal(prepared.reused, false);
  assert.equal((await sharp(prepared.workFile).metadata()).format, "png");
  const metadata = JSON.parse(await fs.readFile(metadataPath(prepared.workFile), "utf8"));
  assert.equal(metadata.imageId, image.id);
  assert.match(metadata.lastSyncedHash, /^[a-f0-9]{64}$/);

  const edit = await sharp({ create: { width: 18, height: 14, channels: 4, background: "#cc3300" } }).png().toBuffer();
  await fs.writeFile(prepared.workFile, edit);
  const reused = await preparePhotoshopWorkfile(image.id);
  assert.equal(reused.reused, true);
  assert.equal((await fs.readFile(reused.workFile)).equals(edit), true);
  await clearPhotoshopWorkfile(image.id);
});

test("sync rejects unchanged work, creates one child version, and preserves the original", async () => {
  const { image, buffer: original } = await saveSource({ color: "#1155aa", width: 20, height: 12 });
  const prepared = await preparePhotoshopWorkfile(image.id);
  await assert.rejects(syncPhotoshopWorkfile(image.id), (error) => error.code === "PHOTOSHOP_WORKFILE_UNCHANGED");

  const edit = await sharp({ create: { width: 20, height: 12, channels: 4, background: "#ee7711" } }).png().toBuffer();
  await fs.writeFile(prepared.workFile, edit);
  const attempts = await Promise.allSettled([
    syncPhotoshopWorkfile(image.id),
    syncPhotoshopWorkfile(image.id),
  ]);
  const fulfilled = attempts.filter((result) => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "PHOTOSHOP_WORKFILE_UNCHANGED");

  const synced = fulfilled[0].value.image;
  assert.notEqual(synced.id, image.id);
  assert.equal(synced.parentImageId, image.id);
  assert.equal(synced.model, "Adobe Photoshop");
  assert.equal((await readGeneratedImageFile(image.id)).buffer.equals(original), true);
  const expectedPixels = await sharp(edit).raw().toBuffer();
  const actualPixels = await sharp((await readGeneratedImageFile(synced.id)).buffer).raw().toBuffer();
  assert.deepEqual(actualPixels, expectedPixels);
  const related = (await listGeneratedImages()).filter((item) => item.id === image.id || item.parentImageId === image.id);
  assert.equal(related.length, 2);

  await assert.rejects(syncPhotoshopWorkfile(image.id), (error) => error.code === "PHOTOSHOP_WORKFILE_UNCHANGED");
  await clearPhotoshopWorkfile(image.id);
});

test("sync rejects oversized, malformed, and symbolic-link workfiles", async (t) => {
  const { image } = await saveSource();
  const prepared = await preparePhotoshopWorkfile(image.id);
  await fs.truncate(prepared.workFile, 32 * 1024 * 1024 + 1);
  await assert.rejects(syncPhotoshopWorkfile(image.id), (error) => error.code === "PHOTOSHOP_WORKFILE_TOO_LARGE");

  await fs.writeFile(prepared.workFile, "not a png");
  await assert.rejects(syncPhotoshopWorkfile(image.id), (error) => error.code === "PHOTOSHOP_WORKFILE_INVALID");
  await clearPhotoshopWorkfile(image.id);

  const external = path.join(dataDir, "external-work.png");
  await fs.writeFile(external, await sharp({ create: { width: 2, height: 2, channels: 4, background: "#000000" } }).png().toBuffer());
  try {
    await fs.symlink(external, prepared.workFile);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.diagnostic("symbolic links are unavailable on this host");
      return;
    }
    throw error;
  }
  await assert.rejects(syncPhotoshopWorkfile(image.id), (error) => error.code === "PHOTOSHOP_WORKFILE_NOT_FOUND");
  await clearPhotoshopWorkfile(image.id);
});

test("clearing a Photoshop workfile removes its image and metadata", async () => {
  const { image } = await saveSource();
  const prepared = await preparePhotoshopWorkfile(image.id);
  const metadata = metadataPath(prepared.workFile);
  await clearPhotoshopWorkfile(image.id);
  await assert.rejects(fs.access(prepared.workFile), (error) => error.code === "ENOENT");
  await assert.rejects(fs.access(metadata), (error) => error.code === "ENOENT");
});
