import { execFileSync } from 'child_process';
import { existsSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Auto-diff brain (TS port of research/fusion/cli_v0/diff_changed_set.sh).
 *
 * Given the base release's AOT snapshot and the freshly-built patch snapshot,
 * run `analyze_snapshot --shorebird` on both and compute the CHANGED FUNCTION
 * SET via subgraph_hash (a transitive Merkle hash over the static call graph):
 * a patch function is REUSED from base iff its subgraph_hash matches a base
 * function; otherwise it changed. Because the hash folds in transitive callee
 * identity, a change also shifts every transitive STATIC caller — so the diff
 * yields the changed fn + its static-caller cascade, bounded at virtual dispatch
 * edges (those are rerouted by the dispatch-funcreg boundary at runtime).
 *
 * This is exactly Shorebird's "detect what changed" step — zero annotations,
 * the developer just edits normal code. The output feeds the dispatch-funcreg
 * boot hook: `sankofaManifest` is the comma-separated Class.method string it
 * parses to transplant + reroute each changed method.
 */
export interface SnapshotFn {
  name: string;
  qualified_name?: string;
  subgraph_hash: string;
  self_hash?: string;
  library_uri?: string;
}

export interface ChangedSet {
  /** Ready-to-embed manifest string the boot hook parses (Class.method,...). */
  sankofaManifest: string;
  /** Qualified transplant targets. */
  targets: string[];
  /** link% by function count (higher = smaller patch). */
  linkPct: number;
  baseCount: number;
  patchCount: number;
  changedCount: number;
}

function qn(f: SnapshotFn): string {
  return f.qualified_name || f.name;
}

/** App code = NOT the SDK/framework (those live in the base engine, never patched). */
function isAppFn(f: SnapshotFn): boolean {
  const uri = f.library_uri ?? '';
  if (!uri) return false;
  if (uri.startsWith('dart:')) return false;
  if (uri.startsWith('package:flutter') || uri.startsWith('package:sky_engine')) return false;
  return true;
}

function runAnalyzer(analyzeSnapshot: string, aot: string, outJson: string): SnapshotFn[] {
  execFileSync(analyzeSnapshot, ['--shorebird', `--out=${outJson}`, aot], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (!existsSync(outJson)) {
    throw new Error(`analyze_snapshot produced no output for ${aot}`);
  }
  const parsed = JSON.parse(readFileSync(outJson, 'utf8'));
  return (parsed.functions ?? []) as SnapshotFn[];
}

/**
 * Compute the changed-function manifest between a base and a patch AOT snapshot.
 * @param analyzeSnapshot absolute path to the engine's `analyze_snapshot`
 * @param baseAot absolute path to the base release's AOT snapshot (ELF/Mach-O)
 * @param patchAot absolute path to the freshly-built patch AOT snapshot
 */
export function computeChangedSet(
  analyzeSnapshot: string,
  baseAot: string,
  patchAot: string,
): ChangedSet {
  for (const [label, p] of [
    ['analyze_snapshot', analyzeSnapshot],
    ['base snapshot', baseAot],
    ['patch snapshot', patchAot],
  ] as const) {
    if (!existsSync(p)) throw new Error(`Missing ${label}: ${p}`);
  }
  const work = mkdtempSync(join(tmpdir(), 'sankofa-diff-'));
  const base = runAnalyzer(analyzeSnapshot, baseAot, join(work, 'base.json'));
  const patch = runAnalyzer(analyzeSnapshot, patchAot, join(work, 'patch.json'));

  const baseHashes = new Set(base.map((f) => f.subgraph_hash));
  const changedAll = patch.filter((f) => !baseHashes.has(f.subgraph_hash));
  const changed = changedAll.filter(isAppFn);

  const targets = Array.from(new Set(changed.map(qn))).sort();
  const linkPct = patch.length > 0 ? +(100 * (patch.length - changed.length) / patch.length).toFixed(2) : 100;

  return {
    sankofaManifest: targets.join(','),
    targets,
    linkPct,
    baseCount: base.length,
    patchCount: patch.length,
    changedCount: changed.length,
  };
}
