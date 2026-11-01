// A declared plugin with `run_hooks: true` is loaded where each runtime loads plugins: these cover which plugins each
// runtime gets, from a launch's selection or a node's saved projection entries.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeHookPluginDirs, codexHookPluginDirs, hookPluginsOf, seatClaudeHookPluginDirs, seatCodexHookPluginDirs,
  type HookPlugin,
} from "../src/domain/declared-plugin-hooks.js";
import { selectedHookPlugins, type ResolvedResources } from "../src/domain/profile-resolver.js";

let root: string;
let pluginsDir: string;

function plugin(name: string, manifests: Array<".claude-plugin" | ".codex-plugin">, parent = root): string {
  const dir = join(parent, name);
  for (const folder of manifests) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const noDb = {} as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "declared-plugin-hooks-"));
  pluginsDir = join(root, "openrig-home-plugins");
  plugin("openrig-core", [".claude-plugin", ".codex-plugin"], pluginsDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hookPluginsOf", () => {
  it("keeps only plugin entries that run their hooks", () => {
    expect(hookPluginsOf([
      { category: "plugin", absolutePath: "/a", pluginType: "claude", runHooks: true },
      { category: "plugin", absolutePath: "/b", pluginType: "auto" },
      { category: "skill", absolutePath: "/c", runHooks: true },
      { category: "plugin", absolutePath: "/d", runHooks: true },
    ])).toEqual([{ path: "/a", pluginType: "claude" }, { path: "/d", pluginType: "auto" }]);
  });
});

describe("claudeHookPluginDirs", () => {
  it("loads a plugin with a Claude manifest, and leaves out Codex-only ones and openrig-core", () => {
    const both = plugin("both", [".claude-plugin", ".codex-plugin"]);
    const codexOnly = plugin("codex-only", [".codex-plugin"]);
    const forCodex = plugin("for-codex", [".claude-plugin"]);
    const plugins: HookPlugin[] = [
      { path: both, pluginType: "auto" },
      { path: codexOnly, pluginType: "auto" },
      { path: forCodex, pluginType: "codex" },
      { path: join(pluginsDir, "openrig-core"), pluginType: "auto" },
    ];
    expect(claudeHookPluginDirs(plugins, pluginsDir)).toEqual({ dirs: [both], skipped: [] });
  });

  it("names a plugin it can't load: no Claude manifest when it says it is for Claude, or a colon in its path", () => {
    const bare = plugin("bare", []);
    const colon = plugin("shared:guards", [".claude-plugin"]);
    const { dirs, skipped } = claudeHookPluginDirs([
      { path: bare, pluginType: "claude" },
      { path: colon, pluginType: "auto" },
    ], pluginsDir);
    expect(dirs).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toContain("no .claude-plugin/plugin.json");
    expect(skipped[1]).toContain("without a colon");
  });

  it("lists a plugin selected twice once", () => {
    const guards = plugin("guards", [".claude-plugin"]);
    expect(claudeHookPluginDirs([{ path: guards, pluginType: "auto" }, { path: `${guards}/`, pluginType: "claude" }], pluginsDir).dirs)
      .toEqual([guards]);
  });
});

describe("codexHookPluginDirs", () => {
  it("installs a plugin with either manifest, and leaves out Claude-only ones and openrig-core", () => {
    const claudeManifest = plugin("claude-manifest", [".claude-plugin"]);
    const codexManifest = plugin("codex-manifest", [".codex-plugin"]);
    const forClaude = plugin("for-claude", [".claude-plugin", ".codex-plugin"]);
    const bare = plugin("bare", []);
    expect(codexHookPluginDirs([
      { path: claudeManifest, pluginType: "auto" },
      { path: codexManifest, pluginType: "codex" },
      { path: forClaude, pluginType: "claude" },
      { path: bare, pluginType: "auto" },
      { path: join(pluginsDir, "openrig-core"), pluginType: "codex" },
    ], pluginsDir)).toEqual([claudeManifest, codexManifest]);
  });
});

describe("a seat's runtime decides which list it gets", () => {
  it("gives Claude dirs only to a Claude seat and Codex dirs only to a Codex seat", () => {
    const guards = plugin("guards", [".claude-plugin"]);
    const selected: HookPlugin[] = [{ path: guards, pluginType: "auto" }];
    expect(seatClaudeHookPluginDirs({ id: "n1", runtime: "claude-code" }, noDb, selected, pluginsDir)).toEqual([guards]);
    expect(seatClaudeHookPluginDirs({ id: "n1", runtime: "codex" }, noDb, selected, pluginsDir)).toEqual([]);
    expect(seatCodexHookPluginDirs({ id: "n1", runtime: "codex" }, noDb, selected, pluginsDir)).toEqual([guards]);
    expect(seatCodexHookPluginDirs({ id: "n1", runtime: "claude-code" }, noDb, selected, pluginsDir)).toEqual([]);
  });
});

describe("selectedHookPlugins", () => {
  it("resolves each selected plugin that runs its hooks", () => {
    const resources: ResolvedResources = {
      skills: [], guidance: [], subagents: [], runtimeResources: [],
      plugins: [
        { effectiveId: "guards", sourceSpec: "depot", sourcePath: "/specs/depot",
          resource: { id: "guards", source: { kind: "local", path: "plugins/guards" }, runHooks: true } },
        { effectiveId: "plain", sourceSpec: "depot", sourcePath: "/specs/depot",
          resource: { id: "plain", source: { kind: "local", path: "/abs/plain" }, pluginType: "claude" } },
      ],
    };
    expect(selectedHookPlugins(resources)).toEqual([{ path: "/specs/depot/plugins/guards", pluginType: "auto" }]);
  });
});
