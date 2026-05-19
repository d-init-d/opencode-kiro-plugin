import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleOpenAICompatibleRequest } from "../src/openai/handler.js";

// Mock the kiro provider so we never actually spawn `kiro-cli`.
vi.mock("../src/kiro/provider.js", async () => {
  return {
    async getProvider() {
      return {
        async getModel(_id: string) {
          return {
            async doGenerate(_options: unknown) {
              return {
                content: [{ type: "text", text: "Xin chào" }],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              };
            },
            async doStream(_options: unknown) {
              async function* gen() {
                yield { type: "text-delta", id: "t1", delta: "Hi " };
                yield { type: "text-delta", id: "t1", delta: "world" };
                yield { type: "finish", finishReason: "stop" };
              }
              return { stream: gen() };
            },
          };
        },
        async shutdown() {
          // no-op
        },
      };
    },
    async resetProvider() {
      // no-op
    },
  };
});

beforeEach(() => {
  // Make models endpoint deterministic: avoid spawning kiro-cli for listModels.
  vi.resetModules();
});

describe("handleOpenAICompatibleRequest", () => {
  it("returns undefined for non-synthetic URLs so callers can pass through", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://api.openai.com/v1/models"),
      { auth: { mode: "cli-login" } }
    );
    expect(res).toBeUndefined();
  });

  it("serves /v1/models", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/models"),
      { auth: { mode: "cli-login" } }
    );
    expect(res).toBeDefined();
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((d) => d.id);
    expect(ids).toContain("claude-opus-4.6");
    expect(ids).toContain("claude-opus-4.7");
  });

  it("rejects POST on /v1/models", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/models", { method: "POST" }),
      { auth: { mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(405);
  });

  it("validates POST /v1/chat/completions body", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      { auth: { mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(400);
  });

  it("returns chat completion JSON for non-streaming requests", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { auth: { mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string | null } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("Xin chào");
  });

  it("streams SSE for streaming requests", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
      { auth: { mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });
});
