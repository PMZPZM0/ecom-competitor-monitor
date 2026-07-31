export const CLOUD_SYNC_PROTOCOL = "ecom-monitor:";
export const CLOUD_SYNC_HOST = "cloud-sync";

export function cloudLinkFromArgs(args) {
  return (Array.isArray(args) ? args : []).find((value) => {
    return typeof value === "string" && value.toLowerCase().startsWith(`${CLOUD_SYNC_PROTOCOL}//`);
  }) || null;
}

export function parseCloudLink(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== CLOUD_SYNC_PROTOCOL || parsed.hostname !== CLOUD_SYNC_HOST) return null;

    const code = parsed.searchParams.get("code")?.trim() || "";
    const endpoint = parsed.searchParams.get("endpoint")?.trim() || "";
    if (!code) return null;

    return { code, endpoint };
  } catch {
    return null;
  }
}
