import type { Scheme } from "./types";

export type FieldName = "host" | "port" | "username" | "password";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: FieldName };

const HOST_MAX_LENGTH = 253;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  return match.slice(1).every((octet) => {
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value.includes(":")) {
    return false;
  }
  try {
    const parsed = new URL(`http://[${value}]`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

function normalizeDnsName(value: string): string | null {
  if (hasControlCharacters(value) || value.includes("_")) {
    return null;
  }

  let ascii: string;
  try {
    ascii = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }

  if (!ascii || ascii.length > HOST_MAX_LENGTH || ascii.endsWith(".")) {
    return null;
  }
  if (!ascii.includes(".")) {
    return null;
  }

  const labels = ascii.split(".");
  if (!labels.every((label) => DNS_LABEL_PATTERN.test(label))) {
    return null;
  }
  return ascii;
}

export function validateHost(raw: string): ValidationResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, field: "host" };
  }

  const withoutBrackets = stripIpv6Brackets(trimmed);
  if (withoutBrackets.length === 0) {
    return { ok: false, field: "host" };
  }

  if (isIpv6(withoutBrackets)) {
    return { ok: true, value: withoutBrackets.toLowerCase() };
  }

  if (isIpv4(withoutBrackets)) {
    return { ok: true, value: withoutBrackets };
  }

  if (
    withoutBrackets.length > HOST_MAX_LENGTH ||
    withoutBrackets.includes("://") ||
    /[/\\\s@?#[\]%]/.test(withoutBrackets)
  ) {
    return { ok: false, field: "host" };
  }

  const host = normalizeDnsName(withoutBrackets.toLowerCase());
  return host === null ? { ok: false, field: "host" } : { ok: true, value: host };
}

export function defaultPort(scheme: Scheme): number {
  return scheme === "https" ? 443 : 80;
}

export function validatePort(raw: string, scheme: Scheme): ValidationResult<number> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: defaultPort(scheme) };
  }
  if (!/^\d{1,5}$/.test(trimmed)) {
    return { ok: false, field: "port" };
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, field: "port" };
  }
  return { ok: true, value: port };
}

export function validateUsername(raw: string): ValidationResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64 || hasControlCharacters(trimmed)) {
    return { ok: false, field: "username" };
  }
  return { ok: true, value: trimmed };
}

export function validatePassword(raw: string): ValidationResult<string> {
  if (raw.length === 0 || raw.length > 256 || hasControlCharacters(raw)) {
    return { ok: false, field: "password" };
  }
  return { ok: true, value: raw };
}

export interface SettingsDraft {
  scheme: Scheme;
  host: string;
  port: string;
  username: string;
  password: string;
}

export interface ValidatedSettings {
  scheme: Scheme;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type SettingsErrors = Partial<Record<FieldName, true>>;

export function validateSettingsDraft(
  draft: SettingsDraft,
  options: { passwordRequired: boolean },
): { ok: true; value: ValidatedSettings } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};

  const host = validateHost(draft.host);
  if (!host.ok) {
    errors.host = true;
  }

  const port = validatePort(draft.port, draft.scheme);
  if (!port.ok) {
    errors.port = true;
  }

  const username = validateUsername(draft.username);
  if (!username.ok) {
    errors.username = true;
  }

  let passwordValue = draft.password;
  if (options.passwordRequired || draft.password.length > 0) {
    const password = validatePassword(draft.password);
    if (!password.ok) {
      errors.password = true;
    } else {
      passwordValue = password.value;
    }
  }

  if (!host.ok || !port.ok || !username.ok || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      scheme: draft.scheme,
      host: host.value,
      port: port.value,
      username: username.value,
      password: passwordValue,
    },
  };
}
