import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  addApiKeyAccount,
  ensureCliLoginAccount,
  loadAccountStore,
  publicView,
  removeAccount,
  saveAccountStore,
  setAccountEnabled,
  setStrategy,
} from "../src/auth/account-store.js";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-store-"));
  storePath = path.join(tmpDir, "kiro-accounts.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("account store", () => {
  it("returns an empty store when the file is missing", async () => {
    const s = await loadAccountStore(storePath);
    expect(s.version).toBe(1);
    expect(s.accounts.length).toBe(0);
    expect(s.strategy).toBe("hybrid");
  });

  it("addApiKeyAccount persists and refuses duplicates", async () => {
    const a = await addApiKeyAccount(
      { label: "first", apiKey: "ksk_abcdefghijklmnop12345" },
      storePath
    );
    const s1 = await loadAccountStore(storePath);
    expect(s1.accounts.length).toBe(1);
    expect(s1.accounts[0]?.id).toBe(a.id);

    const dup = await addApiKeyAccount(
      { label: "second", apiKey: "ksk_abcdefghijklmnop12345" },
      storePath
    );
    expect(dup.id).toBe(a.id);
    const s2 = await loadAccountStore(storePath);
    expect(s2.accounts.length).toBe(1);
  });

  it("ensureCliLoginAccount is idempotent", async () => {
    const a = await ensureCliLoginAccount(storePath);
    const b = await ensureCliLoginAccount(storePath);
    expect(a.id).toBe(b.id);
    const s = await loadAccountStore(storePath);
    expect(s.accounts.length).toBe(1);
  });

  it("setAccountEnabled / removeAccount work", async () => {
    const a = await addApiKeyAccount(
      { label: "x", apiKey: "ksk_abcdefghijklmnop12345" },
      storePath
    );
    const upd = await setAccountEnabled(a.id, false, storePath);
    expect(upd?.enabled).toBe(false);
    const removed = await removeAccount(a.id, storePath);
    expect(removed).toBe(true);
    const s = await loadAccountStore(storePath);
    expect(s.accounts.length).toBe(0);
  });

  it("setStrategy updates the persisted store", async () => {
    await setStrategy("round-robin", storePath);
    const s = await loadAccountStore(storePath);
    expect(s.strategy).toBe("round-robin");
  });

  it("publicView never exposes the raw API key", async () => {
    const a = await addApiKeyAccount(
      { label: "x", apiKey: "ksk_abcdefghijklmnop12345" },
      storePath
    );
    const v = publicView(a);
    const json = JSON.stringify(v);
    expect(json).not.toContain("ksk_abcdefghijklmnop12345");
    expect(v.keyMasked).toBeDefined();
  });

  it("creates the file with restrictive permissions on POSIX", async () => {
    if (process.platform === "win32") return;
    await addApiKeyAccount(
      { label: "x", apiKey: "ksk_abcdefghijklmnop12345" },
      storePath
    );
    const stat = await fs.stat(storePath);
    expect(stat.mode & 0o077).toBe(0); // group + other have no permissions
  });

  it("loadAccountStore tolerates malformed JSON", async () => {
    await fs.writeFile(storePath, "not json", "utf8");
    const s = await loadAccountStore(storePath);
    expect(s.accounts.length).toBe(0);
  });

  it("saveAccountStore validates the input shape", async () => {
    // @ts-expect-error -- intentionally invalid for the test
    await expect(saveAccountStore({ version: 2, accounts: [] }, storePath)).rejects.toThrow();
  });
});
