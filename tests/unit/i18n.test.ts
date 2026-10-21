import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionRoot = resolve(repoRoot, "extension");

interface LocaleMessage {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string }>;
}

type Locale = Record<string, LocaleMessage>;

function readLocale(locale: string): Locale {
  return JSON.parse(
    readFileSync(resolve(extensionRoot, `public/_locales/${locale}/messages.json`), "utf8"),
  ) as Locale;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (/\.(ts|html)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

const ru = readLocale("ru");
const en = readLocale("en");
const sourceFiles = walk(resolve(extensionRoot, "src")).concat([
  resolve(extensionRoot, "popup.html"),
  resolve(extensionRoot, "options.html"),
]);

function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  const patterns = [
    /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g,
    /\bt\("([^"]+)"/g,
  ];

  for (const file of sourceFiles) {
    const content = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) {
          keys.add(match[1]);
        }
      }
    }
  }

  return keys;
}

function placeholderTokens(message: string): string[] {
  return [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((match) => match[1] ?? "");
}

describe("locales", () => {
  it("keeps RU and EN key sets in sync", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it("provides non-empty messages and descriptions", () => {
    for (const [key, entry] of Object.entries(ru)) {
      expect(entry.message.length, `ru.${key}`).toBeGreaterThan(0);
      expect(entry.description?.length, `ru.${key}`).toBeGreaterThan(0);
      expect(en[key]?.message.length, `en.${key}`).toBeGreaterThan(0);
      expect(en[key]?.description?.length, `en.${key}`).toBeGreaterThan(0);
    }
  });

  it("defines every placeholder used by a message", () => {
    for (const locale of [ru, en]) {
      for (const [key, entry] of Object.entries(locale)) {
        const tokens = placeholderTokens(entry.message);
        for (const token of tokens) {
          expect(entry.placeholders?.[token], `${key}.${token}`).toBeDefined();
        }
      }
    }
  });

  it("has an EN fallback for every referenced UI string", () => {
    const missing: string[] = [];
    for (const key of referencedKeys()) {
      if (!ru[key] || !en[key]) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("uses the locale code advertised by each bundle", () => {
    expect(ru.localeCode?.message).toBe("ru");
    expect(en.localeCode?.message).toBe("en");
  });

  it("keeps the manifest on localized messages", () => {
    const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "public/manifest.json"), "utf8")) as {
      name: string;
      description: string;
      action: { default_title: string };
    };
    expect(manifest.name).toBe("__MSG_extName__");
    expect(manifest.description).toBe("__MSG_extDescription__");
    expect(manifest.action.default_title).toBe("__MSG_actionTitle__");
    expect(ru.extName).toBeDefined();
    expect(ru.extDescription).toBeDefined();
    expect(ru.actionTitle).toBeDefined();
  });
});

describe("markup", () => {
  it("does not hardcode visible UI strings in popup/options HTML", () => {
    for (const file of ["popup.html", "options.html"]) {
      const html = readFileSync(resolve(extensionRoot, file), "utf8");
      const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
      const withoutTags = body
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/g, " ")
        .replace(/[0-9—\s·]/g, "");
      expect(withoutTags, `${file} has literal text`).toBe("");
    }
  });
});
