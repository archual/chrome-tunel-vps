import { TunnelError, toTunnelError } from "../core/errors";
import { buildProxyConfig } from "../core/proxy-config";
import type { Exclusions, ProxySettings } from "../core/types";

export type ProxyLevelOfControl =
  | "not_controllable"
  | "controlled_by_other_extensions"
  | "controllable_by_this_extension"
  | "controlled_by_this_extension";

export interface ProxyControlSnapshot {
  value: chrome.proxy.ProxyConfig;
  levelOfControl: ProxyLevelOfControl;
}

export interface ProxySettingsApi {
  get(details: { incognito: boolean }): Promise<ProxyControlSnapshot>;
  set(details: { value: chrome.proxy.ProxyConfig; scope: "regular" }): Promise<void>;
  clear(details: { scope: "regular" }): Promise<void>;
}

export interface ProxyControllerOptions {
  api?: ProxySettingsApi;
}

function chromeLastError(): Error | null {
  const lastError = chrome.runtime.lastError;
  return lastError ? new Error(lastError.message ?? "chrome.proxy error") : null;
}

export function createChromeProxySettingsApi(): ProxySettingsApi {
  return {
    get: (details) =>
      new Promise((resolve, reject) => {
        chrome.proxy.settings.get(details, (result) => {
          const error = chromeLastError();
          if (error !== null) {
            reject(error);
            return;
          }
          resolve({
            value: result.value as chrome.proxy.ProxyConfig,
            levelOfControl: result.levelOfControl as ProxyLevelOfControl,
          });
        });
      }),
    set: (details) =>
      new Promise((resolve, reject) => {
        chrome.proxy.settings.set(details, () => {
          const error = chromeLastError();
          if (error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    clear: (details) =>
      new Promise((resolve, reject) => {
        chrome.proxy.settings.clear(details, () => {
          const error = chromeLastError();
          if (error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function assertControllable(levelOfControl: ProxyLevelOfControl): void {
  if (levelOfControl === "not_controllable") {
    throw new TunnelError("E_POLICY");
  }
  if (levelOfControl === "controlled_by_other_extensions") {
    throw new TunnelError("E_OTHER_EXT");
  }
}

function cloneSnapshot(snapshot: chrome.proxy.ProxyConfig): chrome.proxy.ProxyConfig {
  return structuredClone(snapshot);
}

export class ProxyController {
  private readonly api: ProxySettingsApi;

  constructor(options: ProxyControllerOptions = {}) {
    this.api = options.api ?? createChromeProxySettingsApi();
  }

  async readLevelOfControl(): Promise<ProxyLevelOfControl> {
    const current = await this.api.get({ incognito: false });
    return current.levelOfControl;
  }

  async apply(settings: ProxySettings, exclusions?: Exclusions): Promise<chrome.proxy.ProxyConfig> {
    const config = buildProxyConfig(settings, exclusions) as chrome.proxy.ProxyConfig;
    const current = await this.api.get({ incognito: false });
    assertControllable(current.levelOfControl);

    const snapshot = cloneSnapshot(current.value);

    try {
      await this.api.set({ value: config, scope: "regular" });
    } catch (error) {
      try {
        await this.restore(snapshot);
      } catch {
        void 0;
      }
      throw toTunnelError(error);
    }

    return config;
  }

  async clear(): Promise<void> {
    const current = await this.api.get({ incognito: false });
    assertControllable(current.levelOfControl);

    try {
      await this.api.clear({ scope: "regular" });
    } catch (error) {
      throw toTunnelError(error);
    }
  }

  async restore(snapshot: chrome.proxy.ProxyConfig | null): Promise<void> {
    if (snapshot === null || snapshot.mode === "system") {
      await this.api.clear({ scope: "regular" });
      return;
    }
    await this.api.set({ value: snapshot, scope: "regular" });
  }
}
