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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
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
  const tools: AutoDiffTools = {
    dartSdk,
    dart: join(dartSdk, 'bin', 'dart'),
    dartaotruntime: join(dartSdk, 'bin', 'dartaotruntime'),
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
  // Version-coherent extractor snapshot shipped inside the bundle (optional).
  const bundleSnap = join(dartSdk, 'bin', 'snapshots', 'sankofa_extract.aot');
  if (existsSync(bundleSnap)) tools.bundleExtractorSnapshot = bundleSnap;
  return tools;
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
  return enumerateAppDartFiles(projectRoot).map((current) => {
    const rel = relative(projectRoot, current); // e.g. lib/main.dart
    const base = join(baseSrcDir, rel);
    return { current, base: existsSync(base) ? base : null };
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
  //      version-coherent with dartaotruntime.
  //   2. CLI-shipped snapshot (tools/sankofa_extract.aot) — coherent while the
  //      shipped snapshot matches the bundle's snapshot format.
  //   3. .dart source + analyzer package_config — local/dev fallback only.
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
      // A snapshot from a different VM format is rejected here — try the next.
      lastErr = e;
    }
  }
  if (manifest === undefined) {
    const analyzerPackages =
      opts.analyzerPackages ?? process.env.SANKOFA_ANALYZER_PACKAGES;
    if (!analyzerPackages) {
      throw new Error(
        'Changed-function extractor could not run. No version-coherent snapshot ' +
          'was usable' +
          (snapCandidates.length ? ` (tried ${snapCandidates.length})` : '') +
          ' and no package:analyzer package_config is available. Reinstall the ' +
          'engine (`sankofa engine download`) so its bundled extractor snapshot ' +
          'is present, or set SANKOFA_ANALYZER_PACKAGES for a local build.' +
          (lastErr ? `\n  last snapshot error: ${(lastErr as Error).message?.split('\n')[0]}` : ''),
      );
    }
    manifest = execFileSync(
      t.dart,
      ['--packages=' + analyzerPackages, extractorSource(), specPath],
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    );
  }
  if (!existsSync(opts.unitOut)) {
    throw new Error(`extractor produced no unit at ${opts.unitOut}`);
  }
  return manifest.trim();
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
