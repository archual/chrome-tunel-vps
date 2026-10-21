import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  deriveBadge,
  derivePopupView,
  errorMessageKey,
} from "../../extension/src/shared/popup-state";
import { describeActiveTab, isLocalHostname, siteMatchesHost } from "../../extension/src/shared/site";
import type { PublicState } from "../../extension/src/shared/types";

function state(overrides: Partial<PublicState> = {}): PublicState {
  return {
    phase: "configured_disabled",
    mode: "browser",
    hasSettings: true,
    hasPassword: true,
    endpointHint: { scheme: "https", host: "proxy.k1812.ru", port: 443, username: "owner" },
    sites: [],
    enabled: false,
    activeSite: null,
    lastCheck: { at: "2026-10-21T08:00:00.000Z", ok: true, exitIp: "203.0.113.10", durationMs: 245 },
    ...overrides,
  };
}

const webTab = describeActiveTab("https://example.com/page");
const localTab = describeActiveTab("http://localhost:3000");

describe("popup state machine", () => {
  it("renders the unconfigured state", () => {
    expect(derivePopupView(state({ phase: "unconfigured", hasSettings: false, hasPassword: false }), webTab).kind).toBe(
      "unconfigured",
    );
  });

  it("renders configured but disabled", () => {
    expect(derivePopupView(state(), webTab).kind).toBe("disabled");
  });

  it("renders checking", () => {
    expect(derivePopupView(state({ phase: "checking" }), webTab).kind).toBe("checking");
  });

  it("renders site mode active", () => {
    const view = derivePopupView(
      state({ phase: "enabled_site_active", mode: "site", enabled: true, sites: ["example.com"] }),
      webTab,
    );
    expect(view.kind).toBe("site_active");
    expect(view.bodySubstitutions).toEqual(["example.com"]);
  });

  it("renders site mode inactive", () => {
    const view = derivePopupView(
      state({ phase: "enabled_site_inactive", mode: "site", enabled: true, sites: ["other.example"] }),
      webTab,
    );
    expect(view.kind).toBe("site_inactive");
    expect(view.bodySubstitutions).toEqual(["other.example"]);
  });

  it("renders whole-browser mode", () => {
    expect(derivePopupView(state({ phase: "enabled_browser", enabled: true }), webTab).kind).toBe("browser");
  });

  it("renders the local-network exclusion state", () => {
    expect(derivePopupView(state(), localTab).kind).toBe("excluded");
  });

  it("renders auth errors", () => {
    const view = derivePopupView(
      state({ phase: "error", lastError: { code: "E_AUTH_407", message: "bad password" } }),
      webTab,
    );
    expect(view.kind).toBe("auth_error");
    expect(view.tone).toBe("danger");
  });

  it("renders network errors with the code text", () => {
    const view = derivePopupView(
      state({ phase: "error", lastError: { code: "E_PROXY_TLS", message: "certificate" } }),
      webTab,
    );
    expect(view.kind).toBe("network_error");
    expect(view.titleKey).toBe("stateNetworkErrorTitle");
    expect(view.bodyKey).toBe("errorProxyTls");
  });

  it("renders policy and other-extension errors", () => {
    expect(
      derivePopupView(state({ phase: "error", lastError: { code: "E_POLICY", message: "policy" } }), webTab).kind,
    ).toBe("policy_error");
    expect(
      derivePopupView(state({ phase: "error", lastError: { code: "E_OTHER_EXT", message: "other" } }), webTab).kind,
    ).toBe("policy_error");
  });

  it("covers all ten required views plus Chrome-internal pages", () => {
    const kinds = new Set([
      "unconfigured",
      "disabled",
      "checking",
      "site_active",
      "site_inactive",
      "browser",
      "excluded",
      "auth_error",
      "network_error",
      "policy_error",
    ]);
    expect(kinds.size).toBe(10);
    expect(derivePopupView(state(), describeActiveTab("chrome://extensions")).kind).toBe("unsupported");
  });
});

describe("badge model", () => {
  it("maps checking, error, on and off states", () => {
    expect(deriveBadge({ phase: "checking", enabled: false, lastCheck: null })).toMatchObject({
      text: "…",
      tone: "checking",
    });
    expect(
      deriveBadge({ phase: "error", enabled: true, lastError: { code: "E_AUTH_407" }, lastCheck: null }),
    ).toMatchObject({ text: "!", tone: "error" });
    expect(deriveBadge({ phase: "enabled_browser", enabled: true, lastCheck: null })).toMatchObject({
      text: "ON",
      tone: "on",
    });
    expect(deriveBadge({ phase: "configured_disabled", enabled: false, lastCheck: null })).toMatchObject({
      text: "",
      tone: "off",
    });
  });
});

describe("diagnostics", () => {
  it("includes host/port/state but never credentials", () => {
    const diagnostics = buildDiagnostics({
      state: state({
        lastError: { code: "E_AUTH_407", message: "bad password", at: "2026-10-21T08:01:00.000Z" },
      }),
      extensionVersion: "0.1.0",
      userAgent: "Chrome/120",
      platform: "Linux",
      now: new Date("2026-10-21T08:02:00.000Z"),
    });

    expect(diagnostics).toMatchObject({
      extensionVersion: "0.1.0",
      scheme: "https",
      host: "proxy.k1812.ru",
      port: 443,
      mode: "browser",
      enabled: false,
      lastError: "E_AUTH_407",
      lastErrorMessage: "errorAuth407",
    });

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("owner");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
  });
});

describe("site helpers", () => {
  it("classifies local and private hosts", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("app.local")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
    expect(isLocalHostname("192.168.1.10")).toBe(true);
    expect(isLocalHostname("172.20.0.1")).toBe(true);
    expect(isLocalHostname("10.1.2.3")).toBe(true);
    expect(isLocalHostname("169.254.1.1")).toBe(true);
    expect(isLocalHostname("[::1]")).toBe(true);
    expect(isLocalHostname("fc00::1")).toBe(true);
    expect(isLocalHostname("example.com")).toBe(false);
    expect(isLocalHostname("172.32.0.1")).toBe(false);
  });

  it("matches subdomains but not neighbouring domains", () => {
    expect(siteMatchesHost("example.com", "example.com")).toBe(true);
    expect(siteMatchesHost("example.com", "www.example.com")).toBe(true);
    expect(siteMatchesHost("example.com", "notexample.com")).toBe(false);
  });

  it("describes http(s) tabs and rejects Chrome pages", () => {
    expect(webTab).toMatchObject({ kind: "web", host: "example.com" });
    expect(localTab).toMatchObject({ kind: "local", host: "localhost" });
    expect(describeActiveTab("chrome://settings").kind).toBe("unsupported");
  });
});

describe("error mapping", () => {
  it("maps each catalog code to an i18n key", () => {
    const codes = [
      "E_CFG_HOST",
      "E_CFG_PORT",
      "E_CFG_CREDS",
      "E_PROXY_UNREACHABLE",
      "E_PROXY_TLS",
      "E_AUTH_407",
      "E_FORBIDDEN_403",
      "E_LIMIT",
      "E_POLICY",
      "E_OTHER_EXT",
      "E_TIMEOUT",
      "E_UNSUPPORTED_AUTH",
      "E_NO_NETWORK",
      "E_UNKNOWN",
    ] as const;
    for (const code of codes) {
      expect(errorMessageKey(code)).toMatch(/^error/);
    }
    expect(errorMessageKey(null)).toBe("errorUnknown");
  });
});
