import { isErrorCode, toTunnelError } from "../core/errors";
import {
  SCHEMA_VERSION,
  SESSION_STATE_KEY,
  STORAGE_KEY,
  type Exclusions,
  type LastCheck,
  type PersistedTunnelState,
  type ProxySettings,
  type PublicState,
  type TestInProgress,
  type TunnelEvent,
  type TunnelLastError,
  type TunnelPhase,
  type TunnelSite,
  type VpsTunnelStore,
} from "../core/types";

type UnknownRecord = Record<string, unknown>;

export interface LocalStorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<UnknownRecord>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS" }): Promise<void>;
}

export interface SessionStorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<UnknownRecord>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

export interface NormalizeResult {
  store: VpsTunnelStore;
  migrated: boolean;
  reset: boolean;
  warning: string | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeStoredHost(rawHost: string): string {
  let host = rawHost.trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host.replace(/\.$/, "").toLowerCase();
}

function schemeFrom(value: unknown): "https" | "http" {
  return value === "http" ? "http" : "https";
}

function normalizeSettings(value: unknown): ProxySettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const hostValue = asString(value.host);
  const port = asNumber(value.port);
  if (hostValue === undefined || port === null) {
    return null;
  }

  const host = normalizeStoredHost(hostValue);
  if (host.length === 0) {
    return null;
  }

  return {
    scheme: schemeFrom(value.scheme),
    host,
    port,
    username: asString(value.username) ?? "",
    password: asString(value.password) ?? "",
  };
}

function normalizeSites(value: unknown): TunnelSite[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sites: TunnelSite[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const rawHost = typeof item === "string" ? item : isRecord(item) ? asString(item.host) : undefined;
    if (rawHost === undefined) {
      continue;
    }

    const host = normalizeStoredHost(rawHost).replace(/^\./, "");
    if (host.length === 0 || /[\s/?#@\\]/.test(host) || seen.has(host)) {
      continue;
    }

    seen.add(host);
    const addedAt = isRecord(item) ? asString(item.addedAt) : undefined;
    sites.push({ host, addedAt: addedAt ?? new Date().toISOString() });
  }

  return sites;
}

function normalizeExclusions(value: unknown): Exclusions {
  const rawExtra = isRecord(value) && Array.isArray(value.extra) ? value.extra : [];
  const extra: string[] = [];
  const seen = new Set<string>();

  for (const entry of rawExtra) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    extra.push(trimmed);
  }

  return { useDefaults: true, extra };
}

function normalizeTestInProgress(value: unknown): TestInProgress | null {
  if (!isRecord(value) || typeof value.at !== "number" || !isRecord(value.snapshot)) {
    return null;
  }

  return {
    at: value.at,
    snapshot: value.snapshot as unknown as chrome.proxy.ProxyConfig,
  };
}

function normalizeLastCheck(value: unknown): LastCheck | null {
  if (!isRecord(value)) {
    return null;
  }

  const at = asString(value.at);
  if (at === undefined) {
    return null;
  }

  const exitIp = asString(value.exitIp) ?? asString(value.ip) ?? null;
  const errorCode = isErrorCode(value.errorCode) ? value.errorCode : isErrorCode(value.code) ? value.code : null;

  return {
    at,
    ok: value.ok === true,
    exitIp,
    errorCode,
  };
}

function readVersion(value: UnknownRecord): number {
  const version = asNumber(value.version);
  return version === null ? 0 : version;
}

function migrateV0(value: UnknownRecord): UnknownRecord {
  const legacySettings = isRecord(value.settings) ? value.settings : {};
  const host = asString(legacySettings.host) ?? asString(value.host);
  const port = asNumber(legacySettings.port) ?? asNumber(value.port);

  let settings: UnknownRecord | null = null;
  if (host !== undefined && port !== null) {
    settings = {
      scheme: schemeFrom(legacySettings.scheme ?? legacySettings.protocol ?? value.scheme ?? value.protocol),
      host,
      port,
      username:
        asString(legacySettings.username) ??
        asString(legacySettings.login) ??
        asString(value.username) ??
        asString(value.login) ??
        "",
      password: asString(legacySettings.password) ?? asString(value.password) ?? "",
    };
  }

  const migrated: UnknownRecord = {
    ...value,
    version: SCHEMA_VERSION,
    settings,
  };

  if (value.exclusions === undefined && Array.isArray(value.bypass)) {
    migrated.exclusions = { useDefaults: true, extra: value.bypass };
  }
  if (value.lastCheck === undefined && value.lastTest !== undefined) {
    migrated.lastCheck = value.lastTest;
  }

  return migrated;
}

const MIGRATIONS: Record<number, (value: UnknownRecord) => UnknownRecord> = {
  0: migrateV0,
};

function resetResult(warning: string): NormalizeResult {
  return {
    store: createDefaultStore(),
    migrated: false,
    reset: true,
    warning,
  };
}

export function createDefaultStore(): VpsTunnelStore {
  return {
    version: SCHEMA_VERSION,
    settings: null,
    mode: "browser",
    enabled: false,
    sites: [],
    exclusions: { useDefaults: true, extra: [] },
    testInProgress: null,
    lastCheck: null,
  };
}

export function normalizeStore(raw: unknown): NormalizeResult {
  if (raw === undefined || raw === null) {
    return { store: createDefaultStore(), migrated: false, reset: false, warning: null };
  }

  if (!isRecord(raw)) {
    return resetResult("Некорректные сохранённые настройки сброшены");
  }

  const version = readVersion(raw);
  if (version > SCHEMA_VERSION) {
    return resetResult("Настройки созданы более новой версией расширения и сброшены");
  }

  let source: UnknownRecord = { ...raw };
  let migrated = false;

  for (let current = version; current < SCHEMA_VERSION; current += 1) {
    const step = MIGRATIONS[current];
    if (step === undefined) {
      return resetResult("Не удалось перенести сохранённые настройки, применены настройки по умолчанию");
    }
    source = step(source);
    migrated = true;
  }

  const store = createDefaultStore();

  for (const [key, value] of Object.entries(source)) {
    if (!(key in store)) {
      store[key] = value;
    }
  }

  store.version = SCHEMA_VERSION;
  store.settings = normalizeSettings(source.settings);
  store.mode = source.mode === "site" ? "site" : "browser";
  store.enabled = source.enabled === true;
  store.sites = normalizeSites(source.sites);
  store.exclusions = normalizeExclusions(source.exclusions);
  store.testInProgress = normalizeTestInProgress(source.testInProgress);
  store.lastCheck = normalizeLastCheck(source.lastCheck);

  return { store, migrated, reset: false, warning: null };
}

export function hasCredentials(store: VpsTunnelStore): boolean {
  return (
    store.settings !== null &&
    store.settings.username.length > 0 &&
    store.settings.password.length > 0
  );
}

function toPublicPhase(
  store: VpsTunnelStore,
  state: PersistedTunnelState,
  activeSite: string | null,
): PublicState["phase"] {
  if (store.settings === null) {
    return "unconfigured";
  }
  if (state.phase === "testing") {
    return "checking";
  }
  if (state.phase === "error") {
    return "error";
  }
  if (!store.enabled) {
    return "configured_disabled";
  }
  if (store.mode === "browser") {
    return state.phase === "on" ? "enabled_browser" : "configured_disabled";
  }
  return activeSite === null ? "enabled_site_inactive" : "enabled_site_active";
}

export function toPublicState(
  store: VpsTunnelStore,
  state: PersistedTunnelState,
  activeSite: string | null = null,
): PublicState {
  const publicState: PublicState = {
    phase: toPublicPhase(store, state, activeSite),
    mode: store.mode,
    enabled: store.enabled,
    hasSettings: store.settings !== null,
    hasPassword: (store.settings?.password.length ?? 0) > 0,
    sites: store.sites.map((site) => site.host),
    activeSite,
  };

  if (store.settings !== null) {
    publicState.endpointHint = {
      scheme: store.settings.scheme,
      host: store.settings.host,
      port: store.settings.port,
      username: store.settings.username,
    };
  }

  if (state.lastError !== null) {
    publicState.lastError = state.lastError;
  }

  if (store.lastCheck !== null) {
    publicState.lastCheck = store.lastCheck;
    if (store.lastCheck.ok && store.lastCheck.exitIp !== null) {
      publicState.exitIp = store.lastCheck.exitIp;
    }
  }

  return publicState;
}

export async function loadStore(area: LocalStorageAreaLike = chrome.storage.local): Promise<NormalizeResult> {
  const items = await area.get(STORAGE_KEY);
  const result = normalizeStore(items[STORAGE_KEY]);
  if (result.migrated || result.reset) {
    await saveStore(result.store, area);
  }
  return result;
}

export async function saveStore(
  store: VpsTunnelStore,
  area: LocalStorageAreaLike = chrome.storage.local,
): Promise<void> {
  await area.set({ [STORAGE_KEY]: store });
}

export async function updateStore(
  update: (store: VpsTunnelStore) => VpsTunnelStore,
  area: LocalStorageAreaLike = chrome.storage.local,
): Promise<VpsTunnelStore> {
  const { store } = await loadStore(area);
  const next = update(store);
  next.version = SCHEMA_VERSION;
  await saveStore(next, area);
  return next;
}

export async function forgetCredentials(
  area: LocalStorageAreaLike = chrome.storage.local,
): Promise<VpsTunnelStore> {
  return updateStore((store) => ({
    ...store,
    settings:
      store.settings === null
        ? null
        : { ...store.settings, username: "", password: "" },
    enabled: false,
    testInProgress: null,
    lastCheck: null,
  }), area);
}

export async function restrictToTrustedContexts(
  area: LocalStorageAreaLike = chrome.storage.local,
): Promise<boolean> {
  if (typeof area.setAccessLevel !== "function") {
    return false;
  }
  await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  return true;
}

const PHASES = new Set<TunnelPhase>(["idle", "testing", "on", "error"]);

export function createDefaultState(): PersistedTunnelState {
  return { phase: "idle", lastError: null };
}

export function transitionPhase(phase: TunnelPhase, event: TunnelEvent): TunnelPhase {
  switch (event) {
    case "START_TEST":
      return "testing";
    case "TEST_DONE":
    case "CLEAR_OK":
    case "RESET":
      return "idle";
    case "APPLY_OK":
      return "on";
    case "FAIL":
      return "error";
    default:
      return phase;
  }
}

export function reduceState(
  current: PersistedTunnelState,
  event: TunnelEvent,
  error?: unknown,
): PersistedTunnelState {
  const phase = transitionPhase(current.phase, event);

  if (event === "FAIL") {
    const tunnelError = toTunnelError(error);
    return {
      phase,
      lastError: {
        code: tunnelError.code,
        message: tunnelError.message,
        at: new Date().toISOString(),
      },
    };
  }

  if (event === "APPLY_OK" || event === "CLEAR_OK" || event === "RESET" || event === "START_TEST") {
    return { phase, lastError: null };
  }

  return { phase, lastError: current.lastError };
}

function normalizePersistedState(value: unknown): PersistedTunnelState {
  if (!isRecord(value)) {
    return createDefaultState();
  }

  const phase = typeof value.phase === "string" && PHASES.has(value.phase as TunnelPhase)
    ? (value.phase as TunnelPhase)
    : "idle";

  const rawError = value.lastError;
  const lastError: TunnelLastError | null =
    isRecord(rawError) && isErrorCode(rawError.code) && typeof rawError.message === "string" && typeof rawError.at === "string"
      ? { code: rawError.code, message: rawError.message, at: rawError.at }
      : null;

  return { phase, lastError };
}

export async function loadPersistedState(
  area: SessionStorageAreaLike = chrome.storage.session,
): Promise<PersistedTunnelState> {
  const items = await area.get(SESSION_STATE_KEY);
  return normalizePersistedState(items[SESSION_STATE_KEY]);
}

export async function savePersistedState(
  state: PersistedTunnelState,
  area: SessionStorageAreaLike = chrome.storage.session,
): Promise<void> {
  await area.set({ [SESSION_STATE_KEY]: state });
}

export async function transitionPersistedState(
  event: TunnelEvent,
  error?: unknown,
  area: SessionStorageAreaLike = chrome.storage.session,
): Promise<PersistedTunnelState> {
  const current = await loadPersistedState(area);
  const next = reduceState(current, event, error);
  await savePersistedState(next, area);
  return next;
}
