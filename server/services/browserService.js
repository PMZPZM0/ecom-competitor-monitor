import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileRoot = path.resolve(process.env.ECOM_MONITOR_PROFILE_DIR || path.resolve(__dirname, "../data/account-profiles"));
const profileDir = path.join(profileRoot, "legacy");
const accountProfilesDir = profileRoot;
const remotePort = Number(process.env.TAOBAO_BROWSER_PORT || 9223);
const captureBrowserIdleMs = Math.max(30_000, Number(process.env.CAPTURE_BROWSER_IDLE_MS || 300_000));
const stableChromeUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const browserProcesses = new Map();
const browserStartPromises = new Map();
const browserUsage = new Map();
const browserModes = new Map();

export function canReuseBrowser(runtimeHeadless, requestedHeadless) {
  return requestedHeadless || !runtimeHeadless;
}

function browserContext(options = {}) {
  const profileKey = String(options.profileKey || "legacy").replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    profileKey,
    profilePath: profileKey === "legacy" ? profileDir : path.join(accountProfilesDir, profileKey),
    port: Number(options.port || remotePort),
    headless: Boolean(options.headless),
    background: Boolean(options.background),
  };
}

function browserKey(options = {}) {
  const context = browserContext(options);
  return `${context.profileKey}:${context.port}`;
}

function cancelIdleClose(options = {}) {
  const state = browserUsage.get(browserKey(options));
  if (!state?.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

function beginCaptureBrowserUse(options = {}) {
  const key = browserKey(options);
  const state = browserUsage.get(key) || { active: 0, timer: null };
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.active += 1;
  browserUsage.set(key, state);
}

function endCaptureBrowserUse(options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  const state = browserUsage.get(key) || { active: 0, timer: null };
  state.active = Math.max(0, state.active - 1);
  if (state.active > 0) {
    browserUsage.set(key, state);
    return;
  }
  if (browserModes.get(key) !== "capture") {
    browserUsage.delete(key);
    return;
  }
  state.timer = setTimeout(() => {
    const current = browserUsage.get(key);
    if (!current || current.active > 0) return;
    current.timer = null;
    closeAccountBrowser(context).catch(() => undefined);
  }, captureBrowserIdleMs);
  state.timer.unref?.();
  browserUsage.set(key, state);
}

function chromeCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
  ].filter(Boolean);
}

function findChrome() {
  const found = chromeCandidates().find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("未找到 Chrome/Edge，请安装 Chrome 或在 .env 配置 CHROME_PATH。");
  return found;
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
    return /(^|\.)login\.taobao\.com$/i.test(parsed.hostname) || /\/login(?:[/.]|$)/i.test(parsed.pathname);
  } catch {
    return /login\.taobao\.com|\/login(?:[/.]|$)/i.test(String(url));
  }
}

export function isTaobaoLoginDocument(url = "", html = "") {
  return isTaobaoLoginUrl(url) || /手机扫码登录|密码登录|短信登录|请登录后继续|安全验证|请完成验证/i.test(String(html));
}

export async function openProductInAccountChrome(url, authSession) {
  const parsed = validateProductUrl(url);
  if (!authSession?.browserProfileKey || !authSession?.browserPort) {
    throw new Error("对应账号没有可复用的浏览器登录态，请重新授权该账号。");
  }

  const options = {
    profileKey: authSession.browserProfileKey,
    port: authSession.browserPort,
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
  if (!response.ok) throw new Error(`Chrome 调试接口不可用：${response.status}`);
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

async function startOrReuseBrowser(startUrl = "https://login.taobao.com/", options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  const runtime = await browserRuntimeState(context);
  if (runtime.ready && !browserModes.has(key)) browserModes.set(key, runtime.headless ? "capture" : "visible");
  if (runtime.ready && canReuseBrowser(runtime.headless, context.headless)) return { started: false, ...context };
  if (runtime.ready) {
    const cdp = await createCdp(runtime.version.webSocketDebuggerUrl);
    try {
      await cdp.send("Browser.close", {}, 10000);
    } finally {
      cdp.close();
    }
    for (let index = 0; index < 30; index++) {
      if (!(await isBrowserReady(context))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  fs.mkdirSync(context.profilePath, { recursive: true });
  const chromePath = findChrome();
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
    chromePath,
    launchArgs,
    { detached: true, stdio: "ignore", windowsHide: context.headless || context.background },
  );
  browserProcess.unref();
  browserProcesses.set(browserKey(context), browserProcess);
  browserModes.set(key, context.headless ? "capture" : context.background ? "background" : "visible");

  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await isBrowserReady(context)) return { started: true, ...context };
  }

  throw new Error("Chrome 已启动但调试接口未就绪。");
}

export async function ensureBrowser(startUrl = "https://login.taobao.com/", options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  cancelIdleClose(context);
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
  const script = `$port=${context.port}; Add-Type @'\nusing System;\nusing System.Collections.Generic;\nusing System.Runtime.InteropServices;\nusing System.Text;\npublic static class NativeWindow {\npublic delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);\n[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);\n[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\n[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);\n[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);\n[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\npublic static IntPtr FindWindow(int[] processIds) {\nvar ids = new HashSet<int>(processIds);\nvar found = IntPtr.Zero;\nEnumWindows((hWnd, lParam) => { uint pid; GetWindowThreadProcessId(hWnd, out pid); var name = new StringBuilder(256); GetClassName(hWnd, name, name.Capacity); if (ids.Contains((int)pid) && IsWindowVisible(hWnd) && name.ToString() == "Chrome_WidgetWin_1") { found = hWnd; return false; } return true; }, IntPtr.Zero);\nreturn found;\n}\n}\n'@; for($attempt=0;$attempt -lt 20;$attempt++){ $all=@(Get-CimInstance Win32_Process); $roots=@($all | Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and $_.CommandLine -match "--remote-debugging-port=$port(?:\\s|$)" }); $ids=@{}; foreach($root in $roots){$ids[$root.ProcessId]=$true}; do { $added=$false; foreach($item in $all){ if($ids.ContainsKey($item.ParentProcessId) -and -not $ids.ContainsKey($item.ProcessId)){ $ids[$item.ProcessId]=$true; $added=$true } } } while($added); $handle=[NativeWindow]::FindWindow([int[]]@($ids.Keys)); if($handle -ne [IntPtr]::Zero){ [NativeWindow]::ShowWindow($handle,${showCommand}) | Out-Null; ${bringToFront} exit }; Start-Sleep -Milliseconds 250 }`;
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
  const context = await ensureBrowser("about:blank", {
    profileKey: authSession.browserProfileKey,
    port: authSession.browserPort,
    headless: false,
    background: true,
  });
  await setBrowserWindowState(context, "minimize");
  return context;
}

export function minimizeAccountBrowser(options = {}) {
  return setBrowserWindowState(options, "minimize");
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
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
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
            pending.set(callId, { resolve: callResolve, reject: callReject });
            setTimeout(() => {
              if (!pending.has(callId)) return;
              pending.delete(callId);
              callReject(new Error(`CDP 调用超时：${method}`));
            }, timeoutMs);
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
    socket.addEventListener("error", () => reject(new Error("连接 Chrome 调试接口失败。")));
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

export async function openTaobaoLogin(options = {}) {
  const loginUrl = "https://login.taobao.com/member/login.jhtml";
  const context = await ensureBrowser("about:blank", { ...options, headless: false });
  const tab = await createTab(loginUrl, { ...context, headless: false });
  restoreAccountBrowser(context);
  return {
    ok: true,
    url: loginUrl,
    profileKey: context.profileKey,
    port: context.port,
    targetId: tab.id,
    message: "已打开独立淘宝登录窗口，请用淘宝 App 扫码；检测到真实账号身份后会自动同步并关闭窗口。",
  };
}

export async function getTaobaoCookieHeader(options = {}) {
  const state = await getTaobaoAuthState(options);
  return state.cookie;
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
  const cdp = await createCdp(version.webSocketDebuggerUrl);
  try {
    const { cookies } = await cdp.send("Storage.getCookies");
    const scoped = cookies.filter((cookie) => /\.(taobao|tmall)\.com$/i.test(cookie.domain) || /(taobao|tmall)\.com$/i.test(cookie.domain));
    const names = new Set(scoped.map((cookie) => cookie.name));
    const identityCookies = ["unb", "cookie17", "tracknick", "lgc", "_nk_", "sn", "munb"];
    const loggedIn = identityCookies.some((name) => names.has(name));
    const nicknameCookie = scoped.find((cookie) => ["tracknick", "lgc", "_nk_", "sn"].includes(cookie.name));
    let nickname = "";
    try {
      nickname = decodeURIComponent(nicknameCookie?.value || "");
    } catch {
      nickname = nicknameCookie?.value || "";
    }
    return {
      loggedIn,
      nickname,
      cookie: scoped.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      loginPageOpen: targets.some((target) => target.type === "page" && isTaobaoLoginUrl(target.url)),
      targets: targets.filter((target) => target.type === "page").map((target) => ({ id: target.id, url: target.url })),
    };
  } finally {
    cdp.close();
  }
}

export async function checkTaobaoSession(options = {}) {
  const context = browserContext({ ...options, headless: false, background: true });
  const page = await getRenderedHtml("https://i.taobao.com/my_taobao.htm", {
    browserProfileKey: context.profileKey,
    browserPort: context.port,
  });
  const loginPage = isTaobaoLoginDocument(page.finalUrl, page.html);
  return {
    loggedIn: Boolean(page.authState?.loggedIn && page.cookieHeader && !loginPage),
    cookie: page.cookieHeader || "",
    nickname: page.authState?.nickname || "",
    browserClosed: false,
    finalUrl: page.finalUrl,
    loginPage,
  };
}

export async function closeAccountBrowser(options = {}) {
  const context = browserContext(options);
  const key = browserKey(context);
  cancelIdleClose(context);
  if (!(await isBrowserReady(context))) {
    browserProcesses.delete(key);
    browserUsage.delete(key);
    browserModes.delete(key);
    return false;
  }
  try {
    const version = await getJson(`http://127.0.0.1:${context.port}/json/version`);
    const cdp = await createCdp(version.webSocketDebuggerUrl);
    try {
      await cdp.send("Browser.close", {}, 10000);
    } finally {
      cdp.close();
    }
    browserProcesses.delete(key);
    browserUsage.delete(key);
    browserModes.delete(key);
    for (let index = 0; index < 30; index++) {
      if (!(await isBrowserReady(context))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return true;
  } catch {
    const process = browserProcesses.get(key);
    if (process && !process.killed) process.kill();
    browserProcesses.delete(key);
    browserUsage.delete(key);
    browserModes.delete(key);
    return false;
  }
}

export async function getRenderedHtml(url, authSession = {}, renderOptions = {}) {
  const context = browserContext({ profileKey: authSession.browserProfileKey, port: authSession.browserPort, headless: false, background: true });
  beginCaptureBrowserUse(context);
  let tab = null;
  let cdp = null;
  try {
    // Captures reuse the account's persistent login browser. Always put it in
    // the background before opening a capture tab, even if an earlier manual
    // login/product-open action restored the window to the foreground.
    await minimizeBrowserForCapture(context);
    tab = await createBackgroundTab(context);
    await minimizeBrowserForCapture(context);
    cdp = await createCdp(tab.webSocketDebuggerUrl);
    await cdp.send("Network.enable");
    const priceResponses = new Map();
    const buyerShowResponses = new Map();
    cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
      const responseUrl = String(response?.url || "");
      const mimeType = String(response?.mimeType || "");
      const relevantUrl = /(?:\/h5\/mtop|mtop\.|detail|promotion|benefit|price|sku|rate|review|comment|evaluate|feed)/i.test(responseUrl);
      const buyerShowUrl = /(?:rate|review|comment|evaluate|feed)/i.test(responseUrl);
      const dataResponse = /json/i.test(mimeType) || /XHR|Fetch/i.test(type || "");
      if (!relevantUrl || !dataResponse || Number(response?.status || 0) >= 400) return;
      const target = buyerShowUrl ? buyerShowResponses : priceResponses;
      const limit = buyerShowUrl ? 80 : 60;
      if (target.size < limit) {
        target.set(requestId, { url: responseUrl, mimeType });
      }
    });
    await cdp.send("Network.setUserAgentOverride", { userAgent: stableChromeUserAgent });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 7000));
    if (renderOptions.selectSkuName) {
      const selectionResult = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const normalize = (value) => String(value || '').replace(/\\s+/g, '').replace(/[\\[\\]【】()（）]/g, '');
          const wanted = normalize(${JSON.stringify(renderOptions.selectSkuName)});
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
      if (selectionResult.result?.value?.clicked) await new Promise((resolve) => setTimeout(resolve, 3500));
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
    }
    if (renderOptions.captureBuyerShow) {
      const buyerShowTabResult = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const labels = ['买家秀', '晒单', '评价', '评论'];
          const target = Array.from(document.querySelectorAll('button,a,[role="tab"],[role="button"],div,span'))
            .map((element) => ({ element, text: String(element.textContent || '').replace(/\\s+/g, '') }))
            .filter(({ text }) => text.length <= 12 && labels.some((label) => text === label || text.includes(label)))
            .sort((left, right) => left.text.length - right.text.length)[0]?.element;
          if (!target) return { clicked: false };
          (target.closest('button,a,[role="tab"],[role="button"]') || target).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { clicked: true };
        })()`,
        returnByValue: true,
      }, 10000);
      if (buyerShowTabResult.result?.value?.clicked) {
        await new Promise((resolve) => setTimeout(resolve, 4200));
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const containers = Array.from(document.querySelectorAll('[role="dialog"],[class*="rate"],[class*="review"],[class*="comment"],[class*="evaluate"]'));
            const target = containers.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
            if (target && target.scrollHeight > target.clientHeight) target.scrollTo(0, Math.min(target.scrollHeight, 2400));
            return Boolean(target);
          })()`,
          returnByValue: true,
        }, 10000);
        await new Promise((resolve) => setTimeout(resolve, 2200));
      }
    }
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: "window.scrollTo(0, Math.min(document.body.scrollHeight, 3200)); undefined",
        returnByValue: true,
      },
      10000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    }, 70000);
    const visibleTextResult = await cdp.send("Runtime.evaluate", {
      expression: "document.body?.innerText || ''",
      returnByValue: true,
    }, 10000);
    const locationResult = await cdp.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    }, 10000);
    const authState = await getTaobaoAuthState(context);
    // Buyer-show responses are read first so large price telemetry cannot use
    // the payload budget before the delayed review requests finish.
    const responseEntries = [...buyerShowResponses, ...priceResponses];
    const bodyResults = await Promise.allSettled(responseEntries.map(async ([requestId, response]) => {
      const bodyResult = await cdp.send("Network.getResponseBody", { requestId }, 5000);
      return { ...response, body: String(bodyResult.body || "") };
    }));
    const networkPayloads = [];
    let networkBytes = 0;
    for (const result of bodyResults) {
      if (result.status !== "fulfilled" || networkBytes >= 12_000_000) continue;
      const payload = result.value;
      if (!payload.body || payload.body.length > 2_000_000) continue;
      networkBytes += payload.body.length;
      networkPayloads.push(payload);
    }
    return {
      html: result.result?.value || "",
      visibleText: visibleTextResult.result?.value || "",
      networkPayloads,
      finalUrl: locationResult.result?.value || tab.url,
      statusCode: 200,
      source: "browser",
      cookieHeader: authState.cookie || "",
      authState,
    };
  } finally {
    cdp?.close();
    if (tab?.id) await closeTab(tab.id, context);
    await minimizeBrowserForCapture(context);
    endCaptureBrowserUse(context);
  }
}
