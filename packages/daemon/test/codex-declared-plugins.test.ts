// A declared plugin with `run_hooks: true` is installed into a Codex home with Codex's own commands, refreshed when its
// source changes, and its hooks approved once Codex's cached copy matches OpenRig's copy. The fake `codex` here does what
// codex-cli 0.164 was seen to do in a scratch home: `marketplace add` records the source, `plugin add` copies the plugin
// into plugins/cache/<marketplace>/<name>/<version> (replacing the same version) and enables it.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_DECLARED_MARKETPLACE, declaredHookTrust, ensureCodexDeclaredPlugins, readDeclaredPluginManifest,
  type DeclaredPluginInstallDeps,
} from "../src/domain/codex-declared-plugins.js";
import { codexPluginContentHash } from "../src/domain/codex-owned-plugin-trust.js";
import { upsertCodexHookTrust } from "../src/adapters/codex-runtime-adapter.js";

const GUARD_COMMAND = 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/guards.py"';
const GUARD_MATCHER = "Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit";
const GUARD_KEY = `engineering@${CODEX_DECLARED_MARKETPLACE}:hooks/hooks.json:pre_tool_use:0:0`;

let root: string;
let codexHome: string;
let configPath: string;
let marketplaceRoot: string;
let calls: string[][];
let copyOnAdd: boolean;

function writePlugin(dir: string, opts: { version?: string; hooks?: unknown; script?: string } = {}): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "engineering", version: opts.version ?? "2.7.1" }));
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify(opts.hooks ?? {
    hooks: { PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: "command", command: GUARD_COMMAND, timeout: 10 }] }] },
  }));
  writeFileSync(join(dir, "hooks", "guards.py"), opts.script ?? "print('guard')\n");
  return dir;
}

function deps(): DeclaredPluginInstallDeps {
  return {
    fs: {
      exists: (p) => existsSync(p), readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, c) => writeFileSync(p, c), mkdirp: (p) => mkdirSync(p, { recursive: true }),
    },
    runCodexCli: async (args) => {
      calls.push(args);
      const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
        writeFileSync(configPath, `${config}\n[marketplaces.${CODEX_DECLARED_MARKETPLACE}]\nsource_type = "local"\nsource = "${args[3]}"\n`);
      } else if (args[0] === "plugin" && args[1] === "add") {
        const name = args[2]!.split("@")[0]!;
        const version = (JSON.parse(readFileSync(join(marketplaceRoot, name, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
        const cached = join(codexHome, "plugins", "cache", CODEX_DECLARED_MARKETPLACE, name);
        if (copyOnAdd) { rmSync(cached, { recursive: true, force: true }); cpSync(join(marketplaceRoot, name), join(cached, version), { recursive: true }); }
        if (!config.includes(`[plugins."${args[2]}"]`)) writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[plugins."${args[2]}"]\nenabled = true\n`);
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    codexHome, configPath, systemConfigDir: join(root, "etc"), marketplaceRoot, upsertTrust: upsertCodexHookTrust,
  };
}

function hookState(): Record<string, Record<string, unknown>> {
  return ((parseToml(readFileSync(configPath, "utf8")) as { hooks?: { state?: Record<string, Record<string, unknown>> } }).hooks?.state) ?? {};
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-declared-plugins-"));
  codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  configPath = join(codexHome, "config.toml");
  marketplaceRoot = join(root, "openrig", "state", "codex-declared-plugins");
  calls = [];
  copyOnAdd = true;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the approval recipe matches Codex's own", () => {
  it("gives the guards' PreToolUse hook the trust key and hash codex-cli 0.164 listed for it", () => {
    const plugin = writePlugin(join(root, "source", "engineering"));
    const manifest = readDeclaredPluginManifest(plugin);
    if ("error" in manifest) throw new Error(manifest.error);
    expect(declaredHookTrust(plugin, manifest)).toEqual({
      declarations: { [GUARD_KEY]: "sha256:b9af1545125433e9e72915fd53990f0cbc85e0e58a5a20ad45ea76557de2537e" },
      skipped: [],
    });
  });

  it("names the hooks it can't reproduce Codex's hash for, and keeps the rest", () => {
    const plugin = writePlugin(join(root, "source", "engineering"), { hooks: { hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a", timeout: 5 }, { type: "command", command: "b" }] }],
      Notification: [{ hooks: [{ type: "command", command: "c", timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: "prompt", prompt: "d" }] }],
    } } });
    const manifest = readDeclaredPluginManifest(plugin);
    if ("error" in manifest) throw new Error(manifest.error);
    const { declarations, skipped } = declaredHookTrust(plugin, manifest);
    expect(Object.keys(declarations)).toEqual([`engineering@${CODEX_DECLARED_MARKETPLACE}:hooks/hooks.json:pre_tool_use:0:0`]);
    expect(skipped).toEqual([
      "PreToolUse[0].hooks[1]: no numeric timeout",
      "Notification: not a Codex hook event",
      "PostToolUse[0].hooks[0]: not a command hook",
    ]);
  });
});

describe("ensureCodexDeclaredPlugins", () => {
  it("installs a plugin through Codex's commands and approves its hooks against OpenRig's copy", async () => {
    const plugin = writePlugin(join(root, "source", "engineering"));
    const [result] = await ensureCodexDeclaredPlugins([plugin], deps());
    expect(result).toMatchObject({ name: "engineering", outcome: "installed", approved: 1 });
    expect(calls).toEqual([["plugin", "marketplace", "add", marketplaceRoot], ["plugin", "add", `engineering@${CODEX_DECLARED_MARKETPLACE}`]]);
    expect(JSON.parse(readFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")).plugins)
      .toEqual([{ name: "engineering", source: "./engineering" }]);
    expect(hookState()[GUARD_KEY]).toEqual({
      trusted_hash: "sha256:b9af1545125433e9e72915fd53990f0cbc85e0e58a5a20ad45ea76557de2537e",
      trusted_content_hash: codexPluginContentHash(join(codexHome, "plugins", "cache", CODEX_DECLARED_MARKETPLACE, "engineering", "2.7.1")),
    });
  });

  it("does nothing on a second run when nothing changed", async () => {
    const plugin = writePlugin(join(root, "source", "engineering"));
    await ensureCodexDeclaredPlugins([plugin], deps());
    const config = readFileSync(configPath, "utf8");
    calls = [];
    const [result] = await ensureCodexDeclaredPlugins([plugin], deps());
    expect(result).toMatchObject({ outcome: "current", approved: 1 });
    expect(calls).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(config);
  });

  it("refreshes Codex's copy and approves again when the source changes at the same version", async () => {
    const plugin = writePlugin(join(root, "source", "engineering"));
    await ensureCodexDeclaredPlugins([plugin], deps());
    const before = hookState()[GUARD_KEY]!["trusted_content_hash"];
    writeFileSync(join(plugin, "hooks", "guards.py"), "print('guard, fixed')\n");
    calls = [];
    const [result] = await ensureCodexDeclaredPlugins([plugin], deps());
    expect(result).toMatchObject({ outcome: "installed", approved: 1 });
    expect(calls).toEqual([["plugin", "add", `engineering@${CODEX_DECLARED_MARKETPLACE}`]]);
    const after = hookState()[GUARD_KEY]!["trusted_content_hash"];
    expect(after).not.toBe(before);
    expect(after).toBe(codexPluginContentHash(plugin));
    expect(Object.keys(hookState())).toEqual([GUARD_KEY]);
  });

  it("leaves a plugin the person disabled alone", async () => {
    writeFileSync(configPath, `[plugins."engineering@${CODEX_DECLARED_MARKETPLACE}"]\nenabled = false\n`);
    const plugin = writePlugin(join(root, "source", "engineering"));
    const [result] = await ensureCodexDeclaredPlugins([plugin], deps());
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(result!.reason).toContain("explicitly disabled");
    expect(calls.filter((args) => args[1] === "add")).toEqual([]);
    expect(hookState()).toEqual({});
  });

  it("leaves a marketplace of the same name with another source alone", async () => {
    writeFileSync(configPath, `[marketplaces.${CODEX_DECLARED_MARKETPLACE}]\nsource_type = "local"\nsource = "/somewhere/else"\n`);
    const [result] = await ensureCodexDeclaredPlugins([writePlugin(join(root, "source", "engineering"))], deps());
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(result!.reason).toContain("another source");
    expect(calls).toEqual([]);
  });

  it("approves nothing when Codex's cached copy doesn't match OpenRig's", async () => {
    copyOnAdd = false;
    const [result] = await ensureCodexDeclaredPlugins([writePlugin(join(root, "source", "engineering"))], deps());
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(result!.reason).toContain("doesn't match OpenRig's copy");
    expect(hookState()).toEqual({});
  });

  it("keeps a hook's enabled setting while it approves the hook", async () => {
    writeFileSync(configPath, `[hooks.state."${GUARD_KEY}"]\nenabled = false\n`);
    await ensureCodexDeclaredPlugins([writePlugin(join(root, "source", "engineering"))], deps());
    expect(hookState()[GUARD_KEY]).toMatchObject({ enabled: false, trusted_hash: expect.stringMatching(/^sha256:/) });
  });

  it("skips a second plugin folder with the same name, and one without a usable manifest", async () => {
    const first = writePlugin(join(root, "source", "engineering"));
    const second = writePlugin(join(root, "other", "engineering"), { script: "print('other')\n" });
    const bare = join(root, "bare");
    mkdirSync(bare);
    const results = await ensureCodexDeclaredPlugins([first, second, bare], deps());
    expect(results.find((r) => r.dir === second)).toMatchObject({ outcome: "skipped", reason: `${first} is also named engineering` });
    expect(results.find((r) => r.dir === bare)).toMatchObject({ outcome: "skipped" });
    expect(results.find((r) => r.dir === first)).toMatchObject({ outcome: "installed" });
  });
});
