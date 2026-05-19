/**
 * Public entry point for `opencode-kiro-plugin`.
 *
 * OpenCode loads the plugin by importing the package and looking for a
 * default export (or a named one configured by the user). We expose both
 * patterns: a ready-to-use `KiroPlugin` and the `createKiroPlugin` factory
 * for advanced configuration.
 */
export { KiroPlugin, createKiroPlugin } from "./plugin.js";
export type { KiroPluginHooks, KiroPluginOptions } from "./plugin.js";

export {
  DEFAULT_PROVIDER_ID,
  SYNTHETIC_BASE_URL,
  PLUGIN_PACKAGE_NAME,
  KIRO_MODEL_CATALOG,
} from "./constants.js";

export { handleOpenAICompatibleRequest } from "./openai/handler.js";
export { mergeOpenCodeConfig, defaultOpenCodeConfigPath } from "./config/opencode-config.js";
export { buildStatusReport } from "./plugin/status.js";

// Default export = the plugin function for opencode.json `plugin` arrays.
import { KiroPlugin } from "./plugin.js";
export default KiroPlugin;
