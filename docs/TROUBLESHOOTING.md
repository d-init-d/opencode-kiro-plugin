# Troubleshooting

Bật log chi tiết:

```bash
export KIRO_PLUGIN_LOG=debug
```

Hoặc:

```bash
export OPENCODE_KIRO_LOG=debug
```

## "kiro-acp-ai-provider chưa được cài"

Bạn cần cài provider runtime:

```bash
npm install kiro-acp-ai-provider
```

Hoặc thêm dependency vào project nơi đang chạy OpenCode.

## "kiro-cli chưa được cài"

Cài `kiro-cli` theo hướng dẫn của Kiro. Plugin không tự cài CLI thay bạn.

## "Vẫn báo cần đăng nhập dù đã `kiro-cli login`"

- Xác nhận `kiro-cli` chạy được trên cùng máy (`kiro-cli --version`).
- Nếu bạn đặt `KIRO_API_KEY` trong shell, biến này sẽ override phiên CLI. Tháo bỏ:

```bash
unset KIRO_API_KEY
```

## OpenCode trả lỗi 400 "Body không phải JSON hợp lệ"

Plugin từ chối request OpenAI không đúng format. Kiểm tra phiên bản `@ai-sdk/openai-compatible` và cấu hình `baseURL` đúng `https://kiro.local/v1`.

## "Endpoint không tồn tại"

Plugin chỉ phục vụ `/v1/models`, `/v1/chat/completions`, và `/health` để smoke test. Các endpoint khác (ví dụ `/v1/embeddings`) chưa hỗ trợ trong MVP.

## Hủy phiên ACP "đứng hình"

Plugin có idle timer 5 phút. Nếu cần force restart, có thể restart OpenCode hoặc gọi tool `kiro_status` rồi gửi câu lệnh mới.
