import { TunnelError, errorCodeOf, toTunnelError } from "../core/errors";
import { isCoreRequest, type CoreRequest, type CoreResponse, type SettingsInput } from "../core/messages";
import { normalizeProxySettings, validateProxyEndpoint } from "../core/proxy-config";
import type { ProxySettings, PublicState } from "../core/types";
import { ProxyController } from "./proxy-controller";
import {
  forgetCredentials,
  hasCredentials,
  loadPersistedState,
  loadStore,
  restrictToTrustedContexts,
  toPublicState,
  transitionPersistedState,
  updateStore,
  type LocalStorageAreaLike,
  type SessionStorageAreaLike,
} from "./state";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const controller = new ProxyController();

let operationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(task, task);
  operationQueue = run.catch(() => undefined);
  return run;
}

async function currentPublicState(
  local: LocalStorageAreaLike = chrome.storage.local,
  session: SessionStorageAreaLike = chrome.storage.session,
): Promise<PublicState> {
  const { store } = await loadStore(local);
  const state = await loadPersistedState(session);
  return toPublicState(store, state);
}

function errorResponse(error: unknown): CoreResponse {
  const tunnelError = toTunnelError(error);
  return { ok: false, error: { code: tunnelError.code, message: tunnelError.message } };
}

function validateSettings(settings: ProxySettings): ProxySettings {
  const normalized = normalizeProxySettings(settings);
  validateProxyEndpoint(normalized);
  if (normalized.username.length === 0 || normalized.password.length === 0) {
    throw new TunnelError("E_CFG_CREDS");
  }
  return normalized;
}

function isPolicyError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === "E_POLICY" || code === "E_OTHER_EXT";
}

async function clearQuietly(): Promise<void> {
  try {
    await controller.clear();
  } catch {
    void 0;
  }
}

async function applyStore(): Promise<void> {
  const { store } = await loadStore();

  if (!store.enabled) {
    await clearQuietly();
    await transitionPersistedState("CLEAR_OK");
    return;
  }

  if (store.settings === null || !hasCredentials(store)) {
    await clearQuietly();
    await transitionPersistedState("FAIL", new TunnelError("E_CFG_CREDS"));
    return;
  }

  if (store.mode !== "browser") {
    await clearQuietly();
    await transitionPersistedState("CLEAR_OK");
    return;
  }

  try {
    await controller.apply(store.settings, store.exclusions);
    await transitionPersistedState("APPLY_OK");
  } catch (error) {
    await transitionPersistedState("FAIL", error);
    if (isPolicyError(error)) {
      await updateStore((current) => ({ ...current, enabled: false }));
    }
  }
}

async function reconcile(): Promise<void> {
  await applyStore();
}

async function bootstrap(): Promise<void> {
  try {
    await restrictToTrustedContexts();
  } catch {
    void 0;
  }
  await reconcile();
}

async function setEnabled(enabled: boolean): Promise<PublicState> {
  if (!enabled) {
    await updateStore((store) => ({ ...store, enabled: false }));
    try {
      await controller.clear();
      await transitionPersistedState("CLEAR_OK");
    } catch (error) {
      await transitionPersistedState("FAIL", error);
      throw error;
    }
    return currentPublicState();
  }

  const { store } = await loadStore();
  if (store.settings === null) {
    throw new TunnelError("E_CFG_CREDS");
  }
  validateSettings(store.settings);

  await updateStore((current) => ({ ...current, enabled: true }));
  await applyStore();

  const state = await loadPersistedState();
  if (state.phase === "error") {
    throw new TunnelError(state.lastError?.code ?? "E_UNKNOWN", state.lastError?.message);
  }

  return currentPublicState();
}

async function setMode(mode: PublicState["mode"]): Promise<PublicState> {
  const updated = await updateStore((current) => ({ ...current, mode }));
  if (updated.enabled) {
    await applyStore();
  }
  return currentPublicState();
}

async function saveSettings(input: SettingsInput): Promise<PublicState> {
  const { store } = await loadStore();
  const password =
    input.password !== undefined && input.password.length > 0
      ? input.password
      : (store.settings?.password ?? "");

  const normalized = validateSettings({
    scheme: input.scheme,
    host: input.host,
    port: input.port,
    username: input.username,
    password,
  });

  await updateStore((current) => ({ ...current, settings: normalized }));
  return currentPublicState();
}

async function forgetCreds(): Promise<PublicState> {
  await forgetCredentials();
  try {
    await controller.clear();
    await transitionPersistedState("CLEAR_OK");
  } catch (error) {
    if (isPolicyError(error)) {
      await transitionPersistedState("CLEAR_OK");
    } else {
      await transitionPersistedState("FAIL", error);
      throw error;
    }
  }
  return currentPublicState();
}

async function handleRequest(request: CoreRequest): Promise<CoreResponse> {
  switch (request.type) {
    case "GET_STATE":
      return { ok: true, state: await currentPublicState() };
    case "SAVE_SETTINGS":
      return { ok: true, state: await saveSettings(request.settings) };
    case "FORGET_CREDS":
      return { ok: true, state: await forgetCreds() };
    case "SET_ENABLED":
      return { ok: true, state: await setEnabled(request.enabled) };
    case "SET_MODE":
      return { ok: true, state: await setMode(request.mode) };
    default:
      return errorResponse(new TunnelError("E_UNKNOWN"));
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[vps-tunnel] installed (${details.reason}), version ${EXTENSION_VERSION}`);
  void chrome.action.setBadgeText({ text: "" });
  void enqueue(bootstrap);
});

chrome.runtime.onStartup.addListener(() => {
  console.info(`[vps-tunnel] browser started, version ${EXTENSION_VERSION}`);
  void enqueue(bootstrap);
});

void enqueue(async () => {
  try {
    await restrictToTrustedContexts();
    await loadPersistedState();
  } catch {
    void 0;
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === "vps-tunnel:ping"
  ) {
    sendResponse({ ok: true, version: EXTENSION_VERSION });
    return undefined;
  }

  if (!isCoreRequest(message)) {
    return undefined;
  }

  void enqueue(() => handleRequest(message))
    .then(sendResponse, (error: unknown) => sendResponse(errorResponse(error)));
  return true;
});
