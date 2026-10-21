import { TunnelError, toTunnelError } from "../core/errors";
import { buildPac, PROBE_HOSTS } from "../core/pac";
import type { ErrorCode, ProxySettings, TestInProgress } from "../core/types";
import type { ProxyControlSnapshot } from "./proxy-controller";

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_BASELINE_TIMEOUT_MS = 3_000;

const IFCONFIG_HOST = "ifconfig.me";

function formatUrlHost(host: string): string {
  const trimmed = host.replace(/\.+$/, "");
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

export function probeUrlsForHosts(hosts: readonly string[]): string[] {
  return hosts.map((host) => {
    const normalized = host.replace(/\.+$/, "").toLowerCase();
    const formatted = formatUrlHost(normalized);
    const path =
      normalized === IFCONFIG_HOST || normalized.endsWith(`.${IFCONFIG_HOST}`) ? "/ip" : "?format=json";
    return `https://${formatted}${path}`;
  });
}

export function resolveTestMarker(
  current: TestInProgress | null,
  outcome: Pick<ProbeOutcome, "recoveryRequired">,
): TestInProgress | null {
  return outcome.recoveryRequired ? current : null;
}

/**
 * A stale marker may only be dropped when recovery failed and the subsequent reconcile really
 * applied a known proxy state. Otherwise the snapshot is the only path back to a safe profile.
 */
export function shouldDiscardStaleMarker(recoveryFailed: boolean, applied: boolean): boolean {
  return recoveryFailed && applied;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export interface ProbeProxy {
  snapshot(): Promise<ProxyControlSnapshot>;
  set(value: chrome.proxy.ProxyConfig): Promise<void>;
  restore(snapshot: chrome.proxy.ProxyConfig): Promise<void>;
}

export interface ProbeMarkerStore {
  save(marker: TestInProgress): Promise<void>;
  clear(): Promise<void>;
}

export interface ProbeServiceOptions {
  proxy: ProbeProxy;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baselineTimeoutMs?: number;
  probeHosts?: readonly string[];
  readSignal?: () => ErrorCode | null;
  clearSignals?: () => void;
  marker?: ProbeMarkerStore;
}

export interface ProbeRunOptions {
  tunnelActive: boolean;
}

export interface ProbeOutcome {
  ok: boolean;
  exitIp: string | null;
  durationMs: number | null;
  directIp: string | null;
  suspectedDirect: boolean;
  errorCode: ErrorCode | null;
  recoveryRequired: boolean;
}

interface RequestOutcome {
  ip: string | null;
  durationMs: number;
  errorCode: ErrorCode | null;
}

function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return value.includes(":") && IPV6.test(value) && value.split(":").length >= 3;
}

export function parseExitIp(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ip" in parsed &&
      typeof (parsed as { ip: unknown }).ip === "string"
    ) {
      const ip = (parsed as { ip: string }).ip.trim();
      return isIpAddress(ip) ? ip : null;
    }
  } catch {
    void 0;
  }

  return isIpAddress(trimmed) ? trimmed : null;
}

function statusToError(status: number): ErrorCode {
  if (status === 407) {
    return "E_AUTH_407";
  }
  if (status === 403) {
    return "E_FORBIDDEN_403";
  }
  if (status === 429) {
    return "E_LIMIT";
  }
  return "E_UNKNOWN";
}

function isFatalAuthError(code: ErrorCode): boolean {
  return (
    code === "E_AUTH_407" ||
    code === "E_UNSUPPORTED_AUTH" ||
    code === "E_PROXY_TLS" ||
    code === "E_PROXY_UNREACHABLE" ||
    code === "E_POLICY" ||
    code === "E_OTHER_EXT"
  );
}

export class ProbeService {
  private readonly proxy: ProbeProxy;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly baselineTimeoutMs: number;
  private readonly probeHosts: readonly string[];
  private readonly proxyIpUrls: readonly string[];
  private readonly directIpUrl: string;
  private readonly readSignal: () => ErrorCode | null;
  private readonly clearSignals: () => void;
  private readonly marker: ProbeMarkerStore | undefined;

  constructor(options: ProbeServiceOptions) {
    this.proxy = options.proxy;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.baselineTimeoutMs = options.baselineTimeoutMs ?? PROBE_BASELINE_TIMEOUT_MS;
    this.probeHosts = options.probeHosts ?? PROBE_HOSTS;
    this.proxyIpUrls = probeUrlsForHosts(this.probeHosts);
    this.directIpUrl = this.proxyIpUrls[0] ?? "https://api.ipify.org?format=json";
    this.readSignal = options.readSignal ?? (() => null);
    this.clearSignals = options.clearSignals ?? (() => undefined);
    this.marker = options.marker;
  }

  async run(settings: ProxySettings, options: ProbeRunOptions): Promise<ProbeOutcome> {
    const startedAt = this.now();
    const deadline = startedAt + this.timeoutMs;
    this.clearSignals();

    const directIp = options.tunnelActive
      ? null
      : await this.baselineDirectIp(
          Math.min(deadline, startedAt + this.baselineTimeoutMs),
        );

    let snapshot: chrome.proxy.ProxyConfig | null = null;
    let configTouched = false;
    let recoveryRequired = false;
    let outcome: ProbeOutcome = {
      ok: false,
      exitIp: null,
      durationMs: null,
      directIp,
      suspectedDirect: false,
      errorCode: null,
      recoveryRequired: false,
    };

    try {
      const current = await this.proxy.snapshot();
      snapshot = current.value;

      if (this.marker !== undefined) {
        await this.marker.save({ at: this.now(), snapshot });
      }

      if (options.tunnelActive) {
        outcome = await this.probeThroughExistingConfig(deadline, directIp);
      } else {
        this.assertControllable(current.levelOfControl);
        const pac = buildPac(settings, this.probeHosts);

        configTouched = true;
        await this.proxy.set({
          mode: "pac_script",
          pacScript: { data: pac, mandatory: true },
        });

        outcome = await this.probeThroughExistingConfig(deadline, directIp);
      }
    } catch (error) {
      const code = toTunnelError(error).code;
      outcome = { ...outcome, errorCode: code };
    } finally {
      if (snapshot !== null) {
        if (configTouched) {
          try {
            await this.proxy.restore(snapshot);
          } catch {
            recoveryRequired = true;
            outcome = { ...outcome, ok: false, errorCode: outcome.errorCode ?? "E_UNKNOWN" };
          }
        }
        if (!recoveryRequired && this.marker !== undefined) {
          try {
            await this.marker.clear();
          } catch {
            void 0;
          }
        }
      }
      this.clearSignals();
    }

    return { ...outcome, recoveryRequired };
  }

  private assertControllable(levelOfControl: ProxyControlSnapshot["levelOfControl"]): void {
    if (levelOfControl === "not_controllable") {
      throw new TunnelError("E_POLICY");
    }
    if (levelOfControl === "controlled_by_other_extensions") {
      throw new TunnelError("E_OTHER_EXT");
    }
  }

  private async probeThroughExistingConfig(
    deadline: number,
    directIp: string | null,
  ): Promise<ProbeOutcome> {
    const result = await this.requestProxyIp(deadline);
    const exitIp = result.ip;
    const ok = exitIp !== null && result.errorCode === null;

    return {
      ok,
      exitIp,
      durationMs: result.durationMs,
      directIp,
      suspectedDirect: ok && directIp !== null && exitIp === directIp,
      errorCode: ok ? null : (result.errorCode ?? "E_UNKNOWN"),
      recoveryRequired: false,
    };
  }

  private async baselineDirectIp(deadline: number): Promise<string | null> {
    try {
      const result = await this.request(this.directIpUrl, deadline);
      return result.ip;
    } catch {
      return null;
    }
  }

  private async requestProxyIp(deadline: number): Promise<RequestOutcome> {
    let total = 0;
    let lastError: ErrorCode = "E_UNKNOWN";

    for (const url of this.proxyIpUrls) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return { ip: null, durationMs: total, errorCode: "E_TIMEOUT" };
      }

      const result = await this.request(url, deadline);
      total += result.durationMs;

      if (result.errorCode === null && result.ip !== null) {
        return { ip: result.ip, durationMs: total, errorCode: null };
      }

      lastError = result.errorCode ?? "E_UNKNOWN";
      if (lastError === "E_TIMEOUT" || isFatalAuthError(lastError)) {
        return { ip: null, durationMs: total, errorCode: lastError };
      }
    }

    return { ip: null, durationMs: total, errorCode: lastError };
  }

  private async request(url: string, deadline: number): Promise<RequestOutcome> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      return { ip: null, durationMs: 0, errorCode: "E_TIMEOUT" };
    }

    const started = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
    });

    const request = (async (): Promise<{ kind: "response"; text: string; status: number }> => {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
      });
      const text = await response.text();
      return { kind: "response", text, status: response.status };
    })().catch(() => ({ kind: "error" as const }));

    try {
      const result = await Promise.race([request, timeout]);
      const durationMs = this.now() - started;

      if (result === "timeout") {
        controller.abort();
        return { ip: null, durationMs, errorCode: "E_TIMEOUT" };
      }

      if (result.kind === "error") {
        return { ip: null, durationMs, errorCode: this.signalOr("E_NO_NETWORK") };
      }

      if (result.status < 200 || result.status >= 300) {
        return { ip: null, durationMs, errorCode: statusToError(result.status) };
      }

      const ip = parseExitIp(result.text);
      if (ip === null) {
        return { ip: null, durationMs, errorCode: "E_UNKNOWN" };
      }

      return { ip, durationMs, errorCode: null };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private signalOr(fallback: ErrorCode): ErrorCode {
    return this.readSignal() ?? fallback;
  }
}
