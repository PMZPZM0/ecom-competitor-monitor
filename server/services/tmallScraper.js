import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { getRenderedHtml } from "./browserService.js";

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function cleanImage(url) {
  if (!url) return "";
  if (typeof url !== "string") {
    url = url.url || url.src || url.image || url.img || url.pic || "";
  }
  if (!url || typeof url !== "string") return "";
  const decoded = url.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  const normalized = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  return normalized
    .replace(/^http:\/\//i, "https://")
    .replace(/_(\d+x\d+|\.webp).*$/i, "")
    .replace(/_(q\d+|sum|webp)\.(jpg|jpeg|png|webp)$/i, ".$2")
    .replace(/\.(jpg|jpeg|png|webp)\.\1(?=([?#]|$))/i, ".$1")
    .replace(/[?#].*$/, "");
}

function cookieValue(cookieHeader, name) {
  const match = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] || "";
}

function mergeSetCookie(cookieHeader, setCookieHeader) {
  const cookies = new Map();
  for (const part of String(cookieHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  for (const part of String(setCookieHeader || "").split(",")) {
    const match = part.match(/^\s*([^=;,\s]+)=([^;]*)/);
    if (match) cookies.set(match[1], match[2].trim());
  }
  return Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

function mobileApiHost(productUrl) {
  try {
    return new URL(productUrl).hostname.match(/(?:^|\\.)([a-z0-9-]+\\.(?:com|hk))$/i)?.[1] || "tmall.com";
  } catch {
    return "tmall.com";
  }
}

async function fetchMobileDetailData(itemId, authSession, productUrl) {
  if (!itemId || !authSession?.cookie) return null;

  const api = `https://h5api.m.${mobileApiHost(productUrl)}/h5/mtop.taobao.detail.getdetail/6.0/`;
  const data = JSON.stringify({ itemNumId: String(itemId), fun: "_getMobileItemDetail" });
  let cookie = authSession.cookie;
  let token = cookieValue(cookie, "_m_h5_tk");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = String(Date.now());
    const params = {
      jsv: "2.7.0",
      appKey: "12574478",
      t: timestamp,
      api: "mtop.taobao.detail.getdetail",
      v: "6.0",
      ttid: "202012@taobao_h5_9.17.0",
      ecode: "0",
      isSec: "0",
      AntiFlood: "true",
      AntiCreep: "true",
      H5Request: "true",
      data,
    };
    if (token) {
      params.sign = crypto.createHash("md5").update([token.split("_")[0], timestamp, params.appKey, data].join("&")).digest("hex");
    }

    try {
      const response = await fetch(`${api}?${new URLSearchParams(params)}`, {
        headers: {
          cookie,
          referer: productUrl,
          "user-agent": userAgent,
          accept: "application/json,text/plain,*/*",
        },
      });
      cookie = mergeSetCookie(cookie, response.headers.get("set-cookie"));
      token = cookieValue(cookie, "_m_h5_tk");
      const body = await response.text();
      const parsed = JSON.parse(body);
      if (parsed?.ret?.some((value) => /SUCCESS/i.test(value)) && parsed.data?.item?.images?.length) return parsed.data;
    } catch {
      // The PC page remains usable when the optional mobile detail request is unavailable.
    }
  }

  return null;
}

function parseTmallRateBody(body) {
  const source = String(body || "").trim();
  const json = source.startsWith("{") ? source : source.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/)?.[1];
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed?.rateDetail || parsed?.data?.rateDetail || parsed?.data || null;
  } catch {
    return null;
  }
}

export function buyerShowsFromRateDetail(rateDetail) {
  const listCandidates = [
    rateDetail?.rateList,
    rateDetail?.rateList?.rate,
    rateDetail?.rateList?.list,
    rateDetail?.commentList,
    rateDetail?.comments,
    rateDetail?.data?.rateList,
    rateDetail?.data?.commentList,
  ];
  const rateList = listCandidates.find(Array.isArray) || [];
  const collectMedia = (values, keyPattern) => values
    .flatMap((value) => payloadMediaValues(value, keyPattern))
    .filter(Boolean);

  return rateList.map((rate, index) => {
    const appends = [rate.appendComment, rate.appendRate, rate.additionalComment].flat().filter(Boolean);
    const text = [
      rate.rateContent, rate.reviewContent, rate.commentContent, rate.content,
      ...appends.flatMap((append) => [append.content, append.rateContent, append.reviewContent, append.commentContent]),
    ].map(cleanText).filter(Boolean).join("\n").slice(0, 1200);
    const imageValues = collectMedia([
      rate.pics, rate.picsSmall, rate.picList, rate.pictureList, rate.images, rate.photos,
      ...appends.flatMap((append) => [append.pics, append.picsSmall, append.picList, append.pictureList, append.images, append.photos]),
    ], /url|src|pic|image|photo|big|small/i);
    const videoValues = collectMedia([
      rate.videoList, rate.videos, rate.video, rate.videoInfo,
      ...appends.flatMap((append) => [append.videoList, append.videos, append.video, append.videoInfo]),
    ], /url|src|video|play/i);
    const images = Array.from(new Set(imageValues.map(cleanImage).filter(isCommerceImage))).slice(0, 30);
    const videoUrls = Array.from(new Set(videoValues.map(cleanBuyerShowVideo).filter(Boolean))).slice(0, 10);
    return {
      id: String(rate.id || rate.rateId || rate.commentId || `rate-${index + 1}`),
      text,
      images,
      videoUrls,
      author: cleanText(rate.displayUserNick || rate.userNick || rate.author || ""),
      sku: cleanText(rate.auctionSku || rate.skuInfo || rate.sku || ""),
      createdAt: cleanText(rate.rateDate || rate.createTime || rate.createdAt || ""),
    };
  }).filter((item) => item.text || item.images.length || item.videoUrls.length);
}

async function fetchTmallBuyerShows(itemId, sellerId, cookie, referer) {
  if (!itemId || !sellerId) return [];
  const collected = [];
  // Fetch media reviews first. A second pass fills in useful text reviews when
  // Tmall exposes picture and content filters as separate result sets.
  const filters = [{ picture: "1", content: "" }, { picture: "", content: "1" }];
  for (const filter of filters) {
    let filterCount = 0;
    for (let page = 1; page <= 5 && collected.length < 100; page += 1) {
      const query = new URLSearchParams({
        itemId: String(itemId), sellerId: String(sellerId), order: "3", currentPage: String(page),
        append: "0", content: filter.content, picture: filter.picture, callback: `jsonp${Date.now()}_${page}`,
      });
      try {
        const response = await fetch(`https://rate.tmall.com/list_detail_rate.htm?${query}`, {
          headers: { cookie: cookie || "", referer, "user-agent": userAgent, accept: "application/json,text/javascript,*/*" },
          signal: AbortSignal.timeout(12_000),
        });
        const detail = parseTmallRateBody(await response.text());
        const items = buyerShowsFromRateDetail(detail);
        if (!items.length) break;
        collected.push(...items);
        filterCount += items.length;
        const total = Number(detail?.rateCount?.total || detail?.rateCount || 0);
        if ((total && filterCount >= total) || items.length < 10) break;
        await new Promise((resolve) => setTimeout(resolve, 180));
      } catch {
        break;
      }
    }
  }
  return Array.from(new Map(collected.map((item) => [
    item.id && !/^rate-\d+$/.test(item.id) ? `id:${item.id}` : `${item.text}|${item.images.join(",")}|${item.videoUrls.join(",")}`,
    item,
  ])).values()).slice(0, 100);
}

function imageKey(url) {
  return cleanImage(url)
    .replace(/^https?:\/\/(?:gw|img)\.alicdn\.com/i, "alicdn")
    .replace(/\.(jpg|jpeg|png|webp)\.\1$/i, ".$1")
    .toLowerCase();
}

function extractSellerId(html, images = []) {
  const source = String(html || "").replace(/&quot;|&#34;/gi, '"');
  const direct = source.match(/["']sellerId["']\s*[:=]\s*["']?(\d{6,16})/i)?.[1]
    || source.match(/sellerId\\?"?\s*[:=]\s*\\?["']?(\d{6,16})/i)?.[1];
  if (direct) return direct;
  for (const image of images) {
    const owner = String(image || "").match(/\/i\d\/(\d{6,16})\//i)?.[1];
    if (owner && !owner.startsWith("600000")) return owner;
  }
  return "";
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values.filter(Boolean)) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function cleanBuyerShowVideo(value) {
  const raw = typeof value === "string" ? value : value?.url || value?.src || value?.video || "";
  if (!raw) return "";
  try {
    const parsed = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (parsed.protocol !== "https:") return "";
    if (!/(^|\.)(taobao\.com|alicdn\.com)$/i.test(parsed.hostname)) return "";
    if (!/\.(mp4|m3u8)(?:$|\?)/i.test(parsed.pathname)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function payloadMediaValues(value, keyPattern, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => payloadMediaValues(item, keyPattern, depth + 1));
  if (typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => keyPattern.test(key)
    ? (Array.isArray(item) ? item.flatMap((entry) => payloadMediaValues(entry, /url|src|image|pic|video/i, depth + 1)) : typeof item === "string" ? [item] : payloadMediaValues(item, /url|src|image|pic|video/i, depth + 1))
    : payloadMediaValues(item, keyPattern, depth + 1));
}

function payloadTextValue(value) {
  if (!value || typeof value !== "object") return "";
  const keys = ["rateContent", "reviewContent", "commentContent", "appendContent", "content", "text", "desc"];
  for (const key of keys) {
    if (typeof value[key] === "string" && cleanText(value[key]).length > 2) return cleanText(value[key]).slice(0, 800);
  }
  return "";
}

function extractBuyerShowPayloadItems(payloads = []) {
  const results = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 7 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const keys = Object.keys(value);
    const marker = keys.some((key) => /rate|review|comment|append|pic|video/i.test(key));
    if (marker) {
      const text = payloadTextValue(value);
      const images = Array.from(new Set(payloadMediaValues(value, /pics?|images?|photos?|pictures?|img/i).map(cleanImage).filter(isCommerceImage))).slice(0, 20);
      const videoUrls = Array.from(new Set(payloadMediaValues(value, /videos?|videoUrl|videoSrc/i).map(cleanBuyerShowVideo).filter(Boolean))).slice(0, 6);
      if ((text && !/账号管理|退出|倍速|播放|收藏|分享/i.test(text)) || images.length || videoUrls.length) {
        const key = `${text}|${images.join(",")}|${videoUrls.join(",")}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ id: `buyer-${results.length + 1}`, text, images, videoUrls });
        }
      }
    }
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  for (const payload of payloads) {
    const parsed = typeof payload === "string" ? parseNetworkPayload(payload) : parseNetworkPayload(payload?.body);
    if (parsed) visit(parsed);
  }
  return results.slice(0, 100);
}

export function extractBuyerShowItems(html, networkPayloads = []) {
  const $ = cheerio.load(String(html || ""));
  const selectors = [
    "[class*='rate-item']", "[class*='review-item']", "[class*='comment-item']",
    "[class*='evaluation-item']", "[class*='晒单-item']", "[class*='买家秀-item']",
    "[class*='rate']", "[class*='review']", "[class*='comment']", "[class*='evaluation']",
    "[class*='晒单']", "[class*='买家秀']", "[id*='rate']", "[id*='review']", "[id*='comment']",
  ].join(",");
  const results = [];
  const seen = new Set();
  for (const node of $(selectors).toArray()) {
    const current = $(node);
    const images = Array.from(new Set(current.find("img").map((_, image) => cleanImage($(image).attr("data-src") || $(image).attr("data-ks-lazyload") || $(image).attr("data-original") || $(image).attr("data-zoom-image") || $(image).attr("src") || "")).get().filter(isCommerceImage))).slice(0, 20);
    const videos = Array.from(new Set(current.find("video,source,[data-video],[data-video-url]").map((_, media) => cleanBuyerShowVideo($(media).attr("src") || $(media).attr("data-src") || $(media).attr("data-video") || $(media).attr("data-video-url") || "")).get().filter(Boolean))).slice(0, 6);
    const text = cleanText(current.find("[class*='content'],[class*='text'],[class*='desc'],p").first().text() || current.text()).slice(0, 800);
    if (!images.length && !videos.length && (!text || text.length < 8)) continue;
    if (/账号管理|退出|倍速|播放|收藏|分享/i.test(text)) continue;
    if ((current.text() || "").length > 5000) continue;
    const key = `${text}|${images.join(",")}|${videos.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ id: `buyer-${results.length + 1}`, text, images, videoUrls: videos });
    if (results.length >= 50) break;
  }
  const payloadItems = extractBuyerShowPayloadItems(networkPayloads);
  const merged = [...results, ...payloadItems];
  return Array.from(new Map(merged.map((item) => [`${item.text}|${item.images.join(",")}|${item.videoUrls.join(",")}`, item])).values()).slice(0, 100);
}

function cleanTitle(value) {
  return cleanText(value)
    .replace(/\s*[-_—|]*\s*(tmall\.com)?\s*天猫\s*$/i, "")
    .replace(/\s*[-_—|]*\s*淘宝网?\s*$/i, "")
    .replace(/\s*[-_—|]*\s*Tmall\s*$/i, "")
    .slice(0, 160);
}

function cleanShopName(value) {
  const text = cleanText(value);
  const match = text.match(/^(.{2,40}?(?:旗舰店|专卖店|专营店|官方店|店))/);
  return match?.[1] || text.replace(/(?:\d+(?:\.\d+)?|VIP|好评率|平均|小时发货|客服满意度|%|>).*$/i, "").slice(0, 40);
}

function isNoiseImage(url) {
  return /avatar|sns|user|flag|logo\?type|safe|loading|sprite|icon|wangwang|qrcode|QRCode|tps-\d{1,3}-\d{1,3}|TB1SMG7|6000000004257-2-tps-174-106/i.test(
    url || "",
  );
}

function isCommerceImage(url) {
  return /\/\/(gw|img)\.alicdn\.com\/(imgextra|bao\/uploaded)/i.test(url || "") && !isNoiseImage(url);
}

function normalizeVideoUrl(url) {
  if (!url) return "";
  return String(url)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/^http:\/\//i, "https://")
    .replace(/^\/\//, "https://");
}

function mediaOwnerIds(images) {
  const owners = new Set();
  for (const image of images) {
    const normalized = cleanImage(image);
    const pathOwner = normalized.match(/\/i\d\/(\d{6,})\//i)?.[1];
    const suffixOwner = normalized.match(/!!(\d{6,})(?:[.!_?#]|$)/)?.[1];
    if (pathOwner) owners.add(pathOwner);
    if (suffixOwner) owners.add(suffixOwner);
  }
  return owners;
}

export function filterProductVideoUrls(candidates, productImages = []) {
  const owners = mediaOwnerIds(productImages);
  const seen = new Set();
  const videos = [];

  for (const candidate of candidates) {
    const normalized = normalizeVideoUrl(candidate).replace(/&amp;/gi, "&");
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      continue;
    }

    if (parsed.protocol !== "https:") continue;
    if (!/(^|\.)(taobao\.com|alicdn\.com)$/i.test(parsed.hostname)) continue;
    if (!/\.(mp4|m3u8)$/i.test(parsed.pathname)) continue;
    if (/\/(?:u|user)\/(?:null|undefined|0)\//i.test(parsed.pathname)) continue;
    if (/placeholder|default|loading|sample|preview|test/i.test(parsed.pathname)) continue;

    const videoOwner = parsed.pathname.match(/\/(?:u|user)\/(\d{6,})\//i)?.[1];
    if (owners.size && videoOwner && !owners.has(videoOwner)) continue;

    const mediaId = parsed.pathname.match(/\/(\d{8,})\.(?:mp4|m3u8)$/i)?.[1];
    const key = mediaId || `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push(parsed.toString());
  }

  return videos.slice(0, 6);
}

function parsePrice(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCentPrice(value) {
  const parsed = parsePrice(value);
  if (!parsed) return null;
  return parsed > 1000 ? Number((parsed / 100).toFixed(2)) : parsed;
}

function extractItemId(...values) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      const itemId = url.searchParams.get("id") || url.searchParams.get("itemId");
      if (/^\d{6,20}$/.test(itemId || "")) return itemId;
    } catch {
      const match = String(value).match(/(?:[?&]|\b)(?:id|itemId)[=:]\s*["']?(\d{6,20})/i);
      if (match?.[1]) return match[1];
    }
  }
  return "";
}

function readBalancedObject(source, startIndex) {
  const objectStart = source.indexOf("{", startIndex);
  if (objectStart < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = objectStart; index < source.length; index++) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(objectStart, index + 1);
  }

  return null;
}

function readBalancedValue(source, startIndex) {
  let valueStart = startIndex;
  while (/\s/.test(source[valueStart] || "")) valueStart += 1;
  const opener = source[valueStart];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = valueStart; index < source.length; index++) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) return source.slice(valueStart, index + 1);
  }

  return null;
}

function extractObjectByKey(html, key) {
  const patterns = [`"${key}"`, `'${key}'`, key];
  for (const pattern of patterns) {
    const index = html.indexOf(pattern);
    if (index < 0) continue;
    const colonIndex = html.indexOf(":", index + pattern.length);
    if (colonIndex < 0) continue;
    const raw = readBalancedObject(html, colonIndex + 1);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // Try the next occurrence/pattern; some inline objects are partial or escaped.
    }
  }
  return null;
}

function extractValueByKey(html, key) {
  const patterns = [`"${key}"`, `'${key}'`, key];
  for (const pattern of patterns) {
    const index = html.indexOf(pattern);
    if (index < 0) continue;
    const colonIndex = html.indexOf(":", index + pattern.length);
    if (colonIndex < 0) continue;
    const raw = readBalancedValue(html, colonIndex + 1);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // Inline objects can be partial; the next signal may still be usable.
    }
  }
  return null;
}

function parseJsonBlobs(html) {
  const blobs = [];
  const patterns = [
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /g_config\s*=\s*({[\s\S]*?});/gi,
    /__INIT_DATA__\s*=\s*({[\s\S]*?});/gi,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/gi,
    /window\.__INIT_DATA__\s*=\s*({[\s\S]*?});/gi,
    /window\.__STORE_STATE__\s*=\s*({[\s\S]*?});/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      try {
        blobs.push(JSON.parse(match[1]));
      } catch {
        // Some Taobao/Tmall inline objects are not strict JSON; DOM parsing still covers images.
      }
    }
  }
  return blobs;
}

function walk(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor));
    return;
  }
  Object.values(value).forEach((item) => walk(item, visitor));
}

function extractFromJson(blobs) {
  const images = [];
  const skuImages = [];
  const videoUrls = [];
  const prices = [];
  let title = "";
  let shopName = "";
  let shopLogo = "";
  let model = "";

  for (const blob of blobs) {
    walk(blob, (node) => {
      if (!model && Array.isArray(node.basicParamList)) {
        const modelParam = node.basicParamList.find((item) => /型号|产品型号|货号/i.test(item.propertyName || item.name || ""));
        if (modelParam) model = cleanText(modelParam.valueName || modelParam.value || modelParam.text).slice(0, 80);
      }
      for (const [key, value] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if (!title && typeof value === "string" && ["title", "name"].includes(lower)) {
          title = value.slice(0, 120);
        }
        if (
          !shopName &&
          typeof value === "string" &&
          ["shopname", "shop_name", "shoptitle", "storename", "sellername", "sellernickname", "seller_nickname", "nick"].includes(lower)
        ) {
          const candidate = cleanText(value).slice(0, 80);
          if (candidate && !/^\d+$/.test(candidate) && !/^true|false$/i.test(candidate)) shopName = candidate;
        }
        if (!model && typeof value === "string" && ["model", "modelname", "productmodel"].includes(lower)) {
          model = cleanText(value).slice(0, 80);
        }
        if (!shopLogo && typeof value === "string" && /(shop|seller|store).*(logo|icon)|logo.*(shop|seller|store)/i.test(lower)) {
          const image = cleanImage(value);
          if (image && !isNoiseImage(image)) shopLogo = image;
        }
        if (typeof value === "string" && /\/\/.*\.(jpg|jpeg|png|webp)/i.test(value)) {
          if (lower.includes("sku")) skuImages.push(cleanImage(value));
          else images.push(cleanImage(value));
        }
        if (typeof value === "string" && /\/\/.*\.(mp4|m3u8)(?:[?#][^"']*)?/i.test(value)) {
          videoUrls.push(value.startsWith("//") ? `https:${value}` : value);
        }
        if (typeof value === "number" && lower.includes("price")) prices.push(value);
        if (typeof value === "string" && lower.includes("price")) {
          const parsed = parsePrice(value);
          if (Number.isFinite(parsed) && parsed > 0) prices.push(parsed);
        }
      }
    });
  }

  return { title: cleanTitle(title), shopName, shopLogo, model, images: unique(images), skuImages: unique(skuImages), videoUrls: unique(videoUrls), prices };
}

function extractFromDom(html) {
  const $ = cheerio.load(html);
  const title = cleanTitle($("meta[property='og:title']").attr("content") || $("title").text() || "");
  const shopName = cleanText(
    $("[class*='shopName'], [class*='shop-name'], [class*='ShopName'], [class*='sellerName'], [class*='SellerName'], [class*='storeName'], [class*='StoreName']")
      .first()
      .text() ||
      $("a[href*='shop']").filter((_, item) => /旗舰店|专卖店|专营店|店$/.test(cleanText($(item).text()))).first().text(),
  );
  const shopLogo = cleanImage(
    $("[class*='shopLogo'], [class*='ShopLogo'], [class*='sellerLogo'], [class*='storeLogo']")
      .find("img")
      .first()
      .attr("src") || "",
  );
  const model = cleanText(
    $("[title='型号'], [title='产品型号'], [title='货号']")
      .parent()
      .text()
      .replace(/^(型号|产品型号|货号)/, ""),
  );
  const focusedImageSelectors = [
    "meta[property='og:image']",
    "[class*='main'] img",
    "[class*='Main'] img",
    "[class*='gallery'] img",
    "[class*='Gallery'] img",
    "[class*='thumb'] img",
    "[class*='Thumb'] img",
    "[class*='viewer'] img",
    "[class*='Viewer'] img",
    "[class*='Pic'] img",
  ];
  const mainImages = unique(
    [
      $("meta[property='og:image']").attr("content"),
      ...$(focusedImageSelectors.join(","))
        .map((_, img) => $(img).attr("src") || $(img).attr("data-src"))
        .get(),
    ].map(cleanImage),
  ).slice(0, 12);

  const visibleText = $("body").text();
  const priceMatches = [...visibleText.matchAll(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));

  return { title, shopName, shopLogo: isNoiseImage(shopLogo) ? "" : shopLogo, model, mainImages, priceMatches };
}

function collectCommerceImages(value, images = []) {
  if (!value) return images;
  if (typeof value === "string") {
    const image = cleanImage(value);
    if (isCommerceImage(image)) images.push(image);
    return images;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCommerceImages(item, images);
    return images;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) collectCommerceImages(child, images);
  }
  return images;
}

function extractShopName(html, jsonData, domData) {
  const patterns = [
    /"seller_nickname"\s*:\s*"([^"]+)"/i,
    /"sellerNickname"\s*:\s*"([^"]+)"/i,
    /"sellerName"\s*:\s*"([^"]+)"/i,
    /"shopName"\s*:\s*"([^"]+)"/i,
    /"shopTitle"\s*:\s*"([^"]+)"/i,
    /"storeName"\s*:\s*"([^"]+)"/i,
    /"shop_name"\s*:\s*"([^"]+)"/i,
  ];

  const candidates = [jsonData.shopName, domData.shopName];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) candidates.push(match[1]);
  }

  const found =
    candidates
      .map(cleanText)
      .find((candidate) => candidate && candidate.length <= 80 && /店|shop|store|官方|旗舰|专卖|专营/i.test(candidate)) ||
    candidates.map(cleanText).find((candidate) => candidate && candidate.length <= 80) ||
    "";
  return cleanShopName(found);
}

function extractShopLogo(html, jsonData, domData) {
  const patterns = [
    /"shopLogo"\s*:\s*"([^"]+)"/i,
    /"shopLogoUrl"\s*:\s*"([^"]+)"/i,
    /"sellerLogo"\s*:\s*"([^"]+)"/i,
    /"storeLogo"\s*:\s*"([^"]+)"/i,
  ];
  const candidates = [jsonData.shopLogo, domData.shopLogo];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) candidates.push(match[1]);
  }
  return candidates.map(cleanImage).find((image) => image && !isNoiseImage(image)) || "";
}

function extractModel(html, jsonData, domData) {
  const candidates = [jsonData.model, domData.model];
  const industryParamVO = extractObjectByKey(html, "industryParamVO");
  for (const item of [...(industryParamVO?.basicParamList || []), ...(industryParamVO?.enhanceParamList || [])]) {
    if (/型号|产品型号|货号/i.test(item.propertyName || item.name || "")) candidates.push(item.valueName || item.value || item.text);
  }
  const modelMatch = html.match(/(?:型号|产品型号|货号)["'\s:：>]+([A-Za-z0-9][A-Za-z0-9._/-]{2,40})/i);
  if (modelMatch?.[1]) candidates.push(modelMatch[1]);
  return candidates.map(cleanText).find((candidate) => candidate && candidate.length <= 80 && !/型号|产品型号|货号/.test(candidate)) || "";
}

function extractVideoUrls(html, jsonData, productImages) {
  const matches = [
    ...(jsonData.videoUrls || []),
    ...[...html.matchAll(/https?:\/\/[^"'\\\s<>]+?\.(?:mp4|m3u8)(?:[?#][^"'\\\s<>]*)?/gi)].map((match) => match[0]),
    ...[...html.matchAll(/\/\/[^"'\\\s<>]+?\.(?:mp4|m3u8)(?:[?#][^"'\\\s<>]*)?/gi)].map((match) => `https:${match[0]}`),
  ];
  return filterProductVideoUrls(matches, productImages);
}

export function selectSquareMainImage(mobileImages = [], fallback = "") {
  const fallbackImages = Array.isArray(fallback) ? fallback : [fallback];
  const candidates = uniqueBy(
    [...mobileImages, ...fallbackImages].map(cleanImage).filter((image) => isCommerceImage(image)),
    imageKey,
  );
  return candidates.find((image) => /-0-item_pic\./i.test(image))
    || candidates.find((image) => /item_pic\./i.test(image))
    || candidates[0]
    || "";
}

export function selectGalleryImages(candidates = [], primaryImage = "", limit = 5) {
  void primaryImage;
  return uniqueBy(candidates.map(cleanImage).filter(isCommerceImage), imageKey)
    .slice(0, limit);
}

function extractProductMedia(html, jsonData, domData, skuImages = [], mobileDetailData = null, knownPrimaryImages = [], knownGalleryImages = [], knownVideoUrls = []) {
  const $ = cheerio.load(html);
  const skuImageKeys = new Set(skuImages.map(imageKey));
  const headImageVO = extractValueByKey(html, "headImageVO") || extractObjectByKey(html, "headImageVO");
  const headImages = uniqueBy(collectCommerceImages(headImageVO?.images || headImageVO), imageKey).filter(isCommerceImage);
  const thumbnailImages = uniqueBy(
    $("img[class*='thumbnailPic'], [class*='thumbnail'] img")
      .map((_, image) => cleanImage($(image).attr("src") || $(image).attr("data-src") || ""))
      .get(),
    imageKey,
  ).filter(isCommerceImage);
  const fallbackHeadImageKeys = ["mainImageVO", "auctionImages", "itemImages", "itemImageVO", "galleryImages"];
  const fallbackHeadImages = uniqueBy(
    fallbackHeadImageKeys
      .flatMap((key) => collectCommerceImages(extractValueByKey(html, key) || extractObjectByKey(html, key)))
      .concat(thumbnailImages, domData.mainImages),
    imageKey,
  ).filter(isCommerceImage);
  const headCandidates = uniqueBy(headImages.length ? headImages : fallbackHeadImages, imageKey);
  const domMainImages = uniqueBy(
    $("img[class*='mainPic'], [class*='mainPic'] img")
      .map((_, image) => cleanImage($(image).attr("src") || $(image).attr("data-src") || ""))
      .get(),
    imageKey,
  ).filter(isCommerceImage);
  const fallbackImages = uniqueBy([...domData.mainImages, ...jsonData.images], imageKey)
    .filter(isCommerceImage)
    .filter((image) => !/detail|desc|content|module/i.test(image) && !skuImageKeys.has(imageKey(image)));
  const mobileSquareImages = uniqueBy(mobileDetailData?.item?.images || [], imageKey).filter(isCommerceImage);
  const primary800Image = selectSquareMainImage([
    ...mobileSquareImages,
    ...headCandidates,
    ...thumbnailImages.filter((image) => !skuImageKeys.has(imageKey(image))),
    ...domMainImages.filter((image) => !skuImageKeys.has(imageKey(image))),
  ], knownPrimaryImages) || fallbackImages[0] || "";
  const gallery750Images = selectGalleryImages([
    ...headCandidates,
    ...thumbnailImages,
    ...fallbackHeadImages,
    ...knownGalleryImages,
  ], primary800Image, 5);
  const mainImages = uniqueBy([primary800Image, ...gallery750Images].filter(Boolean), imageKey).slice(0, 6);
  const excludedKeys = new Set([...mainImages, ...skuImages].map(imageKey));

  const detailSelectors = [
    "[class*='desc'] img",
    "[class*='Desc'] img",
    "[class*='detail'] img",
    "[class*='Detail'] img",
    "[class*='imageText'] img",
    "[class*='description'] img",
    "[id*='desc'] img",
    "[id*='detail'] img",
  ];
  const domDetailImages = $(detailSelectors.join(","))
    .map((_, img) => {
      const src = $(img).attr("data-src") || $(img).attr("src") || "";
      return cleanImage(src);
    })
    .get();

  const detailImageKeys = ["detailImages", "descImages", "itemDescImages", "descriptionImages", "moduleDesc"];
  const structuredDetailImages = detailImageKeys.flatMap((key) =>
    collectCommerceImages(extractValueByKey(html, key) || extractObjectByKey(html, key)),
  );
  const detailImages = uniqueBy([...domDetailImages, ...structuredDetailImages], imageKey)
    .filter((image) => isCommerceImage(image) && !excludedKeys.has(imageKey(image)))
    .slice(0, 80);

  return {
    mainImage800: primary800Image,
    gallery750Images,
    mainImages,
    detailImages,
    buyerShows: extractBuyerShowItems(html),
    videoUrls: filterProductVideoUrls([
      ...extractVideoUrls(html, jsonData, [...mainImages, ...skuImages]),
      ...knownVideoUrls,
    ], [...mainImages, ...skuImages]),
  };
}

function deriveAutoGroup({ shopName, model, title }) {
  const productLine =
    model ||
    cleanText(title)
      .replace(/[-_].*$/, "")
      .match(/([A-Za-z0-9]+[-_][A-Za-z0-9]+|[A-Za-z0-9]{4,}|[\u4e00-\u9fa5]{2,8})/)?.[1] ||
    "未识别型号";
  return [shopName || "未知店铺", productLine].filter(Boolean).join(" / ");
}

function buildSkuName(propPath, props) {
  const names = [];
  const images = [];
  for (const pair of String(propPath || "").split(";")) {
    const [, vid] = pair.split(":");
    if (!vid) continue;
    for (const prop of props) {
      const value = prop.valueMap?.[vid] || prop.values?.find((item) => String(item.vid) === String(vid));
      if (!value) continue;
      if (value.name) names.push(value.name);
      if (value.image) images.push(cleanImage(value.image));
    }
  }
  return { name: names.join(" / "), image: images[0] || "" };
}

function pushPriceLayer(layers, layer) {
  if (!layer.label || !layer.value) return;
  const key = `${layer.label}:${layer.value}:${layer.kind || "price"}`;
  if (layers.some((item) => `${item.label}:${item.value}:${item.kind || "price"}` === key)) return;
  layers.push({
    label: layer.label,
    value: Number(layer.value.toFixed(2)),
    kind: layer.kind || "price",
    source: layer.source || "sku",
  });
}

function normalizeLayerLabel(label) {
  const text = String(label || "").trim();
  if (/惊喜立减|惊喜价/i.test(text)) return "惊喜立减价";
  if (/淘金币|金币/i.test(text)) return "淘金币价";
  if (/首单|礼金/i.test(text)) return "首单礼金价";
  if (/券后|用券|优惠券/i.test(text)) return "券后价";
  if (/补贴|加补/i.test(text)) return text.includes("平台") ? "平台加补后" : "补贴后";
  if (/88|会员|VIP/i.test(text)) return "会员价";
  if (/优惠前|原价|划线/i.test(text)) return "优惠前";
  return text;
}

function extractNodePrice(node) {
  const priceText = node.priceText || node.price || node.value || node.amount || node.money || node.realPrice || node.promotionPrice;
  const moneyText = node.priceMoney || node.moneyCent || node.amountCent || node.discountFee || node.reduceMoney;
  return parsePrice(priceText) ?? parseCentPrice(moneyText);
}

function collectPromoPriceLayers(info) {
  const layers = [];
  const promoKeywords = /惊喜立减|惊喜价|首单|礼金|淘金币|金币|券后|用券|优惠券|补贴|加补|88|会员|VIP|到手|预估/i;
  const discountKeywords = /减|抵扣|优惠|立减|省|返/i;

  walk(info, (node) => {
    const title = [
      node.priceTitle,
      node.title,
      node.name,
      node.label,
      node.text,
      node.desc,
      node.priceDesc,
      node.promotionName,
      node.benefitName,
      node.activityName,
    ]
      .filter(Boolean)
      .join(" ");

    if (!promoKeywords.test(title)) return;
    const value = extractNodePrice(node);
    if (!value) return;
    pushPriceLayer(layers, {
      label: normalizeLayerLabel(title),
      value,
      kind: discountKeywords.test(title) && !/价|price|后/i.test(title) ? "discount" : "price",
    });
  });

  return layers;
}

function cleanDiscountText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function parseDiscountThreshold(text) {
  const match = cleanDiscountText(text).match(/满\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parseDiscountAmount(text) {
  const value = cleanDiscountText(text);
  const fullReduction = value.match(/满\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元)?\s*(?:立)?减\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  if (fullReduction) return Number(fullReduction[1]);
  const percentageSaving = value.match(/\d+(?:\.\d+)?\s*%[^\d]{0,8}(?:省|减|优惠)\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  if (percentageSaving) return Number(percentageSaving[1]);
  if (/\d+(?:\.\d+)?\s*%/.test(value)) return null;
  const directReduction = value.match(/(?:立减|直减|减免|省|已抵|抵扣|补贴|优惠)\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  if (directReduction) return Number(directReduction[1]);
  const coupon = value.match(/(?:优惠券|店铺券|平台券|券)\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  return coupon ? Number(coupon[1]) : null;
}

function normalizeDiscountLabel(text) {
  const value = cleanDiscountText(text);
  if (/惊喜立减/.test(value)) return "惊喜立减";
  if (/超级立减/.test(value)) return "超级立减";
  if (/限时立减/.test(value)) return "限时立减";
  if (/双\s*11|双十一/.test(value)) return "双11活动";
  if (/6\s*18|六一八/.test(value)) return "618活动";
  if (/年货节/.test(value)) return "年货节活动";
  if (/百亿补贴/.test(value)) return "百亿补贴";
  if (/跨店满减/.test(value)) return "跨店满减";
  if (/政府补贴|国家补贴|国补/.test(value)) return "政府补贴";
  if (/预售/.test(value)) return "预售优惠";
  if (/店铺活动|店铺优惠/.test(value)) return "店铺活动";
  if (/会员活动/.test(value)) return "会员活动";
  if (/限时活动/.test(value)) return "限时活动";
  if (/满\s*\d+(?:\.\d+)?\s*(?:元)?\s*(?:立)?减/.test(value)) return "满减优惠";
  if (/店铺券/.test(value)) return "店铺券";
  if (/平台券/.test(value)) return "平台券";
  if (/优惠券|券/.test(value)) return "优惠券";
  if (/平台补贴/.test(value)) return "平台补贴";
  if (/补贴/.test(value)) return "补贴";
  if (/淘金币|金币/.test(value)) return "淘金币抵扣";
  if (/礼金/.test(value)) return "礼金优惠";
  if (/88\s*VIP|88VIP/i.test(value)) return "88VIP 优惠";
  if (/会员/.test(value)) return "会员优惠";
  if (/限时/.test(value)) return "限时优惠";
  if (/立减|直减|减免/.test(value)) return "立减优惠";
  return "其他优惠";
}

function discountType(label) {
  if (/立减|满减/.test(label)) return "reduction";
  if (/券/.test(label)) return "coupon";
  if (/补贴/.test(label)) return "subsidy";
  if (/淘金币|礼金/.test(label)) return "credit";
  if (/VIP|会员/.test(label)) return "member";
  return "promotion";
}

export function collectDiscountItems(info) {
  const items = [];
  const seen = new Set();
  const discountKeywords = /惊喜立减|超级立减|限时立减|立减|直减|减免|满\s*\d+(?:\.\d+)?\s*(?:元)?\s*(?:立)?减|优惠券|店铺券|平台券|平台补贴|补贴|淘金币|金币抵扣|礼金|88\s*VIP|会员优惠|双\s*11|双十一|6\s*18|六一八|年货节|百亿补贴|跨店满减|政府补贴|国家补贴|国补|店铺活动|限时活动|会员活动|预售/i;
  const textFields = ["promotionName", "activityName", "benefitName", "couponName", "title", "subTitle", "name", "label", "tag", "text", "desc", "tips", "priceDesc"];

  walk(info, (node) => {
    const texts = textFields.map((field) => cleanDiscountText(node[field])).filter(Boolean);
    const combinedText = cleanDiscountText(texts.join(" "));
    if (!discountKeywords.test(combinedText) || /(?:店铺)?优惠后\s*[¥￥]?\s*\d/i.test(combinedText)) return;

    const displayText = texts.find((text) => discountKeywords.test(text) && parseDiscountAmount(text) !== null)
      || texts.find((text) => discountKeywords.test(text))
      || combinedText;
    const label = normalizeDiscountLabel(combinedText);
    const explicitMoney = node.discountFee ?? node.reduceMoney ?? node.discountAmount ?? node.reduceAmount;
    const amount = parseDiscountAmount(combinedText) ?? parseCentPrice(explicitMoney);
    const threshold = parseDiscountThreshold(combinedText);
    const key = `${label}:${amount ?? ""}:${threshold ?? ""}:${displayText}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      label,
      amount,
      threshold,
      text: displayText,
      type: discountType(label),
      source: "sku",
    });
  });

  return items.slice(0, 20);
}

export function collectDiscountItemsFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ");
  const snippets = [];
  const patterns = [
    /(?:惊喜立减|超级立减|限时立减|限时直降|店铺立减|平台立减|官方立减)\s*\d+(?:\.\d+)?\s*%\s*(?:省|减|优惠)\s*[¥￥]?\s*\d+(?:\.\d+)?\s*元?/gi,
    /(?:惊喜立减|超级立减|限时立减|限时直降|店铺立减|平台立减|官方立减|平台补贴|政府补贴|国家补贴|国补|百亿补贴|店铺券|平台券|优惠券|淘金币(?:已抵|抵扣)|88\s*VIP优惠)[^\d¥￥]{0,12}(?:[¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*元)/gi,
    /满\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元)?\s*(?:立)?减\s*[¥￥]?\s*\d+(?:\.\d+)?\s*元?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) snippets.push(match[0]);
  }

  const items = snippets
    .filter((snippet) => !/惊喜立减(?:到手)?价/i.test(snippet))
    .flatMap((snippet) => collectDiscountItems({ text: snippet }));
  const labelsWithExplicitAmount = new Set(items.filter((item) => Number(item.amount) > 0).map((item) => item.label));
  const preferredItems = items.filter((item) => Number(item.amount) > 0 || !labelsWithExplicitAmount.has(item.label));
  return Array.from(new Map(preferredItems.map((item) => [
    `${item.label}:${item.amount ?? ""}:${item.threshold ?? ""}`,
    { ...item, source: "page-visible" },
  ])).values()).slice(0, 20);
}

export function collectVisibleSurprisePrices(value) {
  const text = String(value || "")
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/\s+/g, " ");
  const prices = [];
  const pattern = /(?:惊喜立减(?:到手)?价|惊喜到手价|惊喜价)\s*(?:为|[:：])?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/gi;
  for (const match of text.matchAll(pattern)) {
    const price = Number(match[1]);
    if (Number.isFinite(price) && price > 0 && !prices.includes(price)) prices.push(price);
  }
  return prices;
}

export function extractSelectedSkuId(finalUrl, html, knownSkuIds = []) {
  const known = new Set(knownSkuIds.map(String));
  try {
    const urlSkuId = new URL(finalUrl).searchParams.get("skuId");
    if (urlSkuId && (!known.size || known.has(urlSkuId))) return urlSkuId;
  } catch {
    // Some fallback fetches can report a non-standard URL.
  }

  const source = String(html || "").replace(/&quot;|&#34;/gi, '"');
  const patterns = [
    /["'](?:selectedSkuId|currentSkuId|defaultSkuId|selected_sku_id)["']\s*[:=]\s*["']?(\d{5,})/gi,
    /(?:selectedSkuId|currentSkuId|defaultSkuId|selected_sku_id)\\?"?\s*[:=]\s*\\?["']?(\d{5,})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!known.size || known.has(match[1])) return match[1];
    }
  }
  return null;
}

export function applyVisibleSurprisePrice(skuPrices, visiblePrices, selectedSkuId) {
  const uniquePrices = Array.from(new Set((visiblePrices || []).map(Number).filter((price) => Number.isFinite(price) && price > 0)));
  if (uniquePrices.length !== 1) return skuPrices;
  const targetSkuId = selectedSkuId && skuPrices.some((sku) => String(sku.skuId) === String(selectedSkuId))
    ? String(selectedSkuId)
    : skuPrices.length === 1
      ? String(skuPrices[0].skuId)
      : null;
  if (!targetSkuId) return skuPrices;

  const surprisePrice = uniquePrices[0];
  return skuPrices.map((sku) => {
    const existingSurprisePrice = Number(sku.surprisePrice);
    if (String(sku.skuId) !== targetSkuId || (Number.isFinite(existingSurprisePrice) && existingSurprisePrice > 0)) return sku;
    const priceLayers = [...(sku.priceLayers || [])];
    pushPriceLayer(priceLayers, {
      label: "惊喜立减价",
      value: surprisePrice,
      source: "page-visible-selected-sku",
    });
    return {
      ...sku,
      surprisePrice,
      surpriseStatus: "available",
      priceLayers,
    };
  });
}

function parseNetworkPayload(body) {
  const text = String(body || "").trim();
  if (!text) return null;
  try {
    return decodeNestedJson(JSON.parse(text));
  } catch {
    const jsonp = text.match(/^[^(]*\((\{[\s\S]*\})\)\s*;?$/);
    if (!jsonp) return null;
    try {
      return decodeNestedJson(JSON.parse(jsonp[1]));
    } catch {
      return null;
    }
  }
}

function decodeNestedJson(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => decodeNestedJson(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNestedJson(item, depth + 1)]));
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return value;
  try {
    return decodeNestedJson(JSON.parse(text), depth + 1);
  } catch {
    return value;
  }
}

function collectSkuScopedPromoData(value, knownSkuIds) {
  const result = new Map();
  const ensure = (skuId) => {
    if (!result.has(skuId)) result.set(skuId, { layers: [], discountItems: [], surprisePrices: [], surpriseInference: null });
    return result.get(skuId);
  };
  const inferSurpriseScenario = (node) => {
    let basePrice = null;
    const reductions = new Map();
    walk(node, (candidate) => {
      const candidateBase = Number(candidate.price1 || candidate.originalPrice || candidate.reservePrice);
      if (Number.isFinite(candidateBase) && candidateBase > 0) basePrice = basePrice || candidateBase;
      for (const details of [candidate.pricedetails1, candidate.utcDNow]) {
        for (const token of String(details || "").split("^")) {
          const code = token.match(/^([^_]+)/)?.[1]?.toLowerCase();
          const cents = Number(token.match(/_(\d+)$/)?.[1]);
          if (code && Number.isFinite(cents) && cents > 0) reductions.set(code, cents / 100);
        }
      }
    });
    if (!basePrice || !reductions.has("spsd4plan")) return null;
    const items = [
      reductions.has("spsd4cjmj") ? { code: "spsd4cjmj", label: "超级立减", amount: reductions.get("spsd4cjmj") } : null,
      { code: "spsd4plan", label: "惊喜活动立减", amount: reductions.get("spsd4plan") },
    ].filter(Boolean);
    const discountAmount = items.reduce((sum, item) => sum + item.amount, 0);
    const price = Number((basePrice - discountAmount).toFixed(2));
    if (!(price > 0 && price < basePrice)) return null;
    return {
      basePrice,
      price,
      discountAmount: Number(discountAmount.toFixed(2)),
      items,
      reductions: Object.fromEntries(reductions),
      formula: `标价 ${basePrice.toFixed(2)}${items.map((item) => ` - ${item.label} ${item.amount.toFixed(2)}`).join("")} = ${price.toFixed(2)}`,
      source: "mobile-promotion-formula",
    };
  };
  const record = (skuId, node) => {
    const target = ensure(skuId);
    for (const layer of collectPromoPriceLayers(node)) {
      pushPriceLayer(target.layers, { ...layer, source: "network-sku" });
    }
    target.discountItems.push(...collectDiscountItems(node));
    target.surprisePrices.push(...collectVisibleSurprisePrices(JSON.stringify(node)));
    target.surpriseInference ||= inferSurpriseScenario(node);
  };
  const visit = (node, inheritedSkuId = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inheritedSkuId);
      return;
    }
    const explicitSkuId = [node.skuId, node.selectSkuId, node.warmSkuId, node.sku_id, node.skuIdStr, node.skuID]
      .map((item) => String(item || ""))
      .find((item) => knownSkuIds.has(item));
    const scopedSkuId = explicitSkuId || inheritedSkuId;
    if (explicitSkuId && explicitSkuId !== inheritedSkuId) record(explicitSkuId, node);
    for (const [key, child] of Object.entries(node)) {
      const keyedSkuId = knownSkuIds.has(String(key)) ? String(key) : null;
      if (keyedSkuId) record(keyedSkuId, child);
      visit(child, keyedSkuId || scopedSkuId);
    }
  };
  visit(value);
  return result;
}

export function applyNetworkPromoData(skuPrices, networkPayloads = [], options = {}) {
  const accountType = options.accountType || "normal";
  const knownSkuIds = new Set(skuPrices.map((sku) => String(sku.skuId)));
  const merged = new Map();
  for (const payload of networkPayloads) {
    const parsed = typeof payload === "string" ? parseNetworkPayload(payload) : parseNetworkPayload(payload?.body);
    if (!parsed) continue;
    for (const [skuId, data] of collectSkuScopedPromoData(parsed, knownSkuIds)) {
      const target = merged.get(skuId) || { layers: [], discountItems: [], surprisePrices: [], surpriseInference: null };
      for (const layer of data.layers) pushPriceLayer(target.layers, layer);
      target.discountItems.push(...data.discountItems);
      target.surprisePrices.push(...data.surprisePrices);
      target.surpriseInference ||= data.surpriseInference;
      merged.set(skuId, target);
    }
  }

  return skuPrices.map((sku) => {
    const data = merged.get(String(sku.skuId));
    if (!data) return sku;
    const priceLayers = [...(sku.priceLayers || [])];
    for (const layer of data.layers) pushPriceLayer(priceLayers, layer);
    const surpriseLayer = priceLayers.find((layer) => /惊喜立减|惊喜价/i.test(layer.label) && layer.kind !== "discount");
    const explicitPrices = Array.from(new Set(data.surprisePrices));
    const currentNormalPrice = Number(sku.normalPrice ?? sku.price);
    const accountBenefit = {
      normal: { label: "惊喜立减", layerLabel: "惊喜立减价", priceField: "surprisePrice", statusField: "surpriseStatus", discountField: "surpriseDiscountAmount", inferenceField: "surpriseInference", benefitCodes: [/^spsd4jzjj$/], layerPattern: /惊喜立减|惊喜价/i },
      gift: { label: "礼金优惠", layerLabel: "礼金价", priceField: "giftPrice", statusField: "giftStatus", discountField: "giftDiscountAmount", inferenceField: "giftInference", benefitCodes: [/^1$/], layerPattern: /首单|礼金/i },
      vip88: { label: "88VIP优惠", layerLabel: "88VIP价", priceField: "vipPrice", statusField: "vipStatus", discountField: "vipDiscountAmount", inferenceField: "vipInference", benefitCodes: [/88|vip|member/i], layerPattern: /88|会员|VIP/i },
    }[accountType] || null;
    const explicitBenefitLayer = accountBenefit
      ? priceLayers.find((layer) => accountBenefit.layerPattern.test(layer.label) && layer.kind !== "discount")
      : null;
    const inferredPromotionPrice = Number(data.surpriseInference?.price);
    const encodedBenefitDiscount = accountBenefit
      ? Object.entries(data.surpriseInference?.reductions || {}).find(([code]) => accountBenefit.benefitCodes.some((pattern) => pattern.test(code)))?.[1]
      : null;
    const encodedBenefitPrice = Number.isFinite(Number(encodedBenefitDiscount)) && Number(encodedBenefitDiscount) > 0
      ? Number((inferredPromotionPrice - Number(encodedBenefitDiscount)).toFixed(2))
      : null;
    const inferredBenefitPrice = encodedBenefitPrice && encodedBenefitPrice > 0 ? encodedBenefitPrice : currentNormalPrice;
    const hasPromotionBase = Number.isFinite(inferredPromotionPrice) && inferredPromotionPrice > 0;
    const hasPromotionFormula = hasPromotionBase
      && Number.isFinite(inferredBenefitPrice)
      && inferredPromotionPrice > inferredBenefitPrice;
    const benefitDiscountAmount = hasPromotionFormula ? Number((inferredPromotionPrice - inferredBenefitPrice).toFixed(2)) : null;
    const benefitInference = hasPromotionFormula && accountBenefit ? {
      ...data.surpriseInference,
      normalPrice: inferredPromotionPrice,
      benefitPrice: inferredBenefitPrice,
      benefitDiscountAmount,
      accountType,
      normalFormula: `${data.surpriseInference.formula.replace(/ = ([\d.]+)$/, " = 普通价 $1")}`,
      formula: `普通价 ${inferredPromotionPrice.toFixed(2)} - ${accountBenefit.label} ${benefitDiscountAmount.toFixed(2)} = ${inferredBenefitPrice.toFixed(2)}`,
    } : null;
    const explicitSurprisePrice = surpriseLayer?.value || (explicitPrices.length === 1 ? explicitPrices[0] : null);
    const normalPrice = hasPromotionBase ? inferredPromotionPrice : currentNormalPrice;
    if (hasPromotionBase) {
      pushPriceLayer(priceLayers, { label: "普通价（活动公式）", value: normalPrice, source: "mobile-promotion-formula" });
    }
    if (benefitInference) {
      pushPriceLayer(priceLayers, { label: accountBenefit.layerLabel, value: inferredBenefitPrice, source: "mobile-promotion-formula" });
    }
    const discountItems = Array.from(new Map([...(sku.discountItems || []), ...data.discountItems].map((item) => [
      `${item.label}:${item.amount ?? ""}:${item.threshold ?? ""}:${item.text}`,
      item,
    ])).values());
    const resolvedBenefitPrice = benefitInference?.benefitPrice || explicitBenefitLayer?.value || null;
    const resolvedBenefitDiscount = benefitInference?.benefitDiscountAmount
      || (resolvedBenefitPrice && currentNormalPrice > resolvedBenefitPrice ? Number((currentNormalPrice - resolvedBenefitPrice).toFixed(2)) : null);
    const accountFields = resolvedBenefitPrice && accountBenefit ? {
      [accountBenefit.priceField]: resolvedBenefitPrice,
      [accountBenefit.statusField]: "available",
      [accountBenefit.discountField]: resolvedBenefitDiscount,
      [accountBenefit.inferenceField]: benefitInference,
    } : {};
    return {
      ...sku,
      price: normalPrice,
      normalPrice,
      priceLayers,
      discountItems,
      surprisePrice: explicitSurprisePrice || accountFields.surprisePrice || sku.surprisePrice || null,
      surpriseStatus: explicitSurprisePrice ? "available" : accountFields.surpriseStatus || sku.surpriseStatus,
      ...accountFields,
    };
  });
}

async function fetchMobilePromotionPayloads(itemId, skuPrices, authSession) {
  if (authSession?.source !== "taobao-browser") return [];
  const desktopProductUrl = `https://detail.tmall.com/item.htm?id=${encodeURIComponent(itemId)}`;
  try {
    const page = await getRenderedHtml(desktopProductUrl, authSession, { selectSkuNames: skuPrices.map((sku) => sku.name) });
    return page.networkPayloads || [];
  } catch {
    return [];
  }
}

export function collectProductProgramItems(value) {
  const text = String(value || "");
  const items = [];
  if (/消费者在百亿补贴购买商品/.test(text) && /假一赔十/.test(text)) {
    items.push({
      label: "百亿补贴",
      amount: null,
      threshold: null,
      text: "商品服务保障确认属于百亿补贴，页面未单独披露补贴金额",
      type: "subsidy",
      source: "product-program",
    });
  }
  return items;
}

function applyProductProgramItems(skuPrices, programItems) {
  if (!programItems.length) return skuPrices;
  return skuPrices.map((sku) => ({
    ...sku,
    discountItems: Array.from(new Map([...(sku.discountItems || []), ...programItems].map((item) => [
      `${item.label}:${item.source}`,
      item,
    ])).values()),
  }));
}

export function applyVisibleDiscountItems(skuPrices, visibleItems) {
  const verifiedItems = visibleItems.filter((item) => Number(item.amount) > 0);
  const visibleTotal = verifiedItems.reduce((sum, item) => sum + Number(item.amount), 0);
  if (!verifiedItems.length) return skuPrices;
  return skuPrices.map((sku) => {
    const totalDiscount = Number(sku.originalPrice || 0) - Number(sku.normalPrice ?? sku.price ?? 0);
    if (totalDiscount <= 0 || totalDiscount + 0.02 < visibleTotal) return sku;
    const currentItems = sku.discountItems || [];
    return {
      ...sku,
      discountItems: Array.from(new Map([...currentItems, ...verifiedItems].map((item) => [
        `${item.label}:${item.amount ?? ""}:${item.threshold ?? ""}`,
        item,
      ])).values()),
    };
  });
}

export function resolveSkuPrices(layers, fallback) {
  const priceLayers = layers.filter((layer) => layer.kind !== "discount" && layer.kind !== "original" && layer.label !== "优惠前");
  const normalLayer =
    priceLayers.find((layer) => /普通|平台|补贴|券后|到手|店铺优惠/.test(layer.label) && !/惊喜|淘金币|金币|首单|礼金|88|会员|VIP/i.test(layer.label)) ||
    priceLayers.find((layer) => !/惊喜|淘金币|金币|首单|礼金|88|会员|VIP/i.test(layer.label));
  const surpriseLayer = priceLayers.find((layer) => /惊喜立减|惊喜价/i.test(layer.label));
  const coinLayer = priceLayers.find((layer) => /淘金币|金币/i.test(layer.label));

  return {
    normalPrice: normalLayer?.value || fallback || null,
    normalPriceTitle: normalLayer?.label || "普通价",
    surprisePrice: surpriseLayer?.value || null,
    coinPrice: coinLayer?.value || null,
  };
}

export function resolveCoinBenefit(sku) {
  const coinLayers = (sku.priceLayers || []).filter((layer) => /淘金币|金币/i.test(layer.label || ""));
  const coinItems = (sku.discountItems || []).filter((item) => /淘金币|金币/i.test(`${item.label || ""} ${item.text || ""}`));
  const explicitDiscount = coinItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const normalPrice = Number(sku.normalPrice ?? sku.price);
  const coinPrice = Number(sku.coinPrice);
  const priceDiscount = Number.isFinite(normalPrice) && Number.isFinite(coinPrice) && coinPrice > 0
    ? Math.max(0, Number((normalPrice - coinPrice).toFixed(2)))
    : 0;
  const available = coinLayers.length > 0 || coinItems.length > 0 || (Number.isFinite(coinPrice) && coinPrice > 0);
  return {
    coinStatus: available ? "available" : "none",
    coinDiscountAmount: explicitDiscount > 0 ? Number(explicitDiscount.toFixed(2)) : priceDiscount || null,
  };
}

export function applyAppliedCoinDiscount(sku) {
  if (Number.isFinite(sku.coinPrice) && Number(sku.coinPrice) > 0) return sku;
  const appliedItems = (sku.discountItems || []).filter((item) => (
    /淘金币|金币/i.test(`${item.label || ""} ${item.text || ""}`)
    && /已抵|抵扣后|金币价/i.test(item.text || "")
    && Number(item.amount) > 0
  ));
  const appliedAmount = appliedItems.reduce((sum, item) => sum + Number(item.amount), 0);
  const displayedPrice = Number(sku.normalPrice ?? sku.price);
  if (!Number.isFinite(displayedPrice) || displayedPrice <= 0 || appliedAmount <= 0) return sku;

  const normalPrice = Number((displayedPrice + appliedAmount).toFixed(2));
  const normalLabel = `${sku.priceTitle || "普通价"}（淘金币前）`;
  const priceLayers = (sku.priceLayers || []).map((layer) => (
    layer.kind !== "original" && Number(layer.value) === displayedPrice
      ? { ...layer, label: "淘金币价", source: "applied-coin" }
      : layer
  ));
  pushPriceLayer(priceLayers, { label: normalLabel, value: normalPrice, source: "derived-before-coin" });
  return {
    ...sku,
    price: normalPrice,
    normalPrice,
    coinPrice: displayedPrice,
    priceTitle: normalLabel,
    priceLayers,
    coinStatus: "available",
    coinDiscountAmount: Number(appliedAmount.toFixed(2)),
  };
}

export function calculatePriceScenarios(sku) {
  const normalInput = Number(sku.normalPrice ?? sku.price);
  const surpriseInput = Number(sku.surprisePrice);
  const coinInput = Number(sku.coinPrice);
  const surpriseItems = (sku.discountItems || []).filter((item) => /惊喜立减/i.test(`${item.label || ""} ${item.text || ""}`));
  const coinItems = (sku.discountItems || []).filter((item) => /淘金币|金币/i.test(`${item.label || ""} ${item.text || ""}`));
  const surpriseDiscount = surpriseItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const coinDiscount = coinItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const candidates = [normalInput];
  if (Number.isFinite(surpriseInput) && surpriseInput > 0 && surpriseDiscount > 0) candidates.push(surpriseInput + surpriseDiscount);
  if (Number.isFinite(coinInput) && coinInput > 0 && coinDiscount > 0) candidates.push(coinInput + coinDiscount);
  const normalPrice = Number(Math.max(...candidates.filter(Number.isFinite)).toFixed(2));
  const surprisePrice = Number.isFinite(surpriseInput) && surpriseInput > 0
    ? surpriseInput
    : surpriseDiscount > 0
      ? Number((normalPrice - surpriseDiscount).toFixed(2))
      : null;
  const giftPrice = Number.isFinite(Number(sku.giftPrice)) && Number(sku.giftPrice) > 0 ? Number(sku.giftPrice) : null;
  const vipPrice = Number.isFinite(Number(sku.vipPrice)) && Number(sku.vipPrice) > 0 ? Number(sku.vipPrice) : null;
  const inferredCoinBase = Number.isFinite(coinInput) && coinInput > 0 && coinDiscount > 0
    ? coinInput + coinDiscount
    : null;
  const accountPriceCandidates = [
    { label: "惊喜立减价", value: surprisePrice },
    { label: "礼金价", value: giftPrice },
    { label: "88VIP价", value: vipPrice },
    { label: "普通价", value: normalPrice },
  ].filter((item) => Number.isFinite(item.value) && item.value > 0);
  const coinBase = inferredCoinBase == null
    ? accountPriceCandidates[0]
    : accountPriceCandidates.toSorted((left, right) => Math.abs(left.value - inferredCoinBase) - Math.abs(right.value - inferredCoinBase))[0];
  const coinBasePrice = coinBase?.value || normalPrice;
  const coinPrice = Number.isFinite(coinInput) && coinInput > 0
    ? coinInput
    : coinDiscount > 0
      ? Number((coinBasePrice - coinDiscount).toFixed(2))
      : null;
  return {
    ...sku,
    price: normalPrice,
    normalPrice,
    surprisePrice,
    coinPrice,
    surpriseStatus: surprisePrice ? "available" : "none",
    surpriseDiscountAmount: sku.surpriseInference?.benefitDiscountAmount || sku.surpriseDiscountAmount || (surpriseDiscount > 0 ? Number(surpriseDiscount.toFixed(2)) : surprisePrice && normalPrice > surprisePrice ? Number((normalPrice - surprisePrice).toFixed(2)) : null),
    giftPrice,
    giftDiscountAmount: sku.giftInference?.benefitDiscountAmount || sku.giftDiscountAmount || (giftPrice && normalPrice > giftPrice ? Number((normalPrice - giftPrice).toFixed(2)) : null),
    vipPrice,
    vipDiscountAmount: sku.vipInference?.benefitDiscountAmount || sku.vipDiscountAmount || (vipPrice && normalPrice > vipPrice ? Number((normalPrice - vipPrice).toFixed(2)) : null),
    coinStatus: coinPrice ? "available" : sku.coinStatus || "none",
    coinDiscountAmount: coinDiscount > 0 ? Number(coinDiscount.toFixed(2)) : coinPrice && normalPrice > coinPrice ? Number((normalPrice - coinPrice).toFixed(2)) : sku.coinDiscountAmount || null,
    priceCalculation: {
      normal: (sku.surpriseInference || sku.giftInference || sku.vipInference)?.normalFormula || `普通价 ${normalPrice.toFixed(2)}`,
      surprise: sku.surpriseInference?.formula || (surprisePrice
        ? normalPrice > surprisePrice
          ? `普通价 ${normalPrice.toFixed(2)} - 惊喜立减 ${(normalPrice - surprisePrice).toFixed(2)} = ${surprisePrice.toFixed(2)}`
          : `页面明确惊喜立减价 ${surprisePrice.toFixed(2)}（独立价格口径）`
        : "未获取惊喜立减价"),
      gift: sku.giftInference?.formula || (giftPrice ? `普通价 ${normalPrice.toFixed(2)} - 礼金优惠 ${(normalPrice - giftPrice).toFixed(2)} = ${giftPrice.toFixed(2)}` : "未获取礼金价"),
      vip88: sku.vipInference?.formula || (vipPrice ? `普通价 ${normalPrice.toFixed(2)} - 88VIP优惠 ${(normalPrice - vipPrice).toFixed(2)} = ${vipPrice.toFixed(2)}` : "未获取88VIP价"),
      coin: coinPrice ? `${coinBase?.label || "普通价"} ${coinBasePrice.toFixed(2)} - 淘金币抵扣 ${(coinBasePrice - coinPrice).toFixed(2)} = ${coinPrice.toFixed(2)}` : "未获取淘金币价",
    },
  };
}

export function calculateAccountPriceScenario(sku, accountType = "normal") {
  const scoped = { ...sku };
  if (accountType !== "normal") {
    scoped.surprisePrice = null;
    scoped.surpriseStatus = "none";
    scoped.surpriseDiscountAmount = null;
    scoped.surpriseInference = null;
  }
  if (accountType !== "gift") {
    scoped.giftPrice = null;
    scoped.giftStatus = "none";
    scoped.giftDiscountAmount = null;
    scoped.giftInference = null;
  }
  if (accountType !== "vip88") {
    scoped.vipPrice = null;
    scoped.vipStatus = "none";
    scoped.vipDiscountAmount = null;
    scoped.vipInference = null;
  }
  const calculated = calculatePriceScenarios(scoped);
  return {
    ...calculated,
    accountType,
    priceCalculation: {
      normal: calculated.priceCalculation.normal,
      surprise: accountType === "normal" ? calculated.priceCalculation.surprise : "当前账号不参与惊喜立减计算",
      gift: accountType === "gift" ? calculated.priceCalculation.gift : "当前账号不参与礼金计算",
      vip88: accountType === "vip88" ? calculated.priceCalculation.vip88 : "当前账号不参与88VIP计算",
      coin: calculated.priceCalculation.coin,
    },
  };
}

function extractStructuredSku(html) {
  const skuBase = extractObjectByKey(html, "skuBase");
  const skuCore = extractObjectByKey(html, "skuCore");
  const sku2info = skuCore?.sku2info || {};
  const props = skuBase?.props || [];
  const skuPrices = [];
  const skuImages = [];

  for (const sku of skuBase?.skus || []) {
    const info = sku2info[String(sku.skuId)] || {};
    const details = buildSkuName(sku.propPath, props);
    const priceLayers = [];
    const subPrice = parsePrice(info.subPrice?.priceText);
    const originalPrice = parsePrice(info.price?.priceText);
    if (subPrice) {
      pushPriceLayer(priceLayers, {
        label: normalizeLayerLabel(info.subPrice?.priceTitle || "到手价"),
        value: subPrice,
      });
    }
    for (const layer of collectPromoPriceLayers(info)) pushPriceLayer(priceLayers, layer);
    if (originalPrice) {
      pushPriceLayer(priceLayers, {
        label: "优惠前",
        value: originalPrice,
        kind: "original",
      });
    }
    const resolvedPrices = resolveSkuPrices(priceLayers, subPrice ?? originalPrice);
    const discountItems = collectDiscountItems(info);
    if (details.image) skuImages.push(details.image);
    skuPrices.push({
      skuId: String(sku.skuId),
      name: details.name || `SKU ${skuPrices.length + 1}`,
      image: details.image,
      price: resolvedPrices.normalPrice,
      normalPrice: resolvedPrices.normalPrice,
      surprisePrice: resolvedPrices.surprisePrice,
      coinPrice: resolvedPrices.coinPrice,
      originalPrice,
      priceTitle: resolvedPrices.normalPriceTitle,
      priceLayers,
      discountItems,
      quantity: Number(info.quantity || 0),
      quantityText: info.quantityText || "",
      quantitySource: "buyer-page",
    });
  }

  const fallbackInfo = sku2info["0"];
  const displayPrice = parsePrice(fallbackInfo?.subPrice?.priceText) ?? parsePrice(fallbackInfo?.price?.priceText);

  return {
    skuPrices: skuPrices.filter((sku) => sku.normalPrice),
    skuImages: unique(skuImages),
    displayPrice,
  };
}

async function fetchHtml(product, authSession) {
  if (authSession?.source === "taobao-browser") {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const page = await getRenderedHtml(product.url, authSession, { captureVideo: true, captureBuyerShow: true });
        const looksBlocked = (/login|验证|captcha|滑块/i.test(page.finalUrl) || /扫码登录|密码登录|安全验证|请完成验证/i.test(page.html)) && !/skuCore|skuBase/i.test(page.html);
        if (!looksBlocked) return page;
        throw new Error("当前抓到登录或验证页面");
      } catch (error) {
        lastError = error;
        if (/登录|验证|captcha|滑块/i.test(error.message)) break;
      }
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw new Error(`浏览器登录态抓取失败：${lastError?.message || "首次加载失败"}`);
  }

  const headers = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  if (authSession?.cookie) headers.cookie = authSession.cookie;

  const response = await fetch(product.url, { headers, redirect: "follow" });
  const html = await response.text();
  return { html, finalUrl: response.url, statusCode: response.status, source: "fetch" };
}

export async function scrapeTmallProduct(product, authSession) {
  const startedAt = new Date().toISOString();
  const page = await fetchHtml(product, authSession);
  const { html } = page;
  const itemId = extractItemId(page.finalUrl, product.url, html);

  if ((/login|验证|captcha|滑块/i.test(page.finalUrl) || /扫码登录|密码登录|安全验证|请完成验证/i.test(html)) && !/skuCore|skuBase/i.test(html)) {
    throw new Error("需要登录或触发验证，请在账号授权中更新淘宝会话后重试。");
  }

  const jsonData = extractFromJson(parseJsonBlobs(html));
  const domData = extractFromDom(html);
  if (domData.title === "登录" && !/skuCore|skuBase/i.test(html)) {
    throw new Error("当前抓到的是登录页，请在账号授权中重新同步淘宝扫码会话。");
  }
  const structuredSku = extractStructuredSku(html);
  const accountType = authSession?.accountType || "normal";
  structuredSku.skuPrices = applyNetworkPromoData(structuredSku.skuPrices, page.networkPayloads, { accountType });
  const mobilePromotionPayloads = await fetchMobilePromotionPayloads(itemId, structuredSku.skuPrices, authSession);
  const visibleText = page.visibleText || cheerio.load(html)("body").text();
  const visibleDiscountItems = collectDiscountItemsFromText(visibleText);
  structuredSku.skuPrices = applyVisibleDiscountItems(structuredSku.skuPrices, visibleDiscountItems);
  const selectedSkuId = extractSelectedSkuId(page.finalUrl, html, structuredSku.skuPrices.map((sku) => sku.skuId));
  structuredSku.skuPrices = applyVisibleSurprisePrice(
    structuredSku.skuPrices,
    collectVisibleSurprisePrices(visibleText),
    selectedSkuId,
  );
  structuredSku.skuPrices = applyProductProgramItems(structuredSku.skuPrices, collectProductProgramItems(html));
  structuredSku.skuPrices = structuredSku.skuPrices.map((sku) => calculateAccountPriceScenario(applyAppliedCoinDiscount(sku), accountType));
  structuredSku.skuPrices = applyNetworkPromoData(structuredSku.skuPrices, mobilePromotionPayloads, { accountType: authSession?.accountType || "normal" })
    .map((sku) => calculateAccountPriceScenario(sku, accountType));
  const shopName = extractShopName(html, jsonData, domData);
  const shopLogo = extractShopLogo(html, jsonData, domData);
  const model = extractModel(html, jsonData, domData);
  const prices = [...jsonData.prices, ...domData.priceMatches].filter((price) => price > 0);
  const structuredPrices = structuredSku.skuPrices.map((sku) => sku.price).filter((price) => price > 0);
  const allPrices = structuredPrices.length ? structuredPrices : prices;
  const minPrice = allPrices.length ? Math.min(...allPrices) : null;
  const maxPrice = allPrices.length ? Math.max(...allPrices) : null;
  const skuImages = unique([...structuredSku.skuImages, ...jsonData.skuImages]).slice(0, 40);
  const mobileDetailData = await fetchMobileDetailData(itemId, {
    ...authSession,
    cookie: page.cookieHeader || authSession?.cookie || "",
  }, product.url);
  if (mobileDetailData) {
    structuredSku.skuPrices = applyNetworkPromoData(structuredSku.skuPrices, [JSON.stringify(mobileDetailData)], { accountType })
      .map((sku) => calculateAccountPriceScenario(sku, accountType));
  }
  const knownPrimaryImages = [
    ...(product.knownPrimaryImages || []),
    product.lastSnapshot?.mainImage800,
    product.lastSnapshot?.mainImage,
    product.mainImage,
  ].filter((image) => /item_pic\./i.test(image || ""));
  const media = extractProductMedia(
    html,
    jsonData,
    domData,
    skuImages,
    mobileDetailData,
    knownPrimaryImages,
    product.knownGalleryImages || [],
    product.knownVideoUrls || [],
  );
  const sellerId = extractSellerId(html, [media.mainImage800, ...media.mainImages, ...skuImages]);
  const buyerShows = await fetchTmallBuyerShows(itemId, sellerId, page.cookieHeader || authSession?.cookie || "", product.url);
  if (buyerShows.length) media.buyerShows = buyerShows;
  const mainImages = media.mainImages;
  const rawSkuPrices = structuredSku.skuPrices.length
    ? structuredSku.skuPrices
    : prices.slice(0, 40).map((price, index) => ({
        skuId: `sku-${index + 1}`,
        name: `SKU ${index + 1}`,
        image: "",
        price,
        normalPrice: price,
        coinPrice: null,
        priceTitle: "普通价",
        priceLayers: [{ label: "普通价", value: price, kind: "price", source: "fallback" }],
      }));
  const skuPrices = rawSkuPrices.map((sku) => {
    const calculated = calculateAccountPriceScenario(applyAppliedCoinDiscount(sku), accountType);
    return { ...calculated, ...resolveCoinBenefit(calculated) };
  });
  const snapshotPrice = skuPrices[0]?.price || structuredSku.displayPrice || minPrice;
  if (!authSession && !Number.isFinite(snapshotPrice)) {
    throw new Error("淘宝匿名公开页未返回可用价格；已保留上次快照，个性化价格需要账号登录。");
  }

  const title = cleanTitle(jsonData.title || domData.title || product.name || "未识别商品标题");

  return {
    capturedAt: startedAt,
    statusCode: page.statusCode,
    finalUrl: page.finalUrl,
    source: page.source,
    accessMode: authSession ? "authenticated" : "anonymous",
    itemId,
    title,
    shopName,
    shopLogo,
    model,
    autoGroup: deriveAutoGroup({ shopName, model, title }),
    mainImage: media.mainImage800 || mainImages[0] || "",
    mainImage800: media.mainImage800 || mainImages[0] || "",
    gallery750Images: media.gallery750Images || mainImages.slice(1, 6),
    mainImages,
    detailImages: media.detailImages,
    buyerShows: media.buyerShows,
    videoUrls: media.videoUrls,
    skuImages,
    skuPrices,
    price: snapshotPrice,
    priceRange: minPrice && maxPrice ? [minPrice, maxPrice] : null,
    rawSignals: {
      htmlBytes: html.length,
      imageCount: mainImages.length,
      detailImageCount: media.detailImages.length,
      videoCount: media.videoUrls.length,
      buyerShowCount: media.buyerShows.length,
      skuImageCount: skuImages.length,
      priceCount: allPrices.length,
      highResImageCount: mainImages.length + media.detailImages.length,
      networkPriceResponseCount: page.networkPayloads?.length || 0,
      mobilePromotionResponseCount: mobilePromotionPayloads.length,
    },
  };
}
