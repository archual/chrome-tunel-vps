import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

describe("extension scaffold", () => {
  const manifest = readJson("extension/public/manifest.json");
  const pkg = readJson("package.json");

  it("uses Manifest V3 and Chrome 120+", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("120");
  });

  it("requests exactly the approved permissions and no tabs", () => {
    expect(manifest.permissions).toEqual([
      "proxy",
      "storage",
      "webRequest",
      "webRequestAuthProvider",
      "contextMenus",
    ]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  it("wires the MV3 service worker and both UI entries", () => {
    expect(manifest.background).toEqual({ service_worker: "service-worker.js", type: "module" });
    expect(manifest.action).toMatchObject({ default_popup: "popup.html" });
    expect(manifest.options_page).toBe("options.html");
  });

  it("keeps manifest and package versions in sync", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares the required npm scripts", () => {
    expect(Object.keys(pkg.scripts as Record<string, string>)).toEqual(
      expect.arrayContaining(["build", "package", "typecheck", "lint", "test"]),
    );
  });
});
