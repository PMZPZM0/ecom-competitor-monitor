import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedLocalHost, isAllowedLocalOrigin, isAllowedLocalRequest, localCorsOptions } from "./localOrigin.js";

test("allows requests without an Origin header and local HTTP origins", () => {
  assert.equal(isAllowedLocalOrigin(undefined), true);
  assert.equal(isAllowedLocalOrigin(null), true);
  assert.equal(isAllowedLocalOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedLocalOrigin("https://127.0.0.1:4317"), true);
  assert.equal(isAllowedLocalOrigin("http://[::1]:4317"), true);
});

test("rejects external, credentialed, and malformed origins", () => {
  assert.equal(isAllowedLocalOrigin("https://example.com"), false);
  assert.equal(isAllowedLocalOrigin("https://localhost.example.com"), false);
  assert.equal(isAllowedLocalOrigin("http://user:secret@localhost:4317"), false);
  assert.equal(isAllowedLocalOrigin("http://localhost:4317/path"), false);
  assert.equal(isAllowedLocalOrigin("file://localhost"), false);
  assert.equal(isAllowedLocalOrigin("not a URL"), false);
  assert.equal(isAllowedLocalOrigin(""), false);
});

test("rejects non-local hosts and cross-site browser requests before routing", () => {
  assert.equal(isAllowedLocalHost("127.0.0.1:4317"), true);
  assert.equal(isAllowedLocalHost("localhost:4317"), true);
  assert.equal(isAllowedLocalHost("attacker.example:4317"), false);
  assert.equal(isAllowedLocalRequest({ host: "127.0.0.1:4317" }), true);
  assert.equal(isAllowedLocalRequest({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:5173", secFetchSite: "same-site" }), true);
  assert.equal(isAllowedLocalRequest({ host: "127.0.0.1:4317", origin: "https://attacker.example", secFetchSite: "cross-site" }), false);
  assert.equal(isAllowedLocalRequest({ host: "attacker.example:4317", origin: "http://127.0.0.1:5173", secFetchSite: "same-site" }), false);
  assert.equal(isAllowedLocalRequest({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:5173", secFetchSite: "cross-site" }), false);
});

test("localCorsOptions delegates the origin decision to the helper", () => {
  let allowed;
  localCorsOptions.origin("http://localhost:5173", (error, value) => {
    assert.equal(error, null);
    allowed = value;
  });
  assert.equal(allowed, true);

  let rejected;
  localCorsOptions.origin("https://example.com", (error, value) => {
    assert.equal(error, null);
    rejected = value;
  });
  assert.equal(rejected, false);
});
