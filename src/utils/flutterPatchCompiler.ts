/**
 * Sankofa Deploy — Flutter patch compiler.
 *
 * Drives the Flutter SDK's bundled compiler to turn a single Dart
 * source file into a compiled patch payload that the on-device SDK can
 * apply. The companion runtime side lives in the Sankofa Flutter SDK.
 *
 * Scope:
 *   - Compile ONE designated patch entry file (default
 *     `lib/sankofa_patch.dart`) into a single payload.
 *   - Optional `--validate <yaml>` enforces the host's dynamic
 *     interface.
 *   - Verify the output container magic.
 *   - Report producer metadata (size, magic).
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { resolveBundledFlutter } from './flutterBundleCache.js';

export type PatchBuildResult = {
  /** Absolute path to the produced payload file. */
  outputPath: string;
  /** Size of the payload file in bytes. */
  sizeBytes: number;
  /** Magic bytes at offset 0, hex. */
  magic: string;
  /** True if magic matched. */
  magicOk: boolean;
  /** Dart SDK root the compiler was loaded from. */
  flutterDartSdk: string;
  /** Whether --validate was passed (and against what file). */
  validatedAgainst: string | null;
  /** Free-form stdout from the compiler (useful for size breakdown). */
  toolStdout: string;
};

export type PatchBuildOptions = {
  /** Patch entry-point Dart file (single file). */
  entryFile: string;
  /** Output payload path. */
  outputPath: string;
  /** Optional dynamic_interface.yaml to validate the patch against. */
  validateYaml?: string;
  /** Override the Flutter dart-sdk path. Defaults to `flutter` on PATH. */
  flutterDartSdk?: string;
  /** Additional compiler options (CSV). Default includes source-positions. */
  bytecodeOptions?: string;
  /**
   * AUTO-DIFF mode. The base app's no-aot kernel to compile the changed source
   * against (--import-dill), so the patch module references the base program.
   */
  importDill?: string;
  /**
   * AUTO-DIFF mode. The comma-separated Class.method manifest (from
   * computeChangedSet). When set, `_sankofaManifest()` + a retaining
   * `@dyn-module:entry-point` are appended to a temp sibling of entryFile before
   * compiling, so the produced module is self-describing: the boot hook invokes
   * `_sankofaManifest()` then transplants each named changed method.
   */
  sankofaManifest?: string;
  /** Prefix the module's library URIs (avoids clashing with the base app). */
  prefixLibraryUris?: string;
};

/**
 * Locate the Flutter SDK's dart-sdk root. Prefers the Sankofa BUNDLED
 * flutter at ~/.sankofa/flutter/<engine-version>/ (resolved from the
 * project's sankofa.yaml engine_version) — falls back to `which flutter`
 * for unconfigured projects.
 *
 * Throws if neither layout yields a valid dart-sdk path.
 */
export function resolveFlutterDartSdk(projectRoot?: string): string {
  // 1) Bundled flutter (isolated per-project toolchain).
  if (projectRoot) {
    const bundled = resolveBundledFlutter(projectRoot);
    if (bundled?.exists) {
      const dartSdk = join(dirname(dirname(bundled.bin)), 'bin', 'cache', 'dart-sdk');
      if (existsSync(dartSdk)) return dartSdk;
    }
  }

  // 2) Customer's flutter on PATH. (`where` on Windows finds flutter.bat;
  // `which` on Unix. `where` can print multiple matches — take the first.)
  let flutterBin: string;
  try {
    const finder = process.platform === 'win32'
      ? execFileSync('where', ['flutter'], { encoding: 'utf-8' })
      : execFileSync('which', ['flutter'], { encoding: 'utf-8' });
    flutterBin = finder.trim().split(/\r?\n/)[0].trim();
  } catch {
    throw new Error('flutter not found on PATH — install Flutter SDK or run `sankofa doctor`.');
  }
  // `flutter` → `<sdk>/bin/flutter`; dart-sdk lives at `<sdk>/bin/cache/dart-sdk/`.
  const sdkRoot = dirname(dirname(flutterBin));
  const dartSdk = join(sdkRoot, 'bin', 'cache', 'dart-sdk');
  if (!existsSync(dartSdk)) {
    throw new Error(
      `Flutter Dart SDK not found at ${dartSdk} — Flutter layout unexpected.`,
    );
  }
  return dartSdk;
}

/**
 * Compile a single Dart source file into a Sankofa patch payload.
 * Returns metadata about the produced file.
 *
 * Throws if compilation fails (invalid Dart, duplicate entry-points,
 * --validate mismatch, etc.) — the error message is the combined
 * stderr/stdout so the caller can surface it.
 */
export function buildFlutterPatch(opts: PatchBuildOptions): PatchBuildResult {
  const entryFile = resolve(opts.entryFile);
  if (!existsSync(entryFile)) {
    throw new Error(`Patch entry file not found: ${entryFile}`);
  }
  if (!entryFile.endsWith('.dart')) {
    throw new Error(`Patch entry file must end in .dart: ${entryFile}`);
  }

  // Resolve dart-sdk from the bundled flutter when this build is anchored
  // to a project — falls back to PATH for standalone CLI invocations.
  const flutterDartSdk =
    opts.flutterDartSdk ?? resolveFlutterDartSdk(opts.entryFile ? dirname(resolve(opts.entryFile)) : undefined);
  const dartaotruntime = join(flutterDartSdk, 'bin', process.platform === 'win32' ? 'dartaotruntime.exe' : 'dartaotruntime');
  const snapshot = join(
    flutterDartSdk,
    'bin',
    'snapshots',
    'dart2bytecode.dart.snapshot',
  );
  const platformDill = join(
    flutterDartSdk,
    'lib',
    '_internal',
    'vm_platform.dill',
  );

  for (const f of [dartaotruntime, snapshot, platformDill]) {
    if (!existsSync(f)) {
      throw new Error(
        `Required Flutter SDK file missing: ${f}\n` +
          '   Your Flutter SDK is older than 3.11 or the layout has shifted.\n' +
          '   Sankofa requires Flutter 3.11+ to build patches.',
      );
    }
  }

  const outputPath = resolve(opts.outputPath);
  const bytecodeOptions =
    opts.bytecodeOptions ?? 'source-positions,show-bytecode-size-stat';

  // AUTO-DIFF: append a self-describing _sankofaManifest() (+ a retaining
  // dyn-module:entry-point) to a temp sibling of the entry file, so the produced
  // module carries the changed-method manifest the boot hook invokes. Sibling
  // path (same dir) keeps the source's relative imports resolvable.
  let sourceToCompile = entryFile;
  let tempFile: string | null = null;
  if (opts.sankofaManifest !== undefined) {
    const esc = opts.sankofaManifest.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const inject =
      `\n\n// [sankofa] auto-generated code-push manifest (DO NOT EDIT)\n` +
      `@pragma('vm:entry-point')\n` +
      `String _sankofaManifest() => '${esc}';\n` +
      `@pragma('dyn-module:entry-point')\n` +
      `Object? _sankofaEntry() { _sankofaManifest(); return null; }\n`;
    tempFile = entryFile.replace(/\.dart$/, '.sankofa_patch.g.dart');
    writeFileSync(tempFile, readFileSync(entryFile, 'utf8') + inject);
    sourceToCompile = tempFile;
  }

  const args: string[] = [
    snapshot,
    '--platform',
    platformDill,
    '--output',
    outputPath,
    '--bytecode-options=' + bytecodeOptions,
  ];
  if (opts.importDill) {
    const importPath = resolve(opts.importDill);
    if (!existsSync(importPath)) {
      throw new Error(`--import-dill kernel not found: ${importPath}`);
    }
    args.push('--import-dill', importPath);
  }
  if (opts.prefixLibraryUris) {
    args.push('--prefix-library-uris', opts.prefixLibraryUris);
  }
  if (opts.validateYaml) {
    const yamlPath = resolve(opts.validateYaml);
    if (!existsSync(yamlPath)) {
      throw new Error(`Dynamic interface YAML not found: ${yamlPath}`);
    }
    args.push('--validate', yamlPath);
  }
  args.push(sourceToCompile);

  let toolStdout = '';
  try {
    toolStdout = execFileSync(dartaotruntime, args, {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    throw new Error(
      `Patch compilation failed (exit ${err.status ?? '?'}):\n${stdout}${stderr}`,
    );
  } finally {
    if (tempFile) {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  if (!existsSync(outputPath)) {
    throw new Error(
      `Patch compilation reported success but produced no output at ${outputPath}.`,
    );
  }
  const sizeBytes = statSync(outputPath).size;

  // Verify the container magic (little-endian: 33 43 42 44).
  const head = readFileSync(outputPath).subarray(0, 4);
  const magic = Array.from(head)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const magicOk = magic === '33434244';

  return {
    outputPath,
    sizeBytes,
    magic,
    magicOk,
    flutterDartSdk,
    validatedAgainst: opts.validateYaml ? resolve(opts.validateYaml) : null,
    toolStdout,
  };
}
