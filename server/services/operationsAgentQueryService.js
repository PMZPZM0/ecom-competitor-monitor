const ENTITY_TYPES = Object.freeze(["all", "store", "category", "product", "audience"]);

const METRICS = Object.freeze([
  { key: "gross_revenue", label: "支付金额", format: "currency", formula: "所选销售记录的支付金额合计" },
  { key: "refund_amount", label: "成功退款金额", format: "currency", formula: "所选销售记录的成功退款金额合计" },
  { key: "gsv", label: "净 GSV", format: "currency", formula: "支付金额 - 成功退款金额" },
  { key: "promotion_spend", label: "推广花费", format: "currency", formula: "所选推广记录的花费合计" },
  { key: "promotion_revenue", label: "推广成交金额", format: "currency", formula: "推广平台归因成交金额合计" },
  { key: "fee_rate", label: "推广费率", format: "percent", formula: "推广花费 / 净 GSV；周期不齐或退款数据不完整时不可用" },
  { key: "management_roi", label: "经营投产", format: "ratio", formula: "净 GSV / 推广花费；周期不齐时不可用" },
  { key: "platform_roi", label: "平台投产", format: "ratio", formula: "推广成交金额 / 推广花费" },
  { key: "visitors", label: "访客数", format: "integer", formula: "所选销售记录访客数合计" },
  { key: "paid_buyers", label: "支付买家数", format: "integer", formula: "所选销售记录支付买家数合计" },
  { key: "conversion_rate", label: "支付转化率", format: "percent", formula: "支付买家数 / 访客数" },
  { key: "clicks", label: "点击量", format: "integer", formula: "所选推广记录点击量合计" },
  { key: "impressions", label: "展现量", format: "integer", formula: "所选推广记录展现量合计" },
  { key: "orders", label: "推广成交笔数", format: "integer", formula: "所选推广记录成交笔数合计" },
  { key: "page_views", label: "浏览量", format: "integer", formula: "所选销售记录浏览量合计" },
  { key: "favorites", label: "收藏人数", format: "integer", formula: "所选销售记录收藏人数合计" },
  { key: "cart_users", label: "加购人数", format: "integer", formula: "所选销售记录加购人数合计" },
  { key: "cart_items", label: "加购件数", format: "integer", formula: "所选销售记录加购件数合计" },
  { key: "paid_items", label: "支付件数", format: "integer", formula: "所选销售记录支付件数合计" },
  { key: "collection_cart_rate", label: "收藏加购率", format: "percent", formula: "加购人数 / 访客数" },
  { key: "cpc", label: "平均点击花费", format: "currency", formula: "推广花费 / 点击量" },
  { key: "cost_per_collect_cart", label: "收藏加购成本", format: "currency", formula: "推广花费 / 加购人数" },
  { key: "sales_rows", label: "销售明细数", format: "integer", formula: "参与计算的销售明细行数" },
  { key: "promotion_rows", label: "推广明细数", format: "integer", formula: "参与计算的推广明细行数" },
]);

const METRIC_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));
const SUM_FIELDS = Object.freeze([
  "spend", "grossRevenue", "refundAmount", "revenue", "orders", "clicks", "impressions", "visitors",
  "pageViews", "favorites", "cartUsers", "cartItems", "paidBuyers", "paidItems",
]);

function finite(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function cleanText(value, limit = 160) {
  return String(value || "").trim().slice(0, limit);
}

function normalizedIdentity(value) {
  return cleanText(value, 240).toLocaleLowerCase("zh-CN");
}

function emptyMetric() {
  return {
    spend: 0, grossRevenue: 0, refundAmount: 0, netGsv: 0, refundDataAvailable: false, revenue: 0,
    orders: 0, clicks: 0, impressions: 0, visitors: 0, pageViews: 0, favorites: 0, cartUsers: 0,
    cartItems: 0, paidBuyers: 0, paidItems: 0, feeRate: null, roi: null, conversionRate: null,
    collectionCartRate: null, cpc: null, costPerCollectCart: null,
  };
}

function sumMetrics(metrics) {
  const usable = metrics.filter(Boolean);
  const result = emptyMetric();
  for (const field of SUM_FIELDS) result[field] = usable.reduce((total, metric) => total + finite(metric[field]), 0);
  const revenueMetrics = usable.filter((metric) => finite(metric.grossRevenue) > 0 || finite(metric.revenue) > 0);
  result.netGsv = result.revenue;
  result.refundDataAvailable = revenueMetrics.length > 0 && revenueMetrics.every((metric) => metric.refundDataAvailable === true);
  result.feeRate = result.refundDataAvailable && result.revenue > 0 ? result.spend / result.revenue : null;
  result.roi = result.spend > 0 ? result.revenue / result.spend : null;
  result.conversionRate = result.visitors > 0 ? result.paidBuyers / result.visitors : null;
  result.collectionCartRate = result.visitors > 0 ? result.cartUsers / result.visitors : null;
  result.cpc = result.clicks > 0 ? result.spend / result.clicks : null;
  result.costPerCollectCart = result.cartUsers > 0 ? result.spend / result.cartUsers : null;
  return result;
}

function directMetric(entity) {
  return {
    ...emptyMetric(),
    spend: finite(entity?.spend),
    grossRevenue: finite(entity?.grossRevenue),
    refundAmount: finite(entity?.refundAmount),
    revenue: finite(entity?.revenue),
    netGsv: finite(entity?.revenue),
    refundDataAvailable: entity?.refundDataAvailable === true,
    orders: finite(entity?.orders),
    clicks: finite(entity?.clicks),
    impressions: finite(entity?.impressions),
    visitors: finite(entity?.visitors),
    pageViews: finite(entity?.pageViews),
    favorites: finite(entity?.favorites),
    cartUsers: finite(entity?.cartUsers),
    cartItems: finite(entity?.cartItems),
    paidBuyers: finite(entity?.paidBuyers),
    paidItems: finite(entity?.paidItems),
  };
}

function aggregateEntities(entities, entityType) {
  const sales = sumMetrics(entities.map((entity) => entity?.sales || (entityType === "audience" ? emptyMetric() : directMetric(entity))));
  const promotion = sumMetrics(entities.map((entity) => entity?.promotion || (entityType === "audience" ? directMetric(entity) : emptyMetric())));
  const salesCount = entities.reduce((total, entity) => total + finite(entity?.salesCount ?? (entityType === "audience" ? 0 : entity?.count)), 0);
  const promotionCount = entities.reduce((total, entity) => total + finite(entity?.promotionCount ?? (entityType === "audience" ? entity?.count : 0)), 0);
  const promotionCoverageComplete = entities.length > 0 && entityType !== "audience"
    && entities.every((entity) => entity?.promotionCoverageComplete !== false);
  const rateAvailable = promotionCoverageComplete && sales.refundDataAvailable && sales.revenue > 0 && promotionCount > 0;
  return {
    key: `agent:${entityType}`,
    name: entities.length === 1 ? entities[0].name : `已选 ${entities.length} 项`,
    matchStatus: entities.length ? "name" : "unmatched",
    sales,
    promotion,
    salesCount,
    promotionCount,
    revenue: sales.revenue,
    grossRevenue: sales.grossRevenue,
    refundAmount: sales.refundAmount,
    refundDataAvailable: sales.refundDataAvailable,
    spend: promotion.spend,
    promotionRevenue: promotion.revenue,
    promotionChannels: [],
    promotionCoverageComplete,
    roi: promotion.spend > 0 ? promotion.revenue / promotion.spend : null,
    feeRate: rateAvailable ? promotion.spend / sales.revenue : null,
    visitors: sales.visitors,
    paidBuyers: sales.paidBuyers,
    conversionRate: sales.visitors > 0 ? sales.paidBuyers / sales.visitors : null,
    clicks: promotion.clicks,
    impressions: promotion.impressions,
    orders: promotion.orders,
    salesDeduction: entities.reduce((total, entity) => total + finite(entity?.salesDeduction), 0),
    managementRoi: rateAvailable && promotion.spend > 0 ? sales.revenue / promotion.spend : null,
  };
}

function entitiesForType(workspace, entityType) {
  if (entityType === "store") return workspace?.dashboard?.stores || [];
  if (entityType === "product") return workspace?.dashboard?.products || [];
  if (entityType === "category") return workspace?.dashboard?.categories || [];
  if (entityType === "audience") return workspace?.audiences || [];
  return [];
}

function entityAliases(entity, entityType) {
  return [
    entity?.key,
    entity?.name,
    entity?.productId,
    entity?.model,
    entity?.category,
    entityType === "store" ? entity?.storeName : "",
  ].map(normalizedIdentity).filter(Boolean);
}

function selectEntities(workspace, query) {
  const entityType = ENTITY_TYPES.includes(query?.entityType) ? query.entityType : "all";
  const requestedIds = [...new Set((query?.entityIds || []).map((value) => cleanText(value, 240)).filter(Boolean))];
  const types = entityType === "all" ? ["store", "category", "product", "audience"] : [entityType];
  const requestedKeys = new Set(requestedIds.map(normalizedIdentity));
  const matchedIds = new Set();
  const sections = Object.fromEntries(types.map((type) => {
    const available = entitiesForType(workspace, type);
    const entities = !requestedKeys.size ? available : available.filter((entity) => {
      const aliases = entityAliases(entity, type);
      const matched = aliases.filter((alias) => requestedKeys.has(alias));
      matched.forEach((alias) => matchedIds.add(alias));
      return matched.length > 0;
    });
    return [type, { availableCount: available.length, entities }];
  }));
  return {
    entityType,
    requestedIds,
    sections,
    missingEntityIds: requestedIds.filter((id) => !matchedIds.has(normalizedIdentity(id))),
  };
}

function metricValue(entity, key) {
  const values = {
    gross_revenue: entity?.grossRevenue,
    refund_amount: entity?.refundAmount,
    gsv: entity?.revenue,
    promotion_spend: entity?.spend,
    promotion_revenue: entity?.promotionRevenue ?? entity?.promotion?.revenue,
    fee_rate: entity?.feeRate,
    management_roi: entity?.managementRoi,
    platform_roi: entity?.roi,
    visitors: entity?.visitors ?? entity?.sales?.visitors,
    paid_buyers: entity?.paidBuyers ?? entity?.sales?.paidBuyers,
    conversion_rate: entity?.conversionRate ?? entity?.sales?.conversionRate,
    clicks: entity?.clicks ?? entity?.promotion?.clicks,
    impressions: entity?.impressions ?? entity?.promotion?.impressions,
    orders: entity?.orders ?? entity?.promotion?.orders,
    page_views: entity?.sales?.pageViews ?? entity?.pageViews,
    favorites: entity?.sales?.favorites ?? entity?.favorites,
    cart_users: entity?.sales?.cartUsers ?? entity?.cartUsers,
    cart_items: entity?.sales?.cartItems ?? entity?.cartItems,
    paid_items: entity?.sales?.paidItems ?? entity?.paidItems,
    collection_cart_rate: entity?.sales?.collectionCartRate ?? entity?.collectionCartRate,
    cpc: entity?.promotion?.cpc ?? entity?.cpc,
    cost_per_collect_cart: entity?.promotion?.costPerCollectCart ?? entity?.costPerCollectCart,
    sales_rows: entity?.salesCount ?? 0,
    promotion_rows: entity?.promotionCount ?? entity?.count ?? 0,
  };
  const value = values[key];
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function metricProjection(entity, metricKeys) {
  return Object.fromEntries(metricKeys.map((key) => [key, metricValue(entity, key)]));
}

function entityProjection(entity, entityType, metricKeys) {
  return {
    key: cleanText(entity?.key || entity?.name, 240),
    name: cleanText(entity?.name, 240),
    ...(entity?.productId ? { productId: cleanText(entity.productId, 120) } : {}),
    ...(entity?.model ? { model: cleanText(entity.model, 160) } : {}),
    ...(entity?.category ? { category: cleanText(entity.category, 160) } : {}),
    ...(entity?.storeName ? { storeName: cleanText(entity.storeName, 80) } : {}),
    ...(entityType !== "audience" ? {
      matchStatus: entity?.matchStatus || "unmatched",
      promotionCoverageComplete: entity?.promotionCoverageComplete === true,
      refundDataAvailable: entity?.refundDataAvailable === true,
    } : {}),
    metrics: metricProjection(entity, metricKeys),
  };
}

function queryMetricKeys(query) {
  const selected = [...new Set((query?.metrics || []).filter((key) => METRIC_BY_KEY.has(key)))];
  return selected.length ? selected : METRICS.map((metric) => metric.key);
}

function defaultSummaryEntities(workspace, selection) {
  if (selection.entityType !== "all") return selection.sections[selection.entityType]?.entities || [];
  return selection.sections.store?.entities?.length
    ? selection.sections.store.entities
    : workspace?.dashboard?.store ? [workspace.dashboard.store] : [];
}

export function operationsAgentSchema() {
  return {
    version: 1,
    entityTypes: [
      { key: "all", label: "全部经营视图" },
      { key: "store", label: "店铺" },
      { key: "category", label: "品类" },
      { key: "product", label: "商品" },
      { key: "audience", label: "人群" },
    ],
    sourcePeriodKinds: ["auto", "all", "day", "week", "month", "custom"],
    metrics: METRICS.map((metric) => ({ ...metric })),
    rules: [
      "净 GSV 始终等于支付金额减成功退款金额。",
      "推广费率始终等于推广花费除以净 GSV，不使用推广成交金额作分母。",
      "经营投产等于净 GSV除以推广花费；平台投产等于推广成交金额除以推广花费。",
      "周期覆盖不完整或退款数据不完整时，推广费率和经营投产返回不可用。",
      "多对象汇总先合计分子与分母，再重新计算比率，绝不平均各行比率。",
    ],
  };
}

export function operationsAgentQueryPayload(workspace, query = {}) {
  const selection = selectEntities(workspace, query);
  const metricKeys = queryMetricKeys(query);
  const summaryEntities = defaultSummaryEntities(workspace, selection);
  const summaryType = selection.entityType === "all" ? "store" : selection.entityType;
  const summary = aggregateEntities(summaryEntities, summaryType);
  return {
    query: {
      periodKind: cleanText(workspace?.filters?.periodKind || query.periodKind || "all", 20),
      sourcePeriodKind: cleanText(workspace?.filters?.sourcePeriodKind || query.sourcePeriodKind || "all", 20),
      start: cleanText(workspace?.filters?.start || query.start, 10),
      end: cleanText(workspace?.filters?.end || query.end, 10),
      storeName: cleanText(workspace?.filters?.storeName || query.storeName, 80),
      entityType: selection.entityType,
      entityIds: selection.requestedIds,
      metrics: metricKeys,
    },
    freshness: workspace?.freshness || null,
    sourceCoverage: workspace?.dashboard?.sourceCoverage || null,
    sourceWarnings: workspace?.dashboard?.sourceWarnings || null,
    matched: {
      count: summaryEntities.length,
      missingEntityIds: selection.missingEntityIds,
    },
    summary: metricProjection(summary, metricKeys),
    entities: Object.fromEntries(Object.entries(selection.sections).map(([type, section]) => [type, {
      availableCount: section.availableCount,
      matchedCount: section.entities.length,
      items: section.entities.map((entity) => entityProjection(entity, type, metricKeys)),
    }])),
    reports: (workspace?.reports || []).map((report) => ({
      id: report.id,
      type: report.type,
      storeName: report.storeName,
      periodKind: report.periodKind,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      reportDate: report.reportDate,
      sourceName: report.sourceName,
      fileName: report.fileName,
      importedAt: report.importedAt,
    })),
  };
}

export function projectOperationsWorkspaceForAgent(workspace, query = {}) {
  const selection = selectEntities(workspace, query);
  if (selection.entityType === "all" && selection.requestedIds.length === 0) {
    return { ...workspace, agentQuery: operationsAgentQueryPayload(workspace, query).query };
  }
  const selected = selection.sections[selection.entityType]?.entities || [];
  const aggregate = aggregateEntities(selected, selection.entityType);
  const combinedTotals = {
    ...aggregate.sales,
    spend: aggregate.spend,
    feeRate: aggregate.feeRate,
    roi: aggregate.roi,
  };
  const selectedKeys = new Set(selected.flatMap((entity) => entityAliases(entity, selection.entityType)));
  const filteredSuggestions = selection.entityType === "product"
    ? (workspace.suggestions || []).filter((suggestion) => [suggestion.key, suggestion.productId, suggestion.productName, suggestion.name]
      .map(normalizedIdentity).some((value) => selectedKeys.has(value)))
    : selection.entityType === "store" ? workspace.suggestions || [] : [];
  return {
    ...workspace,
    totals: combinedTotals,
    storeOverview: {
      ...workspace.storeOverview,
      revenue: aggregate.sales,
      performance: { ...aggregate.promotion, feeRate: aggregate.feeRate },
      managementRoi: aggregate.managementRoi,
      salesDeduction: aggregate.salesDeduction,
    },
    products: selection.entityType === "product" ? selected : selection.entityType === "store" ? workspace.products : [],
    categories: selection.entityType === "category" ? selected : selection.entityType === "store" ? workspace.categories : [],
    audiences: selection.entityType === "audience" ? selected : selection.entityType === "store" ? workspace.audiences : [],
    suggestions: filteredSuggestions,
    dashboard: {
      ...workspace.dashboard,
      store: aggregate,
      stores: selection.entityType === "store" ? selected : [],
      products: selection.entityType === "product" ? selected : [],
      categories: selection.entityType === "category" ? selected : [],
    },
    agentQuery: operationsAgentQueryPayload(workspace, query).query,
  };
}

export const operationsAgentMetricKeys = Object.freeze(METRICS.map((metric) => metric.key));
export const operationsAgentEntityTypes = ENTITY_TYPES;
