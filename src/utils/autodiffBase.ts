/**
 * Sankofa Deploy — auto-diff base store.
 *
 * THE DREAM's base half: `sankofa release` produces a baseline app whose exact
 * AOT snapshot + program kernel (`app.dill`) are the reference a later
 * `sankofa patch` diffs the *rebuilt, edited* app against — yielding only the
 * changed functions to ship (dispatch-funcreg), no patch file. See
 * flutterPatchDiff.ts (`buildAutoDiffPatch`) for the consumer.
 *
 * This module persists that base on disk under
 *   `<project>/.sankofa/baseline/autodiff/<platform>/<label>/`
 * so the SAME machine that released can immediately patch against it. Persisting
 * the base SERVER-side (so any machine / CI can patch a release it didn't build)
 * is the productionization follow-up — see resolveAutoDiffBase()'s server TODO.
 *
 * The store is small and self-describing:
 *   base.aot   — Android libapp.so / iOS App.framework Mach-O (the base program)
 *   base.dill  — the `--import-dill` kernel the patch compiles the delta against
 *   meta.json  — {label, engineVersion, targetBinaryVersion, platform, abi, aotSha256}
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { snapshotAppSource } from './flutterAutoDiffCompile.js';

export interface AutoDiffBaseMeta {
  /** Release label the base belongs to (e.g. `v1.0.0`). */
  label: string;
  /** Sankofa engine version the base was built with (patch must match). */
  engineVersion: string;
  /** App version — the device app_version a patch targets. */
  targetBinaryVersion: string;
  platform: 'ios' | 'android';
  /** ABI of the AOT (Android arm64-v8a; ios device-arm64). */
  abi: string;
  /** SHA-256 of base.aot — lets patch assert it diffed against the exact base. */
  aotSha256: string;
  /** Whether a base kernel was captured (auto-diff needs it; absent ⇒ degraded). */
  hasDill: boolean;
  capturedAt: string;
}

export interface ResolvedAutoDiffBase {
  dir: string;
  baseAotPath: string;
  /**
   * The base program's `--no-aot` kernel (gen_kernel --no-aot) — the
   * `--import-dill` reference the patch compiles the changed unit against. null
   * when it wasn't captured (can't auto-diff). NOT flutter's app.dill.
   */
  baseNoAotPath: string | null;
  /**
   * The base dir holding the app's SOURCE snapshot (`<dir>/lib`) taken at
   * release. A later patch AST-diffs the edited working tree against this to
   * find exactly the changed functions (position-independent).
   */
  baseSrcDir: string;
  meta: AutoDiffBaseMeta;
}

function baseDir(projectRoot: string, platform: string, label: string): string {
  // Labels are `v<semver>` / `<base>-patch.N` — filesystem-safe already, but
  // scrub path separators defensively so a crafted label can't escape the dir.
  const safeLabel = label.replace(/[/\\]/g, '_');
  return resolve(projectRoot, '.sankofa', 'baseline', 'autodiff', platform, safeLabel);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Persist a release's auto-diff base. Returns the store dir, or null when the
 * base AOT wasn't produced (nothing to diff against — the release still
 * succeeds, but patches against it fall back to the legacy path).
 */
export function writeAutoDiffBase(opts: {
  projectRoot: string;
  label: string;
  engineVersion: string;
  targetBinaryVersion: string;
  platform: 'ios' | 'android';
  abi: string;
  baseAotPath: string | null;
  /** The base program's --no-aot kernel (gen_kernel --no-aot), for --import-dill. */
  baseNoAotPath: string | null;
}): string | null {
  if (!opts.baseAotPath || !existsSync(opts.baseAotPath)) return null;
  const dir = baseDir(opts.projectRoot, opts.platform, opts.label);
  // Fresh per (label,platform) — a re-release of the same label supersedes.
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const aotDest = join(dir, 'base.aot');
  copyFileSync(opts.baseAotPath, aotDest);

  let hasDill = false;
  if (opts.baseNoAotPath && existsSync(opts.baseNoAotPath)) {
    copyFileSync(opts.baseNoAotPath, join(dir, 'base_noaot.dill'));
    hasDill = true;
  }

  // Snapshot the app's own source (lib/) — the base a later patch AST-diffs the
  // edited working tree against to find exactly the changed functions.
  snapshotAppSource(opts.projectRoot, dir);

  const meta: AutoDiffBaseMeta = {
    label: opts.label,
    engineVersion: opts.engineVersion,
    targetBinaryVersion: opts.targetBinaryVersion,
    platform: opts.platform,
    abi: opts.abi,
    aotSha256: sha256(aotDest),
    hasDill,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return dir;
}

/**
 * Resolve a previously-persisted auto-diff base for `label` on `platform`.
 * Returns null when no local base exists.
 *
 * TODO(server round-trip): when absent locally, fetch base.aot + base.dill from
 * the release's server-side base artifacts (once ee/deploy persists them) so a
 * machine that didn't build the release can still patch it. Until then a missing
 * local base means "release on this machine first" — surfaced by the caller.
 */
export function resolveAutoDiffBase(
  projectRoot: string,
  platform: 'ios' | 'android',
  label: string,
): ResolvedAutoDiffBase | null {
  const dir = baseDir(projectRoot, platform, label);
  const metaPath = join(dir, 'meta.json');
  const aotPath = join(dir, 'base.aot');
  if (!existsSync(metaPath) || !existsSync(aotPath)) return null;
  let meta: AutoDiffBaseMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AutoDiffBaseMeta;
  } catch {
    return null;
  }
  const dillPath = join(dir, 'base_noaot.dill');
  return {
    dir,
    baseAotPath: aotPath,
    baseNoAotPath: existsSync(dillPath) ? dillPath : null,
    baseSrcDir: dir,
    meta,
  };
}

/** Human-readable size of the persisted base, for CLI output. */
export function autoDiffBaseSize(dir: string): number {
  let total = 0;
  for (const f of ['base.aot', 'base_noaot.dill']) {
    const p = join(dir, f);
    if (existsSync(p)) total += statSync(p).size;
  }
  return total;
}
