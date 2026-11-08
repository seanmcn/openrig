import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProcessTableRow } from "../src/domain/process-table.js";

const { table, paths, argv } = vi.hoisted(() => ({ table: vi.fn(), paths: vi.fn(), argv: vi.fn() }));
vi.mock("../src/domain/process-table.js", () => ({ readProcessTable: table }));
vi.mock("../src/domain/native-process-executable.js", () => ({ readNativeExecutablePaths: paths }));
vi.mock("../src/domain/native-process-arguments.js", () => ({ readNativeProcessArguments: argv }));
import { listNativeProcesses, observeClaudePaneProcess, observeCodexPaneProcess } from "../src/domain/native-process-lineage.js";

const tableRows: ProcessTableRow[] = [
  { pid: 10, ppid: 1, pgid: 101, tpgid: 101, executableName: "zsh", command: "-zsh", startedAt: "shell" },
  { pid: 101, ppid: 10, pgid: 101, tpgid: 101, executableName: "2.1.289", command: "claude --resume first", startedAt: "claude one" },
  { pid: 102, ppid: 10, pgid: 101, tpgid: 101, executableName: "2.1.289", command: "claude --resume other", startedAt: "claude two" },
  { pid: 103, ppid: 10, pgid: 101, tpgid: 101, executableName: "codex", command: "codex resume first", startedAt: "codex target" },
  { pid: 104, ppid: 1, pgid: 101, tpgid: 101, executableName: "codex", command: "codex resume other", startedAt: "foreground conflict" },
  ...Array.from({ length: 8 }, (_, index) => [
    { pid: 201 + index, ppid: 1, pgid: 201 + index, tpgid: 201 + index, executableName: "2.1.289", command: "claude --resume unrelated", startedAt: `other claude ${index}` },
    { pid: 301 + index, ppid: 1, pgid: 301 + index, tpgid: 301 + index, executableName: "codex", command: "codex resume unrelated", startedAt: `other codex ${index}` },
  ]).flat(),
];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin" });
  table.mockResolvedValue(tableRows);
  paths.mockResolvedValue(new Map());
  argv.mockResolvedValue(new Map());
});

afterEach(() => Object.defineProperty(process, "platform", platform));

it("enriches every possible target-foreground match and retains the full table", async () => {
  await listNativeProcesses({ claudeLaunchPaths: true });
  expect(paths).toHaveBeenCalledExactlyOnceWith([101, 102, ...Array.from({ length: 8 }, (_, index) => 201 + index)]);
  expect(argv).toHaveBeenCalledExactlyOnceWith([103, 104, ...Array.from({ length: 8 }, (_, index) => 301 + index)]);
  paths.mockClear();
  argv.mockClear();
  table.mockClear();

  const rows = await listNativeProcesses({ panePid: 10, claudeLaunchPaths: true });

  expect(table).toHaveBeenCalledOnce();
  expect(paths).toHaveBeenCalledExactlyOnceWith([101, 102]);
  expect(argv).toHaveBeenCalledExactlyOnceWith([103, 104]);
  expect(rows.map(row => row.pid)).toEqual(tableRows.map(row => row.pid));
  expect(rows.find(row => row.pid === 201)?.executablePath).toBeUndefined();
  expect(rows.find(row => row.pid === 301)?.argv).toBeUndefined();
});

it("keeps same-foreground conflicts in the proof while excluding unrelated host processes", async () => {
  argv.mockResolvedValue(new Map([
    [103, ["codex", "resume", "first"]],
    [104, ["codex", "resume", "other"]],
  ]));
  const observation = await observeCodexPaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 } });

  expect(observation).toBeNull();
  expect(table).toHaveBeenCalledOnce();
  expect(argv).toHaveBeenCalledExactlyOnceWith([103, 104]);
});

it("keeps same-foreground Claude candidates ambiguous", async () => {
  const install = "/x/.local/share/claude/versions/2.1.289";
  paths.mockResolvedValue(new Map([[101, install], [102, install]]));
  const observation = await observeClaudePaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, expectedToken: "first" });

  expect(observation).toBeNull();
  expect(table).toHaveBeenCalledOnce();
  expect(paths).toHaveBeenCalledExactlyOnceWith([101, 102]);
});

it("skips enrichment when the pane's foreground is unavailable", async () => {
  table.mockResolvedValueOnce(tableRows.map(row => row.pid === 10 ? { ...row, tpgid: undefined } : row));
  const rows = await listNativeProcesses({ panePid: 10, claudeLaunchPaths: true });

  expect(paths).not.toHaveBeenCalled();
  expect(argv).not.toHaveBeenCalled();
  expect(rows).toHaveLength(tableRows.length);
});
