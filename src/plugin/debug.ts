/**
 * Logging helpers with secret redaction.
 *
 * Everything that may surface in OpenCode logs MUST go through `redact()` first.
 * We never want a Kiro API key (`ksk_...`), bearer token, or AWS SSO JSON token
 * to reach disk or stdout in plain text.
 */

const REDACTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Kiro API keys: documented prefix is `ksk_`, but be defensive against future
  // prefixes that look like `kak_`, `kpk_`, etc.
  { name: "kiro-api-key", regex: /\bk[a-z]{2}_[A-Za-z0-9_-]{16,}\b/g },
  // Generic Bearer tokens.
  { name: "bearer", regex: /Bearer\s+[A-Za-z0-9._\-]+/g },
  // AWS SSO style JWT-ish tokens (three dot-separated base64 chunks).
  { name: "jwt", regex: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Common OAuth refresh token fields when serialized as JSON.
  { name: "json-token", regex: /"(?:access_token|refresh_token|id_token|api_key|apiKey)"\s*:\s*"[^"]+"/g },
];

/**
 * Redact secrets in any string. Always returns a string; non-string input is
 * stringified through `String()` first.
 */
export function redact(input: unknown): string {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof Error) text = `${input.name}: ${input.message}`;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }

  for (const { regex } of REDACTION_PATTERNS) {
    text = text.replace(regex, "[REDACTED]");
  }
  return text;
}

/**
 * Redact a record-like object, preserving the structure but masking known
 * sensitive keys regardless of their value shape.
 */
export function redactRecord(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  const sensitiveKeys = new Set([
    "apikey",
    "api_key",
    "kiro_api_key",
    "authorization",
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "password",
    "secret",
  ]);
  for (const [k, v] of Object.entries(input)) {
    if (sensitiveKeys.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (typeof v === "string") out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): LogLevel {
  const raw = (process.env.KIRO_PLUGIN_LOG ?? process.env.OPENCODE_KIRO_LOG ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "warn";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[activeLevel()];
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope: "opencode-kiro-plugin",
    message: redact(message),
    ...(meta ? redactRecord(meta) : {}),
  };
  // Use stderr for warn/error so they do not pollute model stdout if anything
  // captures the plugin's output as a stream.
  const stream = level === "warn" || level === "error" ? console.error : console.log;
  stream(JSON.stringify(payload));
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
