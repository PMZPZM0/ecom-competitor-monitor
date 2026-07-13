const urls = [
  "https://assets.diantoushi.com/v3/tb_detail/js/_common.0b2f8592.js",
  "https://assets.diantoushi.com/v3/tb_detail/js/_detail.d7382b28.js",
  "https://assets.diantoushi.com/v3/tb_detail/js/item.ce533632.js",
  "https://assets.diantoushi.com/v3/tb_detail/js/search.542e5bcb.js",
];

const terms = ["1:1", "1440", "主图", "goods_image", "itemPic", "picUrl", "mainPic", "download", "素材", "media", "api/"];

for (const url of urls) {
  const response = await fetch(url);
  const source = await response.text();
  const snippets = {};
  for (const term of terms) {
    const matches = [];
    let offset = 0;
    while (matches.length < 6) {
      const index = source.indexOf(term, offset);
      if (index < 0) break;
      matches.push(source.slice(Math.max(0, index - 240), index + term.length + 500));
      offset = index + term.length;
    }
    if (matches.length) snippets[term] = matches;
  }
  const discoveredUrls = Array.from(source.matchAll(/https?:\/\/[^"'\s)]+/g), (match) => match[0]);
  console.log(JSON.stringify({ url, status: response.status, bytes: source.length, discoveredUrls: [...new Set(discoveredUrls)].slice(0, 40), snippets }, null, 2));
}
