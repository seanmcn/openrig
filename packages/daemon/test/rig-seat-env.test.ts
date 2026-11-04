import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

// Regression: https://github.com/axiom-maths/open-rig/issues/254
// Reconcile a saved rig without importing it again or exposing environment values.
describe("reconcile a rig's declared seat environment", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  beforeEach(() => { db = createFullTestDb(); setup = createTestApp(db); });
  afterEach(() => db.close());

  it("checks drift without writing, replaces removed keys, and is idempotent", async () => {
    const rig = setup.rigRepo.createRig("saved");
    setup.rigRepo.setRigEnv(rig.id, { PATH: "/old", REMOVED: "old-value" });
    const request = (check: boolean) => setup.app.request(`/api/rigs/${rig.id}/seat-env`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: { PATH: "/mise:/usr/bin" }, check }),
    });
    const checked = await request(true);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ changed: true, applied: false });
    expect(setup.rigRepo.getRigEnv(rig.id)).toEqual({ PATH: "/old", REMOVED: "old-value" });
    const applied = await request(false);
    expect(await applied.json()).toEqual({ changed: true, applied: true });
    expect(setup.rigRepo.getRigEnv(rig.id)).toEqual({ PATH: "/mise:/usr/bin" });
    expect(await (await request(false)).json()).toEqual({ changed: false, applied: false });
  });
  it.each(["running", "unknown", "detached"] as const)("refuses writes while a seat is %s, but still reports drift", async (status) => {
    const rig = setup.rigRepo.createRig("unsafe");
    const node = setup.rigRepo.addNode(rig.id, "dev.build", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-build@unsafe");
    setup.sessionRegistry.updateStatus(session.id, status);
    setup.rigRepo.setRigEnv(rig.id, { PATH: "/old" });
    for (const check of [true, false]) {
      const result = await setup.app.request(`/api/rigs/${rig.id}/seat-env`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: { PATH: "/new" }, check }),
      });
      expect(result.status).toBe(check ? 200 : 409);
      expect(setup.rigRepo.getRigEnv(rig.id)).toEqual({ PATH: "/old" });
    }
  });

  it("preserves member overrides, account homes and conversation identity when clearing rig env", async () => {
    const rig = setup.rigRepo.createRig("preserved");
    const node = setup.rigRepo.addNode(rig.id, "dev.build", {
      runtime: "codex", env: { SHARED: "member", CODEX_HOME: "/member" },
    });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-build@preserved");
    setup.sessionRegistry.updateStatus(session.id, "exited");
    setup.rigRepo.setRigEnv(rig.id, { SHARED: "rig", REMOVED: "old" });
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run("/account", node.id);
    const result = await setup.app.request(`/api/rigs/${rig.id}/seat-env`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ env: {} }),
    });
    expect(result.status).toBe(200);
    expect(setup.rigRepo.getEffectiveSeatEnv(node.id)).toEqual({ SHARED: "member", CODEX_HOME: "/account" });
    expect(setup.sessionRegistry.getSessionsForRig(rig.id).map(s => s.id)).toEqual([session.id]);
    expect(setup.rigRepo.getRig(rig.id)!.nodes.map(n => n.id)).toEqual([node.id]);
  });

  it.each([null, [], { env: null }, { env: { PATH: 1 } }, { env: { OPENRIG_HOME: "/bad" } },
    { env: { PATH: "bad\0value" } }, { env: {}, check: "true" }])("rejects malformed input without echoing it: %j", async (body) => {
    const rig = setup.rigRepo.createRig("invalid");
    const result = await setup.app.request(`/api/rigs/${rig.id}/seat-env`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain("/bad");
    expect(setup.rigRepo.getRigEnv(rig.id)).toBeNull();
  });

});
