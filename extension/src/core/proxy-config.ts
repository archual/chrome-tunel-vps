import { buildBypassList } from "./bypass";
import { TunnelError } from "./errors";
import type { Exclusions, ProxySettings, TunnelScheme } from "./types";

export interface FixedProxyConfig {
  mode: "fixed_servers";
  rules: {
    singleProxy: {
      scheme: TunnelScheme;
      host: string;
      port: number;
    };
    bypassList: string[];
  };
}

const HOST_FORBIDDEN = /[\s/?#@\\]/;

export function normalizeHost(rawHost: string): string {
  let host = rawHost.trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  host = host.replace(/\.$/, "");
  return host.toLowerCase();
}

export function normalizeProxySettings(settings: ProxySettings): ProxySettings {
  return {
    scheme: settings.scheme === "http" ? "http" : "https",
    host: normalizeHost(settings.host),
    port: settings.port,
    username: settings.username.trim(),
    password: settings.password,
  };
}

export function validateProxyEndpoint(settings: ProxySettings): void {
  const host = normalizeHost(settings.host);

  if (host.length === 0 || host.length > 253 || HOST_FORBIDDEN.test(host) || host.includes("://")) {
    throw new TunnelError("E_CFG_HOST");
  }

  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new TunnelError("E_CFG_PORT");
  }

  if (settings.scheme !== "https" && settings.scheme !== "http") {
    throw new TunnelError("E_CFG_HOST");
  }
}

export function buildProxyConfig(settings: ProxySettings, exclusions?: Exclusions): FixedProxyConfig {
  const normalized = normalizeProxySettings(settings);
  validateProxyEndpoint(normalized);

  const extra = exclusions?.extra ?? [];

  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: normalized.scheme,
        host: normalized.host,
        port: normalized.port,
      },
      bypassList: buildBypassList(normalized.host, extra),
    },
  };
}
