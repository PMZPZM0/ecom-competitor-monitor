import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function startMockApp() {
  const requests = [];
  const priceChannels = (normal, government, surprise) => ({
    normal: { status: "verified", valueCents: normal, evidenceIds: ["normal-evidence"] },
    gift: { status: "unavailable", valueCents: null, reason: "different-account-promotion", evidenceIds: [] },
    government: { status: "verified", valueCents: government, evidenceIds: ["government-evidence"] },
    coin: { status: "unavailable", valueCents: null, reason: "no-explicit-evidence", evidenceIds: [] },
    seckill: { status: "unavailable", valueCents: null, reason: "no-explicit-evidence", evidenceIds: [] },
    billion: { status: "unavailable", valueCents: null, reason: "no-explicit-evidence", evidenceIds: [] },
    surprise: { status: "verified", valueCents: surprise, evidenceIds: ["surprise-evidence"] },
    vip88: { status: "unavailable", valueCents: null, reason: "different-account", evidenceIds: [] },
  });
  const currentProduct = {
    id: "product-5-skus",
    itemId: "668945261101",
    name: "测试商品",
    accountType: "normal",
    lastSnapshot: {
      capturedAt: "2026-07-27T01:46:16.983Z",
      localFirst: { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true },
      accountCaptures: [{ sessionId: "session-normal", accountName: "普通账号", accountType: "normal", capturedAt: "2026-07-27T01:46:16.983Z" }],
      skuPrices: [
        ["sku-1", "SKU 1", 44500, 38276, 38266],
        ["sku-2", "SKU 2", 41000, 35900, 31900],
        ["sku-3", "SKU 3", 56300, 48306, 48296],
        ["sku-4", "SKU 4", 39900, 34366, 34356],
        ["sku-5", "SKU 5", 44328, 38729, 34729],
      ].map(([skuId, name, normal, government, surprise]) => ({
        skuId,
        name,
        priceResolution: { channels: priceChannels(normal, government, surprise) },
        accountPrices: [{ sessionId: "session-normal", accountName: "普通账号", accountType: "normal", capturedAt: "2026-07-27T01:46:16.983Z", priceResolution: { channels: priceChannels(normal, government, surprise) } }],
      })),
    },
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, token: req.headers["x-ecom-agent-token"], contentType: req.headers["content-type"] || "", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/overview") return res.end(JSON.stringify({ products: [currentProduct] }));
    if (req.url === "/api/capture-queue") return res.end(JSON.stringify({ jobs: [{ id: "job_1", status: "queued" }] }));
    if (req.url === "/api/agent-tools/operations/schema") return res.end(JSON.stringify({ metrics: [{ key: "gsv", formula: "支付金额 - 成功退款金额" }] }));
    if (req.url === "/api/agent-tools/operations/query") return res.end(JSON.stringify({ query: JSON.parse(body || "{}"), entities: { product: { items: [{ metrics: { gsv: 1200 } }] } } }));
    if (req.url === "/api/agent-tools/operations/analyze") return res.end(JSON.stringify({ analysis: { summary: "精准范围分析" }, data: { query: JSON.parse(body || "{}") } }));
    if (req.url === "/api/prompt-studio/quick-generate") return res.end(JSON.stringify({
      request: { category: "product-scene", userRequest: "高端厨电主图" },
      warnings: [],
      recommendedVariantKey: "safe",
      variants: { safe: { prompt: "安全方案" }, commercial: { prompt: "商业方案" }, creative: { prompt: "创意方案" } },
      model: "test-prompt-model",
    }));
    if (req.url === "/api/image-jobs" && req.method === "POST") return res.end(JSON.stringify({ id: "image-job-1", status: "queued" }));
    if (req.url === "/api/image-jobs/image-job-1/retry" && req.method === "POST") return res.end(JSON.stringify({ id: "image-job-1", status: "queued", attempt: 2 }));
    if (req.url === "/api/image-jobs/image-job-1" && req.method === "DELETE") return res.end(JSON.stringify({ id: "image-job-1", status: "cancelled" }));
    if (req.url === "/api/images/image-1/photoshop/open" && req.method === "POST") return res.end(JSON.stringify({ imageId: "image-1", applicationName: "Adobe Photoshop" }));
    if (req.url === "/api/images/image-1/photoshop/sync" && req.method === "POST") return res.end(JSON.stringify({ image: { id: "image-1" }, modifiedAt: "2026-08-03T00:00:00.000Z" }));
    if (req.url === "/api/agent-tools/audit") return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: "not found" }));
  });
  return { server, requests };
}

function startMcp(port, { mediaDir = "" } = {}) {
  const child = spawn(process.execPath, [path.resolve("server/scripts/ecommerce-agent-mcp.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ECOM_AGENT_APP_URL: `http://127.0.0.1:${port}`,
      ECOM_AGENT_TOOL_TOKEN: "test-token",
      ECOM_AGENT_WORKSPACE_DIR: process.cwd(),
      ...(mediaDir ? { ECOM_AGENT_MEDIA_DIR: mediaDir } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const responses = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  return { child, responses };
}

async function waitForResponse(process, id) {
  for (let index = 0; index < 100; index += 1) {
    const response = process.responses.find((item) => item.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for MCP response ${id}`);
}

test("QwenPaw local MCP bridge exposes only application tools and uses the local token", async () => {
  const { server, requests } = startMockApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const mcp = startMcp(port);
  try {
    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    const initialized = await waitForResponse(mcp, 1);
    assert.equal(initialized.result.serverInfo.name, "ecommerce-monitor-local-tools");

    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = await waitForResponse(mcp, 2);
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("capture_product_price"));
    assert.ok(names.includes("analyze_operations_data"));
    assert.ok(names.includes("get_operations_schema"));
    assert.ok(names.includes("create_prompt_plan"));
    assert.ok(names.includes("create_image_task"));
    assert.ok(names.includes("retry_image_task"));
    assert.ok(names.includes("open_image_in_photoshop"));
    assert.ok(!names.includes("execute_shell_command"));

    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_capture_queue", arguments: {} } })}\n`);
    const result = await waitForResponse(mcp, 3);
    assert.match(result.result.content[0].text, /job_1/);
    assert.equal(requests.find((request) => request.url === "/api/capture-queue")?.token, "test-token");
    assert.ok(requests.some((request) => request.url === "/api/agent-tools/audit"));

    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_product_prices", arguments: { item_id: "668945261101" } } })}\n`);
    const prices = await waitForResponse(mcp, 4);
    const report = JSON.parse(prices.result.content[0].text);
    assert.equal(report.kind, "current_verified_sku_price_matrix");
    assert.equal(report.skuCount, 5);
    assert.equal(report.skuRows.length, 5);
    assert.deepEqual(report.skuRows[4].accountViews[0].verifiedChannels.map((channel) => [channel.key, channel.value]), [
      ["normal", 443.28], ["government", 387.29], ["surprise", 347.29],
    ]);
    assert.equal(report.skuRows[4].accountViews[0].unavailableChannels.length, 5);
  } finally {
    mcp.child.stdin.end();
    await once(mcp.child, "exit");
    server.close();
    await once(server, "close");
  }
});

test("QwenPaw MCP bridge carries precise operations filters and the complete AI creation workflow", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-agent-media-"));
  const referencePath = path.join(tempDirectory, "reference.png");
  await fs.writeFile(referencePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const { server, requests } = startMockApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const mcp = startMcp(server.address().port, { mediaDir: tempDirectory });
  let id = 20;
  const call = async (name, args = {}) => {
    id += 1;
    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const response = await waitForResponse(mcp, id);
    assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  };
  try {
    const schema = await call("get_operations_schema");
    assert.equal(schema.metrics[0].key, "gsv");

    const operations = await call("get_operations_data", {
      store_name: "旗舰店",
      start: "2026-07-01",
      end: "2026-07-31",
      source_period_kind: "auto",
      entity_type: "product",
      entity_ids: ["1001"],
      metrics: ["gsv", "fee_rate"],
    });
    assert.equal(operations.query.storeName, "旗舰店");
    assert.deepEqual(operations.query.entityIds, ["1001"]);

    const analyzed = await call("analyze_operations_data", {
      store_name: "旗舰店",
      start: "2026-07-01",
      end: "2026-07-31",
      source_period_kind: "month",
      entity_type: "category",
      entity_ids: ["锅具"],
      metrics: ["gsv", "promotion_spend", "fee_rate"],
    });
    assert.equal(analyzed.analysis.summary, "精准范围分析");
    assert.equal(analyzed.data.query.entityType, "category");

    const registered = await call("upload_reference_image", { file_path: referencePath, role: "reference" });
    assert.match(registered.reference_image_id, /^reference_[a-f0-9]{20}$/);

    const interpreted = await call("analyze_creation_request", {
      user_request: "高端厨电主图",
      creation_mode: "product",
      reference_image_ids: [registered.reference_image_id],
    });
    assert.equal(interpreted.request.category, "product-scene");

    const plan = await call("create_prompt_plan", {
      user_request: "高端厨电主图",
      creation_mode: "product",
      reference_image_ids: [registered.reference_image_id],
      save_history: true,
    });
    assert.equal(plan.plan.variants.commercial.prompt, "商业方案");

    const created = await call("create_image_task", {
      prompt: "高端厨电商业主图",
      reference_image_ids: [registered.reference_image_id],
    });
    assert.equal(created.job.id, "image-job-1");
    assert.equal(created.referenceCount, 1);

    assert.equal((await call("retry_image_task", { job_id: "image-job-1" })).job.attempt, 2);
    assert.equal((await call("cancel_image_task", { job_id: "image-job-1" })).job.status, "cancelled");
    assert.equal((await call("open_image_in_photoshop", { image_id: "image-1" })).result.applicationName, "Adobe Photoshop");
    assert.equal((await call("sync_image_from_photoshop", { image_id: "image-1" })).result.image.id, "image-1");

    const queryRequest = requests.find((request) => request.url === "/api/agent-tools/operations/query");
    assert.equal(queryRequest.method, "POST");
    assert.equal(JSON.parse(queryRequest.body).sourcePeriodKind, "auto");
    const promptRequest = requests.find((request) => request.url === "/api/prompt-studio/quick-generate");
    assert.match(promptRequest.contentType, /^multipart\/form-data; boundary=/);
    assert.match(promptRequest.body, /productImages/);
    const imageRequest = requests.find((request) => request.url === "/api/image-jobs" && request.method === "POST");
    assert.match(imageRequest.body, /referenceImages/);
    assert.ok(requests.filter((request) => request.url === "/api/agent-tools/audit").length >= 10);
  } finally {
    mcp.child.stdin.end();
    await once(mcp.child, "exit");
    server.close();
    await once(server, "close");
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
