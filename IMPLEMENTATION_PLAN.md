# opencode-kiro-plugin Implementation Plan

## Goal

Build an OpenCode plugin that lets a user use Kiro models from OpenCode after either:

1. logging in with their Kiro account through `kiro-cli login`, or
2. entering/exporting their own `KIRO_API_KEY`.

The target UX is:

```bash
opencode auth login
# choose Kiro
# choose API key or Kiro CLI login

opencode run "hello" --model=kiro/claude-opus-4.6
```

No user should need to manually run a separate gateway process for normal use.

## Current Evidence And Constraints

- OpenCode plugins are TS/JS modules that export plugin functions and can return hooks.
- Official docs show plugin hooks for `event`, `tool`, `shell.env`, and custom tools.
- `opencode-antigravity-auth` proves advanced auth hooks exist and are usable:
  - `auth.provider`
  - `auth.loader`
  - `auth.loader(...).apiKey`
  - `auth.loader(...).fetch`
  - `auth.methods`
- `auth.loader.fetch` can intercept provider HTTP calls and return custom `Response` objects.
- OpenCode supports custom provider config using `@ai-sdk/openai-compatible` with `baseURL`, `apiKey`, and model definitions.
- `kiro-acp-ai-provider` already wraps `kiro-cli acp` and implements AI SDK `LanguageModelV3` with streaming and tool calling.
- `kiro-cli` supports headless auth with `KIRO_API_KEY` and browser/session auth with `kiro-cli login`.

## Recommended Architecture

Use an in-process plugin gateway, not a separate localhost server, for the main plugin.

```text
OpenCode
  -> provider: kiro / @ai-sdk/openai-compatible
  -> plugin auth.loader.fetch intercepts https://kiro.local/v1/*
  -> in-process OpenAI-compatible adapter
  -> kiro-acp-ai-provider
  -> kiro-cli acp subprocess
  -> Kiro backend
```

This keeps the public `kiro-gateway` repo useful for non-OpenCode clients, but the OpenCode plugin should bundle the same translation layer in-process so the user does not manage another terminal.

## Product Decisions

### Plugin package

- Package name: `opencode-kiro-plugin`
- Main export: `KiroPlugin`
- Factory export: `createKiroPlugin(providerId = "kiro")`
- Provider id: `kiro`
- Synthetic local base URL: `https://kiro.local/v1`

### Auth modes

Implement these in order:

1. API key auth, MVP
   - OpenCode `auth.methods` exposes a manual API key method.
   - User pastes `KIRO_API_KEY` into OpenCode auth UI.
   - Plugin never writes the key to repo files.
   - Plugin passes key only to the `kiro-cli` subprocess environment.

2. Existing CLI login detection, MVP
   - If `kiro-cli login` has already been done, plugin can use existing Kiro CLI session.
   - `auth.loader` calls `verifyAuth()` from `kiro-acp-ai-provider`.
   - If authenticated, requests work without API key.

3. Interactive Kiro login, Phase 2
   - Add an auth method that launches or instructs `kiro-cli login`.
   - First implementation can show instructions and ask user to run `kiro-cli login` manually.
   - Later implementation can spawn `kiro-cli login` and forward output to OpenCode/logs if plugin API supports it reliably.

Do not implement OAuth token scraping or reverse-engineered Kiro account extraction.

### Provider wiring

OpenCode still needs a `provider` entry. The plugin should provide two paths:

1. Auto-config path during `opencode auth login`
   - Similar to `opencode-antigravity-auth`, offer a post-login action: `Configure Kiro models in opencode.json`.
   - Update `~/.config/opencode/opencode.json` safely.
   - Preserve existing config formatting where possible.
   - Add only missing fields.

2. Manual copy-paste path
   - Include full config in README and `examples/opencode.jsonc`.

The provider config should use a synthetic base URL so all calls are captured by `auth.loader.fetch`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kiro-plugin"],
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

If OpenCode requires `apiKey` for the OpenAI-compatible provider even though fetch is intercepted, return an empty string or dummy token from `auth.loader` like Antigravity does.

## Module Structure

```text
src/
  index.ts                         # exports KiroPlugin and createKiroPlugin
  plugin.ts                        # OpenCode plugin hooks
  constants.ts                     # provider id, synthetic base URL, model ids
  auth/
    loader.ts                      # auth.provider/auth.loader/auth.methods assembly
    cli-login.ts                   # verifyAuth, optional spawn kiro-cli login
    api-key.ts                     # API key validation/redaction helpers
  config/
    schema.ts                      # plugin config schema
    loader.ts                      # load ~/.config/opencode/kiro.json
    opencode-config.ts             # add provider/models to opencode.json
  kiro/
    provider.ts                    # lifecycle around createKiroAcp()
    models.ts                      # model catalog and dynamic listModels()
    quota.ts                       # optional getQuota() wrapper
  openai/
    schema.ts                      # OpenAI chat completion request validation
    translate.ts                   # OpenAI <-> AI SDK LanguageModelV3 mapping
    stream.ts                      # OpenAI SSE stream wrapper
    response.ts                    # response/error helpers
  plugin/
    debug.ts                       # redacted logs
    status.ts                      # status tool implementation
  tools/
    kiro_status.ts                 # custom OpenCode tool
    kiro_models.ts                 # custom OpenCode tool
tests/
  openai-translate.test.ts
  stream.test.ts
  auth.test.ts
  config.test.ts
docs/
  ARCHITECTURE.md
  TROUBLESHOOTING.md
examples/
  opencode.jsonc
```

## Dependencies

Runtime:

- `@opencode-ai/plugin`
- `kiro-acp-ai-provider`
- `@ai-sdk/provider`
- `zod`
- `xdg-basedir`
- `proper-lockfile` if writing OpenCode config/accounts safely

Dev:

- `typescript`
- `vitest`
- `@types/node`
- `zod-to-json-schema` if generating config schema

## Implementation Phases

### Phase 0 - Scaffold

Tasks:

- Create `package.json` with ESM, Node >= 20.
- Add TypeScript build and Vitest.
- Add `.gitignore`, `LICENSE`, `README.md`, `docs/ARCHITECTURE.md`.
- Add a minimal plugin export that logs initialization.

Acceptance criteria:

- `npm run typecheck` passes.
- `npm run build` emits `dist/index.js` and `dist/index.d.ts`.
- OpenCode can load the local plugin via config `plugin` entry.

### Phase 1 - In-process OpenAI-compatible adapter

Tasks:

- Port/adapt the translation code from `kiro-gateway`:
  - `openai/schema.ts`
  - `openai/translate.ts`
  - `openai/stream.ts`
- Implement a function:

```ts
async function handleOpenAICompatibleRequest(request: Request, authContext: KiroAuthContext): Promise<Response>
```

- Support:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - streaming and non-streaming responses
  - OpenAI tool call shape
  - multimodal image URL/data URL parts when supported by `kiro-acp-ai-provider`

Acceptance criteria:

- Unit tests pass for message translation, tool calls, usage mapping, and stream chunks.
- No network port is opened.
- Synthetic requests to `https://kiro.local/v1/models` return OpenAI-compatible model list.

### Phase 2 - Kiro provider lifecycle

Tasks:

- Wrap `createKiroAcp()` in a singleton/lane-aware manager.
- Pass environment safely:
  - if auth method is API key, inject `KIRO_API_KEY` into the subprocess env only.
  - if CLI login exists, avoid overriding env.
- Add idle shutdown timer to close `kiro-cli` subprocesses.
- Add `shutdown()` on process/session events when available.
- Add guardrails for concurrent sessions.

Acceptance criteria:

- `verifyAuth()` result is exposed through a status helper.
- `listModels()` works with both CLI-login and API-key auth.
- Plugin does not leak key in logs, errors, or config files.

### Phase 3 - OpenCode auth hooks

Tasks:

- Implement `createKiroPlugin(providerId = "kiro")`.
- Return hooks:

```ts
return {
  auth: {
    provider: providerId,
    loader: async (getAuth, provider) => ({
      apiKey: "",
      fetch: async (input, init) => { ... }
    }),
    methods: [ ... ]
  },
  tool: { ... },
  event: async ({ event }) => { ... }
}
```

- API key method:
  - label: `Kiro API Key`
  - type: `api`
  - validates that key looks like `ksk_...` without logging it.
- CLI login method:
  - label: `Use existing Kiro CLI login`
  - verifies `kiro-cli` installed and authenticated.
  - if not authenticated, shows actionable instructions to run `kiro-cli login`.
- Optional later method:
  - label: `Login with Kiro CLI`
  - spawns `kiro-cli login` if supported safely.

Acceptance criteria:

- `opencode auth login` shows Kiro auth methods.
- API-key auth can call `/v1/models` through the fetch interceptor.
- Existing `kiro-cli login` session can call `/v1/models` without entering key.

### Phase 4 - Provider/model auto-configuration

Tasks:

- Add config manager for `~/.config/opencode/opencode.json`.
- Add a safe merge operation:
  - create `plugin` array if missing.
  - add `opencode-kiro-plugin` if missing.
  - add provider `kiro` if missing.
  - add/update Kiro model definitions.
  - do not overwrite user's chosen default model unless user selects that option.
- Add backup before write:
  - `opencode.json.bak.<timestamp>`
- Use lock file or atomic write to avoid corrupting config.

Acceptance criteria:

- Running the configure action twice is idempotent.
- Existing unrelated providers/plugins remain unchanged.
- Invalid JSON fails with clear message and no write.

### Phase 5 - Tools and diagnostics

Custom tools:

- `kiro_status`
  - shows `kiro-cli` installed/authenticated/version
  - shows auth mode: API key or CLI session
  - never prints key/token path contents
- `kiro_models`
  - calls `listModels()` and returns current model list
- optional `kiro_quota`
  - wraps `getQuota()` if available for current session

Events:

- `server.connected`: log plugin ready.
- `session.error`: detect common ACP/Kiro failures and show helpful hints.
- `session.idle`: optional idle cleanup.

Acceptance criteria:

- Tools work in OpenCode sessions.
- Errors are actionable and redacted.

### Phase 6 - Documentation and examples

Files:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/TROUBLESHOOTING.md`
- `docs/SECURITY.md`
- `examples/opencode.jsonc`

README must include:

- install from npm
- install from local path during development
- auth with API key
- auth with `kiro-cli login`
- model examples for Opus 4.6 and 4.7
- warning that this is unofficial and users are responsible for Kiro terms
- explicit warning not to paste or commit `KIRO_API_KEY`

### Phase 7 - Release

Tasks:

- Add `prepublishOnly` build.
- Add GitHub Actions CI:
  - install
  - typecheck
  - test
  - build
- Add npm package metadata.
- Add semantic versioning notes.

Acceptance criteria:

- Fresh clone passes `npm install && npm test && npm run build`.
- Package can be installed by OpenCode with:

```json
{
  "plugin": ["opencode-kiro-plugin@latest"]
}
```

## Security Requirements

Hard requirements:

- Never commit real `KIRO_API_KEY`.
- Never write Kiro API key into `opencode.json`.
- Never log full API keys, OAuth tokens, refresh tokens, or auth files.
- Redact patterns:
  - `ksk_[A-Za-z0-9_-]+`
  - bearer tokens
  - AWS SSO token JSON contents
- Do not expose a localhost HTTP server in the plugin path unless user opts into gateway mode.
- Do not scrape Kiro token caches directly unless Kiro CLI/provider library requires it internally.

Recommended storage:

- API key is stored by OpenCode auth system when user chooses manual API key.
- Plugin config in `~/.config/opencode/kiro.json` should contain only non-secret settings.
- If any custom account storage is added later, encrypt or clearly mark as sensitive and use atomic writes.

## Policy And Positioning

Use this wording in docs:

- This is an unofficial local interoperability plugin.
- Users must bring their own Kiro account/subscription/API key.
- The plugin does not sell, share, or host access.
- Users are responsible for compliance with Kiro's terms.

Avoid wording like:

- bypass
- free credits
- unlimited
- resale
- shared account
- avoid limits

## MVP Scope

MVP should include only:

- plugin package scaffold
- API key auth method
- existing CLI-login detection
- fetch interceptor for `https://kiro.local/v1/models`
- fetch interceptor for `https://kiro.local/v1/chat/completions`
- Opus 4.6 and Opus 4.7 model config
- status tool
- tests for translation and auth redaction

Do not include in MVP:

- multi-account rotation
- direct undocumented Kiro REST calls
- Anthropic `/v1/messages`
- Docker
- separate daemon
- automatic `kiro-cli login` spawning unless proven reliable

## Detailed Acceptance Test Matrix

### Static checks

```bash
npm run typecheck
npm test
npm run build
```

### Manual OpenCode checks

1. Local plugin load
   - Add local plugin path to `opencode.json`.
   - Start OpenCode.
   - Confirm no startup error.

2. API key auth
   - Run `opencode auth login`.
   - Pick Kiro API key.
   - Enter a test key in local environment only.
   - Run `opencode run "Say hello" --model=kiro/claude-opus-4.6`.

3. CLI session auth
   - Run `kiro-cli login`.
   - Run `opencode auth login`.
   - Pick existing CLI login.
   - Run `opencode run "Say hello" --model=kiro/claude-opus-4.7`.

4. Tool call flow
   - Ask OpenCode to inspect a file or run a harmless command.
   - Confirm tool call request/response does not break Kiro ACP loop.

5. Config auto-write
   - Run configure action.
   - Confirm provider/model definitions exist.
   - Run configure action again.
   - Confirm no duplicates.

### Negative checks

- Missing `kiro-cli` gives clear error.
- Invalid API key gives clear error.
- Invalid OpenCode config does not get overwritten.
- Logs do not contain `ksk_` key material.

## Suggested Work Order For Opus

1. Scaffold package and exports.
2. Copy/adapt OpenAI translation layer from `d-init-d/kiro-gateway`.
3. Implement in-process fetch interceptor for synthetic URL.
4. Implement API key auth method.
5. Implement existing CLI-login detection.
6. Add model config writer.
7. Add status/models tools.
8. Write tests.
9. Write docs.
10. Run manual OpenCode smoke test.

## Open Questions To Resolve During Implementation

- Does the installed OpenCode version expose `auth.methods` exactly like `opencode-antigravity-auth` uses it?
- What is the exact shape of the `auth` object returned by OpenCode for `type: "api"`?
- Can an auth method safely run an interactive `kiro-cli login`, or should docs require users to run it separately?
- Does `@ai-sdk/openai-compatible` require a non-empty `apiKey`, or is `apiKey: ""` from `auth.loader` enough?
- Can provider model definitions be updated safely from `auth.methods` UX, or should a custom tool handle config?
