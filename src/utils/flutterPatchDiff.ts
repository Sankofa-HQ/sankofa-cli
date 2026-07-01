import { execFileSync } from 'child_process';
import { existsSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { buildFlutterPatch } from './flutterPatchCompiler.js';

/**
 * Resolve the host `analyze_snapshot` for a given engine version. It emits the
 * `--shorebird` subgraph_hash JSON the diff consumes, so it must be present on
 * the DEV machine. It ships in the Sankofa engine bundle (see
 * docs/CLI_ARCHITECTURE_AND_PARITY.md "CRITICAL-PATH DEPENDENCY"); the engine CI
 * must publish it per host platform. Throws an actionable error if absent rather
 * than failing obscurely mid-patch.
 */
export function resolveAnalyzeSnapshot(engineVersion: string): string {
  const home = process.env.SANKOFA_HOME || join(homedir(), '.sankofa');
  const exe = process.platform === 'win32' ? 'analyze_snapshot.exe' : 'analyze_snapshot';
  const candidates = [
    join(home, 'engines', engineVersion, exe),
    join(home, 'engines', engineVersion, 'bin', exe),
    join(home, 'flutter', engineVersion, 'bin', 'cache', 'dart-sdk', 'bin', 'utils', exe),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `analyze_snapshot not found for engine ${engineVersion}.\n` +
      `  It is the host tool that computes the code diff for a patch. It ships in\n` +
      `  the Sankofa engine bundle. Update via \`sankofa engine download ${engineVersion}\`,\n` +
      `  or (if this is a new engine) the engine CI must publish analyze_snapshot for\n` +
      `  this host platform — see docs/CLI_ARCHITECTURE_AND_PARITY.md.`,
  );
}

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

export interface AutoDiffResult extends ChangedSet {
  /** Path to the built dispatch-funcreg module, or null if nothing changed. */
  modulePath: string | null;
  moduleSizeBytes: number;
}

/**
 * End-to-end auto-diff patch build (Shorebird's model): given the base release's
 * AOT snapshot and the freshly-built patch snapshot + the changed source,
 *   1. computeChangedSet → the changed methods + manifest string,
 *   2. compile the changed source with an embedded _sankofaManifest → module.
 * Returns modulePath=null (a no-op patch) when nothing changed. The caller
 * packages + uploads the module; the device boot hook transplants + reroutes.
 *
 * Inputs come from live builds: `baseAot` is downloaded from the base release,
 * `patchAot` + `entryFile` + `importDill` come from rebuilding the patched app.
 */
export function buildAutoDiffPatch(opts: {
  analyzeSnapshot: string;
  baseAot: string;
  patchAot: string;
  /** App source to compile (contains the changed methods). */
  entryFile: string;
  /** Base app no-aot kernel for --import-dill. */
  importDill: string;
  /** Output module path. */
  outputPath: string;
  validateYaml?: string;
  flutterDartSdk?: string;
}): AutoDiffResult {
  const changed = computeChangedSet(opts.analyzeSnapshot, opts.baseAot, opts.patchAot);
  if (changed.changedCount === 0) {
    return { ...changed, modulePath: null, moduleSizeBytes: 0 };
  }
  const built = buildFlutterPatch({
    entryFile: opts.entryFile,
    outputPath: opts.outputPath,
    importDill: opts.importDill,
    sankofaManifest: changed.sankofaManifest,
    prefixLibraryUris: 'sankofa/patch',
    validateYaml: opts.validateYaml,
    flutterDartSdk: opts.flutterDartSdk,
  });
  return { ...changed, modulePath: built.outputPath, moduleSizeBytes: built.sizeBytes };
}
