import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  mergeOpenCodeConfig,
} from "../src/config/opencode-config.js";
import {
  PLUGIN_PACKAGE_NAME,
  SYNTHETIC_BASE_URL,
  KIRO_MODEL_CATALOG,
} from "../src/constants.js";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kiro-test-"));
  cfgPath = path.join(tmpDir, "opencode.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readJson(file: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("mergeOpenCodeConfig", () => {
  it("creates a fresh config when none exists", async () => {
    const result = await mergeOpenCodeConfig({ configPath: cfgPath });
    expect(result.changed).toBe(true);
    expect(result.added.plugin).toBe(true);
    expect(result.added.provider).toBe(true);
    expect(result.added.models.length).toBe(KIRO_MODEL_CATALOG.length);

    const written = await readJson(cfgPath);
    expect(Array.isArray(written["plugin"])).toBe(true);
    expect((written["plugin"] as unknown[]).includes(PLUGIN_PACKAGE_NAME)).toBe(true);
    expect(written["provider"]).toBeDefined();
    const provider = (written["provider"] as Record<string, unknown>)["kiro"] as Record<string, unknown>;
    expect((provider["options"] as Record<string, unknown>)["baseURL"]).toBe(SYNTHETIC_BASE_URL);
    const models = provider["models"] as Record<string, unknown>;
    expect(models["claude-opus-4.6"]).toBeDefined();
    expect(models["claude-opus-4.7"]).toBeDefined();
    expect(written["model"]).toBe("kiro/claude-opus-4.6");
    expect(written["small_model"]).toBe("kiro/claude-sonnet-4.6");
  });

  it("is idempotent on repeated runs", async () => {
    const first = await mergeOpenCodeConfig({ configPath: cfgPath });
    expect(first.changed).toBe(true);
    const before = await readJson(cfgPath);
    const second = await mergeOpenCodeConfig({ configPath: cfgPath });
    expect(second.added.plugin).toBe(false);
    expect(second.added.provider).toBe(false);
    expect(second.added.models).toEqual([]);
    const after = await readJson(cfgPath);
    expect(after).toEqual(before);
  });

  it("preserves user-defined default model", async () => {
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["other-plugin"],
        provider: {
          openai: { name: "OpenAI", options: { baseURL: "https://api.openai.com/v1" } },
        },
        model: "openai/gpt-4o",
        small_model: "openai/gpt-4o-mini",
      }),
      "utf8"
    );
    const result = await mergeOpenCodeConfig({ configPath: cfgPath });
    expect(result.added.defaultModel).toBe(false);
    expect(result.added.smallModel).toBe(false);
    const after = await readJson(cfgPath);
    expect(after["model"]).toBe("openai/gpt-4o");
    expect(after["small_model"]).toBe("openai/gpt-4o-mini");
    const plugins = after["plugin"] as unknown[];
    expect(plugins).toContain("other-plugin");
    expect(plugins).toContain(PLUGIN_PACKAGE_NAME);
    const provider = (after["provider"] as Record<string, unknown>)["kiro"] as Record<string, unknown>;
    expect(provider).toBeDefined();
    expect((provider["options"] as Record<string, unknown>)["baseURL"]).toBe(SYNTHETIC_BASE_URL);
  });

  it("creates a backup when the file already exists", async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ existing: true }), "utf8");
    const result = await mergeOpenCodeConfig({ configPath: cfgPath });
    expect(result.backupPath).toBeTruthy();
    if (result.backupPath) {
      const backupRaw = await fs.readFile(result.backupPath, "utf8");
      expect(JSON.parse(backupRaw)).toEqual({ existing: true });
    }
  });

  it("rejects non-object opencode.json", async () => {
    await fs.writeFile(cfgPath, JSON.stringify(["array", "not", "object"]), "utf8");
    await expect(mergeOpenCodeConfig({ configPath: cfgPath })).rejects.toThrow();
  });
});
