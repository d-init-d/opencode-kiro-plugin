/**
 * OpenCode auth hook for the Kiro provider.
 *
 * The shape returned here matches the v1.2.x plugin contract used by
 * `sst/opencode` (verified by reverse-engineering `opencode-antigravity-auth`):
 *
 *   {
 *     auth: {
 *       provider: string,
 *       loader: (getAuth, provider) => Promise<{ apiKey, fetch }>,
 *       methods: AuthMethod[]
 *     },
 *     event?: (payload) => void,
 *     tool?: Record<string, unknown>
 *   }
 *
 * `AuthMethod` collects user input through `prompts: AuthPrompt[]` and reacts
 * via `authorize(inputs)`. This is what surfaces in `opencode auth login`.
 *
 * For Kiro we provide:
 *   1. "Kiro API Key" (`type: "api"`) — paste a `ksk_...` value via OpenCode's
 *      built-in API-key prompt. OpenCode persists the value in its own auth
 *      storage; we mirror it into the plugin's account store on first use.
 *   2. "Kiro CLI session" (`type: "oauth"`, manual) — uses the existing
 *      `kiro-cli login` session. We surface a one-shot setup link with
 *      instructions but never spawn the login ourselves (per the project's
 *      MVP guard rails).
 */
import { handleOpenAICompatibleRequest } from "../openai/handler.js";
import { mergeOpenCodeConfig } from "../config/opencode-config.js";
import { inspectApiKeyShape, maskApiKey } from "./api-key.js";
import { inspectCliAuthState } from "./cli-login.js";
import {
  addApiKeyAccount,
  ensureCliLoginAccount,
  loadAccountStore,
} from "./account-store.js";
import type { KiroAuthContext } from "../kiro/provider.js";
import { log } from "../plugin/debug.js";

// ---------- Types mirrored from @opencode-ai/plugin ----------
//
// We mirror these here because @opencode-ai/plugin is a peerDependency that
// users may have installed at any version. Importing the runtime types would
// couple us to a specific version. Anything we use is structural so this is
// safe.

export interface OpenCodeAuthValue {
  type?: string;
  /** Set by OpenCode when `type === "api"`. */
  key?: string;
  apiKey?: string;
  /** Set by OpenCode when `type === "oauth"`. */
  access?: string;
  refresh?: string;
  expires?: number;
}

export type GetAuth = () => Promise<OpenCodeAuthValue> | OpenCodeAuthValue;

export interface LoaderResult {
  apiKey: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export type AuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
      condition?: (inputs: Record<string, string>) => boolean;
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      condition?: (inputs: Record<string, string>) => boolean;
    };

export interface OAuthAuthorizationResult {
  url: string;
  instructions: string;
  method: "auto" | "code";
  callback: ((code?: string) => Promise<unknown>) | (() => Promise<unknown>);
}

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  prompts?: AuthPrompt[];
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
}

export interface KiroAuthHook {
  provider: string;
  loader: (getAuth: GetAuth, provider: unknown) => Promise<LoaderResult | Record<string, unknown>>;
  methods: AuthMethod[];
}

// ---------- Implementation ----------

function deriveAuthContextFromHook(value: OpenCodeAuthValue | undefined): KiroAuthContext {
  // The auth hook context is now only a hint for the rotator's back-compat
  // path. Real account selection happens inside `streamWithRotation()` /
  // `generateWithRotation()` and consults `kiro-accounts.json`.
  const candidate = value?.key ?? value?.apiKey;
  if (candidate && typeof candidate === "string" && candidate.length > 0) {
    return { accountId: "_hook_apikey", mode: "api-key", apiKey: candidate };
  }
  // OAuth-shaped auth from the "kiro-cli session" method.
  if (value?.type === "oauth" || value?.refresh || value?.access) {
    return { accountId: "_hook_cli", mode: "cli-login" };
  }
  return { accountId: "_hook_cli", mode: "cli-login" };
}

/**
 * Mirror an API key from OpenCode's auth storage into our account store the
 * first time we see it. We keep OpenCode's storage as the source of truth and
 * use ours for the rotation/cooldown layer.
 */
async function mirrorHookKeyIntoStore(value: OpenCodeAuthValue | undefined): Promise<void> {
  const candidate = value?.key ?? value?.apiKey;
  if (!candidate || typeof candidate !== "string") return;
  try {
    const store = await loadAccountStore();
    const exists = store.accounts.some((a) => a.type === "api-key" && a.apiKey === candidate);
    if (exists) return;
    await addApiKeyAccount({
      apiKey: candidate,
      label: `OpenCode auth (${maskApiKey(candidate)})`,
    });
    log.info("Mirrored OpenCode API key into Kiro account store", {
      keyMasked: maskApiKey(candidate),
    });
  } catch (err) {
    log.warn("Could not mirror OpenCode key into account store", { error: String(err) });
  }
}

/**
 * Called by the "Kiro CLI session" method's `authorize` flow. Probes whether
 * `kiro-cli` is logged in and creates the implicit cli-login account when
 * everything checks out.
 */
async function authorizeViaExistingCliLogin(): Promise<OAuthAuthorizationResult> {
  const state = await inspectCliAuthState();
  await ensureCliLoginAccount();
  const ok = state.installed && state.authenticated;
  const detail =
    state.detail ??
    (ok
      ? "Đã phát hiện phiên `kiro-cli login`. Nhấn Enter để hoàn tất."
      : "Plugin sẽ thử dùng phiên `kiro-cli login` nếu có. Bạn có thể chạy `kiro-cli login` ở terminal khác trước.");
  return {
    url: "https://github.com/d-init-d/opencode-kiro-plugin#auth-modes",
    instructions: ok
      ? `${detail}\n(Plugin chỉ kiểm tra phiên hiện tại — không tự đăng nhập thay bạn.)`
      : `${detail}\nChạy: kiro-cli login\nSau đó quay lại đây và nhấn Enter.`,
    method: "auto",
    async callback() {
      const recheck = await inspectCliAuthState();
      if (!recheck.installed) {
        throw new Error("`kiro-cli` không có trên PATH. Cài trước rồi thử lại.");
      }
      if (!recheck.authenticated) {
        throw new Error("Phiên `kiro-cli login` chưa hoạt động. Chạy `kiro-cli login` rồi thử lại.");
      }
      return { type: "oauth" as const, refresh: "kiro-cli", access: "kiro-cli", expires: Date.now() + 24 * 60 * 60 * 1000 };
    },
  };
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
      const ctx = deriveAuthContextFromHook(value);
      log.debug("Kiro auth loader resolved", {
        mode: ctx.mode,
        keyMasked: ctx.apiKey ? maskApiKey(ctx.apiKey) : "",
      });

      // Best-effort: copy any newly-pasted API key into our store so rotation
      // can reach it. Errors here are non-fatal; the rotator falls back to
      // the in-memory legacy account when the store is empty.
      void mirrorHookKeyIntoStore(value);

      return {
        apiKey: ctx.apiKey ?? "kiro-acp",
        fetch: async (input, init) => {
          const request = input instanceof Request ? input.clone() : new Request(input as string, init);
          const handled = await handleOpenAICompatibleRequest(request, { auth: ctx });
          if (handled) return handled;
          // If we reach here, the URL is not one we handle. Pass through to
          // the default fetch so other providers are not blocked.
          return globalThis.fetch(request);
        },
      };
    },
    methods: [
      {
        type: "api",
        label: "Kiro API Key",
        prompts: [
          {
            type: "text",
            key: "key",
            message:
              "Dán KIRO_API_KEY (định dạng `ksk_...`). Plugin sẽ lưu vào ~/.config/opencode/kiro-accounts.json (mode 0600), KHÔNG ghi vào opencode.json. Có thể chạy lại để thêm account khác.",
            placeholder: "ksk_xxxxxxxxxxxxxxxxxxxxxxxx",
            validate(value: string) {
              const result = inspectApiKeyShape(value);
              return result.ok ? undefined : result.hint;
            },
          },
        ],
      },
      {
        type: "oauth",
        label: "Use existing kiro-cli login",
        authorize: authorizeViaExistingCliLogin,
      },
      // Advanced action: configure provider entries in opencode.json.
      {
        type: "oauth",
        label: "Configure Kiro models in opencode.json",
        async authorize(): Promise<OAuthAuthorizationResult> {
          return {
            url: "https://github.com/d-init-d/opencode-kiro-plugin#models",
            instructions:
              "Plugin sẽ tự thêm provider/model Kiro vào ~/.config/opencode/opencode.json (có backup .bak.<timestamp>). Nhấn Enter để tiếp tục.",
            method: "auto",
            async callback() {
              const result = await mergeOpenCodeConfig({ providerId });
              if (!result.changed) {
                return { type: "oauth" as const, refresh: "noop", access: "noop", expires: Date.now() + 24 * 60 * 60 * 1000 };
              }
              return {
                type: "oauth" as const,
                refresh: "configured",
                access: "configured",
                expires: Date.now() + 24 * 60 * 60 * 1000,
              };
            },
          };
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
