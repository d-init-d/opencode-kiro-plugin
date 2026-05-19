/**
 * Static identifiers for the Kiro plugin.
 *
 * The synthetic base URL is intentionally not a real network host. It is only
 * used so OpenCode's `@ai-sdk/openai-compatible` provider produces request URLs
 * that we can reliably intercept inside `auth.loader.fetch`.
 */
export const DEFAULT_PROVIDER_ID = "kiro" as const;

/**
 * Synthetic base URL captured by the plugin's fetch interceptor.
 * Plain `kiro.local` would resolve in some networks; using `https://kiro.local/v1`
 * keeps it OpenAI-compatible while signalling "do not actually dial this host".
 */
export const SYNTHETIC_BASE_URL = "https://kiro.local/v1" as const;

/**
 * Placeholder host portion used when checking incoming Request URLs.
 */
export const SYNTHETIC_HOST = "kiro.local" as const;

/**
 * Plugin name as it appears in `opencode.json` `plugin` array.
 */
export const PLUGIN_PACKAGE_NAME = "opencode-kiro-plugin" as const;

/**
 * Curated MVP model catalog. The plan requires Opus 4.6 and 4.7 at minimum.
 * Each entry mirrors what we expose through `/v1/models` and what we suggest
 * writing into `opencode.json`.
 */
export interface KiroModelDescriptor {
  /** Model id used by clients (OpenAI-compatible). */
  readonly id: string;
  /** Human-friendly display name shown in OpenCode. */
  readonly displayName: string;
  /** Whether this model supports tool calling. */
  readonly toolCall: boolean;
  /** Whether this model supports image input parts. */
  readonly vision: boolean;
}

export const KIRO_MODEL_CATALOG: readonly KiroModelDescriptor[] = [
  { id: "auto", displayName: "Kiro Auto", toolCall: true, vision: false },
  { id: "claude-opus-4.7", displayName: "Kiro Claude Opus 4.7", toolCall: true, vision: true },
  { id: "claude-opus-4.6", displayName: "Kiro Claude Opus 4.6", toolCall: true, vision: true },
  { id: "claude-sonnet-4.6", displayName: "Kiro Claude Sonnet 4.6", toolCall: true, vision: true },
  { id: "claude-haiku-4.5", displayName: "Kiro Claude Haiku 4.5", toolCall: true, vision: true },
  { id: "deepseek-3.2", displayName: "Kiro DeepSeek 3.2", toolCall: true, vision: false },
  { id: "qwen3-coder-next", displayName: "Kiro Qwen3 Coder Next", toolCall: true, vision: false },
] as const;

/**
 * Idle timeout for the underlying `kiro-cli acp` subprocess. The real provider
 * also exposes its own idle handling but we manage a higher-level lifecycle
 * here so OpenCode does not keep zombie processes around.
 */
export const KIRO_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

/**
 * Environment variable consumed by `kiro-cli` for headless auth.
 */
export const KIRO_API_KEY_ENV = "KIRO_API_KEY" as const;
