import "../base.css";
import { applyI18n, byId, copyText, formatTime, setHidden, showToast } from "../dom";
import { t } from "../../shared/i18n";
import {
  buildDiagnostics,
  errorMessageKey,
} from "../../shared/popup-state";
import type { ErrorCode, PublicState, Scheme, UiRequest } from "../../shared/types";
import {
  defaultPort,
  validateHost,
  validatePassword,
  validatePort,
  validateSettingsDraft,
  validateUsername,
  type FieldName,
  type SettingsErrors,
} from "../../shared/validation";
import { getState, onStateChanged, send, UiError } from "../runtime";

const TOTAL_STEPS = 3;

let currentState: PublicState | null = null;
let activeStep = 1;
let dirty = false;
let hasSavedPassword = false;
let saving = false;
let testing = false;
let busy = false;
let forgetArmed = false;
let forgetTimer: number | undefined;
let stopListening: (() => void) | null = null;

const schemeSelect = byId<HTMLSelectElement>("scheme");
const hostInput = byId<HTMLInputElement>("host");
const portInput = byId<HTMLInputElement>("port");
const usernameInput = byId<HTMLInputElement>("username");
const passwordInput = byId<HTMLInputElement>("password");
const passwordHint = byId<HTMLElement>("password-hint");

const fieldErrors: Record<FieldName, HTMLElement> = {
  host: byId("host-error"),
  port: byId("port-error"),
  username: byId("username-error"),
  password: byId("password-error"),
};

const stepSections: Record<number, HTMLElement> = {
  1: byId("step-1"),
  2: byId("step-2"),
  3: byId("step-3"),
};

const stepCounters: Record<number, HTMLElement> = {
  1: byId("step-1-counter"),
  2: byId("step-2-counter"),
  3: byId("step-3-counter"),
};

const stepperButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-step-target]"));

const statusPanel = byId<HTMLElement>("status-panel");
const statusTitle = byId<HTMLElement>("status-title");
const statusEndpoint = byId<HTMLElement>("status-endpoint");
const statusDot = byId<HTMLElement>("status-dot");
const summaryEndpoint = byId<HTMLElement>("summary-endpoint");
const summaryMode = byId<HTMLElement>("summary-mode");
const summaryExit = byId<HTMLElement>("summary-exit");
const testResult = byId<HTMLElement>("test-result");
const testResultText = byId<HTMLElement>("test-result-text");
const testResultWarning = byId<HTMLElement>("test-result-warning");
const toggleTunnel = byId<HTMLButtonElement>("toggle-tunnel");
const testConnection = byId<HTMLButtonElement>("test-connection");
const forgetCreds = byId<HTMLButtonElement>("forget-creds");
const credentialDot = byId<HTMLElement>("credential-dot");
const credentialStateText = byId<HTMLElement>("credential-state-text");
const headerVersion = byId<HTMLElement>("header-version");
const diagnosticsSection = byId<HTMLElement>("diagnostics");

function errorText(code: ErrorCode): string {
  return t(errorMessageKey(code));
}

function currentScheme(): Scheme {
  return schemeSelect.value === "http" ? "http" : "https";
}

function endpointLabel(state: PublicState): string {
  const endpoint = state.endpointHint;
  if (!endpoint) {
    return t("diagNone");
  }
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.scheme}://${host}:${endpoint.port}`;
}

function setFieldError(field: FieldName, key: string | null): void {
  const element = fieldErrors[field];
  element.hidden = key === null;
  element.textContent = key ? t(key) : "";
  const input = field === "host" ? hostInput : field === "port" ? portInput : field === "username" ? usernameInput : passwordInput;
  if (key) {
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
}

function clearErrors(): void {
  (Object.keys(fieldErrors) as FieldName[]).forEach((field) => setFieldError(field, null));
}

function showErrors(errors: SettingsErrors): void {
  setFieldError("host", errors.host ? "errHost" : null);
  setFieldError("port", errors.port ? "errPort" : null);
  setFieldError("username", errors.username ? "errUsername" : null);
  setFieldError("password", errors.password ? "errPassword" : null);
}

function markDirty(): void {
  dirty = true;
  render();
}

function validateAddressStep(): boolean {
  const host = validateHost(hostInput.value);
  const port = validatePort(portInput.value, currentScheme());

  setFieldError("host", host.ok ? null : "errHost");
  setFieldError("port", port.ok ? null : "errPort");

  if (host.ok) {
    hostInput.value = host.value;
  }
  if (port.ok) {
    portInput.value = String(port.value);
  }

  return host.ok && port.ok;
}

function validateCredentialsStep(): { ok: true } | { ok: false } {
  const result = validateSettingsDraft(
    {
      scheme: currentScheme(),
      host: hostInput.value,
      port: portInput.value,
      username: usernameInput.value,
      password: passwordInput.value,
    },
    { passwordRequired: !hasSavedPassword },
  );

  if (!result.ok) {
    showErrors(result.errors);
    return { ok: false };
  }

  usernameInput.value = result.value.username;
  hostInput.value = result.value.host;
  portInput.value = String(result.value.port);
  clearErrors();
  return { ok: true };
}

function syncStepChrome(): void {
  Object.entries(stepSections).forEach(([key, section]) => {
    section.hidden = Number(key) !== activeStep;
  });

  stepperButtons.forEach((button) => {
    const target = Number(button.dataset.stepTarget);
    const isCurrent = target === activeStep;
    if (isCurrent) {
      button.setAttribute("aria-current", "step");
    } else {
      button.removeAttribute("aria-current");
    }
    button.dataset.complete = String(target < activeStep || (currentState?.hasSettings === true && target === 1));
  });
}

function setStep(step: number, scroll = true): void {
  activeStep = Math.min(TOTAL_STEPS, Math.max(1, step));
  syncStepChrome();

  if (scroll) {
    stepSections[activeStep]?.scrollIntoView({ block: "nearest" });
  }
}

function setStatus(state: PublicState): void {
  let titleKey = "statusDisabled";
  let tone: "neutral" | "success" | "warning" | "danger" = "neutral";

  if (state.phase === "checking") {
    titleKey = "statusChecking";
    tone = "warning";
  } else if (!state.hasSettings || state.phase === "unconfigured") {
    titleKey = "statusUnconfigured";
  } else if (state.lastError?.code) {
    titleKey = errorMessageKey(state.lastError.code);
    tone = "danger";
  } else if (state.enabled) {
    titleKey = state.mode === "browser" ? "statusEnabled" : "stateSiteActiveTitle";
    tone = "success";
  }

  statusTitle.textContent =
    state.enabled && state.mode === "site"
      ? t("stateSiteActiveTitle", [state.activeSite ?? "—"])
      : t(titleKey);
  statusPanel.dataset.tone = tone;
  statusDot.dataset.tone = tone === "danger" ? "danger" : tone === "success" ? "success" : tone === "warning" ? "warning" : "muted";

  const endpoint = endpointLabel(state);
  statusEndpoint.textContent = endpoint;
}

function setTestResult(state: PublicState): void {
  const check = state.lastCheck;
  if (!check) {
    testResult.hidden = true;
    testResultWarning.hidden = true;
    return;
  }

  if (check.ok) {
    testResult.hidden = false;
    testResult.dataset.tone = "success";
    const ip = check.exitIp ?? "—";
    const ms = check.durationMs !== undefined ? String(check.durationMs) : "—";
    testResultText.textContent = t("testSuccess", [ip, ms]);
    testResultWarning.hidden = check.suspectedDirect !== true;
    testResultWarning.textContent = check.suspectedDirect === true ? t("testNoProxyWarning") : "";
    return;
  }

  testResult.hidden = false;
  testResultWarning.hidden = true;
  testResult.dataset.tone = "danger";
  testResultText.textContent = errorText((check.errorCode ?? "E_UNKNOWN") as ErrorCode);
}

function setDiagnostics(state: PublicState): void {
  const diagnostics = buildDiagnostics({
    state,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  });

  byId("diag-version").textContent = String(diagnostics.extensionVersion ?? "—");
  byId("diag-endpoint").textContent = endpointLabel(state);
  byId("diag-mode").textContent = t(state.mode === "browser" ? "modeBrowser" : "modeSite");
  const stateLabel =
    !state.hasSettings || state.phase === "unconfigured"
      ? t("statusUnconfigured")
      : state.enabled
        ? t("statusEnabled")
        : t("statusDisabled");
  byId("diag-state").textContent = `${state.phase} · ${stateLabel}`;
  byId("diag-error").textContent = state.lastError?.code
    ? `${state.lastError.code} — ${errorText(state.lastError.code)}`
    : t("diagErrorNone");
  byId("diag-last-check").textContent = state.lastCheck?.at
    ? formatTime(state.lastCheck.at)
    : t("diagNotChecked");
}

function setFormFromState(state: PublicState): void {
  const endpoint = state.endpointHint;
  if (!endpoint) {
    return;
  }

  schemeSelect.value = endpoint.scheme;
  if (!dirty) {
    hostInput.value = endpoint.host;
    portInput.value = String(endpoint.port);
    usernameInput.value = endpoint.username;
  }
}

function render(): void {
  const state = currentState;
  if (!state) {
    return;
  }

  const isHttp = currentScheme() === "http";
  setHidden("http-warning", !isHttp);
  setHidden("http-warning-step3", !isHttp);

  hasSavedPassword = state.hasPassword;
  passwordInput.placeholder = hasSavedPassword
    ? t("passwordPlaceholderSaved")
    : t("passwordPlaceholderNew");
  passwordHint.textContent = hasSavedPassword ? t("passwordHintSaved") : t("passwordHintNew");

  credentialDot.dataset.tone = hasSavedPassword ? "success" : "muted";
  credentialStateText.textContent = hasSavedPassword ? t("savedCredentials") : t("noCredentials");

  summaryEndpoint.textContent = endpointLabel(state);
  summaryMode.textContent = t(state.mode === "browser" ? "modeBrowser" : "modeSite");
  summaryExit.textContent = state.exitIp ?? state.lastCheck?.exitIp ?? t("exitIpUnknown");

  setStatus(state);
  setTestResult(state);
  setDiagnostics(state);

  testConnection.textContent = testing || state.phase === "checking" ? t("testing") : t("checkConnection");
  testConnection.disabled = testing || saving || !state.hasSettings;

  toggleTunnel.textContent = state.enabled ? t("disableTunnel") : t("enableTunnel");
  toggleTunnel.disabled = testing || saving || !state.hasSettings || !state.hasPassword;

  forgetCreds.textContent = forgetArmed ? t("confirmForget") : t("forgetCreds");
  forgetCreds.disabled = !state.hasPassword || saving || testing;

  headerVersion.textContent = t("versionLabel", [chrome.runtime.getManifest().version]);

  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    stepCounters[step]!.textContent = t("stepCounter", [String(step), String(TOTAL_STEPS)]);
  }

  if (dirty) {
    testResult.hidden = false;
    testResult.dataset.tone = "neutral";
    testResultText.textContent = t("testDirtyHint");
  }

  syncStepChrome();
}

function applyState(state: PublicState, syncForm: boolean): void {
  currentState = state;
  hasSavedPassword = state.hasPassword;
  if (syncForm) {
    setFormFromState(state);
  }
  render();
}

async function saveSettings(): Promise<boolean> {
  if (!currentState || saving) {
    return false;
  }
  if (!validateCredentialsStep()) {
    return false;
  }

  saving = true;
  render();

  const settings = {
    scheme: currentScheme(),
    host: hostInput.value,
    port: Number(portInput.value),
    username: usernameInput.value,
    ...(passwordInput.value.length > 0 ? { password: passwordInput.value } : {}),
  };

  try {
    const response = await send({ type: "SAVE_SETTINGS", settings });
    if (!response.ok) {
      throw new UiError(response.error.code, response.error.message);
    }
    currentState = response.state;
    hasSavedPassword = response.state.hasPassword;
    dirty = false;
    passwordInput.value = "";
    clearErrors();
    render();
    showToast(t("saveOk"), "success");
    setStep(3);
    return true;
  } catch (error) {
    const message = error instanceof UiError ? errorText(error.code) : t("saveFailed");
    showToast(message, "danger");
    return false;
  } finally {
    saving = false;
    render();
  }
}

async function runTest(): Promise<void> {
  if (!currentState || testing) {
    return;
  }
  if (dirty) {
    showToast(t("testDirtyHint"), "danger");
    return;
  }
  if (!currentState.hasSettings) {
    setStep(1);
    return;
  }

  const previous = currentState;
  testing = true;
  currentState = { ...currentState, phase: "checking" };
  render();

  try {
    const response = await send({ type: "TEST_CONNECTION" });
    if (!response.ok) {
      throw new UiError(response.error.code, response.error.message);
    }
    currentState = response.state;
    hasSavedPassword = response.state.hasPassword;
    render();
    if (response.state.lastError?.code) {
      showToast(errorText(response.state.lastError.code), "danger");
    }
  } catch (error) {
    currentState = previous;
    const message = error instanceof UiError ? errorText(error.code) : t("testFailed");
    showToast(message, "danger");
  } finally {
    testing = false;
    render();
  }
}

async function runToggle(): Promise<void> {
  if (!currentState || busy) {
    return;
  }

  busy = true;
  render();

  const request: UiRequest = { type: "SET_ENABLED", enabled: !currentState.enabled };

  try {
    const response = await send(request);
    if (!response.ok) {
      throw new UiError(response.error.code, response.error.message);
    }
    currentState = response.state;
    render();
    showToast(response.state.enabled ? t("enableSuccess") : t("disableSuccess"), "success");
  } catch (error) {
    const message = error instanceof UiError ? errorText(error.code) : t("errorUnknown");
    showToast(message, "danger");
  } finally {
    busy = false;
    render();
  }
}

async function runForget(): Promise<void> {
  if (!currentState || !currentState.hasPassword) {
    return;
  }

  if (!forgetArmed) {
    forgetArmed = true;
    render();
    window.clearTimeout(forgetTimer);
    forgetTimer = window.setTimeout(() => {
      forgetArmed = false;
      render();
    }, 4000);
    return;
  }

  window.clearTimeout(forgetTimer);
  forgetArmed = false;
  busy = true;
  render();

  try {
    const response = await send({ type: "FORGET_CREDS" });
    if (!response.ok) {
      throw new UiError(response.error.code, response.error.message);
    }
    currentState = response.state;
    hasSavedPassword = false;
    passwordInput.value = "";
    dirty = false;
    render();
    showToast(t("credsForgotten"), "success");
  } catch (error) {
    const message = error instanceof UiError ? errorText(error.code) : t("credsForgetFailed");
    showToast(message, "danger");
  } finally {
    busy = false;
    render();
  }
}

async function copyDiagnostics(): Promise<void> {
  if (!currentState) {
    return;
  }
  const payload = buildDiagnostics({
    state: currentState,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  });
  const copied = await copyText(JSON.stringify(payload, null, 2));
  showToast(copied ? t("diagnosticsCopied") : t("saveFailed"), copied ? "success" : "danger");
}

function goToStep(target: number): void {
  if (target <= activeStep) {
    setStep(target);
    return;
  }
  if (target === 2) {
    if (!validateAddressStep()) {
      return;
    }
    setStep(2);
    return;
  }
  if (target === 3) {
    if (!currentState?.hasSettings) {
      showToast(t("saveFailed"), "danger");
      return;
    }
    if (dirty) {
      showToast(t("testDirtyHint"), "danger");
      return;
    }
    setStep(3);
  }
}

schemeSelect.addEventListener("change", () => {
  const previousDefault = currentScheme() === "http" ? 443 : 80;
  if (portInput.value === "" || portInput.value === String(previousDefault)) {
    portInput.value = String(defaultPort(currentScheme()));
  }
  markDirty();
});

hostInput.addEventListener("input", () => {
  setFieldError("host", null);
  markDirty();
});
hostInput.addEventListener("blur", () => {
  const result = validateHost(hostInput.value);
  if (!result.ok) {
    setFieldError("host", "errHost");
  } else {
    hostInput.value = result.value;
    setFieldError("host", null);
  }
});

portInput.addEventListener("input", () => {
  setFieldError("port", null);
  markDirty();
});
portInput.addEventListener("blur", () => {
  const result = validatePort(portInput.value, currentScheme());
  if (!result.ok) {
    setFieldError("port", "errPort");
  } else {
    portInput.value = String(result.value);
    setFieldError("port", null);
  }
});

usernameInput.addEventListener("input", () => {
  setFieldError("username", null);
  markDirty();
});
usernameInput.addEventListener("blur", () => {
  const result = validateUsername(usernameInput.value);
  if (!result.ok) {
    setFieldError("username", "errUsername");
  } else {
    usernameInput.value = result.value;
    setFieldError("username", null);
  }
});

passwordInput.addEventListener("input", () => {
  setFieldError("password", null);
  markDirty();
});
passwordInput.addEventListener("blur", () => {
  if (passwordInput.value.length === 0 && hasSavedPassword) {
    setFieldError("password", null);
    return;
  }
  const result = validatePassword(passwordInput.value);
  setFieldError("password", result.ok ? null : "errPassword");
});

byId("step-1-next").addEventListener("click", () => {
  if (validateAddressStep()) {
    setStep(2);
  }
});
byId("step-2-back").addEventListener("click", () => setStep(1));
byId("step-2-save").addEventListener("click", () => {
  void saveSettings();
});
byId("step-3-back").addEventListener("click", () => setStep(2));
byId("test-connection").addEventListener("click", () => {
  void runTest();
});
toggleTunnel.addEventListener("click", () => {
  void runToggle();
});
forgetCreds.addEventListener("click", () => {
  void runForget();
});
byId("copy-diagnostics").addEventListener("click", () => {
  void copyDiagnostics();
});

stepperButtons.forEach((button) => {
  button.addEventListener("click", () => {
    goToStep(Number(button.dataset.stepTarget));
  });
});

async function init(): Promise<void> {
  applyI18n();
  headerVersion.textContent = t("versionLabel", [chrome.runtime.getManifest().version]);
  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    stepCounters[step]!.textContent = t("stepCounter", [String(step), String(TOTAL_STEPS)]);
  }

  try {
    const state = await getState();
    currentState = state;
    hasSavedPassword = state.hasPassword;
    dirty = false;
    setFormFromState(state);
    render();
    setStep(state.hasSettings ? 3 : 1);
  } catch {
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
    render();
    setStep(1);
  }

  if (window.location.hash === "#diagnostics") {
    diagnosticsSection.scrollIntoView({ block: "start" });
  }

  stopListening = onStateChanged((state) => {
    if (saving || testing || busy) {
      return;
    }
    applyState(state, !dirty);
  });
}

window.addEventListener("unload", () => {
  window.clearTimeout(forgetTimer);
  stopListening?.();
});

void init();
