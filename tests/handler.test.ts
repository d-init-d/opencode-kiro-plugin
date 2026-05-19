import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleOpenAICompatibleRequest } from "../src/openai/handler.js";

// Mock the kiro provider so we never actually spawn `kiro-cli`.
vi.mock("../src/kiro/provider.js", async () => {
  return {
    async getProvider(_auth: unknown) {
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
    async disposeProviderForAccount() {
      // no-op
    },
  };
});

let tmpHome: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
  // Isolate the persistent account store per test.
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-handler-test-"));
  prevXdg = process.env["XDG_CONFIG_HOME"];
  prevHome = process.env["HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpHome;
  process.env["HOME"] = tmpHome;
  vi.resetModules();
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("handleOpenAICompatibleRequest", () => {
  it("returns undefined for non-synthetic URLs so callers can pass through", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://api.openai.com/v1/models"),
      { auth: { accountId: "_test", mode: "cli-login" } }
    );
    expect(res).toBeUndefined();
  });

  it("serves /v1/models", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/models"),
      { auth: { accountId: "_test", mode: "cli-login" } }
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
      { auth: { accountId: "_test", mode: "cli-login" } }
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
      { auth: { accountId: "_test", mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(400);
  });

  it("returns chat completion JSON for non-streaming requests (uses CLI fallback when store empty)", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { auth: { accountId: "_hook_cli", mode: "cli-login" } }
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
      { auth: { accountId: "_hook_cli", mode: "cli-login" } }
    );
    if (!res) throw new Error("expected response");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("returns 401 with 'no_accounts_configured' when store is empty AND no auth context provided", async () => {
    const res = await handleOpenAICompatibleRequest(
      new Request("https://kiro.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      // Force a context that won't auto-create the cli-login account.
      { auth: { accountId: "_unknown", mode: "api-key" } as never }
    );
    if (!res) throw new Error("expected response");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("no_accounts_configured");
  });
});
