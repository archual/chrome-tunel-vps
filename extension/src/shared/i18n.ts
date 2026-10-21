export type Substitutions = string | string[];

export function t(key: string, substitutions?: Substitutions): string {
  const message = chrome.i18n.getMessage(key, substitutions);
  return message.length > 0 ? message : key;
}

export function hasMessage(key: string): boolean {
  return chrome.i18n.getMessage(key).length > 0;
}
