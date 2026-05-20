/**
 * Plugin factory: wires everything into the shape OpenCode expects.
 *
 * OpenCode (sst/opencode v1.x) calls a plugin function as
 *   `(ctx: { client, directory }) => Promise<PluginResult>`
 * and expects the result to expose `auth`, `tool`, and optionally `event`.
 *
 * We mirror that signature here exactly so the plugin loads on stock OpenCode
 * without any extra adapter.
 */
import { DEFAULT_PROVIDER_ID } from "./constants.js";
import { buildKiroAuthHook, type KiroAuthHook } from "./auth/loader.js";
import { createKiroStatusTool } from "./tools/kiro_status.js";
import { createKiroModelsTool } from "./tools/kiro_models.js";
import { createKiroAccountsTool } from "./tools/kiro_accounts.js";
import { resetProvider } from "./kiro/provider.js";
import { ensureLocalServer, shutdownLocalServer } from "./server/local-server.js";
import { syncOpenCodeProviderToLocalServer } from "./config/opencode-config.js";
import { log } from "./plugin/debug.js";

export interface KiroPluginOptions {
  /** Override provider id; defaults to `kiro`. */
  providerId?: string;
  /** Override plugin version reported by the status tool. */
  version?: string;
}

/**
 * The tiny subset of the OpenCode plugin context we actually consume. We
 * deliberately do not import this from `@opencode-ai/plugin` so the plugin
 * loads against any version of OpenCode that exposes a compatible shape.
 */
export interface KiroPluginContext {
  client?: unknown;
  directory?: string;
}

export interface KiroPluginEventPayload {
  event?: { type?: string; properties?: unknown };
}

export interface KiroPluginResult {
  auth: KiroAuthHook;
  tool: Record<string, unknown>;
  event?: (payload: KiroPluginEventPayload) => void | Promise<void>;
}

const PKG_VERSION = "0.1.1";

/**
 * Factory that returns the plugin function. Exposing both the factory and
 * the default plugin makes it easy to use in tests and in `opencode.json`.
 */
export function createKiroPlugin(
  options: KiroPluginOptions = {}
): (ctx?: KiroPluginContext) => Promise<KiroPluginResult> {
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const version = options.version ?? PKG_VERSION;

  return async function kiroPlugin(ctx?: KiroPluginContext): Promise<KiroPluginResult> {
    log.info("opencode-kiro-plugin loaded", {
      providerId,
      version,
      directory: ctx?.directory ?? "(unknown)",
    });

    // Start the local interceptor server early so the first request can be
    // routed correctly. Errors here are non-fatal — newer OpenCode versions
    // can still use auth.loader.fetch.
    let localBaseURL: string | undefined;
    let localBearer: string | undefined;
    try {
      const server = await ensureLocalServer();
      localBaseURL = server.baseURL;
      localBearer = server.bearerToken;
    } catch (err) {
      log.warn("Local Kiro server failed to start; falling back to fetch interceptor only", {
        error: String(err),
      });
    }

    // Make sure opencode.json's provider entry points at this server.
    if (localBaseURL && localBearer) {
      try {
        await syncOpenCodeProviderToLocalServer({
          providerId,
          baseURL: localBaseURL,
          bearerToken: localBearer,
        });
      } catch (err) {
        log.warn("Could not sync opencode.json provider to local server", { error: String(err) });
      }
    }

    const auth = buildKiroAuthHook(providerId);
    const tool: Record<string, unknown> = {
      kiro_status: createKiroStatusTool({ pluginVersion: version }),
      kiro_models: createKiroModelsTool(),
      kiro_accounts: createKiroAccountsTool(),
    };

    return {
      auth,
      tool,
      async event(payload) {
        const type = payload?.event?.type;
        if (!type) return;
        switch (type) {
          case "server.connected":
            log.debug("OpenCode server connected");
            return;
          case "session.idle":
            await resetProvider(type);
            return;
          case "session.end":
            await resetProvider(type);
            await shutdownLocalServer();
            return;
          default:
            return;
        }
      },
    };
  };
}

/**
 * Default plugin export, ready to be referenced from `opencode.json`.
 */
export const KiroPlugin = createKiroPlugin();
