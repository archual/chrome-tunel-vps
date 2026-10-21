import { siteMatchesHost } from "./site";
import type { ActiveTabInfo, ErrorCode, PublicState } from "./types";

export type PopupViewKind =
  | "unconfigured"
  | "disabled"
  | "checking"
  | "site_active"
  | "site_inactive"
  | "browser"
  | "excluded"
  | "unsupported"
  | "auth_error"
  | "network_error"
  | "policy_error";

export interface PopupView {
  kind: PopupViewKind;
  titleKey: string;
  bodyKey: string;
  bodySubstitutions: string[];
  tone: "neutral" | "success" | "warning" | "danger";
}

const ERROR_KEYS: Record<ErrorCode, string> = {
  E_CFG_HOST: "errorCfgHost",
  E_CFG_PORT: "errorCfgPort",
  E_CFG_CREDS: "errorCfgCreds",
  E_PROXY_UNREACHABLE: "errorProxyUnreachable",
  E_PROXY_TLS: "errorProxyTls",
  E_AUTH_407: "errorAuth407",
  E_FORBIDDEN_403: "errorForbidden403",
  E_LIMIT: "errorLimit",
  E_POLICY: "errorPolicy",
  E_OTHER_EXT: "errorOtherExt",
  E_TIMEOUT: "errorTimeout",
  E_UNSUPPORTED_AUTH: "errorUnsupportedAuth",
  E_NO_NETWORK: "errorNoNetwork",
  E_UNKNOWN: "errorUnknown",
};

export function errorMessageKey(code: string | null | undefined): string {
  if (!code) {
    return "errorUnknown";
  }
  return ERROR_KEYS[code as ErrorCode] ?? "errorUnknown";
}

export function errorBodyKey(code: string | null | undefined): string {
  switch (code) {
    case "E_AUTH_407":
    case "E_UNSUPPORTED_AUTH":
      return "errorAuthBody";
    case "E_POLICY":
    case "E_OTHER_EXT":
      return "errorPolicyBody";
    case "E_PROXY_TLS":
      return "errorTlsBody";
    case "E_TIMEOUT":
      return "errorTimeoutBody";
    case "E_CFG_HOST":
    case "E_CFG_PORT":
    case "E_CFG_CREDS":
      return "errorConfigBody";
    default:
      return "errorNetworkBody";
  }
}

function hasError(state: PublicState): boolean {
  return Boolean(state.lastError?.code) || state.lastCheck?.ok === false;
}

function currentErrorCode(state: PublicState): string | null {
  return state.lastError?.code ?? state.lastCheck?.errorCode ?? null;
}

export function derivePopupView(state: PublicState, tab: ActiveTabInfo): PopupView {
  if (!state.hasSettings || state.phase === "unconfigured") {
    return {
      kind: "unconfigured",
      titleKey: "stateUnconfiguredTitle",
      bodyKey: "stateUnconfiguredBody",
      bodySubstitutions: [],
      tone: "neutral",
    };
  }

  if (state.phase === "checking") {
    return {
      kind: "checking",
      titleKey: "stateCheckingTitle",
      bodyKey: "stateCheckingBody",
      bodySubstitutions: [],
      tone: "warning",
    };
  }

  const code = currentErrorCode(state);
  if (hasError(state) && (state.phase === "error" || state.lastError !== undefined)) {
    if (code === "E_AUTH_407" || code === "E_UNSUPPORTED_AUTH") {
      return {
        kind: "auth_error",
        titleKey: "stateAuthErrorTitle",
        bodyKey: errorBodyKey(code),
        bodySubstitutions: [],
        tone: "danger",
      };
    }
    if (code === "E_POLICY" || code === "E_OTHER_EXT") {
      return {
        kind: "policy_error",
        titleKey: "statePolicyErrorTitle",
        bodyKey: errorBodyKey(code),
        bodySubstitutions: [],
        tone: "danger",
      };
    }
    return {
      kind: "network_error",
      titleKey: "stateNetworkErrorTitle",
      bodyKey: errorMessageKey(code),
      bodySubstitutions: [],
      tone: "danger",
    };
  }

  if (state.enabled && state.mode === "browser") {
    return {
      kind: "browser",
      titleKey: "stateBrowserTitle",
      bodyKey: "stateBrowserBody",
      bodySubstitutions: [],
      tone: "success",
    };
  }

  if (state.mode === "site") {
    const site = tab.host ?? "";
    const siteListed = state.sites.some((entry) => siteMatchesHost(entry, site));
    const siteActive =
      state.enabled &&
      (state.phase === "enabled_site_active" ||
        (state.phase !== "enabled_site_inactive" &&
          (siteListed || siteMatchesHost(state.activeSite ?? "", site))));
    if (siteActive) {
      return {
        kind: "site_active",
        titleKey: "stateSiteActiveTitle",
        bodyKey: "stateSiteActiveBody",
        bodySubstitutions: [site || "—"],
        tone: "success",
      };
    }
    if (state.enabled) {
      return {
        kind: "site_inactive",
        titleKey: "stateSiteInactiveTitle",
        bodyKey: "stateSiteInactiveBody",
        bodySubstitutions: [state.sites.join(", ") || "—"],
        tone: "neutral",
      };
    }
  }

  if (tab.kind === "local") {
    return {
      kind: "excluded",
      titleKey: "stateExcludedTitle",
      bodyKey: "stateExcludedBody",
      bodySubstitutions: [],
      tone: "neutral",
    };
  }

  if (tab.kind === "unsupported") {
    return {
      kind: "unsupported",
      titleKey: "stateUnsupportedTitle",
      bodyKey: "stateUnsupportedBody",
      bodySubstitutions: [],
      tone: "neutral",
    };
  }

  return {
    kind: "disabled",
    titleKey: "stateDisabledTitle",
    bodyKey: "stateDisabledBody",
    bodySubstitutions: [],
    tone: "neutral",
  };
}

export type BadgeTone = "on" | "off" | "error" | "checking";

export interface BadgeModel {
  text: string;
  tone: BadgeTone;
  titleKey: string;
}

export function deriveBadge(state: Pick<PublicState, "phase" | "enabled" | "lastError" | "lastCheck">): BadgeModel {
  if (state.phase === "checking") {
    return { text: "…", tone: "checking", titleKey: "badgeChecking" };
  }
  if (state.lastError?.code || (state.phase === "error" && state.lastCheck?.ok === false)) {
    return { text: "!", tone: "error", titleKey: "badgeError" };
  }
  if (state.enabled) {
    return { text: "ON", tone: "on", titleKey: "badgeOn" };
  }
  return { text: "", tone: "off", titleKey: "badgeOff" };
}

export const BADGE_COLORS: Record<BadgeTone, [number, number, number, number]> = {
  on: [26, 127, 55, 255],
  off: [110, 118, 129, 255],
  error: [207, 34, 46, 255],
  checking: [154, 103, 0, 255],
};

export interface DiagnosticsInput {
  state: PublicState;
  extensionVersion: string;
  userAgent: string;
  platform: string;
  now?: Date;
}

export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  const { state } = input;
  const now = input.now ?? new Date();
  const endpoint = state.endpointHint;

  return {
    generatedAt: now.toISOString(),
    extensionVersion: input.extensionVersion,
    chromeVersion: input.userAgent,
    platform: input.platform,
    scheme: endpoint?.scheme ?? null,
    host: endpoint?.host ?? null,
    port: endpoint?.port ?? null,
    mode: state.mode,
    enabled: state.enabled,
    phase: state.phase,
    hasCredentials: state.hasPassword,
    activeSite: state.activeSite,
    lastError: state.lastError?.code ?? state.lastCheck?.errorCode ?? null,
    lastErrorMessage: errorMessageKey(state.lastError?.code ?? state.lastCheck?.errorCode),
    lastErrorAt: state.lastError?.at ?? null,
    lastCheckAt: state.lastCheck?.at ?? null,
    lastCheckOk: state.lastCheck?.ok ?? null,
  };
}
