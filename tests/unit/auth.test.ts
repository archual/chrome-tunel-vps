import { describe, expect, it } from "vitest";
import {
  AUTH_ATTEMPT_TTL_MS,
  AUTH_MAX_ATTEMPTS,
  AuthAttemptTracker,
  evaluateAuthChallenge,
  sameAuthEndpoint,
  type ExpectedAuthEndpoint,
  type ProxyChallengeDetails,
} from "../../extension/src/core/auth";

const expected: ExpectedAuthEndpoint = {
  host: "proxy.k1812.ru",
  port: 443,
  username: "owner",
  password: "secret",
};

const basicChallenge: ProxyChallengeDetails = {
  isProxy: true,
  requestId: "request-1",
  scheme: "Basic",
  challenger: { host: "proxy.k1812.ru", port: 443 },
};

function context(overrides: { active?: boolean; expected?: ExpectedAuthEndpoint | null; tracker?: AuthAttemptTracker } = {}) {
  return {
    expected: overrides.expected === undefined ? expected : overrides.expected,
    active: overrides.active ?? true,
    tracker: overrides.tracker ?? new AuthAttemptTracker(),
  };
}

describe("sameAuthEndpoint", () => {
  it("compares host case-insensitively, ignoring brackets and a trailing dot", () => {
    expect(sameAuthEndpoint({ host: "PROXY.K1812.RU.", port: 443 }, expected)).toBe(true);
    expect(sameAuthEndpoint({ host: "[proxy.k1812.ru]", port: 443 }, expected)).toBe(true);
  });

  it("compares ports as numbers", () => {
    expect(sameAuthEndpoint({ host: "proxy.k1812.ru", port: Number("443") }, expected)).toBe(true);
    expect(sameAuthEndpoint({ host: "proxy.k1812.ru", port: 444 }, expected)).toBe(false);
  });

  it("rejects a challenger without a host instead of throwing", () => {
    expect(
      sameAuthEndpoint({ host: undefined, port: 443 } as unknown as { host: string; port: number }, expected),
    ).toBe(false);
  });
});

describe("evaluateAuthChallenge", () => {
  it("ignores origin (non-proxy) challenges without spending attempts", () => {
    const tracker = new AuthAttemptTracker();
    const decision = evaluateAuthChallenge({ ...basicChallenge, isProxy: false }, context({ tracker }));

    expect(decision).toEqual({ type: "ignore" });
    expect(tracker.count("request-1")).toBe(0);
  });

  it("ignores challenges when the tunnel is inactive", () => {
    expect(evaluateAuthChallenge(basicChallenge, context({ active: false }))).toEqual({ type: "ignore" });
  });

  it("ignores a foreign proxy challenger (host or port mismatch)", () => {
    expect(
      evaluateAuthChallenge(
        { ...basicChallenge, challenger: { host: "other.example", port: 443 } },
        context(),
      ),
    ).toEqual({ type: "ignore" });
    expect(
      evaluateAuthChallenge(
        { ...basicChallenge, challenger: { host: "proxy.k1812.ru", port: 3128 } },
        context(),
      ),
    ).toEqual({ type: "ignore" });
  });

  it("ignores challenges with no configured credentials", () => {
    expect(evaluateAuthChallenge(basicChallenge, context({ expected: null }))).toEqual({ type: "ignore" });
    expect(
      evaluateAuthChallenge(basicChallenge, context({ expected: { ...expected, password: "" } })),
    ).toEqual({ type: "ignore" });
  });

  it("does not substitute credentials for non-Basic auth schemes", () => {
    const decision = evaluateAuthChallenge({ ...basicChallenge, scheme: "Digest" }, context());

    expect(decision).toEqual({ type: "ignore", error: "E_UNSUPPORTED_AUTH" });
  });

  it("supplies Basic credentials for the configured proxy", () => {
    const decision = evaluateAuthChallenge(basicChallenge, context());

    expect(decision).toEqual({
      type: "credentials",
      credentials: { username: "owner", password: "secret" },
    });
  });

  it("allows exactly two substitutions and then cancels with E_AUTH_407", () => {
    const tracker = new AuthAttemptTracker();
    const ctx = context({ tracker });

    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge(basicChallenge, ctx)).toEqual({ type: "cancel", error: "E_AUTH_407" });
    expect(evaluateAuthChallenge(basicChallenge, ctx)).toEqual({ type: "cancel", error: "E_AUTH_407" });
    expect(tracker.count("request-1")).toBeGreaterThan(AUTH_MAX_ATTEMPTS);
  });

  it("counts attempts per requestId, not globally", () => {
    const tracker = new AuthAttemptTracker();
    const ctx = context({ tracker });

    expect(evaluateAuthChallenge({ ...basicChallenge, requestId: "a" }, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge({ ...basicChallenge, requestId: "a" }, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge({ ...basicChallenge, requestId: "b" }, ctx).type).toBe("credentials");
  });
});

describe("AuthAttemptTracker", () => {
  it("expires counters after the TTL", () => {
    let now = 1_000;
    const tracker = new AuthAttemptTracker(AUTH_ATTEMPT_TTL_MS, 10, () => now);
    const ctx = context({ tracker });

    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("cancel");

    now += AUTH_ATTEMPT_TTL_MS + 1;

    expect(tracker.count("request-1")).toBe(0);
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
  });

  it("releases counters when a request finishes", () => {
    const tracker = new AuthAttemptTracker();
    const ctx = context({ tracker });

    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
    tracker.release("request-1");
    expect(evaluateAuthChallenge(basicChallenge, ctx).type).toBe("credentials");
  });

  it("bounds the number of stored request ids", () => {
    const tracker = new AuthAttemptTracker(AUTH_ATTEMPT_TTL_MS, 3);

    for (let index = 0; index < 10; index += 1) {
      tracker.next(`request-${index}`);
    }

    expect(tracker.count("request-0")).toBe(0);
    expect(tracker.count("request-9")).toBe(1);
  });
});
