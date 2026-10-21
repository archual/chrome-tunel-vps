import { describe, expect, it } from "vitest";
import {
  createDefaultState,
  createDefaultStore,
  forgetCredentials,
  hasCredentials,
  loadPersistedState,
  loadStore,
  normalizeStore,
  reduceState,
  restrictToTrustedContexts,
  saveStore,
  toPublicState,
  transitionPersistedState,
  transitionPhase,
  type LocalStorageAreaLike,
  type SessionStorageAreaLike,
} from "../../extension/src/background/state";
import { STORAGE_KEY, SESSION_STATE_KEY, type VpsTunnelStore } from "../../extension/src/core/types";
import { TunnelError } from "../../extension/src/core/errors";

type Data = Record<string, unknown>;

function createLocalArea(initial: Data = {}): {
  area: LocalStorageAreaLike;
  data: () => Data;
  levels: string[];
} {
  let data: Data = structuredClone(initial);
  const levels: string[] = [];

  const area: LocalStorageAreaLike = {
    async get(keys) {
      if (keys === undefined || keys === null) {
        return { ...data };
      }
      if (typeof keys === "string") {
        return keys in data ? { [keys]: data[keys] } : {};
      }
      const result: Data = {};
      for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (key in data) {
          result[key] = data[key];
        }
      }
      return result;
    },
    async set(items) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
    async setAccessLevel(options) {
      levels.push(options.accessLevel);
    },
  };

  return { area, data: () => data, levels };
}

function createSessionArea(initial: Data = {}): { area: SessionStorageAreaLike; data: () => Data } {
  const local = createLocalArea(initial);
  return { area: local.area, data: local.data };
}

const legacyStore = {
  protocol: "http",
  host: "Legacy.Proxy.Example",
  port: "3128",
  login: "owner",
  password: " secret ",
  enabled: true,
  mode: "site",
  sites: ["Site.Example", "site.example"],
  bypass: ["*.corp.example", "", "*.corp.example"],
  lastTest: { at: "2026-10-21T10:00:00.000Z", ok: true, ip: "203.0.113.10", code: null },
  customField: "keep-me",
};

describe("vpsTunnel schema and migration", () => {
  it("returns defaults when nothing is stored", () => {
    const result = normalizeStore(undefined);

    expect(result.reset).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.store).toEqual(createDefaultStore());
    expect(result.store.version).toBe(1);
    expect(result.store.mode).toBe("browser");
    expect(result.store.enabled).toBe(false);
    expect(result.store.settings).toBeNull();
    expect(result.store.exclusions).toEqual({ useDefaults: true, extra: [] });
  });

  it("keeps a current v1 store, normalizes fields and preserves unknown fields", () => {
    const raw = {
      version: 1,
      settings: {
        scheme: "http",
        host: "Example.COM.",
        port: 8080,
        username: " owner ",
        password: " pass ",
      },
      mode: "site",
      enabled: true,
      sites: [
        { host: "Example.com", addedAt: "2026-10-21T00:00:00.000Z" },
        { host: "example.com", addedAt: "2026-10-22T00:00:00.000Z" },
      ],
      exclusions: { useDefaults: true, extra: [" *.corp.example ", "*.corp.example"] },
      testInProgress: null,
      lastCheck: { at: "2026-10-21T00:00:00.000Z", ok: true, exitIp: "203.0.113.10", errorCode: null },
      customField: { keep: true },
    };

    const result = normalizeStore(raw);

    expect(result.migrated).toBe(false);
    expect(result.reset).toBe(false);
    expect(result.store.settings?.host).toBe("example.com");
    expect(result.store.settings?.scheme).toBe("http");
    expect(result.store.settings?.port).toBe(8080);
    expect(result.store.settings?.username).toBe(" owner ");
    expect(result.store.settings?.password).toBe(" pass ");
    expect(result.store.mode).toBe("site");
    expect(result.store.enabled).toBe(true);
    expect(result.store.sites).toHaveLength(1);
    expect(result.store.exclusions.extra).toEqual(["*.corp.example"]);
    expect(result.store.lastCheck?.exitIp).toBe("203.0.113.10");
    expect(result.store.customField).toEqual({ keep: true });
  });

  it("migrates the legacy flat shape without losing host, port, login or sites", () => {
    const result = normalizeStore(legacyStore);

    expect(result.migrated).toBe(true);
    expect(result.reset).toBe(false);
    expect(result.store.version).toBe(1);
    expect(result.store.settings).toMatchObject({
      scheme: "http",
      host: "legacy.proxy.example",
      port: 3128,
      username: "owner",
      password: " secret ",
    });
    expect(result.store.sites.map((site) => site.host)).toEqual(["site.example"]);
    expect(result.store.exclusions.extra).toEqual(["*.corp.example"]);
    expect(result.store.lastCheck?.exitIp).toBe("203.0.113.10");
    expect(result.store.mode).toBe("site");
    expect(result.store.enabled).toBe(true);
    expect(result.store.customField).toBe("keep-me");
  });

  it("migrates a version-less settings object", () => {
    const result = normalizeStore({
      settings: { scheme: "https", host: "proxy.k1812.ru", port: 443, username: "u", password: "p" },
    });

    expect(result.migrated).toBe(true);
    expect(result.store.version).toBe(1);
    expect(result.store.settings?.host).toBe("proxy.k1812.ru");
  });

  it("resets a store from a newer schema version with a warning", () => {
    const result = normalizeStore({ ...createDefaultStore(), version: 99, customField: "x" });

    expect(result.reset).toBe(true);
    expect(result.warning).not.toBeNull();
    expect(result.store.version).toBe(1);
    expect(result.store.settings).toBeNull();
    expect(result.store.customField).toBeUndefined();
  });

  it("resets a non-object store", () => {
    const result = normalizeStore("garbage");

    expect(result.reset).toBe(true);
    expect(result.store).toEqual(createDefaultStore());
  });

  it("keeps host/port but treats a store without an endpoint as unconfigured", () => {
    const result = normalizeStore({ version: 1, settings: { scheme: "https", username: "u", password: "p" } });

    expect(result.reset).toBe(false);
    expect(result.store.settings).toBeNull();
  });

  it("persists a migration back to storage on load", async () => {
    const { area, data } = createLocalArea({ [STORAGE_KEY]: legacyStore });

    const result = await loadStore(area);
    const stored = data()[STORAGE_KEY] as VpsTunnelStore;

    expect(result.migrated).toBe(true);
    expect(stored.version).toBe(1);
    expect(stored.settings?.host).toBe("legacy.proxy.example");
  });

  it("does not write when the stored schema is already current", async () => {
    const store = createDefaultStore();
    let writes = 0;
    const { area } = createLocalArea({ [STORAGE_KEY]: store });
    const originalSet = area.set.bind(area);
    area.set = async (items) => {
      writes += 1;
      await originalSet(items);
    };

    await loadStore(area);

    expect(writes).toBe(0);
  });
});

describe("storage security helpers", () => {
  it("forgets credentials but keeps host, port, scheme and sites", async () => {
    const store: VpsTunnelStore = {
      ...createDefaultStore(),
      settings: { scheme: "https", host: "proxy.k1812.ru", port: 443, username: "owner", password: "secret" },
      mode: "browser",
      enabled: true,
      sites: [{ host: "example.com", addedAt: "2026-10-21T00:00:00.000Z" }],
      testInProgress: { at: 1, snapshot: { mode: "system" } },
      lastCheck: { at: "2026-10-21T00:00:00.000Z", ok: true, exitIp: "203.0.113.10", errorCode: null },
    };
    const { area, data } = createLocalArea({ [STORAGE_KEY]: store });

    const next = await forgetCredentials(area);

    expect(next.settings).toMatchObject({ scheme: "https", host: "proxy.k1812.ru", port: 443 });
    expect(next.settings?.username).toBe("");
    expect(next.settings?.password).toBe("");
    expect(next.enabled).toBe(false);
    expect(next.testInProgress).toBeNull();
    expect(next.lastCheck).toBeNull();
    expect(next.sites).toHaveLength(1);
    expect((data()[STORAGE_KEY] as VpsTunnelStore).settings?.password).toBe("");
  });

  it("sets TRUSTED_CONTEXTS on storage.local", async () => {
    const { area, levels } = createLocalArea();

    await expect(restrictToTrustedContexts(area)).resolves.toBe(true);
    expect(levels).toEqual(["TRUSTED_CONTEXTS"]);
  });

  it("reports when setAccessLevel is unavailable", async () => {
    const area: LocalStorageAreaLike = {
      get: async () => ({}),
      set: async () => undefined,
    };

    await expect(restrictToTrustedContexts(area)).resolves.toBe(false);
  });

  it("requires both username and password", () => {
    const base = createDefaultStore();
    expect(hasCredentials({ ...base, settings: { scheme: "https", host: "p", port: 1, username: "u", password: "" } })).toBe(false);
    expect(hasCredentials({ ...base, settings: { scheme: "https", host: "p", port: 1, username: "", password: "p" } })).toBe(false);
    expect(hasCredentials({ ...base, settings: { scheme: "https", host: "p", port: 1, username: "u", password: "p" } })).toBe(true);
  });

  it("builds a public state without password material", async () => {
    const store: VpsTunnelStore = {
      ...createDefaultStore(),
      settings: { scheme: "https", host: "proxy.k1812.ru", port: 443, username: "owner", password: "secret" },
      enabled: true,
      sites: [{ host: "example.com", addedAt: "2026-10-21T00:00:00.000Z" }],
    };

    const state = toPublicState(store, {
      phase: "on",
      lastError: { code: "E_POLICY", message: "policy", at: "2026-10-21T00:00:00.000Z" },
    });

    expect(state).toMatchObject({
      phase: "enabled_browser",
      mode: "browser",
      enabled: true,
      hasSettings: true,
      hasPassword: true,
      sites: ["example.com"],
      endpointHint: { scheme: "https", host: "proxy.k1812.ru", port: 443, username: "owner" },
      lastError: { code: "E_POLICY" },
    });
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("saves a store under the single vpsTunnel key", async () => {
    const { area, data } = createLocalArea();
    const store = createDefaultStore();

    await saveStore(store, area);

    expect(data()).toEqual({ [STORAGE_KEY]: store });
  });
});

describe("state machine", () => {
  it("moves idle -> testing -> on -> idle", () => {
    expect(transitionPhase("idle", "START_TEST")).toBe("testing");
    expect(transitionPhase("testing", "APPLY_OK")).toBe("on");
    expect(transitionPhase("on", "CLEAR_OK")).toBe("idle");
  });

  it("moves to error on failure and clears the error on reset", () => {
    expect(transitionPhase("idle", "FAIL")).toBe("error");
    expect(transitionPhase("on", "FAIL")).toBe("error");
    expect(transitionPhase("error", "RESET")).toBe("idle");
    expect(transitionPhase("testing", "TEST_DONE")).toBe("idle");
  });

  it("is idempotent for repeated target events", () => {
    const on = reduceState(createDefaultState(), "APPLY_OK");
    const again = reduceState(on, "APPLY_OK");
    const idle = reduceState(createDefaultState(), "CLEAR_OK");
    const idleAgain = reduceState(idle, "CLEAR_OK");

    expect(again).toEqual({ ...on, lastError: null });
    expect(idleAgain).toEqual(idle);
  });

  it("records the canonical error code and message", () => {
    const state = reduceState(createDefaultState(), "FAIL", new TunnelError("E_POLICY"));

    expect(state.phase).toBe("error");
    expect(state.lastError).toMatchObject({ code: "E_POLICY", at: expect.any(String) });
    expect(state.lastError?.message.length).toBeGreaterThan(0);
  });

  it("persists state across service worker restarts through storage.session", async () => {
    const { area } = createSessionArea();

    await expect(loadPersistedState(area)).resolves.toEqual(createDefaultState());
    await transitionPersistedState("START_TEST", undefined, area);
    await transitionPersistedState("APPLY_OK", undefined, area);

    expect(await loadPersistedState(area)).toEqual({ phase: "on", lastError: null });

    await transitionPersistedState("FAIL", new TunnelError("E_OTHER_EXT"), area);
    const restored = await loadPersistedState(area);
    expect(restored.phase).toBe("error");
    expect(restored.lastError?.code).toBe("E_OTHER_EXT");
  });

  it("ignores a corrupt persisted state", async () => {
    const { area } = createSessionArea({ [SESSION_STATE_KEY]: { phase: "bogus", lastError: "nope" } });

    await expect(loadPersistedState(area)).resolves.toEqual(createDefaultState());
  });

  it("does not persist the password inside state", async () => {
    const { area, data } = createSessionArea();

    await transitionPersistedState("FAIL", new TunnelError("E_AUTH_407"), area);

    expect(JSON.stringify(data())).not.toContain("password");
  });
});
