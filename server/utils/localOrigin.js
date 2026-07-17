const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedLocalOrigin(origin) {
  if (origin == null) return true;
  if (typeof origin !== "string" || !origin) return false;

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && LOCAL_HOSTNAMES.has(url.hostname)
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function isAllowedLocalHost(host) {
  if (typeof host !== "string" || !host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function isAllowedLocalRequest({ origin, host, secFetchSite } = {}) {
  if (!isAllowedLocalHost(host) || !isAllowedLocalOrigin(origin)) return false;
  return !secFetchSite || ["same-origin", "same-site", "none"].includes(String(secFetchSite).toLowerCase());
}

export const localCorsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedLocalOrigin(origin));
  },
};
