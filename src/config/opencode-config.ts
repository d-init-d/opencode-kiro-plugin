/**
 * Safely add the Kiro provider/plugin entries into a user's `opencode.json`.
 *
 * Rules:
 *   - Always back up before writing (`opencode.json.bak.<timestamp>`).
 *   - Never overwrite the user's chosen `model` / `small_model` defaults
 *     unless `forceDefaultModel` is set.
 *   - Idempotent: running the merge twice should not produce duplicates.
 *   - Locked with `proper-lockfile` to avoid corrupting concurrent writes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { xdgConfig } from "xdg-basedir";
import {
  KIRO_MODEL_CATALOG,
  PLUGIN_PACKAGE_NAME,
  SYNTHETIC_BASE_URL,
  DEFAULT_PROVIDER_ID,
} from "../constants.js";
import { log } from "../plugin/debug.js";

export interface MergeOpenCodeConfigOptions {
  /** Provider id to register under `provider`. Defaults to `kiro`. */
  providerId?: string;
  /** Plugin package spec to add into `plugin`. Defaults to `opencode-kiro-plugin`. */
  pluginSpec?: string;
  /** When true, set `model` / `small_model` even if user already set them. */
  forceDefaultModel?: boolean;
  /** Path override for testing. */
  configPath?: string;
}

export interface MergeOpenCodeConfigResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
  added: {
    plugin: boolean;
    provider: boolean;
    models: string[];
    defaultModel: boolean;
    smallModel: boolean;
  };
}

interface AnyRecord {
  [key: string]: unknown;
}

export function defaultOpenCodeConfigPath(): string {
  const base = xdgConfig ?? path.join(process.env["HOME"] ?? process.cwd(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

async function readJsonIfExists(file: string): Promise<AnyRecord | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("opencode.json phải là một object JSON.");
    }
    return parsed as AnyRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function mergePluginArray(existing: unknown, pluginSpec: string): { value: unknown[]; added: boolean } {
  if (!Array.isArray(existing)) return { value: [pluginSpec], added: true };
  const has = existing.some(
    (entry) => typeof entry === "string" && entry === pluginSpec
  );
  if (has) return { value: [...existing], added: false };
  return { value: [...existing, pluginSpec], added: true };
}

interface MergeProviderResult {
  value: AnyRecord;
  added: boolean;
  models: string[];
}

function mergeProviderEntry(existing: unknown, providerId: string): MergeProviderResult {
  const root = (existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as AnyRecord)
    : {}) as AnyRecord;
  const previous = (root[providerId] && typeof root[providerId] === "object"
    ? (root[providerId] as AnyRecord)
    : undefined);
  const wasMissing = previous === undefined;

  const previousOptions =
    (previous?.["options"] && typeof previous["options"] === "object" && !Array.isArray(previous["options"])
      ? (previous["options"] as AnyRecord)
      : {}) as AnyRecord;
  const previousModels =
    (previous?.["models"] && typeof previous["models"] === "object" && !Array.isArray(previous["models"])
      ? (previous["models"] as AnyRecord)
      : {}) as AnyRecord;

  const mergedModels: AnyRecord = { ...previousModels };
  const addedModels: string[] = [];
  for (const m of KIRO_MODEL_CATALOG) {
    if (!mergedModels[m.id]) {
      mergedModels[m.id] = { name: m.displayName };
      addedModels.push(m.id);
    }
  }

  const merged: AnyRecord = {
    ...previous,
    npm: previous?.["npm"] ?? "@ai-sdk/openai-compatible",
    name: previous?.["name"] ?? "Kiro",
    options: { ...previousOptions, baseURL: SYNTHETIC_BASE_URL },
    models: mergedModels,
  };

  return {
    value: { ...root, [providerId]: merged },
    added: wasMissing,
    models: addedModels,
  };
}

async function backup(file: string): Promise<string | undefined> {
  try {
    await fs.access(file);
  } catch {
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak.${stamp}`;
  await fs.copyFile(file, target);
  return target;
}

/**
 * Merge plugin/provider/model definitions into an OpenCode config file.
 */
export async function mergeOpenCodeConfig(
  options: MergeOpenCodeConfigOptions = {}
): Promise<MergeOpenCodeConfigResult> {
  const configPath = options.configPath ?? defaultOpenCodeConfigPath();
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const pluginSpec = options.pluginSpec ?? PLUGIN_PACKAGE_NAME;

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    // Touch the file so `proper-lockfile` can lock it.
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(configPath, "{}\n", { encoding: "utf8" });
    }
    release = await lockfile.lock(configPath, { retries: { retries: 5, minTimeout: 50, factor: 2 } });

    const existing = (await readJsonIfExists(configPath)) ?? {};
    const next: AnyRecord = { ...existing };

    if (!next["$schema"]) next["$schema"] = "https://opencode.ai/config.json";

    const pluginMerge = mergePluginArray(existing["plugin"], pluginSpec);
    next["plugin"] = pluginMerge.value;

    const providerMerge = mergeProviderEntry(existing["provider"], providerId);
    next["provider"] = providerMerge.value;

    const modelDefault = `${providerId}/claude-opus-4.6`;
    const smallDefault = `${providerId}/claude-sonnet-4.6`;
    const addedDefault = !next["model"] || options.forceDefaultModel === true;
    const addedSmall = !next["small_model"] || options.forceDefaultModel === true;
    if (addedDefault) next["model"] = modelDefault;
    if (addedSmall) next["small_model"] = smallDefault;

    const changed =
      pluginMerge.added ||
      providerMerge.added ||
      providerMerge.models.length > 0 ||
      addedDefault ||
      addedSmall ||
      JSON.stringify(existing) !== JSON.stringify(next);

    let backupPath: string | undefined;
    if (changed) {
      backupPath = await backup(configPath);
      const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
      await fs.rename(tmp, configPath);
      log.info("opencode.json đã được cập nhật", {
        configPath,
        addedPlugin: pluginMerge.added,
        addedProvider: providerMerge.added,
        addedModels: providerMerge.models,
      });
    }

    const result: MergeOpenCodeConfigResult = {
      configPath,
      changed,
      added: {
        plugin: pluginMerge.added,
        provider: providerMerge.added,
        models: providerMerge.models,
        defaultModel: addedDefault,
        smallModel: addedSmall,
      },
    };
    if (backupPath) result.backupPath = backupPath;
    return result;
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        log.warn("Giải phóng lock opencode.json thất bại", { error: String(err) });
      }
    }
  }
}


// ---------- Local server sync ----------

export interface SyncLocalServerInput {
  providerId?: string;
  baseURL: string;
  bearerToken: string;
  configPath?: string;
}

/**
 * Update the provider entry to point at the in-process local server.
 *
 * Unlike `mergeOpenCodeConfig()` this is called on EVERY plugin load because
 * the local server picks a random port each time and the bearer token is
 * regenerated. Touching `opencode.json` on every start is OK because:
 *   - the only fields we touch are `provider.<id>.options.{baseURL, headers}`
 *   - we never overwrite plugin/provider lists or model defaults
 *   - we never write user secrets here (the bearer is a per-process random
 *     value used only between OpenCode and the in-process server)
 *
 * If the user has not yet registered the Kiro provider via
 * `mergeOpenCodeConfig`, this function bootstraps a minimal entry so OpenCode
 * still recognises the provider id.
 */
export async function syncOpenCodeProviderToLocalServer(
  input: SyncLocalServerInput
): Promise<{ configPath: string; changed: boolean }> {
  const configPath = input.configPath ?? defaultOpenCodeConfigPath();
  const providerId = input.providerId ?? DEFAULT_PROVIDER_ID;

  await fs.mkdir(path.dirname(configPath), { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(configPath, "{}\n", { encoding: "utf8" });
    }
    release = await lockfile.lock(configPath, { retries: { retries: 5, minTimeout: 50, factor: 2 } });

    const existing = (await readJsonIfExists(configPath)) ?? {};
    const next: AnyRecord = { ...existing };
    if (!next["$schema"]) next["$schema"] = "https://opencode.ai/config.json";

    const providerRoot = (next["provider"] && typeof next["provider"] === "object" && !Array.isArray(next["provider"])
      ? (next["provider"] as AnyRecord)
      : {}) as AnyRecord;
    const previous = (providerRoot[providerId] && typeof providerRoot[providerId] === "object"
      ? (providerRoot[providerId] as AnyRecord)
      : undefined);

    const previousOptions =
      (previous?.["options"] && typeof previous["options"] === "object" && !Array.isArray(previous["options"])
        ? (previous["options"] as AnyRecord)
        : {}) as AnyRecord;

    // Compose the next options. We always overwrite baseURL and the
    // Authorization header so re-runs converge on the latest local server,
    // but we keep any other options the user added (e.g. timeouts).
    const nextOptions: AnyRecord = { ...previousOptions, baseURL: input.baseURL };
    const previousHeaders =
      (previousOptions["headers"] && typeof previousOptions["headers"] === "object" && !Array.isArray(previousOptions["headers"])
        ? (previousOptions["headers"] as AnyRecord)
        : {}) as AnyRecord;
    nextOptions["headers"] = { ...previousHeaders, Authorization: `Bearer ${input.bearerToken}` };

    const previousModels =
      (previous?.["models"] && typeof previous["models"] === "object" && !Array.isArray(previous["models"])
        ? (previous["models"] as AnyRecord)
        : {}) as AnyRecord;
    const mergedModels: AnyRecord = { ...previousModels };
    for (const m of KIRO_MODEL_CATALOG) {
      if (!mergedModels[m.id]) mergedModels[m.id] = { name: m.displayName };
    }

    const merged: AnyRecord = {
      ...previous,
      npm: previous?.["npm"] ?? "@ai-sdk/openai-compatible",
      name: previous?.["name"] ?? "Kiro",
      options: nextOptions,
      models: mergedModels,
    };

    next["provider"] = { ...providerRoot, [providerId]: merged };

    const changed = JSON.stringify(existing) !== JSON.stringify(next);
    if (changed) {
      const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
      await fs.rename(tmp, configPath);
      log.info("opencode.json provider synced to local server", { configPath, providerId });
    }
    return { configPath, changed };
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        log.warn("Releasing opencode.json lock failed (sync)", { error: String(err) });
      }
    }
  }
}
