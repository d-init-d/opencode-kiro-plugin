import { describe, it, expect } from "vitest";
import {
  messagesToPrompt,
  toolsToAi,
  toolChoiceToAi,
  requestToCallOptions,
  buildChatCompletionResponse,
  finishReasonToOpenAI,
  usageToOpenAI,
} from "../src/openai/translate.js";
import type { ChatCompletionRequest } from "../src/openai/schema.js";

describe("messagesToPrompt", () => {
  it("merges multiple system messages into one block", () => {
    const result = messagesToPrompt([
      { role: "system", content: "you are helpful" },
      { role: "system", content: "respond in vietnamese" },
      { role: "user", content: "xin chào" },
    ]);
    expect(result[0]).toEqual({ role: "system", content: "you are helpful\n\nrespond in vietnamese" });
    expect(result[1]?.role).toBe("user");
  });

  it("converts text-only user messages", () => {
    const result = messagesToPrompt([{ role: "user", content: "hi" }]);
    expect(result[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("converts mixed content user messages with image_url", () => {
    const result = messagesToPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    expect(result[0]?.role).toBe("user");
    if (result[0]?.role !== "user") throw new Error("expected user");
    expect(result[0]?.content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(result[0]?.content[1]).toEqual({ type: "file", data: "AAAA", mediaType: "image/png" });
  });

  it("preserves assistant tool_calls", () => {
    const result = messagesToPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"hi"}' } },
        ],
      },
    ]);
    expect(result[0]?.role).toBe("assistant");
    if (result[0]?.role !== "assistant") throw new Error("expected assistant");
    const lastPart = result[0]?.content[result[0].content.length - 1];
    expect(lastPart).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "search",
      input: { q: "hi" },
    });
  });

  it("converts tool messages with JSON output", () => {
    const result = messagesToPrompt([
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
    ]);
    expect(result[0]?.role).toBe("tool");
    if (result[0]?.role !== "tool") throw new Error("expected tool");
    const part = result[0]?.content[0];
    expect(part).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "unknown",
      output: { type: "json", value: { ok: true } },
    });
  });

  it("falls back to {_raw: ...} when assistant arguments are not JSON", () => {
    const result = messagesToPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "x", arguments: "not json" } },
        ],
      },
    ]);
    if (result[0]?.role !== "assistant") throw new Error("expected assistant");
    const last = result[0].content[result[0].content.length - 1];
    if (last?.type !== "tool-call") throw new Error("expected tool-call part");
    expect(last.input).toEqual({ _raw: "not json" });
  });
});

describe("toolsToAi & toolChoiceToAi", () => {
  it("maps function tools to AI SDK shape", () => {
    const tools = toolsToAi([
      {
        type: "function",
        function: {
          name: "search",
          description: "search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "search the web",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });

  it("returns undefined for empty tools array", () => {
    expect(toolsToAi([])).toBeUndefined();
    expect(toolsToAi(undefined)).toBeUndefined();
  });

  it("maps tool choices", () => {
    expect(toolChoiceToAi("auto")).toEqual({ type: "auto" });
    expect(toolChoiceToAi("none")).toEqual({ type: "none" });
    expect(toolChoiceToAi("required")).toEqual({ type: "required" });
    expect(toolChoiceToAi({ type: "function", function: { name: "search" } })).toEqual({
      type: "tool",
      toolName: "search",
    });
    expect(toolChoiceToAi(undefined)).toBeUndefined();
  });
});

describe("requestToCallOptions", () => {
  it("populates max output tokens, temperature, top_p", () => {
    const req: ChatCompletionRequest = {
      model: "claude-opus-4.6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      temperature: 0.5,
      top_p: 0.9,
    };
    const opts = requestToCallOptions(req);
    expect(opts.maxOutputTokens).toBe(256);
    expect(opts.temperature).toBe(0.5);
    expect(opts.topP).toBe(0.9);
  });

  it("prefers max_completion_tokens over max_tokens", () => {
    const opts = requestToCallOptions({
      model: "claude-opus-4.6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      max_completion_tokens: 128,
    });
    expect(opts.maxOutputTokens).toBe(128);
  });

  it("normalizes stop string and array", () => {
    const a = requestToCallOptions({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      stop: "###",
    });
    const b = requestToCallOptions({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      stop: ["###", "END"],
    });
    expect(a.stopSequences).toEqual(["###"]);
    expect(b.stopSequences).toEqual(["###", "END"]);
  });

  it("forwards json response format", () => {
    const opts = requestToCallOptions({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "T", schema: { type: "object" } } },
    });
    expect(opts.responseFormat?.type).toBe("json");
  });
});

describe("buildChatCompletionResponse", () => {
  it("emits text content and finish reason", () => {
    const r = buildChatCompletionResponse({
      id: "chatcmpl-x",
      model: "claude-opus-4.6",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(r.choices[0]?.message.content).toBe("hello");
    expect(r.choices[0]?.finish_reason).toBe("stop");
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("emits tool_calls and null content for tool-only response", () => {
    const r = buildChatCompletionResponse({
      id: "chatcmpl-x",
      model: "claude-opus-4.6",
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "search", input: { q: "hi" } },
      ],
      finishReason: "tool-calls",
    });
    expect(r.choices[0]?.message.content).toBeNull();
    expect(r.choices[0]?.message.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"hi"}' },
    });
    expect(r.choices[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("finishReasonToOpenAI & usageToOpenAI", () => {
  it("maps known reasons", () => {
    expect(finishReasonToOpenAI("stop")).toBe("stop");
    expect(finishReasonToOpenAI("length")).toBe("length");
    expect(finishReasonToOpenAI("tool-calls")).toBe("tool_calls");
    expect(finishReasonToOpenAI("content-filter")).toBe("content_filter");
    expect(finishReasonToOpenAI("error")).toBe("stop");
    expect(finishReasonToOpenAI(undefined)).toBe("stop");
  });

  it("computes total tokens from prompt+completion when missing", () => {
    expect(usageToOpenAI({ inputTokens: 4, outputTokens: 6 })).toEqual({
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
    });
  });
});
