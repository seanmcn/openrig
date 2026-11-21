// seanmcn/openrig#16: reads a seat's Claude transcript JSONL or Codex rollout incrementally and records each model
// request in usage_requests (usage-request-store.ts). A cursor per file keeps the byte offset of the next unread line,
// so each tick reads only what was appended; a line still being written waits for its newline, and a file that got
// shorter than the cursor was replaced and is read from the start (the store counts a re-read request once).
//
// Claude: an assistant line per streamed content block, all carrying the request's id and usage; the request is
// counted once by its request id, with its largest counts. Its paths are those its tool calls name (file_path,
// notebook_path, path) and, for a shell command, the absolute paths in the command and the line's cwd. A line's
// `costUSD`, where a Claude Code version writes one, is a runtime estimate; otherwise the cost is unavailable.
//
// Codex: a `token_usage_record` per response (keyed by its response id), or, in rollouts that have none, a
// `token_count` event (keyed by the thread's cumulative total, which only a new request changes). The tool calls
// written since the previous one are its paths. Codex records no cost. Codex counts cached input inside
// input_tokens; it is stored as cache read and taken out of input, as Claude reports them.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { UsageRequestInput, UsageRequestStore } from "./usage-request-store.js";

export interface IngestTarget {
  runtime: "claude-code" | "codex";
  transcriptPath: string;
  seatSession: string;
  nodeId: string | null;
  nativeSessionId: string;
}

interface CodexState { model?: string | null; cwd?: string | null; paths?: string[]; usageRecords?: boolean }

/** Bytes read per file per tick; a longer backlog is read over the following ticks. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

/** Absolute paths in free text (a shell command, a tool's code): a slash after a delimiter, then path characters. */
const ABSOLUTE_PATH = /(?:^|[\s"'`=(,[{])(\/[\w.@+~-]+(?:\/[\w.@+~-]+)*)/g;

export function absolutePathsIn(text: string): string[] {
  return [...text.matchAll(ABSOLUTE_PATH)].map((m) => m[1]!.replace(/[.,]+$/, "")).filter((p) => p.length > 1);
}

function resolveAgainst(cwd: string | null | undefined, p: string): string | null {
  if (path.isAbsolute(p)) return path.normalize(p);
  return cwd ? path.resolve(cwd, p) : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export class UsageRequestIngestor {
  private readonly maxReadBytes: number;
  constructor(private readonly db: Database, private readonly store: UsageRequestStore, opts: { maxReadBytes?: number } = {}) {
    this.maxReadBytes = opts.maxReadBytes ?? MAX_READ_BYTES;
  }

  /** Read what was appended since the last call and record its requests. Never throws. */
  ingest(target: IngestTarget, nowIso: string): { requests: number } {
    try {
      return this.ingestUnsafe(target, nowIso);
    } catch {
      return { requests: 0 };
    }
  }

  private ingestUnsafe(target: IngestTarget, nowIso: string): { requests: number } {
    const cursor = this.db.prepare(
      "SELECT byte_offset, state_json, native_session_id FROM usage_request_cursors WHERE runtime = ? AND transcript_path = ?",
    ).get(target.runtime, target.transcriptPath) as { byte_offset: number; state_json: string; native_session_id: string } | undefined;
    const size = statSync(target.transcriptPath).size;
    let offset = cursor?.byte_offset ?? 0;
    let state: CodexState = {};
    try { state = cursor ? JSON.parse(cursor.state_json) as CodexState : {}; } catch { state = {}; }
    if (size < offset || (cursor && cursor.native_session_id !== target.nativeSessionId)) { offset = 0; state = {}; }
    if (size === offset) return { requests: 0 };

    const length = Math.min(size - offset, this.maxReadBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(target.transcriptPath, "r");
    try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
    let end = buffer.lastIndexOf(0x0a);
    if (end < 0 && length === this.maxReadBytes) {
      // One line longer than a whole read can't be parsed here: step past this part of it, and the rest of it fails
      // to parse on its own and is skipped, so the file doesn't stall.
      end = length - 1;
    } else if (end < 0) {
      return { requests: 0 }; // no complete line yet
    }
    const lines = buffer.subarray(0, end).toString("utf8").split("\n");

    const requests = target.runtime === "claude-code" ? this.claudeRequests(target, lines) : this.codexRequests(target, lines, state);
    this.db.transaction(() => {
      if (requests.length > 0) this.store.record(requests, nowIso);
      this.db.prepare(
        `INSERT INTO usage_request_cursors (runtime, transcript_path, native_session_id, byte_offset, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime, transcript_path) DO UPDATE SET native_session_id = excluded.native_session_id,
           byte_offset = excluded.byte_offset, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      ).run(target.runtime, target.transcriptPath, target.nativeSessionId, offset + end + 1, JSON.stringify(state), nowIso);
    })();
    return { requests: requests.length };
  }

  private claudeRequests(target: IngestTarget, lines: string[]): UsageRequestInput[] {
    const requests: UsageRequestInput[] = [];
    for (const line of lines) {
      if (!line.includes("\"assistant\"")) continue;
      let o: Record<string, any>;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant" || o.isApiErrorMessage === true) continue;
      const message = o.message as Record<string, any> | undefined;
      const usage = message?.usage as Record<string, any> | undefined;
      if (!message || !usage || message.model === "<synthetic>") continue;
      const key = str(o.requestId) ?? str(message.id);
      const ts = str(o.timestamp);
      if (!key || !ts) continue;
      const cwd = str(o.cwd);
      const paths: string[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== "tool_use" || !block.input || typeof block.input !== "object") continue;
        paths.push(...claudeToolPaths(block.input as Record<string, unknown>, cwd));
      }
      const cost = typeof o.costUSD === "number" && Number.isFinite(o.costUSD) ? o.costUSD : null;
      const request: UsageRequestInput = {
        runtime: "claude-code", seatSession: target.seatSession, nodeId: target.nodeId, nativeSessionId: target.nativeSessionId,
        requestKey: key, requestTs: ts, model: str(message.model),
        tokens: {
          input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite: num(usage.cache_creation_input_tokens), reasoning: num(usage.output_tokens_details?.thinking_tokens),
        },
        cost: cost === null ? { usd: null, provenance: "unavailable" } : { usd: cost, provenance: "runtime_estimate" },
        paths,
      };
      // Every streamed line of a request goes to the store, which counts the request once (first timestamp, largest counts).
      requests.push(request);
    }
    return requests;
  }

  private codexRequests(target: IngestTarget, lines: string[], state: CodexState): UsageRequestInput[] {
    const out: UsageRequestInput[] = [];
    const take = (key: string, ts: string, u: Record<string, unknown>) => {
      const input = num(u.input_tokens);
      const cached = Math.min(num(u.cached_input_tokens), input);
      out.push({
        runtime: "codex", seatSession: target.seatSession, nodeId: target.nodeId, nativeSessionId: target.nativeSessionId,
        requestKey: key, requestTs: ts, model: state.model ?? null,
        tokens: { input: input - cached, output: num(u.output_tokens), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens),
          reasoning: num(u.reasoning_output_tokens) },
        cost: { usd: null, provenance: "unavailable" },
        paths: state.paths ?? [],
      });
      state.paths = [];
    };
    for (const line of lines) {
      let o: Record<string, any>;
      try { o = JSON.parse(line); } catch { continue; }
      const p = (o.payload ?? {}) as Record<string, any>;
      const ts = str(o.timestamp);
      if (o.type === "session_meta" || o.type === "turn_context") {
        state.cwd = str(p.cwd) ?? state.cwd ?? null;
        if (o.type === "turn_context") state.model = str(p.model) ?? state.model ?? null;
      } else if (o.type === "event_msg" && p.type === "thread_settings_applied") {
        state.model = str(p.thread_settings?.model) ?? state.model ?? null;
        state.cwd = str(p.thread_settings?.cwd) ?? state.cwd ?? null;
      } else if (o.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call")) {
        state.paths = [...(state.paths ?? []), ...codexToolPaths(p, state.cwd ?? null)];
      } else if (o.type === "token_usage_record" && ts && str(p.response_id) && p.usage && typeof p.usage === "object") {
        state.usageRecords = true;
        take(p.response_id as string, ts, p.usage as Record<string, unknown>);
      } else if (o.type === "event_msg" && p.type === "token_count" && !state.usageRecords && ts) {
        const total = p.info?.total_token_usage?.total_tokens;
        const last = p.info?.last_token_usage;
        if (typeof total !== "number" || !last || typeof last !== "object") continue; // rate-limit-only update
        take(`total:${total}`, ts, last as Record<string, unknown>);
      }
    }
    return out;
  }
}

function claudeToolPaths(input: Record<string, unknown>, cwd: string | null): string[] {
  const named = ["file_path", "notebook_path", "path"].map((k) => str(input[k])).filter((v): v is string => v !== null)
    .map((v) => resolveAgainst(cwd, v)).filter((v): v is string => v !== null);
  if (named.length > 0) return named;
  const command = str(input.command);
  if (!command) return [];
  return [...absolutePathsIn(command), ...(cwd ? [cwd] : [])];
}

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function codexToolPaths(p: Record<string, any>, cwd: string | null): string[] {
  const name = str(p.name) ?? "";
  const text = str(p.input) ?? str(p.arguments) ?? (p.action ? JSON.stringify(p.action) : "");
  const found: string[] = [];
  let args: Record<string, unknown> | null = null;
  try { const v = JSON.parse(text); args = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { args = null; }
  const workdir = str(args?.workdir) ?? str(args?.cwd) ?? str(p.action?.working_directory);
  if (workdir) found.push(...[resolveAgainst(cwd, workdir)].filter((v): v is string => v !== null));
  for (const k of ["file_path", "path"]) {
    const v = str(args?.[k]);
    const resolved = v ? resolveAgainst(cwd, v) : null;
    if (resolved) found.push(resolved);
  }
  if (name === "apply_patch" || text.includes("*** Begin Patch")) {
    for (const m of text.matchAll(PATCH_FILE)) {
      const resolved = resolveAgainst(workdir ?? cwd, m[1]!.trim());
      if (resolved) found.push(resolved);
    }
  } else {
    found.push(...absolutePathsIn(text));
  }
  // A shell command that names no absolute path ran in the turn's working directory.
  if (found.length === 0 && /exec|shell/.test(name) && cwd) found.push(cwd);
  return found;
}
