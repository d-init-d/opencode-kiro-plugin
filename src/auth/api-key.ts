/**
 * API key validation helpers.
 *
 * We do not validate the key against any remote endpoint here; that would
 * leak the key over the network. Instead we shape-check it locally so users
 * get instant feedback when they paste obviously wrong input into the
 * OpenCode auth UI.
 */

const KIRO_KEY_PATTERN = /^k[a-z]{2}_[A-Za-z0-9_-]{16,}$/;

export interface ApiKeyShapeReport {
  ok: boolean;
  /** Human friendly hint shown to the user (Vietnamese-aware). */
  hint?: string;
}

export function inspectApiKeyShape(value: string | undefined | null): ApiKeyShapeReport {
  if (!value || typeof value !== "string") {
    return { ok: false, hint: "API key trống. Bạn cần dán giá trị KIRO_API_KEY." };
  }
  const trimmed = value.trim();
  if (trimmed !== value) {
    return { ok: false, hint: "API key có khoảng trắng đầu/cuối. Bạn xóa khoảng trắng và thử lại." };
  }
  if (trimmed.length < 20) {
    return { ok: false, hint: "API key quá ngắn so với định dạng Kiro thường thấy." };
  }
  if (!KIRO_KEY_PATTERN.test(trimmed)) {
    return {
      ok: false,
      hint: "Định dạng không khớp `ksk_...`. Vẫn cho phép thử nếu Kiro đổi prefix, nhưng bạn nên kiểm tra lại key.",
    };
  }
  return { ok: true };
}

/**
 * Mask an API key so only the prefix and a small suffix tail remain visible
 * for diagnostics. Never use the original value for logs.
 */
export function maskApiKey(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  const prefix = value.slice(0, 4);
  const suffix = value.slice(-4);
  return `${prefix}…${suffix}`;
}
