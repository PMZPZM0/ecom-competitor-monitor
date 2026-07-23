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
  "4:5": { nativeSize: "1024x1536", width: 4, height: 5 },
  "3:4": { nativeSize: "1024x1536", width: 3, height: 4 },
  "2:3": { nativeSize: "1024x1536", width: 2, height: 3 },
  "9:16": { nativeSize: "1024x1536", width: 9, height: 16 },
  "4:3": { nativeSize: "1536x1024", width: 4, height: 3 },
  "3:2": { nativeSize: "1536x1024", width: 3, height: 2 },
  "16:9": { nativeSize: "1536x1024", width: 16, height: 9 },
};
const RESOLUTION_LONG_EDGES = { "1k": 1024, "2k": 2048, "4k": 4096 };
const QUALITIES = new Set(["low", "medium", "high"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const IMAGE_EDIT_MODES = new Set(["mask", "annotation"]);
const IMAGE_EDIT_INTENTS = new Set(["local", "background", "outpaint", "redraw"]);
const COMPOSITION_MODES = new Set(["keep", "smart"]);
const COPY_POSITIONS = new Set(["top", "center", "bottom"]);
const COPY_STYLES = new Set(["light", "dark"]);
const COPY_SCALES = new Set(["small", "medium", "large"]);
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
const INTERNAL_REVISED_PROMPT_PATTERN = /生图规范：如果画面包含文字|以下为服务端硬约束|以下为服务端基础排除规则|严格参考图编辑任务|普通参考图任务|局部蒙版编辑任务|局部批注编辑任务/;

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

function imageError(message, { code = "IMAGE_REQUEST_INVALID", status = 400, retryable } = {}) {
  const error = new ModelApiError(message, { code, status });
  if (retryable !== undefined) error.retryable = retryable;
  return error;
}

export function mergeImagePrompt(prompt, negativePrompt = "", referenceMode) {
  const positive = requiredText(prompt, "正向提示词", 32_000);
  const negative = optionalText(negativePrompt, "负面提示词", 4_000);
  if (referenceMode && !["source", "reference"].includes(referenceMode)) throw new Error("参考图方式无效。");
  return negative ? `${positive}\n\n负面要求：${negative}` : positive;
}

export function mergeImageEditPrompt(instruction, mode) {
  if (!IMAGE_EDIT_MODES.has(mode)) throw new Error("图片编辑方式无效。");
  return requiredText(instruction, "修改内容", 4_000);
}

export function targetImageSize(ratio = "1:1", resolution = "1k") {
  if (ratio === "custom") throw new Error("自定义尺寸需要同时提供宽度和高度。");
  const ratioConfig = IMAGE_RATIOS[ratio];
  const longEdge = RESOLUTION_LONG_EDGES[resolution];
  if (!ratioConfig) throw new Error("画面比例无效。");
  if (!longEdge) throw new Error("输出分辨率无效。");
  if (ratioConfig.width >= ratioConfig.height) {
    return { width: longEdge, height: Math.round(longEdge * ratioConfig.height / ratioConfig.width) };
  }
  return { width: Math.round(longEdge * ratioConfig.width / ratioConfig.height), height: longEdge };
}

export function resolveTargetImageSize(input = {}) {
  if (input.ratio !== "custom") return targetImageSize(input.ratio || "1:1", input.resolution || "1k");
  const width = Number(input.customWidth);
  const height = Number(input.customHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 512 || width > 4096 || height < 512 || height > 4096) {
    throw new Error("自定义宽高必须是 512 到 4096 之间的整数。");
  }
  if (width * height > 16_777_216) throw new Error("自定义画布不能超过 1677 万像素。");
  return { width, height };
}

function nativeImageSize(input = {}) {
  if (input.ratio !== "custom") return IMAGE_RATIOS[input.ratio || "1:1"]?.nativeSize;
  const target = resolveTargetImageSize(input);
  const ratio = target.width / target.height;
  if (ratio < 0.84) return "1024x1536";
  if (ratio > 1.19) return "1536x1024";
  return "1024x1024";
}

export function buildImageGenerationRequest(input = {}, imageModel = "gpt-image-2") {
  const ratio = input.ratio || "1:1";
  if (ratio !== "custom" && !IMAGE_RATIOS[ratio]) throw new Error("画面比例无效。");
  resolveTargetImageSize({ ...input, ratio });
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

  const mergedPrompt = mergeImagePrompt(
    input.editMode ? mergeImageEditPrompt(input.prompt, input.editMode) : input.prompt,
    input.negativePrompt,
    referenceMode,
  );
  return {
    model: String(imageModel || "").trim(),
    prompt: optionalText(input.copyText, "成品文案", 500)
      ? `${mergedPrompt}\n\n只生成无文字底图，不要在图片中绘制任何文字；成品文案由应用使用真实字体排版。`
      : mergedPrompt,
    size: nativeImageSize({ ...input, ratio }),
    quality,
    output_format: outputFormat,
    background,
    ...((outputFormat === "jpeg" || outputFormat === "webp") ? { output_compression: compression } : {}),
  };
}

function escapeSvgText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function wrapCopyText(value, maxUnits) {
  const output = [];
  for (const paragraph of String(value).split(/\r?\n/)) {
    const characters = Array.from(paragraph.trim());
    if (!characters.length) continue;
    for (let index = 0; index < characters.length; index += maxUnits) output.push(characters.slice(index, index + maxUnits).join(""));
  }
  return output.slice(0, 6);
}

async function applyCopyLayer(image, input) {
  const copyText = optionalText(input.copyText, "成品文案", 500);
  if (!copyText) return image;
  const position = oneOf(input.copyPosition, COPY_POSITIONS, "文案位置", "bottom");
  const style = oneOf(input.copyStyle, COPY_STYLES, "文案样式", "light");
  const scale = oneOf(input.copyScale, COPY_SCALES, "文案字号", "medium");
  const shortEdge = Math.min(image.width, image.height);
  const fontRatio = { small: 0.038, medium: 0.052, large: 0.068 }[scale];
  const fontSize = Math.max(24, Math.round(shortEdge * fontRatio));
  const lineHeight = Math.round(fontSize * 1.28);
  const lines = wrapCopyText(copyText, Math.max(8, Math.floor(image.width / fontSize * 1.7)));
  if (!lines.length) return image;
  const blockHeight = lineHeight * lines.length;
  const padding = Math.round(shortEdge * 0.055);
  const baseline = position === "top"
    ? padding + fontSize
    : position === "center"
      ? Math.round((image.height - blockHeight) / 2) + fontSize
      : image.height - padding - blockHeight + fontSize;
  const fill = style === "light" ? "#ffffff" : "#111827";
  const stroke = style === "light" ? "rgba(15,23,42,0.72)" : "rgba(255,255,255,0.82)";
  const tspans = lines.map((line, index) => `<tspan x="${padding}" y="${baseline + index * lineHeight}">${escapeSvgText(line)}</tspan>`).join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><text font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="${fill}" stroke="${stroke}" stroke-width="${Math.max(1, Math.round(fontSize * 0.045))}" paint-order="stroke" letter-spacing="0">${tspans}</text></svg>`);
  let pipeline = sharp(image.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).composite([{ input: overlay, top: 0, left: 0 }]);
  const compression = input.compression ?? 90;
  if (input.format === "jpeg") pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: compression, chromaSubsampling: "4:4:4", mozjpeg: true });
  else if (input.format === "webp") pipeline = pipeline.webp({ quality: compression, smartSubsample: true });
  else pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  return { ...image, buffer: await pipeline.toBuffer(), copy: { text: copyText, position, style, scale } };
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
  const target = resolveTargetImageSize(input);
  const nativeRatio = native.width / native.height;
  const targetRatio = target.width / target.height;
  const ratioChanged = Math.abs(nativeRatio - targetRatio) >= 0.0001;
  const unchanged = native.width === target.width && native.height === target.height && !ratioChanged;
  const scale = ratioChanged
    ? Math.min(target.width / native.width, target.height / native.height)
    : target.width / native.width;
  const upscaled = scale > 1.0001;
  const processing = unchanged ? "native" : upscaled ? "upscaled" : "fitted";
  const outputFormat = input.format || "png";
  const compression = input.compression ?? 90;
  let pipeline;
  if (ratioChanged) {
    const foreground = await sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({
        width: target.width,
        height: target.height,
        fit: "inside",
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    const left = Math.floor((target.width - foreground.info.width) / 2);
    const top = Math.floor((target.height - foreground.info.height) / 2);
    const right = target.width - foreground.info.width - left;
    const bottom = target.height - foreground.info.height - top;
    if (input.background === "transparent" && outputFormat !== "jpeg") {
      pipeline = sharp({
        create: {
          width: target.width,
          height: target.height,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        },
      }).composite([{ input: foreground.data, left, top }]);
    } else {
      pipeline = sharp(foreground.data, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .extend({ top, bottom, left, right, extendWith: "mirror" });
    }
  } else {
    pipeline = sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize(target.width, target.height, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      });
  }
  if (outputFormat === "jpeg") {
    pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: compression, chromaSubsampling: "4:4:4", mozjpeg: true });
  } else if (outputFormat === "webp") {
    pipeline = pipeline.webp({ quality: compression, smartSubsample: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  const buffer = await pipeline.toBuffer();
  const outputMetadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  const outputDimensions = orientedSize(outputMetadata);
  if (outputDimensions.width !== target.width || outputDimensions.height !== target.height) {
    throw imageError("图片输出尺寸与所选比例不一致，本次未保存。", { code: "IMAGE_RESULT_SIZE_MISMATCH", status: 502, retryable: true });
  }
  return {
    buffer,
    _validationBuffer: sourceBuffer,
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

async function maskedEditChangeMetrics(sourceBuffer, outputBuffer, maskBuffer) {
  const metadata = await sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  const sourceWidth = Number(metadata.autoOrient?.width || metadata.width);
  const sourceHeight = Number(metadata.autoOrient?.height || metadata.height);
  if (!sourceWidth || !sourceHeight) throw imageError("无法读取待编辑原图尺寸。", { code: "IMAGE_EDIT_SOURCE_INVALID" });
  const longEdge = 384;
  const width = sourceWidth >= sourceHeight ? longEdge : Math.max(1, Math.round(longEdge * sourceWidth / sourceHeight));
  const height = sourceHeight >= sourceWidth ? longEdge : Math.max(1, Math.round(longEdge * sourceHeight / sourceWidth));
  const resize = { width, height, fit: "fill", kernel: sharp.kernel.lanczos3 };
  const [source, output, mask] = await Promise.all([
    sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().resize(resize).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(outputBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().resize(resize).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().resize(resize).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let editedPixels = 0;
  let changedPixels = 0;
  let totalDelta = 0;
  let protectedPixels = 0;
  let protectedChangedPixels = 0;
  let protectedTotalDelta = 0;
  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * source.info.channels;
    const outputOffset = index * output.info.channels;
    const red = Math.abs(source.data[sourceOffset] - output.data[outputOffset]);
    const green = Math.abs(source.data[sourceOffset + 1] - output.data[outputOffset + 1]);
    const blue = Math.abs(source.data[sourceOffset + 2] - output.data[outputOffset + 2]);
    const maxDelta = Math.max(red, green, blue);
    const mean = (red + green + blue) / 3;
    if (mask.data[index * mask.info.channels + 3] < 128) {
      editedPixels += 1;
      totalDelta += mean;
      if (maxDelta >= 12) changedPixels += 1;
    } else {
      protectedPixels += 1;
      protectedTotalDelta += mean;
      if (maxDelta >= 12) protectedChangedPixels += 1;
    }
  }
  return {
    editedPixels,
    changedRatio: editedPixels ? changedPixels / editedPixels : 0,
    meanDelta: editedPixels ? totalDelta / editedPixels : 0,
    protectedPixels,
    protectedChangedRatio: protectedPixels ? protectedChangedPixels / protectedPixels : 0,
    protectedMeanDelta: protectedPixels ? protectedTotalDelta / protectedPixels : 0,
  };
}

async function referenceEditChangeMetrics(sourceBuffer, outputBuffer, target) {
  const longEdge = 384;
  const width = target.width >= target.height ? longEdge : Math.max(1, Math.round(longEdge * target.width / target.height));
  const height = target.height >= target.width ? longEdge : Math.max(1, Math.round(longEdge * target.height / target.width));
  const resize = { width, height, fit: "cover", position: "centre", kernel: sharp.kernel.lanczos3 };
  const [source, output] = await Promise.all([
    sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().resize(resize).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(outputBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate().resize(resize).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let changedPixels = 0;
  let totalDelta = 0;
  const pixelCount = width * height;
  for (let index = 0; index < pixelCount; index += 1) {
    const sourceOffset = index * source.info.channels;
    const outputOffset = index * output.info.channels;
    const red = Math.abs(source.data[sourceOffset] - output.data[outputOffset]);
    const green = Math.abs(source.data[sourceOffset + 1] - output.data[outputOffset + 1]);
    const blue = Math.abs(source.data[sourceOffset + 2] - output.data[outputOffset + 2]);
    totalDelta += (red + green + blue) / 3;
    if (Math.max(red, green, blue) >= 12) changedPixels += 1;
  }
  return {
    changedRatio: pixelCount ? changedPixels / pixelCount : 0,
    meanDelta: pixelCount ? totalDelta / pixelCount : 0,
  };
}

async function validateAndRankMaskedEdits(prepared, images) {
  if (!prepared.mask || !prepared.references[0] || !images.length) return;
  const accepted = [];
  let lastFailure = null;
  for (const image of images) {
    const metrics = await maskedEditChangeMetrics(prepared.references[0].buffer, image._validationBuffer || image.buffer, prepared.mask.buffer);
    if (metrics.editedPixels < 16) {
      lastFailure = imageError("框选区域太小，无法确认修改结果，请重新框选后再试。", {
        code: "IMAGE_EDIT_MASK_TOO_SMALL",
        status: 422,
        retryable: true,
      });
      continue;
    }
    if (metrics.changedRatio < 0.01 && metrics.meanDelta < 3) {
      lastFailure = imageError("模型返回的框选区域几乎没有变化，任务未标记为完成。请调整批注文字后重试。", {
        code: "IMAGE_EDIT_NO_VISIBLE_CHANGE",
        status: 422,
        retryable: true,
      });
      continue;
    }
    if (metrics.protectedPixels >= 16 && metrics.protectedChangedRatio > 0.08 && metrics.protectedMeanDelta > 8) {
      lastFailure = imageError("候选图改动了框选区域之外的内容，已自动淘汰。请缩小框选范围或重试。", {
        code: "IMAGE_EDIT_OUTSIDE_MASK_CHANGED",
        status: 422,
        retryable: true,
      });
      continue;
    }
    const score = Math.max(0, Math.min(100, Math.round(
      metrics.changedRatio * 45
      + Math.min(1, metrics.meanDelta / 48) * 25
      + (1 - metrics.protectedChangedRatio) * 20
      + (1 - Math.min(1, metrics.protectedMeanDelta / 24)) * 10,
    )));
    accepted.push({ ...image, validation: { ...metrics, score, passed: true } });
  }
  if (!accepted.length) throw lastFailure || imageError("没有候选图通过局部编辑保护校验。", { code: "IMAGE_EDIT_VALIDATION_FAILED", status: 422, retryable: true });
  accepted.sort((left, right) => right.validation.score - left.validation.score);
  return accepted;
}

async function validateAndRankReferenceEdits(prepared, images, input) {
  if (!prepared.references[0] || !images.length) return images;
  const target = resolveTargetImageSize(input);
  const validationReference = prepared.validationReference || prepared.references[0];
  const accepted = [];
  for (const image of images) {
    const metrics = await referenceEditChangeMetrics(validationReference.buffer, image._validationBuffer || image.buffer, target);
    if (metrics.changedRatio < 0.06 || metrics.meanDelta < 2) continue;
    const score = Math.max(0, Math.min(100, Math.round(
      metrics.changedRatio * 65 + Math.min(1, metrics.meanDelta / 32) * 35,
    )));
    accepted.push({ ...image, validation: { ...metrics, score, passed: true } });
  }
  if (!accepted.length) {
    throw imageError("图片模型返回的结果只包含裁切、压缩或轻微像素变化，没有完成有效修改，本次未标记为成功。请重试或把修改目标写得更具体。", {
      code: "IMAGE_EDIT_NO_VISIBLE_CHANGE",
      status: 422,
      retryable: true,
    });
  }
  return accepted.sort((left, right) => right.validation.score - left.validation.score);
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

async function prepareOutpaintFiles(prepared, nativeSize, compositionMode) {
  if (!prepared.references[0]) throw imageError("扩图缺少待扩展的原图。", { code: "IMAGE_EDIT_SOURCE_MISSING" });
  if (prepared.mask) throw imageError("扩图会自动建立保护区域，请不要同时上传局部蒙版。", { code: "IMAGE_EDIT_MODE_MISMATCH" });
  const [canvasWidth, canvasHeight] = String(nativeSize).split("x").map(Number);
  if (!canvasWidth || !canvasHeight) throw imageError("扩图画布尺寸无效。", { code: "IMAGE_RESULT_SIZE_MISMATCH" });
  const source = prepared.references[0];
  const scale = compositionMode === "smart" ? 0.78 : 0.92;
  const resized = await sharp(source.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate()
    .resize({
      width: Math.max(1, Math.round(canvasWidth * scale)),
      height: Math.max(1, Math.round(canvasHeight * scale)),
      fit: "inside",
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((canvasWidth - resized.info.width) / 2);
  const top = Math.round((canvasHeight - resized.info.height) / 2);
  const canvas = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  }).composite([{ input: resized.data, left, top }]).png().toBuffer();
  const maskPixels = Buffer.alloc(canvasWidth * canvasHeight * 4);
  for (let row = top; row < top + resized.info.height; row += 1) {
    const start = (row * canvasWidth + left) * 4;
    const end = start + resized.info.width * 4;
    for (let offset = start; offset < end; offset += 4) maskPixels[offset + 3] = 255;
  }
  const maskBuffer = await sharp(maskPixels, { raw: { width: canvasWidth, height: canvasHeight, channels: 4 } }).png().toBuffer();
  const [reference, mask] = await Promise.all([
    validateReferenceFile({ buffer: canvas, mimetype: "image/png", originalname: "outpaint-source.png" }, { index: 0 }),
    validateReferenceFile({ buffer: maskBuffer, mimetype: "image/png", originalname: "outpaint-mask.png" }, { mask: true }),
  ]);
  return { references: [reference, ...prepared.references.slice(1)], mask, outpaintPrepared: true };
}

async function prepareReferenceCanvas(prepared, nativeSize) {
  if (!prepared.references[0]) return prepared;
  const [canvasWidth, canvasHeight] = String(nativeSize).split("x").map(Number);
  if (!canvasWidth || !canvasHeight) throw imageError("参考图画布尺寸无效。", { code: "IMAGE_RESULT_SIZE_MISMATCH" });
  const source = prepared.references[0];
  if (source.width === canvasWidth && source.height === canvasHeight) return prepared;
  const resized = await sharp(source.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate()
    .resize({
      width: canvasWidth,
      height: canvasHeight,
      fit: "inside",
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasWidth - resized.info.width) / 2);
  const top = Math.floor((canvasHeight - resized.info.height) / 2);
  const canvas = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  }).composite([{ input: resized.data, left, top }]).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const reference = await validateReferenceFile({
    buffer: canvas,
    mimetype: "image/png",
    originalname: "oriented-reference.png",
  }, { index: 0 });
  let mask = prepared.mask;
  if (mask) {
    const resizedMask = await sharp(mask.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize(resized.info.width, resized.info.height, { fit: "fill", kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
    const maskCanvas = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite([{ input: resizedMask, left, top }]).png().toBuffer();
    mask = await validateReferenceFile({
      buffer: maskCanvas,
      mimetype: "image/png",
      originalname: "oriented-mask.png",
    }, { mask: true });
  }
  return {
    ...prepared,
    references: [reference, ...prepared.references.slice(1)],
    mask,
    validationReference: prepared.validationReference || source,
    referenceCanvasPrepared: true,
  };
}

async function createAutomaticProductMask(reference) {
  const sample = await sharp(reference.buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate()
    .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = sample.info;
  const cornerPoints = [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]];
  const corners = cornerPoints.map(([x, y]) => {
    const offset = (y * width + x) * channels;
    return [sample.data[offset], sample.data[offset + 1], sample.data[offset + 2]];
  });
  const background = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, color) => sum + color[channel], 0) / corners.length));
  const cornerSpread = Math.max(...corners.flatMap((color) => color.map((value, channel) => Math.abs(value - background[channel]))));
  const maskPixels = Buffer.alloc(width * height * 4);
  let subjectPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * channels;
    const alpha = sample.data[sourceOffset + 3];
    const distance = Math.max(
      Math.abs(sample.data[sourceOffset] - background[0]),
      Math.abs(sample.data[sourceOffset + 1] - background[1]),
      Math.abs(sample.data[sourceOffset + 2] - background[2]),
    );
    const subject = alpha >= 48 && distance >= Math.max(22, cornerSpread * 1.7);
    const targetOffset = index * 4;
    if (subject) {
      subjectPixels += 1;
      maskPixels[targetOffset + 3] = 255;
    }
  }
  const subjectRatio = subjectPixels / Math.max(1, width * height);
  const backgroundScore = Math.max(0, 1 - cornerSpread / 64);
  const coverageScore = subjectRatio >= 0.03 && subjectRatio <= 0.78 ? 1 : subjectRatio > 0.005 && subjectRatio < 0.92 ? 0.5 : 0;
  const confidence = Math.round(backgroundScore * coverageScore * 100) / 100;
  const maskBuffer = await sharp(maskPixels, { raw: { width, height, channels: 4 } })
    .blur(1.2)
    .resize(reference.width, reference.height, { fit: "fill", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  return { maskBuffer, confidence, subjectRatio };
}

async function prepareBackgroundFiles(prepared, compositionMode, nativeSize) {
  if (!prepared.references[0] || prepared.mask) return prepared;
  if (compositionMode === "smart") return prepareReferenceCanvas(prepared, nativeSize);
  const detected = await createAutomaticProductMask(prepared.references[0]);
  if (detected.confidence < 0.48) {
    throw imageError("自动主体保护置信度不足，本次未提交模型。请换一张主体边缘更清楚的原图，或在图片详情中使用“批注编辑”手动框选。", {
      code: "IMAGE_PRODUCT_MASK_LOW_CONFIDENCE",
      status: 422,
      retryable: true,
    });
  }
  const mask = await validateReferenceFile({
    buffer: detected.maskBuffer,
    mimetype: "image/png",
    originalname: "automatic-product-mask.png",
  }, { mask: true });
  return prepareReferenceCanvas({
    ...prepared,
    mask,
    productMaskConfidence: detected.confidence,
    productMaskSubjectRatio: detected.subjectRatio,
  }, nativeSize);
}

function generationWarnings(input, body, edit) {
  const output = resolveTargetImageSize(input);
  const warnings = [];
  if (body.size !== `${output.width}x${output.height}`) {
    warnings.push(`模型按原生尺寸 ${body.size} 生成，已由本机保留完整主体并连续扩展边缘至 ${output.width}x${output.height}，不会拉伸或裁切产品。`);
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
  let prepared = await prepareEditFiles(input, referenceImages, maskImage, sourceImageOverride);
  const edit = prepared.references.length > 0;
  const editIntent = edit ? oneOf(input.editIntent, IMAGE_EDIT_INTENTS, "图片编辑模式", prepared.mask ? "local" : "redraw") : undefined;
  const compositionMode = edit ? oneOf(input.compositionMode, COMPOSITION_MODES, "主体构图方式", "keep") : undefined;
  if (prepared.mask && input.editMode && !["mask", "annotation"].includes(input.editMode)) {
    throw imageError("蒙版文件与当前图片编辑方式不匹配。", { code: "IMAGE_EDIT_MODE_MISMATCH" });
  }
  const editMode = input.editMode || (prepared.mask ? "mask" : undefined);
  if (editMode === "mask" && !prepared.mask) {
    throw imageError("蒙版重绘缺少有效蒙版文件。", { code: "IMAGE_EDIT_MASK_MISSING" });
  }
  if (editMode === "annotation" && (!input.sourceImageId || prepared.references.length < 2 || !prepared.mask)) {
    throw imageError("框选批注需要待编辑原图、批注图和编辑蒙版。", { code: "IMAGE_EDIT_ANNOTATION_MISSING" });
  }
  if (editMode && !edit) throw imageError("图片编辑缺少待编辑原图。", { code: "IMAGE_EDIT_SOURCE_MISSING" });
  if (editIntent === "local" && !prepared.mask) {
    throw imageError("局部编辑必须先框选或提供蒙版。", { code: "IMAGE_EDIT_MASK_MISSING" });
  }
  const referenceMode = !editMode && edit ? (input.sourceImageId ? "source" : "reference") : undefined;
  const normalizedInput = { ...input, editMode, editIntent, compositionMode, referenceMode };
  const requestedCount = normalizedInput.count ?? 1;
  const body = buildImageGenerationRequest(normalizedInput, resolved.imageModel);
  if (editIntent === "outpaint") prepared = await prepareOutpaintFiles(prepared, body.size, compositionMode);
  else if (editIntent === "background") prepared = await prepareBackgroundFiles(prepared, compositionMode, body.size);
  else if (editIntent === "redraw") prepared = await prepareReferenceCanvas(prepared, body.size);
  let responses;
  try {
    responses = await Promise.all(Array.from({ length: requestedCount }, () => (
      requestModelApiJson(edit ? imageEditEndpoint(resolved.baseUrl) : imageGenerationEndpoint(resolved.baseUrl), {
        apiKey: resolved.apiKey,
        body: edit ? editFormData(body, prepared.references, prepared.mask) : body,
        fetchImpl,
        label: edit ? "AI 参考图编辑" : "AI 生图",
        signal,
        timeoutMs,
      })
    )));
  } catch (error) {
    if (edit && [404, 405].includes(error?.status)) {
      throw imageError("当前兼容网关不支持参考图编辑接口，请更换支持 /images/edits 的图片模型服务。", { code: "IMAGE_EDIT_UNSUPPORTED", status: 422 });
    }
    throw error;
  }
  const parsed = responses.flatMap((data) => parseImageGenerationResponse(data, { format: body.output_format }));
  const images = [];
  for (const image of parsed) images.push(await transformGeneratedImage(image, normalizedInput, { fetchImpl, signal, remoteImageTimeoutMs }));
  const validatedImages = prepared.mask
    ? await validateAndRankMaskedEdits(prepared, images)
    : edit
      ? await validateAndRankReferenceEdits(prepared, images, normalizedInput)
      : images;
  const composedImages = [];
  for (const image of validatedImages) {
    const { _validationBuffer, ...publicImage } = image;
    composedImages.push(await applyCopyLayer(publicImage, normalizedInput));
  }
  const output = resolveTargetImageSize(normalizedInput);
  return {
    images: composedImages,
    model: resolved.imageModel,
    requestedCount,
    generatedCount: composedImages.length,
    size: `${output.width}x${output.height}`,
    nativeRequestSize: body.size,
    created: responses.map((data) => data.created).find(Number.isFinite) ?? null,
    usage: responses.map((data) => data.usage).find((usage) => usage && typeof usage === "object") || null,
    warnings: generationWarnings(input, body, edit),
    appliedOptions: {
      mode: edit ? "edit" : "generate",
      referenceImageCount: prepared.references.length,
      maskApplied: Boolean(prepared.mask),
      editIntent: editIntent || null,
      compositionMode: compositionMode || null,
      candidateRankingApplied: Boolean(prepared.mask && images.length > 1),
      outpaintPrepared: Boolean(prepared.outpaintPrepared),
      referenceCanvasPrepared: Boolean(prepared.referenceCanvasPrepared),
      productMaskConfidence: prepared.productMaskConfidence ?? null,
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
    ratio: IMAGE_RATIOS[record.ratio] || record.ratio === "custom" ? record.ratio : "1:1",
    customWidth: record.ratio === "custom" ? Number(record.customWidth) || undefined : undefined,
    customHeight: record.ratio === "custom" ? Number(record.customHeight) || undefined : undefined,
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
    processing: ["native", "cropped", "upscaled", "fitted"].includes(record.processing) ? record.processing : "native",
    validation: record.validation && Number.isFinite(record.validation.score) ? {
      score: Math.max(0, Math.min(100, Math.round(record.validation.score))),
      passed: record.validation.passed !== false,
      changedRatio: Number(record.validation.changedRatio) || 0,
      meanDelta: Number(record.validation.meanDelta) || 0,
      protectedChangedRatio: Number(record.validation.protectedChangedRatio) || 0,
      protectedMeanDelta: Number(record.validation.protectedMeanDelta) || 0,
    } : undefined,
    isFavorite: Boolean(record.isFavorite),
    isArchived: Boolean(record.isArchived),
    revisedPrompt: String(record.revisedPrompt || "").slice(0, 4_000),
    parentImageId: IMAGE_ID_PATTERN.test(record.parentImageId || "") ? record.parentImageId : null,
    referenceImageCount: Math.max(0, Math.min(MAX_REFERENCE_FILES, Number(record.referenceImageCount) || 0)),
    maskApplied: Boolean(record.maskApplied),
    editIntent: IMAGE_EDIT_INTENTS.has(record.editIntent) ? record.editIntent : undefined,
    compositionMode: COMPOSITION_MODES.has(record.compositionMode) ? record.compositionMode : undefined,
    productMaskConfidence: Number.isFinite(record.productMaskConfidence) ? Math.max(0, Math.min(1, record.productMaskConfidence)) : undefined,
    copy: record.copy && typeof record.copy.text === "string" ? {
      text: record.copy.text.slice(0, 500),
      position: COPY_POSITIONS.has(record.copy.position) ? record.copy.position : "bottom",
      style: COPY_STYLES.has(record.copy.style) ? record.copy.style : "light",
      scale: COPY_SCALES.has(record.copy.scale) ? record.copy.scale : "medium",
    } : undefined,
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
    revisedPrompt: INTERNAL_REVISED_PROMPT_PATTERN.test(publicRecord.revisedPrompt) ? "" : publicRecord.revisedPrompt,
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
          customWidth: context.customWidth,
          customHeight: context.customHeight,
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
          validation: image.validation,
          isFavorite: false,
          isArchived: false,
          revisedPrompt: image.revisedPrompt,
          parentImageId: context.sourceImageId,
          referenceImageCount: context.referenceImageCount,
          maskApplied: context.maskApplied,
          editIntent: context.editIntent,
          compositionMode: context.compositionMode,
          productMaskConfidence: context.productMaskConfidence,
          copy: image.copy,
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
