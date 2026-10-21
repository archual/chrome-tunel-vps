import { TunnelError } from "./errors";
import { normalizeProxySettings, validateProxyEndpoint } from "./proxy-config";
import type { ProxySettings } from "./types";

export const PROBE_HOSTS = ["api.ipify.org", "ifconfig.me"] as const;

const PAC_FORBIDDEN_CHARS = /[\s;'"`\\<>(){}|,/]/;
const ASCII_HOST = /^[a-z0-9._-]+$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/;

function isIpv4(value: string): boolean {
  return IPV4.test(value) && value.split(".").every((part) => Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  return value.includes(":") && value.split(":").length >= 3 && IPV6.test(value);
}

function toAsciiHostname(host: string): string {
  try {
    const parsed = new URL(`http://${host}/`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/") {
      throw new Error("invalid host");
    }
    const ascii = parsed.hostname.toLowerCase();
    if (ascii.length === 0 || ascii.length > 253 || !ASCII_HOST.test(ascii)) {
      throw new Error("invalid host");
    }
    return ascii;
  } catch {
    throw new TunnelError("E_CFG_HOST");
  }
}

export function normalizePacHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  host = host.replace(/\.+$/, "");

  if (
    host.length === 0 ||
    host.length > 253 ||
    PAC_FORBIDDEN_CHARS.test(host) ||
    host.includes("://") ||
    host.includes("@")
  ) {
    throw new TunnelError("E_CFG_HOST");
  }

  if (isIpv4(host) || isIpv6(host)) {
    return host;
  }

  if (host.includes(":")) {
    throw new TunnelError("E_CFG_HOST");
  }

  return toAsciiHostname(host);
}

function formatProxyDirective(settings: ProxySettings): string {
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  const directive = settings.scheme === "http" ? "PROXY" : "HTTPS";
  return `${directive} ${host}:${settings.port}`;
}

export function buildPac(
  settings: Pick<ProxySettings, "scheme" | "host" | "port">,
  probeHosts: readonly string[] = PROBE_HOSTS,
): string {
  const normalized = normalizeProxySettings({
    scheme: settings.scheme,
    host: settings.host,
    port: settings.port,
    username: "",
    password: "",
  });
  validateProxyEndpoint(normalized);

  const directive = formatProxyDirective(normalized);
  const hosts = [...new Set(probeHosts.map((host) => normalizePacHost(host)))];

  const lines = ["function FindProxyForURL(url, host) {", "  host = String(host).toLowerCase();"];

  if (hosts.length > 0) {
    const clauses = hosts.flatMap((host) => {
      if (isIpv4(host) || isIpv6(host)) {
        const literal = host.includes(":") ? `[${host}]` : host;
        return [`host === ${JSON.stringify(literal)}`];
      }
      return [
        `host === ${JSON.stringify(host)}`,
        `dnsDomainIs(host, ${JSON.stringify(`.${host}`)})`,
      ];
    });
    lines.push(`  if (${clauses.join(" ||\n      ")}) {`);
    lines.push(`    return ${JSON.stringify(directive)};`);
    lines.push("  }");
  }

  lines.push('  return "DIRECT";');
  lines.push("}");

  return `${lines.join("\n")}\n`;
}
