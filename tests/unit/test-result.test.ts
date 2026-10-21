import { describe, expect, it } from "vitest";
import type { ProbeOutcome } from "../../extension/src/background/probe";
import { createDefaultStore } from "../../extension/src/background/state";
import {
  publishTestResult,
  type TestResultPublisher,
} from "../../extension/src/background/test-result";
import { TunnelError } from "../../extension/src/core/errors";
import type { TestInProgress, TunnelEvent, VpsTunnelStore } from "../../extension/src/core/types";

const marker: TestInProgress = { at: 1, snapshot: { mode: "system" } };

function outcome(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    ok: true,
    exitIp: "203.0.113.10",
    durationMs: 120,
    directIp: "198.51.100.5",
    suspectedDirect: false,
    errorCode: null,
    recoveryRequired: false,
    ...overrides,
  };
}

function harness(initialMarker: TestInProgress | null): {
  deps: TestResultPublisher;
  store: () => VpsTunnelStore;
  events: Array<{ event: TunnelEvent; code: string | null }>;
  badgeCalls: () => number;
} {
  let store: VpsTunnelStore = { ...createDefaultStore(), testInProgress: initialMarker };
  const events: Array<{ event: TunnelEvent; code: string | null }> = [];
  let badgeCalls = 0;

  return {
    deps: {
      async updateStore(update) {
        store = update(store);
        return store;
      },
      async transition(event, error) {
        events.push({ event, code: error instanceof TunnelError ? error.code : null });
        return {};
      },
      async updateBadge() {
        badgeCalls += 1;
      },
    },
    store: () => store,
    events,
    badgeCalls: () => badgeCalls,
  };
}

describe("publishTestResult", () => {
  it("clears the probe marker and reports TEST_DONE after a successful probe", async () => {
    const { deps, store, events, badgeCalls } = harness(marker);

    await publishTestResult(outcome(), deps);

    expect(store().testInProgress).toBeNull();
    expect(store().lastCheck).toMatchObject({
      ok: true,
      exitIp: "203.0.113.10",
      errorCode: null,
      durationMs: 120,
      directIp: "198.51.100.5",
      suspectedDirect: false,
    });
    expect(events).toEqual([{ event: "TEST_DONE", code: null }]);
    expect(badgeCalls()).toBe(1);
  });

  it("preserves the recovery marker and reports FAIL when restore failed", async () => {
    const { deps, store, events, badgeCalls } = harness(marker);

    await publishTestResult(
      outcome({ ok: false, exitIp: null, errorCode: "E_PROXY_UNREACHABLE", recoveryRequired: true }),
      deps,
    );

    expect(store().testInProgress).toBe(marker);
    expect(store().lastCheck).toMatchObject({
      ok: false,
      errorCode: "E_PROXY_UNREACHABLE",
    });
    expect(events).toEqual([{ event: "FAIL", code: "E_PROXY_UNREACHABLE" }]);
    expect(badgeCalls()).toBe(1);
  });

  it("clears the marker and reports FAIL when restore succeeded", async () => {
    const { deps, store, events } = harness(marker);

    await publishTestResult(
      outcome({ ok: false, errorCode: "E_TIMEOUT", recoveryRequired: false }),
      deps,
    );

    expect(store().testInProgress).toBeNull();
    expect(events).toEqual([{ event: "FAIL", code: "E_TIMEOUT" }]);
  });
});
