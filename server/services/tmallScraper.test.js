import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { applyAppliedCoinDiscount, applyMediaCapturePreference, applyNetworkPromoData, applyVisibleDiscountItems, applyVisibleSurprisePrice, buildBrowserCaptureEvidence, buyerShowCaptureFromNetwork, buyerShowsFromRateDetail, calculateAccountPriceScenario, calculatePriceScenarios, collectDiscountItems, collectDiscountItemsFromText, collectProductProgramItems, collectVisibleSurprisePrices, extractBuyerShowItems, extractEmbeddedPromotionComponent, extractSearchMainImage, extractSelectedSkuId, extractShopName, extractStructuredSku, filterProductVideoUrls, hasCurrentSkuPriceData, hasTmallPriceLoginGate, hydrateBrowserCapturePage, isUnselectablePromotionSku, resolveCaptureAccessMode, resolveCoinBenefit, resolveLocalSkuPriceRows, resolveSkuPrices, scrapeTmallBuyerShows, scrapeTmallMaterials, scrapeTmallProduct, searchMainImageQueries, selectGalleryImages, selectSquareMainImage, sellerIdFromProductMedia, shouldRequireTmallPriceAuthorization } from "./tmallScraper.js";
import { resolveEmbeddedSkuPriceEvidence } from "./priceResolver.js";

test("Tmall scraper has no Node-side price fetch escape hatch", async () => {
  const source = await fs.readFile(new URL("./tmallScraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "淘宝/天猫价格只能由账号浏览器采集、脱敏落盘并重读后解析");
});

test("search main image requires an exact item card and never falls back to another product image", () => {
  const expectedItemId = "1062991546966";
  const exactImage = "https://g-search1.alicdn.com/img/bao/uploaded/i2/exact-search-cover.jpg";
  const html = `<main>
    <article><a href="https://item.taobao.com/item.htm?id=999999999999"><img src="https://img.alicdn.com/bao/uploaded/i2/wrong-cover.jpg"></a></article>
    <article><a href="https://detail.tmall.com/item.htm?id=${expectedItemId}"><img data-src="${exactImage}_400x400.jpg_.webp"></a></article>
  </main>`;
  assert.deepEqual(extractSearchMainImage(html, expectedItemId), { image: exactImage, matched: true, reason: "" });

  const missing = extractSearchMainImage(`<a href="https://detail.tmall.com/item.htm?id=${expectedItemId}">目标商品</a><img src="https://img.alicdn.com/bao/uploaded/i2/unrelated-detail.jpg">`, expectedItemId);
  assert.equal(missing.image, "");
  assert.equal(missing.matched, true);
  assert.equal(missing.reason, "SEARCH_CARD_IMAGE_NOT_FOUND");
});

test("search main image queries use the recognized model and title instead of an ineffective item-id search", () => {
  assert.deepEqual(searchMainImageQueries({ model: "ZN30FC866", name: "苏泊尔电蒸锅家用多功能蒸汽锅" }, "837915049470"), ["ZN30FC866", "苏泊尔电蒸锅家用多功能蒸汽锅"]);
  assert.deepEqual(searchMainImageQueries({ name: "待识别商品 837915049470" }, "837915049470"), ["837915049470"]);
});

test("extractEmbeddedPromotionComponent skips an invalid leading candidate", () => {
  const expected = {
    trackParams: { itemId: "613114976305", skuId: "6012220507404", price1: "589", price2: "243" },
    xsRedPocketParams: { tbShopRedPocket: "{\"umpInfo\":{\"umpPromotionList\":[]}}" },
  };
  const html = `<script>window.__PLACEHOLDER__={"xsRedPacketParamVO":{}};</script>
    <script>window.__DATA__={"xsRedPacketParamVO":${JSON.stringify(expected)}};</script>`;

  assert.deepEqual(extractEmbeddedPromotionComponent(html), expected);
});

test("browser captures require a verified account identity before prices are trusted", () => {
  const browserSession = { source: "taobao-browser", cookie: "configured" };
  assert.equal(resolveCaptureAccessMode(browserSession, { authState: { loggedIn: true }, cookieHeader: "sid=value" }), "authenticated");
  assert.equal(resolveCaptureAccessMode(browserSession, { authState: { loggedIn: true }, cookieHeader: "" }), "authenticated");
  assert.equal(resolveCaptureAccessMode(browserSession, { accessVerified: true }), "authenticated");
  assert.equal(resolveCaptureAccessMode(browserSession, { authState: { loggedIn: false }, cookieHeader: "sid=value" }), "anonymous");
  assert.equal(resolveCaptureAccessMode({ source: "manual-cookie", cookie: "sid=value" }), "anonymous");
  assert.equal(resolveCaptureAccessMode(null), "anonymous");
});

test("legacy local evidence restores each self-identifying SKU response without a sequence window", () => {
  const itemId = "668945261101";
  const skuIds = ["6206877831711", "6088816047261"];
  const payload = (skuId) => ({
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    responseKind: "price",
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId, skuId, price1: "705", price2: "300" } } } } }),
  });
  const page = hydrateBrowserCapturePage({
    captureType: "account-browser-local-source",
    itemId,
    page: {
      networkPayloads: [payload(skuIds[0]), payload(skuIds[1]), {
        ...payload(skuIds[1]),
        body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId: "999999999999", skuId: skuIds[1], price1: "999", price2: "1" } } } } }),
      }],
      selectionResults: skuIds.map((skuId) => ({ skuId, selected: true })),
    },
  });
  assert.deepEqual(Object.keys(page.skuNetworkPayloads).sort(), [...skuIds].sort());
  assert.deepEqual(page.selectionResults.map(({ skuId, responseObserved }) => [skuId, responseObserved]), skuIds.map((skuId) => [skuId, true]));
  assert.equal(page.skuNetworkPayloads[skuIds[0]].length, 1);
  assert.equal(page.skuNetworkPayloads[skuIds[1]].length, 1);
});

test("local evidence binds identity-free pcdetail responses only through an exact SKU selection window", () => {
  const itemId = "843315272519";
  const selectedSkuId = "6198474471056";
  const otherSkuId = "6198474471057";
  const captureRunId = "selection-run-windowed";
  const payload = (body, responseSequence) => ({
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    responseKind: "price",
    captureRunId,
    responseSequence,
    body: JSON.stringify(body),
  });
  const identityFree = payload({
    data: {
      skuCore: { sku2info: { [selectedSkuId]: {}, [otherSkuId]: {} } },
      componentsVO: { priceVO: { price: { priceText: "689", priceTitle: "超级立减活动价" } } },
    },
  }, 1);
  const explicitOtherSku = payload({
    data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId, skuId: otherSkuId, price1: "609", price2: "409" } } } },
  }, 2);
  const page = hydrateBrowserCapturePage({
    captureType: "account-browser-local-source",
    schemaVersion: 2,
    itemId,
    page: {
      networkPayloads: [identityFree, explicitOtherSku],
      selectionResults: [{
        skuId: selectedSkuId,
        selected: true,
        responseReceivedAfterSelection: true,
        captureRunId,
        responseSequenceStartExclusive: 0,
        responseSequenceEndInclusive: 2,
      }],
    },
  });

  assert.equal(page.selectionResults[0].responseObserved, true);
  assert.equal(page.skuNetworkPayloads[selectedSkuId].length, 1);
  assert.equal(page.skuNetworkPayloads[selectedSkuId][0].body, identityFree.body);
});

test("local evidence reparses a same-run preheated current SKU response after its repeated selection emits no response", () => {
  const itemId = "843315272519";
  const skuId = "6198474471056";
  const captureRunId = "preheat-current-sku-run";
  const finalUrl = `https://detail.tmall.com/item.htm?id=${itemId}&skuId=${skuId}`;
  const html = JSON.stringify({
    skuBase: { props: [], skus: [{ skuId, propPath: "" }] },
    skuCore: { sku2info: { [skuId]: { price: { priceTitle: "优惠前", priceText: "139" }, subPrice: { priceTitle: "到手价", priceText: "139" } } } },
  });
  const preheatedResponse = {
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    responseKind: "price",
    captureRunId,
    responseSequence: 1,
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: {
      trackParams: { itemId, skuId, price1: "139", price2: "139" },
      xsRedPocketParams: { tbShopRedPocket: { umpInfo: { umpPromotionList: [] } } },
    } } } }),
  };
  const page = hydrateBrowserCapturePage({
    captureType: "account-browser-local-source",
    schemaVersion: 2,
    itemId,
    page: {
      html,
      networkPayloads: [preheatedResponse],
      selectionResults: [{
        skuId,
        selected: true,
        responseReceivedAfterSelection: false,
        captureRunId,
        responseSequenceStartExclusive: 1,
        responseSequenceEndInclusive: 1,
      }],
      skuSnapshots: [{
        skuId,
        selected: true,
        finalUrl,
        html,
        responseSequenceStartExclusive: 1,
        responseSequenceEndInclusive: 1,
      }],
    },
  });

  assert.equal(page.selectionResults[0].responseObserved, false);
  assert.equal(page.selectionResults[0].recoveredInitialSkuPayloadCount, 1);
  assert.deepEqual(page.skuNetworkPayloads[skuId].map((payload) => payload.responseSequence), [1]);
  const { resolutions } = resolveLocalSkuPriceRows(page, { itemId, accountType: "normal" });
  assert.equal(resolutions.get(skuId).channels.normal.status, "verified");
  assert.equal(resolutions.get(skuId).channels.normal.valueCents, 13900);
});

test("preheated SKU recovery rejects a different run, response identity, or local snapshot identity", () => {
  const itemId = "843315272519";
  const skuId = "6198474471056";
  const captureRunId = "preheat-current-sku-run";
  const html = JSON.stringify({ skuBase: { props: [], skus: [{ skuId, propPath: "" }] }, skuCore: { sku2info: { [skuId]: {} } } });
  const response = ({ responseItemId = itemId, responseSkuId = skuId, payloadRunId = captureRunId, responseSequence = 1 } = {}) => ({
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    responseKind: "price",
    captureRunId: payloadRunId,
    responseSequence,
    body: JSON.stringify({ data: { componentsVO: { xsRedPacketParamVO: { trackParams: { itemId: responseItemId, skuId: responseSkuId, price1: "139", price2: "139" } } } } }),
  });
  const selection = {
    skuId,
    selected: true,
    responseReceivedAfterSelection: false,
    captureRunId,
    responseSequenceStartExclusive: 3,
    responseSequenceEndInclusive: 3,
  };
  const page = hydrateBrowserCapturePage({
    captureType: "account-browser-local-source",
    schemaVersion: 2,
    itemId,
    page: {
      html,
      networkPayloads: [
        response({ payloadRunId: "another-capture-run" }),
        response({ responseItemId: "999999999999" }),
        response({ responseSkuId: "6198474471057" }),
      ],
      selectionResults: [selection],
      skuSnapshots: [{
        skuId,
        selected: true,
        finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}&skuId=${skuId}`,
        html,
        responseSequenceStartExclusive: 3,
        responseSequenceEndInclusive: 3,
      }],
    },
  });
  assert.deepEqual(page.skuNetworkPayloads[skuId], []);
  assert.equal(page.selectionResults[0].recoveredInitialSkuPayloadCount, undefined);

  const wrongSnapshot = hydrateBrowserCapturePage({
    captureType: "account-browser-local-source",
    schemaVersion: 2,
    itemId,
    page: {
      html,
      networkPayloads: [response()],
      selectionResults: [selection],
      skuSnapshots: [{
        skuId,
        selected: true,
        finalUrl: "https://detail.tmall.com/item.htm?id=999999999999",
        html,
        responseSequenceStartExclusive: 3,
        responseSequenceEndInclusive: 3,
      }],
    },
  });
  assert.deepEqual(wrongSnapshot.skuNetworkPayloads[skuId], []);
});

test("browser page readiness rejects a list-only shell until the current price arrives", () => {
  assert.equal(hasCurrentSkuPriceData('<script>skuCore={skuBase:{},sku2info:{"1":{"price":{"priceText":"689"}}}}</script>'), false);
  assert.equal(hasCurrentSkuPriceData('<script>skuCore={sku2info:{"1":{"subPrice":{"priceText":"388"}}}}</script>'), true);
  assert.equal(hasCurrentSkuPriceData('<script>skuBase={}; priceText="388"; subPrice={}</script>'), true);
  assert.equal(hasCurrentSkuPriceData('<script>skuCore={sku2info:{"1":{"price":{"priceTitle":"优惠前","priceText":"609"}}}}</script>'), false);
});

test("price access gate recognizes the real Tmall login prompt only on price responses", () => {
  const gatedBody = JSON.stringify({ data: { priceActionText: "登录查看更多优惠", priceActionType: "buy_in_mobile" } });
  assert.equal(hasTmallPriceLoginGate([{ url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/", body: gatedBody }]), true);
  assert.equal(hasTmallPriceLoginGate([{ url: "https://h5api.m.tmall.com/h5/mtop.taobao.detail.getdetail/6.0/", body: gatedBody }]), false);
  assert.equal(hasTmallPriceLoginGate([{ url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/", body: '{"data":{"price":"139"}}' }]), false);
  assert.equal(hasTmallPriceLoginGate([], "登录查看更多优惠"), true);
});

test("price login copy cannot promote embedded platform-top-up output to normal price", () => {
  const observed = [
    ["6206877831711", 705, 378.16],
    ["6088816047261", 705, 334.90],
    ["6200494863132", 779, 478.46],
    ["6036847382373", 669, 339.06],
    ["6096276240242", 709, 364.65],
  ];
  const html = JSON.stringify({
    skuBase: { props: [], skus: observed.map(([skuId]) => ({ skuId, propPath: "" })) },
    skuCore: { sku2info: Object.fromEntries(observed.map(([skuId, list, current]) => [skuId, {
      price: { priceTitle: "优惠前", priceText: String(list) },
      subPrice: { priceTitle: "平台加补后", priceText: String(current) },
    }])) },
  });
  const skuPrices = extractStructuredSku(html).skuPrices;
  const resolutions = skuPrices.map((sku) => resolveEmbeddedSkuPriceEvidence(sku, {
    itemId: "668945261101",
    skuId: sku.skuId,
    accountType: "normal",
    capturedAt: "2026-07-20T06:59:15.842Z",
  }));
  const gatedPayloads = [{
    url: "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/",
    body: JSON.stringify({ data: { componentsVO: { priceVO: { price: { priceActionText: "登录查看更多优惠" } } } } }),
  }];

  assert.deepEqual(skuPrices.map((sku) => sku.normalPrice), observed.map(([, , price]) => price));
  assert.equal(resolutions.every((resolution) => resolution.status === "unavailable"), true);
  assert.equal(shouldRequireTmallPriceAuthorization(gatedPayloads, resolutions), true);
  assert.equal(shouldRequireTmallPriceAuthorization(gatedPayloads, []), true);
  assert.equal(shouldRequireTmallPriceAuthorization([], [], "登录查看更多优惠"), true);
});

test("shared scrapers reject every non-browser source before network access", async () => {
  await assert.rejects(
    scrapeTmallProduct({ url: "https://detail.tmall.com/item.htm?id=843315272599" }, { source: "manual-cookie" }),
    /已阻止后端直接请求淘宝接口/,
  );
  await assert.rejects(
    scrapeTmallBuyerShows({ url: "https://detail.tmall.com/item.htm?id=843315272599" }, null),
    /已阻止后端直接请求淘宝接口/,
  );
  await assert.rejects(
    scrapeTmallMaterials({ url: "https://detail.tmall.com/item.htm?id=843315272599" }, { source: "manual-cookie" }),
    /已阻止后端直接请求淘宝接口/,
  );
});

test("browser evidence stores loaded page data once without account credentials", () => {
  const payload = { url: "https://h5api.m.tmall.com/h5/price", body: "{\"data\":1}", responseKind: "price" };
  const evidence = buildBrowserCaptureEvidence({
    product: { url: "https://detail.tmall.com/item.htm?id=843315272599" },
    accountType: "vip88",
    itemId: "843315272599",
    capturedAt: "2026-07-17T00:00:00.000Z",
    page: {
      html: "<html>loaded</html>",
      visibleText: "loaded",
      finalUrl: "https://detail.tmall.com/item.htm?id=843315272599",
      statusCode: 200,
      authState: { loggedIn: true, cookie: "auth-secret" },
      cookieHeader: "sid=cookie-secret",
      networkPayloads: [payload],
    },
    promotionCapture: { networkPayloads: [payload], selectionResults: [{ skuId: "1", selected: true, responseReceivedAfterSelection: true }] },
  });

  assert.equal(evidence.page.accessVerified, true);
  assert.equal(evidence.page.networkPayloads.length, 1);
  assert.equal(evidence.page.selectionResults[0].responseReceivedAfterSelection, true);
  assert.equal(Object.hasOwn(evidence.page.selectionResults[0], "responseObserved"), false);
  assert.equal(JSON.stringify(evidence).includes("auth-secret"), false);
  assert.equal(JSON.stringify(evidence).includes("cookie-secret"), false);
});

test("Tmall Supermarket final URLs override generic shop-page noise", () => {
  assert.equal(extractShopName('{"shopName":"免费开店"}', { shopName: "免费开店" }, { shopName: "" }, "https://chaoshi.detail.tmall.com/item.htm?id=838302541852"), "天猫超市");
});

test("filters only an unavailable review-rebate pseudo SKU", () => {
  const failedSelection = { selected: false, reason: "missing-value:44252240468" };
  assert.equal(isUnselectablePromotionSku({ name: "【旗舰新品】晒图返现50元红包", quantity: 0 }, failedSelection), true);
  assert.equal(isUnselectablePromotionSku({ name: "奶油白", quantity: 0 }, failedSelection), false);
  assert.equal(isUnselectablePromotionSku({ name: "晒单返现50元红包", quantity: 3 }, failedSelection), false);
  assert.equal(isUnselectablePromotionSku({ name: "晒单返现50元红包", quantity: 0 }, { selected: true, reason: "verified" }), false);
});

test("sellerIdFromProductMedia recovers a seller id from verified product assets", () => {
  assert.equal(
    sellerIdFromProductMedia(["https://gw.alicdn.com/bao/uploaded/i2/2218161169404/O1CN01pfzaZa2JL5cupxxQJ_!!2218161169404.jpg"]),
    "2218161169404",
  );
});

test("selectSquareMainImage prefers the mobile 1:1 main image over PC gallery images", () => {
  const square = "https://img.alicdn.com/imgextra/i2/2807173571/O1CN01ZQDGET1cFZV4baq16_!!4611686018427384259-0-item_pic.jpg";
  const pcGallery = "https://img.alicdn.com/imgextra/i3/2807173571/O1CN01gE1gBU1cFZV4bZlV4_!!4611686018427384259-0-item_pic.jpg";

  assert.equal(selectSquareMainImage([square], pcGallery), square);
});

test("selectSquareMainImage prefers the canonical item picture over a Picasso activity image", () => {
  const activityImage = "https://gw.alicdn.com/imgextra/O1CN01S0g1HD2JL5kqPZAsz_!!2218161169404-0-picasso.jpg";
  const itemPicture = "https://img.alicdn.com/imgextra/i4/2218161169404/O1CN011ZU95a2JL5kOByuC2_!!4611686018427380732-0-item_pic.jpg";

  assert.equal(selectSquareMainImage([activityImage, itemPicture]), itemPicture);
});

test("selectSquareMainImage preserves a known search image when a new capture only finds an activity image", () => {
  const activityImage = "https://gw.alicdn.com/imgextra/O1CN01S0g1HD2JL5kqPZAsz_!!2218161169404-0-picasso.jpg";
  const knownSearchImage = "https://img.alicdn.com/imgextra/i4/2218161169404/O1CN011ZU95a2JL5kOByuC2_!!4611686018427380732-0-item_pic.jpg";

  assert.equal(selectSquareMainImage([activityImage], knownSearchImage), knownSearchImage);
});

test("selectGalleryImages excludes the large primary image and keeps the next five assets", () => {
  const primary = "https://img.alicdn.com/imgextra/i1/1/O1CN-primary_!!1-0-item_pic.jpg";
  const gallery = selectGalleryImages([
    primary,
    "https://gw.alicdn.com/imgextra/i1/1/O1CN-primary_!!1-0-item_pic.jpg",
    ...Array.from({ length: 6 }, (_, index) => `https://img.alicdn.com/imgextra/i1/1/O1CN-gallery-${index + 1}_!!1.jpg`),
  ], primary);
  assert.equal(gallery.length, 5);
  assert.equal(gallery.filter((image) => image.includes("O1CN-primary")).length, 0);
  assert.ok(gallery[0].includes("O1CN-gallery-1"));
});

test("resolveSkuPrices keeps normal price before coin price", () => {
  const prices = resolveSkuPrices(
    [
      { label: "淘金币价", value: 159.9, kind: "price" },
      { label: "平台加补后", value: 166.12, kind: "price" },
      { label: "优惠前", value: 339, kind: "original" },
    ],
    339,
  );

  assert.deepEqual(prices, {
    normalPrice: 166.12,
    normalPriceTitle: "平台加补后",
    surprisePrice: null,
    coinPrice: 159.9,
  });
});

test("resolveSkuPrices does not invent a missing coin price", () => {
  assert.deepEqual(resolveSkuPrices([]), {
    normalPrice: null,
    normalPriceTitle: "普通价",
    surprisePrice: null,
    coinPrice: null,
  });
});

test("extractStructuredSku retains a list-only SKU without exposing list price as normal price", () => {
  const skuId = "6198474471999";
  const html = `<script>window.__DATA__=${JSON.stringify({
    skuBase: { props: [], skus: [{ skuId, propPath: "" }] },
    skuCore: { sku2info: { [skuId]: { price: { priceText: "199", priceTitle: "优惠前" }, quantity: 3 } } },
  })}</script>`;
  const structured = extractStructuredSku(html);

  assert.equal(structured.skuPrices.length, 1);
  assert.equal(structured.skuPrices[0].skuId, skuId);
  assert.equal(structured.skuPrices[0].originalPrice, 199);
  assert.equal(structured.skuPrices[0].price, null);
  assert.equal(structured.skuPrices[0].normalPrice, null);
});

test("resolveCoinBenefit reports real SKU coin details and explicit absence", () => {
  assert.deepEqual(resolveCoinBenefit({ normalPrice: 109, coinPrice: 99, priceLayers: [{ label: "淘金币价", value: 99 }] }), {
    coinStatus: "available",
    coinDiscountAmount: 10,
  });
  assert.deepEqual(resolveCoinBenefit({ normalPrice: 109, coinPrice: null, priceLayers: [], discountItems: [] }), {
    coinStatus: "none",
    coinDiscountAmount: null,
  });
});

test("applyAppliedCoinDiscount separates an applied coin price from the normal price", () => {
  const sku = applyAppliedCoinDiscount({
    price: 479.91,
    normalPrice: 479.91,
    coinPrice: null,
    priceTitle: "平台加补后",
    priceLayers: [{ label: "平台加补后", value: 479.91, kind: "price", source: "sku" }],
    discountItems: [{ label: "淘金币抵扣", amount: 9.09, text: "淘金币已抵9.09元", source: "page-visible" }],
  });
  assert.equal(sku.normalPrice, 489);
  assert.equal(sku.coinPrice, 479.91);
  assert.equal(sku.coinDiscountAmount, 9.09);
  assert.deepEqual(sku.priceLayers.map(({ label, value }) => ({ label, value })), [
    { label: "淘金币价", value: 479.91 },
    { label: "平台加补后（淘金币前）", value: 489 },
  ]);
});

test("calculatePriceScenarios stores normal, surprise and coin formulas independently", () => {
  const sku = calculatePriceScenarios({
    price: 489,
    normalPrice: 489,
    surprisePrice: 459,
    coinPrice: 479.91,
    discountItems: [
      { label: "惊喜立减", amount: 30, text: "惊喜立减30元" },
      { label: "淘金币抵扣", amount: 9.09, text: "淘金币已抵9.09元" },
    ],
  });
  assert.deepEqual({
    normalPrice: sku.normalPrice,
    surprisePrice: sku.surprisePrice,
    coinPrice: sku.coinPrice,
    surpriseDiscountAmount: sku.surpriseDiscountAmount,
    coinDiscountAmount: sku.coinDiscountAmount,
  }, {
    normalPrice: 489,
    surprisePrice: 459,
    coinPrice: 479.91,
    surpriseDiscountAmount: 30,
    coinDiscountAmount: 9.09,
  });
  assert.equal(sku.priceCalculation.surprise, "普通价 489.00 - 惊喜立减 30.00 = 459.00");
});

test("collectDiscountItems extracts sku-specific direct reductions", () => {
  const items = collectDiscountItems({
    promotions: [
      { promotionName: "超级立减", desc: "超级立减100元" },
      { activityName: "限时立减", text: "限时立减130元" },
    ],
  });

  assert.deepEqual(items.map(({ label, amount, threshold }) => ({ label, amount, threshold })), [
    { label: "超级立减", amount: 100, threshold: null },
    { label: "限时立减", amount: 130, threshold: null },
  ]);
});

test("collectDiscountItems separates full-reduction threshold and discount", () => {
  const [item] = collectDiscountItems({ couponName: "店铺满减", desc: "满300元减50元" });

  assert.deepEqual({ label: item.label, amount: item.amount, threshold: item.threshold }, {
    label: "满减优惠",
    amount: 50,
    threshold: 300,
  });
});

test("collectDiscountItems does not treat the final shop price as a discount item", () => {
  assert.deepEqual(collectDiscountItems({ priceTitle: "店铺优惠后", priceText: "￥428" }), []);
});

test("collectDiscountItemsFromText extracts visible named promotions", () => {
  const items = collectDiscountItemsFromText("店铺优惠后 ￥428 优惠前 ￥689 超级立减100元 限时立减130元");

  assert.deepEqual(items.map(({ label, amount, source }) => ({ label, amount, source })), [
    { label: "超级立减", amount: 100, source: "page-visible" },
    { label: "限时立减", amount: 130, source: "page-visible" },
  ]);
});

test("collectDiscountItemsFromText parses percentage savings and applied coin amounts", () => {
  const items = collectDiscountItemsFromText("超级立减15%省137元 限时立减243元 淘金币已抵9.09元");
  assert.deepEqual(items.map(({ label, amount }) => ({ label, amount })), [
    { label: "超级立减", amount: 137 },
    { label: "限时立减", amount: 243 },
    { label: "淘金币抵扣", amount: 9.09 },
  ]);
});

test("collectDiscountItemsFromText keeps surprise discounts separate from surprise prices", () => {
  assert.deepEqual(collectDiscountItemsFromText("惊喜立减30元").map(({ label, amount }) => ({ label, amount })), [
    { label: "惊喜立减", amount: 30 },
  ]);
  assert.deepEqual(collectDiscountItemsFromText("惊喜立减价459元"), []);
});

test("collectVisibleSurprisePrices extracts explicit surprise prices without treating reductions as prices", () => {
  assert.deepEqual(collectVisibleSurprisePrices("惊喜立减30元 惊喜立减到手价 ¥459.00"), [459]);
  assert.deepEqual(collectVisibleSurprisePrices("惊喜到手价：479.9 惊喜价 ¥479.90"), [479.9]);
  assert.deepEqual(collectVisibleSurprisePrices("惊喜立减30元"), []);
});

test("extractSelectedSkuId prefers a URL selection and supports explicit page state", () => {
  assert.equal(extractSelectedSkuId("https://detail.tmall.com/item.htm?id=1&skuId=6198474471056", "", ["6198474471056"]), "6198474471056");
  assert.equal(extractSelectedSkuId("https://detail.tmall.com/item.htm?id=1", '{"selectedSkuId":"6270249535967"}', ["6270249535967"]), "6270249535967");
  assert.equal(extractSelectedSkuId("https://detail.tmall.com/item.htm?id=1", '{"selectedSkuId":"99999"}', ["6270249535967"]), null);
});

test("applyVisibleSurprisePrice only updates the selected SKU", () => {
  const skus = applyVisibleSurprisePrice([
    { skuId: "a", normalPrice: 489, priceLayers: [] },
    { skuId: "b", normalPrice: 489, surprisePrice: null, priceLayers: [] },
  ], [459], "b");
  assert.equal(skus[0].surprisePrice, undefined);
  assert.equal(skus[1].surprisePrice, 459);
  assert.deepEqual(skus[1].priceLayers[0], {
    label: "惊喜立减价",
    value: 459,
    kind: "price",
    source: "page-visible-selected-sku",
  });
});

test("applyVisibleSurprisePrice never broadcasts an ambiguous page price across multiple SKUs", () => {
  const skus = applyVisibleSurprisePrice([
    { skuId: "a", normalPrice: 489, priceLayers: [] },
    { skuId: "b", normalPrice: 489, priceLayers: [] },
  ], [459], null);
  assert.equal(skus[0].surprisePrice, undefined);
  assert.equal(skus[1].surprisePrice, undefined);
});

test("applyNetworkPromoData maps explicit surprise prices to their response SKU", () => {
  const skus = applyNetworkPromoData([
    { skuId: "6198474471056", normalPrice: 489, surprisePrice: null, priceLayers: [], discountItems: [] },
    { skuId: "6198474471057", normalPrice: 369, surprisePrice: null, priceLayers: [], discountItems: [] },
  ], [{
    body: JSON.stringify({ data: { skuId: "6198474471056", benefit: { title: "惊喜立减到手价", priceText: "¥459" } } }),
  }]);
  assert.equal(skus[0].surprisePrice, 459);
  assert.equal(skus[0].priceLayers[0].source, "network-sku");
  assert.equal(skus[1].surprisePrice, null);
});

test("applyNetworkPromoData keeps explicit gift and 88VIP prices in their own account channels", () => {
  const base = [{ skuId: "sku-1", price: 179, normalPrice: 179, priceLayers: [], discountItems: [] }];
  const [gift] = applyNetworkPromoData(base, [{ body: JSON.stringify({ data: { skuId: "sku-1", benefit: { title: "首单礼金价", priceText: "126" } } }) }], { accountType: "gift" });
  const [vip] = applyNetworkPromoData(base, [{ body: JSON.stringify({ data: { skuId: "sku-1", benefit: { title: "88VIP会员价", priceText: "169" } } }) }], { accountType: "vip88" });

  assert.deepEqual({ normal: gift.normalPrice, gift: gift.giftPrice, surprise: gift.surprisePrice }, { normal: 179, gift: 126, surprise: null });
  assert.deepEqual({ normal: vip.normalPrice, vip: vip.vipPrice, gift: vip.giftPrice }, { normal: 179, vip: 169, gift: undefined });
});

test("applyNetworkPromoData reads SKU-keyed JSONP without sharing prices", () => {
  const skus = applyNetworkPromoData([
    { skuId: "a12345", normalPrice: 489, surprisePrice: null, priceLayers: [], discountItems: [] },
    { skuId: "b12345", normalPrice: 489, surprisePrice: null, priceLayers: [], discountItems: [] },
  ], [{ body: 'mtopjsonp1({"data":{"a12345":{"text":"惊喜价：459元"}}})' }]);
  assert.equal(skus[0].surprisePrice, 459);
  assert.equal(skus[1].surprisePrice, null);
});

test("applyNetworkPromoData infers a SKU surprise price from real promotion telemetry", () => {
  const nested = {
    data: JSON.stringify({
      global: {
        data: {
          resource: {
            inDetailAutoEvent: [{
              fields: {
                args: {
                  selectSkuId: "6198474471056",
                  price1: "689",
                  pricedetails1: "spsd4cjmj_1_2863817109326_2_10000^spsd4jzjj_1_3013245747769_2_3100^spsd4plan_1_3053536452682_2_13000^saleCjmj_1_2863817739188_1_11000",
                },
              },
            }],
          },
        },
      },
    }),
  };
  const [sku] = applyNetworkPromoData([
    { skuId: "6198474471056", originalPrice: 689, normalPrice: 428, surprisePrice: null, priceLayers: [], discountItems: [] },
  ], [{ body: `mtopjsonp1(${JSON.stringify(nested)})` }]);
  assert.equal(sku.normalPrice, 459);
  assert.equal(sku.surprisePrice, 428);
  assert.equal(sku.surpriseInference.benefitDiscountAmount, 31);
  assert.equal(sku.surpriseInference.normalFormula, "标价 689.00 - 超级立减 100.00 - 惊喜活动立减 130.00 = 普通价 459.00");
  assert.equal(sku.surpriseInference.formula, "普通价 459.00 - 惊喜立减 31.00 = 428.00");

  const calculated = calculatePriceScenarios(sku);
  assert.equal(calculated.normalPrice, 459);
  assert.equal(calculated.surprisePrice, 428);
  assert.equal(calculated.priceCalculation.normal, sku.surpriseInference.normalFormula);
  assert.equal(calculated.priceCalculation.surprise, sku.surpriseInference.formula);
});

test("promotion inference runs after applied coin separation", () => {
  const coinSeparated = applyAppliedCoinDiscount({
    skuId: "6270249535967",
    originalPrice: 909,
    price: 479.91,
    normalPrice: 479.91,
    coinPrice: null,
    priceTitle: "平台加补后",
    priceLayers: [{ label: "平台加补后", value: 479.91, kind: "price", source: "sku" }],
    discountItems: [{ label: "淘金币抵扣", amount: 9.09, text: "淘金币已抵9.09元" }],
  });
  const telemetry = {
    data: JSON.stringify({
      args: {
        selectSkuId: "6270249535967",
        price1: "909",
        pricedetails1: "spsd4cjmj_1_1_2_13700^spsd4plan_1_2_2_24300",
      },
    }),
  };
  const [sku] = applyNetworkPromoData([coinSeparated], [{ body: JSON.stringify(telemetry) }]);
  assert.deepEqual({
    normalPrice: sku.normalPrice,
    surprisePrice: sku.surprisePrice,
    coinPrice: sku.coinPrice,
  }, {
    normalPrice: 529,
    surprisePrice: 489,
    coinPrice: 479.91,
  });
  const calculated = calculatePriceScenarios(sku);
  assert.equal(calculated.priceCalculation.coin, "惊喜立减价 489.00 - 淘金币抵扣 9.09 = 479.91");
});

test("promotion inference assigns gift and 88VIP account prices after restoring normal price", () => {
  const telemetry = [{ body: JSON.stringify({
    data: JSON.stringify({
      args: {
        selectSkuId: "gift-sku-12345",
        price1: "319",
        pricedetails1: "spsd4cjmj_1_1_2_4700^spsd4plan_1_2_2_19300",
      },
    }),
  }) }];
  const baseSku = { skuId: "gift-sku-12345", originalPrice: 319, normalPrice: 69, price: 69, priceLayers: [], discountItems: [] };
  const [giftSku] = applyNetworkPromoData([baseSku], telemetry, { accountType: "gift" });
  assert.deepEqual({ normalPrice: giftSku.normalPrice, giftPrice: giftSku.giftPrice, giftDiscountAmount: giftSku.giftDiscountAmount }, {
    normalPrice: 79,
    giftPrice: 69,
    giftDiscountAmount: 10,
  });
  assert.equal(calculatePriceScenarios(giftSku).priceCalculation.gift, "普通价 79.00 - 礼金优惠 10.00 = 69.00");

  const [vipSku] = applyNetworkPromoData([{ ...baseSku, normalPrice: 75, price: 75 }], telemetry, { accountType: "vip88" });
  assert.deepEqual({ normalPrice: vipSku.normalPrice, vipPrice: vipSku.vipPrice, vipDiscountAmount: vipSku.vipDiscountAmount }, {
    normalPrice: 79,
    vipPrice: 75,
    vipDiscountAmount: 4,
  });
  assert.equal(calculatePriceScenarios(vipSku).priceCalculation.vip88, "普通价 79.00 - 88VIP优惠 4.00 = 75.00");
});

test("gift telemetry calculates both normal and gift prices when the page only shows list price", () => {
  const telemetry = [{
    body: JSON.stringify({
      data: JSON.stringify({
        args: {
          selectSkuId: "6274971435306",
          price1: "319",
          promotionType: "dp-Xinxiangliji-*-online",
          pricedetails1: "saleCjmj_1_3049196130412_1_8000^1_7_6274971435306_3_1000^spsd4plan_1_3053555586328_2_19200^spsd4cjmj_1_3049196076428_2_4800",
        },
      }),
    }),
  }];
  const [sku] = applyNetworkPromoData([{
    skuId: "6274971435306",
    originalPrice: 319,
    normalPrice: 319,
    price: 319,
    priceLayers: [],
    discountItems: [],
  }], telemetry, { accountType: "gift" });
  assert.equal(sku.normalPrice, 79);
  assert.equal(sku.giftPrice, 69);
  assert.equal(sku.giftDiscountAmount, 10);
  assert.equal(calculatePriceScenarios(sku).priceCalculation.gift, "普通价 79.00 - 礼金优惠 10.00 = 69.00");
});

test("promotion telemetry keeps a one-cent surprise benefit when the SKU formula proves it", () => {
  const telemetry = [{
    body: JSON.stringify({
      data: JSON.stringify({
        args: {
          selectSkuId: "6198474471058",
          price1: "669",
          promotionType: "dp-Xinxiangliji-*-online",
          pricedetails1: "spsd4cjmj_1_1_1_10000^spsd4plan_1_1_1_13000",
        },
      }),
    }),
  }];
  const [sku] = applyNetworkPromoData([{
    skuId: "6198474471058",
    originalPrice: 669,
    normalPrice: 438.99,
    price: 438.99,
    priceLayers: [],
    discountItems: [],
  }], telemetry, { accountType: "normal" });

  assert.equal(sku.normalPrice, 439);
  assert.equal(sku.surprisePrice, 438.99);
});

test("richer accounts keep public channels while private benefits stay capability-scoped", () => {
  const mixed = {
    normalPrice: 100,
    surprisePrice: 90,
    giftPrice: 80,
    vipPrice: 85,
    coinPrice: 78,
    discountItems: [],
  };
  const normal = calculateAccountPriceScenario(mixed, "normal");
  assert.equal(normal.surprisePrice, 90);
  assert.equal(normal.giftPrice, null);
  assert.equal(normal.vipPrice, null);

  const gift = calculateAccountPriceScenario(mixed, "gift");
  assert.equal(gift.surprisePrice, 90);
  assert.equal(gift.giftPrice, 80);
  assert.equal(gift.vipPrice, null);
  assert.match(gift.priceCalculation.surprise, /惊喜立减/);
  assert.match(gift.priceCalculation.gift, /礼金优惠/);

  const vip = calculateAccountPriceScenario(mixed, "vip88");
  assert.equal(vip.surprisePrice, 90);
  assert.equal(vip.giftPrice, 80);
  assert.equal(vip.vipPrice, 85);
  assert.match(vip.priceCalculation.gift, /礼金优惠/);
  assert.match(vip.priceCalculation.vip88, /88VIP优惠/);
});

test("calculatePriceScenarios keeps an explicit independent surprise price even when another channel is lower", () => {
  const sku = calculatePriceScenarios({ normalPrice: 428, surprisePrice: 459, discountItems: [] });
  assert.equal(sku.normalPrice, 428);
  assert.equal(sku.surprisePrice, 459);
  assert.equal(sku.surpriseDiscountAmount, null);
  assert.equal(sku.priceCalculation.surprise, "页面明确惊喜立减价 459.00（独立价格口径）");
});

test("collectDiscountItemsFromText rejects bare campaign names without an amount or SKU scope", () => {
  const items = collectDiscountItemsFromText("双11活动 百亿补贴 跨店满减");
  assert.deepEqual(items, []);
});

test("collectDiscountItemsFromText prefers an explicit campaign amount over a duplicate name", () => {
  const items = collectDiscountItemsFromText("百亿补贴 百亿补贴50元");
  assert.deepEqual(items.map(({ label, amount }) => ({ label, amount })), [
    { label: "百亿补贴", amount: 50 },
  ]);
});

test("collectProductProgramItems confirms the subsidy program without inventing an amount", () => {
  assert.deepEqual(collectProductProgramItems('{"title":"假一赔十","text":["消费者在百亿补贴购买商品可享保障"]}'), [{
    label: "百亿补贴",
    amount: null,
    threshold: null,
    text: "商品服务保障确认属于百亿补贴，页面未单独披露补贴金额",
    type: "subsidy",
    source: "product-program",
  }]);
  assert.deepEqual(collectProductProgramItems("百亿补贴商品"), []);
});

test("applyVisibleDiscountItems does not assign amountless page campaigns to a SKU", () => {
  const [sku] = applyVisibleDiscountItems(
    [{ skuId: "a", originalPrice: 500, normalPrice: 420, discountItems: [] }],
    [{ label: "618活动", amount: null, source: "page-visible", text: "618活动" }],
  );
  assert.deepEqual(sku.discountItems, []);
});

test("applyVisibleDiscountItems applies item-level promotions only to compatible SKUs", () => {
  const items = collectDiscountItemsFromText("超级立减100元 限时立减130元");
  const skus = applyVisibleDiscountItems([
    { skuId: "a", originalPrice: 689, normalPrice: 428, discountItems: [] },
    { skuId: "b", originalPrice: 609, normalPrice: 369, discountItems: [] },
    { skuId: "c", originalPrice: 300, normalPrice: 100, discountItems: [] },
  ], items);

  assert.equal(skus[0].discountItems.length, 2);
  assert.equal(skus[1].discountItems.length, 2);
  assert.equal(skus[2].discountItems.length, 0);
});

test("filterProductVideoUrls rejects placeholder and unrelated seller videos", () => {
  const videos = filterProductVideoUrls(
    [
      "https://cloud.video.taobao.com/play/u/2807173571/p/2/e/6/t/1/777054281484935.mp4?appKey=38829",
      "https://gw.alicdn.com/bao/uploaded//play/u/null/p/1/e/6/t/1/569598295489.mp4",
      "https://cloud.video.taobao.com/play/u/9999999999/p/2/e/6/t/1/888888888888888.mp4",
      "https://cloud.video.taobao.com/play/u/2807173571/p/2/e/6/t/1/default.mp4",
      "https://cloud.video.taobao.com.evil.example/play/u/2807173571/777054281484935.mp4",
    ],
    ["https://gw.alicdn.com/bao/uploaded/i1/2807173571/product.jpg"],
  );

  assert.deepEqual(videos, [
    "https://cloud.video.taobao.com/play/u/2807173571/p/2/e/6/t/1/777054281484935.mp4?appKey=38829",
  ]);
});

test("media capture defaults to price, 800 main image and SKU images only", () => {
  const snapshot = {
    mainImage: "main-800",
    mainImage800: "main-800",
    mainImages: ["main-800", "gallery-1"],
    gallery750Images: ["gallery-1"],
    detailImages: ["detail-1"],
    videoUrls: ["video-1"],
    skuImages: ["sku-1"],
    skuPrices: [{ skuId: "1", image: "sku-1", price: 99 }],
    rawSignals: { imageCount: 2, detailImageCount: 1, videoCount: 1, highResImageCount: 3 },
  };

  const core = applyMediaCapturePreference(snapshot);
  assert.deepEqual(core.mainImages, ["main-800"]);
  assert.deepEqual(core.gallery750Images, []);
  assert.deepEqual(core.detailImages, []);
  assert.deepEqual(core.videoUrls, []);
  assert.deepEqual(core.skuImages, ["sku-1"]);
  assert.equal(core.skuPrices[0].price, 99);
  assert.equal(core.rawSignals.detailImageCount, 0);
  assert.equal(core.rawSignals.videoCount, 0);
});

test("media capture keeps complete materials only when explicitly enabled", () => {
  const snapshot = { mainImage800: "main-800", gallery750Images: ["gallery-1"], detailImages: ["detail-1"], videoUrls: ["video-1"] };
  assert.equal(applyMediaCapturePreference(snapshot, true), snapshot);
});

test("filterProductVideoUrls deduplicates Taobao play and Tmall Supermarket CDN variants", () => {
  const videos = filterProductVideoUrls([
    "https://cloud.video.taobao.com/play/u/725677994/p/2/e/6/t/1/533410081214.mp4?appKey=38829",
    "https://tmallmart.cloudvideocdn.taobao.com/path/20250909_abc_533410081214_326956665592922_published_mp4_264_hd_taobao.mp4?auth_key=masked",
  ]);
  assert.deepEqual(videos, [
    "https://cloud.video.taobao.com/play/u/725677994/p/2/e/6/t/1/533410081214.mp4?appKey=38829",
  ]);
});

test("filterProductVideoUrls drops expiring signed streams that cannot survive sanitized local evidence", () => {
  assert.deepEqual(filterProductVideoUrls([
    "https://tbm-auth.alicdn.com/path/product.mp4?auth_key=temporary-secret",
    "https://cloud.video.taobao.com/play/u/725677994/p/2/e/6/t/1/533410081214.mp4?appKey=38829",
  ]), [
    "https://cloud.video.taobao.com/play/u/725677994/p/2/e/6/t/1/533410081214.mp4?appKey=38829",
  ]);
});

test("scrapeTmallMaterials is exported as an independent material capture entry point", () => {
  assert.equal(typeof scrapeTmallMaterials, "function");
});

test("extractBuyerShowItems keeps only review content with real media or copy", () => {
  const html = `<div class="rate-item"><p>锅很好用，发货快</p><img src="https://img.alicdn.com/imgextra/i1/1234567890/a.jpg" /><video src="https://cloud.video.taobao.com/play/u/1234567890/p/2/123456789.mp4"></video></div><div class="rate-item"><span> </span></div>`;
  assert.deepEqual(extractBuyerShowItems(html), [{
    id: "buyer-1",
    text: "锅很好用，发货快",
    images: ["https://img.alicdn.com/imgextra/i1/1234567890/a.jpg"],
    videoUrls: ["https://cloud.video.taobao.com/play/u/1234567890/p/2/123456789.mp4"],
  }]);
});

test("extractBuyerShowItems rejects rating summaries that are not review cards", () => {
  const html = `<div class="rate-item"><p>近3个月好评率高达98.8%</p></div><div class="review"><p>好评率98.4%</p></div>`;
  assert.deepEqual(extractBuyerShowItems(html), []);
});

test("buyerShowCaptureFromNetwork accepts only a known review endpoint and schema", () => {
  const body = `jsonp1(${JSON.stringify({ rateDetail: { rateCount: { total: 1 }, rateList: [{ id: "real-1", rateContent: "真实评价内容", pics: ["//img.alicdn.com/bao/uploaded/i1/real.jpg"] }] } })})`;
  const capture = buyerShowCaptureFromNetwork([{ url: "https://rate.tmall.com/list_detail_rate.htm?itemId=1", body }], { itemId: "1", accountSessionId: "normal" });
  assert.equal(capture.status, "complete");
  assert.equal(capture.items.length, 1);
  assert.equal(capture.mediaCount, 1);
  assert.equal(capture.accountSessionId, "normal");

  const unknown = buyerShowCaptureFromNetwork([{ url: "https://h5api.m.tmall.com/h5/mtop.taobao.review.unknown/1.0/", body: JSON.stringify({ data: { feed: [] } }) }], { itemId: "1" });
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.failureCode, "SCHEMA_CHANGED");
});

test("buyerShowsFromRateDetail keeps each Tmall review with its own pictures and videos", () => {
  const items = buyerShowsFromRateDetail({ rateList: [{ id: 123, rateContent: "加热很快", displayUserNick: "买***家", auctionSku: "白色", rateDate: "2026-07-12", pics: ["//img.alicdn.com/bao/uploaded/i1/a-0-rate.jpg"], videoList: [{ cloudVideoUrl: "//cloud.video.taobao.com/play/u/null/p/1/123.mp4" }] }] });
  assert.deepEqual(items, [{ id: "123", text: "加热很快", images: ["https://img.alicdn.com/bao/uploaded/i1/a-0-rate.jpg"], videoUrls: ["https://cloud.video.taobao.com/play/u/null/p/1/123.mp4"], author: "买***家", sku: "白色", createdAt: "2026-07-12" }]);
});

test("buyerShowsFromRateDetail supports nested lists and object media fields", () => {
  const items = buyerShowsFromRateDetail({
    rateList: {
      rate: [{
        rateId: "new-1",
        reviewContent: "主体评价",
        images: [{ picUrl: "//img.alicdn.com/bao/uploaded/i2/new-rate.jpg" }],
        videoInfo: { playUrl: "//cloud.video.taobao.com/play/u/123/p/1/456.mp4" },
        appendComment: [{ commentContent: "追加评价", photos: [{ url: "//img.alicdn.com/bao/uploaded/i2/append-rate.jpg" }] }],
      }],
    },
  });

  assert.deepEqual(items, [{
    id: "new-1",
    text: "主体评价\n追加评价",
    images: [
      "https://img.alicdn.com/bao/uploaded/i2/new-rate.jpg",
      "https://img.alicdn.com/bao/uploaded/i2/append-rate.jpg",
    ],
    videoUrls: ["https://cloud.video.taobao.com/play/u/123/p/1/456.mp4"],
    author: "",
    sku: "",
    createdAt: "",
  }]);
});

test("resolveCoinBenefit does not revive an unverified coin price after authoritative resolution", () => {
  assert.deepEqual(resolveCoinBenefit({
    normalPrice: 241.31,
    coinPrice: null,
    priceLayers: [{ label: "淘金币价", value: 241.31 }],
    discountItems: [{ label: "淘金币抵扣", amount: 3.79 }],
    priceResolution: { status: "verified", channels: { coin: { status: "unavailable" } } },
  }), { coinStatus: "none", coinDiscountAmount: null });
});

test("buyerShowsFromRateDetail supports the current Tmall feedback and feedPic fields", () => {
  const items = buyerShowsFromRateDetail({
    total: "1",
    rateList: [{
      id: "new-rate-1",
      feedback: "操作简单，做工不错。",
      feedPicList: ["//img.alicdn.com/bao/uploaded/i1/new-rate-1.jpg"],
      feedPicPathList: ["//img.alicdn.com/bao/uploaded/i1/new-rate-1.jpg"],
      reduceUserNick: "买**家",
      skuValueStr: "白色；温热",
      feedbackDate: "2026年7月8日",
    }],
  });
  assert.deepEqual(items, [{
    id: "new-rate-1",
    text: "操作简单，做工不错。",
    images: ["https://img.alicdn.com/bao/uploaded/i1/new-rate-1.jpg"],
    videoUrls: [],
    author: "买**家",
    sku: "白色；温热",
    createdAt: "2026年7月8日",
  }]);
});
