import { z } from "zod";
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
const MODEL_NEGATIVE_PROMPT_LIMIT = 1_600;
const LOCAL_FALLBACK_MODEL = "本地规则保底";
const PROMPT_RETRYABLE_STATUSES = new Set([502, 503, 504]);
const PROMPT_RETRY_MIN_DELAY_MS = 180;
const PROMPT_RETRY_JITTER_MS = 220;

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
  ratio: z.enum(["1:1", "3:4", "4:3", "16:9"]),
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
      && (error.code === "MODEL_API_NETWORK_ERROR" || PROMPT_RETRYABLE_STATUSES.has(error.status));
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
      : "当前未指定创作模式，沿用旧版快捷提示词规则：有参考图时锁定产品事实，无参考图时只根据用户原话生成。";
  const modelInput = {
    userRequest: requestInput.userRequest,
    parameters: requestInput.parameters,
  };
  const content = [{
    type: "input_text",
    text: `把用户的一句话需求解释成完整、可校验的电商生图任务。${modeRequirement}只根据用户原话和参考图填写事实，不得虚构品牌、型号、功效、价格或活动；无法确认的产品细节使用中性的保真描述，并写入 warnings。准确文案必须逐字保留。局部改图和换背景必须给出明确的目标、改动和保留区域。用户原始输入：${JSON.stringify(modelInput)}`,
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
          text: "你是电商生图需求分析师。用户只说需求，你负责选择最合适的任务类目，并补全严格的产品事实、视觉风格、文字模式和修改边界。优先忠实、可执行和不变形；没有依据时不猜测，输出必须符合指定 JSON Schema。",
        }],
      }, { role: "user", content }],
      text: { format: { type: "json_schema", name: "quick_prompt_interpretation", strict: true, schema: quickPromptJsonSchema } },
    },
  }, { idempotencyKey, random, ...(sleep ? { sleep } : {}) });
  const interpreted = parseModelResult(data, quickPromptResultSchema, "快捷提示词理解模型");
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
  if (/(海报|促销|活动|大促|国庆|中秋|春节|618|双\s*11|双十一|年货节|开学季|节日)/i.test(text)) return "campaign-poster";
  return "product-scene";
}

function localQuickCopy(userRequest, category) {
  const text = String(userRequest || "");
  const quoted = [...text.matchAll(/[“‘"']([^”’"'\r\n]{1,120})[”’"']/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const labeledTitle = text.match(/(?:标题|主标题|文案)(?:必须)?(?:写|为|是|：|:)\s*([^，。；;\r\n]{1,120})/i)?.[1]?.trim() || "";
  const title = quoted[0] || labeledTitle;
  if (title) {
    return {
      mode: "exact",
      title,
      subtitle: "",
      sellingPoints: [],
      price: "",
      campaignInfo: "",
      additionalText: quoted.slice(1, 6),
    };
  }
  return {
    mode: ["campaign-poster", "detail-page"].includes(category) ? "reserved" : "none",
    title: "",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  };
}

function localQuickStyle(userRequest, category) {
  const summary = String(userRequest || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const palette = /国庆/.test(summary)
    ? "红色、金色与白色为主，保持克制、清晰和节日质感"
    : /中秋/.test(summary)
      ? "深蓝、月光白与少量金色，保持清晰的节日层次"
      : /春节|年货/.test(summary)
        ? "红色与金色为主，避免大面积高饱和造成廉价感"
        : category === "white-background"
          ? "纯白与中性灰，产品颜色保持真实"
          : "遵循用户主题的克制商业配色，保证主体与背景有清晰对比";
  const presets = {
    "white-background": ["专业白底商品摄影", "纯净白底、自然接触阴影、主体边缘清楚", "柔和均匀的棚拍光", "主体居中完整，四周保留安全边距", "平视商业产品镜头"],
    "campaign-poster": ["电商活动海报", `围绕“${summary}”建立清晰的节日或活动视觉层级，并保留安全文案区`, "明快有层次的商业海报光线", "核心视觉集中，标题区、主体区和信息区层级明确", "正面主视觉，适合电商海报裁切"],
    "detail-page": ["电商详情页配图", `围绕“${summary}”呈现单一明确卖点，信息层级便于快速浏览`, "清晰均匀的商业光线", "主体与卖点说明区分离，留出稳定的信息区域", "平视或轻微俯视的说明型镜头"],
    "product-retouch": ["产品商业精修", `按“${summary}”提升清晰度、材质和光泽，保持原有结构与颜色定义`, "柔和轮廓光与受控高光", "主体完整居中，突出材质细节", "平视近景商业产品镜头"],
    "product-scene": ["真实产品场景", `围绕“${summary}”建立符合真实使用逻辑的场景，主体是第一视觉`, "自然且方向一致的商业光线", "主体清晰，场景道具只辅助叙事并保留安全边距", "符合真实观察高度的商业摄影镜头"],
  };
  const [name, description, lighting, composition, camera] = presets[category];
  return { name, description, lighting, composition, palette, camera, forbidden: ["杂乱背景", "低清晰度", "无关装饰抢占主体"] };
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
        "文字模式：直接生成准确文字。以下每项均为不可改写的原文，字符顺序、简繁体、大小写、数字、单位、标点、空格和换行必须完全一致：",
        ...exactCopyEntries(input.copy).map(([label, value]) => `${label}：${value}`),
        "禁止翻译、润色、缩写、补写或猜测任何文案；除上述原文及产品原有文字外，不得增加任何字符。",
      ]
    : input.copy.mode === "reserved"
      ? ["文字模式：只生成无字底图并预留清晰文案区域；不得生成伪文字、占位文字、价格、促销词或任意新字符，产品原有文字仍须逐字保留。"]
      : ["文字模式：不得新增任何文字、数字、价格、促销标签或伪文字；产品原有文字仍须逐字保留。"];
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
    "【输出参数】",
    `画面比例：${input.parameters.ratio}；输出分辨率：${input.parameters.resolution}；生成质量：${input.parameters.quality}；背景方式：${input.parameters.background}。`,
    "输出前逐项核对产品身份、结构、文字、修改边界、风格和参数；任何创意都不能突破上述事实和边界。",
  ].join("\n");
}

function promptAssemblyContext(requestInput, { productImageCount = 0, styleImageCount = 0 } = {}) {
  const hardRequirements = buildHardRequirements(requestInput, { productImageCount, styleImageCount });
  const corePromptLimit = PROMPT_STUDIO_OUTPUT_LIMITS.prompt - hardRequirements.length - FINAL_PROMPT_SEPARATOR.length;
  if (corePromptLimit < 1) {
    throw promptError(
      `已确认的产品事实、准确文字和修改边界共占用 ${hardRequirements.length} 个字符，超过 AI 生图 ${PROMPT_STUDIO_OUTPUT_LIMITS.prompt} 字符上限。硬约束未被截断，请精简产品档案或文案后重试。`,
      { code: "PROMPT_HARD_REQUIREMENTS_TOO_LONG", status: 400 },
    );
  }
  return { hardRequirements, corePromptLimit };
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
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
  const base = [
    "低清晰度", "模糊", "产品变形", "错误结构", "多余零部件", "乱码", "错别字", "伪文字", "镜像文字",
    "额外品牌", "额外 Logo",
    ...(![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /二维码/i.test(item)) ? ["二维码"] : []),
    ...(![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /条形码/i.test(item)) ? ["条形码"] : []),
    ...(![...input.productFacts.existingText, ...input.productFacts.mustPreserve].some((item) => /水印/i.test(item)) ? ["水印"] : []),
    "签名",
    ...(input.category === "white-background" ? ["复杂背景"] : []),
    ...(input.copy.mode === "exact" ? ["文案缺失", "文案改写", "文案增删"] : []),
  ];
  const baseSegments = [...new Set(base)];
  const baseSet = new Set(baseSegments);
  const accepted = [];
  for (const segment of new Set(modelSegments.filter((item) => !negativeConflict(item, input)))) {
    if (baseSet.has(segment)) continue;
    if ([...accepted, segment, ...baseSegments].join("，").length <= PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt) {
      accepted.push(segment);
    }
  }
  const result = [...accepted, ...baseSegments].join("，");
  if (result.length > PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt) {
    throw promptError("服务端基础排除规则超过 AI 生图长度上限，未截断规则，请联系管理员。", {
      code: "PROMPT_NEGATIVE_REQUIREMENTS_TOO_LONG",
      status: 500,
    });
  }
  return result;
}

function mergeFinalPrompt(corePrompt, hardRequirements, corePromptLimit) {
  const core = String(corePrompt || "").trim();
  if (core.length > corePromptLimit) {
    throw promptError(
      `AI 提示词模型返回的核心画面描述为 ${core.length} 个字符，超过本次可用的 ${corePromptLimit} 个字符。为避免截断产品事实、准确文字或修改边界，本次结果未保存，请重新生成。`,
      { code: "PROMPT_MODEL_OUTPUT_TOO_LONG", status: 502 },
    );
  }
  return `${core}${FINAL_PROMPT_SEPARATOR}${hardRequirements}`;
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
  const parameterPassed = [input.parameters.ratio, input.parameters.resolution, input.parameters.quality, input.parameters.background].every(promptIncludes);
  return [
    { id: "product-consistency", label: "产品一致性", status: productPassed ? "pass" : "error", message: productPassed ? "三套提示词均锁定了产品事实。" : "存在未写入最终提示词的产品事实。" },
    { id: "text-integrity", label: "文字准确性", status: textPassed ? "pass" : "error", message: textPassed ? "精确文字和防乱码规则已写入，排除词无冲突。" : "文字原文缺失或排除词与正向文字冲突。" },
    { id: "edit-boundary", label: "修改边界", status: boundaryPassed ? "pass" : "error", message: boundaryPassed ? (boundaryRequired ? "目标、改动和保留区域均已锁定。" : "该类目无需强制局部修改边界。") : "最终提示词未完整保留修改边界。" },
    { id: "style-consistency", label: "风格一致性", status: stylePassed ? "pass" : "error", message: stylePassed ? "三套提示词均继承了同一风格方案。" : "存在未写入最终提示词的风格规则。" },
    { id: "parameters", label: "生成参数", status: parameterPassed ? "pass" : "error", message: parameterPassed ? "比例、分辨率、质量和背景参数完整。" : "最终提示词缺少生成参数。" },
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
  const { hardRequirements, corePromptLimit } = promptAssemblyContext(requestInput, {
    productImageCount: productImageData.length,
    styleImageCount: styleImageData.length,
  });
  const resolved = resolveModelConfig(modelConfig, { env });
  const content = [{
    type: "input_text",
    text: `基于以下已确认输入分别生成稳妥执行、商业增强、创意方案三套核心画面描述。每套 prompt 不得超过 ${corePromptLimit} 个字符，每套 negativePrompt 不得超过 ${MODEL_NEGATIVE_PROMPT_LIMIT} 个字符。不得改写产品事实、准确文案和修改边界；负面提示词不得否定正向要求。只输出指定 JSON。\n${JSON.stringify(requestInput)}`,
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
          text: "你是电商视觉提示词导演。只生成三套有实质差异、可直接执行的核心画面描述，不重复输入中的硬约束，不添加未提供的产品事实、文案、价格、品牌、功能或参数。safe 最保守，commercial 强化商业质感，creative 只在不改变产品和边界的前提下增强构图创意。输出必须符合指定 JSON Schema。",
        }],
      }, { role: "user", content }],
      text: { format: { type: "json_schema", name: "prompt_set", strict: true, schema: promptSetJsonSchema } },
    },
  }, { idempotencyKey, random, ...(sleep ? { sleep } : {}) });
  const modelVariants = parseModelResult(data, modelPromptSetSchema, "AI 提示词模型");
  const variants = Object.fromEntries(Object.entries(modelVariants).map(([id, variant]) => [id, {
    title: VARIANT_TITLES[id],
    prompt: mergeFinalPrompt(variant.prompt, hardRequirements, corePromptLimit),
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
  const { hardRequirements, corePromptLimit } = promptAssemblyContext(requestInput, { productImageCount, styleImageCount });
  const summary = requestInput.userRequest.replace(/\s+/g, " ").trim().slice(0, 320);
  const categoryDirection = {
    "white-background": "使用纯净白底和自然接触阴影，完整呈现主体并保持边缘干净",
    "product-scene": "建立符合真实使用逻辑的场景，让主体成为第一视觉并控制辅助道具",
    "campaign-poster": "建立清楚的活动海报层级，保留标题与信息安全区，不虚构促销内容",
    "detail-page": "围绕单一卖点组织说明型画面，主体、细节和信息区层级清楚",
    "local-edit": "只执行已指定的局部修改，未指定区域保持原样",
    "background-swap": "只替换背景并重建自然接触阴影，产品主体保持原样",
    "product-retouch": "提升清晰度、材质与受控高光，不改变产品结构和颜色定义",
  }[requestInput.category];
  const cores = {
    safe: `${categoryDirection}。忠实执行用户要求“${summary}”，采用稳定、清晰、易核对的构图。`,
    commercial: `${categoryDirection}。忠实执行用户要求“${summary}”，强化商业布光、材质层次和视觉焦点，同时保持信息克制。`,
    creative: `${categoryDirection}。忠实执行用户要求“${summary}”，在事实和修改边界内增加景深、节奏或留白变化，不引入新事实。`,
  };
  const rationales = {
    safe: "优先保证需求准确、主体清楚和结果可控。",
    commercial: "在不增加虚构信息的前提下增强电商质感。",
    creative: "只在既有事实和边界内提供更有变化的构图。",
  };
  const variants = Object.fromEntries(Object.entries(cores).map(([id, corePrompt]) => [id, {
    title: VARIANT_TITLES[id],
    prompt: mergeFinalPrompt(corePrompt, hardRequirements, corePromptLimit),
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
