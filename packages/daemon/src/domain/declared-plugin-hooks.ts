import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { getDefaultOpenRigPath } from "../openrig-compat.js";

// A plugin an agent spec declares under `resources.plugins` is projected into the seat's folder, where neither Claude
// Code nor Codex loads plugins from, so its hooks never ran. One that says `run_hooks: true` is loaded where each runtime
// does load plugins, in every seat that selects it:
// - Claude Code: its resolved location goes on the seat's CLAUDE_CODE_PLUGIN_DIRS, after the vendored openrig-core. That
//   loads the whole plugin, its skills and commands too, not only its hooks.
// - Codex: OpenRig installs it with Codex's own commands into the seat's Codex home, from a marketplace of copies it keeps,
//   and approves its hooks when the installed copy matches the declared source byte for byte (codex-declared-plugins.ts).
// The shipped openrig-core plugin keeps its own route (claude-core-plugin-env.ts, the Codex adapter's core install) and is
// never handled here, however it is selected.

export interface HookPlugin {
  /** The plugin's resolved location. */
  path: string;
  /** The runtimes the resource says it is for: an explicit one, or "auto" for whichever manifests it has. */
  pluginType: "claude" | "codex" | "auto";
}

type PluginEntry = { category: string; absolutePath: string; pluginType?: string; runHooks?: boolean };

/** The plugins whose hooks run, from a node's persisted projection entries. */
export function hookPluginsOf(entries: ReadonlyArray<PluginEntry>): HookPlugin[] {
  return entries
    .filter((entry) => entry.category === "plugin" && entry.runHooks === true)
    .map((entry) => ({
      path: entry.absolutePath,
      pluginType: entry.pluginType === "claude" || entry.pluginType === "codex" ? entry.pluginType : "auto",
    }));
}

/** The hook plugins the node's last launch resolved, or undefined when none were saved (or they can't be read). */
export function persistedHookPlugins(db: Database.Database, nodeId: string): HookPlugin[] | undefined {
  try {
    const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as { projection_entries_json: string } | undefined;
    if (!row) return undefined;
    const entries = JSON.parse(row.projection_entries_json) as unknown;
    return Array.isArray(entries) ? hookPluginsOf(entries.filter((e): e is PluginEntry =>
      typeof e === "object" && e !== null && typeof (e as { category?: unknown }).category === "string"
      && typeof (e as { absolutePath?: unknown }).absolutePath === "string")) : undefined;
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Whether `path` is the shipped openrig-core under `pluginsDir`, which keeps its own route. */
function isCorePlugin(path: string, pluginsDir: string): boolean {
  return canonical(path) === canonical(join(pluginsDir, "openrig-core"));
}

function hasManifest(path: string, folder: ".claude-plugin" | ".codex-plugin"): boolean {
  return existsSync(join(path, folder, "plugin.json"));
}

/** The Claude plugin folders to load for these hook plugins: each one for Claude (explicitly, or with a Claude manifest),
 *  absolute, and without a colon, which CLAUDE_CODE_PLUGIN_DIRS would split it at. One left out is named in `skipped`. */
export function claudeHookPluginDirs(plugins: readonly HookPlugin[], pluginsDir: string = getDefaultOpenRigPath("plugins")):
  { dirs: string[]; skipped: string[] } {
  const dirs: string[] = [];
  const skipped: string[] = [];
  for (const plugin of plugins) {
    if (plugin.pluginType === "codex" || isCorePlugin(plugin.path, pluginsDir)) continue;
    if (!hasManifest(plugin.path, ".claude-plugin")) {
      if (plugin.pluginType === "claude") skipped.push(`${plugin.path}: no .claude-plugin/plugin.json`);
      continue;
    }
    if (!isAbsolute(plugin.path) || plugin.path.includes(":")) {
      skipped.push(`${plugin.path}: CLAUDE_CODE_PLUGIN_DIRS takes only an absolute path without a colon`);
      continue;
    }
    if (!dirs.some((dir) => canonical(dir) === canonical(plugin.path))) dirs.push(plugin.path);
  }
  return { dirs, skipped };
}

/** The plugin folders Codex installs for these hook plugins: each one for Codex (explicitly, or with a Codex or Claude
 *  manifest, both of which Codex reads). */
export function codexHookPluginDirs(plugins: readonly HookPlugin[], pluginsDir: string = getDefaultOpenRigPath("plugins")): string[] {
  const dirs: string[] = [];
  for (const plugin of plugins) {
    if (plugin.pluginType === "claude" || isCorePlugin(plugin.path, pluginsDir)) continue;
    if (!hasManifest(plugin.path, ".codex-plugin") && !hasManifest(plugin.path, ".claude-plugin")) continue;
    if (!dirs.some((dir) => canonical(dir) === canonical(plugin.path))) dirs.push(plugin.path);
  }
  return dirs;
}

/**
 * The declared plugin folders to load into this node's Claude process: none unless it is a Claude seat. `selected` is the
 * selection a launch has just resolved or a snapshot saved; without it the node's persisted startup context is read.
 */
export function seatClaudeHookPluginDirs(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selected?: readonly HookPlugin[],
  pluginsDir?: string,
): string[] {
  if (node.runtime !== "claude-code") return [];
  const { dirs, skipped } = claudeHookPluginDirs(selected ?? persistedHookPlugins(db, node.id) ?? [], pluginsDir);
  for (const reason of skipped) console.warn(`[openrig] plugin hooks not loaded for ${node.id}: ${reason}`);
  return dirs;
}

/** The declared plugin folders a Codex seat installs and runs the hooks of: none unless it is a Codex seat. */
export function seatCodexHookPluginDirs(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selected?: readonly HookPlugin[],
  pluginsDir?: string,
): string[] {
  if (node.runtime !== "codex") return [];
  return codexHookPluginDirs(selected ?? persistedHookPlugins(db, node.id) ?? [], pluginsDir);
}
