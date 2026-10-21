import { describe, expect, it } from "vitest";
import { DEFAULT_BYPASS_LIST, buildBypassList, normalizeBypassHost } from "../../extension/src/core/bypass";

describe("buildBypassList", () => {
  it("contains every required local, private and special-use range", () => {
    const list = buildBypassList("proxy.k1812.ru");

    expect(list).toEqual(
      expect.arrayContaining([
        "<local>",
        "localhost",
        "127.0.0.0/8",
        "[::1]",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "100.64.0.0/10",
        "fc00::/7",
        "fe80::/10",
        "*.local",
        "proxy.k1812.ru",
      ]),
    );
  });

  it("never adds <-loopback> because localhost must stay direct", () => {
    const list = buildBypassList("proxy.k1812.ru", ["*.corp.example", "<-loopback>"]);

    expect(DEFAULT_BYPASS_LIST).not.toContain("<-loopback>");
    expect(list).not.toContain("<-loopback>");
    expect(list).toContain("*.corp.example");
  });

  it("always includes the proxy host to prevent a routing loop", () => {
    expect(buildBypassList("Proxy.K1812.RU")).toContain("proxy.k1812.ru");
  });

  it("appends user exclusions in order and drops blanks", () => {
    const list = buildBypassList(null, ["  intranet.example  ", "", "   ", "*.internal"]);

    expect(list.slice(-2)).toEqual(["intranet.example", "*.internal"]);
  });

  it("deduplicates case-insensitively without reordering defaults", () => {
    const list = buildBypassList("localhost", ["LOCALHOST", "*.local"]);
    const matches = list.filter((entry) => entry.toLowerCase() === "localhost");

    expect(matches).toEqual(["localhost"]);
    expect(list.filter((entry) => entry.toLowerCase() === "*.local")).toHaveLength(1);
  });

  it("brackets bare IPv6 proxy hosts", () => {
    expect(normalizeBypassHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(normalizeBypassHost("[2001:DB8::1]")).toBe("[2001:db8::1]");
    expect(buildBypassList("2001:db8::1")).toContain("[2001:db8::1]");
  });

  it("does not wrap IPv4 or CIDR entries in brackets", () => {
    expect(normalizeBypassHost("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(normalizeBypassHost("192.168.1.10")).toBe("192.168.1.10");
  });
});
