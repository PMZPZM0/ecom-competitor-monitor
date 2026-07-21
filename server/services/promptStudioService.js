import { z } from "zod";
import { explicitlyRequestsNoText, extractExplicitPosterCopy, hasPosterIntent } from "../utils/promptIntent.js";
import { ModelApiError, requestModelApiJson, resolveModelConfig } from "./modelConfigService.js";

export const PROMPT_STUDIO_CATEGORIES = Object.freeze([
  "white-background",
  "product-scene",
  "campaign-poster",
  "detail-page",
  "local-edit",
  "background-swap",
  "product-retouch",
]);

export const PROMPT_STUDIO_STATE_LIMITS = Object.freeze({
  productProfiles: 100,
  stylePresets: 100,
  records: 500,
  quickRequests: 50,
  libraryFavorites: 100,
});

export const PROMPT_STUDIO_OUTPUT_LIMITS = Object.freeze({
  prompt: 4_000,
  negativePrompt: 2_000,
});

const FINAL_PROMPT_SEPARATOR = "\n\n";
const NEGATIVE_PROMPT_RULES_MARKER = "以下为服务端基础排除规则（自动执行，无需编辑）：";
const MODEL_NEGATIVE_PROMPT_LIMIT = 1_600;
const LOCAL_FALLBACK_MODEL = "本地规则保底";
const PROMPT_RETRYABLE_STATUSES = new Set([502, 503, 504]);
const FREEFORM_PROMPT_RETRYABLE_STATUSES = new Set([...PROMPT_RETRYABLE_STATUSES, 524]);
const PROMPT_RETRY_MIN_DELAY_MS = 180;
const PROMPT_RETRY_JITTER_MS = 220;
export const QUICK_PROMPT_PIPELINE_VERSION = 2;

const CATEGORY_RULES = Object.freeze({
  "white-background": "使用纯净白底，主体完整清晰、边缘自然，保留合理接触阴影；不得增加场景道具、促销贴纸或无关装饰。",
  "product-scene": "产品必须是画面主角，场景与真实使用方式一致，道具只能辅助叙事；不得遮挡关键结构、Logo 或操作区域。",
  "campaign-poster": "建立明确的电商视觉层级并保留安全留白；不得虚构价格、优惠、规格、功效、品牌或活动信息。",
  "detail-page": "围绕单一卖点建立清晰的信息层级，产品结构和功能演示必须符合真实使用逻辑；不得虚构功能或效果。",
  "local-edit": "只能修改明确指定的目标区域和内容，未指定区域逐像素语义保持，尤其不得连带修改产品结构、文字、Logo、视角和构图。",
  "background-swap": "只能替换背景并重建自然的边缘、接触阴影和环境反射；产品主体、文字、Logo、比例、结构、视角和位置必须保持不变。",
  "product-retouch": "仅改善清晰度、材质、光泽、污点和商业质感；不得改变产品结构、比例、颜色定义、零部件、文字或品牌。",
});

const VARIANT_TITLES = Object.freeze({
  safe: "稳妥执行",
  commercial: "商业增强",
  creative: "创意方案",
});

const boundedText = (max, { required = false } = {}) => {
  const schema = z.string().trim().max(max);
  return required ? schema.min(1) : schema.default("");
};

const boundedList = (maxItems, maxLength) => z.array(boundedText(maxLength, { required: true })).max(maxItems).default([]);

export const promptLibraryTemplateIdSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9-]+$/, "提示词模板 ID 只能包含小写字母、数字和连字符。");

export const productFactsSchema = z.object({
  productType: boundedText(120, { required: true }),
  appearance: boundedText(1_000, { required: true }),
  colorsMaterials: boundedText(1_000, { required: true }),
  components: boundedList(24, 200),
  logo: boundedText(300),
  existingText: boundedList(24, 300),
  mustPreserve: boundedList(24, 300),
  forbiddenChanges: boundedList(24, 300),
}).strict();

export const styleSchema = z.object({
  name: boundedText(100),
  description: boundedText(1_000, { required: true }),
  lighting: boundedText(500),
  composition: boundedText(500),
  palette: boundedText(500),
  camera: boundedText(500),
  forbidden: boundedList(20, 200),
}).strict();

export const copySchema = z.object({
  mode: z.enum(["none", "reserved", "exact"]),
  title: boundedText(300),
  subtitle: boundedText(500),
  sellingPoints: boundedList(12, 300),
  price: boundedText(100),
  campaignInfo: boundedText(500),
  additionalText: boundedList(12, 300),
}).strict().superRefine((copy, context) => {
  const hasCopy = Boolean(copy.title || copy.subtitle || copy.price || copy.campaignInfo
    || copy.sellingPoints.length || copy.additionalText.length);
  if (copy.mode === "exact" && !hasCopy) {
    context.addIssue({ code: "custom", message: "直接生成文字时至少填写一项准确文案。" });
  }
  if (copy.mode !== "exact" && hasCopy) {
    context.addIssue({ code: "custom", message: "无字或预留文案区模式不能携带待生成文案。" });
  }
});

export const promptParametersSchema = z.object({
  ratio: z.enum(["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9"]),
  resolution: z.enum(["1k", "2k", "4k"]),
  quality: z.enum(["low", "medium", "high"]),
  background: z.enum(["auto", "opaque", "transparent"]),
}).strict();

const QUICK_PROMPT_DEFAULT_PARAMETERS = Object.freeze({
  ratio: "1:1",
  resolution: "2k",
  quality: "high",
  background: "auto",
});

const quickPromptInputSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  userRequest: boundedText(4_000, { required: true }),
  parameters: promptParametersSchema.default(QUICK_PROMPT_DEFAULT_PARAMETERS),
  creationMode: z.enum(["product", "free"]).optional(),
  saveHistory: z.boolean().default(true),
}).strict();

export const editBoundarySchema = z.object({
  targetAreas: boundedList(12, 300),
  changes: boundedList(12, 500),
  preserveAreas: boundedList(20, 300),
}).strict();

export const promptStudioInputSchema = z.object({
  category: z.enum(PROMPT_STUDIO_CATEGORIES),
  userRequest: boundedText(4_000, { required: true }),
  productFacts: productFactsSchema,
  style: styleSchema,
  copy: copySchema,
  parameters: promptParametersSchema,
  editBoundary: editBoundarySchema,
}).strict().superRefine((input, context) => {
  const negativeStyle = input.style.forbidden.join("；");
  if (input.copy.mode === "exact" && /(无字|无文字|不要文字|去除文字|删除文字|移除文字|no\s*text)/i.test(`${input.userRequest}；${negativeStyle}`)) {
    context.addIssue({ code: "custom", path: ["copy", "mode"], message: "准确文案与无字要求冲突，请保留一种文字模式。" });
  }
  if (input.productFacts.logo && /(无\s*logo|不要\s*logo|去除\s*logo|删除\s*logo|移除\s*logo)/i.test(`${input.userRequest}；${negativeStyle}`)) {
    context.addIssue({ code: "custom", path: ["productFacts", "logo"], message: "Logo 保留事实与去除 Logo 要求冲突。" });
  }
  if (input.category === "white-background" && input.parameters.background === "transparent") {
    context.addIssue({ code: "custom", path: ["parameters", "background"], message: "白底主图不能使用透明背景。" });
  }
  if (!["local-edit", "background-swap"].includes(input.category)) return;
  for (const field of ["targetAreas", "changes", "preserveAreas"]) {
    if (!input.editBoundary[field].length) {
      context.addIssue({
        code: "custom",
        path: ["editBoundary", field],
        message: `${input.category === "local-edit" ? "局部改图" : "换背景"}必须填写完整修改边界。`,
      });
    }
  }
});

const analysisInputSchema = z.object({
  productName: boundedText(200).optional(),
  notes: boundedText(2_000).optional(),
  existingFacts: z.object({
    productType: boundedText(120).optional(),
    appearance: boundedText(1_000).optional(),
    colorsMaterials: boundedText(1_000).optional(),
    components: boundedList(24, 200).optional(),
    logo: boundedText(300).optional(),
    existingText: boundedList(24, 300).optional(),
    mustPreserve: boundedList(24, 300).optional(),
    forbiddenChanges: boundedList(24, 300).optional(),
  }).strict().optional(),
}).strict();

const analysisResultSchema = z.object({
  facts: productFactsSchema,
  confidence: z.number().min(0).max(1),
  warnings: boundedList(20, 500),
}).strict();

const modelVariantSchema = z.object({
  prompt: boundedText(8_000, { required: true }),
  negativePrompt: boundedText(2_000),
  rationale: boundedText(1_000, { required: true }),
}).strict();

const modelPromptSetSchema = z.object({
  safe: modelVariantSchema,
  commercial: modelVariantSchema,
  creative: modelVariantSchema,
}).strict();

const quickPromptResultSchema = z.object({
  category: z.enum(PROMPT_STUDIO_CATEGORIES),
  productFacts: productFactsSchema,
  style: styleSchema,
  copy: copySchema,
  editBoundary: editBoundarySchema,
  warnings: boundedList(20, 500),
  recommendedVariantKey: z.enum(["safe", "commercial", "creative"]),
}).strict();

const storedTimestampSchema = boundedText(64, { required: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "时间格式无效。");

export const promptProductProfileStorageSchema = productFactsSchema.extend({
  id: boundedText(200, { required: true }),
  name: boundedText(120, { required: true }),
  updatedAt: storedTimestampSchema,
}).strict();

export const promptStylePresetStorageSchema = styleSchema.extend({
  id: boundedText(200, { required: true }),
  name: boundedText(100, { required: true }),
  updatedAt: storedTimestampSchema,
}).strict();

const storedPromptVariantSchema = z.object({
  title: boundedText(100, { required: true }),
  prompt: boundedText(4_000, { required: true }),
  negativePrompt: boundedText(2_000),
  rationale: boundedText(1_000, { required: true }),
  recommendedParameters: promptParametersSchema.partial().optional(),
}).strict();

const storedRiskCheckSchema = z.object({
  id: boundedText(100, { required: true }),
  label: boundedText(100, { required: true }),
  status: z.enum(["pass", "warning", "error"]),
  message: boundedText(1_000, { required: true }),
}).strict();

export const promptHistoryStorageSchema = z.object({
  id: boundedText(200, { required: true }),
  name: boundedText(120, { required: true }),
  category: z.enum(PROMPT_STUDIO_CATEGORIES),
  request: promptStudioInputSchema,
  variants: z.object({
    safe: storedPromptVariantSchema,
    commercial: storedPromptVariantSchema,
    creative: storedPromptVariantSchema,
  }).strict(),
  riskChecks: z.array(storedRiskCheckSchema).max(20),
  selectedVariantKey: z.enum(["safe", "commercial", "creative"]),
  isFavorite: z.boolean(),
  createdAt: storedTimestampSchema,
  model: boundedText(200, { required: true }),
}).strict();

const quickPromptRequestStorageSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  response: z.record(z.string(), z.unknown()),
  createdAt: storedTimestampSchema,
  pipelineVersion: z.number().int().min(1).max(100).default(1),
}).strict();

function promptError(message, { code = "PROMPT_STUDIO_INVALID", status = 400 } = {}) {
  return new ModelApiError(message, { code, status });
}

function parseBoundary(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}：` : "";
  throw promptError(`${label}${path}${issue?.message || "输入无效。"}`, { code: "PROMPT_STUDIO_INPUT_INVALID" });
}

export function validatePromptStudioInput(input) {
  return parseBoundary(promptStudioInputSchema, input, "提示词工作台输入无效：");
}

export function validateQuickPromptInput(input) {
  return parseBoundary(quickPromptInputSchema, input, "快捷提示词输入无效：");
}

function outputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chatContent = data?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string" && chatContent.trim()) return chatContent.trim();
  if (Array.isArray(chatContent)) {
    const chatText = chatContent.map((item) => typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n").trim();
    if (chatText) return chatText;
  }
  const text = Array.isArray(data?.output)
    ? data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((item) => typeof item?.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n")
      .trim()
    : "";
  return text;
}

function parseModelResult(data, schema, label) {
  const text = outputText(data);
  if (!text) {
    throw promptError(`${label}没有返回结构化结果。`, { code: "PROMPT_MODEL_EMPTY_RESPONSE", status: 502 });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw promptError(`${label}没有返回有效 JSON，请检查所选模型是否支持结构化输出。`, {
      code: "PROMPT_MODEL_INVALID_JSON",
      status: 502,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw promptError(`${label}返回字段不完整：${issue?.path?.join(".") || "根对象"} ${issue?.message || "无效"}。`, {
      code: "PROMPT_MODEL_SCHEMA_INVALID",
      status: 502,
    });
  }
  return parsed.data;
}

function promptRequestFetch(fetchImpl, idempotencyKey) {
  const key = String(idempotencyKey || "").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 200);
  if (!key) return { fetchImpl, key: "" };
  return {
    key,
    fetchImpl: (url, init = {}) => fetchImpl(url, {
      ...init,
      headers: { ...init.headers, "idempotency-key": key },
    }),
  };
}

async function requestPromptModelApiJson(url, options, {
  idempotencyKey = "",
  random = Math.random,
  retryableStatuses = PROMPT_RETRYABLE_STATUSES,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  const requestFetch = promptRequestFetch(options.fetchImpl || globalThis.fetch, idempotencyKey);
  const request = () => requestModelApiJson(url, { ...options, fetchImpl: requestFetch.fetchImpl });
  try {
    return await request();
  } catch (error) {
    const retryable = requestFetch.key
      && error instanceof ModelApiError
      && error.code !== "MODEL_API_TIMEOUT"
      && (error.code === "MODEL_API_NETWORK_ERROR" || retryableStatuses.has(error.status));
    if (!retryable) throw error;
    const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * PROMPT_RETRY_JITTER_MS);
    await sleep(PROMPT_RETRY_MIN_DELAY_MS + jitter);
    return request();
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;

function imageDataUrls(files, { label, required = false } = {}) {
  if (!Array.isArray(files)) throw promptError(`${label}必须是文件数组。`, { code: "PROMPT_IMAGE_INPUT_INVALID" });
  if (required && !files.length) throw promptError(`请至少上传一张${label}。`, { code: "PROMPT_IMAGE_REQUIRED" });
  return files.map((file, index) => {
    const mimetype = String(file?.mimetype || "").toLowerCase();
    if (!IMAGE_TYPES.has(mimetype)) {
      throw promptError(`${label}第 ${index + 1} 张格式无效，仅支持 PNG、JPEG 和 WEBP。`, { code: "PROMPT_IMAGE_TYPE_INVALID" });
    }
    if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) {
      throw promptError(`${label}第 ${index + 1} 张缺少有效图片数据。`, { code: "PROMPT_IMAGE_DATA_INVALID" });
    }
    if (file.buffer.length > MAX_IMAGE_BYTES) {
      throw promptError(`${label}第 ${index + 1} 张超过 8 MB，请压缩后重试。`, {
        code: "PROMPT_IMAGE_TOO_LARGE",
        status: 413,
      });
    }
    return { bytes: file.buffer.length, url: `data:${mimetype};base64,${file.buffer.toString("base64")}` };
  });
}

function validateImageTotal(groups) {
  const images = groups.flat();
  if (images.length > 4) throw promptError("产品参考图和风格参考图合计最多 4 张。", { code: "PROMPT_IMAGE_COUNT_EXCEEDED" });
  if (images.reduce((sum, image) => sum + image.bytes, 0) > MAX_TOTAL_IMAGE_BYTES) {
    throw promptError("参考图合计不能超过 32 MB。", { code: "PROMPT_IMAGE_TOTAL_TOO_LARGE", status: 413 });
  }
}

function inputImages(images) {
  return images.map((image) => ({ type: "input_image", image_url: image.url }));
}

const productFactsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["productType", "appearance", "colorsMaterials", "components", "logo", "existingText", "mustPreserve", "forbiddenChanges"],
  properties: {
    productType: { type: "string" },
    appearance: { type: "string" },
    colorsMaterials: { type: "string" },
    components: { type: "array", items: { type: "string" } },
    logo: { type: "string" },
    existingText: { type: "array", items: { type: "string" } },
    mustPreserve: { type: "array", items: { type: "string" } },
    forbiddenChanges: { type: "array", items: { type: "string" } },
  },
};

const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "confidence", "warnings"],
  properties: {
    facts: productFactsJsonSchema,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } },
  },
};

const variantJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "negativePrompt", "rationale"],
  properties: {
    prompt: { type: "string" },
    negativePrompt: { type: "string" },
    rationale: { type: "string" },
  },
};

const promptSetJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["safe", "commercial", "creative"],
  properties: {
    safe: variantJsonSchema,
    commercial: variantJsonSchema,
    creative: variantJsonSchema,
  },
};

const styleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "lighting", "composition", "palette", "camera", "forbidden"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    lighting: { type: "string" },
    composition: { type: "string" },
    palette: { type: "string" },
    camera: { type: "string" },
    forbidden: { type: "array", items: { type: "string" } },
  },
};

const copyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "title", "subtitle", "sellingPoints", "price", "campaignInfo", "additionalText"],
  properties: {
    mode: { type: "string", enum: ["none", "reserved", "exact"] },
    title: { type: "string" },
    subtitle: { type: "string" },
    sellingPoints: { type: "array", items: { type: "string" } },
    price: { type: "string" },
    campaignInfo: { type: "string" },
    additionalText: { type: "array", items: { type: "string" } },
  },
};

const editBoundaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetAreas", "changes", "preserveAreas"],
  properties: {
    targetAreas: { type: "array", items: { type: "string" } },
    changes: { type: "array", items: { type: "string" } },
    preserveAreas: { type: "array", items: { type: "string" } },
  },
};

const quickPromptJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "productFacts", "style", "copy", "editBoundary", "warnings", "recommendedVariantKey"],
  properties: {
    category: { type: "string", enum: PROMPT_STUDIO_CATEGORIES },
    productFacts: productFactsJsonSchema,
    style: styleJsonSchema,
    copy: copyJsonSchema,
    editBoundary: editBoundaryJsonSchema,
    warnings: { type: "array", items: { type: "string" } },
    recommendedVariantKey: { type: "string", enum: ["safe", "commercial", "creative"] },
  },
};

export async function analyzeProductImages(modelConfig = {}, input = {}, imageFiles = [], {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  signal,
  timeoutMs = 90_000,
} = {}) {
  const requestInput = parseBoundary(analysisInputSchema, input, "产品识别输入无效：");
  const images = imageDataUrls(imageFiles, { label: "产品参考图", required: true });
  validateImageTotal([images]);
  const resolved = resolveModelConfig(modelConfig, { env });
  const data = await requestModelApiJson(`${resolved.baseUrl}/responses`, {
    apiKey: resolved.apiKey,
    fetchImpl,
    label: "产品参考图识别",
    signal,
    timeoutMs,
    body: {
      model: resolved.model,
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: "你是严谨的电商产品事实识别器。只记录图片中可以确认的事实，不猜测型号、材质、功能、文字或品牌；无法确认时使用空字符串或空数组。逐字抄录可辨认文字，输出必须符合指定 JSON Schema。",
        }],
      }, {
        role: "user",
        content: [
          { type: "input_text", text: `识别这些图片中的同一产品并生成待人工确认的产品事实。用户补充仅作为线索，不得覆盖图片事实：${JSON.stringify(requestInput)}` },
          ...inputImages(images),
        ],
      }],
      text: { format: { type: "json_schema", name: "product_facts", strict: true, schema: analysisJsonSchema } },
    },
  });
  const result = parseModelResult(data, analysisResultSchema, "产品参考图识别模型");
  return { ...result, model: resolved.model, analyzedAt: now() };
}

export async function writeFreeformImagePrompt(modelConfig = {}, input = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  productImages = [],
  signal,
  timeoutMs = 90_000,
  idempotencyKey = "",
  random = Math.random,
  sleep,
} = {}) {
  const requestInput = validateQuickPromptInput(input);
  const images = imageDataUrls(productImages, { label: "参考图" });
  validateImageTotal([images]);
  const resolved = resolveModelConfig(modelConfig, { env });
  const content = [{ type: "text", text: `用户需求：${requestInput.userRequest}` }];
  if (images.length) content.push(
    { type: "text", text: "用户同时提供了参考图，请结合参考图理解需求。" },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.url } })),
  );
  const data = await requestPromptModelApiJson(`${resolved.baseUrl}/chat/completions`, {
    apiKey: resolved.apiKey,
    fetchImpl,
    label: "AI 自由帮写",
    signal,
    timeoutMs,
    body: {
      model: resolved.model,
      messages: [{
        role: "system",
        content: "根据用户需求自由发挥，写出你认为最好的生图提示词。",
      }, { role: "user", content: images.length ? content : content[0].text }],
    },
  }, { idempotencyKey, random, retryableStatuses: FREEFORM_PROMPT_RETRYABLE_STATUSES, ...(sleep ? { sleep } : {}) });
  const parsed = boundedText(PROMPT_STUDIO_OUTPUT_LIMITS.prompt, { required: true }).safeParse(outputText(data));
  if (!parsed.success) {
    throw promptError("AI 自由帮写模型没有返回可用提示词。", { code: "PROMPT_MODEL_EMPTY_RESPONSE", status: 502 });
  }
  return { prompt: parsed.data, model: resolved.model };
}

export async function interpretQuickPrompt(modelConfig = {}, input = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  productImages = [],
  signal,
  timeoutMs = 90_000,
  idempotencyKey = "",
  random = Math.random,
  sleep,
} = {}) {
  const requestInput = validateQuickPromptInput(input);
  const images = imageDataUrls(productImages, { label: "产品参考图" });
  validateImageTotal([images]);
  if (images.length > 3) {
    throw promptError("快捷提示词最多上传 3 张产品参考图。", { code: "PROMPT_IMAGE_COUNT_EXCEEDED" });
  }
  if (requestInput.creationMode === "product" && !images.length) {
    throw promptError("商品生图模式必须上传至少一张产品参考图。", {
      code: "PROMPT_PRODUCT_IMAGE_MISSING",
      status: 400,
    });
  }
  const resolved = resolveModelConfig(modelConfig, { env });
  const modeRequirement = requestInput.creationMode === "product"
    ? "当前为商品生图模式：参考图是产品身份、结构、颜色、Logo 和原有文字的唯一事实依据，必须优先保持产品一致，不得把参考图只当作风格图。"
    : requestInput.creationMode === "free"
      ? "当前为自由生图模式：允许没有产品参考图；无参考图时只能根据用户原话构建画面，不得虚构用户未提供的品牌、型号、价格、活动、功效或准确文字。"
      : "当前未指定创作模式：有参考图时锁定产品事实，无参考图时只根据用户原话自由设计。";
  const copyRequirement = "文案由你根据用户目标自由策划，不要套用固定口号、固定节日文案、固定配色或固定版式。海报、活动图和详情图在用户没有明确要求无字时，通常应主动提出一组与主题相符、简洁有记忆点的可编辑中文文案；文案的数量、层级、句式和摆放位置由你判断，不必凑齐任何字段。将最终要出现在画面里的每条文案逐条放入 copy 的文本字段，这些字段只是传输容器，不代表固定的标题层级。用户明确提供的文字必须逐字保留。只有用户明确说无字、不要文字、只要底图或交给后期排版时，才使用 reserved。";
  const modelInput = {
    userRequest: requestInput.userRequest,
    parameters: requestInput.parameters,
  };
  const content = [{
    type: "input_text",
    text: `把用户的一句话需求解释成完整、可执行的电商生图任务。${modeRequirement}${copyRequirement}围绕用户目标自由发挥，优先给出视觉效果最好的方案；不要复用历史模板或空泛的营销套话。用户明确提供的文案必须逐字保留。局部改图和换背景必须给出明确的目标、改动和保留区域。用户原始输入：${JSON.stringify(modelInput)}`,
  }];
  if (images.length) content.push(
    { type: "input_text", text: "以下均为同一产品的参考图，只用于识别和锁定产品身份、结构、颜色、Logo 及原有文字。" },
    ...inputImages(images),
  );
  const data = await requestPromptModelApiJson(`${resolved.baseUrl}/responses`, {
    apiKey: resolved.apiKey,
    fetchImpl,
    label: "快捷提示词理解",
    signal,
    timeoutMs,
    body: {
      model: resolved.model,
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: `你是电商视觉策划与生图需求分析师。用户只说需求，你负责选择最合适的任务类目，并补全产品事实、视觉风格、文字方案和修改边界。${copyRequirement}大胆设计构图、光影、材质、色彩、空间层次和版式，直接给出你认为效果最好的方案。不要输出模板说明、字段解释或后台规则。输出必须符合指定 JSON Schema。`,
        }],
      }, { role: "user", content }],
      text: { format: { type: "json_schema", name: "quick_prompt_interpretation", strict: true, schema: quickPromptJsonSchema } },
    },
  }, { idempotencyKey, random, ...(sleep ? { sleep } : {}) });
  const interpreted = parseModelResult(data, quickPromptResultSchema, "快捷提示词理解模型");
  if (["campaign-poster", "detail-page"].includes(interpreted.category)) {
    const explicitCopy = extractExplicitPosterCopy(requestInput.userRequest);
    if (explicitlyRequestsNoText(requestInput.userRequest)) {
      interpreted.copy = emptyCopy("reserved");
    } else {
      if (interpreted.copy.mode === "reserved") interpreted.copy = emptyCopy("none");
      if (explicitCopy.hasCopy) {
        interpreted.copy = {
          ...interpreted.copy,
          mode: "exact",
          title: explicitCopy.title || interpreted.copy.title,
          subtitle: explicitCopy.subtitle || interpreted.copy.subtitle,
          sellingPoints: explicitCopy.sellingPoints.length ? explicitCopy.sellingPoints : interpreted.copy.sellingPoints,
          price: explicitCopy.price || interpreted.copy.price,
          campaignInfo: explicitCopy.campaignInfo || interpreted.copy.campaignInfo,
          additionalText: explicitCopy.additionalText.length ? explicitCopy.additionalText : interpreted.copy.additionalText,
        };
      }
    }
  }
  if (["local-edit", "background-swap"].includes(interpreted.category) && !images.length) {
    throw promptError("局部改图或换背景必须上传至少一张产品参考图。", {
      code: "PROMPT_EDIT_IMAGE_REQUIRED",
      status: 400,
    });
  }
  const validatedInput = validatePromptStudioInput({
    category: interpreted.category,
    userRequest: requestInput.userRequest,
    productFacts: interpreted.productFacts,
    style: interpreted.style,
    copy: interpreted.copy,
    parameters: requestInput.parameters,
    editBoundary: interpreted.editBoundary,
  });
  return {
    input: validatedInput,
    warnings: interpreted.warnings,
    recommendedVariantKey: interpreted.recommendedVariantKey,
    model: resolved.model,
  };
}

function localQuickCategory(userRequest) {
  const text = String(userRequest || "");
  if (/(白底|纯白背景|白色背景|商品主图)/i.test(text)) return "white-background";
  if (/(详情页|详情图|卖点图|功能图)/i.test(text)) return "detail-page";
  if (/(精修|修图|质感|去污|清理反光|清晰度)/i.test(text)) return "product-retouch";
  if (hasPosterIntent(text)) return "campaign-poster";
  return "product-scene";
}

function emptyCopy(mode = "none") {
  return { mode, title: "", subtitle: "", sellingPoints: [], price: "", campaignInfo: "", additionalText: [] };
}

function localQuickCopy(userRequest, category) {
  const text = String(userRequest || "");
  if (["campaign-poster", "detail-page"].includes(category) && explicitlyRequestsNoText(text)) {
    return emptyCopy("reserved");
  }
  const explicitCopy = extractExplicitPosterCopy(text);
  if (explicitCopy.hasCopy) {
    return {
      mode: "exact",
      title: explicitCopy.title,
      subtitle: explicitCopy.subtitle,
      sellingPoints: explicitCopy.sellingPoints,
      price: explicitCopy.price,
      campaignInfo: explicitCopy.campaignInfo,
      additionalText: explicitCopy.additionalText,
    };
  }
  return emptyCopy("none");
}

function localQuickStyle(userRequest, category) {
  const summary = String(userRequest || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const labels = {
    "white-background": "白底商品视觉",
    "campaign-poster": "主题海报视觉",
    "detail-page": "详情页视觉",
    "product-retouch": "产品精修视觉",
    "product-scene": "产品场景视觉",
  };
  return {
    name: labels[category] || "开放式创意方向",
    description: `围绕“${summary || "用户提出的主题"}”自由选择最能服务目标的视觉语言。先识别画面真正的主体和受众，再决定叙事、构图、空间层次与信息密度；不预设节日配色、固定版式或套话。`,
    lighting: "根据主体材质、场景情绪和传播目的自由设计有方向性的光线，确保主体清楚、层次自然。",
    composition: "根据用户目标和画面比例自由安排视觉重心、留白、节奏与阅读路径，避免机械套用分区模板。",
    palette: "根据主题、主体和受众自由决定色彩关系，保证对比、可读性与整体审美，不强行使用某一种节日配色。",
    camera: "根据主体与用途自由选择最有表现力的观察角度、景别和镜头语言。",
    forbidden: ["与主题无关的固定模板", "空泛或重复的营销套话", "杂乱背景、低清晰度、无关装饰抢占主体"],
  };
}

export function interpretQuickPromptLocally(input = {}, { reason = "" } = {}) {
  const requestInput = validateQuickPromptInput(input);
  if (requestInput.creationMode === "product") {
    throw promptError("商品生图模式必须上传至少一张产品参考图。", {
      code: "PROMPT_PRODUCT_IMAGE_MISSING",
      status: 400,
    });
  }
  if (/(换|替换|更换).{0,6}背景|局部(?:修改|改图|调整)|框选修改|涂抹修改/i.test(requestInput.userRequest)) {
    throw promptError("局部改图或换背景必须上传至少一张产品参考图。", {
      code: "PROMPT_EDIT_IMAGE_REQUIRED",
      status: 400,
    });
  }
  const category = localQuickCategory(requestInput.userRequest);
  const validatedInput = validatePromptStudioInput({
    category,
    userRequest: requestInput.userRequest,
    productFacts: {
      productType: "自由创作画面（未指定具体商品）",
      appearance: "只呈现用户原话明确描述的主体与外观，不补造具体商品结构",
      colorsMaterials: "只使用用户原话明确的颜色与材质，未说明部分采用中性商业表现",
      components: [],
      logo: "",
      existingText: [],
      mustPreserve: ["用户原始需求的主题与主体"],
      forbiddenChanges: ["不得虚构品牌、型号、价格、功效或活动规则"],
    },
    style: localQuickStyle(requestInput.userRequest, category),
    copy: localQuickCopy(requestInput.userRequest, category),
    parameters: requestInput.parameters,
    editBoundary: { targetAreas: [], changes: [], preserveAreas: [] },
  });
  return {
    input: validatedInput,
    warnings: reason ? [String(reason).slice(0, 500)] : [],
    recommendedVariantKey: category === "campaign-poster" ? "commercial" : "safe",
    model: LOCAL_FALLBACK_MODEL,
  };
}

function exactCopyEntries(copy) {
  return [
    ["主标题", copy.title],
    ["副标题", copy.subtitle],
    ...copy.sellingPoints.map((value, index) => [`卖点 ${index + 1}`, value]),
    ["价格", copy.price],
    ["活动信息", copy.campaignInfo],
    ...copy.additionalText.map((value, index) => [`补充文字 ${index + 1}`, value]),
  ].filter(([, value]) => value);
}

function buildVisibleCopyPlan(input) {
  if (input.copy.mode !== "exact") return "";
  return [
    "【文案原文（可编辑）】",
    ...exactCopyEntries(input.copy).map(([, value], index) => `${index + 1}. ${value}`),
  ].join("\n");
}

function listLine(label, values) {
  return `${label}：${values.length ? values.join("；") : "无额外要求"}`;
}

function buildHardRequirements(input, { productImageCount = 0, styleImageCount = 0 } = {}) {
  const facts = input.productFacts;
  const style = input.style;
  const productImageRange = productImageCount === 1 ? "第 1 张" : `第 1 至 ${productImageCount} 张`;
  const styleImageStart = productImageCount + 1;
  const styleImageEnd = productImageCount + styleImageCount;
  const styleImageRange = styleImageStart === styleImageEnd
    ? `第 ${styleImageStart} 张`
    : `第 ${styleImageStart} 至 ${styleImageEnd} 张`;
  const copyLines = input.copy.mode === "exact"
    ? [
        "文字模式：直接生成创意方案中【文案原文（可编辑）】逐条列明的文字。该区域是本次最终文字原文，字符顺序、简繁体、大小写、数字、单位、标点、空格和换行必须完全一致。",
        "禁止翻译、润色、缩写、补写或猜测任何文案；除创意方案明确列明的文字及产品原有文字外，不得增加任何字符。文案的视觉层级、字体、位置和编排由创意方案自行决定，不得把清单序号渲染到画面中。",
      ]
    : input.copy.mode === "reserved"
      ? ["文字模式：只生成无字底图并预留清晰文案区域；不得生成伪文字、占位文字、价格、促销词或任意新字符，产品原有文字仍须逐字保留。"]
      : hasPosterIntent(input.userRequest)
        ? ["文字模式：根据用户需求自然决定文案内容、数量和视觉层级，不套用固定标题、副标题或卖点模板；不得擅自添加用户未要求的价格、折扣、优惠规则或其他促销事实。"]
        : ["文字模式：用户未要求新增文字时，不得擅自添加标题、价格、促销词或其他字符；产品原有文字仍须逐字保留。"];
  const boundary = input.editBoundary;
  return [
    "以下为服务端硬约束，优先级高于前文的创意描述，不得省略、改写或冲突：",
    "【产品事实】",
    `产品类型：${facts.productType}`,
    `外形结构：${facts.appearance}`,
    `颜色与材质：${facts.colorsMaterials}`,
    listLine("组成部件", facts.components),
    `Logo/品牌事实：${facts.logo || "未提供；不得猜测或新增"}`,
    listLine("原有文字", facts.existingText),
    listLine("必须保留", facts.mustPreserve),
    listLine("禁止改变", facts.forbiddenChanges),
    ...(productImageCount ? [`产品参考图：随本提示词上传的 ${productImageRange}为产品图，只用于锁定上述产品身份、结构、颜色、Logo 和原有文字。`] : []),
    "【风格方案】",
    `方案名称：${style.name || "本次方案"}`,
    `视觉描述：${style.description}`,
    `光线：${style.lighting || "遵循视觉描述"}`,
    `构图：${style.composition || "遵循视觉描述"}`,
    `色彩：${style.palette || "遵循视觉描述"}`,
    `镜头：${style.camera || "遵循视觉描述"}`,
    listLine("排除风格", style.forbidden),
    ...(styleImageCount ? [`风格参考图：随本提示词上传的 ${styleImageRange}为风格图，只参考光线、色彩、构图和氛围，不得复制其中的产品、品牌、文字或造型。`] : []),
    "【精确文字规则】",
    ...copyLines,
    "所有需保留或生成的文字必须清晰可读，禁止乱码、错别字、形近字、漏字、多字、重复字、断笔、粘连、镜像字、倒置字和伪文字。",
    "【类目硬约束】",
    CATEGORY_RULES[input.category],
    "【修改边界】",
    listLine("只允许修改", boundary.targetAreas),
    listLine("具体改动", boundary.changes),
    listLine("必须保持不变", boundary.preserveAreas),
    "输出前逐项核对产品身份、结构、文字和修改边界；任何创意都不能突破上述事实和边界。画面比例、分辨率、质量和背景由结构化生成参数控制，不得在图中渲染成文字。",
  ].join("\n");
}

function promptAssemblyContext(requestInput, { productImageCount = 0, styleImageCount = 0 } = {}) {
  const hardRequirements = buildHardRequirements(requestInput, { productImageCount, styleImageCount });
  const visibleCopyPlan = buildVisibleCopyPlan(requestInput);
  const separatorLength = FINAL_PROMPT_SEPARATOR.length * (visibleCopyPlan ? 2 : 1);
  const corePromptLimit = PROMPT_STUDIO_OUTPUT_LIMITS.prompt - hardRequirements.length - visibleCopyPlan.length - separatorLength;
  if (corePromptLimit < 1) {
    throw promptError(
      `已确认的产品事实、准确文字和修改边界共占用 ${hardRequirements.length} 个字符，超过 AI 生图 ${PROMPT_STUDIO_OUTPUT_LIMITS.prompt} 字符上限。硬约束未被截断，请精简产品档案或文案后重试。`,
      { code: "PROMPT_HARD_REQUIREMENTS_TOO_LONG", status: 400 },
    );
  }
  return { hardRequirements, visibleCopyPlan, corePromptLimit };
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

// A bare artifact word is an explicit request, but a nearby negative phrase is
// an exclusion. Keeping this distinction here prevents "不要二维码" from
// disabling the default QR-code guard while still allowing "加一个二维码".
function explicitlyRequestsArtifact(value, term) {
  const text = String(value || "");
  const target = String(term || "");
  if (!text || !target) return false;
  const negativeIntents = new Set(["不要", "不需要", "无需", "不含", "不带", "不加", "不放", "不显示", "不生成", "不保留", "去掉", "去除", "删除", "移除", "禁止", "避免", "排除", "无", "没有", "不得", "不能", "不可", "别"]);
  const intentPattern = /(不需要|不显示|不生成|不保留|不要|无需|不含|不带|不加|不放|去掉|去除|删除|移除|禁止|避免|排除|没有|不得|不能|不可|别|无|需要|添加|加上|加入|生成|保留|显示|展示|放置|包含|带上|带有|允许|要)/gi;
  const negationAfter = /^(?:\s*.{0,4})?(?:不要|不需要|无需|不含|不带|不加|不放|不显示|不生成|不保留|去掉|去除|删除|移除|禁止|避免|排除|不得|不能|不可|别)/i;
  let offset = 0;
  while (offset < text.length) {
    const index = text.toLowerCase().indexOf(target.toLowerCase(), offset);
    if (index < 0) return false;
    const clause = text.slice(0, index).split(/[。；;！？!?\r\n]/).at(-1) || "";
    const latestIntent = [...clause.matchAll(intentPattern)].at(-1)?.[0] || "";
    const after = text.slice(index + target.length, index + target.length + 14);
    if (!negativeIntents.has(latestIntent) && !negationAfter.test(after)) return true;
    offset = index + target.length;
  }
  return false;
}

function negativeConflict(segment, input) {
  const value = normalized(segment);
  if (!value) return false;
  const exactCopy = exactCopyEntries(input.copy).map(([, text]) => normalized(text));
  if (exactCopy.some((text) => text && value.includes(text))) return true;
  if (input.copy.mode === "exact" && /^(无|不要|不含|去除|删除|移除)?(任何)?(文字|文本|文案|字符|字母|数字|价格|text|typography)$/.test(value)) return true;
  if (input.copy.mode === "exact" && /(无文字|不要文字|去除文字|删除文字|移除文字|notext)/.test(value)) return true;
  if (input.productFacts.logo && /^(无|不要|不含|去除|删除|移除)?(任何)?(logo|商标|品牌标识)$/.test(value)) return true;
  if (input.productFacts.logo && /(无logo|不要logo|去除logo|删除logo|移除logo|nologo)/.test(value)) return true;
  if (input.category === "white-background" && /^(不要|去除|删除|排除)?(纯)?(白底|白色背景|whitebackground)$/.test(value)) return true;
  const protectedValues = [
    input.userRequest,
    input.productFacts.productType,
    input.productFacts.appearance,
    input.productFacts.colorsMaterials,
    ...input.productFacts.components,
    input.productFacts.logo,
    ...input.productFacts.existingText,
    ...input.productFacts.mustPreserve,
    ...exactCopy,
    input.style.name,
    input.style.description,
    input.style.lighting,
    input.style.composition,
    input.style.palette,
    input.style.camera,
  ]
    .map(normalized)
    .filter((text) => text.length >= 2);
  return protectedValues.some((text) => value.includes(text) || (value.length >= 2 && text.includes(value)));
}

function sanitizeNegativePrompt(value, input) {
  const modelSegments = String(value || "").split(/[,，;；\n]+/).map((item) => item.trim()).filter(Boolean);
  const explicitTextArtifacts = [input.userRequest, ...exactCopyEntries(input.copy).map(([, text]) => text)];
  const explicitlyRequests = (term) => explicitTextArtifacts.some((text) => explicitlyRequestsArtifact(text, term));
  const base = [
    "低清晰度", "模糊", "产品变形", "错误结构", "多余零部件", "乱码", "错别字", "伪文字", "镜像文字",
    "额外品牌", "额外 Logo",
    ...(!explicitlyRequests("二维码") && ![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /二维码/i.test(item)) ? ["二维码"] : []),
    ...(!explicitlyRequests("条形码") && ![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /条形码/i.test(item)) ? ["条形码"] : []),
    ...(!explicitlyRequests("水印") && ![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /水印/i.test(item)) ? ["水印"] : []),
    ...(explicitlyRequests("签名") || explicitlyRequests("署名") ? [] : ["签名"]),
    ...(input.category === "white-background" ? ["复杂背景"] : []),
    ...(input.copy.mode === "exact" ? ["文案缺失", "文案改写", "文案增删"] : []),
  ];
  const baseSegments = [...new Set(base)];
  const baseSet = new Set(baseSegments);
  const internalRules = `${NEGATIVE_PROMPT_RULES_MARKER}\n${baseSegments.join("，")}`;
  const accepted = [];
  for (const segment of new Set(modelSegments.filter((item) => !negativeConflict(item, input)))) {
    if (baseSet.has(segment)) continue;
    const visible = [...accepted, segment].join("，");
    if ([visible, internalRules].filter(Boolean).join(FINAL_PROMPT_SEPARATOR).length <= PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt) {
      accepted.push(segment);
    }
  }
  const result = [
    accepted.join("，"),
    internalRules,
  ].filter(Boolean).join(FINAL_PROMPT_SEPARATOR);
  if (result.length > PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt) {
    throw promptError("服务端基础排除规则超过 AI 生图长度上限，未截断规则，请联系管理员。", {
      code: "PROMPT_NEGATIVE_REQUIREMENTS_TOO_LONG",
      status: 500,
    });
  }
  return result;
}

const VISIBLE_CONTROL_CLAUSE_PATTERN = /(?:不得|禁止|不虚构|不允许|不可|不能|硬约束|安全规则|服务端规则|后台规则|保真规则|防错规则|不引入任何新事实|不要(?:编造|改动|新增|改变))/i;

function visibleCreativeText(value) {
  return String(value || "")
    .split(/[，,；;。！？!?\r\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !VISIBLE_CONTROL_CLAUSE_PATTERN.test(segment))
    .join("，");
}

function creativeCorePrompts(input) {
  const summary = visibleCreativeText(input.userRequest).slice(0, 320) || "本次创作主题";
  return {
    safe: `围绕“${summary}”完成一套清晰、可执行的视觉方案。优先让主体、用途和情绪一眼可懂，使用真实可观察的材质、光线和空间关系，保持画面克制、完整、易于落地。`,
    commercial: `以“${summary}”为核心，设计一套有商业质感和记忆点的视觉方案。通过有方向的布光、材质细节、视觉重心、留白与阅读节奏提升传播效果；色彩和版式由主题决定，不套用现成活动模板。`,
    creative: `把“${summary}”发展成一套有独特视觉观点的创意方案。可以大胆选择隐喻、视角、空间关系、材质对比或叙事方式，但必须让主体清楚、内容可信、画面可执行，并避免无关炫技。`,
  };
}

function sanitizeVisibleCreativePrompt(value, fallback) {
  const visible = visibleCreativeText(value);
  return visible ? `${visible}。` : fallback;
}

function mergeFinalPrompt(corePrompt, visibleCopyPlan, hardRequirements, corePromptLimit) {
  const core = String(corePrompt || "").trim();
  if (core.length > corePromptLimit) {
    throw promptError(
      `AI 提示词模型返回的核心画面描述为 ${core.length} 个字符，超过本次可用的 ${corePromptLimit} 个字符。为避免截断产品事实、准确文字或修改边界，本次结果未保存，请重新生成。`,
      { code: "PROMPT_MODEL_OUTPUT_TOO_LONG", status: 502 },
    );
  }
  return [core, visibleCopyPlan, hardRequirements].filter(Boolean).join(FINAL_PROMPT_SEPARATOR);
}

function variantValues(promptSet) {
  return Object.values(promptSet);
}

export function runPromptRiskChecks(input, variants) {
  const values = variantValues(variants);
  const promptIncludes = (text) => values.every((variant) => variant.prompt.includes(text));
  const corePrompts = values.map((variant) => variant.prompt.split("以下为服务端硬约束")[0]);
  const productFields = [input.productFacts.productType, input.productFacts.appearance, input.productFacts.colorsMaterials]
    .filter(Boolean);
  const forbiddenActions = input.productFacts.forbiddenChanges
    .map((value) => value.replace(/^(不得|禁止|不可|不要)/, "").trim())
    .filter((value) => value.length >= 2);
  const coreBreaksProduct = corePrompts.some((prompt) => /(删除|移除|去除).{0,30}(logo|品牌|原有文字|产品主体|产品结构|零部件)|(改变|替换|重构).{0,30}(产品主体|产品结构|产品身份|logo|品牌|原有文字)|忽略.{0,20}(产品事实|修改边界)/i.test(prompt)
    || forbiddenActions.some((action) => prompt.includes(action)));
  const productPassed = productFields.every(promptIncludes) && !coreBreaksProduct;
  const exactCopy = exactCopyEntries(input.copy).map(([, value]) => value);
  const textPassed = exactCopy.every(promptIncludes)
    && values.every((variant) => !String(variant.negativePrompt).split(/[,，;；\n]+/).some((segment) => negativeConflict(segment, input)))
    && (input.copy.mode !== "exact" || corePrompts.every((prompt) => !/(改写|重写|省略|删除|移除|去除).{0,20}(文字|文案|标题|价格)/.test(prompt)));
  const boundaryRequired = ["local-edit", "background-swap"].includes(input.category);
  const boundaryValues = [...input.editBoundary.targetAreas, ...input.editBoundary.changes, ...input.editBoundary.preserveAreas];
  const boundaryPassed = !boundaryRequired || boundaryValues.every(promptIncludes);
  const styleValues = [input.style.description, input.style.lighting, input.style.composition, input.style.palette, input.style.camera].filter(Boolean);
  const stylePassed = styleValues.every(promptIncludes);
  const parameterPassed = values.every((variant) => Object.entries(input.parameters)
    .every(([key, value]) => variant.recommendedParameters?.[key] === value));
  return [
    { id: "product-consistency", label: "产品一致性", status: productPassed ? "pass" : "error", message: productPassed ? "三套提示词均锁定了产品事实。" : "存在未写入最终提示词的产品事实。" },
    { id: "text-integrity", label: "文字准确性", status: textPassed ? "pass" : "error", message: textPassed ? "精确文字和防乱码规则已写入，排除词无冲突。" : "文字原文缺失或排除词与正向文字冲突。" },
    { id: "edit-boundary", label: "修改边界", status: boundaryPassed ? "pass" : "error", message: boundaryPassed ? (boundaryRequired ? "目标、改动和保留区域均已锁定。" : "该类目无需强制局部修改边界。") : "最终提示词未完整保留修改边界。" },
    { id: "style-consistency", label: "风格一致性", status: stylePassed ? "pass" : "error", message: stylePassed ? "三套提示词均继承了同一风格方案。" : "存在未写入最终提示词的风格规则。" },
    { id: "parameters", label: "生成参数", status: parameterPassed ? "pass" : "error", message: parameterPassed ? "比例、分辨率、质量和背景通过结构化字段传递。" : "生成方案缺少结构化输出参数。" },
  ];
}

export async function generatePromptSet(modelConfig = {}, input = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  productImages = [],
  styleImages = [],
  signal,
  timeoutMs = 90_000,
  idempotencyKey = "",
  random = Math.random,
  sleep,
} = {}) {
  const requestInput = validatePromptStudioInput(input);
  const productImageData = imageDataUrls(productImages, { label: "产品参考图" });
  const styleImageData = imageDataUrls(styleImages, { label: "风格参考图" });
  validateImageTotal([productImageData, styleImageData]);
  const { hardRequirements, visibleCopyPlan, corePromptLimit } = promptAssemblyContext(requestInput, {
    productImageCount: productImageData.length,
    styleImageCount: styleImageData.length,
  });
  const resolved = resolveModelConfig(modelConfig, { env });
  const content = [{
    type: "input_text",
    text: `基于以下已确认输入分别生成稳妥执行、商业增强、创意方案三套核心画面描述。每套 prompt 不得超过 ${corePromptLimit} 个字符，每套 negativePrompt 不得超过 ${MODEL_NEGATIVE_PROMPT_LIMIT} 个字符。产品事实和修改边界由服务端另行锁定；当 copy.mode 为 exact 时，文案原文也由服务端锁定，核心描述负责把文案自然融入最合适的视觉层级。当 copy.mode 不是 exact 而用户需求属于海报、活动图或详情图时，请在核心描述中自由策划真正要呈现的文字及其版式，不要让画面变成无字底图，除非用户明确要求无字。核心描述只负责真正影响画面效果的构图、主体关系、光影、色彩、空间层次、氛围、材质和版式；不要复述后台规则，不要使用固定节日口号或固定分区模板。负面提示词不得否定正向要求。只输出指定 JSON。\n${JSON.stringify(requestInput)}`,
  }];
  if (productImageData.length) content.push(
    { type: "input_text", text: "以下是产品参考图：只用于保持产品身份、结构、颜色、Logo 和原有文字。" },
    ...inputImages(productImageData),
  );
  if (styleImageData.length) content.push(
    { type: "input_text", text: "以下是风格参考图：只参考光线、色彩、构图和氛围，禁止复制其中的产品、品牌、文字或造型。" },
    ...inputImages(styleImageData),
  );
  const data = await requestPromptModelApiJson(`${resolved.baseUrl}/responses`, {
    apiKey: resolved.apiKey,
    fetchImpl,
    label: "AI 提示词生成",
    signal,
    timeoutMs,
    body: {
      model: resolved.model,
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: "你是电商视觉提示词导演。只生成三套真正有差异、可直接执行的创意方案，不复述后台规则，不套用固定海报骨架、固定节日配色或固定营销套话。safe 注重清晰、稳定和可落地；commercial 注重材质、布光、视觉焦点和传播效率；creative 可以大胆探索叙事、隐喻、视角、空间关系和版式，但不能牺牲主体辨识度、文字可读性或事实准确性。需要文字时，写出与你当前主题真正相关的文字，不要为了填字段生成空泛口号。创意不能改动产品事实，也不能编造价格、品牌、功能、功效或活动规则。输出必须符合指定 JSON Schema。",
        }],
      }, { role: "user", content }],
      text: { format: { type: "json_schema", name: "prompt_set", strict: true, schema: promptSetJsonSchema } },
    },
  }, { idempotencyKey, random, ...(sleep ? { sleep } : {}) });
  const modelVariants = parseModelResult(data, modelPromptSetSchema, "AI 提示词模型");
  const fallbackCores = creativeCorePrompts(requestInput);
  const variants = Object.fromEntries(Object.entries(modelVariants).map(([id, variant]) => [id, {
    title: VARIANT_TITLES[id],
    prompt: mergeFinalPrompt(sanitizeVisibleCreativePrompt(variant.prompt, fallbackCores[id]), visibleCopyPlan, hardRequirements, corePromptLimit),
    negativePrompt: sanitizeNegativePrompt(variant.negativePrompt, requestInput),
    rationale: variant.rationale,
    recommendedParameters: { ...requestInput.parameters },
  }]));
  return {
    variants,
    riskChecks: runPromptRiskChecks(requestInput, variants),
    model: resolved.model,
    createdAt: now(),
  };
}

export function generatePromptSetLocally(input = {}, {
  configuredModel = "",
  now = () => new Date().toISOString(),
  productImageCount = 0,
  styleImageCount = 0,
} = {}) {
  const requestInput = validatePromptStudioInput(input);
  const { hardRequirements, visibleCopyPlan, corePromptLimit } = promptAssemblyContext(requestInput, { productImageCount, styleImageCount });
  const cores = creativeCorePrompts(requestInput);
  const rationales = {
    safe: "优先保证需求准确、主体清楚和结果可控。",
    commercial: "在不增加虚构信息的前提下增强电商质感。",
    creative: "在事实边界内释放构图、色彩、光影和版式创意。",
  };
  const variants = Object.fromEntries(Object.entries(cores).map(([id, corePrompt]) => [id, {
    title: VARIANT_TITLES[id],
    prompt: mergeFinalPrompt(corePrompt, visibleCopyPlan, hardRequirements, corePromptLimit),
    negativePrompt: sanitizeNegativePrompt("", requestInput),
    rationale: rationales[id],
    recommendedParameters: { ...requestInput.parameters },
  }]));
  return {
    variants,
    riskChecks: runPromptRiskChecks(requestInput, variants),
    model: configuredModel ? `${configuredModel} / ${LOCAL_FALLBACK_MODEL}` : LOCAL_FALLBACK_MODEL,
    createdAt: now(),
  };
}

function storedRecords(value, schema, limit, dateField, { preserveFavorites = false } = {}) {
  if (!Array.isArray(value)) return [];
  const records = value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  records.sort((left, right) => Date.parse(right[dateField]) - Date.parse(left[dateField]));
  if (records.length <= limit) return records;
  if (!preserveFavorites) return records.slice(0, limit);

  const favorites = records.filter((item) => item.isFavorite).slice(0, limit);
  const recentOthers = records.filter((item) => !item.isFavorite).slice(0, limit - favorites.length);
  return [...favorites, ...recentOthers]
    .sort((left, right) => Date.parse(right[dateField]) - Date.parse(left[dateField]));
}

export function normalizePromptStudioState(value = {}) {
  const libraryFavorites = Array.isArray(value?.libraryFavorites)
    ? [...new Set(value.libraryFavorites.filter((item) => promptLibraryTemplateIdSchema.safeParse(item).success))]
      .slice(0, PROMPT_STUDIO_STATE_LIMITS.libraryFavorites)
    : [];
  return {
    productProfiles: storedRecords(value?.productProfiles, promptProductProfileStorageSchema, PROMPT_STUDIO_STATE_LIMITS.productProfiles, "updatedAt"),
    stylePresets: storedRecords(value?.stylePresets, promptStylePresetStorageSchema, PROMPT_STUDIO_STATE_LIMITS.stylePresets, "updatedAt"),
    records: storedRecords(value?.records, promptHistoryStorageSchema, PROMPT_STUDIO_STATE_LIMITS.records, "createdAt", { preserveFavorites: true }),
    quickRequests: storedRecords(value?.quickRequests, quickPromptRequestStorageSchema, PROMPT_STUDIO_STATE_LIMITS.quickRequests, "createdAt"),
    libraryFavorites,
  };
}
