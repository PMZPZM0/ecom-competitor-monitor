import assert from "node:assert/strict";
import test from "node:test";
import { loadPromptDraft } from "../src/features/prompt-studio/promptDraftStorage.ts";

const fallback = {
  category: "white-background",
  productProfileId: "",
  stylePresetId: "",
  userRequest: "",
  productFacts: {
    productType: "",
    appearance: "",
    colorsMaterials: "",
    components: [],
    logo: "",
    existingText: [],
    mustPreserve: [],
    forbiddenChanges: [],
  },
  style: { name: "", description: "", lighting: "", composition: "", palette: "", camera: "", forbidden: [] },
  copy: { mode: "reserved", title: "", subtitle: "", sellingPoints: [], price: "", campaignInfo: "", additionalText: [] },
  parameters: { ratio: "1:1", resolution: "2k", quality: "high", background: "auto" },
  taskFields: {},
  factsConfirmed: false,
};

test("prompt draft recovery accepts valid fields and falls back per invalid field", () => {
  const originalWindow = globalThis.window;
  let stored = JSON.stringify({
    category: "unknown-category",
    productProfileId: 42,
    userRequest: "制作明亮厨房场景",
    productFacts: { productType: "压力锅", appearance: null, components: { invalid: true }, forbiddenChanges: ["不得变形"] },
    style: "invalid-style",
    copy: { mode: "unknown-mode", title: "夏日上新", sellingPoints: [123] },
    parameters: { ratio: "2:3", resolution: "4k", quality: false, background: "transparent" },
    taskFields: { scene: "现代厨房", invalid: 123 },
    factsConfirmed: "yes",
  });
  globalThis.window = { localStorage: { getItem: () => stored } };

  try {
    const recovered = loadPromptDraft(fallback);
    assert.equal(recovered.category, fallback.category);
    assert.equal(recovered.productProfileId, fallback.productProfileId);
    assert.equal(recovered.userRequest, "制作明亮厨房场景");
    assert.equal(recovered.productFacts.productType, "压力锅");
    assert.equal(recovered.productFacts.appearance, fallback.productFacts.appearance);
    assert.deepEqual(recovered.productFacts.components, []);
    assert.deepEqual(recovered.productFacts.forbiddenChanges, ["不得变形"]);
    assert.deepEqual(recovered.style, fallback.style);
    assert.equal(recovered.copy.mode, fallback.copy.mode);
    assert.equal(recovered.copy.title, "夏日上新");
    assert.deepEqual(recovered.copy.sellingPoints, []);
    assert.deepEqual(recovered.parameters, { ratio: "1:1", resolution: "4k", quality: "high", background: "transparent" });
    assert.deepEqual(recovered.taskFields, { scene: "现代厨房" });
    assert.equal(recovered.factsConfirmed, false);

    stored = "{invalid-json";
    assert.equal(loadPromptDraft(fallback), fallback);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
