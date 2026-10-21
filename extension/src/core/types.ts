export const STORAGE_KEY = "vpsTunnel";
export const SESSION_STATE_KEY = "vpsTunnelState";
export const SCHEMA_VERSION = 1;

export type TunnelScheme = "https" | "http";
export type TunnelMode = "browser" | "site";
export type TunnelPhase = "idle" | "testing" | "on" | "error";

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

export interface ProxySettings {
  scheme: TunnelScheme;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface TunnelSite {
  host: string;
  addedAt: string;
}

export interface Exclusions {
  useDefaults: true;
  extra: string[];
}

export interface TestInProgress {
  at: number;
  snapshot: chrome.proxy.ProxyConfig;
}

export interface LastCheck {
  at: string;
  ok: boolean;
  exitIp: string | null;
  errorCode: ErrorCode | null;
}

export interface VpsTunnelStore {
  version: number;
  settings: ProxySettings | null;
  mode: TunnelMode;
  enabled: boolean;
  sites: TunnelSite[];
  exclusions: Exclusions;
  testInProgress: TestInProgress | null;
  lastCheck: LastCheck | null;
  [key: string]: unknown;
}

export interface TunnelLastError {
  code: ErrorCode;
  message: string;
  at: string;
}

export interface PersistedTunnelState {
  phase: TunnelPhase;
  lastError: TunnelLastError | null;
}

export type PublicPhase =
  | "unconfigured"
  | "configured_disabled"
  | "checking"
  | "enabled_browser"
  | "enabled_site_active"
  | "enabled_site_inactive"
  | "error";

export interface PublicState {
  phase: PublicPhase;
  mode: TunnelMode;
  enabled: boolean;
  hasSettings: boolean;
  hasPassword: boolean;
  endpointHint?: {
    scheme: TunnelScheme;
    host: string;
    port: number;
    username: string;
  };
  sites: string[];
  activeSite: string | null;
  exitIp?: string;
  lastError?: TunnelLastError;
  lastCheck?: LastCheck;
}

export type TunnelEvent =
  | "START_TEST"
  | "TEST_DONE"
  | "APPLY_OK"
  | "CLEAR_OK"
  | "FAIL"
  | "RESET";
