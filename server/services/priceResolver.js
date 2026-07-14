import crypto from "node:crypto";

export const PRICE_PARSER_VERSION = "evidence-v1.1";

const endpoint = "mtop.taobao.pcdetail.data.adjust";
const publicPromotionLabels = new Map([
  ["spsd4plan", "平台活动立减"],
  ["spsd4cjmj", "超级立减"],
  ["spsd4bybt", "百亿补贴"],
]);

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
      itemId: String(exParams.itemId || exParams.itemNumId || data.itemId || data.itemNumId || ""),
      skuId: String(exParams.skuId || data.skuId || data.selectSkuId || ""),
    };
  } catch {
    return { itemId: "", skuId: "" };
  }
}

function promotionKind(code, accountType) {
  if (publicPromotionLabels.has(code)) return "public";
  if (code === "spsd4jzjj") return "surprise";
  if (code === "1" || code === "coupon2RedForNewUser") return "gift";
  if (/88|vip|member/i.test(code)) return "vip88";
  if (code === "uppAcrossPromotion" || /coin|淘金币|金币/i.test(code)) return "coin";
  return accountType === "gift" && /gift|lijin/i.test(code) ? "gift" : "unknown";
}

function promotionLabel(code, kind) {
  return publicPromotionLabels.get(code) || {
    surprise: "惊喜立减",
    gift: "首单礼金",
    vip88: "88VIP优惠",
    coin: "淘金币抵扣",
  }[kind] || code;
}

function evidenceId(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function makeEvidence(base, value) {
  const evidence = { ...base, ...value };
  return { id: evidenceId(evidence), ...evidence };
}

function resolvedChannel(valueCents, formula, evidenceIds = []) {
  return { status: "verified", valueCents, formula, evidenceIds };
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
  const promotions = Array.from(promotionAmounts, ([code, amountCents]) => {
    const kind = promotionKind(code, accountType);
    return { code, amountCents, kind, label: promotionLabel(code, kind) };
  });
  const byKind = (kind) => promotions.filter((item) => item.kind === kind);
  const total = (items) => items.reduce((sum, item) => sum + item.amountCents, 0);
  const publicPromotions = byKind("public");
  const normalCents = listCents - total(publicPromotions);
  if (normalCents <= 0) return ambiguous("public-formula-invalid");

  const surprisePromotions = byKind("surprise");
  const giftPromotions = byKind("gift");
  const vip88Promotions = byKind("vip88");
  if (giftPromotions.length && vip88Promotions.length) return ambiguous("mixed-account-benefits");
  const surpriseCents = normalCents - total(surprisePromotions);
  const accountBenefitKind = giftPromotions.length ? "gift" : vip88Promotions.length ? "vip88" : null;
  const accountBenefitPromotions = accountBenefitKind === "gift" ? giftPromotions : vip88Promotions;
  const accountBenefitCents = surpriseCents - total(accountBenefitPromotions);
  const coinPromotions = byKind("coin");
  const finalCents = accountBenefitCents - total(coinPromotions);
  if (surpriseCents <= 0 || accountBenefitCents <= 0 || finalCents <= 0 || finalCents !== displayedCents) {
    return ambiguous("formula-does-not-close", { formulaInputs: { listCents, normalCents, surpriseCents, accountBenefitCents, finalCents, displayedCents, promotions } });
  }

  const capturedAt = options.capturedAt || new Date().toISOString();
  const baseEvidence = {
    itemId,
    skuId,
    accountType,
    endpoint,
    selectedSkuVerified,
    capturedAt,
    promotionCodes: promotions.map((item) => item.code),
  };
  const evidence = [
    makeEvidence(baseEvidence, { kind: "list", valueCents: listCents, source: "api-explicit", sourcePath: "$.data.componentsVO.xsRedPacketParamVO.trackParams.price1" }),
    makeEvidence(baseEvidence, { kind: "normal", valueCents: normalCents, source: "api-formula", sourcePath: "$.data.componentsVO.xsRedPacketParamVO.xsRedPocketParams.tbShopRedPocket.umpInfo.umpPromotionList" }),
  ];
  const normalFormula = promotionFormula("标价", listCents, publicPromotions, "普通价", normalCents);
  const channels = {
    normal: resolvedChannel(normalCents, normalFormula),
    surprise: unavailableChannel(),
    gift: unavailableChannel(),
    vip88: unavailableChannel(),
    coin: unavailableChannel(),
  };
  if (surprisePromotions.length) {
    const formula = promotionFormula("普通价", normalCents, surprisePromotions, "惊喜立减价", surpriseCents);
    const item = makeEvidence(baseEvidence, { kind: "surprise", valueCents: surpriseCents, source: "api-formula", sourcePath: "$.data.componentsVO.xsRedPacketParamVO.trackParams.price2", formula });
    evidence.push(item);
    channels.surprise = resolvedChannel(surpriseCents, formula, [item.id]);
  }
  if (accountBenefitKind) {
    const label = accountBenefitKind === "gift" ? "礼金价" : "88VIP价";
    const baseLabel = surprisePromotions.length ? "惊喜立减价" : "普通价";
    const formula = promotionFormula(baseLabel, surpriseCents, accountBenefitPromotions, label, accountBenefitCents);
    const item = makeEvidence(baseEvidence, { kind: accountBenefitKind, valueCents: accountBenefitCents, source: "api-formula", sourcePath: "$.data.componentsVO.xsRedPacketParamVO.trackParams.price2", formula });
    evidence.push(item);
    channels[accountBenefitKind] = resolvedChannel(accountBenefitCents, formula, [item.id]);
  }
  if (coinPromotions.length) {
    const baseLabel = accountBenefitKind ? (accountBenefitKind === "gift" ? "礼金价" : "88VIP价") : surprisePromotions.length ? "惊喜立减价" : "普通价";
    const formula = promotionFormula(baseLabel, accountBenefitCents, coinPromotions, "淘金币价", finalCents);
    const item = makeEvidence(baseEvidence, { kind: "coin", valueCents: finalCents, source: "api-formula", sourcePath: "$.data.componentsVO.xsRedPacketParamVO.trackParams.price2", formula });
    evidence.push(item);
    channels.coin = resolvedChannel(finalCents, formula, [item.id]);
  }
  channels.normal.evidenceIds = evidence.filter((item) => item.kind === "list" || item.kind === "normal").map((item) => item.id);

  return {
    matched: true,
    status: "verified",
    parserVersion: PRICE_PARSER_VERSION,
    endpoint,
    itemId,
    skuId,
    accountType,
    channels,
    evidence,
    promotions,
    displayedCents,
    evidenceHash: evidenceId(evidence.map(({ id }) => id)),
  };
}

export function resolveSkuPriceEvidence(payloads, options = {}) {
  const candidates = payloads.map((payload) => resolvePcdetailAdjustPayload(payload, options)).filter((item) => item.matched);
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
  const signatures = new Set(verified.map((item) => JSON.stringify(Object.fromEntries(Object.entries(item.channels).map(([key, value]) => [key, value.valueCents])))));
  if (signatures.size > 1) return ambiguous("conflicting-verified-responses");
  return { ...verified[0], attempts };
}

export function applyPriceResolution(sku, resolution) {
  if (!resolution?.matched || resolution.status !== "verified") {
    return resolution?.matched ? { ...sku, resolutionStatus: resolution.status, priceResolution: resolution } : sku;
  }
  const value = (kind) => {
    const cents = resolution.channels[kind]?.valueCents;
    return Number.isSafeInteger(cents) ? cents / 100 : null;
  };
  const normalPrice = value("normal");
  const priceLayers = (sku.priceLayers || []).filter((layer) => !/普通价（活动公式）|惊喜立减价|礼金价|88VIP价/.test(layer.label || ""));
  priceLayers.push({ label: "普通价", value: normalPrice, kind: "price", source: "pcdetail-adjust" });
  const channelFields = {
    surprise: ["surprisePrice", "surpriseStatus", "surpriseDiscountAmount", "惊喜立减价"],
    gift: ["giftPrice", "giftStatus", "giftDiscountAmount", "礼金价"],
    vip88: ["vipPrice", "vipStatus", "vipDiscountAmount", "88VIP价"],
  };
  const channelValues = Object.fromEntries(Object.keys(channelFields).map((kind) => [kind, value(kind)]));
  for (const [kind, [, , , label]] of Object.entries(channelFields)) {
    if (channelValues[kind] != null) priceLayers.push({ label, value: channelValues[kind], kind: "price", source: "pcdetail-adjust" });
  }
  const result = {
    ...sku,
    price: normalPrice,
    normalPrice,
    originalPrice: resolution.evidence.find((item) => item.kind === "list")?.valueCents / 100 || sku.originalPrice,
    priceTitle: "普通价",
    priceLayers,
    priceEvidence: resolution.evidence,
    priceResolution: resolution,
    resolutionStatus: "verified",
    parserVersion: resolution.parserVersion,
    priceCalculation: {
      ...(sku.priceCalculation || {}),
      normal: resolution.channels.normal.formula,
      surprise: resolution.channels.surprise.formula || "本次未获取明确惊喜立减证据",
      gift: resolution.channels.gift.formula || "本次未获取明确礼金证据",
      vip88: resolution.channels.vip88.formula || "本次未获取明确88VIP证据",
      coin: resolution.channels.coin.formula || sku.priceCalculation?.coin || "本次未获取明确淘金币证据",
    },
  };
  for (const [kind, [priceField, statusField, discountField]] of Object.entries(channelFields)) {
    const channelPrice = channelValues[kind];
    result[priceField] = channelPrice;
    result[statusField] = channelPrice != null ? "available" : "none";
    const baseCents = kind === "surprise"
      ? resolution.channels.normal.valueCents
      : resolution.channels.surprise.valueCents ?? resolution.channels.normal.valueCents;
    result[discountField] = channelPrice != null ? (baseCents - resolution.channels[kind].valueCents) / 100 : null;
  }
  const coinPrice = value("coin");
  if (coinPrice != null) {
    result.coinPrice = coinPrice;
    result.coinStatus = "available";
    const coinBaseCents = resolution.channels.gift.valueCents
      ?? resolution.channels.vip88.valueCents
      ?? resolution.channels.surprise.valueCents
      ?? resolution.channels.normal.valueCents;
    result.coinDiscountAmount = (coinBaseCents - resolution.channels.coin.valueCents) / 100;
  } else {
    result.coinPrice = null;
    result.coinStatus = "none";
    result.coinDiscountAmount = null;
  }
  return result;
}
