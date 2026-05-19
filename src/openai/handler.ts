/**
 * In-process handler for OpenAI-compatible Kiro requests.
 *
 * `auth.loader.fetch` calls `handleOpenAICompatibleRequest()` whenever the
 * synthetic Kiro base URL is hit. This is the single entry point for the
 * adapter; everything below stays pure so it is testable without OpenCode.
 *
 * All upstream calls go through the rotation orchestrator, which:
 *   - Picks an eligible account from `kiro-accounts.json`.
 *   - Retries with the next account on rate-limit / quota / transient errors.
 *   - Surfaces auth/client errors verbatim (no silent retries).
 */
import { z } from "zod";
import { ChatCompletionRequestSchema } from "./schema.js";
import {
  buildErrorResponse,
  buildJsonResponse,
  buildSseResponse,
  makeCompletionId,
} from "./response.js";
import { buildChatCompletionResponse, requestToCallOptions } from "./translate.js";
import { toOpenAiSseStream } from "./stream.js";
import { buildModelListResponse } from "../kiro/models.js";
import type { KiroAuthContext } from "../kiro/provider.js";
import { SYNTHETIC_HOST } from "../constants.js";
import { log } from "../plugin/debug.js";
import {
  AllAccountsExhaustedError,
  NoAccountsConfiguredError,
  generateWithRotation,
  streamWithRotation,
} from "../auth/rotator.js";

export interface HandlerContext {
  /**
   * Auth derived from OpenCode's auth hook. The rotator only consults this
   * when the persistent account store is empty (back-compat mode).
   */
  auth: KiroAuthContext;
}

function notFound(): Response {
  return buildErrorResponse({
    status: 404,
    type: "not_found",
    message: "Endpoint không tồn tại trên Kiro plugin.",
  });
}

function methodNotAllowed(allowed: string): Response {
  return buildErrorResponse({
    status: 405,
    type: "method_not_allowed",
    message: `Method không được hỗ trợ. Dùng ${allowed}.`,
  });
}

function isSyntheticUrl(url: URL): boolean {
  return url.hostname.toLowerCase() === SYNTHETIC_HOST;
}

function describeZodError(error: z.ZodError): string {
  return error.errors
    .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
    .join("; ");
}

async function handleModels(_req: Request): Promise<Response> {
  const payload = await buildModelListResponse();
  return buildJsonResponse(payload);
}

function rotationErrorToResponse(err: unknown): Response {
  if (err instanceof NoAccountsConfiguredError) {
    return buildErrorResponse({
      status: 401,
      type: "no_accounts_configured",
      message: err.message,
    });
  }
  if (err instanceof AllAccountsExhaustedError) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (err.waitMs && err.waitMs > 0) {
      headers["Retry-After"] = String(Math.ceil(err.waitMs / 1000));
    }
    const body = {
      error: {
        type: "kiro_all_accounts_exhausted",
        message: err.message,
        code: null as string | null,
        param: null as string | null,
        attempts: err.attempts.map((a) => ({
          account: a.accountLabel,
          kind: a.error.kind,
          message: a.error.message,
        })),
      },
    };
    return new Response(JSON.stringify(body), {
      status: 429,
      headers,
    });
  }
  log.warn("Kiro request failed", { error: String(err) });
  return buildErrorResponse({
    status: 502,
    type: "kiro_upstream_error",
    message: err instanceof Error ? err.message : "Kiro upstream lỗi.",
  });
}

async function handleChatCompletions(req: Request, ctx: HandlerContext): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return buildErrorResponse({
      status: 400,
      type: "invalid_request_error",
      message: "Body không phải JSON hợp lệ.",
    });
  }

  const parsed = ChatCompletionRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return buildErrorResponse({
      status: 400,
      type: "invalid_request_error",
      message: `Request không hợp lệ: ${describeZodError(parsed.error)}`,
    });
  }
  const requestBody = parsed.data;
  const wantsStream = requestBody.stream === true;
  const callOptions = requestToCallOptions(requestBody);
  const completionId = makeCompletionId();

  if (wantsStream) {
    try {
      const { stream } = await streamWithRotation({
        modelId: requestBody.model,
        callOptions,
        ctxFromAuthHook: ctx.auth,
      });
      const sse = toOpenAiSseStream({
        id: completionId,
        model: requestBody.model,
        source: stream,
      });
      return buildSseResponse(sse);
    } catch (err) {
      return rotationErrorToResponse(err);
    }
  }

  try {
    const { result } = await generateWithRotation({
      modelId: requestBody.model,
      callOptions,
      ctxFromAuthHook: ctx.auth,
    });
    const response = buildChatCompletionResponse({
      id: completionId,
      model: requestBody.model,
      content: result.content,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    return buildJsonResponse(response);
  } catch (err) {
    return rotationErrorToResponse(err);
  }
}

/**
 * Public entry. Returns `undefined` when the request URL is not aimed at the
 * synthetic host, so callers can fall through to whatever default fetch
 * behavior they want.
 */
export async function handleOpenAICompatibleRequest(
  request: Request,
  context: HandlerContext
): Promise<Response | undefined> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  if (!isSyntheticUrl(url)) return undefined;

  const path = url.pathname.replace(/^\/v1/, "") || "/";

  if (path === "/models" || path === "/models/") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return handleModels(request);
  }

  if (path === "/chat/completions" || path === "/chat/completions/") {
    return handleChatCompletions(request, context);
  }

  if (path === "/health") {
    return buildJsonResponse({ ok: true });
  }

  return notFound();
}
