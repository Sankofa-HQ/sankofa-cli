/**
 * Sankofa Deploy: Flutter Code — KBC patch producer (sub-phase γ).
 *
 * Wraps the upstream `dart2bytecode.dart.snapshot` that ships with the
 * Flutter SDK to compile a single Dart source file into a `.kbc`
 * bytecode file consumable by `dynamic_modules.loadModuleFromBytes`
 * inside the Sankofa β.1 Flutter engine.
 *
 * Producer-side proof for β.3 (Path C, the KBC interpreter program).
 * The companion runtime side is in
 * `sdks/sankofa_sdk_flutter/lib/src/deploy/` (η work, not yet wired).
 *
 * v0 scope:
 *   - Compile ONE designated patch entry file (default
 *     `lib/sankofa_patch.dart`) into a single `patch.kbc`.
 *   - Optional `--validate <yaml>` enforces the host's dynamic
 *     interface, mirroring `--dynamic-interface` passed to the host's
 *     kernel compile.
 *   - Verify `DBC3` magic (little-endian 33 43 42 44) in the output.
 *   - Report producer metadata (size, instruction count, magic).
 *
 * v1 will add:
 *   - Multi-file patch bundles (the patch may import patch-local
 *     helpers from multiple .dart files; dart2bytecode handles this
 *     natively).
 *   - Old-vs-new source-diff so callers don't manually maintain
 *     `sankofa_patch.dart` — the CLI infers the changed surface from
 *     the project's git baseline.
 *   - β.4 envelope: signed + versioned wrapper so the server side
 *     can verify provenance before applying.
 *
 * See sankofa-flutter-deploy/docs/build-log-interpreter-program.md for
 * the architecture rationale (β.3 + ε spike entries).
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

export type KbcBuildResult = {
  /** Absolute path to the produced .kbc file. */
  outputPath: string;
  /** Size of the .kbc file in bytes. */
  sizeBytes: number;
  /** Magic bytes at offset 0, hex (expected "33434244" = DBC3 little-endian). */
  magic: string;
  /** True if magic matched. */
  magicOk: boolean;
  /** Dart SDK root the snapshot was loaded from. */
  flutterDartSdk: string;
  /** Whether --validate was passed (and against what file). */
  validatedAgainst: string | null;
  /** Free-form stdout from dart2bytecode (useful for size breakdown). */
  toolStdout: string;
};

export type KbcBuildOptions = {
  /** Patch entry-point Dart file (single file). */
  entryFile: string;
  /** Output .kbc path. */
  outputPath: string;
  /** Optional dynamic_interface.yaml to validate the patch against. */
  validateYaml?: string;
  /** Override the Flutter dart-sdk path. Defaults to `flutter` on PATH. */
  flutterDartSdk?: string;
  /** Additional --bytecode-options entries (CSV). Default includes source-positions. */
  bytecodeOptions?: string;
};

/**
 * Locate the Flutter SDK's dart-sdk root. Walks up from `flutter` on PATH.
 * Throws if Flutter isn't installed or layout is unexpected.
 */
export function resolveFlutterDartSdk(): string {
  let flutterBin: string;
  try {
    flutterBin = execFileSync('which', ['flutter'], { encoding: 'utf-8' }).trim();
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
 * Compile a single Dart source file into a Sankofa KBC patch.
 * Returns metadata about the produced .kbc.
 *
 * Throws if dart2bytecode fails (invalid Dart, duplicate dyn-module
 * entry-points, --validate mismatch, etc.) — the error message is the
 * combined stderr/stdout so the caller can surface it.
 */
export function buildKbcPatch(opts: KbcBuildOptions): KbcBuildResult {
  const entryFile = resolve(opts.entryFile);
  if (!existsSync(entryFile)) {
    throw new Error(`Patch entry file not found: ${entryFile}`);
  }
  if (!entryFile.endsWith('.dart')) {
    throw new Error(`Patch entry file must end in .dart: ${entryFile}`);
  }

  const flutterDartSdk = opts.flutterDartSdk ?? resolveFlutterDartSdk();
  const dartaotruntime = join(flutterDartSdk, 'bin', 'dartaotruntime');
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
          '   Sankofa requires Flutter 3.11+ for KBC patch production.',
      );
    }
  }

  const outputPath = resolve(opts.outputPath);
  const bytecodeOptions =
    opts.bytecodeOptions ?? 'source-positions,show-bytecode-size-stat';

  const args: string[] = [
    snapshot,
    '--platform',
    platformDill,
    '--output',
    outputPath,
    '--bytecode-options=' + bytecodeOptions,
  ];
  if (opts.validateYaml) {
    const yamlPath = resolve(opts.validateYaml);
    if (!existsSync(yamlPath)) {
      throw new Error(`Dynamic interface YAML not found: ${yamlPath}`);
    }
    args.push('--validate', yamlPath);
  }
  args.push(entryFile);

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
      `dart2bytecode failed (exit ${err.status ?? '?'}):\n${stdout}${stderr}`,
    );
  }

  if (!existsSync(outputPath)) {
    throw new Error(
      `dart2bytecode reported success but no output at ${outputPath}.`,
    );
  }
  const sizeBytes = statSync(outputPath).size;

  // Verify DBC3 magic (little-endian: 33 43 42 44).
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
