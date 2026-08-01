import { buildOperationsWorkspace } from '/operationsCore.js?v=20260801-auto-comparison-8';

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
  toast: null, activity: null, modal: '', activePanel: 'overview', warehousePanel: 'upload', authMode: 'login', authDraft: { username: '', email: '', password: '', inviteCode: '' }, authFeedback: null, authBusy: '', bootstrapError: '', copiedCode: '', deviceCode: '', selectedTeamId: window.sessionStorage.getItem(SELECTED_TEAM_KEY) || '', teamMenuOpen: false, platformSettings: { allowTeamCreation: true },
  trendMetrics: ['revenue'], entityUi: { category: { keyword: '', categories: [], models: [], sort: 'revenue', direction: 'desc', expanded: '', scrollTop: 0, filterMenu: '', categoryQuery: '', modelQuery: '' }, product: { keyword: '', categories: [], models: [], sort: 'revenue', direction: 'desc', expanded: '', scrollTop: 0, filterMenu: '', categoryQuery: '', modelQuery: '' } },
  archiveUi: { selectedIds: [], expandedStore: null, expandedDate: '', type: 'all', storeName: '', renameId: '', renameValue: '' },
  upload: { mode: '', files: [], activeId: '', storeName: '', sourceName: '', openMenu: '', dateSelecting: 'start', calendarMonth: '', status: 'idle', progress: 0, error: '' },
  catalogUi: { file: null, page: 0, showCreate: false, selectedIds: [], bulkStoreName: '', bulkCategory: '', bulkModel: '' },
  cardUi: { openPanel: '' },
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
function metric(label, value, detail, tone = '', comparison = '', trendId = '') {
  const selected = trendId && state.trendMetrics.includes(trendId);
  const tag = trendId ? 'button' : 'article';
  const attributes = trendId ? ` type="button" data-trend-toggle="${escape(trendId)}" aria-pressed="${selected}" title="点击${selected ? '取消' : '加入'}经营趋势"` : '';
  return `<${tag}${attributes} class="metric-card ${tone}${trendId ? ` trend-toggle-card${selected ? ' selected' : ''}` : ''}"><span>${escape(label)}</span><div class="metric-value-row"><strong>${value}</strong>${comparison ? `<div class="metric-comparisons">${comparison}</div>` : ''}</div><small>${escape(detail)}</small></${tag}>`;
}
const CUSTOM_METRICS = [
  ['grossRevenue', '支付金额', 'money', '退款前支付金额'], ['refundAmount', '成功退款金额', 'money', '售中售后成功退款'],
  ['revenue', '净 GSV', 'money', '支付金额 - 成功退款'], ['spend', '推广花费', 'money', '当前口径推广消耗'],
  ['promotionRevenue', '推广成交', 'money', '推广平台归因成交'], ['managementRoi', '经营 ROI', 'ratio', '净 GSV ÷ 推广花费'],
  ['roi', '推广 ROI', 'ratio', '推广成交 ÷ 推广花费'], ['feeRate', '推广费率', 'percent', '推广花费 ÷ 净 GSV'],
  ['visitors', '访客数', 'number', '经营报表访客'], ['paidBuyers', '支付买家数', 'number', '完成支付的买家'],
  ['conversionRate', '支付转化率', 'percent', '支付买家数 ÷ 访客数'], ['clicks', '点击量', 'number', '推广点击量'],
  ['impressions', '展现量', 'number', '推广展现量'], ['orders', '推广订单', 'number', '推广归因订单'],
  ['pageViews', '浏览量', 'number', '经营报表浏览量'], ['favorites', '收藏人数', 'number', '收藏商品人数'],
  ['cartUsers', '加购人数', 'number', '加入购物车人数'], ['cartItems', '加购件数', 'number', '加入购物车商品件数'], ['paidItems', '支付件数', 'number', '支付商品件数'],
  ['cpc', '平均点击花费', 'money', '推广花费 ÷ 点击量'], ['costPerCollectCart', '收藏加购成本', 'money', '推广花费 ÷ 加购人数'],
].map(([id, label, kind, description]) => ({ id, label, kind, description }));
const COMPARISON_OPTIONS = [['day', '日环比'], ['week', '周环比'], ['last7', '近 7 天'], ['last15', '近 15 天'], ['month', '月环比'], ['custom', '区间环比']].map(([id, label]) => ({ id, label }));
function customCardStorageKey(panel) { return `operations-custom-cards-v1:${state.session?.username || 'anonymous'}:${activeTeamId() || state.mode}:${panel}`; }
function loadCustomCards(panel) { try { const value = JSON.parse(localStorage.getItem(customCardStorageKey(panel)) || '[]'); return Array.isArray(value) ? value.slice(0, 6) : []; } catch { return []; } }
function saveCustomCards(panel, cards) { localStorage.setItem(customCardStorageKey(panel), JSON.stringify(cards.slice(0, 6))); }
function automaticComparisonId(preset) {
  if (preset === 'last-7-days') return 'last7';
  if (preset === 'last-15-days') return 'last15';
  if (preset === 'this-week' || preset === 'last-week') return 'week';
  if (preset === 'this-month' || preset === 'last-month') return 'month';
  if (preset === 'custom') return 'custom';
  return 'day';
}
function customMetricDefinition(id) { return CUSTOM_METRICS.find((item) => item.id === id) || CUSTOM_METRICS[0]; }
function customMetricTotals(rows = []) {
  const total = (key) => rows.reduce((sum, row) => sum + (Number(row?.[key] ?? row?.sales?.[key] ?? row?.promotion?.[key]) || 0), 0);
  const revenue = total('revenue'); const spend = total('spend'); const visitors = total('visitors'); const paidBuyers = total('paidBuyers'); const clicks = total('clicks'); const cartUsers = total('cartUsers');
  const rateAvailable = rows.length > 0 && rows.every((row) => Number(row.salesCount) > 0 && Number(row.promotionCount) > 0 && row.refundDataAvailable === true && row.promotionCoverageComplete === true);
  return {
    grossRevenue: total('grossRevenue'), refundAmount: total('refundAmount'), revenue, spend, promotionRevenue: total('promotionRevenue'),
    visitors, paidBuyers, clicks, impressions: total('impressions'), orders: total('orders'), pageViews: total('pageViews'), favorites: total('favorites'), cartUsers, cartItems: total('cartItems'), paidItems: total('paidItems'),
    managementRoi: rateAvailable && spend > 0 ? revenue / spend : null,
    roi: spend > 0 ? total('promotionRevenue') / spend : null,
    feeRate: rateAvailable && revenue > 0 ? spend / revenue : null,
    conversionRate: visitors > 0 ? paidBuyers / visitors : null,
    cpc: clicks > 0 ? spend / clicks : null,
    costPerCollectCart: cartUsers > 0 ? spend / cartUsers : null,
  };
}
function customMetricValue(rows, metricId) { return customMetricTotals(rows)[metricId]; }
function cardMetricValue(rows, metricId) {
  if (metricId === 'linkedCount') return rows.filter((row) => Number(row.salesCount) > 0 && Number(row.promotionCount) > 0).length;
  if (metricId === 'salesOnlyCount') return rows.filter((row) => Number(row.salesCount) > 0 && Number(row.promotionCount) <= 0).length;
  if (metricId === 'promotionOnlyCount') return rows.filter((row) => Number(row.salesCount) <= 0 && Number(row.promotionCount) > 0).length;
  return customMetricValue(rows, metricId);
}
function formatCustomMetric(metricId, value) { const definition = customMetricDefinition(metricId); if (!hasNumber(value)) return '--'; if (definition.kind === 'money') return money(value); if (definition.kind === 'percent') return percent(value); if (definition.kind === 'ratio') return fmtNumber(value); return fmtNumber(value, 0); }
function customComparisonTone(delta) { if (!Number.isFinite(delta) || delta === 0) return 'neutral'; return delta > 0 ? 'comparison-up' : 'comparison-down'; }
function customComparisonRows(panel, comparison, side, visibleRows) {
  const snapshot = comparison?.[side]; if (!snapshot) return [];
  if (panel === 'store') return snapshot.store ? [snapshot.store] : [];
  const source = panel === 'category' ? snapshot.categories || [] : snapshot.products || [];
  const identities = new Set(visibleRows.flatMap((row) => [row.key, row.productId, row.name, `${row.category || ''}\u0000${row.model || ''}`].filter(Boolean)));
  return source.filter((row) => panel === 'category' ? identities.has(row.key) || identities.has(row.name) : identities.has(row.key) || identities.has(row.productId) || identities.has(`${row.category || ''}\u0000${row.model || ''}`));
}
function comparisonBadges(panel, metricId, comparisonIds, visibleRows) {
  const comparisons = operationsModel()?.core?.dashboard?.comparisons || {};
  const definition = customMetricDefinition(metricId);
  return (comparisonIds || []).map((id) => {
    const comparison = comparisons[id]; const currentRows = customComparisonRows(panel, comparison, 'current', visibleRows); const previousRows = customComparisonRows(panel, comparison, 'previous', visibleRows);
    const available = comparison?.currentAvailable && comparison?.previousAvailable && currentRows.length && previousRows.length;
    const current = available ? cardMetricValue(currentRows, metricId) : null; const previous = available ? cardMetricValue(previousRows, metricId) : null;
    const delta = hasNumber(current) && hasNumber(previous) ? Number(current) - Number(previous) : null; const relative = delta !== null && Number(previous) !== 0 ? delta / Math.abs(Number(previous)) : null;
    const label = comparison?.label || COMPARISON_OPTIONS.find((item) => item.id === id)?.label || id;
    if (delta === null) return `<span class="comparison-badge unavailable" title="当前或同期报表不完整">${escape(label)} 暂无</span>`;
    const display = relative === null ? (delta === 0 ? '持平' : '新增') : definition.kind === 'percent' ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp · ${relative >= 0 ? '+' : ''}${(relative * 100).toFixed(1)}%` : `${relative >= 0 ? '+' : ''}${(relative * 100).toFixed(1)}%`;
    return `<span class="comparison-badge ${customComparisonTone(delta)}" title="${escape(`${comparison.currentStart} 至 ${comparison.currentEnd} 对比 ${comparison.previousStart} 至 ${comparison.previousEnd}`)}">${escape(label)} ${display}</span>`;
  }).join('');
}
function managedMetricGrid(panel, coreCards, visibleRows) {
  const customCards = loadCustomCards(panel); const comparisonId = automaticComparisonId(state.datePreset);
  const coreHtml = coreCards.map((card) => metric(card.label, card.value, card.detail, card.tone, comparisonBadges(panel, card.metricId, [comparisonId], visibleRows))).join('');
  const customHtml = customCards.map((card) => { const definition = customMetricDefinition(card.metricId); const tone = ['revenue', 'paidBuyers', 'conversionRate', 'paidItems'].includes(card.metricId) ? 'mint' : ['spend', 'promotionRevenue', 'clicks', 'cpc'].includes(card.metricId) ? 'blue' : ['managementRoi', 'roi', 'cartUsers', 'cartItems'].includes(card.metricId) ? 'orange' : ['feeRate', 'refundAmount'].includes(card.metricId) ? 'purple' : ''; return metric(definition.label, formatCustomMetric(card.metricId, customMetricValue(visibleRows, card.metricId)), definition.description, tone, comparisonBadges(panel, card.metricId, [comparisonId], visibleRows), panel === 'store' ? card.metricId : ''); }).join('');
  return `<div class="managed-metric-grid"><button class="metric-settings-button" data-card-settings="${panel}" title="设置指标卡片" aria-label="设置指标卡片">⚙</button><div class="metrics-grid dashboard-metrics">${coreHtml}${customHtml}</div></div>`;
}
function customCardSettingsModal() {
  const panel = state.cardUi.openPanel; if (!panel) return ''; const cards = loadCustomCards(panel); const used = new Set(cards.map((card) => card.metricId)); const panelLabel = panel === 'store' ? '整店总览' : panel === 'category' ? '品类 360' : '商品排行'; const comparisonId = automaticComparisonId(state.datePreset); const comparisonLabel = COMPARISON_OPTIONS.find((option) => option.id === comparisonId)?.label || '日环比';
  const customRows = cards.map((card, index) => `<section class="custom-card-editor" data-card-id="${escape(card.id)}"><div><span>自定义 ${index + 1}</span><select data-card-metric="${escape(card.id)}">${CUSTOM_METRICS.map((item) => `<option value="${item.id}" ${item.id === card.metricId ? 'selected' : ''} ${item.id !== card.metricId && used.has(item.id) ? 'disabled' : ''}>${escape(item.label)} · ${escape(item.description)}</option>`).join('')}</select><button class="btn text tiny" data-card-delete="${escape(card.id)}">删除</button></div></section>`).join('');
  return `<div class="modal custom-card-modal"><section class="modal-card"><header class="modal-head"><div><h3>${panelLabel}指标卡片</h3><p>环比跟随当前统计范围自动计算；自定义卡片从数据表全部可计算字段中新增。</p></div><button class="btn text" data-close-card-settings>关闭</button></header><div class="modal-body"><section class="custom-card-global automatic-comparison"><div><strong>环比已自动匹配：${escape(comparisonLabel)}</strong><small>切换今天、周、月、近 7 日、近 15 日或自定义区间后，全部卡片会立即按对应公式重算。</small></div></section><div class="card-settings-section"><h4>自定义数据卡片</h4><p>经营表与推广表全部可计算指标，最多新增 6 张且不可重复。整店卡片可直接点击加入经营趋势。</p><div class="custom-card-editors">${customRows}</div><button class="btn secondary card-add-button" data-add-custom-card ${cards.length >= 6 ? 'disabled' : ''}>${cards.length >= 6 ? '已达到 6 张上限' : '＋ 从数据表新增指标卡片'}</button></div></div><footer class="modal-actions"><button class="btn primary" data-close-card-settings>完成</button></footer></section></div>`;
}
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
  if (preset === 'last-7-days') { const end = addDays(today, -1); return { start: addDays(end, -6), end }; }
  if (preset === 'last-15-days') { const end = addDays(today, -1); return { start: addDays(end, -14), end }; }
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
function entityCategory(row, kind) { return row.category || (kind === 'category' ? row.name : '品类待补'); }
function entityModel(row) { return row.model || '型号待补'; }
function entitySourceRows(kind) {
  const dashboard = operationsModel()?.core?.dashboard;
  return dashboard?.[kind === 'product' ? 'products' : 'categories'] || [];
}
function entityFilterOptions(kind, field, rows, linked = true) {
  const ui = entityUi(kind); let source = rows || [];
  if (linked && kind === 'product') {
    if (field === 'model' && ui.categories.length) {
      const categories = new Set(ui.categories);
      source = source.filter((row) => categories.has(entityCategory(row, kind)));
    }
    if (field === 'category' && ui.models.length) {
      const models = new Set(ui.models);
      source = source.filter((row) => models.has(entityModel(row)));
    }
  }
  return field === 'model'
    ? (kind === 'product' ? uniqueSorted(source.map(entityModel)) : [])
    : uniqueSorted(source.map((row) => entityCategory(row, kind)));
}
function normalizeEntitySelectionsToRows(kind, rows) {
  const ui = entityUi(kind);
  for (const field of ['category', 'model']) {
    const config = entityFilterConfig(field); const allowed = new Set(entityFilterOptions(kind, field, rows, false));
    ui[config.selection] = (ui[config.selection] || []).filter((value) => allowed.has(value));
  }
}
function normalizeEntityLinkedSelection(kind, changedField, rows = entitySourceRows(kind)) {
  if (kind !== 'product') return;
  const oppositeField = changedField === 'category' ? 'model' : 'category';
  const oppositeConfig = entityFilterConfig(oppositeField);
  const allowed = new Set(entityFilterOptions(kind, oppositeField, rows));
  entityUi(kind)[oppositeConfig.selection] = (entityUi(kind)[oppositeConfig.selection] || []).filter((value) => allowed.has(value));
}
function entityFilterMenu(kind, field, options, totalCount = options.length) {
  const ui = entityUi(kind); const config = entityFilterConfig(field); const query = ui[config.query] || '';
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN'); const visible = normalizedQuery ? options.filter((name) => name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : options;
  const chosen = ui[config.selection] || []; const isOpen = ui.filterMenu === field;
  const label = chosen.length ? `已选 ${chosen.length} 个${config.label}` : `选择${config.label}`;
  const oppositeSelection = field === 'category' ? ui.models : ui.categories; const linked = kind === 'product' && oppositeSelection.length > 0;
  return `<div class="entity-filter entity-filter-${field}"><button class="entity-filter-trigger ${isOpen ? 'active' : ''}" data-entity-filter-toggle="${kind}:${field}" aria-expanded="${isOpen}"><span>${label}${linked ? `<em class="entity-filter-linked">联动 · ${options.length} 可选</em>` : ''}</span><i>${isOpen ? '▴' : '▾'}</i></button>${isOpen ? `<section class="entity-filter-panel" data-entity-filter-panel="${kind}:${field}"><label class="entity-filter-search"><span>搜索</span><input data-entity-filter-query="${kind}:${field}" value="${escape(query)}" placeholder="搜索${config.label}" autocomplete="off" /></label><div class="entity-filter-actions"><button data-entity-filter-select-all="${kind}:${field}">全选</button><button data-entity-filter-clear="${kind}:${field}">清空</button><small>${visible.length} / ${options.length}${linked ? ` · 全部 ${totalCount}` : ''}</small></div><div class="entity-filter-options">${visible.length ? visible.map((name) => `<label><input type="checkbox" data-entity-filter-option="${kind}:${field}" value="${escape(name)}" ${selected(chosen, name) ? 'checked' : ''}/><span>${escape(name)}</span></label>`).join('') : `<p class="empty">${linked ? '当前联动条件下无可选项' : '没有匹配的选项'}</p>`}</div></section>` : ''}</div>`;
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
function feeRateTone(value) {
  if (!hasNumber(value)) return 'neutral';
  if (Number(value) <= 0.08) return 'good';
  if (Number(value) <= 0.12) return 'warn';
  return 'high';
}
function entityComparisonChart(rows, kind) {
  const ranked = [...(rows || [])]
    .filter((row) => (Number(row.revenue) || 0) > 0 || (Number(row.spend) || 0) > 0)
    .sort((left, right) => (Number(right.revenue) || 0) - (Number(left.revenue) || 0) || (Number(right.spend) || 0) - (Number(left.spend) || 0))
    .slice(0, 10);
  if (!ranked.length) return '';
  const maxRevenue = Math.max(1, ...ranked.map((row) => Number(row.revenue) || 0));
  const maxSpend = Math.max(1, ...ranked.map((row) => Number(row.spend) || 0));
  const width = (value, max) => `${Math.max(0, Math.min(100, (Number(value) || 0) / max * 100)).toFixed(2)}%`;
  const label = kind === 'product' ? '单品' : '品类';
  return `<section class="entity-comparison"><header><div><span>TOP 10 · 净 GSV 排名</span><h4>${label}销售与推广花费</h4></div><div class="entity-chart-legend"><i class="revenue"></i><span>净 GSV</span><i class="spend"></i><span>推广花费</span></div></header><div class="entity-bar-list">${ranked.map((row, index) => {
    const primary = kind === 'product' ? row.model || row.name || '--' : row.name || '--';
    const secondary = kind === 'product' && row.model ? `${row.productId || '--'} · ${row.name || '--'}` : kind === 'product' ? row.productId || '--' : `${row.promotionChannels?.length || 0} 类推广`;
    const rate = calculatedPromotion(row).feeRate;
    return `<article class="entity-bar-row" title="${escape(row.name || primary)}"><div class="entity-bar-label"><i>${String(index + 1).padStart(2, '0')}</i><span><strong>${escape(primary)}</strong><small>${escape(secondary)}</small></span></div><div class="entity-bar-pair"><div><span>净 GSV</span><b class="entity-bar-track"><i class="revenue" style="--bar-width:${width(row.revenue, maxRevenue)}"></i></b><em>${money(row.revenue)}</em></div><div><span>花费</span><b class="entity-bar-track"><i class="spend" style="--bar-width:${width(row.spend, maxSpend)}"></i></b><em>${money(row.spend)}</em></div></div><div class="entity-bar-rate"><span>推广费率</span><b class="fee-rate ${feeRateTone(rate)}">${percent(rate)}</b></div></article>`;
  }).join('')}</div><footer><span>销售柱与花费柱分别按各自最高值缩放</span><b>${ranked.length} / ${rows.length} 项</b></footer></section>`;
}
function categoryContributionPanel(rows) {
  const active = [...(rows || [])].filter((row) => (Number(row.revenue) || 0) > 0 || (Number(row.spend) || 0) > 0);
  if (!active.length) return '';
  const totals = sumRows(active);
  const totalRevenue = totals.revenue;
  const totalSpend = totals.spend;
  const ranked = active.sort((left, right) => (Number(right.revenue) || 0) - (Number(left.revenue) || 0) || (Number(right.spend) || 0) - (Number(left.spend) || 0)).slice(0, 10);
  const share = (value, total) => total > 0 ? Math.max(0, Math.min(1, (Number(value) || 0) / total)) : 0;
  const maxRevenue = Math.max(1, ...ranked.map((row) => Number(row.revenue) || 0));
  const maxSpend = Math.max(1, ...ranked.map((row) => Number(row.spend) || 0));
  const scale = (value, max) => Math.max(0, Math.min(1, (Number(value) || 0) / max));
  return `<article class="card category-contribution"><header class="section-head contribution-title"><div><span class="section-kicker">经营结构</span><h3>类目销售贡献与推广效率</h3><p>按净 GSV 从高到低，金额、占比和费率均使用当前筛选范围。</p></div><dl class="contribution-totals"><div><dt>已关联类目净 GSV</dt><dd>${money(totalRevenue)}</dd></div><div><dt>已关联类目推广花费</dt><dd>${money(totalSpend)}</dd></div><div><dt>类目整体推广费率</dt><dd><b class="fee-rate ${feeRateTone(totals.feeRate)}">${percent(totals.feeRate)}</b></dd></div></dl></header><div class="contribution-formulas" aria-label="指标计算口径"><span><b>销售占比</b><em>类目净 GSV ÷ 已关联类目净 GSV 合计</em></span><span><b>花费占比</b><em>类目推广花费 ÷ 已关联类目推广花费合计</em></span><span><b>类目推广费率</b><em>类目推广花费 ÷ 类目净 GSV</em></span></div><div class="contribution-head"><span>排名 / 类目</span><span><b>净 GSV</b><small>金额 + 销售占比</small></span><span><b>推广花费</b><small>金额 + 花费占比</small></span><span><b>类目推广费率</b><small>花费 ÷ 类目净 GSV</small></span></div><div class="contribution-list">${ranked.map((row, index) => {
    const revenueShare = share(row.revenue, totalRevenue); const spendShare = share(row.spend, totalSpend);
    const rate = calculatedPromotion(row).feeRate;
    return `<div class="contribution-row"><div class="contribution-name"><i>${String(index + 1).padStart(2, '0')}</i><span><small>类目</small><strong title="${escape(row.name || '')}">${escape(row.name || '--')}</strong></span></div><div class="contribution-metric revenue"><span class="contribution-metric-title">净 GSV</span><div><b>${money(row.revenue)}</b><em><small>销售占比</small><strong>${percent(revenueShare)}</strong></em></div><i><b style="--share:${(scale(row.revenue, maxRevenue) * 100).toFixed(2)}%"></b></i></div><div class="contribution-metric spend"><span class="contribution-metric-title">推广花费</span><div><b>${money(row.spend)}</b><em><small>花费占比</small><strong>${percent(spendShare)}</strong></em></div><i><b style="--share:${(scale(row.spend, maxSpend) * 100).toFixed(2)}%"></b></i></div><div class="contribution-rate"><span>类目推广费率</span><b class="fee-rate ${feeRateTone(rate)}">${percent(rate)}</b><small>推广花费 ÷ 类目净 GSV</small></div></div>`;
  }).join('')}</div><footer><span>展示前 ${ranked.length} 个类目</span><b>${active.length} 个有效类目参与占比计算</b></footer></article>`;
}
function promotionTone(name = '') { if (/全站/.test(name)) return 'blue'; if (/关键词/.test(name)) return 'purple'; const tones = ['teal', 'amber', 'rose', 'sky']; let hash = 0; for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return tones[hash % tones.length]; }
function promotionDetails(row) {
  const channels = row?.promotionChannels || [];
  if (!channels.length) return '';
  // Plan rates are calculated in the shared core from the linked product
  // links' net GSV. Never derive them from the parent category or ad revenue.
  const planMetrics = (plan) => {
    return `<dl class="promotion-plan-metrics"><div><dt>花费</dt><dd>${money(plan.spend)}</dd></div><div><dt>计划成交</dt><dd>${money(plan.promotionRevenue)}</dd></div><div><dt>投产</dt><dd>${fmtNumber(plan.roi)}</dd></div><div class="plan-fee-rate"><dt>计划费率</dt><dd>${percent(plan.feeRate)}</dd></div></dl>`;
  };
  return `<div class="promotion-grid">${channels.map((channel) => {
    const plans = channel.plans?.length ? channel.plans : [{ name: '未分组计划', spend: channel.spend, promotionRevenue: channel.promotionRevenue, roi: channel.roi }];
    return `<section class="promotion-channel ${promotionTone(channel.name)}"><header class="promotion-channel-head"><div><strong>${escape(channel.name || '未识别推广类型')}</strong><span>${plans.length} 个计划</span></div><div class="promotion-channel-summary"><span>关联净 GSV <b>${money(channel.linkedRevenue)}</b></span><span class="channel-fee-rate">${escape(channel.name || '推广')}整体费率 <b>${percent(channel.feeRate)}</b></span><span>花费 <b>${money(channel.spend)}</b></span></div></header><div class="promotion-plan-list">${plans.map((plan) => `<article class="promotion-plan"><strong class="promotion-plan-name" title="${escape(plan.name || '未命名计划')}">${escape(plan.name || '未命名计划')}</strong>${planMetrics(plan)}</article>`).join('')}</div></section>`;
  }).join('')}</div>`;
}
function promotionDrawer(row, kind) {
  const channels = row?.promotionChannels || [];
  const planCount = channels.reduce((sum, channel) => sum + (channel.plans?.length || 0), 0);
  const verified = calculatedPromotion(row);
  const title = kind === 'product' ? row.model || row.name || '商品推广详情' : row.name || '品类推广详情';
  const identity = kind === 'product' ? `${row.productId || '--'} · ${row.name || '--'}` : `${channels.length} 类推广 · ${planCount} 个计划`;
  return `<div class="promotion-drawer-shell" data-entity-drawer role="dialog" aria-modal="true" aria-label="${escape(title)}推广计划详情"><button class="promotion-drawer-backdrop" data-close-entity-drawer aria-label="关闭推广计划详情"></button><aside class="promotion-drawer"><header><div><span>${kind === 'product' ? '商品推广计划' : '品类推广计划'}</span><h3>${escape(title)}</h3><p>${escape(identity)}</p></div><button class="promotion-drawer-close" data-close-entity-drawer aria-label="关闭">×</button></header><div class="promotion-drawer-kpis"><div><span>净 GSV</span><b>${money(row.revenue)}</b></div><div><span>推广花费</span><b>${money(row.spend)}</b></div><div><span>推广费率</span><b class="fee-rate ${feeRateTone(verified.feeRate)}">${percent(verified.feeRate)}</b></div><div><span>推广结构</span><b>${channels.length} 类 / ${planCount} 个计划</b></div></div><div class="promotion-drawer-body">${promotionDetails(row)}</div></aside></div>`;
}
function reportGroupKey(report) { return `${report.periodKind || 'day'}|${report.periodStart || report.reportDate || ''}|${report.periodEnd || report.reportDate || ''}`; }
function groupedWarehouseReports(reports) {
  const stores = new Map();
  for (const report of reports) {
    const storeName = String(report.storeName || '').trim() || '未归属店铺';
    if (!stores.has(storeName)) stores.set(storeName, { key: storeName, storeName, reports: [], periods: new Map() });
    const store = stores.get(storeName); const periodId = reportGroupKey(report); const key = `${storeName}\u0001${periodId}`;
    if (!store.periods.has(periodId)) store.periods.set(periodId, { key, periodKind: report.periodKind || 'day', start: report.periodStart || report.reportDate || '', end: report.periodEnd || report.reportDate || '', reports: [] });
    store.reports.push(report); store.periods.get(periodId).reports.push(report);
  }
  return [...stores.values()].map((store) => ({ ...store, dateGroups: [...store.periods.values()].map((group) => ({ ...group, reports: group.reports.slice().sort((a, b) => String(b.importedAt || b.createdAt || '').localeCompare(String(a.importedAt || a.createdAt || ''))) })).sort((a, b) => `${b.end}|${b.start}`.localeCompare(`${a.end}|${a.start}`)) })).sort((a, b) => a.storeName === b.storeName ? 0 : a.storeName === '未归属店铺' ? 1 : b.storeName === '未归属店铺' ? -1 : a.storeName.localeCompare(b.storeName, 'zh-CN'));
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
  const presets = [['today', '今天'], ['yesterday', '昨天'], ['last-7-days', '近 7 日'], ['last-15-days', '近 15 日'], ['this-week', '本周'], ['last-week', '上周'], ['this-month', '本月'], ['last-month', '上月']];
  return `<section class="operations-toolbar"><div class="toolbar-row controls ${state.customScopeOpen ? 'with-custom-scope' : ''}"><div class="date-presets">${presets.map(([id, label]) => `<button class="${state.datePreset === id ? 'active' : ''}" data-date-preset="${id}">${label}</button>`).join('')}<button class="${state.datePreset === 'custom' ? 'active' : ''}" data-date-preset="custom">自定义</button></div>${state.customScopeOpen ? `<div class="scope-controls"><label><span>开始</span><input id="filter-start" type="date" value="${escape(state.filters.start)}" /></label><label><span>结束</span><input id="filter-end" type="date" value="${escape(state.filters.end)}" /></label><button class="btn primary small" id="apply-custom-scope">确定</button></div>` : ''}<span class="scope-hint">${model?.core?.reports?.length || 0} 份报表已参与当前计算</span></div></section>`;
}
function operationTabs() { return `<nav class="data-tabs"><button class="${state.activePanel === 'overview' ? 'active' : ''}" data-panel="overview"><small>01</small>整店总览</button><button class="${state.activePanel === 'category' ? 'active' : ''}" data-panel="category"><small>02</small>品类 360</button><button class="${state.activePanel === 'product' ? 'active' : ''}" data-panel="product"><small>03</small>商品排行</button><button class="${state.activePanel === 'warehouse' ? 'active' : ''}" data-panel="warehouse"><small>04</small>数据仓库</button></nav>`; }
function trendView(trend = []) {
  const colors = ['#0f766e', '#2563eb', '#d97706', '#e11d48', '#7c3aed', '#0891b2', '#4f46e5', '#be123c', '#15803d', '#b45309', '#0e7490', '#1d4ed8', '#6d28d9', '#047857', '#9f1239', '#0369a1', '#a16207', '#4338ca', '#c2410c', '#1e40af', '#0f766e'];
  const definitions = Object.fromEntries(CUSTOM_METRICS.map((metric, index) => [metric.id, {
    label: metric.label,
    color: colors[index % colors.length],
    value: (row) => metric.id === 'managementRoi' ? row.roi : metric.id === 'roi' ? (Number(row.spend) > 0 ? Number(row.promotionRevenue) / Number(row.spend) : null) : row[metric.id],
    format: (value) => formatCustomMetric(metric.id, value),
  }]));
  const selectedMetrics = (state.trendMetrics.length ? state.trendMetrics : ['revenue']).filter((id) => definitions[id]);
  const legendMetrics = [...new Set(['revenue', 'spend', 'managementRoi', 'feeRate', ...loadCustomCards('store').map((card) => card.metricId), ...selectedMetrics])].filter((id) => definitions[id]);
  const points = trend.slice(-31);
  const width = 760; const height = 230; const padding = { left: 34, right: 20, top: 18, bottom: 32 };
  const chartWidth = width - padding.left - padding.right; const chartHeight = height - padding.top - padding.bottom;
  const series = selectedMetrics.map((metricName) => {
    const definition = definitions[metricName]; const values = points.map((item) => definition.value(item)).filter(hasNumber).map(Number); const max = Math.max(...values.map(Math.abs), 1);
    const pointAt = (item, index) => { const rawValue = definition.value(item); if (!hasNumber(rawValue)) return null; const value = Number(rawValue); const x = padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth); const y = padding.top + chartHeight - Math.max(0, value / max) * chartHeight; return { value, x, y }; };
    const path = points.map((item, index) => { const point = pointAt(item, index); if (!point) return ''; const previous = index ? pointAt(points[index - 1], index - 1) : null; return `${previous ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`; }).join(' ');
    const labelStep = Math.max(1, Math.ceil(points.length / 8));
    const markers = points.map((item, index) => { const point = pointAt(item, index); if (!point) return ''; const label = points.length <= 12 || index === 0 || index === points.length - 1 || index % labelStep === 0; return `<circle class="trend-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" fill="${definition.color}"><title>${escape(definition.label)}：${escape(definition.format(point.value))}</title></circle>${label ? `<text class="trend-point-label" x="${point.x.toFixed(1)}" y="${Math.max(12, point.y - 9).toFixed(1)}" text-anchor="middle" fill="${definition.color}">${escape(definition.format(point.value))}</text>` : ''}`; }).join('');
    return `<g class="trend-series"><path d="${path}" fill="none" stroke="${definition.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${markers}</g>`;
  }).join('');
  return `<article class="card trend-card"><header class="section-head"><div><h3>经营趋势</h3><p>点击指标卡片或右侧标签切换、叠加趋势。每项指标独立缩放，避免不同量级互相压扁。</p></div><div class="trend-legend">${legendMetrics.map((id) => { const item = definitions[id]; return `<button class="${selectedMetrics.includes(id) ? 'active' : ''}" data-trend-toggle="${id}" aria-pressed="${selectedMetrics.includes(id)}" style="--metric-color:${item.color}"><i></i>${item.label}</button>`; }).join('')}</div></header>${points.length ? `<div class="trend-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="经营趋势图"><line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#dbe6ef" />${[.25, .5, .75].map((ratio) => `<line x1="${padding.left}" y1="${padding.top + chartHeight * ratio}" x2="${width - padding.right}" y2="${padding.top + chartHeight * ratio}" stroke="#eef3f7" />`).join('')}${series}${points.map((point, index) => `<text x="${padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth)}" y="${height - 10}" text-anchor="middle" fill="#789" font-size="10">${escape(day(point.date).slice(5))}</text>`).join('')}</svg></div><div class="trend-data-strip">${points.map((point) => `<div><span>${escape(day(point.date))}</span>${selectedMetrics.map((id) => `<b style="color:${definitions[id].color}">${definitions[id].label} ${definitions[id].format(definitions[id].value(point))}</b>`).join('')}</div>`).join('')}</div>` : '<div class="empty-cell">当前筛选范围没有可绘制的日度数据。</div>'}</article>`;
}
function overviewPanel(workspace) {
  const core = workspace.core || workspace.workspace || workspace; const dashboard = core.dashboard; const store = dashboard.store; const verified = calculatedPromotion(store); const canManage = Boolean(workspace.canManage);
  const cards = [
    { id: 'store-revenue', metricId: 'revenue', label: '整店净 GSV', value: money(store.revenue), detail: store.refundDataAvailable ? `支付 ${money(store.grossRevenue)} · 退款 ${money(store.refundAmount)}${store.salesDeduction ? ` · 扣除 ${money(store.salesDeduction)}` : ''}` : '当前销售报表缺退款字段', tone: 'mint' },
    { id: 'store-spend', metricId: 'spend', label: '推广花费', value: money(store.spend), detail: dashboard.sourceCoverage?.storePromotionComplete ? '单品付费周期已完整对齐' : '仅展示已导入消耗，不计算完整费率', tone: 'blue' },
    { id: 'store-roi', metricId: 'roi', label: '整店经营 ROI', value: fmtNumber(verified.roi), detail: dashboard.sourceCoverage?.storePromotionComplete ? '推广成交 ÷ 推广花费' : '需同周期单品付费报表', tone: 'orange' },
    { id: 'store-fee-rate', metricId: 'feeRate', label: '推广费率', value: percent(verified.feeRate), detail: dashboard.sourceCoverage?.storePromotionComplete ? '推广花费 ÷ 净 GSV' : '需同周期单品付费报表', tone: 'purple' },
  ];
  return `<section class="workspace-content">${managedMetricGrid('store', cards, [store])}${dashboard.sourceWarnings?.storePromotion ? `<div class="data-warning">${escape(dashboard.sourceWarnings.storePromotion)}</div>` : ''}${trendView(dashboard.trend)}${categoryContributionPanel(dashboard.categories)}<div class="split-grid"><article class="card"><header class="section-head"><div><h3>店铺经营</h3><p>销售和推广只在同名店铺内关联；表内口径与上方一致。</p></div>${canManage ? `<button class="btn secondary small" data-open-deductions>销售扣除</button>` : ''}</header>${storeTable(dashboard.stores)}</article><article class="card"><header class="section-head"><div><h3>数据口径</h3><p>本页严格使用共享 GSV、推广费率和 ROI 公式。</p></div></header><div class="source-list"><div><span>销售来源</span><strong>${escape(dashboard.sources?.storeSales?.type ? TYPE_LABELS[dashboard.sources.storeSales.type] : '未导入')}</strong></div><div><span>推广来源</span><strong>${escape(dashboard.sources?.storePromotion?.type ? TYPE_LABELS[dashboard.sources.storePromotion.type] : '未导入')}</strong></div><div><span>当前统计日期</span><strong>${escape(core.currentDate || '--')}</strong></div><div><span>商品资料库</span><strong>${core.productCatalog?.length || 0} 条版本记录</strong></div></div></article></div></section>`;
}
function storeTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>店铺</th><th>支付 / 退款</th><th>净 GSV</th><th>推广花费</th><th>ROI</th><th>费率</th></tr></thead><tbody>${rows?.length ? rows.map((row) => { const verified = calculatedPromotion(row); return `<tr><td><strong>${escape(row.name || '--')}</strong></td><td>${money(row.grossRevenue)}<small class="negative">-${money(row.refundAmount)}</small></td><td><strong>${money(row.revenue)}</strong></td><td>${money(row.spend)}</td><td>${fmtNumber(verified.roi)}</td><td>${percent(verified.feeRate)}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty-cell">导入商品排行和单品付费报表后显示店铺经营。</td></tr>'}</tbody></table></div>`;
}
function entityTable(rows, kind = 'product') {
  if (kind === 'store') return storeTable(rows);
  const ui = entityUi(kind); const allRows = (rows || []).filter((row) => hasNumber(row.revenue) || hasNumber(row.spend) || hasNumber(row.grossRevenue));
  normalizeEntitySelectionsToRows(kind, allRows);
  const visible = entityRows(kind, allRows); const summary = sumRows(visible);
  const categories = entityFilterOptions(kind, 'category', allRows); const models = entityFilterOptions(kind, 'model', allRows);
  const allCategories = entityFilterOptions(kind, 'category', allRows, false); const allModels = entityFilterOptions(kind, 'model', allRows, false);
  const columns = kind === 'product' ? 11 : 9;
  const sortHeader = (label, key) => `<button class="sort-header ${ui.sort === key ? 'active' : ''}" data-entity-sort="${kind}:${key}">${label}<i>${ui.sort === key ? (ui.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>`;
  return `<article class="entity-matrix"><header class="matrix-head"><div><h3>${kind === 'product' ? '商品排行经营矩阵' : '品类 360 经营矩阵'}</h3><p>${kind === 'product' ? '商品 ID、型号、品类、销售与每种推广计划在同一行核对。' : '品类花费按商品资料库映射的单品付费汇总，和整店推广花费可核对。'}</p></div><div class="matrix-tools"><label class="search-field"><span>搜索</span><input data-entity-keyword="${kind}" value="${escape(ui.keyword)}" placeholder="名称、ID、型号" /></label>${entityFilterMenu(kind, 'category', categories, allCategories.length)}${kind === 'product' ? entityFilterMenu(kind, 'model', models, allModels.length) : ''}<button class="btn text small" data-entity-clear="${kind}">清除筛选</button></div></header><div class="selection-summary"><div><span>当前范围</span><strong>${visible.length} / ${allRows.length} 项</strong></div><div><span>支付 / 退款</span><strong>${money(summary.grossRevenue)}</strong><small>-${money(summary.refundAmount)}</small></div><div><span>净 GSV</span><strong>${money(summary.revenue)}</strong></div><div><span>推广花费</span><strong>${money(summary.spend)}</strong></div><div><span>推广成交</span><strong>${money(summary.promotionRevenue)}</strong></div><div><span>ROI</span><strong>${fmtNumber(summary.roi)}</strong></div><div><span>费率</span><strong>${percent(summary.feeRate)}</strong></div></div>${entityComparisonChart(visible, kind)}<div class="table-wrap entity-table" data-entity-table="${kind}"><table class="${kind}-matrix-table"><thead><tr><th>${sortHeader(kind === 'product' ? '商品' : '品类', 'name')}</th>${kind === 'product' ? `<th>${sortHeader('商品 ID', 'productId')}</th><th>${sortHeader('型号 / 品类', 'model')}</th>` : ''}<th>${sortHeader('支付 / 退款', 'grossRevenue')}</th><th>${sortHeader('净 GSV', 'revenue')}</th><th>${sortHeader('推广花费', 'spend')}</th><th>${sortHeader('推广成交', 'promotionRevenue')}</th><th>${sortHeader('ROI', 'roi')}</th><th>${sortHeader('费率', 'feeRate')}</th><th>${sortHeader('推广类型 / 计划', 'promotionCount')}</th><th>关联</th></tr></thead><tbody>${visible.length ? visible.map((row) => { const verified = calculatedPromotion(row); const channels = row.promotionChannels || []; const planCount = channels.reduce((sum, channel) => sum + (channel.planCount || channel.plans?.length || 0), 0); const expanded = ui.expanded === row.key; const expansionSummary = `${channels.length} 类 / ${planCount} 个计划`; return `<tr class="${expanded ? 'entity-row-active' : ''}" data-entity-row="${escape(row.key)}"><td><strong title="${escape(row.name || '')}">${escape(row.name || '--')}</strong></td>${kind === 'product' ? `<td class="mono">${escape(row.productId || '--')}</td><td><strong>${escape(row.model || '型号待补')}</strong><small>${escape(row.category || '品类待补')}</small></td>` : ''}<td>${money(row.grossRevenue)}<small class="negative">-${money(row.refundAmount)}</small></td><td><strong>${money(row.revenue)}</strong></td><td>${money(row.spend)}</td><td>${money(row.promotionRevenue)}</td><td>${fmtNumber(verified.roi)}</td><td>${percent(verified.feeRate)}</td><td>${channels.length ? `<button class="promotion-toggle" data-entity-kind="${kind}" data-entity-key="${escape(row.key)}" data-entity-summary="${escape(expansionSummary)}" aria-expanded="${expanded}">${expanded ? '收起' : '展开'} ${escape(expansionSummary)}</button>` : '<small>暂无付费数据</small>'}</td><td><span class="match ${escape(row.matchStatus || 'unmatched')}">${row.matchStatus === 'id' ? 'ID 已关联' : row.matchStatus === 'name' ? '名称关联' : row.matchStatus === 'sales-only' ? '待补推广' : row.matchStatus === 'promotion-only' ? '待补经营' : '未关联'}</span></td></tr>`; }).join('') : `<tr><td colspan="${columns}" class="empty-cell">${allRows.length ? '没有符合当前筛选条件的数据。' : '导入对应报表后展示关联矩阵。'}</td></tr>`}</tbody></table></div></article>`;
}
function captureEntityScroll() {
  document.querySelectorAll('[data-entity-table]').forEach((table) => {
    const ui = entityUi(table.dataset.entityTable);
    if (ui) ui.scrollTop = table.scrollTop;
  });
}
function restoreEntityScroll() {
  window.requestAnimationFrame(() => {
    document.querySelectorAll('[data-entity-table]').forEach((table) => {
      const ui = entityUi(table.dataset.entityTable);
      if (ui) table.scrollTop = ui.scrollTop || 0;
    });
  });
}
function entityDashboardRows(kind) {
  const dashboard = operationsModel()?.core?.dashboard;
  return kind === 'product' ? dashboard?.products || [] : kind === 'category' ? dashboard?.categories || [] : [];
}
function toggleEntityExpansion(button) {
  const kind = button.dataset.entityKind; const key = button.dataset.entityKey; const ui = entityUi(kind);
  const table = button.closest('[data-entity-table]'); const sourceRow = button.closest('tr');
  if (!ui || !key || !table || !sourceRow) return;
  const closing = ui.expanded === key; const previousToggle = table.querySelector('.promotion-toggle[aria-expanded="true"]');
  const previousRow = table.querySelector('.entity-row-active');
  document.querySelector('[data-entity-drawer]')?.remove();
  previousRow?.classList.remove('entity-row-active');
  if (previousToggle) {
    previousToggle.setAttribute('aria-expanded', 'false');
    previousToggle.textContent = `展开 ${previousToggle.dataset.entitySummary}`;
  }
  ui.expanded = closing ? '' : key;
  if (!closing) {
    const row = entityDashboardRows(kind).find((item) => item.key === key);
    if (!row) { ui.expanded = ''; return; }
    button.setAttribute('aria-expanded', 'true'); button.textContent = `收起 ${button.dataset.entitySummary}`;
    sourceRow.classList.add('entity-row-active');
    document.body.insertAdjacentHTML('beforeend', promotionDrawer(row, kind));
    const drawer = document.querySelector('[data-entity-drawer]');
    drawer?.querySelectorAll('[data-close-entity-drawer]').forEach((close) => close.addEventListener('click', () => {
      drawer.remove();
      sourceRow.classList.remove('entity-row-active');
      button.setAttribute('aria-expanded', 'false');
      button.textContent = `展开 ${button.dataset.entitySummary}`;
      ui.expanded = '';
    }));
    drawer?.querySelector('.promotion-drawer-close')?.focus();
  }
  ui.scrollTop = table.scrollTop;
}
function warehousePanel(workspace) {
  const model = workspace.core ? workspace : operationsModel(); const core = model.core; const canManage = model.canManage; const panel = state.warehousePanel;
  const tabs = [['upload', '报表管理', '上传、核对与归档'], ['catalog', '商品资料', '店铺 + 商品 ID 映射'], ['deductions', '销售扣除', '大单剔除与重算']];
  const reports = model.warehouse || []; const filteredReports = reports.filter((report) => (state.archiveUi.type === 'all' || report.type === state.archiveUi.type) && (!state.archiveUi.storeName || report.storeName === state.archiveUi.storeName));
  const groups = groupedWarehouseReports(filteredReports); if (groups.length && (state.archiveUi.expandedStore === null || (state.archiveUi.expandedStore && !groups.some((group) => group.key === state.archiveUi.expandedStore)))) { state.archiveUi.expandedStore = groups[0].key; state.archiveUi.expandedDate = ''; } const selectedIds = new Set(state.archiveUi.selectedIds); const activeCatalog = latestCatalog(core.productCatalog || []);
  const body = panel === 'upload' || panel === 'archive' ? `${uploadWarehouseCard(model)}${archiveWarehouseCard(model, groups, selectedIds, false)}` : panel === 'catalog' ? catalogWarehouseCard(model, activeCatalog) : deductionsWarehouseCard(model);
  return `<section class="workspace-content"><nav class="warehouse-nav">${tabs.map(([id, label, hint]) => `<button class="${panel === id ? 'active' : ''}" data-warehouse-panel="${id}"><strong>${label}</strong><small>${hint}</small></button>`).join('')}</nav>${body}</section>`;
}
function catalogKey(entry) { return `${String(entry?.storeName || '').trim().toLocaleLowerCase('zh-CN')}\u0000${String(entry?.productId || '').trim()}`; }
function latestCatalog(entries) { const latest = new Map(); const replacedIds = new Set((entries || []).map((entry) => entry.replacesId).filter(Boolean)); for (const entry of entries || []) { if (replacedIds.has(entry.id)) continue; const key = catalogKey(entry); if (!latest.has(key)) latest.set(key, entry); } return [...latest.values()].sort((a, b) => `${a.storeName}|${a.category}|${a.productId}`.localeCompare(`${b.storeName}|${b.category}|${b.productId}`, 'zh-CN')); }
function uploadWarehouseCard(model) {
  const stores = model.stores || []; return `<article class="card warehouse-callout"><header class="section-head"><div><h3>${model.mode === 'cloud' ? '上传团队云报表' : '导入浏览器本地报表'}</h3><p>先预检报表类型和统计日期。下载日期不会被当作经营统计日期。</p></div><button class="btn primary" data-open-upload="${model.mode}">选择报表</button></header><div class="warehouse-guide"><div><b>商品排行</b><span>生意参谋 > 商品 > 商品排行</span></div><div><b>品类 360</b><span>生意参谋 > 品类 > 标准类目</span></div><div><b>单品付费</b><span>万相台/直通车商品推广报表</span></div></div>${model.mode === 'cloud' && !stores.length ? `<div class="data-warning">请先在团队管理中新增店铺，再上传团队报表。</div>` : ''}</article>`;
}
function archiveWarehouseCard(model, groups, selectedIds, showImportButton = true) {
  const stores = model.stores || []; const selected = [...selectedIds]; const all = groups.flatMap((store) => store.dateGroups.flatMap((group) => group.reports)).filter((report) => report.status === 'active');
  const storeSections = groups.map((store) => {
    const storeExpanded = state.archiveUi.expandedStore === store.key; const storeCurrent = store.reports.filter((report) => report.status === 'active'); const storeChecked = storeCurrent.length > 0 && storeCurrent.every((report) => selectedIds.has(report.id));
    const dateSections = store.dateGroups.map((group) => { const expanded = state.archiveUi.expandedDate === group.key; const groupCurrent = group.reports.filter((report) => report.status === 'active'); const checked = groupCurrent.length > 0 && groupCurrent.every((report) => selectedIds.has(report.id)); return `<section class="archive-group"><header><label><input type="checkbox" data-select-report-group="${escape(group.key)}" ${checked ? 'checked' : ''} ${groupCurrent.length ? '' : 'disabled'} /></label><button data-toggle-report-group="${escape(group.key)}"><b>${PERIOD_LABELS[group.periodKind] || group.periodKind} · ${escape(group.start || '未设置日期')}${group.end && group.end !== group.start ? ` 至 ${escape(group.end)}` : ''}</b><span>${group.reports.length} 份 · ${group.reports.reduce((sum, report) => sum + (Number(report.rowCount) || report.rows?.length || 0), 0)} 行 ${expanded ? '收起' : '展开'}</span></button></header>${expanded ? `<div class="archive-report-list">${group.reports.map((report) => archiveReportRow(model, report, selectedIds)).join('')}</div>` : ''}</section>`; }).join('');
    return `<section class="archive-store-group"><header class="archive-store-header"><label><input type="checkbox" data-select-store-group="${escape(store.key)}" ${storeChecked ? 'checked' : ''} ${storeCurrent.length ? '' : 'disabled'} /></label><button data-toggle-store-group="${escape(store.key)}"><b>店铺 · ${escape(store.storeName)}</b><span>${store.dateGroups.length} 个日期 · ${store.reports.length} 份报表 · ${store.reports.reduce((sum, report) => sum + (Number(report.rowCount) || report.rows?.length || 0), 0)} 行 ${storeExpanded ? '收起' : '展开'}</span></button></header>${storeExpanded ? `<div class="archive-period-groups">${dateSections}</div>` : ''}</section>`;
  }).join('');
  return `<article class="card warehouse-card"><header class="section-head"><div><h3>${model.mode === 'cloud' ? '团队数据归档' : '本地数据归档'}</h3><p>先按店铺归档，再按统计日期或周期从新到旧排列；支持整店、整期和单份报表选择。</p></div>${showImportButton ? `<button class="btn primary small" data-open-upload="${model.mode}">导入报表</button>` : ''}</header><div class="archive-controls"><label>数据表<select id="archive-type"><option value="all">全部数据表</option><option value="category" ${state.archiveUi.type === 'category' ? 'selected' : ''}>品类 360</option><option value="product" ${state.archiveUi.type === 'product' ? 'selected' : ''}>商品排行</option><option value="campaign" ${state.archiveUi.type === 'campaign' ? 'selected' : ''}>单品付费</option></select></label><label>店铺<select id="archive-store"><option value="">全部店铺</option>${stores.map((store) => `<option value="${escape(store.name)}" ${state.archiveUi.storeName === store.name ? 'selected' : ''}>${escape(store.name)}</option>`).join('')}</select></label><span>${selected.length ? `已选 ${selected.length} 份` : `${all.length} 份当前报表`}</span>${selected.length ? `<button class="btn text tiny" data-clear-archive-selection>取消选择</button><button class="btn danger tiny" data-delete-selected-reports>删除已选</button>${model.mode === 'cloud' && model.canManage ? `<select id="bulk-store-id"><option value="">批量改归属店铺</option>${stores.map((store) => `<option value="${escape(store.id)}">${escape(store.name)}</option>`).join('')}</select><button class="btn secondary tiny" id="bulk-assign-store">确认归属</button>` : ''}` : ''}</div><div class="archive-groups">${groups.length ? storeSections : '<div class="empty-cell">暂无符合条件的报表。</div>'}</div></article>`;
}
function archiveReportRow(model, report, selectedIds) { const editing = state.archiveUi.renameId === report.id; const canDelete = Boolean(report.canDelete); return `<div class="archive-report ${report.status || 'active'}"><input type="checkbox" data-select-report="${escape(report.id)}" ${selectedIds.has(report.id) ? 'checked' : ''} ${report.status === 'active' ? '' : 'disabled'} /> <div class="archive-file">${editing ? `<input data-rename-report-input="${escape(report.id)}" value="${escape(state.archiveUi.renameValue)}" /><button class="btn primary tiny" data-save-report-name="${escape(report.id)}">保存</button><button class="btn text tiny" data-cancel-report-name>取消</button>` : `<button class="archive-name" data-start-report-name="${escape(report.id)}" ${canDelete ? '' : 'disabled'}>${escape(report.fileName || '--')}</button>`}<small>${TYPE_LABELS[report.type] || report.type} · ${escape(report.storeName || '未归属店铺')} · ${report.rowCount || report.rows?.length || 0} 行${report.createdByUsername ? ` · ${escape(report.createdByUsername)}` : ''}</small></div><span class="status ${report.status || 'active'}">${report.status === 'superseded' ? '已替换' : '当前'}</span>${canDelete ? `<button class="btn danger tiny" data-delete-report="${escape(report.id)}">永久删除</button>` : ''}</div>`; }
function catalogWarehouseCard(model, entries) {
  const canManage = model.canManage; const pageSize = 50; const page = Math.max(0, Math.min(state.catalogUi.page, Math.ceil(entries.length / pageSize) - 1)); const visible = entries.slice(page * pageSize, page * pageSize + pageSize);
  const activeIds = new Set(entries.map((entry) => entry.id)); const selectedIds = new Set(state.catalogUi.selectedIds.filter((id) => activeIds.has(id))); const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id)); const allVisibleSelected = visible.length > 0 && visible.every((entry) => selectedIds.has(entry.id));
  const exportCurrent = model.mode === 'cloud' ? `<a class="btn secondary small" href="/api/teams/${encodeURIComponent(state.workspace.team.id)}/product-catalog/export">导出当前表</a>` : `<button class="btn secondary small" data-export-local-catalog>导出当前表</button>`;
  const clearCatalog = canManage ? `<button class="btn danger small" data-clear-catalog ${entries.length ? '' : 'disabled'}>清空资料</button>` : '';
  const headerActions = canManage ? `<div class="catalog-head-actions"><button class="btn primary small" data-toggle-catalog-create>${state.catalogUi.showCreate ? '收起新增' : '新增商品'}</button><a class="btn secondary small" href="/api/templates/product-catalog.xlsx">下载导入模板</a>${exportCurrent}${clearCatalog}</div>` : exportCurrent;
  const createPanel = canManage && state.catalogUi.showCreate ? `<form id="catalog-manual" class="catalog-create-panel"><header><div><span>新增商品资料</span><strong>店铺 + 商品 ID 不可重复</strong></div><button type="button" class="btn text tiny" data-cancel-catalog-create>取消</button></header><div class="catalog-create-grid"><label><span><i>1</i>店铺</span><input name="storeName" list="catalog-stores" required placeholder="选择或输入店铺" autocomplete="off" /></label><datalist id="catalog-stores">${model.stores.map((store) => `<option value="${escape(store.name)}"></option>`).join('')}</datalist><label><span><i>2</i>商品 ID</span><input name="productId" required placeholder="输入商品 ID" inputmode="numeric" autocomplete="off" /></label><label><span><i>3</i>品类</span><input name="category" required placeholder="输入品类" autocomplete="off" /></label><label><span><i>4</i>型号</span><input name="model" required placeholder="输入型号" autocomplete="off" /></label></div><footer><button type="reset" class="btn secondary small">清空</button><button class="btn primary small">保存商品</button></footer></form>` : '';
  const bulkEditor = canManage && selectedEntries.length ? `<form id="catalog-bulk-edit" class="catalog-bulk-editor"><div class="catalog-bulk-count"><span>已选</span><strong>${selectedEntries.length}</strong><small>条商品</small></div><div class="catalog-bulk-fields"><label><span>店铺</span><input list="catalog-bulk-stores" data-catalog-bulk-field="bulkStoreName" value="${escape(state.catalogUi.bulkStoreName)}" placeholder="留空不修改" autocomplete="off" /></label><datalist id="catalog-bulk-stores">${model.stores.map((store) => `<option value="${escape(store.name)}"></option>`).join('')}</datalist><label><span>品类</span><input data-catalog-bulk-field="bulkCategory" value="${escape(state.catalogUi.bulkCategory)}" placeholder="留空不修改" autocomplete="off" /></label><label><span>型号</span><input data-catalog-bulk-field="bulkModel" value="${escape(state.catalogUi.bulkModel)}" placeholder="留空不修改" autocomplete="off" /></label></div><div class="catalog-bulk-actions"><button type="button" class="btn text tiny" data-clear-catalog-selection>取消选择</button><button class="btn primary small">应用修改</button></div></form>` : '';
  const selectHead = canManage ? `<th class="catalog-check"><input type="checkbox" data-select-catalog-page aria-label="全选当前页" ${allVisibleSelected ? 'checked' : ''} ${visible.length ? '' : 'disabled'} /></th>` : '';
  const body = visible.length ? visible.map((entry) => `<tr class="${selectedIds.has(entry.id) ? 'catalog-row-selected' : ''}">${canManage ? `<td class="catalog-check"><input type="checkbox" data-select-catalog="${escape(entry.id)}" aria-label="选择商品 ${escape(entry.productId)}" ${selectedIds.has(entry.id) ? 'checked' : ''} /></td>` : ''}<td>${escape(entry.storeName)}</td><td class="mono">${escape(entry.productId)}</td><td>${escape(entry.category || '--')}</td><td>${escape(entry.model || '--')}</td><td>${escape(entry.sourceName || '--')}</td><td>${escape(fmtDate(entry.createdAt))}</td></tr>`).join('') : `<tr><td colspan="${canManage ? 7 : 6}" class="empty-cell">还没有商品资料。可以新增商品或导入 ID 型号表。</td></tr>`;
  return `<article class="card catalog-card"><header class="section-head"><div><h3>商品 ID、型号与品类资料库</h3><p>按店铺 + 商品 ID 唯一维护，勾选后可批量修改店铺、品类或型号。</p></div>${headerActions}</header>${createPanel}${canManage ? `<div class="catalog-actions"><label class="file-button">选择 ID 型号表<input id="catalog-file" type="file" accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt" /></label><button class="btn primary small" id="catalog-import" ${state.catalogUi.file ? '' : 'disabled'}>更新资料库</button><span>${state.catalogUi.file ? escape(state.catalogUi.file.name) : '表头：店铺名、商品ID、品类名、型号'}</span></div>` : '<div class="data-warning">商品资料由团队管理员维护；当前资料已参与商品和品类计算。</div>'}${bulkEditor}<div class="table-wrap"><table><thead><tr>${selectHead}<th>店铺</th><th>商品 ID</th><th>品类</th><th>型号</th><th>来源</th><th>更新时间</th></tr></thead><tbody>${body}</tbody></table></div>${entries.length > pageSize ? `<footer class="pager"><button class="btn secondary tiny" data-catalog-page="prev" ${page ? '' : 'disabled'}>上一页</button><span>${page + 1} / ${Math.ceil(entries.length / pageSize)} · ${entries.length} 条${selectedEntries.length ? ` · 已选 ${selectedEntries.length} 条` : ''}</span><button class="btn secondary tiny" data-catalog-page="next" ${page < Math.ceil(entries.length / pageSize) - 1 ? '' : 'disabled'}>下一页</button></footer>` : ''}</article>`;
}
function deductionsWarehouseCard(model) {
  const currentDeductions = model.core.salesDeductions || [];
  const deductions = model.core.salesDeductionHistory || currentDeductions;
  const currentIds = new Set(currentDeductions.map((item) => item.id));
  const total = deductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return `<article class="card"><header class="section-head"><div><h3>销售扣除</h3><p>历史记录始终保留；标记“当前口径”的记录才参与当前日期范围计算。</p></div><div class="deduction-summary"><span>历史 ${deductions.length} 笔</span><strong>-${money(total)}</strong></div></header>${model.canManage ? `<form id="sales-deduction-form" class="deduction-form"><select name="storeName" required><option value="">选择店铺</option>${model.stores.map((store) => `<option value="${escape(store.name)}">${escape(store.name)}</option>`).join('')}</select><input type="date" name="reportDate" value="${escape(model.core.currentDate || utcDate())}" required /><input type="number" name="amount" min="0.01" step="0.01" placeholder="扣除金额" required /><input name="note" placeholder="备注（可选）" /><button class="btn primary small">保存并重算</button></form>` : '<div class="data-warning">销售扣除由团队管理员维护，成员可查看已生效的经营口径。</div>'}<div class="table-wrap"><table><thead><tr><th>店铺</th><th>统计日期</th><th>扣除金额</th><th>当前状态</th><th>备注</th><th>操作</th></tr></thead><tbody>${deductions.length ? deductions.map((item) => `<tr><td>${escape(item.storeName)}</td><td>${escape(item.reportDate)}</td><td class="negative">-${money(item.amount)}</td><td><span class="deduction-scope ${currentIds.has(item.id) ? 'active' : ''}">${currentIds.has(item.id) ? '当前口径' : '历史记录'}</span></td><td>${escape(item.note || '--')}</td><td>${model.canManage ? `<button class="btn danger tiny" data-delete-deduction="${escape(item.id)}">删除</button>` : '--'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">还没有销售扣除记录。</td></tr>'}</tbody></table></div></article>`;
}
function cloudOperationsView() {
  if (state.bootstrapError && !state.workspace) return `<section class="load-failure" role="alert"><div><span>数据加载未完成</span><h1>运营数据暂时没有加载出来</h1><p>${escape(state.bootstrapError)}</p></div><button class="btn primary" id="retry-bootstrap">重新加载</button></section>`;
  if (!state.workspace?.hasTeam) return emptyTeamView();
  const model = operationsModel(); const workspace = state.workspace;
  return operationsView(model, `<section class="page-header"><div><div class="eyebrow">${escape(workspace.team.name)} · 团队共享空间</div><h1>运营数据</h1><p>团队统一计算，支持按日报、周报、月报和自定义周期核对经营结果。</p></div><div class="quota"><span>云空间</span><strong>${formatBytes(workspace.storage.usedBytes)} / ${formatBytes(workspace.storage.quotaBytes)}</strong><i><b style="width:${Math.min(100, workspace.storage.usageRatio * 100)}%"></b></i></div></section>`);
}
function localOperationsView() {
  const model = operationsModel();
  return operationsView(model, `<section class="page-header"><div><div class="eyebrow">此浏览器 · 私有数据空间</div><h1>运营数据</h1><p>报表、商品资料和销售扣除只保存在当前浏览器；不会上传到团队云端。</p></div><div class="actions"><button class="btn secondary small" id="export-local">导出备份</button><button class="btn danger small" id="clear-local">清空本地数据</button></div></section>`);
}
function operationsView(model, header) {
  const dashboard = model.core.dashboard;
  let panel;
  if (state.activePanel === 'overview') panel = overviewPanel(model);
  else if (state.activePanel === 'category') {
    const rows = entityRows('category', dashboard.categories);
    const cards = [
      { id: 'category-linked', metricId: 'linkedCount', label: '已关联品类', value: fmtNumber(cardMetricValue(rows, 'linkedCount'), 0), detail: '当前筛选范围内销售与单品付费已关联', tone: 'mint' },
      { id: 'category-sales-only', metricId: 'salesOnlyCount', label: '待补单品付费', value: fmtNumber(cardMetricValue(rows, 'salesOnlyCount'), 0), detail: '当前筛选范围内仅有品类 360 销售数据', tone: 'orange' },
      { id: 'category-promotion-only', metricId: 'promotionOnlyCount', label: '待补品类 360', value: fmtNumber(cardMetricValue(rows, 'promotionOnlyCount'), 0), detail: '当前筛选范围内仅有单品付费数据', tone: 'blue' },
      { id: 'category-revenue', metricId: 'revenue', label: '品类净 GSV', value: money(cardMetricValue(rows, 'revenue')), detail: '当前筛选范围', tone: '' },
    ];
    panel = `<section class="workspace-content">${managedMetricGrid('category', cards, rows)}${entityTable(dashboard.categories, 'category')}</section>`;
  } else if (state.activePanel === 'product') {
    const rows = entityRows('product', dashboard.products);
    const cards = [
      { id: 'product-linked', metricId: 'linkedCount', label: '已关联单品', value: fmtNumber(cardMetricValue(rows, 'linkedCount'), 0), detail: '当前筛选范围内经营与推广已关联', tone: 'mint' },
      { id: 'product-sales-only', metricId: 'salesOnlyCount', label: '待补推广数据', value: fmtNumber(cardMetricValue(rows, 'salesOnlyCount'), 0), detail: '当前筛选范围内仅有商品经营', tone: 'orange' },
      { id: 'product-promotion-only', metricId: 'promotionOnlyCount', label: '待补经营数据', value: fmtNumber(cardMetricValue(rows, 'promotionOnlyCount'), 0), detail: '当前筛选范围内仅有单品推广', tone: 'blue' },
      { id: 'product-spend', metricId: 'spend', label: '单品推广花费', value: money(cardMetricValue(rows, 'spend')), detail: '当前筛选范围', tone: 'purple' },
    ];
    panel = `<section class="workspace-content">${managedMetricGrid('product', cards, rows)}${entityTable(dashboard.products, 'product')}</section>`;
  } else panel = warehousePanel(model);
  return `${header}${operationsNav()}${modeToolbar()}${panel}`;
}
function uploadSelectMenu(id, value, options, placeholder) {
  const selectedOption = options.find((option) => option.value === value);
  const open = state.upload.openMenu === id;
  return `<div class="upload-select"><button class="upload-select-trigger ${selectedOption ? 'has-value' : ''}" type="button" data-upload-menu="${id}" aria-expanded="${open}" aria-haspopup="listbox"><span>${escape(selectedOption?.label || placeholder)}</span></button>${open ? `<div class="upload-select-options" role="listbox">${options.map((option) => `<button type="button" role="option" aria-selected="${option.value === value}" class="${option.value === value ? 'selected' : ''}" data-upload-select="${id}" data-upload-value="${escape(option.value)}">${escape(option.label)}</button>`).join('')}</div>` : ''}</div>`;
}
function activeUploadItem() {
  return state.upload.files.find((item) => item.id === state.upload.activeId) || state.upload.files[0] || null;
}
function updateUploadItem(id, changes) {
  state.upload.files = state.upload.files.map((item) => item.id === id ? { ...item, ...changes } : item);
}
function uploadItemReady(item) {
  return Boolean(item?.file && item?.preview && item?.type && item?.periodKind && item?.periodStart && item?.periodEnd && item.periodStart <= item.periodEnd && !['recognizing', 'preview-error', 'uploading', 'success'].includes(item.status));
}
function uploadItemStatus(item) {
  if (item.status === 'success') return ['已入库', 'success'];
  if (item.status === 'uploading') return ['正在入库', 'working'];
  if (item.status === 'recognizing') return ['正在识别', 'working'];
  if (item.status === 'preview-error' || item.status === 'upload-error') return ['处理失败', 'error'];
  if (uploadItemReady(item)) return ['可以入库', 'ready'];
  return ['待补充', 'pending'];
}
function defaultUploadStoreName(mode) {
  const stores = operationsModel()?.stores || [];
  const filteredStore = stores.find((store) => store.name === state.filters.storeName);
  if (filteredStore) return filteredStore.name;
  if (mode === 'cloud' && stores.length === 1) return stores[0].name;
  return mode === 'local' ? state.filters.storeName || '' : '';
}
function uploadCalendarMonth(value) {
  const base = /^\d{4}-\d{2}$/.test(value || '') ? `${value}-01` : `${utcDate()}-01`;
  return new Date(`${base}T12:00:00`);
}
function uploadDateRangePicker(item = activeUploadItem()) {
  if (!item) return '';
  const upload = state.upload;
  const open = upload.openMenu === 'dateRange';
  const month = uploadCalendarMonth(upload.calendarMonth || item.periodStart?.slice(0, 7) || item.periodEnd?.slice(0, 7));
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const firstWeekday = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const toIso = (dayOfMonth) => utcDate(new Date(year, monthIndex, dayOfMonth));
  const blanks = Array.from({ length: firstWeekday }, () => '<i aria-hidden="true"></i>').join('');
  const days = Array.from({ length: lastDay }, (_, index) => {
    const value = toIso(index + 1);
    const selected = value === item.periodStart || value === item.periodEnd;
    const between = item.periodStart && item.periodEnd && value > item.periodStart && value < item.periodEnd;
    const today = value === utcDate();
    return `<button type="button" class="${selected ? 'selected' : ''} ${between ? 'between' : ''} ${today ? 'today' : ''}" data-upload-date="${value}" aria-pressed="${selected}">${index + 1}</button>`;
  }).join('');
  const label = item.periodStart && item.periodEnd ? `${item.periodStart} 至 ${item.periodEnd}` : item.periodStart ? `开始：${item.periodStart}` : '选择开始与结束日期';
  return `<div class="upload-date-range"><button type="button" class="upload-select-trigger ${item.periodStart && item.periodEnd ? 'has-value' : ''}" data-upload-date-menu aria-expanded="${open}" aria-haspopup="dialog"><span>${escape(label)}</span></button>${open ? `<section class="upload-date-panel" role="dialog" aria-label="选择统计日期"><div class="date-range-summary"><button type="button" class="${upload.dateSelecting === 'start' ? 'active' : ''}" data-upload-date-target="start"><small>开始日期</small><strong>${escape(item.periodStart || '请选择')}</strong></button><span>至</span><button type="button" class="${upload.dateSelecting === 'end' ? 'active' : ''}" data-upload-date-target="end"><small>结束日期</small><strong>${escape(item.periodEnd || '请选择')}</strong></button></div><div class="upload-calendar-head"><button type="button" data-upload-date-month="-1" aria-label="上个月">&#8249;</button><strong>${year} 年 ${monthIndex + 1} 月</strong><button type="button" data-upload-date-month="1" aria-label="下个月">&#8250;</button></div><div class="upload-calendar-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="upload-calendar-days">${blanks}${days}</div><footer><button type="button" class="btn text tiny" data-upload-date-today>今天</button><button type="button" class="btn primary tiny" data-upload-date-apply>确认日期</button></footer></section>` : ''}</div>`;
}
function uploadModal(mode) {
  const model = operationsModel(); const upload = state.upload; const stores = model?.stores || []; const active = activeUploadItem(); const busy = ['recognizing', 'uploading'].includes(upload.status);
  const pendingItems = upload.files.filter((item) => item.status !== 'success'); const ready = pendingItems.length > 0 && pendingItems.every(uploadItemReady) && upload.storeName;
  const storeField = mode === 'cloud'
    ? uploadSelectMenu('storeName', upload.storeName, stores.map((store) => ({ value: store.name, label: store.name })), '选择店铺')
    : `<input id="upload-store" required list="upload-stores" value="${escape(upload.storeName)}" placeholder="输入或选择店铺" /><datalist id="upload-stores">${stores.map((store) => `<option value="${escape(store.name)}"></option>`).join('')}</datalist>`;
  const fileHint = upload.status === 'recognizing' ? `正在逐份识别报表，已完成 ${upload.files.filter((item) => item.status !== 'recognizing').length} / ${upload.files.length} 份`
    : upload.status === 'uploading' ? `正在逐份写入数据仓，已完成 ${upload.files.filter((item) => item.status === 'success').length} / ${upload.files.length} 份`
    : upload.status === 'partial' || upload.status === 'error' ? upload.error || '部分文件处理失败，请检查标红项目。'
    : upload.files.length ? `已选择 ${upload.files.length} 份报表，可继续添加文件` : '可一次选择多份 Excel / CSV / TSV / JSON 文件';
  const progress = ['recognizing', 'uploading'].includes(upload.status) ? `<div class="upload-progress" role="status" aria-live="polite"><div><span>${escape(fileHint)}</span><b>${Math.round(upload.progress || 0)}%</b></div><i><b style="width:${Math.max(4, Math.min(100, upload.progress || 0))}%"></b></i></div>` : '';
  const fileRows = upload.files.map((item) => {
    const [statusLabel, statusClass] = uploadItemStatus(item); const selected = active?.id === item.id; const type = TYPE_LABELS[item.type] || item.type || '待选数据表'; const period = item.periodStart && item.periodEnd ? `${item.periodStart}${item.periodStart === item.periodEnd ? '' : ` 至 ${item.periodEnd}`}` : '待补统计日期';
    return `<div class="upload-batch-row ${selected ? 'active' : ''} ${statusClass}"><button type="button" class="upload-batch-main" data-select-upload-item="${escape(item.id)}"><span class="upload-file-index">${upload.files.indexOf(item) + 1}</span><div><strong>${escape(item.file.name)}</strong><small>${escape(type)} · ${escape(PERIOD_LABELS[item.periodKind] || item.periodKind || '待选口径')} · ${escape(period)}${item.preview?.rowCount ? ` · ${item.preview.rowCount} 行` : ''}</small>${item.error ? `<em>${escape(item.error)}</em>` : ''}</div><b class="upload-file-status ${statusClass}">${statusLabel}</b></button>${item.status === 'success' || busy ? '' : `<button type="button" class="upload-file-remove" data-remove-upload-item="${escape(item.id)}" aria-label="移除 ${escape(item.file.name)}">×</button>`}</div>`;
  }).join('');
  const activeEditor = active?.status === 'success' ? `<section class="upload-item-editor upload-item-complete"><header><div><span>已完成</span><strong>${escape(active.file.name)}</strong></div><small>这份报表已经入库，不会在重试时重复上传。</small></header></section>` : active ? `<section class="upload-item-editor"><header><div><span>当前报表</span><strong>${escape(active.file.name)}</strong></div><small>类型、统计口径和日期仅应用于这一份文件</small></header><div class="form-grid two"><div class="field"><span>数据表</span>${uploadSelectMenu('type', active.type, [{ value: 'category', label: '品类 360' }, { value: 'product', label: '商品排行' }, { value: 'campaign', label: '单品付费' }], '请选择')}</div><div class="field"><span>统计口径</span>${uploadSelectMenu('periodKind', active.periodKind, [{ value: 'day', label: '日报' }, { value: 'week', label: '周报' }, { value: 'month', label: '月报' }, { value: 'custom', label: '自定义周期' }], '选择统计口径')}</div><div class="field date-range-field"><span>统计日期</span>${uploadDateRangePicker(active)}</div></div></section>` : '<div class="upload-batch-empty">选择多份报表后，会在这里逐份显示识别结果。</div>';
  const uploadLabel = upload.status === 'uploading' ? `正在入库 ${Math.max(1, upload.files.findIndex((item) => item.status === 'uploading') + 1)} / ${upload.files.length}` : pendingItems.some((item) => item.status === 'upload-error') ? `重试 ${pendingItems.length} 份失败报表` : mode === 'cloud' ? `批量上传 ${pendingItems.length} 份并入库` : `批量保存 ${pendingItems.length} 份到本地`;
  return `<div class="modal"><section class="modal-card upload-modal batch-upload-modal"><header class="modal-head"><div><h3>${mode === 'cloud' ? '批量上传团队云报表' : '批量导入本地浏览器报表'}</h3><p>统一选择店铺，系统逐份识别数据表和统计日期；点击文件可单独修正后一次入库。</p></div><button class="btn text" data-close-modal ${busy ? 'disabled' : ''}>关闭</button></header><form id="report-upload" class="modal-body" data-mode="${mode}"><label class="drop-field ${upload.status === 'partial' || upload.status === 'error' ? 'error' : ''}"><span>批量选择报表</span><input id="report-file" type="file" multiple accept=".xls,.xlsx,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,.json" ${busy ? 'disabled' : ''} /> <b>${upload.files.length ? `继续添加报表（当前 ${upload.files.length} 份）` : '一次选择多份报表'}</b><small>${fileHint}</small></label>${progress}<div class="upload-shared-fields"><div class="field"><span>统一归属店铺</span>${storeField}${mode === 'cloud' && upload.storeName ? '<small class="upload-field-hint">已识别当前团队店铺，可手动修改</small>' : ''}</div><label class="field"><span>统一来源备注</span><input id="upload-source-name" value="${escape(upload.sourceName || (mode === 'cloud' ? '网页运营工作台' : '浏览器本地导入'))}" /></label></div>${upload.files.length ? `<div class="upload-batch-summary"><span>文件清单</span><b>${upload.files.filter((item) => item.status === 'success').length} 已入库 · ${upload.files.filter(uploadItemReady).length} 待入库 · ${upload.files.filter((item) => ['preview-error', 'upload-error'].includes(item.status)).length} 异常</b></div><div class="upload-batch-list">${fileRows}</div>` : ''}${activeEditor}${mode === 'cloud' && !stores.length ? '<div class="data-warning">云端团队还没有店铺。请先到团队管理新增店铺。</div>' : ''}<div class="modal-actions"><button id="submit-report-upload" class="btn primary" type="submit" ${ready && !busy ? '' : 'disabled'}>${uploadLabel}</button><button class="btn secondary" type="button" data-close-modal ${busy ? 'disabled' : ''}>${upload.files.some((item) => item.status === 'success') ? '完成' : '取消'}</button></div></form></section></div>`;
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
  app.innerHTML = `<div class="app-shell">${topNav()}<main class="app-main">${view}</main>${activity}${state.toast ? `<div class="toast ${state.toast.error ? 'error' : ''}"><span>${escape(state.toast.message)}</span><button id="dismiss-toast">关闭</button></div>` : ''}${state.modal === 'upload' ? uploadModal(state.upload.mode) : state.modal === 'platform-team' ? platformTeamModal() : ''}${customCardSettingsModal()}</div>`;
  prepareDesktopSyncPanel();
  bindShell();
  restoreEntityScroll();
}
function render() {
  document.querySelector('[data-entity-drawer]')?.remove();
  state.entityUi.category.expanded = '';
  state.entityUi.product.expanded = '';
  captureTeamDraft(); captureEntityScroll();
  if (!state.session) loginView(); else shell();
}

function localDetectedType(rows, fileName = '') {
  const headers = Object.keys(rows?.[0] || {}).map(headerKey); const has = (pattern) => headers.some((header) => pattern.test(header));
  if (/(分类目场景|营销场景|类目花费)/.test(fileName)) return 'category';
  if (has(/(商品id|宝贝id|主体id)/) && has(/(花费|消耗)/)) return 'campaign';
  if (has(/(商品id|宝贝id|主体id)/) && has(/(支付金额|成交金额|总成交金额)/)) return 'product';
  if (has(/(类目|品类)/) && has(/(支付金额|成交金额|总成交金额)/)) return 'category';
  return '';
}
function periodKindForRange(start, end) { if (!start || !end || start > end) return 'custom'; if (start === end) return 'day'; const first = new Date(`${start}T12:00:00`); const last = new Date(`${end}T12:00:00`); const days = Math.round((last - first) / 86_400_000) + 1; if (((first.getDay() + 6) % 7) === 0 && days === 7) return 'week'; if (first.getDate() === 1 && first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear() && last.getDate() === new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate()) return 'month'; return 'custom'; }
async function importLocalUpload(item, upload = state.upload) {
  const file = item?.file; if (!(file instanceof File)) throw new Error('请选择报表文件。');
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
  const periodStart = String(item.periodStart); const periodEnd = String(item.periodEnd);
  const report = { id: `local_${crypto.randomUUID()}`, type: String(item.type), storeName: String(upload.storeName).trim(), periodKind: String(item.periodKind), periodStart, periodEnd, periodLabel: periodStart === periodEnd ? periodStart : `${periodStart} 至 ${periodEnd}`, fileName: file.name, sourceName: String(upload.sourceName || ''), importedAt: new Date().toISOString(), rows: rows.map((row) => normalRow(row, upload.storeName)), rawFile: file };
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
  const sourceName = document.querySelector('#upload-source-name');
  if (store) state.upload.storeName = store.value.trim();
  if (sourceName) state.upload.sourceName = sourceName.value.trim();
}
function refreshUploadSubmitState() {
  const submit = document.querySelector('#submit-report-upload');
  if (!submit) return;
  const upload = state.upload;
  const pending = upload.files.filter((item) => item.status !== 'success');
  submit.disabled = !(upload.storeName && pending.length > 0 && pending.every(uploadItemReady) && !['recognizing', 'uploading'].includes(upload.status));
}
async function bootstrap() {
  state.bootstrapError = '';
  try { [state.localReports, state.localMeta] = await Promise.all([localReadAll(), localReadMeta()]); }
  catch { state.localReports = []; state.localMeta = { productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [] }; }
  if (state.session) {
    const [workspaceResult] = await Promise.allSettled([loadCloudWorkspace(), loadOverview().catch(() => { state.overview = null; }), loadTeam().catch(() => { state.team = null; })]);
    if (workspaceResult.status === 'rejected') { state.workspace = null; state.bootstrapError = workspaceResult.reason?.message || '团队数据请求失败，请稍后重试。'; }
  }
  render();
}
function bindShell() {
  document.querySelector('#retry-bootstrap')?.addEventListener('click', async () => { state.bootstrapError = ''; render(); await bootstrap(); });
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
  document.querySelectorAll('[data-open-upload]').forEach((button) => button.addEventListener('click', () => { const mode = button.dataset.openUpload; state.upload = { mode, files: [], activeId: '', storeName: defaultUploadStoreName(mode), sourceName: mode === 'cloud' ? '网页运营工作台' : '浏览器本地导入', openMenu: '', dateSelecting: 'start', calendarMonth: (state.filters.start || state.filters.end || utcDate()).slice(0, 7), status: 'idle', progress: 0, error: '' }; state.modal = 'upload'; render(); }));
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { state.modal = ''; render(); }));
  document.querySelector('.modal-card')?.addEventListener('pointerdown', (event) => event.stopPropagation());
  document.querySelector('.modal-card')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelectorAll('[data-upload-menu]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); const id = event.currentTarget.dataset.uploadMenu; state.upload.openMenu = state.upload.openMenu === id ? '' : id; render(); }));
  document.querySelector('[data-upload-date-menu]')?.addEventListener('click', (event) => { event.preventDefault(); const item = activeUploadItem(); if (!item) return; if (!state.upload.calendarMonth) state.upload.calendarMonth = (item.periodStart || item.periodEnd || utcDate()).slice(0, 7); state.upload.openMenu = state.upload.openMenu === 'dateRange' ? '' : 'dateRange'; render(); });
  document.querySelectorAll('[data-upload-date-target]').forEach((button) => button.addEventListener('click', (event) => { state.upload.dateSelecting = event.currentTarget.dataset.uploadDateTarget; render(); }));
  document.querySelectorAll('[data-upload-date-month]').forEach((button) => button.addEventListener('click', (event) => { const month = uploadCalendarMonth(state.upload.calendarMonth); month.setMonth(month.getMonth() + Number(event.currentTarget.dataset.uploadDateMonth)); state.upload.calendarMonth = utcDate(month).slice(0, 7); render(); }));
  document.querySelector('[data-upload-date-today]')?.addEventListener('click', () => { const item = activeUploadItem(); if (!item) return; const today = utcDate(); updateUploadItem(item.id, { periodStart: today, periodEnd: today, periodKind: 'day' }); state.upload.dateSelecting = 'start'; state.upload.calendarMonth = today.slice(0, 7); refreshUploadSubmitState(); render(); });
  document.querySelectorAll('[data-upload-date]').forEach((button) => button.addEventListener('click', (event) => { const item = activeUploadItem(); if (!item) return; const value = event.currentTarget.dataset.uploadDate; let periodStart = item.periodStart; let periodEnd = item.periodEnd; if (state.upload.dateSelecting === 'end' && periodStart) { if (value < periodStart) { periodEnd = periodStart; periodStart = value; } else periodEnd = value; state.upload.dateSelecting = 'start'; } else { periodStart = value; periodEnd = ''; state.upload.dateSelecting = 'end'; } updateUploadItem(item.id, { periodStart, periodEnd, periodKind: periodEnd ? periodKindForRange(periodStart, periodEnd) : item.periodKind }); refreshUploadSubmitState(); render(); }));
  document.querySelector('[data-upload-date-apply]')?.addEventListener('click', () => { const item = activeUploadItem(); if (!item?.periodStart || !item?.periodEnd) return setToast('请在日历中选择开始和结束日期。', true); state.upload.openMenu = ''; refreshUploadSubmitState(); render(); });
  document.querySelectorAll('[data-upload-select]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); const field = event.currentTarget.dataset.uploadSelect; const value = event.currentTarget.dataset.uploadValue || ''; if (field === 'storeName') state.upload.storeName = value; else if (['type', 'periodKind'].includes(field)) { const item = activeUploadItem(); if (item) updateUploadItem(item.id, { [field]: value }); } else return; state.upload.openMenu = ''; render(); }));
  document.querySelector('#report-upload')?.addEventListener('input', () => { syncUploadDraftFromForm(); refreshUploadSubmitState(); });
  document.querySelector('#report-upload')?.addEventListener('change', () => { syncUploadDraftFromForm(); refreshUploadSubmitState(); });
  document.querySelectorAll('[data-select-upload-item]').forEach((button) => button.addEventListener('click', () => { const item = state.upload.files.find((candidate) => candidate.id === button.dataset.selectUploadItem); if (!item) return; state.upload.activeId = item.id; state.upload.openMenu = ''; state.upload.dateSelecting = 'start'; state.upload.calendarMonth = (item.periodStart || item.periodEnd || utcDate()).slice(0, 7); render(); }));
  document.querySelectorAll('[data-remove-upload-item]').forEach((button) => button.addEventListener('click', () => { const id = button.dataset.removeUploadItem; state.upload.files = state.upload.files.filter((item) => item.id !== id); if (state.upload.activeId === id) state.upload.activeId = state.upload.files[0]?.id || ''; const failed = state.upload.files.filter((item) => item.status === 'preview-error').length; state.upload.status = failed ? 'error' : state.upload.files.length ? 'ready' : 'idle'; state.upload.error = failed ? `${failed} 份文件识别失败，请查看文件清单。` : ''; state.upload.progress = state.upload.files.length ? 100 : 0; render(); }));
  document.querySelector('#report-file')?.addEventListener('change', async (event) => {
    const selectedFiles = [...(event.currentTarget.files || [])]; if (!selectedFiles.length) return;
    const known = new Set(state.upload.files.map((item) => `${item.file.name}\u0000${item.file.size}\u0000${item.file.lastModified}`));
    const defaults = { periodKind: state.filters.start && state.filters.end ? periodKindForRange(state.filters.start, state.filters.end) : 'day', periodStart: state.filters.start || '', periodEnd: state.filters.end || '' };
    const additions = selectedFiles.filter((file) => !known.has(`${file.name}\u0000${file.size}\u0000${file.lastModified}`)).map((file) => ({ id: `upload_${crypto.randomUUID()}`, file, preview: null, type: '', ...defaults, status: 'recognizing', error: '' }));
    if (!additions.length) return setToast('这些文件已经在批量清单中。', true);
    state.upload.files = [...state.upload.files, ...additions]; if (!state.upload.activeId) state.upload.activeId = additions[0].id; state.upload.status = 'recognizing'; state.upload.progress = 4; state.upload.error = ''; render();
    for (let index = 0; index < additions.length; index += 1) {
      const item = additions[index];
      try {
        let preview;
        if (state.upload.mode === 'cloud') { const form = new FormData(); form.append('file', item.file, item.file.name); preview = await api(`/api/teams/${state.workspace.team.id}/reports/preview`, { method: 'POST', body: form }); }
        else { const rows = spreadsheetRows(await item.file.arrayBuffer()); if (!rows.length) throw new Error('没有读取到可计算的数据行。'); preview = { rowCount: rows.length, detectedType: localDetectedType(rows, item.file.name), period: null }; }
        const dates = preview.period ? { periodStart: preview.period.start, periodEnd: preview.period.end, periodKind: periodKindForRange(preview.period.start, preview.period.end) } : {};
        updateUploadItem(item.id, { preview, type: preview.detectedType || '', ...dates, status: 'ready', error: '' });
      } catch (error) { updateUploadItem(item.id, { status: 'preview-error', error: error.message || '文件识别失败，请移除后重新选择。' }); }
      state.upload.progress = Math.round(((index + 1) / additions.length) * 100); render();
    }
    const firstNeedsReview = state.upload.files.find((item) => !uploadItemReady(item) && item.status !== 'success'); if (firstNeedsReview) state.upload.activeId = firstNeedsReview.id;
    const failed = state.upload.files.filter((item) => item.status === 'preview-error').length; state.upload.status = failed ? 'error' : 'ready'; state.upload.error = failed ? `${failed} 份文件识别失败，请查看文件清单。` : ''; state.upload.progress = 100; render();
  });
  document.querySelector('#report-upload')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const mode = event.currentTarget.dataset.mode; syncUploadDraftFromForm(); const upload = { ...state.upload }; const items = upload.files.filter((item) => item.status !== 'success');
    try {
      if (!upload.storeName || !items.length || !items.every(uploadItemReady)) throw new Error('请完成店铺选择，并补齐每份报表的数据表、统计口径和有效日期。');
      const store = mode === 'cloud' ? state.workspace.stores.find((candidate) => candidate.name === upload.storeName) : null; if (mode === 'cloud' && !store) throw new Error('云端报表请先在团队管理中新增或选择归属店铺。');
      state.upload.status = 'uploading'; state.upload.progress = 0; state.upload.error = ''; render();
      await runActivity(mode === 'cloud' ? `正在批量上传 ${items.length} 份团队报表` : `正在批量导入 ${items.length} 份本地报表`, async () => {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]; updateUploadItem(item.id, { status: 'uploading', error: '' }); state.upload.activeId = item.id; state.upload.progress = Math.round((index / items.length) * 100); render();
          try {
            if (mode === 'local') await importLocalUpload(item, upload);
            else {
              const form = new FormData(); form.append('file', item.file, item.file.name); form.append('storeId', store.id); form.append('type', item.type); form.append('periodKind', item.periodKind); form.append('periodStart', item.periodStart); form.append('periodEnd', item.periodEnd); form.append('reportDate', item.periodEnd); form.append('sourceName', upload.sourceName);
              await api(`/api/teams/${state.workspace.team.id}/reports`, { method: 'POST', body: form });
            }
            updateUploadItem(item.id, { status: 'success', error: '' });
          } catch (error) { updateUploadItem(item.id, { status: 'upload-error', error: error.message || '上传入库失败，请重试。' }); }
          state.upload.progress = Math.round(((index + 1) / items.length) * 100); render();
        }
        if (mode === 'cloud') await loadCloudWorkspace(); else state.localReports = await localReadAll();
      });
      const failed = state.upload.files.filter((item) => item.status === 'upload-error'); const successCount = state.upload.files.filter((item) => item.status === 'success').length;
      if (failed.length) { state.upload.status = 'partial'; state.upload.activeId = failed[0].id; state.upload.error = `${successCount} 份已入库，${failed.length} 份失败。修正后可直接重试失败项。`; setToast(state.upload.error, true); render(); }
      else { state.modal = ''; setToast(`${successCount} 份报表已批量入库并参与团队计算。`); render(); }
    } catch (error) { state.upload.status = 'error'; state.upload.progress = 0; state.upload.error = error.message || '批量上传失败。'; render(); }
  });
  document.querySelectorAll('[data-delete-report]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('确认删除这份报表？')) return; try { await runActivity('正在删除报表并重新计算', async () => { if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/reports/${button.dataset.deleteReport}`, { method: 'DELETE' }); await loadCloudWorkspace(); } else { await localDelete(button.dataset.deleteReport); state.localReports = await localReadAll(); } }); state.archiveUi.selectedIds = state.archiveUi.selectedIds.filter((id) => id !== button.dataset.deleteReport); setToast('报表已删除。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelectorAll('[data-delete-local]').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm('仅删除此浏览器中的本地副本，确定继续？')) return; await localDelete(button.dataset.deleteLocal); state.localReports = await localReadAll(); render(); }));
  document.querySelector('#export-local')?.addEventListener('click', () => downloadJson(`运营数据本地备份_${new Date().toISOString().slice(0, 10)}.json`, { reports: state.localReports.map(({ rawFile, ...report }) => report), metadata: state.localMeta }));
  document.querySelector('#clear-local')?.addEventListener('click', async () => { if (!window.confirm('将清空当前浏览器的全部本地报表、商品资料和销售扣除。确定继续？')) return; await localClear(); state.localReports = []; state.localMeta = { productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null }, salesDeductions: [] }; await localPutMeta(state.localMeta); render(); });
  document.querySelectorAll('[data-trend-toggle]').forEach((button) => button.addEventListener('click', () => { const metricName = button.dataset.trendToggle; state.trendMetrics = state.trendMetrics.includes(metricName) ? (state.trendMetrics.length > 1 ? state.trendMetrics.filter((item) => item !== metricName) : state.trendMetrics) : [...state.trendMetrics, metricName]; render(); }));
  document.querySelectorAll('[data-card-settings]').forEach((button) => button.addEventListener('click', () => { state.cardUi.openPanel = button.dataset.cardSettings; render(); }));
  document.querySelectorAll('[data-close-card-settings]').forEach((button) => button.addEventListener('click', () => { state.cardUi.openPanel = ''; render(); }));
  document.querySelector('[data-add-custom-card]')?.addEventListener('click', () => { const panel = state.cardUi.openPanel; const cards = loadCustomCards(panel); const used = new Set(cards.map((card) => card.metricId)); const metric = CUSTOM_METRICS.find((item) => !used.has(item.id)); if (!metric || cards.length >= 6) return; saveCustomCards(panel, [...cards, { id: `${panel}_${crypto.randomUUID()}`, metricId: metric.id }]); render(); });
  document.querySelectorAll('[data-card-delete]').forEach((button) => button.addEventListener('click', () => { const panel = state.cardUi.openPanel; saveCustomCards(panel, loadCustomCards(panel).filter((card) => card.id !== button.dataset.cardDelete)); render(); }));
  document.querySelectorAll('[data-card-metric]').forEach((select) => select.addEventListener('change', () => { const panel = state.cardUi.openPanel; saveCustomCards(panel, loadCustomCards(panel).map((card) => card.id === select.dataset.cardMetric ? { ...card, metricId: select.value } : card)); render(); }));
  document.querySelectorAll('[data-entity-keyword]').forEach((input) => input.addEventListener('input', (event) => { state.entityUi[event.currentTarget.dataset.entityKeyword].keyword = event.currentTarget.value; render(); }));
  document.querySelectorAll('[data-entity-filter-toggle]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterToggle); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; ui.filterMenu = ui.filterMenu === field ? '' : field; render(); }));
  document.querySelectorAll('[data-entity-filter-query]').forEach((input) => input.addEventListener('input', (event) => { const { kind, key: field } = parseEntityTarget(event.currentTarget.dataset.entityFilterQuery); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); ui[config.query] = event.currentTarget.value; ui.filterMenu = field; renderWithEntityFilterFocus(kind, field, event.currentTarget.selectionStart ?? event.currentTarget.value.length); }));
  document.querySelectorAll('[data-entity-filter-option]').forEach((input) => input.addEventListener('change', (event) => { const { kind, key: field } = parseEntityTarget(event.currentTarget.dataset.entityFilterOption); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); const value = event.currentTarget.value; const current = ui[config.selection] || []; if (ui[config.query].trim()) { ui[config.selection] = event.currentTarget.checked ? [value] : []; ui[config.query] = ''; } else ui[config.selection] = event.currentTarget.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); normalizeEntityLinkedSelection(kind, field); ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-filter-select-all]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterSelectAll); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); const names = [...document.querySelectorAll(`[data-entity-filter-option="${CSS.escape(`${kind}:${field}`)}"]`)].map((input) => input.value); ui[config.selection] = [...new Set([...(ui[config.selection] || []), ...names])]; normalizeEntityLinkedSelection(kind, field); ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-filter-clear]').forEach((button) => button.addEventListener('click', () => { const { kind, key: field } = parseEntityTarget(button.dataset.entityFilterClear); const ui = state.entityUi[kind]; if (!ui || !['category', 'model'].includes(field)) return; const config = entityFilterConfig(field); ui[config.selection] = []; ui[config.query] = ''; normalizeEntityLinkedSelection(kind, field); ui.filterMenu = field; render(); }));
  document.querySelectorAll('[data-entity-clear]').forEach((button) => button.addEventListener('click', () => { const ui = state.entityUi[button.dataset.entityClear]; Object.assign(ui, { keyword: '', categories: [], models: [], expanded: '', filterMenu: '', categoryQuery: '', modelQuery: '' }); render(); }));
  document.querySelectorAll('[data-entity-sort]').forEach((button) => button.addEventListener('click', () => { const [kind, key] = button.dataset.entitySort.split(':'); const ui = state.entityUi[kind]; if (ui.sort === key) ui.direction = ui.direction === 'asc' ? 'desc' : 'asc'; else { ui.sort = key; ui.direction = 'desc'; } render(); }));
  document.querySelectorAll('[data-entity-kind]').forEach((button) => button.addEventListener('click', () => toggleEntityExpansion(button)));
  document.querySelectorAll('[data-entity-table]').forEach((table) => table.addEventListener('scroll', () => { const ui = entityUi(table.dataset.entityTable); if (ui) ui.scrollTop = table.scrollTop; }, { passive: true }));
  document.querySelectorAll('[data-warehouse-panel]').forEach((button) => button.addEventListener('click', () => { state.warehousePanel = button.dataset.warehousePanel; render(); }));
  document.querySelector('#archive-type')?.addEventListener('change', (event) => { state.archiveUi.type = event.currentTarget.value; state.archiveUi.selectedIds = []; render(); });
  document.querySelector('#archive-store')?.addEventListener('change', (event) => { state.archiveUi.storeName = event.currentTarget.value; state.archiveUi.selectedIds = []; render(); });
  document.querySelectorAll('[data-toggle-store-group]').forEach((button) => button.addEventListener('click', () => { state.archiveUi.expandedStore = state.archiveUi.expandedStore === button.dataset.toggleStoreGroup ? '' : button.dataset.toggleStoreGroup; state.archiveUi.expandedDate = ''; render(); }));
  document.querySelectorAll('[data-toggle-report-group]').forEach((button) => button.addEventListener('click', () => { state.archiveUi.expandedDate = state.archiveUi.expandedDate === button.dataset.toggleReportGroup ? '' : button.dataset.toggleReportGroup; render(); }));
  document.querySelectorAll('[data-select-store-group]').forEach((input) => input.addEventListener('change', (event) => { const model = operationsModel(); const groups = groupedWarehouseReports((model.warehouse || []).filter((report) => (state.archiveUi.type === 'all' || report.type === state.archiveUi.type) && (!state.archiveUi.storeName || report.storeName === state.archiveUi.storeName))); const ids = groups.find((group) => group.key === event.currentTarget.dataset.selectStoreGroup)?.reports.filter((report) => report.status === 'active').map((report) => report.id) || []; const selected = new Set(state.archiveUi.selectedIds); for (const id of ids) { if (event.currentTarget.checked) selected.add(id); else selected.delete(id); } state.archiveUi.selectedIds = [...selected]; render(); }));
  document.querySelectorAll('[data-select-report-group]').forEach((input) => input.addEventListener('change', (event) => { const model = operationsModel(); const groups = groupedWarehouseReports((model.warehouse || []).filter((report) => (state.archiveUi.type === 'all' || report.type === state.archiveUi.type) && (!state.archiveUi.storeName || report.storeName === state.archiveUi.storeName))); const ids = groups.flatMap((store) => store.dateGroups).find((group) => group.key === event.currentTarget.dataset.selectReportGroup)?.reports.filter((report) => report.status === 'active').map((report) => report.id) || []; const selected = new Set(state.archiveUi.selectedIds); for (const id of ids) { if (event.currentTarget.checked) selected.add(id); else selected.delete(id); } state.archiveUi.selectedIds = [...selected]; render(); }));
  document.querySelectorAll('[data-select-report]').forEach((input) => input.addEventListener('change', (event) => { const selected = new Set(state.archiveUi.selectedIds); if (event.currentTarget.checked) selected.add(event.currentTarget.dataset.selectReport); else selected.delete(event.currentTarget.dataset.selectReport); state.archiveUi.selectedIds = [...selected]; render(); }));
  document.querySelector('[data-clear-archive-selection]')?.addEventListener('click', () => { state.archiveUi.selectedIds = []; render(); });
  document.querySelector('[data-delete-selected-reports]')?.addEventListener('click', async () => { const ids = [...state.archiveUi.selectedIds]; if (!ids.length || !window.confirm(`确认删除已选 ${ids.length} 份报表？`)) return; try { await runActivity(`正在删除 ${ids.length} 份报表并重新计算`, async () => { if (state.mode === 'cloud') { for (const id of ids) await api(`/api/teams/${state.workspace.team.id}/reports/${id}`, { method: 'DELETE' }); await loadCloudWorkspace(); } else { for (const id of ids) await localDelete(id); state.localReports = await localReadAll(); } }); state.archiveUi.selectedIds = []; setToast('已删除选中的报表。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelectorAll('[data-start-report-name]').forEach((button) => button.addEventListener('click', (event) => { const model = operationsModel(); const report = (model.warehouse || []).find((item) => item.id === event.currentTarget.dataset.startReportName); state.archiveUi.renameId = report?.id || ''; state.archiveUi.renameValue = report?.fileName || ''; render(); }));
  document.querySelector('[data-cancel-report-name]')?.addEventListener('click', () => { state.archiveUi.renameId = ''; state.archiveUi.renameValue = ''; render(); });
  document.querySelectorAll('[data-save-report-name]').forEach((button) => button.addEventListener('click', async (event) => { const id = event.currentTarget.dataset.saveReportName; const value = document.querySelector(`[data-rename-report-input="${CSS.escape(id)}"]`)?.value?.trim(); if (!value) return setToast('请输入归档显示名称。', true); try { if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: value }) }); await loadCloudWorkspace(); } else { const report = state.localReports.find((item) => item.id === id); if (!report) throw new Error('报表不存在。'); await localPut({ ...report, fileName: value }); state.localReports = await localReadAll(); } state.archiveUi.renameId = ''; setToast('归档名称已保存。'); render(); } catch (error) { setToast(error.message, true); } }));
  document.querySelector('#bulk-assign-store')?.addEventListener('click', async () => { const storeId = document.querySelector('#bulk-store-id')?.value; if (!storeId) return setToast('请选择要归属的店铺。', true); try { await runActivity('正在调整报表归属并重新计算', async () => { await api(`/api/teams/${state.workspace.team.id}/reports/bulk-store`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: state.archiveUi.selectedIds, storeId }) }); await loadCloudWorkspace(); }); state.archiveUi.selectedIds = []; setToast('报表归属已批量调整并立即重算。'); render(); } catch (error) { setToast(error.message, true); } });
  document.querySelector('[data-toggle-catalog-create]')?.addEventListener('click', () => { state.catalogUi.showCreate = !state.catalogUi.showCreate; render(); });
  document.querySelector('[data-cancel-catalog-create]')?.addEventListener('click', () => { state.catalogUi.showCreate = false; render(); });
  document.querySelector('[data-select-catalog-page]')?.addEventListener('change', (event) => {
    const entries = latestCatalog(operationsModel().core.productCatalog || []); const pageSize = 50; const start = state.catalogUi.page * pageSize; const visibleIds = entries.slice(start, start + pageSize).map((entry) => entry.id); const selected = new Set(state.catalogUi.selectedIds);
    for (const id of visibleIds) { if (event.currentTarget.checked) selected.add(id); else selected.delete(id); }
    state.catalogUi.selectedIds = [...selected]; render();
  });
  document.querySelectorAll('[data-select-catalog]').forEach((input) => input.addEventListener('change', (event) => { const selected = new Set(state.catalogUi.selectedIds); const id = event.currentTarget.dataset.selectCatalog; if (event.currentTarget.checked) selected.add(id); else selected.delete(id); state.catalogUi.selectedIds = [...selected]; render(); }));
  document.querySelectorAll('[data-catalog-bulk-field]').forEach((input) => input.addEventListener('input', (event) => { state.catalogUi[event.currentTarget.dataset.catalogBulkField] = event.currentTarget.value; }));
  document.querySelector('[data-clear-catalog-selection]')?.addEventListener('click', () => { state.catalogUi.selectedIds = []; state.catalogUi.bulkStoreName = ''; state.catalogUi.bulkCategory = ''; state.catalogUi.bulkModel = ''; render(); });
  document.querySelector('#catalog-bulk-edit')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ids = [...state.catalogUi.selectedIds]; const changes = Object.fromEntries([['storeName', state.catalogUi.bulkStoreName.trim()], ['category', state.catalogUi.bulkCategory.trim()], ['model', state.catalogUi.bulkModel.trim()]].filter(([, value]) => value));
    if (!ids.length) return setToast('请先勾选要修改的商品。', true);
    if (!Object.keys(changes).length) return setToast('请至少填写一项要修改的内容，留空字段不会改变。', true);
    try {
      await runActivity(`正在批量更新 ${ids.length} 条商品资料`, async () => {
        if (state.mode === 'cloud') {
          await api(`/api/teams/${state.workspace.team.id}/product-catalog/bulk`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, changes }) });
          await loadCloudWorkspace();
        } else {
          const currentEntries = latestCatalog(operationsModel().core.productCatalog || []); const currentById = new Map(currentEntries.map((entry) => [entry.id, entry])); const selected = ids.map((id) => currentById.get(id));
          if (selected.some((entry) => !entry)) throw new Error('部分商品资料已更新，请刷新后重新选择。');
          const createdAt = new Date().toISOString(); const updated = selected.map((entry) => ({ ...entry, ...changes, id: `catalog_${crypto.randomUUID()}`, replacesId: entry.id, sourceName: '网页批量维护', createdAt })); const selectedIds = new Set(ids); const proposed = [...currentEntries.filter((entry) => !selectedIds.has(entry.id)), ...updated]; const keys = new Set();
          for (const entry of proposed) { const key = catalogKey(entry); if (keys.has(key)) throw new Error(`批量修改后“${entry.storeName} + ${entry.productId}”将重复，未保存任何修改。`); keys.add(key); }
          state.localMeta = { ...state.localMeta, productCatalog: [...(state.localMeta.productCatalog || []), ...updated], productCatalogSource: { fileName: '网页批量维护', updatedAt: createdAt } }; await localPutMeta(state.localMeta);
        }
      });
      const count = ids.length; state.catalogUi.selectedIds = []; state.catalogUi.bulkStoreName = ''; state.catalogUi.bulkCategory = ''; state.catalogUi.bulkModel = ''; setToast(`已批量更新 ${count} 条商品资料，商品排行和品类 360 已重新计算。`); render();
    } catch (error) { setToast(error.message, true); }
  });
  document.querySelector('[data-export-local-catalog]')?.addEventListener('click', async () => { try { await runActivity('正在导出当前商品资料', async () => exportCatalogWorkbook(latestCatalog(state.localMeta.productCatalog || []), `商品资料_${utcDate()}.xlsx`)); setToast('当前商品资料已导出。'); } catch (error) { setToast(error.message, true); } });
  document.querySelector('[data-clear-catalog]')?.addEventListener('click', async () => {
    const model = operationsModel(); const count = latestCatalog(model.core.productCatalog || []).length;
    if (!count || !window.confirm(`确认清空当前团队的 ${count} 条商品资料？这不会删除报表、销售扣除或推广数据。`)) return;
    try {
      await runActivity('正在清空商品资料并重新计算', async () => {
        if (state.mode === 'cloud') { await api(`/api/teams/${state.workspace.team.id}/product-catalog`, { method: 'DELETE' }); await loadCloudWorkspace(); }
        else { state.localMeta = { ...state.localMeta, productCatalog: [], productCatalogSource: { fileName: '', updatedAt: null } }; await localPutMeta(state.localMeta); }
      });
      state.catalogUi.page = 0; state.catalogUi.selectedIds = []; setToast('商品资料已清空，商品排行和品类 360 已重新计算。'); render();
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
try { await bootstrap(); } catch (error) { state.bootstrapError = error?.message || '页面初始化失败，请重新加载。'; render(); }
