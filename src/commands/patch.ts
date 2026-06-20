import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  bundleJS,
  clearBuildArtifacts,
  computeSHA256,
  createOTAArchive,
  detectEntryFile,
  formatBytes,
  getFileSize,
  syncNativeFromAppJson,
} from '../utils/bundler.js';
import { listReleases, uploadRelease } from '../utils/api.js';
import { requireAuth, findProjectConfig } from '../utils/config.js';
import { resolveEnvironmentPrompt, resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveProjectRoot, type ProjectInfo } from '../utils/stack.js';
import { escapeRegExp, parseRollout } from '../utils/validation.js';
import { detectFlutterEngineInfo, resolveFlutterPlatform } from '../utils/flutterBundler.js';
import { readBaselineManifest } from '../utils/baseline.js';
import { buildFlutterPatch, resolveFlutterDartSdk } from '../utils/flutterPatchCompiler.js';
import { packPatch, type PatchMetadata } from '../utils/flutterPatchPackage.js';
import { loadSigningKey, signEd25519 } from './keys.js';

function isPatchRelease(release: any): boolean {
  return /-patch\.\d+$/.test(String(release.label || ''));
}

export const patchCommand = new Command('patch')
  .description('Push an OTA patch to an existing release (Dart/JS code only — no native changes)')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--entry-file <file>', 'RN: JS entry file. Flutter: patch entry-point (alias of -t/--target).')
  .option('-t, --target <file>', "Flutter: patch entry-point file to compile (default lib/sankofa_patch.dart). Pick one when you keep several patch entries. The file must expose the @pragma('dyn-module:entry-point') function.")
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--description <desc>', 'Patch description')
  .option('--mandatory', 'Mark this patch as mandatory (force-update)')
  .option('--rollout <percent>', 'Rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--project <path>', 'Project root (defaults to auto-detect)')
  .option('--release <labelOrId>', 'Baseline release label or id to patch (skips the interactive picker — required for headless/CI patching)')
  .option('--flavor <name>', 'Flutter: product flavor the base release was built with (e.g. staging, production). Scopes which base release this patch targets, mirroring `sankofa release --flavor`. The KBC patch itself is flavor-independent.')
  .option('--engine-version <version>', 'Flutter: override the detected engine version (rare)')
  // Flutter Code patch options (iOS + Android — RN ignores these).
  .option('--label <label>', 'Flutter: standalone base-patch label override (used only when no baseline release exists)')
  .option('--target-binary-version <semver>', 'Flutter: target host app version for a standalone base patch (default: inherited from the baseline release)')
  .option('--engine-commit <sha>', 'Flutter: Sankofa Flutter engine commit baked into patch metadata')
  .option('--dart-version <semver>', 'Flutter: Dart SDK version baked into patch metadata')
  .option('--dynamic-interface <yaml>', 'Flutter: dynamic_interface.yaml path (default ./sankofa/dynamic_interface.yaml if present)')
  .option('--dry-run', 'Build + run the safety check locally, but do NOT contact the server or upload')
  .action(async (platformArg: string | undefined, opts: any) => {
    const chalk = (await import('chalk')).default;

    await requireAuth();

    let project: ProjectInfo;
    try {
      project = await resolveProjectRoot({
        explicit: opts.project,
        allowedStacks: ['react-native', 'flutter'],
      });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    if (project.root !== process.cwd()) {
      console.log(chalk.dim(`  → Working in ${project.root}`));
      process.chdir(project.root);
    }

    if (project.stack === 'flutter') {
      return flutterPatch(project, platformArg, opts);
    }
    return rnPatch(project, platformArg, opts);
  });

// ── React Native (existing behavior, unchanged) ───────────────────────────────

async function rnPatch(project: ProjectInfo, platformArg: string | undefined, opts: any) {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const inquirer = (await import('inquirer')).default;

  let platform;
  let environment;
  let initialRollout;
  try {
    platform = await resolvePlatformPrompt(platformArg);
    environment = await resolveEnvironmentPrompt(opts.env);
    initialRollout = parseRollout(opts.rollout);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const syncSpinner = ora('Syncing native project from app.json (expo prebuild)...').start();
  try {
    syncNativeFromAppJson(platform);
    syncSpinner.succeed('Native project synced');
  } catch (err: any) {
    syncSpinner.fail(err.message);
    process.exit(1);
  }

  const entryFile = detectEntryFile(opts.entryFile);

  const spinner = ora('Fetching releases...').start();
  let releases: any[];
  let baseReleases: any[];
  try {
    releases = await listReleases(environment, platform);
    baseReleases = releases.filter((release: any) => !isPatchRelease(release));
  } catch (err: any) {
    spinner.fail(`Failed to fetch releases: ${err.message}`);
    process.exit(1);
  }

  if (baseReleases.length === 0) {
    spinner.fail(`No releases found for ${platform}. Run ${chalk.cyan('sankofa release ' + platform)} first.`);
    process.exit(1);
  }
  spinner.succeed(`Found ${baseReleases.length} base release(s)`);

  const { selectedRelease } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedRelease',
      message: 'Select a release to patch:',
      choices: baseReleases.map((r: any) => ({
        name: `${r.label} (${r.is_disabled ? 'Disabled' : 'Active'}, ${r.total_installs ?? 0} installs, target: ${r.target_binary_version})`,
        value: r,
      })),
    },
  ]);

  const { hasNativeChanges } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'hasNativeChanges',
      message: 'Does this patch include native code changes (new native modules, updated Podfile/build.gradle)?',
      default: false,
    },
  ]);

  if (hasNativeChanges) {
    console.log('');
    console.log(chalk.yellow('  ⚠️  Native changes cannot be deployed over-the-air.'));
    console.log(chalk.yellow('     Only JavaScript/TypeScript code will be patched.'));
    console.log(chalk.yellow('     Users will need an App Store/Play Store update for native changes.'));
    console.log('');
    const { continueAnyway } = await inquirer.prompt([
      { type: 'confirm', name: 'continueAnyway', message: 'Continue with JS-only patch?', default: true },
    ]);
    if (!continueAnyway) {
      console.log(chalk.dim('Patch cancelled.'));
      return;
    }
  }

  const outputDir = opts.outputDir;
  const cleanSpinner = ora('Clearing build caches...').start();
  try {
    clearBuildArtifacts(outputDir);
    cleanSpinner.succeed('Build caches cleared');
  } catch (err: any) {
    cleanSpinner.fail(`Failed to clear build caches: ${err.message}`);
    process.exit(1);
  }

  const stageDir = join(outputDir, 'ota-stage');
  const archivePath = join(outputDir, `patch.${platform}.zip`);
  const bundleSpinner = ora('Bundling JavaScript + assets...').start();
  try {
    bundleJS(platform, entryFile, stageDir);
    createOTAArchive(stageDir, archivePath);
    bundleSpinner.succeed('OTA archive built');
  } catch (err: any) {
    bundleSpinner.fail(`Bundling failed: ${err.message}`);
    process.exit(1);
  }

  const sha256 = computeSHA256(archivePath);
  const size = getFileSize(archivePath);
  console.log(chalk.dim(`  SHA256: ${sha256}`));
  console.log(chalk.dim(`  Size:   ${formatBytes(size)}`));

  const baseLabel = selectedRelease.label;
  const patchPattern = new RegExp(`^${escapeRegExp(baseLabel)}-patch\\.(\\d+)$`);
  const maxPatchNumber = releases
    .filter((r: any) =>
      r.target_binary_version === selectedRelease.target_binary_version &&
      r.platform === platform &&
      (r.environment || environment) === environment,
    )
    .reduce((max: number, r: any) => {
      const match = String(r.label).match(patchPattern);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
  const label = `${baseLabel}-patch.${maxPatchNumber + 1}`;

  let isMandatory = opts.mandatory || false;
  if (!opts.mandatory && !opts.publish) {
    const { mandatory } = await inquirer.prompt([
      { type: 'confirm', name: 'mandatory', message: 'Mark as mandatory (forces users to update)?', default: false },
    ]);
    isMandatory = mandatory;
  }

  let rollout = initialRollout;
  if (!opts.publish && opts.rollout === '100') {
    const { rolloutAnswer } = await inquirer.prompt([
      {
        type: 'input',
        name: 'rolloutAnswer',
        message: 'Initial rollout percentage (0-100):',
        default: '100',
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return n >= 0 && n <= 100 ? true : 'Must be between 0 and 100';
        },
      },
    ]);
    rollout = parseRollout(rolloutAnswer);
  }

  let shouldPublish = opts.publish;
  if (!shouldPublish) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Publish patch ${chalk.bold(label)} targeting ${chalk.bold(selectedRelease.target_binary_version)}?`,
        default: true,
      },
    ]);
    shouldPublish = confirm;
  }

  if (!shouldPublish) {
    console.log(chalk.dim('Patch cancelled.'));
    return;
  }

  const uploadSpinner = ora('Uploading patch to Sankofa...').start();
  try {
    const release = await uploadRelease(archivePath, {
      label,
      target_binary_version: selectedRelease.target_binary_version,
      platform,
      description: opts.description || `Patch for ${selectedRelease.label}`,
      is_mandatory: isMandatory,
      rollout_percentage: rollout,
      environment,
    });

    uploadSpinner.succeed('Patch uploaded!');
    console.log('');
    console.log(chalk.green.bold('  🩹 Patch published'));
    console.log(chalk.dim(`     Label:    ${release.label}`));
    console.log(chalk.dim(`     Target:   ${release.target_binary_version}`));
    console.log(chalk.dim(`     Rollout:  ${release.rollout_percentage}%`));
    console.log(chalk.dim(`     Mandatory: ${release.is_mandatory ? 'Yes' : 'No'}`));
    console.log(chalk.dim(`     ID:       ${release.id}`));
    console.log('');
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Flutter (NEW) ─────────────────────────────────────────────────────────────

export async function flutterPatch(
  project: ProjectInfo,
  platformArg: string | undefined,
  opts: any,
) {
  // β.3 — Sankofa CodePush ships a SINGLE cross-platform OTA pipeline: Dart
  // kernel bytecode (KBC) compiled from `lib/sankofa_patch.dart`, wrapped in a
  // signed `.skdp` envelope, applied inside the engine's interpreter on BOTH
  // iOS and Android (no JIT, no native swap). The legacy Android `libapp.so`
  // binary-diff path is retired — the unified SDK marks it deprecated and
  // every shipping app (incl. hello_codepush) applies via
  // `fetchAndApplyKbcPatch` on both platforms.
  // See sankofa-flutter-deploy/docs/codepush-beta3-architecture.md.
  const platform = await resolveFlutterPlatform(platformArg);
  return runFlutterPatch(project, platform, opts);
}

// ── Flutter Code (β.3) — unified KBC patch pipeline (iOS + Android) ──────────

/**
 * Flutter Code patch — the single cross-platform β.3 pipeline:
 *
 *   project source (lib/sankofa_patch.dart)
 *     → γ: dart2bytecode → patch.kbc
 *       → β.4: SANKOFA_KBC_ENVELOPE wrap (+ Ed25519 sign) → patch.skdp
 *         → δ: POST /api/v1/deploy/releases
 *           → η (on-device): fetchAndApplyKbcPatch → Interpreter::Run
 *
 * iOS and Android are byte-identical here. KBC bytecode is platform-
 * independent, so the SAME `.skdp` envelope applies inside the engine's
 * interpreter on both — no JIT, no native binary swap, App-Store + Play-
 * Store compliant. The `platform` argument only scopes which release record
 * / targeting band the patch lands in (the device's handshake passes its own
 * platform). The legacy Android `libapp.so` binary-diff path is retired; the
 * unified SDK (`sankofa_sdk_flutter`) marks it deprecated and hello_codepush
 * applies via `fetchAndApplyKbcPatch` on both platforms.
 * See sankofa-flutter-deploy/docs/codepush-beta3-architecture.md.
 *
 * Server note: the upload endpoint validates + stores the envelope as
 * `patch.skdp` for platform=ios, and stores the uploaded bytes verbatim
 * under a `libapp.so` object key for platform=android (handlers.go:760).
 * The object-key filename is cosmetic — the device downloads the stored
 * bytes and parses them as an envelope regardless. The on-device SDK
 * re-verifies payload SHA-256 + Ed25519 (kbc_loader.dart), so the missing
 * server-side android validation is not a trust gap.
 *
 * Tier-A constraint: patches today can only return values constructable
 * from the patch's own constant pool (strings, ints, doubles, Map/List
 * literals). Calling back into host AOT code (string interpolation, Flutter
 * widgets, String._create) crashes at `Interpreter::InvokeCompiled` because
 * the dyn-module:callable pragmas the dynamic-interface YAML emits aren't
 * yet retained by gen_snapshot during AOT tree-shaking (ε.1 work). Until
 * that lands, encode UI overrides as a JSON string returned by the patch's
 * `@pragma('dyn-module:entry-point')` function and decode it on the host.
 *
 * Convention-over-configuration defaults:
 *   - Patch entry: lib/sankofa_patch.dart (single
 *     @pragma('dyn-module:entry-point') Object? function)
 *   - Dynamic interface: sankofa/dynamic_interface.yaml if present;
 *     otherwise skip --validate (patch is then language-primitives only)
 *   - Output (transient): .sankofa/build/patch.kbc + patch.skdp
 *
 * The patch targets an existing flutter-code BASE release: it inherits the
 * baseline's target_binary_version (so the device's installed app_version
 * matches server-side targeting) and is labelled `<base>-patch.N`. With no
 * server baseline (and an explicit --target-binary-version) it falls back to
 * publishing a standalone base release labelled `kbc-<platform>-<ts>`.
 */
async function runFlutterPatch(
  project: ProjectInfo,
  platform: 'ios' | 'android',
  opts: any,
) {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const inquirer = (await import('inquirer')).default;

  // ── 1. Engine + environment ─────────────────────────────────────────
  let engineInfo;
  try {
    engineInfo = detectFlutterEngineInfo(project.root);
  } catch (err: any) {
    console.error(chalk.red(`  ✖ Could not detect Flutter engine: ${err.message}`));
    console.error(chalk.dim('     Is `flutter` on your PATH? Run `sankofa doctor` to verify.'));
    process.exit(1);
  }
  const engineVersion = opts.engineVersion || engineInfo.sankofaEngineVersion;

  let environment;
  let initialRollout;
  try {
    environment = await resolveEnvironmentPrompt(opts.env);
    initialRollout = parseRollout(opts.rollout);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  // ── 2. Resolve the baseline release this patch targets ──────────────
  // A KBC patch inherits its baseline's target_binary_version + engine and
  // is labelled `<base>-patch.N`. With --dry-run we synthesize the baseline
  // from the on-disk manifest so the build can be exercised offline.
  let releases: any[] = [];
  let selectedRelease: any = null;

  if (opts.dryRun) {
    const localBaseline = readBaselineManifest(project.root);
    if (localBaseline) {
      selectedRelease = {
        label: localBaseline.releaseLabel,
        target_binary_version: localBaseline.targetBinaryVersion,
        engine_version: localBaseline.engineVersion,
      };
      console.log(chalk.dim(`  · Using local baseline ${selectedRelease.label} (--dry-run, no server)`));
    }
  } else {
    const spinner = ora('Fetching Flutter releases...').start();
    let baseReleases: any[] = [];
    try {
      releases = await listReleases(environment, platform);
      baseReleases = releases.filter((r: any) =>
        !isPatchRelease(r) &&
        (r.runtime === 'flutter-code' || r.runtime === 'flutter_code'),
      );
      // Scope to the requested flavor. KBC patches are flavor-independent,
      // so this only picks WHICH base release / targeting band the patch
      // lands in — mirroring `sankofa release --flavor`. Graceful: if no
      // base release records a flavor (older server that drops it), keep
      // them all and surface the heads-up below rather than filtering to
      // zero.
      if (opts.flavor && baseReleases.some((r: any) => r.flavor)) {
        baseReleases = baseReleases.filter((r: any) => r.flavor === opts.flavor);
      }
    } catch (err: any) {
      spinner.fail(`Failed to fetch releases: ${err.message}`);
      process.exit(1);
    }
    if (opts.flavor && !releases.some((r: any) => r.flavor)) {
      console.log(
        `  · --flavor ${opts.flavor} noted; releases don't record a flavor server-side yet, ` +
          `so all ${platform} base releases are eligible (KBC patches are flavor-independent).`,
      );
    }

    if (baseReleases.length === 0 && !opts.targetBinaryVersion) {
      spinner.fail(
        `No Flutter releases found for ${platform}. Run ${chalk.cyan('sankofa release ' + platform)} first ` +
        `(or pass --target-binary-version for a standalone base patch).`,
      );
      process.exit(1);
    }

    if (baseReleases.length > 0) {
      spinner.succeed(`Found ${baseReleases.length} Flutter release(s).`);
      if (opts.release) {
        // Non-interactive baseline selection (CI / headless / scripted).
        selectedRelease = baseReleases.find(
          (r: any) => r.label === opts.release || r.id === opts.release,
        );
        if (!selectedRelease) {
          console.error(chalk.red(`  ✖ No Flutter base release matching --release "${opts.release}".`));
          console.error(chalk.dim(`     Available: ${baseReleases.map((r: any) => r.label).join(', ')}`));
          process.exit(1);
        }
        console.log(chalk.dim(`  Patching against ${selectedRelease.label} (target ${selectedRelease.target_binary_version})`));
      } else if (baseReleases.length === 1) {
        selectedRelease = baseReleases[0];
        console.log(chalk.dim(`  Patching against ${selectedRelease.label} (target ${selectedRelease.target_binary_version})`));
      } else {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedRelease',
            message: 'Select a baseline release to patch:',
            choices: baseReleases.map((r: any) => ({
              name: `${r.label} (engine: ${r.engine_version || '?'}, target: ${r.target_binary_version}, ${r.total_installs ?? 0} installs)`,
              value: r,
            })),
          },
        ]);
        selectedRelease = answer.selectedRelease;
      }
    } else {
      spinner.succeed('No baseline release found — building a standalone base patch.');
    }
  }

  // Target binary version: inherit the baseline's (so device app_version
  // matches); else the explicit flag; else the v0 default.
  const targetBinaryVersion =
    selectedRelease?.target_binary_version || opts.targetBinaryVersion || '1.0.0';

  // Engine cross-check — a patch built against engine X must target a
  // baseline built against engine X, or the device can't load it.
  if (selectedRelease?.engine_version && selectedRelease.engine_version !== engineVersion) {
    console.log('');
    console.log(chalk.red(`  ✖ Engine mismatch.`));
    console.log(chalk.dim(`     Baseline release was built with engine: ${selectedRelease.engine_version}`));
    console.log(chalk.dim(`     Your local engine is:                   ${engineVersion}`));
    console.log(chalk.dim(`     A patch built against a different engine will not load.`));
    console.log(chalk.dim(`     Switch your Flutter / Sankofa engine to match, or run \`sankofa release\` for a new baseline.`));
    process.exit(1);
  }

  // Patch label: `<base>-patch.N` when a baseline is resolved (the server
  // links the patch to its base by this label — handlers.go:706); otherwise
  // a standalone base label.
  let label: string;
  if (selectedRelease) {
    const baseLabel = selectedRelease.label;
    const patchPattern = new RegExp(`^${escapeRegExp(baseLabel)}-patch\\.(\\d+)$`);
    const maxPatchNumber = releases
      .filter((r: any) =>
        r.target_binary_version === selectedRelease.target_binary_version &&
        (r.runtime === 'flutter-code' || r.runtime === 'flutter_code') &&
        (r.environment || environment) === environment,
      )
      .reduce((max: number, r: any) => {
        const match = String(r.label).match(patchPattern);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0);
    label = `${baseLabel}-patch.${maxPatchNumber + 1}`;
  } else {
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    label = opts.label || `patch-${platform}-${timestamp}`;
  }

  // ── 3. Resolve patch entry + optional dynamic interface ─────────────
  const projectRoot = project.root;
  // -t/--target and --entry-file are aliases for the patch entry; -t wins
  // when both are given. Lets you keep multiple patch entries and select one.
  const entryFile = resolve(projectRoot, opts.target || opts.entryFile || 'lib/sankofa_patch.dart');
  if (!existsSync(entryFile)) {
    console.error(chalk.red(`  ✖ Patch entry not found: ${entryFile}`));
    console.error(chalk.dim(
      '     Create it with exactly one entry-point function:\n' +
      '        @pragma(\'dyn-module:entry-point\')\n' +
      '        Object? main() => \'sankofa patch v1\';\n' +
      '     Or pass --entry-file <path>.'
    ));
    process.exit(2);
  }

  // Guard the common Shorebird reflex: passing the APP entry-point (e.g.
  // `-t lib/main_prod.dart`) as the patch target. In Sankofa β.3 the patch
  // is a SEPARATE file exposing @pragma('dyn-module:entry-point') — the app
  // main is not one. Catch it here with a clear message instead of a
  // downstream compile failure on a 10k-line app graph.
  try {
    const entrySrc = readFileSync(entryFile, 'utf8');
    if (!entrySrc.includes('dyn-module:entry-point')) {
      const looksLikeApp = /runApp\s*\(/.test(entrySrc) || /void\s+main\s*\(/.test(entrySrc);
      console.error(chalk.red(`  ✖ ${entryFile} is not a Sankofa patch entry.`));
      console.error(chalk.dim(
        looksLikeApp
          ? "     That looks like your app's entry-point. A Sankofa patch is a SEPARATE\n" +
            "     file (default lib/sankofa_patch.dart) exposing:\n" +
            "        @pragma('dyn-module:entry-point')\n" +
            "        Object? main() => 'sankofa patch v1';\n" +
            `     For a flavored app you don't pass -t — the flavor scopes the base\n` +
            `     release, not the patch entry. Just run:\n` +
            `        sankofa patch ${platform}${opts.flavor ? ` --flavor ${opts.flavor}` : ''}`
          : "     The patch entry must expose exactly one\n" +
            "        @pragma('dyn-module:entry-point') function."
      ));
      process.exit(2);
    }
  } catch {
    /* unreadable file — let the compiler surface the real error */
  }

  let dynamicInterface: string | undefined;
  const conventional = join(projectRoot, 'sankofa', 'dynamic_interface.yaml');
  if (opts.dynamicInterface) {
    dynamicInterface = resolve(projectRoot, opts.dynamicInterface);
  } else if (existsSync(conventional)) {
    dynamicInterface = conventional;
    console.log(chalk.dim(`  · Using conventional dynamic interface ${conventional}`));
  }

  const buildDir = resolve(projectRoot, '.sankofa/build');
  const payloadPath = join(buildDir, 'patch.payload');
  const patchPath = join(buildDir, 'patch.skdp');
  mkdirSync(buildDir, { recursive: true });

  // ── 4. Compile the patch entry-point ────────────────────────────────
  console.log('');
  const buildSpinner = ora(`Building patch from ${entryFile}…`).start();
  let buildResult;
  try {
    buildResult = buildFlutterPatch({
      entryFile,
      outputPath: payloadPath,
      validateYaml: dynamicInterface,
      // Resolve the dart-sdk from the PROJECT root (where sankofa.yaml lives).
      // buildFlutterPatch otherwise derives it from dirname(entryFile)=lib/,
      // which misses sankofa.yaml → falls back to PATH flutter (absent on Windows).
      flutterDartSdk: resolveFlutterDartSdk(projectRoot),
    });
    buildSpinner.succeed(`Patch compiled (${buildResult.sizeBytes} B).`);
  } catch (err: any) {
    buildSpinner.fail(`Patch compile failed: ${err.message}`);
    process.exit(1);
  }

  // ── 5. Package (+ sign if a project key exists) ─────────────────────
  const wrapSpinner = ora('Packaging patch…').start();
  const meta: PatchMetadata = {
    label,
    description: opts.description || `Flutter ${platform} patch from ${entryFile}`,
    engineCommit: opts.engineCommit,
    dartVersion: opts.dartVersion,
    targetBinaryVersion,
    rollout: initialRollout,
    mandatory: !!opts.mandatory,
    createdAt: new Date().toISOString(),
  };
  const projectCfg = findProjectConfig();
  const signingKey = projectCfg?.projectId
    ? loadSigningKey(projectCfg.projectId)
    : null;
  let patchBytes: Buffer;
  try {
    patchBytes = packPatch({
      payload: readFileSync(payloadPath),
      metadata: meta,
      sigAlg: signingKey ? 1 : 0,
      signer: signingKey
        ? (bytes) => signEd25519(signingKey.privateKeyPem, bytes)
        : undefined,
    });
    writeFileSync(patchPath, patchBytes);
    const signedNote = signingKey ? ' (signed)' : ' (unsigned)';
    wrapSpinner.succeed(`Patch packaged${signedNote} (${patchBytes.length} B).`);
  } catch (err: any) {
    wrapSpinner.fail(`Packaging failed: ${err.message}`);
    process.exit(1);
  }

  console.log(chalk.dim(`  Label:          ${label}`));
  console.log(chalk.dim(`  Engine:         ${engineVersion}`));
  console.log(chalk.dim(`  Target binary:  ${targetBinaryVersion}`));
  console.log(chalk.dim(`  Patch:          ${patchPath}`));

  if (opts.dryRun) {
    console.log('');
    console.log(chalk.green.bold('  ✓ Dry-run complete'));
    console.log(chalk.dim(`     Patch file:   ${patchPath}`));
    console.log(chalk.dim('     Re-run without --dry-run when the server is reachable.'));
    return;
  }

  // ── 6. Mandatory + rollout + confirm (skipped with --publish) ───────
  let isMandatory = opts.mandatory || false;
  if (!opts.mandatory && !opts.publish) {
    const { mandatory } = await inquirer.prompt([
      { type: 'confirm', name: 'mandatory', message: 'Mark as mandatory (forces users to apply on next launch)?', default: false },
    ]);
    isMandatory = mandatory;
  }

  let rollout = initialRollout;
  if (!opts.publish && opts.rollout === '100') {
    const { rolloutAnswer } = await inquirer.prompt([
      {
        type: 'input',
        name: 'rolloutAnswer',
        message: 'Initial rollout percentage (0-100):',
        default: '100',
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return n >= 0 && n <= 100 ? true : 'Must be between 0 and 100';
        },
      },
    ]);
    rollout = parseRollout(rolloutAnswer);
  }

  let shouldPublish = opts.publish;
  if (!shouldPublish) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Publish patch ${chalk.bold(label)} targeting ${chalk.bold(targetBinaryVersion)}?`,
        default: true,
      },
    ]);
    shouldPublish = confirm;
  }

  if (!shouldPublish) {
    console.log(chalk.dim('Patch cancelled.'));
    return;
  }

  // ── 7. δ: upload ────────────────────────────────────────────────────
  const uploadSpinner = ora('Uploading patch to Sankofa…').start();
  try {
    const release = await uploadRelease(patchPath, {
      label,
      target_binary_version: targetBinaryVersion,
      platform,
      description: meta.description,
      is_mandatory: isMandatory,
      rollout_percentage: rollout,
      environment,
      runtime: 'flutter-code',
      engine_version: engineVersion,
    });
    uploadSpinner.succeed('Patch uploaded.');
    console.log('');
    console.log(chalk.green.bold(`  🩹 Flutter ${platform} patch published`));
    console.log(chalk.dim(`     ID:              ${release.id}`));
    console.log(chalk.dim(`     Label:           ${release.label}`));
    console.log(chalk.dim(`     Runtime:         ${release.runtime}`));
    console.log(chalk.dim(`     Engine:          ${release.engine_version}`));
    console.log(chalk.dim(`     Target binary:   ${release.target_binary_version}`));
    console.log(chalk.dim(`     Rollout:         ${release.rollout_percentage}%`));
    console.log(chalk.dim(`     Mandatory:       ${release.is_mandatory ? 'Yes' : 'No'}`));
    console.log('');
    console.log(
      chalk.dim(
        'Devices in this rollout fetch + apply the patch on next launch\n' +
        'via the Sankofa updater (SankofaUpdater.preFlight() at startup).',
      ),
    );
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${err.message}`);
    process.exit(1);
  }
}
