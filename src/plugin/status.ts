/**
 * Status snapshot returned by the `kiro_status` tool and used by debug logs.
 * Never includes API keys or tokens.
 */
import { inspectCliAuthState } from "../auth/cli-login.js";
import { listKiroModels } from "../kiro/models.js";
import { getKiroQuota } from "../kiro/quota.js";

export interface KiroStatusReport {
  pluginVersion: string;
  pluginName: string;
  cli: {
    installed: boolean;
    version?: string;
    authenticated: boolean;
    detail?: string;
  };
  authMode: "api-key" | "cli-login" | "unknown";
  models: { id: string; displayName: string }[];
  quota?: {
    available: boolean;
    detail?: string;
  };
}

export async function buildStatusReport(args?: {
  authMode?: KiroStatusReport["authMode"];
  pluginVersion?: string;
}): Promise<KiroStatusReport> {
  const cli = await inspectCliAuthState();
  const models = await listKiroModels();
  const quota = await getKiroQuota();

  const cliReport: KiroStatusReport["cli"] = {
    installed: cli.installed,
    authenticated: cli.authenticated,
  };
  if (cli.version) cliReport.version = cli.version;
  if (cli.detail) cliReport.detail = cli.detail;

  const result: KiroStatusReport = {
    pluginName: "opencode-kiro-plugin",
    pluginVersion: args?.pluginVersion ?? "0.0.0",
    cli: cliReport,
    authMode: args?.authMode ?? "unknown",
    models: models.map((m) => ({ id: m.id, displayName: m.displayName })),
    quota: { available: quota.available, ...(quota.detail ? { detail: quota.detail } : {}) },
  };
  return result;
}
