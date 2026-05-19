/**
 * Kiro model catalog facade.
 *
 * The MVP returns the static catalog defined in `constants.ts`. When/if
 * `kiro-acp-ai-provider` exposes a `listModels()` function we prefer the
 * dynamic list and merge it with the curated metadata so user-facing names
 * stay friendly.
 */
import { KIRO_MODEL_CATALOG, type KiroModelDescriptor } from "../constants.js";
import { log } from "../plugin/debug.js";

export interface ModelListEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: "kiro";
  display_name: string;
  capabilities: { tool_call: boolean; vision: boolean };
}

export interface ModelListPayload {
  object: "list";
  data: ModelListEntry[];
}

function toEntry(m: KiroModelDescriptor, created: number): ModelListEntry {
  return {
    id: m.id,
    object: "model",
    created,
    owned_by: "kiro",
    display_name: m.displayName,
    capabilities: { tool_call: m.toolCall, vision: m.vision },
  };
}

async function listFromProvider(): Promise<KiroModelDescriptor[] | undefined> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("kiro-acp-ai-provider")) as Record<string, unknown>;
  } catch (err) {
    log.debug("listModels: provider import failed", { error: String(err) });
    return undefined;
  }
  const fn = mod["listModels"];
  if (typeof fn !== "function") return undefined;
  try {
    const raw = (await (fn as () => unknown)()) as unknown;
    if (!Array.isArray(raw)) return undefined;
    return raw
      .map((entry): KiroModelDescriptor | null => {
        if (typeof entry === "string") {
          const known = KIRO_MODEL_CATALOG.find((m) => m.id === entry);
          if (known) return known;
          return { id: entry, displayName: entry, toolCall: true, vision: false };
        }
        if (entry && typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          const id = typeof obj["id"] === "string" ? (obj["id"] as string) : undefined;
          if (!id) return null;
          const displayName =
            typeof obj["displayName"] === "string"
              ? (obj["displayName"] as string)
              : typeof obj["name"] === "string"
                ? (obj["name"] as string)
                : id;
          return { id, displayName, toolCall: true, vision: false };
        }
        return null;
      })
      .filter((m): m is KiroModelDescriptor => m !== null);
  } catch (err) {
    log.warn("listModels: provider call failed, falling back to static catalog", { error: String(err) });
    return undefined;
  }
}

export async function listKiroModels(): Promise<KiroModelDescriptor[]> {
  const dynamic = await listFromProvider();
  if (dynamic && dynamic.length > 0) {
    // Merge: prefer dynamic ids but keep curated displayName/capabilities
    // when we have a curated entry.
    return dynamic.map((entry) => {
      const curated = KIRO_MODEL_CATALOG.find((m) => m.id === entry.id);
      return curated ?? entry;
    });
  }
  return [...KIRO_MODEL_CATALOG];
}

export async function buildModelListResponse(): Promise<ModelListPayload> {
  const created = Math.floor(Date.now() / 1000);
  const models = await listKiroModels();
  return {
    object: "list",
    data: models.map((m) => toEntry(m, created)),
  };
}
