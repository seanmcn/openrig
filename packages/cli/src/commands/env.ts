import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function envCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("env")
    .description("Inspect and control rig services and seat variables; for execution placement use rig environment")
    .addHelpText("after", `
Examples:
  rig env status secrets-manager
  rig env logs secrets-manager vault
  rig env down secrets-manager
  rig env sync my-rig --spec rig.yaml --check --json
`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveRigId(client: DaemonClient, rigRef: string): Promise<string> {
    const summaries = await client.get<Array<{ id: string; name: string }> | { error?: string }>("/api/rigs/summary");
    if (summaries.status >= 400) {
      const error = !Array.isArray(summaries.data) ? summaries.data?.error : undefined;
      throw new Error(error ?? `Failed to list rigs (HTTP ${summaries.status})`);
    }
    if (!Array.isArray(summaries.data)) throw new Error("The daemon returned an invalid rig summary.");
    const match = summaries.data.find((r) => r.name === rigRef || r.id === rigRef);
    if (!match) throw new Error(`Rig '${rigRef}' not found`);
    return match.id;
  }

  cmd.command("sync")
    .description("Replace a stopped rig's seat variables with its spec's env block; never restarts seats")
    .argument("<rig>", "Rig name or ID")
    .requiredOption("--spec <file>", "Rig spec to read; an absent env block clears rig-level variables")
    .option("--check", "Report drift without changing the stored environment")
    .option("--json", "JSON output (no environment values)")
    .action(async (rig: string, opts: { spec: string; check?: boolean; json?: boolean }) => {
      let spec: unknown;
      try { spec = parse(readFileSync(opts.spec, "utf8")); }
      catch { console.error("Cannot read or parse the rig spec"); process.exitCode = 1; return; }
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        console.error("The rig spec must be a mapping"); process.exitCode = 1; return;
      }
      const client = await getClient(getDeps());
      if (!client) { process.exitCode = 1; return; }
      try {
        const id = await resolveRigId(client, rig);
        const res = await client.post<{ changed: boolean; applied: boolean; error?: string }>(
          `/api/rigs/${encodeURIComponent(id)}/seat-env`,
          { env: "env" in spec ? spec.env : {}, check: opts.check ?? false },
        );
        if (res.status >= 400) {
          console.error(res.data.error ?? `Environment reconciliation failed (HTTP ${res.status})`);
          process.exitCode = 1; return;
        }
        if (opts.json) console.log(JSON.stringify(res.data));
        else console.log(res.data.applied ? "Stored seat environment updated; restore the rig to apply it."
          : res.data.changed ? "Stored seat environment differs from the spec." : "Stored seat environment matches the spec.");
      } catch {
        console.error("Could not reconcile the rig environment; check the daemon and rig name");
        process.exitCode = 1;
      }
    });

  // rig env status <rig>
  cmd
    .command("status")
    .description("Show the state of a rig's services")
    .argument("<rig>", "Rig name or ID")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.get<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/env`);

      if (res.status >= 400) {
        if (opts.json) console.log(JSON.stringify(res.data, null, 2));
        else console.error(res.data?.["error"] ?? `Failed to get service status (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (!res.data["hasServices"]) {
        console.log("No services configured for this rig.");
        return;
      }

      const receipt = res.data["receipt"] as Record<string, unknown> | null;
      const probeStatus = res.data["probeStatus"];
      if (probeStatus === "stale" || probeStatus === "no_orchestrator") {
        const probeError = res.data["probeError"];
        console.error(`Service status is ${probeStatus === "stale" ? "stale" : "unverified"} (probe: ${probeStatus}); ${receipt ? "showing the saved receipt" : "no saved receipt is available"}.${typeof probeError === "string" && probeError ? ` ${probeError}` : ""}`);
      }

      if (!receipt) {
        console.log("Services configured but no receipt available yet.");
        return;
      }

      console.log(`Env: ${res.data["kind"]} (${res.data["projectName"]})`);
      const services = receipt["services"] as Array<{ name: string; status: string; health?: string | null }>;
      if (services) {
        for (const svc of services) {
          const health = svc.health ? ` (${svc.health})` : "";
          console.log(`  ${svc.name}: ${svc.status}${health}`);
        }
      }
    });

  // rig env logs <rig> [service]
  cmd
    .command("logs")
    .description("Print recent logs from a rig's services, or from one service")
    .argument("<rig>", "Rig name or ID")
    .argument("[service]", "Specific service name")
    .option("--tail <n>", "Number of lines", "100")
    .action(async (rig: string, service: string | undefined, opts: { tail: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const params = new URLSearchParams({ tail: opts.tail });
      if (service) params.set("service", service);

      const res = await client.get<{ ok: boolean; output?: string; error?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/logs?${params}`,
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to get logs (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.output ?? "");
    });

  // rig env down <rig> [--volumes]
  cmd
    .command("down")
    .description("Stop a rig's services as its down_policy says; --volumes also removes volumes")
    .argument("<rig>", "Rig name or ID")
    .option("--volumes", "Also remove volumes")
    .action(async (rig: string, opts: { volumes?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.post<{ ok: boolean; error?: string; kept?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/down`,
        { volumes: opts.volumes ?? false },
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to stop services (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.kept ?? `Services stopped for ${rig}.`);
    });

  return cmd;
}
