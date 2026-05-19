import { describe, it, expect } from "vitest";
import { inspectApiKeyShape, maskApiKey } from "../src/auth/api-key.js";
import { redact, redactRecord } from "../src/plugin/debug.js";

describe("inspectApiKeyShape", () => {
  it("rejects empty input", () => {
    expect(inspectApiKeyShape("").ok).toBe(false);
    expect(inspectApiKeyShape(undefined).ok).toBe(false);
  });

  it("flags whitespace boundaries", () => {
    const r = inspectApiKeyShape("  ksk_abcdefghij1234567890  ");
    expect(r.ok).toBe(false);
  });

  it("flags too short keys", () => {
    expect(inspectApiKeyShape("ksk_short").ok).toBe(false);
  });

  it("warns on unknown prefix", () => {
    const r = inspectApiKeyShape("zz_abcdefghij1234567890abcd");
    expect(r.ok).toBe(false);
  });

  it("accepts well-formed ksk keys", () => {
    expect(inspectApiKeyShape("ksk_abcdefghij1234567890ABCD").ok).toBe(true);
    expect(inspectApiKeyShape("kpk_abcdefghij1234567890ABCD").ok).toBe(true);
  });
});

describe("maskApiKey", () => {
  it("masks middle of long keys", () => {
    expect(maskApiKey("ksk_abcdefghijklmn1234")).toBe("ksk_…1234");
  });
  it("returns short masks for tiny inputs", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey(undefined)).toBe("");
  });
});

describe("redact()", () => {
  it("replaces Kiro API key shape", () => {
    const input = "Authorization: Bearer ksk_abcdefghijklmnopqrstuvwxyz";
    const out = redact(input);
    expect(out).not.toContain("ksk_abcdefghij");
    expect(out).toContain("[REDACTED]");
  });

  it("replaces Bearer tokens regardless of secret format", () => {
    const out = redact("Bearer abc.def.ghi");
    expect(out).toContain("[REDACTED]");
  });

  it("replaces JSON token-like fields", () => {
    const out = redact('{"access_token":"abc123","other":"keep"}');
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("keep");
  });
});

describe("redactRecord()", () => {
  it("masks sensitive keys", () => {
    const out = redactRecord({
      api_key: "ksk_abcdefghijklmnopqrstuvwxyz",
      Authorization: "Bearer x.y.z",
      keep: "ok",
    });
    expect(out["api_key"]).toBe("[REDACTED]");
    expect(out["Authorization"]).toBe("[REDACTED]");
    expect(out["keep"]).toBe("ok");
  });

  it("returns empty object for undefined input", () => {
    expect(redactRecord(undefined)).toEqual({});
  });
});
