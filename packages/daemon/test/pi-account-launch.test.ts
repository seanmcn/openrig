import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePiAgentDirectory } from "../src/adapters/pi-runner.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("prepares seat MCP with direct tools and only the selected account's auth", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-account-"));
  roots.push(root);
  const agent = path.join(root, "seat", "agent"), account = path.join(root, "account"), defaults = path.join(root, "defaults");
  fs.mkdirSync(account);
  fs.mkdirSync(defaults);
  fs.writeFileSync(path.join(account, "auth.json"), JSON.stringify({ mistral: { type: "api_key", key: "test-key" } }));
  fs.writeFileSync(path.join(defaults, "mcp.json"), JSON.stringify({ mcpServers: {
    notion: { command: "/bin/notion", exposure: "codemode" }, cartograph: { url: "https://example.test/mcp" },
  } }));
  preparePiAgentDirectory(agent, account, defaults);
  expect(fs.realpathSync(path.join(agent, "auth.json"))).toBe(fs.realpathSync(path.join(account, "auth.json")));
  expect(JSON.parse(fs.readFileSync(path.join(agent, "mcp.json"), "utf8"))).toEqual({ mcpServers: {
    notion: { command: "/bin/notion", exposure: "direct" }, cartograph: { url: "https://example.test/mcp", exposure: "direct" },
  } });
  preparePiAgentDirectory(agent, undefined, defaults);
  expect(fs.existsSync(path.join(agent, "auth.json"))).toBe(false);
  expect(fs.existsSync(path.join(account, "auth.json"))).toBe(true);
});

it("preserves the selected account when resuming a Pi seat", async () => {
  const { PiResumeAdapter } = await import("../src/adapters/pi-resume.js");
  const { SeatLaunchEnvironment } = await import("../src/domain/seat-launch-environment.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-account-"));
  roots.push(root);
  const cli = path.join(root, "rig"), sessionFile = path.join(root, "session.jsonl"), account = path.join(root, "account");
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(sessionFile, "{}");
  let launched = "";
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "pi-node", OPENRIG_SESSION_NAME: "build@rig", OPENRIG_RUNTIME: "pi", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = {
    getSessionEnv: async (_session: string, key: string) => identity[key],
    getPaneCommand: async () => "bash",
    sendShellCommand: async (_session: string, command: string) => {
      launched = command;
      fs.writeFileSync(path.join(root, "build@rig/runner-state.json"), JSON.stringify({ ready: true, launchId: "attempt", sessionFile, updatedAt: "now" }));
      return { ok: true as const };
    },
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, { PATH: "/usr/bin", OPENRIG_HOME: root }, root, cli, undefined,
    (node, runtime) => node === "pi-node" && runtime === "pi" ? account : undefined);
  const adapter = new PiResumeAdapter(tmux, {
    readFile: file => fs.readFileSync(file, "utf8"), writeFile: (file, text) => fs.writeFileSync(file, text),
    exists: fs.existsSync, mkdirp: file => fs.mkdirSync(file, { recursive: true }),
  }, { stateRoot: root, runnerEntryPath: "/runner.js" }, { seatLaunchEnvironment: launch, newLaunchId: () => "attempt" });
  expect(await adapter.resume("build@rig", "pi_session_file", sessionFile, root, "mistral/devstral-latest")).toMatchObject({ ok: true });
  expect(launched).toContain(`PI_CODING_AGENT_DIR=${account}`);
  let attempts = 0;
  tmux.sendShellCommand = async () => { attempts++; return { ok: false, code: "launch_path_too_long", message: "fixture bound" }; };
  expect(await adapter.resume("build@rig", "pi_session_file", sessionFile, root, "mistral/devstral-latest"))
    .toMatchObject({ ok: false, code: "resume_failed" });
  expect(attempts).toBe(1);
});

it("loads operator extensions in each isolated seat without replacing seat extensions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extensions-"));
  roots.push(root);
  const agent = path.join(root, "seat"), defaults = path.join(root, "defaults");
  fs.mkdirSync(agent);
  fs.mkdirSync(path.join(defaults, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(defaults, "extensions", "guard.ts"), "export default () => {};");
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ extensions: ["./own.ts"], theme: "dark" }));
  preparePiAgentDirectory(agent, undefined, defaults);
  const settings = () => JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
  expect(settings()).toEqual({ extensions: ["./own.ts", path.join(defaults, "extensions")], theme: "dark" });
  preparePiAgentDirectory(agent, undefined, defaults);
  expect(settings().extensions).toHaveLength(2);
});
