/**
 * OpenCode auth hooks for the Kiro provider.
 *
 * The shape returned here matches what `opencode-antigravity-auth` uses:
 *   {
 *     auth: {
 *       provider,            // provider id this loader belongs to
 *       loader: async (...) => ({ apiKey, fetch }),
 *       methods: [...]
 *     }
 *   }
 *
 * Because OpenCode's plugin types are still evolving we keep the structure
 * compatible but loosely typed at the boundaries (`unknown` where OpenCode
 * passes opaque values).
 */
import { handleOpenAICompatibleRequest } from "../openai/handler.js";
import { mergeOpenCodeConfig } from "../config/opencode-config.js";
import { inspectApiKeyShape, maskApiKey } from "./api-key.js";
import { inspectCliAuthState } from "./cli-login.js";
import type { KiroAuthContext } from "../kiro/provider.js";
import { log } from "../plugin/debug.js";

export interface OpenCodeAuthValue {
  type?: string;
  /** API-key auth from OpenCode's manual flow. */
  key?: string;
  apiKey?: string;
  /** OAuth-style auth, currently unused by the Kiro plugin. */
  access?: string;
  refresh?: string;
}

export interface KiroLoaderResult {
  apiKey: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface KiroAuthMethod {
  type: "api" | "oauth" | "custom";
  label: string;
  /** Optional setup function invoked when the user picks the method. */
  setup?: () => Promise<unknown>;
  /** Some OpenCode versions look at `instructions` to render help. */
  instructions?: string;
}

export interface KiroAuthHook {
  provider: string;
  loader: (
    getAuth: () => Promise<OpenCodeAuthValue | undefined> | OpenCodeAuthValue | undefined,
    provider: unknown
  ) => Promise<KiroLoaderResult>;
  methods: KiroAuthMethod[];
}

function deriveAuthContext(value: OpenCodeAuthValue | undefined): KiroAuthContext {
  const candidate = value?.key ?? value?.apiKey;
  if (candidate && typeof candidate === "string" && candidate.length > 0) {
    return { mode: "api-key", apiKey: candidate };
  }
  return { mode: "cli-login" };
}

/**
 * Build the auth hook entry. `providerId` lets advanced users register the
 * plugin under a different name, e.g. `kiro-personal`, when running multiple
 * Kiro accounts via separate OpenCode profiles.
 */
export function buildKiroAuthHook(providerId: string): KiroAuthHook {
  return {
    provider: providerId,
    async loader(getAuth) {
      const value = (await Promise.resolve(getAuth())) ?? undefined;
      const ctx = deriveAuthContext(value);
      log.debug("Kiro auth loader resolved", {
        mode: ctx.mode,
        keyMasked: ctx.apiKey ? maskApiKey(ctx.apiKey) : "",
      });

      // We always return apiKey as a non-empty string so any consumer that
      // does a truthy check is satisfied. The intercepted fetch ignores it.
      return {
        apiKey: ctx.apiKey ?? "kiro-acp",
        fetch: async (input, init) => {
          const request = input instanceof Request ? input.clone() : new Request(input as string, init);
          const handled = await handleOpenAICompatibleRequest(request, { auth: ctx });
          if (handled) return handled;
          // Defensive default: anyone hitting this fetch with a non-Kiro URL
          // gets a clear error rather than a silent network call.
          return new Response(
            JSON.stringify({
              error: {
                type: "kiro_unsupported_url",
                message: `Kiro plugin chỉ phục vụ ${request.url ? new URL(request.url).hostname : "kiro.local"}.`,
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        },
      };
    },
    methods: [
      {
        type: "api",
        label: "Kiro API Key",
        instructions:
          "Dán giá trị KIRO_API_KEY của bạn (bắt đầu bằng `ksk_...`). Plugin sẽ chỉ truyền key cho `kiro-cli` và không ghi vào `opencode.json`.",
      },
      {
        type: "custom",
        label: "Use existing kiro-cli login",
        instructions:
          "Bạn cần chạy `kiro-cli login` trên cùng máy trước. Plugin sẽ dùng phiên đăng nhập đó.",
        setup: async () => {
          const state = await inspectCliAuthState();
          return {
            installed: state.installed,
            authenticated: state.authenticated,
            version: state.version ?? null,
            detail: state.detail ?? null,
          };
        },
      },
      {
        type: "custom",
        label: "Configure Kiro models in opencode.json",
        instructions:
          "Tự động thêm provider/model Kiro vào ~/.config/opencode/opencode.json. Có backup trước khi ghi đè.",
        setup: async () => {
          const result = await mergeOpenCodeConfig({ providerId });
          return result;
        },
      },
    ],
  };
}

/**
 * Lightweight shape-check exported so the plugin entry can validate inputs in
 * the API-key setup flow without pulling all of `auth/api-key`.
 */
export function checkApiKey(value: string): { ok: boolean; hint?: string } {
  return inspectApiKeyShape(value);
}
