# Kiro Models for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-kiro-plugin.svg)](https://www.npmjs.com/package/opencode-kiro-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Use **Kiro** models from inside [Opencode](https://opencode.ai) by reusing your existing `kiro-cli` session — or by pasting your own `KIRO_API_KEY`. The plugin runs in-process: it wraps `kiro-cli acp` via [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider) and translates between OpenAI Chat Completions and the AI SDK v3 stream surface that Opencode already understands. No separate gateway server, no localhost ports.

## What You Get

- **Claude Opus 4.7 / 4.6**, **Sonnet 4.6**, **Haiku 4.5** through Kiro
- **DeepSeek 3.2** and **Qwen3 Coder Next** when your Kiro plan exposes them
- **Two auth modes** — `KIRO_API_KEY` paste or existing `kiro-cli login` session
- **Multi-account rotation** — add multiple Kiro keys, plugin auto-fails over on rate limit / quota / 5xx
- **Three rotation strategies** — `sticky`, `round-robin`, `hybrid` (default: stick to one account, switch only on errors)
- **Streaming + tool calls** — full SSE pipeline, including assistant `tool_calls`
- **First-chunk failover** — streaming requests can switch accounts before any byte reaches the client
- **Auto-config** — one click to add provider/model entries to `opencode.json`
- **Secret hygiene** — keys stored in `~/.config/opencode/kiro-accounts.json` (mode `0600`); never written to `opencode.json`; logs redact `ksk_*`, bearer, JWT, and OAuth token fields
- **In-process** — no daemon, no localhost server, no `ngrok`-style routing

---

<details open>
<summary><b>⚠️ Unofficial — Read Before Installing</b></summary>

> [!CAUTION]
> This is an unofficial local interoperability plugin. You must bring your own Kiro account / subscription / API key. By installing you acknowledge:
> - The plugin is **not endorsed by Kiro**.
> - You are responsible for compliance with Kiro's terms of service.
> - The plugin does not sell, share, or proxy any account.
> - APIs and quotas may change without notice.

</details>

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A — Let an LLM do it**

Paste this into Opencode, Claude Code, or any agent:

```
Install the opencode-kiro-plugin and add Kiro model definitions to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/d-init-d/opencode-kiro-plugin/main/README.md
```

**Option B — Manual**

1. Add the plugin to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["opencode-kiro-plugin@latest"]
   }
   ```

2. Authenticate. Pick one:

   ```bash
   opencode auth login
   # → Kiro → "Kiro API Key"  (paste a `ksk_...` value)
   # or
   # → Kiro → "Use existing kiro-cli login"
   ```

3. Add models — choose one:
   - Run `opencode auth login` → Kiro → **"Configure Kiro models in opencode.json"** (auto-configures everything below)
   - Or copy the [full configuration](#models) yourself

4. Use it:

   ```bash
   opencode run "Hello" --model=kiro/claude-opus-4.6
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-step

1. Edit `~/.config/opencode/opencode.json` (works on Windows, macOS, Linux — `~` resolves to the user home).
2. Add `"opencode-kiro-plugin@latest"` to the `plugin` array.
3. Add the model definitions from [Models](#models).
4. Set `provider` to `"kiro"` (or whatever you registered) and pick a model.

### Verification

```bash
opencode run "Hello" --model=kiro/claude-opus-4.7
```

If the call fails with `kiro-cli chưa được cài` install `kiro-cli` and run `kiro-cli login` once.

</details>

---

## Models

### Model Reference

| Model | Streaming | Tool calls | Vision | Notes |
|-------|-----------|------------|--------|-------|
| `auto` | ✅ | ✅ | — | Lets Kiro pick the best backing model |
| `claude-opus-4.7` | ✅ | ✅ | ✅ | Latest Opus tier |
| `claude-opus-4.6` | ✅ | ✅ | ✅ | Default for `model` |
| `claude-sonnet-4.6` | ✅ | ✅ | ✅ | Default for `small_model` |
| `claude-haiku-4.5` | ✅ | ✅ | ✅ | Lower latency |
| `deepseek-3.2` | ✅ | ✅ | — | Subject to Kiro plan |
| `qwen3-coder-next` | ✅ | ✅ | — | Subject to Kiro plan |

> Availability depends on what your Kiro account is entitled to. The plugin asks `kiro-acp-ai-provider` for a dynamic list when supported and falls back to the catalog above.

<details>
<summary><b>Full models configuration (copy-paste ready)</b></summary>

Add this to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kiro-plugin@latest"],
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro",
      "options": {
        "baseURL": "https://kiro.local/v1"
      },
      "models": {
        "auto": { "name": "Kiro Auto" },
        "claude-opus-4.7": { "name": "Kiro Claude Opus 4.7" },
        "claude-opus-4.6": { "name": "Kiro Claude Opus 4.6" },
        "claude-sonnet-4.6": { "name": "Kiro Claude Sonnet 4.6" },
        "claude-haiku-4.5": { "name": "Kiro Claude Haiku 4.5" },
        "deepseek-3.2": { "name": "Kiro DeepSeek 3.2" },
        "qwen3-coder-next": { "name": "Kiro Qwen3 Coder Next" }
      }
    }
  },
  "model": "kiro/claude-opus-4.6",
  "small_model": "kiro/claude-sonnet-4.6"
}
```

> The `https://kiro.local/v1` host is **synthetic**. The plugin's `auth.loader.fetch` intercepts every request to it; no DNS lookup or outbound connection is made to that hostname.

</details>

---

## Multi-Account Rotation

Add several Kiro API keys (and optionally one existing `kiro-cli login` session) so the plugin can fail over automatically when one account is rate-limited, quota-exhausted, or returns 5xx errors. This mirrors the behavior of `opencode-antigravity-auth`'s multi-account flow but uses Kiro's API key model instead of OAuth.

### Add accounts

```bash
opencode auth login
# → Kiro → "Kiro API Key (add account)"   # repeat for each `ksk_...` you own
# → Kiro → "Use existing kiro-cli login"  # optional fallback
```

Each invocation appends to `~/.config/opencode/kiro-accounts.json` (mode `0600`). Duplicate keys are detected and ignored.

### Inspect & manage

```bash
opencode auth login
# → Kiro → "List Kiro accounts"
# → Kiro → "Manage Kiro accounts (enable/disable/remove)"
# → Kiro → "Set rotation strategy (sticky / round-robin / hybrid)"
```

You can also run the `kiro_accounts` tool inside any Opencode session to see the current state without leaving the chat.

### Strategies

| Strategy | When to use |
|----------|-------------|
| `hybrid` (default) | Best for most users. Sticks to the first eligible account; switches only when it hits an error. Preserves prompt cache. |
| `sticky` | Single-account workflows. Same as hybrid but won't auto-rotate even when an account is on cooldown — surfaces the error directly. |
| `round-robin` | Many short requests. Picks the least recently used eligible account every call to spread load evenly. |

### Cooldown policy

When an account fails, the plugin classifies the error and applies the right cooldown before considering it eligible again:

| Error class | Detection | Cooldown |
|-------------|-----------|----------|
| `rate_limit` | HTTP 429 or "rate limit / throttled" wording | 60s, doubling per consecutive failure, capped at 30 min |
| `quota_exceeded` | HTTP 402 or "quota / billing / credits" wording | 15 min flat |
| `transient` | HTTP 5xx, `ECONNRESET`, fetch failed, "bad gateway" | 10s, doubling, capped at 5 min |
| `auth` | HTTP 401/403 or "invalid api key / forbidden" wording | 24 h **and** account is auto-disabled (re-add to recover) |
| `client_error` | HTTP 4xx other than auth/rate | not penalized — request is malformed |
| `unknown` | catch-all | 30s short cooldown |

Auth errors are intentionally **not** retried on a different account — the request is the problem, not the account choice. The original error is surfaced to the caller.

### When all accounts are on cooldown

The plugin returns HTTP 429 with a `Retry-After` header and a JSON body:

```json
{
  "error": {
    "type": "kiro_all_accounts_exhausted",
    "message": "Tất cả tài khoản Kiro đều đang cooldown. Thử lại sau 42s. Chi tiết: work[rate_limit], personal[rate_limit]",
    "attempts": [
      { "account": "work", "kind": "rate_limit", "message": "..." },
      { "account": "personal", "kind": "rate_limit", "message": "..." }
    ]
  }
}
```

`Retry-After` is set to the number of seconds until the first account becomes eligible again, so well-behaved clients (including Opencode) can back off automatically.

### Reset state

If something gets stuck, delete the store and re-add accounts:

```bash
rm ~/.config/opencode/kiro-accounts.json
opencode auth login
```

The plugin holds no in-memory state beyond the lifetime of a single Opencode session, so a restart also clears any transient cooldown timers.

---

## Auth Modes

### 1. Existing `kiro-cli login`

```bash
kiro-cli login                  # opens browser, authenticates once
opencode auth login
# → Kiro → "Use existing kiro-cli login"
```

The plugin calls `verifyAuth()` from `kiro-acp-ai-provider` (when available) and otherwise lets the first request surface the real session error. The plugin **never** writes to or reads from your Kiro token cache.

### 2. Manual API key

```bash
opencode auth login
# → Kiro → "Kiro API Key"
# paste a value that looks like `ksk_...`
```

The key is stored by Opencode's own auth subsystem. The plugin only injects it into the **child** `kiro-cli` process via the `KIRO_API_KEY` environment variable; it is never written to `opencode.json`, `kiro.json`, logs, or repo files.

> If you set `KIRO_API_KEY` in your shell, that value will override an existing `kiro-cli login` session for the child process. Unset it (`unset KIRO_API_KEY` / `Remove-Item Env:KIRO_API_KEY`) to use the CLI session.

---

## How It Works

```
Opencode
  └─ provider: kiro / @ai-sdk/openai-compatible
       └─ auth.loader.fetch (in-process interceptor)
            └─ /v1/models, /v1/chat/completions
                 └─ OpenAI ↔ AI SDK v3 translator
                      └─ kiro-acp-ai-provider
                           └─ kiro-cli acp (subprocess)
                                └─ Kiro backend
```

1. Opencode's `@ai-sdk/openai-compatible` provider builds a real `Request` for `https://kiro.local/v1/...`.
2. The plugin's `auth.loader.fetch` recognises the synthetic host and short-circuits the request inside the same Node process.
3. The request is validated with Zod, translated into AI SDK v3 prompt parts, and dispatched to a singleton `kiro-acp-ai-provider` instance.
4. AI SDK v3 stream parts are converted back into OpenAI Chat Completion SSE chunks (`text` deltas, `tool_calls`, finish reasons, usage).
5. An idle timer shuts down the underlying `kiro-cli acp` subprocess after five minutes of inactivity.

---

## Tools

Two custom Opencode tools ship with the plugin:

| Tool | Purpose |
|------|---------|
| `kiro_status` | Reports whether `kiro-cli` is installed/authenticated, the active auth mode, account count, cooldown summary, and the current model list. Output is fully redacted. |
| `kiro_models` | Returns the merged model catalog (dynamic list from `kiro-acp-ai-provider` when supported, curated catalog otherwise). |
| `kiro_accounts` | Read-only view of the configured Kiro accounts, the active rotation strategy, and the time until the next eligible account becomes available. Never returns the raw API key. |

Use them from inside an Opencode session, for example:

> "Use the `kiro_status` tool and tell me whether Kiro is ready."

---

## Configuration

### Files the plugin owns

| File | Path | Contains secrets? |
|------|------|-------------------|
| Main Opencode config | `~/.config/opencode/opencode.json` | **No** — only provider/model definitions |
| Plugin config | `~/.config/opencode/kiro.json` | **No** — non-secret preferences only |
| Account store | `~/.config/opencode/kiro-accounts.json` | **Yes** — API keys (mode `0600`, never copied to other files) |
| Opencode auth storage | managed by Opencode | Yes (when using API key mode) |
| `kiro-cli` token cache | managed by `kiro-cli` | Yes (when using CLI login mode) |

> **Windows users:** `~` resolves to your user home (e.g. `C:\Users\YourName`). Do NOT use `%APPDATA%`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `KIRO_API_KEY` | Used by the underlying `kiro-cli` subprocess when API-key mode is active. The plugin sets it from Opencode auth storage; you usually don't need to set it manually. |
| `KIRO_PLUGIN_LOG` | One of `debug`, `info`, `warn`, `error`. Default `warn`. |
| `OPENCODE_KIRO_LOG` | Alias for `KIRO_PLUGIN_LOG`. |

---

## Troubleshooting

> **Quick reset:** the plugin holds no per-user state of its own. If something is wrong, restart Opencode; if that doesn't help, run `kiro-cli login` again or rotate the API key inside `opencode auth login`.

### `kiro-acp-ai-provider chưa được cài`

Install the runtime provider package once:

```bash
npm install kiro-acp-ai-provider
```

If you installed Opencode globally, install it in the same global scope (`npm install -g kiro-acp-ai-provider`).

### `kiro-cli` is missing or not on `PATH`

Install `kiro-cli` from the official Kiro source. The plugin will not install it for you, and it will not bypass an interactive `kiro-cli login` prompt.

### "Logged in via `kiro-cli login` but the plugin still fails"

- Confirm `kiro-cli --version` works in the same shell that launched Opencode.
- Make sure no `KIRO_API_KEY` is exported in your shell — it overrides the session for child processes.

### `400 Body không phải JSON hợp lệ`

The plugin rejected an upstream request that wasn't valid OpenAI Chat Completions JSON. Check that:
- `provider.kiro.npm` is `@ai-sdk/openai-compatible`
- `provider.kiro.options.baseURL` is exactly `https://kiro.local/v1`

### `Endpoint không tồn tại`

The plugin only serves `/v1/models`, `/v1/chat/completions`, and `/health`. Embeddings and Anthropic-style `/v1/messages` are out of scope for the MVP.

### Tool calls vanish or arrive empty

Tool definitions must follow the OpenAI Chat shape:

```json
{
  "type": "function",
  "function": {
    "name": "search",
    "parameters": { "type": "object", "properties": { "q": { "type": "string" } } }
  }
}
```

If your MCP server emits a non-OpenAI schema, expose it through Opencode's MCP layer rather than passing it raw.

### Verbose logs

```bash
# bash / zsh
KIRO_PLUGIN_LOG=debug opencode

# PowerShell
$env:KIRO_PLUGIN_LOG = "debug"; opencode
```

Logs are JSON lines on stderr/stdout. Secrets are redacted before they reach a stream — if you ever spot a `ksk_*`-shaped string in the output, please open an issue.

---

## Plugin Compatibility

### Other Opencode plugins

The plugin only registers a `kiro` provider and two tools (`kiro_status`, `kiro_models`). It does not touch other providers' models, fetch handlers, or auth methods, so it can sit alongside `opencode-antigravity-auth`, `oh-my-opencode`, `@tarquinen/opencode-dcp`, etc.

If another plugin also exposes a `kiro` provider id, register this plugin under a different name:

```ts
import { createKiroPlugin } from "opencode-kiro-plugin";
export default createKiroPlugin({ providerId: "kiro-personal" });
```

---

## Security Posture

Hard rules baked into the codebase:

- `KIRO_API_KEY` is **never** written to any file the plugin manages.
- The plugin opens **no** network ports.
- Logger redacts `ksk_*`, `Bearer …`, JWT triplets, and JSON `access_token` / `refresh_token` / `id_token` / `api_key` fields before printing.
- `auth/api-key.ts` shape-checks the key locally; it does not phone home to validate.
- The plugin does not scrape Kiro token caches or call undocumented Kiro REST endpoints.
- The plugin does not spawn `kiro-cli login` for you. If a login is needed, the plugin tells you to run it.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

---

## Development

```bash
git clone https://github.com/d-init-d/opencode-kiro-plugin.git
cd opencode-kiro-plugin
npm install
npm run typecheck
npm test
npm run build
```

To load the local build into Opencode:

```jsonc
{
  "plugin": ["/abs/path/to/opencode-kiro-plugin/dist/index.js"]
}
```

Project layout:

```
src/
  index.ts                 # public exports + default plugin
  plugin.ts                # createKiroPlugin / KiroPlugin / hooks
  constants.ts             # synthetic URL, model catalog, env names
  auth/                    # api-key checks, cli-login probe, loader hook
  kiro/                    # provider lifecycle, model catalog, optional quota
  openai/                  # zod schema, translate, SSE stream, handler, helpers
  config/                  # opencode.json merge + kiro.json loader
  plugin/                  # JSON logger w/ redaction, status report
  tools/                   # kiro_status, kiro_models
tests/                     # vitest specs (44 tests)
docs/                      # ARCHITECTURE, TROUBLESHOOTING, SECURITY
examples/opencode.jsonc
```

---

## Roadmap (post-MVP)

- Optional `/v1/embeddings` passthrough when `kiro-acp-ai-provider` exposes an embeddings model
- Optional spawn-and-monitor `kiro-cli login` flow once it can be made non-interactive
- Anthropic `/v1/messages` shim for tools that prefer that shape
- Soft quota threshold (skip an account before it fully exhausts) like `opencode-antigravity-auth`

These are explicitly **out of scope for the MVP** in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — module layout, lifecycle, request flow
- [Security](docs/SECURITY.md) — trust boundary, redaction, what is and isn't supported
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common errors and fixes

---

## Credits

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) by [@NoeFabris](https://github.com/NoeFabris) — proved that `auth.loader.fetch` interception is a viable Opencode plugin pattern.
- [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider) — the AI SDK v3 wrapper around `kiro-cli acp` that this plugin sits on top of.

## License

MIT. See [LICENSE](LICENSE).

<details>
<summary><b>Legal</b></summary>

### Intended use

- Personal / internal development against your own Kiro account
- Not for production proxying or for sharing access between users
- Not for evading Kiro quotas, rate limits, or terms

### Warning

By using this plugin you acknowledge:

- **Terms of Service risk** — using third-party tooling against Kiro may violate Kiro's ToS.
- **Account risk** — Kiro may suspend or ban accounts that use unsupported clients.
- **No guarantees** — the upstream API may change without notice and break this plugin.
- **Assumption of risk** — you accept all legal, financial, and technical risks.

### Disclaimer

Not affiliated with Kiro. "Kiro" is a trademark of its respective owner. This is an independent open-source project.

</details>
