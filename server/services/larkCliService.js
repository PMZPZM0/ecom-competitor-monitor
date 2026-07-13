import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(process.env.ECOM_MONITOR_RESOURCE_DIR || process.cwd());
const dataDir = path.resolve(process.env.ECOM_MONITOR_DATA_DIR || path.join(projectRoot, "server", "data"));
const cliScript = path.join(projectRoot, "node_modules", "@larksuite", "cli", "scripts", "run.js");
const qrPath = path.join(dataDir, "feishu-auth.png");
const cliEnv = { ...process.env };
delete cliEnv.HERMES_HOME;
delete cliEnv.OPENCLAW_HOME;
delete cliEnv.LARK_CHANNEL;

let setupState = { status: "idle", url: "", message: "", startedAt: null };
let authState = { status: "idle", url: "", message: "", startedAt: null };

function runCli(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliScript, ...args], {
      cwd: projectRoot,
      env: { ...cliEnv, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`飞书 CLI 执行超时：${args.slice(0, 2).join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout.trim() || stderr.trim();
      if (code === 0) resolve(output);
      else reject(new Error(readCliError(output) || `飞书 CLI 退出码 ${code}`));
    });
  });
}

function parseJson(output) {
  try { return JSON.parse(output); } catch { return null; }
}

function readCliError(output) {
  const parsed = parseJson(output);
  return parsed?.error?.message || parsed?.message || output;
}

function findUrl(value) {
  const parsed = parseJson(value);
  return parsed?.verification_url || parsed?.verification_uri_complete || parsed?.console_url || value.match(/https?:\/\/[^\s"']+/)?.[0] || "";
}

export async function cliStatus() {
  try {
    const version = await runCli(["--version"]);
    let auth = null;
    try { auth = parseJson(await runCli(["auth", "status", "--json"])); } catch (error) { auth = { ok: false, message: error.message }; }
    const userIdentity = auth?.identities?.user || auth?.data?.identities?.user;
    const botIdentity = auth?.identities?.bot || auth?.data?.identities?.bot;
    const configured = Boolean(auth?.appId || auth?.data?.appId || botIdentity?.available || userIdentity);
    return {
      installed: true,
      version: version.match(/[\d.]+/)?.[0] || version,
      configured,
      authenticated: Boolean(userIdentity?.available || auth?.data?.logged_in || auth?.logged_in),
      botReady: Boolean(botIdentity?.available),
      userStatus: userIdentity?.status || "missing",
      userMessage: userIdentity?.message || auth?.error?.message || auth?.message || "",
      setup: setupState,
      login: authState,
    };
  } catch (error) {
    return { installed: false, version: "", configured: false, authenticated: false, message: error.message, setup: setupState, login: authState };
  }
}

export function startCliSetup() {
  if (setupState.status === "running") return setupState;
  setupState = { status: "running", url: "", message: "正在创建飞书开放平台应用...", startedAt: new Date().toISOString() };
  const child = spawn(process.execPath, [cliScript, "config", "init", "--new", "--brand", "feishu", "--lang", "zh_cn"], {
    cwd: projectRoot,
    env: { ...cliEnv, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    windowsHide: true,
    shell: false,
  });
  let output = "";
  const consume = (data) => {
    output += data.toString();
    const url = findUrl(output);
    if (url) setupState = { ...setupState, url, message: "请在飞书开放平台完成应用创建。" };
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.on("error", (error) => { setupState = { ...setupState, status: "failed", message: error.message }; });
  child.on("close", (code) => {
    setupState = { ...setupState, status: code === 0 ? "completed" : "failed", message: code === 0 ? "飞书应用配置完成。" : readCliError(output) || `配置退出码 ${code}` };
  });
  return setupState;
}

export async function startCliLogin() {
  const output = await runCli(["auth", "login", "--domain", "docs,drive,im", "--recommend", "--no-wait", "--json"]);
  const parsed = parseJson(output);
  const url = parsed?.verification_url || parsed?.verification_uri_complete;
  const deviceCode = parsed?.device_code;
  if (!url || !deviceCode) throw new Error(readCliError(output) || "飞书 CLI 未返回扫码授权地址。");
  await fs.mkdir(path.dirname(qrPath), { recursive: true });
  await runCli(["auth", "qrcode", url, "--output", qrPath, "--size", "320"]);
  authState = { status: "waiting", url, message: "请使用飞书扫码并确认授权。", startedAt: new Date().toISOString() };
  runCli(["auth", "login", "--device-code", deviceCode], { timeoutMs: 10 * 60_000 })
    .then(() => { authState = { ...authState, status: "completed", message: "飞书扫码授权成功。" }; })
    .catch((error) => { authState = { ...authState, status: "failed", message: error.message }; });
  return authState;
}

export async function readAuthQr() {
  return fs.readFile(qrPath);
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function reportXml(product, snapshot, { includeTitle = false } = {}) {
  const shop = product.shopName || snapshot.shopName || "未知店铺";
  const model = product.model || snapshot.model || product.name || "未知型号";
  const thresholds = product.skuMonitorPrices || {};
  const anonymous = snapshot.accessMode === "anonymous";
  const accountType = product.accountType || "normal";
  const accountName = { normal: "普通账号", gift: "礼金账号", vip88: "88VIP账号" }[accountType] || "普通账号";
  const formattedPrice = (value, fallback = "未获取") => Number.isFinite(Number(value)) && Number(value) > 0 ? `¥${Number(value).toFixed(2)}` : fallback;
  const accountPrice = (sku, type, field, statusField, noneLabel) => {
    if (anonymous) return "需登录";
    if (Number.isFinite(Number(sku[field])) && Number(sku[field]) > 0) return formattedPrice(sku[field]);
    if (type !== accountType) return "不适用";
    return sku[statusField] === "none" ? noneLabel : "未获取";
  };
  const coinPrice = (sku) => anonymous
    ? "需登录"
    : Number.isFinite(Number(sku.coinPrice)) && Number(sku.coinPrice) > 0
      ? formattedPrice(sku.coinPrice)
      : sku.coinStatus === "none" ? "无淘金币" : "未获取";
  const rows = (snapshot.skuPrices || []).map((sku) => `<tr><td>${escapeXml(sku.name || sku.skuId)}</td><td>${escapeXml(sku.skuId)}</td><td>${formattedPrice(sku.normalPrice ?? sku.price, "未获取")}</td><td>${accountPrice(sku, "normal", "surprisePrice", "surpriseStatus", "无惊喜立减")}</td><td>${accountPrice(sku, "gift", "giftPrice", "giftStatus", "无礼金优惠")}</td><td>${accountPrice(sku, "vip88", "vipPrice", "vipStatus", "无88VIP优惠")}</td><td>${coinPrice(sku)}</td><td>${formattedPrice(thresholds[sku.skuId], "--")}</td></tr>`).join("");
  const introduction = includeTitle ? '<title>电商价格监控报告</title><callout emoji="📊" background-color="light-blue" border-color="blue"><p>系统自动记录各店铺、型号与 SKU 价格。每次抓取后追加最新数据。</p></callout>' : "";
  return `${introduction}<h2>${escapeXml(shop)} · ${escapeXml(model)}</h2><p><b>抓取时间：</b>${escapeXml(new Date(snapshot.capturedAt || Date.now()).toLocaleString("zh-CN", { hour12: false }))}</p><p><b>价格身份：</b>${anonymous ? "匿名公开价（不触发低价提醒）" : accountName}</p><table><thead><tr><th background-color="light-blue">SKU</th><th background-color="light-blue">SKU ID</th><th background-color="light-blue">普通价</th><th background-color="light-blue">惊喜立减价</th><th background-color="light-blue">礼金价</th><th background-color="light-blue">88VIP价</th><th background-color="light-blue">淘金币价</th><th background-color="light-blue">监控价</th></tr></thead><tbody>${rows}</tbody></table><p><a href="${escapeXml(product.url)}">打开商品</a></p><hr/>`;
}

export async function createPriceDocument(product) {
  const snapshot = product.lastSnapshot;
  if (!snapshot) throw new Error("商品还没有抓取快照，无法创建价格文档。");
  const output = await runCli(["docs", "+create", "--api-version", "v2", "--as", "user", "--content", reportXml(product, snapshot, { includeTitle: true }), "--format", "json"], { timeoutMs: 90_000 });
  const parsed = parseJson(output);
  const document = parsed?.data?.document;
  if (!parsed?.ok || !document?.document_id) throw new Error(readCliError(output) || "创建飞书价格文档失败。");
  return { documentId: document.document_id, documentUrl: document.url || "" };
}

export async function appendPriceDocument(documentId, product, snapshot) {
  const output = await runCli(["docs", "+update", "--api-version", "v2", "--as", "user", "--doc", documentId, "--command", "append", "--content", reportXml(product, snapshot), "--format", "json"], { timeoutMs: 90_000 });
  const parsed = parseJson(output);
  if (!parsed?.ok) throw new Error(readCliError(output) || "更新飞书价格文档失败。");
  return parsed;
}
