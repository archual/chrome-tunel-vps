import { beforeEach, describe, expect, it, vi } from "vitest";

interface MenuItem {
  id: string;
  title?: string;
  parentId?: string;
  enabled?: boolean;
}

const messages: Record<string, string> = {
  menuRoot: "VPS Tunnel",
  menuEnable: "Enable tunnel",
  menuDisable: "Disable tunnel",
  menuSiteSoon: "This site only (soon)",
  menuSettings: "Settings",
};

interface FakeChrome {
  created: MenuItem[];
  updates: Array<{ id: string; enabled?: boolean | undefined }>;
  sent: unknown[];
  installed: Array<(details: { reason: string }) => void>;
  startup: Array<() => void>;
  clicked: Array<(info: { menuItemId: string; pageUrl: string }) => void>;
  storageChanged: Array<(changes: Record<string, unknown>, area: string) => void>;
  config: Record<string, unknown> | undefined;
}

function createFakeChrome(): FakeChrome {
  return {
    created: [],
    updates: [],
    sent: [],
    installed: [],
    startup: [],
    clicked: [],
    storageChanged: [],
    config: undefined,
  };
}

function installChrome(fake: FakeChrome): void {
  const contextMenus = {
    create: (item: MenuItem, callback?: () => void) => {
      fake.created.push(item);
      callback?.();
    },
    removeAll: (callback: () => void) => callback(),
    update: (id: string, properties: { enabled?: boolean }, callback?: () => void) => {
      fake.updates.push({ id, enabled: properties.enabled });
      callback?.();
    },
    onClicked: { addListener: (listener: (info: { menuItemId: string; pageUrl: string }) => void) => fake.clicked.push(listener) },
    onShown: { addListener: () => undefined },
    refresh: () => undefined,
  };

  const chromeMock = {
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: (listener: (details: { reason: string }) => void) => fake.installed.push(listener) },
      onStartup: { addListener: (listener: () => void) => fake.startup.push(listener) },
      onMessage: { addListener: () => undefined },
      openOptionsPage: async () => undefined,
      sendMessage: async (message: unknown) => {
        fake.sent.push(message);
        return { ok: true };
      },
    },
    contextMenus,
    storage: {
      local: {
        get: async (key: string) => {
          if (key === "vpsTunnel" && fake.config) {
            return { vpsTunnel: fake.config };
          }
          return {};
        },
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
          fake.storageChanged.push(listener),
      },
    },
    i18n: {
      getMessage: (key: string) => messages[key] ?? "",
    },
  };

  vi.stubGlobal("chrome", chromeMock);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function importSurface() {
  vi.resetModules();
  return import("../../extension/src/background/ui-surface");
}

describe("context menu surface", () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = createFakeChrome();
    installChrome(fake);
  });

  it("creates the localized menu tree on install", async () => {
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    expect(fake.created.map((item) => item.id)).toEqual([
      "vps-tunnel",
      "vps-tunnel-enable",
      "vps-tunnel-disable",
      "vps-tunnel-site",
      "vps-tunnel-settings",
    ]);
    const titles = Object.fromEntries(fake.created.map((item) => [item.id, item.title]));
    expect(titles).toMatchObject({
      "vps-tunnel": "VPS Tunnel",
      "vps-tunnel-enable": "Enable tunnel",
      "vps-tunnel-disable": "Disable tunnel",
      "vps-tunnel-site": "This site only (soon)",
      "vps-tunnel-settings": "Settings",
    });
    const site = fake.created.find((item) => item.id === "vps-tunnel-site");
    expect(site?.enabled).toBe(false);
  });

  it("disables enabling until settings exist", async () => {
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    const enable = fake.updates.filter((entry) => entry.id === "vps-tunnel-enable").at(-1);
    expect(enable?.enabled).toBe(false);
  });

  it("enables disable and disables enable while the tunnel is on", async () => {
    fake.config = { settings: { host: "proxy.example.com", port: 443 }, enabled: true };
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    const enable = fake.updates.filter((entry) => entry.id === "vps-tunnel-enable").at(-1);
    const disable = fake.updates.filter((entry) => entry.id === "vps-tunnel-disable").at(-1);
    expect(enable?.enabled).toBe(false);
    expect(disable?.enabled).toBe(true);
  });

  it("sends enable and disable requests from the menu", async () => {
    fake.config = { settings: { host: "proxy.example.com", port: 443 }, enabled: false };
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    fake.clicked[0]?.({ menuItemId: "vps-tunnel-enable", pageUrl: "https://example.com/" });
    await flush();
    fake.clicked[0]?.({ menuItemId: "vps-tunnel-disable", pageUrl: "https://example.com/" });
    await flush();

    expect(fake.sent).toEqual([
      { type: "SET_ENABLED", enabled: true },
      { type: "SET_ENABLED", enabled: false },
    ]);
  });

  it("does not enable from restricted Chrome pages", async () => {
    fake.config = { settings: { host: "proxy.example.com", port: 443 }, enabled: false };
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    fake.clicked[0]?.({ menuItemId: "vps-tunnel-enable", pageUrl: "chrome://extensions/" });
    await flush();

    expect(fake.sent).toEqual([]);
  });

  it("opens settings from the menu", async () => {
    const open = vi.spyOn(chrome.runtime, "openOptionsPage");
    const { registerUiSurface } = await importSurface();
    registerUiSurface();
    fake.installed[0]?.({ reason: "update" });
    await flush();

    fake.clicked[0]?.({ menuItemId: "vps-tunnel-settings", pageUrl: "https://example.com/" });
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
  });
});
