import { describeActiveTab } from "../shared/site";
import type { ActiveTabInfo, ErrorCode, PublicState, UiRequest, UiResponse } from "../shared/types";

export class UiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

function isResponse(value: unknown): value is UiResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if ((value as { ok: unknown }).ok === true) {
    return "state" in value;
  }
  return "error" in value;
}

export async function send(request: UiRequest): Promise<UiResponse> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch {
    throw new UiError("E_UNKNOWN", "The background service worker did not respond");
  }

  if (!isResponse(response)) {
    throw new UiError("E_UNKNOWN", "The background service worker returned an invalid response");
  }
  return response;
}

export async function requireState(request: UiRequest): Promise<PublicState> {
  const response = await send(request);
  if (!response.ok) {
    throw new UiError(response.error.code, response.error.message);
  }
  return response.state;
}

export async function getState(): Promise<PublicState> {
  return requireState({ type: "GET_STATE" });
}

export async function getActiveTab(): Promise<ActiveTabInfo> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url;
    return describeActiveTab(url);
  } catch {
    return { kind: "unsupported", host: null };
  }
}

type StateListener = (state: PublicState) => void;

export function onStateChanged(listener: StateListener): () => void {
  let disposed = false;
  let timer: number | undefined;

  const reload = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (disposed) {
        return;
      }
      void getState()
        .then((state) => {
          if (!disposed) {
            listener(state);
          }
        })
        .catch(() => {
          // Keep the last known state while the worker wakes up.
        });
    }, 80);
  };

  const storageListener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
    if (area === "local" || area === "session") {
      const relevant = area === "local" ? changes.vpsTunnel : true;
      if (relevant) {
        reload();
      }
    }
  };

  chrome.storage.onChanged.addListener(storageListener);

  return () => {
    disposed = true;
    window.clearTimeout(timer);
    chrome.storage.onChanged.removeListener(storageListener);
  };
}

export function openOptions(hash?: string): void {
  const base = chrome.runtime.getURL("options.html");
  const url = hash ? `${base}#${hash}` : base;

  if (hash) {
    void chrome.tabs.create({ url });
    return;
  }

  void chrome.runtime.openOptionsPage();
}
