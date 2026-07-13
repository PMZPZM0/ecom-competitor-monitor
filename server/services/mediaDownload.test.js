import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { addBuyerShowsToZip, fetchRemoteMedia, validBuyerShows } from "../index.js";

test("failed buyer-show captures use the last successful cache", () => {
  const cached = [{ id: "cached", text: "真实历史评价", images: [], videoUrls: [] }];
  assert.deepEqual(validBuyerShows({
    buyerShowCapture: { status: "failed" },
    buyerShows: [],
    buyerShowCachedItems: cached,
  }), cached);
});

test("buyer-show ZIP keeps text-only reviews without pretending media downloaded", async () => {
  const zip = new JSZip();
  const result = await addBuyerShowsToZip(zip, {
    buyerShows: [{ id: "review-1", text: "真实文案", images: [], videoUrls: [] }],
  });
  assert.deepEqual(result, { count: 1, requested: 0, downloaded: 0, failures: [] });
  assert.ok(zip.file("买家秀/001/文案.txt"));
});

test("remote media refuses redirects outside approved Taobao CDN hosts", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      status: 302,
      ok: false,
      url: "https://img.alicdn.com/source.jpg",
      headers: new Headers({ location: "https://example.com/private.jpg" }),
    };
  };
  try {
    assert.equal(await fetchRemoteMedia("https://img.alicdn.com/source.jpg"), false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote media accepts a supported response from an approved host", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    url: "https://img.alicdn.com/source.jpg",
    headers: new Headers({ "content-type": "image/jpeg", "content-length": "3" }),
    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
  });
  try {
    const media = await fetchRemoteMedia("https://img.alicdn.com/source.jpg");
    assert.equal(media.contentType, "image/jpeg");
    assert.deepEqual([...media.data], [1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
