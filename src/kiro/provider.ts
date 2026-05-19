/**
 * Lifecycle wrapper around `kiro-acp-ai-provider`.
 *
 * Responsibilities:
 *   1. Lazy-import `createKiroAcp()` so the plugin still loads when the
 *      package is missing (we surface a helpful error instead of crashing).
 *   2. Inject `KIRO_API_KEY` into the subprocess environment when the user
 *      authenticated with an API key. The key is never written elsewhere.
 *   3. Provide a thin `generate()` and `stream()` interface that the OpenAI
 *      adapter calls into. The interface is intentionally narrow so we can
 *      mock it in tests.
 */
import { KIRO_API_KEY_ENV, KIRO_IDLE_SHUTDOWN_MS } from "../constants.js";
import { log } from "../plugin/debug.js";
import type { AiCallOptions, AiContent, AiFinishReason, AiUsage } from "../openai/translate.js";
import type { AiStreamPart } from "../openai/stream.js";

export type AuthMode = "api-key" | "cli-login";

export interface KiroAuthContext {
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

interface InternalState {
  handle?: KiroProviderHandle;
  authKey?: string;
  authMode?: AuthMode;
  idleTimer?: NodeJS.Timeout;
}

const state: InternalState = {};

function clearIdleTimer() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

function armIdleTimer() {
  clearIdleTimer();
  state.idleTimer = setTimeout(() => {
    log.info("Shutting down idle Kiro provider");
    void resetProvider("idle");
  }, KIRO_IDLE_SHUTDOWN_MS);
  // Allow the Node process to exit even if the timer is still pending.
  if (typeof state.idleTimer.unref === "function") state.idleTimer.unref();
}

export async function resetProvider(reason: string): Promise<void> {
  const { handle } = state;
  state.handle = undefined;
  state.authKey = undefined;
  state.authMode = undefined;
  clearIdleTimer();
  if (handle) {
    try {
      await handle.shutdown();
    } catch (err) {
      log.warn("Kiro provider shutdown failed", { reason, error: String(err) });
    }
  }
}

function ensureEnvForAuth(auth: KiroAuthContext): void {
  // For api-key auth we set KIRO_API_KEY in our own process env so the spawned
  // `kiro-cli acp` subprocess inherits it without us writing to disk.
  // For cli-login auth we explicitly do NOT touch the variable so the existing
  // session config governs behavior.
  if (auth.mode === "api-key" && auth.apiKey) {
    if (process.env[KIRO_API_KEY_ENV] !== auth.apiKey) {
      process.env[KIRO_API_KEY_ENV] = auth.apiKey;
    }
  }
}

async function loadProviderModule(): Promise<ProviderModule> {
  try {
    return (await import("kiro-acp-ai-provider")) as ProviderModule;
  } catch (err) {
    log.error("Không import được `kiro-acp-ai-provider`. Hãy cài: npm i kiro-acp-ai-provider", {
      error: String(err),
    });
    throw new Error(
      "kiro-acp-ai-provider chưa được cài. Chạy: npm i kiro-acp-ai-provider"
    );
  }
}

function adaptHandle(rawProvider: unknown): KiroProviderHandle {
  // Support several plausible shapes:
  //   1. function(modelId) -> LanguageModelV3 (createKiroAcp returns a callable)
  //   2. { languageModel(modelId) -> LanguageModelV3 }
  //   3. { chat(modelId) -> LanguageModelV3 }
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
      throw new Error("kiro-acp-ai-provider trả về object không có hàm tạo model");
    }
  } else {
    throw new Error("kiro-acp-ai-provider trả về kết quả không nhận diện được");
  }

  return {
    async getModel(modelId: string): Promise<KiroLanguageModel> {
      const raw = resolveModel(modelId);
      const model = (await Promise.resolve(raw)) as Record<string, unknown> | null;
      if (!model || typeof model !== "object") {
        throw new Error(`Không lấy được language model cho '${modelId}' từ kiro-acp-ai-provider`);
      }
      const doGenerate = model["doGenerate"];
      const doStream = model["doStream"];
      if (typeof doGenerate !== "function" && typeof doStream !== "function") {
        throw new Error(
          `Model '${modelId}' không có doGenerate/doStream. Phiên bản kiro-acp-ai-provider có thể không tương thích.`
        );
      }
      return {
        async doGenerate(options) {
          if (typeof doGenerate !== "function") {
            throw new Error("Model không hỗ trợ doGenerate");
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
            throw new Error("Model không hỗ trợ doStream");
          }
          const result = (await (doStream as (o: unknown) => Promise<unknown>).call(model, options)) as {
            stream?: AsyncIterable<AiStreamPart> | ReadableStream<AiStreamPart>;
          };
          if (!result || !result.stream) {
            throw new Error("doStream() không trả về stream");
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
  // ReadableStream<T> path
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

function authChanged(prev: InternalState, next: KiroAuthContext): boolean {
  if (prev.authMode !== next.mode) return true;
  if (next.mode === "api-key" && prev.authKey !== next.apiKey) return true;
  return false;
}

export async function getProvider(auth: KiroAuthContext): Promise<KiroProviderHandle> {
  ensureEnvForAuth(auth);
  if (state.handle && !authChanged(state, auth)) {
    armIdleTimer();
    return state.handle;
  }

  // Switching auth mode -> tear down existing subprocess so the new env is
  // picked up cleanly.
  if (state.handle) {
    log.info("Auth context changed; restarting Kiro provider");
    await resetProvider("auth-change");
  }

  const mod = await loadProviderModule();
  const factory = mod.createKiroAcp ?? (typeof mod.default === "function" ? (mod.default as ProviderModule["createKiroAcp"]) : undefined);
  if (typeof factory !== "function") {
    throw new Error("kiro-acp-ai-provider không export `createKiroAcp`");
  }
  const raw = factory();
  const resolved = await Promise.resolve(raw);
  state.handle = adaptHandle(resolved);
  state.authMode = auth.mode;
  if (auth.mode === "api-key" && auth.apiKey) state.authKey = auth.apiKey;
  armIdleTimer();
  return state.handle;
}
