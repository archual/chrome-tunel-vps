import "../base.css";
import { applyI18n, byId, formatTime, showToast } from "../dom";
import { t } from "../../shared/i18n";
import { derivePopupView, errorMessageKey, type PopupView } from "../../shared/popup-state";
import type { ActiveTabInfo, ErrorCode, PublicState, UiRequest } from "../../shared/types";
import { getActiveTab, getState, onStateChanged, openOptions, send, UiError } from "../runtime";

const stateCard = byId<HTMLElement>("state-card");
const stateTitle = byId<HTMLElement>("state-title");
const stateBody = byId<HTMLElement>("state-body");
const errorCode = byId<HTMLElement>("error-code");
const spinner = byId<HTMLElement>("spinner");
const facts = byId<HTMLElement>("facts");
const factSite = byId<HTMLElement>("fact-site");
const factIp = byId<HTMLElement>("fact-ip");
const siteValue = byId<HTMLElement>("site-value");
const modeValue = byId<HTMLElement>("mode-value");
const exitValue = byId<HTMLElement>("exit-value");
const primaryAction = byId<HTMLButtonElement>("primary-action");
const siteAction = byId<HTMLButtonElement>("site-action");
const testAction = byId<HTMLButtonElement>("test-action");
const diagnosticsAction = byId<HTMLButtonElement>("diagnostics-action");
const settingsButton = byId<HTMLButtonElement>("open-settings");
const versionElement = byId<HTMLElement>("version");

let currentState: PublicState | null = null;
let currentTab: ActiveTabInfo = { kind: "unsupported", host: null };
let busy = false;
let stopListening: (() => void) | null = null;

function errorText(code: ErrorCode): string {
  return t(errorMessageKey(code));
}

function toneFor(view: PopupView): string {
  if (view.tone === "danger") {
    return "danger";
  }
  return view.tone;
}

function setPrimary(label: string, enabled: boolean): void {
  primaryAction.textContent = label;
  primaryAction.hidden = false;
  primaryAction.disabled = !enabled || busy;
}

function renderFacts(state: PublicState): void {
  facts.hidden = !state.hasSettings;
  factSite.hidden = currentTab.host === null;
  siteValue.textContent = currentTab.host ?? "—";
  siteValue.classList.add("mono");

  modeValue.textContent = t(state.mode === "browser" ? "modeBrowser" : "modeSite");

  const lastCheck = state.lastCheck;
  const exitIp = state.exitIp ?? lastCheck?.exitIp ?? undefined;
  exitValue.textContent = exitIp ?? t("exitIpUnknown");
  exitValue.classList.add("mono");

  if (lastCheck?.at) {
    factIp.title = t("lastChecked", [formatTime(lastCheck.at)]);
  } else {
    factIp.removeAttribute("title");
  }
}

function renderPrimary(view: PopupView): void {
  if (view.kind === "unconfigured") {
    setPrimary(t("setupTunnel"), true);
    return;
  }
  if (view.kind === "checking") {
    setPrimary(t("testing"), false);
    return;
  }
  if (view.kind === "auth_error" || view.kind === "policy_error") {
    setPrimary(t("openSettings"), true);
    return;
  }
  if (view.kind === "network_error") {
    setPrimary(t("retry"), true);
    return;
  }
  if (view.kind === "browser" || view.kind === "site_active") {
    setPrimary(t("disableTunnel"), true);
    return;
  }
  if (view.kind === "site_inactive") {
    setPrimary(t("enableHere"), true);
    return;
  }
  if (view.kind === "disabled") {
    setPrimary(t("enableTunnel"), true);
    return;
  }
  primaryAction.hidden = true;
  primaryAction.disabled = true;
}

function renderSiteAction(view: PopupView): void {
  const visible =
    view.kind === "disabled" ||
    view.kind === "browser" ||
    view.kind === "site_inactive" ||
    view.kind === "site_active";
  siteAction.hidden = !visible;
  siteAction.disabled = true;
  siteAction.textContent = t("siteModeSoon");
}

function render(): void {
  if (!currentState) {
    return;
  }

  const state = currentState;
  const view = derivePopupView(state, currentTab);

  stateCard.dataset.tone = toneFor(view);
  stateTitle.textContent = t(view.titleKey, view.bodySubstitutions);
  stateBody.textContent =
    view.bodySubstitutions.length > 0 ? t(view.bodyKey, view.bodySubstitutions) : t(view.bodyKey);

  spinner.hidden = view.kind !== "checking";

  const code = state.lastError?.code ?? state.lastCheck?.errorCode ?? null;
  errorCode.hidden = code === null;
  errorCode.textContent = code ?? "";

  renderFacts(state);
  renderPrimary(view);
  renderSiteAction(view);

  testAction.disabled = busy || !state.hasSettings || state.phase === "checking";
  testAction.textContent = state.phase === "checking" ? t("testing") : t("checkConnection");

  versionElement.textContent = t("versionLabel", [chrome.runtime.getManifest().version]);
}

function optimisticChecking(state: PublicState): PublicState {
  return { ...state, phase: "checking" };
}

async function runTest(): Promise<void> {
  if (!currentState || busy) {
    return;
  }
  const previous = currentState;
  busy = true;
  currentState = optimisticChecking(previous);
  render();
  try {
    const next = await send({ type: "TEST_CONNECTION" });
    if (!next.ok) {
      throw new UiError(next.error.code, next.error.message);
    }
    currentState = next.state;
    render();
    if (next.state.lastError?.code) {
      showToast(errorText(next.state.lastError.code), "danger");
    }
  } catch (error) {
    currentState = previous;
    render();
    const message = error instanceof UiError ? errorText(error.code) : t("errorUnknown");
    showToast(message, "danger");
  } finally {
    busy = false;
    render();
  }
}

function requestForPrimary(): UiRequest | "options" | "test" | null {
  if (!currentState) {
    return null;
  }
  const view = derivePopupView(currentState, currentTab);

  switch (view.kind) {
    case "unconfigured":
    case "auth_error":
    case "policy_error":
      return "options";
    case "network_error":
      return "test";
    case "browser":
    case "site_active":
      return { type: "SET_ENABLED", enabled: false };
    case "site_inactive":
      return {
        type: "SET_ENABLED",
        enabled: true,
        ...(currentTab.host ? { site: currentTab.host } : {}),
      };
    case "disabled":
      return { type: "SET_ENABLED", enabled: true };
    default:
      return null;
  }
}

async function runPrimary(): Promise<void> {
  if (busy) {
    return;
  }
  const request = requestForPrimary();
  if (request === null) {
    return;
  }
  if (request === "options") {
    openOptions();
    return;
  }
  if (request === "test") {
    await runTest();
    return;
  }

  busy = true;
  render();
  try {
    const response = await send(request);
    if (!response.ok) {
      throw new UiError(response.error.code, response.error.message);
    }
    currentState = response.state;
    render();
    showToast(
      request.type === "SET_ENABLED" && request.enabled ? t("enableSuccess") : t("disableSuccess"),
      "success",
    );
  } catch (error) {
    const message = error instanceof UiError ? errorText(error.code) : t("errorUnknown");
    showToast(message, "danger");
  } finally {
    busy = false;
    render();
  }
}

async function init(): Promise<void> {
  applyI18n();
  versionElement.textContent = t("versionLabel", [chrome.runtime.getManifest().version]);

  const [state, tab] = await Promise.all([
    getState().catch(() => null),
    getActiveTab(),
  ]);

  if (tab) {
    currentTab = tab;
  }

  if (!state) {
    currentState = {
      phase: "error",
      mode: "browser",
      hasSettings: false,
      hasPassword: false,
      sites: [],
      enabled: false,
      activeSite: null,
      lastError: { code: "E_UNKNOWN" },
    };
  } else {
    currentState = state;
  }

  render();

  if (!stopListening) {
    stopListening = onStateChanged((next) => {
      currentState = next;
      render();
    });
  }
}

settingsButton.addEventListener("click", () => openOptions());
primaryAction.addEventListener("click", () => {
  void runPrimary();
});
testAction.addEventListener("click", () => {
  void runTest();
});
diagnosticsAction.addEventListener("click", () => {
  openOptions("diagnostics");
});
siteAction.addEventListener("click", () => {
  showToast(t("siteModeSoonBody"));
});

window.addEventListener("unload", () => {
  stopListening?.();
});

void init();
