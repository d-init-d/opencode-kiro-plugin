import { describe, it, expect } from "vitest";
import { toOpenAiSseStream, type AiStreamPart } from "../src/openai/stream.js";

async function* fromArray(parts: AiStreamPart[]): AsyncIterable<AiStreamPart> {
  for (const p of parts) yield p;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value);
  }
  return out;
}

function parseSse(payload: string): unknown[] {
  return payload
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const line = chunk.replace(/^data:\s*/, "");
      if (line === "[DONE]") return "DONE";
      return JSON.parse(line);
    });
}

describe("toOpenAiSseStream", () => {
  it("emits role, text deltas, finish, and DONE", async () => {
    const stream = toOpenAiSseStream({
      id: "chatcmpl-1",
      model: "claude-opus-4.6",
      source: fromArray([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Xin " },
        { type: "text-delta", id: "t1", delta: "chào" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } },
      ]),
    });
    const events = parseSse(await collect(stream));
    // role chunk + 2 deltas + final + DONE
    expect(events.length).toBe(5);
    const first = events[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(first.choices[0]?.delta.role).toBe("assistant");
    const last = events[events.length - 1];
    expect(last).toBe("DONE");
    const finalChunk = events[events.length - 2] as { choices: Array<{ finish_reason: string }>; usage?: unknown };
    expect(finalChunk.choices[0]?.finish_reason).toBe("stop");
    expect(finalChunk.usage).toEqual({ prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
  });

  it("emits tool call header + argument deltas", async () => {
    const stream = toOpenAiSseStream({
      id: "chatcmpl-2",
      model: "claude-opus-4.6",
      source: fromArray([
        { type: "tool-input-start", id: "call_1", toolName: "search" },
        { type: "tool-input-delta", id: "call_1", delta: '{"q":' },
        { type: "tool-input-delta", id: "call_1", delta: '"hi"}' },
        { type: "tool-input-end", id: "call_1" },
        { type: "finish", finishReason: "tool-calls" },
      ]),
    });
    const events = parseSse(await collect(stream));
    const headerEvent = events[1] as { choices: Array<{ delta: { tool_calls?: Array<{ function?: { name?: string } }> } }> };
    expect(headerEvent.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe("search");
    const argEvent = events[2] as { choices: Array<{ delta: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> };
    expect(argEvent.choices[0]?.delta.tool_calls?.[0]?.function?.arguments).toBe('{"q":');
    const lastReal = events[events.length - 2] as { choices: Array<{ finish_reason: string }> };
    expect(lastReal.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("collapses single tool-call event into one chunk", async () => {
    const stream = toOpenAiSseStream({
      id: "chatcmpl-3",
      model: "claude-opus-4.6",
      source: fromArray([
        { type: "tool-call", toolCallId: "call_x", toolName: "search", input: { q: "vn" } },
        { type: "finish", finishReason: "tool-calls" },
      ]),
    });
    const events = parseSse(await collect(stream));
    const headerEvent = events[1] as { choices: Array<{ delta: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
    expect(headerEvent.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe("search");
    expect(headerEvent.choices[0]?.delta.tool_calls?.[0]?.function?.arguments).toBe('{"q":"vn"}');
  });

  it("emits reasoning as inline italic content for OpenCode 1.2.x compatibility", async () => {
    const stream = toOpenAiSseStream({
      id: "chatcmpl-reason",
      model: "claude-opus-4.6",
      source: fromArray([
        { type: "stream-start" } as AiStreamPart,
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "Let me think..." },
        { type: "reasoning-delta", id: "r1", delta: " about this." },
        { type: "reasoning-end", id: "r1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Here is my answer." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop" },
      ]),
    });
    const events = parseSse(await collect(stream));
    // Collect all content deltas
    const contentParts: string[] = [];
    for (const e of events) {
      if (e === "DONE" || typeof e !== "object") continue;
      const obj = e as { choices?: Array<{ delta?: { content?: string } }> };
      const c = obj.choices?.[0]?.delta?.content;
      if (c !== undefined) contentParts.push(c);
    }
    const fullContent = contentParts.join("");
    // Should contain italic thinking block followed by actual answer
    expect(fullContent).toContain("*Thought: Let me think... about this.*");
    expect(fullContent).toContain("Here is my answer.");
    // Thinking comes before the answer
    const thinkIdx = fullContent.indexOf("*Thought:");
    const answerIdx = fullContent.indexOf("Here is my answer.");
    expect(thinkIdx).toBeLessThan(answerIdx);
  });

  it("turns errors into a final stop chunk and DONE", async () => {
    const stream = toOpenAiSseStream({
      id: "chatcmpl-4",
      model: "claude-opus-4.6",
      // eslint-disable-next-line require-yield
      source: (async function* () {
        throw new Error("boom");
      })(),
    });
    const events = parseSse(await collect(stream));
    expect(events[events.length - 1]).toBe("DONE");
    const errorChunk = events[events.length - 2] as { error?: { message: string } };
    expect(errorChunk.error?.message).toBe("boom");
  });
});
