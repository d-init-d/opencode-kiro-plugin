/**
 * `kiro_status` OpenCode tool definition.
 * Returns a redacted status snapshot for the Kiro plugin.
 */
import { buildStatusReport } from "../plugin/status.js";

export interface ToolDescriptor {
  description: string;
  parameters: Record<string, unknown>;
  /**
   * OpenCode passes its own context object that we deliberately do not
   * constrain — the plugin only needs to return a JSON-serializable value.
   */
  execute: (args: unknown, context?: unknown) => Promise<unknown>;
}

export function createKiroStatusTool(args?: { pluginVersion?: string }): ToolDescriptor {
  return {
    description:
      "Trả về tình trạng Kiro plugin: kiro-cli đã cài chưa, đang xác thực ở chế độ nào, danh sách model.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const report = await buildStatusReport({
        ...(args?.pluginVersion ? { pluginVersion: args.pluginVersion } : {}),
      });
      return report;
    },
  };
}
