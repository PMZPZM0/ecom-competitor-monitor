import assert from "node:assert/strict";
import test from "node:test";
import { applyAccountBenefitFormula, applyAppliedCoinDiscount, applyNetworkPromoData, applyVisibleDiscountItems, applyVisibleSurprisePrice, buyerShowsFromRateDetail, calculateAccountPriceScenario, calculatePriceScenarios, collectDiscountItems, collectDiscountItemsFromText, collectProductProgramItems, collectVisibleSurprisePrices, extractBuyerShowItems, extractSelectedSkuId, filterProductVideoUrls, resolveCoinBenefit, resolveSkuPrices, selectGalleryImages, selectSquareMainImage } from "./tmallScraper.js";

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

test("selectGalleryImages keeps five gallery-role assets even when the 800 image is also present", () => {
  const primary = "https://img.alicdn.com/imgextra/i1/1/O1CN-primary_!!1-0-item_pic.jpg";
  const gallery = selectGalleryImages([
    primary,
    "https://gw.alicdn.com/imgextra/i1/1/O1CN-primary_!!1-0-item_pic.jpg",
    ...Array.from({ length: 6 }, (_, index) => `https://img.alicdn.com/imgextra/i1/1/O1CN-gallery-${index + 1}_!!1.jpg`),
  ], primary);
  assert.equal(gallery.length, 5);
  assert.equal(gallery.filter((image) => image.includes("O1CN-primary")).length, 1);
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
  assert.deepEqual(resolveSkuPrices([], 199), {
    normalPrice: 199,
    normalPriceTitle: "普通价",
    surprisePrice: null,
    coinPrice: null,
  });
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

test("account benefit fallback restores normal price from named promotions", () => {
  const baseSku = {
    skuId: "gift-sku",
    originalPrice: 319,
    normalPrice: 69,
    price: 69,
    priceLayers: [],
    discountItems: [
      { label: "超级立减", amount: 47, text: "超级立减47元" },
      { label: "限时立减", amount: 193, text: "限时立减193元" },
    ],
  };
  const [giftSku] = applyAccountBenefitFormula([baseSku], "gift");
  assert.deepEqual({ normalPrice: giftSku.normalPrice, giftPrice: giftSku.giftPrice, giftDiscountAmount: giftSku.giftDiscountAmount }, {
    normalPrice: 79,
    giftPrice: 69,
    giftDiscountAmount: 10,
  });
  assert.equal(giftSku.giftInference.normalFormula, "标价 319.00 - 超级立减 47.00 - 限时立减 193.00 = 普通价 79.00");

  const [vipSku] = applyAccountBenefitFormula([{ ...baseSku, normalPrice: 75, price: 75 }], "vip88");
  assert.equal(vipSku.normalPrice, 79);
  assert.equal(vipSku.vipPrice, 75);
  assert.equal(vipSku.vipDiscountAmount, 4);
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

test("account price formulas stay isolated by account type", () => {
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
  assert.equal(gift.surprisePrice, null);
  assert.equal(gift.giftPrice, 80);
  assert.equal(gift.vipPrice, null);
  assert.match(gift.priceCalculation.gift, /礼金优惠/);

  const vip = calculateAccountPriceScenario(mixed, "vip88");
  assert.equal(vip.surprisePrice, null);
  assert.equal(vip.giftPrice, null);
  assert.equal(vip.vipPrice, 85);
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

test("extractBuyerShowItems keeps only review content with real media or copy", () => {
  const html = `<div class="rate-item"><p>锅很好用，发货快</p><img src="https://img.alicdn.com/imgextra/i1/1234567890/a.jpg" /><video src="https://cloud.video.taobao.com/play/u/1234567890/p/2/123456789.mp4"></video></div><div class="rate-item"><span> </span></div>`;
  assert.deepEqual(extractBuyerShowItems(html), [{
    id: "buyer-1",
    text: "锅很好用，发货快",
    images: ["https://img.alicdn.com/imgextra/i1/1234567890/a.jpg"],
    videoUrls: ["https://cloud.video.taobao.com/play/u/1234567890/p/2/123456789.mp4"],
  }]);
});

test("buyerShowsFromRateDetail keeps each Tmall review with its own pictures and videos", () => {
  const items = buyerShowsFromRateDetail({ rateList: [{ id: 123, rateContent: "加热很快", displayUserNick: "买***家", auctionSku: "白色", rateDate: "2026-07-12", pics: ["//img.alicdn.com/bao/uploaded/i1/a-0-rate.jpg"], videoList: [{ cloudVideoUrl: "//cloud.video.taobao.com/play/u/null/p/1/123.mp4" }] }] });
  assert.deepEqual(items, [{ id: "123", text: "加热很快", images: ["https://img.alicdn.com/bao/uploaded/i1/a-0-rate.jpg"], videoUrls: ["https://cloud.video.taobao.com/play/u/null/p/1/123.mp4"], author: "买***家", sku: "白色", createdAt: "2026-07-12" }]);
});
