/**
 * Plugin factory: wires everything into the shape OpenCode expects.
 *
 * The OpenCode plugin API is still evolving so we keep our exported plugin
 * function loosely typed at the call boundary. The internal hook structure
 * mirrors the working pattern from `opencode-antigravity-auth`.
 */
import { DEFAULT_PROVIDER_ID } from "./constants.js";
import { buildKiroAuthHook } from "./auth/loader.js";
import { createKiroStatusTool } from "./tools/kiro_status.js";
import { createKiroModelsTool } from "./tools/kiro_models.js";
import { resetProvider } from "./kiro/provider.js";
import { log } from "./plugin/debug.js";

export interface KiroPluginOptions {
  /** Override provider id; defaults to `kiro`. */
  providerId?: string;
  /** Override plugin version reported by the status tool. */
  version?: string;
}

export interface KiroPluginHooks {
  auth: ReturnType<typeof buildKiroAuthHook>;
  tool: Record<string, unknown>;
  event: (input: { event?: { type?: string } } | undefined) => Promise<void> | void;
  /** Called by some OpenCode versions when the plugin is unloaded. */
  shutdown?: () => Promise<void>;
}

const PKG_VERSION = "0.1.0";

/**
 * Factory that returns the plugin function. Exposing both the factory and
 * the default plugin makes it easy to use in tests and in `opencode.json`.
 */
export function createKiroPlugin(options: KiroPluginOptions = {}): (input?: unknown) => Promise<KiroPluginHooks> {
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const version = options.version ?? PKG_VERSION;

  return async function kiroPlugin(_input?: unknown): Promise<KiroPluginHooks> {
    log.info("opencode-kiro-plugin loaded", { providerId, version });
    const auth = buildKiroAuthHook(providerId);
    const tool: Record<string, unknown> = {
      kiro_status: createKiroStatusTool({ pluginVersion: version }),
      kiro_models: createKiroModelsTool(),
    };

    return {
      auth,
      tool,
      async event(input) {
        const type = input?.event?.type;
        if (!type) return;
        switch (type) {
          case "server.connected":
            log.debug("OpenCode server connected");
            return;
          case "session.idle":
          case "session.end":
            // Best-effort cleanup. Errors are logged inside `resetProvider()`.
            await resetProvider(type);
            return;
          default:
            return;
        }
      },
      async shutdown() {
        await resetProvider("plugin-shutdown");
      },
    };
  };
}

/**
 * Default plugin export, ready to be referenced from `opencode.json`.
 */
export const KiroPlugin = createKiroPlugin();
