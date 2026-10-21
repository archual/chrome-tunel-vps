import { describe, expect, it } from "vitest";
import {
  defaultPort,
  validateHost,
  validatePassword,
  validatePort,
  validateSettingsDraft,
  validateUsername,
} from "../../extension/src/shared/validation";

describe("host validation", () => {
  it("accepts DNS names, IPv4 and IPv6 literals", () => {
    expect(validateHost("proxy.k1812.ru")).toEqual({ ok: true, value: "proxy.k1812.ru" });
    expect(validateHost("203.0.113.10")).toEqual({ ok: true, value: "203.0.113.10" });
    expect(validateHost("2001:db8::1")).toEqual({ ok: true, value: "2001:db8::1" });
    expect(validateHost("[2001:DB8::1]")).toEqual({ ok: true, value: "2001:db8::1" });
  });

  it("normalizes case and IDN names without network access", () => {
    expect(validateHost("PROXY.Example.COM")).toEqual({ ok: true, value: "proxy.example.com" });
    expect(validateHost("пример.рф")).toEqual({ ok: true, value: "xn--e1afmkfd.xn--p1ai" });
    expect(validateHost("  proxy.example.com  ")).toEqual({ ok: true, value: "proxy.example.com" });
  });

  it.each([
    "",
    "   ",
    "https://proxy.example.com",
    "proxy.example.com/path",
    "user@proxy.example.com",
    "proxy example.com",
    "localhost",
    "-bad.example.com",
    "bad-.example.com",
    "bad..example.com",
    "proxy.example.com.",
    "999.1.1.1",
    "2001:db8::zz",
  ])("rejects %j", (input) => {
    expect(validateHost(input)).toEqual({ ok: false, field: "host" });
  });
});

describe("port validation", () => {
  it("uses the protocol default for an empty value", () => {
    expect(validatePort("", "https")).toEqual({ ok: true, value: 443 });
    expect(validatePort(" ", "http")).toEqual({ ok: true, value: 80 });
    expect(defaultPort("https")).toBe(443);
    expect(defaultPort("http")).toBe(80);
  });

  it("accepts the full valid range", () => {
    expect(validatePort("1", "https")).toEqual({ ok: true, value: 1 });
    expect(validatePort("65535", "https")).toEqual({ ok: true, value: 65535 });
    expect(validatePort(" 8443 ", "https")).toEqual({ ok: true, value: 8443 });
  });

  it.each(["0", "65536", "-1", "44a", "1.5", "1 443"])("rejects %j", (input) => {
    expect(validatePort(input, "https")).toEqual({ ok: false, field: "port" });
  });
});

describe("credential validation", () => {
  it("trims usernames but not passwords", () => {
    expect(validateUsername("  owner  ")).toEqual({ ok: true, value: "owner" });
    expect(validatePassword(" pass ")).toEqual({ ok: true, value: " pass " });
  });

  it("enforces length limits", () => {
    expect(validateUsername("a".repeat(64))).toEqual({ ok: true, value: "a".repeat(64) });
    expect(validateUsername("a".repeat(65))).toEqual({ ok: false, field: "username" });
    expect(validateUsername("")).toEqual({ ok: false, field: "username" });
    expect(validatePassword("a".repeat(256))).toEqual({ ok: true, value: "a".repeat(256) });
    expect(validatePassword("a".repeat(257))).toEqual({ ok: false, field: "password" });
    expect(validatePassword("")).toEqual({ ok: false, field: "password" });
  });
});

describe("settings draft validation", () => {
  const base = {
    scheme: "https" as const,
    host: " Proxy.Example.com ",
    port: "443",
    username: " owner ",
    password: "secret",
  };

  it("returns normalized settings", () => {
    expect(validateSettingsDraft(base, { passwordRequired: true })).toEqual({
      ok: true,
      value: {
        scheme: "https",
        host: "proxy.example.com",
        port: 443,
        username: "owner",
        password: "secret",
      },
    });
  });

  it("reports every invalid field inline", () => {
    const result = validateSettingsDraft(
      { scheme: "https", host: "", port: "0", username: "", password: "" },
      { passwordRequired: true },
    );
    expect(result).toEqual({
      ok: false,
      errors: { host: true, port: true, username: true, password: true },
    });
  });

  it("allows an empty password when a password is already saved", () => {
    const result = validateSettingsDraft({ ...base, password: "" }, { passwordRequired: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.password).toBe("");
    }
  });
});
