function buildRuleInsights(products, snapshots) {
  const insights = [];

  for (const product of products) {
    const history = snapshots
      .filter((item) => item.productId === product.id && item.price)
      .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));

    if (history.length < 2) {
      insights.push(`${product.name} 数据仍在积累中，建议至少保留 2 次抓取后再判断趋势。`);
      continue;
    }

    const first = history[0].price;
    const latest = history[history.length - 1].price;
    const delta = latest - first;
    const percent = first ? ((delta / first) * 100).toFixed(1) : "0.0";
    const direction = delta < 0 ? "下调" : delta > 0 ? "上调" : "稳定";
    insights.push(`${product.name} 当前价格 ${latest}，较首条记录${direction} ${Math.abs(delta).toFixed(2)}（${percent}%）。`);
  }

  return insights;
}

export async function analyzeData({ products, snapshots, modelConfig = {} }) {
  const payload = {
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      shopName: product.shopName || product.lastSnapshot?.shopName || "",
      model: product.model || product.lastSnapshot?.model || "",
      autoGroup: product.autoGroup || product.lastSnapshot?.autoGroup || "",
      url: product.url,
      lastPrice: product.lastSnapshot?.price ?? null,
      lastStatus: product.lastStatus,
    })),
    recentSnapshots: snapshots.slice(-60),
  };

  const { apiKey, baseUrl, model } = resolveModelConfig(modelConfig);

  if (!apiKey) {
    return {
      mode: "rule-based",
      summary: "未配置模型 API Key，已使用本地规则生成分析。",
      insights: buildRuleInsights(products, snapshots),
      createdAt: new Date().toISOString(),
    };
  }

  const data = await requestModelApiJson(`${baseUrl}/responses`, {
    apiKey,
    label: "AI 分析",
    timeoutMs: 60_000,
    body: {
      model,
      input: [
        {
          role: "system",
          content: "你是电商竞品价格监控分析师。输出简洁中文，包含风险、机会和下一步动作。",
        },
        {
          role: "user",
          content: `请分析这些天猫竞品监控数据，输出 JSON：{"summary":"","insights":[],"actions":[]}。\n${JSON.stringify(payload)}`,
        },
      ],
    },
  });
  const text = data.output_text || data.output?.flatMap((item) => item.content || []).map((item) => item.text).join("\n");

  try {
    return { mode: "ai", ...JSON.parse(text), createdAt: new Date().toISOString() };
  } catch {
    return { mode: "ai", summary: text || "AI 已返回分析结果。", insights: [], actions: [], createdAt: new Date().toISOString() };
  }
}
import { requestModelApiJson, resolveModelConfig } from "./modelConfigService.js";
