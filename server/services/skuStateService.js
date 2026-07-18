const channelFields = {
  normal: "normalPrice",
  government: "governmentPrice",
  surprise: "surprisePrice",
  gift: "giftPrice",
  vip88: "vipPrice",
  coin: "coinPrice",
};

function verifiedChannel(sku, channel) {
  return sku?.resolutionStatus === "verified"
    && sku?.priceResolution?.channels?.[channel]?.status === "verified";
}

function staleVerifiedPrices(previousSku, currentSku, verifiedAt) {
  if (!previousSku) return {};
  return Object.fromEntries(Object.entries(channelFields).flatMap(([channel, field]) => {
    if (verifiedChannel(currentSku, channel) || !verifiedChannel(previousSku, channel)) return [];
    const valueCents = previousSku.priceResolution.channels[channel].valueCents;
    if (!Number.isSafeInteger(valueCents) || valueCents <= 0) return [];
    return [[channel, {
      value: valueCents / 100,
      verifiedAt,
      evidenceIds: previousSku.priceResolution.channels[channel].evidenceIds || [],
      field,
    }]];
  }));
}

export function applySkuVerificationHistory(snapshot, previousSnapshot) {
  if (!snapshot || !previousSnapshot || String(snapshot.itemId || "") !== String(previousSnapshot.itemId || "")) return snapshot;
  const previousById = new Map((previousSnapshot.skuPrices || []).map((sku) => [String(sku.skuId), sku]));
  const currentIds = new Set((snapshot.skuPrices || []).map((sku) => String(sku.skuId)));
  const verifiedAt = previousSnapshot.capturedAt || null;
  const skuPrices = (snapshot.skuPrices || []).map((sku) => {
    const stalePrices = staleVerifiedPrices(previousById.get(String(sku.skuId)), sku, verifiedAt);
    return Object.keys(stalePrices).length ? { ...sku, stalePrices } : { ...sku, stalePrices: {} };
  });
  const newlyArchived = (previousSnapshot.skuPrices || [])
    .filter((sku) => !currentIds.has(String(sku.skuId)))
    .map((sku) => ({ ...structuredClone(sku), archivedAt: snapshot.capturedAt }));
  const archivedById = new Map([...(previousSnapshot.archivedSkuPrices || []), ...newlyArchived]
    .map((sku) => [String(sku.skuId), sku]));
  return { ...snapshot, skuPrices, archivedSkuPrices: [...archivedById.values()] };
}

export function updateSkuLifecycle(existing = {}, snapshot) {
  const capturedAt = snapshot?.capturedAt || new Date().toISOString();
  const next = structuredClone(existing || {});
  const activeIds = new Set();
  for (const sku of snapshot?.skuPrices || []) {
    const skuId = String(sku.skuId || "");
    if (!skuId) continue;
    activeIds.add(skuId);
    next[skuId] = {
      ...next[skuId],
      skuId,
      name: sku.name || next[skuId]?.name || skuId,
      image: sku.image || next[skuId]?.image || "",
      status: "active",
      firstSeenAt: next[skuId]?.firstSeenAt || capturedAt,
      lastSeenAt: capturedAt,
      archivedAt: null,
    };
  }
  for (const [skuId, state] of Object.entries(next)) {
    if (activeIds.has(skuId) || state.status === "archived") continue;
    next[skuId] = { ...state, status: "archived", archivedAt: capturedAt };
  }
  return next;
}
