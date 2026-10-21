import type { ErrorCode, PublicState, TunnelMode, TunnelScheme } from "./types";

export interface SettingsInput {
  scheme: TunnelScheme;
  host: string;
  port: number;
  username: string;
  password?: string;
}

export type CoreRequest =
  | { type: "GET_STATE" }
  | { type: "SAVE_SETTINGS"; settings: SettingsInput }
  | { type: "FORGET_CREDS" }
  | { type: "SET_ENABLED"; enabled: boolean; site?: string }
  | { type: "SET_MODE"; mode: TunnelMode };

export type CoreResponse =
  | { ok: true; state: PublicState }
  | { ok: false; error: { code: ErrorCode; message: string } };

const CORE_REQUEST_TYPES = new Set([
  "GET_STATE",
  "SAVE_SETTINGS",
  "FORGET_CREDS",
  "SET_ENABLED",
  "SET_MODE",
]);

export function isCoreRequest(message: unknown): message is CoreRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    typeof (message as { type: unknown }).type === "string" &&
    CORE_REQUEST_TYPES.has((message as { type: string }).type)
  );
}
