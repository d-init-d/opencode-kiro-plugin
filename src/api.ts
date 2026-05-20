/**
 * Advanced API surface — NOT loaded by OpenCode's plugin runtime.
 *
 * Imported via `opencode-kiro-plugin/api`. Holds the rotation, account
 * store, error classifier, model catalog, and config helpers. Exposing
 * them from `index.ts` would break OpenCode plugin loading because the
 * loader tries to call every named export.
 */

export {
  DEFAULT_PROVIDER_ID,
  SYNTHETIC_BASE_URL,
  PLUGIN_PACKAGE_NAME,
  KIRO_MODEL_CATALOG,
} from "./constants.js";

export { handleOpenAICompatibleRequest } from "./openai/handler.js";
export { mergeOpenCodeConfig, defaultOpenCodeConfigPath } from "./config/opencode-config.js";
export { buildStatusReport } from "./plugin/status.js";

// Multi-account / rotation surface — useful for advanced users wiring custom
// front-ends, scripts, or tests.
export {
  addApiKeyAccount,
  ensureCliLoginAccount,
  loadAccountStore,
  publicView,
  removeAccount,
  saveAccountStore,
  setAccountEnabled,
  setStrategy,
  getAccountsFilePath,
} from "./auth/account-store.js";
export type {
  AccountStore,
  AccountStrategy,
  AccountType,
  KiroAccount,
  PublicAccountView,
  AccountRuntimeState,
} from "./auth/account-store.js";
export {
  generateWithRotation,
  streamWithRotation,
  AllAccountsExhaustedError,
  NoAccountsConfiguredError,
} from "./auth/rotator.js";
export type { RotationAttempt } from "./auth/rotator.js";
export { classifyKiroError, isRetryable } from "./auth/error-classifier.js";
export type { KiroErrorKind, ClassifiedError } from "./auth/error-classifier.js";
export { pickAccount, planCooldown, timeUntilNextAvailable } from "./auth/rotation.js";
