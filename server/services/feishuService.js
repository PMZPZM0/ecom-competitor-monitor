import crypto from "node:crypto";
import { newId } from "../storage/db.js";

const ENCRYPTION_VERSION = "v1";

function encryptionKey() {
  const source = process.env.FEISHU_CONFIG_KEY || process.env.CONFIG_ENCRYPTION_KEY || "tmall-monitor-local-config-key";
  return crypto.createHash("sha256").update(source).digest();
}

function encrypt(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decrypt(value) {
  if (!value) return "";
  const [version, ivValue, tagValue, encryptedValue] = String(value).split(".");
  if (version !== ENCRYPTION_VERSION || !ivValue || !tagValue || !encryptedValue) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function mask(value, visible = 6) {
  if (!value) return "";
  return value.length <= visible ? "******" : `${value.slice(0, visible)}******`;
}

export function publicFeishuConfig(config = {}) {
  const webhookUrl = decrypt(config.webhookUrlEncrypted);
  const signingSecret = decrypt(config.signingSecretEncrypted);
  return {
    enabled: Boolean(config.enabled),
    webhookConfigured: Boolean(webhookUrl),
    webhookUrlMasked: mask(webhookUrl, 36),
    signingSecretConfigured: Boolean(signingSecret),
    lastTestedAt: config.lastTestedAt || null,
    documentEnabled: Boolean(config.documentEnabled),
    documentConfigured: Boolean(config.documentId),
    documentUrl: config.documentUrl || "",
    lastDocumentSyncAt: config.lastDocumentSyncAt || null,
  };
}

export function updateFeishuConfig(current = {}, patch = {}) {
  const next = { ...current };
  delete next.cooldownEnabled;
  delete next.cooldownMinutes;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.documentEnabled !== undefined) next.documentEnabled = patch.documentEnabled;
  if (patch.webhookUrl !== undefined && patch.webhookUrl !== "") next.webhookUrlEncrypted = encrypt(patch.webhookUrl);
  if (patch.signingSecret !== undefined && patch.signingSecret !== "") next.signingSecretEncrypted = encrypt(patch.signingSecret);
  if (patch.clearSigningSecret) next.signingSecretEncrypted = "";
  return next;
}

function buildSignature(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  return { timestamp, sign };
}

function notificationText({ type, product, price, threshold, skuName, priceLabel }) {
  const shopName = product.shopName || product.lastSnapshot?.shopName || "未知店铺";
  const model = product.model || product.lastSnapshot?.model || product.name || "未知型号";
  const headline = type === "manual-sync" ? "价格监控同步" : "价格监控预警";
  const lines = [
    `${headline}，请关注`,
    `店铺：${shopName}`,
    `型号：${model}`,
    `当前价格：${priceLabel ? `${priceLabel} ` : ""}¥${price.toFixed(2)}`,
  ];
  if (threshold !== null && threshold !== undefined) lines.push(`监控价：¥${threshold.toFixed(2)}`);
  if (skuName) lines.push(`SKU：${skuName}`);
  lines.push(`商品链接：${product.url}`);
  return lines.join("\n");
}

function escapeMarkdown(value) {
  return String(value || "").replace(/[\\`*_{}()[\]#+.!|>-]/g, "\\$&");
}

function priceText(value) {
  return Number.isFinite(value) ? `¥${Number(value).toFixed(2)}` : "--";
}

const accountLabels = {
  normal: { account: "普通账号", benefit: "惊喜立减价", field: "surprisePrice", status: "surpriseStatus" },
  gift: { account: "礼金账号", benefit: "礼金价", field: "giftPrice", status: "giftStatus" },
  vip88: { account: "88VIP账号", benefit: "88VIP价", field: "vipPrice", status: "vipStatus" },
};

const channelLabels = {
  billion: { benefit: "百亿补贴价", field: "billionPrice", status: "billionStatus" },
  seckill: { benefit: "淘宝秒杀价", field: "seckillPrice", status: "seckillStatus" },
  government: { benefit: "国补价", field: "governmentPrice", status: "governmentStatus" },
  surprise: { benefit: "惊喜立减价", field: "surprisePrice", status: "surpriseStatus", accountType: "normal" },
  gift: { benefit: "礼金价", field: "giftPrice", status: "giftStatus", accountType: "gift" },
  vip88: { benefit: "88VIP价", field: "vipPrice", status: "vipStatus", accountType: "vip88" },
};

export function accountPriceContext(product, snapshot = product?.lastSnapshot || {}) {
  const capture = snapshot.accountCaptures?.find((item) => item.sessionId === snapshot.primaryAccountSessionId)
    || snapshot.accountCaptures?.find((item) => item.primary)
    || snapshot.accountCaptures?.find((item) => item.accountType === snapshot.primaryAccountType)
    || snapshot.accountCaptures?.[0];
  const accountType = capture?.accountType || snapshot.primaryAccountType || product?.accountType || "normal";
  const account = accountLabels[accountType] || accountLabels.normal;
  return { accountType, account, accountName: capture?.accountName || "" };
}

function restrictedFirstOrderGift(sku, accountType) {
  return accountType !== "vip88" && (sku?.priceResolution?.promotions || [])
    .some((promotion) => String(promotion?.code || "") === "1");
}

function resolvedChannelForAccount(sku, channel, accountType = "normal") {
  const resolved = sku?.priceResolution?.channels?.[channel];
  if (sku?.resolutionStatus !== "verified"
    || sku?.priceResolution?.status !== "verified"
    || resolved?.status !== "verified"
    || !Number.isSafeInteger(resolved.valueCents)
    || resolved.valueCents <= 0) return null;
  if (channel === "gift" && restrictedFirstOrderGift(sku, accountType)) return null;
  if (channel === "vip88" && accountType !== "vip88") return null;
  return resolved;
}

export function effectivePriceForSku(sku, accountType = "normal") {
  const channelsInPriorityOrder = [
    // Campaign channels precede the public baseline so an alias value emitted
    // by the resolver is still reported with its explicit campaign label.
    ["seckill", "淘宝秒杀价"],
    ["billion", "百亿补贴价"],
    ["normal", "普通价"],
    ["government", "国补价"],
    ["surprise", "惊喜立减价"],
    ["gift", channelDisplayLabel(sku, "gift", accountType)],
    ...(accountType === "vip88" ? [["vip88", "88VIP价"]] : []),
    ["coin", "淘金币价"],
  ];
  const options = channelsInPriorityOrder.map(([kind, label]) => {
    const resolved = resolvedChannelForAccount(sku, kind, accountType);
    return resolved ? { label, value: resolved.valueCents / 100 } : null;
  }).filter(Boolean);
  return options.reduce((lowest, item) => (!lowest || item.value < lowest.value ? item : lowest), null);
}

function accountSupportsChannel(accountType, channel) {
  if (["normal", "billion", "seckill", "government", "surprise", "gift", "coin"].includes(channel)) return true;
  return channel === "vip88" && accountType === "vip88";
}

function channelDisplayLabel(sku, channel, accountType = "normal") {
  const configured = String(resolvedChannelForAccount(sku, channel, accountType)?.label || "").trim();
  return configured.slice(0, 40) || channelLabels[channel]?.benefit || channel;
}

function channelValue(sku, channel, { anonymous, accountType }) {
  if (anonymous) return "需登录";
  const kind = channel === "normal" ? "normal" : channel === "gift" ? "gift" : channel === "vip88" ? "vip88" : channel;
  const resolvedChannel = sku?.priceResolution?.channels?.[kind];
  const verifiedChannel = resolvedChannelForAccount(sku, kind, accountType);
  if (!verifiedChannel) {
    if ((kind === "gift" && restrictedFirstOrderGift(sku, accountType)) || /^different-account-/.test(String(resolvedChannel?.reason || ""))) return "不适用";
    if (!accountSupportsChannel(accountType, channel)) return "不适用";
    return "本次未验证";
  }
  return priceText(verifiedChannel.valueCents / 100);
}

function priceColumn(label, value) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "center",
    elements: [{ tag: "markdown", content: `**${escapeMarkdown(label)}**\n${value}` }],
  };
}

const monitorChannelNames = {
  lowest: "最低已验证价",
  normal: "普通价",
  billion: "百亿补贴价",
  seckill: "淘宝秒杀价",
  government: "国补价",
  surprise: "惊喜立减价",
  gift: "礼金价",
  vip88: "88VIP价",
  coin: "淘金币价",
};

function monitorRulesText(product, skuId) {
  const explicitRules = product.skuMonitorRules?.[skuId] || {};
  const rules = Object.keys(explicitRules).length ? explicitRules : Number(product.skuMonitorPrices?.[skuId]) > 0 ? { lowest: product.skuMonitorPrices[skuId] } : {};
  const values = Object.entries(rules)
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0)
    .map(([channel, value]) => `${monitorChannelNames[channel] || channel} ${priceText(Number(value))}`);
  return values.length ? values.join("　") : "未设置";
}

export function buildPriceCard({ type, product, price, threshold, skuName, triggeredSkuIds = [], triggeredRules = [] }) {
  const snapshot = product.lastSnapshot || {};
  const shopName = product.shopName || snapshot.shopName || "未知店铺";
  const model = product.model || snapshot.model || product.name || "未知型号";
  const isAlert = type === "below-threshold";
  const triggered = new Set(triggeredSkuIds);
  const anonymous = snapshot.accessMode === "anonymous";
  const { accountType, account, accountName } = accountPriceContext(product, snapshot);
  const allSkus = snapshot.skuPrices || [];
  const gridSkus = allSkus.slice(0, 10);
  const compactSkus = allSkus.slice(10);
  const skuElements = gridSkus.flatMap((sku, index) => {
    const effective = effectivePriceForSku(sku, accountType);
    const skuTriggeredRules = triggeredRules.filter((rule) => String(rule.skuId) === String(sku.skuId));
    const prefix = triggered.has(sku.skuId) ? "🔔" : "▫️";
    const status = skuTriggeredRules.length
      ? `  **${skuTriggeredRules.map((rule) => `${rule.event === "new-low" ? "新低" : "首次跌破"} · ${rule.priceLabel || monitorChannelNames[rule.channel] || rule.channel} ${priceText(Number(rule.priceCents) / 100)} < ${priceText(Number(rule.thresholdCents) / 100)}`).join("；")}**`
      : triggered.has(sku.skuId)
        ? `  **低于监控价 · ${effective?.label || "当前价格"} ${priceText(effective?.value)}**`
      : "";
    return [
      { tag: "markdown", content: `${prefix} **${index + 1}. ${escapeMarkdown(sku.name || sku.skuId)}**${status}\nSKU ID ${escapeMarkdown(sku.skuId)}` },
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "small", columns: [
        priceColumn(anonymous ? "匿名公开价" : "普通价", channelValue(sku, "normal", { anonymous, accountType })),
        priceColumn("淘宝秒杀价", channelValue(sku, "seckill", { anonymous, accountType })),
        priceColumn("百亿补贴价", channelValue(sku, "billion", { anonymous, accountType })),
      ] },
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "small", columns: [
        priceColumn("国补价", channelValue(sku, "government", { anonymous, accountType })),
        priceColumn("惊喜立减价", channelValue(sku, "surprise", { anonymous, accountType })),
        priceColumn("淘金币价", channelValue(sku, "coin", { anonymous, accountType })),
      ] },
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "small", columns: [
        priceColumn(channelDisplayLabel(sku, "gift", accountType), channelValue(sku, "gift", { anonymous, accountType })),
        priceColumn("88VIP价", channelValue(sku, "vip88", { anonymous, accountType })),
      ] },
      { tag: "markdown", content: `**监控规则** ${monitorRulesText(product, sku.skuId)}` },
      ...(index < gridSkus.length - 1 ? [{ tag: "hr" }] : []),
    ];
  });
  if (compactSkus.length) {
    const compactLines = compactSkus.map((sku, index) => {
      const prefix = triggered.has(sku.skuId) ? "🔔" : "▫️";
      return [
        `${prefix} **${index + gridSkus.length + 1}. ${escapeMarkdown(sku.name || sku.skuId)}**`,
        `普通价 ${channelValue(sku, "normal", { anonymous, accountType })}　淘宝秒杀价 ${channelValue(sku, "seckill", { anonymous, accountType })}　百亿补贴价 ${channelValue(sku, "billion", { anonymous, accountType })}　国补价 ${channelValue(sku, "government", { anonymous, accountType })}　惊喜立减价 ${channelValue(sku, "surprise", { anonymous, accountType })}　${escapeMarkdown(channelDisplayLabel(sku, "gift", accountType))} ${channelValue(sku, "gift", { anonymous, accountType })}　88VIP价 ${channelValue(sku, "vip88", { anonymous, accountType })}　淘金币价 ${channelValue(sku, "coin", { anonymous, accountType })}　监控规则 ${monitorRulesText(product, sku.skuId)}`,
      ].join("\n");
    });
    skuElements.push({ tag: "hr" }, { tag: "markdown", content: `**更多 SKU**\n${compactLines.join("\n\n")}` });
  }
  if (!skuElements.length) {
    skuElements.push({ tag: "markdown", content: `▫️ **${escapeMarkdown(skuName || "商品价格")}**\n当前价 ${priceText(price)}　监控价 ${priceText(threshold)}` });
  }
  const summary = [
    `**店铺** ${escapeMarkdown(shopName)}`,
    `**型号** ${escapeMarkdown(model)}`,
    `**价格口径** ${anonymous ? "匿名公开价（不触发低价提醒）" : `${account.account}${accountName && accountName !== account.account ? ` · ${escapeMarkdown(accountName)}` : ""}`}`,
    `**更新时间** ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
  ].join("\n");

  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: true },
    header: {
      title: { tag: "plain_text", content: isAlert ? "价格监控预警" : "价格监控同步" },
      subtitle: { tag: "plain_text", content: `${shopName} · ${model}`.slice(0, 80) },
      template: isAlert ? "orange" : "blue",
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content: summary },
        { tag: "hr" },
        ...skuElements,
        { tag: "markdown", content: "价格字段只展示当前抓取到的真实值；‘不适用’表示该价格渠道不属于当前账号口径，‘未获取’表示页面本次未返回。" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "打开商品" },
          type: "default",
          width: "default",
          size: "medium",
          behaviors: [{ type: "open_url", default_url: product.url }],
          margin: "8px 0px 0px 0px",
        },
      ],
    },
  };
}

export async function sendFeishuNotification(config, details) {
  const webhookUrl = decrypt(config.webhookUrlEncrypted);
  if (!webhookUrl) throw new Error("请先填写飞书自定义机器人的 Webhook 地址。");
  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    throw new Error("飞书 Webhook 地址格式不正确。");
  }
  if (parsedUrl.protocol !== "https:" || !/(^|\.)feishu\.cn$/i.test(parsedUrl.hostname) || !/^\/open-apis\/bot\/v2\/hook\//.test(parsedUrl.pathname)) {
    throw new Error("请填写飞书自定义机器人 Webhook 地址。");
  }
  const body = { msg_type: "interactive", card: buildPriceCard(details) };
  const signingSecret = decrypt(config.signingSecretEncrypted);
  if (signingSecret) Object.assign(body, buildSignature(signingSecret));

  const response = await fetch(parsedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) throw new Error(result.msg || `飞书发送失败（HTTP ${response.status}）。`);
  return { text: notificationText(details), result };
}

export function createNotificationLog({ productId = "", skuId = "", type, status, message, price = null, threshold = null, source = "" }) {
  return {
    id: newId("feishu"),
    productId,
    skuId,
    type,
    status,
    message,
    price,
    threshold,
    source,
    createdAt: new Date().toISOString(),
  };
}
