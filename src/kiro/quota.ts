/**
 * Optional quota lookup. We never throw out of this helper; absence of quota
 * info is not a fatal condition.
 */
import { log } from "../plugin/debug.js";

export interface QuotaSnapshot {
  available: boolean;
  /** Free-form string suitable for diagnostics. Never includes secrets. */
  detail?: string;
  raw?: unknown;
}

export async function getKiroQuota(): Promise<QuotaSnapshot> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("kiro-acp-ai-provider")) as Record<string, unknown>;
  } catch (err) {
    log.debug("quota: provider import failed", { error: String(err) });
    return { available: false, detail: "không import được kiro-acp-ai-provider" };
  }
  const fn = mod["getQuota"];
  if (typeof fn !== "function") {
    return { available: false, detail: "kiro-acp-ai-provider không expose getQuota()" };
  }
  try {
    const raw = await (fn as () => unknown)();
    return { available: true, raw };
  } catch (err) {
    return { available: false, detail: `getQuota() lỗi: ${String(err)}` };
  }
}
