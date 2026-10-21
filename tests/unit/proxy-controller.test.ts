import { describe, expect, it } from "vitest";
import {
  ProxyController,
  type ProxyControlSnapshot,
  type ProxySettingsApi,
} from "../../extension/src/background/proxy-controller";
import type { ProxySettings } from "../../extension/src/core/types";

const settings: ProxySettings = {
  scheme: "https",
  host: "proxy.k1812.ru",
  port: 443,
  username: "owner",
  password: "secret",
};

interface FakeOptions {
  value?: chrome.proxy.ProxyConfig;
  levelOfControl?: ProxyControlSnapshot["levelOfControl"];
  failFirstSet?: boolean;
  clearError?: Error;
}

function createFakeApi(options: FakeOptions = {}): {
  api: ProxySettingsApi;
  calls: string[];
  current: () => chrome.proxy.ProxyConfig;
} {
  let value: chrome.proxy.ProxyConfig = options.value ?? { mode: "system" };
  const calls: string[] = [];
  let setAttempts = 0;

  const api: ProxySettingsApi = {
    async get() {
      return { value: structuredClone(value), levelOfControl: options.levelOfControl ?? "controllable_by_this_extension" };
    },
    async set(details) {
      calls.push("set");
      setAttempts += 1;
      if (options.failFirstSet === true && setAttempts === 1) {
        throw new Error("settings.set failed");
      }
      value = structuredClone(details.value);
    },
    async clear() {
      calls.push("clear");
      if (options.clearError !== undefined) {
        throw options.clearError;
      }
      value = { mode: "system" };
    },
  };

  return { api, calls, current: () => value };
}

describe("ProxyController.apply", () => {
  it("writes one fixed_servers config with a single settings.set()", async () => {
    const { api, calls } = createFakeApi();
    const controller = new ProxyController({ api });

    const config = await controller.apply(settings);

    expect(calls).toEqual(["set"]);
    expect(config.mode).toBe("fixed_servers");
    expect(api.set).toBeDefined();
  });

  it("does not call clear() before set() when switching modes", async () => {
    const previous: chrome.proxy.ProxyConfig = {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "https", host: "old.example", port: 443 },
        bypassList: ["localhost"],
      },
    };
    const { api, calls } = createFakeApi({ value: previous, levelOfControl: "controlled_by_this_extension" });
    const controller = new ProxyController({ api });

    await controller.apply(settings);

    expect(calls).toEqual(["set"]);
    expect(calls).not.toContain("clear");
  });

  it("allows controlled_by_this_extension", async () => {
    const { api, calls } = createFakeApi({ levelOfControl: "controlled_by_this_extension" });
    const controller = new ProxyController({ api });

    await expect(controller.apply(settings)).resolves.toBeDefined();
    expect(calls).toEqual(["set"]);
  });

  it("blocks with E_POLICY when the proxy is not controllable", async () => {
    const { api, calls } = createFakeApi({ levelOfControl: "not_controllable" });
    const controller = new ProxyController({ api });

    await expect(controller.apply(settings)).rejects.toMatchObject({ code: "E_POLICY" });
    expect(calls).toEqual([]);
  });

  it("blocks with E_OTHER_EXT when another extension controls the proxy", async () => {
    const { api, calls } = createFakeApi({ levelOfControl: "controlled_by_other_extensions" });
    const controller = new ProxyController({ api });

    await expect(controller.apply(settings)).rejects.toMatchObject({ code: "E_OTHER_EXT" });
    expect(calls).toEqual([]);
  });

  it("rolls back to the previous fixed_servers config after a failed set", async () => {
    const previous: chrome.proxy.ProxyConfig = {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "https", host: "previous.example", port: 8443 },
        bypassList: ["localhost"],
      },
    };
    const { api, calls, current } = createFakeApi({ value: previous, failFirstSet: true });
    const controller = new ProxyController({ api });

    await expect(controller.apply(settings)).rejects.toMatchObject({ code: "E_UNKNOWN" });

    expect(calls).toEqual(["set", "set"]);
    expect(current()).toEqual(previous);
  });

  it("rolls back to the system config with a single clear after a failed set", async () => {
    const { api, calls, current } = createFakeApi({ failFirstSet: true });
    const controller = new ProxyController({ api });

    await expect(controller.apply(settings)).rejects.toMatchObject({ code: "E_UNKNOWN" });

    expect(calls).toEqual(["set", "clear"]);
    expect(current()).toEqual({ mode: "system" });
  });

  it("does not touch chrome.proxy when the endpoint is invalid", async () => {
    const { api, calls } = createFakeApi();
    const controller = new ProxyController({ api });

    await expect(controller.apply({ ...settings, port: 0 })).rejects.toMatchObject({ code: "E_CFG_PORT" });
    expect(calls).toEqual([]);
  });
});

describe("ProxyController.clear", () => {
  it("clears the regular profile scope once", async () => {
    const { api, calls, current } = createFakeApi({
      value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "https", host: "proxy.k1812.ru", port: 443 } } },
      levelOfControl: "controlled_by_this_extension",
    });
    const controller = new ProxyController({ api });

    await controller.clear();

    expect(calls).toEqual(["clear"]);
    expect(current()).toEqual({ mode: "system" });
  });

  it("refuses to clear someone else's proxy", async () => {
    const { api, calls } = createFakeApi({ levelOfControl: "controlled_by_other_extensions" });
    const controller = new ProxyController({ api });

    await expect(controller.clear()).rejects.toMatchObject({ code: "E_OTHER_EXT" });
    expect(calls).toEqual([]);
  });

  it("refuses to clear a policy-managed proxy", async () => {
    const { api, calls } = createFakeApi({ levelOfControl: "not_controllable" });
    const controller = new ProxyController({ api });

    await expect(controller.clear()).rejects.toMatchObject({ code: "E_POLICY" });
    expect(calls).toEqual([]);
  });

  it("surfaces a clear failure as a tunnel error", async () => {
    const { api } = createFakeApi({ clearError: new Error("cannot clear") });
    const controller = new ProxyController({ api });

    await expect(controller.clear()).rejects.toMatchObject({ code: "E_UNKNOWN", message: "cannot clear" });
  });

  it("restores a non-system snapshot with set() and a system snapshot with clear()", async () => {
    const { api, calls } = createFakeApi();
    const controller = new ProxyController({ api });

    await controller.restore({ mode: "system" });
    await controller.restore(null);
    await controller.restore({
      mode: "direct",
    });

    expect(calls).toEqual(["clear", "clear", "set"]);
  });
});
