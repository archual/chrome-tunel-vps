import { TunnelError, errorCodeOf, toTunnelError } from "../core/errors";
import { isCoreRequest, type CoreRequest, type CoreResponse, type SettingsInput } from "../core/messages";
import { normalizeProxySettings, validateProxyEndpoint } from "../core/proxy-config";
import type { ErrorCode, ProxySettings, PublicState } from "../core/types";
import { AuthRuntime, registerAuthListener } from "./auth";
import { mapProxyErrorText, mapRequestErrorText, RuntimeErrorSignal } from "./error-signal";
import { ProbeService, shouldDiscardStaleMarker, type ProbeMarkerStore, type ProbeOutcome } from "./probe";
import { createChromeProxySettingsApi, ProxyController } from "./proxy-controller";
import { RuntimeFailureGate } from "./runtime-failures";
import { publishTestResult, runProbeWithPublication } from "./test-result";
import { registerUiSurface } from "./ui-surface";
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
const settingsApi = createChromeProxySettingsApi();
const controller = new ProxyController({ api: settingsApi });
const runtimeSignal = new RuntimeErrorSignal();
const probeGate = new RuntimeFailureGate();

const markerStore: ProbeMarkerStore = {
  save: async (marker) => {
    await updateStore((store) => ({ ...store, testInProgress: marker }));
  },
  clear: async () => {
    await updateStore((store) => ({ ...store, testInProgress: null }));
  },
};

const probeService = new ProbeService({
  proxy: {
    snapshot: () => settingsApi.get({ incognito: false }),
    set: (value) => settingsApi.set({ value, scope: "regular" }),
    restore: (snapshot) => controller.restore(snapshot),
  },
  fetchImpl: (input, init) => fetch(input, init),
  readSignal: () => runtimeSignal.get("auth") ?? runtimeSignal.get("proxy"),
  clearSignals: () => runtimeSignal.clear(),
  marker: markerStore,
});

const authRuntime = new AuthRuntime({
  loadStore: async () => (await loadStore()).store,
  report: (code) => reportRuntimeError(code),
});

registerAuthListener(authRuntime);
registerUiSurface();

chrome.proxy.onProxyError.addListener((details) => {
  const code = mapProxyErrorText(details.error);
  if (code === null) {
    return;
  }
  runtimeSignal.set("proxy", code);
  if (code === "E_AUTH_407" || code === "E_UNSUPPORTED_AUTH") {
    runtimeSignal.set("auth", code);
  }
  reportRuntimeError(code);
});

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.type !== "main_frame") {
      return;
    }
    const code = mapRequestErrorText(details.error);
    if (code === null) {
      return;
    }
    runtimeSignal.set("proxy", code);
    probeGate.report(() => {
      void enqueue(async () => {
        const { store } = await loadStore();
        if (!store.enabled) {
          return;
        }
        await transitionPersistedState("FAIL", new TunnelError(code));
        await updateBadge();
      }).catch(() => undefined);
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "vpsTunnel" in changes) {
    authRuntime.invalidate();
  }
});

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

async function updateBadge(): Promise<void> {
  try {
    const state = await currentPublicState();
    const badge =
      state.phase === "checking"
        ? { text: "…", color: [154, 103, 0, 255] as const, key: "badgeChecking" }
        : state.lastError !== undefined
          ? { text: "!", color: [207, 34, 46, 255] as const, key: "badgeError" }
          : state.enabled
            ? { text: "ON", color: [26, 127, 55, 255] as const, key: "badgeOn" }
            : { text: "", color: [110, 118, 129, 255] as const, key: "badgeOff" };

    const title = chrome.i18n.getMessage(badge.key);
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: [...badge.color] });
    if (title.length > 0) {
      await chrome.action.setTitle({ title });
    }
  } catch {
    void 0;
  }
}

function reportRuntimeError(code: ErrorCode): void {
  runtimeSignal.set("auth", code);
  probeGate.report(() => {
    void enqueue(async () => {
      try {
        await transitionPersistedState("FAIL", new TunnelError(code));
        await updateBadge();
      } catch {
        void 0;
      }
    });
  });
}

async function recoverStaleProbe(): Promise<void> {
  const { store } = await loadStore();
  const marker = store.testInProgress;
  if (marker === null) {
    return;
  }

  await controller.restore(marker.snapshot);
  await updateStore((current) => ({ ...current, testInProgress: null }));
}

function probeOutcomeFromError(error: unknown): ProbeOutcome {
  return {
    ok: false,
    exitIp: null,
    durationMs: null,
    directIp: null,
    suspectedDirect: false,
    errorCode: toTunnelError(error).code,
    recoveryRequired: false,
  };
}

async function testConnection(): Promise<PublicState> {
  const { store } = await loadStore();
  if (store.settings === null || !hasCredentials(store)) {
    throw new TunnelError("E_CFG_CREDS");
  }

  if (store.testInProgress !== null) {
    await recoverStaleProbe();
  }

  const settings = store.settings;
  const tunnelActive = store.enabled && store.mode === "browser";
  authRuntime.setProbeActive(true);
  runtimeSignal.clear();

  try {
    await runProbeWithPublication(
      probeGate,
      async () => {
        try {
          await transitionPersistedState("START_TEST");
          await updateBadge();
        } catch {
          void 0;
        }

        try {
          return await probeService.run(settings, { tunnelActive });
        } catch (error) {
          return probeOutcomeFromError(error);
        }
      },
      (outcome) =>
        publishTestResult(outcome, {
          updateStore,
          transition: (event, error) => transitionPersistedState(event, error),
          updateBadge,
        }),
    );

    return await currentPublicState();
  } finally {
    authRuntime.setProbeActive(false);
    authRuntime.invalidate();
  }
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

interface ClearOutcome {
  applied: boolean;
  error: unknown;
}

async function clearQuietly(): Promise<ClearOutcome> {
  try {
    await controller.clear();
    return { applied: true, error: null };
  } catch (error) {
    return { applied: false, error };
  }
}

async function applyStore(): Promise<boolean> {
  const { store } = await loadStore();

  if (!store.enabled) {
    const clear = await clearQuietly();
    if (!clear.applied) {
      await transitionPersistedState("FAIL", clear.error);
      return false;
    }
    await transitionPersistedState("CLEAR_OK");
    return true;
  }

  if (store.settings === null || !hasCredentials(store)) {
    const clear = await clearQuietly();
    await transitionPersistedState("FAIL", new TunnelError("E_CFG_CREDS"));
    return clear.applied;
  }

  if (store.mode !== "browser") {
    const clear = await clearQuietly();
    if (!clear.applied) {
      await transitionPersistedState("FAIL", clear.error);
      return false;
    }
    await transitionPersistedState("CLEAR_OK");
    return true;
  }

  try {
    await controller.apply(store.settings, store.exclusions);
    await transitionPersistedState("APPLY_OK");
    return true;
  } catch (error) {
    await transitionPersistedState("FAIL", error);
    if (isPolicyError(error)) {
      await updateStore((current) => ({ ...current, enabled: false }));
    }
    return false;
  }
}

async function reconcile(): Promise<boolean> {
  return applyStore();
}

async function bootstrap(): Promise<void> {
  try {
    await restrictToTrustedContexts();
  } catch {
    void 0;
  }
  let recoveryFailed = false;
  try {
    await recoverStaleProbe();
  } catch {
    recoveryFailed = true;
  }
  const applied = await reconcile();
  if (shouldDiscardStaleMarker(recoveryFailed, applied)) {
    try {
      await updateStore((current) => ({ ...current, testInProgress: null }));
    } catch {
      void 0;
    }
  }
  await updateBadge();
}

async function setEnabled(enabled: boolean): Promise<PublicState> {
  authRuntime.invalidate();

  if (!enabled) {
    await updateStore((store) => ({ ...store, enabled: false }));
    try {
      await controller.clear();
      await transitionPersistedState("CLEAR_OK");
      authRuntime.resetAttempts();
    } catch (error) {
      await transitionPersistedState("FAIL", error);
      throw error;
    }
    await updateBadge();
    return currentPublicState();
  }

  const { store } = await loadStore();
  if (store.settings === null) {
    throw new TunnelError("E_CFG_CREDS");
  }
  validateSettings(store.settings);

  await updateStore((current) => ({ ...current, enabled: true }));
  authRuntime.resetAttempts();
  await applyStore();
  await updateBadge();

  const state = await loadPersistedState();
  if (state.phase === "error") {
    throw new TunnelError(state.lastError?.code ?? "E_UNKNOWN", state.lastError?.message);
  }

  return currentPublicState();
}

async function setMode(mode: PublicState["mode"]): Promise<PublicState> {
  const updated = await updateStore((current) => ({ ...current, mode }));
  authRuntime.invalidate();
  if (updated.enabled) {
    await applyStore();
  }
  await updateBadge();
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
  authRuntime.invalidate();
  authRuntime.resetAttempts();
  return currentPublicState();
}

async function forgetCreds(): Promise<PublicState> {
  await forgetCredentials();
  authRuntime.invalidate();
  authRuntime.resetAttempts();
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
  await updateBadge();
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
    case "TEST_CONNECTION":
      return { ok: true, state: await testConnection() };
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
    await recoverStaleProbe();
    await updateBadge();
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
