/**
 * Account rotation policy.
 *
 * Picks the next eligible account out of the persistent store, taking the
 * configured strategy and per-account cooldown windows into account.
 *
 * Strategies:
 *   - sticky:      always return the first eligible account (stable order).
 *                  Best when prompt caching matters and quotas are generous.
 *   - round-robin: pick the eligible account that was used least recently.
 *                  Best for spreading load evenly.
 *   - hybrid:      sticky with auto-failover. Same as `sticky` until the
 *                  current account hits a cooldown / failure, then advances
 *                  to the next eligible one for as long as needed.
 *
 * Cooldown values (ms):
 *   - rate_limit     : 60s base, doubles up to 30 minutes per consecutive failure
 *   - quota_exceeded : 15 minutes (longer because it usually clears slower)
 *   - transient      : 10s base, doubles up to 5 minutes
 *   - auth           : marked disabled (require user to re-auth) — long cooldown
 *   - client_error   : do not extend cooldown, error is request-side
 *   - unknown        : 30s short cooldown to avoid hammering
 */
import type { KiroErrorKind } from "./error-classifier.js";
import type { AccountStore, AccountStrategy, KiroAccount } from "./account-store.js";

export interface PickContext {
  /** Account ids to skip even if eligible (already failed in this request). */
  excludeIds?: ReadonlySet<string>;
  /** Override now() for tests. */
  now?: number;
}

export function isEligible(account: KiroAccount, now: number): boolean {
  if (!account.enabled) return false;
  const cooldownUntil = account.runtime?.cooldownUntil ?? 0;
  return cooldownUntil <= now;
}

export function pickAccount(
  store: AccountStore,
  ctx: PickContext = {}
): KiroAccount | undefined {
  const now = ctx.now ?? Date.now();
  const exclude = ctx.excludeIds ?? new Set<string>();
  const eligible = store.accounts.filter(
    (a) => !exclude.has(a.id) && isEligible(a, now)
  );
  if (eligible.length === 0) return undefined;

  switch (store.strategy) {
    case "sticky":
      return eligible[0];
    case "round-robin": {
      // Least-recently-used wins; cli-login accounts win ties because they
      // do not consume API key budgets.
      const sorted = [...eligible].sort((a, b) => {
        const al = a.runtime?.lastUsedAt ?? 0;
        const bl = b.runtime?.lastUsedAt ?? 0;
        if (al !== bl) return al - bl;
        if (a.type !== b.type) return a.type === "cli-login" ? -1 : 1;
        return 0;
      });
      return sorted[0];
    }
    case "hybrid":
    default:
      // Hybrid: prefer the original first eligible (stickiness) — the
      // exclude set already accounts for "current account just failed".
      return eligible[0];
  }
}

export interface CooldownPlan {
  cooldownUntil: number;
  /** Whether the account should be auto-disabled (auth errors). */
  disable: boolean;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const SECOND = 1000;

export function planCooldown(args: {
  kind: KiroErrorKind;
  consecutiveFailures: number;
  now?: number;
}): CooldownPlan {
  const now = args.now ?? Date.now();
  const fails = Math.max(args.consecutiveFailures, 1);
  switch (args.kind) {
    case "rate_limit": {
      const ms = Math.min(60 * SECOND * 2 ** (fails - 1), 30 * MINUTE);
      return { cooldownUntil: now + ms, disable: false };
    }
    case "quota_exceeded":
      return { cooldownUntil: now + 15 * MINUTE, disable: false };
    case "transient": {
      const ms = Math.min(10 * SECOND * 2 ** (fails - 1), 5 * MINUTE);
      return { cooldownUntil: now + ms, disable: false };
    }
    case "auth":
      // Disable account so the user is forced to re-auth before it rotates back in.
      return { cooldownUntil: now + 24 * HOUR, disable: true };
    case "client_error":
      // Request was malformed; do not penalize the account.
      return { cooldownUntil: now, disable: false };
    case "unknown":
    default:
      return { cooldownUntil: now + 30 * SECOND, disable: false };
  }
}

/**
 * Returns the time, in milliseconds, until at least one account becomes
 * eligible again. Used to surface helpful "wait N seconds" diagnostics when
 * every account is on cooldown.
 */
export function timeUntilNextAvailable(store: AccountStore, now = Date.now()): number | undefined {
  let best: number | undefined;
  for (const a of store.accounts) {
    if (!a.enabled) continue;
    const cd = a.runtime?.cooldownUntil ?? 0;
    if (cd <= now) return 0;
    if (best === undefined || cd < best) best = cd;
  }
  return best === undefined ? undefined : best - now;
}
