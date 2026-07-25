import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

function startMockApp() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, token: req.headers["x-ecom-agent-token"], body });
    res.setHeader("content-type", "application/json");
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
  } finally {
    mcp.child.stdin.end();
    await once(mcp.child, "exit");
    server.close();
    await once(server, "close");
  }
});
