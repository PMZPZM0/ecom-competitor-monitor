import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { parseOperationsFile } from "../public/operationsCore.js";
import { parseOperationsFile as parseBackendOperationsFile } from "../../server/services/operationsAssistantService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "server.js"), "utf8");
const appSource = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
const operationsCoreSource = await fs.readFile(path.join(root, "public", "operationsCore.js"), "utf8");
const stylesSource = await fs.readFile(path.join(root, "public", "styles.css"), "utf8");
const htmlSource = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
const localOperationsSource = await fs.readFile(path.join(root, "..", "src", "features", "operations", "OperationsAssistant.tsx"), "utf8");

function latestProductCatalogEntriesForTest(entries = []) {
  const replacedIds = new Set(entries.map((entry) => entry.replacesId).filter(Boolean));
  const latest = new Map();
  for (const entry of entries) {
    if (replacedIds.has(entry.id)) continue;
    const key = `${String(entry.storeName || "").trim().toLowerCase()}\u0000${String(entry.productId || "").trim()}`;
    latest.set(key, entry);
  }
  return [...latest.values()];
}

test("the product brand and team cards expose a clear operating identity", () => {
  assert.match(htmlSource, /<title>经营罗盘 · 团队经营决策<\/title>/);
  assert.match(htmlSource, /styles\.css\?v=[^"']+/);
  assert.match(htmlSource, /app\.js\?v=[^"']+/);
  assert.match(appSource, /operationsCore\.js\?v=20260801-auto-comparison-8/);
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

test("cloud report upload defaults to the current team's store and keeps manual selection", () => {
  assert.match(appSource, /function defaultUploadStoreName\(mode\)/);
  assert.match(appSource, /if \(mode === 'cloud' && stores\.length === 1\) return stores\[0\]\.name;/);
  assert.match(appSource, /storeName: defaultUploadStoreName\(mode\)/);
  assert.match(appSource, /uploadSelectMenu\('storeName', upload\.storeName/);
  assert.match(appSource, /已识别当前团队店铺，可手动修改/);
});

test("report upload exposes batch recognition, per-file status, and retry feedback", () => {
  assert.match(appSource, /type="file" multiple accept=/);
  assert.match(appSource, /function activeUploadItem\(\)/);
  assert.match(appSource, /function uploadItemReady\(item\)/);
  assert.match(appSource, /data-select-upload-item=/);
  assert.match(appSource, /data-remove-upload-item=/);
  assert.match(appSource, /for \(let index = 0; index < additions\.length; index \+= 1\)/);
  assert.match(appSource, /state\.upload\.status = 'recognizing'/);
  assert.match(appSource, /state\.upload\.status = 'uploading'/);
  assert.match(appSource, /status: 'upload-error'/);
  assert.match(appSource, /status = 'partial'/);
  assert.match(appSource, /修正后可直接重试失败项/);
  assert.match(appSource, /class="upload-progress" role="status" aria-live="polite"/);
  assert.match(stylesSource, /\.upload-progress \{ display: grid;/);
  assert.match(stylesSource, /\.upload-batch-list \{ display: grid;/);
  assert.match(stylesSource, /\.upload-item-editor \{ padding:/);
});

test("short UTF-8 promotion CSV keeps Chinese headers and is auto-detected", async () => {
  const content = [
    "统计日期,商品ID,推广类型,计划名称,花费,成交金额",
    "2026-07-30,900001,全站推广,批量验收计划A,120,600",
  ].join("\n");
  const parsed = await parseOperationsFile({
    buffer: Buffer.from(content, "utf8"),
    originalname: "单品付费.csv",
  });
  assert.deepEqual(parsed.columns, ["统计日期", "商品ID", "推广类型", "计划名称", "花费", "成交金额"]);
  assert.equal(parsed.detectedType, "campaign");
  assert.deepEqual(parsed.period, { start: "2026-07-30", end: "2026-07-30", label: "2026-07-30" });
  assert.equal(parsed.rows[0].productId, "900001");
  assert.equal(parsed.rows[0].channel, "全站推广");

  const backendParsed = await parseBackendOperationsFile({
    buffer: Buffer.from(content, "utf8"),
    originalname: "单品付费.csv",
  });
  assert.deepEqual(backendParsed.columns, parsed.columns);
  assert.equal(backendParsed.detectedType, "campaign");
  assert.deepEqual(backendParsed.period, parsed.period);
});

test("operations toolbar exposes a rolling seven-day daily aggregation shortcut", () => {
  assert.match(appSource, /preset === 'last-7-days'/);
  assert.match(appSource, /\['last-7-days', '近 7 日'\]/);
  assert.match(appSource, /preset === 'last-15-days'/);
  assert.match(appSource, /\['last-15-days', '近 15 日'\]/);
});

test("entity matrices replace large cards with row comparisons and custom columns", () => {
  assert.match(appSource, /function managedMetricGrid\(panel, coreCards, visibleRows\)/);
  assert.match(appSource, /managedMetricGrid\('store'/);
  assert.doesNotMatch(appSource, /managedMetricGrid\('category'/);
  assert.doesNotMatch(appSource, /managedMetricGrid\('product'/);
  assert.match(appSource, /function customCardSettingsModal\(\)/);
  assert.match(appSource, /operations-custom-cards-v1:/);
  assert.match(appSource, /operations-comparison-visibility-v1:/);
  assert.match(appSource, /operations-matrix-metrics-v1:/);
  assert.match(appSource, /MATRIX_CUSTOM_METRIC_LIMIT = 8/);
  assert.doesNotMatch(appSource, /operations-core-card-comparisons-v1:/);
  assert.match(appSource, /comparison-up/);
  assert.match(appSource, /comparison-down/);
  assert.match(appSource, /\['day', '日环比'\]/);
  assert.match(appSource, /\['last15', '近 15 天'\]/);
  assert.match(appSource, /function automaticComparisonId\(preset\)/);
  assert.match(appSource, /function entityComparisonBadge\(metricId, row, previousRow, comparison\)/);
  assert.match(appSource, /previousEntityIndex\(kind, previousRows\)/);
  for (const metricId of ['grossRevenue', 'refundAmount', 'revenue', 'spend', 'promotionRevenue', 'roi', 'feeRate']) {
    assert.match(appSource, new RegExp(`badge\\('${metricId}', row, previousRow\\)`));
  }
  assert.match(appSource, /data-comparison-toggle=/);
  assert.match(appSource, /data-matrix-metric-toggle=/);
  assert.match(appSource, /data-matrix-metric-order=/);
  assert.match(appSource, /data-matrix-metric-move=/);
  assert.match(appSource, /function reorderMatrixMetric\(panel, sourceId, targetId\)/);
  assert.match(appSource, /customMetricIds\.map/);
  assert.match(stylesSource, /\.metric-comparison-switch/);
  assert.match(stylesSource, /\.entity-comparison-badge/);
  assert.match(stylesSource, /\.custom-metric-options/);
  assert.match(stylesSource, /\.matrix-metric-order-list/);
  assert.match(stylesSource, /\.entity-table \.metric-custom::before/);
  assert.match(operationsCoreSource, /function buildDashboardComparisons\(normalized, filters, fallbackEnd\)/);
  assert.match(operationsCoreSource, /dashboard\.comparisons = buildDashboardComparisons/);
});

test("sales deduction warehouse keeps history separate from the active calculation scope", () => {
  assert.match(operationsCoreSource, /salesDeductionHistory: state\.salesDeductions\.slice\(\)\.sort/);
  assert.match(appSource, /model\.core\.salesDeductionHistory \|\| currentDeductions/);
  assert.match(appSource, /当前口径/);
  assert.match(appSource, /历史记录/);
});

test("normal login, invitation acceptance, and self-service team creation open operations data", () => {
  assert.match(appSource, /function openOperationsHome\(\) \{[\s\S]*state\.page = 'operations';[\s\S]*state\.activePanel = 'overview';/);
  assert.match(appSource, /if \(register\) \{ const result = await api\('\/api\/auth\/register'/);
  assert.match(appSource, /state\.authBusy = ''; state\.authFeedback = null; state\.authDraft = \{ username: '', password: '', inviteCode: '' \};\n      openOperationsHome\(\);\n      await bootstrap\(\);/);
  assert.match(appSource, /state\.session = result\.user; openOperationsHome\(\); await bootstrap\(\); setToast\('团队已创建，已进入运营数据。'\);/);
  assert.match(appSource, /state\.session = result\.user; openOperationsHome\(\); await bootstrap\(\); setToast\('已加入团队，已进入运营数据。'\);/);
});

test("upload dialog keeps the date range inside an application-managed calendar", () => {
  assert.match(appSource, /function uploadDateRangePicker\(item = activeUploadItem\(\)\)/);
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

test("entity expansion uses a detached drawer without rebuilding the large table", () => {
  assert.match(appSource, /function parseEntityTarget\(value\)/);
  assert.match(appSource, /key: source\.slice\(separator \+ 1\)/);
  assert.match(appSource, /function entityFilterMenu\(kind, field, options, totalCount = options\.length\)/);
  assert.match(appSource, /data-entity-filter-toggle=/);
  assert.match(appSource, /data-entity-filter-query=/);
  assert.match(appSource, /data-entity-filter-select-all=/);
  assert.match(appSource, /data-entity-filter-clear=/);
  assert.doesNotMatch(appSource, /<details class="filter-menu">/);
  assert.match(appSource, /function promotionDrawer\(row, kind\)/);
  assert.match(appSource, /data-entity-kind=/);
  assert.match(appSource, /data-entity-key=/);
  assert.match(appSource, /function toggleEntityExpansion\(button\)/);
  assert.match(appSource, /document\.body\.insertAdjacentHTML\('beforeend', promotionDrawer\(row, kind\)\)/);
  assert.match(appSource, /data-entity-drawer/);
  assert.match(appSource, /sourceRow\.classList\.add\('entity-row-active'\)/);
  assert.match(appSource, /function captureEntityScroll\(\)/);
  assert.match(appSource, /function restoreEntityScroll\(\)/);
  assert.match(appSource, /const previousToggle = table\.querySelector\('\.promotion-toggle\[aria-expanded="true"\]'\)/);
  assert.match(appSource, /if \(previousToggle\) \{/);
  assert.doesNotMatch(appSource, /insertAdjacentHTML\('afterend', promotionDetails/);
  assert.doesNotMatch(appSource, /getBoundingClientRect\(\)\.height/);
  assert.doesNotMatch(appSource, /data-entity-expand=/);
  assert.match(stylesSource, /\.entity-filter-panel \{ position: absolute;/);
  assert.match(stylesSource, /\.entity-table table \{ table-layout: fixed; \}/);
  assert.match(stylesSource, /\.promotion-drawer-shell \{ position: fixed;/);
});

test("bootstrap failures render a retryable page instead of leaving the application blank", () => {
  assert.match(appSource, /bootstrapError: ''/);
  assert.match(appSource, /class="load-failure" role="alert"/);
  assert.match(appSource, /id="retry-bootstrap"/);
  assert.match(appSource, /await Promise\.allSettled\(\[loadCloudWorkspace\(\)/);
  assert.match(appSource, /workspaceResult\.status === 'rejected'/);
  assert.match(appSource, /try \{ await bootstrap\(\); \} catch \(error\)/);
  assert.match(stylesSource, /\.load-failure \{ min-height: 420px;/);
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

test("category and product matrices include linked top-ten sales and spend bars", () => {
  assert.match(appSource, /function entityComparisonChart\(rows, kind\)/);
  assert.match(appSource, /TOP 10 · 净 GSV 排名/);
  assert.match(appSource, /entityComparisonChart\(visible, kind\)/);
  assert.match(appSource, /class="entity-bar-track"/);
  assert.match(appSource, /width\(row\.revenue, maxRevenue\)/);
  assert.match(appSource, /width\(row\.spend, maxSpend\)/);
  assert.match(stylesSource, /\.entity-bar-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.entity-bar-track i\.revenue \{ background: #0f9f83; \}/);
  assert.match(stylesSource, /\.entity-bar-track i\.spend \{ background: #3478d4; \}/);
});

test("matrix result controls sit below the top-ten chart and directly above the detail table", () => {
  const matrixStart = appSource.indexOf('return `<article class="entity-matrix">');
  const chartIndex = appSource.indexOf('${entityComparisonChart(visible, kind)}', matrixStart);
  const toolsIndex = appSource.indexOf('class="matrix-tools matrix-table-tools"', matrixStart);
  const tableIndex = appSource.indexOf('data-entity-table="${kind}"', matrixStart);
  assert.ok(matrixStart >= 0 && chartIndex > matrixStart && toolsIndex > chartIndex && tableIndex > toolsIndex);
  assert.match(appSource, /<header class="matrix-head"><div><h3>[\s\S]*?<\/p><\/div><\/header><div class="selection-summary">/);
  assert.match(stylesSource, /\.matrix-table-tools \{ position: relative; z-index: 12;/);
});

test("top-ten charts expose promotion fee rate with shared risk thresholds", () => {
  assert.match(appSource, /const FEE_RATE_QUALIFIED_MAX = 0\.095/);
  assert.match(appSource, /const FEE_RATE_WARNING_MAX = 0\.11/);
  assert.match(appSource, /function feeRateTone\(value\)/);
  assert.match(appSource, /Number\(value\) <= FEE_RATE_QUALIFIED_MAX/);
  assert.match(appSource, /Number\(value\) <= FEE_RATE_WARNING_MAX/);
  assert.match(appSource, /const rate = calculatedPromotion\(row\)\.feeRate/);
  assert.match(appSource, /class="entity-bar-rate"/);
  assert.match(appSource, /function feeRateValue\(value\)/);
  assert.match(appSource, /\$\{feeRateValue\(rate\)\}/);
  assert.match(stylesSource, /\.fee-rate\.good/);
  assert.match(stylesSource, /\.fee-rate\.warn/);
  assert.match(stylesSource, /\.fee-rate\.high/);
  assert.match(stylesSource, /\.fee-rate\.neutral/);
});

test("comparison charts always use the currently filtered date, store, and period workspace", () => {
  assert.match(appSource, /state\.workspace = await api\(`\/api\/web\/workspace\?\$\{query\(filters\)\}`\)/);
  assert.match(appSource, /state\.filters = \{ \.\.\.state\.filters, \.\.\.next \}/);
  assert.match(appSource, /applyScope\(dateRangeForPreset\(preset\)\)/);
  assert.match(appSource, /applyScope\(ordered\)/);
  assert.match(appSource, /entityComparisonChart\(visible, kind\)/);
  assert.match(source, /buildOperationsWorkspace\(\{[\s\S]*reports: reportsForTeam\(db, teamId\)[\s\S]*\}, \{ filters \}\)/);
});

test("mobile operations view prioritizes executive metrics and converts matrices to cards", () => {
  assert.match(stylesSource, /Mobile executive view/);
  assert.match(stylesSource, /\.metrics-grid\.dashboard-metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.operations-nav-row \.data-tabs \{ display: grid; grid-template-columns: repeat\(4, minmax\(76px, 1fr\)\)/);
  assert.match(stylesSource, /\.entity-table tbody > tr \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.entity-table \.metric-revenue::before/);
  assert.match(stylesSource, /\.entity-table \.metric-custom::before/);
  assert.doesNotMatch(stylesSource, /\.product-matrix-table td:nth-child/);
  assert.match(stylesSource, /\.promotion-drawer \{ top: auto; bottom: 0;/);
});

test("store overview ranks category sales and exposes sales and spend shares", () => {
  assert.match(appSource, /function categoryContributionPanel\(rows\)/);
  assert.match(appSource, /类目销售贡献与推广效率/);
  assert.match(appSource, /<small>销售占比<\/small>/);
  assert.match(appSource, /<small>花费占比<\/small>/);
  assert.match(appSource, /categoryContributionPanel\(dashboard\.categories\)/);
  assert.match(appSource, /const revenueShare = share\(row\.revenue, totalRevenue\); const spendShare = share\(row\.spend, totalSpend\)/);
  assert.match(appSource, /scale\(row\.revenue, maxRevenue\)/);
  assert.match(appSource, /scale\(row\.spend, maxSpend\)/);
  assert.match(stylesSource, /\.contribution-metric\.revenue > i b \{ background: #0f9f83; \}/);
  assert.match(stylesSource, /\.contribution-metric\.spend > i b \{ background: #3478d4; \}/);
});

test("store category structure shows fee rate from spend divided by net GSV", () => {
  assert.match(appSource, /const totals = sumRows\(active\)/);
  assert.match(appSource, /整体推广费率/);
  assert.match(appSource, /feeRateValue\(totals\.feeRate\)/);
  assert.match(appSource, /<span>类目推广费率<\/span>/);
  assert.match(appSource, /<small>推广花费 ÷ 类目净 GSV<\/small>/);
  assert.doesNotMatch(appSource, /promotionRevenue\s*\/\s*(?:row\.)?revenue/);
});

test("store category contribution labels every amount, share, rate, and formula", () => {
  assert.match(appSource, /类目销售贡献与推广效率/);
  assert.match(appSource, /销售占比/);
  assert.match(appSource, /类目净 GSV ÷ 已关联类目净 GSV 合计/);
  assert.match(appSource, /花费占比/);
  assert.match(appSource, /类目推广花费 ÷ 已关联类目推广花费合计/);
  assert.match(appSource, /类目推广费率/);
  assert.match(appSource, /类目推广花费 ÷ 类目净 GSV/);
  assert.match(stylesSource, /\.contribution-formulas \{ display: grid;/);
  assert.match(stylesSource, /grid-template-areas: "name name" "revenue spend" "rate rate"/);
});

test("registration is invitation-only and the legacy email-code route is explicitly retired", () => {
  assert.match(source, /app\.post\("\/api\/auth\/email-code"/);
  assert.match(source, /res\.status\(410\).*EMAIL_REGISTRATION_DISABLED/);
  assert.match(source, /LOGIN_USERNAME_PATTERN = /);
  assert.match(source, /function normalizeLoginUsername\(value\)/);
  assert.match(source, /username: z\.string\(\)\.trim\(\)\.min\(2\)\.max\(40\)/);
  assert.match(source, /inviteCode: z\.string\(\)\.trim\(\)\.min\(8\)\.max\(80\)/);
  assert.match(source, /team\.invite\.register/);
  assert.doesNotMatch(source, /normalizeQqEmail/);
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
  assert.match(appSource, /<dt>计划费率<\/dt><dd>\$\{feeRateValue\(plan\.feeRate\)\}<\/dd>/);
  assert.match(appSource, /整体费率 \$\{feeRateValue\(channel\.feeRate\)\}/);
});

test("report upload and archive share one warehouse panel", () => {
  assert.match(appSource, /\['upload', '报表管理', '上传、核对与归档'\]/);
  assert.match(appSource, /`\$\{uploadWarehouseCard\(model\)\}\$\{archiveWarehouseCard\(model, groups, selectedIds, false\)\}`/);
  assert.match(appSource, /showImportButton \? `<button class="btn primary small" data-open-upload=/);
  assert.doesNotMatch(appSource, /\['archive', '数据归档'/);
});

test("local and cloud archives group reports by store before newest statistics period", () => {
  assert.match(localOperationsSource, /function groupReportsByStoreAndStatisticsDate\(/);
  assert.match(localOperationsSource, /dateGroups: groupReportsByStatisticsDate\(storeReports\)/);
  assert.match(localOperationsSource, /return right\.sortDate\.localeCompare\(left\.sortDate\)/);
  assert.match(localOperationsSource, /店铺 · \{store\.label\}/);
  assert.match(appSource, /dateGroups: \[\.\.\.store\.periods\.values\(\)\]/);
  assert.match(appSource, /`\$\{b\.end\}\|\$\{b\.start\}`\.localeCompare\(`/);
  assert.match(appSource, /data-toggle-store-group=/);
  assert.match(appSource, /data-select-store-group=/);
  assert.match(stylesSource, /\.archive-store-group \{/);
  assert.match(stylesSource, /\.archive-period-groups \{/);
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

test("product catalog supports transactional bulk maintenance from the current page", () => {
  assert.match(source, /app\.patch\("\/api\/teams\/:teamId\/product-catalog\/bulk", requireUser, requireTeamManager/);
  assert.match(source, /ids: z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\.max\(80\)\)\.min\(1\)\.max\(500\)/);
  assert.match(source, /code: "PRODUCT_CATALOG_STALE_SELECTION"/);
  assert.match(source, /code: "PRODUCT_CATALOG_DUPLICATE"/);
  assert.match(source, /action: "catalog\.bulk-update"/);
  assert.match(appSource, /data-select-catalog-page/);
  assert.match(appSource, /data-select-catalog=/);
  assert.match(appSource, /id="catalog-bulk-edit"/);
  assert.match(appSource, /留空字段不会改变/);
  assert.match(appSource, /product-catalog\/bulk/);
  assert.match(stylesSource, /\.catalog-bulk-editor\{display:grid;/);
  assert.match(operationsCoreSource, /if \(replacedIds\.has\(entry\.id\)\) continue;/);
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

test("registration UI collects username, password, and team invitation code without requiring email", () => {
  assert.match(appSource, /用户名或原 QQ 邮箱/);
  assert.match(appSource, /name="username"/);
  assert.match(appSource, /name="inviteCode"/);
  assert.match(appSource, /注册并加入团队/);
  assert.doesNotMatch(appSource, /name="email"/);
  assert.doesNotMatch(appSource, /name="emailCode"/);
  assert.doesNotMatch(appSource, /id="send-email-code"/);
});

test("product category and model filters are bidirectionally linked", () => {
  assert.match(appSource, /function normalizeEntityLinkedSelection\(kind, changedField/);
  assert.match(appSource, /changedField === 'category' \? 'model' : 'category'/);
  assert.match(appSource, /entityFilterOptions\(kind, oppositeField, rows\)/);
  assert.match(appSource, /normalizeEntityLinkedSelection\(kind, field\)/);
  assert.match(appSource, /entityFilterMenu\(kind, 'category', categories, allCategories\.length\)/);
  assert.match(appSource, /entityFilterMenu\(kind, 'model', models, allModels\.length\)/);
  assert.match(appSource, /entity-filter-linked/);
  assert.match(stylesSource, /\.entity-filter-linked \{/);
});

test("entity filter panels escape the matrix crop and use the available viewport", () => {
  assert.match(stylesSource, /\.entity-matrix\{overflow:visible/);
  assert.match(stylesSource, /\.matrix-head\{position:relative;z-index:12;/);
  assert.match(stylesSource, /\.entity-filter-panel \{ position: absolute; z-index: 48;/);
  assert.match(stylesSource, /max-height: min\(560px, calc\(100vh - 120px\)\)/);
  assert.match(stylesSource, /\.entity-filter-options \{ min-height: 90px; max-height: 370px; flex: 1 1 auto; overflow: auto;/);
  assert.match(appSource, /class="entity-filter entity-filter-\$\{field\}"/);
  assert.match(stylesSource, /\.entity-matrix \{ width: 100%; max-width: 100%; \}/);
  assert.match(stylesSource, /\.matrix-tools \.entity-filter \{ position: static; \}/);
  assert.match(stylesSource, /\.matrix-tools \.entity-filter-panel \{\s+position: fixed;/);
  assert.match(stylesSource, /bottom: max\(12px, env\(safe-area-inset-bottom\)\)/);
  assert.match(stylesSource, /max-height: calc\(100dvh - 24px\)/);
  assert.match(stylesSource, /\.matrix-tools \.entity-filter-category \.entity-filter-panel,\s+\.matrix-tools \.entity-filter-model \.entity-filter-panel \{ right: 12px; left: 12px; \}/);
});

test("category and product filters keep up to three manually saved combinations", () => {
  assert.match(appSource, /const ENTITY_FILTER_HISTORY_LIMIT = 3/);
  assert.match(appSource, /entityFilterHistoryStorageKey\(kind\)/);
  assert.match(appSource, /ecom-operations-entity-filter-history-v1:\$\{kind\}/);
  assert.match(appSource, /function upsertEntityFilterHistory\(kind, categories, manualName = ''\)/);
  assert.match(appSource, /data-entity-filter-history-save/);
  assert.match(appSource, /data-entity-filter-history-apply/);
  assert.match(appSource, /data-entity-filter-history-delete/);
  assert.match(appSource, /data-entity-filter-history-clear/);
  assert.match(appSource, /normalizeEntityLinkedSelection\(kind, 'category'\)/);
  assert.match(stylesSource, /\.entity-filter-history \{/);
});

test("entity filter menus close on outside clicks without swallowing inside selection", () => {
  assert.match(appSource, /document\.addEventListener\('click', \(event\) => \{/);
  assert.match(appSource, /event\.target\.closest\('\.entity-filter'\)/);
  assert.match(appSource, /ui\.filterMenu = ''; ui\.historySaveOpen = false; ui\.historyDraft = ''/);
});

test("custom and upload date ranges always keep start on or before end", () => {
  assert.match(appSource, /function normalizeOrderedDateRange\(start, end, changed = ''\)/);
  assert.match(appSource, /changed === 'end' \? \{ start: end, end \} : \{ start, end: start \}/);
  assert.match(appSource, /#filter-start/);
  assert.match(appSource, /#filter-end/);
  assert.match(appSource, /normalizeOrderedDateRange\(event\.currentTarget\.value, endInput\.value, 'start'\)/);
  assert.match(appSource, /normalizeOrderedDateRange\(startInput\.value, event\.currentTarget\.value, 'end'\)/);
  assert.match(appSource, /normalizeOrderedDateRange\(item\.periodStart, item\.periodEnd, 'end'\)/);
});

test("registration preserves the in-progress form and displays request feedback in the form", () => {
  assert.match(appSource, /authDraft: \{ username: '', password: '', inviteCode: '' \}/);
  assert.match(appSource, /function updateAuthDraft\(form\)/);
  assert.match(appSource, /value="\$\{escape\(draft\.username\)\}"/);
  assert.match(appSource, /value="\$\{escape\(draft\.inviteCode\)\}"/);
  assert.match(appSource, /class="auth-feedback/);
  assert.match(stylesSource, /\.auth-feedback \{ padding: 10px 11px;/);
});

test("users have editable display names while login identifiers remain stable", () => {
  assert.match(source, /app\.patch\("\/api\/account\/profile", requireUser/);
  assert.match(source, /displayName: normalizeDisplayName\(user\.displayName, user\.username \|\| user\.email\)/);
  assert.match(source, /function accountByLoginName\(db, value\)/);
  assert.match(source, /loginKey\(user\.email\)/);
  assert.match(appSource, /function profileModal\(\)/);
  assert.match(appSource, /id="open-profile"/);
  assert.match(appSource, /id="profile-form"/);
  assert.match(appSource, /\/api\/account\/profile/);
  assert.match(appSource, /member\.displayName \|\| member\.username/);
  assert.match(stylesSource, /\.profile-button \{/);
});

test("platform super admins are excluded from memberships, member counts, and team member lists", () => {
  assert.match(source, /if \(!user \|\| user\.role === "platform-admin"\) return \[\];/);
  assert.match(source, /return Boolean\(user && user\.role !== "platform-admin"\);/);
  assert.match(source, /platformAdminUserIds\.has\(String\(source\.userId \|\| ""\)\)/);
  assert.match(source, /PLATFORM_ADMIN_MEMBERSHIP_FORBIDDEN/);
  assert.match(source, /const memberCount = membershipsForTeam\(db, team\.id\)\.length;/);
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
  assert.equal((await request("/api/auth/register", { method: "POST", body: { username: "member_01", password: "a-strong-test-password" } })).status, 400);

  const adminLogin = await request("/api/auth/login", { method: "POST", body: { username: "owner", password: "test-platform-admin-password" } });
  const adminLoginBody = await json(adminLogin, 200);
  const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(adminCookie);
  assert.equal(adminLoginBody.user.memberships.length, 0);

  const teamA = (await json(await request("/api/admin/teams", { method: "POST", cookie: adminCookie, body: { name: "Team A", plan: "team", memberLimit: 6 } }), 201)).team;
  assert.equal(teamA.memberCount, 0, "platform admin must not consume a team seat");
  const hubPath = path.join(dataDir, "hub.json");
  const persistedHub = JSON.parse(await fs.readFile(hubPath, "utf8"));
  persistedHub.teamMemberships.push({ id: "membership_legacy_platform_admin", userId: adminLoginBody.user.id, teamId: teamA.id, role: "team-admin", status: "active", joinedAt: new Date().toISOString() });
  await fs.writeFile(hubPath, JSON.stringify(persistedHub, null, 2), "utf8");
  const normalizedLegacyMembership = await json(await request(`/api/admin/teams/${teamA.id}`, { cookie: adminCookie }), 200);
  assert.equal(normalizedLegacyMembership.team.memberCount, 0, "legacy super-admin memberships must be ignored during normalization");
  assert.equal(normalizedLegacyMembership.members.length, 0);
  assert.equal((await json(await request("/api/session", { cookie: adminCookie }), 200)).user.memberships.length, 0);
  const invite = await json(await request(`/api/teams/${teamA.id}/invitations`, { method: "POST", cookie: adminCookie, body: { label: "Team A invite", expiresInDays: 7 } }), 201);
  const invalidUsername = await request("/api/auth/register", { method: "POST", body: { username: "invalid name", inviteCode: invite.code, password: "a-strong-test-password" } });
  assert.equal(invalidUsername.status, 400);
  assert.equal((await invalidUsername.json()).code, "USERNAME_INVALID");
  const registered = await request("/api/auth/register", { method: "POST", body: { username: "Operator_01", inviteCode: invite.code, password: "a-strong-test-password" } });
  const registeredBody = await json(registered, 201);
  const memberCookie = registered.headers.get("set-cookie")?.split(";")[0];
  const userId = registeredBody.user.id;
  assert.equal(registeredBody.user.username, "Operator_01");
  assert.equal(registeredBody.user.displayName, "Operator_01");
  assert.equal(registeredBody.user.memberships.length, 1);
  const duplicateUsername = await request("/api/auth/register", { method: "POST", body: { username: "operator_01", inviteCode: invite.code, password: "a-strong-test-password" } });
  assert.equal(duplicateUsername.status, 409);
  assert.equal((await duplicateUsername.json()).code, "USERNAME_ALREADY_REGISTERED");
  const profile = await json(await request("/api/account/profile", { method: "PATCH", cookie: memberCookie, body: { displayName: "张三" } }), 200);
  assert.equal(profile.user.username, "Operator_01");
  assert.equal(profile.user.displayName, "张三");

  const platformAdminMembership = await request(`/api/admin/members/${adminLoginBody.user.id}/membership`, { method: "PUT", cookie: adminCookie, body: { teamId: teamA.id, role: "team-admin", note: "不应出现" } });
  assert.equal(platformAdminMembership.status, 404);
  assert.equal((await platformAdminMembership.json()).code, "PLATFORM_ADMIN_MEMBERSHIP_FORBIDDEN");
  const platformAdminPromotion = await request(`/api/admin/teams/${teamA.id}/admins`, { method: "POST", cookie: adminCookie, body: { username: "owner", password: "test-platform-admin-password" } });
  assert.equal(platformAdminPromotion.status, 403);
  assert.equal((await platformAdminPromotion.json()).code, "PLATFORM_ADMIN_MEMBERSHIP_FORBIDDEN");
  const detailWithoutPlatformAdmin = await json(await request(`/api/admin/teams/${teamA.id}`, { cookie: adminCookie }), 200);
  assert.equal(detailWithoutPlatformAdmin.team.memberCount, 1);
  assert.equal(detailWithoutPlatformAdmin.members.some((member) => member.role === "platform-admin"), false);

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
  const relogin = await json(await request("/api/auth/login", { method: "POST", body: { username: "operator_01", password: "a-strong-test-password" } }), 200);
  assert.equal(relogin.user.displayName, "张三");
  assert.equal(relogin.user.username, "Operator_01");

  await json(await request(`/api/admin/teams/${teamA.id}/admins`, { method: "POST", cookie: adminCookie, body: { username: "manager@qq.com", password: "another-strong-password" } }), 201);
  await json(await request(`/api/admin/teams/${teamA.id}/admins`, { method: "POST", cookie: adminCookie, body: { username: "manager2@qq.com", password: "another-strong-password" } }), 201);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { username: "manager@qq.com", password: "another-strong-password" } })).status, 200, "existing QQ-email-shaped accounts must remain login-compatible");
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
  const firstCatalogEntry = await json(await request(`/api/teams/${teamA.id}/product-catalog`, { method: "POST", cookie: adminCookie, body: product }), 201);
  const duplicate = await request(`/api/teams/${teamA.id}/product-catalog`, { method: "POST", cookie: adminCookie, body: product });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "PRODUCT_CATALOG_DUPLICATE");
  const secondProduct = { storeName: store.name, productId: "2234567890", category: "电压力锅", model: "SY-TEST" };
  const secondCatalogEntry = await json(await request(`/api/teams/${teamA.id}/product-catalog`, { method: "POST", cookie: adminCookie, body: secondProduct }), 201);
  const bulkCatalog = await json(await request(`/api/teams/${teamA.id}/product-catalog/bulk`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { ids: [firstCatalogEntry.entry.id, secondCatalogEntry.entry.id], changes: { category: "炊具", model: "批量型号" } },
  }), 200);
  assert.equal(bulkCatalog.updatedCount, 2);
  assert.equal(bulkCatalog.workspace.productCatalog.length, 4, "append-only versions remain available for audit");
  const currentCatalog = latestProductCatalogEntriesForTest(bulkCatalog.workspace.productCatalog);
  assert.equal(currentCatalog.length, 2);
  assert.deepEqual(currentCatalog.map((entry) => [entry.category, entry.model]), [["炊具", "批量型号"], ["炊具", "批量型号"]]);
  const staleBulkCatalog = await request(`/api/teams/${teamA.id}/product-catalog/bulk`, { method: "PATCH", cookie: adminCookie, body: { ids: [firstCatalogEntry.entry.id], changes: { model: "过期资料" } } });
  assert.equal(staleBulkCatalog.status, 409);
  assert.equal((await staleBulkCatalog.json()).code, "PRODUCT_CATALOG_STALE_SELECTION");
  const clearCatalog = await json(await request(`/api/teams/${teamA.id}/product-catalog`, { method: "DELETE", cookie: adminCookie }), 200);
  assert.equal(clearCatalog.removedCount, 2);
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
