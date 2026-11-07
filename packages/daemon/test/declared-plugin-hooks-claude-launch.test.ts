// A Claude seat loads each declared plugin it selected with `run_hooks: true` through CLAUDE_CODE_PLUGIN_DIRS, after the
// vendored openrig-core and before the seat's own skill plugin, on a fresh launch and on one that reads the saved selection.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

function claudePlugin(dir: string): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
  return dir;
}

function fakeTmux(created: Array<Record<string, string> | undefined>): TmuxAdapter {
  return {
    createSession: async (_name: string, _cwd?: string, env?: Record<string, string>) => { created.push(env); return { ok: true as const }; },
    setSessionEnv: async () => {}, unsetSessionEnv: async () => {},
    killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], listWindows: async () => [],
    hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("a Claude seat's launch env with declared hook plugins", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  let root: string;
  let pluginsDir: string;
  let core: string;
  let guards: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "declared-hooks-claude-"));
    pluginsDir = join(root, "plugins");
    core = claudePlugin(join(pluginsDir, "openrig-core"));
    guards = claudePlugin(join(root, "specs", "guards"));
  });
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); rmSync(root, { recursive: true, force: true }); });

  function setup(nodes: Array<{ id: string; runtime: string }>) {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("declared-hooks");
    const ids = Object.fromEntries(nodes.map((node) => [node.id, rigRepo.addNode(rig.id, node.id, { runtime: node.runtime }).id]));
    const created: Array<Record<string, string> | undefined> = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), pluginsDir });
    return { db, rig, ids, created, launcher };
  }

  it("fresh launch: loads the declared plugin after openrig-core, and only on a Claude seat", async () => {
    const { rig, created, launcher } = setup([{ id: "claude", runtime: "claude-code" }, { id: "codex", runtime: "codex" }]);
    for (const id of ["claude", "codex"]) {
      expect((await launcher.launchNode(rig.id, id, { pluginPaths: [core, guards], hookPlugins: [{ path: guards, pluginType: "auto" }] })).ok).toBe(true);
    }
    expect(created[0]![PLUGIN_ENV]).toBe(`${core}:${guards}`);
    expect(created[1]).not.toHaveProperty(PLUGIN_ENV);
  });

  it("fresh launch: a selected plugin without run_hooks isn't loaded", async () => {
    const { rig, created, launcher } = setup([{ id: "claude", runtime: "claude-code" }]);
    expect((await launcher.launchNode(rig.id, "claude", { pluginPaths: [guards], hookPlugins: [] })).ok).toBe(true);
    expect(created[0]).not.toHaveProperty(PLUGIN_ENV);
  });

  it("a launch that isn't given a selection reads the saved one, honouring run_hooks", async () => {
    const { db, rig, ids, created, launcher } = setup([{ id: "hooked", runtime: "claude-code" }, { id: "plain", runtime: "claude-code" }]);
    const save = db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')");
    save.run(ids["hooked"], JSON.stringify([{ category: "plugin", absolutePath: guards, pluginType: "auto", runHooks: true }]));
    save.run(ids["plain"], JSON.stringify([{ category: "plugin", absolutePath: guards, pluginType: "auto" }]));
    expect((await launcher.launchNode(rig.id, "hooked")).ok).toBe(true);
    expect((await launcher.launchNode(rig.id, "plain")).ok).toBe(true);
    expect(created[0]![PLUGIN_ENV]).toBe(guards);
    expect(created[1]).not.toHaveProperty(PLUGIN_ENV);
  });
});
