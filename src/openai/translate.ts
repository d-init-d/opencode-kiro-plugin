/**
 * Translate OpenAI Chat Completions <-> AI SDK v3 LanguageModel prompt/results.
 *
 * We deliberately do not import the concrete `LanguageModelV3` types from
 * `@ai-sdk/provider` here so the plugin keeps building even if the upstream
 * surface area changes minor things. Instead we work against the small set of
 * shapes we actually use, defined in `kiro/provider.ts`.
 *
 * What the AI SDK v3 prompt shape looks like (subset we produce):
 *   - system:     { role: 'system', content: string }
 *   - user:       { role: 'user', content: Array<TextPart | FilePart> }
 *   - assistant:  { role: 'assistant', content: Array<TextPart | ToolCallPart> }
 *   - tool:       { role: 'tool', content: Array<ToolResultPart> }
 */
import type {
  ChatCompletionRequest,
  ChatMessage,
  ContentPart,
  ToolCallWire,
  ToolDefinition,
  ToolChoice,
  ChatCompletionResponse,
  ChatCompletionUsage,
} from "./schema.js";

// ---------- AI SDK v3 prompt shape (local mirror) ----------

export interface AiTextPart {
  type: "text";
  text: string;
}

export interface AiFilePart {
  type: "file";
  /** base64 string OR URL string. */
  data: string;
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
}

export interface AiToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Parsed JSON value. */
  input: unknown;
}

export interface AiToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output:
    | { type: "text"; value: string }
    | { type: "json"; value: unknown }
    | { type: "error-text"; value: string };
}

export type AiUserContentPart = AiTextPart | AiFilePart;
export type AiAssistantContentPart = AiTextPart | AiToolCallPart;

export type AiSystemMessage = { role: "system"; content: string };
export type AiUserMessage = { role: "user"; content: AiUserContentPart[] };
export type AiAssistantMessage = { role: "assistant"; content: AiAssistantContentPart[] };
export type AiToolMessage = { role: "tool"; content: AiToolResultPart[] };

export type AiPromptMessage = AiSystemMessage | AiUserMessage | AiAssistantMessage | AiToolMessage;

export interface AiToolDefinition {
  type: "function";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type AiToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

export interface AiCallOptions {
  prompt: AiPromptMessage[];
  tools?: AiToolDefinition[];
  toolChoice?: AiToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  responseFormat?:
    | { type: "text" }
    | { type: "json"; schema?: Record<string, unknown> };
}

// ---------- OpenAI -> AI SDK ----------

function textOnly(content: string | Array<{ type: "text"; text: string }>): string {
  if (typeof content === "string") return content;
  return content.map((p) => p.text).join("");
}

function parseToolArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Models occasionally emit non-JSON or partial JSON. Falling back to a raw
    // string preserves information rather than throwing.
    return { _raw: raw };
  }
}

function dataUrlToFilePart(url: string): AiFilePart {
  // data:image/png;base64,AAAA
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/i.exec(url);
  if (!match) {
    return { type: "file", data: url, mediaType: "application/octet-stream" };
  }
  const mediaType = match[1] ?? "application/octet-stream";
  const payload = match[2] ?? "";
  return { type: "file", data: payload, mediaType };
}

function userPart(part: ContentPart): AiUserContentPart | null {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    const raw = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
    if (!raw) return null;
    if (raw.startsWith("data:")) return dataUrlToFilePart(raw);
    return { type: "file", data: raw, mediaType: "image/*" };
  }
  if (part.type === "input_audio") {
    return {
      type: "file",
      data: part.input_audio.data,
      mediaType: `audio/${part.input_audio.format}`,
    };
  }
  return null;
}

function toolCallToAi(call: ToolCallWire): AiToolCallPart {
  return {
    type: "tool-call",
    toolCallId: call.id,
    toolName: call.function.name,
    input: parseToolArgs(call.function.arguments),
  };
}

/**
 * Convert OpenAI-style messages into AI SDK v3 prompt messages. We collapse
 * adjacent system messages into a single one because some upstream providers
 * (including Kiro ACP) expect a single system block.
 */
export function messagesToPrompt(messages: ChatMessage[]): AiPromptMessage[] {
  const out: AiPromptMessage[] = [];
  let pendingSystem: string[] = [];

  const flushSystem = () => {
    if (pendingSystem.length === 0) return;
    out.push({ role: "system", content: pendingSystem.join("\n\n") });
    pendingSystem = [];
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      pendingSystem.push(textOnly(msg.content));
      continue;
    }
    flushSystem();

    if (msg.role === "user") {
      const parts: AiUserContentPart[] = [];
      if (typeof msg.content === "string") {
        parts.push({ type: "text", text: msg.content });
      } else {
        for (const p of msg.content) {
          const mapped = userPart(p);
          if (mapped) parts.push(mapped);
        }
      }
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({ role: "user", content: parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: AiAssistantContentPart[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) parts.push({ type: "text", text: p.text });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) parts.push(toolCallToAi(tc));
      }
      // AI SDK requires non-empty content; insert empty text if assistant only
      // emitted tool calls and nothing else, which is fine.
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({ role: "assistant", content: parts });
      continue;
    }

    if (msg.role === "tool") {
      const text = textOnly(msg.content);
      let value: unknown = text;
      let outputType: AiToolResultPart["output"]["type"] = "text";
      try {
        const parsed = JSON.parse(text);
        value = parsed;
        outputType = "json";
      } catch {
        // keep as text
      }
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id,
            // AI SDK requires toolName, but OpenAI's tool message omits it.
            // Use a placeholder; downstream provider tolerates this in practice
            // because it correlates by toolCallId.
            toolName: "unknown",
            output:
              outputType === "json"
                ? { type: "json", value }
                : { type: "text", value: text },
          },
        ],
      });
      continue;
    }
  }
  flushSystem();
  return out;
}

export function toolsToAi(tools: ToolDefinition[] | undefined): AiToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    inputSchema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

export function toolChoiceToAi(choice: ToolChoice | undefined): AiToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "required" };
  return { type: "tool", toolName: choice.function.name };
}

export function requestToCallOptions(req: ChatCompletionRequest): AiCallOptions {
  const stopSequences = req.stop === undefined ? undefined : Array.isArray(req.stop) ? req.stop : [req.stop];
  const opts: AiCallOptions = {
    prompt: messagesToPrompt(req.messages),
  };
  const tools = toolsToAi(req.tools);
  if (tools) opts.tools = tools;
  const toolChoice = toolChoiceToAi(req.tool_choice);
  if (toolChoice) opts.toolChoice = toolChoice;
  const maxOut = req.max_completion_tokens ?? req.max_tokens;
  if (maxOut !== undefined) opts.maxOutputTokens = maxOut;
  if (req.temperature !== undefined) opts.temperature = req.temperature;
  if (req.top_p !== undefined) opts.topP = req.top_p;
  if (req.presence_penalty !== undefined) opts.presencePenalty = req.presence_penalty;
  if (req.frequency_penalty !== undefined) opts.frequencyPenalty = req.frequency_penalty;
  if (req.seed !== undefined) opts.seed = req.seed;
  if (stopSequences) opts.stopSequences = stopSequences;
  if (req.response_format?.type === "json_object" || req.response_format?.type === "json_schema") {
    opts.responseFormat = {
      type: "json",
      ...(req.response_format.json_schema ? { schema: req.response_format.json_schema } : {}),
    };
  }
  return opts;
}

// ---------- AI SDK -> OpenAI ----------

export type AiFinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other"
  | "unknown";

export function finishReasonToOpenAI(reason: AiFinishReason | string | undefined): ChatCompletionResponse["choices"][number]["finish_reason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    case "error":
    case "other":
    case "unknown":
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

export interface AiUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
}

export function usageToOpenAI(usage: AiUsage | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  const prompt = normalizeTokenCount(usage.inputTokens) ?? 0;
  const completion = normalizeTokenCount(usage.outputTokens) ?? 0;
  const total = normalizeTokenCount(usage.totalTokens) ?? prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

/**
 * kiro-acp-ai-provider sometimes returns token counts as objects like
 * `{ total: 313093, noCache: 313093 }` instead of plain numbers. Normalize
 * to a plain number so downstream validators (OpenCode's @ai-sdk/openai-compatible)
 * don't reject the chunk.
 */
function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["total"] === "number") return obj["total"];
    // Fallback: sum all numeric values.
    let sum = 0;
    let found = false;
    for (const v of Object.values(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        found = true;
        break; // Take the first numeric value as the count.
      }
    }
    if (found) return sum;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export interface AiContent {
  type: "text" | "tool-call" | "reasoning" | string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

/**
 * Build a non-streaming OpenAI response payload from the AI SDK
 * `doGenerate()` result we modeled internally.
 */
export function buildChatCompletionResponse(args: {
  id: string;
  model: string;
  content: AiContent[];
  finishReason: AiFinishReason | string | undefined;
  usage?: AiUsage;
  created?: number;
}): ChatCompletionResponse {
  const { id, model, content, finishReason, usage, created } = args;
  const textChunks: string[] = [];
  const toolCalls: ToolCallWire[] = [];

  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      textChunks.push(part.text);
    } else if (part.type === "tool-call" && part.toolCallId && part.toolName) {
      toolCalls.push({
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        },
      });
    }
    // reasoning parts are dropped from the OpenAI surface; we could surface
    // them under a custom field later if needed.
  }

  return {
    id,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReasonToOpenAI(finishReason),
        message: {
          role: "assistant",
          content: textChunks.length > 0 ? textChunks.join("") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    ...(usage ? { usage: usageToOpenAI(usage) ?? undefined } : {}),
  } as ChatCompletionResponse;
}
