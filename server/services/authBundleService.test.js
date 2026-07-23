import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_BUNDLE_FORMAT,
  createAuthBundle,
  normalizeAuthBundleCookies,
  openAuthBundle,
} from "./authBundleService.js";

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);
const cookies = [
  {
    name: "tracknick",
    value: "private-account-name",
    domain: ".taobao.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    priority: "High",
    expires: 2_100_000_000,
    partitionKey: { topLevelSite: "https://taobao.com", hasCrossSiteAncestor: false },
    size: 999,
  },
  {
    name: "_m_h5_tk",
    value: "private-tmall-token",
    domain: ".tmall.com",
    path: "/",
    secure: true,
  },
];

test("encrypted login bundle is JSON but contains no plaintext cookie or account identity", async () => {
  const document = await createAuthBundle({
    cookies,
    session: { id: "auth-private", name: "我的88VIP账号", accountType: "vip88", browserEngine: "uc" },
  }, { key });
  const serialized = JSON.stringify(document);
  assert.equal(document.format, AUTH_BUNDLE_FORMAT);
  assert.doesNotMatch(serialized, /private-account-name|private-tmall-token|我的88VIP账号|auth-private/);

  const opened = await openAuthBundle(serialized, { key });
  assert.equal(opened.name, "我的88VIP账号");
  assert.equal(opened.accountType, "vip88");
  assert.equal(opened.browserEngine, "uc");
  assert.equal(opened.cookies.length, 2);
  assert.equal(opened.cookies[0].value, "private-account-name");
  assert.equal("size" in opened.cookies[0], false);
});

test("login bundle rejects a different machine key and authenticated-data tampering", async () => {
  const document = await createAuthBundle({ cookies, session: {} }, { key });
  await assert.rejects(() => openAuthBundle(JSON.stringify(document), { key: otherKey }), (error) => error.code === "AUTH_BUNDLE_MACHINE_MISMATCH");

  const tampered = { ...document, ciphertext: `${document.ciphertext.startsWith("a") ? "b" : "a"}${document.ciphertext.slice(1)}` };
  await assert.rejects(() => openAuthBundle(JSON.stringify(tampered), { key }), (error) => error.code === "AUTH_BUNDLE_AUTH_FAILED");
});

test("login bundle keeps only structured Taobao and Tmall cookie fields", () => {
  const normalized = normalizeAuthBundleCookies([
    ...cookies,
    { name: "other", value: "must-not-export", domain: ".example.com", path: "/" },
    { name: "", value: "invalid", domain: ".taobao.com", path: "/" },
  ]);
  assert.deepEqual(normalized.map((cookie) => cookie.domain), [".taobao.com", ".tmall.com"]);
  assert.equal(JSON.stringify(normalized).includes("must-not-export"), false);
  assert.deepEqual(normalized[0].partitionKey, { topLevelSite: "https://taobao.com", hasCrossSiteAncestor: false });
  assert.deepEqual(Object.keys(normalized[0]).sort(), ["domain", "expires", "httpOnly", "name", "partitionKey", "path", "priority", "sameSite", "secure", "value"].sort());
  assert.equal(normalizeAuthBundleCookies([{ ...cookies[0], partitionKey: { topLevelSite: "https://example.com" } }])[0].partitionKey, undefined);
});

test("invalid or empty login bundle input is rejected", async () => {
  await assert.rejects(() => openAuthBundle("not-json", { key }), (error) => error.code === "AUTH_BUNDLE_INVALID_JSON");
  assert.throws(() => normalizeAuthBundleCookies([]), (error) => error.code === "AUTH_BUNDLE_EMPTY");
});
