import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMPT_STUDIO_CATEGORIES,
  PROMPT_STUDIO_OUTPUT_LIMITS,
  PROMPT_STUDIO_STATE_LIMITS,
  analyzeProductImages,
  generatePromptSet,
  generatePromptSetLocally,
  interpretQuickPrompt,
  interpretQuickPromptLocally,
  normalizePromptStudioState,
  validateQuickPromptInput,
  validatePromptStudioInput,
  writeFreeformImagePrompt,
} from "./promptStudioService.js";
import { MODEL_CHANNELS, updateModelConfig } from "./modelConfigService.js";

const env = { MODEL_CONFIG_ENCRYPTION_KEY: "prompt-studio-tests" };

function modelConfig() {
  return updateModelConfig({}, {
    channel: "stable",
    apiKey: "sk-prompt-private",
    model: "gpt-4.1-mini",
  }, { env });
}

function validInput(category = "white-background") {
  const editing = ["local-edit", "background-swap"].includes(category);
  return {
    category,
    userRequest: category === "local-edit" ? "只把旋钮改成银色" : "制作专业电商图片",
    productFacts: {
      productType: "智能压力锅",
      appearance: "圆柱形黑银机身，顶部黑色锅盖，正面矩形控制面板",
      colorsMaterials: "黑色塑料锅盖，拉丝不锈钢机身",
      components: ["锅盖", "锅体", "控制面板", "旋钮"],
      logo: "SUPOR",
      existingText: ["SUPOR", "智能压力锅"],
      mustPreserve: ["产品比例", "正面控制面板"],
      forbiddenChanges: ["不得增加按键", "不得改变锅盖结构"],
    },
    style: {
      name: "明亮厨房",
      description: "现代明亮的商业电商摄影",
      lighting: "柔和自然侧光",
      composition: "主体居中，留出安全边距",
      palette: "白色与浅灰色为主",
      camera: "平视 50mm 镜头",
      forbidden: ["昏暗暖黄", "过度景深"],
    },
    copy: {
      mode: "exact",
      title: "一锅多用",
      subtitle: "智能压力锅 Pro",
      sellingPoints: ["快速烹饪", "一键排气"],
      price: "到手价 ¥499",
      campaignInfo: "新品首发",
      additionalText: ["以实际页面为准"],
    },
    parameters: { ratio: "3:4", resolution: "2k", quality: "high", background: "opaque" },
    editBoundary: editing
      ? { targetAreas: [category === "background-swap" ? "产品以外背景" : "正面旋钮"], changes: [category === "background-swap" ? "替换为明亮厨房" : "改成银色"], preserveAreas: ["产品主体", "Logo 和全部文字"] }
      : { targetAreas: [], changes: [], preserveAreas: [] },
  };
}

function factsResult() {
  return {
    facts: validInput().productFacts,
    confidence: 0.92,
    warnings: ["侧面不可见"],
  };
}

function modelPromptSet() {
  return {
    safe: { prompt: "保持原产品，使用克制的棚拍构图。", negativePrompt: "无文字，白色背景，无Logo，噪点", rationale: "优先还原产品。" },
    commercial: { prompt: "增强材质反射和商业布光。", negativePrompt: "无文字，低对比度", rationale: "提升货架吸引力。" },
    creative: { prompt: "使用更有层次的前后景构图。", negativePrompt: "无Logo，杂乱", rationale: "在边界内增强创意。" },
  };
}

function quickPromptResult(category = "product-scene") {
  const input = validInput(category);
  return {
    category,
    productFacts: input.productFacts,
    style: input.style,
    copy: input.copy,
    editBoundary: input.editBoundary,
    warnings: ["请在生图前核对产品型号"],
    recommendedVariantKey: "commercial",
  };
}

function historyRecord(index, { isFavorite = false } = {}) {
  const parameters = validInput().parameters;
  const variants = Object.fromEntries(Object.entries(modelPromptSet()).map(([key, value]) => [key, {
    title: { safe: "稳妥执行", commercial: "商业增强", creative: "创意方案" }[key],
    ...value,
    recommendedParameters: parameters,
  }]));
  return {
    id: `record-${index}`,
    name: `提示词 ${index}`,
    category: "white-background",
    request: validInput(),
    variants,
    riskChecks: [{ id: "product-consistency", label: "产品一致性", status: "pass", message: "检查通过。" }],
    selectedVariantKey: "safe",
    isFavorite,
    createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1_000).toISOString(),
    model: "test-model",
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify({ output_text: JSON.stringify(value) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("prompt input strictly supports the seven canonical categories", () => {
  assert.deepEqual(PROMPT_STUDIO_CATEGORIES, [
    "white-background",
    "product-scene",
    "campaign-poster",
    "detail-page",
    "local-edit",
    "background-swap",
    "product-retouch",
  ]);
  for (const category of PROMPT_STUDIO_CATEGORIES) {
    assert.equal(validatePromptStudioInput(validInput(category)).category, category);
  }
  assert.throws(
    () => validatePromptStudioInput({ ...validInput(), category: "white-main" }),
    (error) => error.code === "PROMPT_STUDIO_INPUT_INVALID" && error.status === 400,
  );
  assert.throws(
    () => validatePromptStudioInput({ ...validInput(), unexpected: true }),
    (error) => error.code === "PROMPT_STUDIO_INPUT_INVALID",
  );
});

test("product facts, style, copy, parameters, and edit boundaries reject invalid input", () => {
  const cases = [
    { ...validInput(), productFacts: { ...validInput().productFacts, productType: "" } },
    { ...validInput(), style: { ...validInput().style, description: "" } },
    { ...validInput(), parameters: { ...validInput().parameters, ratio: "2:3" } },
    { ...validInput(), copy: { ...validInput().copy, mode: "reserved" } },
    { ...validInput(), userRequest: "不要文字，只要产品图" },
    { ...validInput(), style: { ...validInput().style, forbidden: ["无 Logo"] } },
    { ...validInput(), parameters: { ...validInput().parameters, background: "transparent" } },
    { ...validInput("local-edit"), editBoundary: { targetAreas: [], changes: [], preserveAreas: [] } },
    { ...validInput(), productFacts: { ...validInput().productFacts, components: Array.from({ length: 25 }, () => "部件") } },
  ];
  for (const input of cases) {
    assert.throws(() => validatePromptStudioInput(input), (error) => error.code === "PROMPT_STUDIO_INPUT_INVALID");
  }
});

test("product image analysis uses /responses with data URL images and validates structured JSON", async () => {
  let request;
  const result = await analyzeProductImages(modelConfig(), {
    productName: "压力锅",
    notes: "以正面图为准",
    existingFacts: {
      productType: "",
      appearance: "",
      colorsMaterials: "",
      components: [],
      logo: "",
      existingText: [],
      mustPreserve: [],
      forbiddenChanges: [],
    },
  }, [{ mimetype: "image/png", buffer: Buffer.from("test-image") }], {
    env,
    now: () => "2026-07-17T12:00:00.000Z",
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse(factsResult());
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.stable.baseUrl}/responses`);
  assert.equal(request.init.headers.authorization, "Bearer sk-prompt-private");
  assert.equal(request.body.model, "gpt-4.1-mini");
  assert.equal(request.body.text.format.type, "json_schema");
  const image = request.body.input[1].content.find((item) => item.type === "input_image");
  assert.match(image.image_url, /^data:image\/png;base64,/);
  assert.deepEqual(result.facts, validInput().productFacts);
  assert.equal(result.confidence, 0.92);
  assert.equal(result.analyzedAt, "2026-07-17T12:00:00.000Z");
});

test("analysis explicitly rejects missing keys, non-JSON, and incomplete model output", async () => {
  const image = [{ mimetype: "image/jpeg", buffer: Buffer.from("image") }];
  await assert.rejects(
    analyzeProductImages({}, {}, image, { env }),
    (error) => error.code === "MODEL_API_KEY_MISSING" && /API Key/.test(error.message),
  );
  await assert.rejects(
    analyzeProductImages(modelConfig(), {}, image, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }),
    }),
    (error) => error.code === "PROMPT_MODEL_INVALID_JSON" && error.status === 502,
  );
  await assert.rejects(
    analyzeProductImages(modelConfig(), {}, image, {
      env,
      fetchImpl: async () => jsonResponse({ facts: { productType: "锅" }, confidence: 0.8, warnings: [] }),
    }),
    (error) => error.code === "PROMPT_MODEL_SCHEMA_INVALID" && /字段不完整/.test(error.message),
  );
});

test("freeform prompt help returns the real model prompt without templates or hidden creative rules", async () => {
  const finalPrompt = "一幅大胆而精致的国庆主题视觉，金色光轨穿过深红空间，城市轮廓与飘带形成强烈纵深，主标题融入中央视觉焦点。";
  let request;
  const result = await writeFreeformImagePrompt(modelConfig(), {
    userRequest: "做一张有高级感的国庆海报",
    creationMode: "free",
  }, {
    env,
    productImages: [{ mimetype: "image/png", buffer: Buffer.from("reference") }],
    idempotencyKey: "freeform-test",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: finalPrompt } }] }), { status: 200 });
    },
  });

  assert.deepEqual(result, { prompt: finalPrompt, model: "gpt-4.1-mini" });
  assert.equal(request.url, `${MODEL_CHANNELS.stable.baseUrl}/chat/completions`);
  assert.equal(request.body.messages[1].content.filter((item) => item.type === "image_url").length, 1);
  assert.equal(request.body.messages[0].content, "根据用户需求自由发挥，写出你认为最好的生图提示词。");
  assert.doesNotMatch(request.body.messages[0].content, /稳妥执行|商业增强|创意方案|产品事实|类目硬约束|主标题|副标题|卖点/);
  assert.equal(request.body.messages[1].content[0].text, "用户需求：做一张有高级感的国庆海报");
});

test("freeform prompt help fails visibly instead of substituting a local template", async () => {
  await assert.rejects(
    writeFreeformImagePrompt(modelConfig(), { userRequest: "国庆海报", creationMode: "free" }, {
      env,
      fetchImpl: async () => new Response("upstream timeout", { status: 524 }),
    }),
    (error) => error.status === 524 && !/本地规则保底/.test(error.message),
  );
});

test("freeform prompt help retries one transient 524 with the same idempotency key", async () => {
  let calls = 0;
  const keys = [];
  const result = await writeFreeformImagePrompt(modelConfig(), { userRequest: "国庆海报", creationMode: "free" }, {
    env,
    idempotencyKey: "freeform-524-retry",
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      keys.push(init.headers["idempotency-key"]);
      if (calls === 1) return new Response("gateway timeout", { status: 524 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "自由创作的国庆海报提示词" } }] }), { status: 200 });
    },
  });

  assert.equal(result.prompt, "自由创作的国庆海报提示词");
  assert.equal(calls, 2);
  assert.deepEqual(keys, ["freeform-524-retry", "freeform-524-retry"]);
});

test("quick prompt interpretation defaults parameters and locks the original user request", async () => {
  let request;
  const userRequest = "把这个压力锅放进明亮厨房，做成真实的电商场景图";
  const validated = validateQuickPromptInput({ userRequest });
  assert.deepEqual(validated.parameters, {
    ratio: "1:1",
    resolution: "2k",
    quality: "high",
    background: "auto",
  });
  assert.equal(validated.creationMode, undefined);
  assert.equal(validated.saveHistory, true);
  const result = await interpretQuickPrompt(modelConfig(), { userRequest }, {
    env,
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return jsonResponse(quickPromptResult());
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.stable.baseUrl}/responses`);
  assert.equal(request.body.model, "gpt-4.1-mini");
  assert.equal(request.body.text.format.name, "quick_prompt_interpretation");
  assert.equal(result.input.userRequest, userRequest);
  assert.deepEqual(result.input.parameters, {
    ratio: "1:1",
    resolution: "2k",
    quality: "high",
    background: "auto",
  });
  assert.equal(result.input.category, "product-scene");
  assert.equal(result.recommendedVariantKey, "commercial");
  assert.equal(result.model, "gpt-4.1-mini");
  assert.match(request.body.input[1].content[0].text, /当前未指定创作模式：有参考图时锁定产品事实，无参考图时只根据用户原话自由设计/);
  assert.doesNotMatch(request.body.input[1].content[0].text, /saveHistory/);
});

test("quick prompt input rejects invalid creation controls", () => {
  assert.throws(
    () => validateQuickPromptInput({ userRequest: "制作商品图", creationMode: "unknown" }),
    (error) => error.code === "PROMPT_STUDIO_INPUT_INVALID" && error.status === 400 && /creationMode/.test(error.message),
  );
  assert.throws(
    () => validateQuickPromptInput({ userRequest: "制作商品图", saveHistory: "false" }),
    (error) => error.code === "PROMPT_STUDIO_INPUT_INVALID" && error.status === 400 && /saveHistory/.test(error.message),
  );
});

test("product creation requires a reference while free creation can run without one", async () => {
  let upstreamCalled = false;
  await assert.rejects(
    interpretQuickPrompt(modelConfig(), { userRequest: "制作商品主图", creationMode: "product" }, {
      env,
      fetchImpl: async () => {
        upstreamCalled = true;
        return jsonResponse(quickPromptResult("white-background"));
      },
    }),
    (error) => error.code === "PROMPT_PRODUCT_IMAGE_MISSING" && error.status === 400 && /至少一张产品参考图/.test(error.message),
  );
  assert.equal(upstreamCalled, false);

  let request;
  const result = await interpretQuickPrompt(modelConfig(), {
    userRequest: "生成一个未来感厨房场景",
    creationMode: "free",
    saveHistory: false,
  }, {
    env,
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return jsonResponse(quickPromptResult("product-scene"));
    },
  });
  assert.equal(result.input.category, "product-scene");
  assert.match(request.body.input[1].content[0].text, /当前为自由生图模式：允许没有产品参考图/);
  assert.doesNotMatch(request.body.input[1].content[0].text, /saveHistory/);
});

test("simple free requests can be interpreted and assembled locally when the prompt gateway is unavailable", () => {
  const interpreted = interpretQuickPromptLocally({
    userRequest: "年货节宣传海报",
    creationMode: "free",
    parameters: { ratio: "4:3", resolution: "2k", quality: "high", background: "opaque" },
  }, { reason: "提示词通道上游响应超时（524），已使用本地规则。" });
  assert.equal(interpreted.input.category, "campaign-poster");
  assert.deepEqual(interpreted.input.copy, {
    mode: "none",
    title: "",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  });
  assert.match(interpreted.warnings[0], /524/);

  const generated = generatePromptSetLocally(interpreted.input, {
    configuredModel: "gpt-5.6-sol",
    now: () => "2026-07-18T07:00:00.000Z",
  });
  assert.equal(generated.model, "gpt-5.6-sol / 本地规则保底");
  assert.equal(generated.createdAt, "2026-07-18T07:00:00.000Z");
  assert.deepEqual(Object.keys(generated.variants), ["safe", "commercial", "creative"]);
  assert.ok(generated.riskChecks.every((item) => item.status === "pass"));
  for (const variant of Object.values(generated.variants)) {
    const visible = variant.prompt.split("以下为服务端硬约束")[0];
    assert.match(visible, /年货节宣传海报/);
    assert.doesNotMatch(visible, /新春焕新季|新年好物|品质好物|焕新日常|主标题|副标题|卖点/);
    assert.match(variant.prompt, /清晰可读/);
    assert.match(variant.negativePrompt, /乱码/);
    assert.match(variant.negativePrompt, /以下为服务端基础排除规则/);
  }
});

test("local prompt fallback preserves only explicit copy and never invents a poster template", () => {
  const noText = interpretQuickPromptLocally({ userRequest: "国庆无字底图，只预留后期排版区域", creationMode: "free" });
  assert.equal(noText.input.category, "campaign-poster");
  assert.deepEqual(noText.input.copy, {
    mode: "reserved",
    title: "",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  });

  for (const request of ["国庆海报，不要文案", "活动海报，不需要文字", "促销海报，只要背景不要加字", "国庆海报不放字", "活动海报不显示任何文字"]) {
    const textFree = interpretQuickPromptLocally({ userRequest: request, creationMode: "free" });
    assert.equal(textFree.input.category, "campaign-poster", request);
    assert.equal(textFree.input.copy.mode, "reserved", request);
  }

  const festivalVisual = interpretQuickPromptLocally({ userRequest: "国庆节日氛围图，红金配色", creationMode: "free" });
  assert.equal(festivalVisual.input.category, "campaign-poster");
  assert.equal(festivalVisual.input.copy.mode, "none");

  const activityScene = interpretQuickPromptLocally({ userRequest: "户外活动场景图", creationMode: "free" });
  assert.equal(activityScene.input.category, "product-scene");
  assert.equal(activityScene.input.copy.mode, "none");

  for (const request of ["详情图", "卖点图", "功能图"]) {
    const detail = interpretQuickPromptLocally({ userRequest: request, creationMode: "free" });
    assert.equal(detail.input.category, "detail-page", request);
    assert.equal(detail.input.copy.mode, "none", request);
  }

  const scene = interpretQuickPromptLocally({ userRequest: "生成一个未来感厨房场景", creationMode: "free" });
  assert.equal(scene.input.category, "product-scene");
  assert.equal(scene.input.copy.mode, "none");

  for (const request of [
    "活动海报，预留文案区，主标题写“新品上市”",
    "海报文字不要太小，标题写“焕新生活”",
    "删除旧文字后换新标题，标题写“夏日上新”",
  ]) {
    const withCopy = interpretQuickPromptLocally({ userRequest: request, creationMode: "free" });
    assert.equal(withCopy.input.copy.mode, "exact", request);
    assert.ok(withCopy.input.copy.title, request);
  }
  assert.equal(interpretQuickPromptLocally({ userRequest: "海报不要生成文字乱码", creationMode: "free" }).input.copy.mode, "none");
});

test("model interpretation does not replace an empty poster plan with a fixed copy template", async () => {
  const modelResult = quickPromptResult("campaign-poster");
  modelResult.copy = { mode: "reserved", title: "", subtitle: "", sellingPoints: [], price: "", campaignInfo: "", additionalText: [] };
  let request;
  const interpreted = await interpretQuickPrompt(modelConfig(), { userRequest: "做一张智能压力锅活动海报", creationMode: "product" }, {
    env,
    productImages: [{ mimetype: "image/png", buffer: Buffer.from("product") }],
    fetchImpl: async (url, init) => {
      request = JSON.parse(init.body);
      return jsonResponse(modelResult);
    },
  });
  assert.deepEqual(interpreted.input.copy, {
    mode: "none",
    title: "",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  });
  assert.match(request.input[0].content[0].text, /不要套用固定口号、固定节日文案、固定配色或固定版式/);
  assert.doesNotMatch(request.input[0].content[0].text, /必须给出可编辑的中文主标题、副标题和 1 至 3 个短卖点/);
});

test("model poster copy stays creative without server templates or keyword filtering", async () => {
  async function interpretCopy(userRequest, copy) {
    const modelResult = quickPromptResult("campaign-poster");
    modelResult.copy = copy;
    return interpretQuickPrompt(modelConfig(), { userRequest, creationMode: "product" }, {
      env,
      productImages: [{ mimetype: "image/png", buffer: Buffer.from("product") }],
      fetchImpl: async () => jsonResponse(modelResult),
    });
  }

  const freeCopy = {
    mode: "exact",
    title: "围炉见新",
    subtitle: "让年味自然发生",
    sellingPoints: ["暖意入席", "好物相伴"],
    price: "",
    campaignInfo: "",
    additionalText: [],
  };
  const creative = await interpretCopy("做一张智能压力锅年货节海报", freeCopy);
  assert.deepEqual(creative.input.copy, freeCopy);

  const explicit = await interpretCopy("做一张海报，主标题写“夏日上新”", {
    mode: "exact",
    title: "夏日新品",
    subtitle: "轻盈色彩，点亮日常",
    sellingPoints: ["质感呈现"],
    price: "",
    campaignInfo: "",
    additionalText: [],
  });
  assert.equal(explicit.input.copy.title, "夏日上新");
  assert.equal(explicit.input.copy.subtitle, "轻盈色彩，点亮日常");
  assert.deepEqual(explicit.input.copy.sellingPoints, ["质感呈现"]);
});

test("visible prompt plans contain creative direction and editable copy but no backend control language", async () => {
  const modelResult = modelPromptSet();
  for (const variant of Object.values(modelResult)) {
    variant.prompt = "红金主题形成前中后景与鲜明节奏；不得虚构价格；禁止改变产品结构。";
  }
  const generated = await generatePromptSet(modelConfig(), validInput("campaign-poster"), {
    env,
    fetchImpl: async () => jsonResponse(modelResult),
  });
  const localInput = { ...validInput("campaign-poster"), userRequest: "国庆活动海报，不要编造价格" };
  const local = generatePromptSetLocally(localInput);
  for (const variant of Object.values(generated.variants)) {
    assert.match(variant.prompt.split("以下为服务端硬约束")[0], /前中后景|节奏|主题/);
  }
  for (const result of [generated, local]) {
    for (const variant of Object.values(result.variants)) {
      const visible = variant.prompt.split("以下为服务端硬约束")[0];
      assert.match(visible, /【文案原文（可编辑）】/);
      assert.doesNotMatch(visible, /不得|禁止|不虚构|不允许|硬约束|安全规则|服务端规则|后台规则|不引入任何新事实/);
      assert.match(variant.prompt, /以下为服务端硬约束/);
    }
  }
});

test("model poster copy keeps non-factual atmosphere language", async () => {
  const modelResult = quickPromptResult("campaign-poster");
  modelResult.copy = {
    mode: "exact",
    title: "让美好自然发生",
    subtitle: "轻盈色彩，点亮日常",
    sellingPoints: ["质感呈现", "焕新日常"],
    price: "",
    campaignInfo: "",
    additionalText: [],
  };
  const interpreted = await interpretQuickPrompt(modelConfig(), {
    userRequest: "做一张智能压力锅活动海报",
    creationMode: "product",
  }, {
    env,
    productImages: [{ mimetype: "image/png", buffer: Buffer.from("product") }],
    fetchImpl: async () => jsonResponse(modelResult),
  });
  assert.deepEqual(interpreted.input.copy, modelResult.copy);
  assert.doesNotMatch(interpreted.warnings.join(" "), /已改用中性文案/);
});

test("model poster copy may use a natural one-line structure without server augmentation", async () => {
  const modelResult = quickPromptResult("campaign-poster");
  modelResult.copy = {
    mode: "exact",
    title: "围炉见新",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  };
  const interpreted = await interpretQuickPrompt(modelConfig(), {
    userRequest: "年货节宣传海报",
    creationMode: "product",
  }, {
    env,
    productImages: [{ mimetype: "image/png", buffer: Buffer.from("product") }],
    fetchImpl: async () => jsonResponse(modelResult),
  });
  assert.deepEqual(interpreted.input.copy, modelResult.copy);
  assert.doesNotMatch(JSON.stringify(interpreted.input.copy), /新春焕新季|新年好物|品质好物|焕新日常/);
});

test("prompt generation retries one idempotent transient failure with jitter but does not retry 524", async () => {
  const calls = [];
  const delays = [];
  const generated = await generatePromptSet(modelConfig(), validInput("campaign-poster"), {
    env,
    idempotencyKey: "quick-request.generate",
    random: () => 0.5,
    sleep: async (delayMs) => { delays.push(delayMs); },
    fetchImpl: async (url, init) => {
      calls.push({ url, key: init.headers["idempotency-key"] });
      return calls.length === 1
        ? new Response("gateway busy", { status: 503 })
        : jsonResponse(modelPromptSet());
    },
  });
  assert.equal(generated.model, "gpt-4.1-mini");
  assert.deepEqual(calls.map((call) => call.key), ["quick-request.generate", "quick-request.generate"]);
  assert.deepEqual(delays, [290]);

  let timeoutCalls = 0;
  await assert.rejects(
    generatePromptSet(modelConfig(), validInput("campaign-poster"), {
      env,
      idempotencyKey: "quick-request.uncertain",
      sleep: async () => assert.fail("524 must not be retried"),
      fetchImpl: async () => {
        timeoutCalls += 1;
        return new Response("upstream timeout", { status: 524 });
      },
    }),
    (error) => error.status === 524,
  );
  assert.equal(timeoutCalls, 1);
});

test("quick prompt interpretation sends up to three validated product images", async () => {
  let request;
  const files = [
    { mimetype: "image/png", buffer: Buffer.from("front") },
    { mimetype: "image/webp", buffer: Buffer.from("side") },
  ];
  await interpretQuickPrompt(modelConfig(), { userRequest: "为产品制作白底主图", creationMode: "product" }, {
    env,
    productImages: files,
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return jsonResponse(quickPromptResult("white-background"));
    },
  });
  const images = request.body.input[1].content.filter((item) => item.type === "input_image");
  assert.equal(images.length, 2);
  assert.match(images[0].image_url, /^data:image\/png;base64,/);
  assert.match(images[1].image_url, /^data:image\/webp;base64,/);
  assert.match(request.body.input[1].content[0].text, /当前为商品生图模式/);
});

test("quick prompt interpretation preserves explicit generation parameters", async () => {
  const parameters = { ratio: "16:9", resolution: "4k", quality: "medium", background: "opaque" };
  const result = await interpretQuickPrompt(modelConfig(), {
    userRequest: "制作横版活动海报",
    parameters,
  }, {
    env,
    fetchImpl: async () => jsonResponse(quickPromptResult("campaign-poster")),
  });
  assert.deepEqual(result.input.parameters, parameters);
});

test("quick prompt interpretation rejects invalid structured model output", async () => {
  const incomplete = quickPromptResult();
  delete incomplete.style;
  await assert.rejects(
    interpretQuickPrompt(modelConfig(), { userRequest: "制作产品场景图" }, {
      env,
      fetchImpl: async () => jsonResponse(incomplete),
    }),
    (error) => error.code === "PROMPT_MODEL_SCHEMA_INVALID" && error.status === 502 && /style/.test(error.message),
  );
});

test("quick prompt interpretation requires a reference image for local edits and background swaps", async () => {
  for (const category of ["local-edit", "background-swap"]) {
    await assert.rejects(
      interpretQuickPrompt(modelConfig(), { userRequest: category === "local-edit" ? "把旋钮改成银色" : "把背景换成厨房" }, {
        env,
        fetchImpl: async () => jsonResponse(quickPromptResult(category)),
      }),
      (error) => error.code === "PROMPT_EDIT_IMAGE_REQUIRED" && error.status === 400 && /参考图/.test(error.message),
    );
  }
});

test("prompt generation separates product and style images and server-appends all hard requirements", async () => {
  let request;
  const input = validInput("white-background");
  const result = await generatePromptSet(modelConfig(), input, {
    env,
    now: () => "2026-07-17T12:30:00.000Z",
    productImages: [{ mimetype: "image/png", buffer: Buffer.from("product") }],
    styleImages: [{ mimetype: "image/webp", buffer: Buffer.from("style") }],
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return jsonResponse(modelPromptSet());
    },
  });
  assert.equal(request.url, `${MODEL_CHANNELS.stable.baseUrl}/responses`);
  assert.equal(request.body.input[1].content.filter((item) => item.type === "input_image").length, 2);
  assert.match(request.body.input[1].content.find((item) => item.type === "input_text" && item.text.includes("产品参考图")).text, /产品身份/);
  assert.match(request.body.input[1].content.find((item) => item.type === "input_text" && item.text.includes("风格参考图")).text, /禁止复制其中的产品/);
  assert.match(request.body.input[1].content[0].text, /每套 prompt 不得超过 \d+ 个字符/);

  for (const [key, variant] of Object.entries(result.variants)) {
    assert.equal(variant.title, { safe: "稳妥执行", commercial: "商业增强", creative: "创意方案" }[key]);
    assert.match(variant.prompt, /【产品事实】/);
    assert.match(variant.prompt, /第 1 张为产品图/);
    assert.match(variant.prompt, /第 2 张为风格图/);
    assert.match(variant.prompt, /智能压力锅/);
    assert.match(variant.prompt, /SUPOR/);
    assert.match(variant.prompt, /【风格方案】/);
    assert.match(variant.prompt, /现代明亮的商业电商摄影/);
    assert.match(variant.prompt, /一锅多用/);
    assert.match(variant.prompt, /到手价 ¥499/);
    assert.match(variant.prompt, /使用纯净白底/);
    assert.doesNotMatch(variant.prompt, /【输出参数】/);
    assert.match(variant.prompt, /结构化生成参数控制/);
    assert.deepEqual(variant.recommendedParameters, input.parameters);
    assert.doesNotMatch(variant.negativePrompt, /无文字|白色背景|无Logo/);
    assert.match(variant.negativePrompt, /乱码/);
    assert.ok(variant.prompt.length <= PROMPT_STUDIO_OUTPUT_LIMITS.prompt);
    assert.ok(variant.negativePrompt.length <= PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt);
  }
  assert.deepEqual(result.riskChecks.map((item) => [item.id, item.status]), [
    ["product-consistency", "pass"],
    ["text-integrity", "pass"],
    ["edit-boundary", "pass"],
    ["style-consistency", "pass"],
    ["parameters", "pass"],
  ]);
  assert.equal(result.createdAt, "2026-07-17T12:30:00.000Z");
});

test("local edit final prompts preserve every explicit boundary", async () => {
  const input = validInput("local-edit");
  const result = await generatePromptSet(modelConfig(), input, {
    env,
    fetchImpl: async () => jsonResponse(modelPromptSet()),
  });
  for (const variant of Object.values(result.variants)) {
    assert.match(variant.prompt, /正面旋钮/);
    assert.match(variant.prompt, /改成银色/);
    assert.match(variant.prompt, /Logo 和全部文字/);
    assert.match(variant.prompt, /只能修改明确指定的目标区域/);
  }
  assert.equal(result.riskChecks.find((item) => item.id === "edit-boundary").status, "pass");
});

test("deterministic checks expose contradictory model instructions instead of reporting a false pass", async () => {
  const conflicting = modelPromptSet();
  conflicting.safe.prompt = "删除 SUPOR Logo，改变产品结构，并改写标题。";
  conflicting.safe.negativePrompt = "智能压力锅，现代明亮的商业电商摄影";
  const result = await generatePromptSet(modelConfig(), validInput(), {
    env,
    fetchImpl: async () => jsonResponse(conflicting),
  });
  assert.equal(result.riskChecks.find((item) => item.id === "product-consistency").status, "error");
  assert.equal(result.riskChecks.find((item) => item.id === "text-integrity").status, "error");
  assert.doesNotMatch(result.variants.safe.negativePrompt, /智能压力锅|现代明亮的商业电商摄影/);
});

test("prompt generation never truncates hard requirements when the model core or confirmed facts exceed the final limit", async () => {
  const oversizedModelResult = modelPromptSet();
  oversizedModelResult.safe.prompt = "核心画面".repeat(1_000);
  await assert.rejects(
    generatePromptSet(modelConfig(), validInput(), {
      env,
      fetchImpl: async () => jsonResponse(oversizedModelResult),
    }),
    (error) => error.code === "PROMPT_MODEL_OUTPUT_TOO_LONG"
      && error.status === 502
      && /未保存|未截断/.test(error.message),
  );

  const oversizedFacts = validInput();
  oversizedFacts.productFacts.appearance = "外形".repeat(500);
  oversizedFacts.productFacts.colorsMaterials = "材质".repeat(500);
  oversizedFacts.productFacts.components = Array.from({ length: 24 }, (_, index) => `部件${index}-${"细节".repeat(95)}`);
  let called = false;
  await assert.rejects(
    generatePromptSet(modelConfig(), oversizedFacts, {
      env,
      fetchImpl: async () => {
        called = true;
        return jsonResponse(modelPromptSet());
      },
    }),
    (error) => error.code === "PROMPT_HARD_REQUIREMENTS_TOO_LONG"
      && error.status === 400
      && /硬约束未被截断/.test(error.message),
  );
  assert.equal(called, false);
});

test("prompt generation fits model negative phrases around complete server safety rules", async () => {
  const longNegative = modelPromptSet();
  const segments = Array.from({ length: 45 }, (_, index) => `模型排除项${index}-${"内容".repeat(17)}`);
  longNegative.safe.negativePrompt = segments.join("，");
  assert.ok(longNegative.safe.negativePrompt.length <= 2_000);

  const result = await generatePromptSet(modelConfig(), validInput(), {
    env,
    fetchImpl: async () => jsonResponse(longNegative),
  });
  assert.ok(result.variants.safe.negativePrompt.length <= PROMPT_STUDIO_OUTPUT_LIMITS.negativePrompt);
  assert.match(result.variants.safe.negativePrompt, /低清晰度/);
  assert.match(result.variants.safe.negativePrompt, /文案增删/);
  assert.doesNotMatch(result.variants.safe.negativePrompt, /无文字|无Logo/);
});

test("negative artifact wording keeps QR codes, barcodes, and watermarks blocked", async () => {
  for (const userRequest of [
    "做一张活动海报，不要二维码、条形码或水印。",
    "做一张活动海报，画面无二维码、条形码或水印。",
  ]) {
    const input = {
      ...validInput("campaign-poster"),
      userRequest,
      copy: {
        mode: "none",
        title: "",
        subtitle: "",
        sellingPoints: [],
        price: "",
        campaignInfo: "",
        additionalText: [],
      },
    };
    const modelResult = modelPromptSet();
    for (const variant of Object.values(modelResult)) variant.negativePrompt = "";
    const result = await generatePromptSet(modelConfig(), input, {
      env,
      fetchImpl: async () => jsonResponse(modelResult),
    });
    assert.match(result.variants.safe.negativePrompt, /二维码/);
    assert.match(result.variants.safe.negativePrompt, /条形码/);
    assert.match(result.variants.safe.negativePrompt, /水印/);
  }
});

test("positive artifact wording can intentionally opt into QR codes and watermarks", async () => {
  const input = {
    ...validInput("campaign-poster"),
    userRequest: "请在右下角添加一个二维码，并保留品牌水印。",
    copy: {
      mode: "none",
      title: "",
      subtitle: "",
      sellingPoints: [],
      price: "",
      campaignInfo: "",
      additionalText: [],
    },
  };
  const modelResult = modelPromptSet();
  for (const variant of Object.values(modelResult)) variant.negativePrompt = "";
  const result = await generatePromptSet(modelConfig(), input, {
    env,
    fetchImpl: async () => jsonResponse(modelResult),
  });
  assert.doesNotMatch(result.variants.safe.negativePrompt, /二维码/);
  assert.doesNotMatch(result.variants.safe.negativePrompt, /水印/);
});

test("prompt generation rejects too many images and incomplete model variants", async () => {
  const files = Array.from({ length: 5 }, (_, index) => ({ mimetype: "image/png", buffer: Buffer.from(`image-${index}`) }));
  await assert.rejects(
    generatePromptSet(modelConfig(), validInput(), { env, productImages: files }),
    (error) => error.code === "PROMPT_IMAGE_COUNT_EXCEEDED",
  );
  const incomplete = modelPromptSet();
  delete incomplete.creative;
  await assert.rejects(
    generatePromptSet(modelConfig(), validInput(), {
      env,
      fetchImpl: async () => jsonResponse(incomplete),
    }),
    (error) => error.code === "PROMPT_MODEL_SCHEMA_INVALID" && /creative/.test(error.message),
  );
});

test("prompt studio state keeps only schema-valid profiles, presets, and history", () => {
  const input = validInput();
  const productProfile = { id: "product-1", name: "压力锅", ...input.productFacts, updatedAt: "2026-07-17T00:00:00.000Z" };
  const stylePreset = { id: "style-1", ...input.style, updatedAt: "2026-07-17T00:00:00.000Z" };
  const state = normalizePromptStudioState({
    productProfiles: [productProfile, { ...productProfile, unexpected: true }, { legacyName: "旧产品档案" }],
    stylePresets: [stylePreset, { ...stylePreset, updatedAt: "not-a-date" }, { legacyStyle: "旧风格" }],
    records: [historyRecord(0), { ...historyRecord(1), variants: undefined }, { id: "legacy-history" }],
    libraryFavorites: ["campaign-poster", "campaign-poster", "Invalid-ID", "bad_id", "x".repeat(81), 42],
    ignored: [{ id: "must-not-leak" }],
  });
  assert.deepEqual(Object.keys(state), ["productProfiles", "stylePresets", "records", "quickRequests", "libraryFavorites"]);
  assert.deepEqual(state.productProfiles, [productProfile]);
  assert.deepEqual(state.stylePresets, [stylePreset]);
  assert.deepEqual(state.records, [historyRecord(0)]);
  assert.deepEqual(state.libraryFavorites, ["campaign-poster"]);
  assert.deepEqual(normalizePromptStudioState(), { productProfiles: [], stylePresets: [], records: [], quickRequests: [], libraryFavorites: [] });
});

test("prompt studio state caps unique safe library favorite IDs", () => {
  const libraryFavorites = Array.from({ length: PROMPT_STUDIO_STATE_LIMITS.libraryFavorites + 1 }, (_, index) => `template-${index}`);
  const state = normalizePromptStudioState({ libraryFavorites });
  assert.equal(state.libraryFavorites.length, PROMPT_STUDIO_STATE_LIMITS.libraryFavorites);
  assert.deepEqual(state.libraryFavorites, libraryFavorites.slice(0, PROMPT_STUDIO_STATE_LIMITS.libraryFavorites));
});

test("prompt studio state evicts the oldest non-favorite before an older favorite", () => {
  const records = Array.from({ length: PROMPT_STUDIO_STATE_LIMITS.records + 1 }, (_, index) => historyRecord(index, {
    isFavorite: index === PROMPT_STUDIO_STATE_LIMITS.records,
  }));
  const state = normalizePromptStudioState({ records });
  assert.equal(state.records.length, PROMPT_STUDIO_STATE_LIMITS.records);
  assert.equal(state.records[0].id, "record-0");
  assert.equal(state.records.at(-1).id, `record-${PROMPT_STUDIO_STATE_LIMITS.records}`);
  assert.equal(state.records.some((item) => item.id === `record-${PROMPT_STUDIO_STATE_LIMITS.records - 1}`), false);
  assert.equal(state.records.at(-1).isFavorite, true);
});
