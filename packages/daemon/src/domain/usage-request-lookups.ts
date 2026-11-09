// seanmcn/openrig#16: the daemon's lookups for the attribution rule's last tie-break (usage-request-store.ts): the git
// worktree a path is in, with its HEAD, and the candidate sha on the proof of a slice, read the way the review
// composer reads it. Both are only consulted when a seat holds several rows and no row names the request's worktree.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { deriveCandidateSha } from "./review/compose.js";
import { readProofArtifacts } from "./review/proof-io.js";
import type { AttributionLookups } from "./usage-request-store.js";

/** A worktree's HEAD moves; a short cache keeps one tick's many requests from running git for each. */
const WORKTREE_CACHE_MS = 30_000;

export function daemonAttributionLookups(sliceIndexer: () => { get(name: string): { slicePath: string } | null } | undefined): AttributionLookups {
  const worktrees = new Map<string, { at: number; value: { root: string; head: string } | null }>();
  return {
    worktreeOf: (p) => {
      let dir = p;
      while (dir !== path.dirname(dir) && !(existsSync(dir) && statSync(dir).isDirectory())) dir = path.dirname(dir);
      const cached = worktrees.get(dir);
      if (cached && Date.now() - cached.at < WORKTREE_CACHE_MS) return cached.value;
      let value: { root: string; head: string } | null = null;
      try {
        const [root, head] = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel", "HEAD"],
          { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
        value = root && head ? { root, head } : null;
      } catch {
        value = null;
      }
      worktrees.set(dir, { at: Date.now(), value });
      return value;
    },
    sliceCandidateSha: (slice) => {
      const record = sliceIndexer()?.get(slice);
      return record ? deriveCandidateSha(readProofArtifacts(record.slicePath)) : null;
    },
  };
}
