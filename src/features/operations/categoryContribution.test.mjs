import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let vite;
let contribution;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  contribution = await vite.ssrLoadModule(
    "/src/features/operations/categoryContribution.ts",
  );
});

after(async () => {
  await vite?.close();
});

test("category fee rate aggregates only categories with a complete rate basis", () => {
  const totals = contribution.categoryContributionTotals([
    { revenue: 10_000, spend: 900, feeRate: 0.09 },
    { revenue: 5_000, spend: 500, feeRate: 0.1 },
    { revenue: 8_000, spend: 700, feeRate: null },
  ]);

  assert.equal(totals.revenue, 23_000);
  assert.equal(totals.spend, 2_100);
  assert.equal(totals.feeRateCategoryCount, 2);
  assert.equal(totals.feeRate, 1_400 / 15_000);
});

test("category fee rate stays unavailable when no category has a complete basis", () => {
  const totals = contribution.categoryContributionTotals([
    { revenue: 10_000, spend: 900, feeRate: null },
  ]);

  assert.equal(totals.feeRate, null);
  assert.equal(totals.feeRateCategoryCount, 0);
});
