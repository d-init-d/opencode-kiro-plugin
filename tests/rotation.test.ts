import { describe, it, expect } from "vitest";
import {
  pickAccount,
  planCooldown,
  timeUntilNextAvailable,
  isEligible,
} from "../src/auth/rotation.js";
import type { AccountStore, KiroAccount } from "../src/auth/account-store.js";
import { classifyKiroError, isRetryable } from "../src/auth/error-classifier.js";

function mkAcc(id: string, partial: Partial<KiroAccount> = {}): KiroAccount {
  return {
    id,
    label: id,
    type: "api-key",
    apiKey: `ksk_${id}_abcdefghij1234567890`,
    enabled: true,
    createdAt: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

function mkStore(strategy: AccountStore["strategy"], accounts: KiroAccount[]): AccountStore {
  return { version: 1, strategy, accounts };
}

describe("classifyKiroError", () => {
  it("identifies 429 as rate_limit", () => {
    expect(classifyKiroError({ status: 429, message: "x" }).kind).toBe("rate_limit");
  });
  it("identifies 401/403 as auth", () => {
    expect(classifyKiroError({ status: 401, message: "x" }).kind).toBe("auth");
    expect(classifyKiroError({ status: 403, message: "x" }).kind).toBe("auth");
  });
  it("identifies 5xx as transient", () => {
    expect(classifyKiroError({ status: 502, message: "bad gateway" }).kind).toBe("transient");
  });
  it("identifies wording 'rate limit' even without status", () => {
    expect(classifyKiroError(new Error("Rate limit hit, slow down")).kind).toBe("rate_limit");
  });
  it("identifies quota exceeded by wording", () => {
    expect(classifyKiroError(new Error("Monthly limit reached")).kind).toBe("quota_exceeded");
  });
  it("auth/client_error are not retryable; rate/transient/quota are", () => {
    expect(isRetryable("auth")).toBe(false);
    expect(isRetryable("client_error")).toBe(false);
    expect(isRetryable("rate_limit")).toBe(true);
    expect(isRetryable("quota_exceeded")).toBe(true);
    expect(isRetryable("transient")).toBe(true);
    expect(isRetryable("unknown")).toBe(true);
  });
});

describe("planCooldown", () => {
  it("rate_limit uses exponential backoff up to 30 minutes", () => {
    const a = planCooldown({ kind: "rate_limit", consecutiveFailures: 1, now: 1000 });
    const b = planCooldown({ kind: "rate_limit", consecutiveFailures: 5, now: 1000 });
    const c = planCooldown({ kind: "rate_limit", consecutiveFailures: 50, now: 1000 });
    expect(a.cooldownUntil - 1000).toBe(60 * 1000);
    expect(b.cooldownUntil - 1000).toBe(60 * 1000 * 16); // 16 minutes
    expect(c.cooldownUntil - 1000).toBe(30 * 60 * 1000); // capped at 30 min
    expect(a.disable).toBe(false);
  });

  it("quota_exceeded uses fixed 15 minutes", () => {
    const p = planCooldown({ kind: "quota_exceeded", consecutiveFailures: 3, now: 0 });
    expect(p.cooldownUntil).toBe(15 * 60 * 1000);
  });

  it("auth marks the account for disable", () => {
    const p = planCooldown({ kind: "auth", consecutiveFailures: 1, now: 0 });
    expect(p.disable).toBe(true);
  });

  it("client_error does not extend cooldown", () => {
    const p = planCooldown({ kind: "client_error", consecutiveFailures: 1, now: 1000 });
    expect(p.cooldownUntil).toBe(1000);
  });
});

describe("isEligible", () => {
  it("respects enabled flag", () => {
    const a = mkAcc("a", { enabled: false });
    expect(isEligible(a, 0)).toBe(false);
  });
  it("respects cooldown", () => {
    const a = mkAcc("a", { runtime: { cooldownUntil: 5000, consecutiveFailures: 1, successCount: 0 } });
    expect(isEligible(a, 1000)).toBe(false);
    expect(isEligible(a, 6000)).toBe(true);
  });
});

describe("pickAccount", () => {
  const a = mkAcc("a");
  const b = mkAcc("b");
  const c = mkAcc("c");

  it("sticky picks the first eligible account", () => {
    const store = mkStore("sticky", [a, b, c]);
    expect(pickAccount(store, { now: 0 })?.id).toBe("a");
  });

  it("sticky skips disabled / cooldown accounts", () => {
    const a2 = mkAcc("a", { enabled: false });
    const b2 = mkAcc("b", { runtime: { cooldownUntil: 1_000_000, consecutiveFailures: 1, successCount: 0 } });
    const store = mkStore("sticky", [a2, b2, c]);
    expect(pickAccount(store, { now: 0 })?.id).toBe("c");
  });

  it("hybrid honors excludeIds for first-account failover", () => {
    const store = mkStore("hybrid", [a, b, c]);
    expect(pickAccount(store, { excludeIds: new Set(["a"]) })?.id).toBe("b");
  });

  it("round-robin prefers the least recently used eligible account", () => {
    const a2 = mkAcc("a", { runtime: { cooldownUntil: 0, lastUsedAt: 100, consecutiveFailures: 0, successCount: 5 } });
    const b2 = mkAcc("b", { runtime: { cooldownUntil: 0, lastUsedAt: 50, consecutiveFailures: 0, successCount: 5 } });
    const c2 = mkAcc("c", { runtime: { cooldownUntil: 0, lastUsedAt: 200, consecutiveFailures: 0, successCount: 5 } });
    const store = mkStore("round-robin", [a2, b2, c2]);
    expect(pickAccount(store, { now: 1000 })?.id).toBe("b");
  });

  it("returns undefined when nothing is eligible", () => {
    const x = mkAcc("x", { runtime: { cooldownUntil: 9_999_999, consecutiveFailures: 1, successCount: 0 } });
    const store = mkStore("sticky", [x]);
    expect(pickAccount(store, { now: 0 })).toBeUndefined();
  });
});

describe("timeUntilNextAvailable", () => {
  it("returns 0 when at least one account is eligible", () => {
    const store = mkStore("sticky", [mkAcc("a")]);
    expect(timeUntilNextAvailable(store, 0)).toBe(0);
  });

  it("returns the smallest remaining cooldown otherwise", () => {
    const a = mkAcc("a", { runtime: { cooldownUntil: 5000, consecutiveFailures: 1, successCount: 0 } });
    const b = mkAcc("b", { runtime: { cooldownUntil: 10000, consecutiveFailures: 1, successCount: 0 } });
    const store = mkStore("sticky", [a, b]);
    expect(timeUntilNextAvailable(store, 1000)).toBe(4000);
  });

  it("returns undefined when there are no enabled accounts at all", () => {
    const a = mkAcc("a", { enabled: false });
    const store = mkStore("sticky", [a]);
    expect(timeUntilNextAvailable(store, 0)).toBeUndefined();
  });
});
