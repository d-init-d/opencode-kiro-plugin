/**
 * Public entry point for `opencode-kiro-plugin`.
 *
 * IMPORTANT: OpenCode's plugin loader iterates all named exports of this
 * module and treats each callable one as a plugin function. Anything that
 * is not a plugin function (classes, schemas, types, helpers) MUST NOT be
 * exported from here, otherwise OpenCode will try to invoke them and fail
 * with errors like "Cannot call a class constructor without |new|".
 *
 * Advanced consumers (tests, scripts, integrations) should import from the
 * `/api` subpath, which exposes the rotation/account/error-classifier API:
 *
 *   import { addApiKeyAccount, generateWithRotation } from "opencode-kiro-plugin/api";
 */
import { KiroPlugin as _KiroPlugin, createKiroPlugin as _createKiroPlugin } from "./plugin.js";

// Default export: the plugin function OpenCode invokes.
export default _KiroPlugin;

// Named `KiroPlugin` export: same value, supports `import { KiroPlugin }`.
export const KiroPlugin = _KiroPlugin;

// Factory: returns a plugin function. Safe because the result is callable
// the same way OpenCode expects.
export const createKiroPlugin = _createKiroPlugin;
