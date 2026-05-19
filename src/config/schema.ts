/**
 * Plugin-side config kept in `~/.config/opencode/kiro.json`.
 * Secrets are NEVER stored here. Only non-sensitive preferences.
 */
import { z } from "zod";

export const PluginConfigSchema = z.object({
  /** Provider id surfaced in OpenCode. Defaults to `kiro`. */
  providerId: z.string().min(1).default("kiro"),
  /** Default model id used by OpenCode commands when none is specified. */
  defaultModel: z.string().optional(),
  /** Idle timeout (ms) for the embedded `kiro-cli acp` subprocess. */
  idleShutdownMs: z.number().int().positive().optional(),
  /** Future-proof feature flags. */
  flags: z.record(z.boolean()).optional(),
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
