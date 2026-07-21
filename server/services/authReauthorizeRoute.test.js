import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const previousDataDir = process.env.ECOM_MONITOR_DATA_DIR;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-reauthorize-route-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;
process.env.ECOM_MONITOR_EAGER_BROWSER_WARMUP = "0";

const [{ app }, { readDb, updateDb }] = await Promise.all([
  import("../index.js"),
  import("../storage/db.js"),
]);

let server;
let baseUrl;

before(async () => {
  await updateDb((db) => {
    db.authSessions = [{
      id: "auth-online-degraded",
      name: "在线普通账号",
      accountType: "normal",
      source: "taobao-browser",
      browserProfileKey: "online-profile",
      browserPort: 49223,
      cookie: "cookie17=must-remain-unchanged",
      active: true,
      enabled: true,
      loginStatus: "valid",
      tmallPriceStatus: "degraded",
      tmallPriceCheckedAt: "2026-07-21T00:00:00.000Z",
      tmallPriceFailureReason: "price-login-gate",
      tmallPriceFailureCount: 3,
    }];
    return db;
  });
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousDataDir === undefined) delete process.env.ECOM_MONITOR_DATA_DIR;
  else process.env.ECOM_MONITOR_DATA_DIR = previousDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("an online account prepares a real price recheck without deleting cookies or faking recovery", async () => {
  const response = await fetch(`${baseUrl}/api/auth/sessions/auth-online-degraded/reauthorize`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "silent");
  assert.equal(result.url, "");
  assert.match(result.message, /没有打开登录页或删除 Cookie/);

  const db = await readDb();
  const session = db.authSessions.find((item) => item.id === "auth-online-degraded");
  assert.equal(session.cookie, "cookie17=must-remain-unchanged");
  assert.equal(session.loginStatus, "valid");
  assert.equal(session.tmallPriceStatus, "degraded");
  assert.equal(session.tmallPriceFailureReason, "price-login-gate");
  assert.equal(session.tmallPriceFailureCount, 3);
  assert.equal(db.pendingAuthScans.length, 0);
});

test("the reauthorization route never opens the unusable Tmall login page", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/auth/sessions/:id/reauthorize"');
  const end = source.indexOf("async function syncPendingScan", start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(route, /resetTmallSession|openTmallLogin/);
  assert.match(route, /resetTmallSsoRefreshWindow/);
  assert.match(route, /isTmallLoginPageUrl/);
  assert.match(route, /closeAccountTab/);
  assert.match(route, /openTaobaoLogin/);
});
