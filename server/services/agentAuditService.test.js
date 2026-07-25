import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentActions, recordAgentAction } from "./agentAuditService.js";

test("agent audit persists local action receipts without secrets", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-agent-audit-"));
  try {
    await recordAgentAction(dataDir, {
      action: "capture_product_price",
      status: "succeeded",
      target: "1059717807069",
      summary: "本机价格采集完成。",
      details: { productId: "prod_1", apiKey: "must-not-persist", nested: { cookie: "must-not-persist", skuId: "sku_1" } },
    });
    const records = await listAgentActions(dataDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "capture_product_price");
    assert.equal(records[0].details.apiKey, undefined);
    assert.equal(records[0].details.nested.cookie, undefined);
    assert.equal(records[0].details.nested.skuId, "sku_1");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
