import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * We mock the kiro provider so failover can be deterministic without
 * touching the real `kiro-cli`. Each call we record which accountId we were
 * asked for and behave according to a pre-programmed map.
 */
const calls: Array<{ accountId: string; kind: "generate" | "stream" }> = [];
const behaviorByAccount: Record<string, "ok" | "rate-limit" | "auth" | "transient"> = {};

vi.mock("../src/kiro/provider.js", async () => {
  return {
    async getProvider(auth: { accountId: string }) {
      return {
        async getModel(_id: string) {
          return {
            async doGenerate(_options: unknown) {
              calls.push({ accountId: auth.accountId, kind: "generate" });
              const b = behaviorByAccount[auth.accountId] ?? "ok";
              if (b === "rate-limit") throw Object.assign(new Error("rate limit hit"), { status: 429 });
              if (b === "auth") throw Object.assign(new Error("invalid api key"), { status: 401 });
              if (b === "transient") throw Object.assign(new Error("bad gateway"), { status: 502 });
              return {
                content: [{ type: "text", text: `from:${auth.accountId}` }],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
            async doStream(_options: unknown) {
              calls.push({ accountId: auth.accountId, kind: "stream" });
              const b = behaviorByAccount[auth.accountId] ?? "ok";
              if (b === "rate-limit") throw Object.assign(new Error("rate limit hit"), { status: 429 });
              if (b === "auth") throw Object.assign(new Error("invalid api key"), { status: 401 });
              if (b === "transient") {
                async function* err() {
                  yield {
                    type: "error",
                    error: Object.assign(new Error("upstream blew up"), { status: 502 }),
                  };
                }
                return { stream: err() };
              }
              async function* gen() {
                yield { type: "text-delta", id: "t1", delta: `from:${auth.accountId} ` };
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
  calls.length = 0;
  for (const k of Object.keys(behaviorByAccount)) delete behaviorByAccount[k];
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-rotator-test-"));
  prevXdg = process.env["XDG_CONFIG_HOME"];
  prevHome = process.env["HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpHome;
  process.env["HOME"] = tmpHome;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function setupAccounts(): Promise<{ a: string; b: string; c: string }> {
  // Important: import inside the test so the env-isolated paths apply.
  const { addApiKeyAccount, setStrategy } = await import("../src/auth/account-store.js");
  const a = await addApiKeyAccount({ label: "A", apiKey: "ksk_AAAAAAAAAAAAAAAAAAAAAA" });
  const b = await addApiKeyAccount({ label: "B", apiKey: "ksk_BBBBBBBBBBBBBBBBBBBBBB" });
  const c = await addApiKeyAccount({ label: "C", apiKey: "ksk_CCCCCCCCCCCCCCCCCCCCCC" });
  await setStrategy("hybrid");
  return { a: a.id, b: b.id, c: c.id };
}

describe("generateWithRotation", () => {
  it("returns the result from the first eligible account on success", async () => {
    const ids = await setupAccounts();
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    const out = await generateWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(ids.a);
    expect(calls.length).toBe(1);
  });

  it("fails over to the next account on rate_limit", async () => {
    const ids = await setupAccounts();
    behaviorByAccount[ids.a] = "rate-limit";
    behaviorByAccount[ids.b] = "ok";
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    const out = await generateWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(ids.b);
    expect(calls.map((c) => c.accountId)).toEqual([ids.a, ids.b]);
  });

  it("does NOT retry on auth errors (returns the original message)", async () => {
    const ids = await setupAccounts();
    behaviorByAccount[ids.a] = "auth";
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    await expect(
      generateWithRotation({
        modelId: "claude-opus-4.6",
        callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      })
    ).rejects.toThrow(/invalid api key/i);
    // Only the first account should have been tried.
    expect(calls.length).toBe(1);
    expect(calls[0]?.accountId).toBe(ids.a);
    // And it should now be disabled.
    const { loadAccountStore } = await import("../src/auth/account-store.js");
    const s = await loadAccountStore();
    expect(s.accounts.find((a) => a.id === ids.a)?.enabled).toBe(false);
  });

  it("throws AllAccountsExhausted when every account fails with retryable errors", async () => {
    const ids = await setupAccounts();
    behaviorByAccount[ids.a] = "rate-limit";
    behaviorByAccount[ids.b] = "rate-limit";
    behaviorByAccount[ids.c] = "transient";
    const { generateWithRotation, AllAccountsExhaustedError } = await import("../src/auth/rotator.js");
    await expect(
      generateWithRotation({
        modelId: "claude-opus-4.6",
        callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      })
    ).rejects.toBeInstanceOf(AllAccountsExhaustedError);
    expect(calls.length).toBe(3);
  });

  it("auto-creates a CLI-login account when the store is empty and the auth hook is cli-login", async () => {
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    const out = await generateWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      ctxFromAuthHook: { accountId: "_hook_cli", mode: "cli-login" },
    });
    expect(out.result.content[0]?.text).toContain("from:");
    const { loadAccountStore } = await import("../src/auth/account-store.js");
    const s = await loadAccountStore();
    expect(s.accounts.find((a) => a.type === "cli-login")).toBeDefined();
  });
});

describe("streamWithRotation", () => {
  it("returns first eligible stream on success", async () => {
    const ids = await setupAccounts();
    const { streamWithRotation } = await import("../src/auth/rotator.js");
    const out = await streamWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(ids.a);
    let collected = "";
    for await (const part of out.stream) {
      if (part.type === "text-delta") collected += part.delta ?? "";
    }
    expect(collected).toContain(ids.a);
  });

  it("fails over before producing the first chunk on transient error", async () => {
    const ids = await setupAccounts();
    behaviorByAccount[ids.a] = "transient";
    behaviorByAccount[ids.b] = "ok";
    const { streamWithRotation } = await import("../src/auth/rotator.js");
    const out = await streamWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(ids.b);
    let collected = "";
    for await (const part of out.stream) {
      if (part.type === "text-delta") collected += part.delta ?? "";
    }
    expect(collected).toContain(ids.b);
  });
});

describe("mixed api-key + cli-login rotation", () => {
  it("falls over from a rate-limited API key to the CLI-login account", async () => {
    const { addApiKeyAccount, ensureCliLoginAccount } = await import("../src/auth/account-store.js");
    const apiAcc = await addApiKeyAccount({ label: "api", apiKey: "ksk_KEYKEYKEYKEYKEYKEYKEYK" });
    const cliAcc = await ensureCliLoginAccount();
    behaviorByAccount[apiAcc.id] = "rate-limit";
    behaviorByAccount[cliAcc.id] = "ok";
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    const out = await generateWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(cliAcc.id);
    expect(calls.map((c) => c.accountId)).toEqual([apiAcc.id, cliAcc.id]);
  });

  it("falls over from a broken CLI-login session to a healthy API key", async () => {
    const { addApiKeyAccount, ensureCliLoginAccount, setStrategy } = await import(
      "../src/auth/account-store.js"
    );
    const cliAcc = await ensureCliLoginAccount();
    const apiAcc = await addApiKeyAccount({ label: "api", apiKey: "ksk_KEYKEYKEYKEYKEYKEYKEYK" });
    // Force CLI account to be tried first by switching to round-robin which
    // prefers the LRU; cli was just created so its lastUsedAt is undefined.
    await setStrategy("round-robin");
    behaviorByAccount[cliAcc.id] = "transient";
    behaviorByAccount[apiAcc.id] = "ok";
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    const out = await generateWithRotation({
      modelId: "claude-opus-4.6",
      callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    expect(out.accountId).toBe(apiAcc.id);
  });

  it("disables CLI-login on auth error so subsequent calls skip it", async () => {
    const { addApiKeyAccount, ensureCliLoginAccount, loadAccountStore, setStrategy } = await import(
      "../src/auth/account-store.js"
    );
    const cliAcc = await ensureCliLoginAccount();
    const apiAcc = await addApiKeyAccount({ label: "api", apiKey: "ksk_KEYKEYKEYKEYKEYKEYKEYK" });
    await setStrategy("round-robin");
    behaviorByAccount[cliAcc.id] = "auth";
    const { generateWithRotation } = await import("../src/auth/rotator.js");
    await expect(
      generateWithRotation({
        modelId: "claude-opus-4.6",
        callOptions: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      })
    ).rejects.toThrow();
    const store = await loadAccountStore();
    const storedCli = store.accounts.find((a) => a.id === cliAcc.id);
    expect(storedCli?.enabled).toBe(false);
    // API key remains enabled.
    const storedApi = store.accounts.find((a) => a.id === apiAcc.id);
    expect(storedApi?.enabled).toBe(true);
  });
});
