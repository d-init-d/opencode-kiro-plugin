/**
 * `kiro_accounts` Opencode tool — read-only listing of Kiro accounts and
 * rotation state. Never returns the raw API key.
 */
import {
  loadAccountStore,
  publicView,
  type PublicAccountView,
} from "../auth/account-store.js";
import { timeUntilNextAvailable } from "../auth/rotation.js";
import type { ToolDescriptor } from "./kiro_status.js";

export interface KiroAccountsToolResult {
  strategy: "sticky" | "round-robin" | "hybrid";
  total: number;
  enabled: number;
  onCooldown: number;
  nextAvailableInMs?: number;
  list: PublicAccountView[];
}

export function createKiroAccountsTool(): ToolDescriptor {
  return {
    description:
      "Liệt kê tài khoản Kiro đã cấu hình (không lộ key), trạng thái cooldown, và chiến lược xoay tài khoản hiện tại.",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<KiroAccountsToolResult> {
      const store = await loadAccountStore();
      const now = Date.now();
      const list = store.accounts.map(publicView);
      const onCooldown = list.filter((a) => (a.runtime?.cooldownUntil ?? 0) > now).length;
      const enabled = list.filter((a) => a.enabled).length;
      const nextAvailable = timeUntilNextAvailable(store, now);
      const result: KiroAccountsToolResult = {
        strategy: store.strategy,
        total: list.length,
        enabled,
        onCooldown,
        list,
      };
      if (nextAvailable !== undefined) result.nextAvailableInMs = nextAvailable;
      return result;
    },
  };
}
