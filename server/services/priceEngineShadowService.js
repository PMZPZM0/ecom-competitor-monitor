const CHANNEL_FIELDS = Object.freeze({
  normal: Object.freeze(["normalPrice", "price"]),
  government: Object.freeze(["governmentPrice"]),
  surprise: Object.freeze(["surprisePrice"]),
  gift: Object.freeze(["giftPrice"]),
  vip88: Object.freeze(["vipPrice"]),
  coin: Object.freeze(["coinPrice"]),
});

const HISTORY_LIMIT = 30;
const DEFAULT_REQUIRED_ROUNDS = 10;

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function amountToCents(value) {
  if (value == null || value === "") return null;
  const source = typeof value === "number"
    ? String(value)
    : String(value).trim().replace(/[¥￥,\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return null;
  const [yuan, fraction = ""] = source.split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function safeParserVersion(value) {
  const version = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version) ? version : "unknown";
}

function roundTimestamp(meta = {}) {
  const candidate = meta.recordedAt ?? meta.now ?? meta.at;
  const date = candidate instanceof Date ? candidate : new Date(candidate ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalDisplayMatches(view, expectedCents) {
  const presentFields = CHANNEL_FIELDS.normal.filter((field) => view?.[field] != null && view[field] !== "");
  return presentFields.length > 0 && presentFields.every((field) => amountToCents(view[field]) === expectedCents);
}

function displayMatches(view, channel, expectedCents) {
  if (channel === "normal") return normalDisplayMatches(view, expectedCents);
  const field = CHANNEL_FIELDS[channel]?.[0];
  return Boolean(field) && amountToCents(view?.[field]) === expectedCents;
}

function auditView(view, inheritedParserVersion, summary) {
  const resolution = view?.priceResolution;
  const channels = resolution?.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) return;

  const parserVersion = safeParserVersion(view?.parserVersion || resolution?.parserVersion || inheritedParserVersion);
  for (const channel of Object.keys(CHANNEL_FIELDS)) {
    const result = channels[channel];
    if (!result || typeof result !== "object") continue;
    if (result.status === "unavailable") {
      summary.unavailable += 1;
      continue;
    }
    if (result.status !== "verified") continue;

    summary.verifiedChannels += 1;
    summary.parserVersions[parserVersion] = (summary.parserVersions[parserVersion] || 0) + 1;
    if (!Number.isSafeInteger(result.valueCents)
      || result.valueCents <= 0
      || !displayMatches(view, channel, result.valueCents)) {
      summary.mismatches += 1;
    }
  }
}

function sortedParserVersions(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .map(([version, count]) => [safeParserVersion(version), nonNegativeInteger(count)])
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function safeStoredRound(round = {}) {
  return {
    recordedAt: roundTimestamp({ recordedAt: round.recordedAt }),
    products: nonNegativeInteger(round.products),
    failedProducts: nonNegativeInteger(round.failedProducts),
    skus: nonNegativeInteger(round.skus),
    verifiedChannels: nonNegativeInteger(round.verifiedChannels),
    mismatches: nonNegativeInteger(round.mismatches),
    unavailable: nonNegativeInteger(round.unavailable),
    parserVersions: sortedParserVersions(round.parserVersions),
  };
}

export function auditPriceEngineShadowRound(snapshots = [], meta = {}) {
  const summary = {
    recordedAt: roundTimestamp(meta),
    products: 0,
    failedProducts: nonNegativeInteger(meta.failedProducts),
    skus: 0,
    verifiedChannels: 0,
    mismatches: 0,
    unavailable: 0,
    parserVersions: {},
  };

  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    summary.products += 1;
    const skus = Array.isArray(snapshot.skuPrices) ? snapshot.skuPrices : [];
    summary.skus += skus.length;
    for (const sku of skus) {
      auditView(sku, snapshot.parserVersion, summary);
      for (const accountPrice of Array.isArray(sku?.accountPrices) ? sku.accountPrices : []) {
        auditView(accountPrice, sku?.parserVersion || snapshot.parserVersion, summary);
      }
    }
  }

  summary.parserVersions = sortedParserVersions(summary.parserVersions);
  return summary;
}

export function recordPriceEngineShadowRound(currentConfig = {}, snapshots = [], meta = {}) {
  const config = currentConfig && typeof currentConfig === "object" && !Array.isArray(currentConfig)
    ? currentConfig
    : {};
  const legacyRounds = config.rounds;
  const storedHistory = Array.isArray(config.shadowRounds)
    ? config.shadowRounds
    : Array.isArray(legacyRounds) ? legacyRounds : [];
  const history = storedHistory.map(safeStoredRound).slice(-(HISTORY_LIMIT - 1));
  const requiredShadowRounds = positiveInteger(config.requiredShadowRounds, DEFAULT_REQUIRED_ROUNDS);
  const legacyCompleted = nonNegativeInteger(config.shadowRoundsCompleted, nonNegativeInteger(legacyRounds));
  const previousCleanRounds = nonNegativeInteger(config.consecutiveCleanShadowRounds, legacyCompleted);
  const previousAttempts = nonNegativeInteger(
    config.shadowRoundsAttempted,
    Math.max(previousCleanRounds, storedHistory.length),
  );
  const round = auditPriceEngineShadowRound(snapshots, meta);
  const hasVerifiedEvidence = round.verifiedChannels > 0;
  const cleanRound = hasVerifiedEvidence && round.mismatches === 0 && round.failedProducts === 0;
  const consecutiveCleanShadowRounds = cleanRound ? previousCleanRounds + 1 : 0;
  const shadowRounds = [...history, round];
  const updated = {
    ...config,
    mode: consecutiveCleanShadowRounds >= requiredShadowRounds ? "active" : "shadow",
    requiredShadowRounds,
    shadowRoundsCompleted: consecutiveCleanShadowRounds,
    consecutiveCleanShadowRounds,
    shadowRoundsAttempted: previousAttempts + 1,
    lastShadowAt: round.recordedAt,
    shadowRounds,
  };

  if (Object.hasOwn(config, "rounds")) {
    updated.rounds = Array.isArray(legacyRounds) ? shadowRounds : consecutiveCleanShadowRounds;
  }
  return updated;
}
