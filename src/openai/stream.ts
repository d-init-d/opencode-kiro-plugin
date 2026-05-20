/**
 * Convert AI SDK v3 stream parts into OpenAI-compatible SSE chunks.
 *
 * AI SDK v3 emits parts roughly like:
 *   { type: 'text-start',   id }
 *   { type: 'text-delta',   id, delta }
 *   { type: 'text-end',     id }
 *   { type: 'tool-input-start', id, toolName }
 *   { type: 'tool-input-delta', id, delta }   // delta is JSON string fragment
 *   { type: 'tool-input-end',   id }
 *   { type: 'tool-call', toolCallId, toolName, input }
 *   { type: 'finish', finishReason, usage }
 *   { type: 'error', error }
 *
 * We do not depend on the exact import path because the upstream API is still
 * settling. Instead we duck-type on `part.type`.
 */
import type { AiFinishReason, AiUsage } from "./translate.js";
import { finishReasonToOpenAI, usageToOpenAI } from "./translate.js";
import type { ChatCompletionStreamChunk } from "./schema.js";

export interface AiStreamPart {
  type: string;
  id?: string;
  delta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  finishReason?: AiFinishReason | string;
  usage?: AiUsage;
  error?: unknown;
}

export interface ToOpenAiStreamArgs {
  id: string;
  model: string;
  source: AsyncIterable<AiStreamPart>;
  /** Optional override for the `created` field. */
  created?: number;
}

const ENC = new TextEncoder();

function sseLine(obj: unknown): Uint8Array {
  return ENC.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseDone(): Uint8Array {
  return ENC.encode("data: [DONE]\n\n");
}

interface ToolCallChannel {
  /** Index in the OpenAI `tool_calls` array. */
  index: number;
  emittedHeader: boolean;
  toolName?: string;
  /** Tracked so we never re-emit the function name once the header is sent. */
  closed: boolean;
}

/**
 * Build a ReadableStream that emits OpenAI-compatible SSE events derived from
 * an AI SDK v3 part stream. The function never throws synchronously; errors
 * become `error` SSE events followed by `[DONE]`.
 */
export function toOpenAiSseStream(args: ToOpenAiStreamArgs): ReadableStream<Uint8Array> {
  const { id, model, source } = args;
  const created = args.created ?? Math.floor(Date.now() / 1000);
  const baseChunk = {
    id,
    object: "chat.completion.chunk" as const,
    created,
    model,
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let started = false;
      const startIfNeeded = () => {
        if (started) return;
        started = true;
        const firstChunk: ChatCompletionStreamChunk = {
          ...baseChunk,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        };
        controller.enqueue(sseLine(firstChunk));
      };

      const toolChannels = new Map<string, ToolCallChannel>();
      let nextToolIndex = 0;

      const ensureToolChannel = (key: string, toolName?: string): ToolCallChannel => {
        let ch = toolChannels.get(key);
        if (!ch) {
          ch = { index: nextToolIndex++, emittedHeader: false, closed: false };
          if (toolName !== undefined) ch.toolName = toolName;
          toolChannels.set(key, ch);
        } else if (toolName && !ch.toolName) {
          ch.toolName = toolName;
        }
        return ch;
      };

      const emitToolHeader = (key: string) => {
        const ch = toolChannels.get(key);
        if (!ch || ch.emittedHeader) return;
        ch.emittedHeader = true;
        const chunk: ChatCompletionStreamChunk = {
          ...baseChunk,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: ch.index,
                    id: key,
                    type: "function",
                    function: { name: ch.toolName ?? "", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(sseLine(chunk));
      };

      try {
        for await (const part of source) {
          startIfNeeded();
          switch (part.type) {
            case "text-start":
            case "text-end":
            case "stream-start":
              // Marker only; no SSE delta.
              break;
            case "reasoning-start": {
              // Begin a reasoning/thinking block. Emit role if not yet sent,
              // then start the italic markdown prefix so older OpenCode versions
              // (1.2.x) that don't understand reasoning_content still see it.
              startIfNeeded();
              const startChunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [{
                  index: 0,
                  delta: { content: "\n*Thought: " },
                  finish_reason: null,
                }],
              };
              controller.enqueue(sseLine(startChunk));
              break;
            }
            case "reasoning-delta": {
              // Kiro thinking content — emit as plain content (italic markdown)
              // for compatibility with OpenCode 1.2.x which doesn't render
              // reasoning_content. Newer versions will still show it inline.
              const reasoningText = part.delta ?? "";
              if (!reasoningText) break;
              startIfNeeded();
              const reasoningChunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [{
                  index: 0,
                  delta: { content: reasoningText },
                  finish_reason: null,
                }],
              };
              controller.enqueue(sseLine(reasoningChunk));
              break;
            }
            case "reasoning-end": {
              // Close the italic markdown block with a newline separator.
              startIfNeeded();
              const endChunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [{
                  index: 0,
                  delta: { content: "*\n\n" },
                  finish_reason: null,
                }],
              };
              controller.enqueue(sseLine(endChunk));
              break;
            }
            case "text-delta": {
              const delta = part.delta ?? part.text ?? "";
              if (!delta) break;
              const chunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              };
              controller.enqueue(sseLine(chunk));
              break;
            }
            case "tool-input-start": {
              const key = part.id ?? part.toolCallId ?? `tool-${nextToolIndex}`;
              ensureToolChannel(key, part.toolName);
              emitToolHeader(key);
              break;
            }
            case "tool-input-delta": {
              const key = part.id ?? part.toolCallId ?? "";
              if (!key) break;
              const ch = ensureToolChannel(key);
              if (!ch.emittedHeader) emitToolHeader(key);
              const delta = part.delta ?? "";
              if (!delta) break;
              const chunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: ch.index,
                          function: { arguments: delta },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(sseLine(chunk));
              break;
            }
            case "tool-input-end": {
              const key = part.id ?? part.toolCallId ?? "";
              const ch = key ? toolChannels.get(key) : undefined;
              if (ch) ch.closed = true;
              break;
            }
            case "tool-call": {
              const key = part.toolCallId ?? `tool-${nextToolIndex}`;
              const ch = ensureToolChannel(key, part.toolName);
              if (!ch.emittedHeader) {
                // Emit a single chunk that contains the entire tool call when
                // the provider only emits the consolidated `tool-call` event.
                ch.emittedHeader = true;
                const argString =
                  typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
                const chunk: ChatCompletionStreamChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: ch.index,
                            id: key,
                            type: "function",
                            function: { name: ch.toolName ?? "", arguments: argString },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(sseLine(chunk));
              }
              ch.closed = true;
              break;
            }
            case "finish": {
              const usage = usageToOpenAI(part.usage);
              const finalChunk: ChatCompletionStreamChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: finishReasonToOpenAI(part.finishReason),
                  },
                ],
                ...(usage ? { usage } : {}),
              };
              controller.enqueue(sseLine(finalChunk));
              break;
            }
            case "error": {
              const message =
                part.error instanceof Error
                  ? part.error.message
                  : typeof part.error === "string"
                    ? part.error
                    : "Upstream Kiro error";
              const errorChunk = {
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
                error: { message, type: "kiro_upstream_error" },
              };
              controller.enqueue(sseLine(errorChunk));
              break;
            }
            default:
              // Ignore unknown part types defensively.
              break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream failed";
        const errorChunk = {
          ...baseChunk,
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
          ],
          error: { message, type: "kiro_stream_error" },
        };
        controller.enqueue(sseLine(errorChunk));
      } finally {
        controller.enqueue(sseDone());
        controller.close();
      }
    },
  });
}
