import {
  AuthAttemptTracker,
  evaluateAuthChallenge,
  type AuthDecision,
  type ExpectedAuthEndpoint,
} from "../core/auth";
import type { ErrorCode, VpsTunnelStore } from "../core/types";
import { hasCredentials } from "./state";

export interface AuthRuntimeOptions {
  loadStore: () => Promise<VpsTunnelStore>;
  report: (code: ErrorCode) => void;
}

function endpointFromStore(store: VpsTunnelStore): ExpectedAuthEndpoint | null {
  const settings = store.settings;
  if (settings === null || !hasCredentials(store)) {
    return null;
  }
  return {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    password: settings.password,
  };
}

function applyDecision(
  decision: AuthDecision,
  report: (code: ErrorCode) => void,
  callback: (response: chrome.webRequest.BlockingResponse) => void,
): void {
  switch (decision.type) {
    case "ignore":
      if (decision.error !== undefined) {
        report(decision.error);
      }
      callback({});
      return;
    case "cancel":
      if (decision.error !== undefined) {
        report(decision.error);
      }
      callback({ cancel: true });
      return;
    case "credentials":
      callback({ authCredentials: decision.credentials });
      return;
  }
}

export class AuthRuntime {
  private store: VpsTunnelStore | null = null;
  private probeActive = false;
  private readonly tracker = new AuthAttemptTracker();

  constructor(private readonly options: AuthRuntimeOptions) {}

  invalidate(): void {
    this.store = null;
  }

  setProbeActive(active: boolean): void {
    this.probeActive = active;
  }

  release(requestId: string): void {
    this.tracker.release(requestId);
  }

  resetAttempts(): void {
    this.tracker.clear();
  }

  private async currentStore(): Promise<VpsTunnelStore> {
    if (this.store === null) {
      this.store = await this.options.loadStore();
    }
    return this.store;
  }

  private isActive(store: VpsTunnelStore): boolean {
    if (this.probeActive) {
      return true;
    }
    return (
      store.enabled &&
      store.mode === "browser" &&
      store.settings !== null &&
      hasCredentials(store)
    );
  }

  async handle(
    details: chrome.webRequest.WebAuthenticationChallengeDetails,
    callback: (response: chrome.webRequest.BlockingResponse) => void,
  ): Promise<void> {
    let store: VpsTunnelStore;
    try {
      store = await this.currentStore();
    } catch {
      callback({});
      return;
    }

    try {
      const decision = evaluateAuthChallenge(
        {
          isProxy: details.isProxy,
          requestId: details.requestId,
          scheme: details.scheme,
          challenger:
            details.challenger === undefined
              ? null
              : { host: details.challenger.host, port: details.challenger.port },
        },
        {
          expected: endpointFromStore(store),
          active: this.isActive(store),
          tracker: this.tracker,
        },
      );

      applyDecision(decision, this.options.report, callback);
    } catch {
      callback({});
    }
  }
}

export function registerAuthListener(runtime: AuthRuntime): void {
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      void runtime.handle(details, callback ?? (() => undefined));
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"],
  );

  const release = (details: chrome.webRequest.WebResponseCacheDetails): void => {
    runtime.release(details.requestId);
  };

  chrome.webRequest.onCompleted.addListener(release, { urls: ["<all_urls>"] });
  chrome.webRequest.onErrorOccurred.addListener(release, { urls: ["<all_urls>"] });
}
