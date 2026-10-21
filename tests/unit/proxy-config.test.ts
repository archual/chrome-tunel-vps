import { describe, expect, it } from "vitest";
import { buildProxyConfig, normalizeHost, normalizeProxySettings } from "../../extension/src/core/proxy-config";
import type { ProxySettings } from "../../extension/src/core/types";

const baseSettings: ProxySettings = {
  scheme: "https",
  host: "proxy.k1812.ru",
  port: 443,
  username: "owner",
  password: "secret",
};

describe("buildProxyConfig", () => {
  it("builds a single fixed_servers proxy with the default bypass list", () => {
    const config = buildProxyConfig(baseSettings);

    expect(config.mode).toBe("fixed_servers");
    expect(config.rules.singleProxy).toEqual({
      scheme: "https",
      host: "proxy.k1812.ru",
      port: 443,
    });
    expect(config.rules.bypassList).toEqual(
      expect.arrayContaining(["<local>", "localhost", "127.0.0.0/8", "192.168.0.0/16", "proxy.k1812.ru"]),
    );
    expect(config.rules).not.toHaveProperty("fallbackProxy");
    expect(config).not.toHaveProperty("pacScript");
  });

  it("keeps fail-closed semantics: only a PROXY server, never DIRECT", () => {
    const config = buildProxyConfig(baseSettings);

    expect(config.mode).toBe("fixed_servers");
    expect(config.rules.singleProxy).toBeDefined();
    expect(JSON.stringify(config)).not.toContain("DIRECT");
  });

  it("honors the explicit http scheme and adds user exclusions", () => {
    const config = buildProxyConfig(
      { ...baseSettings, scheme: "http", port: 3128 },
      { useDefaults: true, extra: ["*.corp.example"] },
    );

    expect(config.rules.singleProxy).toEqual({ scheme: "http", host: "proxy.k1812.ru", port: 3128 });
    expect(config.rules.bypassList).toContain("*.corp.example");
  });

  it("normalizes the host to lowercase and strips IPv6 brackets and trailing dots", () => {
    expect(normalizeHost("Proxy.K1812.RU.")).toBe("proxy.k1812.ru");
    expect(normalizeHost("[2001:DB8::1]")).toBe("2001:db8::1");
  });

  it.each(["http://proxy.example", "proxy.example/path", "bad host", "user@proxy.example", "proxy?x=1"])(
    "rejects an invalid host: %s",
    (host) => {
      expect(() => buildProxyConfig({ ...baseSettings, host })).toThrowError(
        expect.objectContaining({ code: "E_CFG_HOST" }),
      );
    },
  );

  it.each([0, 65536, -1, 1.5, Number.NaN])("rejects an invalid port: %s", (port) => {
    expect(() => buildProxyConfig({ ...baseSettings, port })).toThrowError(
      expect.objectContaining({ code: "E_CFG_PORT" }),
    );
  });

  it("trims the username but never the password", () => {
    const normalized = normalizeProxySettings({
      ...baseSettings,
      username: " owner ",
      password: " secret ",
    });

    expect(normalized.username).toBe("owner");
    expect(normalized.password).toBe(" secret ");
  });
});
