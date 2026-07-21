import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  buildImageGenerationRequest,
  generateImages,
  imageEditEndpoint,
  imageGenerationEndpoint,
  mergeImageEditPrompt,
  mergeImagePrompt,
  parseImageGenerationResponse,
  resolveTargetImageSize,
  targetImageSize,
} from "./imageGenerationService.js";
import { MODEL_CHANNELS, updateModelConfig } from "./modelConfigService.js";

const env = { MODEL_CONFIG_ENCRYPTION_KEY: "image-generation-tests" };

function pendingFetchUntilAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(watchdog);
      reject(signal.reason);
    };
    const watchdog = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Expected the request timeout to abort the fetch mock."));
    }, 1_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

test("image requests map UI ratios to supported GPT image sizes", () => {
  const expected = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
  };
  for (const [ratio, size] of Object.entries(expected)) {
    assert.equal(buildImageGenerationRequest({ prompt: "product", ratio }, "gpt-image-2").size, size);
  }
  const merged = mergeImagePrompt(" product ", " watermark ");
  assert.equal(merged, "product\n\n负面要求：watermark");
  assert.deepEqual(targetImageSize("16:9", "4k"), { width: 4096, height: 2304 });
  assert.deepEqual(targetImageSize("4:5", "1k"), { width: 819, height: 1024 });
  assert.deepEqual(targetImageSize("9:16", "2k"), { width: 1152, height: 2048 });
  assert.deepEqual(resolveTargetImageSize({ ratio: "custom", customWidth: 1200, customHeight: 1600 }), { width: 1200, height: 1600 });
});

test("masked edits reject candidates that alter protected pixels and rank valid candidates", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#336699" } }).png().toBuffer();
  const maskPixels = Buffer.alloc(64 * 64 * 4, 255);
  const goodPixels = Buffer.alloc(64 * 64 * 4);
  for (let row = 0; row < 64; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      const offset = (row * 64 + column) * 4;
      if (column < 32) maskPixels[offset + 3] = 0;
      const color = column < 32 ? [244, 240, 232] : [51, 102, 153];
      goodPixels[offset] = color[0];
      goodPixels[offset + 1] = color[1];
      goodPixels[offset + 2] = color[2];
      goodPixels[offset + 3] = 255;
    }
  }
  const mask = await sharp(maskPixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
  const good = await sharp(goodPixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
  const bad = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#f4f0e8" } }).png().toBuffer();
  const result = await generateImages(config, {
    prompt: "只修改左半边",
    ratio: "1:1",
    resolution: "1k",
    format: "png",
    count: 2,
    editMode: "mask",
    editIntent: "local",
  }, {
    env,
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "source.png" }],
    maskImage: { buffer: mask, mimetype: "image/png", originalname: "mask.png" },
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { b64_json: bad.toString("base64") },
      { b64_json: good.toString("base64") },
    ] }), { status: 200 }),
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].validation.passed, true);
  assert.ok(result.images[0].validation.score >= 70);
  assert.equal(result.appliedOptions.candidateRankingApplied, true);
});

test("outpainting prepares a protected canvas and fills expansion without cropping the source", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#336699" } }).png().toBuffer();
  let maskSeen = false;
  const result = await generateImages(config, {
    prompt: "向上下扩展画面",
    ratio: "2:3",
    resolution: "1k",
    format: "png",
    count: 1,
    editIntent: "outpaint",
    compositionMode: "keep",
  }, {
    env,
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "source.png" }],
    fetchImpl: async (_url, init) => {
      maskSeen = init.body.get("mask") instanceof Blob;
      const prepared = Buffer.from(await init.body.get("image").arrayBuffer());
      const filled = await sharp(prepared).flatten({ background: "#f4f0e8" }).png().toBuffer();
      return new Response(JSON.stringify({ data: [{ b64_json: filled.toString("base64") }] }), { status: 200 });
    },
  });
  assert.equal(maskSeen, true);
  assert.equal(result.appliedOptions.outpaintPrepared, true);
  assert.equal(result.images[0].processing, "fitted");
  assert.equal(result.images[0].outputSize, "683x1024");
});

test("background replacement protects an automatically detected product before model editing", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ffffff" } })
    .composite([{ input: await sharp({ create: { width: 32, height: 32, channels: 4, background: "#336699" } }).png().toBuffer(), left: 16, top: 16 }])
    .png()
    .toBuffer();
  const output = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#78a55a" } })
    .composite([{ input: await sharp({ create: { width: 32, height: 32, channels: 4, background: "#336699" } }).png().toBuffer(), left: 16, top: 16 }])
    .png()
    .toBuffer();
  let maskSeen = false;
  const result = await generateImages(config, {
    prompt: "背景改成绿色",
    ratio: "1:1",
    resolution: "1k",
    format: "png",
    count: 1,
    editIntent: "background",
    compositionMode: "keep",
  }, {
    env,
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "product.png" }],
    fetchImpl: async (_url, init) => {
      maskSeen = init.body.get("mask") instanceof Blob;
      return new Response(JSON.stringify({ data: [{ b64_json: output.toString("base64") }] }), { status: 200 });
    },
  });
  assert.equal(maskSeen, true);
  assert.ok(result.appliedOptions.productMaskConfidence >= 0.9);
  assert.equal(result.images[0].validation.passed, true);
});

test("application copy layer uses a real font render after generating a text-free base", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const source = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#336699" } }).png().toBuffer();
  let modelPrompt = "";
  const result = await generateImages(config, {
    prompt: "红色节日海报底图",
    ratio: "1:1",
    resolution: "1k",
    format: "png",
    count: 1,
    copyText: "新春焕新季\n新年好物",
    copyPosition: "top",
    copyStyle: "light",
    copyScale: "large",
  }, {
    env,
    fetchImpl: async (_url, init) => {
      modelPrompt = JSON.parse(init.body).prompt;
      return new Response(JSON.stringify({ data: [{ b64_json: source.toString("base64") }] }), { status: 200 });
    },
  });
  assert.match(modelPrompt, /只生成无文字底图/);
  assert.deepEqual(result.images[0].copy, { text: "新春焕新季\n新年好物", position: "top", style: "light", scale: "large" });
  assert.deepEqual(await sharp(result.images[0].buffer).metadata().then(({ width, height }) => ({ width, height })), { width: 1024, height: 1024 });
});

test("image request supports quality, format, background, compression and count", () => {
  assert.deepEqual(buildImageGenerationRequest({
    prompt: "studio product photo",
    negativePrompt: "text",
    ratio: "3:4",
    quality: "high",
    format: "webp",
    background: "transparent",
    compression: 82,
    count: 4,
  }, "gpt-image-2"), {
    model: "gpt-image-2",
    prompt: mergeImagePrompt("studio product photo", "text"),
    size: "1024x1536",
    quality: "high",
    output_format: "webp",
    background: "transparent",
    n: 4,
    output_compression: 82,
  });
  assert.equal("output_compression" in buildImageGenerationRequest({ prompt: "x", format: "png", compression: 20 }), false);
});

test("image edits send only the user's instruction without hidden prompt templates", () => {
  const maskPrompt = mergeImageEditPrompt("改成白色陶瓷材质", "mask");
  assert.equal(maskPrompt, "改成白色陶瓷材质");

  const annotationRequest = buildImageGenerationRequest({
    prompt: "删除红圈里的文字",
    editMode: "annotation",
    negativePrompt: "水印",
  });
  assert.equal(annotationRequest.prompt, "删除红圈里的文字\n\n负面要求：水印");
  const rewritePrompt = mergeImageEditPrompt("1. 框选区域：文字润色一下", "annotation");
  assert.equal(rewritePrompt, "1. 框选区域：文字润色一下");
  assert.throws(() => mergeImageEditPrompt("修改", "unknown"));
});

test("plain generation preserves the user's full prompt without adding rules", () => {
  for (const userPrompt of [
    "包装正面准确写出：智能压力锅 Pro",
    "为新品做一张国庆活动海报，创意完全自由",
    "制作国庆海报无字底图，预留后期排版区域",
  ]) {
    const prompt = mergeImagePrompt(userPrompt);
    assert.equal(prompt, userPrompt);
  }
});

test("all generation modes pass through only the visible user prompt", () => {
  const requests = [
    buildImageGenerationRequest({ prompt: "生成白底商品主图" }),
    buildImageGenerationRequest({
      prompt: "只调整背景光线",
      sourceImageId: "image_0123456789abcdef0123456789abcdef",
    }),
    buildImageGenerationRequest({
      prompt: "1. 框选区域：改成白色",
      sourceImageId: "image_0123456789abcdef0123456789abcdef",
      editMode: "annotation",
    }),
  ];
  assert.deepEqual(requests.map((request) => request.prompt), ["生成白底商品主图", "只调整背景光线", "1. 框选区域：改成白色"]);
});

test("explicit copy edits are not rewritten by the server", () => {
  const requestedCopy = "把包装正面的“旧款”替换为“新款 Pro 2.0”，其他文字不变";
  const prompt = buildImageGenerationRequest({
    prompt: requestedCopy,
    sourceImageId: "image_0123456789abcdef0123456789abcdef",
  }).prompt;
  assert.equal(prompt, requestedCopy);
});

test("user exclusions pass through without server-authored creative policy", () => {
  const prompt = buildImageGenerationRequest({
    prompt: "包装正面新增准确文字“新品上市”",
    negativePrompt: "文字、水印",
  }).prompt;
  assert.equal(prompt, "包装正面新增准确文字“新品上市”\n\n负面要求：文字、水印");
  assert.doesNotMatch(prompt, /正向要求优先|固定模板|后台规则/);
});

test("a saved source image does not mutate or wrap the history prompt", () => {
  const input = {
    prompt: "只把厨房背景改得干净整洁，增强产品光线",
    sourceImageId: "image_0123456789abcdef0123456789abcdef",
    ratio: "16:9",
  };
  const originalInput = structuredClone(input);
  const request = buildImageGenerationRequest(input);
  assert.equal(request.prompt, mergeImagePrompt(input.prompt, "", "source"));
  assert.equal(request.prompt, input.prompt);
  assert.deepEqual(input, originalInput);
  assert.equal(input.prompt, "只把厨房背景改得干净整洁，增强产品光线");
});

test("invalid image parameters are rejected before calling a model", () => {
  for (const input of [
    { prompt: "" },
    { prompt: "x", ratio: "custom" },
    { prompt: "x", ratio: "custom", customWidth: 511, customHeight: 1024 },
    { prompt: "x", quality: "ultra" },
    { prompt: "x", format: "gif" },
    { prompt: "x", background: "red" },
    { prompt: "x", count: 0 },
    { prompt: "x", count: 5 },
    { prompt: "x", compression: 101 },
    { prompt: "x", format: "jpeg", background: "transparent" },
  ]) assert.throws(() => buildImageGenerationRequest(input));
});

test("generation endpoint does not duplicate an existing images path", () => {
  assert.equal(imageGenerationEndpoint("https://example.com/v1/"), "https://example.com/v1/images/generations");
  assert.equal(imageGenerationEndpoint("https://example.com/v1/images/generations"), "https://example.com/v1/images/generations");
  assert.equal(imageEditEndpoint("https://example.com/v1/images/generations"), "https://example.com/v1/images/edits");
});

test("image response accepts base64, data URIs, URLs, and revised prompts", () => {
  const raw = Buffer.from("fake png").toString("base64");
  const images = parseImageGenerationResponse({ data: [
    { b64_json: raw, revised_prompt: "revised" },
    { b64_json: `data:image/webp;base64,${raw}` },
    { url: "https://cdn.example.com/generated.png?signature=1" },
    { url: "file:///private/image.png" },
  ] }, { format: "png" });
  assert.equal(images.length, 3);
  assert.equal(images[0].src, `data:image/png;base64,${raw}`);
  assert.equal(images[0].revisedPrompt, "revised");
  assert.equal(images[1].mimeType, "image/webp");
  assert.equal(images[2].source, "url");
});

test("empty or malformed image responses fail explicitly", () => {
  assert.throws(() => parseImageGenerationResponse({}), (error) => error.code === "IMAGE_RESPONSE_INVALID");
  assert.throws(() => parseImageGenerationResponse({ data: [] }), (error) => error.code === "IMAGE_RESPONSE_EMPTY");
  assert.throws(() => parseImageGenerationResponse({ data: [{ b64_json: "not base64!" }, { url: "javascript:alert(1)" }] }), (error) => error.code === "IMAGE_RESPONSE_EMPTY");
});

test("generateImages sends a Bearer request and reports the actual result count", async () => {
  const config = updateModelConfig({}, {
    channel: "stable",
    apiKey: "sk-image-private",
    imageModel: "gpt-image-2",
  }, { env });
  const raw = (await sharp({ create: { width: 16, height: 16, channels: 4, background: "#336699" } }).png().toBuffer()).toString("base64");
  let request;
  const result = await generateImages(config, {
    prompt: "clean product photo",
    ratio: "16:9",
    quality: "low",
    format: "jpeg",
    background: "opaque",
    compression: 75,
    count: 4,
  }, {
    env,
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ created: 123, data: [{ b64_json: raw }] }), { status: 200 });
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.stable.baseUrl}/images/generations`);
  assert.equal(request.init.headers.authorization, "Bearer sk-image-private");
  assert.equal(request.body.size, "1536x1024");
  assert.equal(request.body.output_compression, 75);
  assert.equal(result.requestedCount, 4);
  assert.equal(result.generatedCount, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.size, "1024x576");
  assert.equal(result.images[0].outputSize, "1024x576");
  assert.equal(result.images[0].processing, "upscaled");
});

test("reference images use the compatible multipart edits endpoint", async () => {
  const config = updateModelConfig({}, {
    channel: "fast",
    apiKey: "sk-image-private",
    imageModel: "gpt-image-2",
  }, { env });
  const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const editedPng = await sharp({ create: { width: 24, height: 24, channels: 4, background: "#3366ff" } }).png().toBuffer();
  let request;
  const result = await generateImages(config, {
    prompt: "change the package color",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    format: "png",
    background: "auto",
    count: 1,
  }, {
    env,
    referenceImages: [{ buffer: png, mimetype: "image/png", originalname: "source.png" }],
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: [{ b64_json: editedPng.toString("base64") }] }), { status: 200 });
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.fast.baseUrl}/images/edits`);
  assert.equal(request.init.headers["content-type"], undefined);
  assert.ok(request.init.body instanceof FormData);
  assert.ok(request.init.body.get("image") instanceof Blob);
  assert.equal(request.init.body.get("prompt"), mergeImagePrompt("change the package color", "", "reference"));
  assert.doesNotMatch(request.init.body.get("prompt"), /第一张图片是待编辑原图/);
  assert.equal(result.appliedOptions.mode, "edit");
  assert.equal(result.appliedOptions.referenceImageCount, 1);
});

test("reference edits reject an unchanged image instead of reporting false success", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const png = await sharp({ create: { width: 64, height: 96, channels: 4, background: "#ffffff" } }).png().toBuffer();
  await assert.rejects(
    generateImages(config, {
      prompt: "明显改变画面",
      ratio: "3:4",
      resolution: "1k",
      format: "png",
    }, {
      env,
      referenceImages: [{ buffer: png, mimetype: "image/png", originalname: "source.png" }],
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 }),
    }),
    (error) => error.status === 422 && error.code === "IMAGE_EDIT_NO_VISIBLE_CHANGE",
  );
});

test("reference edits always save the exact selected 3:4 canvas size", async () => {
  const config = updateModelConfig({}, { channel: "fast", apiKey: "sk-image-private", imageModel: "gpt-image-2" }, { env });
  const source = await sharp({ create: { width: 60, height: 90, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const edited = await sharp({ create: { width: 60, height: 90, channels: 4, background: "#2457d6" } }).png().toBuffer();
  const result = await generateImages(config, {
    prompt: "重新设计画面",
    ratio: "3:4",
    resolution: "2k",
    format: "png",
  }, {
    env,
    referenceImages: [{ buffer: source, mimetype: "image/png", originalname: "source.png" }],
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: edited.toString("base64") }] }), { status: 200 }),
  });
  const metadata = await sharp(result.images[0].buffer).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 1536, height: 2048 });
  assert.equal(result.images[0].outputSize, "1536x2048");
  assert.equal(result.appliedOptions.ratio, "3:4");
});

test("an edit endpoint missing on a compatible gateway returns a clear error", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: "sk-image-private" }, { env });
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ffffff" } }).png().toBuffer();
  await assert.rejects(
    generateImages(config, { prompt: "edit", ratio: "1:1", format: "png" }, {
      env,
      referenceImages: [{ buffer: png, mimetype: "image/png", originalname: "source.png" }],
      fetchImpl: async () => new Response("not found", { status: 404 }),
    }),
    (error) => error.status === 422 && error.code === "IMAGE_EDIT_UNSUPPORTED",
  );
});

test("remote results pointing at local or private addresses are rejected before download", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: "sk-image-private" }, { env });
  let calls = 0;
  await assert.rejects(
    generateImages(config, { prompt: "product", ratio: "1:1", format: "png" }, {
      env,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ url: "http://169.254.169.254/latest/meta-data" }] }), { status: 200 });
      },
    }),
    (error) => error.code === "IMAGE_REMOTE_RESULT_BLOCKED",
  );
  assert.equal(calls, 1);
});

test("remote image downloads have an independent timeout after the model response", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: "sk-image-private" }, { env });
  let calls = 0;
  await assert.rejects(
    generateImages(config, { prompt: "product", ratio: "1:1", format: "png" }, {
      env,
      remoteImageTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ data: [{ url: "https://1.1.1.1/generated.png" }] }), { status: 200 });
        return pendingFetchUntilAbort(signal);
      },
    }),
    (error) => error.status === 504 && error.code === "IMAGE_REMOTE_RESULT_TIMEOUT",
  );
  assert.equal(calls, 2);
});

test("generation errors and timeouts never leak the API key", async () => {
  const secret = "sk-image-never-leak";
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: secret }, { env });
  await assert.rejects(
    generateImages(config, { prompt: "product" }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: `bad ${secret}` } }), { status: 429 }),
    }),
    (error) => error.status === 429 && !error.message.includes(secret),
  );

  await assert.rejects(
    generateImages(config, { prompt: "product" }, {
      env,
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => pendingFetchUntilAbort(signal),
    }),
    (error) => error.code === "MODEL_API_TIMEOUT" && !error.message.includes(secret),
  );

  await assert.rejects(
    generateImages(config, { prompt: "product" }, {
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          throw error;
        },
      }),
    }),
    (error) => error.code === "MODEL_API_TIMEOUT" && /AI 生图等待超过 10 分钟/.test(error.message) && !error.message.includes(secret),
  );
});
