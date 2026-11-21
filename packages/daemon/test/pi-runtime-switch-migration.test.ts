import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { piRuntimeSwitchesSchema } from "./fixtures/legacy-pi-runtime-switches.js";

it.each([false, true])("retains an interrupted runtime switch when upgrading to upstream Pi switches (legacy depot=%s)", legacy => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS.filter(migration => migration.name !== "151_pi_account_switches.sql"));
    if (legacy) migrate(db, [piRuntimeSwitchesSchema]);
    db.exec("INSERT INTO rigs (id, name) VALUES ('rig', 'upgrade'); INSERT INTO nodes (id, rig_id, logical_id) VALUES ('seat', 'rig', 'dev.build');");
    const insert = db.prepare(`INSERT INTO seat_runtime_switches
      (id, node_id, canonical_session, staging_session, predecessor_pane, predecessor_generation, successor_generation, from_runtime, to_runtime, reason, plan_json, deadline_at)
      VALUES (?, 'seat', 'build@upgrade', ?, '%0', 'before', ?, 'codex', ?, 'allowance', '{}', '2026-11-03T03:00:00Z')`);
    insert.run("old", "staging-old", "after-old", legacy ? "pi" : "claude-code");
    const before = db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get();
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get()).toEqual(before);
    expect(() => insert.run("duplicate", "staging-new", "after-new", "pi")).toThrow();
    db.exec("UPDATE seat_runtime_switches SET phase = 'abandoned' WHERE id = 'old'");
    insert.run("pi", "staging-new", "after-new", "pi");
    expect(db.prepare("SELECT to_runtime FROM seat_runtime_switches WHERE id = 'pi'").get()).toEqual({ to_runtime: "pi" });
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("151_pi_account_switches.sql")).toBeDefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
