import type { ErrorCode } from "./types";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_CFG_HOST: "Проверьте адрес прокси",
  E_CFG_PORT: "Проверьте порт прокси",
  E_CFG_CREDS: "Введите логин и пароль",
  E_PROXY_UNREACHABLE: "Не удалось подключиться к прокси. Проверьте адрес, порт и сеть",
  E_PROXY_TLS: "Ошибка TLS сертификата прокси. Сертификат должен быть выдан доверенным центром",
  E_AUTH_407: "Неверный логин или пароль",
  E_FORBIDDEN_403: "Прокси отклонил запрос (403). Возможно, сайт запрещён или исчерпан лимит",
  E_LIMIT: "Превышен лимит подключений к прокси",
  E_POLICY: "Прокси управляется политикой организации",
  E_OTHER_EXT: "Прокси управляется другим расширением",
  E_TIMEOUT: "Превышено время ожидания (10 с)",
  E_UNSUPPORTED_AUTH: "Прокси требует неподдерживаемый тип авторизации",
  E_NO_NETWORK: "Нет подключения к интернету",
  E_UNKNOWN: "Неизвестная ошибка. Откройте диагностику",
};

const ERROR_CODES = new Set<string>(Object.keys(ERROR_MESSAGES));

export class TunnelError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string = ERROR_MESSAGES[code]) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

export function isTunnelError(error: unknown): error is TunnelError {
  return error instanceof TunnelError;
}

export function errorCodeOf(error: unknown): ErrorCode {
  return isTunnelError(error) ? error.code : "E_UNKNOWN";
}

export function toTunnelError(error: unknown, fallback: ErrorCode = "E_UNKNOWN"): TunnelError {
  if (isTunnelError(error)) {
    return error;
  }

  const message = error instanceof Error && error.message.length > 0 ? error.message : ERROR_MESSAGES[fallback];
  return new TunnelError(fallback, message);
}
