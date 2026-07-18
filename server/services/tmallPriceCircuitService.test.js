import assert from "node:assert/strict";
import test from "node:test";
import {
  createTmallPriceCooldownError,
  hydrateTmallPriceCircuits,
  isTmallPriceCooldownError,
  isTmallPriceGateError,
  markTmallPriceGate,
  markTmallPriceSuccess,
  markTmallPriceUnknown,
  resetTmallPriceCircuitForTests,
  tmallPriceCircuitOpen,
  tmallPriceCooldownRemaining,
  TMALL_PRICE_STATUS,
} from "./tmallPriceCircuitService.js";

const session = () => ({
  id: "session-1",
  browserProfileKey: "profile-1",
  browserPort: 9517,
  tmallPriceStatus: TMALL_PRICE_STATUS.UNKNOWN,
});

test.afterEach(() => resetTmallPriceCircuitForTests());

test("login sync starts with an unknown Tmall price capability", () => {
  const account = session();
  markTmallPriceUnknown(account, 1_000);
  assert.equal(account.tmallPriceStatus, "unknown");
  assert.equal(account.tmallPriceCooldownUntil, null);
  assert.equal(tmallPriceCircuitOpen(account, 1_001), false);
});

test("a Tmall price gate opens account and local-device circuits", () => {
  const account = session();
  const result = markTmallPriceGate(account, { now: 1_000, accountCooldownMs: 10_000, deviceCooldownMs: 5_000 });
  assert.equal(account.tmallPriceStatus, "cooldown");
  assert.equal(tmallPriceCircuitOpen(account, 5_999), true);
  assert.equal(tmallPriceCooldownRemaining(account, 5_999), 5_001);
  assert.equal(tmallPriceCooldownRemaining(account, 11_001), 0);
  assert.equal(tmallPriceCircuitOpen(account, 11_001), false);
  assert.equal(result.remainingMs, 10_000);
  const error = createTmallPriceCooldownError(account, 2_000);
  assert.equal(error.code, "TMALL_PRICE_COOLDOWN");
  assert.equal(isTmallPriceCooldownError(error), true);
  assert.equal(isTmallPriceGateError({ code: "TMALL_PRICE_AUTH_REQUIRED" }), true);
});

test("different account profiles share the short local-device cooldown", () => {
  const first = session();
  const second = { ...session(), id: "session-2", browserProfileKey: "profile-2", browserPort: 9518 };
  markTmallPriceGate(first, { now: 1_000, accountCooldownMs: 10_000, deviceCooldownMs: 5_000 });
  assert.equal(tmallPriceCircuitOpen(second, 5_999), true);
  assert.equal(tmallPriceCooldownRemaining(second, 5_999), 1);
  assert.equal(tmallPriceCircuitOpen(second, 6_001), false);
  assert.equal(tmallPriceCircuitOpen(first, 6_001), true);
});

test("a verified price response is the only success transition and clears the circuit", () => {
  const account = session();
  markTmallPriceGate(account, { now: 1_000, accountCooldownMs: 10_000, deviceCooldownMs: 10_000 });
  markTmallPriceSuccess(account, 2_000);
  assert.equal(account.tmallPriceStatus, "valid");
  assert.equal(account.tmallPriceCooldownUntil, null);
  assert.equal(tmallPriceCircuitOpen(account, 2_001), false);
  assert.equal(account.tmallPriceFailureCount, 0);
});

test("persisted cooldown is restored after a service restart", () => {
  const account = session();
  account.tmallPriceStatus = "cooldown";
  account.tmallPriceDeviceCooldownUntil = new Date(20_000).toISOString();
  hydrateTmallPriceCircuits([account], 1_000);
  assert.equal(tmallPriceCircuitOpen(account, 19_999), true);
  assert.equal(tmallPriceCircuitOpen(account, 20_001), false);
});
