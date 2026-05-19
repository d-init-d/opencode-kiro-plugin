/**
 * Persistent account store at `~/.config/opencode/kiro-accounts.json`.
 *
 * Layout:
 *   {
 *     "version": 1,
 *     "accounts": [
 *       { "id": "...", "label": "work", "type": "api-key", "apiKey": "ksk_...", "enabled": true, "createdAt": "..." },
 *       { "id": "...", "label": "cli",  "type": "cli-login", "enabled": true, "createdAt": "..." }
 *     ],
 *     "strategy": "hybrid"
 *   }
 *
 * Security:
 *   - File is created with mode 0600.
 *   - Atomic write via temp + rename.
 *   - Lockfile during writes to prevent corruption.
 *   - API keys are NEVER written into `opencode.json` or the plugin source tree.
 *   - When the file is read back, callers should treat it as the trust source for keys.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { xdgConfig } from "xdg-basedir";
import { z } from "zod";
import { log } from "../plugin/debug.js";

export type AccountStrategy = "sticky" | "round-robin" | "hybrid";
export type AccountType = "api-key" | "cli-login";

export interface AccountRuntimeState {
  /** Cooldown deadline (ms epoch). Account is skipped while now < cooldownUntil. */
  cooldownUntil?: number;
  /** Last classified error kind, if any. */
  lastErrorKind?: string;
  /** Last error message (redacted-safe summary). */
  lastErrorMessage?: string;
  /** Total number of consecutive failures while picking this account. */
  consecutiveFailures?: number;
  /** Total successful requests served by this account. */
  successCount?: number;
  /** Last time this account served a request. */
  lastUsedAt?: number;
}

export interface KiroAccount {
  id: string;
  label: string;
  type: AccountType;
  /** Only present for type === 'api-key'. */
  apiKey?: string;
  enabled: boolean;
  createdAt: string;
  /** Free-form note from the user, e.g. "team account". */
  note?: string;
  /** Persisted runtime state — survives plugin restarts. */
  runtime?: AccountRuntimeState;
}

const RuntimeSchema = z
  .object({
    cooldownUntil: z.number().nonnegative().default(0),
    lastErrorKind: z.string().optional(),
    lastErrorMessage: z.string().optional(),
    consecutiveFailures: z.number().int().nonnegative().default(0),
    successCount: z.number().int().nonnegative().default(0),
    lastUsedAt: z.number().optional(),
  })
  .partial()
  .optional();

const AccountSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(64),
  type: z.enum(["api-key", "cli-login"]),
  apiKey: z.string().min(8).optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  note: z.string().max(256).optional(),
  runtime: RuntimeSchema,
});

const StoreSchema = z.object({
  version: z.literal(1),
  strategy: z.enum(["sticky", "round-robin", "hybrid"]).default("hybrid"),
  accounts: z.array(AccountSchema).default([]),
});

export type AccountStore = z.infer<typeof StoreSchema>;

const EMPTY_STORE: AccountStore = { version: 1, strategy: "hybrid", accounts: [] };

function freshEmptyStore(): AccountStore {
  return { version: 1, strategy: "hybrid", accounts: [] };
}

export function getAccountsFilePath(): string {
  // Resolve at call time so tests can override XDG_CONFIG_HOME / HOME via env.
  const xdg = process.env["XDG_CONFIG_HOME"];
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? process.cwd();
  const base = xdg && xdg.length > 0 ? xdg : (xdgConfig ?? path.join(home, ".config"));
  return path.join(base, "opencode", "kiro-accounts.json");
}

async function ensureParentDir(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function readRaw(file: string): Promise<AccountStore> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = StoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn("kiro-accounts.json invalid; falling back to empty store", {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return freshEmptyStore();
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return freshEmptyStore();
    log.warn("Failed to read kiro-accounts.json", { error: String(err) });
    return freshEmptyStore();
  }
}

async function writeRaw(file: string, next: AccountStore): Promise<void> {
  await ensureParentDir(file);
  // Touch file so proper-lockfile can lock; mode 0600 to keep keys private.
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "{}\n", { encoding: "utf8", mode: 0o600 });
  }
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(file, { retries: { retries: 5, minTimeout: 30, factor: 2 } });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, file);
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        log.warn("Releasing kiro-accounts.json lock failed", { error: String(err) });
      }
    }
  }
}

function genId(prefix: string): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

// ---------- Public API ----------

export async function loadAccountStore(filePath?: string): Promise<AccountStore> {
  return readRaw(filePath ?? getAccountsFilePath());
}

export async function saveAccountStore(
  store: AccountStore,
  filePath?: string
): Promise<void> {
  // Re-validate so a bug elsewhere can't write a malformed store.
  const parsed = StoreSchema.parse(store);
  await writeRaw(filePath ?? getAccountsFilePath(), parsed);
}

export interface AddApiKeyAccountInput {
  label: string;
  apiKey: string;
  note?: string;
  enabled?: boolean;
}

export async function addApiKeyAccount(
  input: AddApiKeyAccountInput,
  filePath?: string
): Promise<KiroAccount> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  // Prevent duplicate keys.
  const dup = store.accounts.find((a) => a.type === "api-key" && a.apiKey === input.apiKey);
  if (dup) {
    log.warn("Duplicate API key add ignored", { id: dup.id });
    return dup;
  }
  const account: KiroAccount = {
    id: genId("acct"),
    label: input.label.slice(0, 64),
    type: "api-key",
    apiKey: input.apiKey,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
    ...(input.note ? { note: input.note.slice(0, 256) } : {}),
  };
  store.accounts.push(account);
  await saveAccountStore(store, file);
  return account;
}

export async function ensureCliLoginAccount(
  filePath?: string
): Promise<KiroAccount> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  const existing = store.accounts.find((a) => a.type === "cli-login");
  if (existing) return existing;
  const account: KiroAccount = {
    id: genId("acct"),
    label: "kiro-cli login",
    type: "cli-login",
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  store.accounts.push(account);
  await saveAccountStore(store, file);
  return account;
}

export async function removeAccount(
  accountId: string,
  filePath?: string
): Promise<boolean> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== accountId);
  if (store.accounts.length === before) return false;
  await saveAccountStore(store, file);
  return true;
}

export async function setAccountEnabled(
  accountId: string,
  enabled: boolean,
  filePath?: string
): Promise<KiroAccount | undefined> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) return undefined;
  acc.enabled = enabled;
  await saveAccountStore(store, file);
  return acc;
}

export async function setStrategy(
  strategy: AccountStrategy,
  filePath?: string
): Promise<AccountStore> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  store.strategy = strategy;
  await saveAccountStore(store, file);
  return store;
}

export async function updateAccountRuntime(
  accountId: string,
  patch: Partial<AccountRuntimeState>,
  filePath?: string
): Promise<void> {
  const file = filePath ?? getAccountsFilePath();
  const store = await loadAccountStore(file);
  const acc = store.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  acc.runtime = { ...(acc.runtime ?? {}), ...patch };
  await saveAccountStore(store, file);
}

/**
 * Build a redaction-safe public view of the account list. Never returns
 * `apiKey` so this is safe to expose in tools and status reports.
 */
export interface PublicAccountView {
  id: string;
  label: string;
  type: AccountType;
  enabled: boolean;
  createdAt: string;
  note?: string;
  keyMasked?: string;
  runtime?: AccountRuntimeState;
}

export function publicView(account: KiroAccount): PublicAccountView {
  const masked = account.apiKey ? maskKey(account.apiKey) : undefined;
  const view: PublicAccountView = {
    id: account.id,
    label: account.label,
    type: account.type,
    enabled: account.enabled,
    createdAt: account.createdAt,
  };
  if (account.note) view.note = account.note;
  if (masked) view.keyMasked = masked;
  if (account.runtime) view.runtime = account.runtime;
  return view;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
