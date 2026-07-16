/**
 * Sankofa Deploy — the auto-diff module builder (THE DREAM's real module-build).
 *
 * Proven on host 2026-07-04: real flutter app code → tiny dispatch-funcreg
 * module, with no patch file. The flow:
 *   RELEASE  → captureBaseNoAotKernel(): gen_kernel --no-aot → base_noaot.dill
 *              (the --import-dill reference; NOT flutter's --aot app.dill, which
 *              crashes dart2bytecode).
 *   PATCH    → runExtractor(): analyze-diff manifest + the app's real source →
 *              a minimal generated unit (the changed fns + their imports).
 *            → compileChangedUnit(): dart2bytecode the unit against
 *              --import-dill(base_noaot) + the flutter platform → a ~KB module.
 *
 * Compiling the WHOLE app main against import-dill crashes the CFE (same-URI
 * collision with the huge flutter tree); a minimal, prefixed, tool-generated
 * unit sidesteps it — yields 527 B (logic) / 868 B (UI) / 670 B (real risky).
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { resolveBundledFlutter } from './flutterBundleCache.js';

export interface AutoDiffTools {
  dartSdk: string;
  dart: string;
  dartaotruntime: string;
  genKernel: string;
  dart2bytecode: string;
  /** Flutter platform kernel — resolves package:flutter/dart:ui refs. */
  flutterPlatform: string;
  /**
   * The extractor AOT snapshot that SHIPS INSIDE THIS BUNDLE, if present.
   * Compiled against this engine's dart-sdk at engine-build time, so it is
   * guaranteed version-coherent with `dartaotruntime`. Preferred over the
   * CLI-shipped copy (which may lag the bundle across engine versions).
   */
  bundleExtractorSnapshot?: string;
  /** The bundled Flutter SDK root (`<root>/bin/flutter` lives here). */
  flutterRoot: string;
  /**
   * A package_config resolving `package:analyzer`, discovered inside the
   * bundled Flutter SDK (flutter_tools depends on the analyzer). Used to
   * BUILD [bundleExtractorSnapshot] on demand and as the source-mode
   * fallback's `--packages`. Absent until flutter_tools has been
   * pub-got — which any `flutter build` does on first run.
   */
  analyzerPackageConfig?: string;
}

/**
 * Resolve the bundle's compile toolchain from the project's bundled flutter.
 * Throws with an actionable message if a tool is missing.
 */
export function resolveAutoDiffTools(projectRoot: string): AutoDiffTools {
  const bundled = resolveBundledFlutter(projectRoot);
  if (!bundled?.exists) {
    throw new Error(
      'Bundled Sankofa flutter not found for this project — run a build/patch once ' +
        'to install it, or `sankofa engine download`.',
    );
  }
  const root = dirname(dirname(bundled.bin)); // <root>/bin/flutter → <root>
  const dartSdk = join(root, 'bin', 'cache', 'dart-sdk');
  const engArt = join(root, 'bin', 'cache', 'artifacts', 'engine');
  // Windows executables carry a `.exe` suffix. execFileSync does NOT auto-append
  // it for a full path, and the existence checks below would otherwise fail —
  // silently killing the base_noaot.dill capture (so `sankofa patch` refuses).
  const exe = process.platform === 'win32' ? '.exe' : '';
  const tools: AutoDiffTools = {
    flutterRoot: root,
    dartSdk,
    dart: join(dartSdk, 'bin', `dart${exe}`),
    dartaotruntime: join(dartSdk, 'bin', `dartaotruntime${exe}`),
    genKernel: join(dartSdk, 'bin', 'snapshots', 'gen_kernel_aot.dart.snapshot'),
    dart2bytecode: join(dartSdk, 'bin', 'snapshots', 'dart2bytecode.dart.snapshot'),
    // Product platform (release). Fall back to the non-product one if absent.
    flutterPlatform:
      firstExisting([
        join(engArt, 'common', 'flutter_patched_sdk_product', 'platform_strong.dill'),
        join(engArt, 'common', 'flutter_patched_sdk', 'platform_strong.dill'),
      ]) ?? join(engArt, 'common', 'flutter_patched_sdk_product', 'platform_strong.dill'),
  };
  const required: (keyof AutoDiffTools)[] = [
    'dartSdk', 'dart', 'dartaotruntime', 'genKernel', 'dart2bytecode', 'flutterPlatform',
  ];
  for (const label of required) {
    const p = tools[label] as string;
    if (!existsSync(p)) {
      throw new Error(`Auto-diff toolchain missing ${label}: ${p}\n  The bundled engine is incomplete — reinstall with \`sankofa engine download\`.`);
    }
  }
  // Version-coherent extractor snapshot living inside the bundle (optional —
  // ensureBundleExtractorSnapshot builds it on first use when absent).
  const bundleSnap = bundleExtractorSnapshotPath(dartSdk);
  if (existsSync(bundleSnap)) tools.bundleExtractorSnapshot = bundleSnap;
  tools.analyzerPackageConfig = findAnalyzerPackageConfig(root);
  return tools;
}

/**
 * Locate a package_config inside the bundled Flutter SDK that resolves
 * `package:analyzer`. flutter_tools depends on the analyzer, and its
 * package_config is regenerated with machine-local pub-cache paths the first
 * time the bundled `flutter` runs — so on a fresh machine this exists by the
 * time any patch is built, with no extra download.
 */
function findAnalyzerPackageConfig(flutterRoot: string): string | undefined {
  const p = join(flutterRoot, 'packages', 'flutter_tools', '.dart_tool', 'package_config.json');
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as {
      packages?: { name?: string }[];
    };
    const hasAnalyzer = parsed.packages?.some((pkg) => pkg.name === 'analyzer');
    return hasAnalyzer ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure the bundle carries an extractor snapshot that `dartaotruntime` can
 * actually run, building it on first use when absent.
 *
 * WHY THIS EXISTS: the CLI-shipped `tools/sankofa_extract.aot` is compiled
 * against whatever Dart built the npm package, so it is only usable while its
 * snapshot format matches the engine the customer pinned. Any drift makes
 * dartaotruntime reject it ("Wrong full snapshot version"), and — with no
 * bundled snapshot and no package:analyzer at the customer — `sankofa patch`
 * dies. Compiling here, with the bundle's own `dart`, makes the snapshot
 * version-coherent BY CONSTRUCTION for every engine version, on any machine.
 *
 * Costs ~10s once per engine version, then it is cached inside the bundle
 * (a re-downloaded engine correctly rebuilds it). Best-effort: any failure
 * returns undefined and leaves the caller's other candidates to try.
 */
/**
 * Where this CLI's extractor snapshot lives inside a bundle. The filename
 * carries a hash of the extractor SOURCE, so a CLI upgrade that changes the
 * extractor can never silently keep using a stale snapshot compiled from the
 * old source — a changed hash is simply a cache miss.
 */
function bundleExtractorSnapshotPath(dartSdk: string): string {
  let tag = 'unknown';
  try {
    tag = createHash('sha256')
      .update(readFileSync(extractorSource()))
      .digest('hex')
      .slice(0, 12);
  } catch {
    /* extractor source unreadable — the caller degrades to other candidates */
  }
  return join(dartSdk, 'bin', 'snapshots', `sankofa_extract.${tag}.aot`);
}

export function ensureBundleExtractorSnapshot(
  tools: AutoDiffTools,
  opts: { quiet?: boolean } = {},
): string | undefined {
  if (tools.bundleExtractorSnapshot) return tools.bundleExtractorSnapshot;
  const packages = tools.analyzerPackageConfig;
  if (!packages) return undefined;
  const dest = bundleExtractorSnapshotPath(tools.dartSdk);
  // Compile to a unique temp path + rename: concurrent `sankofa patch` runs
  // must never observe a half-written snapshot.
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    if (!opts.quiet) {
      console.log('  Preparing the changed-function extractor for this engine (one-time, ~10s)…');
    }
    execFileSync(
      tools.dart,
      ['compile', 'aot-snapshot', `--packages=${packages}`, extractorSource(), '-o', tmp],
      { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
    );
    if (!existsSync(tmp)) return undefined;
    renameSync(tmp, dest);
    tools.bundleExtractorSnapshot = dest;
    // Drop snapshots built from older extractor sources — they can never be
    // chosen again (the hash moved) and each is ~3 MB.
    try {
      const dir = dirname(dest);
      for (const name of readdirSync(dir)) {
        if (/^sankofa_extract\..*\.aot$/.test(name) && join(dir, name) !== dest) {
          rmSync(join(dir, name), { force: true });
        }
      }
    } catch { /* pruning is best-effort */ }
    return dest;
  } catch {
    // Read-only bundle, missing analyzer, compile error — fall back to the
    // caller's remaining candidates rather than failing the patch here.
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return undefined;
  }
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

/**
 * Capture the base program's `--no-aot` kernel (the `--import-dill` reference for
 * later patches). Produced with gen_kernel `--no-aot --target flutter` against
 * the flutter platform — NOT flutter's `app.dill` (that's the --aot kernel and
 * crashes dart2bytecode). Returns the output path.
 */
export function captureBaseNoAotKernel(opts: {
  projectRoot: string;
  /** App entry, e.g. package:<name>/main.dart or a file path. */
  appEntry: string;
  packageConfig: string;
  outputPath: string;
  tools?: AutoDiffTools;
}): string {
  const t = opts.tools ?? resolveAutoDiffTools(opts.projectRoot);
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  execFileSync(
    t.dartaotruntime,
    [
      t.genKernel,
      '--target', 'flutter',
      '--packages', opts.packageConfig,
      '-Ddart.vm.product=true',
      '--no-aot',
      '--no-embed-sources',
      '--platform', t.flutterPlatform,
      '--output', opts.outputPath,
      opts.appEntry,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  if (!existsSync(opts.outputPath)) {
    throw new Error(`base no-aot kernel not produced at ${opts.outputPath}`);
  }
  return opts.outputPath;
}

/** A source file to diff: the current (edited) version vs the base snapshot. */
export interface SourceDiffPair {
  current: string;
  /** Base snapshot path, or null if the file is new (all its fns count as changed). */
  base: string | null;
  /**
   * The `package:` URI this file is known by (e.g. `package:my_app/main.dart`).
   * The extractor self-imports it so a lifted body can still name the types its
   * own library declares. MUST be the package URI, not a file path: the base
   * dill knows the library under that URI, so importing it resolves through
   * --import-dill instead of loading a second copy of the same library.
   */
  uri?: string;
}

/** Read `name:` from the project's pubspec.yaml. */
function readPubspecPackageName(projectRoot: string): string | undefined {
  const p = join(projectRoot, 'pubspec.yaml');
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, 'utf-8').match(/^\s*name:\s*['"]?([A-Za-z_][\w]*)['"]?\s*$/m);
  return m?.[1];
}

/**
 * The `package:` URI for an app source file, or undefined when it isn't under
 * `lib/` (those aren't addressable as package URIs and can't be self-imported).
 */
export function packageUriForAppFile(
  projectRoot: string,
  file: string,
  packageName = readPubspecPackageName(projectRoot),
): string | undefined {
  if (!packageName) return undefined;
  const rel = relative(join(projectRoot, 'lib'), file);
  if (!rel || rel.startsWith('..')) return undefined;
  return `package:${packageName}/${rel.split(sep).join('/')}`;
}

/** All `.dart` files under `<root>/lib` — the app's own patchable source. */
export function enumerateAppDartFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.dart')) out.push(p);
    }
  };
  walk(join(root, 'lib'));
  return out;
}

/**
 * Snapshot the app's own source (`<root>/lib`) into `<destDir>/lib` at release.
 * A later `sankofa patch` AST-diffs the edited working tree against this to find
 * exactly the changed functions — position-independent, no app rebuild.
 */
export function snapshotAppSource(projectRoot: string, destDir: string): void {
  const src = join(projectRoot, 'lib');
  const dest = join(destDir, 'lib');
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true });
}

/** Map current app source files to diff pairs against a base source snapshot dir. */
export function sourceDiffPairs(
  projectRoot: string,
  baseSrcDir: string,
): SourceDiffPair[] {
  const packageName = readPubspecPackageName(projectRoot);
  return enumerateAppDartFiles(projectRoot).map((current) => {
    const rel = relative(projectRoot, current); // e.g. lib/main.dart
    const base = join(baseSrcDir, rel);
    return {
      current,
      base: existsSync(base) ? base : null,
      uri: packageUriForAppFile(projectRoot, current, packageName),
    };
  });
}

/** Absolute path to the bundled extractor Dart source (shipped with the CLI). */
function extractorSource(): string {
  // dist/utils/flutterAutoDiffCompile.js → ../../tools/sankofa_extract.dart
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'tools', 'sankofa_extract.dart');
}

/** Absolute path to the precompiled extractor AOT snapshot (self-contained: the
 * analyzer is baked in, so it runs on the bundle's dartaotruntime with no
 * package:analyzer at the customer). Shipped alongside the source. */
function extractorSnapshot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'tools', 'sankofa_extract.aot');
}

/**
 * Run the changed-function extractor: real app source + the changed-fn specs →
 * a generated minimal unit written to `unitOut`. Returns the manifest string
 * (comma-separated transplant targets) the module embeds.
 *
 * The extractor needs package:analyzer. In a customer bundle it runs from the
 * shipped, self-contained AOT snapshot (analyzer baked in) via the bundle's
 * dartaotruntime — no package:analyzer, no engine dart tree required. The
 * .dart source + SANKOFA_ANALYZER_PACKAGES is only a local/dev fallback.
 */
export function runExtractor(opts: {
  projectRoot: string;
  /** Source files to diff (current vs base snapshot) — the source-level detector. */
  files: SourceDiffPair[];
  unitOut: string;
  tools?: AutoDiffTools;
  /** package_config that resolves package:analyzer for the extractor. */
  analyzerPackages?: string;
}): string {
  const t = opts.tools ?? resolveAutoDiffTools(opts.projectRoot);
  mkdirSync(dirname(opts.unitOut), { recursive: true });
  const specPath = join(dirname(opts.unitOut), 'sankofa_extract_spec.json');
  writeFileSync(specPath, JSON.stringify({ out: opts.unitOut, files: opts.files }));

  // Prefer the self-contained snapshot (analyzer baked in) — runs on the
  // bundle's dartaotruntime with no package:analyzer at the customer.
  //   1. bundle snapshot  — compiled against THIS engine's dart-sdk, always
  //      version-coherent with dartaotruntime. Built on first use.
  //   2. CLI-shipped snapshot (tools/sankofa_extract.aot) — coherent while the
  //      shipped snapshot matches the bundle's snapshot format.
  //   3. .dart source + analyzer package_config — local/dev fallback only.
  ensureBundleExtractorSnapshot(t);
  const snapCandidates = [t.bundleExtractorSnapshot, extractorSnapshot()].filter(
    (p): p is string => !!p && existsSync(p),
  );
  let manifest: string | undefined;
  let lastErr: unknown;
  for (const snap of snapCandidates) {
    try {
      manifest = execFileSync(t.dartaotruntime, [snap, specPath], {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      });
      break;
    } catch (e) {
      // Exit 64 is the extractor's own verdict (a changed method is outside
      // the patchable seam) — a diagnostic for the USER, not a broken
      // snapshot. Every candidate would say the same thing: surface it now.
      throwIfSeamError(e);
      // A snapshot from a different VM format is rejected here — try the next.
      lastErr = e;
    }
  }
  if (manifest === undefined) {
    const analyzerPackages =
      opts.analyzerPackages ??
      process.env.SANKOFA_ANALYZER_PACKAGES ??
      t.analyzerPackageConfig;
    if (!analyzerPackages) {
      throw new Error(
        'Changed-function extractor could not run. No version-coherent snapshot ' +
          'was usable' +
          (snapCandidates.length ? ` (tried ${snapCandidates.length})` : '') +
          ' and no package:analyzer package_config is available.\n' +
          '  The extractor is normally compiled on demand from the bundled engine, ' +
          'which needs flutter_tools to have been pub-got at least once. Run a ' +
          'build first (`sankofa release <platform>`) or reinstall the engine ' +
          '(`sankofa engine download`); set SANKOFA_ANALYZER_PACKAGES to override.' +
          (lastErr ? `\n  last snapshot error: ${(lastErr as Error).message?.split('\n')[0]}` : ''),
      );
    }
    try {
      manifest = execFileSync(
        t.dart,
        ['--packages=' + analyzerPackages, extractorSource(), specPath],
        { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (e) {
      throwIfSeamError(e);
      throw e;
    }
  }
  if (!existsSync(opts.unitOut)) {
    throw new Error(`extractor produced no unit at ${opts.unitOut}`);
  }
  return manifest.trim();
}

/**
 * Exit code by which sankofa_extract.dart reports "a changed method is
 * outside the patchable seam" — a user-facing verdict carried on stderr, as
 * opposed to any real tool failure.
 */
const SEAM_ERROR_EXIT = 64;

/** Rethrow an extractor failure as its clean stderr message when it is the
 * seam diagnostic (exit 64); no-op for every other failure. */
function throwIfSeamError(e: unknown): void {
  const err = e as { status?: number; stderr?: string | Buffer };
  if (err?.status !== SEAM_ERROR_EXIT) return;
  const msg = (err.stderr ?? '').toString().trim();
  if (msg) throw new Error(msg);
}

/**
 * Compile a generated unit into a dispatch-funcreg module against the base
 * no-aot kernel + the flutter platform. Returns { modulePath, sizeBytes }.
 */
export function compileChangedUnit(opts: {
  projectRoot: string;
  unitFile: string;
  baseNoAotKernel: string;
  packageConfig: string;
  outputPath: string;
  tools?: AutoDiffTools;
}): { modulePath: string; sizeBytes: number } {
  const t = opts.tools ?? resolveAutoDiffTools(opts.projectRoot);
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  execFileSync(
    t.dartaotruntime,
    [
      t.dart2bytecode,
      '--platform', t.flutterPlatform,
      '--target', 'flutter',
      '--packages', opts.packageConfig,
      '-Ddart.vm.product=true',
      '--import-dill', opts.baseNoAotKernel,
      '--prefix-library-uris', 'sankofa/patch',
      '--output', opts.outputPath,
      opts.unitFile,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
  if (!existsSync(opts.outputPath)) {
    throw new Error(`module not produced at ${opts.outputPath}`);
  }
  const sizeBytes = statSync(opts.outputPath).size;
  // Verify the DBC3 container magic.
  const magic = readFileSync(opts.outputPath).subarray(0, 4).toString('hex');
  if (magic !== '33434244') {
    throw new Error(`produced module has bad magic ${magic} (expected DBC3 33434244)`);
  }
  return { modulePath: opts.outputPath, sizeBytes };
}
