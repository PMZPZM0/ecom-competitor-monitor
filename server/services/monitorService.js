import { newId, readDb, updateDb } from "../storage/db.js";
import { scrapeTmallProduct } from "./tmallScraper.js";
import { createNotificationLog, effectivePriceForSku, sendFeishuNotification } from "./feishuService.js";
import { appendPriceDocument } from "./larkCliService.js";

let timer = null;
let captureRunActive = false;

const MIN_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MIN_DELAY_MS || 5000);
const MAX_PRODUCT_DELAY_MS = Number(process.env.MONITOR_MAX_DELAY_MS || 12000);
const MAX_CAPTURE_CONCURRENCY = 5;
const MIN_PRODUCT_INTERVAL_MINUTES = 30;
const MAX_PRODUCT_INTERVAL_MINUTES = 1440;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomProductDelay() {
  const min = Math.max(0, MIN_PRODUCT_DELAY_MS);
  const max = Math.max(min, MAX_PRODUCT_DELAY_MS);
  return Math.round(min + Math.random() * (max - min));
}

function isRiskControlError(message = "") {
  return /登录|验证|captcha|滑块|风控|访问受限|cookie/i.test(message);
}

export function riskCooldownMs(configuredMinutes = 3) {
  const minutes = Number(configuredMinutes);
  if (Number.isFinite(minutes) && minutes <= 0) return 0;
  return Math.min(120, Math.max(1, minutes || 3)) * 60_000;
}

export function resolveCaptureProtectionMinutes(monitor, accountType = "normal") {
  const override = monitor?.captureProtectionByAccount?.[accountType];
  return override !== null && override !== undefined && Number.isFinite(Number(override)) && Number(override) >= 0
    ? Number(override)
    : Number.isFinite(Number(monitor?.captureProtectionMinutes)) && Number(monitor.captureProtectionMinutes) >= 0
      ? Number(monitor.captureProtectionMinutes)
      : 3;
}

export function resolveProductIntervalMinutes(product, fallbackMinutes = 60) {
  const requested = Number(product?.monitorIntervalMinutes);
  const fallback = Number(fallbackMinutes);
  const value = Number.isFinite(requested) && requested > 0
    ? requested
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : 60;
  return Math.min(MAX_PRODUCT_INTERVAL_MINUTES, Math.max(MIN_PRODUCT_INTERVAL_MINUTES, Math.round(value)));
}

export function nextProductScheduleAt(product, fallbackMinutes = 60, now = Date.now()) {
  const intervalMs = resolveProductIntervalMinutes(product, fallbackMinutes) * 60_000;
  const anchor = Date.parse(product?.monitorStartAt || "");
  if (!Number.isFinite(anchor)) return new Date(now + intervalMs).toISOString();
  if (anchor > now) return new Date(anchor).toISOString();
  const elapsedIntervals = Math.floor((now - anchor) / intervalMs) + 1;
  return new Date(anchor + elapsedIntervals * intervalMs).toISOString();
}

export function scheduleProduct(product, monitor, { reset = false, now = Date.now() } = {}) {
  if (!monitor?.running || !product?.enabled) return { ...product, nextMonitorAt: null };
  const existing = Date.parse(product.nextMonitorAt || "");
  if (!reset && Number.isFinite(existing)) return product;
  return {
    ...product,
    nextMonitorAt: nextProductScheduleAt(product, monitor.intervalMinutes, now),
  };
}

export function scheduleProducts(products, monitor, options = {}) {
  return products.map((product) => scheduleProduct(product, monitor, options));
}

export function dueProductIds(products, now = Date.now()) {
  return products
    .filter((product) => product.enabled && Number.isFinite(Date.parse(product.nextMonitorAt || "")) && Date.parse(product.nextMonitorAt) <= now)
    .sort((left, right) => Date.parse(left.nextMonitorAt) - Date.parse(right.nextMonitorAt))
    .map((product) => product.id);
}

export function earliestProductSchedule(products, monitor, now = Date.now()) {
  const scheduled = scheduleProducts(products, monitor, { now });
  const times = scheduled
    .filter((product) => product.enabled && product.nextMonitorAt)
    .map((product) => Date.parse(product.nextMonitorAt))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export async function runInCaptureGroups(items, worker, { concurrency = MAX_CAPTURE_CONCURRENCY, delayBetweenGroups = null } = {}) {
  const size = Math.min(MAX_CAPTURE_CONCURRENCY, Math.max(1, Number(concurrency) || MAX_CAPTURE_CONCURRENCY));
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    const group = items.slice(index, index + size);
    results.push(...await Promise.all(group.map((item, groupIndex) => worker(item, index + groupIndex))));
    if (index + size < items.length && delayBetweenGroups) await delay(delayBetweenGroups());
  }
  return results;
}

function availablePoolSessions(sessions) {
  const now = Date.now();
  return sessions
    .filter((session) => !session.cooldownUntil || new Date(session.cooldownUntil).getTime() <= now)
    .sort((left, right) => new Date(left.lastUsedAt || 0).getTime() - new Date(right.lastUsedAt || 0).getTime());
}

function persistSessionHealth(current, sessions) {
  const healthById = new Map(sessions.map((session) => [session.id, session]));
  current.authSessions = current.authSessions.map((session) => {
    const health = healthById.get(session.id);
    if (!health) return session;
    return {
      ...session,
      lastUsedAt: health.lastUsedAt || null,
      lastSuccessAt: health.lastSuccessAt || null,
      lastFailureAt: health.lastFailureAt || null,
      consecutiveFailures: health.consecutiveFailures || 0,
      cooldownUntil: health.cooldownUntil || null,
      healthStatus: health.healthStatus || "healthy",
      loginStatus: health.loginStatus || session.loginStatus,
    };
  });
}

async function withCaptureLock(operation) {
  if (captureRunActive) throw new Error("已有抓取任务正在运行，请等待当前任务完成后再试。");
  captureRunActive = true;
  try {
    return await operation();
  } finally {
    captureRunActive = false;
  }
}

function summarizeResults(results) {
  const success = results.filter((result) => result.snapshot).length;
  const failed = results.length - success;
  return { total: results.length, success, failed };
}

export function orderedCaptureCandidates(products, productIds, includeDisabled = false) {
  const allowed = (product) => includeDisabled || product.enabled;
  if (!productIds) return products.filter(allowed);
  const byId = new Map(products.map((product) => [product.id, product]));
  return productIds.map((id) => byId.get(id)).filter((product) => product && allowed(product));
}

export function historicalPrimaryImages(snapshots, productId) {
  return snapshots
    .filter((snapshot) => snapshot.productId === productId)
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime())
    .flatMap((snapshot) => [snapshot.mainImage800, snapshot.mainImage, ...(snapshot.mainImages || [])])
    .filter((image, index, images) => /item_pic\./i.test(image || "") && images.indexOf(image) === index);
}

export function historicalProductMedia(snapshots, productId) {
  const productSnapshots = snapshots
    .filter((snapshot) => snapshot.productId === productId)
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime());
  const unique = (items) => Array.from(new Set(items.filter(Boolean)));
  return {
    galleryImages: unique(productSnapshots.flatMap((snapshot) => snapshot.gallery750Images || [])).slice(0, 10),
    videoUrls: unique(productSnapshots.flatMap((snapshot) => snapshot.videoUrls || [])).slice(0, 10),
  };
}

export function historicalAccountPriceSnapshot(snapshots, productId, accountType = "normal") {
  return snapshots
    .filter((snapshot) => snapshot.productId === productId)
    .sort((left, right) => new Date(right.capturedAt || 0).getTime() - new Date(left.capturedAt || 0).getTime())
    .find((snapshot) => (snapshot.skuPrices || []).some((sku) => hasVerifiedAccountPrice(sku, accountType))) || null;
}

export function preserveVerifiedAccountPrices(snapshot, previousSnapshot, accountType = "normal") {
  if (!previousSnapshot?.skuPrices?.length) return snapshot;
  const priceField = accountType === "gift" ? "giftPrice" : accountType === "vip88" ? "vipPrice" : "surprisePrice";
  const statusField = accountType === "gift" ? "giftStatus" : accountType === "vip88" ? "vipStatus" : "surpriseStatus";
  const discountField = accountType === "gift" ? "giftDiscountAmount" : accountType === "vip88" ? "vipDiscountAmount" : "surpriseDiscountAmount";
  const inferenceField = accountType === "gift" ? "giftInference" : accountType === "vip88" ? "vipInference" : "surpriseInference";
  const previousBySku = new Map(previousSnapshot.skuPrices.map((sku) => [String(sku.skuId), sku]));
  let preservedCount = 0;
  const skuPrices = (snapshot.skuPrices || []).map((sku) => {
    const previous = previousBySku.get(String(sku.skuId));
    const displayedPrice = Number(sku.normalPrice ?? sku.price);
    const previousBenefitPrice = Number(previous?.[priceField]);
    if (!previous || hasVerifiedAccountPrice(sku, accountType) || !hasVerifiedAccountPrice(previous, accountType)) return sku;
    if (!Number.isFinite(displayedPrice) || Math.abs(displayedPrice - previousBenefitPrice) > 0.05) return sku;
    preservedCount += 1;
    return {
      ...sku,
      price: previous.normalPrice ?? previous.price,
      normalPrice: previous.normalPrice ?? previous.price,
      [priceField]: previous[priceField],
      [statusField]: previous[statusField] || "available",
      [discountField]: previous[discountField] ?? null,
      [inferenceField]: previous[inferenceField],
      coinPrice: Number(sku.coinPrice) > 0 ? sku.coinPrice : previous.coinPrice,
      coinStatus: Number(sku.coinPrice) > 0 ? sku.coinStatus : previous.coinStatus,
      coinDiscountAmount: Number(sku.coinPrice) > 0 ? sku.coinDiscountAmount : previous.coinDiscountAmount,
      priceCalculation: previous.priceCalculation || sku.priceCalculation,
      priceLayers: previous.priceLayers?.length ? previous.priceLayers : sku.priceLayers,
      discountItems: previous.discountItems?.length ? previous.discountItems : sku.discountItems,
      accountPricePreservedAt: new Date().toISOString(),
    };
  });
  if (!preservedCount) return snapshot;
  const prices = skuPrices.map((sku) => Number(sku.normalPrice ?? sku.price)).filter(Number.isFinite);
  return {
    ...snapshot,
    skuPrices,
    price: skuPrices[0]?.normalPrice ?? skuPrices[0]?.price ?? snapshot.price,
    priceRange: prices.length ? [Math.min(...prices), Math.max(...prices)] : snapshot.priceRange,
    rawSignals: { ...snapshot.rawSignals, preservedAccountPriceCount: preservedCount },
  };
}

function buildRunRecord({ source, scope, startedAt, results, message }) {
  const summary = summarizeResults(results);
  return {
    id: newId("run"),
    source,
    scope,
    status: summary.failed > 0 ? (summary.success > 0 ? "partial" : "failed") : "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    ...summary,
    message:
      message ||
      `抓取 ${summary.total} 个商品，成功 ${summary.success} 个，失败 ${summary.failed} 个。`,
  };
}

function isVerifiedBenefitPrice(normalPrice, benefitPrice) {
  const normal = Number(normalPrice);
  const benefit = Number(benefitPrice);
  return Number.isFinite(normal) && Number.isFinite(benefit) && benefit > 0 && normal - benefit > 0.05;
}

function hasVerifiedAccountPrice(sku, accountType) {
  const priceField = accountType === "gift" ? "giftPrice" : accountType === "vip88" ? "vipPrice" : "surprisePrice";
  const inferenceField = accountType === "gift" ? "giftInference" : accountType === "vip88" ? "vipInference" : "surpriseInference";
  return isVerifiedBenefitPrice(sku?.[inferenceField]?.normalPrice ?? sku?.normalPrice ?? sku?.price, sku?.[priceField]);
}

export function mergeAccountSnapshots(snapshots) {
  const preferred = snapshots.find((entry) => entry.session?.accountType === "normal") || snapshots[0];
  const merged = structuredClone(preferred.snapshot);
  const bySkuId = new Map();
  const ordered = [preferred, ...snapshots.filter((entry) => entry !== preferred)];
  for (const entry of ordered) {
    const accountType = entry.session?.accountType || "normal";
    for (const sku of entry.snapshot.skuPrices || []) {
      const skuId = String(sku.skuId);
      const current = bySkuId.get(skuId) || { ...sku, accountPrices: [] };
      const normalPrice = Number(current.normalPrice ?? current.price);
      const displayedPrice = Number(sku.normalPrice ?? sku.price);
      const config = accountType === "gift"
        ? { priceField: "giftPrice", statusField: "giftStatus", discountField: "giftDiscountAmount", inferenceField: "giftInference", calculationField: "gift", label: "礼金价", discountLabel: "礼金优惠" }
        : accountType === "vip88"
          ? { priceField: "vipPrice", statusField: "vipStatus", discountField: "vipDiscountAmount", inferenceField: "vipInference", calculationField: "vip88", label: "88VIP价", discountLabel: "88VIP优惠" }
          : null;
      const explicitBenefitPrice = config ? Number(sku[config.priceField]) : null;
      const observedBenefitPrice = config && isVerifiedBenefitPrice(normalPrice, explicitBenefitPrice)
        ? explicitBenefitPrice
        : config && isVerifiedBenefitPrice(normalPrice, displayedPrice)
          ? displayedPrice
          : null;
      if (config && observedBenefitPrice) {
        const discountAmount = Number((normalPrice - observedBenefitPrice).toFixed(2));
        current[config.priceField] = observedBenefitPrice;
        current[config.statusField] = "available";
        current[config.discountField] = Number(sku[config.discountField]) > 0 ? sku[config.discountField] : discountAmount;
        current[config.inferenceField] = sku[config.inferenceField] || {
          normalPrice,
          benefitPrice: observedBenefitPrice,
          benefitDiscountAmount: discountAmount,
          accountType,
          formula: `普通价 ${normalPrice.toFixed(2)} - ${config.discountLabel} ${discountAmount.toFixed(2)} = ${observedBenefitPrice.toFixed(2)}`,
          source: "cross-account-observation",
        };
        current.priceCalculation = {
          ...(current.priceCalculation || {}),
          [config.calculationField]: current[config.inferenceField].formula,
        };
        current.priceLayers = [...(current.priceLayers || [])];
        if (!current.priceLayers.some((layer) => layer.label === config.label && Number(layer.value) === observedBenefitPrice)) {
          current.priceLayers.push({ label: config.label, value: observedBenefitPrice, kind: "price", source: "cross-account-observation" });
        }
      }
      if (accountType !== "normal" && Number(sku.coinPrice) > 0) {
        current.coinPrice = sku.coinPrice;
        current.coinStatus = sku.coinStatus;
        current.coinDiscountAmount = sku.coinDiscountAmount;
        current.priceCalculation = { ...(current.priceCalculation || {}), coin: sku.priceCalculation?.coin || current.priceCalculation?.coin };
      }
      current.accountPrices.push({
        sessionId: entry.session?.id || "guest",
        accountName: entry.session?.name || "未登录前台",
        accountType,
        price: sku.price,
        normalPrice,
        surprisePrice: sku.surprisePrice,
        giftPrice: accountType === "gift" ? observedBenefitPrice : sku.giftPrice,
        giftDiscountAmount: accountType === "gift" && observedBenefitPrice ? Number((normalPrice - observedBenefitPrice).toFixed(2)) : sku.giftDiscountAmount,
        vipPrice: accountType === "vip88" ? observedBenefitPrice : sku.vipPrice,
        vipDiscountAmount: accountType === "vip88" && observedBenefitPrice ? Number((normalPrice - observedBenefitPrice).toFixed(2)) : sku.vipDiscountAmount,
        coinPrice: sku.coinPrice,
        originalPrice: sku.originalPrice,
        priceCalculation: sku.priceCalculation,
        priceLayers: sku.priceLayers || [],
        discountItems: sku.discountItems || [],
      });
      const discountItems = [...(current.discountItems || []), ...(sku.discountItems || [])];
      current.discountItems = Array.from(new Map(discountItems.map((item) => [
        `${item.label}:${item.amount ?? ""}:${item.threshold ?? ""}:${item.text}`,
        item,
      ])).values());
      bySkuId.set(skuId, current);
    }
  }
  merged.skuPrices = Array.from(bySkuId.values());
  merged.accountCaptures = snapshots.map((entry) => ({
    sessionId: entry.session?.id || "guest",
    accountName: entry.session?.name || "未登录前台",
    accountType: entry.session?.accountType || "normal",
    price: entry.snapshot.price,
    priceRange: entry.snapshot.priceRange,
  }));
  const normalPrices = merged.skuPrices.map((sku) => Number(sku.normalPrice ?? sku.price)).filter(Number.isFinite);
  merged.price = merged.skuPrices[0]?.normalPrice ?? merged.skuPrices[0]?.price ?? merged.price;
  merged.priceRange = normalPrices.length ? [Math.min(...normalPrices), Math.max(...normalPrices)] : merged.priceRange;
  merged.rawSignals = { ...merged.rawSignals, accountCaptureCount: snapshots.length };
  return merged;
}

export function sessionsForProduct(activeSessions, accountType = "normal", rotation = 0) {
  const rotate = (sessions) => sessions.length
    ? [...sessions.slice(rotation % sessions.length), ...sessions.slice(0, rotation % sessions.length)]
    : [];
  const normal = rotate(activeSessions.filter((session) => (session.accountType || "normal") === "normal"));
  if (accountType === "normal") return normal;
  return [...normal, ...rotate(activeSessions.filter((session) => session.accountType === accountType))];
}

export function hasTrustedAccountBaseline(snapshots, accountType = "normal") {
  if (accountType === "normal" || snapshots.some((entry) => (entry.session?.accountType || "normal") === "normal")) return true;
  return snapshots.some((entry) => (entry.snapshot.skuPrices || []).some((sku) => (
    accountType === "gift"
      ? isVerifiedBenefitPrice(sku.giftInference?.normalPrice, sku.giftPrice)
      : isVerifiedBenefitPrice(sku.vipInference?.normalPrice, sku.vipPrice)
  )));
}

function buyerShowKey(item) {
  const id = String(item?.id || "");
  if (id && !/^(?:buyer|rate)-\d+$/.test(id)) return `id:${id}`;
  return `content:${String(item?.text || "").trim()}|${(item?.images || []).join(",")}|${(item?.videoUrls || []).join(",")}`;
}

export function mergeBuyerShowHistory(currentItems = [], previousItems = []) {
  const merged = new Map();
  for (const item of [...currentItems, ...previousItems].filter(Boolean)) {
    const key = buyerShowKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, structuredClone(item));
      continue;
    }
    merged.set(key, {
      ...item,
      ...existing,
      text: existing.text || item.text || "",
      author: existing.author || item.author || "",
      sku: existing.sku || item.sku || "",
      createdAt: existing.createdAt || item.createdAt || "",
      images: Array.from(new Set([...(existing.images || []), ...(item.images || [])])).slice(0, 30),
      videoUrls: Array.from(new Set([...(existing.videoUrls || []), ...(item.videoUrls || [])])).slice(0, 10),
    });
  }
  return Array.from(merged.values()).slice(0, 100);
}

export function snapshotAllowsPriceAlerts(snapshot) {
  return snapshot?.accessMode !== "anonymous";
}

export function isFeishuAlertCoolingDown(feishu, notificationLogs, productId, skuId, now = Date.now()) {
  if (feishu?.cooldownEnabled === false) return false;
  const cooldownMs = Math.max(1, Number(feishu?.cooldownMinutes) || 120) * 60_000;
  return (notificationLogs || []).some((log) =>
    log.productId === productId && log.skuId === skuId && log.type === "below-threshold" && log.status === "sent" && now - new Date(log.createdAt).getTime() < cooldownMs,
  );
}

async function notifyBelowThreshold(current, product, snapshot, source) {
  if (!snapshotAllowsPriceAlerts(snapshot)) return [];
  if (!current.feishu.enabled) return [];
  const skuThresholds = product.skuMonitorPrices || {};
  const alerts = [];
  const pending = [];
  for (const sku of snapshot.skuPrices || []) {
    const threshold = Number(skuThresholds[sku.skuId]);
    const effective = effectivePriceForSku(sku, product.accountType || "normal");
    const price = effective?.value;
    if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(price) || price >= threshold) continue;

    const sentRecently = isFeishuAlertCoolingDown(current.feishu, current.notificationLogs, product.id, sku.skuId);
    if (sentRecently) {
      alerts.push(createNotificationLog({ productId: product.id, skuId: sku.skuId, type: "below-threshold", status: "suppressed", message: `SKU「${sku.name || sku.skuId}」价格仍低于监控价，处于飞书提醒冷却期。`, price, threshold, source }));
      continue;
    }
    pending.push({ sku, price, threshold, priceLabel: effective.label });
  }
  if (!pending.length) return alerts;
  try {
    await sendFeishuNotification(current.feishu, {
      type: "below-threshold",
      product,
      price: Math.min(...pending.map((item) => item.price)),
      priceLabel: [...new Set(pending.map((item) => item.priceLabel))].join("、") || "当前价格",
      threshold: null,
      skuName: pending.map((item) => item.sku.name || item.sku.skuId).join("、"),
      triggeredSkuIds: pending.map((item) => item.sku.skuId),
    });
    for (const item of pending) alerts.push(createNotificationLog({ productId: product.id, skuId: item.sku.skuId, type: "below-threshold", status: "sent", message: `SKU「${item.sku.name || item.sku.skuId}」${item.priceLabel}低于监控价，飞书价格预警已发送。`, price: item.price, threshold: item.threshold, source }));
  } catch (error) {
    for (const item of pending) alerts.push(createNotificationLog({ productId: product.id, skuId: item.sku.skuId, type: "below-threshold", status: "failed", message: error.message, price: item.price, threshold: item.threshold, source }));
  }
  return alerts;
}

export async function captureProduct(product, authSessions = [], { captureProtectionMinutes = 3, ignoreProtection = false } = {}) {
  const { knownPrimaryImages: _knownPrimaryImages, knownGalleryImages: _knownGalleryImages, knownVideoUrls: _knownVideoUrls, knownPriceSnapshot: _knownPriceSnapshot, ...persistedProduct } = product;
  try {
    const protectionDisabled = riskCooldownMs(captureProtectionMinutes) === 0;
    const sessions = authSessions.length
      ? ignoreProtection || protectionDisabled
        ? [...authSessions].sort((left, right) => new Date(left.lastUsedAt || 0).getTime() - new Date(right.lastUsedAt || 0).getTime())
        : availablePoolSessions(authSessions)
      : [null];
    if (!sessions.length) throw new Error("该账号池正处于本地采集保护冷却期。这是软件控制抓取频率，不代表淘宝账号被风控；请等待倒计时结束或手动解除冷却。");
    const snapshots = [];
    const accountErrors = [];
    const sessionGroups = sessions[0] === null
      ? [[null]]
      : Array.from(Map.groupBy(sessions, (session) => session.accountType || "normal").values());
    for (const group of sessionGroups) {
      for (const session of group.slice(0, 2)) {
        if (session) session.lastUsedAt = new Date().toISOString();
        try {
          const capturedSnapshot = await scrapeTmallProduct(product, session);
          snapshots.push({
            session,
            snapshot: preserveVerifiedAccountPrices(capturedSnapshot, product.knownPriceSnapshot || product.lastSnapshot, session?.accountType || product.accountType || "normal"),
          });
          if (session) {
            session.lastSuccessAt = new Date().toISOString();
            session.consecutiveFailures = 0;
            session.cooldownUntil = null;
            session.healthStatus = "healthy";
            session.loginStatus = "valid";
          }
          break;
        } catch (error) {
          accountErrors.push({ sessionId: session?.id || "guest", accountName: session?.name || "未登录前台", message: error.message });
          if (session) {
            session.lastFailureAt = new Date().toISOString();
            session.consecutiveFailures = Number(session.consecutiveFailures || 0) + 1;
            if (isRiskControlError(error.message)) {
              const cooldownMs = riskCooldownMs(captureProtectionMinutes);
              session.cooldownUntil = cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null;
              session.healthStatus = cooldownMs > 0 ? "cooldown" : "degraded";
              if (/登录|验证|captcha|滑块/i.test(error.message)) session.loginStatus = "expired";
            } else {
              session.healthStatus = "degraded";
            }
          }
        }
      }
    }
    if (!snapshots.length && authSessions.length) {
      try {
        snapshots.push({ session: null, snapshot: await scrapeTmallProduct(product, null) });
      } catch (error) {
        accountErrors.push({ sessionId: "anonymous", accountName: "匿名公开价", message: error.message });
      }
    }
    if (!snapshots.length) throw new Error(accountErrors.map((error) => `${error.accountName}：${error.message}`).join("；"));
    const targetAccountType = product.accountType || "normal";
    if (!hasTrustedAccountBaseline(snapshots, targetAccountType)) {
      throw new Error(`${targetAccountType === "gift" ? "礼金" : "88VIP"}价格缺少普通账号基准，本次结果已拒绝保存，避免把标价误当普通价。请检查普通账号登录后重试。`);
    }
    const snapshot = mergeAccountSnapshots(snapshots);
    snapshot.buyerShows = mergeBuyerShowHistory(snapshot.buyerShows, product.lastSnapshot?.buyerShows);
    if (snapshot.rawSignals) snapshot.rawSignals.buyerShowCount = snapshot.buyerShows.length;
    snapshot.accountErrors = accountErrors;
    return {
      product: {
        ...persistedProduct,
        name: snapshot.title || product.name,
        shopName: snapshot.shopName || product.shopName || "",
        shopLogo: snapshot.shopLogo || product.shopLogo || "",
        model: snapshot.model || product.model || "",
        itemId: snapshot.itemId || product.itemId || "",
        autoGroup: snapshot.autoGroup || product.autoGroup || "",
        mainImage: snapshot.mainImage || product.mainImage,
        lastStatus: "ok",
        lastError: "",
        lastSnapshot: snapshot,
        updatedAt: new Date().toISOString(),
      },
      snapshot: {
        id: newId("snap"),
        productId: product.id,
        ...snapshot,
      },
    };
  } catch (error) {
    return {
      product: {
        ...persistedProduct,
        lastStatus: "error",
        lastError: error.message,
        updatedAt: new Date().toISOString(),
      },
      snapshot: null,
    };
  }
}

async function runMonitorUnlocked({ source = "manual", productIds = null, includeDisabled = false } = {}) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const activeSessions = data.authSessions.filter((session) => (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const candidates = orderedCaptureCandidates(data.products, productIds, includeDisabled);
  const ignoreProtection = source === "manual-batch";
  const results = await runInCaptureGroups(candidates, async (product, productIndex) => {
    const captureCandidate = {
      ...product,
      knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
      knownGalleryImages: Array.from(new Set([...(product.lastSnapshot?.gallery750Images || []), ...historicalProductMedia(data.snapshots, product.id).galleryImages])),
      knownVideoUrls: Array.from(new Set([...(product.lastSnapshot?.videoUrls || []), ...historicalProductMedia(data.snapshots, product.id).videoUrls])),
      knownPriceSnapshot: historicalAccountPriceSnapshot(data.snapshots, product.id, product.accountType || "normal"),
    };
    const accountType = product.accountType || "normal";
    const productSessions = sessionsForProduct(activeSessions, accountType, productIndex);
    return captureProduct(captureCandidate, productSessions, {
      captureProtectionMinutes: resolveCaptureProtectionMinutes(data.monitor, accountType),
      ignoreProtection,
    });
  }, { concurrency: MAX_CAPTURE_CONCURRENCY, delayBetweenGroups: ignoreProtection ? null : randomProductDelay });

  const runRecord = buildRunRecord({
    source,
    scope: productIds ? "selected-products" : includeDisabled ? "all-products" : "all-enabled-products",
    startedAt,
    results,
    message: results.length ? undefined : productIds ? "没有选中可抓取的商品。" : "没有可抓取的商品。",
  });

  await updateDb(async (current) => {
    persistSessionHealth(current, activeSessions);
    for (const result of results) {
      const index = current.products.findIndex((product) => product.id === result.product.id);
      if (index >= 0) {
        const persisted = current.products[index];
        current.products[index] = {
          ...result.product,
          enabled: persisted.enabled,
          monitorIntervalMinutes: persisted.monitorIntervalMinutes,
          monitorStartAt: persisted.monitorStartAt,
          nextMonitorAt: persisted.nextMonitorAt,
        };
      }
      if (result.snapshot) {
        current.snapshots.push(result.snapshot);
        const logs = await notifyBelowThreshold(current, result.product, result.snapshot, source);
        current.notificationLogs.push(...logs);
        if (current.feishu.documentEnabled && current.feishu.documentId) {
          try {
            await appendPriceDocument(current.feishu.documentId, result.product, result.snapshot);
            current.feishu.lastDocumentSyncAt = new Date().toISOString();
            current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "sent", message: "价格快照已写入飞书文档。", source }));
          } catch (error) {
            current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "failed", message: error.message, source }));
          }
        }
      }
    }
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });

  return { run: runRecord, results };
}

export async function runMonitorOnce(options = {}) {
  return withCaptureLock(() => runMonitorUnlocked(options));
}

async function runProductUnlocked(productId, { source = "single-product" } = {}) {
  const startedAt = new Date().toISOString();
  const data = await readDb();
  const product = data.products.find((item) => item.id === productId);
  if (!product) throw new Error("商品不存在。");

  const activeSessions = data.authSessions.filter((session) => (session.enabled ?? session.active ?? true) && session.loginStatus !== "expired");
  const accountType = product.accountType || "normal";
  const productSessions = sessionsForProduct(activeSessions, accountType);
  const result = await captureProduct({
    ...product,
    knownPrimaryImages: historicalPrimaryImages(data.snapshots, product.id),
    knownGalleryImages: Array.from(new Set([...(product.lastSnapshot?.gallery750Images || []), ...historicalProductMedia(data.snapshots, product.id).galleryImages])),
    knownVideoUrls: Array.from(new Set([...(product.lastSnapshot?.videoUrls || []), ...historicalProductMedia(data.snapshots, product.id).videoUrls])),
    knownPriceSnapshot: historicalAccountPriceSnapshot(data.snapshots, product.id, product.accountType || "normal"),
  }, productSessions, { captureProtectionMinutes: resolveCaptureProtectionMinutes(data.monitor, accountType) });
  const runRecord = buildRunRecord({
    source,
    scope: productId,
    startedAt,
    results: [result],
  });

  await updateDb(async (current) => {
    persistSessionHealth(current, activeSessions);
    const index = current.products.findIndex((item) => item.id === productId);
    if (index >= 0) {
      const persisted = current.products[index];
      current.products[index] = {
        ...result.product,
        enabled: persisted.enabled,
        monitorIntervalMinutes: persisted.monitorIntervalMinutes,
        monitorStartAt: persisted.monitorStartAt,
        nextMonitorAt: persisted.nextMonitorAt,
      };
    }
    if (result.snapshot) {
      current.snapshots.push(result.snapshot);
      const logs = await notifyBelowThreshold(current, result.product, result.snapshot, source);
      current.notificationLogs.push(...logs);
      if (current.feishu.documentEnabled && current.feishu.documentId) {
        try {
          await appendPriceDocument(current.feishu.documentId, result.product, result.snapshot);
          current.feishu.lastDocumentSyncAt = new Date().toISOString();
          current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "sent", message: "价格快照已写入飞书文档。", source }));
        } catch (error) {
          current.notificationLogs.push(createNotificationLog({ productId: result.product.id, type: "document-sync", status: "failed", message: error.message, source }));
        }
      }
    }
    current.monitor.lastRunAt = new Date().toISOString();
    current.runs.push(runRecord);
    current.runs = current.runs.slice(-200);
    return current;
  });

  return { run: runRecord, ...result };
}

export async function runProductOnce(productId, options = {}) {
  return withCaptureLock(() => runProductUnlocked(productId, options));
}

async function scheduleNext() {
  if (timer) windowClearTimeout(timer);
  const data = await readDb();

  if (!data.monitor.running) {
    await updateDb((db) => {
      db.monitor.nextRunAt = null;
      return db;
    });
    return null;
  }
  const now = Date.now();
  const scheduledProducts = scheduleProducts(data.products, data.monitor, { now });
  const nextRunAt = earliestProductSchedule(scheduledProducts, data.monitor, now);
  await updateDb((db) => {
    const byId = new Map(scheduledProducts.map((product) => [product.id, product]));
    db.products = db.products.map((product) => {
      const scheduled = byId.get(product.id);
      return scheduled ? { ...product, nextMonitorAt: scheduled.nextMonitorAt } : product;
    });
    db.monitor.nextRunAt = nextRunAt;
    return db;
  });
  if (!nextRunAt) return null;
  const delayMs = Math.max(1000, Date.parse(nextRunAt) - Date.now());
  timer = setTimeout(async () => {
    let dueIds = [];
    try {
      const current = await readDb();
      dueIds = dueProductIds(current.products, Date.now());
      if (dueIds.length) {
        await runMonitorOnce({ source: "scheduled", productIds: dueIds });
        const completedAt = Date.now();
        await updateDb((db) => {
          db.products = db.products.map((product) => dueIds.includes(product.id)
            ? scheduleProduct(product, db.monitor, { reset: true, now: completedAt })
            : product);
          return db;
        });
      }
    } catch (error) {
      console.error("[monitor]", error);
      if (dueIds.length) {
        const retryAt = new Date(Date.now() + 60_000).toISOString();
        await updateDb((db) => {
          db.products = db.products.map((product) => dueIds.includes(product.id) && product.enabled
            ? { ...product, nextMonitorAt: retryAt }
            : product);
          return db;
        });
      }
    } finally {
      await scheduleNext();
    }
  }, delayMs);

  return timer;
}

function windowClearTimeout(handle) {
  clearTimeout(handle);
  timer = null;
}

export async function rescheduleMonitor() {
  return scheduleNext();
}

export function startScheduler() {
  rescheduleMonitor().catch((error) => console.error("[scheduler]", error));
}

export function stopScheduler() {
  if (timer) windowClearTimeout(timer);
}
