import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_CHANNELS,
  normalizeModelBaseUrl,
  publicModelConfig,
  recordModelTestResult,
  resolveModelConfig,
  testImageModel,
  updateModelConfig,
} from "./modelConfigService.js";

const env = { MODEL_CONFIG_ENCRYPTION_KEY: "model-config-tests" };

test("model base URLs require HTTPS except for loopback development servers", () => {
  assert.equal(normalizeModelBaseUrl("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(normalizeModelBaseUrl("https://example.com/v1/images/generations"), "https://example.com/v1");
  assert.equal(normalizeModelBaseUrl("https://example.com/v1/responses"), "https://example.com/v1");
  assert.equal(normalizeModelBaseUrl("http://localhost:4317/v1/"), "http://localhost:4317/v1");
  assert.equal(normalizeModelBaseUrl("http://127.0.0.1:4317/v1"), "http://127.0.0.1:4317/v1");
  assert.equal(normalizeModelBaseUrl("http://[::1]:4317/v1"), "http://[::1]:4317/v1");
  for (const unsafe of [
    "http://example.com/v1",
    "ftp://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://example.com/v1#fragment",
  ]) assert.throws(() => normalizeModelBaseUrl(unsafe));
});

test("saved model keys are encrypted, blank values preserve them, and explicit clear removes them", () => {
  const saved = updateModelConfig({}, {
    baseUrl: "https://models.example.com/v1/",
    model: "analysis-model",
    imageModel: "image-model",
    apiKey: "sk-private-value-1234",
  }, { env });
  assert.equal("apiKey" in saved, false);
  assert.equal(saved.channel, "custom");
  assert.equal(saved.channelStates.custom.apiKeyEncrypted.includes("sk-private-value-1234"), false);
  assert.equal(resolveModelConfig(saved, { env }).apiKey, "sk-private-value-1234");

  const preserved = updateModelConfig(saved, { apiKey: "" }, { env });
  assert.equal(resolveModelConfig(preserved, { env }).apiKey, "sk-private-value-1234");
  const cleared = updateModelConfig(preserved, { clearApiKey: true }, { env });
  assert.equal(resolveModelConfig(cleared, { env }).apiKey, "");
  assert.throws(() => updateModelConfig(saved, { apiKey: "new", clearApiKey: true }, { env }));
});

test("public model config masks secrets and reports saved or environment sources", () => {
  const saved = updateModelConfig({}, { apiKey: "sk-saved-private-1234", imageModel: "gpt-image-2" }, { env });
  const publicSaved = publicModelConfig(saved, { env: { ...env, OPENAI_API_KEY: "sk-environment-private" } });
  assert.equal(publicSaved.apiKeySource, "saved");
  assert.equal(publicSaved.hasApiKey, true);
  assert.equal(publicSaved.apiKeyMasked, "sk-sav...1234");
  assert.equal(JSON.stringify(publicSaved).includes("sk-saved-private-1234"), false);
  assert.equal("apiKey" in publicSaved, false);

  const publicEnvironment = publicModelConfig({}, { env: { ...env, MODEL_STABLE_API_KEY: "sk-environment-private" } });
  assert.equal(publicEnvironment.apiKeySource, "environment");
  assert.equal(publicEnvironment.hasApiKey, true);
});

test("legacy plaintext keys are encrypted on the next update", () => {
  const migrated = updateModelConfig({ baseUrl: MODEL_CHANNELS.stable.baseUrl, apiKey: "legacy-secret", model: "old-model" }, {}, { env });
  assert.equal("apiKey" in migrated, false);
  assert.equal(resolveModelConfig(migrated, { env }).apiKey, "legacy-secret");
});

test("stable, fast, and custom channels keep independent keys and endpoints", () => {
  let config = updateModelConfig({}, { channel: "stable", apiKey: "sk-stable" }, { env });
  config = updateModelConfig(config, { channel: "fast", apiKey: "sk-fast" }, { env });
  config = updateModelConfig(config, {
    channel: "custom",
    customBaseUrl: "https://custom.example.com/v1/",
    apiKey: "sk-custom",
  }, { env });

  assert.deepEqual(
    ["stable", "fast", "custom"].map((channel) => {
      const resolved = resolveModelConfig(config, { env, channel });
      return [channel, resolved.baseUrl, resolved.apiKey];
    }),
    [
      ["stable", MODEL_CHANNELS.stable.baseUrl, "sk-stable"],
      ["fast", MODEL_CHANNELS.fast.baseUrl, "sk-fast"],
      ["custom", "https://custom.example.com/v1", "sk-custom"],
    ],
  );

  const publicConfig = publicModelConfig(config, { env });
  assert.equal(publicConfig.channel, "custom");
  assert.equal(publicConfig.customBaseUrl, "https://custom.example.com/v1");
  assert.equal(publicConfig.channelStates.stable.apiKeyMasked, "sk***");
  assert.equal(publicConfig.channelStates.fast.apiKeyMasked, "sk***");
  assert.equal(publicConfig.channelStates.custom.apiKeyMasked, "sk***");
  assert.equal("baseUrl" in publicConfig, false);
  assert.equal(JSON.stringify(publicConfig).includes("cn.pptoken.cc"), false);
  assert.equal(JSON.stringify(publicConfig).includes("jvsppl.vip"), false);

  const fastCleared = updateModelConfig(config, { channel: "fast", clearApiKey: true }, { env });
  assert.equal(resolveModelConfig(fastCleared, { env, channel: "fast" }).apiKey, "");
  assert.equal(resolveModelConfig(fastCleared, { env, channel: "stable" }).apiKey, "sk-stable");
  assert.equal(resolveModelConfig(fastCleared, { env, channel: "custom" }).apiKey, "sk-custom");
});

test("legacy baseUrl patches become custom while environment keys never cross channels", () => {
  assert.throws(() => updateModelConfig({}, { channel: "custom" }, { env }), /缺少 API 地址/);
  assert.throws(() => updateModelConfig({}, { channel: "custom" }, { env: { ...env, OPENAI_BASE_URL: "not-a-url" } }), /API 地址无效/);
  const legacyPatch = updateModelConfig({}, {
    baseUrl: "https://legacy.example.com/v1/images/generations",
    apiKey: "sk-legacy-custom",
  }, { env });
  assert.equal(legacyPatch.channel, "custom");
  assert.equal(legacyPatch.customBaseUrl, "https://legacy.example.com/v1");
  assert.equal(resolveModelConfig(legacyPatch, { env }).apiKey, "sk-legacy-custom");
  assert.throws(() => updateModelConfig({}, { channel: "stable", customBaseUrl: "https://wrong.example.com/v1" }, { env }));

  const environment = {
    ...env,
    MODEL_STABLE_API_KEY: "sk-env-stable",
    MODEL_FAST_API_KEY: "sk-env-fast",
    OPENAI_API_KEY: "sk-env-custom",
    OPENAI_BASE_URL: "https://openai-compatible.example.com/v1",
  };
  assert.equal(resolveModelConfig({}, { env: environment, channel: "stable" }).apiKey, "sk-env-stable");
  assert.equal(resolveModelConfig({}, { env: environment, channel: "fast" }).apiKey, "sk-env-fast");
  const custom = resolveModelConfig({ channel: "custom" }, { env: environment });
  assert.equal(custom.apiKey, "sk-env-custom");
  assert.equal(custom.baseUrl, "https://openai-compatible.example.com/v1");
  assert.equal(resolveModelConfig({}, { env: { ...env, OPENAI_API_KEY: "must-not-cross" }, channel: "stable" }).apiKey, "");
  assert.equal(resolveModelConfig({}, { env: { ...env, OPENAI_API_KEY: "must-not-cross" }, channel: "fast" }).apiKey, "");
});

test("test status belongs to its channel and shared model changes invalidate every channel", () => {
  let config = updateModelConfig({}, { channel: "stable", apiKey: "stable" }, { env });
  config = updateModelConfig(config, { channel: "fast", apiKey: "fast" }, { env });
  config = recordModelTestResult(config, { channel: "stable", status: "success", testedAt: "2026-07-16T00:00:00.000Z" }, { env });
  config = recordModelTestResult(config, { channel: "fast", status: "failed", testedAt: "2026-07-16T01:00:00.000Z" }, { env });
  config = updateModelConfig(config, { channel: "stable", apiKey: "stable-new" }, { env });
  assert.equal(config.channelStates.stable.lastTestStatus, null);
  assert.equal(config.channelStates.fast.lastTestStatus, "failed");

  config = updateModelConfig(config, { imageModel: "new-image-model" }, { env });
  assert.equal(config.channelStates.stable.lastTestStatus, null);
  assert.equal(config.channelStates.fast.lastTestStatus, null);
  assert.equal(config.channelStates.custom.lastTestStatus, null);
});

test("model test uses the image model endpoint without exposing its key", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, {
    imageModel: "vendor/image-model",
    apiKey: "sk-test-model-secret",
  }, { env });
  let request;
  const result = await testImageModel(config, {
    env,
    now: () => "2026-07-16T00:00:00.000Z",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ id: "vendor/image-model" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(request.url, "https://models.example.com/v1/models/vendor%2Fimage-model");
  assert.equal(request.init.headers.authorization, "Bearer sk-test-model-secret");
  assert.deepEqual(result, {
    ok: true,
    status: "success",
    testedAt: "2026-07-16T00:00:00.000Z",
    model: "vendor/image-model",
    message: "图片模型基础连接成功（未执行生图）。",
  });
});

test("model test falls back to the model list when a compatible gateway has no detail endpoint", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, {
    imageModel: "gpt-image-2",
    apiKey: "sk-list-fallback-secret",
  }, { env });
  const requests = [];
  const result = await testImageModel(config, {
    env,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/models/gpt-image-2")) return new Response("404 page not found", { status: 404 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200 });
    },
  });
  assert.deepEqual(requests, [
    "https://models.example.com/v1/models/gpt-image-2",
    "https://models.example.com/v1/models",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.message, "图片模型基础连接成功（未执行生图）。");
});

test("model test does not claim success when the detail endpoint returns another model", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, {
    imageModel: "gpt-image-2",
    apiKey: "sk-wrong-detail-model",
  }, { env });
  const result = await testImageModel(config, {
    env,
    fetchImpl: async () => new Response(JSON.stringify({ id: "another-image-model" }), { status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unverified");
  assert.match(result.message, /未确认 gpt-image-2/);
});

test("model test does not claim success when the model list omits the configured model", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, {
    imageModel: "gpt-image-2",
    apiKey: "sk-list-missing-model",
  }, { env });
  const result = await testImageModel(config, {
    env,
    fetchImpl: async (url) => url.endsWith("/models/gpt-image-2")
      ? new Response("404 page not found", { status: 404 })
      : new Response(JSON.stringify({ data: [{ id: "another-image-model" }] }), { status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unverified");
  assert.match(result.message, /未找到 gpt-image-2/);
});

test("model test explains gateways that expose no free model lookup without marking failure", async () => {
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: "sk-no-models" }, { env });
  const result = await testImageModel(config, { env, fetchImpl: async () => new Response("404 page not found", { status: 404 }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unverified");
  assert.match(result.message, /不代表生图不可用/);
});

test("upstream and network errors redact model secrets", async () => {
  const secret = "sk-never-leak-this";
  const config = updateModelConfig({ baseUrl: "https://models.example.com/v1" }, { apiKey: secret }, { env });
  await assert.rejects(
    testImageModel(config, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: `invalid ${secret}` } }), { status: 401 }),
    }),
    (error) => error.status === 401 && !error.message.includes(secret) && error.message.includes("[已隐藏]"),
  );
  await assert.rejects(
    testImageModel(config, { env, fetchImpl: async () => { throw new Error(`network ${secret}`); } }),
    (error) => !error.message.includes(secret) && error.code === "MODEL_API_NETWORK_ERROR",
  );
});

test("recorded model test state is public without exposing storage fields", () => {
  const recorded = recordModelTestResult({}, { ok: false, testedAt: "2026-07-16T01:00:00.000Z" }, { env });
  const view = publicModelConfig(recorded, { env });
  assert.equal(view.lastTestedAt, "2026-07-16T01:00:00.000Z");
  assert.equal(view.lastTestStatus, "failed");

  const unverified = recordModelTestResult(recorded, { status: "unverified" }, { env });
  assert.equal(publicModelConfig(unverified, { env }).lastTestStatus, "unverified");
});
