import { qwenPawBackendUrl, startQwenPawBackend } from "./qwenPawRuntimeService.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_ID = "default";
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const qwenPawQrDirectory = path.resolve(process.env.ECOM_MONITOR_DATA_DIR || path.resolve(__dirname, "../data"), "qwenpaw-login-qr");

function clean(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

export function targetKey(target) {
  return [target.channel, target.userId, target.sessionId].join(":");
}

export function normalizeQwenPawFeishuTarget(value) {
  const channel = clean(value?.channel, 40);
  const userId = clean(value?.userId ?? value?.user_id, 500);
  const sessionId = clean(value?.sessionId ?? value?.session_id, 500);
  if (channel !== "feishu" || !userId || !sessionId) return null;
  return { channel, userId, sessionId };
}

export function normalizeQwenPawFeishuTargets(values) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const target = normalizeQwenPawFeishuTarget(value);
    if (target) unique.set(targetKey(target), target);
  }
  return [...unique.values()].slice(0, 40);
}

export function normalizeQwenPawAlerts(value = {}) {
  return {
    belowThresholdTargets: normalizeQwenPawFeishuTargets(value?.belowThresholdTargets),
    loginExpiredTargets: normalizeQwenPawFeishuTargets(value?.loginExpiredTargets),
  };
}

function displayTarget(item) {
  return {
    channel: "feishu",
    userId: clean(item?.user_id, 500),
    sessionId: clean(item?.session_id, 500),
    label: clean(item?.user_id || item?.session_id, 200),
  };
}

async function qwenPawRequest(runtime, pathname, options = {}) {
  const response = await fetch(qwenPawBackendUrl(runtime, pathname), {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Agent-Id": AGENT_ID,
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { /* Keep backend text. */ }
  if (!response.ok) {
    const detail = clean(parsed?.detail || parsed?.message || body, 600);
    throw new Error(detail || `QwenPaw 飞书接口返回 ${response.status}。`);
  }
  return parsed;
}

export async function listQwenPawFeishuTargets(installDirectory) {
  const runtime = await startQwenPawBackend(installDirectory);
  const payload = await qwenPawRequest(runtime, `/api/agents/${AGENT_ID}/cron/dispatch-targets?channel=feishu`);
  const targets = new Map();
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const target = normalizeQwenPawFeishuTarget(displayTarget(item));
    if (target) targets.set(targetKey(target), { ...target, label: displayTarget(item).label });
  }
  return [...targets.values()];
}

export async function sendQwenPawFeishuText(installDirectory, target, message) {
  const normalized = normalizeQwenPawFeishuTarget(target);
  if (!normalized) throw new Error("QwenPaw 飞书通知目标无效，请刷新并重新选择。" );
  const text = clean(message, MAX_MESSAGE_LENGTH);
  if (!text) throw new Error("QwenPaw 飞书通知内容为空。" );
  const runtime = await startQwenPawBackend(installDirectory);
  return qwenPawRequest(runtime, "/api/messages/send", {
    method: "POST",
    body: JSON.stringify({
      channel: normalized.channel,
      target_user: normalized.userId,
      target_session: normalized.sessionId,
      text,
    }),
  });
}

export async function saveQwenPawLoginQr(sessionId, image) {
  const data = Buffer.from(image || []);
  if (!sessionId || !data.length || data.length > MAX_QR_IMAGE_BYTES || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("登录二维码图片无效。");
  }
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeId) throw new Error("登录账号标识无效。");
  const fileId = `${safeId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const filePath = path.join(qwenPawQrDirectory, `${fileId}.png`);
  await fs.mkdir(qwenPawQrDirectory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, data, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  return fileId;
}

function qwenPawQrPath(fileId) {
  if (!/^[a-zA-Z0-9_-]{4,160}$/.test(String(fileId || ""))) throw new Error("登录二维码文件标识无效。");
  return path.join(qwenPawQrDirectory, `${fileId}.png`);
}

export async function readQwenPawLoginQr(fileId) {
  const image = await fs.readFile(qwenPawQrPath(fileId));
  if (!image.length || image.length > MAX_QR_IMAGE_BYTES) throw new Error("登录二维码文件不可用。");
  return image;
}

export async function deleteQwenPawLoginQr(fileId) {
  await fs.rm(qwenPawQrPath(fileId), { force: true });
}

export async function sendQwenPawFeishuQr(installDirectory, target, image) {
  const normalized = normalizeQwenPawFeishuTarget(target);
  const data = Buffer.from(image || []);
  if (!normalized) throw new Error("QwenPaw 飞书通知目标无效，请刷新并重新选择。");
  if (!data.length || data.length > MAX_QR_IMAGE_BYTES) throw new Error("登录二维码图片不可用。");
  const runtime = await startQwenPawBackend(installDirectory);
  return qwenPawRequest(runtime, "/api/ecommerce-qr-delivery/send", {
    method: "POST",
    body: JSON.stringify({
      target_user: normalized.userId,
      target_session: normalized.sessionId,
      image_base64: data.toString("base64"),
    }),
  });
}

export async function retractQwenPawFeishuQr(installDirectory, messageId) {
  const id = clean(messageId, 500);
  if (!id) throw new Error("飞书二维码消息标识无效。");
  const runtime = await startQwenPawBackend(installDirectory);
  return qwenPawRequest(runtime, "/api/ecommerce-qr-delivery/retract", {
    method: "POST",
    body: JSON.stringify({ message_id: id }),
  });
}

function money(value) {
  return Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(2)}` : "--";
}

const channelLabels = {
  normal: "普通价",
  billion: "百亿补贴价",
  seckill: "淘宝秒杀价",
  government: "国补价",
  surprise: "惊喜立减价",
  gift: "礼金价",
  vip88: "88VIP价",
  coin: "淘金币价",
};

export function qwenPawThresholdMessage(payload) {
  const product = payload?.product || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const lines = [
    "【竞品低价提醒】",
    `商品：${clean(product.name || product.model || "未命名商品", 160)}`,
    `店铺：${clean(product.shopName || "未识别店铺", 120)}`,
    `账号：${clean(payload?.accountType || product.accountType || "normal", 40)}`,
  ];
  for (const item of items.slice(0, 12)) {
    const current = Number(item.priceCents) / 100;
    const threshold = Number(item.thresholdCents) / 100;
    const difference = threshold - current;
    const event = item.event === "new-low" ? "继续降价" : "首次跌破";
    lines.push(`${event} · ${clean(item.skuName || item.skuId, 100)} · ${clean(item.priceLabel || channelLabels[item.channel] || item.channel, 60)} ${money(current)} < 监控价 ${money(threshold)}（低 ${money(difference)}）`);
  }
  if (product.url) lines.push(`商品链接：${product.url}`);
  lines.push("本消息由 QwenPaw 已绑定飞书主动发送。价格仅来自本地已验证快照。");
  return lines.join("\n");
}

export function qwenPawLoginExpiredMessage(payload) {
  const session = payload?.session || {};
  const label = clean(session.name || "淘宝账号", 120);
  const accountType = clean(session.accountType || "normal", 40);
  return [
    "【账号掉线提醒】",
    `账号：${label}`,
    `账号类型：${accountType}`,
    "状态：淘宝登录已失效，相关商品抓取已暂停。",
    "请使用下方二维码在淘宝 App 中完成重新授权；二维码过期后会自动撤回。",
  ].join("\n");
}
