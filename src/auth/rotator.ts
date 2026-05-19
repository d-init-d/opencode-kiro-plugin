/**
 * High-level rotation orchestrator.
 *
 * Wraps `getProvider()` so the OpenAI handler can ask:
 *   "Run this generate/stream call against any eligible Kiro account."
 *
 * Behavior:
 *   1. Pick an eligible account using the configured strategy.
 *   2. Run the operation. On success, mark the account as healthy.
 *   3. On retryable failures, classify the error, update cooldown, and try
 *      the next eligible account. Retry up to the number of eligible accounts.
 *   4. On non-retryable failures (auth, malformed request), surface the
 *      original error so the user gets actionable feedback.
 *
 * Streaming caveat:
 *   For streams we can only retry while we have NOT yielded any byte to the
 *   client. The `streamWithRotation()` helper takes care of buffering the
 *   "first chunk barrier": if the upstream errors before producing the first
 *   stream part, we transparently fail over.
 */
import {
  classifyKiroError,
  isRetryable,
  type ClassifiedError,
} from "./error-classifier.js";
import {
  loadAccountStore,
  publicView,
  saveAccountStore,
  type AccountStore,
  type KiroAccount,
} from "./account-store.js";
import { pickAccount, planCooldown, timeUntilNextAvailable } from "./rotation.js";
import { ensureCliLoginAccount } from "./account-store.js";
import {
  disposeProviderForAccount,
  getProvider,
  type KiroAuthContext,
  type KiroLanguageModel,
} from "../kiro/provider.js";
import type { AiCallOptions } from "../openai/translate.js";
import type { AiStreamPart } from "../openai/stream.js";
import { log } from "../plugin/debug.js";

export interface RotationAttempt {
  accountId: string;
  accountLabel: string;
  error: ClassifiedError;
}

export class AllAccountsExhaustedError extends Error {
  readonly attempts: RotationAttempt[];
  readonly waitMs: number | undefined;
  constructor(attempts: RotationAttempt[], waitMs: number | undefined) {
    const summary = attempts
      .map((a) => `${a.accountLabel}[${a.error.kind}]`)
      .join(", ");
    super(
      waitMs !== undefined && waitMs > 0
        ? `Tất cả tài khoản Kiro đều đang cooldown. Thử lại sau ${Math.ceil(
            waitMs / 1000
          )}s. Chi tiết: ${summary}`
        : `Tất cả tài khoản Kiro đều thất bại: ${summary}`
    );
    this.name = "AllAccountsExhaustedError";
    this.attempts = attempts;
    if (waitMs !== undefined) this.waitMs = waitMs;
  }
}

export class NoAccountsConfiguredError extends Error {
  constructor() {
    super(
      "Chưa có tài khoản Kiro nào được cấu hình. Chạy `opencode auth login` -> Kiro -> chọn API key hoặc CLI login."
    );
    this.name = "NoAccountsConfiguredError";
  }
}

interface AttemptContext {
  modelId: string;
  /** Fallback to bare cli-login when the store is empty (back-compat path). */
  ctxFromAuthHook?: KiroAuthContext;
}

function toAuthContext(account: KiroAccount): KiroAuthContext {
  if (account.type === "api-key") {
    if (!account.apiKey) throw new Error(`Account ${account.id} is api-key but has no key`);
    return { accountId: account.id, mode: "api-key", apiKey: account.apiKey };
  }
  return { accountId: account.id, mode: "cli-login" };
}

async function ensureAccountsAvailable(
  ctxFromAuthHook?: KiroAuthContext
): Promise<AccountStore> {
  let store = await loadAccountStore();
  if (store.accounts.length === 0) {
    // Two recovery paths:
    //   (a) Auth hook gave us a key directly -> mirror it into the store on the fly.
    //       This keeps the legacy single-key flow working for users who haven't
    //       added accounts via the auth setup yet.
    //   (b) Auth hook says cli-login -> create the implicit cli-login account so
    //       rotation always has something to point at.
    if (ctxFromAuthHook?.mode === "api-key" && ctxFromAuthHook.apiKey) {
      const ad = {
        accountId: `legacy_api_${Date.now().toString(36)}`,
        mode: "api-key" as const,
        apiKey: ctxFromAuthHook.apiKey,
      };
      // Don't persist a key we just received from the OpenCode auth UI without
      // explicit user action; instead surface it as a single in-memory account.
      return {
        version: 1,
        strategy: "sticky",
        accounts: [
          {
            id: ad.accountId,
            label: "OpenCode auth (API key)",
            type: "api-key",
            apiKey: ad.apiKey,
            enabled: true,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }
    if (ctxFromAuthHook?.mode === "cli-login") {
      await ensureCliLoginAccount();
      store = await loadAccountStore();
    } else {
      throw new NoAccountsConfiguredError();
    }
  }
  // Always materialize an implicit CLI-login account when one is missing AND
  // the user has the strategy that wants a fallback. We do not auto-add one
  // when the user has explicit api-key accounts only — they may not want it.
  return store;
}

async function recordSuccess(store: AccountStore, account: KiroAccount): Promise<void> {
  account.runtime = {
    cooldownUntil: 0,
    consecutiveFailures: 0,
    successCount: (account.runtime?.successCount ?? 0) + 1,
    lastUsedAt: Date.now(),
  };
  // Save only when account is persisted (legacy in-memory ones have no real id mapping).
  if (account.id.startsWith("legacy_api_")) return;
  try {
    await saveAccountStore(store);
  } catch (err) {
    log.warn("Could not persist account success state", { error: String(err) });
  }
}

async function recordFailure(
  store: AccountStore,
  account: KiroAccount,
  classified: ClassifiedError
): Promise<void> {
  const fails = (account.runtime?.consecutiveFailures ?? 0) + 1;
  const plan = planCooldown({ kind: classified.kind, consecutiveFailures: fails });
  account.runtime = {
    ...(account.runtime ?? { successCount: 0, cooldownUntil: 0, consecutiveFailures: 0 }),
    cooldownUntil: plan.cooldownUntil,
    consecutiveFailures: fails,
    lastErrorKind: classified.kind,
    lastErrorMessage: classified.message,
    lastUsedAt: Date.now(),
  };
  if (plan.disable) account.enabled = false;

  // The credential material may have changed (e.g. expired key); blow the
  // provider handle away so the next pick spawns a clean subprocess.
  try {
    await disposeProviderForAccount(account.id);
  } catch (err) {
    log.warn("Could not dispose provider after failure", { accountId: account.id, error: String(err) });
  }

  if (account.id.startsWith("legacy_api_")) return;
  try {
    await saveAccountStore(store);
  } catch (err) {
    log.warn("Could not persist account failure state", { error: String(err) });
  }
}

async function pickAndAttempt<T>(
  store: AccountStore,
  exhausted: Set<string>,
  modelId: string,
  fn: (model: KiroLanguageModel, account: KiroAccount) => Promise<T>
): Promise<{ result: T; account: KiroAccount } | { failure: ClassifiedError; account: KiroAccount } | undefined> {
  const account = pickAccount(store, { excludeIds: exhausted });
  if (!account) return undefined;
  exhausted.add(account.id);

  let model: KiroLanguageModel;
  try {
    const provider = await getProvider(toAuthContext(account));
    model = await provider.getModel(modelId);
  } catch (err) {
    const classified = classifyKiroError(err);
    log.warn("Provider/model bootstrap failed for account", {
      accountId: account.id,
      kind: classified.kind,
      error: classified.message,
    });
    await recordFailure(store, account, classified);
    return { failure: classified, account };
  }

  try {
    const result = await fn(model, account);
    await recordSuccess(store, account);
    return { result, account };
  } catch (err) {
    const classified = classifyKiroError(err);
    log.warn("Kiro call failed", {
      accountId: account.id,
      kind: classified.kind,
      error: classified.message,
    });
    await recordFailure(store, account, classified);
    return { failure: classified, account };
  }
}

export interface GenerateRotationOptions {
  modelId: string;
  callOptions: AiCallOptions;
  ctxFromAuthHook?: KiroAuthContext;
}

export async function generateWithRotation(
  options: GenerateRotationOptions
): Promise<{ accountId: string; result: Awaited<ReturnType<KiroLanguageModel["doGenerate"]>> }> {
  const store = await ensureAccountsAvailable(options.ctxFromAuthHook);
  const attempts: RotationAttempt[] = [];
  const exhausted = new Set<string>();
  // Hard upper bound to avoid runaway loops if the store grows mid-flight.
  const maxAttempts = Math.max(store.accounts.length, 1);
  for (let i = 0; i < maxAttempts; i++) {
    const outcome = await pickAndAttempt(store, exhausted, options.modelId, (m) =>
      m.doGenerate(options.callOptions)
    );
    if (!outcome) break;
    if ("result" in outcome) {
      return { accountId: outcome.account.id, result: outcome.result };
    }
    attempts.push({
      accountId: outcome.account.id,
      accountLabel: publicView(outcome.account).label,
      error: outcome.failure,
    });
    if (!isRetryable(outcome.failure.kind)) {
      throw new Error(outcome.failure.message);
    }
  }
  throw new AllAccountsExhaustedError(attempts, timeUntilNextAvailable(store));
}

export interface StreamRotationOptions {
  modelId: string;
  callOptions: AiCallOptions;
  ctxFromAuthHook?: KiroAuthContext;
}

/**
 * Drive a streaming call with first-chunk failover. Once the first chunk
 * has been observed we stop attempting failover for the rest of the stream
 * (we've already started writing to the client and cannot rewrite history).
 */
export async function streamWithRotation(options: StreamRotationOptions): Promise<{
  accountId: string;
  stream: AsyncIterable<AiStreamPart>;
}> {
  const store = await ensureAccountsAvailable(options.ctxFromAuthHook);
  const attempts: RotationAttempt[] = [];
  const exhausted = new Set<string>();
  const maxAttempts = Math.max(store.accounts.length, 1);

  for (let i = 0; i < maxAttempts; i++) {
    const account = pickAccount(store, { excludeIds: exhausted });
    if (!account) break;
    exhausted.add(account.id);

    let upstream: AsyncIterable<AiStreamPart>;
    try {
      const provider = await getProvider(toAuthContext(account));
      const model = await provider.getModel(options.modelId);
      const result = await model.doStream(options.callOptions);
      upstream = result.stream;
    } catch (err) {
      const classified = classifyKiroError(err);
      attempts.push({
        accountId: account.id,
        accountLabel: publicView(account).label,
        error: classified,
      });
      await recordFailure(store, account, classified);
      if (!isRetryable(classified.kind)) {
        throw new Error(classified.message);
      }
      continue;
    }

    // Probe the first chunk before declaring success. If the first chunk
    // is an error part (or the iterator throws synchronously), fail over.
    const iterator = upstream[Symbol.asyncIterator]();
    let firstResult: IteratorResult<AiStreamPart>;
    try {
      firstResult = await iterator.next();
    } catch (err) {
      const classified = classifyKiroError(err);
      attempts.push({
        accountId: account.id,
        accountLabel: publicView(account).label,
        error: classified,
      });
      await recordFailure(store, account, classified);
      if (!isRetryable(classified.kind)) throw new Error(classified.message);
      continue;
    }

    const firstPart = firstResult.value;
    if (!firstResult.done && firstPart && firstPart.type === "error" && firstPart.error) {
      const classified = classifyKiroError(firstPart.error);
      attempts.push({
        accountId: account.id,
        accountLabel: publicView(account).label,
        error: classified,
      });
      await recordFailure(store, account, classified);
      if (!isRetryable(classified.kind)) throw new Error(classified.message);
      continue;
    }

    // Reassemble the stream: yield the probed first part, then drain.
    const replayed: AsyncIterable<AiStreamPart> = {
      [Symbol.asyncIterator]() {
        let returnedFirst = false;
        let done = firstResult.done === true;
        return {
          async next(): Promise<IteratorResult<AiStreamPart>> {
            if (!returnedFirst) {
              returnedFirst = true;
              if (firstResult.done) {
                return { value: undefined as unknown as AiStreamPart, done: true };
              }
              return { value: firstResult.value, done: false };
            }
            if (done) return { value: undefined as unknown as AiStreamPart, done: true };
            const next = await iterator.next();
            if (next.done) done = true;
            return next;
          },
          async return(value): Promise<IteratorResult<AiStreamPart>> {
            done = true;
            if (typeof iterator.return === "function") {
              try {
                await iterator.return(value);
              } catch {
                // ignore
              }
            }
            return { value: undefined as unknown as AiStreamPart, done: true };
          },
        };
      },
    };

    // Wrap recording success at end-of-stream.
    const observed: AsyncIterable<AiStreamPart> = {
      async *[Symbol.asyncIterator]() {
        let sawError = false;
        try {
          for await (const part of replayed) {
            if (part && part.type === "error") sawError = true;
            yield part;
          }
        } finally {
          if (!sawError) await recordSuccess(store, account);
        }
      },
    };

    return { accountId: account.id, stream: observed };
  }
  throw new AllAccountsExhaustedError(attempts, timeUntilNextAvailable(store));
}
