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
  tmallAccessRestrictionOpen,
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

test("a Tmall price gate opens only the affected account circuit", () => {
  const account = session();
  const result = markTmallPriceGate(account, { now: 1_000, accountCooldownMs: 10_000, deviceCooldownMs: 5_000 });
  const other = { ...session(), id: "session-2", browserProfileKey: "profile-2", browserPort: 9518 };
  assert.equal(account.tmallPriceStatus, "cooldown");
  assert.equal(account.tmallPriceDeviceCooldownUntil, null);
  assert.equal(tmallPriceCircuitOpen(account, 5_999), true);
  assert.equal(tmallPriceCooldownRemaining(account, 5_999), 5_001);
  assert.equal(tmallPriceCircuitOpen(other, 5_999), false);
  assert.equal(tmallAccessRestrictionOpen(account, 5_999), false);
  assert.equal(tmallPriceCooldownRemaining(account, 11_001), 0);
  assert.equal(tmallPriceCircuitOpen(account, 11_001), false);
  assert.equal(result.remainingMs, 10_000);
  const error = createTmallPriceCooldownError(account, 2_000);
  assert.equal(error.code, "TMALL_PRICE_COOLDOWN");
  assert.equal(isTmallPriceCooldownError(error), true);
  assert.equal(isTmallPriceGateError({ code: "TMALL_PRICE_AUTH_REQUIRED" }), true);
  assert.equal(isTmallPriceGateError({ code: "TAOBAO_ACCESS_RESTRICTED" }), true);
});

test("an access restriction keeps every local account blocked for the platform recovery window", () => {
  const account = session();
  markTmallPriceGate(account, {
    now: 1_000,
    accountCooldownMs: 60_000,
    deviceCooldownMs: 60_000,
    reason: "TAOBAO_ACCESS_RESTRICTED",
  });
  const other = { ...session(), id: "session-2", browserProfileKey: "profile-2", browserPort: 9518 };
  assert.equal(account.tmallPriceFailureReason, "TAOBAO_ACCESS_RESTRICTED");
  assert.equal(tmallPriceCircuitOpen(other, 60_999), true);
  assert.equal(tmallAccessRestrictionOpen(other, 60_999), true);
  assert.match(createTmallPriceCooldownError(account, 2_000).message, /淘宝访问限制保护中/);
});

test("a verified response clears a normal account-only gate", () => {
  const account = session();
  markTmallPriceGate(account, { now: 1_000, accountCooldownMs: 10_000, deviceCooldownMs: 10_000 });
  markTmallPriceSuccess(account, 2_000);
  assert.equal(account.tmallPriceStatus, "valid");
  assert.equal(account.tmallPriceCooldownUntil, null);
  assert.equal(tmallPriceCircuitOpen(account, 2_001), false);
  assert.equal(account.tmallPriceFailureCount, 0);
});

test("a success from another account cannot clear an access-restriction circuit", () => {
  const restricted = session();
  const inFlightSuccess = { ...session(), id: "session-2", browserProfileKey: "profile-2", browserPort: 9518 };
  markTmallPriceGate(restricted, {
    now: 1_000,
    accountCooldownMs: 60_000,
    deviceCooldownMs: 60_000,
    reason: "TAOBAO_ACCESS_RESTRICTED",
  });
  markTmallPriceSuccess(inFlightSuccess, 2_000);
  assert.equal(tmallPriceCircuitOpen(inFlightSuccess, 2_001), true);
  assert.match(createTmallPriceCooldownError(inFlightSuccess, 2_001).message, /淘宝访问限制保护中/);
});

test("persisted cooldown is restored after a service restart", () => {
  const account = session();
  account.tmallPriceStatus = "cooldown";
  account.tmallPriceFailureReason = "TAOBAO_ACCESS_RESTRICTED";
  account.tmallPriceDeviceCooldownUntil = new Date(20_000).toISOString();
  hydrateTmallPriceCircuits([account], 1_000);
  assert.equal(tmallPriceCircuitOpen(account, 19_999), true);
  assert.equal(tmallPriceCircuitOpen(account, 20_001), false);
});

test("legacy device cooldown from a normal auth gate does not block other accounts", () => {
  const account = session();
  account.tmallPriceStatus = "cooldown";
  account.tmallPriceFailureReason = "TMALL_PRICE_AUTH_REQUIRED";
  account.tmallPriceDeviceCooldownUntil = new Date(20_000).toISOString();
  const other = { ...session(), id: "session-2", browserProfileKey: "profile-2", browserPort: 9518 };
  hydrateTmallPriceCircuits([account], 1_000);
  assert.equal(tmallPriceCircuitOpen(other, 2_000), false);
});
