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

test("all local fee-rate surfaces share the qualified, warning, and high thresholds", () => {
  assert.match(source, /FEE_RATE_QUALIFIED_MAX = 0\.095/);
  assert.match(source, /FEE_RATE_WARNING_MAX = 0\.11/);
  assert.match(source, /Number\(value\) <= FEE_RATE_QUALIFIED_MAX/);
  assert.match(source, /Number\(value\) <= FEE_RATE_WARNING_MAX/);
  assert.match(source, /function FeeRateValue\(/);
  assert.match(source, /feeRateMetricTone\(store\.feeRate\)/);
  assert.match(source, /colorForValue=\{\(value\) => feeRateChartColor\(value \/ 100\)\}/);
  for (const expression of [
    "totals.feeRate",
    "item.feeRate",
    "selectionSummary.feeRate",
    "type.feeRate",
    "plan.feeRate",
  ]) {
    assert.match(source, new RegExp(`FeeRateValue value=\\{${expression.replace(".", "\\.")}\\}`));
  }
  assert.doesNotMatch(source, /value <= 0\.08/);
  assert.doesNotMatch(source, /value <= 0\.12/);
});

test("local matrix controls sit above the table and close native filters on outside clicks", () => {
  const headerIndex = source.indexOf('<CardHeader className="border-b border-slate-200">', source.indexOf("function EntityTable("));
  const toolsIndex = source.indexOf('ref={matrixToolsRef}', headerIndex);
  const tableIndex = source.indexOf('className="max-h-[530px] overflow-auto"', toolsIndex);
  assert.ok(headerIndex >= 0 && toolsIndex > headerIndex && tableIndex > toolsIndex);
  assert.match(source, /const matrixToolsRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(source, /querySelectorAll<HTMLDetailsElement>\("details\[open\]"\)/);
  assert.match(source, /document\.removeEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(source, />\s*清除筛选\s*<\/button>/);
});
