const COPY_VALUE_PATTERN = "(?:[“‘\"']([^”’\"'\\r\\n]{1,300})[”’\"']|([^，。；;\\r\\n]{1,300}))";
const NO_TEXT_PATTERN = /(?:无字(?:底图|海报)?|无文字(?:版|底图)?|(?:不要|不加|不生成|不需要|无需|不放|不显示)(?:任何|新增|额外|所有)?(?:的)?(?:文字|文案|字)(?!太小|过小|太多|过多|乱码|错字|错误|模糊|变形|重叠|遮挡|改动|修改|变化)|只要(?:纯)?(?:底图|背景)(?:[，,、\s]*(?:不要|不加|不生成)(?:任何|新增|额外)?(?:的)?(?:文字|文案|字))?|(?:文字|文案)(?:留到|放到|交给)?后期排版|no\s*text)/i;
const EXPLICIT_POSTER_FORMAT_PATTERN = /(海报|活动图|促销图|宣传图|大促|主视觉|节日视觉|banner|\bkv\b|详情页|详情图|卖点图|功能图)/i;
const POSTER_INTENT_PATTERN = /(海报|活动图|促销图|宣传图|大促|促销|活动|主视觉|节日视觉|国庆|中秋|春节|新春|618|双\s*11|双十一|年货节|开学季|节日|banner|\bkv\b|详情页|详情图|卖点图|功能图)/i;
const SCENE_INTENT_PATTERN = /(场景图|场景摄影|生活场景|使用场景|聚餐场景)/i;

function cleanCopyValue(quoted, plain) {
  return String(quoted || plain || "").trim().replace(/[”’"']$/, "");
}

function labeledValues(text, labels) {
  const expression = new RegExp(
    `(?:${labels})(?:\\s*\\d+)?\\s*(?:必须\\s*)?(?:写(?:成|为)?|改成|替换为|设置为|用|为|是|[：:])\\s*${COPY_VALUE_PATTERN}`,
    "gi",
  );
  return [...text.matchAll(expression)]
    .map((match) => cleanCopyValue(match[1], match[2]))
    .filter(Boolean);
}

export function extractExplicitPosterCopy(value) {
  const text = String(value || "");
  const titles = labeledValues(text, "主标题|(?<!副)标题|文案");
  const subtitles = labeledValues(text, "副标题");
  const sellingPoints = labeledValues(text, "卖点");
  const prices = labeledValues(text, "价格|到手价|活动价|售价");
  const campaignInfo = labeledValues(text, "活动信息|活动规则");
  const additionalText = labeledValues(text, "补充文字|附加文字");
  if (!titles.length) {
    const written = text.match(new RegExp(`(?:写上|写出|(?<!不)显示(?:文字)?|呈现文字|(?:海报|画面)(?:上|中)?写)\\s*${COPY_VALUE_PATTERN}`, "i"));
    const title = written && cleanCopyValue(written[1], written[2]);
    if (title) titles.push(title);
  }
  const plan = {
    mode: "exact",
    title: titles[0] || "",
    subtitle: subtitles[0] || "",
    sellingPoints,
    price: prices[0] || "",
    campaignInfo: campaignInfo[0] || "",
    additionalText: [...titles.slice(1), ...subtitles.slice(1), ...additionalText],
  };
  return {
    ...plan,
    hasCopy: Boolean(plan.title || plan.subtitle || plan.price || plan.campaignInfo
      || plan.sellingPoints.length || plan.additionalText.length),
  };
}

export function hasPosterIntent(value) {
  const text = String(value || "");
  if (SCENE_INTENT_PATTERN.test(text) && !EXPLICIT_POSTER_FORMAT_PATTERN.test(text)) return false;
  return POSTER_INTENT_PATTERN.test(text);
}

export function explicitlyRequestsNoText(value) {
  const text = String(value || "");
  return !extractExplicitPosterCopy(text).hasCopy && NO_TEXT_PATTERN.test(text);
}
