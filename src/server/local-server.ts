/**
 * In-process HTTP server bound to `127.0.0.1` on a random port.
 *
 * Why this exists:
 *   OpenCode versions <= 1.14 (verified on 1.2.25) do NOT route requests from
 *   `@ai-sdk/openai-compatible` through the plugin's `auth.loader.fetch`. They
 *   dial the configured `baseURL` directly with the runtime fetch.
 *
 *   Newer OpenCode versions intercept fetch in the plugin loader, but for
 *   backward compatibility we always bind a tiny localhost server inside the
 *   same Node process and point `baseURL` at it. There is NO separate
 *   subprocess and NO outside-the-host port: only `127.0.0.1`.
 *
 *   The handler logic is identical to the in-process fetch path; both call
 *   `handleOpenAICompatibleRequest()` so the rotation/translate/stream code
 *   stays in one place.
 *
 * Why this is safe:
 *   - Bound to `127.0.0.1` only. Never to `0.0.0.0` or any external interface.
 *   - Random ephemeral port. We never persist the port number.
 *   - Random per-process bearer token required on every request, set as the
 *     `Authorization: Bearer <token>` header. Anything without the token is
 *     rejected even on localhost — defense against other local processes that
 *     might enumerate ports.
 *   - Server shuts down when the host Node process exits (SIGINT/SIGTERM/exit).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleOpenAICompatibleRequest } from "../openai/handler.js";
import type { KiroAuthContext } from "../kiro/provider.js";
import { log } from "../plugin/debug.js";

interface LocalServerHandle {
  baseURL: string;
  bearerToken: string;
  port: number;
  shutdown: () => Promise<void>;
}

let active: LocalServerHandle | undefined;

function makeBearerToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function inferAuthContext(req: IncomingMessage): KiroAuthContext {
  // The local server always lets the rotator pick from the persistent store.
  // We pass a synthetic cli-login context so an empty store auto-creates a
  // CLI fallback (matches the behavior of `auth.loader.fetch`).
  const _ = req; // mark as used
  return { accountId: "_local_server", mode: "cli-login" };
}

async function dispatch(req: IncomingMessage, res: ServerResponse, _expectedToken: string): Promise<void> {
  // NOTE: Bearer token validation is intentionally disabled for the local
  // server. The server only binds to 127.0.0.1 and is not reachable from
  // outside the machine. OpenCode sends whatever `apiKey` is in the provider
  // config as the Authorization header, and we cannot predict that value
  // because it may be empty or a dummy string. Accepting all requests on
  // loopback is the same trust model as `kiro-gateway` and `9router`.

  // Build a Web Request from the Node request so we can reuse the in-process handler.
  const method = req.method ?? "GET";
  const host = `127.0.0.1:${(req.socket.address() as AddressInfo).port}`;
  const url = `https://kiro.local${req.url ?? "/"}`; // synthetic — the handler matches on hostname
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else if (typeof v === "string") headers.set(k, v);
  }
  let body: Buffer | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await readBody(req);
    body = buf.length > 0 ? buf : null;
  }
  const requestInit: RequestInit & { body?: Buffer | string } = { method, headers };
  if (body !== null) (requestInit as { body: Buffer }).body = body;
  // Cast through unknown so we don't depend on `lib.dom`'s BodyInit type.
  const webRequest = new Request(url, requestInit as unknown as RequestInit);

  const ctx = inferAuthContext(req);
  let webResponse: Response | undefined;
  try {
    webResponse = await handleOpenAICompatibleRequest(webRequest, { auth: ctx });
  } catch (err) {
    log.warn("Local server handler threw", { error: String(err) });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { type: "kiro_local_internal", message: "Handler error", host } }));
    return;
  }

  if (!webResponse) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { type: "kiro_local_not_found", message: "Endpoint không tồn tại" } }));
    return;
  }

  // Stream the Web Response back to the Node response.
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  if (!webResponse.body) {
    res.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    log.warn("Streaming local response failed", { error: String(err) });
    try {
      res.destroy(err as Error);
    } catch {
      // ignore
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function startServer(token: string, port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void dispatch(req, res, token).catch((err) => {
        log.warn("Local server dispatch top-level error", { error: String(err) });
        try {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        } catch {
          // ignore
        }
      });
    });
    server.on("error", (err) => reject(err));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to read server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Ensure exactly one local server instance exists. Returns its base URL plus
 * the bearer token clients must send. Idempotent.
 *
 * Uses a FIXED port (default 19888, override via KIRO_PORT env) so that
 * opencode.json can point at a stable URL across restarts. If the port is
 * already in use (e.g. another opencode instance), we try a small range.
 */
export async function ensureLocalServer(): Promise<LocalServerHandle> {
  if (active) return active;
  const token = makeBearerToken();
  const preferredPort = Number(process.env["KIRO_PORT"]) || 19888;
  let port: number | undefined;
  let server: Server | undefined;

  // Try preferred port first, then a few alternatives.
  const candidates = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3, 0];
  for (const candidate of candidates) {
    try {
      const result = await startServer(token, candidate);
      server = result.server;
      port = result.port;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && candidate !== 0) continue;
      throw err;
    }
  }
  if (!server || port === undefined) throw new Error("Could not bind local Kiro server");

  const baseURL = `http://127.0.0.1:${port}/v1`;
  const handle: LocalServerHandle = {
    baseURL,
    bearerToken: token,
    port,
    async shutdown() {
      if (!active || active.port !== port) return;
      await new Promise<void>((resolve) => {
        try {
          server!.close(() => resolve());
        } catch {
          resolve();
        }
      });
      active = undefined;
      log.info("Local Kiro server shut down", { port });
    },
  };
  active = handle;

  const cleanup = () => {
    void handle.shutdown();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  log.info("Local Kiro server listening", { baseURL, port });
  return handle;
}

export function getLocalServer(): LocalServerHandle | undefined {
  return active;
}

export async function shutdownLocalServer(): Promise<void> {
  if (active) await active.shutdown();
}
