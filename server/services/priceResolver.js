import crypto from "node:crypto";

export const PRICE_PARSER_VERSION = "evidence-v2.0";

const endpoint = "mtop.taobao.pcdetail.data.adjust";
const embeddedEndpoint = "tmall-ssr-sku";
const embeddedPublicNormalLabel = /^店铺优惠后$/;
export const PRICE_PROMOTION_INDEX = new Map([
  ["commonItemDiscount", { kind: "public", label: "商品优惠" }],
  ["spsd4plan", { kind: "public", label: "平台活动立减" }],
  ["spsd4cjmj", { kind: "public", label: "超级立减" }],
  ["spsd4price", { kind: "public", label: "平台立减" }],
  ["spsd4autopri", { kind: "public", label: "平台加补" }],
  ["spsd4bybt", { kind: "billion", label: "百亿补贴" }],
  ["spsd4bybtjb", { kind: "billion", label: "百亿补贴加补" }],
  ["spsd4hjmssjbt", { kind: "seckill", label: "淘宝秒杀补贴" }],
  ["spsd4hjbt", { kind: "seckill", label: "淘宝秒杀加补" }],
  ["zflj", { kind: "government", label: "政府补贴" }],
  ["spsd4jzjj", { kind: "surprise", label: "惊喜立减" }],
  ["coupon2RedForNewUser", { kind: "gift", label: "新客礼金", accounts: new Set(["normal", "gift", "vip88"]) }],
  ["coupon2PlatRed", { kind: "gift", label: "平台礼金", accounts: new Set(["gift", "vip88"]) }],
  ["1", { kind: "gift", label: "首单礼金", accounts: new Set(["vip88"]) }],
  ["5", { kind: "gift", label: "平台礼金", accounts: new Set(["gift", "vip88"]) }],
  ["12", { kind: "coin", label: "淘金币抵扣" }],
  ["20", { kind: "public", label: "商品优惠" }],
  ["22", { kind: "vip88", label: "88VIP优惠", accounts: new Set(["vip88"]) }],
  ["coupon288vipcard", { kind: "vip88", label: "88VIP优惠", accounts: new Set(["vip88"]) }],
  ["uppAcrossPromotion", { kind: "coin", label: "淘金币抵扣" }],
  // These UMP baseline reductions are already reflected in price1.
  ["9", { kind: "ignored", label: "新品抢购基准优惠" }],
  ["10", { kind: "ignored", label: "店铺基准优惠" }],
  ["42", { kind: "ignored", label: "活动基准优惠" }],
  // This legacy amount is likewise present before price1 and is not part of price2.
  ["saleCjmj", { kind: "ignored", label: "未生效店铺满减" }],
]);

function giftPromotionVisibleForAccount(promotion, accountType = "normal") {
  const allowed = PRICE_PROMOTION_INDEX.get(String(promotion?.code || ""))?.accounts;
  return allowed instanceof Set && allowed.has(accountType);
}

function exposedChannelKinds(accountType = "normal", promotions = []) {
  const common = ["normal", "billion", "seckill", "government", "surprise", "coin"];
  const giftPromotions = promotions.filter((promotion) => promotion.kind === "gift");
  if (giftPromotions.length && giftPromotions.every((promotion) => giftPromotionVisibleForAccount(promotion, accountType))) common.push("gift");
  if (accountType === "vip88") return [...common, "vip88"];
  return common;
}

function decodeJson(value, depth = 0) {
  if (depth > 5 || typeof value !== "string") return value;
  const source = value.trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return value;
  try {
    return decodeJson(JSON.parse(source), depth + 1);
  } catch {
    return value;
  }
}

function parseBody(body) {
  const source = String(body || "").trim();
  const json = source.startsWith("{") ? source : source.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function yuanToCents(value) {
  const source = String(value ?? "").replace(/[¥￥,\s]/g, "");
  const match = source.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function requestIdentity(url) {
  try {
    const parsed = new URL(url);
    const data = decodeJson(parsed.searchParams.get("data") || "{}") || {};
    const exParams = decodeJson(data.exParams) || {};
    return {
      itemId: String(exParams.itemId || exParams.itemNumId || data.itemId || data.itemNumId || parsed.searchParams.get("itemId") || parsed.searchParams.get("id") || ""),
      skuId: String(exParams.skuId || data.skuId || data.selectSkuId || parsed.searchParams.get("skuId") || ""),
    };
  } catch {
    return { itemId: "", skuId: "" };
  }
}

function promotionKind(code) {
  return PRICE_PROMOTION_INDEX.get(code)?.kind || "unknown";
}

function promotionLabel(code, kind) {
  return PRICE_PROMOTION_INDEX.get(code)?.label || {
    surprise: "惊喜立减",
    gift: "首单礼金",
    vip88: "88VIP优惠",
    coin: "淘金币抵扣",
    billion: "百亿补贴",
    seckill: "淘宝秒杀补贴",
  }[kind] || code;
}

function campaignLabel(kind) {
  return kind === "billion" ? "百亿补贴价" : kind === "seckill" ? "淘宝秒杀价" : "普通价";
}

function normalizedFormula(formula) {
  return String(formula || "").replace(/\s+/g, " ").trim();
}

function evidenceId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function makeEvidence(base, value) {
  const evidence = { ...base, ...value };
  return { id: evidenceId(evidence), ...evidence };
}

function resolvedChannel(valueCents, formula, evidenceIds = [], label = "") {
  return { status: "verified", valueCents, formula, evidenceIds, ...(label ? { label } : {}) };
}

function unavailableChannel(reason = "no-explicit-evidence") {
  return { status: "unavailable", valueCents: null, reason, evidenceIds: [] };
}

function ambiguous(reason, extra = {}) {
  return {
    matched: true,
    status: "ambiguous",
    reason,
    channels: {
      normal: { status: "ambiguous", valueCents: null, reason, evidenceIds: [] },
      billion: unavailableChannel(),
      seckill: unavailableChannel(),
      government: unavailableChannel(),
      surprise: unavailableChannel(),
      gift: unavailableChannel(),
      vip88: unavailableChannel(),
      coin: unavailableChannel(),
    },
    evidence: [],
    ...extra,
  };
}

function promotionFormula(baseLabel, baseCents, promotions, resultLabel, resultCents) {
  const reductions = promotions.map((item) => ` - ${item.label} ${(item.amountCents / 100).toFixed(2)}`).join("");
  return `${baseLabel} ${(baseCents / 100).toFixed(2)}${reductions} = ${resultLabel} ${(resultCents / 100).toFixed(2)}`;
}

export function resolvePcdetailAdjustPayload(payload, options = {}) {
  if (!/mtop\.taobao\.pcdetail\.data\.adjust/i.test(String(payload?.url || ""))) return { matched: false };
  const parsed = parseBody(payload?.body);
  if (!parsed) return ambiguous("invalid-response-body");

  const itemId = String(options.itemId || "");
  const skuId = String(options.skuId || "");
  const accountType = options.accountType || "normal";
  const evidenceEndpoint = options.evidenceEndpoint || endpoint;
  const evidenceSource = options.evidenceSource === "ssr" ? "ssr" : "api";
  const componentPath = options.componentPath || "$.data.componentsVO.xsRedPacketParamVO";
  const listSourcePath = options.listSourcePath || `${componentPath}.trackParams.price1`;
  const promotionSourcePath = options.promotionSourcePath || `${componentPath}.xsRedPocketParams.tbShopRedPocket.umpInfo.umpPromotionList`;
  const displayedSourcePath = options.displayedSourcePath || `${componentPath}.trackParams.price2`;
  const identity = requestIdentity(payload.url);
  const component = parsed?.data?.componentsVO?.xsRedPacketParamVO;
  const trackParams = decodeJson(component?.trackParams) || {};
  const responseSkuId = String(trackParams.skuId || "");
  const identitySummary = { expectedSkuId: skuId, requestSkuId: identity.skuId, responseSkuId, capturedRequestSkuId: payload.requestSkuId || "", capturedResponseSkuId: payload.responseSkuId || "" };
  if (!skuId || responseSkuId !== skuId) return ambiguous("response-sku-mismatch", identitySummary);
  if (identity.skuId && identity.skuId !== skuId) return ambiguous("request-sku-mismatch", identitySummary);
  if (payload.requestSkuId && String(payload.requestSkuId) !== skuId) return ambiguous("captured-request-sku-mismatch", identitySummary);
  if (payload.responseSkuId && String(payload.responseSkuId) !== skuId) return ambiguous("captured-response-sku-mismatch", identitySummary);
  if (payload.skuId && String(payload.skuId) !== skuId) return ambiguous("captured-sku-mismatch", identitySummary);
  if (itemId && identity.itemId && identity.itemId !== itemId) return ambiguous("request-item-mismatch", { ...identitySummary, expectedItemId: itemId, requestItemId: identity.itemId });

  const selectedSkuVerified = Boolean(options.selectedSkuVerified || (identity.skuId === skuId && responseSkuId === skuId));
  if (!selectedSkuVerified) return ambiguous("sku-selection-unverified");

  const listCents = yuanToCents(trackParams.price1);
  const displayedCents = yuanToCents(trackParams.price2);
  if (!listCents || !displayedCents) return ambiguous("missing-price1-or-price2");

  const pocketParams = decodeJson(component?.xsRedPocketParams) || {};
  const pocket = decodeJson(pocketParams.tbShopRedPocket) || pocketParams;
  const rawPromotions = pocket?.umpInfo?.umpPromotionList;
  if (!Array.isArray(rawPromotions) && listCents !== displayedCents) return ambiguous("promotion-list-missing");

  const promotionAmounts = new Map();
  for (const item of rawPromotions || []) {
    const code = String(item?.promotionName || "").trim();
    const amountCents = Number(item?.amount);
    if (!code || !Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
    if (promotionAmounts.has(code) && promotionAmounts.get(code) !== amountCents) return ambiguous("conflicting-promotion-amount");
    promotionAmounts.set(code, amountCents);
  }
  const promotionCodeOrder = new Map([
    ["commonItemDiscount", 10], ["20", 10], ["spsd4plan", 20], ["spsd4cjmj", 30],
    ["spsd4autopri", 35], ["spsd4price", 40], ["spsd4bybt", 60], ["spsd4bybtjb", 70],
    ["spsd4hjmssjbt", 80], ["spsd4hjbt", 90], ["zflj", 100], ["spsd4jzjj", 110],
    ["coupon2RedForNewUser", 120], ["coupon2PlatRed", 130], ["5", 130], ["1", 140],
    ["coupon288vipcard", 150], ["22", 150], ["uppAcrossPromotion", 160], ["12", 160],
    ["9", 170], ["10", 180], ["42", 190], ["saleCjmj", 200],
  ]);
  const promotions = Array.from(promotionAmounts, ([code, amountCents]) => {
    const kind = promotionKind(code);
    return { code, amountCents, kind, label: promotionLabel(code, kind) };
  }).sort((left, right) => (
    (promotionCodeOrder.get(left.code) ?? 999) - (promotionCodeOrder.get(right.code) ?? 999)
    || left.code.localeCompare(right.code)
  ));
  const unknownPromotionCodes = promotions
    .filter((item) => item.kind === "unknown")
    .map((item) => item.code)
    .sort();
  if (unknownPromotionCodes.length) {
    return ambiguous("unknown-promotion-code", { promotions, unknownPromotionCodes });
  }
  const byKind = (kind) => promotions.filter((item) => item.kind === kind);
  const total = (items) => items.reduce((sum, item) => sum + item.amountCents, 0);
  const campaignKinds = [...new Set(promotions.filter((item) => item.kind === "billion" || item.kind === "seckill").map((item) => item.kind))];
  if (campaignKinds.length > 1) return ambiguous("conflicting-public-campaigns", { promotions, campaignKinds });
  const campaignKind = campaignKinds[0] || null;
  const publicPromotions = byKind("public");
  const campaignPromotions = campaignKind ? byKind(campaignKind) : [];
  const normalLabel = "普通价";
  const normalCents = listCents - total(publicPromotions);
  if (normalCents <= 0) return ambiguous("public-formula-invalid");
  const campaignCents = normalCents - total(campaignPromotions);
  if (campaignCents <= 0) return ambiguous("campaign-formula-invalid");

  const governmentPromotions = byKind("government");
  const governmentCents = campaignCents - total(governmentPromotions);
  const surprisePromotions = byKind("surprise");
  const giftPromotions = byKind("gift");
  const vip88Promotions = byKind("vip88");
  const giftVisible = !giftPromotions.length || giftPromotions.every((promotion) => giftPromotionVisibleForAccount(promotion, accountType));
  const vip88Visible = !vip88Promotions.length || accountType === "vip88";
  const surpriseCents = governmentCents - total(surprisePromotions);
  const giftCents = surpriseCents - total(giftPromotions);
  const vip88Cents = giftCents - total(vip88Promotions);
  const accountBenefitCents = vip88Cents;
  const coinPromotions = byKind("coin");
  const finalCents = accountBenefitCents - total(coinPromotions);
  if (governmentCents <= 0 || surpriseCents <= 0 || giftCents <= 0 || vip88Cents <= 0 || finalCents <= 0 || finalCents !== displayedCents) {
    return ambiguous("formula-does-not-close", { formulaInputs: { listCents, normalCents, campaignCents, governmentCents, surpriseCents, giftCents, vip88Cents, finalCents, displayedCents, promotions } });
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const baseEvidence = {
    itemId,
    skuId,
    accountType,
    endpoint: evidenceEndpoint,
    selectedSkuVerified,
    capturedAt,
    campaignKind,
    promotionCodes: promotions.map((item) => item.code),
  };
  const evidence = [
    makeEvidence(baseEvidence, { kind: "list", valueCents: listCents, source: `${evidenceSource}-explicit`, sourcePath: listSourcePath }),
    makeEvidence(baseEvidence, { kind: "normal", valueCents: normalCents, source: `${evidenceSource}-formula`, sourcePath: promotionSourcePath }),
  ];
  const normalFormula = promotionFormula("标价", listCents, publicPromotions, normalLabel, normalCents);
  const channels = {
    normal: resolvedChannel(normalCents, normalFormula),
    billion: unavailableChannel(),
    seckill: unavailableChannel(),
    government: unavailableChannel(),
    surprise: unavailableChannel(),
    gift: unavailableChannel(),
    vip88: unavailableChannel(),
    coin: unavailableChannel(),
  };
  if (campaignKind) {
    const formula = promotionFormula(normalLabel, normalCents, campaignPromotions, campaignLabel(campaignKind), campaignCents);
    const item = makeEvidence(baseEvidence, { kind: campaignKind, valueCents: campaignCents, source: `${evidenceSource}-formula`, sourcePath: promotionSourcePath, formula });
    evidence.push(item);
    channels[campaignKind] = resolvedChannel(campaignCents, formula, [item.id]);
  }
  if (governmentPromotions.length) {
    const formula = promotionFormula(campaignLabel(campaignKind), campaignCents, governmentPromotions, "国补价", governmentCents);
    const item = makeEvidence(baseEvidence, { kind: "government", valueCents: governmentCents, source: `${evidenceSource}-formula`, sourcePath: promotionSourcePath, formula });
    evidence.push(item);
    channels.government = resolvedChannel(governmentCents, formula, [item.id]);
  }
  if (surprisePromotions.length) {
    const formula = promotionFormula(governmentPromotions.length ? "国补价" : campaignLabel(campaignKind), governmentCents, surprisePromotions, "惊喜立减价", surpriseCents);
    const item = makeEvidence(baseEvidence, { kind: "surprise", valueCents: surpriseCents, source: `${evidenceSource}-formula`, sourcePath: displayedSourcePath, formula });
    evidence.push(item);
    channels.surprise = resolvedChannel(surpriseCents, formula, [item.id]);
  }
  if (giftPromotions.length) {
    const baseLabel = surprisePromotions.length ? "惊喜立减价" : governmentPromotions.length ? "国补价" : campaignLabel(campaignKind);
    const giftLabels = [...new Set(giftPromotions.map((promotion) => `${promotion.label}价`))];
    const giftLabel = giftLabels.length === 1 ? giftLabels[0] : "礼金价";
    const formula = promotionFormula(baseLabel, surpriseCents, giftPromotions, giftLabel, giftCents);
    if (giftVisible) {
      const item = makeEvidence(baseEvidence, { kind: "gift", valueCents: giftCents, source: `${evidenceSource}-formula`, sourcePath: displayedSourcePath, formula });
      evidence.push(item);
      channels.gift = resolvedChannel(giftCents, formula, [item.id], giftLabel);
    } else {
      channels.gift = unavailableChannel("different-account-promotion");
    }
  }
  if (vip88Promotions.length) {
    const baseLabel = channels.gift.label || (giftPromotions.length ? "礼金价" : surprisePromotions.length ? "惊喜立减价" : governmentPromotions.length ? "国补价" : campaignLabel(campaignKind));
    const formula = promotionFormula(baseLabel, giftCents, vip88Promotions, "88VIP价", vip88Cents);
    if (vip88Visible) {
      const item = makeEvidence(baseEvidence, { kind: "vip88", valueCents: vip88Cents, source: `${evidenceSource}-formula`, sourcePath: displayedSourcePath, formula });
      evidence.push(item);
      channels.vip88 = resolvedChannel(vip88Cents, formula, [item.id]);
    } else {
      channels.vip88 = unavailableChannel("different-account-promotion");
    }
  }
  if (coinPromotions.length) {
    const dependsOnHiddenAccountChannel = !giftVisible || !vip88Visible;
    if (dependsOnHiddenAccountChannel) {
      channels.coin = unavailableChannel("depends-on-different-account-channel");
    } else {
      const baseLabel = vip88Promotions.length ? "88VIP价" : channels.gift.label || (giftPromotions.length ? "礼金价" : surprisePromotions.length ? "惊喜立减价" : governmentPromotions.length ? "国补价" : campaignLabel(campaignKind));
      const formula = promotionFormula(baseLabel, accountBenefitCents, coinPromotions, "淘金币价", finalCents);
      const item = makeEvidence(baseEvidence, { kind: "coin", valueCents: finalCents, source: `${evidenceSource}-formula`, sourcePath: displayedSourcePath, formula });
      evidence.push(item);
      channels.coin = resolvedChannel(finalCents, formula, [item.id]);
    }
  }
  channels.normal.evidenceIds = evidence.filter((item) => item.kind === "list" || item.kind === "normal").map((item) => item.id);

  return {
    matched: true,
    status: "verified",
    parserVersion: PRICE_PARSER_VERSION,
    endpoint: evidenceEndpoint,
    source: options.resolutionSource || (evidenceSource === "ssr" ? "embedded-promotion" : "pcdetail-adjust"),
    itemId,
    skuId,
    accountType,
    channels,
    evidence,
    promotions,
    campaignKind,
    normalLabel,
    displayedCents,
    evidenceHash: evidenceId(evidence.map(({ id }) => id)),
  };
}

function parseUmpPriceLogMap(value, skuId) {
  const source = String(value || "").trim();
  const prefix = `{${skuId}:`;
  if (!/^\d{5,30}$/.test(skuId) || !source.startsWith(prefix) || !source.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(source.slice(prefix.length, -1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveUmpPriceLogPayload(payload, options = {}) {
  if (!/mtop\.taobao\.pcdetail\.data\.adjust/i.test(String(payload?.url || ""))) return { matched: false };
  const parsed = parseBody(payload?.body);
  const ump = parsed?.data?.componentsVO?.umpPriceLogVO;
  if (!ump || typeof ump !== "object" || Array.isArray(ump)) return { matched: false };

  const itemId = String(options.itemId || "");
  const skuId = String(options.skuId || "");
  const responseItemId = String(ump.xobjectId || "");
  const responseSkuId = String(ump.sid || "");
  if (!itemId || !skuId || responseItemId !== itemId || responseSkuId !== skuId) {
    return ambiguous("ump-identity-mismatch", { expectedItemId: itemId, responseItemId, expectedSkuId: skuId, responseSkuId });
  }
  const priceLog = parseUmpPriceLogMap(ump.map, skuId);
  if (!priceLog) return ambiguous("invalid-ump-price-map");

  const listCents = yuanToCents(priceLog.price1);
  const displayedCents = yuanToCents(priceLog.price2);
  const catalogCents = yuanToCents(priceLog.price3);
  const priceVO = parsed?.data?.componentsVO?.priceVO || {};
  if (!listCents || !displayedCents || !catalogCents
    || yuanToCents(priceVO?.price?.priceText) !== listCents
    || yuanToCents(priceVO?.extraPrice?.priceText) !== displayedCents) {
    return ambiguous("ump-visible-price-mismatch");
  }

  const rawTokens = String(priceLog.utcDNow || "").split("^").filter(Boolean);
  const umpPromotionAliases = new Map([
    ["1", "coupon2RedForNewUser"],
    ["5", "coupon2PlatRed"],
    ["12", "uppAcrossPromotion"],
    ["20", "commonItemDiscount"],
    ["22", "coupon288vipcard"],
  ]);
  const promotions = [];
  for (const token of rawTokens) {
    const match = token.match(/^([A-Za-z0-9]+)_(\d+)$/);
    if (!match) return ambiguous("invalid-ump-promotion-token", { token });
    const amount = Number(match[2]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return ambiguous("invalid-ump-promotion-amount", { token });
    promotions.push({ promotionName: umpPromotionAliases.get(match[1]) || match[1], amount });
  }
  const unknownPromotionCodes = [...new Set(promotions
    .map((item) => item.promotionName)
    .filter((code) => !PRICE_PROMOTION_INDEX.has(code)))].sort();
  if (unknownPromotionCodes.length) return ambiguous("unknown-promotion-code", { unknownPromotionCodes });

  const baselineDiscountCents = promotions
    .filter((item) => PRICE_PROMOTION_INDEX.get(item.promotionName)?.kind === "ignored")
    .reduce((sum, item) => sum + item.amount, 0);
  if (catalogCents - baselineDiscountCents !== listCents) {
    return ambiguous("ump-baseline-formula-does-not-close", { catalogCents, baselineDiscountCents, listCents });
  }

  const data = encodeURIComponent(JSON.stringify({ itemId, skuId }));
  return resolvePcdetailAdjustPayload({
    url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`,
    skuId,
    requestSkuId: skuId,
    responseSkuId: skuId,
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: {
      trackParams: { itemId, skuId, price1: priceLog.price1, price2: priceLog.price2 },
      xsRedPocketParams: { tbShopRedPocket: { umpInfo: { umpPromotionList: promotions } } },
    } } } }),
  }, {
    ...options,
    selectedSkuVerified: true,
    evidenceEndpoint: "tmall-ump-price-log",
    resolutionSource: "ump-price-log",
    componentPath: "$.data.componentsVO.umpPriceLogVO",
    listSourcePath: `$.data.componentsVO.umpPriceLogVO.map[${skuId}].price1`,
    promotionSourcePath: `$.data.componentsVO.umpPriceLogVO.map[${skuId}].utcDNow`,
    displayedSourcePath: `$.data.componentsVO.umpPriceLogVO.map[${skuId}].price2`,
  });
}

export function resolveSkuPriceEvidence(payloads, options = {}) {
  const candidates = payloads.flatMap((payload) => [
    resolvePcdetailAdjustPayload(payload, options),
    resolveUmpPriceLogPayload(payload, options),
  ]).filter((item) => item.matched);
  if (!candidates.length) return { matched: false, status: "unavailable", reason: "supported-endpoint-not-observed", evidence: [] };
  const verified = candidates.filter((item) => item.status === "verified");
  const attempts = candidates.map((item) => ({
    status: item.status,
    reason: item.reason || "",
    expectedSkuId: item.expectedSkuId || options.skuId || "",
    requestSkuId: item.requestSkuId || "",
    responseSkuId: item.responseSkuId || "",
    capturedRequestSkuId: item.capturedRequestSkuId || "",
    capturedResponseSkuId: item.capturedResponseSkuId || "",
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!verified.length) return { ...candidates[0], attempts };
  const signatures = new Set(verified.map((item) => {
    const channelKinds = exposedChannelKinds(options.accountType, item.promotions || []);
    const listCents = item.evidence?.find((evidence) => evidence.kind === "list")?.valueCents ?? null;
    const channels = Object.fromEntries(channelKinds.map((kind) => {
      const channel = item.channels[kind] || unavailableChannel();
      return [kind, {
        status: channel.status || "unavailable",
        valueCents: channel.valueCents ?? null,
        formula: normalizedFormula(channel.formula),
      }];
    }));
    return JSON.stringify({ listCents, campaignKind: item.campaignKind || null, normalLabel: item.normalLabel || "普通价", channels });
  }));
  if (signatures.size > 1) return ambiguous("conflicting-verified-responses", { attempts });
  const selected = verified.toSorted((left, right) => String(left.evidenceHash || "").localeCompare(String(right.evidenceHash || "")))[0];
  return { ...selected, attempts };
}

export function resolveEmbeddedPromotionPriceEvidence(component, options = {}) {
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    return { matched: false, status: "unavailable", reason: "embedded-promotion-not-observed", evidence: [] };
  }
  const trackParams = decodeJson(component.trackParams) || {};
  const itemId = String(options.itemId || "");
  const skuId = String(options.skuId || "");
  const responseItemId = String(trackParams.itemId || trackParams.itemNumId || "");
  const responseSkuId = String(trackParams.skuId || "");
  if (!itemId || !skuId || responseItemId !== itemId || responseSkuId !== skuId) {
    return { matched: false, status: "unavailable", reason: "embedded-promotion-identity-mismatch", evidence: [] };
  }
  const data = encodeURIComponent(JSON.stringify({ itemId, skuId }));
  return resolvePcdetailAdjustPayload({
    url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${data}`,
    skuId,
    requestSkuId: skuId,
    responseSkuId: skuId,
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: component } } }),
  }, {
    ...options,
    selectedSkuVerified: true,
    evidenceEndpoint: "tmall-ssr-promotion",
    evidenceSource: "ssr",
    resolutionSource: "embedded-promotion",
    componentPath: "$.embedded.xsRedPacketParamVO",
  });
}

export function applyItemScopedNewCustomerGift(baseResolution, component, options = {}) {
  if (!baseResolution?.matched || baseResolution.status !== "verified") return baseResolution;
  const itemId = String(options.itemId || "");
  const skuId = String(options.skuId || "");
  const accountType = options.accountType || baseResolution.accountType || "normal";
  const trackParams = decodeJson(component?.trackParams) || {};
  const pocketParams = decodeJson(component?.xsRedPocketParams) || {};
  const pocket = decodeJson(pocketParams?.tbShopRedPocket) || pocketParams;
  const sourceItemId = String(trackParams.itemId || trackParams.itemNumId || "");
  const pocketItemId = String(pocket?.itemId || "");
  const sourceSkuId = String(trackParams.skuId || "");
  if (!itemId || !skuId || sourceItemId !== itemId || pocketItemId !== itemId || !sourceSkuId) return baseResolution;
  if (baseResolution.channels?.gift?.status === "verified") return baseResolution;

  const targetEvidenceVerified = (baseResolution.evidence || []).some((item) => (
    String(item?.itemId || "") === itemId
    && String(item?.skuId || "") === skuId
    && item?.selectedSkuVerified === true
  ));
  if (!targetEvidenceVerified) return baseResolution;

  const rawPromotions = pocket?.umpInfo?.umpPromotionList;
  if (!Array.isArray(rawPromotions)) return baseResolution;
  const giftEntries = rawPromotions.filter((item) => String(item?.promotionName || "") === "coupon2RedForNewUser");
  if (giftEntries.length !== 1) return baseResolution;
  const giftEntry = giftEntries[0];
  const hasSkuRestriction = Object.entries(giftEntry).some(([key, value]) => (
    /sku|scope|range|exclude|include|eligible|applicable/i.test(key)
    && value != null
    && value !== false
    && value !== ""
    && (!Array.isArray(value) || value.length > 0)
  ));
  if (hasSkuRestriction) return baseResolution;

  const sourceResolution = resolveEmbeddedPromotionPriceEvidence(component, {
    ...options,
    skuId: sourceSkuId,
    accountType,
  });
  const sourceGift = sourceResolution.channels?.gift;
  if (sourceResolution.status !== "verified" || sourceGift?.status !== "verified") return baseResolution;

  const amountCents = Number(giftEntry.amount);
  const thresholdCents = Number(giftEntry.threshold);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isSafeInteger(thresholdCents) || thresholdCents < 0) return baseResolution;
  const baseChannel = ["surprise", "government", baseResolution.campaignKind, "normal"]
    .filter(Boolean)
    .find((kind) => baseResolution.channels?.[kind]?.status === "verified");
  const baseCents = baseChannel ? baseResolution.channels[baseChannel].valueCents : null;
  if (!Number.isSafeInteger(baseCents) || baseCents < thresholdCents || baseCents <= amountCents) return baseResolution;

  const giftCents = baseCents - amountCents;
  const baseLabel = baseChannel === "surprise"
    ? "惊喜立减价"
    : baseChannel === "government"
      ? "国补价"
      : baseChannel === "billion" || baseChannel === "seckill"
        ? campaignLabel(baseChannel)
        : "普通价";
  const giftLabel = sourceGift.label || "新客礼金价";
  const formula = promotionFormula(baseLabel, baseCents, [{ label: "新客礼金", amountCents }], giftLabel, giftCents);
  const promotion = { code: "coupon2RedForNewUser", amountCents, thresholdCents, kind: "gift", label: "新客礼金", scope: "item" };
  const evidence = makeEvidence({
    itemId,
    skuId,
    accountType,
    endpoint: "tmall-ssr-item-promotion",
    selectedSkuVerified: true,
    capturedAt: options.capturedAt || new Date().toISOString(),
    promotionCodes: [promotion.code],
  }, {
    kind: "gift",
    valueCents: giftCents,
    source: "ssr-item-formula",
    sourcePath: "$.embedded.xsRedPacketParamVO.xsRedPocketParams.tbShopRedPocket.umpInfo.umpPromotionList[coupon2RedForNewUser]",
    formula,
    scope: "item",
    sourceSkuId,
    thresholdCents,
    sourceEvidenceIds: sourceGift.evidenceIds || [],
  });
  const promotions = [
    ...(baseResolution.promotions || []).filter((item) => String(item?.code || "") !== promotion.code),
    promotion,
  ];
  const nextEvidence = [...(baseResolution.evidence || []), evidence];
  return {
    ...baseResolution,
    parserVersion: PRICE_PARSER_VERSION,
    accountType,
    source: `${baseResolution.source || "verified"}+item-scoped-gift`,
    channels: {
      ...baseResolution.channels,
      gift: resolvedChannel(giftCents, formula, [evidence.id], giftLabel),
    },
    evidence: nextEvidence,
    promotions,
    evidenceHash: evidenceId(nextEvidence.map(({ id }) => id)),
  };
}

export function resolveEmbeddedSkuPriceEvidence(sku, options = {}) {
  const itemId = String(options.itemId || "");
  const skuId = String(options.skuId || "");
  const accountType = options.accountType || "normal";
  const sourceSkuId = String(sku?.skuId || "");
  const priceTitle = String(sku?.priceTitle || "").replace(/\s+/g, "");
  if (!embeddedPublicNormalLabel.test(priceTitle)) {
    return { matched: false, status: "unavailable", reason: "supported-label-not-observed", evidence: [] };
  }
  if (!itemId || !skuId || sourceSkuId !== skuId) {
    return ambiguous("embedded-sku-mismatch", { expectedSkuId: skuId, responseSkuId: sourceSkuId });
  }

  const listCents = yuanToCents(sku?.originalPrice);
  const displayedCents = yuanToCents(sku?.normalPrice ?? sku?.price);
  const normalLayerCents = yuanToCents((sku?.priceLayers || []).find((layer) => (
    layer?.kind !== "discount" && embeddedPublicNormalLabel.test(String(layer?.label || "").replace(/\s+/g, ""))
  ))?.value);
  const listLayerCents = yuanToCents((sku?.priceLayers || []).find((layer) => (
    layer?.kind === "original" || String(layer?.label || "").replace(/\s+/g, "") === "优惠前"
  ))?.value);
  if (!listCents || !displayedCents || listCents <= displayedCents) return ambiguous("embedded-price-invalid");
  if (normalLayerCents !== displayedCents || listLayerCents !== listCents) return ambiguous("embedded-price-layer-mismatch");

  const discountCents = listCents - displayedCents;
  if (!Number.isSafeInteger(discountCents) || discountCents <= 0 || listCents - discountCents !== displayedCents) {
    return ambiguous("embedded-formula-does-not-close");
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const promotion = { code: "commonItemDiscount", amountCents: discountCents, kind: "public", label: "店铺优惠" };
  const formula = promotionFormula("标价", listCents, [promotion], "普通价", displayedCents);
  const baseEvidence = {
    itemId,
    skuId,
    accountType,
    endpoint: embeddedEndpoint,
    selectedSkuVerified: true,
    capturedAt,
    promotionCodes: [promotion.code],
  };
  const evidence = [
    makeEvidence(baseEvidence, { kind: "list", valueCents: listCents, source: "ssr-explicit", sourcePath: `$.skuCore.sku2info[${skuId}].price.priceText` }),
    makeEvidence(baseEvidence, { kind: "normal", valueCents: displayedCents, source: "ssr-explicit", sourcePath: `$.skuCore.sku2info[${skuId}].subPrice.priceText`, formula }),
  ];
  return {
    matched: true,
    status: "verified",
    parserVersion: PRICE_PARSER_VERSION,
    endpoint: embeddedEndpoint,
    source: "embedded-ssr",
    itemId,
    skuId,
    accountType,
    channels: {
      normal: resolvedChannel(displayedCents, formula, evidence.map((item) => item.id)),
      billion: unavailableChannel(),
      seckill: unavailableChannel(),
      government: unavailableChannel(),
      surprise: unavailableChannel(),
      gift: unavailableChannel(),
      vip88: unavailableChannel(),
      coin: unavailableChannel(),
    },
    evidence,
    promotions: [promotion],
    campaignKind: null,
    normalLabel: "普通价",
    displayedCents,
    evidenceHash: evidenceId(evidence.map(({ id }) => id)),
  };
}

export function selectAuthoritativePriceResolution(networkResolution, embeddedResolution) {
  const transportOnlyReasons = new Set([
    "response-sku-mismatch",
    "request-sku-mismatch",
    "captured-request-sku-mismatch",
    "captured-response-sku-mismatch",
    "captured-sku-mismatch",
    "sku-selection-unverified",
  ]);
  if (networkResolution?.matched && !transportOnlyReasons.has(networkResolution.reason)) {
    return networkResolution;
  }
  return embeddedResolution?.status === "verified" ? embeddedResolution : networkResolution;
}

function clearUnverifiedPriceFields(sku, resolution) {
  const priceFields = ["price", "normalPrice", "originalPrice", "governmentPrice", "surprisePrice", "giftPrice", "vipPrice", "coinPrice", "seckillPrice", "billionPrice"];
  const statusFields = ["governmentStatus", "surpriseStatus", "giftStatus", "vipStatus", "coinStatus", "seckillStatus", "billionStatus"];
  const discountFields = ["governmentDiscountAmount", "surpriseDiscountAmount", "giftDiscountAmount", "vipDiscountAmount", "coinDiscountAmount"];
  const calculation = Object.fromEntries(["normal", "government", "surprise", "gift", "vip88", "coin", "seckill", "billion"].map((kind) => [kind, "本次价格证据未通过验证"]));
  return {
    ...sku,
    ...Object.fromEntries(priceFields.map((field) => [field, null])),
    ...Object.fromEntries(statusFields.map((field) => [field, "none"])),
    ...Object.fromEntries(discountFields.map((field) => [field, null])),
    priceTitle: "价格待核对",
    priceLayers: [],
    priceEvidence: resolution.evidence || [],
    priceResolution: resolution,
    resolutionStatus: resolution.status,
    parserVersion: resolution.parserVersion || PRICE_PARSER_VERSION,
    priceCalculation: calculation,
  };
}

export function applyPriceResolution(sku, resolution) {
  if (!resolution?.matched || resolution.status !== "verified") {
    return clearUnverifiedPriceFields(sku, resolution || {
      matched: false,
      status: "unavailable",
      reason: "supported-price-evidence-not-observed",
      evidence: [],
      parserVersion: PRICE_PARSER_VERSION,
    });
  }
  const accountType = resolution.accountType || "normal";
  const allowedChannels = new Set(exposedChannelKinds(accountType, resolution.promotions || []));
  const scopedResolution = {
    ...resolution,
    channels: Object.fromEntries(Object.entries(resolution.channels).map(([kind, channel]) => [
      kind,
      allowedChannels.has(kind) || channel?.status !== "verified" ? channel : unavailableChannel("different-account-channel"),
    ])),
  };
  const value = (kind) => {
    const cents = scopedResolution.channels[kind]?.valueCents;
    return Number.isSafeInteger(cents) ? cents / 100 : null;
  };
  const normalPrice = value("normal");
  const normalLabel = "普通价";
  const resolutionSource = resolution.source || "pcdetail-adjust";
  const listEvidence = resolution.evidence.find((item) => item.kind === "list");
  const originalPrice = Number.isSafeInteger(listEvidence?.valueCents) ? listEvidence.valueCents / 100 : null;
  const priceLayers = originalPrice ? [{ label: "优惠前", value: originalPrice, kind: "original", source: resolutionSource }] : [];
  priceLayers.push({ label: normalLabel, value: normalPrice, kind: "price", source: resolutionSource });
  const campaignFields = {
    billion: ["billionPrice", "billionStatus", "百亿补贴价"],
    seckill: ["seckillPrice", "seckillStatus", "淘宝秒杀价"],
  };
  const channelFields = {
    government: ["governmentPrice", "governmentStatus", "governmentDiscountAmount", "国补价"],
    surprise: ["surprisePrice", "surpriseStatus", "surpriseDiscountAmount", "惊喜立减价"],
    gift: ["giftPrice", "giftStatus", "giftDiscountAmount", scopedResolution.channels.gift.label || "礼金价"],
    vip88: ["vipPrice", "vipStatus", "vipDiscountAmount", "88VIP价"],
  };
  const campaignValues = Object.fromEntries(Object.keys(campaignFields).map((kind) => [kind, value(kind)]));
  for (const [kind, [, , label]] of Object.entries(campaignFields)) {
    if (campaignValues[kind] != null) priceLayers.push({ label, value: campaignValues[kind], kind: "price", source: resolutionSource });
  }
  const channelValues = Object.fromEntries(Object.keys(channelFields).map((kind) => [kind, value(kind)]));
  for (const [kind, [, , , label]] of Object.entries(channelFields)) {
    if (channelValues[kind] != null) priceLayers.push({ label, value: channelValues[kind], kind: "price", source: resolutionSource });
  }
  const coinPrice = value("coin");
  if (coinPrice != null) priceLayers.push({ label: "淘金币价", value: coinPrice, kind: "price", source: resolutionSource });
  const promotionTypes = {
    public: "promotion",
    billion: "subsidy",
    seckill: "promotion",
    government: "subsidy",
    surprise: "reduction",
    gift: "credit",
    vip88: "member",
    coin: "credit",
  };
  const promotionChannel = (kind) => kind === "public" ? "normal" : kind;
  const discountItems = (resolution.promotions || [])
    .filter((item) => scopedResolution.channels[promotionChannel(item.kind)]?.status === "verified"
      && Number.isSafeInteger(item.amountCents)
      && item.amountCents > 0)
    .map((item) => ({
      label: item.label,
      amount: item.amountCents / 100,
      threshold: null,
      text: `${item.label} ${Number(item.amountCents / 100).toFixed(2)} 元`,
      type: promotionTypes[item.kind] || "promotion",
      source: `price-resolver:${item.kind}`,
    }));
  const coinFormula = scopedResolution.channels.coin.formula
    || (scopedResolution.channels.coin.reason === "depends-on-different-account-channel"
      ? "本次淘金币价依赖当前账号不可见的账户优惠，已停止展示"
      : "本次未获取明确淘金币证据");
  const result = {
    ...sku,
    price: normalPrice,
    normalPrice,
    originalPrice,
    priceTitle: normalLabel,
    priceLayers,
    discountItems,
    priceEvidence: resolution.evidence,
    priceResolution: scopedResolution,
    resolutionStatus: "verified",
    parserVersion: resolution.parserVersion,
    priceCalculation: {
      ...(sku.priceCalculation || {}),
      normal: scopedResolution.channels.normal.formula,
      government: scopedResolution.channels.government.formula || "本次未获取明确政府补贴证据",
      surprise: scopedResolution.channels.surprise.formula || "本次未获取明确惊喜立减证据",
      gift: scopedResolution.channels.gift.formula || (scopedResolution.channels.gift.reason === "different-account-promotion" ? "当前账号不适用本次礼金活动" : "本次未获取明确礼金证据"),
      vip88: scopedResolution.channels.vip88.formula || (accountType === "vip88" ? "本次未获取明确88VIP证据" : "当前账号不参与88VIP计算"),
      coin: coinFormula,
      seckill: scopedResolution.channels.seckill.formula || "本次未获取明确淘宝秒杀证据",
      billion: scopedResolution.channels.billion.formula || "本次未获取明确百亿补贴证据",
    },
  };
  const campaignBaseCents = scopedResolution.channels[resolution.campaignKind]?.valueCents
    ?? scopedResolution.channels.normal.valueCents;
  for (const [kind, [priceField, statusField, discountField]] of Object.entries(channelFields)) {
    const channelPrice = channelValues[kind];
    result[priceField] = channelPrice;
    result[statusField] = channelPrice != null ? "available" : "none";
    const baseCents = kind === "government"
      ? campaignBaseCents
      : kind === "surprise"
        ? scopedResolution.channels.government.valueCents ?? campaignBaseCents
        : kind === "vip88"
          ? scopedResolution.channels.gift.valueCents ?? scopedResolution.channels.surprise.valueCents ?? scopedResolution.channels.government.valueCents ?? campaignBaseCents
          : scopedResolution.channels.surprise.valueCents ?? scopedResolution.channels.government.valueCents ?? campaignBaseCents;
    result[discountField] = channelPrice != null ? (baseCents - scopedResolution.channels[kind].valueCents) / 100 : null;
  }
  for (const [kind, [priceField, statusField]] of Object.entries(campaignFields)) {
    const campaignPrice = campaignValues[kind];
    result[priceField] = campaignPrice;
    result[statusField] = campaignPrice != null ? "available" : "none";
  }
  result.coinPrice = coinPrice;
  result.coinStatus = coinPrice != null ? "available" : "none";
  result.coinDiscountAmount = coinPrice != null
    ? ((scopedResolution.channels.vip88.valueCents
      ?? scopedResolution.channels.gift.valueCents
      ?? scopedResolution.channels.surprise.valueCents
      ?? scopedResolution.channels.government.valueCents
      ?? campaignBaseCents) - scopedResolution.channels.coin.valueCents) / 100
    : null;
  return result;
}
