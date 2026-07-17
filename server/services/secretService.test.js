import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from "./secretService.js";

const env = { MODEL_CONFIG_ENCRYPTION_KEY: "test-only-model-key" };

test("model secrets are authenticated, randomized, and never stored as plaintext", () => {
  const first = encryptSecret("sk-secret-value-1234", { env });
  const second = encryptSecret("sk-secret-value-1234", { env });
  assert.notEqual(first, second);
  assert.equal(first.includes("sk-secret-value-1234"), false);
  assert.equal(isEncryptedSecret(first), true);
  assert.equal(decryptSecret(first, { env }), "sk-secret-value-1234");
});

test("tampered or differently keyed ciphertext does not decrypt", () => {
  const encrypted = encryptSecret("sk-sensitive", { env });
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("a") ? "b" : "a"}`;
  assert.equal(decryptSecret(tampered, { env }), "");
  assert.equal(decryptSecret(encrypted, { env: { MODEL_CONFIG_ENCRYPTION_KEY: "wrong-key" } }), "");
  assert.equal(decryptSecret("plain text", { env }), "");
});

test("secret masks never expose the complete value", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("short"), "sh***");
  assert.equal(maskSecret("sk-example-secret-1234"), "sk-exa...1234");
});
