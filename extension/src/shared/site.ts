import type { ActiveTabInfo } from "./types";

const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "::"
  ) {
    return true;
  }

  if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) {
    return true;
  }

  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) {
    return true;
  }

  return false;
}

export function describeActiveTab(url: string | undefined): ActiveTabInfo {
  if (!url) {
    return { kind: "unsupported", host: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unsupported", host: null, url };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "unsupported", host: null, url };
  }

  if (!parsed.hostname) {
    return { kind: "unsupported", host: null, url };
  }

  const host = parsed.hostname.toLowerCase();
  return { kind: isLocalHostname(host) ? "local" : "web", host, url };
}

export function siteMatchesHost(site: string, host: string | null): boolean {
  if (!host) {
    return false;
  }
  const normalizedSite = site.toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
}
