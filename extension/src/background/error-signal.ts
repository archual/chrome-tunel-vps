import type { ErrorCode } from "../core/types";

export type ErrorSignalKind = "auth" | "proxy";

interface SignalEntry {
  code: ErrorCode;
  at: number;
}

export class RuntimeErrorSignal {
  private readonly signals = new Map<ErrorSignalKind, SignalEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = 10_000,
  ) {}

  set(kind: ErrorSignalKind, code: ErrorCode): void {
    this.signals.set(kind, { code, at: this.now() });
  }

  get(kind: ErrorSignalKind): ErrorCode | null {
    const entry = this.signals.get(kind);
    if (entry === undefined) {
      return null;
    }
    if (this.now() - entry.at > this.ttlMs) {
      this.signals.delete(kind);
      return null;
    }
    return entry.code;
  }

  clear(): void {
    this.signals.clear();
  }
}

export function isProxyContextError(error: string): boolean {
  const text = error.toUpperCase();
  return text.includes("ERR_PROXY_") || text.includes("ERR_TUNNEL_");
}

export function mapRequestErrorText(error: string): ErrorCode | null {
  return isProxyContextError(error) ? mapProxyErrorText(error) : null;
}

export function mapProxyErrorText(error: string): ErrorCode | null {
  const text = error.toUpperCase();

  if (text.includes("AUTH_UNSUPPORTED")) {
    return "E_UNSUPPORTED_AUTH";
  }
  if (text.includes("CERT") || text.includes("TLS") || text.includes("SSL")) {
    return "E_PROXY_TLS";
  }
  if (text.includes("AUTH") || text.includes("407")) {
    return "E_AUTH_407";
  }
  if (text.includes("INTERNET_DISCONNECTED") || text.includes("NETWORK_CHANGED")) {
    return "E_NO_NETWORK";
  }
  if (text.includes("TIMED_OUT") || text.includes("TIMEOUT")) {
    return "E_TIMEOUT";
  }
  if (text.includes("PROXY") || text.includes("TUNNEL")) {
    return "E_PROXY_UNREACHABLE";
  }

  return null;
}
