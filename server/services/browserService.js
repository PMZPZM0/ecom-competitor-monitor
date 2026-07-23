import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(process.env.ECOM_MONITOR_PROFILE_DIR || path.resolve(__dirname, "../data/account-profiles"));
const profileDir = path.join(profileRoot, "legacy");
const accountProfilesDir = profileRoot;
const remotePort = Number(process.env.TAOBAO_BROWSER_PORT || 9223);
const taobaoAuthUrls = ["https://i.taobao.com/my_taobao.htm", "https://www.taobao.com/", "https://detail.tmall.com/"];
const tmallSsoSyncHosts = new Set(["pass.tmall.com", "pass.tmall.hk"]);
const browserProcesses = new Map();
const browserStartPromises = new Map();
const browserModes = new Map();
const verifiedBrowserOwners = new Map();
const tmallSsoRefreshTimes = new Map();
const TMALL_SSO_REFRESH_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TMALL_PRICE_CAPABILITY_FRESH_MS = 24 * 60 * 60 * 1000;

export function browserRuntimeInfo() {
  return { profileDir: accountProfilesDir, captureBrowserIdleMs: 0, browserEngines: listBrowserEngines() };
}

export function shouldRefreshTmallSso(authSession = {}, { lastRefreshAt = 0, now = Date.now() } = {}) {
  if (authSession.tmallPriceStatus === "degraded") return true;
  const checkedAt = Date.parse(authSession.tmallPriceCheckedAt || "");
  const priceCapabilityFresh = authSession.tmallPriceStatus === "valid"
    && Number.isFinite(checkedAt)
    && now >= checkedAt
    && now - checkedAt < TMALL_PRICE_CAPABILITY_FRESH_MS;
  if (priceCapabilityFresh) return false;
  return !lastRefreshAt || now - lastRefreshAt >= TMALL_SSO_REFRESH_MIN_INTERVAL_MS;
}

const BROWSER_ENGINES = Object.freeze([
  { id: "uc", name: "UC 浏览器", downloadUrl: "https://www.uc.cn/", env: "UC_BROWSER_PATH" },
  { id: "360", name: "360 浏览器", downloadUrl: "https://browser.360.cn/", env: "BROWSER_360_PATH" },
  { id: "qq", name: "QQ 浏览器", downloadUrl: "https://browser.qq.com/", env: "QQ_BROWSER_PATH" },
  { id: "sogou", name: "搜狗浏览器", downloadUrl: "https://ie.sogou.com/", env: "SOGOU_BROWSER_PATH" },
  { id: "edge", name: "Microsoft Edge", downloadUrl: "https://www.microsoft.com/edge/download", env: "EDGE_BROWSER_PATH" },
]);

function browserEngineCandidates(engineId) {
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const definitions = {
    uc: [
      process.env.UC_BROWSER_PATH,
      path.join(local, "Programs/UC浏览器/uc.exe"),
      path.join(local, "UCBrowser/Application/UCBrowser.exe"),
    ],
    360: [
      process.env.BROWSER_360_PATH,
      path.join(local, "360Chrome/Chrome/Application/360chrome.exe"),
      path.join(local, "360ChromeX/Chrome/Application/360ChromeX.exe"),
      path.join(roaming, "360se6/Application/360se.exe"),
      "C:\\Program Files\\360\\360Chrome\\Chrome\\Application\\360chrome.exe",
      "C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe",
    ],
    qq: [
      process.env.QQ_BROWSER_PATH,
      path.join(local, "Tencent/QQBrowser/Application/QQBrowser.exe"),
      "C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe",
      "C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe",
    ],
    sogou: [
      process.env.SOGOU_BROWSER_PATH,
      path.join(local, "SogouExplorer/SogouExplorer.exe"),
      path.join(roaming, "SogouExplorer/SogouExplorer.exe"),
      "C:\\Program Files\\SogouExplorer\\SogouExplorer.exe",
      "C:\\Program Files (x86)\\SogouExplorer\\SogouExplorer.exe",
    ],
    edge: [
      process.env.EDGE_BROWSER_PATH,
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ],
  };
  return (definitions[engineId] || []).filter(Boolean);
}

function detectedBrowserEngines() {
  return BROWSER_ENGINES.map((engine) => {
    const executablePath = browserEngineCandidates(engine.id).find((candidate) => fs.existsSync(candidate)) || "";
    return { ...engine, available: Boolean(executablePath), executablePath };
  });
}

export function listBrowserEngines() {
  const engines = detectedBrowserEngines().map(({ executablePath: _executablePath, env: _env, ...engine }) => engine);
  const defaultEngine = "uc";
  return { defaultEngine, engines };
}

function normalizeBrowserEngine(value = "") {
  const requested = String(value || "").toLowerCase();
  if (requested === "legacy-google") return requested;
  if (BROWSER_ENGINES.some((engine) => engine.id === requested)) return requested;
  return listBrowserEngines().defaultEngine;
}

function findBrowserExecutable(engineId) {
  if (engineId === "legacy-google") {
    throw Object.assign(new Error("旧版浏览器环境已停用，请在账号卡片选择 UC 或其他浏览器后重新授权。"), {
      code: "LEGACY_GOOGLE_BROWSER_DISABLED",
      status: 409,
    });
  }
  const engine = detectedBrowserEngines().find((item) => item.id === normalizeBrowserEngine(engineId));
  if (!engine?.available) {
    throw Object.assign(new Error(`${engine?.name || "所选浏览器"}尚未安装，请先点击“安装”并完成官方安装。`), {
      code: "BROWSER_NOT_INSTALLED",
      status: 409,
    });
  }
  return engine.executablePath;
}

export function openBrowserInstallPage(engineId) {
  const engine = BROWSER_ENGINES.find((item) => item.id === String(engineId || "").toLowerCase());
  if (!engine) throw Object.assign(new Error("不支持该浏览器。"), { status: 400, code: "BROWSER_ENGINE_INVALID" });
  if (process.platform === "win32") {
    const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", engine.downloadUrl], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } else {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [engine.downloadUrl], { detached: true, stdio: "ignore" });
    child.unref();
  }
  return { ok: true, engine: { id: engine.id, name: engine.name, downloadUrl: engine.downloadUrl } };
}

function identityFromNetworkUrl(value) {
  try {
    const parsed = new URL(value);
    const data = JSON.parse(parsed.searchParams.get("data") || "{}");
    const exParams = typeof data.exParams === "string" ? JSON.parse(data.exParams) : data.exParams || {};
    return {
      itemId: String(exParams.itemId || exParams.itemNumId || data.itemId || data.itemNumId || data.id || parsed.searchParams.get("itemId") || parsed.searchParams.get("id") || ""),
      skuId: String(exParams.skuId || data.skuId || data.selectSkuId || parsed.searchParams.get("skuId") || ""),
    };
  } catch {
    return { itemId: "", skuId: "" };
  }
}

function productItemIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(?:^|\.)(?:taobao|tmall)\.com$/i.test(url.hostname)) return "";
    if (!/\/item\.html?$/i.test(url.pathname)) return "";
    const itemId = String(url.searchParams.get("id") || "");
    return /^\d{6,20}$/.test(itemId) ? itemId : "";
  } catch {
    return "";
  }
}

export function selectReusableCaptureTarget(targets = [], requestedUrl = "") {
  const requestedItemId = productItemIdFromUrl(requestedUrl);
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => (
    target?.type === "page"
    && target.webSocketDebuggerUrl
    && !isTaobaoLoginUrl(target.url)
  ));
  if (requestedItemId) {
    const exact = pages.find((target) => productItemIdFromUrl(target.url) === requestedItemId);
    if (exact) return { target: exact, reuseLoadedDocument: true };
  }
  const existingProduct = pages.find((target) => productItemIdFromUrl(target.url));
  if (existingProduct) return { target: existingProduct, reuseLoadedDocument: false };
  const blank = pages.find((target) => target.url === "about:blank");
  return blank ? { target: blank, reuseLoadedDocument: false } : null;
}

export function itemIdFromNetworkUrl(value) {
  return identityFromNetworkUrl(value).itemId;
}

export function skuIdFromNetworkUrl(value) {
  return identityFromNetworkUrl(value).skuId;
}

function parseNetworkBody(body) {
  const source = String(body || "").trim();
  const json = source.startsWith("{") ? source : source.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function identityFromNetworkBody(body) {
  const components = parseNetworkBody(body)?.data?.componentsVO;
  const value = components?.xsRedPacketParamVO?.trackParams;
  if (value) {
    try {
      const trackParams = typeof value === "string" ? JSON.parse(value) : value;
      const identity = {
        itemId: String(trackParams?.itemId || trackParams?.itemNumId || ""),
        skuId: String(trackParams?.skuId || ""),
      };
      if (identity.itemId || identity.skuId) return identity;
    } catch {
      return { itemId: "", skuId: "" };
    }
  }
  const ump = components?.umpPriceLogVO;
  const itemId = String(ump?.xobjectId || "");
  const skuId = String(ump?.sid || "");
  const map = String(ump?.map || "").trim();
  if (/^\d{5,30}$/.test(itemId) && /^\d{5,30}$/.test(skuId) && map.startsWith(`{${skuId}:`) && map.endsWith("}")) {
    return { itemId, skuId };
  }
  return { itemId: "", skuId: "" };
}

export function itemIdFromNetworkBody(body) {
  return identityFromNetworkBody(body).itemId;
}

export function skuIdFromNetworkBody(body) {
  return identityFromNetworkBody(body).skuId;
}

export function isTmallSilentLoginResponse(value) {
  return /\/newlogin\/silentHasLogin\.do/i.test(String(value || ""));
}

export function isTrustedTmallSilentLoginResponse(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && url.hostname === "login.taobao.com"
      && !url.port
      && !url.username
      && !url.password
      && url.pathname === "/newlogin/silentHasLogin.do";
  } catch {
    return false;
  }
}

export function tmallSsoSyncUrlsFromSilentLogin(body) {
  const data = parseNetworkBody(body)?.content?.data;
  const candidates = Array.isArray(data?.asyncUrls) ? data.asyncUrls : [];
  const urls = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(String(candidate));
      if (url.protocol !== "https:"
        || !tmallSsoSyncHosts.has(url.hostname)
        || url.port
        || url.username
        || url.password
        || url.pathname !== "/add") continue;
      urls.push(url.toString());
    } catch {
      // Ignore malformed or non-Tmall bridge URLs.
    }
  }
  return [...new Set(urls)];
}

export function summarizeTmallSilentLoginResponse(body) {
  const parsed = parseNetworkBody(body);
  const content = parsed?.content;
  const data = content?.data;
  return {
    parsed: Boolean(parsed && typeof parsed === "object"),
    rootKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [],
    contentKeys: content && typeof content === "object" ? Object.keys(content).sort() : [],
    dataKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
    asyncUrlCount: Array.isArray(data?.asyncUrls) ? data.asyncUrls.length : 0,
    success: content?.success === true,
  };
}

export function resetTmallSsoRefreshWindow(options = {}) {
  tmallSsoRefreshTimes.delete(browserKey(browserContext(options)));
}

export async function requestTmallSilentLoginBridge(cdp) {
  await evaluateBrowserPage(cdp, {
    expression: `new Promise((resolve) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); resolve(false); }, 5000);
      script.async = true;
      script.src = 'https://login.taobao.com/newlogin/silentHasLogin.do';
      script.onload = script.onerror = () => { clearTimeout(timer); script.remove(); resolve(true); };
      document.head.appendChild(script);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, { timeoutMs: 8000, attempts: 2, stage: "请求天猫同浏览器会话桥接" });
}

// Consume Tmall's one-time same-browser bridge only inside the authorized
// browser target. The URLs and response bodies never enter captured evidence.
export async function refreshTmallSsoFromCapturedLogin(cdp, responses = new Map(), { onDiagnostics = () => {} } = {}) {
  const silentResponses = [...responses.entries()].filter(([, response]) => (
    isTrustedTmallSilentLoginResponse(response?.url)
  ));
  if (!silentResponses.length) return false;
  const bodyResults = await Promise.allSettled(silentResponses.map(async ([requestId]) => {
    const result = await cdp.send("Network.getResponseBody", { requestId }, 5000);
    onDiagnostics(summarizeTmallSilentLoginResponse(result.body));
    return tmallSsoSyncUrlsFromSilentLogin(result.body);
  }));
  const syncUrls = [...new Set(bodyResults.flatMap((result) => (
    result.status === "fulfilled" ? result.value : []
  )))];
  if (!syncUrls.length) return false;
  await evaluateBrowserPage(cdp, {
    expression: `new Promise((resolve) => {
      const urls = ${JSON.stringify(syncUrls)};
      let pending = urls.length;
      const finish = () => { pending -= 1; if (pending <= 0) resolve(true); };
      for (const url of urls) {
        const script = document.createElement('script');
        const timer = setTimeout(() => { script.remove(); finish(); }, 4000);
        script.async = true;
        script.src = url;
        script.onload = script.onerror = () => { clearTimeout(timer); script.remove(); finish(); };
        document.head.appendChild(script);
      }
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, { timeoutMs: 10000, attempts: 2, stage: "同步天猫同浏览器会话" });
  return true;
}

export function isBuyerShowResponseUrl(value) {
  return /(?:rate|review|comment|evaluate)/i.test(String(value || ""));
}

export function shouldCaptureNetworkResponse(response = {}, type = "") {
  const responseUrl = String(response.url || "");
  const mimeType = String(response.mimeType || "");
  if (isTmallSilentLoginResponse(responseUrl)) return false;
  const relevantUrl = /(?:\/h5\/mtop|mtop\.|detail|promotion|benefit|price|sku|rate|review|comment|evaluate|feed)/i.test(responseUrl);
  const dataResponse = /json/i.test(mimeType) || /XHR|Fetch/i.test(type);
  return relevantUrl && dataResponse && Number(response.status || 0) < 400;
}

export function canReuseBrowser(runtimeHeadless, requestedHeadless) {
  return requestedHeadless || !runtimeHeadless;
}

export function shouldPreserveCaptureCache(options = {}) {
  if (options.preserveCache === false) return false;
  return options.localCapture === true || options.preserveCache === true;
}

function browserContext(options = {}) {
  const profileKey = String(options.profileKey || "legacy").replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    profileKey,
    profilePath: profileKey === "legacy" ? profileDir : path.join(accountProfilesDir, profileKey),
    port: Number(options.port || remotePort),
    headless: Boolean(options.headless),
    background: Boolean(options.background),
    browserEngine: options.browserEngine
      ? normalizeBrowserEngine(options.browserEngine)
      : options.profileKey && options.profileKey !== "legacy" ? "legacy-google" : normalizeBrowserEngine(),
  };
}

function browserKey(options = {}) {
  const context = browserContext(options);
  return `${context.profileKey}:${context.port}`;
}

function cookieMatchesUrl(cookie, value, now = Date.now()) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const domain = String(cookie?.domain || "").toLowerCase();
  const cookieHost = domain.replace(/^\./, "");
  const requestHost = url.hostname.toLowerCase();
  const domainMatches = domain.startsWith(".")
    ? requestHost === cookieHost || requestHost.endsWith(`.${cookieHost}`)
    : requestHost === cookieHost;
  if (!domainMatches || (cookie.secure && url.protocol !== "https:")) return false;
  const cookiePath = String(cookie.path || "/");
  const requestPath = url.pathname || "/";
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookie.expires > 0 && cookie.expires * 1000 <= now) return false;
  return Boolean(cookie.name);
}

function cookiesForUrls(cookies = [], urls = [], now = Date.now()) {
  const targets = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const candidates = cookies
    .map((cookie) => ({
      cookie,
      targetIndex: targets.findIndex((url) => cookieMatchesUrl(cookie, url, now)),
    }))
    .filter((entry) => entry.targetIndex >= 0)
    .sort((left, right) => left.targetIndex - right.targetIndex
      || String(right.cookie.domain || "").length - String(left.cookie.domain || "").length
      || String(right.cookie.path || "/").length - String(left.cookie.path || "/").length);
  const byName = new Map();
  for (const { cookie } of candidates) {
    if (!byName.has(cookie.name)) byName.set(cookie.name, cookie);
  }
  return [...byName.values()];
}

export function cookieHeaderForUrls(cookies = [], urls = [], now = Date.now()) {
  return cookiesForUrls(cookies, urls, now).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function taobaoCookieStateForUrls(cookies = [], urls = taobaoAuthUrls, now = Date.now()) {
  const identityScoped = cookiesForUrls(cookies, taobaoAuthUrls, now);
  const identityNames = new Set(identityScoped.map((cookie) => cookie.name));
  const identityCookies = ["unb", "cookie17", "tracknick", "lgc", "_nk_", "sn", "munb"];
  const nicknameCookie = identityScoped.find((cookie) => ["tracknick", "lgc", "_nk_", "sn"].includes(cookie.name));
  let nickname = "";
  try {
    nickname = decodeURIComponent(nicknameCookie?.value || "");
  } catch {
    nickname = nicknameCookie?.value || "";
  }
  return {
    loggedIn: identityCookies.some((name) => identityNames.has(name)),
    nickname,
    cookie: cookieHeaderForUrls(cookies, urls, now),
  };
}

export function classifyTaobaoSessionCheck({ authLoggedIn = false, hasCookie = false, loginPage = false, explicitLogin = false } = {}) {
  if (explicitLogin) return "expired";
  if (authLoggedIn && hasCookie && !loginPage) return "valid";
  return "degraded";
}

export function classifyPassiveTaobaoSession({ browserClosed = false, authLoggedIn = false, hasCookie = false, loginPageOpen = false, identityLoginRedirect = false } = {}) {
  if (browserClosed) return "degraded";
  if (identityLoginRedirect) return "expired";
  // A stale login tab is not proof that the persistent profile logged out.
  // Product-page redirects are checked separately and remain authoritative.
  if (authLoggedIn && hasCookie) return "valid";
  if (loginPageOpen) return "expired";
  return "degraded";
}

export function classifyTaobaoIdentityProbe({ authState = {}, finalUrl = "", html = "", visibleText = "" } = {}) {
  const loginPage = isTaobaoLoginDocument(finalUrl, `${visibleText}\n${html}`);
  return classifyTaobaoSessionCheck({
    authLoggedIn: Boolean(authState.loggedIn),
    hasCookie: Boolean(authState.cookie),
    loginPage,
    // A browser navigation that ends on Taobao's login host is authoritative.
    // Stale identity cookies must not keep an expired account marked online.
    explicitLogin: loginPage && isTaobaoLoginUrl(finalUrl),
  });
}

function browserSwitchValues(commandLine, switchName) {
  const command = String(commandLine || "");
  const pattern = new RegExp(`(?:^|\\s)(["']?)--${switchName}=`, "gi");
  const values = [];
  let match;
  while ((match = pattern.exec(command))) {
    const argumentQuote = match[1];
    const valueQuote = argumentQuote || (`"'`.includes(command[pattern.lastIndex]) ? command[pattern.lastIndex++] : "");
    if (valueQuote) {
      const end = command.indexOf(valueQuote, pattern.lastIndex);
      if (end < 0 || (command[end + 1] && !/\s/.test(command[end + 1]))) {
        values.push(null);
        continue;
      }
      values.push(command.slice(pattern.lastIndex, end));
      pattern.lastIndex = end + 1;
      continue;
    }
    const nextSwitch = command.slice(pattern.lastIndex).search(/\s+["']?--[a-z0-9-]+(?:=|["']?(?=\s|$))/i);
    values.push(command.slice(pattern.lastIndex, nextSwitch < 0 ? command.length : pattern.lastIndex + nextSwitch).trim());
    if (nextSwitch < 0) break;
    pattern.lastIndex += nextSwitch;
  }
  return values;
}

function normalizeBrowserProfilePath(value) {
  let source = String(value || "").trim();
  const windowsPath = /^[a-z]:[\\/]/i.test(source) || source.startsWith("\\\\");
  if (!windowsPath) source = source.replaceAll("\\ ", " ");
  const posixPath = !windowsPath && path.posix.isAbsolute(source);
  const pathApi = windowsPath ? path.win32 : posixPath ? path.posix : path;
  let normalized = pathApi.resolve(source);
  const foreignPath = (windowsPath && process.platform !== "win32") || (posixPath && process.platform === "win32");
  if (!foreignPath) {
    try {
      normalized = fs.realpathSync.native(normalized);
    } catch {
      // The ownership check can run before a newly selected profile directory exists.
    }
  }
  return windowsPath ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

export function browserCommandMatchesContext(commandLine, { profilePath: expectedProfilePath, port } = {}) {
  const expectedPort = Number(port);
  if (!expectedProfilePath || !Number.isInteger(expectedPort)) return false;
  const ports = browserSwitchValues(commandLine, "remote-debugging-port");
  const profiles = browserSwitchValues(commandLine, "user-data-dir");
  return ports.length === 1
    && /^\d+$/.test(ports[0])
    && Number(ports[0]) === expectedPort
    && profiles.length === 1
    && Boolean(profiles[0])
    && normalizeBrowserProfilePath(profiles[0]) === normalizeBrowserProfilePath(expectedProfilePath);
}

function localPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailableBrowserPort(reservedPorts = [], options = {}) {
  const start = Number(options.start || 9300);
  const end = Number(options.end || 9799);
  const isAvailable = options.isAvailable || localPortAvailable;
  const random = options.random || Math.random;
  const count = end - start + 1;
  const offset = Math.floor(random() * count) % count;
  const reserved = new Set(reservedPorts.map(Number));
  for (let index = 0; index < count; index += 1) {
    const port = start + ((offset + index) % count);
    if (!reserved.has(port) && await isAvailable(port)) return port;
  }
  throw new Error("没有可用的账号浏览器端口，请关闭旧版本软件后重试。");
}

function validateProductUrl(url) {
  const parsed = new URL(url);
  if (!/(^|\.)tmall\.com$|(^|\.)taobao\.com$/i.test(parsed.hostname)) {
    throw new Error("只支持打开淘宝或天猫商品链接。");
  }
  return parsed;
}

export function isTaobaoLoginUrl(url = "") {
  try {
    const parsed = new URL(url);
    return /^(?:login|passport)\.(?:m\.)?(?:taobao|tmall)\.com$/i.test(parsed.hostname);
  } catch {
    return /(?:login|passport)\.(?:m\.)?(?:taobao|tmall)\.com/i.test(String(url));
  }
}

export function isTaobaoIdentityLoginUrl(value = "") {
  if (!isTaobaoLoginUrl(value)) return false;
  try {
    const url = new URL(String(value));
    for (const key of ["redirectURL", "redirectUrl", "redirect_url"]) {
      const redirect = url.searchParams.get(key);
      if (!redirect) continue;
      const target = new URL(redirect);
      if (target.hostname === "i.taobao.com" && /\/(?:my_)?(?:i?taobao|mytaobao)/i.test(target.pathname)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isTmallLoginPageUrl(url = "") {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "login.tmall.com";
  } catch {
    return false;
  }
}

export function isTaobaoAccessRestrictedDocument(html = "") {
  return /访问行为存在异常|不当获取使用平台商业信息|系统将限制(?:该)?账号|再次违规将升级处置/i.test(String(html));
}

export function createTaobaoAccessRestrictedError(text = "", now = Date.now()) {
  const source = String(text || "");
  const match = source.match(/预计\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2})时(?:(\d{1,2})分)?/);
  const until = match
    ? Date.parse(`${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T${match[4].padStart(2, "0")}:${(match[5] || "0").padStart(2, "0")}:00+08:00`)
    : 0;
  const error = new Error("淘宝已限制当前账号访问，本次抓取已停止；全局自动监控保持原设置。请按页面提示恢复后再抓取，避免连续重试或重复授权。");
  error.code = "TAOBAO_ACCESS_RESTRICTED";
  error.status = 423;
  error.retryAfterMs = Number.isFinite(until) && until > now ? until - now + 5 * 60_000 : 24 * 60 * 60_000;
  return error;
}

export function isTaobaoLoginDocument(url = "", html = "") {
  const source = String(html);
  const hasProductData = /skuCore|skuBase|skuOptionsArea/i.test(source);
  const loginBridge = /pc-detail-ssr-2025[\s\S]{0,8000}\/(?:login_jump|close_iframe_page)|aluWVJSBridge[\s\S]{0,2000}sdkLogin|["']action["']\s*:\s*["']login["']/i.test(source);
  return isTaobaoLoginUrl(url)
    || isTaobaoAccessRestrictedDocument(source)
    || (!hasProductData && (/手机扫码登录|密码登录|短信登录|请登录后继续|安全验证|请完成验证/i.test(source) || loginBridge));
}

function assertAccountBrowserConfigured(authSession = {}) {
  if (authSession.browserEngine === "legacy-google") {
    throw Object.assign(new Error("旧版浏览器环境已停用，请在账号卡片选择 UC 浏览器后重新授权。"), {
      code: "LEGACY_GOOGLE_BROWSER_DISABLED",
      status: 409,
    });
  }
}

export async function openProductInAccountBrowser(url, authSession) {
  const parsed = validateProductUrl(url);
  if (!authSession?.browserProfileKey || !authSession?.browserPort) {
    throw new Error("对应账号没有可复用的浏览器登录态，请检测账号；只有明确失效时才重新扫码。");
  }
  assertAccountBrowserConfigured(authSession);

  const options = {
    profileKey: authSession.browserProfileKey,
    port: authSession.browserPort,
    browserEngine: authSession.browserEngine,
    headless: false,
  };
  const context = await ensureBrowser(parsed.toString(), options);
  if (!context.started) await createTab(parsed.toString(), options);
  restoreAccountBrowser(context);
  return {
    ok: true,
    url: parsed.toString(),
    accountName: authSession.name,
    accountType: authSession.accountType || "normal",
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`浏览器调试接口不可用：${response.status}`);
  return response.json();
}

async function browserRuntimeState(options = {}) {
  const context = browserContext(options);
  try {
    const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
    return {
      ready: true,
      headless: /HeadlessChrome/i.test(version["User-Agent"] || version.Browser || ""),
      version,
    };
  } catch {
    return { ready: false, headless: false, version: null };
  }
}

export async function isBrowserReady(options = {}) {
  const context = browserContext(options);
  try {
    await getJson(`http://127.0.0.1:${context.port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(processId) {
  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args = process.platform === "win32"
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(processId)}").CommandLine`,
      ]
    : ["-p", String(processId), "-o", "command="];
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || "").trim());
    });
  });
}

async function assertBrowserOwnership(context, version) {
  const key = browserKey(context);
  const cdp = await createCdp(version.webSocketDebuggerUrl);
  let processId;
  try {
    const processInfo = await cdp.send("SystemInfo.getProcessInfo", {}, 5000);
    processId = Number(processInfo.processInfo?.find((item) => item.type === "browser")?.id);
  } finally {
    cdp.close();
  }
  if (!Number.isFinite(processId)) throw new Error("无法确认账号浏览器进程归属，请重启软件后重试。");
  if (verifiedBrowserOwners.get(key) === processId) return true;
  const commandLine = await processCommandLine(processId);
  if (!browserCommandMatchesContext(commandLine, context)) {
    throw new Error("账号浏览器端口与资料目录不匹配；为避免串账号，本次操作已停止。请关闭旧版本软件后重试。");
  }
  verifiedBrowserOwners.set(key, processId);
  return true;
}

async function startOrReuseBrowser(startUrl = "https://login.taobao.com/", options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  const runtime = await browserRuntimeState(context);
  if (runtime.ready) await assertBrowserOwnership(context, runtime.version);
  if (runtime.ready && !browserModes.has(key)) browserModes.set(key, runtime.headless ? "capture" : "visible");
  if (runtime.ready && canReuseBrowser(runtime.headless, context.headless)) return { started: false, ...context };
  if (runtime.ready) {
    const cdp = await createCdp(runtime.version.webSocketDebuggerUrl);
    try {
      await cdp.send("Browser.close", {}, 10000);
    } finally {
      cdp.close();
    }
    verifiedBrowserOwners.delete(key);
    for (let index = 0; index < 30; index++) {
      if (!(await isBrowserReady(context))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  fs.mkdirSync(context.profilePath, { recursive: true });
  const browserPath = findBrowserExecutable(context.browserEngine);
  const launchArgs = [
    `--remote-debugging-port=${context.port}`,
    `--user-data-dir=${context.profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
  ];
  if (context.headless) {
    launchArgs.push(
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--window-size=1280,900",
      "--window-position=-32000,-32000",
    );
  } else if (context.background) {
    launchArgs.push("--window-size=1280,900", "--start-minimized");
    if (process.platform === "darwin") launchArgs.push("--window-position=-32000,-32000");
  } else {
    launchArgs.push("--window-size=1280,900");
  }
  launchArgs.push(startUrl);
  const browserProcess = spawn(
    browserPath,
    launchArgs,
    { detached: true, stdio: "ignore", windowsHide: context.headless || context.background },
  );
  browserProcess.unref();
  browserProcesses.set(browserKey(context), browserProcess);
  browserModes.set(key, context.headless ? "capture" : context.background ? "background" : "visible");

  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const startedRuntime = await browserRuntimeState(context);
    if (startedRuntime.ready) {
      await assertBrowserOwnership(context, startedRuntime.version);
      return { started: true, ...context };
    }
  }

  throw new Error(`${listBrowserEngines().engines.find((engine) => engine.id === context.browserEngine)?.name || "浏览器"}已启动但调试接口未就绪。`);
}

export async function ensureBrowser(startUrl = "https://login.taobao.com/", options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  const existingStart = browserStartPromises.get(key);
  if (existingStart) return existingStart;

  const startPromise = startOrReuseBrowser(startUrl, context).finally(() => {
    if (browserStartPromises.get(key) === startPromise) browserStartPromises.delete(key);
  });
  browserStartPromises.set(key, startPromise);
  return startPromise;
}

async function createTab(url, options = {}) {
  const requestedContext = browserContext(options);
  const context = await ensureBrowser(
    requestedContext.headless || requestedContext.background ? "about:blank" : "https://login.taobao.com/",
    requestedContext,
  );
  const response = await fetch(`http://127.0.0.1:${context.port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`打开浏览器标签失败：${response.status}`);
  return response.json();
}

async function createBackgroundTab(options = {}) {
  const requestedContext = browserContext({ ...options, background: true });
  const context = await ensureBrowser("about:blank", requestedContext);
  const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
  const browserCdp = await createCdp(version.webSocketDebuggerUrl);
  let targetId = "";
  try {
    const created = await browserCdp.send("Target.createTarget", { url: "about:blank", background: true }, 10000);
    targetId = created.targetId;
  } finally {
    browserCdp.close();
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await getJson(`http://127.0.0.1:${context.port}/json/list`).catch(() => []);
    const target = targets.find((item) => item.id === targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("后台抓取标签已创建，但调试接口未就绪。");
}

async function closeTab(id, options = {}) {
  const context = browserContext(options);
  try {
    await fetch(`http://127.0.0.1:${context.port}/json/close/${id}`);
  } catch {
    // Best effort cleanup only.
  }
}

function setBrowserWindowState(options = {}, state = "minimize") {
  const context = browserContext(options);
  if (process.platform !== "win32") return setBrowserWindowStateWithCdp(context, state);
  const showCommand = state === "restore" ? 9 : 6;
  const bringToFront = state === "restore" ? "[NativeWindow]::SetForegroundWindow($handle) | Out-Null;" : "";
  const script = `$port=${context.port}; Add-Type @'\nusing System;\nusing System.Collections.Generic;\nusing System.Runtime.InteropServices;\nusing System.Text;\npublic static class NativeWindow {\npublic delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);\n[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);\n[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\n[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);\n[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\npublic static IntPtr FindWindow(int[] processIds) {\nvar ids = new HashSet<int>(processIds);\nvar found = IntPtr.Zero;\nEnumWindows((hWnd, lParam) => { uint pid; GetWindowThreadProcessId(hWnd, out pid); var name = new StringBuilder(256); GetClassName(hWnd, name, name.Capacity); if (ids.Contains((int)pid) && IsWindowVisible(hWnd) && name.ToString() == "Chrome_WidgetWin_1") { found = hWnd; return false; } return true; }, IntPtr.Zero);\nreturn found;\n}\n}\n'@; for($attempt=0;$attempt -lt 20;$attempt++){ $all=@(Get-CimInstance Win32_Process); $roots=@($all | Where-Object { $_.Name -in @('uc.exe','360chrome.exe','360ChromeX.exe','360se.exe','QQBrowser.exe','SogouExplorer.exe','msedge.exe') -and $_.CommandLine -match "--remote-debugging-port=$port(?:\\s|$)" }); $ids=@{}; foreach($root in $roots){$ids[$root.ProcessId]=$true}; do { $added=$false; foreach($item in $all){ if($ids.ContainsKey($item.ParentProcessId) -and -not $ids.ContainsKey($item.ProcessId)){ $ids[$item.ProcessId]=$true; $added=$true } } } while($added); $handle=[NativeWindow]::FindWindow([int[]]@($ids.Keys)); if($handle -ne [IntPtr]::Zero){ [NativeWindow]::ShowWindow($handle,${showCommand}) | Out-Null; ${bringToFront} exit }; Start-Sleep -Milliseconds 250 }`;
  const helper = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const completed = new Promise((resolve) => {
    helper.once("exit", resolve);
    helper.once("error", resolve);
  });
  helper.unref();
  return completed;
}

async function setBrowserWindowStateWithCdp(options = {}, state = "minimize") {
  const context = browserContext(options);
  try {
    const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
    const cdp = await createCdp(version.webSocketDebuggerUrl);
    try {
      const targets = await cdp.send("Target.getTargets", {}, 10000);
      const pageTarget = targets.targetInfos?.find((target) => target.type === "page");
      if (!pageTarget) return false;
      const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: pageTarget.targetId }, 10000);
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: state === "restore" ? { windowState: "normal" } : { windowState: "minimized" },
      }, 10000);
      return true;
    } finally {
      cdp.close();
    }
  } catch {
    return false;
  }
}

export async function keepAccountBrowserWarm(authSession) {
  if (!authSession?.browserProfileKey || !authSession?.browserPort) return null;
  assertAccountBrowserConfigured(authSession);
  const context = await ensureBrowser("about:blank", {
    profileKey: authSession.browserProfileKey,
    port: authSession.browserPort,
    browserEngine: authSession.browserEngine,
    headless: false,
    background: true,
  });
  await setBrowserWindowState(context, "minimize");
  return context;
}

export async function minimizeAccountBrowser(options = {}) {
  const context = browserContext(options);
  const runtime = await browserRuntimeState(context);
  if (!runtime.ready) return false;
  await assertBrowserOwnership(context, runtime.version);
  return setBrowserWindowState(context, "minimize");
}

async function acquireBackgroundCaptureTab(url, options = {}) {
  const context = await ensureBrowser("about:blank", { ...options, background: true });
  const targets = await getJson(`http://127.0.0.1:${context.port}/json/list`).catch(() => []);
  const reusable = selectReusableCaptureTarget(targets, url);
  if (reusable) return { tab: reusable.target, reuseLoadedDocument: reusable.reuseLoadedDocument };
  return { tab: await createBackgroundTab(context), reuseLoadedDocument: false };
}

export async function closeAccountTab(id, options = {}) {
  if (!id) return false;
  await closeTab(id, options);
  return true;
}

function restoreAccountBrowser(options = {}) {
  setBrowserWindowState(options, "restore");
}

function createCdp(wsUrl) {
  let id = 0;
  const pending = new Map();
  const eventHandlers = new Map();
  const socket = new WebSocket(wsUrl);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const handler of eventHandlers.get(message.method) || []) handler(message.params || {});
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          const callId = ++id;
          socket.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((callResolve, callReject) => {
            const timer = setTimeout(() => {
              if (!pending.has(callId)) return;
              pending.delete(callId);
              callReject(new Error(`CDP 调用超时：${method}`));
            }, timeoutMs);
            pending.set(callId, { resolve: callResolve, reject: callReject, timer });
          });
        },
        on(method, handler) {
          const handlers = eventHandlers.get(method) || new Set();
          handlers.add(handler);
          eventHandlers.set(method, handlers);
          return () => handlers.delete(handler);
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("error", () => reject(new Error("连接浏览器调试接口失败。")));
  });
}

async function minimizeBrowserForCapture(options = {}) {
  const context = browserContext(options);
  if (!(await isBrowserReady(context))) return false;
  try {
    const [version, targets] = await Promise.all([
      getJson(`http://127.0.0.1:${context.port}/json/version`),
      getJson(`http://127.0.0.1:${context.port}/json/list`).catch(() => []),
    ]);
    const pageTarget = targets.find((target) => target.type === "page");
    if (!pageTarget) return setBrowserWindowState(context, "minimize");
    const cdp = await createCdp(version.webSocketDebuggerUrl);
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: pageTarget.id }, 5000);
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } }, 5000);
      return true;
    } finally {
      cdp.close();
    }
  } catch {
    await setBrowserWindowState(context, "minimize");
    return true;
  }
}

async function openLoginPage(loginUrl, options, message) {
  const context = await ensureBrowser("about:blank", { ...options, headless: false });
  const tab = await createTab(loginUrl, { ...context, headless: false });
  restoreAccountBrowser(context);
  return {
    ok: true,
    url: loginUrl,
    profileKey: context.profileKey,
    port: context.port,
    targetId: tab.id,
    message,
  };
}

export async function openTaobaoLogin(options = {}) {
  return openLoginPage(
    "https://login.taobao.com/member/login.jhtml",
    options,
    "已打开独立淘宝登录窗口，请用淘宝 App 扫码；检测到账号身份后会自动同步并最小化窗口。",
  );
}

export async function getTaobaoCookieHeader(options = {}) {
  const state = await getTaobaoAuthState(options);
  return state.cookie;
}

export async function exportTaobaoBrowserCookies(options = {}) {
  const context = browserContext({ ...options, headless: false, background: true });
  await ensureBrowser("about:blank", context);
  const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
  await assertBrowserOwnership(context, version);
  const cdp = await createCdp(version.webSocketDebuggerUrl);
  try {
    const { cookies } = await cdp.send("Storage.getCookies");
    return Array.isArray(cookies) ? cookies : [];
  } finally {
    cdp.close();
  }
}

export async function restoreTaobaoBrowserCookies(cookies = [], options = {}) {
  const context = browserContext({ ...options, headless: false, background: true });
  await ensureBrowser("about:blank", context);
  await minimizeBrowserForCapture(context);
  const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
  await assertBrowserOwnership(context, version);
  const browserCdp = await createCdp(version.webSocketDebuggerUrl);
  try {
    await browserCdp.send("Storage.setCookies", { cookies });
  } catch (error) {
    throw Object.assign(new Error(`写入登录包失败：${error.message}`), { code: "AUTH_BUNDLE_COOKIE_WRITE_FAILED", status: 409 });
  } finally {
    browserCdp.close();
  }

  const tab = await createTab("https://i.taobao.com/my_taobao.htm", context);
  await minimizeBrowserForCapture(context);
  const pageCdp = await createCdp(tab.webSocketDebuggerUrl);
  let document = { html: "", text: "", url: tab.url || "", readyState: "" };
  try {
    await pageCdp.send("Page.enable");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 700));
      document = await readBrowserDocument(pageCdp, { attempts: 2, timeoutMs: 5000, stage: "验证导入登录包" });
      if (document.readyState === "complete" || isTaobaoLoginUrl(document.url)) break;
    }
  } finally {
    pageCdp.close();
  }
  const authState = await getTaobaoAuthState(context);
  const status = classifyTaobaoIdentityProbe({
    authState,
    finalUrl: document.url,
    html: document.html,
    visibleText: document.text,
  });
  if (status !== "valid" || !authState.loggedIn || !authState.cookie) {
    throw Object.assign(new Error("登录包中的 Cookie 已失效，未创建账号。请重新扫码授权后导出新的登录包。"), {
      code: "AUTH_BUNDLE_LOGIN_EXPIRED",
      status: 409,
    });
  }
  await minimizeBrowserForCapture(context);
  return { ...authState, status, finalUrl: document.url };
}

export async function getTaobaoAuthState(options = {}) {
  const context = browserContext(options);
  if (!(await isBrowserReady(context))) {
    return { loggedIn: false, browserClosed: true, nickname: "", cookie: "" };
  }
  const [version, targets] = await Promise.all([
    getJson(`http://127.0.0.1:${context.port}/json/version`),
    getJson(`http://127.0.0.1:${context.port}/json/list`).catch(() => []),
  ]);
  await assertBrowserOwnership(context, version);
  const cdp = await createCdp(version.webSocketDebuggerUrl);
  try {
    const { cookies } = await cdp.send("Storage.getCookies");
    const requestedUrls = options.url ? [options.url] : options.urls?.length ? options.urls : taobaoAuthUrls;
    const cookieState = taobaoCookieStateForUrls(cookies, requestedUrls);
    return {
      ...cookieState,
      loginPageOpen: targets.some((target) => target.type === "page" && isTaobaoLoginUrl(target.url)),
      targets: targets.filter((target) => target.type === "page").map((target) => ({ id: target.id, url: target.url })),
    };
  } finally {
    cdp.close();
  }
}

export async function checkTaobaoSession(options = {}) {
  const context = browserContext({ ...options, headless: false, background: true });
  await ensureBrowser("about:blank", context).catch(() => undefined);
  const authState = await getTaobaoAuthState(context).catch((error) => ({
    loggedIn: false,
    cookie: "",
    browserClosed: true,
    error: error.message,
  }));
  const openLoginTarget = authState.targets?.find((target) => isTaobaoLoginUrl(target.url));
  const identityLoginTarget = authState.targets?.find((target) => isTaobaoIdentityLoginUrl(target.url));
  const status = classifyPassiveTaobaoSession({
    browserClosed: authState.browserClosed,
    authLoggedIn: authState.loggedIn,
    hasCookie: Boolean(authState.cookie),
    loginPageOpen: Boolean(openLoginTarget),
    identityLoginRedirect: Boolean(identityLoginTarget),
  });
  return {
    status,
    loggedIn: status === "valid",
    cookie: authState.cookie || "",
    nickname: authState.nickname || "",
    browserClosed: Boolean(authState.browserClosed),
    finalUrl: identityLoginTarget?.url || openLoginTarget?.url || "",
    loginPage: Boolean(openLoginTarget),
    ...(authState.error ? { error: authState.error } : {}),
  };
}

export async function closeAccountBrowser(options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  if (!(await isBrowserReady(context))) {
    browserProcesses.delete(key);
    browserModes.delete(key);
    verifiedBrowserOwners.delete(key);
    return false;
  }
  try {
    const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
    await assertBrowserOwnership(context, version);
    const cdp = await createCdp(version.webSocketDebuggerUrl);
    try {
      await cdp.send("Browser.close", {}, 10000);
    } finally {
      cdp.close();
    }
    browserProcesses.delete(key);
    browserModes.delete(key);
    verifiedBrowserOwners.delete(key);
    for (let index = 0; index < 30; index++) {
      if (!(await isBrowserReady(context))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return true;
  } catch {
    const process = browserProcesses.get(key);
    if (process && !process.killed) process.kill();
    browserProcesses.delete(key);
    browserModes.delete(key);
    verifiedBrowserOwners.delete(key);
    return false;
  }
}

export async function captureRequestedSkuSelections({
  cdp,
  requestedSelections = [],
  captureRunId,
  getResponseSequence,
  captureSelectedDocument,
  assertNoAccessRestriction = async () => {},
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  responseTimeoutMs = 6500,
  responseSettleMs = 900,
  warmupSelection = true,
}) {
  const selectValues = (valueIds) => cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const valueIds = ${JSON.stringify(valueIds)};
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const findValue = (valueId) => document.querySelector('#skuOptionsArea [data-vid="' + valueId + '"]')
        || Array.from(document.querySelectorAll('[data-vid]')).find((element) => element.getAttribute('data-vid') === valueId);
      const hydrationDeadline = Date.now() + 1500;
      const interactionDeadline = Date.now() + 6000;
      let targets = [];
      while (Date.now() < hydrationDeadline) {
        targets = valueIds.map(findValue);
        if (targets.every(Boolean)) break;
        await pause(150);
      }
      const clicked = [];
      for (const valueId of valueIds) {
        let target = findValue(valueId);
        while (!target && Date.now() < interactionDeadline) {
          await pause(100);
          target = findValue(valueId);
        }
        if (!target || target.getAttribute('data-disabled') === 'true') return { selected: false, clicked, missing: valueId };
        const clickable = target.closest('button,[role="button"]') || target;
        if (clickable.closest('a[href]')) return { selected: false, clicked, unsafeAnchor: valueId };
        clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
        const pointer = (type) => {
          const EventType = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          clickable.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, view: window, pointerType: 'mouse', isPrimary: true }));
        };
        pointer('pointerdown');
        clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        pointer('pointerup');
        clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        clickable.click();
        clicked.push(valueId);
        await pause(350);
      }
      return { selected: clicked.length === valueIds.length, clicked };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }, 8000);
  const waitForResponseSettle = async (responseSequenceStartExclusive) => {
    const deadline = now() + responseTimeoutMs;
    let observedSequence = Number(getResponseSequence());
    while (now() < deadline && observedSequence <= responseSequenceStartExclusive) {
      await wait(100);
      observedSequence = Number(getResponseSequence());
    }
    const responseReceived = observedSequence > responseSequenceStartExclusive;
    if (responseReceived && responseSettleMs > 0) {
      let quietSince = now();
      while (now() < deadline && now() - quietSince < responseSettleMs) {
        await wait(100);
        const nextSequence = Number(getResponseSequence());
        if (nextSequence > observedSequence) {
          observedSequence = nextSequence;
          quietSince = now();
        }
      }
    }
    return responseReceived;
  };

  const captureSelection = async (selection) => {
    const skuId = String(selection?.skuId || "");
    const valueIds = Array.from(new Set((selection?.valueIds || []).map(String).filter(Boolean)));
    const responseSequenceStartExclusive = Number(getResponseSequence());
    const baseResult = {
      skuId,
      selected: false,
      responseReceivedAfterSelection: false,
      captureRunId,
      responseSequenceStartExclusive,
    };
    if (!skuId || !valueIds.length) {
      return {
        ...baseResult,
        responseSequenceEndInclusive: Number(getResponseSequence()),
        reason: "missing-selection-ids",
      };
    }

    let selectionResult;
    try {
      selectionResult = await selectValues(valueIds);
    } catch (error) {
      return {
        ...baseResult,
        responseSequenceEndInclusive: Number(getResponseSequence()),
        reason: /超时|timed?\s*out/i.test(String(error?.message || "")) ? "runtime-timeout" : "runtime-error",
      };
    }

    const selected = Boolean(selectionResult.result?.value?.selected);
    const clicked = selectionResult.result?.value?.clicked || [];
    let responseReceivedAfterSelection = false;
    if (selected) {
      responseReceivedAfterSelection = await waitForResponseSettle(responseSequenceStartExclusive);
    }
    let responseSequenceEndInclusive = Number(getResponseSequence());
    let documentCaptured = false;
    let documentCaptureError = "";
    await assertNoAccessRestriction();
    if (selected && typeof captureSelectedDocument === "function") {
      try {
        await captureSelectedDocument({
          skuId,
          selected: true,
          clicked,
          captureRunId,
          responseReceivedAfterSelection,
          responseSequenceStartExclusive,
          responseSequenceEndInclusive,
        });
        documentCaptured = true;
        responseSequenceEndInclusive = Number(getResponseSequence());
      } catch (error) {
        if (error?.code === "TAOBAO_ACCESS_RESTRICTED") throw error;
        documentCaptureError = String(error?.message || error || "读取 SKU 页面失败");
      }
    }
    return {
      ...baseResult,
      selected,
      responseReceivedAfterSelection,
      responseSequenceEndInclusive,
      clicked,
      ...(typeof captureSelectedDocument === "function" ? { documentCaptured } : {}),
      reason: selectionResult.result?.value?.missing
        ? `missing-value:${selectionResult.result.value.missing}`
        : selectionResult.result?.value?.unsafeAnchor
          ? `unsafe-anchor:${selectionResult.result.value.unsafeAnchor}`
          : documentCaptureError
            ? `document-capture-error:${documentCaptureError}`
            : documentCaptured
              ? "document-captured"
              : responseReceivedAfterSelection ? "response-received" : "response-timeout",
    };
  };

  const selectable = requestedSelections.filter((selection) => (
    String(selection?.skuId || "")
    && Array.from(new Set((selection?.valueIds || []).map(String).filter(Boolean))).length
  ));
  let warmedSelection;
  if (warmupSelection && selectable.length > 1) {
    const selection = selectable.at(-1);
    try {
      const result = await captureSelection(selection);
      if (result.selected && result.responseReceivedAfterSelection && (
        typeof captureSelectedDocument !== "function" || result.documentCaptured
      )) warmedSelection = { selection, result };
    } catch {
      // A normal selection pass still runs when the warmup cannot produce reusable evidence.
    }
  }

  const selectionResults = [];
  for (const selection of requestedSelections) {
    if (warmedSelection?.selection === selection) {
      selectionResults.push(warmedSelection.result);
      warmedSelection = undefined;
      continue;
    }
    selectionResults.push(await captureSelection(selection));
  }
  return selectionResults;
}

export function waitForBrowserCaptureSignal(cdp, {
  timeoutMs = 5000,
  responseMatches = ({ response }) => shouldCaptureNetworkResponse(response, "XHR"),
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let responseOff = () => {};
    let lifecycleOff = () => {};
    let timer;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      responseOff();
      lifecycleOff();
      resolve(reason);
    };
    responseOff = cdp.on("Network.responseReceived", (event) => {
      if (responseMatches(event)) finish("matching-response");
    });
    lifecycleOff = cdp.on("Page.lifecycleEvent", ({ name }) => {
      if (name === "networkAlmostIdle" || name === "networkIdle") finish(name);
    });
    timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

export function waitForBrowserDocumentSignal(cdp, {
  timeoutMs = 7000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let domOff = () => {};
    let loadOff = () => {};
    let lifecycleOff = () => {};
    let timer;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      domOff();
      loadOff();
      lifecycleOff();
      resolve(reason);
    };
    domOff = cdp.on("Page.domContentEventFired", () => finish("dom-content-loaded"));
    loadOff = cdp.on("Page.loadEventFired", () => finish("load"));
    lifecycleOff = cdp.on("Page.lifecycleEvent", ({ name }) => {
      if (["DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle"].includes(name)) finish(name);
    });
    timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

export function isTransientRuntimeEvaluationError(error) {
  return /(?:CDP .*Runtime\.evaluate|Execution context was destroyed|ExecutionContext was destroyed|Cannot find (?:default )?context|Inspected target navigated|No frame with given id|Target closed)/i
    .test(String(error?.message || error || ""));
}

export async function evaluateBrowserPage(cdp, params, {
  attempts = 3,
  timeoutMs = 10000,
  retryDelayMs = 400,
  stage = "读取页面",
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await cdp.send("Runtime.evaluate", params, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isTransientRuntimeEvaluationError(error) || attempt === attempts) break;
      await wait(retryDelayMs * attempt);
    }
  }
  const error = new Error(`${stage}失败：${String(lastError?.message || lastError || "Runtime.evaluate 未返回结果")}`);
  error.cause = lastError;
  throw error;
}

export async function readBrowserDocument(cdp, {
  attempts = 3,
  timeoutMs = 70000,
  retryDelayMs = 500,
  stage = "读取商品页证据",
  wait,
} = {}) {
  const result = await evaluateBrowserPage(cdp, {
    expression: `(() => ({
      html: document.documentElement?.outerHTML || '',
      text: document.body?.innerText || '',
      url: window.location.href,
      readyState: document.readyState,
    }))()`,
    returnByValue: true,
  }, { attempts, timeoutMs, retryDelayMs, stage, ...(wait ? { wait } : {}) });
  return result.result?.value || { html: "", text: "", url: "", readyState: "" };
}

export async function getRenderedHtml(url, authSession = {}, renderOptions = {}) {
  assertAccountBrowserConfigured(authSession);
  const context = browserContext({ profileKey: authSession.browserProfileKey, port: authSession.browserPort, browserEngine: authSession.browserEngine, headless: false, background: true });
  let tab = null;
  let cdp = null;
  try {
    // Captures reuse the account's persistent login browser. Always put it in
    // the background before opening a capture tab, even if an earlier manual
    // login/product-open action restored the window to the foreground.
    await minimizeBrowserForCapture(context);
    const acquired = await acquireBackgroundCaptureTab(url, context);
    tab = acquired.tab;
    await minimizeBrowserForCapture(context);
    cdp = await createCdp(tab.webSocketDebuggerUrl);
    await cdp.send("Network.enable");
    const preserveCache = shouldPreserveCaptureCache(renderOptions);
    if (!preserveCache) {
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    }
    const priceResponses = new Map();
    const tmallSsoResponses = new Map();
    let tmallSsoObserved = false;
    let tmallSsoAttempted = false;
    let tmallSsoRefreshed = false;
    let tmallSsoDiagnostics = null;
    const buyerShowResponses = new Map();
    const buyerShowInteractions = [];
    const observedVideoResponses = new Set();
    const captureRunId = randomUUID();
    let pcdetailResponseSequence = 0;
    let requestedSelections = Array.isArray(renderOptions.selectSkus) ? renderOptions.selectSkus : [];
    const selectSkuNames = Array.isArray(renderOptions.selectSkuNames)
      ? renderOptions.selectSkuNames.filter(Boolean)
      : renderOptions.selectSkuName ? [renderOptions.selectSkuName] : [];
    if (requestedSelections.length && !preserveCache) await cdp.send("Network.clearBrowserCache");
    // Selection IDs may be derived from the first local DOM snapshot below.
    // Compute the diagnostic response budget lazily so a late SKU list does
    // not stay stuck at the single-page default.
    const priceResponseLimit = () => Math.max(60, (requestedSelections.length + selectSkuNames.length) * 4);
    cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
      if (renderOptions.captureNetworkResponses === false) return;
      const responseUrl = String(response?.url || "");
      const mimeType = String(response?.mimeType || "");
      if (isTrustedTmallSilentLoginResponse(responseUrl) && Number(response?.status || 0) < 400) {
        tmallSsoObserved = true;
        tmallSsoResponses.set(requestId, { url: responseUrl });
        return;
      }
      if (renderOptions.captureVideo && (
        /video/i.test(mimeType)
        || /Media/i.test(type)
        || /\.(?:mp4|m3u8)(?:$|[?#])/i.test(responseUrl)
      ) && observedVideoResponses.size < 24) observedVideoResponses.add(responseUrl);
      const buyerShowUrl = isBuyerShowResponseUrl(responseUrl);
      if (!shouldCaptureNetworkResponse(response, type)) return;
      const target = buyerShowUrl ? buyerShowResponses : priceResponses;
      const limit = buyerShowUrl ? 80 : priceResponseLimit();
      const isPcdetailResponse = /mtop\.taobao\.pcdetail\.data\.adjust/i.test(responseUrl);
      const responseSequence = isPcdetailResponse ? ++pcdetailResponseSequence : null;
      if (target.size < limit) {
        target.set(requestId, {
          url: responseUrl,
          mimeType,
          responseKind: buyerShowUrl ? "buyer-show" : "price",
          captureRunId,
          ...(responseSequence ? { responseSequence } : {}),
        });
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const assertNoAccessRestriction = async () => {
      const pageState = await evaluateBrowserPage(cdp, {
        expression: "({ url: window.location.href, text: document.body?.innerText || '' })",
        returnByValue: true,
      }, { timeoutMs: 10000, attempts: 3, stage: "检查商品页访问状态" });
      const url = String(pageState.result?.value?.url || "");
      const text = String(pageState.result?.value?.text || "");
      if (isTaobaoAccessRestrictedDocument(text)) throw createTaobaoAccessRestrictedError(text);
      if (isTaobaoLoginUrl(url)) {
        const error = new Error("账号登录已明确失效：商品页跳转到淘宝登录页。");
        error.tmallSsoObserved = tmallSsoObserved;
        error.tmallSsoAttempted = tmallSsoAttempted;
        error.tmallSsoRefreshed = tmallSsoRefreshed;
        error.tmallSsoDiagnostics = tmallSsoDiagnostics;
        throw error;
      }
      return text;
    };
    const requestedHost = new URL(url).hostname.toLowerCase();
    const tmallSsoRefreshKey = browserKey(context);
    const tmallSsoRefreshNeeded = requestedHost.endsWith(".tmall.com")
      && shouldRefreshTmallSso(authSession, { lastRefreshAt: tmallSsoRefreshTimes.get(tmallSsoRefreshKey) || 0 });
    const navigateToProduct = async () => {
      const initialCaptureSignal = waitForBrowserCaptureSignal(cdp, {
        timeoutMs: Number(renderOptions.pageReadyTimeoutMs || 5000),
        responseMatches: ({ response, type }) => shouldCaptureNetworkResponse(response, type)
          && /(?:pcdetail|detail|promotion|benefit|price|sku)/i.test(String(response?.url || "")),
      });
      const initialDocumentSignal = waitForBrowserDocumentSignal(cdp, {
        timeoutMs: Number(renderOptions.pageReadyTimeoutMs || 7000),
      });
      await cdp.send("Page.navigate", { url });
      await Promise.all([initialCaptureSignal, initialDocumentSignal]);
    };
    await navigateToProduct();
    if (tmallSsoRefreshNeeded) {
      tmallSsoAttempted = true;
      tmallSsoRefreshTimes.set(tmallSsoRefreshKey, Date.now());
      try {
        if (!tmallSsoResponses.size) await requestTmallSilentLoginBridge(cdp);
        tmallSsoRefreshed = await refreshTmallSsoFromCapturedLogin(cdp, tmallSsoResponses, {
          onDiagnostics: (diagnostics) => { tmallSsoDiagnostics = diagnostics; },
        });
      } catch {
        tmallSsoRefreshed = false;
      }
      tmallSsoResponses.clear();
      if (tmallSsoRefreshed) {
        priceResponses.clear();
        pcdetailResponseSequence = 0;
        await navigateToProduct();
      }
    }
    await assertNoAccessRestriction();
    if (!requestedSelections.length && typeof renderOptions.prepareSelectionsFromLocalEvidence === "function") {
      const [documentState, authState] = await Promise.all([
        readBrowserDocument(cdp, { attempts: 3, timeoutMs: 70000, stage: "读取 SKU 索引证据" }),
        getTaobaoAuthState(context),
      ]);
      const prepared = await renderOptions.prepareSelectionsFromLocalEvidence({
        html: documentState.html,
        visibleText: documentState.text,
        networkPayloads: [],
        buyerShowInteractions: [],
        mediaObservations: {},
        selectionResults: [],
        finalUrl: documentState.url || tab.url,
        statusCode: 200,
        source: "browser",
        cookieHeader: authState.cookie || "",
        authState,
      });
      requestedSelections = Array.isArray(prepared) ? prepared : [];
    }
    const skuSnapshots = [];
    const selectionResults = await captureRequestedSkuSelections({
      cdp,
      requestedSelections,
      captureRunId,
      getResponseSequence: () => pcdetailResponseSequence,
      captureSelectedDocument: async ({
        skuId,
        selected,
        clicked,
        responseSequenceStartExclusive,
        responseSequenceEndInclusive,
      }) => {
        const skuDocument = await readBrowserDocument(cdp, {
          attempts: 3,
          timeoutMs: 70000,
          stage: `读取 SKU ${skuId} 页面证据`,
        });
        if (isTaobaoAccessRestrictedDocument(`${skuDocument.text}\n${skuDocument.html}`)) {
          throw createTaobaoAccessRestrictedError(skuDocument.text || skuDocument.html);
        }
        skuSnapshots.push({
          skuId,
          selected,
          clicked,
          capturedAt: new Date().toISOString(),
          html: skuDocument.html,
          visibleText: skuDocument.text,
          finalUrl: skuDocument.url || tab.url,
          responseSequenceStartExclusive,
          responseSequenceEndInclusive: Math.max(responseSequenceEndInclusive, Number(pcdetailResponseSequence)),
        });
      },
      assertNoAccessRestriction,
    });
    for (const selectSkuName of selectSkuNames) {
      const selectionResult = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const normalize = (value) => String(value || '').replace(/\\s+/g, '').replace(/[\\[\\]【】()（）]/g, '');
          const wanted = normalize(${JSON.stringify(selectSkuName)});
          const target = Array.from(document.querySelectorAll('button,[role="button"],div,span'))
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const text = normalize(element.textContent);
              return rect.width > 20 && rect.height > 15 && text && (text === wanted || text.includes(wanted));
            })
            .sort((left, right) => normalize(left.textContent).length - normalize(right.textContent).length)[0];
          if (!target) return { clicked: false };
          const clickable = target.closest('button,[role="button"]') || target.closest('[class*="sku"],[class*="Sku"]') || target;
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { clicked: true, text: target.textContent };
        })()`,
        returnByValue: true,
      }, 10000);
      if (selectionResult.result?.value?.clicked) await new Promise((resolve) => setTimeout(resolve, 2200));
      await assertNoAccessRestriction();
    }
    if (renderOptions.captureVideo) {
      const videoTabResult = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const target = Array.from(document.querySelectorAll('button,[role="button"],div,span,a'))
            .find((element) => String(element.textContent || '').replace(/\\s+/g, '') === '视频');
          if (!target) return { clicked: false };
          (target.closest('button,[role="button"],a') || target).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { clicked: true };
        })()`,
        returnByValue: true,
      }, 10000);
      if (videoTabResult.result?.value?.clicked) await new Promise((resolve) => setTimeout(resolve, 2200));
      await assertNoAccessRestriction();
      await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
          const steps = Math.min(8, Math.max(1, Math.ceil(maxScroll / Math.max(innerHeight * 1.5, 900))));
          for (let index = 1; index <= steps; index += 1) {
            window.scrollTo(0, Math.round(maxScroll * index / steps));
            await pause(400);
          }
          return { steps, scrollHeight: document.documentElement.scrollHeight };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, 15000);
      await assertNoAccessRestriction();
    }
    if (renderOptions.captureBuyerShow) {
      for (let attempt = 0; attempt < 2 && buyerShowResponses.size === 0; attempt += 1) {
        const buyerShowTabResult = await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const priorities = ['查看全部评价', '全部评价', '用户评价', '买家秀', '晒单', '评价', '评论'];
            const normalize = (value) => String(value || '').replace(/\\s+/g, '');
            const candidates = Array.from(document.querySelectorAll('button,a,[role="tab"],[role="button"],div,span'))
              .map((element) => ({ element, text: normalize(element.textContent), rect: element.getBoundingClientRect() }))
              .filter(({ text, rect }) => rect.width > 20 && rect.height > 15 && text.length <= 16 && priorities.some((label) => text === label || text.startsWith(label)))
              .sort((left, right) => {
                const leftRank = priorities.findIndex((label) => left.text === label || left.text.startsWith(label));
                const rightRank = priorities.findIndex((label) => right.text === label || right.text.startsWith(label));
                return leftRank - rightRank || left.text.length - right.text.length || (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height);
              });
            const candidate = candidates[${attempt}] || candidates[0];
            if (!candidate) return { clicked: false };
            const target = candidate.element.closest('button,a,[role="tab"],[role="button"],[class*="Button"],[class*="button"],[class*="Btn"],[class*="btn"]') || candidate.element;
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
              target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            }
            target.click?.();
            return {
              clicked: true,
              text: candidate.text,
              candidateTag: candidate.element.tagName,
              candidateClass: String(candidate.element.className || '').slice(0, 180),
              targetTag: target.tagName,
              targetClass: String(target.className || '').slice(0, 180),
              targetRole: target.getAttribute('role') || '',
              targetHref: target.getAttribute('href') || '',
            };
          })()`,
          returnByValue: true,
        }, 10000);
        buyerShowInteractions.push({ attempt: attempt + 1, ...(buyerShowTabResult.result?.value || { clicked: false }) });
        if (buyerShowTabResult.result?.value?.clicked) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 4800 : 3600));
        await assertNoAccessRestriction();
        if (buyerShowResponses.size === 0 && attempt === 0) {
          await cdp.send("Runtime.evaluate", {
            expression: "window.scrollTo(0, Math.min(document.body.scrollHeight, 3600)); undefined",
            returnByValue: true,
          }, 10000);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (buyerShowResponses.size > 0) {
        let previousResponseCount = buyerShowResponses.size;
        let unchangedAttempts = 0;
        for (let pageAttempt = 0; pageAttempt < 4 && unchangedAttempts < 2; pageAttempt += 1) {
          const scrollResult = await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              const candidates = Array.from(document.querySelectorAll('[role="dialog"],div,section,main,ul'))
                .map((element) => ({ element, rect: element.getBoundingClientRect() }))
                .filter(({ element, rect }) => rect.width > 280 && rect.height > 160 && rect.bottom > 0 && rect.top < innerHeight && element.scrollHeight > element.clientHeight + 80)
                .sort((left, right) => right.element.scrollHeight - left.element.scrollHeight);
              const scrolled = [];
              for (const { element } of candidates.slice(0, 6)) {
                const before = element.scrollTop;
                element.scrollTop = Math.min(element.scrollHeight, before + Math.max(element.clientHeight * 0.85, 500));
                if (element.scrollTop !== before) scrolled.push({ tag: element.tagName, className: String(element.className || '').slice(0, 120), before, after: element.scrollTop, height: element.scrollHeight });
              }
              return scrolled;
            })()`,
            returnByValue: true,
          }, 10000);
          buyerShowInteractions.push({ attempt: `scroll-${pageAttempt + 1}`, scrolled: scrollResult.result?.value || [] });
          await new Promise((resolve) => setTimeout(resolve, 2200));
          if (buyerShowResponses.size > previousResponseCount) unchangedAttempts = 0;
          else unchangedAttempts += 1;
          previousResponseCount = buyerShowResponses.size;
        }
      }
    }
    if (renderOptions.captureVideo || renderOptions.captureBuyerShow) {
      await cdp.send(
        "Runtime.evaluate",
        {
          expression: "window.scrollTo(0, Math.min(document.body.scrollHeight, 3200)); undefined",
          returnByValue: true,
        },
        10000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, Number(renderOptions.finalRestrictionSettleMs || 1200)));
    await assertNoAccessRestriction();
    const documentState = await readBrowserDocument(cdp, {
      attempts: 3,
      timeoutMs: 70000,
      stage: "读取最终商品页证据",
    });
    const mediaObservationResult = renderOptions.captureVideo
      ? await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const attributes = ['currentSrc', 'src', 'data-src', 'data-ks-lazyload', 'data-original', 'data-lazyload', 'data-lazy-src', 'data-video', 'data-video-url'];
          const values = (element) => attributes.map((attribute) => attribute === 'currentSrc' ? element.currentSrc : element.getAttribute?.(attribute)).filter(Boolean);
          const context = (element) => {
            const parts = [];
            let current = element;
            for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) parts.push(current.id || '', String(current.className || ''));
            return parts.join(' ');
          };
          const images = [];
          const galleryImages = [];
          const detailImages = [];
          const videoUrls = [];
          for (const image of document.querySelectorAll('img')) {
            const urls = values(image);
            images.push(...urls);
            const owner = context(image);
            if (/thumbnail|gallery|mainpic|viewer|headimage/i.test(owner)) galleryImages.push(...urls);
            if (/desc|detail|description|imagetext|modulepic/i.test(owner)) detailImages.push(...urls);
          }
          for (const media of document.querySelectorAll('video,source,[data-video],[data-video-url]')) videoUrls.push(...values(media));
          for (const entry of performance.getEntriesByType('resource')) if (/\\.(?:mp4|m3u8)(?:$|[?#])/i.test(entry.name || '')) videoUrls.push(entry.name);
          const unique = (items, limit) => Array.from(new Set(items.map(String).filter(Boolean))).slice(0, limit);
          return {
            images: unique(images, 240),
            galleryImages: unique(galleryImages, 24),
            detailImages: unique(detailImages, 160),
            videoUrls: unique(videoUrls, 24),
          };
        })()`,
        returnByValue: true,
      }, 10000)
      : { result: { value: {} } };
    if (isTaobaoAccessRestrictedDocument(`${documentState.text}\n${documentState.html}`)) {
      throw createTaobaoAccessRestrictedError(documentState.text || documentState.html);
    }
    // Keep the identity check on canonical Taobao URLs. A Tmall product page
    // may not receive the `.taobao.com` identity cookies by URL scope even
    // though this same persistent browser is still signed in.
    const authState = await getTaobaoAuthState(context);
    // Buyer-show responses are read first so large price telemetry cannot use
    // the payload budget before the delayed review requests finish.
    // JSONP login bridges can contain one-time session tokens and must never
    // enter the local evidence file.
    const responseEntries = [...buyerShowResponses, ...priceResponses]
      .filter(([, response]) => !isTmallSilentLoginResponse(response.url));
    const bodyResults = await Promise.allSettled(responseEntries.map(async ([requestId, response]) => {
      const bodyResult = await cdp.send("Network.getResponseBody", { requestId }, 5000);
      return {
        ...response,
        body: String(bodyResult.body || ""),
      };
    }));
    const networkPayloads = [];
    let networkBytes = 0;
    for (const result of bodyResults) {
      const networkByteLimit = requestedSelections.length > 1 || selectSkuNames.length > 1 ? 24_000_000 : 12_000_000;
      if (result.status !== "fulfilled" || networkBytes >= networkByteLimit) continue;
      const payload = result.value;
      if (!payload.body || payload.body.length > 2_000_000) continue;
      networkBytes += payload.body.length;
      networkPayloads.push(payload);
    }
    const buyerShowPayloads = networkPayloads.filter((payload) => payload.responseKind === "buyer-show");
    const priceNetworkPayloads = networkPayloads.filter((payload) => payload.responseKind === "price");
    const capturedPage = {
      html: documentState.html,
      visibleText: documentState.text,
      networkPayloads,
      buyerShowPayloads,
      buyerShowInteractions,
      mediaObservations: {
        ...(mediaObservationResult.result?.value || {}),
        videoUrls: Array.from(new Set([
          ...(mediaObservationResult.result?.value?.videoUrls || []),
          ...observedVideoResponses,
        ])).slice(0, 24),
      },
      priceNetworkPayloads,
      skuNetworkPayloads: {},
      skuSnapshots,
      selectionResults,
      tmallSsoSync: {
        attempted: tmallSsoAttempted,
        observed: tmallSsoObserved,
        refreshed: tmallSsoRefreshed,
      },
      finalUrl: documentState.url || tab.url,
      statusCode: 200,
      source: "browser",
      cookieHeader: authState.cookie || "",
      authState,
    };
    // Persist sanitized evidence while the browser tab is still alive. The
    // caller must finish the local write before this function closes CDP/tab.
    // No parser runs here; this hook only records the browser observation.
    if (typeof renderOptions.persistEvidenceBeforeClose === "function") {
      await renderOptions.persistEvidenceBeforeClose(capturedPage);
    }
    return capturedPage;
  } finally {
    cdp?.close();
    await minimizeBrowserForCapture(context);
  }
}
