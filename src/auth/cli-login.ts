/**
 * Helpers for inspecting an existing `kiro-cli` login session without
 * triggering any interactive prompts.
 *
 * We try `verifyAuth()` from `kiro-acp-ai-provider` first because that is the
 * documented surface. If unavailable we fall back to detecting `kiro-cli` on
 * PATH and inspecting its `version`/`whoami`-like output. We deliberately
 * never read any token files on disk.
 */
import { spawn } from "node:child_process";
import { log } from "../plugin/debug.js";

export interface CliPresence {
  installed: boolean;
  version?: string;
  /** Path that resolved on PATH, when known. */
  resolvedPath?: string;
}

export interface CliAuthState extends CliPresence {
  authenticated: boolean;
  /** Free-form message safe to surface to the user. */
  detail?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

function runOnce(cmd: string, args: string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: err as NodeJS.ErrnoException });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function detectKiroCli(): Promise<CliPresence> {
  const result = await runOnce("kiro-cli", ["--version"], 4000);
  if (result.spawnError && result.spawnError.code === "ENOENT") {
    return { installed: false };
  }
  if (result.code === 0) {
    const version = result.stdout.trim().split(/\s+/).pop();
    const presence: CliPresence = { installed: true };
    if (version) presence.version = version;
    return presence;
  }
  // Some CLIs print version on stderr; consider non-zero exits as installed if
  // the binary actually responded.
  if (!result.spawnError) {
    return { installed: true };
  }
  return { installed: false };
}

/**
 * Try to use `verifyAuth` exported by `kiro-acp-ai-provider` if available.
 * Returns `undefined` when the symbol does not exist so the caller can fall
 * back to spawning the CLI.
 */
async function verifyViaProvider(): Promise<CliAuthState | undefined> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("kiro-acp-ai-provider")) as Record<string, unknown>;
  } catch (err) {
    log.debug("kiro-acp-ai-provider import failed", { error: String(err) });
    return undefined;
  }
  const verifyAuth = mod["verifyAuth"];
  if (typeof verifyAuth !== "function") return undefined;
  try {
    const result = (await (verifyAuth as () => unknown)()) as
      | boolean
      | { authenticated?: boolean; detail?: string }
      | undefined;
    if (typeof result === "boolean") {
      return { installed: true, authenticated: result };
    }
    if (result && typeof result === "object") {
      const state: CliAuthState = {
        installed: true,
        authenticated: Boolean(result.authenticated),
      };
      if (result.detail) state.detail = result.detail;
      return state;
    }
    return { installed: true, authenticated: false };
  } catch (err) {
    log.debug("verifyAuth threw", { error: String(err) });
    return { installed: true, authenticated: false, detail: "verifyAuth() báo lỗi" };
  }
}

/**
 * Inspect whether the user can call Kiro through their already-running
 * `kiro-cli login` session. This call must not write or modify any files.
 */
export async function inspectCliAuthState(): Promise<CliAuthState> {
  // Prefer the provider hook because it owns the source of truth.
  const viaProvider = await verifyViaProvider();
  if (viaProvider) return viaProvider;

  const presence = await detectKiroCli();
  if (!presence.installed) {
    return { installed: false, authenticated: false, detail: "`kiro-cli` chưa được cài hoặc không có trong PATH." };
  }

  // Without a documented `kiro-cli auth status` we cannot reliably check the
  // session non-interactively. Treat the presence of the CLI as "maybe
  // authenticated" so the plugin can still try; the first `acp` request will
  // surface a real error if the session is missing.
  const state: CliAuthState = {
    installed: presence.installed,
    authenticated: true,
    detail:
      "Không kiểm tra được trạng thái đăng nhập từ xa. Plugin sẽ thử dùng phiên `kiro-cli login` hiện có.",
  };
  if (presence.version) state.version = presence.version;
  if (presence.resolvedPath) state.resolvedPath = presence.resolvedPath;
  return state;
}
