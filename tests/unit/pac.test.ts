import { describe, expect, it } from "vitest";
import { buildPac, normalizePacHost, PROBE_HOSTS } from "../../extension/src/core/pac";

const proxy = { scheme: "https" as const, host: "proxy.k1812.ru", port: 443 };

describe("normalizePacHost", () => {
  it("lowercases, strips a trailing dot and converts IDN to punycode", () => {
    expect(normalizePacHost("  API.IPIFY.ORG.  ")).toBe("api.ipify.org");
    expect(normalizePacHost("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
  });

  it("strips IPv6 brackets", () => {
    expect(normalizePacHost("[::1]")).toBe("::1");
  });

  it.each([
    'evil.com";alert(1)//',
    "evil.com\nreturn \"DIRECT\"",
    "evil.com; return 'DIRECT'",
    "host with space",
    "http://evil.com",
    "user@evil.com",
    "",
  ])("rejects an unsafe host: %j", (host) => {
    expect(() => normalizePacHost(host)).toThrowError(expect.objectContaining({ code: "E_CFG_HOST" }));
  });
});

describe("buildPac", () => {
  it("proxies only probe hosts and sends everything else DIRECT", () => {
    const pac = buildPac(proxy);

    expect(pac).toContain("function FindProxyForURL(url, host)");
    expect(pac).toContain('host === "api.ipify.org"');
    expect(pac).toContain('dnsDomainIs(host, ".ifconfig.me")');
    expect(pac).toContain('return "HTTPS proxy.k1812.ru:443";');
    expect(pac.trimEnd().endsWith('return "DIRECT";\n}')).toBe(true);
  });

  it("is deterministic and never contains credentials", () => {
    const settings = { ...proxy, username: "owner", password: "super-secret" };
    const first = buildPac(settings);
    const second = buildPac(settings);

    expect(first).toBe(second);
    expect(first).not.toContain("owner");
    expect(first).not.toContain("super-secret");
  });

  it("uses PROXY for an HTTP proxy and brackets IPv6 literals", () => {
    const pac = buildPac({ scheme: "http", host: "2001:db8::1", port: 8080 });

    expect(pac).toContain('return "PROXY [2001:db8::1]:8080";');
  });

  it("normalizes probe hosts and removes duplicates", () => {
    const pac = buildPac(proxy, [" API.IPIFY.ORG. ", "api.ipify.org", "ifconfig.me"]);

    expect(pac.match(/api\.ipify\.org/g)).toHaveLength(2);
    expect(pac).toContain('host === "ifconfig.me"');
  });

  it("keeps only DIRECT when the probe host list is empty", () => {
    const pac = buildPac(proxy, []);

    expect(pac).not.toContain("HTTPS proxy.k1812.ru:443");
    expect(pac).toContain('return "DIRECT";');
  });

  it("rejects invalid proxy endpoints", () => {
    expect(() => buildPac({ scheme: "https", host: "proxy.example", port: 0 })).toThrowError(
      expect.objectContaining({ code: "E_CFG_PORT" }),
    );
  });

  it("exports the default probe host list", () => {
    expect(PROBE_HOSTS).toEqual(["api.ipify.org", "ifconfig.me"]);
  });
});
