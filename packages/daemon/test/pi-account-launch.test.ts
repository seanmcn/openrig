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
