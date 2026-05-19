/**
 * Classify upstream Kiro errors so the rotation layer knows whether to
 * retry on a different account, disable the current one, or fail fast.
 *
 * `kiro-acp-ai-provider` doesn't expose a stable error code surface, so we
 * inspect both structured fields (when present) and the human message text.
 * The classification is intentionally conservative — when in doubt we mark
 * the error as `transient` so the user gets a chance on another account
 * before we give up.
 */

export type KiroErrorKind =
  | "rate_limit"      // 429-style: account is throttled, cool it down for a while
  | "auth"            // 401/403: account token is bad; mark for review, do not auto-retry
  | "quota_exceeded"  // explicit "quota" exhaustion (longer cooldown than rate limit)
  | "transient"       // 5xx, ECONNRESET, fetch failed, etc. — short cooldown, try next
  | "client_error"    // 4xx other than auth/rate — usually a request bug; do not retry
  | "unknown";        // catch-all; treat as short cooldown

export interface ClassifiedError {
  kind: KiroErrorKind;
  /** Human-readable, redaction-safe summary suitable for logs / status. */
  message: string;
  /** HTTP status when we managed to extract one. */
  status?: number;
}

interface ErrorLike {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
  responseBody?: unknown;
  data?: { error?: { type?: unknown; code?: unknown; message?: unknown } };
  error?: { type?: unknown; code?: unknown; message?: unknown };
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function deepText(err: ErrorLike): string {
  const parts: string[] = [];
  const push = (s: unknown) => {
    const t = asString(s);
    if (t) parts.push(t);
  };
  push(err.message);
  push(err.name);
  push(err.code);
  if (err.error) {
    push(err.error.message);
    push(err.error.type);
    push(err.error.code);
  }
  if (err.data?.error) {
    push(err.data.error.message);
    push(err.data.error.type);
    push(err.data.error.code);
  }
  push(err.responseBody);
  if (err.cause && typeof err.cause === "object") {
    parts.push(deepText(err.cause as ErrorLike));
  }
  return parts.join(" | ").toLowerCase();
}

function deepStatus(err: ErrorLike): number | undefined {
  const direct = asNumber(err.status) ?? asNumber(err.statusCode);
  if (direct) return direct;
  if (err.cause && typeof err.cause === "object") {
    return deepStatus(err.cause as ErrorLike);
  }
  return undefined;
}

const RATE_LIMIT_HINTS = [
  "rate limit",
  "rate-limited",
  "rate_limited",
  "ratelimit",
  "too many requests",
  "throttled",
  "throttling",
  "request_throttled",
  "exceeded the rate",
];

const QUOTA_HINTS = [
  "quota exceeded",
  "out of quota",
  "insufficient_quota",
  "quota_exhausted",
  "monthly limit",
  "billing",
  "credits exhausted",
];

const AUTH_HINTS = [
  "unauthorized",
  "invalid api key",
  "invalid_api_key",
  "authentication failed",
  "auth failed",
  "forbidden",
  "permission denied",
  "not authorized",
  "expired token",
  "token expired",
  "invalid_grant",
  "session expired",
  "please log in",
  "kiro-cli login",
];

const TRANSIENT_HINTS = [
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "fetch failed",
  "socket hang up",
  "network error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error",
  "upstream",
  "temporarily",
  "try again later",
];

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

export function classifyKiroError(rawError: unknown): ClassifiedError {
  if (!rawError) {
    return { kind: "unknown", message: "Unknown error (no payload)" };
  }
  const err = (typeof rawError === "object" ? rawError : { message: String(rawError) }) as ErrorLike;
  const text = deepText(err);
  const status = deepStatus(err);
  const summary = (asString(err.message) ?? text ?? "Kiro upstream error").slice(0, 240);

  // Status-driven path first; it is the most reliable signal.
  if (status !== undefined) {
    if (status === 429) return { kind: "rate_limit", message: summary, status };
    if (status === 402) return { kind: "quota_exceeded", message: summary, status };
    if (status === 401 || status === 403) return { kind: "auth", message: summary, status };
    if (status >= 500 && status < 600) return { kind: "transient", message: summary, status };
    if (status >= 400 && status < 500) return { kind: "client_error", message: summary, status };
  }

  if (matchesAny(text, RATE_LIMIT_HINTS)) return { kind: "rate_limit", message: summary, ...(status ? { status } : {}) };
  if (matchesAny(text, QUOTA_HINTS)) return { kind: "quota_exceeded", message: summary, ...(status ? { status } : {}) };
  if (matchesAny(text, AUTH_HINTS)) return { kind: "auth", message: summary, ...(status ? { status } : {}) };
  if (matchesAny(text, TRANSIENT_HINTS)) return { kind: "transient", message: summary, ...(status ? { status } : {}) };

  return { kind: "unknown", message: summary, ...(status ? { status } : {}) };
}

/**
 * Whether the rotation layer should attempt another account after seeing this
 * error. `auth` and `client_error` are intentionally NOT retried because they
 * usually indicate a permanent account problem or a malformed request.
 */
export function isRetryable(kind: KiroErrorKind): boolean {
  return kind === "rate_limit" || kind === "quota_exceeded" || kind === "transient" || kind === "unknown";
}
