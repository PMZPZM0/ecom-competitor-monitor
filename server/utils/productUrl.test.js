import test from "node:test";
import assert from "node:assert/strict";
import { assertMatchingProductId, normalizeProductUrl } from "./productUrl.js";

test("normalizeProductUrl keeps only the useful Tmall item id", () => {
  assert.equal(
    normalizeProductUrl("https://detail.tmall.com/item.htm?id=1033688812571&spm=a21n57.1.0.0&skuId=123#detail"),
    "https://detail.tmall.com/item.htm?id=1033688812571",
  );
});

test("normalizeProductUrl canonicalizes mobile Taobao links", () => {
  assert.equal(
    normalizeProductUrl("https://item.m.taobao.com/item.htm?itemId=123456789012&share_crt_v=1"),
    "https://item.taobao.com/item.htm?id=123456789012",
  );
});

test("assertMatchingProductId rejects cross-product redirects", () => {
  assert.equal(assertMatchingProductId("https://detail.tmall.com/item.htm?id=1006331369273", "1006331369273"), "1006331369273");
  assert.throws(
    () => assertMatchingProductId("https://detail.tmall.com/item.htm?id=1006331369273", "548635113360", "https://detail.tmall.com/item.htm?id=548635113360"),
    /避免串品/,
  );
});
