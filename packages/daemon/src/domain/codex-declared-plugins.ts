import fs from "node:fs";
import nodePath from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  CODEX_MARKETPLACE_MANIFEST_PATH, codexCorePluginEnablement, codexReadableConfigLayers, recordedMarketplaceSource,
  userLayerEnablesCorePlugin, type CodexConfigLayerRead,
} from "./codex-core-plugin-install.js";
import { codexPluginContentHash } from "./codex-owned-plugin-trust.js";

// Codex runs a plugin's hooks only when the plugin is installed through one of its marketplaces, enabled in its config,
// and each hook is approved there by hash. A declared plugin with `run_hooks: true` (declared-plugin-hooks.ts) gets all
// three from OpenRig, in the seat's Codex home, on every launch:
//
// 1. Copy. OpenRig keeps a copy of each such plugin in a marketplace of its own, `openrig-declared`, under the OpenRig
//    home, and refreshes the copy when the declared source changes. Codex's marketplace sources must sit inside the
//    marketplace folder, and the copy is the exact bytes approved below.
// 2. Install. Codex's own commands (`codex plugin marketplace add`, `codex plugin add`) install it, the same way OpenRig
//    installs openrig-core. Running `codex plugin add` again refreshes Codex's cached copy, at the same version or a new
//    one, so a cache that differs from OpenRig's copy is installed again. A person's `enabled = false` for the plugin, an
//    effective `plugins._default` that disables plugins, or a marketplace of the same name with another source, is left
//    alone, as for openrig-core.
// 3. Approve. Once Codex's cached copy matches OpenRig's copy byte for byte, each of the plugin's command hooks gets
//    `trusted_hash` (Codex's hash of the hook's declaration) and `trusted_content_hash` (its hash of the whole plugin) in
//    `[hooks.state."<plugin>@openrig-declared:<hooks file>:<event>:<group>:<handler>"]`. Codex asks again whenever the
//    plugin's files change, so this runs after every refresh. The spec's `run_hooks: true` is the approval: unlike
//    openrig-core, whose bytes the daemon ships, a declared plugin's bytes are whatever its source holds, and the spec's
//    author chose that source. A hook's `enabled` setting is never changed.
//
// A plugin installed into a Codex home runs in every Codex session that uses that home, not only in the seats that
// selected it: a Codex home is shared state. Its hooks see OPENRIG_SESSION_NAME in a seat and can check it if they must.

export const CODEX_DECLARED_MARKETPLACE = "openrig-declared";

const codexHookTrust = createRequire(import.meta.url)("../../assets/plugins/openrig-core/hooks/scripts/codex-hook-trust.cjs") as {
  codexHookHash(eventLabel: string, handler: Record<string, unknown>): string;
};

/** Codex's snake_case label for each hook event a plugin's hooks file may name (codex-rs HookEventName, rust-v0.165.0). */
export const CODEX_HOOK_EVENT_LABELS: Readonly<Record<string, string>> = {
  PreModelRequest: "pre_model_request",
  PostModelRequest: "post_model_request",
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

const SAFE_NAME = /^[0-9A-Za-z._-]+$/;

export interface DeclaredPluginManifest { name: string; version: string; hooksFile: string }

/** A plugin folder's name, version and hooks file, from its Codex manifest, else its Claude one (Codex reads both). */
export function readDeclaredPluginManifest(dir: string): DeclaredPluginManifest | { error: string } {
  for (const folder of [".codex-plugin", ".claude-plugin"]) {
    const file = nodePath.join(dir, folder, "plugin.json");
    if (!fs.existsSync(file)) continue;
    let manifest: { name?: unknown; version?: unknown; hooks?: unknown };
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return { error: `${folder}/plugin.json isn't readable JSON` }; }
    if (typeof manifest.name !== "string" || !SAFE_NAME.test(manifest.name)) return { error: `${folder}/plugin.json has no usable name` };
    if (typeof manifest.version !== "string" || !SAFE_NAME.test(manifest.version)) return { error: `${folder}/plugin.json has no usable version` };
    const declared = typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json";
    const hooksFile = nodePath.posix.normalize(declared.replace(/\\/g, "/")).replace(/^\.\//, "");
    if (hooksFile.startsWith("../") || nodePath.posix.isAbsolute(hooksFile)) return { error: `${folder}/plugin.json names a hooks file outside the plugin` };
    return { name: manifest.name, version: manifest.version, hooksFile };
  }
  return { error: "no .codex-plugin/plugin.json or .claude-plugin/plugin.json" };
}

/** Each command hook's approval key and declaration hash, from the plugin's hooks file. A hook Codex's recipe can't be
 *  reproduced for (an unknown event, a non-command handler, no numeric timeout) is named in `skipped` and left to
 *  Codex's own review. */
export function declaredHookTrust(pluginRoot: string, manifest: DeclaredPluginManifest): { declarations: Record<string, string>; skipped: string[] } {
  const declarations: Record<string, string> = {};
  const skipped: string[] = [];
  const file = nodePath.join(pluginRoot, manifest.hooksFile);
  if (!fs.existsSync(file)) return { declarations, skipped };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> };
  const keySource = `${manifest.name}@${CODEX_DECLARED_MARKETPLACE}:${manifest.hooksFile}`;
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    const label = CODEX_HOOK_EVENT_LABELS[event];
    if (!label) { skipped.push(`${event}: not a Codex hook event`); continue; }
    if (!Array.isArray(groups)) { skipped.push(`${event}: not a list of hook groups`); continue; }
    groups.forEach((group: { matcher?: unknown; hooks?: unknown }, groupIndex) => {
      const handlers = Array.isArray(group?.hooks) ? group.hooks as Array<Record<string, unknown>> : [];
      handlers.forEach((handler, handlerIndex) => {
        const where = `${event}[${groupIndex}].hooks[${handlerIndex}]`;
        if ((handler["type"] ?? "command") !== "command" || typeof handler["command"] !== "string") { skipped.push(`${where}: not a command hook`); return; }
        if (typeof handler["timeout"] !== "number") { skipped.push(`${where}: no numeric timeout`); return; }
        const hash = codexHookTrust.codexHookHash(label, {
          command: handler["command"], timeoutSec: handler["timeout"], async: handler["async"] === true,
          ...(handler["statusMessage"] != null ? { statusMessage: handler["statusMessage"] } : {}),
          ...(handler["additionalContextLimit"] != null ? { additionalContextLimit: handler["additionalContextLimit"] } : {}),
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
        });
        declarations[`${keySource}:${label}:${groupIndex}:${handlerIndex}`] = hash;
      });
    });
  }
  return { declarations, skipped };
}

export interface DeclaredPluginFsOps {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
}

export interface DeclaredPluginInstallDeps {
  fs: DeclaredPluginFsOps;
  /** Runs `codex` with these arguments and environment. */
  runCodexCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** The Codex home to install into, and its config.toml. */
  codexHome: string;
  configPath: string;
  /** Where Codex's system and legacy managed config files live. */
  systemConfigDir: string;
  /** OpenRig's marketplace folder for declared plugins. */
  marketplaceRoot: string;
  launchPath?: string;
  /** Sets one field of `[hooks.state."<key>"]` in the config text, keeping the rest of it (the adapter's
   *  upsertCodexHookTrust line writer). */
  upsertTrust(content: string, key: string, hash: string, field: "trusted_hash" | "trusted_content_hash"): string;
}

export type DeclaredPluginOutcome = { dir: string; name?: string; outcome: "installed" | "current" | "skipped"; reason: string; approved?: number };

function strictHash(dir: string): string | undefined {
  try { return codexPluginContentHash(dir, true); } catch { return undefined; }
}

function canonical(path: string): string {
  try { return fs.realpathSync.native(nodePath.resolve(path)); } catch { return nodePath.resolve(path); }
}

/** The marketplace manifest listing every plugin copy in the marketplace folder. */
function marketplaceManifest(root: string): string {
  const plugins = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && SAFE_NAME.test(entry.name)
      && !("error" in readDeclaredPluginManifest(nodePath.join(root, entry.name))))
    .map((entry) => entry.name).sort() : [];
  return `${JSON.stringify({
    name: CODEX_DECLARED_MARKETPLACE,
    interface: { displayName: "OpenRig declared plugins" },
    plugins: plugins.map((name) => ({ name, source: `./${name}` })),
  }, null, 2)}\n`;
}

/**
 * Install, refresh and approve these declared plugins in one Codex home. Each plugin's outcome is returned, and nothing
 * here throws for one plugin's problem: a plugin that can't be handled is skipped and the rest go on.
 */
export async function ensureCodexDeclaredPlugins(dirs: readonly string[], deps: DeclaredPluginInstallDeps): Promise<DeclaredPluginOutcome[]> {
  const outcomes: DeclaredPluginOutcome[] = [];
  const plugins: Array<{ dir: string; manifest: DeclaredPluginManifest; copy: string }> = [];
  for (const dir of dirs) {
    const manifest = readDeclaredPluginManifest(dir);
    if ("error" in manifest) { outcomes.push({ dir, outcome: "skipped", reason: manifest.error }); continue; }
    const other = plugins.find((plugin) => plugin.manifest.name === manifest.name);
    if (other) {
      if (canonical(other.dir) !== canonical(dir)) outcomes.push({ dir, name: manifest.name, outcome: "skipped", reason: `${other.dir} is also named ${manifest.name}` });
      continue;
    }
    const copy = nodePath.join(deps.marketplaceRoot, manifest.name);
    const source = strictHash(dir);
    if (!source) { outcomes.push({ dir, name: manifest.name, outcome: "skipped", reason: "the plugin folder can't be read" }); continue; }
    if (strictHash(copy) !== source) {
      fs.rmSync(copy, { recursive: true, force: true });
      fs.mkdirSync(deps.marketplaceRoot, { recursive: true });
      fs.cpSync(dir, copy, { recursive: true, dereference: true });
      if (strictHash(copy) !== source) { outcomes.push({ dir, name: manifest.name, outcome: "skipped", reason: "the plugin changed while OpenRig copied it" }); continue; }
    }
    plugins.push({ dir, manifest, copy });
  }
  if (plugins.length === 0) return outcomes;

  const manifestPath = nodePath.join(deps.marketplaceRoot, CODEX_MARKETPLACE_MANIFEST_PATH);
  const manifest = marketplaceManifest(deps.marketplaceRoot);
  if (!deps.fs.exists(manifestPath) || deps.fs.readFile(manifestPath) !== manifest) {
    deps.fs.mkdirp(nodePath.dirname(manifestPath));
    deps.fs.writeFile(manifestPath, manifest);
  }

  const readLayers = (): CodexConfigLayerRead[] => codexReadableConfigLayers(deps.codexHome, deps.systemConfigDir).map((layer) => {
    if (!deps.fs.exists(layer.path)) return { ...layer, state: "absent" as const };
    try { return { ...layer, state: "read" as const, content: deps.fs.readFile(layer.path) }; }
    catch (error) { return { ...layer, state: "unreadable" as const, reason: (error as Error).message }; }
  });
  const userConfig = (layers: CodexConfigLayerRead[]) => {
    const user = layers.find((layer) => layer.name === "user config");
    return user?.state === "read" ? user.content : null;
  };
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: deps.codexHome, ...(deps.launchPath ? { PATH: deps.launchPath } : {}) };

  const recorded = recordedMarketplaceSource(userConfig(readLayers()), CODEX_DECLARED_MARKETPLACE);
  if (recorded !== undefined && (recorded === null || canonical(recorded) !== canonical(deps.marketplaceRoot))) {
    for (const plugin of plugins) outcomes.push({ dir: plugin.dir, name: plugin.manifest.name, outcome: "skipped",
      reason: `a marketplace named ${CODEX_DECLARED_MARKETPLACE} is already configured with another source; it's left alone` });
    return outcomes;
  }
  if (recorded === undefined) {
    const added = await deps.runCodexCli(["plugin", "marketplace", "add", deps.marketplaceRoot], env);
    if (added.status !== 0) {
      const reason = `codex plugin marketplace add failed: ${(added.stderr || added.stdout).trim() || `exit ${added.status}`}`;
      for (const plugin of plugins) outcomes.push({ dir: plugin.dir, name: plugin.manifest.name, outcome: "skipped", reason });
      return outcomes;
    }
  }

  for (const plugin of plugins) {
    const { name, version } = plugin.manifest;
    const key = `${name}@${CODEX_DECLARED_MARKETPLACE}`;
    const enablement = codexCorePluginEnablement(readLayers(), key);
    if (enablement.decision !== "allow") { outcomes.push({ dir: plugin.dir, name, outcome: "skipped", reason: enablement.reason }); continue; }
    const cached = nodePath.join(deps.codexHome, "plugins", "cache", CODEX_DECLARED_MARKETPLACE, name, version);
    const copyHash = strictHash(plugin.copy);
    let outcome: "installed" | "current" = "current";
    if (strictHash(cached) !== copyHash || !userLayerEnablesCorePlugin(userConfig(readLayers()), key)) {
      const installed = await deps.runCodexCli(["plugin", "add", key], env);
      if (installed.status !== 0) {
        outcomes.push({ dir: plugin.dir, name, outcome: "skipped", reason: `codex plugin add failed: ${(installed.stderr || installed.stdout).trim() || `exit ${installed.status}`}` });
        continue;
      }
      outcome = "installed";
    }
    if (strictHash(cached) !== copyHash) {
      outcomes.push({ dir: plugin.dir, name, outcome: "skipped", reason: `Codex's installed copy at ${cached} doesn't match OpenRig's copy, so its hooks aren't approved` });
      continue;
    }
    const approval = approveDeclaredHooks(plugin.copy, plugin.manifest, deps);
    outcomes.push({ dir: plugin.dir, name, outcome, approved: approval.approved,
      reason: `${key} ${version}${approval.note ? `; ${approval.note}` : ""}` });
  }
  return outcomes;
}

/** Writes the approvals for one plugin's hooks into the user config, unless the config changed while they were planned. */
function approveDeclaredHooks(copy: string, manifest: DeclaredPluginManifest, deps: DeclaredPluginInstallDeps): { approved: number; note?: string } {
  let trust: ReturnType<typeof declaredHookTrust>;
  try { trust = declaredHookTrust(copy, manifest); }
  catch (error) { return { approved: 0, note: `its hooks file can't be read (${(error as Error).message.split("\n")[0]}), so Codex reviews its hooks` }; }
  const skippedNote = trust.skipped.length ? `left to Codex's review: ${trust.skipped.join("; ")}` : undefined;
  const keys = Object.keys(trust.declarations);
  if (keys.length === 0) return { approved: 0, note: skippedNote };
  const contentHash = codexPluginContentHash(copy);
  const before = deps.fs.exists(deps.configPath) ? deps.fs.readFile(deps.configPath) : "";
  let content = before;
  let expected: { hooks?: { state?: Record<string, Record<string, unknown>> } };
  try { expected = parseToml(before) as typeof expected; }
  catch { return { approved: 0, note: "the user config can't be parsed, so Codex reviews its hooks" }; }
  const state = ((expected.hooks ??= {}).state ??= {});
  let changed = 0;
  for (const key of keys) {
    const current = state[key] ?? {};
    if (current["trusted_hash"] === trust.declarations[key] && current["trusted_content_hash"] === contentHash) continue;
    content = deps.upsertTrust(content, key, trust.declarations[key]!, "trusted_hash");
    content = deps.upsertTrust(content, key, contentHash, "trusted_content_hash");
    state[key] = { ...current, trusted_hash: trust.declarations[key], trusted_content_hash: contentHash };
    changed++;
  }
  if (changed === 0) return { approved: keys.length, note: skippedNote };
  // The line writer must not change anything else; an unsupported spelling leaves Codex's review in place.
  try { if (!isDeepStrictEqual(parseToml(content), expected)) return { approved: 0, note: "the user config's layout isn't one OpenRig can extend safely, so Codex reviews its hooks" }; }
  catch { return { approved: 0, note: "the user config's layout isn't one OpenRig can extend safely, so Codex reviews its hooks" }; }
  if ((deps.fs.exists(deps.configPath) ? deps.fs.readFile(deps.configPath) : "") !== before) {
    return { approved: 0, note: "the user config changed while OpenRig approved its hooks; the next launch tries again" };
  }
  deps.fs.writeFile(deps.configPath, content);
  return { approved: keys.length, note: skippedNote };
}
