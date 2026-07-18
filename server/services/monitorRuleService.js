export const MONITOR_CHANNELS = Object.freeze([
  "lowest",
  "normal",
  "billion",
  "seckill",
  "government",
  "surprise",
  "gift",
  "vip88",
  "coin",
]);

const ACCOUNT_CHANNELS = Object.freeze({
  // Campaign channels are public price evidence and are available from every
  // authenticated account type. Account-specific channels remain scoped below.
  normal: Object.freeze(["normal", "billion", "seckill", "government", "surprise", "coin"]),
  gift: Object.freeze(["normal", "billion", "seckill", "government", "surprise", "gift", "coin"]),
  vip88: Object.freeze(["normal", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"]),
});

function accountChannels(accountType) {
  return ACCOUNT_CHANNELS[accountType] || ACCOUNT_CHANNELS.normal;
}

export function monitorChannelsForAccount(accountType = "normal") {
  return ["lowest", ...accountChannels(accountType)];
}

export function monitorChannelSupported(accountType = "normal", channel = "lowest") {
  return channel === "lowest" || accountChannels(accountType).includes(channel);
}

function thresholdToCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const cents = Math.round((numeric + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function verifiedChannelCents(sku, channel) {
  const resolution = sku?.priceResolution?.channels?.[channel];
  return resolution?.status === "verified"
    && Number.isSafeInteger(resolution.valueCents)
    && resolution.valueCents > 0
    ? resolution.valueCents
    : null;
}

function resolveMonitorPrice(sku, accountType, channel) {
  const supported = accountChannels(accountType);
  if (channel !== "lowest" && !supported.includes(channel)) return null;

  const candidates = (channel === "lowest" ? supported : [channel])
    .map((candidate) => ({ channel: candidate, priceCents: verifiedChannelCents(sku, candidate) }))
    .filter((candidate) => candidate.priceCents !== null);
  return candidates.reduce((lowest, candidate) => (
    !lowest || candidate.priceCents < lowest.priceCents ? candidate : lowest
  ), null);
}

export function resolveMonitorPriceCents(sku, accountType = "normal", channel = "lowest") {
  return resolveMonitorPrice(sku, accountType, channel)?.priceCents ?? null;
}

export function evaluateMonitorAlert({ priceCents, threshold, previousState = null }) {
  const thresholdCents = thresholdToCents(threshold);
  if (thresholdCents === null) throw new TypeError("Monitor threshold must be a positive amount.");

  const previous = previousState?.thresholdCents === thresholdCents ? previousState : null;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    return {
      event: "unavailable",
      priceCents: null,
      thresholdCents,
      nextState: {
        thresholdCents,
        relation: previous?.relation || "unknown",
        available: false,
        lastPriceCents: previous?.lastPriceCents ?? null,
        episodeLowCents: previous?.episodeLowCents ?? null,
      },
    };
  }

  const isBelow = priceCents < thresholdCents;
  let event = "none";
  if (isBelow && previous?.relation !== "below") event = "crossing-below";
  else if (isBelow && priceCents < (previous?.episodeLowCents ?? priceCents)) event = "new-low";
  else if (!isBelow && previous?.relation === "below") event = "recovered";

  return {
    event,
    priceCents,
    thresholdCents,
    nextState: {
      thresholdCents,
      relation: isBelow ? "below" : "at-or-above",
      available: true,
      lastPriceCents: priceCents,
      episodeLowCents: isBelow
        ? Math.min(priceCents, previous?.episodeLowCents ?? priceCents)
        : null,
    },
  };
}

export function evaluateSkuMonitorRules({
  skuPrices = [],
  skuMonitorRules = {},
  accountType = "normal",
  previousStates = {},
} = {}) {
  const skus = new Map(skuPrices.map((sku) => [String(sku?.skuId || ""), sku]));
  const evaluations = [];
  const nextStates = {};

  for (const [skuId, rules] of Object.entries(skuMonitorRules || {})) {
    if (!rules || typeof rules !== "object") continue;
    for (const channel of MONITOR_CHANNELS) {
      if (!Object.hasOwn(rules, channel) || thresholdToCents(rules[channel]) === null) continue;
      const resolved = resolveMonitorPrice(skus.get(skuId), accountType, channel);
      const evaluation = evaluateMonitorAlert({
        priceCents: resolved?.priceCents ?? null,
        threshold: rules[channel],
        previousState: previousStates?.[skuId]?.[channel],
      });
      evaluations.push({
        skuId,
        channel,
        resolvedChannel: resolved?.channel ?? null,
        threshold: Number(rules[channel]),
        ...evaluation,
      });
      nextStates[skuId] ||= {};
      nextStates[skuId][channel] = evaluation.nextState;
    }
  }

  return { evaluations, nextStates };
}
