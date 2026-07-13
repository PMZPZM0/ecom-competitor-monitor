import crypto from "node:crypto";

export function buildTaobaoOAuthUrl() {
  const appKey = process.env.TAOBAO_APP_KEY;
  const redirectUri = process.env.TAOBAO_REDIRECT_URI;
  if (!appKey || !redirectUri) {
    return {
      configured: false,
      message: "请在 .env 中配置 TAOBAO_APP_KEY 和 TAOBAO_REDIRECT_URI 后使用淘宝开放平台授权。",
    };
  }

  const state = crypto.randomBytes(12).toString("hex");
  const url = new URL("https://oauth.taobao.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("view", "web");
  return { configured: true, state, url: url.toString() };
}

export function maskCookie(cookie) {
  if (!cookie) return "";
  return `${cookie.slice(0, 18)}...${cookie.slice(-10)}`;
}

export function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 10) return `${secret.slice(0, 2)}***`;
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}
