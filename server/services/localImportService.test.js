import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecom-local-import-"));
process.env.ECOM_MONITOR_DATA_DIR = dataDir;

const {
  clearLocalEvidenceFiles,
  createLocalImport,
  createLocalImportFromSavedSource,
  getLocalEvidenceStorageOverview,
  saveCapturedSnapshotLocalEvidence,
  loadLocalImport,
  loadLocalImportRecord,
  LOCAL_IMPORT_MAX_BYTES,
  LOCAL_IMPORT_MAX_FILES,
  mergeLocalImportSnapshot,
  readBrowserCaptureSource,
  reparseBrowserCaptureSource,
  saveBrowserCaptureSource,
  saveLocalImportSource,
  validateLocalEvidenceDirectory,
} = await import("./localImportService.js");
const { updateDb } = await import("../storage/db.js");

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function response(skuId, price1, price2, promotions) {
  return {
    data: {
      componentsVO: {
        xsRedPacketParamVO: {
          trackParams: { skuId, price1, price2 },
          xsRedPocketParams: {
            tbShopRedPocket: JSON.stringify({ umpInfo: { umpPromotionList: promotions } }),
          },
        },
      },
    },
  };
}

function pcdetailUrl(itemId, skuId) {
  return `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId, skuId }))}`;
}

function newUserGiftBrowserCapture() {
  const itemId = "613114976305";
  const currentSkuId = "6012220507404";
  const skuCases = [
    { skuId: "5053947379176", originalPrice: 609, normalPrice: 270, giftPrice: 244 },
    { skuId: "5175235530908", originalPrice: 690, normalPrice: 297, giftPrice: 271 },
    { skuId: "5925291249025", originalPrice: 609, normalPrice: 243, giftPrice: 217 },
    { skuId: currentSkuId, originalPrice: 589, normalPrice: 269, giftPrice: 243 },
    { skuId: "5984100993900", originalPrice: 729, normalPrice: 270, giftPrice: 244 },
    { skuId: "6035530305968", originalPrice: 669, normalPrice: 315, giftPrice: 289 },
  ];
  const embedded = {
    itemId,
    skuBase: {
      props: [],
      skus: skuCases.map(({ skuId }) => ({ skuId, propPath: "" })),
    },
    skuCore: {
      sku2info: Object.fromEntries(skuCases.map(({ skuId, originalPrice, normalPrice }, index) => [skuId, {
        subPrice: { priceText: String(normalPrice), priceTitle: "平台加补后" },
        price: { priceText: String(originalPrice) },
        quantity: index + 1,
      }])),
    },
    xsRedPacketParamVO: {
      trackParams: { itemId, skuId: currentSkuId, price1: "589", price2: "243" },
      xsRedPocketParams: {
        tbShopRedPocket: JSON.stringify({
          itemId,
          detailExtraParam: {},
          umpInfo: {
            umpPromotionList: [
              { promotionName: "coupon2RedForNewUser", amount: 2600, threshold: 2601 },
              { toolCode: "spsd4cjmj", promotionName: "spsd4cjmj", amount: 7100, threshold: 0 },
              { toolCode: "spsd4price", promotionName: "spsd4price", amount: 24900, threshold: 0 },
            ],
          },
        }),
      },
    },
  };
  return {
    itemId,
    currentSkuId,
    skuCases,
    capture: {
      captureType: "account-browser-local-source",
      itemId,
      requestedUrl: `https://detail.tmall.com/item.htm?id=${itemId}&sign=browser-request-secret`,
      finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}&token=browser-final-secret`,
      accountType: "normal",
      page: {
        html: `<script>window.__DATA__=${JSON.stringify(embedded)}</script>`,
        visibleText: "首单礼金 店铺新客专享",
        finalUrl: `https://detail.tmall.com/item.htm?id=${itemId}`,
        statusCode: 200,
        source: "browser",
        accessVerified: true,
        networkPayloads: [],
        selectionResults: [],
      },
      authorization: "Bearer browser-authorization-secret",
      cookie: "sid=browser-cookie-secret",
    },
  };
}

test("imports an explicitly identified pcdetail response and verifies normal plus surprise prices", async () => {
  const skuId = "6198474471056";
  const itemId = "843315272519";
  const raw = response(skuId, "199", "129", [
    { promotionName: "spsd4plan", amount: 6000 },
    { promotionName: "spsd4jzjj", amount: 1000 },
  ]);
  const preview = await createLocalImport(JSON.stringify({ itemId, request: { url: pcdetailUrl(itemId, skuId), body: raw } }), {
    accountType: "normal",
    itemIdHint: itemId,
  });

  assert.equal(preview.canCommit, true);
  assert.equal(preview.inputType, "json");
  assert.equal(preview.savedFile, `local-imports/${preview.importId}.json`);
  assert.equal(preview.sourceFile, `local-imports/${preview.importId}.source.txt`);
  assert.deepEqual(preview.localFirst, { sourceSaved: true, sourceSanitized: true, parsedFromDisk: true, networkAccessed: false });
  assert.equal(preview.resolutionStatus, "verified");
  assert.equal(preview.skuCount, 1);
  assert.equal(preview.verifiedSkuCount, 1);
  assert.equal(preview.skuPrices[0].resolutionStatus, "verified");
  assert.equal(preview.skuPrices[0].normalPrice, 139);
  assert.equal(preview.skuPrices[0].surprisePrice, 129);
  assert.deepEqual(preview.priceRange, [139, 139]);
  assert.deepEqual(Object.keys(preview).sort(), [
    "accountType", "canCommit", "importId", "inputType", "itemId", "price", "priceRange", "resolutionStatus",
    "localFirst", "savedFile", "shopName", "skuCount", "skuPrices", "sourceFile", "title", "verifiedSkuCount", "warnings",
  ].sort());
  assert.deepEqual(await loadLocalImport(preview.importId), preview);
  const record = await loadLocalImportRecord(preview.importId);
  assert.equal(record.snapshot.source, "local-import");
  assert.equal(record.snapshot.accessMode, "authenticated");
  assert.equal(record.snapshot.buyerShowCapture.status, "skipped");
  assert.equal(record.snapshot.buyerShowCapture.source, "disabled");
  assert.equal(record.snapshot.buyerShowCapture.itemId, itemId);
  assert.deepEqual(record.snapshot.skuImages, []);
  assert.equal(record.snapshot.skuPrices[0].image, "");
  assert.equal(record.snapshot.rawSignals.imageCount, 0);
  assert.equal(record.snapshot.rawSignals.skuImageCount, 0);
  assert.equal(record.snapshot.rawSignals.priceCount, 1);
  assert.equal(record.snapshot.rawSignals.localSourceStored, true);
  assert.equal(record.snapshot.rawSignals.localSourceSanitized, true);
  assert.equal(record.snapshot.rawSignals.originalContentDiscarded, true);

  const merged = mergeLocalImportSnapshot({
    name: "已核对商品标题",
    shopName: "原店铺",
    model: "原型号",
    mainImage: "https://img.alicdn.com/main.jpg",
    lastSnapshot: {
      mainImage: "https://img.alicdn.com/main.jpg",
      mainImage800: "https://img.alicdn.com/main-800.jpg",
      mainImages: ["https://img.alicdn.com/main.jpg"],
      gallery750Images: ["https://img.alicdn.com/gallery.jpg"],
      detailImages: ["https://img.alicdn.com/detail.jpg"],
      videoUrls: ["https://cloud.video.taobao.com/video.mp4"],
      buyerShows: [{ id: "buyer-1", text: "历史买家秀", images: [], videoUrls: [] }],
      skuPrices: [{ skuId, image: "https://img.alicdn.com/sku.jpg" }],
    },
  }, record.snapshot);
  assert.equal(merged.title, "已核对商品标题");
  assert.equal(merged.shopName, "原店铺");
  assert.equal(merged.model, "原型号");
  assert.equal(merged.skuPrices[0].normalPrice, 139);
  assert.equal(merged.skuPrices[0].image, "https://img.alicdn.com/sku.jpg");
  assert.deepEqual(merged.skuImages, ["https://img.alicdn.com/sku.jpg"]);
  assert.deepEqual(merged.gallery750Images, ["https://img.alicdn.com/gallery.jpg"]);
  assert.equal(merged.buyerShows[0].text, "历史买家秀");
  assert.equal(merged.rawSignals.detailImageCount, 1);
  assert.equal(merged.rawSignals.videoCount, 1);
  assert.equal(merged.rawSignals.buyerShowCount, 1);
});

test("local evidence keeps billion and seckill channels after disk parsing", async () => {
  const itemId = "843315272530";
  const billionSku = "6274971435530";
  const seckillSku = "6274971435531";
  const preview = await createLocalImport(JSON.stringify({
    itemId,
    capture: {
      networkPayloads: [
        { url: pcdetailUrl(itemId, billionSku), body: response(billionSku, "200", "150", [{ promotionName: "spsd4bybt", amount: 5000 }]) },
        { url: pcdetailUrl(itemId, seckillSku), body: response(seckillSku, "200", "150", [{ promotionName: "spsd4hjmssjbt", amount: 5000 }]) },
      ],
    },
  }), { accountType: "normal" });

  const bySku = new Map(preview.skuPrices.map((sku) => [sku.skuId, sku]));
  assert.equal(bySku.get(billionSku)?.billionPrice, 150);
  assert.equal(bySku.get(billionSku)?.billionStatus, "available");
  assert.equal(bySku.get(billionSku)?.seckillStatus, "none");
  assert.equal(bySku.get(seckillSku)?.seckillPrice, 150);
  assert.equal(bySku.get(seckillSku)?.seckillStatus, "available");
  assert.equal(bySku.get(seckillSku)?.billionStatus, "none");
  const record = await loadLocalImportRecord(preview.importId);
  assert.equal(record.snapshot.skuPrices.find((sku) => sku.skuId === billionSku)?.priceResolution.channels.billion.status, "verified");
  assert.equal(record.snapshot.skuPrices.find((sku) => sku.skuId === seckillSku)?.priceResolution.channels.seckill.status, "verified");
});

test("imports nested url/body records and applies the 88VIP-only first-order gift formula", async () => {
  const itemId = "843315272520";
  const skuId = "6274971435306";
  const body = response(skuId, "199", "119", [
    { promotionName: "spsd4plan", amount: 6000 },
    { promotionName: "1", amount: 2000 },
  ]);
  const preview = await createLocalImport(JSON.stringify({
    itemId,
    title: "测试礼金商品",
    capture: {
      networkPayloads: [[{
        url: `${pcdetailUrl(itemId, skuId)}&sign=do-not-store&_m_h5_tk=url-mh5-secret&_tb_token_=url-tb-secret&x-sign=url-x-sign-secret&x-sgext=url-x-sgext-secret&x-mini-wua=url-wua-secret`,
        body,
        headers: {
          authorization: "Bearer auth-secret-value",
          cookie: "sid=cookie-secret-value",
          token: "token-secret-value",
          password: "password-secret-value",
          "_m_h5_tk": "mh5-secret-value",
          "_tb_token_": "tb-token-secret-value",
          "x-sign": "x-sign-secret-value",
          "x-sgext": "x-sgext-secret-value",
          "x-mini-wua": "x-mini-wua-secret-value",
        },
      }]],
    },
  }), { accountType: "vip88" });

  const sku = preview.skuPrices[0];
  assert.equal(preview.canCommit, true);
  assert.equal(preview.inputType, "json");
  assert.equal(sku.normalPrice, 139);
  assert.equal(sku.giftPrice, 119);
  assert.equal(sku.resolutionStatus, "verified");
  assert.match(sku.priceCalculation.gift, /首单礼金 20\.00/);

  const saved = await fs.readFile(path.join(dataDir, "local-imports", `${preview.importId}.json`), "utf8");
  assert.doesNotMatch(saved, /do-not-store|auth-secret-value|cookie-secret-value|token-secret-value|password-secret-value|mh5-secret-value|tb-token-secret-value|x-sign-secret-value|x-sgext-secret-value|x-mini-wua-secret-value|url-mh5-secret|url-tb-secret|url-x-sign-secret|url-x-sgext-secret|url-wua-secret/i);
  const source = await fs.readFile(path.join(dataDir, preview.sourceFile), "utf8");
  assert.doesNotMatch(source, /do-not-store|auth-secret-value|cookie-secret-value|token-secret-value|password-secret-value|mh5-secret-value|tb-token-secret-value|x-sign-secret-value|x-sgext-secret-value|x-mini-wua-secret-value|url-mh5-secret|url-tb-secret|url-x-sign-secret|url-x-sgext-secret|url-wua-secret/i);
  assert.match(source, /\[REDACTED\]/);
});

test("parses only the sanitized bytes re-read from disk", async () => {
  const itemId = "843315272598";
  const skuId = "6274971435988";
  const staged = await saveLocalImportSource("this in-memory value cannot produce a price");
  const diskContent = JSON.stringify({
    itemId,
    request: {
      url: pcdetailUrl(itemId, skuId),
      body: response(skuId, "199", "139", [{ promotionName: "spsd4plan", amount: 6000 }]),
    },
  });
  await fs.writeFile(path.join(dataDir, staged.sourceFile), diskContent, "utf8");

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("local import must not access the network");
  };
  try {
    const preview = await createLocalImportFromSavedSource(staged.importId, { accountType: "normal" });
    assert.equal(preview.canCommit, true);
    assert.equal(preview.itemId, itemId);
    assert.equal(preview.skuPrices[0].skuId, skuId);
    assert.equal(preview.skuPrices[0].normalPrice, 139);
    assert.equal(networkCalls, 0);
    assert.equal(await fs.readFile(path.join(dataDir, preview.sourceFile), "utf8"), diskContent);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser capture is sanitized, saved first, and re-read without a network request", async () => {
  const encodedCredential = "encoded-browser-token";
  const capture = {
    captureType: "account-browser-local-source",
    itemId: "843315272599",
    requestedUrl: "https://detail.tmall.com/item.htm?id=843315272599&data=encoded-request-secret&spm=tracking-secret",
    finalUrl: "https://detail.tmall.com/item.htm?id=843315272599&exParams=encoded-final-secret",
    page: {
      html: '<script>const cookie="sid=browser-secret";window.__ACCOUNT__={"nick":"private-nick","nickname":"private-nickname","userId":"private-user","uid":"private-uid","accountId":"private-account","loginId":"private-login","openId":"private-open","unionId":"private-union","unb":"private-unb","wk_unb":"private-wk-unb"};window.__SAFE_PARAMS__={"mi_id":"private-html-mi-id"};window.__ADDRESS__={"addressList":[{"addressId":"private-address-id","areaId":"private-area-id","briefAddress":"private-brief-address","detailAddress":"private-detail-address","tel":"private-tel","userName":"private-user-name"}],"displayNick":"private-display-nick"};window.__ESCAPED__="{\\"userName\\":\\"private-escaped-user\\",\\"tel\\":\\"private-escaped-tel\\"}"</script><div>本地页面</div>',
      visibleText: "nickname=visible-private-nickname userName=visible-private-user tel=visible-private-tel 本地页面",
      finalUrl: "https://detail.tmall.com/item.htm?id=843315272599&data=encoded-page-secret",
      safeParams: { mi_id: "private-mi-id" },
      networkPayloads: [{
        url: `https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?data=${encodeURIComponent(JSON.stringify({ itemId: "843315272599", skuId: "6274971435999", token: encodedCredential }))}&sign=url-secret`,
        skuId: "6274971435999",
        requestSkuId: "6274971435999",
        responseSkuId: "6274971435999",
        captureRunId: "selection-run-sanitized",
        responseSequence: 1,
        body: JSON.stringify({ data: { addressList: [{ addressId: "private-body-address", tel: "private-body-tel", userName: "private-body-user" }], displayNick: "private-body-display", componentsVO: { deliveryVO: { addressId: "private-delivery-address", areaId: "private-delivery-area" }, xsRedPacketParamVO: { trackParams: { skuId: "6274971435999", price1: "199", price2: "139" } } } } }),
        responseKind: "price",
      }],
      selectionResults: [{
        skuId: "6274971435999",
        selected: true,
        responseReceivedAfterSelection: true,
        captureRunId: "selection-run-sanitized",
        responseSequenceStartExclusive: 0,
        responseSequenceEndInclusive: 1,
      }],
    },
    authorization: "Bearer browser-auth-secret",
  };
  const saved = await saveBrowserCaptureSource(capture);
  capture.page.html = "内存对象已被改写";
  const diskText = await fs.readFile(path.join(dataDir, saved.sourceFile), "utf8");
  assert.doesNotMatch(diskText, /browser-secret|browser-auth-secret|url-secret|encoded-browser-token|encoded-request-secret|tracking-secret|encoded-final-secret|encoded-page-secret|private-(?:nick|nickname|user|uid|account|login|open|union|unb|wk-unb|mi-id|html-mi-id|address-id|area-id|brief-address|detail-address|tel|user-name|display-nick|escaped-user|escaped-tel|body-address|body-tel|body-user|body-display|delivery-address|delivery-area)|visible-private-(?:nickname|user|tel)/);
  assert.match(diskText, /\[REDACTED\]/);
  const stored = JSON.parse(diskText);
  assert.equal(stored.requestedUrl, "https://detail.tmall.com/item.htm?id=843315272599");
  assert.equal(stored.finalUrl, "https://detail.tmall.com/item.htm?id=843315272599");
  assert.equal(stored.page.finalUrl, "https://detail.tmall.com/item.htm?id=843315272599");
  assert.equal(stored.page.safeParams.mi_id, "[REDACTED]");
  assert.doesNotMatch(stored.page.html, /private-html-mi-id/);
  assert.equal(stored.page.networkPayloads[0].url, "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.adjust/1.0/?itemId=843315272599&skuId=6274971435999");
  assert.equal(stored.page.networkPayloads[0].captureRunId, "selection-run-sanitized");
  assert.equal(stored.page.networkPayloads[0].responseSequence, 1);
  const storedBody = JSON.parse(stored.page.networkPayloads[0].body);
  assert.equal(storedBody.data.addressList, "[REDACTED]");
  assert.equal(storedBody.data.displayNick, "[REDACTED]");
  assert.equal(storedBody.data.componentsVO.deliveryVO.addressId, "[REDACTED]");
  assert.equal(storedBody.data.componentsVO.deliveryVO.areaId, "[REDACTED]");
  assert.equal(storedBody.data.componentsVO.xsRedPacketParamVO.trackParams.price2, "139");
  assert.equal(stored.page.selectionResults[0].captureRunId, "selection-run-sanitized");
  assert.equal(stored.page.selectionResults[0].responseSequenceStartExclusive, 0);
  assert.equal(stored.page.selectionResults[0].responseSequenceEndInclusive, 1);

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("disk parsing must not request the network");
  };
  try {
    const reloaded = await readBrowserCaptureSource(saved.captureId);
    assert.match(reloaded.page.html, /本地页面/);
    assert.doesNotMatch(reloaded.page.html, /内存对象已被改写/);
    assert.equal(reloaded.localFirst.sourceSaved, true);
    assert.equal(reloaded.localFirst.parsedFromDisk, true);
    assert.equal(reloaded.localFirst.networkAccessedAfterCapture, false);
    assert.equal(networkCalls, 0);
    const overview = await getLocalEvidenceStorageOverview();
    assert.equal(overview.sourceFileCount, 1);
    const cleared = await clearLocalEvidenceFiles();
    assert.equal(cleared.sourceFileCount, 0);
    assert.deepEqual(cleared.deletedCaptureIds, [saved.captureId]);
    await assert.rejects(fs.stat(path.join(dataDir, saved.sourceFile)), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reloaded browser SSR evidence applies an item-scoped new-user gift to every eligible SKU across all capable accounts", async () => {
  const { itemId, currentSkuId, skuCases, capture } = newUserGiftBrowserCapture();
  const saved = await saveBrowserCaptureSource(capture);
  capture.page.html = "<script>window.__DATA__={}</script>";

  const browserSourcePath = path.join(dataDir, saved.sourceFile);
  const browserSource = await fs.readFile(browserSourcePath, "utf8");
  assert.doesNotMatch(browserSource, /browser-request-secret|browser-final-secret|browser-authorization-secret|browser-cookie-secret/);
  assert.match(browserSource, /coupon2RedForNewUser/);
  assert.equal((await fs.stat(browserSourcePath)).isFile(), true);
  assert.deepEqual((await fs.readdir(path.dirname(browserSourcePath))).filter((name) => name.endsWith(".tmp")), []);

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("SSR price parsing must remain local after browser capture");
  };
  try {
    const reloaded = await readBrowserCaptureSource(saved.captureId);
    assert.equal(reloaded.localFirst.sourceSaved, true);
    assert.equal(reloaded.localFirst.sourceSanitized, true);
    assert.equal(reloaded.localFirst.parsedFromDisk, true);
    assert.match(reloaded.page.html, /coupon2RedForNewUser/);
    assert.doesNotMatch(reloaded.page.html, /window\.__DATA__=\{\}/);

    for (const accountType of ["normal", "gift", "vip88"]) {
      const preview = await createLocalImport(JSON.stringify(reloaded), { accountType, itemIdHint: itemId });
      assert.deepEqual(preview.localFirst, {
        sourceSaved: true,
        sourceSanitized: true,
        parsedFromDisk: true,
        networkAccessed: false,
      });
      assert.equal(preview.canCommit, true);
      assert.equal(preview.verifiedSkuCount, 6);

      const current = preview.skuPrices.find((sku) => sku.skuId === currentSkuId);
      assert.equal(current.resolutionStatus, "verified");
      assert.equal(current.originalPrice, 589);
      assert.equal(current.normalPrice, 269);
      assert.equal(current.giftPrice, 243);
      assert.equal(current.giftStatus, "available");
      assert.equal(current.priceResolution.source, "embedded-promotion");
      assert.equal(current.priceResolution.channels.gift.label, "新客礼金价");
      assert.equal(current.priceCalculation.normal, "标价 589.00 - 超级立减 71.00 - 平台立减 249.00 = 普通价 269.00");
      assert.equal(current.priceCalculation.gift, "普通价 269.00 - 新客礼金 26.00 = 新客礼金价 243.00");

      for (const expected of skuCases) {
        const sku = preview.skuPrices.find((item) => item.skuId === expected.skuId);
        assert.equal(sku.resolutionStatus, "verified", expected.skuId);
        assert.equal(sku.normalPrice, expected.normalPrice, expected.skuId);
        assert.equal(sku.giftPrice, expected.giftPrice, expected.skuId);
        assert.equal(sku.giftStatus, "available", expected.skuId);
        assert.equal(sku.priceResolution.channels.gift.status, "verified", expected.skuId);
        assert.equal(sku.priceResolution.channels.gift.label, "新客礼金价", expected.skuId);
        assert.equal(
          sku.priceCalculation.gift,
          `普通价 ${expected.normalPrice.toFixed(2)} - 新客礼金 26.00 = 新客礼金价 ${expected.giftPrice.toFixed(2)}`,
          expected.skuId,
        );
      }

      const record = await loadLocalImportRecord(preview.importId);
      const storedCurrent = record.snapshot.skuPrices.find((sku) => sku.skuId === currentSkuId);
      assert.equal(storedCurrent.priceResolution.channels.gift.label, "新客礼金价");
      assert.equal(storedCurrent.giftPrice, 243);
      assert.deepEqual(record.snapshot.skuPrices.map((sku) => sku.giftPrice), skuCases.map((sku) => sku.giftPrice));
    }

    const reparsed = await reparseBrowserCaptureSource(saved.captureId, { accountType: "normal", itemIdHint: itemId });
    assert.deepEqual(reparsed.localFirst, {
      sourceSaved: true,
      sourceSanitized: true,
      parsedFromDisk: true,
      networkAccessedAfterCapture: false,
    });
    assert.deepEqual(reparsed.snapshot.skuPrices.map((sku) => sku.giftPrice), skuCases.map((sku) => sku.giftPrice));
    assert.equal(reparsed.snapshot.itemId, itemId);
    assert.equal(reparsed.snapshot.source, "browser");
    assert.equal(reparsed.snapshot.browserEvidenceId, saved.captureId);
    assert.equal(reparsed.snapshot.localFirst.parsedFromDisk, true);

    assert.equal(networkCalls, 0);
    assert.deepEqual((await fs.readdir(path.join(dataDir, "local-imports"))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores nested price responses that have no verifiable product identity", async () => {
  const itemId = "843315272522";
  const targetSkuId = "6274971435308";
  const unrelatedSkuId = "6274971435999";
  const preview = await createLocalImport(JSON.stringify({
    itemId,
    target: {
      url: pcdetailUrl(itemId, targetSkuId),
      body: response(targetSkuId, "199", "139", [{ promotionName: "spsd4plan", amount: 6000 }]),
    },
    recommendation: {
      body: response(unrelatedSkuId, "999", "899", [{ promotionName: "spsd4plan", amount: 10000 }]),
    },
  }), { accountType: "normal" });

  assert.equal(preview.canCommit, true);
  assert.equal(preview.skuCount, 1);
  assert.equal(preview.verifiedSkuCount, 1);
  assert.equal(preview.skuPrices[0].skuId, targetSkuId);
  assert.equal(preview.skuPrices[0].normalPrice, 139);
});

test("never treats an unverified embedded page price as a live price", async () => {
  const itemId = "843315272521";
  const skuId = "6274971435307";
  const content = JSON.stringify({
    itemId,
    skuBase: { props: [], skus: [{ skuId, propPath: "" }] },
    skuCore: {
      sku2info: {
        [skuId]: {
          subPrice: { priceText: "99", priceTitle: "到手价" },
          price: { priceText: "199" },
          quantity: 10,
        },
      },
    },
  });
  const preview = await createLocalImport(content, { accountType: "normal" });

  assert.equal(preview.canCommit, false);
  assert.equal(preview.price, null);
  assert.equal(preview.priceRange, null);
  assert.equal(preview.skuCount, 1);
  assert.equal(preview.verifiedSkuCount, 0);
  assert.equal(preview.skuPrices.length, 1);
  assert.equal(preview.skuPrices[0].skuId, skuId);
  assert.equal(preview.skuPrices[0].normalPrice, null);
  assert.equal(preview.skuPrices[0].resolutionStatus, "unavailable");
  assert.match(preview.warnings.join(" "), /价格证据核验/);
  const record = await loadLocalImportRecord(preview.importId);
  assert.equal(record.snapshot.skuPrices.length, 1);
  assert.equal(record.snapshot.skuPrices[0].normalPrice, null);
  assert.equal(record.snapshot.rawSignals.skuCount, 1);
});

test("a bare pcdetail response cannot borrow product identity from itemIdHint", async () => {
  const skuId = "6198474471056";
  const preview = await createLocalImport(`mtopjsonp1(${JSON.stringify(response(skuId, "199", "139", [
    { promotionName: "spsd4plan", amount: 6000 },
  ]))})`, { accountType: "normal", itemIdHint: "843315272519" });

  assert.equal(preview.canCommit, false);
  assert.equal(preview.itemId, "");
  assert.equal(preview.verifiedSkuCount, 0);
  assert.match(preview.warnings.join(" "), /商品 ID|SKU 证据不完整/);
});

test("a request and response SKU mismatch fails closed on the requested SKU identity", async () => {
  const itemId = "843315272520";
  const requestSkuId = "6198474471056";
  const responseSkuId = "6198474471057";
  const preview = await createLocalImport(JSON.stringify({
    itemId,
    request: {
      url: pcdetailUrl(itemId, requestSkuId),
      body: response(responseSkuId, "199", "139", [{ promotionName: "spsd4plan", amount: 6000 }]),
    },
  }), { accountType: "normal", itemIdHint: itemId });

  assert.equal(preview.canCommit, false);
  assert.equal(preview.skuCount, 1);
  assert.equal(preview.verifiedSkuCount, 0);
  assert.equal(preview.skuPrices[0].skuId, requestSkuId);
  assert.equal(preview.skuPrices[0].normalPrice, null);
  assert.equal(preview.skuPrices.some((sku) => sku.skuId === responseSkuId), false);
});

test("two observed SKUs remain visible when only one has verified price evidence", async () => {
  const itemId = "843315272523";
  const verifiedSkuId = "6274971435310";
  const missingSkuId = "6274971435311";
  const preview = await createLocalImport(JSON.stringify({
    itemId,
    skuBase: { props: [], skus: [{ skuId: verifiedSkuId, propPath: "" }, { skuId: missingSkuId, propPath: "" }] },
    skuCore: {
      sku2info: {
        [verifiedSkuId]: { price: { priceText: "199", priceTitle: "优惠前" } },
        [missingSkuId]: { price: { priceText: "229", priceTitle: "优惠前" } },
      },
    },
    request: {
      url: pcdetailUrl(itemId, verifiedSkuId),
      body: response(verifiedSkuId, "199", "139", [{ promotionName: "spsd4plan", amount: 6000 }]),
    },
  }), { accountType: "normal", itemIdHint: itemId });

  assert.equal(preview.canCommit, false);
  assert.equal(preview.resolutionStatus, "partial");
  assert.equal(preview.skuCount, 2);
  assert.equal(preview.verifiedSkuCount, 1);
  assert.equal(preview.skuPrices.length, 2);
  assert.equal(preview.skuPrices.find((sku) => sku.skuId === verifiedSkuId).normalPrice, 139);
  assert.equal(preview.skuPrices.find((sku) => sku.skuId === missingSkuId).normalPrice, null);
});

test("rejects oversized input before parsing or writing", async () => {
  await assert.rejects(
    createLocalImport("x".repeat(LOCAL_IMPORT_MAX_BYTES + 1), { accountType: "normal" }),
    (error) => error.code === "IMPORT_TOO_LARGE" && error.status === 413,
  );
});

test("rejects unsafe import IDs and invalid item ID hints", async () => {
  await assert.rejects(loadLocalImport("../db"), (error) => error.code === "INVALID_IMPORT_ID" && error.status === 400);
  await assert.rejects(
    loadLocalImport("local_00000000000000000000000000000000"),
    (error) => error.code === "IMPORT_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    createLocalImport("{}", { accountType: "normal", itemIdHint: "123/../../db" }),
    (error) => error.code === "INVALID_ITEM_ID" && error.status === 400,
  );
});

test("keeps a bounded number of local preview records", async () => {
  const directory = path.join(dataDir, "local-imports");
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: LOCAL_IMPORT_MAX_FILES + 1 }, (_, index) => {
    const filename = `local_${index.toString(16).padStart(32, "0")}.json`;
    return fs.writeFile(path.join(directory, filename), "{}", "utf8");
  }));

  const preview = await createLocalImport("{}", { accountType: "normal", itemIdHint: "843315272599" });
  const files = (await fs.readdir(directory)).filter((name) => /^local_[a-f0-9]{32}\.json$/.test(name));
  const sources = (await fs.readdir(directory)).filter((name) => /^local_[a-f0-9]{32}\.source\.txt$/.test(name));
  assert.equal(files.length, LOCAL_IMPORT_MAX_FILES);
  assert.ok(sources.length <= LOCAL_IMPORT_MAX_FILES);
  assert.equal(files.includes(`${preview.importId}.json`), true);
});

test("automatic evidence refuses a snapshot when any observed SKU is unverified", async () => {
  const itemId = "843315272588";
  const skuId = "6274971435888";
  const capturedAt = "2026-07-16T08:00:00.000Z";
  const resolution = {
    status: "verified",
    parserVersion: "evidence-test",
    evidenceHash: "evidence-hash",
    channels: {
      normal: { status: "verified", valueCents: 13900, formula: "标价 199.00 - 活动立减 60.00 = 普通价 139.00", evidenceIds: ["normal-evidence"] },
      gift: { status: "verified", valueCents: 11900, formula: "普通价 139.00 - 礼金 20.00 = 礼金价 119.00", evidenceIds: ["gift-evidence"] },
    },
  };
  await assert.rejects(saveCapturedSnapshotLocalEvidence({
    itemId,
    title: "自动证据测试商品",
    shopName: "测试店铺",
    model: "MODEL-1",
    capturedAt,
    parserVersion: "evidence-test",
    source: "browser",
    accessMode: "authenticated",
    primaryAccountType: "gift",
    primaryAccountSessionId: "real-session-secret",
    accountCaptures: [{ sessionId: "real-session-secret", accountName: "真实账号昵称", accountType: "gift" }],
    accountErrors: [{ sessionId: "other-secret", accountName: "失败账号", message: "cookie=sensitive" }],
    mainImage: "https://img.alicdn.com/private-main.jpg",
    buyerShows: [{ id: "buyer-secret", text: "不应保存", images: ["https://img.alicdn.com/buyer.jpg"], videoUrls: [] }],
    skuPrices: [{
      skuId,
      name: "白色 5L",
      image: "https://img.alicdn.com/private-sku.jpg",
      quantity: 12,
      normalPrice: 139,
      giftPrice: 119,
      resolutionStatus: "verified",
      priceResolution: resolution,
      priceEvidence: [{
        id: "normal-evidence",
        itemId,
        skuId,
        accountType: "gift",
        kind: "normal",
        valueCents: 13900,
        source: "api-formula",
        endpoint: "https://h5api.m.tmall.com/h5/price?sign=do-not-store&token=secret",
        sourcePath: "$.data.price",
        promotionCodes: ["spsd4plan"],
        selectedSkuVerified: true,
        capturedAt,
      }],
      accountPrices: [{
        sessionId: "real-session-secret",
        accountName: "真实账号昵称",
        accountType: "gift",
        capturedAt,
        normalPrice: 139,
        giftPrice: 119,
        resolutionStatus: "verified",
        priceResolution: resolution,
      }],
    }, {
      skuId: "unverified-sku",
      name: "未核验规格",
      normalPrice: 99,
      resolutionStatus: "ambiguous",
      priceResolution: { status: "ambiguous", channels: { normal: { status: "ambiguous", valueCents: null, evidenceIds: [] } } },
    }],
  }), (error) => error.code === "INCOMPLETE_CAPTURE_SNAPSHOT");
});

test("uses a writable custom evidence directory and only clears verified automatic records", async () => {
  const requestedDirectory = path.join(dataDir, "chosen-evidence");
  const directory = await validateLocalEvidenceDirectory(requestedDirectory);
  assert.equal(directory, await fs.realpath(requestedDirectory));
  await assert.rejects(validateLocalEvidenceDirectory("relative/evidence"), (error) => error.code === "INVALID_EVIDENCE_DIRECTORY");
  await updateDb((db) => {
    db.localEvidence = { directory };
    return db;
  });

  try {
    const itemId = "843315272566";
    const skuId = "6274971435666";
    const capturedAt = "2026-07-16T09:00:00.000Z";
    const resolution = {
      status: "verified",
      parserVersion: "evidence-test",
      channels: { normal: { status: "verified", valueCents: 13900, evidenceIds: ["normal-evidence"] } },
    };
    const preview = await saveCapturedSnapshotLocalEvidence({
      itemId,
      title: "自定义目录测试商品",
      capturedAt,
      parserVersion: "evidence-test",
      primaryAccountType: "normal",
      skuPrices: [{
        skuId,
        name: "标准规格",
        normalPrice: 139,
        resolutionStatus: "verified",
        priceResolution: resolution,
        priceEvidence: [{
          id: "normal-evidence",
          itemId,
          skuId,
          accountType: "normal",
          kind: "normal",
          valueCents: 13900,
          source: "api-formula",
          selectedSkuVerified: true,
          capturedAt,
        }],
      }],
    });
    assert.equal(preview.savedFile, path.join(directory, `${preview.importId}.json`));
    assert.equal((await loadLocalImportRecord(preview.importId)).origin, "automatic-capture");

    const manualId = `local_${"a".repeat(32)}`;
    const mismatchedFilenameId = `local_${"b".repeat(32)}`;
    const nestedId = `local_${"c".repeat(32)}`;
    await fs.writeFile(path.join(directory, `${manualId}.json`), JSON.stringify({ importId: manualId, origin: "manual-import" }), "utf8");
    await fs.writeFile(path.join(directory, `${mismatchedFilenameId}.json`), JSON.stringify({ importId: nestedId, origin: "automatic-capture" }), "utf8");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested", `${nestedId}.json`), JSON.stringify({ importId: nestedId, origin: "automatic-capture" }), "utf8");

    const overview = await getLocalEvidenceStorageOverview(directory);
    assert.equal(overview.directory, directory);
    assert.equal(overview.fileCount, 1);
    assert.ok(overview.totalBytes > 0);

    const cleared = await clearLocalEvidenceFiles(directory);
    assert.equal(cleared.deletedCount, 1);
    assert.deepEqual(cleared.deletedImportIds, [preview.importId]);
    assert.equal(cleared.fileCount, 0);
    await assert.rejects(fs.access(preview.savedFile), (error) => error.code === "ENOENT");
    await fs.access(path.join(directory, `${manualId}.json`));
    await fs.access(path.join(directory, `${mismatchedFilenameId}.json`));
    await fs.access(path.join(directory, "nested", `${nestedId}.json`));
  } finally {
    await updateDb((db) => {
      db.localEvidence = { directory: "" };
      return db;
    });
  }
});
