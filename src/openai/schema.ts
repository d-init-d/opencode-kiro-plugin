/**
 * Zod schemas for OpenAI Chat Completions request/response.
 *
 * We support a permissive subset that matches what `@ai-sdk/openai-compatible`
 * actually emits, plus a couple of extensions used by OpenCode (e.g. tool
 * definitions). Anything we accept here must also be translatable in
 * `openai/translate.ts`.
 */
import { z } from "zod";

// ---------- Content parts ----------

export const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ImageUrlPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.union([
    z.string(),
    z.object({
      url: z.string(),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  ]),
});

export const InputAudioPartSchema = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.string(),
  }),
});

export const ContentPartSchema = z.union([TextPartSchema, ImageUrlPartSchema, InputAudioPartSchema]);

// ---------- Tool calls ----------

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    /** Stringified JSON in OpenAI's wire format. */
    arguments: z.string(),
  }),
});

// ---------- Messages ----------

const BaseMessage = {
  name: z.string().optional(),
};

export const SystemMessageSchema = z.object({
  ...BaseMessage,
  role: z.literal("system"),
  content: z.union([z.string(), z.array(TextPartSchema)]),
});

export const UserMessageSchema = z.object({
  ...BaseMessage,
  role: z.literal("user"),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
});

export const AssistantMessageSchema = z.object({
  ...BaseMessage,
  role: z.literal("assistant"),
  content: z.union([z.string(), z.array(TextPartSchema), z.null()]).optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  refusal: z.string().nullish(),
});

export const ToolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string(),
  content: z.union([z.string(), z.array(TextPartSchema)]),
});

export const ChatMessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

// ---------- Tool definitions ----------

export const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

export const ToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);

// ---------- Request ----------

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]).optional(),
      json_schema: z.record(z.unknown()).optional(),
    })
    .optional(),
  user: z.string().optional(),
  // Client-defined metadata we forward verbatim if the underlying provider takes it.
  metadata: z.record(z.unknown()).optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
export type ToolCallWire = z.infer<typeof ToolCallSchema>;

// ---------- Response (non-stream) ----------

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCallWire[];
    refusal?: string | null;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

// ---------- Response (stream chunk) ----------

export interface ChatCompletionStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: ChatCompletionChoice["finish_reason"] | null;
  }>;
  usage?: ChatCompletionUsage;
}
