import type { OperationsBusinessEntity } from "../../types/domain";

type CategoryContributionMetric = Pick<
  OperationsBusinessEntity,
  "revenue" | "spend" | "feeRate"
>;

export function categoryContributionTotals(
  categories: CategoryContributionMetric[],
) {
  const revenue = categories.reduce((sum, item) => sum + item.revenue, 0);
  const spend = categories.reduce((sum, item) => sum + item.spend, 0);
  const feeRateCategories = categories.filter(
    (item) =>
      item.feeRate !== null &&
      Number.isFinite(item.feeRate) &&
      item.revenue > 0,
  );
  const feeRateRevenue = feeRateCategories.reduce(
    (sum, item) => sum + item.revenue,
    0,
  );
  const feeRateSpend = feeRateCategories.reduce(
    (sum, item) => sum + item.spend,
    0,
  );

  return {
    revenue,
    spend,
    feeRate:
      feeRateCategories.length > 0 && feeRateRevenue > 0
        ? feeRateSpend / feeRateRevenue
        : null,
    feeRateCategoryCount: feeRateCategories.length,
  };
}
