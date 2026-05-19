# Architecture

```
OpenCode
  -> provider: kiro / @ai-sdk/openai-compatible
  -> auth.loader.fetch (in-process)
  -> handleOpenAICompatibleRequest()
       -> /v1/models           : list từ kiro/models.ts
       -> /v1/chat/completions : translate + stream
  -> kiro-acp-ai-provider
  -> kiro-cli acp (subprocess)
  -> Kiro backend
```

## Lý do dùng synthetic baseURL

`@ai-sdk/openai-compatible` luôn dial baseURL bạn cấu hình. Vì plugin tự thực hiện request bằng `auth.loader.fetch`, host thật không cần tồn tại — chỉ cần unique để interceptor nhận biết và route. `https://kiro.local/v1` đáp ứng yêu cầu đó và không trùng với host thật.

## Lifecycle tiến trình `kiro-cli acp`

`src/kiro/provider.ts` quản lý singleton:

- Lazy-import `kiro-acp-ai-provider` để plugin vẫn load được khi package thiếu.
- Khi đổi auth mode, tear down handle cũ trước khi tạo mới (env mới mới có hiệu lực).
- Idle timer 5 phút (`KIRO_IDLE_SHUTDOWN_MS`) tắt subprocess khi không dùng.
- Hook `event` của plugin đóng provider khi OpenCode bắn `session.idle` hoặc `session.end`.

## Tách biệt module

| Module | Mục đích |
|--------|----------|
| `openai/schema.ts` | Zod schema cho request OpenAI |
| `openai/translate.ts` | OpenAI <-> AI SDK v3 prompt/response |
| `openai/stream.ts` | AI SDK stream parts -> OpenAI SSE |
| `openai/handler.ts` | Router cho `/v1/*` |
| `kiro/provider.ts` | Singleton wrap `createKiroAcp` |
| `kiro/models.ts` | Catalog model + dynamic listModels |
| `kiro/quota.ts` | Optional getQuota wrapper |
| `auth/loader.ts` | OpenCode auth hook lắp ráp |
| `auth/api-key.ts` | Validate/redact API key |
| `auth/cli-login.ts` | Dò `kiro-cli` + `verifyAuth()` |
| `config/opencode-config.ts` | Merge opencode.json an toàn |
| `config/loader.ts` | kiro.json non-secret |
| `plugin/debug.ts` | Logger có redact secret |
| `plugin/status.ts` | Báo cáo trạng thái cho tool |
| `tools/kiro_status.ts` | Tool OpenCode |
| `tools/kiro_models.ts` | Tool OpenCode |

## Kiểm thử

- `tests/openai-translate.test.ts` — translate request/response/usage/finish reason.
- `tests/stream.test.ts` — SSE chunks cho text + tool calls + lỗi.
- `tests/auth.test.ts` — shape API key + redact log.
- `tests/config.test.ts` — merge `opencode.json` idempotent + backup.
- `tests/handler.test.ts` — handler interceptor (mock provider).


## Multi-account rotation

When the user adds more than one account, every `/v1/chat/completions` call goes through `auth/rotator.ts`:

```
handleChatCompletions
  └─ generateWithRotation / streamWithRotation
       └─ pickAccount(store, excludeIds)         # rotation.ts
       └─ getProvider({ accountId, mode, apiKey })
            └─ subprocess kiro-cli acp (per accountId, cached, idle-shutdown 5m)
       └─ run model.doGenerate / doStream
       └─ on error → classifyKiroError → planCooldown → save store → retry next account
```

Key invariants:

- `kiro-accounts.json` is the single source of truth for credentials and rotation state.
- Each accountId owns its own `kiro-cli acp` subprocess. Switching accounts does NOT reuse the previous subprocess (its env var differs).
- API keys are written into the subprocess env right before spawn and never logged or copied elsewhere.
- For streams, failover only happens before the first chunk is observed. Once the client starts receiving bytes we cannot re-attempt without breaking the SSE contract.
