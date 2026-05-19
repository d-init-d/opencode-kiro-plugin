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
 * Compared to a single-account plugin, the methods here cover:
 *   - "Kiro API Key" / "Use existing kiro-cli login"   — first-time setup
 *   - "Add another Kiro API key"                       — multi-account
 *   - "Manage Kiro accounts"                            — enable/disable/remove
 *   - "Set rotation strategy"                           — sticky/round-robin/hybrid
 *   - "Check Kiro account status"                       — read-only status snapshot
 *   - "Configure Kiro models in opencode.json"          — provider/model wiring
 */
import { handleOpenAICompatibleRequest } from "../openai/handler.js";
import { mergeOpenCodeConfig } from "../config/opencode-config.js";
import { inspectApiKeyShape, maskApiKey } from "./api-key.js";
import { inspectCliAuthState } from "./cli-login.js";
import {
  addApiKeyAccount,
  ensureCliLoginAccount,
  loadAccountStore,
  publicView,
  removeAccount,
  setAccountEnabled,
  setStrategy,
  type AccountStrategy,
} from "./account-store.js";
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
  setup?: (input?: unknown) => Promise<unknown>;
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

function deriveAuthContextFromHook(value: OpenCodeAuthValue | undefined): KiroAuthContext {
  // The auth hook context is now only a hint for the rotator's back-compat
  // path. Real account selection happens inside `streamWithRotation()` /
  // `generateWithRotation()` and consults `kiro-accounts.json`.
  const candidate = value?.key ?? value?.apiKey;
  if (candidate && typeof candidate === "string" && candidate.length > 0) {
    return { accountId: "_hook_apikey", mode: "api-key", apiKey: candidate };
  }
  return { accountId: "_hook_cli", mode: "cli-login" };
}

interface AddApiKeySetupInput {
  apiKey?: string;
  key?: string;
  label?: string;
  note?: string;
}

interface ManageAccountsInput {
  action?: "enable" | "disable" | "remove" | "list";
  accountId?: string;
}

interface SetStrategyInput {
  strategy?: AccountStrategy;
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

      return {
        apiKey: ctx.apiKey ?? "kiro-acp",
        fetch: async (input, init) => {
          const request = input instanceof Request ? input.clone() : new Request(input as string, init);
          const handled = await handleOpenAICompatibleRequest(request, { auth: ctx });
          if (handled) return handled;
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
        label: "Kiro API Key (add account)",
        instructions:
          "Dán giá trị KIRO_API_KEY (bắt đầu bằng `ksk_...`). Plugin lưu key vào ~/.config/opencode/kiro-accounts.json (mode 0600), KHÔNG ghi vào opencode.json. Có thể thêm nhiều key để xoay tự động.",
        setup: async (input) => {
          const data = (input ?? {}) as AddApiKeySetupInput;
          const key = (data.apiKey ?? data.key ?? "").trim();
          const shape = inspectApiKeyShape(key);
          if (!shape.ok) {
            return { ok: false, error: shape.hint ?? "Key không hợp lệ" };
          }
          const account = await addApiKeyAccount({
            apiKey: key,
            label: data.label && data.label.length > 0 ? data.label : `account-${new Date().toISOString().slice(0, 16)}`,
            ...(data.note ? { note: data.note } : {}),
          });
          return { ok: true, account: publicView(account) };
        },
      },
      {
        type: "custom",
        label: "Use existing kiro-cli login",
        instructions:
          "Bạn cần chạy `kiro-cli login` trên cùng máy trước. Plugin sẽ thêm một mục `cli-login` vào danh sách tài khoản và dùng phiên đăng nhập đó. Có thể vẫn xoay sang API key khi CLI bị lỗi.",
        setup: async () => {
          const state = await inspectCliAuthState();
          const account = await ensureCliLoginAccount();
          return {
            account: publicView(account),
            cli: {
              installed: state.installed,
              authenticated: state.authenticated,
              version: state.version ?? null,
              detail: state.detail ?? null,
            },
          };
        },
      },
      {
        type: "custom",
        label: "List Kiro accounts",
        instructions: "Hiển thị danh sách tài khoản hiện có (không lộ giá trị key).",
        setup: async () => {
          const store = await loadAccountStore();
          return {
            strategy: store.strategy,
            accounts: store.accounts.map(publicView),
          };
        },
      },
      {
        type: "custom",
        label: "Manage Kiro accounts (enable/disable/remove)",
        instructions:
          "Truyền `{ action: 'enable'|'disable'|'remove', accountId }` hoặc `{ action: 'list' }`.",
        setup: async (input) => {
          const data = (input ?? {}) as ManageAccountsInput;
          const action = data.action ?? "list";
          if (action === "list") {
            const store = await loadAccountStore();
            return { strategy: store.strategy, accounts: store.accounts.map(publicView) };
          }
          if (!data.accountId) {
            return { ok: false, error: "Cần truyền accountId" };
          }
          if (action === "remove") {
            const removed = await removeAccount(data.accountId);
            return { ok: removed, action, accountId: data.accountId };
          }
          if (action === "enable" || action === "disable") {
            const updated = await setAccountEnabled(data.accountId, action === "enable");
            if (!updated) return { ok: false, error: "Không tìm thấy account" };
            return { ok: true, action, account: publicView(updated) };
          }
          return { ok: false, error: `Hành động không hợp lệ: ${action}` };
        },
      },
      {
        type: "custom",
        label: "Set rotation strategy (sticky / round-robin / hybrid)",
        instructions:
          "Truyền `{ strategy: 'sticky' | 'round-robin' | 'hybrid' }`. Mặc định là `hybrid`: giữ tài khoản hiện tại, tự xoay khi gặp lỗi.",
        setup: async (input) => {
          const data = (input ?? {}) as SetStrategyInput;
          if (
            data.strategy !== "sticky" &&
            data.strategy !== "round-robin" &&
            data.strategy !== "hybrid"
          ) {
            return { ok: false, error: "strategy phải là 'sticky' | 'round-robin' | 'hybrid'" };
          }
          const store = await setStrategy(data.strategy);
          return { ok: true, strategy: store.strategy };
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
