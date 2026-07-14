import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "docs", "screenshots");
const appUrl = process.env.SCREENSHOT_APP_URL || "http://127.0.0.1:5173";
const apiUrl = process.env.SCREENSHOT_API_URL || "http://127.0.0.1:4317";
const screenshotOnly = process.env.SCREENSHOT_ONLY || "";
const port = 9431;
const profileDir = path.join(os.tmpdir(), `ecom-monitor-docs-${Date.now()}`);
const chromeCandidates = process.platform === "win32"
  ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];

async function firstExisting(paths) {
  for (const candidate of paths) {
    try { await fs.access(candidate); return candidate; } catch { /* try next */ }
  }
  throw new Error("未找到 Chrome 或 Edge，无法生成文档截图。");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* browser is still starting */ }
    await delay(250);
  }
  throw new Error(`等待浏览器调试端口超时：${url}`);
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      const queue = this.waiters.get(message.method);
      if (queue?.length) queue.shift()(message.params || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  wait(method, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      const queue = this.waiters.get(method) || [];
      queue.push(done);
      this.waiters.set(method, queue);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "页面脚本执行失败");
  return response.result?.value;
}

async function navigate(cdp, url) {
  const loaded = cdp.wait("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  await evaluate(cdp, "document.fonts?.ready", true).catch(() => undefined);
  await delay(700);
}

async function showPage(cdp, page) {
  await evaluate(cdp, `localStorage.setItem('tmall-monitor-active-page', ${JSON.stringify(page)}); localStorage.setItem('ecommerce-monitor-font-size', 'standard')`);
  await navigate(cdp, `${appUrl}/?docs=${page}&t=${Date.now()}`);
}

function sensitiveValues(overview) {
  const values = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (text.length >= 3) values.add(text);
  };
  const addSnapshot = (snapshot) => {
    if (!snapshot) return;
    [snapshot.title, snapshot.shopName, snapshot.model, snapshot.itemId].forEach(add);
    for (const sku of snapshot.skuPrices || []) {
      [
        sku.skuId, sku.name, sku.quantity, sku.quantityText,
        sku.price, sku.normalPrice, sku.surprisePrice, sku.coinPrice,
        sku.originalPrice, sku.giftPrice, sku.vipPrice, sku.governmentPrice,
        ...Object.values(sku.priceCalculation || {}),
      ].forEach(add);
      for (const accountPrice of sku.accountPrices || []) {
        [accountPrice.accountName, accountPrice.price, accountPrice.normalPrice, accountPrice.surprisePrice, accountPrice.coinPrice, accountPrice.giftPrice, accountPrice.vipPrice, accountPrice.originalPrice, ...Object.values(accountPrice.priceCalculation || {})].forEach(add);
      }
    }
  };
  for (const product of overview.products || []) {
    [product.name, product.group, product.shopName, product.model, product.itemId, product.url].forEach(add);
    addSnapshot(product.lastSnapshot);
  }
  for (const snapshot of overview.snapshots || []) addSnapshot(snapshot);
  for (const session of overview.authSessions || []) [session.id, session.name, session.browserProfileKey, session.browserPort].forEach(add);
  [overview.feishu?.documentUrl, overview.runtime?.dataDir, overview.runtime?.dbPath, overview.runtime?.profileDir].forEach(add);
  return [...values].sort((left, right) => right.length - left.length);
}

function mergeRects(rects) {
  const result = [];
  for (const rect of rects) {
    const existing = result.find((item) => !(rect.x > item.x + item.width + 3 || rect.x + rect.width + 3 < item.x || rect.y > item.y + item.height + 3 || rect.y + rect.height + 3 < item.y));
    if (!existing) {
      result.push({ ...rect });
      continue;
    }
    const right = Math.max(existing.x + existing.width, rect.x + rect.width);
    const bottom = Math.max(existing.y + existing.height, rect.y + rect.height);
    existing.x = Math.min(existing.x, rect.x);
    existing.y = Math.min(existing.y, rect.y);
    existing.width = right - existing.x;
    existing.height = bottom - existing.y;
  }
  return result;
}

async function redactionRects(cdp, sensitive, redactPrices) {
  return evaluate(cdp, `(() => {
    const sensitive = ${JSON.stringify(sensitive)};
    const redactPrices = ${JSON.stringify(Boolean(redactPrices))};
    const rects = [];
    const add = (element) => {
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth) return;
      rects.push({ x: Math.max(0, box.left - 4), y: Math.max(0, box.top - 3), width: Math.min(innerWidth, box.right + 4) - Math.max(0, box.left - 4), height: Math.min(innerHeight, box.bottom + 3) - Math.max(0, box.top - 3) });
    };
    document.querySelectorAll('main img, main video, [role="dialog"] img, [role="dialog"] video').forEach(add);
    const shouldRedact = (text) => sensitive.some((value) => text.includes(value))
      || /(?:商品|SKU)\\s*ID\\s*\\d{6,}/i.test(text)
      || (redactPrices && /[¥￥]\\s*\\d+(?:\\.\\d+)?|\\b\\d+\\.\\d{1,2}\\b/.test(text));
    document.querySelectorAll('main *, [role="dialog"] *').forEach((element) => {
      if (!element.textContent?.trim()) return;
      const text = element.textContent.trim();
      if (!shouldRedact(text)) return;
      if ([...element.children].some((child) => shouldRedact(child.textContent?.trim() || ''))) return;
      add(element);
    });
    return rects;
  })()`);
}

async function mosaic(buffer, rects) {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 1440;
  const height = metadata.height || 900;
  const overlays = [];
  for (const rect of mergeRects(rects)) {
    const left = Math.max(0, Math.floor(rect.x));
    const top = Math.max(0, Math.floor(rect.y));
    const regionWidth = Math.min(width - left, Math.max(2, Math.ceil(rect.width)));
    const regionHeight = Math.min(height - top, Math.max(2, Math.ceil(rect.height)));
    if (regionWidth < 2 || regionHeight < 2) continue;
    const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${regionWidth}" height="${regionHeight}">
      <defs><pattern id="m" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="#cbd5e1"/>
        <rect width="8" height="8" fill="#94a3b8"/>
        <rect x="8" y="8" width="8" height="8" fill="#64748b"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill="url(#m)"/>
    </svg>`);
    overlays.push({ input, left, top });
  }
  return sharp(buffer).composite(overlays).png({ compressionLevel: 9 }).toBuffer();
}

async function prepare(cdp, expression = "scrollTo(0, 0)") {
  await evaluate(cdp, expression, true);
  await delay(500);
  await evaluate(cdp, `Promise.race([Promise.all([...document.images].map((image) => image.complete ? null : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); }))), new Promise((resolve) => setTimeout(resolve, 3000))])`, true);
}

async function capture(cdp, sensitive, file, { page, action, requireRedaction = false, redactPrices = false } = {}) {
  if (screenshotOnly && file !== screenshotOnly) return;
  await showPage(cdp, page);
  await prepare(cdp, action);
  const rects = await redactionRects(cdp, sensitive, redactPrices);
  if (requireRedaction && !rects.length) throw new Error(`${file} 未识别到任何脱敏区域，已停止输出。`);
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const sanitized = await mosaic(Buffer.from(screenshot.data, "base64"), rects);
  await fs.writeFile(path.join(outputDir, file), sanitized);
  console.log(`${file}: ${rects.length} 个脱敏区域`);
}

const chromePath = await firstExisting(chromeCandidates);
const overviewResponse = await fetch(`${apiUrl}/api/overview`);
if (!overviewResponse.ok) throw new Error(`无法读取本地数据：HTTP ${overviewResponse.status}`);
const overview = await overviewResponse.json();
const sensitive = sensitiveValues(overview);
const featuredProduct = (overview.products || []).find((product) => product.lastSnapshot?.mainImage && product.lastSnapshot?.skuPrices?.length >= 2)
  || (overview.products || []).find((product) => product.lastSnapshot?.skuPrices?.length)
  || overview.products?.[0];
const featuredArticle = `Array.from(document.querySelectorAll('main article')).find((article) => article.textContent?.includes(${JSON.stringify(String(featuredProduct?.itemId || featuredProduct?.lastSnapshot?.itemId || ""))})) || document.querySelector('main article')`;
await fs.mkdir(outputDir, { recursive: true });
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { windowsHide: true, stdio: "ignore" });

let cdp;
try {
  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" }).then((response) => response.json());
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate(cdp, appUrl);

  await capture(cdp, sensitive, "dashboard-home.png", { page: "overview", action: "scrollTo(0, 0)" });
  await capture(cdp, sensitive, "product-workbench.png", { page: "overview", action: `(() => { const article = ${featuredArticle}; article?.scrollIntoView({ block: 'start' }); scrollBy(0, -76); })()`, requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "sku-monitor-overview.png", { page: "overview", action: `(() => { const article = ${featuredArticle}; const label = [...(article?.querySelectorAll('*') || [])].find((item) => item.textContent?.trim() === '最近抓取'); (label?.parentElement?.parentElement || article)?.scrollIntoView({ block: 'start' }); scrollBy(0, -76); })()`, requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "product-monitor-trend.png", { page: "overview", action: `(async () => { const article = ${featuredArticle}; article?.scrollIntoView({ block: 'start' }); await new Promise((resolve) => setTimeout(resolve, 900)); article?.querySelector('.product-price-trend')?.scrollIntoView({ block: 'start' }); scrollBy(0, -76); })()`, requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "sku-monitor-detail.png", { page: "overview", action: `(() => { const article = ${featuredArticle}; article?.scrollIntoView({ block: 'start' }); const button = [...(article?.querySelectorAll('button') || [])].find((item) => item.textContent?.trim() === '明细'); button?.click(); })()`, requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "monitor-queue.png", { page: "queue", action: "scrollTo(0, 0)", requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "capture-queue.png", { page: "capture-queue", action: "scrollTo(0, 0)", redactPrices: true });
  await capture(cdp, sensitive, "monitor-classification.png", { page: "categories", action: "scrollTo(0, 0)", requireRedaction: true, redactPrices: true });
  await capture(cdp, sensitive, "account-auth.png", { page: "auth", action: `(() => { const label = [...document.querySelectorAll('main *')].find((item) => item.textContent?.trim() === '已授权登录账号'); (label?.parentElement?.parentElement || label)?.scrollIntoView({ block: 'start' }); scrollBy(0, -76); })()`, requireRedaction: true });
  await capture(cdp, sensitive, "feishu-notifications.png", { page: "auth", action: `(() => { const label = [...document.querySelectorAll('main *')].find((item) => item.textContent?.trim() === '飞书价格提醒'); (label?.parentElement?.parentElement?.parentElement || label)?.scrollIntoView({ block: 'start' }); scrollBy(0, -76); })()`, redactPrices: true });
  await capture(cdp, sensitive, "usage-guide.png", { page: "guide", action: "scrollTo(0, 0)" });
  await capture(cdp, sensitive, "update-download.png", { page: "overview", action: `(() => { const button = document.querySelector('aside button[aria-label^="发现新版本"], aside button[aria-label^="检查更新"]'); button?.click(); })()` });
} finally {
  cdp?.close();
  chrome.kill();
  await delay(500);
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}
