/**
 * Read/write `~/.config/opencode/kiro.json` (XDG-aware).
 * The file holds only non-secret plugin preferences.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { xdgConfig } from "xdg-basedir";
import { PluginConfigSchema, type PluginConfig } from "./schema.js";
import { log } from "../plugin/debug.js";

const DEFAULT_CONFIG: PluginConfig = { providerId: "kiro" };

export function getPluginConfigPath(): string {
  const base = xdgConfig ?? path.join(process.env["HOME"] ?? process.cwd(), ".config");
  return path.join(base, "opencode", "kiro.json");
}

export async function readPluginConfig(): Promise<PluginConfig> {
  const file = getPluginConfigPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = PluginConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn("kiro.json không hợp lệ, dùng cấu hình mặc định", { issues: parsed.error.issues });
      return { ...DEFAULT_CONFIG };
    }
    return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    log.warn("Đọc kiro.json thất bại", { error: String(err) });
    return { ...DEFAULT_CONFIG };
  }
}

export async function writePluginConfig(next: PluginConfig): Promise<void> {
  const file = getPluginConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
