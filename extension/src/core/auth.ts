import { normalizeHost } from "./proxy-config";
import type { ErrorCode } from "./types";

export const AUTH_MAX_ATTEMPTS = 2;
export const AUTH_ATTEMPT_TTL_MS = 5 * 60_000;
export const AUTH_ATTEMPT_MAX_ENTRIES = 1024;

export interface ProxyChallengeDetails {
  isProxy?: boolean | undefined;
  requestId: string;
  scheme?: string | undefined;
  challenger?: { host: string; port: number } | null | undefined;
}

export interface ExpectedAuthEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
}

export type AuthDecision =
  | { type: "ignore"; error?: ErrorCode }
  | { type: "cancel"; error?: ErrorCode }
  | { type: "credentials"; credentials: { username: string; password: string } };

export interface AuthGuardContext {
  expected: ExpectedAuthEndpoint | null;
  active: boolean;
  tracker: AuthAttemptTracker;
}

interface AttemptEntry {
  count: number;
  at: number;
}

export class AuthAttemptTracker {
  private readonly attempts = new Map<string, AttemptEntry>();

  constructor(
    private readonly ttlMs: number = AUTH_ATTEMPT_TTL_MS,
    private readonly maxEntries: number = AUTH_ATTEMPT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  next(requestId: string): number {
    this.prune();
    const previous = this.attempts.get(requestId);
    const count = (previous?.count ?? 0) + 1;
    this.attempts.set(requestId, { count, at: this.now() });

    while (this.attempts.size > this.maxEntries) {
      const oldest = this.attempts.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.attempts.delete(oldest.value);
    }

    return count;
  }

  count(requestId: string): number {
    this.prune();
    return this.attempts.get(requestId)?.count ?? 0;
  }

  release(requestId: string): void {
    this.attempts.delete(requestId);
  }

  clear(): void {
    this.attempts.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [requestId, entry] of this.attempts) {
      if (entry.at < cutoff) {
        this.attempts.delete(requestId);
      }
    }
  }
}

export function sameAuthEndpoint(
  challenger: { host: string; port: number },
  expected: ExpectedAuthEndpoint,
): boolean {
  if (normalizeHost(challenger.host) !== normalizeHost(expected.host)) {
    return false;
  }
  return Number(challenger.port) === Number(expected.port);
}

export function evaluateAuthChallenge(
  details: ProxyChallengeDetails,
  context: AuthGuardContext,
): AuthDecision {
  if (details.isProxy !== true) {
    return { type: "ignore" };
  }

  const { expected } = context;
  if (!context.active || expected === null) {
    return { type: "ignore" };
  }

  if (expected.username.length === 0 || expected.password.length === 0) {
    return { type: "ignore" };
  }

  if (details.challenger === null || details.challenger === undefined) {
    return { type: "ignore" };
  }

  if (!sameAuthEndpoint(details.challenger, expected)) {
    return { type: "ignore" };
  }

  if ((details.scheme ?? "").toLowerCase() !== "basic") {
    return { type: "ignore", error: "E_UNSUPPORTED_AUTH" };
  }

  const attempt = context.tracker.next(details.requestId);
  if (attempt > AUTH_MAX_ATTEMPTS) {
    return { type: "cancel", error: "E_AUTH_407" };
  }

  return {
    type: "credentials",
    credentials: { username: expected.username, password: expected.password },
  };
}
