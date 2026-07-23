import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("reauthorization always uses the original Taobao QR flow", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/auth/sessions/:id/reauthorize"');
  const end = source.indexOf("async function syncPendingScan", start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /const login = await openTaobaoLogin/);
  assert.match(route, /await rememberPendingScan/);
  assert.match(route, /loginTargetId: login\.targetId/);
  assert.doesNotMatch(route, /interactiveTmall|mode:\s*"silent"|tmallPriceStatus|closeAccountTab|resetTmallSession|openTmallLogin/);
  assert.match(route, /browserEngine/);
  assert.match(route, /switchingBrowser/);
  assert.match(route, /previousBrowserProfileKey/);
});

test("new authorization supports only the selectable non-Google browser engines", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/auth/taobao/scan/start"');
  const end = source.indexOf('app.post("/api/auth/sessions/:id/reauthorize"', start);
  const route = source.slice(start, end);
  assert.match(route, /browserEngine: z\.enum\(\["uc", "360", "qq", "sogou", "edge"\]\)/);
  assert.doesNotMatch(route, /"chrome"|Google Chrome/);
});

test("the Taobao QR URL has no automatic Tmall redirect", async () => {
  const source = await fs.readFile(new URL("./browserService.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function openTaobaoLogin");
  const end = source.indexOf("export async function getTaobaoCookieHeader", start);
  const login = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(login, /https:\/\/login\.taobao\.com\/member\/login\.jhtml/);
  assert.doesNotMatch(login, /redirectURL|tmallSessionLandingUrl/);
});

test("login bundle export refuses an already degraded Tmall price session", async () => {
  const source = await fs.readFile(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.get("/api/auth/sessions/:id/login-bundle"');
  const end = source.indexOf('app.post("/api/auth/login-bundles/import"', start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /session\.tmallPriceStatus === TMALL_PRICE_STATUS\.DEGRADED/);
  assert.match(route, /不能生成不完整登录包/);
  assert.ok(route.indexOf("TMALL_PRICE_STATUS.DEGRADED") < route.indexOf("exportTaobaoBrowserCookies"));
});
