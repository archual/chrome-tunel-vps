import { describe, expect, it } from "vitest";
import { mapProxyErrorText, RuntimeErrorSignal } from "../../extension/src/background/error-signal";

describe("mapProxyErrorText", () => {
  it.each([
    ["net::ERR_PROXY_CERTIFICATE_INVALID", "E_PROXY_TLS"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "E_PROXY_TLS"],
    ["net::ERR_PROXY_AUTH_UNSUPPORTED", "E_UNSUPPORTED_AUTH"],
    ["net::ERR_PROXY_AUTH_REQUESTED", "E_AUTH_407"],
    ["net::ERR_PROXY_CONNECTION_FAILED", "E_PROXY_UNREACHABLE"],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", "E_PROXY_UNREACHABLE"],
    ["net::ERR_INTERNET_DISCONNECTED", "E_NO_NETWORK"],
    ["net::ERR_TIMED_OUT", "E_TIMEOUT"],
    ["net::ERR_FAILED", null],
  ])("maps %s to %s", (error, expected) => {
    expect(mapProxyErrorText(error)).toBe(expected);
  });
});

describe("RuntimeErrorSignal", () => {
  it("returns a fresh signal and expires it after the TTL", () => {
    let now = 1_000;
    const signal = new RuntimeErrorSignal(() => now, 5_000);

    signal.set("proxy", "E_PROXY_TLS");
    expect(signal.get("proxy")).toBe("E_PROXY_TLS");
    expect(signal.get("auth")).toBeNull();

    now += 5_001;
    expect(signal.get("proxy")).toBeNull();
  });

  it("consumer priority is decided by the caller, not the store", () => {
    const signal = new RuntimeErrorSignal();

    signal.set("proxy", "E_PROXY_TLS");
    signal.set("auth", "E_AUTH_407");

    expect(signal.get("auth") ?? signal.get("proxy")).toBe("E_AUTH_407");
    signal.clear();
    expect(signal.get("auth")).toBeNull();
    expect(signal.get("proxy")).toBeNull();
  });
});
