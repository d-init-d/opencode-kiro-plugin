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
