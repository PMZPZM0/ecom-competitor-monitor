import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-prompt-studio-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";
process.env.MODEL_STABLE_API_KEY = "sk-prompt-route-test";
process.env.MODEL_CONFIG_ENCRYPTION_KEY = "prompt-route-encryption-test";

const { startServer, stopServer } = await import("../index.js");

const productFacts = {
  productType: "智能压力锅",
  appearance: "圆柱形黑银机身，顶部黑色锅盖，正面矩形控制面板",
  colorsMaterials: "黑色塑料锅盖，拉丝不锈钢机身",
  components: ["锅盖", "锅体", "控制面板", "旋钮"],
  logo: "SUPOR",
  existingText: ["SUPOR", "智能压力锅"],
  mustPreserve: ["产品比例", "控制面板"],
  forbiddenChanges: ["不得增加按键", "不得改变锅盖结构"],
};

const style = {
  name: "明亮厨房",
  description: "现代明亮的商业电商摄影",
  lighting: "柔和自然侧光",
  composition: "主体居中，右侧保留文案空间",
  palette: "白色、浅灰色和少量绿色",
  camera: "平视 50mm 镜头",
  forbidden: ["昏暗暖黄", "杂乱背景"],
};

const generationRequest = {
  category: "campaign-poster",
  userRequest: "制作清爽的新品活动海报，产品为第一视觉",
  productFacts,
  style,
  copy: {
    mode: "exact",
    title: "新品首发",
    subtitle: "一锅多用",
    sellingPoints: ["快速烹饪", "一键排气"],
    price: "到手价 ¥499",
    campaignInfo: "活动时间 7 月 20 日",
    additionalText: ["以实际页面为准"],
  },
  parameters: { ratio: "3:4", resolution: "2k", quality: "high", background: "opaque" },
  editBoundary: { targetAreas: [], changes: [], preserveAreas: productFacts.mustPreserve },
};

const analyzedProduct = {
  facts: productFacts,
  confidence: 0.94,
  warnings: ["产品背面不可见"],
};

const modelPromptSet = {
  safe: {
    prompt: "保持产品正面完整，以克制的棚拍构图呈现。",
    negativePrompt: "无文字，噪点",
    rationale: "产品还原优先。",
  },
  commercial: {
    prompt: "增强金属材质、商业布光和活动层级。",
    negativePrompt: "低对比度，杂乱",
    rationale: "强化电商转化表现。",
  },
  creative: {
    prompt: "使用更有纵深的场景构图，同时保持产品正面清晰。",
    negativePrompt: "无 Logo，产品遮挡",
    rationale: "在产品约束内增强画面创意。",
  },
};

const quickPromptInput = {
  userRequest: "给这款压力锅制作活动海报，标题必须写‘夏日焕新’，产品放中间，不要添加价格。",
  parameters: { ratio: "3:4", resolution: "4k", quality: "high", background: "opaque" },
};

const quickFreeHistoryInput = {
  ...quickPromptInput,
  userRequest: "自由生成一张清爽的夏日厨房活动海报。",
  creationMode: "free",
  saveHistory: true,
};

const quickProductNoHistoryInput = {
  ...quickPromptInput,
  userRequest: "根据参考图生成一张商品活动海报，但不要保存提示词历史。",
  creationMode: "product",
  saveHistory: false,
  clientRequestId: "2c9f0c7b-5f5d-4e56-9bb6-66ce7f9ad1e4",
};

const quickPromptInterpretation = {
  category: "campaign-poster",
  productFacts,
  style,
  copy: {
    mode: "exact",
    title: "夏日焕新",
    subtitle: "",
    sellingPoints: [],
    price: "",
    campaignInfo: "",
    additionalText: [],
  },
  editBoundary: { targetAreas: [], changes: [], preserveAreas: productFacts.mustPreserve },
  warnings: ["用户未提供活动价格，未写入价格文案。"],
  recommendedVariantKey: "commercial",
};

const interpretedQuickRequest = {
  category: quickPromptInterpretation.category,
  userRequest: quickPromptInput.userRequest,
  productFacts,
  style,
  copy: quickPromptInterpretation.copy,
  parameters: quickPromptInput.parameters,
  editBoundary: quickPromptInterpretation.editBoundary,
};

async function api(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("prompt studio routes persist profiles, presets, generated variants, and history across restart", async () => {
  let server = await startServer({ port: 0 });
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const upstreamRequests = [];

  try {
    const empty = await api(nativeFetch, `${baseUrl}/api/prompt-studio`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { productProfiles: [], stylePresets: [], history: [], libraryFavorites: [] });

    const favoriteTemplate = await api(nativeFetch, `${baseUrl}/api/prompt-studio/library-favorites/campaign-poster`, jsonOptions("PATCH", {
      favorite: true,
    }));
    assert.equal(favoriteTemplate.status, 200);
    assert.deepEqual(favoriteTemplate.body, { libraryFavorites: ["campaign-poster"] });

    const duplicateFavorite = await api(nativeFetch, `${baseUrl}/api/prompt-studio/library-favorites/campaign-poster`, jsonOptions("PATCH", {
      favorite: true,
    }));
    assert.equal(duplicateFavorite.status, 200);
    assert.deepEqual(duplicateFavorite.body, favoriteTemplate.body);

    const invalidFavoriteBody = await api(nativeFetch, `${baseUrl}/api/prompt-studio/library-favorites/campaign-poster`, jsonOptions("PATCH", {
      favorite: true,
      unexpected: true,
    }));
    assert.equal(invalidFavoriteBody.status, 400);

    const invalidFavoriteId = await api(nativeFetch, `${baseUrl}/api/prompt-studio/library-favorites/Invalid_ID`, jsonOptions("PATCH", {
      favorite: true,
    }));
    assert.equal(invalidFavoriteId.status, 400);

    const createdProfile = await api(nativeFetch, `${baseUrl}/api/prompt-studio/product-profiles`, jsonOptions("POST", {
      name: "压力锅产品档案",
      ...productFacts,
    }));
    assert.equal(createdProfile.status, 201);
    assert.match(createdProfile.body.id, /^prompt_product_/);
    assert.equal(createdProfile.body.name, "压力锅产品档案");

    const updatedProfile = await api(nativeFetch, `${baseUrl}/api/prompt-studio/product-profiles/${createdProfile.body.id}`, jsonOptions("PATCH", {
      name: "压力锅标准档案",
      colorsMaterials: "黑色耐热塑料锅盖，拉丝不锈钢机身",
    }));
    assert.equal(updatedProfile.status, 200);
    assert.equal(updatedProfile.body.name, "压力锅标准档案");
    assert.match(updatedProfile.body.colorsMaterials, /耐热塑料/);

    const rejectedLongStyleName = await api(nativeFetch, `${baseUrl}/api/prompt-studio/style-presets`, jsonOptions("POST", {
      ...style,
      name: "风".repeat(101),
    }));
    assert.equal(rejectedLongStyleName.status, 400);

    const createdStyle = await api(nativeFetch, `${baseUrl}/api/prompt-studio/style-presets`, jsonOptions("POST", style));
    assert.equal(createdStyle.status, 201);
    assert.match(createdStyle.body.id, /^prompt_style_/);

    const updatedStyle = await api(nativeFetch, `${baseUrl}/api/prompt-studio/style-presets/${createdStyle.body.id}`, jsonOptions("PATCH", {
      lighting: "柔和自然侧光，并使用轻微轮廓光",
    }));
    assert.equal(updatedStyle.status, 200);
    assert.match(updatedStyle.body.lighting, /轮廓光/);

    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      upstreamRequests.push({ url: String(url), body });
      const name = body?.text?.format?.name;
      const requestText = JSON.stringify(body?.input || []);
      if (name === "prompt_set" && requestText.includes("国庆海报")) {
        return new Response("upstream timeout", { status: 524 });
      }
      if (name === "prompt_set" && requestText.includes("超时海报")) {
        throw new DOMException("request timed out", "TimeoutError");
      }
      if (name === "quick_prompt_interpretation" && requestText.includes("参考图超时测试")) {
        return new Response("upstream timeout", { status: 524 });
      }
      const output = name === "product_facts"
        ? analyzedProduct
        : name === "quick_prompt_interpretation"
          ? quickPromptInterpretation
          : name === "prompt_set"
            ? modelPromptSet
            : name === "connection_test"
              ? { ok: true }
              : null;
      assert.ok(output, `unexpected structured request: ${name}`);
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const analysisForm = new FormData();
    analysisForm.append("request", JSON.stringify({
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
    }));
    analysisForm.append("productImages", new Blob(["product-image"], { type: "image/png" }), "product.png");
    const analyzed = await api(nativeFetch, `${baseUrl}/api/prompt-studio/analyze-product`, { method: "POST", body: analysisForm });
    assert.equal(analyzed.status, 200);
    assert.deepEqual(analyzed.body.facts, productFacts);
    assert.equal(analyzed.body.confidence, 0.94);
    assert.deepEqual(analyzed.body.warnings, ["产品背面不可见"]);

    const generateForm = new FormData();
    generateForm.append("request", JSON.stringify(generationRequest));
    generateForm.append("productImages", new Blob(["product-image"], { type: "image/png" }), "product.png");
    generateForm.append("styleImages", new Blob(["style-image"], { type: "image/webp" }), "style.webp");
    const generated = await api(nativeFetch, `${baseUrl}/api/prompt-studio/generate`, { method: "POST", body: generateForm });
    assert.equal(generated.status, 200);
    assert.match(generated.body.id, /^prompt_/);
    assert.deepEqual(Object.keys(generated.body.variants), ["safe", "commercial", "creative"]);
    assert.equal(generated.body.historyItem.id, generated.body.id);
    assert.equal(generated.body.historyItem.name, "新品首发");
    assert.equal(generated.body.historyItem.selectedVariantKey, "safe");
    assert.equal(generated.body.historyItem.isFavorite, false);
    assert.ok(generated.body.riskChecks.every((item) => item.status === "pass"));
    for (const variant of Object.values(generated.body.variants)) {
      assert.match(variant.prompt, /【产品事实】/);
      assert.match(variant.prompt, /新品首发/);
      assert.match(variant.prompt, /【类目硬约束】/);
    }

    const quickForm = new FormData();
    quickForm.append("request", JSON.stringify(quickPromptInput));
    quickForm.append("productImages", new Blob(["quick-product-image"], { type: "image/png" }), "quick-product.png");
    const quickGenerated = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: quickForm });
    assert.equal(quickGenerated.status, 200);
    assert.deepEqual(quickGenerated.body.request, interpretedQuickRequest);
    assert.deepEqual(quickGenerated.body.warnings, quickPromptInterpretation.warnings);
    assert.equal(quickGenerated.body.recommendedVariantKey, "commercial");
    assert.equal(quickGenerated.body.historyItem.id, quickGenerated.body.id);
    assert.equal(quickGenerated.body.historyItem.selectedVariantKey, "commercial");
    assert.deepEqual(quickGenerated.body.historyItem.request, interpretedQuickRequest);

    const missingProductImageForm = new FormData();
    missingProductImageForm.append("request", JSON.stringify({ ...quickPromptInput, creationMode: "product" }));
    const missingProductImage = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: missingProductImageForm });
    assert.equal(missingProductImage.status, 400);
    assert.equal(missingProductImage.body.error.code, "PROMPT_PRODUCT_IMAGE_MISSING");

    for (const invalidRequest of [
      { ...quickPromptInput, creationMode: "invalid" },
      { ...quickPromptInput, saveHistory: "false" },
    ]) {
      const invalidForm = new FormData();
      invalidForm.append("request", JSON.stringify(invalidRequest));
      const invalid = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: invalidForm });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "PROMPT_STUDIO_INPUT_INVALID");
    }

    const quickFreeForm = new FormData();
    quickFreeForm.append("request", JSON.stringify(quickFreeHistoryInput));
    const quickFreeGenerated = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: quickFreeForm });
    assert.equal(quickFreeGenerated.status, 200);
    assert.match(quickFreeGenerated.body.id, /^prompt_/);
    assert.equal(quickFreeGenerated.body.historyItem.id, quickFreeGenerated.body.id);
    assert.equal(quickFreeGenerated.body.request.userRequest, quickFreeHistoryInput.userRequest);

    const fallbackForm = new FormData();
    fallbackForm.append("request", JSON.stringify({
      userRequest: "国庆海报",
      creationMode: "free",
      saveHistory: false,
      parameters: { ratio: "4:3", resolution: "2k", quality: "high", background: "opaque" },
    }));
    const fallbackGenerated = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: fallbackForm });
    assert.equal(fallbackGenerated.status, 200);
    assert.match(fallbackGenerated.body.model, /本地规则保底/);
    assert.match(fallbackGenerated.body.warnings.join("；"), /524/);
    assert.ok(fallbackGenerated.body.riskChecks.every((item) => item.status === "pass"));
    assert.match(fallbackGenerated.body.variants.commercial.prompt, /国庆海报/);

    const localTimeoutForm = new FormData();
    localTimeoutForm.append("request", JSON.stringify({
      userRequest: "超时海报",
      creationMode: "free",
      saveHistory: false,
      parameters: { ratio: "1:1", resolution: "2k", quality: "high", background: "opaque" },
    }));
    const localTimeoutGenerated = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: localTimeoutForm });
    assert.equal(localTimeoutGenerated.status, 200);
    assert.match(localTimeoutGenerated.body.warnings.join("；"), /超过 25 秒/);
    assert.doesNotMatch(localTimeoutGenerated.body.warnings.join("；"), /524/);

    const quickProductNoHistoryForm = new FormData();
    quickProductNoHistoryForm.append("request", JSON.stringify(quickProductNoHistoryInput));
    quickProductNoHistoryForm.append("productImages", new Blob(["no-history-product-image"], { type: "image/png" }), "no-history-product.png");
    const quickProductNoHistory = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: quickProductNoHistoryForm });
    assert.equal(quickProductNoHistory.status, 200);
    assert.equal(quickProductNoHistory.body.request.userRequest, quickProductNoHistoryInput.userRequest);
    assert.equal("id" in quickProductNoHistory.body, false);
    assert.equal("historyItem" in quickProductNoHistory.body, false);

    const quickProductNoHistoryRetryForm = new FormData();
    quickProductNoHistoryRetryForm.append("request", JSON.stringify(quickProductNoHistoryInput));
    quickProductNoHistoryRetryForm.append("productImages", new Blob(["no-history-product-image"], { type: "image/png" }), "renamed-product.png");
    const quickProductNoHistoryRetry = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: quickProductNoHistoryRetryForm });
    assert.equal(quickProductNoHistoryRetry.status, 200);
    assert.deepEqual(quickProductNoHistoryRetry.body, quickProductNoHistory.body);

    const quickProductConflictForm = new FormData();
    quickProductConflictForm.append("request", JSON.stringify({ ...quickProductNoHistoryInput, userRequest: "同一个请求 ID 不应执行另一组需求。" }));
    quickProductConflictForm.append("productImages", new Blob(["no-history-product-image"], { type: "image/png" }), "renamed-product.png");
    const quickProductConflict = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: quickProductConflictForm });
    assert.equal(quickProductConflict.status, 409);
    assert.equal(quickProductConflict.body.error.code, "PROMPT_REQUEST_ID_CONFLICT");

    const productInterpretationTimeoutForm = new FormData();
    productInterpretationTimeoutForm.append("request", JSON.stringify({
      userRequest: "参考图超时测试",
      creationMode: "product",
      saveHistory: false,
      parameters: { ratio: "1:1", resolution: "2k", quality: "high", background: "opaque" },
    }));
    productInterpretationTimeoutForm.append("productImages", new Blob(["timeout-product"], { type: "image/png" }), "timeout.png");
    const productInterpretationTimeout = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: productInterpretationTimeoutForm });
    assert.equal(productInterpretationTimeout.status, 503);
    assert.equal(productInterpretationTimeout.body.error.code, "PROMPT_UPSTREAM_TEMPORARY");
    assert.match(productInterpretationTimeout.body.message, /参考图模式无法安全猜测产品事实/);
    assert.match(productInterpretationTimeout.body.message, /没有切换通道或伪造结果/);

    const historyAfterQuickModes = await api(nativeFetch, `${baseUrl}/api/prompt-studio`);
    assert.equal(historyAfterQuickModes.body.history.length, 3);
    assert.ok(historyAfterQuickModes.body.history.some((item) => item.request.userRequest === quickFreeHistoryInput.userRequest));
    assert.equal(historyAfterQuickModes.body.history.some((item) => item.request.userRequest === quickProductNoHistoryInput.userRequest), false);

    const promptConnection = await api(nativeFetch, `${baseUrl}/api/model-config/test`, jsonOptions("POST", {
      target: "prompt",
      channel: "stable",
      model: "gpt-4.1-mini",
    }));
    assert.equal(promptConnection.status, 200);
    assert.equal(promptConnection.body.target, "prompt");
    assert.equal(promptConnection.body.model, "gpt-4.1-mini");

    assert.equal(upstreamRequests.length, 11);
    assert.ok(upstreamRequests.every((request) => request.url === "https://cn.pptoken.cc/v1/responses"));
    assert.deepEqual(upstreamRequests.map((request) => request.body.text.format.name), [
      "product_facts",
      "prompt_set",
      "quick_prompt_interpretation",
      "prompt_set",
      "prompt_set",
      "prompt_set",
      "prompt_set",
      "quick_prompt_interpretation",
      "prompt_set",
      "quick_prompt_interpretation",
      "connection_test",
    ]);
    assert.deepEqual(upstreamRequests.slice(0, 4).map((request) => (
      request.body.input[1].content.filter((item) => item.type === "input_image").length
    )), [1, 2, 1, 1]);
    assert.deepEqual(upstreamRequests.slice(4, 9).map((request) => (
      request.body.input[1].content.filter((item) => item.type === "input_image").length
    )), [0, 0, 0, 1, 1]);
    assert.match(upstreamRequests[4].body.input[1].content[0].text, /自由生成一张清爽的夏日厨房活动海报/);
    assert.match(upstreamRequests[7].body.input[1].content[0].text, /当前为商品生图模式/);
    assert.equal(upstreamRequests[10].body.model, "gpt-4.1-mini");
    assert.equal(upstreamRequests[10].body.text.format.strict, true);

    const updatedHistory = await api(nativeFetch, `${baseUrl}/api/prompt-studio/history/${generated.body.id}`, jsonOptions("PATCH", {
      name: "压力锅夏季活动海报",
      isFavorite: true,
      selectedVariantKey: "commercial",
    }));
    assert.equal(updatedHistory.status, 200);
    assert.equal(updatedHistory.body.name, "压力锅夏季活动海报");
    assert.equal(updatedHistory.body.isFavorite, true);
    assert.equal(updatedHistory.body.selectedVariantKey, "commercial");

    globalThis.fetch = nativeFetch;
    await stopServer(server);
    server = await startServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const persistedQuickRetryForm = new FormData();
    persistedQuickRetryForm.append("request", JSON.stringify(quickProductNoHistoryInput));
    persistedQuickRetryForm.append("productImages", new Blob(["no-history-product-image"], { type: "image/png" }), "after-restart.png");
    const persistedQuickRetry = await api(nativeFetch, `${baseUrl}/api/prompt-studio/quick-generate`, { method: "POST", body: persistedQuickRetryForm });
    assert.equal(persistedQuickRetry.status, 200);
    assert.deepEqual(persistedQuickRetry.body, quickProductNoHistory.body);

    const restored = await api(nativeFetch, `${baseUrl}/api/prompt-studio`);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.libraryFavorites, ["campaign-poster"]);
    assert.equal(restored.body.productProfiles.length, 1);
    assert.equal(restored.body.productProfiles[0].id, createdProfile.body.id);
    assert.equal(restored.body.productProfiles[0].name, "压力锅标准档案");
    assert.equal(restored.body.stylePresets.length, 1);
    assert.equal(restored.body.stylePresets[0].id, createdStyle.body.id);
    assert.match(restored.body.stylePresets[0].lighting, /轮廓光/);
    assert.equal(restored.body.history.length, 3);
    const restoredGenerated = restored.body.history.find((item) => item.id === generated.body.id);
    assert.equal(restoredGenerated.name, "压力锅夏季活动海报");
    assert.equal(restoredGenerated.isFavorite, true);
    assert.equal(restoredGenerated.selectedVariantKey, "commercial");
    assert.deepEqual(Object.keys(restoredGenerated.variants), ["safe", "commercial", "creative"]);
    const restoredQuickGenerated = restored.body.history.find((item) => item.id === quickGenerated.body.id);
    assert.deepEqual(restoredQuickGenerated.request, interpretedQuickRequest);
    assert.equal(restoredQuickGenerated.selectedVariantKey, "commercial");
    assert.deepEqual(Object.keys(restoredQuickGenerated.variants), ["safe", "commercial", "creative"]);
    const restoredQuickFree = restored.body.history.find((item) => item.id === quickFreeGenerated.body.id);
    assert.equal(restoredQuickFree.request.userRequest, quickFreeHistoryInput.userRequest);
    assert.equal(restored.body.history.some((item) => item.request.userRequest === quickProductNoHistoryInput.userRequest), false);

    const deletedHistory = await api(nativeFetch, `${baseUrl}/api/prompt-studio/history/${generated.body.id}`, { method: "DELETE" });
    const deletedQuickHistory = await api(nativeFetch, `${baseUrl}/api/prompt-studio/history/${quickGenerated.body.id}`, { method: "DELETE" });
    const deletedQuickFreeHistory = await api(nativeFetch, `${baseUrl}/api/prompt-studio/history/${quickFreeGenerated.body.id}`, { method: "DELETE" });
    const deletedProfile = await api(nativeFetch, `${baseUrl}/api/prompt-studio/product-profiles/${createdProfile.body.id}`, { method: "DELETE" });
    const deletedStyle = await api(nativeFetch, `${baseUrl}/api/prompt-studio/style-presets/${createdStyle.body.id}`, { method: "DELETE" });
    const unfavoriteTemplate = await api(nativeFetch, `${baseUrl}/api/prompt-studio/library-favorites/campaign-poster`, jsonOptions("PATCH", { favorite: false }));
    assert.equal(deletedHistory.status, 204);
    assert.equal(deletedQuickHistory.status, 204);
    assert.equal(deletedQuickFreeHistory.status, 204);
    assert.equal(deletedProfile.status, 204);
    assert.equal(deletedStyle.status, 204);
    assert.equal(unfavoriteTemplate.status, 200);
    assert.deepEqual(unfavoriteTemplate.body, { libraryFavorites: [] });
    assert.deepEqual((await api(nativeFetch, `${baseUrl}/api/prompt-studio`)).body, {
      productProfiles: [],
      stylePresets: [],
      history: [],
      libraryFavorites: [],
    });
  } finally {
    globalThis.fetch = nativeFetch;
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
