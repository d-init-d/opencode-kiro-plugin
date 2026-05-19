# Prompt For Opus

You are implementing `opencode-kiro-plugin` in this repository.

Read `IMPLEMENTATION_PLAN.md` first and follow it as the source of truth. Build an OpenCode plugin that lets users use Kiro models from OpenCode via either manual `KIRO_API_KEY` auth or an existing `kiro-cli login` session.

Important constraints:

- Do not commit any real API key or token.
- Do not write `KIRO_API_KEY` into `opencode.json`.
- Use `kiro-acp-ai-provider` and `kiro-cli acp`; do not call undocumented Kiro REST APIs directly.
- Make the main plugin in-process via `auth.loader.fetch`; do not require a separate gateway server for MVP.
- Use synthetic base URL `https://kiro.local/v1` for the OpenAI-compatible provider.
- MVP models must include `claude-opus-4.6` and `claude-opus-4.7`.
- Run `npm run typecheck`, `npm test`, and `npm run build` before declaring completion.

Suggested first milestone:

1. scaffold package
2. export `KiroPlugin` and `createKiroPlugin`
3. implement `GET /v1/models` and `POST /v1/chat/completions` inside `auth.loader.fetch`
4. add API-key auth and existing CLI-login detection
5. add `examples/opencode.jsonc`
