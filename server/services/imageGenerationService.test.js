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
  assert.equal(mergeImagePrompt(" product ", " watermark "), "product\n\nAvoid the following: watermark");
  assert.deepEqual(targetImageSize("16:9", "4k"), { width: 4096, height: 2304 });
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
    prompt: "studio product photo\n\nAvoid the following: text",
    size: "1024x1536",
    quality: "high",
    output_format: "webp",
    background: "transparent",
    n: 4,
    output_compression: 82,
  });
  assert.equal("output_compression" in buildImageGenerationRequest({ prompt: "x", format: "png", compression: 20 }), false);
});

test("image edits prepend hidden scope rules while keeping the user instruction concise", () => {
  const maskPrompt = mergeImageEditPrompt("改成白色陶瓷材质", "mask");
  assert.match(maskPrompt, /只修改透明蒙版覆盖的区域/);
  assert.match(maskPrompt, /严格保持蒙版外/);
  assert.match(maskPrompt, /修改内容：改成白色陶瓷材质$/);

  const annotationRequest = buildImageGenerationRequest({
    prompt: "删除红圈里的文字",
    editMode: "annotation",
    negativePrompt: "水印",
  });
  assert.match(annotationRequest.prompt, /最后一张带编号框选或备注点的图片只用于指示修改位置/);
  assert.match(annotationRequest.prompt, /标注编号与修改内容中的编号一一对应/);
  assert.match(annotationRequest.prompt, /框线、编号和备注点不得出现在最终图片中/);
  assert.match(annotationRequest.prompt, /修改内容：删除红圈里的文字/);
  assert.match(annotationRequest.prompt, /Avoid the following: 水印$/);
  assert.throws(() => mergeImageEditPrompt("修改", "unknown"));
});

test("invalid image parameters are rejected before calling a model", () => {
  for (const input of [
    { prompt: "" },
    { prompt: "x", ratio: "2:3" },
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
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.fast.baseUrl}/images/edits`);
  assert.equal(request.init.headers["content-type"], undefined);
  assert.ok(request.init.body instanceof FormData);
  assert.ok(request.init.body.get("image") instanceof Blob);
  assert.equal(request.init.body.get("prompt"), "change the package color");
  assert.equal(result.appliedOptions.mode, "edit");
  assert.equal(result.appliedOptions.referenceImageCount, 1);
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
