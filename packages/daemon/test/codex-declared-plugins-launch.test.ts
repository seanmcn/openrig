// A Codex seat's launch installs, refreshes and approves the declared plugins it runs the hooks of, a resume too, and only
// while runtime.codex.hooks_enabled is on. The daemon's boot step does the same in the daemon's Codex home.

import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CODEX_DECLARED_MARKETPLACE } from "../src/domain/codex-declared-plugins.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const NODE_DIR = dirname(process.execPath);
const KEY = `guards@${CODEX_DECLARED_MARKETPLACE}`;
const HOOK_KEY = `${KEY}:hooks/hooks.json:pre_tool_use:0:0`;

const realFs = {
  readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf8"),
  exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "codex-declared-launch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup(opts: { hooksEnabled?: boolean } = {}) {
  const home = join(root, "home"), codexHome = join(root, "codex-home"), cwd = join(root, "project"), bin = join(root, "bin");
  const marketplaceRoot = join(root, "openrig", "state", "codex-declared-plugins");
  for (const d of [home, codexHome, cwd, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.165.0');\n`, { mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, "");
  const plugin = join(root, "specs", "guards");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guards", version: "1.0.0" }));
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/guard.py"', timeout: 10 }] }] } }));
  writeFileSync(join(plugin, "hooks", "guard.py"), "print('v1')\n");
  const calls: string[][] = [];
  const runCodexCli = async (args: string[]) => {
    calls.push(args);
    const config = readFileSync(configPath, "utf8");
    if (args[1] === "marketplace") writeFileSync(configPath, `${config}\n[marketplaces.${CODEX_DECLARED_MARKETPLACE}]\nsource_type = "local"\nsource = "${args[3]}"\n`);
    else if (args[1] === "add") {
      const cached = join(codexHome, "plugins", "cache", CODEX_DECLARED_MARKETPLACE, "guards");
      rmSync(cached, { recursive: true, force: true });
      cpSync(join(marketplaceRoot, "guards"), join(cached, "1.0.0"), { recursive: true });
      if (!config.includes(`[plugins."${KEY}"]`)) writeFileSync(configPath, `${config}\n[plugins."${KEY}"]\nenabled = true\n`);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const tmux = { getPaneCommand: async () => "bash", getSessionEnv: async () => undefined, sendShellCommand: async () => ({ ok: true }) };
  const adapter = new CodexRuntimeAdapter({
    tmux: tmux as unknown as TmuxAdapter, fsOps: { ...realFs, homedir: home }, codexHome, launchPath: `${bin}:${NODE_DIR}:/usr/bin:/bin`,
    activityRelayPath: RELAY, resolveGitAddDirs: async () => [], runCodexCli, codexSystemConfigDir: join(root, "etc"),
    resolveManagedConfigSettings: async () => ({ enabled: opts.hooksEnabled ?? true, codexVersion: "0.165.0" }),
    resolveHooksEnabled: async () => opts.hooksEnabled ?? true,
    resolveHookPluginDirs: (nodeId: string) => nodeId === "selected" ? [plugin] : [],
    declaredPluginsRoot: marketplaceRoot,
  });
  const internals = adapter as unknown as Record<string, unknown>;
  internals.dismissSkippableCodexUpdatePrompt = async () => undefined;
  internals.captureFreshThreadId = async () => "fresh";
  internals.verifyResumeLaunch = async () => ({ ok: true });
  const hookState = () => ((parseToml(readFileSync(configPath, "utf8")) as { hooks?: { state?: Record<string, Record<string, unknown>> } }).hooks?.state ?? {});
  return { adapter, cwd, plugin, calls, hookState };
}

describe("a Codex seat's declared hook plugins", () => {
  it("a fresh launch installs the seat's plugin and approves its hooks; another seat's launch installs nothing", async () => {
    const s = setup();
    expect((await s.adapter.launchHarness({ nodeId: "other", tmuxSession: "o@rig", cwd: s.cwd } as never, { name: "o" })).ok).toBe(true);
    expect(s.calls).toEqual([]);
    expect((await s.adapter.launchHarness({ nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never, { name: "s" })).ok).toBe(true);
    expect(s.calls.map((args) => args.slice(0, 3))).toEqual([["plugin", "marketplace", "add"], ["plugin", "add", KEY]]);
    expect(s.hookState()[HOOK_KEY]).toMatchObject({ trusted_hash: expect.stringMatching(/^sha256:/), trusted_content_hash: expect.stringMatching(/^sha256:/) });
  });

  it("a resume refreshes the plugin when its source changed, and approves the new bytes", async () => {
    const s = setup();
    const binding = { nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never;
    expect((await s.adapter.launchHarness(binding, { name: "s" })).ok).toBe(true);
    const before = s.hookState()[HOOK_KEY]!["trusted_content_hash"];
    writeFileSync(join(s.plugin, "hooks", "guard.py"), "print('v2')\n");
    s.calls.length = 0;
    expect((await s.adapter.launchHarness(binding, { name: "s", resumeToken: "thread-1" })).ok).toBe(true);
    expect(s.calls).toEqual([["plugin", "add", KEY]]);
    expect(s.hookState()[HOOK_KEY]!["trusted_content_hash"]).not.toBe(before);
  });

  it("does nothing while runtime.codex.hooks_enabled is off", async () => {
    const s = setup({ hooksEnabled: false });
    expect((await s.adapter.launchHarness({ nodeId: "selected", tmuxSession: "s@rig", cwd: s.cwd } as never, { name: "s" })).ok).toBe(true);
    await s.adapter.ensureCodexDeclaredPluginsAtBoot([s.plugin]);
    expect(s.calls).toEqual([]);
    expect(s.hookState()).not.toHaveProperty(HOOK_KEY);
  });

  it("the boot step installs the plugins it is given into the daemon's home", async () => {
    const s = setup();
    await s.adapter.ensureCodexDeclaredPluginsAtBoot([s.plugin]);
    expect(s.calls.map((args) => args.slice(0, 3))).toEqual([["plugin", "marketplace", "add"], ["plugin", "add", KEY]]);
    expect(existsSync(join(root, "codex-home", "plugins", "cache", CODEX_DECLARED_MARKETPLACE, "guards", "1.0.0", "hooks", "guard.py"))).toBe(true);
  });
});
