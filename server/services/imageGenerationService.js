import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import sharp from "sharp";
import { dbRuntimeInfo } from "../storage/db.js";
import {
  ModelApiError,
  requestModelApiJson,
  resolveModelConfig,
} from "./modelConfigService.js";

const IMAGE_RATIOS = {
  "1:1": { nativeSize: "1024x1024", width: 1, height: 1 },
  "3:4": { nativeSize: "1024x1536", width: 3, height: 4 },
  "4:3": { nativeSize: "1536x1024", width: 4, height: 3 },
  "16:9": { nativeSize: "1536x1024", width: 16, height: 9 },
};
const RESOLUTION_LONG_EDGES = { "1k": 1024, "2k": 2048, "4k": 4096 };
const QUALITIES = new Set(["low", "medium", "high"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const IMAGE_OUTPUT_BASE_PROMPT = "基础质量规范：严格服从用户明确提出的画面内容，用户的正向要求优先于额外排除要求。文字与标识：将用户明确提供的所有文案视为必须逐字执行的原文，即使原文没有使用引号。必须保持用户指定的简体或繁体、语言、字符顺序、大小写、数字、单位、标点、空格、换行、行序和全角半角完全一致，文字清晰可读；不得擅自翻译、改写、增删或转换简繁体。不得出现乱码、伪文字、错别字、同音字、形近字、部首或偏旁替换、缺字、多字、重复字、笔画增减、断笔、粘连或畸形，不得出现镜像、反向、倒置、旋转或变形字符。无论用户是否要求新增或修改文字，都不得出现用户未明确指定的额外文字、数字、价格、促销标签、二维码、条形码、水印、Logo、品牌标识或署名；用户只要求某一段文字时，只能新增或替换该段指定文字，不得连带生成其他文案。正向要求与额外排除要求冲突时，以正向要求为准，额外排除要求只约束用户未明确要求的内容。画面完整性：主体数量、身份、外形、比例、结构、颜色和关键细节必须符合用户要求，主体完整且不畸变，边缘干净，材质与光影自然；不得出现重复部件、缺失部件、穿模、悬浮、拉伸、过度锐化、明显噪点、压缩伪影或无关界面元素。";
const IMAGE_REFERENCE_BASE_PROMPTS = {
  source: "严格参考图编辑任务。第一张图片是待编辑原图，也是产品身份和原始画面的唯一事实依据。除用户明确要求修改的项目外，必须保持原图中的产品身份、外形、比例、结构、零部件、按键、Logo、既有文字、材质、颜色、镜头角度、透视、构图、裁切和宽高比不变。若用户明确要求新增、删除或替换原图文字，仅允许修改用户指定的文字和对应区域；新增或替换的内容必须与用户原文逐字一致，其他既有文字及其字体风格、字号、颜色、排版和位置必须保持不变。若用户未明确要求改字，禁止改写、翻译、删除或新增既有文字。若请求的输出尺寸与原图宽高比不同，该尺寸选择视为用户明确要求，仅允许为适配新画布做必要的扩图或裁切，产品本身仍须完整保真。只实施用户明确要求的变化；禁止替换产品、整体重设计、虚构或增删结构以及新增品牌。其余参考图仅用于用户指定的材质、风格或场景参考，不得覆盖第一张原图的产品事实。",
  reference: "普通参考图任务。参考图用于约束用户指定的产品、风格、材质或构图，但不默认把第一张图片视为待编辑原图。若用户未明确要求重新设计，必须保留参考图中核心产品可辨识的身份、外形、比例、结构、按键、Logo、既有文字、材质和颜色。若用户明确要求基于参考图新增、删除或替换文字，仅允许修改用户指定的文字和对应区域；新增或替换的内容必须与用户原文逐字一致，其他既有文字及其字体风格、字号、颜色、排版和位置必须保持不变。若用户未明确要求改字，禁止改写、翻译、删除或新增既有文字。只实施用户明确要求的变化，禁止替换产品、虚构或增删结构以及新增品牌。若用户明确说明参考图只用于风格，则仅提取相关风格，不要求复刻其主体或构图。",
};
const IMAGE_EDIT_BASE_PROMPTS = {
  mask: "局部蒙版编辑任务。第一张图片是待编辑原图，也是产品身份和原始画面的唯一事实依据；其他参考图仅用于用户指定的材质或风格参考。只修改透明蒙版覆盖的区域，并且只实施用户明确要求的变化。若用户明确要求新增、删除或替换文字，只允许在蒙版内修改指定文字；新增或替换的内容必须与用户原文逐字一致，蒙版外和未指定修改的既有文字必须保持不变。严格保持蒙版外的产品身份、外形、比例、结构、零部件、按键、Logo、既有文字、材质、颜色、镜头角度、透视、构图、裁切、宽高比、背景和清晰度不变；禁止替换产品、整体重设计、虚构或增删结构、新增品牌，以及移动、重画、增删或裁切蒙版外内容。修改区域必须与周围自然衔接。",
  annotation: "局部批注编辑任务。第一张图片是待编辑原图，也是产品身份和原始画面的唯一事实依据；最后一张带编号框选或备注点的图片只用于指示修改位置；中间图片仅作为用户指定的材质或风格参考。最后一张批注图中的编号必须与修改内容中的相同编号逐条对应，按编号分别执行，不得合并、错配或漏改；框线、编号和备注点不得出现在最终图片中。只修改每个编号指向的框选或点选区域，并且只实施该编号明确要求的变化。若某编号明确要求新增、删除或替换文字，只允许在该编号标注区域内修改指定文字；新增或替换的内容必须与该条用户原文逐字一致，其他编号、未标注区域和未指定修改的既有文字必须保持不变。严格保持未标注区域的产品身份、外形、比例、结构、零部件、按键、Logo、既有文字、材质、颜色、镜头角度、透视、构图、裁切、宽高比、背景和清晰度不变；禁止替换产品、整体重设计、虚构或增删结构、新增品牌，以及移动、重画、增删或裁切未标注内容。修改区域必须与周围自然衔接。",
};
const MIME_BY_FORMAT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const FORMAT_BY_MIME = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
const IMAGE_ID_PATTERN = /^image_[a-f0-9]{32}$/;
const MAX_REFERENCE_FILES = 4;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_LIBRARY_ITEMS = 200;
const MANIFEST_VERSION = 1;
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 250, 250, 250, 250];
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

let libraryMutationQueue = Promise.resolve();

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}不能为空。`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

function optionalText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

function oneOf(value, allowed, label, fallback) {
  const normalized = value ?? fallback;
  if (!allowed.has(normalized)) throw new Error(`${label}无效。`);
  return normalized;
}

function imageError(message, { code = "IMAGE_REQUEST_INVALID", status = 400 } = {}) {
  return new ModelApiError(message, { code, status });
}

export function mergeImagePrompt(prompt, negativePrompt = "", referenceMode) {
  const positive = requiredText(prompt, "正向提示词", 32_000);
  const negative = optionalText(negativePrompt, "负面提示词", 4_000);
  const reference = referenceMode ? IMAGE_REFERENCE_BASE_PROMPTS[referenceMode] : "";
  if (referenceMode && !reference) throw new Error("参考图方式无效。");
  const merged = [IMAGE_OUTPUT_BASE_PROMPT, reference, positive].filter(Boolean).join("\n\n");
  return negative ? `${merged}\n\n额外排除要求（不得覆盖上述正向要求、原图事实或保留规则，只约束用户未明确要求的内容）：${negative}` : merged;
}

export function mergeImageEditPrompt(instruction, mode) {
  const base = IMAGE_EDIT_BASE_PROMPTS[mode];
  if (!base) throw new Error("图片编辑方式无效。");
  return `${base}\n\n修改内容：${requiredText(instruction, "修改内容", 4_000)}`;
}

export function targetImageSize(ratio = "1:1", resolution = "1k") {
  const ratioConfig = IMAGE_RATIOS[ratio];
  const longEdge = RESOLUTION_LONG_EDGES[resolution];
  if (!ratioConfig) throw new Error("画面比例无效。");
  if (!longEdge) throw new Error("输出分辨率无效。");
  if (ratioConfig.width >= ratioConfig.height) {
    return { width: longEdge, height: Math.round(longEdge * ratioConfig.height / ratioConfig.width) };
  }
  return { width: Math.round(longEdge * ratioConfig.width / ratioConfig.height), height: longEdge };
}

export function buildImageGenerationRequest(input = {}, imageModel = "gpt-image-2") {
  const ratio = input.ratio || "1:1";
  const ratioConfig = IMAGE_RATIOS[ratio];
  if (!ratioConfig) throw new Error("画面比例无效。");
  if (!RESOLUTION_LONG_EDGES[input.resolution || "1k"]) throw new Error("输出分辨率无效。");
  const quality = oneOf(input.quality, QUALITIES, "生成质量", "medium");
  const outputFormat = oneOf(input.format, FORMATS, "输出格式", "png");
  const background = oneOf(input.background, BACKGROUNDS, "背景方式", "auto");
  if (background === "transparent" && outputFormat === "jpeg") throw new Error("JPEG 不支持透明背景，请改用 PNG 或 WEBP。");
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("生成数量必须为 1 到 4 之间的整数。");
  const compression = input.compression ?? 90;
  if (!Number.isInteger(compression) || compression < 0 || compression > 100) throw new Error("图片压缩率必须为 0 到 100 之间的整数。");
  const referenceMode = input.referenceMode || (!input.editMode && input.sourceImageId ? "source" : undefined);

  return {
    model: String(imageModel || "").trim(),
    prompt: mergeImagePrompt(
      input.editMode ? mergeImageEditPrompt(input.prompt, input.editMode) : input.prompt,
      input.negativePrompt,
      referenceMode,
    ),
    size: ratioConfig.nativeSize,
    quality,
    output_format: outputFormat,
    background,
    n: count,
    ...((outputFormat === "jpeg" || outputFormat === "webp") ? { output_compression: compression } : {}),
  };
}

export function imageGenerationEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  return /\/images\/generations$/i.test(normalized) ? normalized : `${normalized}/images/generations`;
}

export function imageEditEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "").replace(/\/images\/generations$/i, "");
  return /\/images\/edits$/i.test(normalized) ? normalized : `${normalized}/images/edits`;
}

function mimeType(format) {
  return MIME_BY_FORMAT[format] || "image/png";
}

function base64Image(value, fallbackFormat) {
  const source = String(value || "").trim();
  const dataUri = source.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  const encoded = (dataUri?.[2] || source).replace(/\s/g, "");
  if (!encoded || encoded.length > 50_000_000 || encoded.length % 4 === 1 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) return null;
  const type = dataUri?.[1]?.toLowerCase().replace("image/jpg", "image/jpeg") || mimeType(fallbackFormat);
  return { src: `data:${type};base64,${encoded}`, source: "base64", mimeType: type };
}

function remoteImage(value, fallbackFormat) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { src: url.toString(), source: "url", mimeType: mimeType(fallbackFormat) };
  } catch {
    return null;
  }
}

export function parseImageGenerationResponse(data, { format = "png" } = {}) {
  if (!data || !Array.isArray(data.data)) {
    throw new ModelApiError("图片模型返回格式无效。", { code: "IMAGE_RESPONSE_INVALID", status: 502 });
  }
  const images = data.data.flatMap((item) => {
    const parsed = item?.b64_json
      ? base64Image(item.b64_json, format)
      : remoteImage(item?.url, format);
    if (!parsed) return [];
    return [{
      ...parsed,
      ...(item?.revised_prompt ? { revisedPrompt: String(item.revised_prompt) } : {}),
    }];
  });
  if (!images.length) {
    throw new ModelApiError("图片模型没有返回可用图片。", { code: "IMAGE_RESPONSE_EMPTY", status: 502 });
  }
  return images;
}

function normalizedMimeType(value) {
  const type = String(value || "").toLowerCase().split(";")[0].trim().replace("image/jpg", "image/jpeg");
  return FORMAT_BY_MIME[type] ? type : "";
}

function safeUploadName(value, fallback) {
  return path.basename(String(value || fallback))
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .slice(0, 100) || fallback;
}

async function validateReferenceFile(file, { mask = false, index = 0 } = {}) {
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) {
    throw imageError(mask ? "批注蒙版内容为空。" : `第 ${index + 1} 张参考图内容为空。`, { code: "IMAGE_REFERENCE_EMPTY" });
  }
  if (file.buffer.length > MAX_REFERENCE_BYTES) {
    throw imageError("每张参考图或蒙版不能超过 8 MB。", { code: "IMAGE_REFERENCE_TOO_LARGE", status: 413 });
  }
  const declaredMimeType = normalizedMimeType(file.mimetype || file.mimeType);
  if (!declaredMimeType) {
    throw imageError("参考图只支持 PNG、JPEG 或 WEBP。", { code: "IMAGE_REFERENCE_TYPE_INVALID" });
  }
  let metadata;
  try {
    metadata = await sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  } catch {
    throw imageError("参考图文件损坏、格式不受支持或像素过大。", { code: "IMAGE_REFERENCE_INVALID" });
  }
  const actualMimeType = MIME_BY_FORMAT[metadata.format];
  if (!actualMimeType || actualMimeType !== declaredMimeType) {
    throw imageError("参考图扩展类型与实际图片内容不一致。", { code: "IMAGE_REFERENCE_TYPE_MISMATCH" });
  }
  if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw imageError("参考图尺寸不能超过 8192×8192 或 4000 万像素。", { code: "IMAGE_REFERENCE_PIXELS_EXCEEDED", status: 413 });
  }
  if ((metadata.pages || 1) > 1) {
    throw imageError("参考图暂不支持动图或多页图片。", { code: "IMAGE_REFERENCE_ANIMATED_UNSUPPORTED" });
  }
  if (mask && (metadata.format !== "png" || !metadata.hasAlpha)) {
    throw imageError("批注蒙版必须是带透明区域的 PNG 图片。", { code: "IMAGE_MASK_INVALID" });
  }
  if (mask) {
    const stats = await sharp(file.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).stats();
    const alpha = stats.channels[3];
    if (!alpha || alpha.min >= 255) {
      throw imageError("批注蒙版必须包含透明区域，透明区域才是需要修改的位置。", { code: "IMAGE_MASK_OPAQUE" });
    }
  }
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const dimensions = orientedSize(metadata);
  return {
    buffer: file.buffer,
    mimeType: actualMimeType,
    name: safeUploadName(file.originalname || file.name, `${mask ? "mask" : `reference-${index + 1}`}.${extension}`),
    width: dimensions.width,
    height: dimensions.height,
  };
}

function privateIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return privateIpAddress(normalized.slice(7));
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return true;
}

async function assertSafeRemoteImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw imageError("图片模型返回了无效的图片地址。", { code: "IMAGE_REMOTE_RESULT_INVALID", status: 502 });
  }
  const hostname = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname === "metadata.google.internal") {
    throw imageError("图片模型返回的远程图片地址不安全，已拒绝下载。", { code: "IMAGE_REMOTE_RESULT_BLOCKED", status: 502 });
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateIpAddress(address))) {
    throw imageError("图片模型返回的远程图片地址指向本机或内网，已拒绝下载。", { code: "IMAGE_REMOTE_RESULT_BLOCKED", status: 502 });
  }
  return url;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function fetchRemoteImageWithSignal(value, { fetchImpl, signal }) {
  let url = await abortable(assertSafeRemoteImageUrl(value), signal);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: "image/png,image/jpeg,image/webp" }, redirect: "manual", signal });
    } catch (error) {
      throw imageError(`无法下载图片模型返回的图片：${error?.message || "网络错误"}`, { code: "IMAGE_REMOTE_RESULT_FAILED", status: 502 });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === 3) throw imageError("图片模型返回的图片重定向次数过多。", { code: "IMAGE_REMOTE_RESULT_REDIRECTED", status: 502 });
      const location = response.headers.get("location");
      if (!location) throw imageError("图片模型返回了无目标地址的重定向。", { code: "IMAGE_REMOTE_RESULT_INVALID", status: 502 });
      url = await abortable(assertSafeRemoteImageUrl(new URL(location, url).toString()), signal);
      continue;
    }
    if (!response.ok) throw imageError(`下载图片模型结果失败（${response.status}）。`, { code: "IMAGE_REMOTE_RESULT_FAILED", status: 502 });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_REMOTE_IMAGE_BYTES) throw imageError("图片模型返回的图片超过 32 MB。", { code: "IMAGE_REMOTE_RESULT_TOO_LARGE", status: 502 });
    const declaredMimeType = normalizedMimeType(response.headers.get("content-type"));
    if (!declaredMimeType) throw imageError("图片模型返回的地址不是受支持的图片格式。", { code: "IMAGE_REMOTE_RESULT_TYPE_INVALID", status: 502 });
    const chunks = [];
    let totalBytes = 0;
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw imageError("图片模型返回的图片超过 32 MB。", { code: "IMAGE_REMOTE_RESULT_TOO_LARGE", status: 502 });
          }
          chunks.push(Buffer.from(chunk));
        }
      } else {
        const chunk = Buffer.from(await response.arrayBuffer());
        totalBytes = chunk.length;
        chunks.push(chunk);
      }
    } catch (error) {
      if (error?.code === "IMAGE_REMOTE_RESULT_TOO_LARGE") throw error;
      throw imageError("读取图片模型返回的远程图片失败。", { code: "IMAGE_REMOTE_RESULT_FAILED", status: 502 });
    }
    const buffer = Buffer.concat(chunks, totalBytes);
    if (!buffer.length || buffer.length > MAX_REMOTE_IMAGE_BYTES) throw imageError("图片模型返回的图片为空或超过 32 MB。", { code: "IMAGE_REMOTE_RESULT_TOO_LARGE", status: 502 });
    return { buffer, declaredMimeType };
  }
  throw imageError("无法下载图片模型返回的图片。", { code: "IMAGE_REMOTE_RESULT_FAILED", status: 502 });
}

async function fetchRemoteImage(value, { fetchImpl, signal, timeoutMs = 60_000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("remote image timeout must be positive");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetchRemoteImageWithSignal(value, { fetchImpl, signal: requestSignal });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw imageError("下载图片模型返回的远程图片超过 60 秒，已停止等待。", { code: "IMAGE_REMOTE_RESULT_TIMEOUT", status: 504 });
    }
    if (signal?.aborted) throw imageError("远程图片下载已取消。", { code: "IMAGE_REMOTE_RESULT_ABORTED", status: 499 });
    throw error;
  }
}

function base64Buffer(src) {
  const comma = src.indexOf(",");
  const buffer = Buffer.from(comma >= 0 ? src.slice(comma + 1) : src, "base64");
  if (!buffer.length || buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw imageError("图片模型返回的图片为空或超过 32 MB。", { code: "IMAGE_RESULT_TOO_LARGE", status: 502 });
  }
  return buffer;
}

function orientedSize(metadata) {
  return metadata.orientation >= 5 && metadata.orientation <= 8
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

async function transformGeneratedImage(image, input, { fetchImpl, signal, remoteImageTimeoutMs }) {
  const remote = image.source === "url" ? await fetchRemoteImage(image.src, { fetchImpl, signal, timeoutMs: remoteImageTimeoutMs }) : null;
  const sourceBuffer = remote?.buffer || base64Buffer(image.src);
  let metadata;
  try {
    metadata = await sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  } catch {
    throw imageError("图片模型返回了损坏或像素过大的图片。", { code: "IMAGE_RESULT_INVALID", status: 502 });
  }
  const actualMimeType = MIME_BY_FORMAT[metadata.format];
  if (!actualMimeType || (remote?.declaredMimeType && actualMimeType !== remote.declaredMimeType)) {
    throw imageError("图片模型返回的图片格式与内容不一致。", { code: "IMAGE_RESULT_TYPE_INVALID", status: 502 });
  }
  const native = orientedSize(metadata);
  if (!native.width || !native.height || native.width * native.height > MAX_INPUT_PIXELS) {
    throw imageError("图片模型返回的图片超过 4000 万像素。", { code: "IMAGE_RESULT_PIXELS_EXCEEDED", status: 502 });
  }
  const target = targetImageSize(input.ratio, input.resolution || "1k");
  const upscaled = target.width > native.width || target.height > native.height;
  const nativeRatio = native.width / native.height;
  const targetRatio = target.width / target.height;
  const unchanged = native.width === target.width && native.height === target.height && Math.abs(nativeRatio - targetRatio) < 0.0001;
  const processing = upscaled ? "upscaled" : unchanged ? "native" : "cropped";
  const outputFormat = input.format || "png";
  const compression = input.compression ?? 90;
  let pipeline = sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate()
    .resize(target.width, target.height, { fit: "cover", position: "centre", kernel: sharp.kernel.lanczos3 });
  if (outputFormat === "jpeg") {
    pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: compression, chromaSubsampling: "4:4:4", mozjpeg: true });
  } else if (outputFormat === "webp") {
    pipeline = pipeline.webp({ quality: compression, smartSubsample: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  const buffer = await pipeline.toBuffer();
  return {
    buffer,
    mimeType: mimeType(outputFormat),
    revisedPrompt: image.revisedPrompt,
    nativeSize: `${native.width}x${native.height}`,
    outputSize: `${target.width}x${target.height}`,
    width: target.width,
    height: target.height,
    upscaled,
    processing,
  };
}

function editFormData(body, references, mask) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.append(key, String(value));
  const imageField = references.length === 1 ? "image" : "image[]";
  for (const reference of references) {
    form.append(imageField, new Blob([reference.buffer], { type: reference.mimeType }), reference.name);
  }
  if (mask) form.append("mask", new Blob([mask.buffer], { type: mask.mimeType }), mask.name);
  return form;
}

async function prepareEditFiles(input, uploadedReferences, uploadedMask, sourceImageOverride = null) {
  const references = [];
  if (input.sourceImageId) {
    const source = sourceImageOverride || await readGeneratedImageFile(input.sourceImageId);
    references.push(await validateReferenceFile(sourceImageOverride ? source : {
      buffer: source.buffer,
      mimetype: source.record.mimeType,
      originalname: `source.${source.record.format === "jpeg" ? "jpg" : source.record.format}`,
    }, { index: 0 }));
  }
  for (const [index, file] of (uploadedReferences || []).entries()) {
    references.push(await validateReferenceFile(file, { index }));
  }
  if (references.length > MAX_REFERENCE_FILES) {
    throw imageError("参考图最多上传 4 张。", { code: "IMAGE_REFERENCE_COUNT_EXCEEDED" });
  }
  const mask = uploadedMask ? await validateReferenceFile(uploadedMask, { mask: true }) : null;
  if (mask && !references.length) throw imageError("使用批注蒙版时必须提供原图或参考图。", { code: "IMAGE_MASK_SOURCE_MISSING" });
  if (mask && (mask.width !== references[0].width || mask.height !== references[0].height)) {
    throw imageError("批注蒙版尺寸必须与第一张原图一致。", { code: "IMAGE_MASK_SIZE_MISMATCH" });
  }
  const totalBytes = references.reduce((sum, item) => sum + item.buffer.length, 0) + (mask?.buffer.length || 0);
  if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
    throw imageError("参考图和蒙版合计不能超过 32 MB。", { code: "IMAGE_REFERENCE_TOTAL_TOO_LARGE", status: 413 });
  }
  return { references, mask };
}

function generationWarnings(input, body, edit) {
  const output = targetImageSize(input.ratio, input.resolution || "1k");
  const warnings = [];
  if (body.size !== `${output.width}x${output.height}`) {
    warnings.push(`模型按原生尺寸 ${body.size} 生成，已由本机处理为 ${output.width}x${output.height}。`);
  }
  if ((input.resolution || "1k") !== "1k") warnings.push(`${String(input.resolution).toUpperCase()} 为本机高质量增强输出，并非模型原生分辨率。`);
  if (edit) warnings.push("本次使用参考图编辑接口，原图未被覆盖。");
  return warnings;
}

export async function generateImages(config = {}, input = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 600_000,
  remoteImageTimeoutMs = 60_000,
  referenceImages = [],
  maskImage = null,
  sourceImageOverride = null,
} = {}) {
  const resolved = resolveModelConfig(config, { env });
  const prepared = await prepareEditFiles(input, referenceImages, maskImage, sourceImageOverride);
  const edit = prepared.references.length > 0;
  if (prepared.mask && input.editMode && input.editMode !== "mask") {
    throw imageError("蒙版文件只能使用蒙版重绘方式。", { code: "IMAGE_EDIT_MODE_MISMATCH" });
  }
  const editMode = input.editMode || (prepared.mask ? "mask" : undefined);
  if (editMode === "mask" && !prepared.mask) {
    throw imageError("蒙版重绘缺少有效蒙版文件。", { code: "IMAGE_EDIT_MASK_MISSING" });
  }
  if (editMode === "annotation" && (!input.sourceImageId || prepared.references.length < 2)) {
    throw imageError("带批注参考需要待编辑原图和批注图。", { code: "IMAGE_EDIT_ANNOTATION_MISSING" });
  }
  if (editMode && !edit) throw imageError("图片编辑缺少待编辑原图。", { code: "IMAGE_EDIT_SOURCE_MISSING" });
  const referenceMode = !editMode && edit ? (input.sourceImageId ? "source" : "reference") : undefined;
  const body = buildImageGenerationRequest({ ...input, editMode, referenceMode }, resolved.imageModel);
  let data;
  try {
    data = await requestModelApiJson(edit ? imageEditEndpoint(resolved.baseUrl) : imageGenerationEndpoint(resolved.baseUrl), {
      apiKey: resolved.apiKey,
      body: edit ? editFormData(body, prepared.references, prepared.mask) : body,
      fetchImpl,
      label: edit ? "AI 参考图编辑" : "AI 生图",
      signal,
      timeoutMs,
    });
  } catch (error) {
    if (edit && [404, 405].includes(error?.status)) {
      throw imageError("当前兼容网关不支持参考图编辑接口，请更换支持 /images/edits 的图片模型服务。", { code: "IMAGE_EDIT_UNSUPPORTED", status: 422 });
    }
    throw error;
  }
  const parsed = parseImageGenerationResponse(data, { format: body.output_format });
  const images = [];
  for (const image of parsed) images.push(await transformGeneratedImage(image, input, { fetchImpl, signal, remoteImageTimeoutMs }));
  const output = targetImageSize(input.ratio, input.resolution || "1k");
  return {
    images,
    model: resolved.imageModel,
    requestedCount: body.n,
    generatedCount: images.length,
    size: `${output.width}x${output.height}`,
    nativeRequestSize: body.size,
    created: Number.isFinite(data.created) ? data.created : null,
    usage: data.usage && typeof data.usage === "object" ? data.usage : null,
    warnings: generationWarnings(input, body, edit),
    appliedOptions: {
      mode: edit ? "edit" : "generate",
      referenceImageCount: prepared.references.length,
      maskApplied: Boolean(prepared.mask),
      ratio: input.ratio,
      resolution: input.resolution || "1k",
      nativeSize: body.size,
      outputSize: `${output.width}x${output.height}`,
    },
  };
}

function libraryPaths() {
  const directory = path.join(dbRuntimeInfo().dataDir, "generated-images");
  return { directory, manifest: path.join(directory, "manifest.json") };
}

function recordFiles(id, format) {
  const extension = format === "jpeg" ? "jpg" : format;
  return { filename: `${id}.${extension}`, thumbnailFilename: `${id}.thumb.webp` };
}

async function atomicWriteFile(destination, data) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, destination);
        break;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function normalizeStoredRecord(record) {
  if (!record || !IMAGE_ID_PATTERN.test(record.id) || !FORMAT_BY_MIME[record.mimeType]) return null;
  const format = FORMAT_BY_MIME[record.mimeType];
  const files = recordFiles(record.id, format);
  if (record.filename !== files.filename || record.thumbnailFilename !== files.thumbnailFilename) return null;
  return {
    id: record.id,
    filename: files.filename,
    thumbnailFilename: files.thumbnailFilename,
    mimeType: record.mimeType,
    format,
    prompt: String(record.prompt || "").slice(0, 4_000),
    negativePrompt: String(record.negativePrompt || "").slice(0, 2_000),
    ratio: IMAGE_RATIOS[record.ratio] ? record.ratio : "1:1",
    resolution: RESOLUTION_LONG_EDGES[record.resolution] ? record.resolution : "1k",
    quality: QUALITIES.has(record.quality) ? record.quality : "medium",
    background: BACKGROUNDS.has(record.background) ? record.background : "auto",
    model: String(record.model || "").slice(0, 200),
    createdAt: Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : new Date(0).toISOString(),
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    nativeSize: String(record.nativeSize || ""),
    outputSize: String(record.outputSize || ""),
    upscaled: Boolean(record.upscaled),
    processing: ["native", "cropped", "upscaled"].includes(record.processing) ? record.processing : "native",
    isFavorite: Boolean(record.isFavorite),
    isArchived: Boolean(record.isArchived),
    revisedPrompt: String(record.revisedPrompt || "").slice(0, 4_000),
    parentImageId: IMAGE_ID_PATTERN.test(record.parentImageId || "") ? record.parentImageId : null,
    referenceImageCount: Math.max(0, Math.min(MAX_REFERENCE_FILES, Number(record.referenceImageCount) || 0)),
    maskApplied: Boolean(record.maskApplied),
  };
}

async function readManifest() {
  const { directory, manifest } = libraryPaths();
  await fs.mkdir(directory, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(manifest, "utf8"));
    return {
      version: MANIFEST_VERSION,
      items: (Array.isArray(parsed?.items) ? parsed.items : []).map(normalizeStoredRecord).filter(Boolean),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: MANIFEST_VERSION, items: [] };
    if (error instanceof SyntaxError) throw imageError("AI 图片相册索引损坏，请备份 generated-images 目录后重试。", { code: "IMAGE_LIBRARY_CORRUPT", status: 500 });
    throw error;
  }
}

async function writeManifest(manifest) {
  const paths = libraryPaths();
  await fs.mkdir(paths.directory, { recursive: true });
  await atomicWriteFile(paths.manifest, JSON.stringify({ version: MANIFEST_VERSION, items: manifest.items }, null, 2));
}

function mutateLibrary(operation) {
  const next = libraryMutationQueue.then(operation);
  libraryMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function publicImageRecord(record) {
  const base = `/api/images/${encodeURIComponent(record.id)}/file`;
  const { filename: _filename, thumbnailFilename: _thumbnailFilename, ...publicRecord } = record;
  return {
    ...publicRecord,
    src: base,
    thumbnailSrc: `${base}?thumbnail=1`,
  };
}

async function removeRecordFiles(records) {
  const { directory } = libraryPaths();
  await Promise.all(records.flatMap((record) => [record.filename, record.thumbnailFilename]
    .map((filename) => fs.unlink(path.join(directory, filename)).catch((error) => {
      if (error?.code !== "ENOENT") console.error("[image-library-cleanup]", error);
    }))));
}

export async function saveGeneratedImages(images, context = {}) {
  if (!Array.isArray(images) || !images.length) throw imageError("没有可保存的生成图片。", { code: "IMAGE_RESPONSE_EMPTY", status: 502 });
  return mutateLibrary(async () => {
    const paths = libraryPaths();
    await fs.mkdir(paths.directory, { recursive: true });
    const createdAt = context.createdAt || new Date().toISOString();
    const saved = [];
    const writtenFiles = [];
    try {
      for (const image of images) {
        const format = FORMAT_BY_MIME[image.mimeType];
        if (!format || !Buffer.isBuffer(image.buffer)) throw imageError("生成图片格式无法保存。", { code: "IMAGE_RESULT_INVALID", status: 502 });
        const id = `image_${crypto.randomUUID().replaceAll("-", "")}`;
        const files = recordFiles(id, format);
        const thumbnail = await sharp(image.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
          .webp({ quality: 78, smartSubsample: true })
          .toBuffer();
        await atomicWriteFile(path.join(paths.directory, files.filename), image.buffer);
        writtenFiles.push(files.filename);
        await atomicWriteFile(path.join(paths.directory, files.thumbnailFilename), thumbnail);
        writtenFiles.push(files.thumbnailFilename);
        saved.push(normalizeStoredRecord({
          id,
          ...files,
          mimeType: image.mimeType,
          prompt: context.prompt,
          negativePrompt: context.negativePrompt,
          ratio: context.ratio,
          resolution: context.resolution || "1k",
          quality: context.quality,
          background: context.background,
          model: context.model,
          createdAt,
          width: image.width,
          height: image.height,
          nativeSize: image.nativeSize,
          outputSize: image.outputSize,
          upscaled: image.upscaled,
          processing: image.processing,
          isFavorite: false,
          isArchived: false,
          revisedPrompt: image.revisedPrompt,
          parentImageId: context.sourceImageId,
          referenceImageCount: context.referenceImageCount,
          maskApplied: context.maskApplied,
        }));
      }
      const manifest = await readManifest();
      manifest.items = [...saved, ...manifest.items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const removed = [];
      const savedIds = new Set(saved.map((item) => item.id));
      while (manifest.items.length > MAX_LIBRARY_ITEMS) {
        let removeIndex = -1;
        for (let index = manifest.items.length - 1; index >= 0; index -= 1) {
          if (!manifest.items[index].isFavorite && !savedIds.has(manifest.items[index].id)) {
            removeIndex = index;
            break;
          }
        }
        if (removeIndex < 0) break;
        removed.push(...manifest.items.splice(removeIndex, 1));
      }
      await writeManifest(manifest);
      await removeRecordFiles(removed);
      return saved.map(publicImageRecord);
    } catch (error) {
      await Promise.all(writtenFiles.map((filename) => fs.unlink(path.join(paths.directory, filename)).catch(() => undefined)));
      throw error;
    }
  });
}

export async function listGeneratedImages({ scope = "all" } = {}) {
  const manifest = await readManifest();
  const items = manifest.items.filter((item) => scope === "favorites"
    ? item.isFavorite
    : scope === "archived"
      ? item.isArchived
      : scope === "active"
        ? !item.isArchived
        : true);
  return items.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).map(publicImageRecord);
}

export async function updateGeneratedImage(id, patch = {}) {
  if (!IMAGE_ID_PATTERN.test(id)) throw imageError("图片记录 ID 无效。", { code: "IMAGE_LIBRARY_ID_INVALID" });
  return mutateLibrary(async () => {
    const manifest = await readManifest();
    const item = manifest.items.find((record) => record.id === id);
    if (!item) throw imageError("没有找到这张历史图片。", { code: "IMAGE_LIBRARY_NOT_FOUND", status: 404 });
    if (patch.isFavorite !== undefined) item.isFavorite = Boolean(patch.isFavorite);
    if (patch.isArchived !== undefined) item.isArchived = Boolean(patch.isArchived);
    await writeManifest(manifest);
    return publicImageRecord(item);
  });
}

export async function deleteGeneratedImage(id) {
  if (!IMAGE_ID_PATTERN.test(id)) throw imageError("图片记录 ID 无效。", { code: "IMAGE_LIBRARY_ID_INVALID" });
  return mutateLibrary(async () => {
    const manifest = await readManifest();
    const index = manifest.items.findIndex((record) => record.id === id);
    if (index < 0) throw imageError("没有找到这张历史图片。", { code: "IMAGE_LIBRARY_NOT_FOUND", status: 404 });
    const [removed] = manifest.items.splice(index, 1);
    await writeManifest(manifest);
    await removeRecordFiles([removed]);
  });
}

export async function readGeneratedImageFile(id, { thumbnail = false } = {}) {
  if (!IMAGE_ID_PATTERN.test(id)) throw imageError("图片记录 ID 无效。", { code: "IMAGE_LIBRARY_ID_INVALID" });
  const manifest = await readManifest();
  const record = manifest.items.find((item) => item.id === id);
  if (!record) throw imageError("没有找到这张历史图片。", { code: "IMAGE_LIBRARY_NOT_FOUND", status: 404 });
  const filename = thumbnail ? record.thumbnailFilename : record.filename;
  try {
    return {
      buffer: await fs.readFile(path.join(libraryPaths().directory, filename)),
      mimeType: thumbnail ? "image/webp" : record.mimeType,
      filename,
      record: publicImageRecord(record),
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw imageError("历史图片文件已丢失，请删除这条记录后重新生成。", { code: "IMAGE_LIBRARY_FILE_MISSING", status: 404 });
    throw error;
  }
}

export const imageGenerationLimits = Object.freeze({
  maxReferenceFiles: MAX_REFERENCE_FILES,
  maxReferenceBytes: MAX_REFERENCE_BYTES,
  maxReferenceTotalBytes: MAX_REFERENCE_TOTAL_BYTES,
  maxInputPixels: MAX_INPUT_PIXELS,
  maxLibraryItems: MAX_LIBRARY_ITEMS,
});
