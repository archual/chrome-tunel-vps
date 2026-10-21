import { describe, expect, it } from "vitest";
import { AuthRuntime } from "../../extension/src/background/auth";
import { ProbeService, type ProbeMarkerStore, type ProbeProxy } from "../../extension/src/background/probe";
import { createDefaultStore } from "../../extension/src/background/state";
import type { ProxySettings, TestInProgress } from "../../extension/src/core/types";

const settings: ProxySettings = {
  scheme: "https",
  host: "proxy.k1812.ru",
  port: 443,
  username: "owner",
  password: "secret",
};

const DIRECT_IP = "198.51.100.5";
const PROXY_IP = "203.0.113.10";

describe("probe smoke with auth + proxy mock", () => {
  it("obtains the proxy exit IP through a temporary PAC without leaving it enabled", async () => {
    let current: chrome.proxy.ProxyConfig = { mode: "system" };
    const setValues: chrome.proxy.ProxyConfig[] = [];
    let restoreCount = 0;
    const markerEvents: string[] = [];
    const authAttempts: string[] = [];

    const marker: ProbeMarkerStore = {
      async save(_value: TestInProgress) {
        markerEvents.push("save");
      },
      async clear() {
        markerEvents.push("clear");
      },
    };

    const proxy: ProbeProxy = {
      async snapshot() {
        return { value: structuredClone(current), levelOfControl: "controllable_by_this_extension" };
      },
      async set(value) {
        setValues.push(structuredClone(value));
        current = structuredClone(value);
      },
      async restore(snapshot) {
        restoreCount += 1;
        current = structuredClone(snapshot);
      },
    };

    const store = {
      ...createDefaultStore(),
      settings,
      enabled: false,
    };

    const auth = new AuthRuntime({
      loadStore: async () => store,
      report: () => undefined,
    });
    auth.setProbeActive(true);

    const fetchImpl = (async () => {
      if (current.mode !== "pac_script") {
        return new Response(JSON.stringify({ ip: DIRECT_IP }), { status: 200 });
      }

      let response: chrome.webRequest.BlockingResponse = {};
      await auth.handle(
        {
          isProxy: true,
          requestId: "probe-request",
          scheme: "Basic",
          challenger: { host: "proxy.k1812.ru", port: 443 },
        } as chrome.webRequest.WebAuthenticationChallengeDetails,
        (next) => {
          response = next;
        },
      );

      if (response.authCredentials === undefined) {
        return new Response("", { status: 407 });
      }

      authAttempts.push(`${response.authCredentials.username}:${response.authCredentials.password}`);
      return new Response(JSON.stringify({ ip: PROXY_IP }), { status: 200 });
    }) as typeof fetch;

    const probe = new ProbeService({
      proxy,
      fetchImpl,
      marker,
      now: () => Date.now(),
    });

    const outcome = await probe.run(settings, { tunnelActive: false });
    auth.setProbeActive(false);

    expect(outcome).toMatchObject({
      ok: true,
      exitIp: PROXY_IP,
      directIp: DIRECT_IP,
      suspectedDirect: false,
      errorCode: null,
    });
    expect(authAttempts).toEqual(["owner:secret"]);
    expect(setValues).toHaveLength(1);
    expect(setValues[0]?.mode).toBe("pac_script");
    expect(restoreCount).toBe(1);
    expect(current).toEqual({ mode: "system" });
    expect(markerEvents).toEqual(["save", "clear"]);
  });

  it("cancels with E_AUTH_407 after two failed substitutions and restores the profile", async () => {
    let current: chrome.proxy.ProxyConfig = { mode: "system" };
    let restoreCount = 0;
    const reported: string[] = [];

    const store = {
      ...createDefaultStore(),
      settings,
      enabled: false,
    };

    const auth = new AuthRuntime({
      loadStore: async () => store,
      report: (code) => reported.push(code),
    });
    auth.setProbeActive(true);

    const proxy: ProbeProxy = {
      async snapshot() {
        return { value: structuredClone(current), levelOfControl: "controllable_by_this_extension" };
      },
      async set(value) {
        current = structuredClone(value);
      },
      async restore(snapshot) {
        restoreCount += 1;
        current = structuredClone(snapshot);
      },
    };

    let attempts = 0;
    const fetchImpl = (async () => {
      if (current.mode !== "pac_script") {
        throw new TypeError("baseline offline");
      }

      while (attempts < 3) {
        attempts += 1;
        let response: chrome.webRequest.BlockingResponse = {};
        await auth.handle(
          {
            isProxy: true,
            requestId: "bad-creds",
            scheme: "Basic",
            challenger: { host: "proxy.k1812.ru", port: 443 },
          } as chrome.webRequest.WebAuthenticationChallengeDetails,
          (next) => {
            response = next;
          },
        );
        if (response.cancel === true) {
          break;
        }
      }

      return new Response("", { status: 407 });
    }) as typeof fetch;

    const probe = new ProbeService({ proxy, fetchImpl, now: () => Date.now() });
    const outcome = await probe.run(settings, { tunnelActive: false });
    auth.setProbeActive(false);

    expect(attempts).toBe(3);
    expect(reported).toContain("E_AUTH_407");
    expect(outcome.errorCode).toBe("E_AUTH_407");
    expect(restoreCount).toBe(1);
    expect(current).toEqual({ mode: "system" });
  });
});
