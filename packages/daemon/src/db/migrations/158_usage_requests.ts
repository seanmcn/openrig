import type { Migration } from "../migrate.js";

/**
 * Per-request usage for every runtime, attributed to the queue row it was spent on (seanmcn/openrig#16).
 *
 * usage_requests: one row per model request, keyed by (runtime, native session, request key) so a re-read of the
 * same transcript lines stores nothing new. Claude rows come from the transcript JSONL (one per request id), Codex
 * rows from the rollout's token_count events, Pi rows mirror the seat's own pi_usage_entries. Tokens are by kind;
 * `cost_usd` is NULL whenever `cost_provenance` is 'unavailable', never zero. `paths_json` keeps the paths the
 * request's tool calls touched, so attribution can be recomputed if the rule changes. The attribution columns are
 * written with the record: an attributed row names its queue row (and the slice, mission and repo read from it),
 * an unattributed one names its reason and the candidate rows.
 *
 * usage_request_cursors: how far each transcript or rollout has been read (byte offset of the next unread line),
 * plus the parser's carried state (a Codex rollout's model and the paths since its last token_count).
 *
 * No account identity column, as in usage_samples. Rows follow retention.usage_samples_days.
 */
export const usageRequestsSchema: Migration = {
  name: "158_usage_requests.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS usage_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runtime TEXT NOT NULL CHECK (runtime IN ('claude-code', 'codex', 'pi')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      native_session_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_ts TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      cost_provenance TEXT NOT NULL CHECK (cost_provenance IN ('runtime_estimate', 'provider_charge', 'unavailable')),
      paths_json TEXT NOT NULL DEFAULT '[]',
      attribution_status TEXT NOT NULL CHECK (attribution_status IN ('attributed', 'unattributed')),
      attribution_basis TEXT NOT NULL,
      qitem_id TEXT,
      slice TEXT,
      mission TEXT,
      repo TEXT,
      candidate_rows_json TEXT NOT NULL DEFAULT '[]',
      recorded_at TEXT NOT NULL,
      UNIQUE (runtime, native_session_id, request_key),
      CHECK (cost_provenance <> 'unavailable' OR cost_usd IS NULL),
      CHECK (attribution_status <> 'attributed' OR qitem_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_requests_ts ON usage_requests(request_ts, id);
    CREATE INDEX IF NOT EXISTS idx_usage_requests_seat_ts ON usage_requests(seat_session, request_ts, id);
    CREATE TABLE IF NOT EXISTS usage_request_cursors (
      runtime TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (runtime, transcript_path)
    );
  `,
};
