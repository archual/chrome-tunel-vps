const EXTENSION_VERSION = chrome.runtime.getManifest().version;

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[vps-tunnel] installed (${details.reason}), version ${EXTENSION_VERSION}`);
  void chrome.action.setBadgeText({ text: "" });
});

chrome.runtime.onStartup.addListener(() => {
  console.info(`[vps-tunnel] browser started, version ${EXTENSION_VERSION}`);
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === "vps-tunnel:ping"
  ) {
    return Promise.resolve({ ok: true, version: EXTENSION_VERSION });
  }

  return undefined;
});
