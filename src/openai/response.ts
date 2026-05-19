/**
 * Helpers for building OpenAI-style success and error Response objects.
 */

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    code?: string | null;
    param?: string | null;
  };
}

export function buildErrorResponse(args: {
  status: number;
  type: string;
  message: string;
  code?: string;
  param?: string;
}): Response {
  const body: OpenAIErrorBody = {
    error: {
      message: args.message,
      type: args.type,
      code: args.code ?? null,
      param: args.param ?? null,
    },
  };
  return new Response(JSON.stringify(body), {
    status: args.status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Generate a `chatcmpl-...` style id without depending on `crypto.randomUUID`
 * since older runtimes may not have it on `globalThis`.
 */
export function makeCompletionId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `chatcmpl-${hex}`;
}
