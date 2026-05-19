/**
 * Status snapshot returned by the `kiro_status` tool and used by debug logs.
 * Never includes API keys or tokens.
 */
import { inspectCliAuthState } from "../auth/cli-login.js";
import { listKiroModels } from "../kiro/models.js";
import { getKiroQuota } from "../kiro/quota.js";
import { loadAccountStore, publicView, type PublicAccountView } from "../auth/account-store.js";
import { timeUntilNextAvailable } from "../auth/rotation.js";

export interface KiroStatusReport {
  pluginVersion: string;
  pluginName: string;
  cli: {
    installed: boolean;
    version?: string;
    authenticated: boolean;
    detail?: string;
  };
  accounts: {
    strategy: "sticky" | "round-robin" | "hybrid";
    total: number;
    enabled: number;
    onCooldown: number;
    nextAvailableInMs?: number;
    list: PublicAccountView[];
  };
  models: { id: string; displayName: string }[];
  quota?: {
    available: boolean;
    detail?: string;
  };
}

export async function buildStatusReport(args?: {
  pluginVersion?: string;
}): Promise<KiroStatusReport> {
  const cli = await inspectCliAuthState();
  const models = await listKiroModels();
  const quota = await getKiroQuota();
  const store = await loadAccountStore();
  const now = Date.now();
  const list = store.accounts.map(publicView);
  const onCooldown = list.filter((a) => (a.runtime?.cooldownUntil ?? 0) > now).length;
  const enabled = list.filter((a) => a.enabled).length;
  const nextAvailable = timeUntilNextAvailable(store, now);

  const cliReport: KiroStatusReport["cli"] = {
    installed: cli.installed,
    authenticated: cli.authenticated,
  };
  if (cli.version) cliReport.version = cli.version;
  if (cli.detail) cliReport.detail = cli.detail;

  const accounts: KiroStatusReport["accounts"] = {
    strategy: store.strategy,
    total: list.length,
    enabled,
    onCooldown,
    list,
  };
  if (nextAvailable !== undefined) accounts.nextAvailableInMs = nextAvailable;

  const result: KiroStatusReport = {
    pluginName: "opencode-kiro-plugin",
    pluginVersion: args?.pluginVersion ?? "0.0.0",
    cli: cliReport,
    accounts,
    models: models.map((m) => ({ id: m.id, displayName: m.displayName })),
    quota: { available: quota.available, ...(quota.detail ? { detail: quota.detail } : {}) },
  };
  return result;
}
