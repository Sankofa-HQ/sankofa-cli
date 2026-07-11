import { execFileSync } from 'child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { SANKOFA_STORAGE_BASE_URL } from './engineVersion.js';
import {
  resolveAutoDiffTools,
  runExtractor,
  compileChangedUnit,
  sourceDiffPairs,
} from './flutterAutoDiffCompile.js';

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
  const fRoot = join(home, 'flutter', engineVersion);
  const artEngine = join(fRoot, 'bin', 'cache', 'artifacts', 'engine');
  const candidates = [
    // Fetched alongside gen_snapshot (see ensureAnalyzeSnapshot).
    join(artEngine, 'ios-release', 'analyze_snapshot_arm64'),
    join(artEngine, 'ios-release', exe),
    join(home, 'flutter', engineVersion, 'bin', 'cache', 'dart-sdk', 'bin', 'utils', exe),
    join(home, 'engines', engineVersion, exe),
    join(home, 'engines', engineVersion, 'bin', exe),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `analyze_snapshot not found for engine ${engineVersion}.\n` +
      `  It is the host tool that computes the code diff for a patch. Fetch it with\n` +
      `  ensureAnalyzeSnapshot() (downloads from the engine mirror), or run\n` +
      `  \`sankofa engine download ${engineVersion}\`. See docs/CLI_ARCHITECTURE_AND_PARITY.md.`,
  );
}

/**
 * Ensure the host `analyze_snapshot` for `engineVersion` is present, downloading
 * it from the engine mirror if needed. The mirror already carries it at
 * flutter_infra_release/flutter/<rev>/ios-release/analyze_snapshot_arm64 (the
 * mac-arm64 host binary) — it just isn't extracted by `flutter precache`
 * (standard Flutter doesn't need it; code-push does). We drop it next to
 * gen_snapshot so resolveAnalyzeSnapshot finds it. Returns the path.
 *
 * Note: today only the mac-arm64 host artifact is in the mirror. Linux/Windows
 * dev hosts need their own analyze_snapshot published (engine CI follow-up).
 */
export async function ensureAnalyzeSnapshot(engineVersion: string): Promise<string> {
  try {
    return resolveAnalyzeSnapshot(engineVersion);
  } catch {
    /* not cached yet — fetch below */
  }
  if (process.platform !== 'darwin') {
    throw new Error(
      `analyze_snapshot auto-fetch currently supports macOS hosts only; ` +
        `the mirror lacks a ${process.platform} host binary for ${engineVersion}. ` +
        `Publish it via the engine CI (see docs/CLI_ARCHITECTURE_AND_PARITY.md).`,
    );
  }
  const home = process.env.SANKOFA_HOME || join(homedir(), '.sankofa');
  const fRoot = join(home, 'flutter', engineVersion);
  const revFile = join(fRoot, 'bin', 'internal', 'engine.version');
  if (!existsSync(revFile)) {
    throw new Error(
      `Bundled Flutter not installed for ${engineVersion} (no ${revFile}). ` +
        `Run a build/patch once to install it, or \`sankofa engine download ${engineVersion}\`.`,
    );
  }
  const rev = readFileSync(revFile, 'utf8').trim();
  const url = `${SANKOFA_STORAGE_BASE_URL}/flutter_infra_release/flutter/${rev}/ios-release/analyze_snapshot_arm64`;
  const dest = join(fRoot, 'bin', 'cache', 'artifacts', 'engine', 'ios-release', 'analyze_snapshot_arm64');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `analyze_snapshot not found in the mirror for engine rev ${rev} (HTTP ${res.status}).\n  ${url}\n` +
        `  The engine CI must publish it for this rev.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  chmodSync(dest, 0o755);
  return dest;
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
  /** Qualified transplant targets (the LEAF, body-changed app fns). */
  targets: string[];
  /**
   * The leaf app functions whose OWN body changed (self_hash differs) — the
   * transplant/extract targets. Distinct from the wider subgraph-changed set
   * (which also includes cascade callers that only changed because a callee did;
   * those are handled by the dispatch reroute, not transplanted).
   */
  leafFns: SnapshotFn[];
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

/**
 * Error thrown when `analyze_snapshot` can't read an AOT because its Dart VM
 * snapshot version differs from the `gen_snapshot` that built the app — i.e. the
 * engine mirror shipped an `analyze_snapshot` that isn't coherent with the
 * engine that built the release. Carries a distinct name so the caller can
 * fail fast with guidance instead of a cryptic mid-diff crash.
 */
export class AnalyzeSnapshotIncoherentError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = 'AnalyzeSnapshotIncoherentError';
  }
}

function coherenceHelp(aot: string, extra: string): string {
  return (
    `analyze_snapshot could not read the AOT snapshot (${aot}).\n` +
    `  ${extra}\n` +
    `  This means the engine's host tool \`analyze_snapshot\` was built from a\n` +
    `  different Dart revision than the \`gen_snapshot\` that compiled your app —\n` +
    `  their VM snapshot-format versions must match. The engine mirror needs an\n` +
    `  analyze_snapshot rebuilt from the SAME engine revision as gen_snapshot\n` +
    `  (the engine CI must publish them together, like the dart-sdk tools).\n` +
    `  Auto-diff code-push can't run until that coherent analyze_snapshot is on\n` +
    `  the mirror. (Meanwhile, --legacy-patch-file still works.)`
  );
}

function runAnalyzer(analyzeSnapshot: string, aot: string, outJson: string): SnapshotFn[] {
  try {
    execFileSync(analyzeSnapshot, ['--shorebird', `--out=${outJson}`, aot], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: any) {
    const stderr = (err.stderr?.toString() ?? '') + (err.stdout?.toString() ?? '');
    // Version mismatch surfaces two ways depending on the engine build: a clean
    // "Wrong full snapshot version" message, or a hard SIGKILL (the tool aborts
    // before it can print). Treat both as an incoherent-toolchain error.
    if (/Wrong full snapshot version/i.test(stderr)) {
      const m = stderr.match(/expected '([a-f0-9]+)' found '([a-f0-9]+)'/i);
      throw new AnalyzeSnapshotIncoherentError(
        coherenceHelp(aot, m ? `VM snapshot version mismatch: tool expects '${m[1]}', app is '${m[2]}'.` : stderr.trim().split('\n')[0]),
      );
    }
    if (err.signal === 'SIGKILL' || err.status === 137) {
      throw new AnalyzeSnapshotIncoherentError(
        coherenceHelp(aot, 'analyze_snapshot was killed (SIGKILL) while reading the snapshot — the hallmark of a VM snapshot-version mismatch.'),
      );
    }
    throw new Error(`analyze_snapshot failed for ${aot} (exit ${err.status ?? err.signal ?? '?'}):\n${stderr}`);
  }
  if (!existsSync(outJson)) {
    throw new Error(`analyze_snapshot produced no output for ${aot}`);
  }
  const parsed = JSON.parse(readFileSync(outJson, 'utf8'));
  return (parsed.functions ?? []) as SnapshotFn[];
}

/**
 * Cheap coherence preflight: run `analyze_snapshot` on an already-built base AOT
 * and throw AnalyzeSnapshotIncoherentError if the tool can't read it. Callers
 * run this BEFORE the multi-minute app rebuild so a mismatched engine mirror
 * fails in seconds with guidance, not after a wasted build.
 */
export function assertAnalyzeSnapshotCoherent(analyzeSnapshot: string, baseAot: string): void {
  const probe = join(mkdtempSync(join(tmpdir(), 'sankofa-coh-')), 'probe.json');
  runAnalyzer(analyzeSnapshot, baseAot, probe);
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

  // Subgraph-changed set (a fn + its static-caller cascade) drives link% —
  // the fraction of the app that's reused/unshipped.
  const baseSubgraph = new Set(base.map((f) => f.subgraph_hash));
  const changed = patch.filter((f) => !baseSubgraph.has(f.subgraph_hash)).filter(isAppFn);
  const linkPct = patch.length > 0 ? +(100 * (patch.length - changed.length) / patch.length).toFixed(2) : 100;

  // LEAF changes = app fns whose OWN body changed (self_hash new). These are what
  // we transplant; cascade-only callers are rerouted, not transplanted. Fall back
  // to the subgraph set if the analyzer build doesn't emit self_hash.
  const anySelf = patch.some((f) => !!f.self_hash);
  let leafFns: SnapshotFn[];
  if (anySelf) {
    const baseSelf = new Set(base.map((f) => f.self_hash).filter(Boolean) as string[]);
    leafFns = patch.filter((f) => f.self_hash && !baseSelf.has(f.self_hash)).filter(isAppFn);
  } else {
    leafFns = changed;
  }
  const targets = Array.from(new Set(leafFns.map(qn))).sort();

  return {
    sankofaManifest: targets.join(','),
    targets,
    leafFns,
    linkPct,
    baseCount: base.length,
    patchCount: patch.length,
    changedCount: changed.length,
  };
}

export interface AutoDiffResult {
  /** Comma-separated transplant targets embedded in the module. */
  sankofaManifest: string;
  /** The changed function names (Class.method or top-level). */
  targets: string[];
  /** Count of changed functions. */
  changedCount: number;
  /** Path to the built dispatch-funcreg module, or null if nothing changed. */
  modulePath: string | null;
  moduleSizeBytes: number;
}

/**
 * THE DREAM, no patch file, no app rebuild:
 *   1. AST-diff your edited source against the release snapshot (position-
 *      independent — line shifts don't matter) → the functions whose body
 *      actually changed. Precise, unlike the AOT hash diff which is drowned in
 *      build non-determinism (edit one line → 9000+ spurious hash changes).
 *   2. Emit a minimal unit lifting just those functions + their imports + a
 *      self-describing manifest.
 *   3. dart2bytecode the unit against --import-dill(base no-aot kernel) + the
 *      flutter platform → a ~KB dispatch-funcreg module the device transplants
 *      by name.
 * Returns modulePath=null when nothing source-level changed.
 */
export function buildAutoDiffPatch(opts: {
  projectRoot: string;
  /** The app's .dart_tool/package_config.json — for the unit compile. */
  packageConfig: string;
  /** The release source snapshot dir (holds lib/) to diff the edited tree against. */
  baseSrcDir: string;
  /** Base app no-aot kernel (gen_kernel --no-aot), captured at release. */
  baseNoAotKernel: string;
  /** Output module path. */
  outputPath: string;
  /** package_config that resolves package:analyzer for the extractor (dev/local). */
  analyzerPackages?: string;
}): AutoDiffResult {
  const tools = resolveAutoDiffTools(opts.projectRoot);
  const files = sourceDiffPairs(opts.projectRoot, opts.baseSrcDir);
  const work = mkdtempSync(join(tmpdir(), 'sankofa-unit-'));
  const unitOut = join(work, 'sankofa_patch_unit.dart');
  const manifest = runExtractor({
    projectRoot: opts.projectRoot,
    files,
    unitOut,
    tools,
    analyzerPackages: opts.analyzerPackages,
  });
  const targets = manifest ? manifest.split(',').filter(Boolean) : [];
  if (targets.length === 0) {
    return { sankofaManifest: '', targets: [], changedCount: 0, modulePath: null, moduleSizeBytes: 0 };
  }
  const built = compileChangedUnit({
    projectRoot: opts.projectRoot,
    unitFile: unitOut,
    baseNoAotKernel: opts.baseNoAotKernel,
    packageConfig: opts.packageConfig,
    outputPath: opts.outputPath,
    tools,
  });
  return {
    sankofaManifest: manifest,
    targets,
    changedCount: targets.length,
    modulePath: built.modulePath,
    moduleSizeBytes: built.sizeBytes,
  };
}

