import { decryptSecret, encryptSecret, maskSecret } from "./secretService.js";

export const MODEL_CHANNELS = Object.freeze({
  stable: Object.freeze({ baseUrl: "https://cn.pptoken.cc/v1" }),
  fast: Object.freeze({ baseUrl: "https://jvsppl.vip/v1" }),
  custom: Object.freeze({ baseUrl: null }),
});
export const MODEL_CHANNEL_IDS = Object.freeze(Object.keys(MODEL_CHANNELS));
export const DEFAULT_MODEL_CHANNEL = "stable";
export const DEFAULT_MODEL_BASE_URL = MODEL_CHANNELS[DEFAULT_MODEL_CHANNEL].baseUrl;
export const DEFAULT_ANALYSIS_MODEL = "gpt-4.1-mini";
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizeModelName(value, fallback) {
  const model = String(value || fallback || "").trim();
  const hasControlCharacter = Array.from(model, (character) => character.charCodeAt(0)).some((code) => code <= 31 || code === 127);
  if (!model || model.length > 200 || hasControlCharacter) {
    throw new Error("模型名称无效。");
  }
  return model;
}

function storedModelName(value, fallback) {
  try {
    return normalizeModelName(value, fallback);
  } catch {
    return fallback;
  }
}

function storedModelChannel(value, fallback = DEFAULT_MODEL_CHANNEL) {
  return MODEL_CHANNEL_IDS.includes(value) ? value : fallback;
}

function normalizeModelChannel(value, fallback = DEFAULT_MODEL_CHANNEL) {
  const channel = String(value || fallback).trim();
  if (!MODEL_CHANNEL_IDS.includes(channel)) throw new Error("模型通道无效。");
  return channel;
}

function testStatus(value) {
  return ["success", "unverified", "failed"].includes(value) ? value : null;
}

function storedChannelState(state = {}, { env = process.env } = {}) {
  let apiKeyEncrypted = String(state?.apiKeyEncrypted || "");
  if (!apiKeyEncrypted && state?.apiKey) apiKeyEncrypted = encryptSecret(String(state.apiKey).trim(), { env });
  return {
    apiKeyEncrypted,
    lastTestedAt: typeof state?.lastTestedAt === "string" ? state.lastTestedAt : null,
    lastTestStatus: testStatus(state?.lastTestStatus),
  };
}

export function normalizeModelBaseUrl(value = DEFAULT_MODEL_BASE_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_MODEL_BASE_URL).trim());
  } catch {
    throw new Error("模型 API 地址无效。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("模型 API 地址不能包含账号、密码、查询参数或锚点。");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname.toLowerCase()))) {
    throw new Error("模型 API 地址必须使用 HTTPS；仅本机服务可使用 HTTP。");
  }
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:images\/(?:generations|edits)|responses)$/i, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function channelForLegacyBaseUrl(value) {
  if (!String(value || "").trim()) return null;
  try {
    const normalized = normalizeModelBaseUrl(value);
    return MODEL_CHANNEL_IDS.find((channel) => MODEL_CHANNELS[channel].baseUrl === normalized) || "custom";
  } catch {
    return null;
  }
}

function storedCustomBaseUrl(value) {
  if (!String(value || "").trim()) return "";
  try {
    return normalizeModelBaseUrl(value);
  } catch {
    return "";
  }
}

function encryptedLegacyKey(config, options) {
  if (config?.apiKeyEncrypted) return String(config.apiKeyEncrypted);
  const plaintext = String(config?.apiKey || "").trim();
  return plaintext ? encryptSecret(plaintext, options) : "";
}

function storedLegacyConfig(config = {}, options = {}) {
  const source = config?.legacyConfig || {};
  const baseUrl = String(source.baseUrl || "").trim().slice(0, 500);
  const apiKeyEncrypted = encryptedLegacyKey(source, options);
  if (!baseUrl && !apiKeyEncrypted) return null;
  return {
    baseUrl,
    apiKeyEncrypted,
    lastTestedAt: typeof source.lastTestedAt === "string" ? source.lastTestedAt : null,
    lastTestStatus: testStatus(source.lastTestStatus),
  };
}

export function secureStoredModelConfig(config = {}, { env = process.env } = {}) {
  const legacyChannel = channelForLegacyBaseUrl(config.baseUrl);
  const legacyKey = encryptedLegacyKey(config, { env });
  const customBaseUrl = storedCustomBaseUrl(config.customBaseUrl)
    || (legacyChannel === "custom" ? storedCustomBaseUrl(config.baseUrl) : "");
  const channelStates = Object.fromEntries(MODEL_CHANNEL_IDS.map((channel) => [
    channel,
    storedChannelState(config?.channelStates?.[channel], { env }),
  ]));
  if (legacyChannel && legacyKey && !channelStates[legacyChannel].apiKeyEncrypted) {
    channelStates[legacyChannel].apiKeyEncrypted = legacyKey;
    channelStates[legacyChannel].lastTestedAt = typeof config.lastTestedAt === "string" ? config.lastTestedAt : null;
    channelStates[legacyChannel].lastTestStatus = testStatus(config.lastTestStatus);
  }
  let legacyConfig = storedLegacyConfig(config, { env });
  if (!legacyChannel && legacyKey && !legacyConfig) {
    legacyConfig = {
      baseUrl: String(config.baseUrl || "").trim().slice(0, 500),
      apiKeyEncrypted: legacyKey,
      lastTestedAt: typeof config.lastTestedAt === "string" ? config.lastTestedAt : null,
      lastTestStatus: testStatus(config.lastTestStatus),
    };
  }
  const next = {
    channel: storedModelChannel(config.channel, legacyChannel || DEFAULT_MODEL_CHANNEL),
    customBaseUrl,
    channelStates,
    model: storedModelName(config.model, DEFAULT_ANALYSIS_MODEL),
    imageModel: storedModelName(config.imageModel, DEFAULT_IMAGE_MODEL),
  };
  if (legacyConfig) next.legacyConfig = legacyConfig;
  return next;
}

function environmentKeyForChannel(channel, env) {
  if (channel === "stable") return String(env.MODEL_STABLE_API_KEY || "").trim();
  if (channel === "fast") return String(env.MODEL_FAST_API_KEY || "").trim();
  return String(env.OPENAI_API_KEY || "").trim();
}

function resolvedChannelKey(stored, channel, env) {
  const savedKey = decryptSecret(stored.channelStates[channel].apiKeyEncrypted, { env });
  const environmentKey = environmentKeyForChannel(channel, env);
  return {
    apiKey: savedKey || environmentKey,
    apiKeySource: savedKey ? "saved" : environmentKey ? "environment" : "none",
  };
}

export function resolveModelConfig(config = {}, { env = process.env, channel } = {}) {
  const stored = secureStoredModelConfig(config, { env });
  const selectedChannel = normalizeModelChannel(channel, stored.channel);
  const credentials = resolvedChannelKey(stored, selectedChannel, env);
  const customBaseUrl = stored.customBaseUrl || String(env.OPENAI_BASE_URL || "").trim();
  if (selectedChannel === "custom" && !customBaseUrl) throw new Error("自定义模型通道缺少 API 地址。");
  return {
    channel: selectedChannel,
    baseUrl: selectedChannel === "custom" ? normalizeModelBaseUrl(customBaseUrl) : MODEL_CHANNELS[selectedChannel].baseUrl,
    model: normalizeModelName(stored.model || env.OPENAI_MODEL, DEFAULT_ANALYSIS_MODEL),
    imageModel: normalizeModelName(stored.imageModel || env.OPENAI_IMAGE_MODEL, DEFAULT_IMAGE_MODEL),
    ...credentials,
  };
}

export function publicModelConfig(config = {}, { env = process.env } = {}) {
  const stored = secureStoredModelConfig(config, { env });
  const channelStates = Object.fromEntries(MODEL_CHANNEL_IDS.map((channel) => {
    const channelConfig = resolvedChannelKey(stored, channel, env);
    const state = stored.channelStates[channel];
    return [channel, {
      apiKeyMasked: maskSecret(channelConfig.apiKey),
      hasApiKey: Boolean(channelConfig.apiKey),
      apiKeySource: channelConfig.apiKeySource,
      lastTestedAt: state.lastTestedAt,
      lastTestStatus: state.lastTestStatus,
    }];
  }));
  const activeState = channelStates[stored.channel];
  return {
    channel: stored.channel,
    customBaseUrl: stored.customBaseUrl,
    channelStates,
    model: normalizeModelName(stored.model || env.OPENAI_MODEL, DEFAULT_ANALYSIS_MODEL),
    imageModel: normalizeModelName(stored.imageModel || env.OPENAI_IMAGE_MODEL, DEFAULT_IMAGE_MODEL),
    ...activeState,
  };
}

export function updateModelConfig(current = {}, patch = {}, { env = process.env } = {}) {
  const legacyBaseUrlProvided = patch.baseUrl !== undefined;
  const customBaseUrlProvided = patch.customBaseUrl !== undefined;
  if (legacyBaseUrlProvided && customBaseUrlProvided) throw new Error("不能同时提交 baseUrl 和 customBaseUrl。");
  if ((legacyBaseUrlProvided || customBaseUrlProvided) && patch.channel && patch.channel !== "custom") {
    throw new Error("固定模型通道不能自定义 API 地址。");
  }
  if (patch.clearApiKey && String(patch.apiKey || "").trim()) {
    throw new Error("不能同时设置和清除 API Key。");
  }
  const next = secureStoredModelConfig(current, { env });
  next.channelStates = Object.fromEntries(MODEL_CHANNEL_IDS.map((channel) => [channel, { ...next.channelStates[channel] }]));
  const urlProvided = legacyBaseUrlProvided || customBaseUrlProvided;
  const targetChannel = normalizeModelChannel(patch.channel, urlProvided ? "custom" : next.channel);
  if (patch.channel !== undefined || urlProvided) next.channel = targetChannel;
  if (urlProvided) {
    const customBaseUrl = normalizeModelBaseUrl(customBaseUrlProvided ? patch.customBaseUrl : patch.baseUrl);
    if (customBaseUrl !== next.customBaseUrl) {
      next.customBaseUrl = customBaseUrl;
      next.channelStates.custom.lastTestedAt = null;
      next.channelStates.custom.lastTestStatus = null;
    }
  }
  let sharedModelChanged = false;
  if (patch.model !== undefined) {
    const model = normalizeModelName(patch.model);
    sharedModelChanged ||= model !== next.model;
    next.model = model;
  }
  if (patch.imageModel !== undefined) {
    const imageModel = normalizeModelName(patch.imageModel);
    sharedModelChanged ||= imageModel !== next.imageModel;
    next.imageModel = imageModel;
  }
  const apiKey = String(patch.apiKey || "").trim();
  if (apiKey) {
    next.channelStates[targetChannel].apiKeyEncrypted = encryptSecret(apiKey, { env });
    next.channelStates[targetChannel].lastTestedAt = null;
    next.channelStates[targetChannel].lastTestStatus = null;
  } else if (patch.clearApiKey) {
    next.channelStates[targetChannel].apiKeyEncrypted = "";
    next.channelStates[targetChannel].lastTestedAt = null;
    next.channelStates[targetChannel].lastTestStatus = null;
  }
  if (sharedModelChanged) {
    for (const channel of MODEL_CHANNEL_IDS) {
      next.channelStates[channel].lastTestedAt = null;
      next.channelStates[channel].lastTestStatus = null;
    }
  }
  if (next.channel === "custom") {
    const customBaseUrl = next.customBaseUrl || String(env.OPENAI_BASE_URL || "").trim();
    if (!customBaseUrl) throw new Error("自定义模型通道缺少 API 地址。");
    normalizeModelBaseUrl(customBaseUrl);
  }
  return next;
}

export function recordModelTestResult(current = {}, { channel, ok, status = ok ? "success" : "failed", testedAt = new Date().toISOString() } = {}, options = {}) {
  const next = secureStoredModelConfig(current, options);
  const targetChannel = normalizeModelChannel(channel, next.channel);
  next.channelStates = Object.fromEntries(MODEL_CHANNEL_IDS.map((id) => [id, { ...next.channelStates[id] }]));
  next.channelStates[targetChannel].lastTestedAt = testedAt;
  next.channelStates[targetChannel].lastTestStatus = testStatus(status) || "failed";
  return next;
}

function redact(value, secrets = []) {
  let result = String(value || "");
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[已隐藏]");
  return result.slice(0, 500);
}

async function responseBody(response) {
  if (typeof response.text === "function") return response.text();
  if (typeof response.json === "function") return JSON.stringify(await response.json());
  return "";
}

function errorDetail(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

export class ModelApiError extends Error {
  constructor(message, { code = "MODEL_API_ERROR", status = 502 } = {}) {
    super(message);
    this.name = "ModelApiError";
    this.code = code;
    this.status = status;
  }
}

export async function requestModelApiJson(url, {
  apiKey,
  body,
  fetchImpl = globalThis.fetch,
  label = "模型请求",
  method = body === undefined ? "GET" : "POST",
  signal,
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) throw new ModelApiError("未配置模型 API Key。", { code: "MODEL_API_KEY_MISSING", status: 400 });
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const multipartBody = typeof FormData !== "undefined" && body instanceof FormData;
  let response;
  let raw;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined || multipartBody ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: multipartBody ? body : JSON.stringify(body) }),
      signal: requestSignal,
    });
    raw = await responseBody(response);
  } catch (error) {
    if (requestSignal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      const waitLabel = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分钟` : `${Math.round(timeoutMs / 1000)} 秒`;
      throw new ModelApiError(`${label}等待超过 ${waitLabel}，已停止等待。`, { code: "MODEL_API_TIMEOUT", status: 504 });
    }
    throw new ModelApiError(`${label}失败：${redact(error?.message || error, [apiKey])}`, { code: "MODEL_API_NETWORK_ERROR", status: 502 });
  }
  if (!response.ok) {
    const detail = redact(errorDetail(raw), [apiKey]);
    throw new ModelApiError(`${label}失败（${response.status}）${detail ? `：${detail}` : ""}`, { status: response.status || 502 });
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ModelApiError(`${label}返回了无法解析的 JSON。`, { code: "MODEL_API_INVALID_RESPONSE", status: 502 });
  }
}

export async function testImageModel(config = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  signal,
  timeoutMs = 15_000,
} = {}) {
  const resolved = resolveModelConfig(config, { env });
  const endpoint = `${resolved.baseUrl}/models/${encodeURIComponent(resolved.imageModel)}`;
  let model = resolved.imageModel;
  let verified = false;
  let message = "";
  try {
    const data = await requestModelApiJson(endpoint, {
      apiKey: resolved.apiKey,
      fetchImpl,
      label: "图片模型连接测试",
      signal,
      timeoutMs,
    });
    model = data?.id || resolved.imageModel;
    verified = data?.id === resolved.imageModel;
    message = verified
      ? "图片模型基础连接成功（未执行生图）。"
      : `模型详情接口可访问，但未确认 ${resolved.imageModel}；请核对模型名称，或用“快速”质量生成 1 张验证。`;
  } catch (error) {
    if (![404, 405].includes(error?.status)) throw error;
    try {
      const list = await requestModelApiJson(`${resolved.baseUrl}/models`, {
        apiKey: resolved.apiKey,
        fetchImpl,
        label: "模型列表连接测试",
        signal,
        timeoutMs,
      });
      const models = Array.isArray(list?.data) ? list.data : [];
      const matched = models.find((item) => item?.id === resolved.imageModel);
      model = matched?.id || resolved.imageModel;
      verified = Boolean(matched);
      message = verified
        ? "图片模型基础连接成功（未执行生图）。"
        : `模型列表可访问，但未找到 ${resolved.imageModel}；请核对模型名称，或用“快速”质量生成 1 张验证。`;
    } catch (fallbackError) {
      if ([404, 405].includes(fallbackError?.status)) {
        message = "该兼容网关未提供免付费模型查询接口，暂时无法验证；这不代表生图不可用，请保存后用“快速”质量生成 1 张验证。";
      } else {
        throw fallbackError;
      }
    }
  }
  return {
    ok: verified,
    status: verified ? "success" : "unverified",
    testedAt: now(),
    model,
    message,
  };
}
