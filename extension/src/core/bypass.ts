export const DEFAULT_BYPASS_LIST = [
  "<local>",
  "localhost",
  "127.0.0.0/8",
  "[::1]",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  "fe80::/10",
  "*.local",
] as const;

function isIpv6WithoutBrackets(value: string): boolean {
  return value.includes(":") && !value.startsWith("[") && !value.includes("/");
}

export function normalizeBypassHost(host: string): string {
  const trimmed = host.trim().replace(/^\[|\]$/g, "");
  if (isIpv6WithoutBrackets(trimmed)) {
    return `[${trimmed.toLowerCase()}]`;
  }
  return trimmed.toLowerCase();
}

export function buildBypassList(proxyHost?: string | null, extra: readonly string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const push = (entry: string): void => {
    const value = entry.trim();
    if (value.length === 0) {
      return;
    }
    const key = value.toLowerCase();
    if (key === "<-loopback>") {
      return;
    }
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(value);
  };

  for (const entry of DEFAULT_BYPASS_LIST) {
    push(entry);
  }

  if (proxyHost && proxyHost.trim().length > 0) {
    push(normalizeBypassHost(proxyHost));
  }

  for (const entry of extra) {
    push(entry);
  }

  return result;
}
