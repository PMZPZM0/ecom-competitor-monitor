import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
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
    requests.push({ method: req.method, url: req.url, token: req.headers["x-ecom-agent-token"], body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/overview") return res.end(JSON.stringify({ products: [currentProduct] }));
    if (req.url === "/api/capture-queue") return res.end(JSON.stringify({ jobs: [{ id: "job_1", status: "queued" }] }));
    if (req.url === "/api/agent-tools/audit") return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: "not found" }));
  });
  return { server, requests };
}

function startMcp(port) {
  const child = spawn(process.execPath, [path.resolve("server/scripts/ecommerce-agent-mcp.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ECOM_AGENT_APP_URL: `http://127.0.0.1:${port}`,
      ECOM_AGENT_TOOL_TOKEN: "test-token",
      ECOM_AGENT_WORKSPACE_DIR: process.cwd(),
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
    assert.ok(names.includes("create_image_task"));
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
