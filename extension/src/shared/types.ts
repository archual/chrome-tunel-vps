export type Scheme = "https" | "http";
export type Mode = "browser" | "site";

export type Phase =
  | "unconfigured"
  | "configured_disabled"
  | "checking"
  | "enabled_browser"
  | "enabled_site_active"
  | "enabled_site_inactive"
  | "error";

export type ErrorCode =
  | "E_CFG_HOST"
  | "E_CFG_PORT"
  | "E_CFG_CREDS"
  | "E_PROXY_UNREACHABLE"
  | "E_PROXY_TLS"
  | "E_AUTH_407"
  | "E_FORBIDDEN_403"
  | "E_LIMIT"
  | "E_POLICY"
  | "E_OTHER_EXT"
  | "E_TIMEOUT"
  | "E_UNSUPPORTED_AUTH"
  | "E_NO_NETWORK"
  | "E_UNKNOWN";

export interface EndpointHint {
  scheme: Scheme;
  host: string;
  port: number;
  username: string;
}

export interface LastError {
  code: ErrorCode;
  message?: string;
  at?: string;
}

export interface LastCheck {
  at?: string;
  ok?: boolean;
  exitIp?: string | null;
  errorCode?: ErrorCode | null;
  durationMs?: number;
  directIp?: string | null;
  suspectedDirect?: boolean;
}

export interface PublicState {
  phase: Phase;
  mode: Mode;
  hasSettings: boolean;
  hasPassword: boolean;
  endpointHint?: EndpointHint;
  sites: string[];
  enabled: boolean;
  activeSite: string | null;
  exitIp?: string;
  lastError?: LastError | null;
  lastCheck?: LastCheck | null;
}

export interface ProxySettingsInput {
  scheme: Scheme;
  host: string;
  port: number;
  username: string;
  password?: string;
}

export type UiRequest =
  | { type: "GET_STATE" }
  | { type: "SAVE_SETTINGS"; settings: ProxySettingsInput }
  | { type: "FORGET_CREDS" }
  | { type: "TEST_CONNECTION"; settings?: ProxySettingsInput }
  | { type: "SET_MODE"; mode: Mode }
  | { type: "SET_ENABLED"; enabled: boolean; site?: string }
  | { type: "ADD_SITE"; site: string }
  | { type: "REMOVE_SITE"; site: string }
  | { type: "GET_DIAGNOSTICS" };

export type UiFailure = { ok: false; error: { code: ErrorCode; message: string } };
export type UiSuccess = { ok: true; state: PublicState };
export type UiResponse = UiSuccess | UiFailure;

export interface ActiveTabInfo {
  url?: string;
  host: string | null;
  kind: "web" | "local" | "unsupported";
}
