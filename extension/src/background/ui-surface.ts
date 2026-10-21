import { t } from "../shared/i18n";

interface StoredConfig {
  settings?: { host?: string; port?: number };
  enabled?: boolean;
}

interface Snapshot {
  enabled: boolean;
  hasSettings: boolean;
}

const MENU_ROOT = "vps-tunnel";
const MENU_ENABLE = "vps-tunnel-enable";
const MENU_DISABLE = "vps-tunnel-disable";
const MENU_SITE = "vps-tunnel-site";
const MENU_SETTINGS = "vps-tunnel-settings";

const MENU_IDS = new Set<string>([MENU_ROOT, MENU_ENABLE, MENU_DISABLE, MENU_SITE, MENU_SETTINGS]);

type MenusWithOnShown = typeof chrome.contextMenus & {
  onShown?: {
    addListener: (callback: (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void) => void;
  };
  refresh?: () => void;
};

const menus = chrome.contextMenus as MenusWithOnShown;

let lastSnapshot: Snapshot = { enabled: false, hasSettings: false };
let refreshTimer: number | undefined;

async function readSnapshot(): Promise<Snapshot> {
  const local = await chrome.storage.local.get("vpsTunnel");
  const config = (local.vpsTunnel ?? {}) as StoredConfig;
  const hasSettings = Boolean(config.settings?.host && config.settings?.port);
  return { enabled: config.enabled === true, hasSettings };
}

function isRestrictedPage(pageUrl: string | undefined): boolean {
  if (!pageUrl) {
    return true;
  }
  return /^(chrome|edge|about|devtools|chrome-extension|file):/i.test(pageUrl);
}

function updateMenuItems(restricted: boolean): void {
  const update = (id: string, properties: chrome.contextMenus.UpdateProperties): void => {
    chrome.contextMenus.update(id, properties, () => {
      void chrome.runtime.lastError;
    });
  };

  update(MENU_ENABLE, {
    enabled: !lastSnapshot.enabled && lastSnapshot.hasSettings && !restricted,
  });
  update(MENU_DISABLE, { enabled: lastSnapshot.enabled });
  update(MENU_SITE, { enabled: false });
}

async function refreshMenus(): Promise<void> {
  try {
    lastSnapshot = await readSnapshot();
  } catch {
    return;
  }
  updateMenuItems(false);
}

function scheduleMenuRefresh(): void {
  if (refreshTimer !== undefined) {
    globalThis.clearTimeout(refreshTimer);
  }
  const schedule = globalThis.setTimeout as (handler: () => void, timeout: number) => number;
  refreshTimer = schedule(() => {
    refreshTimer = undefined;
    void refreshMenus();
  }, 80);
}

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: MENU_ROOT, title: t("menuRoot"), contexts: ["all"] });
    chrome.contextMenus.create({
      id: MENU_ENABLE,
      parentId: MENU_ROOT,
      title: t("menuEnable"),
      contexts: ["all"],
      enabled: false,
    });
    chrome.contextMenus.create({
      id: MENU_DISABLE,
      parentId: MENU_ROOT,
      title: t("menuDisable"),
      contexts: ["all"],
      enabled: false,
    });
    chrome.contextMenus.create({
      id: MENU_SITE,
      parentId: MENU_ROOT,
      title: t("menuSiteSoon"),
      contexts: ["all"],
      enabled: false,
    });
    chrome.contextMenus.create({
      id: MENU_SETTINGS,
      parentId: MENU_ROOT,
      title: t("menuSettings"),
      contexts: ["all"],
    });
    void refreshMenus();
  });
}

async function setEnabled(enabled: boolean): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled });
  } catch {
    // The menu mirrors storage.onChanged, so a state update still refreshes it.
  }
  scheduleMenuRefresh();
}

async function handleMenuClick(info: chrome.contextMenus.OnClickData): Promise<void> {
  if (!MENU_IDS.has(String(info.menuItemId))) {
    return;
  }

  switch (info.menuItemId) {
    case MENU_ENABLE:
      if (!isRestrictedPage(info.pageUrl)) {
        await setEnabled(true);
      }
      break;
    case MENU_DISABLE:
      await setEnabled(false);
      break;
    case MENU_SETTINGS:
      await chrome.runtime.openOptionsPage();
      break;
    default:
      break;
  }
}

export function registerUiSurface(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    createMenus();
    if (details.reason === "install") {
      void chrome.runtime.openOptionsPage();
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    createMenus();
  });

  chrome.contextMenus.onClicked.addListener((info) => {
    void handleMenuClick(info);
  });

  menus.onShown?.addListener((info) => {
    updateMenuItems(isRestrictedPage(info.pageUrl));
    menus.refresh?.();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "local" && "vpsTunnel" in changes) || area === "session") {
      scheduleMenuRefresh();
    }
  });
}
