import { buildOperationsWorkspace } from '/operationsCore.js?v=20260731-core-6';

const app = document.querySelector('#app');
const TYPE_LABELS = { category: '品类360', product: '商品排行', promotion: '单品付费', campaign: '单品付费' };
const PERIOD_LABELS = { day: '日报', week: '周报', month: '月报', custom: '自定义周期' };
const LOCAL_DB = 'ecom-operations-browser-data-v1';
const LOCAL_STORE = 'reports';
const LOCAL_META_STORE = 'meta';
const SELECTED_TEAM_KEY = 'ecom-platform-selected-team-v1';
const state = {
  session: null, page: 'operations', mode: 'cloud', workspace: null, overview: null, team: null,
  localReports: [], localMeta: { productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [] },
  filters: { start: '', end: '', storeName: '', sourcePeriodKind: 'auto' }, datePreset: 'yesterday', customScopeOpen: false,
  toast: null, activity: null, modal: '', activePanel: 'overview', warehousePanel: 'upload', authMode: 'login', authDraft: { username: '', email: '', password: '', inviteCode: '' }, authFeedback: null, authBusy: '', copiedCode: '', deviceCode: '', selectedTeamId: window.sessionStorage.getItem(SELECTED_TEAM_KEY) || '', teamMenuOpen: false, platformSettings: { allowTeamCreation: true },
  trendMetrics: ['revenue'], entityUi: { category: { keyword: '', categories: [], models: [], sort: 'revenue', direction: 'desc', expanded: '', filterMenu: '', categoryQuery: '', modelQuery: '' }, product: { keyword: '', categories: [], models: [], sort: 'revenue', direction: 'desc', expanded: '', filterMenu: '', categoryQuery: '', modelQuery: '' } },
  archiveUi: { selectedIds: [], expandedDate: '', type: 'all', storeName: '', renameId: '', renameValue: '' },
  upload: { mode: '', file: null, preview: null, type: '', storeName: '', periodKind: 'day', periodStart: '', periodEnd: '', sourceName: '', openMenu: '', dateSelecting: 'start', calendarMonth: '' },
  catalogUi: { file: null, page: 0, showCreate: false },
  teamDraft: { teamId: '', admin: { username: '', password: '' }, members: {} },
};

function escape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function fmtNumber(value, digits = 2) {
  const numeric = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(numeric) ? numeric.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '--';
}
function money(value) { return value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) ? `¥${fmtNumber(value)}` : '--'; }
function percent(value) { return value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) ? `${fmtNumber(Number(value) * 100, 1)}%` : '--'; }
function fmtDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '--'; }
function day(value) { return value ? String(value).slice(0, 10) : '--'; }
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
function setToast(message, error = false) {
  state.toast = { message, error };
  render();
  window.setTimeout(() => { if (state.toast?.message === message) { state.toast = null; render(); } }, 4800);
}
async function runActivity(label, task) {
  state.activity = { label, phase: 'running' }; render();
  try {
    const result = await task();
    state.activity = { label, phase: 'success' }; render();
    window.setTimeout(() => { if (state.activity?.label === label) { state.activity = null; render(); } }, 2200);
    return result;
  } catch (error) {
    state.activity = { label, phase: 'error', message: error.message }; render();
    window.setTimeout(() => { if (state.activity?.label === label) { state.activity = null; render(); } }, 6000);
    throw error;
  }
}
function activityText(activity) {
  if (activity.phase === 'error') return activity.message || activity.label;
  if (activity.phase === 'success' && activity.label.startsWith('正在')) return `已${activity.label.slice(2)}`;
  return activity.label;
}
function updateAuthDraft(form) {
  const values = new FormData(form);
  state.authDraft = {
    ...state.authDraft,
    username: String(values.get('username') || ''),
    email: String(values.get('email') || ''),
    password: String(values.get('password') || ''),
    inviteCode: String(values.get('inviteCode') || ''),
  };
}
async function api(path, init = {}) {
  const response = await fetch(path, { cache: 'no-store', ...init });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败：${response.status}`);
  return body;
}
function query(filters = state.filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}
function activeTeamId() {
  return state.session?.role === 'platform-admin' ? state.selectedTeamId : state.session?.teamId || '';
}
function captureTeamDraft() {
  if (state.page !== 'team' || !state.team?.team?.id) return;
  const teamId = state.team.team.id;
  const renderedTeamId = document.querySelector('.team-control-page')?.dataset.teamPage || '';
  if (renderedTeamId && renderedTeamId !== teamId) { state.teamDraft = { teamId, admin: { username: '', password: '' }, members: {} }; return; }
  if (state.teamDraft.teamId !== teamId) state.teamDraft = { teamId, admin: { username: '', password: '' }, members: {} };
  const admin = document.querySelector('#create-team-admin');
  if (admin) {
    state.teamDraft.admin = {
      username: String(admin.elements.username?.value || ''),
      password: String(admin.elements.password?.value || ''),
    };
  }
  document.querySelectorAll('[data-member-note]').forEach((input) => {
    const userId = input.dataset.memberNote;
    if (!userId) return;
    const row = input.closest('.member-editor');
    state.teamDraft.members[userId] = {
      note: input.value,
      role: row?.querySelector(`[data-member-role="${CSS.escape(userId)}"]`)?.value || 'member',
      teamIds: [...(row?.querySelectorAll(`[data-member-access="${CSS.escape(userId)}"]:checked`) || [])].map((item) => item.value),
    };
  });
}
function memberDraft(member, membership) {
  const draft = state.teamDraft.teamId === state.team?.team?.id ? state.teamDraft.members[member.id] : null;
  return {
    note: draft?.note ?? membership?.note ?? '',
    role: draft?.role ?? membership?.role ?? 'member',
    teamIds: draft?.teamIds ?? (member.memberships || []).filter((item) => item.status === 'active' && item.teamStatus === 'active').map((item) => item.teamId),
  };
}
function selectTeam(teamId) {
  state.selectedTeamId = teamId || '';
  if (state.selectedTeamId) window.sessionStorage.setItem(SELECTED_TEAM_KEY, state.selectedTeamId);
  else window.sessionStorage.removeItem(SELECTED_TEAM_KEY);
}
function brandLockup(subtitle, compact = false) {
  return `<div class="brand-lockup${compact ? ' compact' : ''}"><span class="brand-mark" aria-hidden="true"><img src="/brand-mark.svg?v=20260731-brand-1" alt="" /></span><div><strong>经营罗盘</strong><span>${escape(subtitle)}</span></div></div>`;
}
function teamMemberCount(team) {
  const count = Math.max(0, Number(team?.memberCount) || 0);
  const limit = Number(team?.memberLimit);
  return Number.isInteger(limit) && limit > 0 ? `${count}/${limit}` : `${count}`;
}
function openOperationsHome() {
  state.page = 'operations';
  state.activePanel = 'overview';
  state.warehousePanel = 'upload';
  state.modal = '';
}
async function loadCloudWorkspace() {
  const filters = { ...state.filters };
  if (activeTeamId()) filters.teamId = activeTeamId();
  state.workspace = await api(`/api/web/workspace?${query(filters)}`);
}
async function loadPublicSettings() { state.platformSettings = await api('/api/public/settings'); }
async function loadOverview() { state.overview = await api('/api/admin/overview'); }
async function loadTeam() {
  const teamId = activeTeamId();
  const activeMembership = state.session?.memberships?.find((membership) => membership.teamId === teamId);
  if (!teamId || (state.session?.role !== 'platform-admin' && activeMembership?.role !== 'team-admin')) { state.team = null; return; }
  state.team = await api(`/api/admin/teams/${encodeURIComponent(teamId)}`);
}

function localDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(LOCAL_DB, 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(LOCAL_STORE)) open.result.createObjectStore(LOCAL_STORE, { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains(LOCAL_META_STORE)) open.result.createObjectStore(LOCAL_META_STORE, { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error('无法打开浏览器本地数据仓。'));
  });
}
async function localReadAll() {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_STORE, 'readonly');
    const request = tx.objectStore(LOCAL_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
async function localPut(report) {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_STORE, 'readwrite');
    tx.objectStore(LOCAL_STORE).put(report);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function localDelete(id) {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_STORE, 'readwrite');
    tx.objectStore(LOCAL_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function localClear() {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_STORE, 'readwrite');
    tx.objectStore(LOCAL_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function localReadMeta() {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_META_STORE, 'readonly');
    const request = tx.objectStore(LOCAL_META_STORE).get('workspace');
    request.onsuccess = () => resolve(request.result || { id: 'workspace', productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [] });
    request.onerror = () => reject(request.error);
  });
}
async function localPutMeta(value) {
  const db = await localDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOCAL_META_STORE, 'readwrite');
    tx.objectStore(LOCAL_META_STORE).put({ id: 'workspace', productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [], ...value });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

const ALIASES = {
  storeName: ['店铺', '店铺名称', '所属店铺', 'storename', 'store', 'shop'], productId: ['商品id', '宝贝id', '主体id', 'itemid', 'productid', '商品编号'],
  productName: ['商品名称', '宝贝名称', '推广商品', '主体名称', '产品名称', 'productname', '商品', '宝贝', 'product'],
  campaignName: ['计划名称', '计划名字', '推广计划', 'campaignname', '计划', 'campaign'], channel: ['推广渠道', '原二级场景名字', '场景名字', '推广场景', '一级场景', '营销场景', '推广类型', '投放渠道', '渠道', '场景', 'channel'],
  category: ['二级类目名称', '类目名称', '一级类目名称', '类目', '商品类目', 'category'], primaryCategory: ['一级类目名称', '一级类目', 'primarycategory'], secondaryCategory: ['二级类目名称', '二级类目', 'secondarycategory'],
  model: ['型号', '商品型号', '产品型号', 'model'],
  spend: ['消耗', '花费', '推广花费', '广告消耗', 'cost', 'spend'], revenue: ['总成交金额', '支付金额', '支付成交金额', '成交金额', '成交额', '成交金额元', 'gmv', 'revenue'],
  refundAmount: ['售中售后成功退款金额', '成功退款金额', '退款金额', '退款总金额', '退款', 'refundamount', 'refund'], roi: ['roi', '投入产出比', '投产'],
  orders: ['总成交笔数', '支付订单数', '订单数', '成交订单数', '成交笔数', 'orders'], clicks: ['点击量', '点击次数', 'clicks'], impressions: ['展现量', '曝光量', 'impressions'],
};
function headerKey(value) { return String(value || '').trim().toLowerCase().replace(/[\s_()（）【】[\]·-]/g, ''); }
function numeric(value, percentMode = false) {
  if (typeof value === 'number' && Number.isFinite(value)) return percentMode && value > 1 ? value / 100 : value;
  const source = String(value ?? '').replace(/[￥¥,\s]/g, ''); const match = source.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null; const result = Number(match[0]); return Number.isFinite(result) ? (percentMode && (source.includes('%') || result > 1) ? result / 100 : result) : null;
}
function rowValue(row, aliases) {
  const entries = Object.entries(row || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined);
  for (const alias of aliases.map(headerKey)) { const exact = entries.find(([header]) => headerKey(header) === alias); if (exact) return exact[1]; }
  for (const alias of aliases.map(headerKey)) { const fuzzy = entries.find(([header]) => headerKey(header).includes(alias) || alias.includes(headerKey(header))); if (fuzzy) return fuzzy[1]; }
  return undefined;
}
function hasColumn(row, aliases) { return Object.keys(row || {}).some((key) => aliases.map(headerKey).some((alias) => headerKey(key) === alias || headerKey(key).includes(alias))); }
function normalRow(row, storeName) {
  const spend = numeric(rowValue(row, ALIASES.spend)); const grossRevenue = numeric(rowValue(row, ALIASES.revenue));
  const hasRefund = hasColumn(row, ALIASES.refundAmount); const refundAmount = hasRefund ? (numeric(rowValue(row, ALIASES.refundAmount)) ?? 0) : null;
  const revenue = Number.isFinite(grossRevenue) ? grossRevenue - (refundAmount || 0) : null;
  return {
    storeName: String(rowValue(row, ALIASES.storeName) || storeName || '').trim(), productId: String(rowValue(row, ALIASES.productId) || '').trim(), productName: String(rowValue(row, ALIASES.productName) || '').trim(),
    campaignName: String(rowValue(row, ALIASES.campaignName) || '').trim(), channel: String(rowValue(row, ALIASES.channel) || '').trim(), category: String(rowValue(row, ALIASES.category) || '').trim(),
    primaryCategory: String(rowValue(row, ALIASES.primaryCategory) || '').trim(), secondaryCategory: String(rowValue(row, ALIASES.secondaryCategory) || '').trim(),
    spend, grossRevenue, revenue, refundAmount, refundDataAvailable: hasRefund, roi: Number.isFinite(spend) && spend > 0 && Number.isFinite(grossRevenue) ? grossRevenue / spend : numeric(rowValue(row, ALIASES.roi)),
    orders: numeric(rowValue(row, ALIASES.orders)), clicks: numeric(rowValue(row, ALIASES.clicks)), impressions: numeric(rowValue(row, ALIASES.impressions)),
  };
}
function spreadsheetRows(buffer) {
  if (!window.XLSX) throw new Error('本地表格解析组件尚未加载，请刷新页面后重试。');
  const workbook = window.XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const score = (row) => Array.isArray(row) ? row.filter((cell) => Object.values(ALIASES).flat().map(headerKey).some((alias) => headerKey(cell) === alias || headerKey(cell).includes(alias))).length : 0;
  const headerIndex = grid.slice(0, 60).map((row, index) => ({ index, score: score(row), populated: row.filter(Boolean).length })).sort((left, right) => right.score - left.score || right.populated - left.populated)[0]?.index ?? 0;
  const seen = new Map(); const headers = (grid[headerIndex] || []).map((cell, index) => { const base = String(cell || `column_${index + 1}`).trim(); const count = (seen.get(base) || 0) + 1; seen.set(base, count); return count === 1 ? base : `${base}_${count}`; });
  return grid.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell || '').trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}
function localWorkspace(reports) {
  const core = buildOperationsWorkspace({
    reports,
    storeNames: [...new Set(reports.map((report) => report.storeName).filter(Boolean))],
    productCatalog: state.localMeta.productCatalog || [],
    productCatalogSource: state.localMeta.productCatalogSource || { fileName: '', updatedAt: null },
    salesDeductions: state.localMeta.salesDeductions || [],
  }, { filters: { ...state.filters, sourcePeriodKind: state.filters.sourcePeriodKind || 'auto' } });
  return {
    core,
    reports: core.reports,
    storeNames: core.storeNames,
    store: core.dashboard.store,
    products: core.dashboard.products,
    categories: core.dashboard.categories,
    storageCount: reports.length,
  };
}

function loginView() {
  const register = state.authMode === 'register';
  const draft = state.authDraft;
  const feedback = state.authFeedback ? `<div class="auth-feedback ${state.authFeedback.error ? 'error' : 'success'}" role="status" aria-live="polite">${escape(state.authFeedback.message)}</div>` : '';
  const submitting = state.authBusy === 'submit';
  app.innerHTML = `<main class="auth-page"><section class="auth-card">${brandLockup('团队经营决策平台')}<div class="auth-head"><h1>${register ? '使用团队邀请码注册' : '登录工作台'}</h1><p>${register ? '向团队管理员获取邀请码，注册后会直接进入对应团队。' : '使用 QQ 邮箱或原有账号进入运营数据与数据仓库。'}</p></div><div class="switcher"><button class="${register ? '' : 'active'}" data-auth="login">登录</button><button class="${register ? 'active' : ''}" data-auth="register">邀请码注册</button></div><form id="auth-form" class="stack">${register ? `<label class="field"><span>QQ 邮箱</span><input required type="email" name="email" autocomplete="email" inputmode="email" value="${escape(draft.email)}" placeholder="name@qq.com" /></label>` : `<label class="field"><span>QQ 邮箱或账号</span><input required name="username" autocomplete="username" value="${escape(draft.username)}" placeholder="输入 QQ 邮箱或已有账号" /></label>`}<label class="field"><span>密码</span><input required type="password" name="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="10" value="${escape(draft.password)}" placeholder="至少 10 位" /></label>${register ? `<label class="field"><span>团队邀请码</span><input required name="inviteCode" value="${escape(draft.inviteCode)}" placeholder="XXXX-XXXX-XXXX" /></label>` : ''}${feedback}<button class="btn primary" type="submit" ${submitting ? 'disabled' : ''}>${submitting ? (register ? '注册并加入中...' : '登录中...') : (register ? '注册并加入团队' : '登录')}</button></form></section></main>`;
  document.querySelectorAll('[data-auth]').forEach((button) => button.addEventListener('click', () => { state.authMode = button.dataset.auth; state.authFeedback = null; render(); }));
  document.querySelector('#auth-form')?.addEventListener('input', (event) => updateAuthDraft(event.currentTarget));
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); updateAuthDraft(event.currentTarget); const form = { ...state.authDraft };
    try {
      state.authBusy = 'submit'; state.authFeedback = null; render();
      if (register) { const result = await api('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.email, inviteCode: form.inviteCode, password: form.password }) }); state.session = result.user; } else { const result = await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.username, password: form.password }) }); state.session = result.user; }
      state.authBusy = ''; state.authFeedback = null; state.authDraft = { username: '', email: '', password: '', inviteCode: '' };
      openOperationsHome();
      await bootstrap();
    } catch (error) { state.authBusy = ''; if (state.session) setToast(error.message, true); else { state.authFeedback = { message: error.message, error: true }; render(); } }
  });
}

function topNav() {
  const memberships = state.session?.memberships || [];
  const currentMembership = memberships.find((membership) => membership.teamId === activeTeamId());
  const canManage = state.session?.role === 'platform-admin' ? Boolean(activeTeamId()) : currentMembership?.role === 'team-admin';
  const workspaceName = state.workspace?.team?.name || state.team?.team?.name || (state.session?.role === 'platform-admin' ? '平台管理' : '浏览器本地空间');
  const canLeaveTeam = state.session?.role !== 'platform-admin' && Boolean(state.session?.teamId);
  const switchOptions = state.session?.role === 'platform-admin'
    ? (state.overview?.teams || []).map((team) => ({ teamId: team.id, teamName: team.name, role: 'platform-admin', status: team.status }))
    : memberships.filter((membership) => membership.status === 'active' && membership.teamStatus === 'active');
  const switcher = switchOptions.length > 1 ? `<div class="team-switcher"><button id="team-switcher-button" class="team-switcher-button" aria-expanded="${state.teamMenuOpen}"><span>当前团队</span><strong>${escape(workspaceName)}</strong><i>⌄</i></button>${state.teamMenuOpen ? `<div class="team-switcher-menu" role="menu">${switchOptions.map((membership) => `<button role="menuitem" class="${membership.teamId === activeTeamId() ? 'active' : ''}" data-switch-team="${escape(membership.teamId)}"><span>${escape(membership.teamName)}</span><small>${membership.role === 'team-admin' ? '团队管理员' : membership.role === 'platform-admin' ? '平台管理' : '团队成员'}${membership.note ? ` · ${escape(membership.note)}` : ''}</small></button>`).join('')}</div>` : ''}</div>` : '';
  return `<header class="top-nav">${brandLockup(workspaceName, true)}<nav class="page-nav"><button class="${state.page === 'operations' ? 'active' : ''}" data-page="operations">运营数据</button>${canManage ? `<button class="${state.page === 'team' ? 'active' : ''}" data-page="team">团队管理</button>` : ''}${state.session?.role === 'platform-admin' ? `<button class="${state.page === 'platform' ? 'active' : ''}" data-page="platform">平台管理</button>` : ''}</nav><div class="user-menu">${switcher}<span>${escape(state.session?.username || '')}</span>${canLeaveTeam ? '<button class="btn text" id="leave-team">退出团队</button>' : ''}<button class="btn text" id="logout">退出</button></div></header>`;
}
function emptyTeamView() {
  if (state.session?.role === 'platform-admin') return `<section class="onboarding"><div class="eyebrow">平台团队</div><h1>选择一个团队开始</h1><p>平台管理员可创建多个独立团队；创建后会直接进入该团队的管理界面。</p><div class="onboarding-grid"><article class="onboarding-card"><h2>团队空间</h2><p>请在平台管理中创建团队，或从现有团队列表进入运营数据和团队管理。</p><button class="btn primary" data-page="platform">前往平台管理</button></article></div></section>`;
  const selfCreate = state.platformSettings.allowTeamCreation ? `<form id="create-team" class="onboarding-card"><h2>创建我的团队</h2><p>默认 2 GB 云空间，团队内成员看到同一套计算结果。</p><label class="field"><span>团队名称</span><input name="name" required placeholder="例如：苏泊尔运营组" /></label><label class="field"><span>授权方案</span><select name="plan"><option value="team">团队（默认 6 台设备）</option><option value="personal">个人（默认 2 台设备）</option></select></label><button class="btn primary" type="submit">创建团队</button></form>` : `<article class="onboarding-card onboarding-locked"><h2>暂不开放自助创建</h2><p>当前只允许通过团队邀请码加入。请联系团队管理员获取邀请码。</p></article>`;
  return `<section class="onboarding"><div class="eyebrow">团队空间</div><h1>先建立数据归属</h1><p>运营数据按团队隔离。创建团队后，你会自动成为团队管理员；成员可通过邀请码加入。</p><div class="onboarding-grid">${selfCreate}<form id="accept-invite" class="onboarding-card"><h2>加入已有团队</h2><p>让团队管理员生成成员邀请码。加入后可上传、查看团队数据。</p><label class="field"><span>团队邀请码</span><input name="code" required placeholder="XXXX-XXXX-XXXX" /></label><button class="btn secondary" type="submit">加入团队</button></form></div></section>`;
}
function metric(label, value, detail, tone = '') { return `<article class="metric-card ${tone}"><span>${escape(label)}</span><strong>${value}</strong><small>${escape(detail)}</small></article>`; }
function operationsModel() {
  if (state.mode === 'cloud') {
    const payload = state.workspace;
    if (!payload?.hasTeam) return null;
    return {
      core: payload.workspace,
      stores: payload.stores || [],
      warehouse: payload.warehouse || [],
      canManage: Boolean(payload.permissions?.canManageTeam),
      canUpload: Boolean(payload.permissions?.canUpload),
      mode: 'cloud',
    };
  }
  const local = localWorkspace(state.localReports);
  return {
    core: local.core,
    stores: local.storeNames.map((name) => ({ id: name, name })),
    warehouse: local.reports.map((report) => ({ ...report, rowCount: report.rows?.length || 0, status: 'active', canDelete: true, canRestore: false })),
    canManage: true,
    canUpload: true,
    mode: 'local',
  };
}
function hasNumber(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function calculatedPromotion(row) { return row?.promotionCoverageComplete === true ? row : { ...row, feeRate: null, roi: null }; }
function utcDate(value = new Date()) { const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000); return shifted.toISOString().slice(0, 10); }
function addDays(value, days) { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return utcDate(date); }
function monthRange(offset = 0) { const now = new Date(); const date = new Date(now.getFullYear(), now.getMonth() + offset, 1); const start = utcDate(date); const end = utcDate(new Date(date.getFullYear(), date.getMonth() + 1, 0)); return { start, end }; }
function dateRangeForPreset(preset) {
  const today = utcDate(); const weekday = (new Date(`${today}T12:00:00`).getDay() + 6) % 7;
  if (preset === 'today') return { start: today, end: today };
  if (preset === 'yesterday') { const yesterday = addDays(today, -1); return { start: yesterday, end: yesterday }; }
  if (preset === 'this-week') return { start: addDays(today, -weekday), end: today };
  if (preset === 'last-week') { const end = addDays(today, -weekday - 1); return { start: addDays(end, -6), end }; }
  if (preset === 'this-month') return monthRange();
  if (preset === 'last-month') return monthRange(-1);
  return { start: state.filters.start, end: state.filters.end };
}
function applyScope(next = {}) {
  state.filters = { ...state.filters, ...next };
  return state.mode === 'cloud' ? loadCloudWorkspace() : Promise.resolve();
}
function uniqueSorted(values) { return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')); }
function selected(array, value) { return Array.isArray(array) && array.includes(value); }
function entityUi(kind) { return state.entityUi[kind]; }
function parseEntityTarget(value) {
  const source = String(value || ''); const separator = source.indexOf(':');
  return separator < 0 ? { kind: '', key: '' } : { kind: source.slice(0, separator), key: source.slice(separator + 1) };
}
function entityFilterConfig(field) {
  return field === 'model'
    ? { selection: 'models', query: 'modelQuery', label: '型号' }
    : { selection: 'categories', query: 'categoryQuery', label: '品类' };
}
function entityFilterOptions(kind, field, rows) {
  if (field === 'model') return kind === 'product' ? uniqueSorted(rows.map((row) => row.model || '型号待补')) : [];
  return uniqueSorted(rows.map((row) => row.category || (kind === 'category' ? row.name : '品类待补')));
}
function entityFilterMenu(kind, field, options) {
  const ui = entityUi(kind); const config = entityFilterConfig(field); const query = ui[config.query] || '';
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN'); const visible = normalizedQuery ? options.filter((name) => name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : options;
  const chosen = ui[config.selection] || []; const isOpen = ui.filterMenu === field;
  const label = chosen.length ? `已选 ${chosen.length} 个${config.label}` : `选择${config.label}`;
  return `<div class="entity-filter"><button class="entity-filter-trigger ${isOpen ? 'active' : ''}" data-entity-filter-toggle="${kind}:${field}" aria-expanded="${isOpen}">${label}<i>${isOpen ? '▴' : '▾'}</i></button>${isOpen ? `<section class="entity-filter-panel" data-entity-filter-panel="${kind}:${field}"><label class="entity-filter-search"><span>搜索</span><input data-entity-filter-query="${kind}:${field}" value="${escape(query)}" placeholder="搜索${config.label}" autocomplete="off" /></label><div class="entity-filter-actions"><button data-entity-filter-select-all="${kind}:${field}">全选</button><button data-entity-filter-clear="${kind}:${field}">清空</button><small>${visible.length} / ${options.length}</small></div><div class="entity-filter-options">${visible.length ? visible.map((name) => `<label><input type="checkbox" data-entity-filter-option="${kind}:${field}" value="${escape(name)}" ${selected(chosen, name) ? 'checked' : ''}/><span>${escape(name)}</span></label>`).join('') : '<p class="empty">没有匹配的选项</p>'}</div></section>` : ''}</div>`;
}
function renderWithEntityFilterFocus(kind, field, caret = 0) {
  render();
  window.requestAnimationFrame(() => {
    const input = document.querySelector(`[data-entity-filter-query="${CSS.escape(`${kind}:${field}`)}"]`);
    if (!input) return;
    input.focus(); input.setSelectionRange(caret, caret);
  });
}
function entityRows(kind, items) {
  const ui = entityUi(kind);
  const keyword = ui.keyword.trim().toLocaleLowerCase('zh-CN');
  const categories = new Set(ui.categories); const models = new Set(ui.models);
  const rows = (items || []).filter((row) => {
    if (!hasNumber(row.revenue) && !hasNumber(row.spend) && !hasNumber(row.grossRevenue)) return false;
    const search = `${row.name || ''} ${row.productId || ''} ${row.model || ''} ${row.category || ''}`.toLocaleLowerCase('zh-CN');
    const category = row.category || (kind === 'category' ? row.name : '品类待补');
    return (!keyword || search.includes(keyword)) && (!categories.size || categories.has(category)) && (!models.size || models.has(row.model || '型号待补'));
  });
  const key = ui.sort; const direction = ui.direction === 'asc' ? 1 : -1;
  return rows.sort((left, right) => {
    const a = left[key] ?? ''; const b = right[key] ?? '';
    if (hasNumber(a) && hasNumber(b)) return (Number(a) - Number(b)) * direction;
    return String(a).localeCompare(String(b), 'zh-CN') * direction;
  });
}
function sumRows(rows) {
  const total = (key) => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const revenue = total('revenue'); const spend = total('spend');
  const refundDataAvailable = rows.length > 0 && rows.every((row) => row.refundDataAvailable !== false);
  const complete = rows.length > 0 && rows.every((row) => row.promotionCoverageComplete === true);
  return { grossRevenue: total('grossRevenue'), refundAmount: total('refundAmount'), revenue, spend, promotionRevenue: total('promotionRevenue'), refundDataAvailable, complete, roi: complete && spend > 0 ? total('promotionRevenue') / spend : null, feeRate: complete && refundDataAvailable && revenue > 0 ? spend / revenue : null };
}
function promotionTone(name = '') { if (/全站/.test(name)) return 'blue'; if (/关键词/.test(name)) return 'purple'; const tones = ['teal', 'amber', 'rose', 'sky']; let hash = 0; for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return tones[hash % tones.length]; }
function promotionDetails(row, columns = 11) {
  const channels = row?.promotionChannels || [];
  if (!channels.length) return '';
  // Plan rates are calculated in the shared core from the linked product
  // links' net GSV. Never derive them from the parent category or ad revenue.
  const planMetrics = (plan) => {
    return `<dl class="promotion-plan-metrics"><div><dt>花费</dt><dd>${money(plan.spend)}</dd></div><div><dt>计划成交</dt><dd>${money(plan.promotionRevenue)}</dd></div><div><dt>投产</dt><dd>${fmtNumber(plan.roi)}</dd></div><div class="plan-fee-rate"><dt>计划费率</dt><dd>${percent(plan.feeRate)}</dd></div></dl>`;
  };
  return `<tr class="promotion-detail"><td colspan="${columns}"><div class="promotion-grid">${channels.map((channel) => {
    const plans = channel.plans?.length ? channel.plans : [{ name: '未分组计划', spend: channel.spend, promotionRevenue: channel.promotionRevenue, roi: channel.roi }];
    return `<section class="promotion-channel ${promotionTone(channel.name)}"><header class="promotion-channel-head"><div><strong>${escape(channel.name || '未识别推广类型')}</strong><span>${plans.length} 个计划</span></div><div class="promotion-channel-summary"><span>关联净 GSV <b>${money(channel.linkedRevenue)}</b></span><span class="channel-fee-rate">${escape(channel.name || '推广')}整体费率 <b>${percent(channel.feeRate)}</b></span><span>花费 <b>${money(channel.spend)}</b></span></div></header><div class="promotion-plan-list">${plans.map((plan) => `<article class="promotion-plan"><strong class="promotion-plan-name" title="${escape(plan.name || '未命名计划')}">${escape(plan.name || '未命名计划')}</strong>${planMetrics(plan)}</article>`).join('')}</div></section>`;
  }).join('')}</div></td></tr>`;
}
function reportGroupKey(report) { return `${report.periodKind || 'day'}|${report.periodStart || report.reportDate || ''}|${report.periodEnd || report.reportDate || ''}`; }
function groupedWarehouseReports(reports) {
  const groups = new Map();
  for (const report of reports) { const key = reportGroupKey(report); if (!groups.has(key)) groups.set(key, { key, periodKind: report.periodKind || 'day', start: report.periodStart || report.reportDate || '', end: report.periodEnd || report.reportDate || '', reports: [] }); groups.get(key).reports.push(report); }
  return [...groups.values()].sort((a, b) => `${b.end}|${b.start}`.localeCompare(`${a.end}|${a.start}`));
}
function dataSourceSwitch() {
  return `<div class="data-source-switch"><span>数据来源</span><div class="mode-tabs"><button class="${state.mode === 'cloud' ? 'active' : ''}" data-mode="cloud">团队云数据</button><button class="${state.mode === 'local' ? 'active' : ''}" data-mode="local">本地浏览器数据</button></div></div>`;
}
function reportFilterControls() {
  const model = operationsModel(); const stores = model?.stores || [];
  const periodOptions = `<option value="auto" ${state.filters.sourcePeriodKind === 'auto' ? 'selected' : ''}>自动匹配</option><option value="day" ${state.filters.sourcePeriodKind === 'day' ? 'selected' : ''}>日报</option><option value="week" ${state.filters.sourcePeriodKind === 'week' ? 'selected' : ''}>周报</option><option value="month" ${state.filters.sourcePeriodKind === 'month' ? 'selected' : ''}>月报</option><option value="custom" ${state.filters.sourcePeriodKind === 'custom' ? 'selected' : ''}>自定义周期</option><option value="all" ${state.filters.sourcePeriodKind === 'all' ? 'selected' : ''}>全部口径</option>`;
  return `<div class="operations-nav-filters"><label><span>店铺</span><select id="filter-store"><option value="">全部店铺</option>${stores.map((store) => `<option value="${escape(store.name)}" ${state.filters.storeName === store.name ? 'selected' : ''}>${escape(store.name)}</option>`).join('')}</select></label><label class="toolbar-scope"><span>报表口径</span><select id="filter-period-kind">${periodOptions}</select></label><button class="btn secondary small" id="apply-filters">应用</button></div>`;
}
function operationsNav() {
  return `<div class="operations-nav-row">${operationTabs()}<div class="operations-nav-actions">${reportFilterControls()}${dataSourceSwitch()}</div></div>`;
}
function modeToolbar() {
  const model = operationsModel();
  const presets = [['today', '今天'], ['yesterday', '昨天'], ['this-week', '本周'], ['last-week', '上周'], ['this-month', '本月'], ['last-month', '上月']];
  return `<section class="operations-toolbar"><div class="toolbar-row controls ${state.customScopeOpen ? 'with-custom-scope' : ''}"><div class="date-presets">${presets.map(([id, label]) => `<button class="${state.datePreset === id ? 'active' : ''}" data-date-preset="${id}">${label}</button>`).join('')}<button class="${state.datePreset === 'custom' ? 'active' : ''}" data-date-preset="custom">自定义</button></div>${state.customScopeOpen ? `<div class="scope-controls"><label><span>开始</span><input id="filter-start" type="date" value="${escape(state.filters.start)}" /></label><label><span>结束</span><input id="filter-end" type="date" value="${escape(state.filters.end)}" /></label><button class="btn primary small" id="apply-custom-scope">确定</button></div>` : ''}<span class="scope-hint">${model?.core?.reports?.length || 0} 份报表已参与当前计算</span></div></section>`;
}
function operationTabs() { return `<nav class="data-tabs"><button class="${state.activePanel === 'overview' ? 'active' : ''}" data-panel="overview"><small>01</small>整店总览</button><button class="${state.activePanel === 'category' ? 'active' : ''}" data-panel="category"><small>02</small>品类 360</button><button class="${state.activePanel === 'product' ? 'active' : ''}" data-panel="product"><small>03</small>商品排行</button><button class="${state.activePanel === 'warehouse' ? 'active' : ''}" data-panel="warehouse"><small>04</small>数据仓库</button></nav>`; }
function trendView(trend = []) {
  const definitions = { revenue: { label: '净 GSV', color: '#0d9488', value: (row) => row.revenue, format: money }, spend: { label: '推广花费', color: '#2563eb', value: (row) => row.spend, format: money }, roi: { label: '经营 ROI', color: '#d97706', value: (row) => row.roi, format: (value) => fmtNumber(value) }, feeRate: { label: '推广费率', color: '#c026d3', value: (row) => row.feeRate, format: percent } };
  const points = trend.slice(-31); const selectedMetrics = state.trendMetrics.length ? state.trendMetrics : ['revenue'];
  const width = 760; const height = 230; const padding = { left: 34, right: 20, top: 18, bottom: 32 };
  const chartWidth = width - padding.left - padding.right; const chartHeight = height - padding.top - padding.bottom;
  const series = selectedMetrics.map((metricName) => {
    const definition = definitions[metricName]; const values = points.map((item) => Number(definition.value(item))).filter(Number.isFinite); const max = Math.max(...values, 1);
    const pointAt = (item, index) => { const value = Number(definition.value(item)); if (!Number.isFinite(value)) return null; const x = padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth); const y = padding.top + chartHeight - Math.max(0, value / max) * chartHeight; return { value, x, y }; };
    const path = points.map((item, index) => { const point = pointAt(item, index); if (!point) return ''; const previous = index ? pointAt(points[index - 1], index - 1) : null; return `${previous ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`; }).join(' ');
    const labelStep = Math.max(1, Math.ceil(points.length / 8));
    const markers = points.map((item, index) => { const point = pointAt(item, index); if (!point) return ''; const label = points.length <= 12 || index === 0 || index === points.length - 1 || index % labelStep === 0; return `<circle class="trend-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" fill="${definition.color}"><title>${escape(definition.label)}：${escape(definition.format(point.value))}</title></circle>${label ? `<text class="trend-point-label" x="${point.x.toFixed(1)}" y="${Math.max(12, point.y - 9).toFixed(1)}" text-anchor="middle" fill="${definition.color}">${escape(definition.format(point.value))}</text>` : ''}`; }).join('');
    return `<g class="trend-series"><path d="${path}" fill="none" stroke="${definition.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${markers}</g>`;
  }).join('');
  return `<article class="card trend-card"><header class="section-head"><div><h3>经营趋势</h3><p>点击上方指标切换或叠加趋势。净 GSV = 支付金额 - 成功退款金额。</p></div><div class="trend-legend">${Object.entries(definitions).map(([id, item]) => `<button class="${selectedMetrics.includes(id) ? 'active' : ''}" data-trend-toggle="${id}" style="--metric-color:${item.color}"><i></i>${item.label}</button>`).join('')}</div></header>${points.length ? `<div class="trend-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="经营趋势图"><line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#dbe6ef" />${[.25, .5, .75].map((ratio) => `<line x1="${padding.left}" y1="${padding.top + chartHeight * ratio}" x2="${width - padding.right}" y2="${padding.top + chartHeight * ratio}" stroke="#eef3f7" />`).join('')}${series}${points.map((point, index) => `<text x="${padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth)}" y="${height - 10}" text-anchor="middle" fill="#789" font-size="10">${escape(day(point.date).slice(5))}</text>`).join('')}</svg></div><div class="trend-data-strip">${points.map((point) => `<div><span>${escape(day(point.date))}</span>${selectedMetrics.map((id) => `<b style="color:${definitions[id].color}">${definitions[id].label} ${definitions[id].format(definitions[id].value(point))}</b>`).join('')}</div>`).join('')}</div>` : '<div class="empty-cell">当前筛选范围没有可绘制的日度数据。</div>'}</article>`;
}
function overviewPanel(workspace) {
  const core = workspace.core || workspace.workspace || workspace; const dashboard = core.dashboard; const store = dashboard.store; const verified = calculatedPromotion(store); const canManage = Boolean(workspace.canManage);
  return `<section class="workspace-content"><div class="metrics-grid dashboard-metrics">${metric('整店净 GSV', money(store.revenue), store.refundDataAvailable ? `支付 ${money(store.grossRevenue)} · 退款 ${money(store.refundAmount)}${store.salesDeduction ? ` · 扣除 ${money(store.salesDeduction)}` : ''}` : '当前销售报表缺退款字段', 'mint')}${metric('推广花费', money(store.spend), dashboard.sourceCoverage?.storePromotionComplete ? '单品付费周期已完整对齐' : '仅展示已导入消耗，不计算完整费率', 'blue')}${metric('整店经营 ROI', fmtNumber(verified.roi), dashboard.sourceCoverage?.storePromotionComplete ? '推广成交 ÷ 推广花费' : '需同周期单品付费报表', 'orange')}${metric('推广费率', percent(verified.feeRate), dashboard.sourceCoverage?.storePromotionComplete ? '推广花费 ÷ 净 GSV' : '需同周期单品付费报表', 'purple')}</div>${dashboard.sourceWarnings?.storePromotion ? `<div class="data-warning">${escape(dashboard.sourceWarnings.storePromotion)}</div>` : ''}${trendView(dashboard.trend)}<div class="split-grid"><article class="card"><header class="section-head"><div><h3>店铺经营</h3><p>销售和推广只在同名店铺内关联；表内口径与上方一致。</p></div>${canManage ? `<button class="btn secondary small" data-open-deductions>销售扣除</button>` : ''}</header>${storeTable(dashboard.stores)}</article><article class="card"><header class="section-head"><div><h3>数据口径</h3><p>本页严格使用共享 GSV、推广费率和 ROI 公式。</p></div></header><div class="source-list"><div><span>销售来源</span><strong>${escape(dashboard.sources?.storeSales?.type ? TYPE_LABELS[dashboard.sources.storeSales.type] : '未导入')}</strong></div><div><span>推广来源</span><strong>${escape(dashboard.sources?.storePromotion?.type ? TYPE_LABELS[dashboard.sources.storePromotion.type] : '未导入')}</strong></div><div><span>当前统计日期</span><strong>${escape(core.currentDate || '--')}</strong></div><div><span>商品资料库</span><strong>${core.productCatalog?.length || 0} 条版本记录</strong></div></div></article></div></section>`;
}
function storeTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>店铺</th><th>支付 / 退款</th><th>净 GSV</th><th>推广花费</th><th>ROI</th><th>费率</th></tr></thead><tbody>${rows?.length ? rows.map((row) => { const verified = calculatedPromotion(row); return `<tr><td><strong>${escape(row.name || '--')}</strong></td><td>${money(row.grossRevenue)}<small class="negative">-${money(row.refundAmount)}</small></td><td><strong>${money(row.revenue)}</strong></td><td>${money(row.spend)}</td><td>${fmtNumber(verified.roi)}</td><td>${percent(verified.feeRate)}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty-cell">导入商品排行和单品付费报表后显示店铺经营。</td></tr>'}</tbody></table></div>`;
}
function entityTable(rows, kind = 'product') {
  if (kind === 'store') return storeTable(rows);
  const ui = entityUi(kind); const allRows = (rows || []).filter((row) => hasNumber(row.revenue) || hasNumber(row.spend) || hasNumber(row.grossRevenue)); const visible = entityRows(kind, allRows); const summary = sumRows(visible);
  const categories = entityFilterOptions(kind, 'category', allRows); const models = entityFilterOptions(kind, 'model', allRows);
  const columns = kind === 'product' ? 11 : 9;
  const sortHeader = (label, key) => `<button class="sort-header ${ui.sort === key ? 'active' : ''}" data-entity-sort="${kind}:${key}">${label}<i>${ui.sort === key ? (ui.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>`;
  return `<article class="entity-matrix"><header class="matrix-head"><div><h3>${kind === 'product' ? '商品排行经营矩阵' : '品类 360 经营矩阵'}</h3><p>${kind === 'product' ? '商品 ID、型号、品类、销售与每种推广计划在同一行核对。' : '品类花费按商品资料库映射的单品付费汇总，和整店推广花费可核对。'}</p></div><div class="matrix-tools"><label class="search-field"><span>搜索</span><input data-entity-keyword="${kind}" value="${escape(ui.keyword)}" placeholder="名称、ID、型号" /></label>${entityFilterMenu(kind, 'category', categories)}${kind === 'product' ? entityFilterMenu(kind, 'model', models) : ''}<button class="btn text small" data-entity-clear="${kind}">清除筛选</button></div></header><div class="selection-summary"><div><span>当前范围</span><strong>${visible.length} / ${allRows.length} 项</strong></div><div><span>支付 / 退款</span><strong>${money(summary.grossRevenue)}</strong><small>-${money(summary.refundAmount)}</small></div><div><span>净 GSV</span><strong>${money(summary.revenue)}</strong></div><div><span>推广花费</span><strong>${money(summary.spend)}</strong></div><div><span>推广成交</span><strong>${money(summary.promotionRevenue)}</strong></div><div><span>ROI</span><strong>${fmtNumber(summary.roi)}</strong></div><div><span>费率</span><strong>${percent(summary.feeRate)}</strong></div></div><div class="table-wrap entity-table"><table><thead><tr><th>${sortHeader(kind === 'product' ? '商品' : '品类', 'name')}</th>${kind === 'product' ? `<th>${sortHeader('商品 ID', 'productId')}</th><th>${sortHeader('型号 / 品类', 'model')}</th>` : ''}<th>${sortHeader('支付 / 退款', 'grossRevenue')}</th><th>${sortHeader('净 GSV', 'revenue')}</th><th>${sortHeader('推广花费', 'spend')}</th><th>${sortHeader('推广成交', 'promotionRevenue')}</th><th>${sortHeader('ROI', 'roi')}</th><th>${sortHeader('费率', 'feeRate')}</th><th>${sortHeader('推广类型 / 计划', 'promotionCount')}</th><th>关联</th></tr></thead><tbody>${visible.length ? visible.map((row) => { const verified = calculatedPromotion(row); const channels = row.promotionChannels || []; const planCount = channels.reduce((sum, channel) => sum + (channel.planCount || channel.plans?.length || 0), 0); const expanded = ui.expanded === row.key; return `<tr><td><strong title="${escape(row.name || '')}">${escape(row.name || '--')}</strong></td>${kind === 'product' ? `<td class="mono">${escape(row.productId || '--')}</td><td><strong>${escape(row.model || '型号待补')}</strong><small>${escape(row.category || '品类待补')}</small></td>` : ''}<td>${money(row.grossRevenue)}<small class="negative">-${money(row.refundAmount)}</small></td><td><strong>${money(row.revenue)}</strong></td><td>${money(row.spend)}</td><td>${money(row.promotionRevenue)}</td><td>${fmtNumber(verified.roi)}</td><td>${percent(verified.feeRate)}</td><td>${channels.length ? `<button class="promotion-toggle" data-entity-expand="${kind}:${escape(row.key)}">${expanded ? '收起' : '展开'} ${channels.length} 类 / ${planCount} 个计划</button>` : '<small>暂无付费数据</small>'}</td><td><span class="match ${escape(row.matchStatus || 'unmatched')}">${row.matchStatus === 'id' ? 'ID 已关联' : row.matchStatus === 'name' ? '名称关联' : row.matchStatus === 'sales-only' ? '待补推广' : row.matchStatus === 'promotion-only' ? '待补经营' : '未关联'}</span></td></tr>${expanded ? promotionDetails(row, columns) : ''}`; }).join('') : `<tr><td colspan="${columns}" class="empty-cell">${allRows.length ? '没有符合当前筛选条件的数据。' : '导入对应报表后展示关联矩阵。'}</td></tr>`}</tbody></table></div></article>`;
}
function warehousePanel(workspace) {
  const model = workspace.core ? workspace : operationsModel(); const core = model.core; const canManage = model.canManage; const panel = state.warehousePanel;
  const tabs = [['upload', '报表管理', '上传、核对与归档'], ['catalog', '商品资料', '店铺 + 商品 ID 映射'], ['deductions', '销售扣除', '大单剔除与重算']];
  const reports = model.warehouse || []; const filteredReports = reports.filter((report) => (state.archiveUi.type === 'all' || report.type === state.archiveUi.type) && (!state.archiveUi.storeName || report.storeName === state.archiveUi.storeName));
  const groups = groupedWarehouseReports(filteredReports); const selectedIds = new Set(state.archiveUi.selectedIds); const activeCatalog = latestCatalog(core.productCatalog || []);
  const body = panel === 'upload' || panel === 'archive' ? `${uploadWarehouseCard(model)}${archiveWarehouseCard(model, groups, selectedIds, false)}` : panel === 'catalog' ? catalogWarehouseCard(model, activeCatalog) : deductionsWarehouseCard(model);
  return `<section class="workspace-content"><nav class="warehouse-nav">${tabs.map(([id, label, hint]) => `<button class="${panel === id ? 'active' : ''}" data-warehouse-panel="${id}"><strong>${label}</strong><small>${hint}</small></button>`).join('')}</nav>${body}</section>`;
}
function catalogKey(entry) { return `${String(entry?.storeName || '').trim().toLocaleLowerCase('zh-CN')}\u0000${String(entry?.productId || '').trim()}`; }
function latestCatalog(entries) { const latest = new Map(); for (const entry of entries || []) latest.set(catalogKey(entry), entry); return [...latest.values()].sort((a, b) => `${a.storeName}|${a.category}|${a.productId}`.localeCompare(`${b.storeName}|${b.category}|${b.productId}`, 'zh-CN')); }
function uploadWarehouseCard(model) {
  const stores = model.stores || []; return `<article class="card warehouse-callout"><header class="section-head"><div><h3>${model.mode === 'cloud' ? '上传团队云报表' : '导入浏览器本地报表'}</h3><p>先预检报表类型和统计日期。下载日期不会被当作经营统计日期。</p></div><button class="btn primary" data-open-upload="${model.mode}">选择报表</button></header><div class="warehouse-guide"><div><b>商品排行</b><span>生意参谋 > 商品 > 商品排行</span></div><div><b>品类 360</b><span>生意参谋 > 品类 > 标准类目</span></div><div><b>单品付费</b><span>万相台/直通车商品推广报表</span></div></div>${model.mode === 'cloud' && !stores.length ? `<div class="data-warning">请先在团队管理中新增店铺，再上传团队报表。</div>` : ''}</article>`;
}
function archiveWarehouseCard(model, groups, selectedIds, showImportButton = true) {
  const stores = model.stores || []; const selected = [...selectedIds]; const all = groups.flatMap((group) => group.reports).filter((report) => report.status === 'active');
  return `<article class="card warehouse-card"><header class="section-head"><div><h3>${model.mode === 'cloud' ? '团队数据归档' : '本地数据归档'}</h3><p>按报表真实统计周期折叠。可整组选择，也可展开后单独选择一份。</p></div>${showImportButton ? `<button class="btn primary small" data-open-upload="${model.mode}">导入报表</button>` : ''}</header><div class="archive-controls"><label>数据表<select id="archive-type"><option value="all">全部数据表</option><option value="category" ${state.archiveUi.type === 'category' ? 'selected' : ''}>品类 360</option><option value="product" ${state.archiveUi.type === 'product' ? 'selected' : ''}>商品排行</option><option value="campaign" ${state.archiveUi.type === 'campaign' ? 'selected' : ''}>单品付费</option></select></label><label>店铺<select id="archive-store"><option value="">全部店铺</option>${stores.map((store) => `<option value="${escape(store.name)}" ${state.archiveUi.storeName === store.name ? 'selected' : ''}>${escape(store.name)}</option>`).join('')}</select></label><span>${selected.length ? `已选 ${selected.length} 份` : `${all.length} 份当前报表`}</span>${selected.length ? `<button class="btn text tiny" data-clear-archive-selection>取消选择</button><button class="btn danger tiny" data-delete-selected-reports>删除已选</button>${model.mode === 'cloud' && model.canManage ? `<select id="bulk-store-id"><option value="">批量改归属店铺</option>${stores.map((store) => `<option value="${escape(store.id)}">${escape(store.name)}</option>`).join('')}</select><button class="btn secondary tiny" id="bulk-assign-store">确认归属</button>` : ''}` : ''}</div><div class="archive-groups">${groups.length ? groups.map((group) => { const expanded = state.archiveUi.expandedDate === group.key; const groupCurrent = group.reports.filter((report) => report.status === 'active'); const checked = groupCurrent.length > 0 && groupCurrent.every((report) => selectedIds.has(report.id)); return `<section class="archive-group"><header><label><input type="checkbox" data-select-report-group="${escape(group.key)}" ${checked ? 'checked' : ''} ${groupCurrent.length ? '' : 'disabled'} /></label><button data-toggle-report-group="${escape(group.key)}"><b>${PERIOD_LABELS[group.periodKind] || group.periodKind} · ${escape(group.start)}${group.end && group.end !== group.start ? ` 至 ${escape(group.end)}` : ''}</b><span>${group.reports.length} 份 · ${group.reports.reduce((sum, report) => sum + (Number(report.rowCount) || report.rows?.length || 0), 0)} 行 ${expanded ? '收起' : '展开'}</span></button></header>${expanded ? `<div class="archive-report-list">${group.reports.map((report) => archiveReportRow(model, report, selectedIds)).join('')}</div>` : ''}</section>`; }).join('') : '<div class="empty-cell">暂无符合条件的报表。</div>'}</div></article>`;
}
function archiveReportRow(model, report, selectedIds) { const editing = state.archiveUi.renameId === report.id; const canDelete = Boolean(report.canDelete); return `<div class="archive-report ${report.status || 'active'}"><input type="checkbox" data-select-report="${escape(report.id)}" ${selectedIds.has(report.id) ? 'checked' : ''} ${report.status === 'active' ? '' : 'disabled'} /> <div class="archive-file">${editing ? `<input data-rename-report-input="${escape(report.id)}" value="${escape(state.archiveUi.renameValue)}" /><button class="btn primary tiny" data-save-report-name="${escape(report.id)}">保存</button><button class="btn text tiny" data-cancel-report-name>取消</button>` : `<button class="archive-name" data-start-report-name="${escape(report.id)}" ${canDelete ? '' : 'disabled'}>${escape(report.fileName || '--')}</button>`}<small>${TYPE_LABELS[report.type] || report.type} · ${escape(report.storeName || '未归属店铺')} · ${report.rowCount || report.rows?.length || 0} 行${report.createdByUsername ? ` · ${escape(report.createdByUsername)}` : ''}</small></div><span class="status ${report.status || 'active'}">${report.status === 'superseded' ? '已替换' : '当前'}</span>${canDelete ? `<button class="btn danger tiny" data-delete-report="${escape(report.id)}">永久删除</button>` : ''}</div>`; }
function catalogWarehouseCard(model, entries) {
  const canManage = model.canManage; const pageSize = 50; const page = Math.max(0, Math.min(state.catalogUi.page, Math.ceil(entries.length / pageSize) - 1)); const visible = entries.slice(page * pageSize, page * pageSize + pageSize);
  const exportCurrent = model.mode === 'cloud' ? `<a class="btn secondary small" href="/api/teams/${encodeURIComponent(state.workspace.team.id)}/product-catalog/export">导出当前表</a>` : `<button class="btn secondary small" data-export-local-catalog>导出当前表</button>`;
  const clearCatalog = canManage ? `<button class="btn danger small" data-clear-catalog ${entries.length ? '' : 'disabled'}>清空资料</button>` : '';
  const headerActions = canManage ? `<div class="catalog-head-actions"><button class="btn primary small" data-toggle-catalog-create>${state.catalogUi.showCreate ? '收起新增' : '新增商品'}</button><a class="btn secondary small" href="/api/templates/product-catalog.xlsx">下载导入模板</a>${exportCurrent}${clearCatalog}</div>` : exportCurrent;
  const createPanel = canManage && state.catalogUi.showCreate ? `<form id="catalog-manual" class="catalog-create-panel"><header><div><span>新增商品资料</span><strong>店铺 + 商品 ID 不可重复</strong></div><button type="button" class="btn text tiny" data-cancel-catalog-create>取消</button></header><div class="catalog-create-grid"><label><span><i>1</i>店铺</span><input name="storeName" list="catalog-stores" required placeholder="选择或输入店铺" autocomplete="off" /></label><datalist id="catalog-stores">${model.stores.map((store) => `<option value="${escape(store.name)}"></option>`).join('')}</datalist><label><span><i>2</i>商品 ID</span><input name="productId" required placeholder="输入商品 ID" inputmode="numeric" autocomplete="off" /></label><label><span><i>3</i>品类</span><input name="category" required placeholder="输入品类" autocomplete="off" /></label><label><span><i>4</i>型号</span><input name="model" required placeholder="输入型号" autocomplete="off" /></label></div><footer><button type="reset" class="btn secondary small">清空</button><button class="btn primary small">保存商品</button></footer></form>` : '';
  return `<article class="card catalog-card"><header class="section-head"><div><h3>商品 ID、型号与品类资料库</h3><p>按店铺 + 商品 ID 唯一维护，商品排行和品类 360 使用当前资料。</p></div>${headerActions}</header>${createPanel}${canManage ? `<div class="catalog-actions"><label class="file-button">选择 ID 型号表<input id="catalog-file" type="file" accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt" /></label><button class="btn primary small" id="catalog-import" ${state.catalogUi.file ? '' : 'disabled'}>更新资料库</button><span>${state.catalogUi.file ? escape(state.catalogUi.file.name) : '表头：店铺名、商品ID、品类名、型号'}</span></div>` : '<div class="data-warning">商品资料由团队管理员维护；当前资料已参与商品和品类计算。</div>'}<div class="table-wrap"><table><thead><tr><th>店铺</th><th>商品 ID</th><th>品类</th><th>型号</th><th>来源</th><th>更新时间</th></tr></thead><tbody>${visible.length ? visible.map((entry) => `<tr><td>${escape(entry.storeName)}</td><td class="mono">${escape(entry.productId)}</td><td>${escape(entry.category || '--')}</td><td>${escape(entry.model || '--')}</td><td>${escape(entry.sourceName || '--')}</td><td>${escape(fmtDate(entry.createdAt))}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">还没有商品资料。可以新增商品或导入 ID 型号表。</td></tr>'}</tbody></table></div>${entries.length > pageSize ? `<footer class="pager"><button class="btn secondary tiny" data-catalog-page="prev" ${page ? '' : 'disabled'}>上一页</button><span>${page + 1} / ${Math.ceil(entries.length / pageSize)} · ${entries.length} 条</span><button class="btn secondary tiny" data-catalog-page="next" ${page < Math.ceil(entries.length / pageSize) - 1 ? '' : 'disabled'}>下一页</button></footer>` : ''}</article>`;
}
function deductionsWarehouseCard(model) { const deductions = model.core.salesDeductions || []; return `<article class="card"><header class="section-head"><div><h3>销售扣除</h3><p>扣除只作用于整店净 GSV、经营 ROI 和推广费率，不会伪造分摊到单品或品类。</p></div></header>${model.canManage ? `<form id="sales-deduction-form" class="deduction-form"><select name="storeName" required><option value="">选择店铺</option>${model.stores.map((store) => `<option value="${escape(store.name)}">${escape(store.name)}</option>`).join('')}</select><input type="date" name="reportDate" value="${escape(model.core.currentDate || utcDate())}" required /><input type="number" name="amount" min="0.01" step="0.01" placeholder="扣除金额" required /><input name="note" placeholder="备注（可选）" /><button class="btn primary small">保存并重算</button></form>` : '<div class="data-warning">销售扣除由团队管理员维护，成员可查看已生效的经营口径。</div>'}<div class="table-wrap"><table><thead><tr><th>店铺</th><th>统计日期</th><th>扣除金额</th><th>备注</th><th>操作</th></tr></thead><tbody>${deductions.length ? deductions.map((item) => `<tr><td>${escape(item.storeName)}</td><td>${escape(item.reportDate)}</td><td class="negative">-${money(item.amount)}</td><td>${escape(item.note || '--')}</td><td>${model.canManage ? `<button class="btn danger tiny" data-delete-deduction="${escape(item.id)}">删除</button>` : '--'}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-cell">当前范围没有销售扣除。</td></tr>'}</tbody></table></div></article>`; }
function cloudOperationsView() {
  if (!state.workspace?.hasTeam) return emptyTeamView();
  const model = operationsModel(); const workspace = state.workspace;
  return operationsView(model, `<section class="page-header"><div><div class="eyebrow">${escape(workspace.team.name)} · 团队共享空间</div><h1>运营数据</h1><p>团队统一计算，支持按日报、周报、月报和自定义周期核对经营结果。</p></div><div class="quota"><span>云空间</span><strong>${formatBytes(workspace.storage.usedBytes)} / ${formatBytes(workspace.storage.quotaBytes)}</strong><i><b style="width:${Math.min(100, workspace.storage.usageRatio * 100)}%"></b></i></div></section>`);
}
function localOperationsView() {
  const model = operationsModel();
  return operationsView(model, `<section class="page-header"><div><div class="eyebrow">此浏览器 · 私有数据空间</div><h1>运营数据</h1><p>报表、商品资料和销售扣除只保存在当前浏览器；不会上传到团队云端。</p></div><div class="actions"><button class="btn secondary small" id="export-local">导出备份</button><button class="btn danger small" id="clear-local">清空本地数据</button></div></section>`);
}
function operationsView(model, header) { const dashboard = model.core.dashboard; const panel = state.activePanel === 'overview' ? overviewPanel(model) : state.activePanel === 'category' ? `<section class="workspace-content"><div class="matrix-kpis"><div><span>已关联品类</span><b>${dashboard.coverage?.categories?.linked || 0}</b></div><div><span>待补推广</span><b>${dashboard.coverage?.categories?.salesOnly || 0}</b></div><div><span>待补品类 360</span><b>${dashboard.coverage?.categories?.promotionOnly || 0}</b></div><div><span>品类净 GSV</span><b>${money(dashboard.categories.reduce((sum, item) => sum + (Number(item.revenue) || 0), 0))}</b></div></div>${entityTable(dashboard.categories, 'category')}</section>` : state.activePanel === 'product' ? `<section class="workspace-content"><div class="matrix-kpis"><div><span>已关联单品</span><b>${dashboard.coverage?.products?.linked || 0}</b></div><div><span>待补推广</span><b>${dashboard.coverage?.products?.salesOnly || 0}</b></div><div><span>待补经营</span><b>${dashboard.coverage?.products?.promotionOnly || 0}</b></div><div><span>单品推广花费</span><b>${money(dashboard.products.reduce((sum, item) => sum + (Number(item.spend) || 0), 0))}</b></div></div>${entityTable(dashboard.products, 'product')}</section>` : warehousePanel(model); return `${header}${operationsNav()}${modeToolbar()}${panel}`; }
function uploadSelectMenu(id, value, options, placeholder) {
  const selectedOption = options.find((option) => option.value === value);
  const open = state.upload.openMenu === id;
  return `<div class="upload-select"><button class="upload-select-trigger ${selectedOption ? 'has-value' : ''}" type="button" data-upload-menu="${id}" aria-expanded="${open}" aria-haspopup="listbox"><span>${escape(selectedOption?.label || placeholder)}</span></button>${open ? `<div class="upload-select-options" role="listbox">${options.map((option) => `<button type="button" role="option" aria-selected="${option.value === value}" class="${option.value === value ? 'selected' : ''}" data-upload-select="${id}" data-upload-value="${escape(option.value)}">${escape(option.label)}</button>`).join('')}</div>` : ''}</div>`;
}
function uploadCalendarMonth(value) {
  const base = /^\d{4}-\d{2}$/.test(value || '') ? `${value}-01` : `${utcDate()}-01`;
  return new Date(`${base}T12:00:00`);
}
function uploadDateRangePicker() {
  const upload = state.upload;
  const open = upload.openMenu === 'dateRange';
  const month = uploadCalendarMonth(upload.calendarMonth || upload.periodStart?.slice(0, 7) || upload.periodEnd?.slice(0, 7));
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const toIso = (dayOfMonth) => utcDate(new Date(year, monthIndex, dayOfMonth));
  const blanks = Array.from({ length: firstWeekday }, () => '<i aria-hidden="true"></i>').join('');
  const days = Array.from({ length: lastDay }, (_, index) => {
    const value = toIso(index + 1);
    const selected = value === upload.periodStart || value === upload.periodEnd;
    const between = upload.periodStart && upload.periodEnd && value > upload.periodStart && value < upload.periodEnd;
    const today = value === utcDate();
    return `<button type="button" class="${selected ? 'selected' : ''} ${between ? 'between' : ''} ${today ? 'today' : ''}" data-upload-date="${value}" aria-pressed="${selected}">${index + 1}</button>`;
  }).join('');
  const label = upload.periodStart && upload.periodEnd ? `${upload.periodStart} 至 ${upload.periodEnd}` : upload.periodStart ? `开始：${upload.periodStart}` : '选择开始与结束日期';
  return `<div class="upload-date-range"><button type="button" class="upload-select-trigger ${upload.periodStart && upload.periodEnd ? 'has-value' : ''}" data-upload-date-menu aria-expanded="${open}" aria-haspopup="dialog"><span>${escape(label)}</span></button>${open ? `<section class="upload-date-panel" role="dialog" aria-label="选择统计日期"><div class="date-range-summary"><button type="button" class="${upload.dateSelecting === 'start' ? 'active' : ''}" data-upload-date-target="start"><small>开始日期</small><strong>${escape(upload.periodStart || '请选择')}</strong></button><span>至</span><button type="button" class="${upload.dateSelecting === 'end' ? 'active' : ''}" data-upload-date-target="end"><small>结束日期</small><strong>${escape(upload.periodEnd || '请选择')}</strong></button></div><div class="upload-calendar-head"><button type="button" data-upload-date-month="-1" aria-label="上个月">&#8249;</button><strong>${year} 年 ${monthIndex + 1} 月</strong><button type="button" data-upload-date-month="1" aria-label="下个月">&#8250;</button></div><div class="upload-calendar-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="upload-calendar-days">${blanks}${days}</div><footer><button type="button" class="btn text tiny" data-upload-date-today>今天</button><button type="button" class="btn primary tiny" data-upload-date-apply>确认日期</button></footer></section>` : ''}</div>`;
}
function uploadModal(mode) {
  const model = operationsModel(); const upload = state.upload; const stores = model?.stores || [];
  const ready = upload.file && upload.type && upload.storeName && upload.periodStart && upload.periodEnd;
  const storeField = mode === 'cloud'
    ? uploadSelectMenu('storeName', upload.storeName, stores.map((store) => ({ value: store.name, label: store.name })), '选择店铺')
    : `<input id="upload-store" required list="upload-stores" value="${escape(upload.storeName)}" placeholder="输入或选择店铺" /><datalist id="upload-stores">${stores.map((store) => `<option value="${escape(store.name)}"></option>`).join('')}</datalist>`;
  const typeField = uploadSelectMenu('type', upload.type, [{ value: 'category', label: '品类 360' }, { value: 'product', label: '商品排行' }, { value: 'campaign', label: '单品付费' }], '请选择');
  const periodField = uploadSelectMenu('periodKind', upload.periodKind, [{ value: 'day', label: '日报' }, { value: 'week', label: '周报' }, { value: 'month', label: '月报' }, { value: 'custom', label: '自定义周期' }], '选择统计口径');
  const fileHint = upload.preview
    ? `已识别 ${upload.preview.rowCount || 0} 行${upload.preview.detectedType ? ` · 建议类型：${TYPE_LABELS[upload.preview.detectedType] || upload.preview.detectedType}` : ''}${upload.preview.period ? ` · 统计 ${escape(upload.preview.period.start)} 至 ${escape(upload.preview.period.end)}` : ''}`
    : '上传前不会写入任何数据';
  return `<div class="modal"><section class="modal-card upload-modal"><header class="modal-head"><div><h3>${mode === 'cloud' ? '上传团队云报表' : '导入本地浏览器报表'}</h3><p>选择文件后先识别报表类型、行数和真实统计周期；可人工修改后再写入数据仓。</p></div><button class="btn text" data-close-modal>关闭</button></header><form id="report-upload" class="modal-body" data-mode="${mode}"><label class="drop-field"><span>报表文件</span><input id="report-file" type="file" accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,.json" /> <b>${upload.file ? escape(upload.file.name) : '选择 Excel / CSV / TSV / JSON 文件'}</b><small>${fileHint}</small></label><div class="form-grid two"><div class="field"><span>归属店铺</span>${storeField}</div><div class="field"><span>数据表</span>${typeField}</div><div class="field"><span>统计口径</span>${periodField}</div><label class="field"><span>来源备注</span><input id="upload-source-name" value="${escape(upload.sourceName || (mode === 'cloud' ? '网页运营工作台' : '浏览器本地导入'))}" /></label><div class="field date-range-field"><span>统计日期</span>${uploadDateRangePicker()}</div></div>${mode === 'cloud' && !stores.length ? '<div class="data-warning">云端团队还没有店铺。请先到团队管理新增店铺。</div>' : ''}<div class="modal-actions"><button id="submit-report-upload" class="btn primary" type="submit" ${ready ? '' : 'disabled'}>${mode === 'cloud' ? '上传并入库' : '仅保存到本地浏览器'}</button><button class="btn secondary" type="button" data-close-modal>取消</button></div></form></section></div>`;
}
function platformTeamModal() {
  return `<div class="modal"><section class="modal-card"><header class="modal-head"><div><h3>创建店铺团队</h3><p>一个店铺对应一个独立团队；成员权限、数据和报表互相隔离。</p></div><button class="btn text" data-close-modal>关闭</button></header><form id="platform-team-form" class="modal-body"><div class="form-grid two"><label class="field"><span>店铺团队名称</span><input required name="name" placeholder="例如：华东运营店" /></label><label class="field"><span>授权方案</span><select name="plan"><option value="team">团队</option><option value="personal">个人</option></select></label><label class="field"><span>团队人数上限</span><input required name="memberLimit" type="number" min="2" max="500" value="6" /></label></div><div class="modal-actions"><button class="btn primary" type="submit">创建团队</button><button class="btn secondary" type="button" data-close-modal>取消</button></div></form></section></div>`;
}
function teamView() {
  if (!state.team) return `<section class="empty-screen"><h1>团队管理</h1><p>当前账号没有团队管理权限。</p></section>`;
  const { team, stores, members, devices, storage } = state.team;
  const invitations = (state.team.invitations || []).filter((item) => !item.revokedAt);
  const codes = (state.team.codes || []).filter((item) => !item.revokedAt);
  const storeOptions = stores.map((store) => `<option value="${store.id}">${escape(store.name)}</option>`).join('');
  return `<section class="page-header"><div><div class="eyebrow">团队治理</div><h1>${escape(team.name)}</h1><p>管理成员、店铺、邀请码和团队云端空间。</p></div><div class="quota"><span>云空间</span><strong>${formatBytes(storage.usedBytes)} / ${formatBytes(storage.quotaBytes)}</strong><i><b style="width:${Math.min(100, storage.usageRatio * 100)}%"></b></i></div></section><section class="management-grid"><article class="card"><header class="section-head"><div><h3>店铺</h3><p>云端报表必须绑定一个团队店铺。</p></div></header><div class="card-body"><form id="add-store" class="inline-form"><input name="name" required placeholder="新增店铺名称" /><button class="btn secondary small">新增</button></form><div class="simple-list">${stores.length ? stores.map((store) => `<div><strong>${escape(store.name)}</strong><span>${day(store.createdAt)}</span></div>`).join('') : '<p class="empty">尚未创建店铺</p>'}</div></div></article><article class="card"><header class="section-head"><div><h3>邀请成员</h3><p>成员可上传和查看全部团队数据，但只能删除自己上传的报表。</p></div></header><div class="card-body"><form id="create-invite" class="inline-form"><input name="label" placeholder="例如：华东运营" /><select name="expiresInDays"><option value="7">7 天有效</option><option value="3">3 天有效</option><option value="14">14 天有效</option></select><button class="btn primary small">生成邀请码</button></form>${state.copiedCode ? `<div class="invite-code"><code>${escape(state.copiedCode)}</code><button class="btn secondary tiny" id="copy-invite">复制</button></div>` : ''}<div class="simple-list">${members.map((member) => `<div><strong>${escape(member.username)}</strong><span>${member.role === 'team-admin' ? '团队管理员' : '成员'}</span></div>`).join('')}</div>${invitations?.length ? `<div class="subsection"><h4>邀请记录</h4>${invitations.slice(0, 8).map((invite) => `<div class="history-row"><span>${escape(invite.label)}</span><small>${invite.acceptedAt ? '已加入' : invite.revokedAt ? '已撤销' : `至 ${day(invite.expiresAt)} 有效`}</small></div>`).join('')}</div>` : ''}</div></article><article class="card"><header class="section-head"><div><h3>本地应用同步</h3><p>授权码仅用于桌面应用连接团队云数据，不影响网页登录。</p></div><span class="status">${devices.filter((device) => !device.revokedAt).length}/${team.deviceLimit} 台</span></header><div class="card-body"><form id="create-device-code" class="stack"><div class="form-grid two"><label class="field"><span>授权名称</span><input name="label" value="${escape(team.name)} 同步" /></label><label class="field"><span>授权类型</span><select name="mode"><option value="team">团队授权码</option><option value="personal">个人授权码</option></select></label><label class="field"><span>有效期</span><select name="expiresInDays"><option value="7">7 天</option><option value="3">3 天</option><option value="14">14 天</option></select></label><label class="field"><span>可同步店铺</span><select required name="storeIds" multiple>${storeOptions}</select></label></div><button class="btn secondary small" ${stores.length ? '' : 'disabled'}>生成同步授权码</button></form>${state.deviceCode ? `<div class="invite-code"><code>${escape(state.deviceCode)}</code><button class="btn secondary tiny" id="copy-device-code">复制</button></div>` : ''}${codes?.length ? `<div class="subsection"><h4>同步授权码</h4>${codes.slice(0, 6).map((code) => `<div class="history-row"><span>${escape(code.label)} · ${code.mode === 'team' ? '团队' : '个人'} · ${code.activationCount}/${code.maxActivations}</span><small>${code.revokedAt ? '已撤销' : `至 ${day(code.expiresAt)} 有效`}</small></div>`).join('')}</div>` : ''}${devices?.length ? `<div class="subsection"><h4>已绑定设备</h4>${devices.slice(0, 8).map((device) => `<div class="history-row"><span>${escape(device.label)}</span><small>${device.revokedAt ? '已移除' : device.lastSeenAt ? `最近 ${day(device.lastSeenAt)}` : '已绑定'}</small></div>`).join('')}</div>` : ''}</div></article></section>`;
}
function platformView() {
  const teams = state.overview?.teams || [];
  return `<section class="page-header"><div><div class="eyebrow">平台治理</div><h1>团队总览</h1><p>平台管理员可以管理全部团队、成员额度与云空间。</p></div></section><section class="workspace-content"><article class="card"><header class="section-head"><div><h3>团队</h3><p>${teams.length} 个活跃团队</p></div><button class="btn primary small" id="new-platform-team">创建团队</button></header><div class="table-wrap"><table><thead><tr><th>团队</th><th>类型</th><th>店铺</th><th>报表</th><th>成员</th><th>云空间</th><th>操作</th></tr></thead><tbody>${teams.map((team) => `<tr><td><strong>${escape(team.name)}</strong></td><td>${team.plan === 'team' ? '团队' : '个人'}</td><td>${team.storeCount}</td><td>${team.reportCount}</td><td>${teamMemberCount(team)}</td><td>${formatBytes(team.storage?.usedBytes)} / ${formatBytes(team.storage?.quotaBytes)}</td><td><button class="btn secondary tiny" data-open-team="${escape(team.id)}" data-open-page="team">管理</button><button class="btn text tiny" data-open-team="${escape(team.id)}" data-open-page="operations">查看数据</button></td></tr>`).join('')}</tbody></table></div></article></section>`;
}
function teamStatusLabel(team) { return team.status === 'suspended' ? '已封禁' : '正常'; }
function teamStatusClass(team) { return team.status === 'suspended' ? 'suspended' : 'active'; }
function invitationStatus(invitation, team) {
  if (invitation.revokedAt) return '已撤销';
  if (invitation.exhaustedAt) return '团队名额已满，已失效';
  if (Date.parse(invitation.expiresAt || '') <= Date.now()) return '已过期';
  const limit = Number(team.memberLimit) || '未设置';
  return `${Number(invitation.acceptanceCount) || 0}/${limit} 人已加入`;
}
function platformAdminView() {
  const teams = state.overview?.teams || [];
  const allowTeamCreation = state.overview?.platform?.allowTeamCreation ?? state.platformSettings.allowTeamCreation;
  const active = teams.filter((team) => team.status === 'active');
  const suspended = teams.filter((team) => team.status === 'suspended');
  const usedBytes = teams.reduce((total, team) => total + (Number(team.storage?.usedBytes) || 0), 0);
  const quotaBytes = teams.reduce((total, team) => total + (Number(team.storage?.quotaBytes) || 0), 0);
  return `<section class="platform-admin"><header class="platform-commandbar"><div><div class="eyebrow">平台控制台</div><h1>团队空间</h1><p>统一管理团队、成员、店铺、设备与云端数据。封禁会立即阻止该团队全部账号登录。</p></div><button class="btn primary" id="new-platform-team">新建团队</button></header><section class="platform-summary"><article><span>团队总数</span><strong>${teams.length}</strong><small>${active.length} 个正常运行</small></article><article class="summary-blue"><span>已封禁团队</span><strong>${suspended.length}</strong><small>无法登录和同步</small></article><article class="summary-teal"><span>已用云空间</span><strong>${formatBytes(usedBytes)}</strong><small>总配额 ${formatBytes(quotaBytes)}</small></article><article class="summary-amber"><span>已接入店铺</span><strong>${teams.reduce((total, team) => total + (Number(team.storeCount) || 0), 0)}</strong><small>跨团队独立隔离</small></article></section><section class="platform-switch"><div><strong>普通用户自助创建团队</strong><span>${allowTeamCreation ? '已开启：注册用户可创建个人或团队空间。' : '已关闭：注册用户只能通过邀请码加入已有团队。'}</span></div><label class="toggle-control"><input id="team-creation-toggle" type="checkbox" ${allowTeamCreation ? 'checked' : ''} /><i></i><b>${allowTeamCreation ? '已开启' : '已关闭'}</b></label></section><section class="team-command-list"><header class="command-list-head"><div><h2>全部团队</h2><p>选择团队后可直接进入其运营数据或完整管理界面。</p></div><span>${teams.length} 个团队</span></header>${teams.length ? teams.map((team) => `<article class="team-command-card ${teamStatusClass(team)}"><div class="team-rail"></div><div class="team-identity"><div><h3>${escape(team.name)}</h3><span class="status ${teamStatusClass(team)}">${teamStatusLabel(team)}</span></div><p>${team.plan === 'team' ? '团队授权' : '个人授权'} · 创建于 ${day(team.createdAt)}</p></div><div class="team-stats"><div><span>店铺</span><strong>${team.storeCount}</strong></div><div><span>报表</span><strong>${team.reportCount}</strong></div><div><span>成员</span><strong>${teamMemberCount(team)}</strong><small>${team.memberLimit ? '当前 / 上限' : '当前人数'}</small></div><div><span>云空间</span><strong>${formatBytes(team.storage?.usedBytes)}</strong><small>/ ${formatBytes(team.storage?.quotaBytes)}</small></div></div><div class="team-actions"><button class="btn secondary tiny" data-open-team="${escape(team.id)}" data-open-page="operations">运营数据</button><button class="btn secondary tiny" data-open-team="${escape(team.id)}" data-open-page="team">团队管理</button>${team.status === 'suspended' ? `<button class="btn primary tiny" data-activate-team="${escape(team.id)}">解除封禁</button>` : `<button class="btn warning tiny" data-suspend-team="${escape(team.id)}">封禁团队</button>`}<button class="btn danger tiny" data-delete-team="${escape(team.id)}" data-team-name="${escape(team.name)}">永久删除</button></div></article>`).join('') : '<div class="command-empty">还没有团队。创建团队后，成员、店铺和数据会独立隔离。</div>'}</section></section>`;
}
function enhancedTeamView() {
  if (!state.team) return `<section class="empty-screen"><h1>团队管理</h1><p>请选择一个团队后再管理成员、店铺和授权。</p></section>`;
  const { team, stores, members, invitations, devices, codes, storage } = state.team;
  const platformControl = state.session?.role === 'platform-admin';
  const active = team.status === 'active';
  const memberLimit = Number(team.memberLimit) || null;
  const activeDevices = devices.filter((device) => !device.revokedAt).length;
  const canDissolve = !platformControl && state.session?.memberships?.some((membership) => membership.teamId === team.id && membership.role === 'team-admin' && membership.status === 'active') && active;
  const storeOptions = stores.map((store) => `<option value="${escape(store.id)}">${escape(store.name)}</option>`).join('');
  const accessStatus = (item) => item.revokedAt ? ['已撤销', 'muted'] : item.exhaustedAt ? ['名额已满', 'warning'] : Date.parse(item.expiresAt || '') <= Date.now() ? ['已过期', 'muted'] : ['有效', 'active'];
  const revealCode = (item, kind) => item.recoverable
    ? `<div class="access-code-value"><code>${escape(item.code)}</code><button class="btn text tiny" data-copy-managed-code="${escape(item.code)}">复制</button></div>`
    : `<span class="code-unavailable">${kind === 'invite' ? '旧邀请码不可恢复' : '旧授权码不可恢复'}</span>`;
  const invitationRows = invitations?.length ? invitations.map((invite) => {
    const [label, tone] = accessStatus(invite);
    return `<article class="access-code-row"><div class="access-code-meta"><div><strong>${escape(invite.label)}</strong><span class="status ${tone}">${label}</span></div><small>${Number(invite.acceptanceCount) || 0}/${memberLimit || '未设置'} 人已加入 · 至 ${day(invite.expiresAt)}</small></div>${revealCode(invite, 'invite')}<div class="access-code-actions">${!invite.revokedAt ? `<button class="btn danger tiny" data-revoke-invitation="${escape(invite.id)}" data-invitation-name="${escape(invite.label)}">撤销</button>` : ''}</div></article>`;
  }).join('') : '<p class="empty">还没有成员邀请码。生成后可在这里长期复制和撤销。</p>';
  const syncRows = codes?.length ? codes.map((code) => {
    const [label, tone] = accessStatus(code);
    return `<article class="access-code-row"><div class="access-code-meta"><div><strong>${escape(code.label)}</strong><span class="status ${tone}">${label}</span></div><small>${code.mode === 'team' ? '团队授权' : '个人授权'} · 已绑 ${Number(code.activationCount) || 0}/${Number(code.maxActivations) || 0} 台 · ${code.storeIds?.length || 0} 家店铺</small></div>${revealCode(code, 'sync')}<div class="access-code-actions">${!code.revokedAt ? `<button class="btn danger tiny" data-revoke-device-code="${escape(code.id)}" data-device-code-name="${escape(code.label)}">撤销</button>` : ''}</div></article>`;
  }).join('') : '<p class="empty">还没有本地应用授权码。</p>';
  const availableTeams = (state.overview?.teams || [team]).filter((option) => option.status === 'active');
  // This list is the current team's membership only. The platform account
  // directory is deliberately kept out of it so removed accounts cannot look
  // like they rejoined when a new team is created.
  const editableMembers = members;
  const currentMemberIds = new Set(members.map((member) => member.id));
  const existingMemberOptions = platformControl ? (state.team.memberDirectory || [])
    .filter((member) => !currentMemberIds.has(member.id))
    .map((member) => `<option value="${escape(member.id)}">${escape(member.username)}</option>`).join('') : '';
  const addExistingMember = platformControl && active ? `<form id="add-existing-member" class="existing-member-row"><select name="userId" required><option value="">选择已有账号加入当前团队</option>${existingMemberOptions}</select><button class="btn secondary" ${existingMemberOptions ? '' : 'disabled'}>加入团队</button></form>` : '';
  const membersList = editableMembers.length ? editableMembers.map((member) => {
    const membership = member.membership || (member.memberships || []).find((item) => item.teamId === team.id) || {};
    const draft = memberDraft(member, membership);
    const membershipStatus = membership.status || 'not-member';
    const hasCurrentMembership = Boolean(membership.id);
    const accessScope = platformControl ? `<fieldset class="member-access-scope"><legend>可查看店铺</legend><div>${availableTeams.map((option) => `<label><input type="checkbox" data-member-access="${escape(member.id)}" value="${escape(option.id)}" ${draft.teamIds.includes(option.id) ? 'checked' : ''} /><span>${escape(option.name)}</span></label>`).join('')}</div></fieldset>` : '';
    return `<div class="member-row member-editor"><div class="member-identity"><strong>${escape(draft.note || member.username)}</strong><small>${escape(member.username)} · ${draft.role === 'team-admin' ? '团队管理员' : '团队成员'} · ${membershipStatus === 'active' ? '当前店铺可用' : hasCurrentMembership ? '当前店铺已停用' : '未授权当前店铺'}</small></div><div class="member-fields"><input data-member-note="${escape(member.id)}" value="${escape(draft.note)}" maxlength="80" placeholder="成员备注名" aria-label="成员备注名" /><select data-member-role="${escape(member.id)}" aria-label="当前店铺角色"><option value="member" ${draft.role === 'member' ? 'selected' : ''}>团队成员</option><option value="team-admin" ${draft.role === 'team-admin' ? 'selected' : ''}>团队管理员</option></select>${accessScope}</div><div class="member-actions"><button class="btn secondary tiny" data-save-member="${escape(member.id)}">保存</button>${hasCurrentMembership ? (membershipStatus === 'active' ? `<button class="btn warning tiny" data-suspend-member="${escape(member.id)}">停用</button>` : `<button class="btn secondary tiny" data-activate-member="${escape(member.id)}">恢复</button>`) : ''}${hasCurrentMembership ? `<button class="btn danger tiny" data-delete-member="${escape(member.id)}" data-member-name="${escape(member.username)}">移出</button>` : ''}</div></div>`;
  }).join('') : '<p class="empty">还没有可管理的成员账号。</p>';
  const storeRows = stores.length ? stores.map((store) => `<div class="store-row"><strong>${escape(store.name)}</strong><div>${platformControl ? `<button class="btn text tiny" data-rename-store="${escape(store.id)}" data-store-name="${escape(store.name)}">改名</button><button class="btn danger tiny" data-delete-store="${escape(store.id)}" data-store-name="${escape(store.name)}">移除</button>` : `<small>${day(store.createdAt)}</small>`}</div></div>`).join('') : '<p class="empty">尚未新增店铺。</p>';
  const storeSetup = !stores.length ? `<form id="add-store" class="store-create-row"><input name="name" required placeholder="绑定此团队的店铺名称" ${active ? '' : 'disabled'} /><button class="btn secondary" ${active ? '' : 'disabled'}>绑定店铺</button></form>` : '<p class="store-scope-note">一个店铺对应一个独立团队；需要新增店铺时，请在平台中新建店铺团队。</p>';
  const platformControls = platformControl ? `<article class="team-control-card wide-card"><header><div><span class="section-kicker">平台权限</span><h2>团队控制</h2></div></header><form id="update-team-settings" class="settings-grid"><label class="field"><span>团队名称</span><input name="name" required value="${escape(team.name)}" /></label><label class="field"><span>授权方案</span><select name="plan"><option value="team" ${team.plan === 'team' ? 'selected' : ''}>团队</option><option value="personal" ${team.plan === 'personal' ? 'selected' : ''}>个人</option></select></label><label class="field"><span>团队人数上限</span><input name="memberLimit" required type="number" min="${Math.max(2, members.length)}" max="500" value="${memberLimit || 6}" /></label><label class="field"><span>云空间 GB</span><input name="storageQuotaGb" required type="number" min="0.25" max="100" step="0.25" value="${Math.max(.25, (Number(storage.quotaBytes) || 0) / 1024 ** 3)}" /></label><button class="btn primary small">保存团队设置</button></form><footer class="control-footer"><span>${active ? '团队正常运行，成员可登录和同步。' : '团队已封禁，成员无法登录和同步。'}</span><div>${active ? `<button class="btn warning" data-suspend-team="${escape(team.id)}">封禁团队</button>` : `<button class="btn primary" data-activate-team="${escape(team.id)}">解除封禁</button>`}<button class="btn danger" data-delete-team="${escape(team.id)}" data-team-name="${escape(team.name)}">永久删除</button></div></footer></article>` : '';
  const dissolveCard = canDissolve ? `<article class="team-control-card wide-card"><header><div><span class="section-kicker">高风险操作</span><h2>解散团队</h2></div></header><div class="control-footer"><span>解散会删除团队数据、店铺与全部授权；成员账号保留，可再次加入其他团队。</span><button class="btn danger" id="dissolve-team" data-team-id="${escape(team.id)}" data-team-name="${escape(team.name)}">解散团队</button></div></article>` : '';
  return `<section class="team-control-page" data-team-page="${escape(team.id)}"><header class="team-control-hero"><div><div class="eyebrow">${platformControl ? '平台团队管理' : '团队管理'}</div><div class="title-row"><h1>${escape(team.name)}</h1><span class="status ${teamStatusClass(team)}">${teamStatusLabel(team)}</span></div><p>成员、店铺与授权都在这里维护，运营数据保持团队隔离。</p></div><div class="hero-actions">${platformControl ? '<button class="btn text" id="team-back-platform">返回全部团队</button>' : ''}<div class="quota"><span>云空间</span><strong>${formatBytes(storage.usedBytes)} / ${formatBytes(storage.quotaBytes)}</strong><i><b style="width:${Math.min(100, storage.usageRatio * 100)}%"></b></i></div></div></header><section class="team-control-metrics"><article><span>团队成员</span><strong>${members.length}<em> / ${memberLimit || '未设置'}</em></strong><small>${memberLimit ? `${Math.max(0, memberLimit - members.length)} 个可用名额` : '创建邀请码时设置上限'}</small></article><article><span>团队店铺</span><strong>${stores.length}</strong><small>一店一团队，数据独立隔离</small></article><article><span>已连接设备</span><strong>${activeDevices}<em> / ${team.deviceLimit}</em></strong><small>成功绑定本地应用后显示</small></article><article><span>有效邀请码</span><strong>${(invitations || []).filter((item) => !item.revokedAt && !item.exhaustedAt && Date.parse(item.expiresAt || '') > Date.now()).length}</strong><small>可直接免验证码注册</small></article></section><section class="team-control-grid"><article class="team-control-card invite-card"><header><div><span class="section-kicker">成员加入</span><h2>多人邀请码</h2><p>有效码长期可复制；团队满员时自动失效。</p></div></header><form id="create-invite" class="code-create-form"><input name="label" placeholder="邀请码名称，例如华东运营" ${active ? '' : 'disabled'} /><select name="expiresInDays" ${active ? '' : 'disabled'}><option value="7">7 天有效</option><option value="3">3 天有效</option><option value="14">14 天有效</option><option value="30">30 天有效</option></select><button class="btn primary" ${active ? '' : 'disabled'}>生成邀请码</button></form><div class="access-code-list">${invitationRows}</div></article><article class="team-control-card sync-card"><header><div><span class="section-kicker">桌面应用</span><h2>同步授权码</h2><p>为本地应用设置可同步店铺和设备范围。</p></div></header><form id="create-device-code" class="sync-create-form"><input name="label" value="${escape(team.name)} 同步" ${active ? '' : 'disabled'} /><select name="mode" ${active ? '' : 'disabled'}><option value="team">团队授权</option><option value="personal">个人授权</option></select><select required name="storeIds" multiple ${active && stores.length ? '' : 'disabled'}>${storeOptions}</select><select name="expiresInDays" ${active ? '' : 'disabled'}><option value="7">7 天有效</option><option value="30">30 天有效</option><option value="60">60 天有效</option></select><button class="btn secondary" ${active && stores.length ? '' : 'disabled'}>生成授权码</button></form><div class="access-code-list">${syncRows}</div></article><article class="team-control-card members-card"><header><div><span class="section-kicker">成员</span><h2>成员与管理员</h2></div><span class="status active">${members.length}${memberLimit ? ` / ${memberLimit}` : ''} 人</span></header>${addExistingMember}${active ? `<form id="create-team-admin" class="admin-create-row"><input name="username" required value="${escape(state.teamDraft.admin.username)}" placeholder="新团队管理员账号" /><input name="password" required type="password" minlength="10" value="${escape(state.teamDraft.admin.password)}" placeholder="新账号初始密码（已有账号不会修改密码）" /><button class="btn secondary">新增管理员</button></form>` : ''}<div class="member-list">${membersList}</div></article><article class="team-control-card stores-card"><header><div><span class="section-kicker">数据归属</span><h2>团队店铺</h2></div><span class="status active">${stores.length} 家</span></header>${storeSetup}<div class="store-list">${storeRows}</div></article>${platformControls}${dissolveCard}</section></section>`;
}
function prepareDesktopSyncPanel() {
  const card = app.querySelector('.sync-card');
  const form = card?.querySelector('#create-device-code');
  const codeList = card?.querySelector('.access-code-list');
  if (!card || !form || !codeList) return;

  const header = card.querySelector(':scope > header');
  header?.querySelector('.section-kicker')?.replaceChildren('按需使用');
  header?.querySelector('h2')?.replaceChildren('本地软件连接');
  header?.querySelector('p')?.replaceChildren('仅当电脑需要同步团队云端数据时，才创建连接码。');

  const note = form.querySelector('input[name="label"]');
  const mode = form.querySelector('select[name="mode"]');
  const stores = form.querySelector('select[name="storeIds"]');
  const expires = form.querySelector('select[name="expiresInDays"]');
  const submit = form.querySelector('button');
  if (!note || !mode || !stores || !expires || !submit) return;

  note.value = '';
  note.placeholder = '例如：老板电脑（可不填）';
  note.setAttribute('aria-label', '连接码备注（可不填）');
  mode.options[0].textContent = '多台电脑（占用团队设备名额）';
  mode.options[1].textContent = '仅一台电脑';

  const details = document.createElement('details');
  details.className = 'desktop-link-panel';
  const summary = document.createElement('summary');
  summary.innerHTML = `<div class="desktop-link-summary-copy"><strong>连接一台新电脑</strong><span>生成连接码后，在本地应用的云端数据同步中粘贴即可。</span></div><div class="desktop-link-summary-status"><span class="status active">${stores.options.length ? '可设置店铺范围' : '请先新增店铺'}</span><i aria-hidden="true"></i></div>`;
  details.append(summary);

  const content = document.createElement('div');
  content.className = 'desktop-link-content';
  content.innerHTML = '<p class="desktop-link-hint">连接码只允许读取下方勾选店铺的数据；不影响网页端登录和团队成员权限。</p>';
  const fields = document.createElement('div');
  fields.className = 'desktop-link-fields';
  const field = (label, control, description = '') => {
    const wrapper = document.createElement('label');
    wrapper.className = 'desktop-link-field';
    const title = document.createElement('span');
    title.textContent = label;
    wrapper.append(title, control);
    if (description) {
      const hint = document.createElement('small');
      hint.textContent = description;
      wrapper.append(hint);
    }
    return wrapper;
  };

  fields.append(
    field('连接码备注（可不填）', note, '仅供团队管理员区分不同电脑。'),
    field('可使用的电脑', mode, '多台电脑会占用团队设备名额。'),
  );

  const storeField = document.createElement('fieldset');
  storeField.className = 'desktop-link-field desktop-link-store-scope';
  const legend = document.createElement('legend');
  legend.textContent = '可访问店铺';
  storeField.append(legend);
  const storeOptions = document.createElement('div');
  storeOptions.className = 'desktop-link-store-options';
  Array.from(stores.options).forEach((option) => {
    const choice = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'storeIds';
    checkbox.value = option.value;
    checkbox.checked = true;
    checkbox.disabled = stores.disabled;
    choice.append(checkbox, document.createTextNode(option.textContent));
    storeOptions.append(choice);
  });
  storeField.append(storeOptions);
  fields.append(storeField, field('连接码有效期', expires, '到期后不能再用于连接新电脑。'));

  form.className = 'desktop-link-form';
  form.replaceChildren(fields, submit);
  submit.textContent = '生成连接码';
  content.append(form);

  const savedCodes = document.createElement('section');
  savedCodes.className = 'desktop-link-codes';
  savedCodes.innerHTML = '<h3>已生成的连接码</h3>';
  savedCodes.append(codeList);
  content.append(savedCodes);
  if (state.deviceCode) {
    const quickConnect = document.createElement('button');
    quickConnect.type = 'button';
    quickConnect.className = 'btn primary small desktop-quick-connect';
    quickConnect.textContent = '连接本机应用';
    quickConnect.title = '已安装桌面应用时自动完成设备绑定';
    quickConnect.addEventListener('click', () => {
      const endpoint = window.location.origin;
      const link = `ecom-monitor://cloud-sync?endpoint=${encodeURIComponent(endpoint)}&code=${encodeURIComponent(state.deviceCode)}`;
      window.location.href = link;
      setToast('正在打开本机应用完成绑定；如果没有反应，请复制连接码到应用内。');
    });
    content.append(quickConnect);
  }
  const deviceSection = document.createElement('section');
  deviceSection.className = 'desktop-link-devices';
  const activeDevices = (state.team?.devices || []).filter((device) => !device.revokedAt);
  deviceSection.innerHTML = `<div class="desktop-link-devices-head"><h3>已连接设备</h3><button class="btn text tiny" id="refresh-devices" type="button">刷新</button></div>${activeDevices.length ? activeDevices.map((device) => `<div class="history-row"><span>${escape(device.label || '本地应用')}</span><small>${device.lastSeenAt ? `最近连接 ${fmtDate(device.lastSeenAt)}` : '已绑定'}</small></div>`).join('') : '<p class="empty">生成连接码不等于设备已连接。本地软件粘贴连接码并完成绑定后，设备会显示在这里。</p>'}`;
  content.append(deviceSection);
  details.append(content);
  card.append(details);
}

function shell() {
  let view = state.page === 'team' ? enhancedTeamView() : state.page === 'platform' ? platformAdminView() : (state.mode === 'cloud' ? cloudOperationsView() : localOperationsView());
  const activity = state.activity ? `<div class="activity-dock ${state.activity.phase}" role="status" aria-live="polite"><i></i><div><strong>${state.activity.phase === 'running' ? '正在处理' : state.activity.phase === 'success' ? '已完成' : '处理失败'}</strong><span>${escape(activityText(state.activity))}</span></div></div>` : '';
  app.innerHTML = `<div class="app-shell">${topNav()}<main class="app-main">${view}</main>${activity}${state.toast ? `<div class="toast ${state.toast.error ? 'error' : ''}"><span>${escape(state.toast.message)}</span><button id="dismiss-toast">关闭</button></div>` : ''}${state.modal === 'upload' ? uploadModal(state.upload.mode) : state.modal === 'platform-team' ? platformTeamModal() : ''}</div>`;
  prepareDesktopSyncPanel();
  bindShell();
}
function render() { captureTeamDraft(); if (!state.session) loginView(); else shell(); }

function localDetectedType(rows, fileName = '') {
  const headers = Object.keys(rows?.[0] || {}).map(headerKey); const has = (pattern) => headers.some((header) => pattern.test(header));
  if (/(分类目场景|营销场景|类目花费)/.test(fileName)) return 'category';
  if (has(/(商品id|宝贝id|主体id)/) && has(/(花费|消耗)/)) return 'campaign';
  if (has(/(商品id|宝贝id|主体id)/) && has(/(支付金额|成交金额|总成交金额)/)) return 'product';
  if (has(/(类目|品类)/) && has(/(支付金额|成交金额|总成交金额)/)) return 'category';
  return '';
}
function periodKindForRange(start, end) { if (!start || !end || start > end) return 'custom'; if (start === end) return 'day'; const first = new Date(`${start}T12:00:00`); const last = new Date(`${end}T12:00:00`); const days = Math.round((last - first) / 86_400_000) + 1; if (((first.getDay() + 6) % 7) === 0 && days === 7) return 'week'; if (first.getDate() === 1 && first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear() && last.getDate() === new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate()) return 'month'; return 'custom'; }
async function importLocalUpload() {
  const upload = state.upload; const file = upload.file; if (!(file instanceof File)) throw new Error('请选择报表文件。');
  if (/\.json$/i.test(file.name)) {
    try {
      const backup = JSON.parse(await file.text());
      const backupReports = Array.isArray(backup) ? backup : Array.isArray(backup?.reports) ? backup.reports : null;
      if (backupReports && backupReports.every((item) => Array.isArray(item?.rows) && item?.type)) {
        for (const item of backupReports) await localPut({ ...item, id: `local_${crypto.randomUUID()}`, importedAt: item.importedAt || new Date().toISOString() });
        if (backup?.metadata && typeof backup.metadata === 'object') {
          state.localMeta = { ...state.localMeta, ...backup.metadata };
          await localPutMeta(state.localMeta);
        }
        state.localReports = await localReadAll();
        return;
      }
    } catch {
      // Not a browser backup; SheetJS will attempt to read it as a data export.
    }
  }
  const rows = spreadsheetRows(await file.arrayBuffer()); if (!rows.length) throw new Error('没有读取到可计算的数据行，请确认选择的是原始导出报表。');
  const periodStart = String(upload.periodStart); const periodEnd = String(upload.periodEnd);
  const report = { id: `local_${crypto.randomUUID()}`, type: String(upload.type), storeName: String(upload.storeName).trim(), periodKind: String(upload.periodKind), periodStart, periodEnd, periodLabel: periodStart === periodEnd ? periodStart : `${periodStart} 至 ${periodEnd}`, fileName: file.name, sourceName: String(upload.sourceName || ''), importedAt: new Date().toISOString(), rows: rows.map((row) => normalRow(row, upload.storeName)), rawFile: file };
  if (!report.storeName) throw new Error('请填写归属店铺。');
  await localPut(report); state.localReports = await localReadAll();
}
function downloadJson(name, value) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
function exportCatalogWorkbook(rows, fileName) {
  if (!window.XLSX) throw new Error('Excel 导出组件尚未加载，请刷新页面后重试。');
  const values = [['店铺名', '商品ID', '品类名', '型号'], ...rows.map((entry) => [entry.storeName, entry.productId, entry.category, entry.model])];
  const sheet = window.XLSX.utils.aoa_to_sheet(values);
  sheet['!cols'] = [{ wch: 28 }, { wch: 22 }, { wch: 20 }, { wch: 24 }];
  sheet['!autofilter'] = { ref: `A1:D${Math.max(1, values.length)}` };
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, sheet, '商品资料');
  window.XLSX.writeFile(workbook, fileName, { compression: true });
}
function syncUploadDraftFromForm() {
  if (!document.querySelector('#report-upload')) return;
  const store = document.querySelector('#upload-store');
  const type = document.querySelector('#upload-type');
  const periodKind = document.querySelector('#upload-period-kind');
  const periodStart = document.querySelector('#upload-period-start');
  const periodEnd = document.querySelector('#upload-period-end');
  const sourceName = document.querySelector('#upload-source-name');
  if (store) state.upload.storeName = store.value.trim();
  if (type) state.upload.type = type.value;
  if (periodKind) state.upload.periodKind = periodKind.value || 'day';
  if (periodStart) state.upload.periodStart = periodStart.value;
  if (periodEnd) state.upload.periodEnd = periodEnd.value;
  if (sourceName) state.upload.sourceName = sourceName.value.trim();
}
function refreshUploadSubmitState() {
  const submit = document.querySelector('#submit-report-upload');
  if (!submit) return;
  const upload = state.upload;
  submit.disabled = !(upload.file && upload.type && upload.storeName && upload.periodStart && upload.periodEnd && upload.periodStart <= upload.periodEnd);
}
async function bootstrap() {
  [state.localReports, state.localMeta] = await Promise.all([localReadAll(), localReadMeta()]);
  if (state.session) { await Promise.all([loadCloudWorkspace(), loadOverview().catch(() => { state.overview = null; }), loadTeam().catch(() => { state.team = null; })]); }
  render();
}
function bindShell() {
  document.querySelector('#logout')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); selectTeam(''); Object.assign(state, { session: null, workspace: null, overview: null, team: null, page: 'operations' }); render(); });
  document.querySelector('#dismiss-toast')?.addEventListener('click', () => { state.toast = null; render(); });
  document.querySelector('#team-switcher-button')?.addEventListener('click', () => { state.teamMenuOpen = !state.teamMenuOpen; render(); });
  document.querySelectorAll('[data-switch-team]').forEach((button) => button.addEventListener('click', async () => {
    const teamId = button.dataset.switchTeam;
    if (!teamId || teamId === activeTeamId()) { state.teamMenuOpen = false; render(); return; }
    try {
      await runActivity('正在切换团队并加载运营数据', async () => {
        const result = await api('/api/session/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId }) });
        state.session = result.user;
        if (state.session.role === 'platform-admin') selectTeam(teamId);
        state.teamMenuOpen = false;
        state.workspace = null;
        state.team = null;
        openOperationsHome();
        await bootstrap();
      });
      setToast('团队已切换。');
    } catch (error) { setToast(error.message, true); }
  }));
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => { state.page = button.dataset.page; if (state.page === 'team' && !activeTeamId()) { state.page = 'platform'; setToast('请先在平台管理中选择一个团队。', true); } if (state.page === 'team') await loadTeam().catch((error) => setToast(error.message, true)); if (state.page === 'platform') await loadOverview().catch((error) => setToast(error.message, true)); render(); }));
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => { state.mode = button.dataset.mode; if (state.mode === 'cloud') await loadCloudWorkspace().catch((error) => setToast(error.message, true)); render(); }));
  document.querySelectorAll('[data-panel]').forEach((button) => button.addEventListener('click', () => { state.activePanel = button.dataset.panel; if (state.activePanel === 'warehouse') state.warehousePanel = 'upload'; render(); }));
  document.querySelectorAll('[data-date-preset]').forEach((button) => button.addEventListener('click', async () => { const preset = button.dataset.datePreset; state.datePreset = preset; if (preset === 'custom') { state.customScopeOpen = true; render(); return; } state.customScopeOpen = false; await applyScope(dateRangeForPreset(preset)).catch((error) => setToast(error.message, true)); render(); }));
  document.querySelector('#apply-custom-scope')?.addEventListener('click', async () => { const start = document.querySelector('#filter-start')?.value || ''; const end = document.querySelector('#filter-end')?.value || ''; if (!start || !end || start > end) return setToast('请选择有效的自定义统计日期。', true); state.datePreset = 'custom'; state.customScopeOpen = false; await applyScope({ start, end }).catch((error) => setToast(error.message, true)); render(); });
  document.querySelector('#apply-filters')?.addEventListener('click', async () => { const period = document.querySelector('#filter-period-kind')?.value || 'auto'; const storeName = document.querySelector('#filter-store')?.value || ''; await applyScope({ sourcePeriodKind: period, storeName }).catch((error) => setToast(error.message, true)); render(); });
  document.querySelectorAll('[data-open-upload]').forEach((button) => button.addEventListener('click', () => { const mode = button.dataset.openUpload; state.upload = { mode, file: null, preview: null, type: '', storeName: state.filters.storeName || '', periodKind: 'day', periodStart: state.filters.start || '', periodEnd: state.filters.end || '', sourceName: mode === 'cloud' ? '网页运营工作台' : '浏览器本地导入', openMenu: '', dateSelecting: 'start', calendarMonth: (state.filters.start || state.filters.end || utcDate()).slice(0, 7) }; state.modal = 'upload'; render(); }));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { state.modal = ''; render(); }));
  document.querySelector('.modal-card')?.addEventListener('pointerdown', (event) => event.stopPropagation());
  document.querySelector('.modal-card')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelectorAll('[data-upload-menu]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); const id = event.currentTarget.dataset.uploadMenu; state.upload.openMenu = state.upload.openMenu === id ? '' : id; render(); }));
  document.querySelector('[data-upload-date-menu]')?.addEventListener('click', (event) => { event.preventDefault(); if (!state.upload.calendarMonth) state.upload.calendarMonth = (state.upload.periodStart || state.upload.periodEnd || utcDate()).slice(0, 7); state.upload.openMenu = state.upload.openMenu === 'dateRange' ? '' : 'dateRange'; render(); });
  document.querySelectorAll('[data-upload-date-target]').forEach((button) => button.addEventListener('click', (event) => { state.upload.dateSelecting = event.currentTarget.dataset.uploadDateTarget; render(); }));
  document.querySelectorAll('[data-upload-date-month]').forEach((button) => button.addEventListener('click', (event) => { const month = uploadCalendarMonth(state.upload.calendarMonth); month.setMonth(month.getMonth() + Number(event.currentTarget.dataset.uploadDateMonth)); state.upload.calendarMonth = utcDate(month).slice(0, 7); render(); }));
  document.querySelector('[data-upload-date-today]')?.addEventListener('click', () => { const today = utcDate(); state.upload.periodStart = today; state.upload.periodEnd = today; state.upload.dateSelecting = 'start'; state.upload.calendarMonth = today.slice(0, 7); refreshUploadSubmitState(); render(); });
  document.querySelectorAll('[data-upload-date]').forEach((button) => button.addEventListener('click', (event) => { const value = event.currentTarget.dataset.uploadDate; if (state.upload.dateSelecting === 'end' && state.upload.periodStart) { if (value < state.upload.periodStart) { state.upload.periodEnd = state.upload.periodStart; state.upload.periodStart = value; } else { state.upload.periodEnd = value; } state.upload.dateSelecting = 'start'; } else { state.upload.periodStart = value; state.upload.periodEnd = ''; state.upload.dateSelecting = 'end'; } refreshUploadSubmitState(); render(); }));
  document.querySelector('[data-upload-date-apply]')?.addEventListener('click', () => { if (!state.upload.periodStart || !state.upload.periodEnd) return setToast('请在日历中选择开始和结束日期。', true); state.upload.openMenu = ''; refreshUploadSubmitState(); render(); });
  document.querySelectorAll('[data-upload-select]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); const field = event.currentTarget.dataset.uploadSelect; if (!['storeName', 'type', 'periodKind'].includes(field)) return; state.upload[field] = event.currentTarget.dataset.uploadValue || ''; state.upload.openMenu = ''; render(); }));
  document.querySelector('#report-upload')?.addEventListener('input', () => { syncUploadDraftFromForm(); refreshUploadSubmitState(); });
  document.querySelector('#report-upload')?.addEventListener('change', () => { syncUploadDraftFromForm(); refreshUploadSubmitState(); });
  document.querySelector('#report-file')?.addEventListener('change', async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; try { state.upload.file = file; if (state.upload.mode === 'cloud') { const form = new FormData(); form.append('file', file, file.name); state.upload.preview = await api(`/api/teams/${state.workspace.team.id}/reports/preview`, { method: 'POST', body: form }); } else { const rows = spreadsheetRows(await file.arrayBuffer()); state.upload.preview = { rowCount: rows.length, detectedType: localDetectedType(rows, file.name), period: null }; } const preview = state.upload.preview; if (preview.detectedType) state.upload.type = preview.detectedType; if (preview.period) { state.upload.periodStart = preview.period.start; state.upload.periodEnd = preview.period.end; state.upload.periodKind = periodKindForRange(preview.period.start, preview.period.end); state.upload.calendarMonth = preview.period.start.slice(0, 7); } state.upload.openMenu = ''; render(); } catch (error) { state.upload.file = null; state.upload.preview = null; setToast(error.message, true); } });
  document.querySelector('#report-upload')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const mode = event.currentTarget.dataset.mode; syncUploadDraftFromForm(); const upload = { ...state.upload };
    try {
      if (!upload.file || !upload.type || !upload.storeName || !upload.periodStart || !upload.periodEnd || upload.periodStart > upload.periodEnd) throw new Error('请完成文件预检、店铺、数据表和有效统计日期。');
      const response = await runActivity(mode === 'cloud' ? '正在上传并计算团队报表' : '正在导入并计算本地报表', async () => {
        if (mode === 'local') { await importLocalUpload(); return { message: '本地报表已入库并完成公式计算。' }; }
        const store = state.workspace.stores.find((item) => item.name === upload.storeName); if (!store) throw new Error('云端报表请先在团队管理中新增或选择归属店铺。');
        const form = new FormData(); form.append('file', upload.file, upload.file.name); form.append('storeId', store.id); form.append('type', upload.type); form.append('periodKind', upload.periodKind); form.append('periodStart', upload.periodStart); form.append('periodEnd', upload.periodEnd); form.append('reportDate', upload.periodEnd); form.append('sourceName', upload.sourceName);
        const result = await api(`/api/teams/${state.workspace.team.id}/reports`, { method: 'POST', body: form }); await loadCloudWorkspace(); return result;
      });
      state.modal = ''; setToast(response.message || '报表已上传并参与团队计算。'); render();
    } catch (error) { setToast(error.message, true); }
  });
  document.querySelectorAll('[data-delete-report]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('确认删除这份报表？')) return; try { await runActivity('正在删除报表并重新计算', async () => { if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/reports/${button.dataset.deleteReport}`, { method: 'DELETE' }); await loadCloudWorkspace(); } else { await localDelete(button.dataset.deleteReport); state.localReports = await localReadAll(); } }); state.archiveUi.selectedIds = state.archiveUi.selectedIds.filter((id) => id !== button.dataset.deleteReport); setToast('报表已删除。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-delete-local]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('仅删除此浏览器中的本地副本，确定继续？')) return; await localDelete(button.dataset.deleteLocal); state.localReports = await localReadAll(); render(); }));
  document.querySelector('#export-local')?.addEventListener('click', () => downloadJson(`运营数据本地备份_${new Date().toISOString().slice(0, 10)}.json`, { reports: state.localReports.map(({ rawFile, ...report }) => report), metadata: state.localMeta }));
  document.querySelector('#clear-local')?.addEventListener('click', async () => { if (!window.confirm('将清空当前浏览器的全部本地报表、商品资料和销售扣除。确定继续？')) return; await localClear(); state.localReports = []; state.localMeta = { productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [] }; await localPutMeta(state.localMeta); render(); });
  document.querySelectorAll('[data-trend-toggle]').forEach((button) => button.addEventListener('click', () => { const metricName = button.dataset.trendToggle; state.trendMetrics = state.trendMetrics.includes(metricName) ? (state.trendMetrics.length > 1 ? state.trendMetrics.filter((item) => item !== metricName) : state.trendMetrics) : [...state.trendMetrics, metricName]; render(); }));
  document.querySelectorAll('[data-entity-keyword]').forEach((input) => input.addEventListener('input', (event) => { state.entityUi[event.currentTarget.dataset.entityKeyword].keyword = event.currentTarget.value; render(); }));
  document.querySelectorAll('[data-entity-filter-toggle]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterToggle); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; ui.filterMenu = ui.filterMenu === field ? '' : field; render(); }));
  document.querySelectorAll('[data-entity-filter-query]').forEach((input) => input.addEventListener('input', (event) => { const { kind, key: field } = parseEntityTarget(event.currentTarget.dataset.entityFilterQuery); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); ui[config.query] = event.currentTarget.value; ui.filterMenu = field; renderWithEntityFilterFocus(kind, field, event.currentTarget.selectionStart ?? event.currentTarget.value.length); }));
  document.querySelectorAll('[data-entity-filter-option]').forEach((input) => input.addEventListener('change', (event) => { const { kind, key: field } = parseEntityTarget(event.currentTarget.dataset.entityFilterOption); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); const value = event.currentTarget.value; const current = ui[config.selection] || []; if (ui[config.query].trim()) { ui[config.selection] = event.currentTarget.checked ? [value] : []; ui[config.query] = ''; } else ui[config.selection] = event.currentTarget.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-filter-select-all]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterSelectAll); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); const names = [...document.querySelectorAll(`[data-entity-filter-option="${CSS.escape(`${kind}:${field}`)}"]`)].map((input) => input.value); ui[config.selection] = [...new Set([...(ui[config.selection] || []), ...names])]; ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-filter-clear]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterClear); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); ui[config.selection] = []; ui[config.query] = ''; ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-clear]').forEach((button) => button.addEventListener('click', () => { const ui = state.entityUi[button.dataset.entityClear]; Object.assign(ui, { keyword: '', categories: [], models: [], expanded: '', filterMenu: '', categoryQuery: '', modelQuery: '' }); render(); }));
  document.querySelectorAll('[data-entity-sort]').forEach((button) => button.addEventListener('click', () => { const [kind, key] = button.dataset.entitySort.split(':'); const ui = state.entityUi[kind]; if (ui.sort === key) ui.direction = ui.direction === 'asc' ? 'desc' : 'asc'; else { ui.sort = key; ui.direction = 'desc'; } render(); }));
  document.querySelectorAll('[data-entity-expand]').forEach((button) => button.addEventListener('click', () => { const { kind, key } = parseEntityTarget(button.dataset.entityExpand); const ui = state.entityUi[kind]; if (!ui || !key) return; ui.expanded = ui.expanded === key ? '' : key; render(); }));
  document.querySelectorAll('[data-warehouse-panel]').forEach((button) => button.addEventListener('click', () => { state.warehousePanel = button.dataset.warehousePanel; render(); }));
  document.querySelector('#archive-type')?.addEventListener('change', (event) => { state.archiveUi.type = event.currentTarget.value; state.archiveUi.selectedIds = []; render(); });
  document.querySelector('#archive-store')?.addEventListener('change', (event) => { state.archiveUi.storeName = event.currentTarget.value; state.archiveUi.selectedIds = []; render(); });
  document.querySelectorAll('[data-toggle-report-group]').forEach((button) => button.addEventListener('click', () => { state.archiveUi.expandedDate = state.archiveUi.expandedDate === button.dataset.toggleReportGroup ? '' : button.dataset.toggleReportGroup; render(); }));
  document.querySelectorAll('[data-select-report-group]').forEach((input) => input.addEventListener('change', (event) => { const model = operationsModel(); const ids = groupedWarehouseReports((model.warehouse || []).filter((report) => (state.archiveUi.type === 'all' || report.type === state.archiveUi.type) && (!state.archiveUi.storeName || report.storeName === state.archiveUi.storeName))).find((group) => group.key === event.currentTarget.dataset.selectReportGroup)?.reports.filter((report) => report.status === 'active').map((report) => report.id) || []; const selected = new Set(state.archiveUi.selectedIds); for (const id of ids) { if (event.currentTarget.checked) selected.add(id); else selected.delete(id); } state.archiveUi.selectedIds = [...selected]; render(); }));
  document.querySelectorAll('[data-select-report]').forEach((input) => input.addEventListener('change', (event) => { const selected = new Set(state.archiveUi.selectedIds); if (event.currentTarget.checked) selected.add(event.currentTarget.dataset.selectReport); else selected.delete(event.currentTarget.dataset.selectReport); state.archiveUi.selectedIds = [...selected]; render(); }));
  document.querySelector('[data-clear-archive-selection]')?.addEventListener('click', () => { state.archiveUi.selectedIds = []; render(); });
  document.querySelector('[data-delete-selected-reports]')?.addEventListener('click', async () => { const ids = [...state.archiveUi.selectedIds]; if (!ids.length || !window.confirm(`确认删除已选 ${ids.length} 份报表？`)) return; try { await runActivity(`正在删除 ${ids.length} 份报表并重新计算`, async () => { if (state.mode === 'cloud') { for (const id of ids) await api(`/api/teams/${state.workspace.team.id}/reports/${id}`, { method: 'DELETE' }); await loadCloudWorkspace(); } else { for (const id of ids) await localDelete(id); state.localReports = await localReadAll(); } }); state.archiveUi.selectedIds = []; setToast('已删除选中的报表。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-start-report-name]').forEach((button) => button.addEventListener('click', (event) => { const model = operationsModel(); const report = (model.warehouse || []).find((item) => item.id === event.currentTarget.dataset.startReportName); state.archiveUi.renameId = report?.id || ''; state.archiveUi.renameValue = report?.fileName || ''; render(); }));
  document.querySelector('[data-cancel-report-name]')?.addEventListener('click', () => { state.archiveUi.renameId = ''; state.archiveUi.renameValue = ''; render(); });
  document.querySelectorAll('[data-save-report-name]').forEach((button) => button.addEventListener('click', async (event) => { const id = event.currentTarget.dataset.saveReportName; const value = document.querySelector(`[data-rename-report-input="${CSS.escape(id)}"]`)?.value?.trim(); if (!value) return setToast('请输入归档显示名称。', true); try { if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: value }) }); await loadCloudWorkspace(); } else { const report = state.localReports.find((item) => item.id === id); if (!report) throw new Error('报表不存在。'); await localPut({ ...report, fileName: value }); state.localReports = await localReadAll(); } state.archiveUi.renameId = ''; setToast('归档名称已保存。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelector('#bulk-assign-store')?.addEventListener('click', async () => { const storeId = document.querySelector('#bulk-store-id')?.value; if (!storeId) return setToast('请选择要归属的店铺。', true); try { await runActivity('正在调整报表归属并重新计算', async () => { await api(`/api/teams/${state.workspace.team.id}/reports/bulk-store`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: state.archiveUi.selectedIds, storeId }) }); await loadCloudWorkspace(); }); state.archiveUi.selectedIds = []; setToast('报表归属已批量调整并立即重算。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('[data-toggle-catalog-create]')?.addEventListener('click', () => { state.catalogUi.showCreate = !state.catalogUi.showCreate; render(); });
  document.querySelector('[data-cancel-catalog-create]')?.addEventListener('click', () => { state.catalogUi.showCreate = false; render(); });
  document.querySelector('[data-export-local-catalog]')?.addEventListener('click', async () => { try { await runActivity('正在导出当前商品资料', async () => exportCatalogWorkbook(latestCatalog(state.localMeta.productCatalog || []), `商品资料_${utcDate()}.xlsx`)); setToast('当前商品资料已导出。'); } catch (error) { setToast(error.message, true); } });
  document.querySelector('[data-clear-catalog]')?.addEventListener('click', async () => {
    const model = operationsModel(); const count = latestCatalog(model.core.productCatalog || []).length;
    if (!count || !window.confirm(`确认清空当前团队的 ${count} 条商品资料？这不会删除报表、销售扣除或推广数据。`)) return;
    try {
      await runActivity('正在清空商品资料并重新计算', async () => {
        if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/product-catalog`, { method: 'DELETE' }); await loadCloudWorkspace(); }
        else { state.localMeta = { ...state.localMeta, productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null } }; await localPutMeta(state.localMeta); }
      });
      state.catalogUi.page = 0; setToast('商品资料已清空，商品排行和品类 360 已重新计算。'); render();
    } catch (error) { setToast(error.message, true); }
  });
  document.querySelector('#catalog-file')?.addEventListener('change', (event) => { state.catalogUi.file = event.currentTarget.files?.[0] || null; render(); });
  document.querySelector('#catalog-import')?.addEventListener('click', async () => { const file = state.catalogUi.file; if (!file) return; try { await runActivity('正在导入商品资料并重新计算', async () => { if (state.mode === 'cloud') { const form = new FormData(); form.append('file', file, file.name); await api(`/api/teams/${state.workspace.team.id}/product-catalog/import`, { method: 'POST', body: form }); await loadCloudWorkspace(); } else { const rows = spreadsheetRows(await file.arrayBuffer()); const entries = rows.map((row) => ({ storeName: String(rowValue(row, ALIASES.storeName) || '').trim(), productId: String(rowValue(row, ALIASES.productId) || '').trim(), category: String(rowValue(row, ALIASES.category) || '').trim(), model: String(rowValue(row, ALIASES.model || []) || '').trim() })).filter((entry) => entry.productId && (entry.category || entry.model)).map((entry) => ({ ...entry, id: `catalog_${crypto.randomUUID()}`, sourceName: file.name, createdAt: new Date().toISOString() })); if (!entries.length) throw new Error('未识别到有效商品 ID。请确认表头包含店铺名、商品ID、品类名或型号。'); state.localMeta = { ...state.localMeta, productCatalog: [...(state.localMeta.productCatalog || []), ...entries], productCatalogSource: { fileName: file.name, updatedAt: new Date().toISOString() } }; await localPutMeta(state.localMeta); } }); state.catalogUi.file = null; setToast('商品资料已更新，商品排行和品类 360 已立即重算。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#catalog-manual')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const entry = { storeName: String(form.get('storeName') || '').trim(), productId: String(form.get('productId') || '').trim(), category: String(form.get('category') || '').trim(), model: String(form.get('model') || '').trim() };
    if (!entry.storeName || !entry.productId || !entry.category || !entry.model) return setToast('请按顺序填写店铺、商品 ID、品类和型号。', true);
    const existing = latestCatalog(operationsModel().core.productCatalog || []).some((current) => catalogKey(current) === catalogKey(entry));
    if (existing) return setToast('该店铺下的商品 ID 已存在，请勿重复新增。', true);
    try {
      await runActivity('正在保存商品资料', async () => {
        if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/product-catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) }); await loadCloudWorkspace(); }
        else { state.localMeta = { ...state.localMeta, productCatalog: [...(state.localMeta.productCatalog || []), { ...entry, id: `catalog_${crypto.randomUUID()}`, sourceName: '网页手工维护', createdAt: new Date().toISOString() }] }; await localPutMeta(state.localMeta); }
      });
      state.catalogUi.showCreate = false; state.catalogUi.page = 0; setToast('商品已新增，商品排行和品类 360 已重新计算。'); render();
    } catch (error) { setToast(error.message, true); }
  });
  document.querySelectorAll('[data-catalog-page]').forEach((button) => button.addEventListener('click', () => { state.catalogUi.page = Math.max(0, state.catalogUi.page + (button.dataset.catalogPage === 'next' ? 1 : -1)); render(); }));
  document.querySelector('#sales-deduction-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const deduction = { storeName: String(form.get('storeName') || ''), reportDate: String(form.get('reportDate') || ''), amount: Number(form.get('amount')), note: String(form.get('note') || '').trim() }; if (!deduction.storeName || !deduction.reportDate || !Number.isFinite(deduction.amount) || deduction.amount <= 0) return setToast('请填写完整的销售扣除信息。', true); try { if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/sales-deductions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deduction) }); await loadCloudWorkspace(); } else { state.localMeta = { ...state.localMeta, salesDeductions: [...(state.localMeta.salesDeductions || []), { ...deduction, id: `deduction_${crypto.randomUUID()}`, createdAt: new Date().toISOString() }] }; await localPutMeta(state.localMeta); } setToast('销售扣除已保存，整店指标已重新计算。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-delete-deduction]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('删除这笔销售扣除？')) return; try { const id = button.dataset.deleteDeduction; if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/sales-deductions/${id}`, { method: 'DELETE' }); await loadCloudWorkspace(); } else { state.localMeta = { ...state.localMeta, salesDeductions: (state.localMeta.salesDeductions || []).filter((item) => item.id !== id) }; await localPutMeta(state.localMeta); } setToast('销售扣除已删除，经营指标已恢复计算。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelector('[data-open-deductions]')?.addEventListener('click', () => { state.activePanel = 'warehouse'; state.warehousePanel = 'deductions'; render(); });
  document.querySelector('#create-team')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const result = await api('/api/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), plan: form.get('plan') }) }); state.session = result.user; openOperationsHome(); await bootstrap(); setToast('团队已创建，已进入运营数据。'); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#accept-invite')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const result = await api('/api/auth/invitations/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: form.get('code') }) }); state.session = result.user; openOperationsHome(); await bootstrap(); setToast('已加入团队，已进入运营数据。'); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#add-store')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); await api(`/api/admin/teams/${state.team.team.id}/stores`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name') }) }); await loadTeam(); await loadCloudWorkspace(); setToast('店铺已新增。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#create-invite')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const result = await api(`/api/teams/${state.team.team.id}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: form.get('label') || '团队成员邀请', expiresInDays: Number(form.get('expiresInDays') || 7) }) }); state.copiedCode = result.code; await loadTeam(); setToast('邀请码已生成，已保存到列表。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#copy-invite')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.copiedCode); setToast('邀请码已复制。'); } catch { setToast('复制失败，请手动复制邀请码。', true); } });
  document.querySelector('#create-device-code')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const storeIds = form.getAll('storeIds'); if (!storeIds.length) throw new Error('请选择至少一个可同步店铺。'); const result = await api(`/api/admin/teams/${state.team.team.id}/codes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: form.get('label') || '团队同步授权', mode: form.get('mode'), expiresInDays: Number(form.get('expiresInDays') || 7), storeIds }) }); state.deviceCode = result.code; await loadTeam(); setToast('同步授权码已生成，已保存到列表。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#copy-device-code')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.deviceCode); setToast('同步授权码已复制。'); } catch { setToast('复制失败，请手动复制同步授权码。', true); } });  document.querySelectorAll('[data-copy-managed-code]').forEach((button) => button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(button.dataset.copyManagedCode || ''); setToast('授权码已复制。'); } catch { setToast('复制失败，请手动复制授权码。', true); } }));
  document.querySelector('#refresh-devices')?.addEventListener('click', async () => { try { await runActivity('正在检查已连接设备', loadTeam); setToast(`已识别 ${(state.team?.devices || []).filter((device) => !device.revokedAt).length} 台设备。`); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-revoke-invitation]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm(`撤销邀请码“${button.dataset.invitationName}”？已加入的成员不会受影响。`)) return; try { await api(`/api/teams/${state.team.team.id}/invitations/${button.dataset.revokeInvitation}`, { method: 'DELETE' }); await loadTeam(); setToast('邀请码已撤销。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-revoke-device-code]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm(`撤销同步授权码“${button.dataset.deviceCodeName}”？已连接的桌面应用将无法继续同步。`)) return; try { await api(`/api/admin/teams/${state.team.team.id}/codes/${button.dataset.revokeDeviceCode}`, { method: 'DELETE' }); await loadTeam(); setToast('同步授权码已撤销。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelector('#new-platform-team')?.addEventListener('click', () => { state.modal = 'platform-team'; render(); });
  document.querySelector('#platform-team-form')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const result = await api('/api/admin/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), plan: form.get('plan'), memberLimit: Number(form.get('memberLimit')) }) }); selectTeam(result.team.id); state.modal = ''; state.page = 'team'; await Promise.all([loadOverview(), loadCloudWorkspace(), loadTeam()]); setToast('店铺团队已创建，已进入团队管理。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#team-back-platform')?.addEventListener('click', async () => { state.page = 'platform'; await loadOverview(); render(); });
  document.querySelector('#team-creation-toggle')?.addEventListener('change', async (event) => { try { const result = await api('/api/admin/platform/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowTeamCreation: event.currentTarget.checked }) }); state.platformSettings = result.platform; await loadOverview(); setToast(result.message); render(); } catch (error) { event.currentTarget.checked = !event.currentTarget.checked; setToast(error.message, true); } });
  document.querySelector('#update-team-settings')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); const quotaGb = Number(form.get('storageQuotaGb')); await api(`/api/admin/teams/${state.team.team.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), plan: form.get('plan'), memberLimit: Number(form.get('memberLimit')), storageQuotaBytes: Math.round(quotaGb * 1024 ** 3) }) }); await Promise.all([loadOverview(), loadTeam(), loadCloudWorkspace()]); setToast('团队人数上限与设置已保存。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#add-existing-member')?.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const userId = String(form.get('userId') || ''); const account = (state.team.memberDirectory || []).find((member) => member.id === userId); if (!account) { setToast('请选择一个尚未加入当前团队的已有账号。', true); return; } try { const currentTeamId = state.team.team.id; const teamIds = [...new Set([...(account.memberships || []).filter((membership) => membership.status === 'active' && membership.teamStatus === 'active').map((membership) => membership.teamId), currentTeamId])]; await api(`/api/admin/members/${encodeURIComponent(userId)}/team-access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamIds, currentTeamId, currentRole: 'member', currentNote: '' }) }); await Promise.all([loadTeam(), loadOverview()]); setToast('已有账号已加入当前团队。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#create-team-admin')?.addEventListener('submit', async (event) => { event.preventDefault(); try { const form = new FormData(event.currentTarget); await api(`/api/admin/teams/${state.team.team.id}/admins`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); await loadTeam(); setToast('团队管理员已新增。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-rename-store]').forEach((button) => button.addEventListener('click', async () => { const name = window.prompt('输入新的店铺名称', button.dataset.storeName); if (!name || name.trim() === button.dataset.storeName) return; try { await api(`/api/admin/teams/${state.team.team.id}/stores/${button.dataset.renameStore}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await Promise.all([loadTeam(), loadCloudWorkspace()]); setToast('店铺名称已更新。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-delete-store]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm(`移除店铺“${button.dataset.storeName}”？历史报表会保留原店铺名称。`)) return; try { await api(`/api/admin/teams/${state.team.team.id}/stores/${button.dataset.deleteStore}`, { method: 'DELETE' }); await Promise.all([loadOverview(), loadTeam(), loadCloudWorkspace()]); setToast('店铺已移除。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-suspend-team]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('封禁后，该团队所有成员和管理员会立即退出且无法重新登录。确定封禁？')) return; try { const result = await api(`/api/admin/teams/${button.dataset.suspendTeam}/suspend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }); state.workspace = null; await Promise.all([loadOverview(), activeTeamId() === button.dataset.suspendTeam ? loadTeam() : Promise.resolve()]); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-activate-team]').forEach((button) => button.addEventListener('click', async () => { try { const result = await api(`/api/admin/teams/${button.dataset.activateTeam}/activate`, { method: 'POST' }); if (activeTeamId() === button.dataset.activateTeam) await Promise.all([loadOverview(), loadTeam(), loadCloudWorkspace()]); else await loadOverview(); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-delete-team]').forEach((button) => button.addEventListener('click', async () => { const confirmName = window.prompt(`永久删除“${button.dataset.teamName}”。请输入完整团队名称确认：`); if (confirmName !== button.dataset.teamName) { if (confirmName !== null) setToast('团队名称不匹配，未删除。', true); return; } try { const result = await api(`/api/admin/teams/${button.dataset.deleteTeam}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName }) }); if (state.selectedTeamId === button.dataset.deleteTeam) { selectTeam(''); state.workspace = null; state.team = null; state.page = 'platform'; } await loadOverview(); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelector('#dissolve-team')?.addEventListener('click', async (event) => { const button = event.currentTarget; const confirmName = window.prompt(`解散“${button.dataset.teamName}”会永久删除团队数据。请输入完整团队名称确认：`); if (confirmName !== button.dataset.teamName) { if (confirmName !== null) setToast('团队名称不匹配，未解散。', true); return; } try { const result = await api(`/api/teams/${button.dataset.teamId}/dissolve`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName }) }); state.session = result.user; state.workspace = null; state.team = null; openOperationsHome(); await bootstrap(); setToast(result.message); } catch (error) { setToast(error.message, true); } });
  document.querySelector('#leave-team')?.addEventListener('click', async () => { if (!window.confirm('确认退出当前团队？你的账号会保留，但将无法查看该团队数据。')) return; try { const result = await api(`/api/teams/${state.session.teamId}/leave`, { method: 'POST' }); state.session = result.user; state.workspace = null; state.team = null; openOperationsHome(); await bootstrap(); setToast(result.message); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-save-member]').forEach((button) => button.addEventListener('click', async () => {
    const userId = button.dataset.saveMember;
    const row = button.closest('.member-editor');
    const note = row?.querySelector(`[data-member-note="${CSS.escape(userId)}"]`)?.value || '';
    const role = row?.querySelector(`[data-member-role="${CSS.escape(userId)}"]`)?.value || 'member';
    const teamIds = [...(row?.querySelectorAll(`[data-member-access="${CSS.escape(userId)}"]:checked`) || [])].map((input) => input.value);
    const currentTeamId = state.team.team.id;
    const isPlatformAdmin = state.session?.role === 'platform-admin';
    try {
      if (isPlatformAdmin && !teamIds.includes(currentTeamId)) throw new Error('当前店铺必须保持勾选；如需移出当前店铺，请使用本行“移出”。');
      button.disabled = true; button.textContent = '保存中';
      const result = isPlatformAdmin
        ? await api(`/api/admin/members/${encodeURIComponent(userId)}/team-access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamIds, currentTeamId, currentRole: role, currentNote: note }) })
        : await api(`/api/admin/members/${encodeURIComponent(userId)}/membership`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: currentTeamId, role, note }) });
      state.teamDraft.members[userId] = { note, role, teamIds: isPlatformAdmin ? teamIds : [currentTeamId] };
      await Promise.all([loadTeam(), isPlatformAdmin ? loadOverview() : Promise.resolve()]);
      setToast(result.message || '成员权限已保存。');
    } catch (error) { setToast(error.message, true); }
  }));
  document.querySelectorAll('[data-suspend-member]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('停用后该成员会立即退出当前团队，确定继续？')) return; try { const result = await runActivity('正在停用当前团队成员', () => api(`/api/admin/teams/${state.team.team.id}/members/${button.dataset.suspendMember}/suspend`, { method: 'POST' })); await loadTeam(); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-activate-member]').forEach((button) => button.addEventListener('click', async () => { try { const result = await runActivity('正在恢复当前团队成员', () => api(`/api/admin/teams/${state.team.team.id}/members/${button.dataset.activateMember}/activate`, { method: 'POST' })); await loadTeam(); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-delete-member]').forEach((button) => button.addEventListener('click', async () => { const confirmUsername = window.prompt(`将成员“${button.dataset.memberName}”移出当前团队，账号和其他团队关系会保留。请输入完整账号确认：`); if (confirmUsername !== button.dataset.memberName) { if (confirmUsername !== null) setToast('账号不匹配，未移出团队。', true); return; } try { const result = await runActivity('正在移出团队成员', () => api(`/api/admin/teams/${state.team.team.id}/members/${button.dataset.deleteMember}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmUsername }) })); await loadTeam(); setToast(result.message); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-open-team]').forEach((button) => button.addEventListener('click', async () => { try { selectTeam(button.dataset.openTeam); state.page = button.dataset.openPage || 'operations'; await loadTeam(); if (state.page === 'operations') { try { await loadCloudWorkspace(); } catch (error) { state.workspace = null; state.page = 'team'; setToast('该团队已封禁，当前只能进入团队管理。', true); } } else { state.workspace = null; } render(); } catch (error) { setToast(error.message, true); } }));
}

try { await loadPublicSettings(); } catch { state.platformSettings = { allowTeamCreation: true }; }
try { const session = await api('/api/session'); state.session = session.user; } catch { state.session = null; }
await bootstrap();
