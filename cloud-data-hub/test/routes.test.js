import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "server.js"), "utf8");
const appSource = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
const operationsCoreSource = await fs.readFile(path.join(root, "public", "operationsCore.js"), "utf8");
const stylesSource = await fs.readFile(path.join(root, "public", "styles.css"), "utf8");
const htmlSource = await fs.readFile(path.join(root, "public", "index.html"), "utf8");

test("the product brand and team cards expose a clear operating identity", () => {
  assert.match(htmlSource, /<title>经营罗盘 · 团队经营决策<\/title>/);
  assert.match(htmlSource, /operations-web-22/);
  assert.match(appSource, /function brandLockup\(subtitle, compact = false\)/);
  assert.match(appSource, /<strong>经营罗盘<\/strong>/);
  assert.match(appSource, /function teamMemberCount\(team\)/);
  assert.match(appSource, /<span>成员<\/span><strong>\$\{teamMemberCount\(team\)\}<\/strong>/);
  assert.doesNotMatch(appSource, /<span>设备<\/span><strong>\$\{team\.activeDeviceCount\}\/\$\{team\.deviceLimit\}<\/strong>/);
});

test("bulk report store route is declared before the generic report rename route", () => {
  const bulkRoute = source.indexOf('app.patch("/api/teams/:teamId/reports/bulk-store"');
  const genericRoute = source.indexOf('app.patch("/api/teams/:teamId/reports/:reportId"');
  assert.ok(bulkRoute >= 0, "bulk report store route must exist");
  assert.ok(genericRoute >= 0, "generic report rename route must exist");
  assert.ok(bulkRoute < genericRoute, "Express must reach bulk-store before :reportId");
});

test("cloud database atomic replacement retries transient Windows locks", () => {
  assert.match(source, /error\?\.code === "EPERM" \|\| error\?\.code === "EBUSY"/);
  assert.match(source, /for \(let attempt = 0; attempt < 5; attempt \+= 1\)/);
});

test("upload dialog uses application-managed menus instead of browser-native select popups", () => {
  const changeHandler = "document.querySelector('#report-upload')?.addEventListener('change', () => { syncUploadDraftFromForm(); refreshUploadSubmitState(); });";
  assert.ok(appSource.includes(changeHandler), "upload form must keep date and text changes local");
  assert.match(appSource, /function uploadSelectMenu\(id, value, options, placeholder\)/);
  assert.match(appSource, /data-upload-menu=/);
  assert.match(appSource, /data-upload-select=/);
  assert.match(appSource, /function syncUploadDraftFromForm\(\)/);
  assert.match(appSource, /document\.querySelector\('\.modal-card'\)\?\.addEventListener\('pointerdown', \(event\) => event\.stopPropagation\(\)\)/);
});

test("normal login, invitation acceptance, and self-service team creation open operations data", () => {
  assert.match(appSource, /function openOperationsHome\(\) \{[\s\S]*state\.page = 'operations';[\s\S]*state\.activePanel = 'overview';/);
  assert.match(appSource, /if \(register\) \{ const result = await api\('\/api\/auth\/register'/);
  assert.match(appSource, /state\.authBusy = ''; state\.authFeedback = null; state\.authDraft = \{ username: '', email: '', password: '', inviteCode: '' \};\n      openOperationsHome\(\);\n      await bootstrap\(\);/);
  assert.match(appSource, /state\.session = result\.user; openOperationsHome\(\); await bootstrap\(\); setToast\('团队已创建，已进入运营数据。'\);/);
  assert.match(appSource, /state\.session = result\.user; openOperationsHome\(\); await bootstrap\(\); setToast\('已加入团队，已进入运营数据。'\);/);
});

test("upload dialog keeps the date range inside an application-managed calendar", () => {
  assert.match(appSource, /function uploadDateRangePicker\(\)/);
  assert.match(appSource, /data-upload-date-menu/);
  assert.match(appSource, /data-upload-date-apply/);
  assert.match(appSource, /data-upload-date-month/);
  assert.doesNotMatch(appSource, /id="upload-period-start" required type="date"/);
  assert.doesNotMatch(appSource, /id="upload-period-end" required type="date"/);
});

test("date range calendar overlays upward without making the upload dialog scroll", () => {
  assert.match(stylesSource, /\.modal-card\.upload-modal \{ max-height: calc\(100vh - 30px\); overflow: visible; \}/);
  assert.match(stylesSource, /\.upload-date-panel \{ position: absolute; z-index: 45; right: 0; bottom: calc\(100% \+ 6px\);/);
});

test("active warehouse navigation keeps a legible active state on hover", () => {
  assert.match(stylesSource, /\.warehouse-nav button\.active, \.warehouse-nav button\.active:hover \{ border-color: #2563c8; background: #2563c8; \}/);
  assert.match(stylesSource, /\.warehouse-nav button\.active:hover \{ background: #1f56ad; \}/);
});

test("entity expansion preserves compound row keys and filter menus stay application managed", () => {
  assert.match(appSource, /function parseEntityTarget\(value\)/);
  assert.match(appSource, /key: source\.slice\(separator \+ 1\)/);
  assert.match(appSource, /function entityFilterMenu\(kind, field, options\)/);
  assert.match(appSource, /data-entity-filter-toggle=/);
  assert.match(appSource, /data-entity-filter-query=/);
  assert.match(appSource, /data-entity-filter-select-all=/);
  assert.match(appSource, /data-entity-filter-clear=/);
  assert.doesNotMatch(appSource, /<details class="filter-menu">/);
  assert.match(appSource, /promotionDetails\(row, columns\)/);
  assert.match(stylesSource, /\.entity-filter-panel \{ position: absolute;/);
});

test("expanded promotion plans show comparable metrics without source-row counters", () => {
  assert.match(appSource, /成交金额/);
  assert.match(appSource, /投产/);
  assert.match(appSource, /费率/);
  assert.match(appSource, /class="promotion-plan-metrics"/);
  assert.doesNotMatch(appSource, /经营 \$\{row\.salesCount \|\| 0\} 行/);
  assert.doesNotMatch(appSource, /\$\{plan\.rowCount \|\| 0\} 行/);
  assert.match(stylesSource, /\.promotion-plan-metrics \{ display: grid;/);
});

test("registration is invitation-only and the legacy email-code route is explicitly retired", () => {
  assert.match(source, /app\.post\("\/api\/auth\/email-code"/);
  assert.match(source, /res\.status\(410\).*EMAIL_REGISTRATION_DISABLED/);
  assert.match(source, /QQ_EMAIL_PATTERN = .*@qq\\\.com/);
  assert.match(source, /inviteCode: z\.string\(\)\.trim\(\)\.min\(8\)\.max\(80\)/);
  assert.match(source, /team\.invite\.register/);
  assert.doesNotMatch(source, /import nodemailer/);
});

test("team member limits are centrally managed and invitations only consume existing capacity", () => {
  assert.match(source, /const MAX_TEAM_MEMBER_LIMIT = 500;/);
  assert.match(source, /memberLimit: z\.coerce\.number\(\)\.int\(\)\.min\(2\)\.max\(MAX_TEAM_MEMBER_LIMIT\)/);
  assert.match(source, /function teamMemberCapacity\(db, team\)/);
  assert.match(source, /function exhaustTeamInvitations\(db, teamId\)/);
  assert.match(source, /通过团队邀请码免验证码注册并加入团队/);
  assert.match(appSource, /name="memberLimit" required type="number" min="\$\{Math\.max\(2, members\.length\)\}"/);
  assert.match(appSource, /团队人数上限/);
  assert.doesNotMatch(appSource, /name="deviceLimit"/);
  assert.match(appSource, /有效码长期可复制；团队满员时自动失效/);
  assert.match(appSource, /expiresInDays: Number\(form\.get\('expiresInDays'\) \|\| 7\)/);
  assert.match(appSource, /function invitationStatus\(invitation, team\)/);
});

test("member permission editing preserves drafts, supports multi-store access, and reports delete permanently", () => {
  assert.match(appSource, /function captureTeamDraft\(\)/);
  assert.match(appSource, /data-member-access=/);
  assert.match(appSource, /\/api\/admin\/members\/\$\{encodeURIComponent\(userId\)\}\/team-access/);
  assert.match(source, /app\.put\("\/api\/admin\/members\/:userId\/team-access", requireUser, requirePlatformAdmin/);
  assert.match(source, /next\.reports = next\.reports\.filter\(\(item\) => item\.id !== report\.id\);/);
  assert.match(source, /await fs\.rm\(rawPath, \{ force: true \}\)/);
  assert.doesNotMatch(source, /reports\/:reportId\/restore/);
  assert.doesNotMatch(appSource, /data-restore-cloud/);
});

test("new teams only render their own members and add existing accounts explicitly", () => {
  assert.match(appSource, /const editableMembers = members;/);
  assert.doesNotMatch(appSource, /const editableMembers = platformControl \? \(state\.team\.memberDirectory \|\| members\) : members;/);
  assert.match(appSource, /id="add-existing-member"/);
  assert.match(appSource, /已有账号已加入当前团队/);
  assert.match(appSource, /currentMemberIds = new Set\(members\.map/);
  assert.match(stylesSource, /\.existing-member-row \{ display: flex;/);
});

test("each shop is an independent team and a team cannot gain a second shop", () => {
  assert.match(source, /const primaryStore = \{ id: id\("store"\), teamId: team\.id, name: team\.name/);
  assert.match(source, /code: "ONE_STORE_PER_TEAM"/);
  assert.match(appSource, /一个店铺对应一个独立团队/);
});

test("desktop sync setup is an optional, clearly scoped connection flow", () => {
  assert.match(appSource, /function prepareDesktopSyncPanel\(\)/);
  assert.match(appSource, /desktop-link-panel/);
  assert.match(appSource, /连接码备注（可不填）/);
  assert.match(appSource, /连接一台新电脑/);
  assert.match(appSource, /checkbox\.name = 'storeIds'/);
  assert.match(stylesSource, /\.desktop-link-panel \{ border-top:/);
});

test("promotion types use linked net GSV while each plan uses its own promotion revenue", () => {
  assert.match(operationsCoreSource, /feeRate: metrics\.spend > 0 && metrics\.revenue > 0 \? metrics\.spend \/ metrics\.revenue : null,/);
  assert.match(operationsCoreSource, /feeRate: linked\.complete && linked\.linkedRevenue > 0 \? metrics\.spend \/ linked\.linkedRevenue : null,/);
  assert.match(appSource, /<dt>计划费率<\/dt><dd>\$\{percent\(plan\.feeRate\)\}<\/dd>/);
  assert.match(appSource, /整体费率 <b>\$\{percent\(channel\.feeRate\)\}<\/b>/);
});

test("report upload and archive share one warehouse panel", () => {
  assert.match(appSource, /\['upload', '报表管理', '上传、核对与归档'\]/);
  assert.match(appSource, /`\$\{uploadWarehouseCard\(model\)\}\$\{archiveWarehouseCard\(model, groups, selectedIds, false\)\}`/);
  assert.match(appSource, /showImportButton \? `<button class="btn primary small" data-open-upload=/);
  assert.doesNotMatch(appSource, /\['archive', '数据归档'/);
});

test("product catalog supports ordered manual creation, duplicate rejection, and xlsx templates", () => {
  assert.match(appSource, /data-toggle-catalog-create/);
  assert.match(appSource, /<i>1<\/i>店铺[\s\S]*<i>2<\/i>商品 ID[\s\S]*<i>3<\/i>品类[\s\S]*<i>4<\/i>型号/);
  assert.match(appSource, /href="\/api\/templates\/product-catalog\.xlsx"/);
  assert.match(source, /app\.get\("\/api\/templates\/product-catalog\.xlsx", requireUser/);
  assert.match(source, /header: "店铺名"[\s\S]*header: "商品ID"[\s\S]*header: "品类名"[\s\S]*header: "型号"/);
  assert.match(source, /sheet\.addRow\(\{ storeName: "示例店铺", productId: "1234567890", category: "电饭煲", model: "示例型号-01" \}\)/);
  assert.match(appSource, /该店铺下的商品 ID 已存在，请勿重复新增/);
  assert.match(source, /code: "PRODUCT_CATALOG_DUPLICATE"/);
  assert.match(stylesSource, /\.catalog-create-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test("product catalog can be cleared without touching reports or deductions", () => {
  assert.match(source, /app\.delete\("\/api\/teams\/:teamId\/product-catalog", requireUser, requireTeamManager/);
  assert.match(source, /operations\.productCatalog = \[\];/);
  assert.match(source, /action: "catalog\.clear"/);
  assert.match(appSource, /data-clear-catalog/);
  assert.match(appSource, /清空当前团队的 \$\{count\} 条商品资料/);
});

test("trend chart exposes readable point values and keeps report filters beside the data source", () => {
  assert.match(appSource, /class="trend-point"/);
  assert.match(appSource, /class="trend-point-label"/);
  assert.match(appSource, /function operationsNav\(\)/);
  assert.match(appSource, /class="operations-nav-row"/);
  assert.match(appSource, /class="operations-nav-actions"/);
  assert.match(appSource, /class="operations-nav-filters"/);
  assert.match(appSource, /class="data-source-switch"/);
  assert.match(appSource, /<label class="toolbar-scope"><span>报表口径<\/span>/);
  assert.doesNotMatch(appSource, /class="toolbar-row toolbar-primary"/);
  assert.match(appSource, /return `\$\{header\}\$\{operationsNav\(\)\}\$\{modeToolbar\(\)\}/);
  assert.match(stylesSource, /\.operations-nav-row \{ display: flex;/);
  assert.match(stylesSource, /\.operations-nav-actions \{ display: flex;/);
});

test("revoked invitations and device codes are removed from the management payload", () => {
  assert.match(source, /db\.activationCodes\.filter\(\(code\) => code\.teamId === team\.id && !code\.revokedAt\)/);
  assert.match(source, /db\.invitations\.filter\(\(item\) => item\.teamId === team\.id && !item\.revokedAt\)/);
  assert.match(appSource, /state\.team\.invitations \|\| \[\]\)\.filter\(\(item\) => !item\.revokedAt\)/);
});

test("registration UI collects QQ email, password, and team invitation code", () => {
  assert.match(appSource, /name="email"/);
  assert.match(appSource, /name="inviteCode"/);
  assert.match(appSource, /注册并加入团队/);
  assert.doesNotMatch(appSource, /name="emailCode"/);
  assert.doesNotMatch(appSource, /id="send-email-code"/);
});

test("registration preserves the in-progress form and displays request feedback in the form", () => {
  assert.match(appSource, /authDraft: \{ username: '', email: '', password: '', inviteCode: '' \}/);
  assert.match(appSource, /function updateAuthDraft\(form\)/);
  assert.match(appSource, /value="\$\{escape\(draft\.email\)\}"/);
  assert.match(appSource, /value="\$\{escape\(draft\.inviteCode\)\}"/);
  assert.match(appSource, /class="auth-feedback/);
  assert.match(stylesSource, /\.auth-feedback \{ padding: 10px 11px;/);
});

test("deleting a team detaches members instead of deleting their login accounts", () => {
  assert.match(source, /next\.teamMemberships = next\.teamMemberships\.filter\(\(membership\) => membership\.teamId !== team\.id\);/);
  assert.match(source, /setActiveTeamForUser\(next, user, fallback\?\.teamId \|\| ""\);/);
  assert.doesNotMatch(source, /next\.users = next\.users\.filter/);
  assert.doesNotMatch(source, /if \(user\.role !== "platform-admin" && !fallback\) return res\.status\(403\)/);
  assert.match(source, /app\.post\("\/api\/teams\/:teamId\/leave"/);
  assert.match(source, /LAST_TEAM_ADMIN/);
  assert.match(appSource, /id="leave-team"/);
  assert.match(appSource, /\/api\/teams\/\$\{state\.session\.teamId\}\/leave/);
});

test("team admins can dissolve only their own team and keep their session", () => {
  assert.match(source, /app\.delete\("\/api\/teams\/:teamId\/dissolve", requireUser, requireTeamManager/);
  assert.match(source, /auditAction: "team\.dissolve"/);
  assert.match(source, /if \(actorAfterDeletion\) setSession\(res, actorAfterDeletion\);/);
  assert.match(appSource, /id="dissolve-team"/);
  assert.match(appSource, /\/api\/teams\/\$\{button\.dataset\.teamId\}\/dissolve/);
});

async function waitForHttp(url, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("multi-team memberships, invite registration, device activation, and catalog uniqueness work end to end", async (t) => {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const dataDir = path.join(root, ".test-data", `membership-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CLOUD_HUB_DATA_DIR: dataDir,
      COOKIE_SECURE: "false",
      CLOUD_ADMIN_PASSWORD: "test-platform-admin-password",
      MANAGED_CODE_ENCRYPTION_SECRET: "test-managed-code-encryption-secret",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/api/health`);
  const request = (url, { method = "GET", body, cookie } = {}) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (response, expectedStatus) => {
    assert.equal(response.status, expectedStatus, `${response.url}: ${await response.clone().text()}`);
    return response.json();
  };

  const emailCode = await request("/api/auth/email-code", { method: "POST", body: { email: "member@qq.com" } });
  assert.equal(emailCode.status, 410);
  assert.equal((await emailCode.json()).code, "EMAIL_REGISTRATION_DISABLED");
  assert.equal((await request("/api/auth/register", { method: "POST", body: { email: "member@qq.com", password: "a-strong-test-password" } })).status, 400);

  const adminLogin = await request("/api/auth/login", { method: "POST", body: { username: "owner", password: "test-platform-admin-password" } });
  await json(adminLogin, 200);
  const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(adminCookie);

  const teamA = (await json(await request("/api/admin/teams", { method: "POST", cookie: adminCookie, body: { name: "Team A", plan: "team", memberLimit: 6 } }), 201)).team;
  const invite = await json(await request(`/api/teams/${teamA.id}/invitations`, { method: "POST", cookie: adminCookie, body: { label: "Team A invite", expiresInDays: 7 } }), 201);
  const registered = await request("/api/auth/register", { method: "POST", body: { email: "member@qq.com", inviteCode: invite.code, password: "a-strong-test-password" } });
  const registeredBody = await json(registered, 201);
  const memberCookie = registered.headers.get("set-cookie")?.split(";")[0];
  const userId = registeredBody.user.id;
  assert.equal(registeredBody.user.memberships.length, 1);

  const teamB = (await json(await request("/api/admin/teams", { method: "POST", cookie: adminCookie, body: { name: "Team B", plan: "team", memberLimit: 6 } }), 201)).team;
  await json(await request(`/api/admin/members/${userId}/membership`, { method: "PUT", cookie: adminCookie, body: { teamId: teamA.id, role: "member", note: "A 组运营" } }), 200);
  const secondMembership = await json(await request(`/api/admin/members/${userId}/team-access`, { method: "PUT", cookie: adminCookie, body: { teamIds: [teamA.id, teamB.id], currentTeamId: teamB.id, currentRole: "team-admin", currentNote: "B 组负责人" } }), 200);
  assert.equal(secondMembership.user.memberships.length, 2);
  assert.equal(secondMembership.user.memberships.find((item) => item.teamId === teamA.id)?.note, "A 组运营");
  assert.equal(secondMembership.user.memberships.find((item) => item.teamId === teamB.id)?.note, "B 组负责人");

  assert.equal((await request(`/api/admin/teams/${teamA.id}`, { cookie: memberCookie })).status, 403, "ordinary membership must not manage Team A");
  await json(await request("/api/session/team", { method: "POST", cookie: memberCookie, body: { teamId: teamB.id } }), 200);
  assert.equal((await request(`/api/admin/teams/${teamB.id}`, { cookie: memberCookie })).status, 200, "Team B admin membership must allow management");
  const lastAdminDemotion = await request(`/api/admin/members/${userId}/membership`, { method: "PUT", cookie: adminCookie, body: { teamId: teamB.id, role: "member", note: "B 组负责人" } });
  assert.equal(lastAdminDemotion.status, 409);
  assert.equal((await lastAdminDemotion.json()).code, "LAST_TEAM_ADMIN");

  await json(await request(`/api/admin/teams/${teamB.id}`, { method: "DELETE", cookie: adminCookie, body: { confirmName: "Team B" } }), 200);
  const sessionAfterDeletion = await json(await request("/api/session", { cookie: memberCookie }), 200);
  assert.equal(sessionAfterDeletion.user.teamId, teamA.id);
  assert.equal(sessionAfterDeletion.user.memberships.length, 1);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { username: "member@qq.com", password: "a-strong-test-password" } })).status, 200);

  await json(await request(`/api/admin/teams/${teamA.id}/admins`, { method: "POST", cookie: adminCookie, body: { username: "manager@qq.com", password: "another-strong-password" } }), 201);
  await json(await request(`/api/admin/teams/${teamA.id}/admins`, { method: "POST", cookie: adminCookie, body: { username: "manager2@qq.com", password: "another-strong-password" } }), 201);
  const belowMemberLimit = await request(`/api/admin/teams/${teamA.id}`, { method: "PATCH", cookie: adminCookie, body: { name: "Team A", plan: "team", memberLimit: 2 } });
  assert.equal(belowMemberLimit.status, 409);
  const patchedTeam = await json(await request(`/api/admin/teams/${teamA.id}`, { method: "PATCH", cookie: adminCookie, body: { name: "Team A", plan: "team", memberLimit: 3 } }), 200);
  assert.equal(patchedTeam.team.memberLimit, 3);

  const initialTeamDetail = await json(await request(`/api/admin/teams/${teamA.id}`, { cookie: adminCookie }), 200);
  const store = initialTeamDetail.stores[0];
  assert.equal(store.name, "Team A");
  const extraStore = await request(`/api/admin/teams/${teamA.id}/stores`, { method: "POST", cookie: adminCookie, body: { name: "不应新增的第二家店" } });
  assert.equal(extraStore.status, 409);
  assert.equal((await extraStore.json()).code, "ONE_STORE_PER_TEAM");
  const templateResponse = await request("/api/templates/product-catalog.xlsx", { cookie: adminCookie });
  assert.equal(templateResponse.status, 200);
  assert.match(templateResponse.headers.get("content-type") || "", /spreadsheetml/);
  const templateBook = XLSX.read(await templateResponse.arrayBuffer(), { type: "array" });
  const templateRows = XLSX.utils.sheet_to_json(templateBook.Sheets["商品资料"], { header: 1, raw: false });
  assert.deepEqual(templateRows.slice(0, 2), [["店铺名", "商品ID", "品类名", "型号"], ["示例店铺", "1234567890", "电饭煲", "示例型号-01"]]);
  const product = { storeName: store.name, productId: "1234567890", category: "电饭煲", model: "CFXB-TEST" };
  assert.equal((await request(`/api/teams/${teamA.id}/product-catalog`, { method: "POST", cookie: adminCookie, body: product })).status, 201);
  const duplicate = await request(`/api/teams/${teamA.id}/product-catalog`, { method: "POST", cookie: adminCookie, body: product });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "PRODUCT_CATALOG_DUPLICATE");
  const clearCatalog = await json(await request(`/api/teams/${teamA.id}/product-catalog`, { method: "DELETE", cookie: adminCookie }), 200);
  assert.equal(clearCatalog.removedCount, 1);
  const clearedWorkspace = await json(await request(`/api/web/workspace?teamId=${teamA.id}`, { cookie: adminCookie }), 200);
  assert.equal(clearedWorkspace.workspace.productCatalog.length, 0);

  const activationCode = await json(await request(`/api/admin/teams/${teamA.id}/codes`, { method: "POST", cookie: adminCookie, body: { label: "测试设备", mode: "team", storeIds: [store.id] } }), 201);
  await json(await request("/api/device/activate", { method: "POST", body: { code: activationCode.code, deviceId: "test-device-0001", deviceName: "测试电脑", appVersion: "1.0.0" } }), 200);
  const teamDetail = await json(await request(`/api/admin/teams/${teamA.id}`, { cookie: adminCookie }), 200);
  assert.equal(teamDetail.team.memberCount, 3);
  assert.equal(teamDetail.team.memberLimit, 3);
  assert.equal(teamDetail.team.activeDeviceCount, 1);
  assert.equal(teamDetail.team.deviceLimit, 6);
  assert.equal(teamDetail.devices.length, 1);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["商品ID", "商品名称", "支付金额", "成功退款金额"],
    ["10001", "测试商品", 120, 20],
  ]), "商品排行");
  const form = new FormData();
  form.append("file", new Blob([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "商品排行.xlsx");
  form.append("storeId", store.id);
  form.append("type", "product");
  form.append("periodKind", "day");
  form.append("periodStart", "2026-07-31");
  form.append("periodEnd", "2026-07-31");
  form.append("sourceName", "route test");
  const uploaded = await json(await fetch(`${baseUrl}/api/teams/${teamA.id}/reports`, { method: "POST", headers: { cookie: adminCookie }, body: form }), 201);
  const dbPath = path.join(dataDir, "hub.json");
  const beforeDelete = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const rawPath = beforeDelete.reports.find((report) => report.id === uploaded.report.id)?.rawPath;
  assert.ok(rawPath && await fs.stat(rawPath));
  assert.equal((await request(`/api/teams/${teamA.id}/reports/${uploaded.report.id}`, { method: "DELETE", cookie: adminCookie })).status, 204);
  const afterDelete = JSON.parse(await fs.readFile(dbPath, "utf8"));
  assert.equal(afterDelete.reports.some((report) => report.id === uploaded.report.id), false);
  await assert.rejects(fs.stat(rawPath));
  const workspaceAfterDelete = await json(await request(`/api/web/workspace?teamId=${teamA.id}`, { cookie: adminCookie }), 200);
  assert.equal(workspaceAfterDelete.warehouse.some((report) => report.id === uploaded.report.id), false);
  assert.equal((await request(`/api/teams/${teamA.id}/reports/${uploaded.report.id}/restore`, { method: "POST", cookie: adminCookie })).status, 404);
});
