/**
 * Lifecycle wrapper around `kiro-acp-ai-provider` with per-account isolation.
 *
 * Responsibilities:
 *   1. Lazy-import `createKiroAcp()` so the plugin still loads when the
 *      package is missing (we surface a helpful error instead of crashing).
 *   2. Inject `KIRO_API_KEY` into the subprocess environment when the active
 *      account is API-key based. The key is never written elsewhere.
 *   3. Provide a thin `generate()` and `stream()` interface that the OpenAI
 *      adapter calls into. The interface is intentionally narrow so we can
 *      mock it in tests.
 *   4. Cache one provider handle per accountId so switching accounts is fast
 *      and doesn't tear down a working subprocess we still need.
 */
import { KIRO_API_KEY_ENV, KIRO_IDLE_SHUTDOWN_MS } from "../constants.js";
import { log } from "../plugin/debug.js";
import type { AiCallOptions, AiContent, AiFinishReason, AiUsage } from "../openai/translate.js";
import type { AiStreamPart } from "../openai/stream.js";

export type AuthMode = "api-key" | "cli-login";

export interface KiroAuthContext {
  /**
   * Identifier of the account we want to bind this request to.
   * For backwards compatibility, when the rotation layer is not used,
   * a synthetic id `"_legacy_${mode}"` is fine.
   */
  accountId: string;
  mode: AuthMode;
  /** Only present when mode === 'api-key'. Never logged. */
  apiKey?: string;
}

export interface KiroGenerateResult {
  content: AiContent[];
  finishReason: AiFinishReason | string | undefined;
  usage?: AiUsage;
}

export interface KiroLanguageModel {
  doGenerate(options: AiCallOptions): Promise<KiroGenerateResult>;
  doStream(options: AiCallOptions): Promise<{ stream: AsyncIterable<AiStreamPart> }>;
}

export interface KiroProviderHandle {
  getModel(modelId: string): Promise<KiroLanguageModel>;
  shutdown(): Promise<void>;
}

interface ProviderModule {
  createKiroAcp?: (config?: Record<string, unknown>) => unknown;
  default?: unknown;
}

interface CachedHandle {
  handle: KiroProviderHandle;
  authMode: AuthMode;
  /** The API key in use when this handle was created (api-key mode only). */
  apiKey?: string;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
}

/** key = accountId */
const handleCache = new Map<string, CachedHandle>();
/** Used by the API-key path to avoid mutating env if we're already pointed at the right key. */
let currentEnvKey: string | undefined = process.env[KIRO_API_KEY_ENV];

function clearIdleTimer(cached: CachedHandle): void {
  if (cached.idleTimer) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
  }
}

function armIdleTimer(accountId: string, cached: CachedHandle): void {
  clearIdleTimer(cached);
  cached.idleTimer = setTimeout(() => {
    log.info("Shutting down idle Kiro provider", { accountId });
    void disposeAccount(accountId, "idle");
  }, KIRO_IDLE_SHUTDOWN_MS);
  if (typeof cached.idleTimer.unref === "function") cached.idleTimer.unref();
}

async function disposeAccount(accountId: string, reason: string): Promise<void> {
  const cached = handleCache.get(accountId);
  if (!cached) return;
  handleCache.delete(accountId);
  clearIdleTimer(cached);
  try {
    await cached.handle.shutdown();
  } catch (err) {
    log.warn("Kiro provider shutdown failed", { reason, accountId, error: String(err) });
  }
}

/**
 * Tear down all cached handles. Used on plugin shutdown.
 */
export async function resetProvider(reason: string): Promise<void> {
  const ids = Array.from(handleCache.keys());
  for (const id of ids) await disposeAccount(id, reason);
}

/**
 * Synchronously set the env var for the next subprocess spawn. Subsequent
 * spawns inherit this env until we set it again.
 */
function setEnvForApiKey(apiKey: string): void {
  if (currentEnvKey !== apiKey) {
    process.env[KIRO_API_KEY_ENV] = apiKey;
    currentEnvKey = apiKey;
  }
}

/**
 * For cli-login mode we need to make sure no stale `KIRO_API_KEY` is leaking
 * into the subprocess env.
 */
function clearEnvForCliLogin(): void {
  if (process.env[KIRO_API_KEY_ENV]) {
    delete process.env[KIRO_API_KEY_ENV];
    currentEnvKey = undefined;
  }
}

async function loadProviderModule(): Promise<ProviderModule> {
  try {
    return (await import("kiro-acp-ai-provider")) as ProviderModule;
  } catch (err) {
    log.error("Could not import kiro-acp-ai-provider. Run: npm i kiro-acp-ai-provider", {
      error: String(err),
    });
    throw new Error("kiro-acp-ai-provider not installed. Run: npm i kiro-acp-ai-provider");
  }
}

function adaptHandle(rawProvider: unknown): KiroProviderHandle {
  let resolveModel: (id: string) => unknown;
  let provider: { shutdown?: () => Promise<void> | void } = {};

  if (typeof rawProvider === "function") {
    const fn = rawProvider as (id: string) => unknown;
    resolveModel = (id) => fn(id);
  } else if (rawProvider && typeof rawProvider === "object") {
    const obj = rawProvider as Record<string, unknown>;
    provider = obj as typeof provider;
    if (typeof obj["languageModel"] === "function") {
      const fn = obj["languageModel"] as (id: string) => unknown;
      resolveModel = (id) => fn.call(obj, id);
    } else if (typeof obj["chat"] === "function") {
      const fn = obj["chat"] as (id: string) => unknown;
      resolveModel = (id) => fn.call(obj, id);
    } else if (typeof obj["model"] === "function") {
      const fn = obj["model"] as (id: string) => unknown;
      resolveModel = (id) => fn.call(obj, id);
    } else {
      throw new Error("kiro-acp-ai-provider returned an object without a model factory");
    }
  } else {
    throw new Error("kiro-acp-ai-provider returned an unrecognized result");
  }

  return {
    async getModel(modelId: string): Promise<KiroLanguageModel> {
      const raw = resolveModel(modelId);
      const model = (await Promise.resolve(raw)) as Record<string, unknown> | null;
      if (!model || typeof model !== "object") {
        throw new Error(`Could not get language model '${modelId}' from kiro-acp-ai-provider`);
      }
      const doGenerate = model["doGenerate"];
      const doStream = model["doStream"];
      if (typeof doGenerate !== "function" && typeof doStream !== "function") {
        throw new Error(
          `Model '${modelId}' has no doGenerate/doStream. The kiro-acp-ai-provider version may be incompatible.`
        );
      }
      return {
        async doGenerate(options) {
          if (typeof doGenerate !== "function") {
            throw new Error("Model does not support doGenerate");
          }
          const result = (await (doGenerate as (o: unknown) => Promise<unknown>).call(model, options)) as {
            content?: AiContent[];
            text?: string;
            finishReason?: AiFinishReason | string;
            usage?: AiUsage;
          };
          let content = result.content;
          if (!content && typeof result.text === "string") {
            content = [{ type: "text", text: result.text }];
          }
          return {
            content: content ?? [],
            finishReason: result.finishReason,
            usage: result.usage,
          };
        },
        async doStream(options) {
          if (typeof doStream !== "function") {
            throw new Error("Model does not support doStream");
          }
          const result = (await (doStream as (o: unknown) => Promise<unknown>).call(model, options)) as {
            stream?: AsyncIterable<AiStreamPart> | ReadableStream<AiStreamPart>;
          };
          if (!result || !result.stream) {
            throw new Error("doStream() did not return a stream");
          }
          const stream = await toAsyncIterable<AiStreamPart>(result.stream);
          return { stream };
        },
      };
    },
    async shutdown() {
      if (provider && typeof provider.shutdown === "function") {
        await Promise.resolve(provider.shutdown());
      }
    },
  };
}

async function toAsyncIterable<T>(
  source: AsyncIterable<T> | ReadableStream<T>
): Promise<AsyncIterable<T>> {
  if (Symbol.asyncIterator in (source as object)) {
    return source as AsyncIterable<T>;
  }
  const reader = (source as ReadableStream<T>).getReader();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          yield value as T;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
  };
}

export async function getProvider(auth: KiroAuthContext): Promise<KiroProviderHandle> {
  const cached = handleCache.get(auth.accountId);
  // Reuse cache only when the credential material is unchanged.
  if (cached && cached.authMode === auth.mode && cached.apiKey === auth.apiKey) {
    if (auth.mode === "api-key" && auth.apiKey) setEnvForApiKey(auth.apiKey);
    else if (auth.mode === "cli-login") clearEnvForCliLogin();
    cached.lastUsedAt = Date.now();
    armIdleTimer(auth.accountId, cached);
    return cached.handle;
  }

  // If credentials changed, dispose the old handle so the new env is picked up.
  if (cached) {
    log.info("Credentials changed; restarting provider for account", { accountId: auth.accountId });
    await disposeAccount(auth.accountId, "credentials-changed");
  }

  // Set env BEFORE the provider import / spawn so the child process inherits.
  if (auth.mode === "api-key") {
    if (!auth.apiKey) throw new Error("API-key auth context is missing apiKey");
    setEnvForApiKey(auth.apiKey);
  } else {
    clearEnvForCliLogin();
  }

  const mod = await loadProviderModule();
  const factory =
    mod.createKiroAcp ?? (typeof mod.default === "function" ? (mod.default as ProviderModule["createKiroAcp"]) : undefined);
  if (typeof factory !== "function") {
    throw new Error("kiro-acp-ai-provider does not export `createKiroAcp`");
  }
  const raw = factory();
  const resolved = await Promise.resolve(raw);
  const handle = adaptHandle(resolved);
  const next: CachedHandle = {
    handle,
    authMode: auth.mode,
    lastUsedAt: Date.now(),
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
  };
  handleCache.set(auth.accountId, next);
  armIdleTimer(auth.accountId, next);
  return handle;
}

export async function disposeProviderForAccount(accountId: string): Promise<void> {
  await disposeAccount(accountId, "explicit-dispose");
}
