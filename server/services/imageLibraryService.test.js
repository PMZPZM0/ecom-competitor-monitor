import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import sharp from "sharp";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-image-library-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  deleteGeneratedImage,
  generateImages,
  listGeneratedImages,
  readGeneratedImageFile,
  saveGeneratedImages,
  updateGeneratedImage,
} = await import("./imageGenerationService.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function generatedImage(buffer, overrides = {}) {
  return {
    buffer,
    mimeType: "image/png",
    nativeSize: "1024x1024",
    outputSize: "1024x1024",
    width: 1024,
    height: 1024,
    upscaled: false,
    processing: "native",
    ...overrides,
  };
}

test("generated images persist locally and support favorite, archive, file and delete operations", async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#336699" } }).png().toBuffer();
  const [saved] = await saveGeneratedImages([generatedImage(png)], {
    prompt: "blue product",
    negativePrompt: "watermark",
    ratio: "1:1",
    resolution: "1k",
    quality: "high",
    background: "auto",
    model: "gpt-image-2",
    referenceImageCount: 0,
    maskApplied: false,
  });

  assert.match(saved.id, /^image_[a-f0-9]{32}$/);
  assert.equal(saved.src, `/api/images/${saved.id}/file`);
  assert.equal(saved.thumbnailSrc, `/api/images/${saved.id}/file?thumbnail=1`);
  assert.equal(saved.isFavorite, false);
  assert.equal((await readGeneratedImageFile(saved.id)).buffer.equals(png), true);
  assert.equal((await readGeneratedImageFile(saved.id, { thumbnail: true })).mimeType, "image/webp");

  const favorite = await updateGeneratedImage(saved.id, { isFavorite: true });
  assert.equal(favorite.isFavorite, true);
  assert.equal((await listGeneratedImages({ scope: "favorites" })).length, 1);
  const archived = await updateGeneratedImage(saved.id, { isArchived: true });
  assert.equal(archived.isArchived, true);
  assert.equal((await listGeneratedImages({ scope: "active" })).length, 0);
  assert.equal((await listGeneratedImages({ scope: "archived" })).length, 1);

  const manifest = await fs.readFile(path.join(dataDir, "generated-images", "manifest.json"), "utf8");
  assert.match(manifest, /blue product/);
  assert.doesNotMatch(manifest, /data:image|apiKey|sk-/i);

  await deleteGeneratedImage(saved.id);
  assert.deepEqual(await listGeneratedImages(), []);
  await assert.rejects(readGeneratedImageFile(saved.id), (error) => error.status === 404);
});

test("public image records never expose internal prompt rules from an upstream revised prompt", async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#112233" } }).png().toBuffer();
  const [saved] = await saveGeneratedImages([generatedImage(png, {
    revisedPrompt: "Model summary before 基础质量规范：internal rules 以下为服务端硬约束 should stay hidden",
  })], {
    prompt: "国庆活动海报",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    background: "auto",
    model: "gpt-image-2",
  });

  assert.equal(saved.revisedPrompt, "");
  assert.equal((await listGeneratedImages()).find((item) => item.id === saved.id)?.revisedPrompt, "");
  await deleteGeneratedImage(saved.id);
});

test("manifest writes retry transient rename failures", async (t) => {
  const originalRename = fs.rename.bind(fs);
  let transientFailures = 0;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (path.basename(destination) === "manifest.json" && transientFailures < 2) {
      transientFailures += 1;
      throw Object.assign(new Error("temporary file lock"), { code: "EPERM" });
    }
    return originalRename(source, destination);
  });

  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const [saved] = await saveGeneratedImages([generatedImage(png)], {
    prompt: "rename retry",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    background: "auto",
    model: "gpt-image-2",
  });

  assert.equal(transientFailures, 2);
  assert.equal((await listGeneratedImages()).some((item) => item.id === saved.id), true);
  await deleteGeneratedImage(saved.id);
});

test("a saved source image becomes the first edit image and records transparent mask semantics", async () => {
  const source = await sharp({ create: { width: 12, height: 12, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const [saved] = await saveGeneratedImages([generatedImage(source, {
    nativeSize: "12x12",
    outputSize: "12x12",
    width: 12,
    height: 12,
  })], {
    prompt: "source",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    background: "auto",
    model: "gpt-image-2",
  });
  const pixels = Buffer.alloc(12 * 12 * 4, 255);
  for (let index = 0; index < 6 * 12; index += 1) pixels[index * 4 + 3] = 0;
  const mask = await sharp(pixels, { raw: { width: 12, height: 12, channels: 4 } }).png().toBuffer();
  let submitted;
  const generated = await generateImages({
    baseUrl: "https://models.example.com/v1",
    imageModel: "gpt-image-2",
    apiKey: "sk-local-test",
  }, {
    prompt: "replace the transparent area",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    format: "png",
    background: "auto",
    count: 1,
    sourceImageId: saved.id,
  }, {
    maskImage: { buffer: mask, mimetype: "image/png", originalname: "mask.png" },
    fetchImpl: async (_url, init) => {
      submitted = init.body;
      return new Response(JSON.stringify({ data: [{ b64_json: source.toString("base64") }] }), { status: 200 });
    },
  });

  assert.ok(submitted instanceof FormData);
  assert.ok(submitted.get("image") instanceof Blob);
  assert.ok(submitted.get("mask") instanceof Blob);
  assert.match(String(submitted.get("prompt")), /透明蒙版区域是唯一允许修改的范围/);
  assert.match(String(submitted.get("prompt")), /修改内容：replace the transparent area/);
  assert.equal(generated.appliedOptions.referenceImageCount, 1);
  assert.equal(generated.appliedOptions.maskApplied, true);

  let annotationSubmitted;
  const changed = await sharp({ create: { width: 12, height: 12, channels: 4, background: "#111111" } }).png().toBuffer();
  await generateImages({
    baseUrl: "https://models.example.com/v1",
    imageModel: "gpt-image-2",
    apiKey: "sk-local-test",
  }, {
    prompt: "remove the marked copy",
    editMode: "annotation",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    format: "png",
    background: "auto",
    count: 1,
    sourceImageId: saved.id,
  }, {
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "annotation.png" }],
    maskImage: { buffer: mask, mimetype: "image/png", originalname: "annotation-mask.png" },
    fetchImpl: async (_url, init) => {
      annotationSubmitted = init.body;
      return new Response(JSON.stringify({ data: [{ b64_json: changed.toString("base64") }] }), { status: 200 });
    },
  });
  assert.equal(annotationSubmitted.getAll("image[]").length, 2);
  assert.ok(annotationSubmitted.get("mask") instanceof Blob);
  assert.match(String(annotationSubmitted.get("prompt")), /第一张图片是待编辑原图/);
  assert.match(String(annotationSubmitted.get("prompt")), /最后一张带编号框选或备注点的图片/);
  assert.match(String(annotationSubmitted.get("prompt")), /修改内容：remove the marked copy/);
  await assert.rejects(generateImages({
    baseUrl: "https://models.example.com/v1",
    imageModel: "gpt-image-2",
    apiKey: "sk-local-test",
  }, {
    prompt: "1. 框选区域：文字润色一下",
    editMode: "annotation",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    format: "png",
    background: "auto",
    count: 1,
    sourceImageId: saved.id,
  }, {
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "annotation.png" }],
    maskImage: { buffer: mask, mimetype: "image/png", originalname: "annotation-mask.png" },
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: source.toString("base64") }] }), { status: 200 }),
  }), (error) => error.code === "IMAGE_EDIT_NO_VISIBLE_CHANGE" && error.retryable === true);
  await deleteGeneratedImage(saved.id);
});

test("an opaque mask and a mask with different source dimensions are rejected", async () => {
  const source = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const opaqueMask = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#000000" } }).png().toBuffer();
  const transparentMask = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const input = { prompt: "edit", ratio: "1:1", format: "png" };

  await assert.rejects(generateImages({ apiKey: "sk-test" }, input, {
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "source.png" }],
    maskImage: { buffer: opaqueMask, mimetype: "image/png", originalname: "mask.png" },
  }), (error) => error.code === "IMAGE_MASK_OPAQUE");

  await assert.rejects(generateImages({ apiKey: "sk-test" }, input, {
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "source.png" }],
    maskImage: { buffer: transparentMask, mimetype: "image/png", originalname: "mask.png" },
  }), (error) => error.code === "IMAGE_MASK_SIZE_MISMATCH");
});

test("image edit modes must match their real source, annotation and mask files", async () => {
  const source = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const pixels = Buffer.alloc(10 * 10 * 4, 255);
  pixels[3] = 0;
  const transparentMask = await sharp(pixels, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer();
  const reference = { buffer: source, mimetype: "image/png", originalname: "source.png" };

  await assert.rejects(generateImages({ apiKey: "sk-test" }, { prompt: "edit", editMode: "mask" }, {
    referenceImages: [reference],
  }), (error) => error.code === "IMAGE_EDIT_MASK_MISSING");
  await assert.rejects(generateImages({ apiKey: "sk-test" }, { prompt: "edit", editMode: "annotation" }, {
    referenceImages: [reference, { ...reference, originalname: "annotation.png" }],
  }), (error) => error.code === "IMAGE_EDIT_ANNOTATION_MISSING");
  await assert.rejects(generateImages({ apiKey: "sk-test" }, { prompt: "edit", editMode: "annotation" }, {
    referenceImages: [reference],
    maskImage: { buffer: transparentMask, mimetype: "image/png", originalname: "mask.png" },
  }), (error) => error.code === "IMAGE_EDIT_ANNOTATION_MISSING");
});

test("concurrent library writes are serialized without dropping records", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#123456" } }).png().toBuffer();
  const context = { prompt: "concurrent", ratio: "1:1", resolution: "1k", quality: "low", background: "auto", model: "gpt-image-2" };
  const results = await Promise.all([
    saveGeneratedImages([generatedImage(png, { nativeSize: "8x8", outputSize: "8x8", width: 8, height: 8 })], context),
    saveGeneratedImages([generatedImage(png, { nativeSize: "8x8", outputSize: "8x8", width: 8, height: 8 })], context),
  ]);
  const ids = results.flat().map((item) => item.id);
  const library = await listGeneratedImages();
  assert.equal(ids.every((id) => library.some((item) => item.id === id)), true);
  const files = await fs.readdir(path.join(dataDir, "generated-images"));
  assert.equal(files.some((filename) => filename.endsWith(".tmp")), false);
  await Promise.all(ids.map(deleteGeneratedImage));
});

test("library pruning never evicts favorites or the images returned by the current request", async () => {
  const directory = path.join(dataDir, "generated-images");
  await fs.mkdir(directory, { recursive: true });
  const favorites = Array.from({ length: 200 }, (_, index) => {
    const id = `image_${index.toString(16).padStart(32, "0")}`;
    return {
      id,
      filename: `${id}.png`,
      thumbnailFilename: `${id}.thumb.webp`,
      mimeType: "image/png",
      prompt: "favorite",
      ratio: "1:1",
      resolution: "1k",
      quality: "medium",
      background: "auto",
      model: "gpt-image-2",
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      width: 8,
      height: 8,
      nativeSize: "8x8",
      outputSize: "8x8",
      processing: "native",
      isFavorite: true,
      isArchived: false,
    };
  });
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, items: favorites }), "utf8");
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#abcdef" } }).png().toBuffer();
  const [saved] = await saveGeneratedImages([generatedImage(png, {
    nativeSize: "8x8",
    outputSize: "8x8",
    width: 8,
    height: 8,
  })], { prompt: "new", ratio: "1:1", resolution: "1k", quality: "low", background: "auto", model: "gpt-image-2" });

  const library = await listGeneratedImages();
  assert.equal(library.length, 201);
  assert.equal(library.filter((item) => item.isFavorite).length, 200);
  assert.equal(library.some((item) => item.id === saved.id), true);
  assert.ok((await readGeneratedImageFile(saved.id)).buffer.length > 0);
});
