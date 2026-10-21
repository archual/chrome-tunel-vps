import { t } from "../shared/i18n";

type I18nAttribute = "data-i18n" | "data-i18n-placeholder" | "data-i18n-title" | "data-i18n-aria-label";

const ATTRIBUTE_TARGETS: Record<Exclude<I18nAttribute, "data-i18n">, string> = {
  "data-i18n-placeholder": "placeholder",
  "data-i18n-title": "title",
  "data-i18n-aria-label": "aria-label",
};

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

export function query<T extends Element = Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = t(key);
    }
  });

  (Object.keys(ATTRIBUTE_TARGETS) as Array<Exclude<I18nAttribute, "data-i18n">>).forEach((attribute) => {
    root.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((element) => {
      const key = element.getAttribute(attribute);
      if (key) {
        element.setAttribute(ATTRIBUTE_TARGETS[attribute], t(key));
      }
    });
  });

  document.documentElement.lang = t("localeCode");
  document.title = t("appName");
}

export function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

export function setHidden(id: string, hidden: boolean): void {
  const element = document.getElementById(id);
  if (element) {
    element.hidden = hidden;
  }
}

export function setButtonLabel(button: HTMLButtonElement, label: string): void {
  button.textContent = label;
}

export function showToast(message: string, tone: "neutral" | "success" | "danger" = "neutral"): void {
  const toast = document.getElementById("toast");
  if (!toast) {
    return;
  }
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  window.clearTimeout(Number(toast.dataset.timer ?? "0"));
  const timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
  toast.dataset.timer = String(timer);
}

export function formatTime(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  try {
    return new Intl.DateTimeFormat(t("localeCode"), {
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
