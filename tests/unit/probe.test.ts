import { describe, expect, it } from "vitest";
import {
  parseExitIp,
  probeUrlsForHosts,
  ProbeService,
  resolveTestMarker,
  shouldDiscardStaleMarker,
  type ProbeMarkerStore,
  type ProbeProxy,
} from "../../extension/src/background/probe";
import type { ErrorCode, ProxySettings, TestInProgress } from "../../extension/src/core/types";
import type { ProxyControlSnapshot } from "../../extension/src/background/proxy-controller";

const settings: ProxySettings = {
  scheme: "https",
  host: "proxy.k1812.ru",
  port: 443,
  username: "owner",
  password: "secret",
};

const DIRECT_IP = "198.51.100.5";
const PROXY_IP = "203.0.113.10";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

interface FakeProxyOptions {
  levelOfControl?: ProxyControlSnapshot["levelOfControl"];
  failRestore?: boolean;
  failSet?: boolean;
}

function createProxy(options: FakeProxyOptions = {}): {
  proxy: ProbeProxy;
  calls: string[];
  values: chrome.proxy.ProxyConfig[];
  current: () => chrome.proxy.ProxyConfig;
} {
  let value: chrome.proxy.ProxyConfig = { mode: "system" };
  const calls: string[] = [];
  const values: chrome.proxy.ProxyConfig[] = [];

  return {
    proxy: {
      async snapshot() {
        return {
          value: structuredClone(value),
          levelOfControl: options.levelOfControl ?? "controllable_by_this_extension",
        };
      },
      async set(next) {
        calls.push("set");
        if (options.failSet === true) {
          throw new Error("set failed");
        }
        values.push(structuredClone(next));
        value = structuredClone(next);
      },
      async restore(snapshot) {
        calls.push("restore");
        if (options.failRestore === true) {
          throw new Error("restore failed");
        }
        value = structuredClone(snapshot);
      },
    },
    calls,
    values,
    current: () => value,
  };
}

function createMarker(): { marker: ProbeMarkerStore; saved: TestInProgress[]; cleared: number } {
  const saved: TestInProgress[] = [];
  let cleared = 0;

  const marker: ProbeMarkerStore = {
    async save(value) {
      saved.push(value);
    },
    async clear() {
      cleared += 1;
    },
  };

  return {
    marker,
    saved,
    get cleared() {
      return cleared;
    },
  };
}

type FetchStep = () => Promise<Response>;

function createFetch(steps: FetchStep[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let index = 0;

  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) {
      throw new Error("unexpected fetch");
    }
    return step();
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function createProbe(
  proxy: ProbeProxy,
  fetchImpl: typeof fetch,
  options: {
    timeoutMs?: number;
    baselineTimeoutMs?: number;
    readSignal?: () => ErrorCode | null;
    marker?: ProbeMarkerStore;
  } = {},
): ProbeService {
  return new ProbeService({
    proxy,
    fetchImpl,
    now: () => Date.now(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.baselineTimeoutMs === undefined ? {} : { baselineTimeoutMs: options.baselineTimeoutMs }),
    ...(options.readSignal === undefined ? {} : { readSignal: options.readSignal }),
    ...(options.marker === undefined ? {} : { marker: options.marker }),
  });
}

describe("parseExitIp", () => {
  it("parses JSON, plain text and rejects garbage", () => {
    expect(parseExitIp('{"ip":"203.0.113.10"}')).toBe("203.0.113.10");
    expect(parseExitIp(" 203.0.113.10\n")).toBe("203.0.113.10");
    expect(parseExitIp("2001:db8::1")).toBe("2001:db8::1");
    expect(parseExitIp("<html>oops</html>")).toBeNull();
    expect(parseExitIp("999.1.1.1")).toBeNull();
  });
});

describe("ProbeService", () => {
  it("uses a temporary PAC, measures exit IP, and restores the snapshot", async () => {
    const { proxy, calls, values, current } = createProxy();
    const marker = createMarker();
    const { fetchImpl, calls: fetchCalls } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
      () => Promise.resolve(jsonResponse({ ip: PROXY_IP })),
    ]);

    const outcome = await createProbe(proxy, fetchImpl, { marker: marker.marker }).run(settings, {
      tunnelActive: false,
    });

    expect(outcome).toMatchObject({
      ok: true,
      exitIp: PROXY_IP,
      directIp: DIRECT_IP,
      suspectedDirect: false,
      errorCode: null,
      recoveryRequired: false,
    });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchCalls).toHaveLength(2);
    expect(calls).toEqual(["set", "restore"]);
    expect(current()).toEqual({ mode: "system" });
    expect(marker.saved).toHaveLength(1);
    expect(marker.cleared).toBe(1);

    const pac = values[0];
    expect(pac?.mode).toBe("pac_script");
    expect(pac?.pacScript?.mandatory).toBe(true);
    expect(pac?.pacScript?.data).toContain('host === "api.ipify.org"');
    expect(pac?.pacScript?.data).toContain('host === "ifconfig.me"');
    expect(pac?.pacScript?.data).not.toContain("owner");
    expect(pac?.pacScript?.data).not.toContain("secret");
  });

  it("flags a direct exit IP that matches the proxy result", async () => {
    const { proxy } = createProxy();
    const { fetchImpl } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
    ]);

    const outcome = await createProbe(proxy, fetchImpl).run(settings, { tunnelActive: false });

    expect(outcome.ok).toBe(true);
    expect(outcome.suspectedDirect).toBe(true);
  });

  it("does not touch chrome.proxy when the tunnel is already active", async () => {
    const { proxy, calls } = createProxy();
    const marker = createMarker();
    const { fetchImpl, calls: fetchCalls } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: PROXY_IP })),
    ]);

    const outcome = await createProbe(proxy, fetchImpl, { marker: marker.marker }).run(settings, {
      tunnelActive: true,
    });

    expect(outcome).toMatchObject({ ok: true, exitIp: PROXY_IP, directIp: null, suspectedDirect: false });
    expect(calls).toEqual([]);
    expect(fetchCalls).toHaveLength(1);
    expect(marker.saved).toHaveLength(1);
    expect(marker.cleared).toBe(1);
  });

  it("restores the snapshot after a 407 and reports E_AUTH_407", async () => {
    const { proxy, calls } = createProxy();
    const { fetchImpl } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
      () => Promise.resolve(textResponse("", 407)),
    ]);

    const outcome = await createProbe(proxy, fetchImpl).run(settings, { tunnelActive: false });

    expect(outcome).toMatchObject({ ok: false, errorCode: "E_AUTH_407" });
    expect(calls).toEqual(["set", "restore"]);
  });

  it("times out after the configured deadline and still restores", async () => {
    const { proxy, calls } = createProxy();
    const { fetchImpl } = createFetch([() => new Promise<Response>(() => undefined)]);

    const outcome = await createProbe(proxy, fetchImpl, {
      timeoutMs: 60,
      baselineTimeoutMs: 20,
    }).run(settings, { tunnelActive: false });

    expect(outcome.errorCode).toBe("E_TIMEOUT");
    expect(calls).toEqual(["set", "restore"]);
  });

  it("maps an unreachable network to E_NO_NETWORK", async () => {
    const { proxy, calls } = createProxy();
    const { fetchImpl } = createFetch([
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]);

    const outcome = await createProbe(proxy, fetchImpl).run(settings, { tunnelActive: false });

    expect(outcome.errorCode).toBe("E_NO_NETWORK");
    expect(calls).toEqual(["set", "restore"]);
  });

  it("prefers the runtime proxy signal such as E_PROXY_TLS", async () => {
    const { proxy } = createProxy();
    const { fetchImpl } = createFetch([() => Promise.reject(new TypeError("Failed to fetch"))]);

    const outcome = await createProbe(proxy, fetchImpl, {
      readSignal: () => "E_PROXY_TLS",
    }).run(settings, { tunnelActive: false });

    expect(outcome.errorCode).toBe("E_PROXY_TLS");
  });

  it("retries the second probe host when the first one fails", async () => {
    const { proxy } = createProxy();
    const { fetchImpl, calls } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
      () => Promise.resolve(textResponse("", 500)),
      () => Promise.resolve(textResponse(PROXY_IP)),
    ]);

    const outcome = await createProbe(proxy, fetchImpl).run(settings, { tunnelActive: false });

    expect(outcome).toMatchObject({ ok: true, exitIp: PROXY_IP });
    expect(calls).toHaveLength(3);
  });

  it("does not touch the proxy when another actor controls it", async () => {
    const { proxy, calls } = createProxy({ levelOfControl: "controlled_by_other_extensions" });
    const { fetchImpl } = createFetch([() => Promise.resolve(jsonResponse({ ip: DIRECT_IP }))]);

    const outcome = await createProbe(proxy, fetchImpl).run(settings, { tunnelActive: false });

    expect(outcome.errorCode).toBe("E_OTHER_EXT");
    expect(calls).toEqual([]);
  });

  it("rejects an injected probe host before writing PAC", async () => {
    const { proxy, calls } = createProxy();
    const { fetchImpl } = createFetch([() => Promise.resolve(jsonResponse({ ip: DIRECT_IP }))]);

    const outcome = await createProbe(proxy, fetchImpl).run(
      { ...settings, host: 'proxy.k1812.ru";alert(1)//' },
      { tunnelActive: false },
    );

    expect(outcome.errorCode).toBe("E_CFG_HOST");
    expect(calls).toEqual([]);
  });

  it("keeps the test marker when restore fails so startup can recover", async () => {
    const { proxy } = createProxy({ failRestore: true });
    const marker = createMarker();
    const { fetchImpl } = createFetch([
      () => Promise.resolve(jsonResponse({ ip: DIRECT_IP })),
      () => Promise.resolve(jsonResponse({ ip: PROXY_IP })),
    ]);

    const outcome = await createProbe(proxy, fetchImpl, { marker: marker.marker }).run(settings, {
      tunnelActive: false,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe("E_UNKNOWN");
    expect(outcome.recoveryRequired).toBe(true);
    expect(marker.cleared).toBe(0);
    expect(marker.saved).toHaveLength(1);
  });
});

describe("probe URLs and marker recovery", () => {
  it("derives probe URLs from the configured probe hosts", () => {
    expect(probeUrlsForHosts(["api.ipify.org", "ifconfig.me"])).toEqual([
      "https://api.ipify.org?format=json",
      "https://ifconfig.me/ip",
    ]);
    expect(probeUrlsForHosts(["2001:db8::1"])).toEqual(["https://[2001:db8::1]?format=json"]);
  });

  it("clears the marker only when no recovery is required", () => {
    const marker: TestInProgress = { at: 1, snapshot: { mode: "system" } };

    expect(resolveTestMarker(marker, { recoveryRequired: false })).toBeNull();
    expect(resolveTestMarker(marker, { recoveryRequired: true })).toBe(marker);
    expect(resolveTestMarker(null, { recoveryRequired: true })).toBeNull();
  });

  it("discards a stale marker only after a failed recovery was followed by a real apply", () => {
    expect(shouldDiscardStaleMarker(true, true)).toBe(true);
    expect(shouldDiscardStaleMarker(true, false)).toBe(false);
    expect(shouldDiscardStaleMarker(false, true)).toBe(false);
    expect(shouldDiscardStaleMarker(false, false)).toBe(false);
  });
});
