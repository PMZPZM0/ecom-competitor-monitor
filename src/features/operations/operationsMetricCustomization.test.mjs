import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./OperationsAssistant.tsx", import.meta.url), "utf8");

test("category and product matrices replace the large cards with row comparisons", () => {
  assert.doesNotMatch(source, /<MetricCardGrid\s+panel="category"/);
  assert.doesNotMatch(source, /<MetricCardGrid\s+panel="product"/);
  assert.match(source, /function EntityComparisonBadge\(/);
  assert.match(source, /previousEntityIndex\(kind, previousItems\)/);
  for (const metricId of ["grossRevenue", "refundAmount", "revenue", "spend", "promotionRevenue", "roi", "feeRate"]) {
    assert.match(source, new RegExp(`comparisonBadge\\("${metricId}"\\)`));
  }
});

test("category and product matrix comparison visibility is independent and persistent", () => {
  assert.match(source, /operations-comparison-visibility-v1/);
  assert.match(source, /function loadComparisonVisibility\(panel: CustomCardPanel\)/);
  assert.match(source, /function saveComparisonVisibility\(panel: CustomCardPanel, visible: boolean\)/);
  assert.match(source, /\{ \.\.\.parsed, \[panel\]: visible \}/);
  assert.match(source, /checked=\{showComparisons\}/);
  assert.match(source, /saveComparisonVisibility\(kind, showComparisons\)/);
});

test("all normalized paid metrics can be selected as up to eight matrix columns", () => {
  for (const metricId of ["spend", "promotionRevenue", "roi", "feeRate", "clicks", "impressions", "orders", "cpc", "costPerCollectCart"]) {
    assert.match(source, new RegExp(`id: "${metricId}"`));
  }
  assert.match(source, /operations-matrix-metrics-v1/);
  assert.match(source, /MATRIX_CUSTOM_METRIC_LIMIT = 8/);
  assert.match(source, /CUSTOM_METRICS\.filter\(\(metric\) => !MATRIX_FIXED_METRIC_IDS\.has\(metric\.id\)\)/);
  assert.match(source, /toggleMatrixMetric\(metric\.id\)/);
  assert.match(source, /matrixMetricIds\.map\(\(metricId\) =>/);
  assert.match(source, /draggable/);
  assert.match(source, /reorderMatrixMetric\(sourceId, metric\.id\)/);
  assert.match(source, /moveMatrixMetric\(metric\.id, -1\)/);
  assert.match(source, /moveMatrixMetric\(metric\.id, 1\)/);
  assert.match(source, /已选列顺序/);
});
