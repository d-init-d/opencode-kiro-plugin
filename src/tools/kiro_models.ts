/**
 * `kiro_models` OpenCode tool: list Kiro models currently available.
 */
import { listKiroModels } from "../kiro/models.js";
import type { ToolDescriptor } from "./kiro_status.js";

export function createKiroModelsTool(): ToolDescriptor {
  return {
    description: "Liệt kê các model Kiro hiện tại (kết hợp danh sách động từ kiro-acp-ai-provider nếu có).",
    parameters: { type: "object", properties: {} },
    async execute() {
      const models = await listKiroModels();
      return { models };
    },
  };
}
