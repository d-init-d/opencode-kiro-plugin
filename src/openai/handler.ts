/**
 * In-process handler for OpenAI-compatible Kiro requests.
 *
 * `auth.loader.fetch` calls `handleOpenAICompatibleRequest()` whenever the
 * synthetic Kiro base URL is hit. This is the single entry point for the
 * adapter; everything below stays pure so it is testable without OpenCode.
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
import { getProvider, type KiroAuthContext } from "../kiro/provider.js";
import { SYNTHETIC_HOST } from "../constants.js";
import { log } from "../plugin/debug.js";

export interface HandlerContext {
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

  let provider;
  try {
    provider = await getProvider(ctx.auth);
  } catch (err) {
    log.error("Lấy Kiro provider thất bại", { error: String(err) });
    return buildErrorResponse({
      status: 500,
      type: "kiro_unavailable",
      message: err instanceof Error ? err.message : "Không khởi tạo được Kiro provider.",
    });
  }

  let model;
  try {
    model = await provider.getModel(requestBody.model);
  } catch (err) {
    return buildErrorResponse({
      status: 400,
      type: "invalid_model",
      message: err instanceof Error ? err.message : `Model '${requestBody.model}' không hợp lệ.`,
    });
  }

  const completionId = makeCompletionId();

  if (wantsStream) {
    let streamSource;
    try {
      streamSource = await model.doStream(callOptions);
    } catch (err) {
      log.warn("doStream() lỗi", { error: String(err) });
      return buildErrorResponse({
        status: 502,
        type: "kiro_upstream_error",
        message: err instanceof Error ? err.message : "Kiro upstream từ chối stream.",
      });
    }
    const sse = toOpenAiSseStream({
      id: completionId,
      model: requestBody.model,
      source: streamSource.stream,
    });
    return buildSseResponse(sse);
  }

  try {
    const result = await model.doGenerate(callOptions);
    const response = buildChatCompletionResponse({
      id: completionId,
      model: requestBody.model,
      content: result.content,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
    });
    return buildJsonResponse(response);
  } catch (err) {
    log.warn("doGenerate() lỗi", { error: String(err) });
    return buildErrorResponse({
      status: 502,
      type: "kiro_upstream_error",
      message: err instanceof Error ? err.message : "Kiro upstream lỗi.",
    });
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

  // Strip leading `/v1` if present so we accept both `/v1/models` and
  // `/models` for forward compatibility.
  const path = url.pathname.replace(/^\/v1/, "") || "/";

  if (path === "/models" || path === "/models/") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return handleModels(request);
  }

  if (path === "/chat/completions" || path === "/chat/completions/") {
    return handleChatCompletions(request, context);
  }

  // `health` is a non-standard convenience endpoint. Useful when running
  // smoke tests against the interceptor.
  if (path === "/health") {
    return buildJsonResponse({ ok: true });
  }

  return notFound();
}
