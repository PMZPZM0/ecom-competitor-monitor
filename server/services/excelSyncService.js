import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { dbRuntimeInfo, readDb } from "../storage/db.js";
import { PRICE_PROMOTION_INDEX } from "./priceResolver.js";

const WORKBOOK_NAME = "电商竞品监控-价格自动同步.xlsx";
const PRICE_INDEX_NAME = "电商竞品监控-价格索引.json";
const CHANNEL_KINDS = ["normal", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"];
const channelFields = [
  ["标价", "originalPrice", "list"],
  ["普通价", "normalPrice", "normal"],
  ["百亿补贴价", "billionPrice", "billion"],
  ["淘宝秒杀价", "seckillPrice", "seckill"],
  ["国补价", "governmentPrice", "government"],
  ["惊喜立减价", "surprisePrice", "surprise"],
  ["新客礼金价", "giftPrice", "gift"],
  ["88VIP价", "vipPrice", "vip88"],
  ["淘金币价", "coinPrice", "coin"],
];
let runtimeStatus = { lastSyncedAt: null, lastError: "", calculationMs: null, indexLookupMs: null, workbookMs: null };

function outputDirectory(db) {
  const configured = String(db?.localEvidence?.directory || "").trim();
  return configured && path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.join(dbRuntimeInfo().dataDir, "exports");
}

export function excelSyncPath(db) {
  return path.join(outputDirectory(db), WORKBOOK_NAME);
}

export function priceIndexPath(db) {
  return path.join(outputDirectory(db), PRICE_INDEX_NAME);
}

function verifiedPrice(value, status) {
  const price = Number(value);
  return status === "verified" && Number.isFinite(price) && price > 0 ? price : null;
}

function primaryView(product, snapshot, sku) {
  return {
    accountName: "主账号",
    accountType: snapshot.primaryAccountType || product.accountType || "normal",
    capturedAt: snapshot.capturedAt,
    ...sku,
  };
}

function accountViews(product, snapshot, sku) {
  const views = Array.isArray(sku.accountPrices) && sku.accountPrices.length
    ? sku.accountPrices
    : [primaryView(product, snapshot, sku)];
  return views.map((view) => ({ product, snapshot, sku, view }));
}

function verifiedChannelValue(view, field, kind) {
  if (field === "originalPrice") {
    const listEvidence = (view.priceResolution?.evidence || []).find((item) => item.kind === "list");
    const evidenceValue = Number(listEvidence?.valueCents) / 100;
    if (Number.isFinite(evidenceValue) && evidenceValue > 0) return evidenceValue;
    return Number(view.originalPrice) > 0 ? Number(view.originalPrice) : null;
  }
  return verifiedPrice(view[field], view.priceResolution?.channels?.[kind]?.status);
}

function lowestVerified(view) {
  const values = channelFields
    .filter(([, field]) => field !== "originalPrice")
    .map(([, field, kind]) => verifiedChannelValue(view, field, kind))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}

function formulaSummary(view) {
  return Object.values(view.priceCalculation || {}).filter(Boolean).join("；");
}

function entryIdentity(product, snapshot, sku, view) {
  const itemId = String(snapshot.itemId || product.itemId || "");
  const skuId = String(sku.skuId || "");
  const accountType = view.accountType || snapshot.primaryAccountType || product.accountType || "normal";
  return {
    capturedAt: new Date(view.capturedAt || snapshot.capturedAt || Date.now()),
    productName: product.name || snapshot.title || "",
    shopName: snapshot.shopName || product.shopName || "",
    model: snapshot.model || product.model || "",
    itemId,
    skuId,
    skuName: sku.name || "",
    accountName: view.accountName || "主账号",
    accountType,
    lookupKey: `${itemId}|${skuId}|${accountType}`,
  };
}

function entryFor(product, snapshot, sku, view) {
  const identity = entryIdentity(product, snapshot, sku, view);
  const prices = Object.fromEntries(channelFields.map(([, field, kind]) => [kind, verifiedChannelValue(view, field, kind)]));
  const promotions = (view.priceResolution?.promotions || view.priceResolution?.formulaInputs?.promotions || [])
    .filter((item) => item && item.code != null && Number.isSafeInteger(Number(item.amountCents)) && Number(item.amountCents) > 0)
    .map((item) => ({
      code: String(item.code),
      amountCents: Number(item.amountCents),
      sourceKind: String(item.kind || "unknown"),
      sourceLabel: String(item.label || ""),
    }));
  return {
    ...identity,
    prices,
    displayedPrice: Number.isSafeInteger(view.priceResolution?.displayedCents)
      ? view.priceResolution.displayedCents / 100
      : null,
    lowest: lowestVerified(view),
    resolutionStatus: view.resolutionStatus || sku.resolutionStatus || view.priceResolution?.status || "unavailable",
    formulaSummary: formulaSummary(view),
    channelFormulas: Object.fromEntries(CHANNEL_KINDS.map((kind) => [kind, String(view.priceResolution?.channels?.[kind]?.formula || "")])),
    evidenceFile: snapshot.browserEvidenceFile || "",
    promotions,
  };
}

export function buildPriceIndexRows(entries) {
  const latestByKey = new Map();
  const ordered = [...entries].sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime());
  for (const entry of ordered) {
    for (const [label, , kind] of channelFields) {
      const key = `${entry.lookupKey}|${kind}`;
      if (latestByKey.has(key)) continue;
      const value = Number(entry.prices[kind]);
      const verified = Number.isFinite(value) && value > 0;
      latestByKey.set(key, {
        key,
        lookupKey: entry.lookupKey,
        itemId: entry.itemId,
        skuId: entry.skuId,
        accountType: entry.accountType,
        channel: kind,
        channelLabel: label,
        value: verified ? value : null,
        status: verified ? "verified" : "unavailable",
        formula: kind === "list" ? (verified ? "页面明确标价" : "") : entry.channelFormulas?.[kind] || "",
        capturedAt: entry.capturedAt,
        evidenceFile: entry.evidenceFile,
      });
    }
  }
  return [...latestByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function benchmarkPriceIndex(entries, rows = buildPriceIndexRows(entries), iterations = 100) {
  const index = new Map(rows.map((row) => [row.key, row]));
  const keys = entries.flatMap((entry) => channelFields.map(([, , kind]) => `${entry.lookupKey}|${kind}`));
  const started = performance.now();
  let hits = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const key of keys) if (index.get(key)?.status === "verified") hits += 1;
  }
  return {
    rows: rows.length,
    lookups: keys.length * iterations,
    hits,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

function currentEntries(db) {
  return (db.products || []).flatMap((product) => {
    const snapshot = product.lastSnapshot;
    if (!snapshot) return [];
    return (snapshot.skuPrices || []).flatMap((sku) => accountViews(product, snapshot, sku)
      .map(({ view }) => entryFor(product, snapshot, sku, view)));
  });
}

function historyEntries(db) {
  const products = new Map((db.products || []).map((product) => [product.id, product]));
  return (db.snapshots || []).flatMap((snapshot) => {
    const product = products.get(snapshot.productId) || { id: snapshot.productId, accountType: snapshot.primaryAccountType };
    return (snapshot.skuPrices || []).flatMap((sku) => accountViews(product, snapshot, sku)
      .map(({ view }) => entryFor(product, snapshot, sku, view)));
  });
}

function priceLookupFormula(row, indexEnd, kind) {
  return `XLOOKUP($J${row}&"|${kind}",'价格索引'!$A$2:$A$${indexEnd},'价格索引'!$I$2:$I$${indexEnd},"")`;
}

function priceRow(entry, row, indexEnd, indexed = false) {
  const indexedPrices = channelFields.map(([, , kind]) => indexed
    ? formulaValue(priceLookupFormula(row, indexEnd, kind), entry.prices[kind])
    : entry.prices[kind]);
  return [
    entry.capturedAt, entry.productName, entry.shopName, entry.model, entry.itemId, entry.skuId,
    entry.skuName, entry.accountName, entry.accountType, entry.lookupKey,
    ...indexedPrices,
    indexed ? formulaValue(`IF(COUNT(L${row}:S${row})=0,"",MIN(L${row}:S${row}))`, entry.lowest) : entry.lowest,
    entry.resolutionStatus, entry.formulaSummary, entry.evidenceFile,
  ];
}

function promotionRule(code) {
  const rule = PRICE_PROMOTION_INDEX.get(String(code));
  return rule || { kind: "unknown", label: "未匹配优惠码", accounts: null };
}

function promotionEligible(rule, accountType) {
  return !(rule.accounts instanceof Set) || rule.accounts.has(accountType);
}

function promotionRows(entries) {
  return entries.flatMap((entry) => entry.promotions.map((promotion) => {
    const rule = promotionRule(promotion.code);
    return {
      capturedAt: entry.capturedAt,
      lookupKey: entry.lookupKey,
      itemId: entry.itemId,
      skuId: entry.skuId,
      accountType: entry.accountType,
      code: promotion.code,
      amount: promotion.amountCents / 100,
      sourceKind: promotion.sourceKind,
      ruleKind: rule.kind,
      ruleLabel: rule.label,
      ruleAccounts: rule.accounts instanceof Set ? [...rule.accounts].join("、") : "全部",
      eligible: promotionEligible(rule, entry.accountType),
    };
  }));
}

function sumsForEntry(entry) {
  const sums = Object.fromEntries(["public", "billion", "seckill", "government", "surprise", "gift", "vip88", "coin"].map((kind) => [kind, 0]));
  for (const promotion of entry.promotions) {
    const rule = promotionRule(promotion.code);
    if (!promotionEligible(rule, entry.accountType) || !(rule.kind in sums)) continue;
    sums[rule.kind] += promotion.amountCents / 100;
  }
  return sums;
}

function subtract(base, amount) {
  return Number.isFinite(base) && amount > 0 ? Math.round((base - amount) * 100) / 100 : null;
}

export function calculateFormulaEntry(entry) {
  const sums = sumsForEntry(entry);
  const list = entry.prices.list;
  const normal = Number.isFinite(list) ? Math.round((list - sums.public) * 100) / 100 : null;
  const billion = subtract(normal, sums.billion);
  const seckill = subtract(normal, sums.seckill);
  const campaignBase = billion ?? seckill ?? normal;
  const government = subtract(campaignBase, sums.government);
  const governmentBase = government ?? campaignBase;
  const surprise = subtract(governmentBase, sums.surprise);
  const surpriseBase = surprise ?? governmentBase;
  const gift = subtract(surpriseBase, sums.gift);
  const giftBase = gift ?? surpriseBase;
  const vip88 = subtract(giftBase, sums.vip88);
  const vipBase = vip88 ?? giftBase;
  const coin = subtract(vipBase, sums.coin);
  const final = coin ?? vip88 ?? gift ?? surprise ?? government ?? billion ?? seckill ?? normal;
  return { sums, calculated: { normal, billion, seckill, government, surprise, gift, vip88, coin, final } };
}

function sameCent(left, right) {
  if (left == null && right == null) return true;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.round(left * 100) === Math.round(right * 100);
}

export function benchmarkFormulaEntries(entries, iterations = 1) {
  const started = performance.now();
  let verified = 0;
  let mismatched = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const entry of entries) {
      const result = calculateFormulaEntry(entry);
      const checks = CHANNEL_KINDS.map((kind) => sameCent(result.calculated[kind], entry.prices[kind]));
      if (checks.every(Boolean)) verified += 1;
      else mismatched += 1;
    }
  }
  return { rows: entries.length, iterations, verified, mismatched, elapsedMs: Number((performance.now() - started).toFixed(3)) };
}

export function buildExcelSyncDataset(db) {
  const current = currentEntries(db);
  return {
    current,
    history: historyEntries(db),
    promotions: promotionRows(current),
  };
}

function headerStyle(row, color = "FF1F4E78") {
  row.height = 26;
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  row.alignment = { vertical: "middle" };
}

function stripeRows(sheet) {
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    row.alignment = { vertical: "middle", wrapText: false };
    if (index % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F8FB" } };
  });
}

function stylePriceSheet(sheet, rowCount) {
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  sheet.autoFilter = { from: "A1", to: `W${Math.max(1, rowCount + 1)}` };
  headerStyle(sheet.getRow(1));
  sheet.getColumn(1).numFmt = "yyyy-mm-dd hh:mm:ss";
  for (let column = 11; column <= 20; column += 1) sheet.getColumn(column).numFmt = "¥#,##0.00";
  const widths = [20, 28, 18, 16, 16, 18, 26, 16, 12, 42, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 14, 48, 38];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  stripeRows(sheet);
}

function addPriceSheet(workbook, name, entries, { indexRowCount = 0, indexed = false } = {}) {
  const sheet = workbook.addWorksheet(name, { properties: { showGridLines: false } });
  sheet.addRow([
    "更新时间", "商品名", "店铺", "型号", "商品ID", "SKU ID", "SKU名称", "账号", "账号类型", "查找键",
    ...channelFields.map(([label]) => label), "最低已验证价", "解析状态", "价格公式", "本地证据文件",
  ]);
  const indexEnd = Math.max(2, indexRowCount + 1);
  entries.forEach((entry, index) => sheet.addRow(priceRow(entry, index + 2, indexEnd, indexed)));
  stylePriceSheet(sheet, entries.length);
  return sheet;
}

function addPriceIndexSheet(workbook, rows) {
  const sheet = workbook.addWorksheet("价格索引", { properties: { showGridLines: false } });
  sheet.addRow(["唯一索引键", "查找键", "商品ID", "SKU ID", "账号类型", "价格通道", "通道名称", "验证状态", "价格", "更新时间", "闭合公式", "本地证据文件"]);
  rows.forEach((item) => sheet.addRow([
    item.key, item.lookupKey, item.itemId, item.skuId, item.accountType, item.channel, item.channelLabel,
    item.status, item.value, item.capturedAt, item.formula, item.evidenceFile,
  ]));
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  sheet.autoFilter = { from: "A1", to: `L${Math.max(1, rows.length + 1)}` };
  headerStyle(sheet.getRow(1), "FF0F766E");
  sheet.getColumn(9).numFmt = "¥#,##0.00";
  sheet.getColumn(10).numFmt = "yyyy-mm-dd hh:mm:ss";
  [48, 42, 16, 18, 12, 14, 18, 14, 13, 20, 56, 38].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  stripeRows(sheet);
  return sheet;
}

function addRuleSheet(workbook) {
  const sheet = workbook.addWorksheet("优惠码规则", { properties: { showGridLines: false } });
  sheet.addRow(["优惠码", "价格通道", "显示名称", "适用账号"]);
  for (const [code, rule] of PRICE_PROMOTION_INDEX) {
    sheet.addRow([code, rule.kind, rule.label, rule.accounts instanceof Set ? [...rule.accounts].join("、") : "全部"]);
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `D${PRICE_PROMOTION_INDEX.size + 1}` };
  headerStyle(sheet.getRow(1), "FF2F6B4F");
  [28, 16, 28, 24].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  stripeRows(sheet);
  return sheet;
}

function formulaValue(formula, result) {
  return { formula, result: result ?? "" };
}

function addRawPromotionSheet(workbook, rows) {
  const sheet = workbook.addWorksheet("原始优惠数据", { properties: { showGridLines: false } });
  sheet.addRow(["采集时间", "查找键", "商品ID", "SKU ID", "账号类型", "优惠码", "优惠金额", "源数据类型", "公式匹配通道", "公式匹配名称", "适用账号", "当前账号适用性"]);
  const ruleEnd = PRICE_PROMOTION_INDEX.size + 1;
  rows.forEach((item, index) => {
    const row = index + 2;
    sheet.addRow([
      item.capturedAt, item.lookupKey, item.itemId, item.skuId, item.accountType, item.code, item.amount, item.sourceKind,
      formulaValue(`XLOOKUP(F${row},'优惠码规则'!$A$2:$A$${ruleEnd},'优惠码规则'!$B$2:$B$${ruleEnd},"unknown",0)`, item.ruleKind),
      formulaValue(`XLOOKUP(F${row},'优惠码规则'!$A$2:$A$${ruleEnd},'优惠码规则'!$C$2:$C$${ruleEnd},"未匹配优惠码",0)`, item.ruleLabel),
      formulaValue(`XLOOKUP(F${row},'优惠码规则'!$A$2:$A$${ruleEnd},'优惠码规则'!$D$2:$D$${ruleEnd},"全部",0)`, item.ruleAccounts),
      formulaValue(`IF(OR(K${row}="全部",ISNUMBER(SEARCH(E${row},K${row}))),"适用","不适用")`, item.eligible ? "适用" : "不适用"),
    ]);
  });
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  sheet.autoFilter = { from: "A1", to: `L${Math.max(1, rows.length + 1)}` };
  headerStyle(sheet.getRow(1), "FF7A4E13");
  sheet.getColumn(1).numFmt = "yyyy-mm-dd hh:mm:ss";
  sheet.getColumn(7).numFmt = "¥#,##0.00";
  [20, 42, 16, 18, 12, 28, 13, 16, 16, 24, 24, 16].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  stripeRows(sheet);
  return sheet;
}

function sumifsFormula(rawEnd, row, kind) {
  return `SUMIFS('原始优惠数据'!$G$2:$G$${rawEnd},'原始优惠数据'!$B$2:$B$${rawEnd},$F${row},'原始优惠数据'!$I$2:$I$${rawEnd},"${kind}",'原始优惠数据'!$L$2:$L$${rawEnd},"适用")`;
}

function checkFormula(calculatedColumn, appColumn, row) {
  return `IF(AND(${calculatedColumn}${row}="",${appColumn}${row}=""),"一致",IF(OR(${calculatedColumn}${row}="",${appColumn}${row}=""),"缺失",IF(ROUND(${calculatedColumn}${row}*100,0)=ROUND(${appColumn}${row}*100,0),"一致","不一致")))`;
}

function addFormulaSheet(workbook, entries, rawRowCount) {
  const sheet = workbook.addWorksheet("公式计算", { properties: { showGridLines: false } });
  sheet.addRow([
    "更新时间", "商品名", "商品ID", "SKU ID", "账号类型", "查找键", "标价", "页面最终价", "公共优惠", "百亿优惠", "秒杀优惠", "国补优惠", "惊喜立减", "礼金优惠", "88VIP优惠", "淘金币优惠",
    "公式普通价", "公式百亿价", "公式秒杀价", "公式国补价", "公式惊喜价", "公式礼金价", "公式88VIP价", "公式淘金币价", "公式最终价",
    "应用普通价", "应用百亿价", "应用秒杀价", "应用国补价", "应用惊喜价", "应用礼金价", "应用88VIP价", "应用淘金币价",
    "普通校验", "百亿校验", "秒杀校验", "国补校验", "惊喜校验", "礼金校验", "88VIP校验", "淘金币校验", "页面闭合", "总校验", "解析状态", "本地证据文件",
  ]);
  const rawEnd = Math.max(2, rawRowCount + 1);
  entries.forEach((entry, index) => {
    const row = index + 2;
    const { sums, calculated } = calculateFormulaEntry(entry);
    const sum = (kind) => formulaValue(`${sumifsFormula(rawEnd, row, kind)}`, sums[kind]);
    const calculatedValues = {
      normal: formulaValue(`IF(G${row}="","",ROUND(G${row}-I${row},2))`, calculated.normal),
      billion: formulaValue(`IF(J${row}>0,ROUND(Q${row}-J${row},2),"")`, calculated.billion),
      seckill: formulaValue(`IF(K${row}>0,ROUND(Q${row}-K${row},2),"")`, calculated.seckill),
      government: formulaValue(`IF(L${row}>0,ROUND(IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row}))-L${row},2),"")`, calculated.government),
      surprise: formulaValue(`IF(M${row}>0,ROUND(IF(T${row}<>"",T${row},IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row})))-M${row},2),"")`, calculated.surprise),
      gift: formulaValue(`IF(N${row}>0,ROUND(IF(U${row}<>"",U${row},IF(T${row}<>"",T${row},IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row}))))-N${row},2),"")`, calculated.gift),
      vip88: formulaValue(`IF(O${row}>0,ROUND(IF(V${row}<>"",V${row},IF(U${row}<>"",U${row},IF(T${row}<>"",T${row},IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row})))))-O${row},2),"")`, calculated.vip88),
      coin: formulaValue(`IF(P${row}>0,ROUND(IF(W${row}<>"",W${row},IF(V${row}<>"",V${row},IF(U${row}<>"",U${row},IF(T${row}<>"",T${row},IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row}))))))-P${row},2),"")`, calculated.coin),
    };
    const checks = CHANNEL_KINDS.map((kind) => sameCent(calculated[kind], entry.prices[kind]) ? "一致" : (calculated[kind] == null || entry.prices[kind] == null ? "缺失" : "不一致"));
    const pageClosure = entry.displayedPrice == null ? "无页面最终价" : sameCent(calculated.final, entry.displayedPrice) ? "闭合" : "不闭合";
    const totalCheck = entry.resolutionStatus !== "verified" ? "待核验" : checks.every((value) => value === "一致") && pageClosure !== "不闭合" ? "通过" : "异常";
    sheet.addRow([
      entry.capturedAt, entry.productName, entry.itemId, entry.skuId, entry.accountType, entry.lookupKey, entry.prices.list, entry.displayedPrice,
      sum("public"), sum("billion"), sum("seckill"), sum("government"), sum("surprise"), sum("gift"), sum("vip88"), sum("coin"),
      calculatedValues.normal, calculatedValues.billion, calculatedValues.seckill, calculatedValues.government, calculatedValues.surprise, calculatedValues.gift, calculatedValues.vip88, calculatedValues.coin,
      formulaValue(`IF(X${row}<>"",X${row},IF(W${row}<>"",W${row},IF(V${row}<>"",V${row},IF(U${row}<>"",U${row},IF(T${row}<>"",T${row},IF(R${row}<>"",R${row},IF(S${row}<>"",S${row},Q${row})))))))`, calculated.final),
      ...CHANNEL_KINDS.map((kind) => entry.prices[kind]),
      formulaValue(checkFormula("Q", "Z", row), checks[0]),
      formulaValue(checkFormula("R", "AA", row), checks[1]),
      formulaValue(checkFormula("S", "AB", row), checks[2]),
      formulaValue(checkFormula("T", "AC", row), checks[3]),
      formulaValue(checkFormula("U", "AD", row), checks[4]),
      formulaValue(checkFormula("V", "AE", row), checks[5]),
      formulaValue(checkFormula("W", "AF", row), checks[6]),
      formulaValue(checkFormula("X", "AG", row), checks[7]),
      formulaValue(`IF(H${row}="","无页面最终价",IF(ROUND(Y${row}*100,0)=ROUND(H${row}*100,0),"闭合","不闭合"))`, pageClosure),
      formulaValue(`IF(AR${row}<>"verified","待核验",IF(AND(AH${row}="一致",AI${row}="一致",AJ${row}="一致",AK${row}="一致",AL${row}="一致",AM${row}="一致",AN${row}="一致",AO${row}="一致",AP${row}<>"不闭合"),"通过","异常"))`, totalCheck),
      entry.resolutionStatus, entry.evidenceFile,
    ]);
  });
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 6 }];
  sheet.autoFilter = { from: "A1", to: `AS${Math.max(1, entries.length + 1)}` };
  headerStyle(sheet.getRow(1), "FF5A3D8A");
  sheet.getColumn(1).numFmt = "yyyy-mm-dd hh:mm:ss";
  for (let column = 7; column <= 33; column += 1) sheet.getColumn(column).numFmt = "¥#,##0.00";
  const widths = [20, 28, 16, 18, 12, 42, ...Array(27).fill(13), ...Array(10).fill(12), 12, 36];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  stripeRows(sheet);
  return sheet;
}

async function replaceFileAtomic(destination, buffer) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, buffer);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
      const locked = new Error("Excel 工作簿正在被占用，已保留本次价格数据；关闭 Excel 后点击重新同步即可。");
      locked.code = "EXCEL_FILE_LOCKED";
      throw locked;
    }
    throw error;
  }
}

export async function syncPriceWorkbook(dbDocument = null) {
  const db = dbDocument || await readDb();
  const started = performance.now();
  try {
    const calculationStarted = performance.now();
    const dataset = buildExcelSyncDataset(db);
    const benchmark = benchmarkFormulaEntries(dataset.current);
    const indexRows = buildPriceIndexRows(dataset.current);
    const indexBenchmark = benchmarkPriceIndex(dataset.current, indexRows);
    const calculationMs = Number((performance.now() - calculationStarted).toFixed(3));
    const indexDestination = priceIndexPath(db);
    await replaceFileAtomic(indexDestination, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      keyFormat: "itemId|skuId|accountType|channel",
      rows: indexRows,
    }, null, 2)));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "电商竞品监控";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;
    addPriceIndexSheet(workbook, indexRows);
    addPriceSheet(workbook, "当前价格", dataset.current, { indexRowCount: indexRows.length, indexed: true });
    addPriceSheet(workbook, "价格历史", dataset.history);
    addRawPromotionSheet(workbook, dataset.promotions);
    addRuleSheet(workbook);
    addFormulaSheet(workbook, dataset.current, dataset.promotions.length);
    const status = workbook.addWorksheet("同步说明", { properties: { showGridLines: false } });
    status.addRows([
      ["电商竞品监控 · 本地 Excel 公式引擎", ""],
      ["最后同步", new Date()],
      ["当前价格行数", dataset.current.length],
      ["历史价格行数", dataset.history.length],
      ["原始优惠行数", dataset.promotions.length],
      ["内存公式测算", `${benchmark.elapsedMs.toFixed(3)} ms / ${dataset.current.length} 行`],
      ["本地索引查找", `${indexBenchmark.elapsedMs.toFixed(3)} ms / ${indexBenchmark.lookups} 次查找`],
      ["索引文件", indexDestination],
      ["Excel 公式链", "原始优惠数据.XLOOKUP 匹配优惠码 → 公式计算.SUMIFS 按商品/SKU/账号汇总 → 逐通道计算 → 精确到分校验"],
      ["自动同步", "每次保存价格后原子更新本地价格索引与 Excel；当前价格通过 XLOOKUP 从唯一索引键自动回填。"],
      ["安全规则", "Excel 只读取本地已脱敏证据的解析结果；未验证、缺失或冲突证据不会变成可展示或可提醒价格。"],
    ]);
    status.mergeCells("A1:B1");
    status.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    status.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    status.getColumn(1).width = 22;
    status.getColumn(2).width = 92;
    status.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    status.getCell("B2").numFmt = "yyyy-mm-dd hh:mm:ss";
    const destination = excelSyncPath(db);
    await replaceFileAtomic(destination, await workbook.xlsx.writeBuffer());
    const workbookMs = Number((performance.now() - started).toFixed(3));
    const result = {
      path: destination,
      currentRows: dataset.current.length,
      historyRows: dataset.history.length,
      promotionRows: dataset.promotions.length,
      indexRows: indexRows.length,
      indexPath: indexDestination,
      indexLookupMs: indexBenchmark.elapsedMs,
      calculationMs,
      workbookMs,
      syncedAt: new Date().toISOString(),
    };
    runtimeStatus = { lastSyncedAt: result.syncedAt, lastError: "", calculationMs, indexLookupMs: result.indexLookupMs, workbookMs };
    return result;
  } catch (error) {
    runtimeStatus = { ...runtimeStatus, lastError: String(error?.message || "Excel 自动同步失败。") };
    throw error;
  }
}

export async function getExcelSyncStatus() {
  const db = await readDb();
  const destination = excelSyncPath(db);
  const indexDestination = priceIndexPath(db);
  let stat = null;
  let indexStat = null;
  try {
    stat = await fs.stat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    indexStat = await fs.stat(indexDestination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    enabled: true,
    path: destination,
    exists: Boolean(stat?.isFile()),
    size: stat?.size || 0,
    modifiedAt: stat?.mtime?.toISOString() || null,
    indexPath: indexDestination,
    indexExists: Boolean(indexStat?.isFile()),
    indexSize: indexStat?.size || 0,
    ...runtimeStatus,
  };
}
