import { TunnelError } from "../core/errors";
import type { TunnelEvent, VpsTunnelStore } from "../core/types";
import { resolveTestMarker, type ProbeOutcome } from "./probe";

export interface TestResultPublisher {
  updateStore(update: (store: VpsTunnelStore) => VpsTunnelStore): Promise<unknown>;
  transition(event: TunnelEvent, error?: unknown): Promise<unknown>;
  updateBadge(): Promise<void>;
}

export async function publishTestResult(
  outcome: ProbeOutcome,
  deps: TestResultPublisher,
): Promise<void> {
  await deps.updateStore((current) => ({
    ...current,
    testInProgress: resolveTestMarker(current.testInProgress, outcome),
    lastCheck: {
      at: new Date().toISOString(),
      ok: outcome.ok,
      exitIp: outcome.exitIp,
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs,
      directIp: outcome.directIp,
      suspectedDirect: outcome.suspectedDirect,
    },
  }));

  if (outcome.ok) {
    await deps.transition("TEST_DONE");
  } else {
    await deps.transition("FAIL", new TunnelError(outcome.errorCode ?? "E_UNKNOWN"));
  }

  await deps.updateBadge();
}
