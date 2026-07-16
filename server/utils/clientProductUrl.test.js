import assert from "node:assert/strict";
import test from "node:test";
import { itemIdFromProductInput, normalizeProductUrl, productUrlForItemId } from "../../src/lib/productUrl.ts";

test("client product input accepts exact IDs and builds platform URLs", () => {
  assert.equal(itemIdFromProductInput("1059717807069"), "1059717807069");
  assert.equal(productUrlForItemId("1059717807069", "tmall"), "https://detail.tmall.com/item.htm?id=1059717807069");
  assert.equal(productUrlForItemId("1064816137335", "taobao"), "https://item.taobao.com/item.htm?id=1064816137335");
});

test("client product input rejects malformed IDs instead of truncating them", () => {
  assert.equal(itemIdFromProductInput("12345"), "");
  assert.equal(itemIdFromProductInput("123456789012345678901"), "");
  assert.equal(itemIdFromProductInput("https://detail.tmall.com/item.htm?id=123456789012345678901"), "");
  assert.equal(itemIdFromProductInput("1059717807069abc"), "");
});

test("client product links are normalized and stripped of tracking parameters", () => {
  assert.equal(
    normalizeProductUrl("https://detail.tmall.com/item.htm?abbucket=7&id=1062991546966&spm=x"),
    "https://detail.tmall.com/item.htm?id=1062991546966",
  );
  assert.throws(() => normalizeProductUrl("https://example.com/item.htm?id=1062991546966"), /淘宝或天猫/);
});
