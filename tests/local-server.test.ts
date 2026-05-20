import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/kiro/provider.js", async () => {
  return {
    async getProvider(_auth: unknown) {
      return {
        async getModel(_id: string) {
          return {
            async doGenerate(_options: unknown) {
              return {
                content: [{ type: "text", text: "from-local" }],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
            async doStream(_options: unknown) {
              async function* gen() {
                yield { type: "text-delta", id: "t1", delta: "hi" };
                yield { type: "finish", finishReason: "stop" };
              }
              return { stream: gen() };
            },
          };
        },
        async shutdown() {},
      };
    },
    async resetProvider() {},
    async disposeProviderForAccount() {},
  };
});

let tmpHome: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-local-srv-"));
  prevXdg = process.env["XDG_CONFIG_HOME"];
  prevHome = process.env["HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpHome;
  process.env["HOME"] = tmpHome;
});

afterEach(async () => {
  // shutdown server between tests
  const { shutdownLocalServer } = await import("../src/server/local-server.js");
  await shutdownLocalServer();
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("ensureLocalServer", () => {
  it("starts on a random localhost port and serves /v1/models with bearer token", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const handle = await ensureLocalServer();
    expect(handle.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(handle.bearerToken).toMatch(/^[0-9a-f]{48}$/);

    const res = await fetch(`${handle.baseURL}/models`, {
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((d) => d.id);
    expect(ids).toContain("claude-opus-4.6");
  });

  it("rejects requests without bearer token", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const handle = await ensureLocalServer();
    const res = await fetch(`${handle.baseURL}/models`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const handle = await ensureLocalServer();
    const res = await fetch(`${handle.baseURL}/models`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(403);
  });

  it("is idempotent: calling twice returns the same handle", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const a = await ensureLocalServer();
    const b = await ensureLocalServer();
    expect(a.port).toBe(b.port);
    expect(a.bearerToken).toBe(b.bearerToken);
  });

  it("only listens on 127.0.0.1 (not 0.0.0.0)", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const handle = await ensureLocalServer();
    // Sanity — can connect via loopback.
    const res1 = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, {
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    });
    expect(res1.status).toBe(200);
    // Trying to connect via the machine hostname should not be exposed; we
    // can't easily assert that without binding to a specific NIC, but we DO
    // assert the URL contains the loopback literal — the only public knob.
    expect(handle.baseURL.includes("127.0.0.1")).toBe(true);
  });

  it("forwards POST /v1/chat/completions through the rotation handler", async () => {
    const { ensureLocalServer } = await import("../src/server/local-server.js");
    const { addApiKeyAccount } = await import("../src/auth/account-store.js");
    await addApiKeyAccount({ label: "test", apiKey: "ksk_AAAAAAAAAAAAAAAAAAAAAA" });
    const handle = await ensureLocalServer();
    const res = await fetch(`${handle.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string | null } }>;
    };
    expect(body.choices[0]?.message.content).toBe("from-local");
  });
});
