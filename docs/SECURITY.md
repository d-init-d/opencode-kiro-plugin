# Security

## Hard rules

- Không bao giờ commit `KIRO_API_KEY`.
- Plugin không ghi key vào `opencode.json` hay bất kỳ file nào trong repo.
- Plugin redact các pattern sau trong log: `ksk_...`, `Bearer ...`, JWT 3-phần, JSON `access_token/refresh_token/id_token/api_key/apiKey`.

## Trust boundary

| Vị trí | Chứa secret? |
|--------|--------------|
| OpenCode auth storage | Có (do OpenCode tự lưu) |
| `~/.config/opencode/kiro.json` | Không, chỉ preference |
| `~/.config/opencode/opencode.json` | Không (plugin không ghi key) |
| Tiến trình `kiro-cli acp` | Có, qua biến môi trường `KIRO_API_KEY` (chỉ trong process tree) |
| Logs stdout/stderr | Không, đã redact |

## Phạm vi không hỗ trợ trong MVP

Để giữ surface bảo mật nhỏ:

- Không scrape token cache của Kiro.
- Không gọi REST không tài liệu của Kiro.
- Không expose port localhost.
- Không spawn `kiro-cli login` tự động (user chạy thủ công).

## Khi báo lỗi bảo mật

Vui lòng KHÔNG mở public issue có chứa key/log thật. Liên hệ riêng với maintainer và đính kèm log đã redact bằng `KIRO_PLUGIN_LOG=debug`.


## Multi-account rotation security

When you add multiple Kiro accounts:

- Keys are stored at `~/.config/opencode/kiro-accounts.json` with mode `0600` (POSIX) and an atomic temp+rename write.
- Writes are serialized through `proper-lockfile` to prevent corruption during concurrent saves.
- The store is **never** copied into `opencode.json` or any plugin source file.
- The `kiro_accounts` tool and the auth setup actions return only a masked key (`ksk_…1234` shape). The raw key is never serialized to a tool result, status report, or log.
- Auth errors disable the offending account automatically. A disabled account stays disabled until the user re-enables it (via `Manage Kiro accounts`) or removes it.
- Switching accounts always tears down the previous `kiro-cli acp` subprocess so the new key cannot leak into a long-lived child process.
