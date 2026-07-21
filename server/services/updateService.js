const RELEASES_API = "https://api.github.com/repos/PMZPZM0/ecom-competitor-monitor/releases/latest";
const DOWNLOAD_MIRROR = "https://jvsppl.vip/ecom-monitor/releases";
const CACHE_MS = 30 * 60_000;
let cachedRelease = null;

function versionParts(value) {
  return String(value || "0")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function selectReleaseAsset(assets, platform = process.platform, arch = process.arch) {
  const candidates = Array.isArray(assets) ? assets : [];
  const patterns = platform === "win32"
    ? [/win(?:dows)?[-_. ]*x64.*\.exe$/i, /x64.*\.exe$/i, /\.exe$/i]
    : platform === "darwin" && arch === "arm64"
      ? [/mac(?:os)?[-_. ]*arm64.*\.dmg$/i, /apple.?silicon.*\.dmg$/i, /arm64.*\.dmg$/i]
      : platform === "darwin"
        ? [/mac(?:os)?[-_. ]*x64.*\.dmg$/i, /intel.*\.dmg$/i, /x64.*\.dmg$/i]
        : [];
  for (const pattern of patterns) {
    const asset = candidates.find((item) => pattern.test(String(item?.name || "")) && /^https:\/\/github\.com\//i.test(String(item?.browser_download_url || "")));
    if (asset) return asset;
  }
  return null;
}

export function acceleratedDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return "";
    const match = url.pathname.match(/^\/PMZPZM0\/ecom-competitor-monitor\/releases\/download\/([^/]+)\/([^/]+)$/i);
    if (!match) return "";
    const tag = decodeURIComponent(match[1]);
    const assetName = decodeURIComponent(match[2]);
    if (!/^v[0-9]+(?:\.[0-9]+){2}(?:[-.][a-z0-9.-]+)?$/i.test(tag) || !/^[^/\\]+\.(?:exe|dmg)$/i.test(assetName)) return "";
    return `${DOWNLOAD_MIRROR}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  } catch {
    return "";
  }
}

async function latestRelease() {
  if (cachedRelease?.expiresAt > Date.now()) return cachedRelease.value;
  const response = await fetch(RELEASES_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ecom-competitor-monitor",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GitHub Releases 返回 ${response.status}`);
  const value = await response.json();
  if (!value?.tag_name || !/^https:\/\/github\.com\//i.test(String(value.html_url || ""))) {
    throw new Error("GitHub Releases 返回的数据不完整");
  }
  cachedRelease = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

export async function checkForUpdate(currentVersion, runtime = {}) {
  const release = await latestRelease();
  const latestVersion = String(release.tag_name).replace(/^v/i, "");
  const platform = runtime.platform || process.platform;
  const arch = runtime.arch || process.arch;
  const asset = selectReleaseAsset(release.assets, platform, arch);
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseName: String(release.name || release.tag_name),
    notes: String(release.body || "本次版本暂无更新说明。").slice(0, 8_000),
    publishedAt: release.published_at || null,
    releaseUrl: release.html_url,
    downloadUrl: asset?.browser_download_url || release.html_url,
    acceleratedDownloadUrl: asset ? acceleratedDownloadUrl(asset.browser_download_url) : "",
    assetName: asset?.name || "",
    assetSize: Number(asset?.size) || 0,
    assetDigest: /^sha256:[a-f0-9]{64}$/i.test(String(asset?.digest || "")) ? asset.digest : "",
    platform,
    arch,
    checkedAt: new Date().toISOString(),
  };
}
