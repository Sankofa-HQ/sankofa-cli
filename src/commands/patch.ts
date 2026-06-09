import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
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
import { buildFlutterAOT, detectFlutterEngineInfo, resolveFlutterPlatform } from '../utils/flutterBundler.js';
import { runFlutterDiffGuard } from '../utils/diffGuard.js';
import { hasBaseline, readBaselineManifest } from '../utils/baseline.js';
import { buildKbcPatch } from '../utils/flutterKbcBundler.js';
import { wrapKbc, type KbcEnvelopeMetadata } from '../utils/flutterKbcEnvelope.js';
import { loadSigningKey, signEd25519 } from './keys.js';

function isPatchRelease(release: any): boolean {
  return /-patch\.\d+$/.test(String(release.label || ''));
}

export const patchCommand = new Command('patch')
  .description('Push an OTA patch to an existing release (Dart/JS code only — no native changes)')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted; ignored for Flutter where only android is supported today)')
  .option('--entry-file <file>', 'RN: JS entry file')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--description <desc>', 'Patch description')
  .option('--mandatory', 'Mark this patch as mandatory (force-update)')
  .option('--rollout <percent>', 'Rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--project <path>', 'Project root (defaults to auto-detect)')
  .option('--engine-version <version>', 'Flutter: override the detected engine version (rare)')
  // iOS patch options (Flutter only — RN ignores these).
  .option('--label <label>', 'Flutter iOS: label override (default sankofa-ios-YYYYMMDDhhmmss)')
  .option('--target-binary-version <semver>', 'Flutter iOS: target host app version (default 1.0.0)', '1.0.0')
  .option('--engine-commit <sha>', 'Flutter iOS: Sankofa Flutter engine commit baked into patch metadata')
  .option('--dart-version <semver>', 'Flutter iOS: Dart SDK version baked into patch metadata')
  .option('--dynamic-interface <yaml>', 'Flutter iOS: dynamic_interface.yaml path (default ./sankofa/dynamic_interface.yaml if present)')
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
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const inquirer = (await import('inquirer')).default;

  // Platform — Android takes the libapp.so binary-diff path; iOS goes
  // through the Path C KBC interpreter pipeline (handled in
  // `flutterIosKbcPatch` below).
  const platform = await resolveFlutterPlatform(platformArg);
  if (platform === 'ios') {
    return flutterIosKbcPatch(project, opts);
  }

  let environment;
  let initialRollout;
  try {
    environment = await resolveEnvironmentPrompt(opts.env);
    initialRollout = parseRollout(opts.rollout);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  // Engine info — captured early so we can announce the version we're
  // about to build against. Customers can override via --engine-version
  // in rare situations (e.g. test a hand-built engine).
  let engineInfo;
  try {
    engineInfo = detectFlutterEngineInfo(project.root);
  } catch (err: any) {
    console.error(chalk.red(`  ✖ Could not detect Flutter engine: ${err.message}`));
    console.error(chalk.dim('     Is `flutter` on your PATH? Run `sankofa doctor` to verify.'));
    process.exit(1);
  }
  const engineVersion = opts.engineVersion || engineInfo.sankofaEngineVersion;

  // Fetch existing flutter-code releases. With --dry-run we synthesize a
  // baseline release from the on-disk manifest so we can exercise Diff
  // Guard locally without touching the server.
  let releases: any[];
  let selectedRelease: any;

  if (opts.dryRun) {
    const localBaseline = readBaselineManifest(project.root);
    if (!localBaseline) {
      console.error(chalk.red(`  ✖ --dry-run requires a local baseline at .sankofa/baseline/.`));
      console.error(chalk.dim(`     Run \`sankofa release --dry-run\` first to capture one.`));
      process.exit(1);
    }
    releases = [];
    selectedRelease = {
      label: localBaseline.releaseLabel,
      target_binary_version: localBaseline.targetBinaryVersion,
      engine_version: localBaseline.engineVersion,
    };
    console.log(chalk.dim(`  · Using local baseline ${selectedRelease.label} (--dry-run, no server)`));
  } else {
    const spinner = ora('Fetching Flutter releases...').start();
    let baseReleases: any[];
    try {
      releases = await listReleases(environment, platform);
      baseReleases = releases.filter((r: any) =>
        !isPatchRelease(r) &&
        (r.runtime === 'flutter-code' || r.runtime === 'flutter_code'),
      );
    } catch (err: any) {
      spinner.fail(`Failed to fetch releases: ${err.message}`);
      process.exit(1);
    }

    if (baseReleases.length === 0) {
      spinner.fail(`No Flutter releases found. Run ${chalk.cyan('sankofa release')} first.`);
      process.exit(1);
    }
    spinner.succeed(`Found ${baseReleases.length} Flutter release(s).`);

    if (baseReleases.length === 1) {
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
  }

  // Build the APK and extract the Flutter binary (plus AndroidManifest
  // + flutter_assets for the safety-check comparison).
  console.log('');
  const buildSpinner = ora(`Building Flutter APK (engine ${engineVersion})...`).start();
  let built;
  try {
    built = buildFlutterAOT(project.root, {
      outputDir: opts.outputDir,
      keepApk: false,
      verbose: false,
    });
    buildSpinner.succeed(`Build complete (${formatBytes(statSync(built.libappPath).size)})`);
  } catch (err: any) {
    buildSpinner.fail(`Flutter build failed: ${err.message}`);
    process.exit(1);
  }

  // ── Patch safety check ──
  // Refuse the patch if anything outside the OTA-eligible scope changed
  // since the baseline (AndroidManifest, native assets, new native
  // bindings).
  if (hasBaseline(project.root)) {
    const diffSpinner = ora('Running patch safety check...').start();
    const outcome = runFlutterDiffGuard({
      projectRoot: project.root,
      apkContentsDir: built.apkContentsDir || '',
    });
    if (outcome.refusals.length > 0) {
      diffSpinner.fail(`Safety check refused this patch (${outcome.refusals.length} blocker${outcome.refusals.length === 1 ? '' : 's'}).`);
      console.log('');
      for (const f of outcome.refusals) {
        console.log(chalk.red(`  ✖ ${f.label}`));
        for (const line of f.detail.split('\n')) console.log(chalk.dim(`     ${line}`));
        console.log(chalk.dim(`     → ${f.remedy}`));
        console.log('');
      }
      if (outcome.warnings.length > 0) {
        for (const f of outcome.warnings) {
          console.log(chalk.yellow(`  ! ${f.label}: ${f.detail}`));
          console.log(chalk.dim(`     → ${f.remedy}`));
        }
        console.log('');
      }
      console.log(chalk.dim('  Patches can only change Dart code — not native config, manifests, or assets.'));
      process.exit(1);
    }
    if (outcome.warnings.length > 0) {
      diffSpinner.succeed(`Safety check passed with ${outcome.warnings.length} warning(s)`);
      for (const f of outcome.warnings) {
        console.log(chalk.yellow(`  ! ${f.label}: ${f.detail.split('\n')[0]}`));
        console.log(chalk.dim(`     → ${f.remedy}`));
      }
    } else {
      diffSpinner.succeed('Safety check passed — Dart-only change');
    }
  } else {
    // No baseline yet. This is the case where the dev never ran
    // `sankofa release` for this project, OR they're patching against
    // a baseline they've since deleted. We can't enforce; warn loudly
    // and proceed.
    console.log(chalk.yellow(`  ! No baseline at .sankofa/baseline/ — skipping safety check.`));
    console.log(chalk.dim(`     Run \`sankofa release\` to capture a baseline so future patches are guarded.`));
  }

  // Cross-check: the engine version we'll send to the server must match the
  // dev's currently-installed Flutter, OR the customer is using --engine-version
  // override. Refuse if the override conflicts with the baseline release's
  // engine version (means the patch won't load anyway).
  if (selectedRelease.engine_version && selectedRelease.engine_version !== engineVersion) {
    console.log('');
    console.log(chalk.red(`  ✖ Engine mismatch.`));
    console.log(chalk.dim(`     Baseline release was built with engine: ${selectedRelease.engine_version}`));
    console.log(chalk.dim(`     Your local engine is:                   ${engineVersion}`));
    console.log(chalk.dim(`     A patch built against a different engine will not load.`));
    console.log(chalk.dim(`     Switch your Flutter / Sankofa engine to match the baseline, or run \`sankofa release\` to create a new baseline.`));
    process.exit(1);
  }

  const sha256 = computeSHA256(built.libappPath);
  const size = getFileSize(built.libappPath);
  console.log(chalk.dim(`  SHA256:         ${sha256}`));
  console.log(chalk.dim(`  Size:           ${formatBytes(size)}`));
  console.log(chalk.dim(`  Engine:         ${engineVersion}`));
  console.log(chalk.dim(`  Target binary:  ${selectedRelease.target_binary_version}`));

  if (opts.dryRun) {
    console.log('');
    console.log(chalk.green.bold('  ✓ Dry-run complete'));
    console.log(chalk.dim('     Safety check passed; patch would be safe to publish.'));
    console.log(chalk.dim('     Re-run without --dry-run when the server is reachable.'));
    console.log('');
    return;
  }

  // Compute next patch label.
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
  const label = `${baseLabel}-patch.${maxPatchNumber + 1}`;

  // Mandatory + rollout + confirm.
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
    const release = await uploadRelease(built.libappPath, {
      label,
      target_binary_version: selectedRelease.target_binary_version,
      platform,
      description: opts.description || `Flutter patch for ${selectedRelease.label}`,
      is_mandatory: isMandatory,
      rollout_percentage: rollout,
      environment,
      runtime: 'flutter-code',
      engine_version: engineVersion,
    });

    uploadSpinner.succeed('Patch uploaded.');
    console.log('');
    console.log(chalk.green.bold('  🩹 Flutter patch published'));
    console.log(chalk.dim(`     Label:           ${release.label}`));
    console.log(chalk.dim(`     Runtime:         ${release.runtime}`));
    console.log(chalk.dim(`     Engine:          ${release.engine_version}`));
    console.log(chalk.dim(`     Target binary:   ${release.target_binary_version}`));
    console.log(chalk.dim(`     Rollout:         ${release.rollout_percentage}%`));
    console.log(chalk.dim(`     Mandatory:       ${release.is_mandatory ? 'Yes' : 'No'}`));
    console.log(chalk.dim(`     ID:              ${release.id}`));
    console.log('');
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${err.message}`);
    process.exit(1);
  }
}

// ── iOS Path C (KBC interpreter) — sub-phase γ → β.4 → δ end-to-end ─────────

/**
 * iOS Flutter Code patch — the Path C pipeline:
 *
 *   project source (lib/sankofa_patch.dart)
 *     → γ: dart2bytecode → patch.kbc
 *       → β.4: SANKOFA_KBC_ENVELOPE wrap → patch.skdp
 *         → δ: POST /api/v1/deploy/releases (server validates envelope)
 *           → η (on-device): SDK.applyKbcPatchFromBytes/File → Interpreter::Run
 *
 * Tier-A constraint: patches today can only return values constructable
 * from the patch's own constant pool (strings, ints, doubles). Calling
 * back into host AOT code (string interpolation, Flutter widgets,
 * String._create) crashes at `Interpreter::InvokeCompiled` because the
 * dyn-module:callable pragmas the dynamic-interface YAML emits aren't
 * yet retained by gen_snapshot during AOT tree-shaking (ε.1 work). Until
 * that lands, encode UI overrides as a JSON string returned by the
 * patch's `@pragma('dyn-module:entry-point')` function and decode it on
 * the host. See sankofa-flutter-deploy/docs/build-log-interpreter-program.md
 * ε spike entry for the rationale.
 *
 * Convention-over-configuration defaults:
 *   - Patch entry: lib/sankofa_patch.dart (single
 *     @pragma('dyn-module:entry-point') Object? function)
 *   - Dynamic interface: sankofa/dynamic_interface.yaml if present;
 *     otherwise skip --validate (patch is then language-primitives only)
 *   - Output (transient): .sankofa/build/patch.kbc + patch.skdp
 *
 * v0 produces and uploads a BASE release (no -patch.N suffix) per the
 * server's existing semantics. A future enhancement can resolve the
 * baseline release for the host's engine and label as -patch.N.
 */
async function flutterIosKbcPatch(project: ProjectInfo, opts: any) {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;

  // ── 1. Engine + environment + label ─────────────────────────────────
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

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const label = opts.label || `kbc-ios-${timestamp}`;
  const targetBinaryVersion = opts.targetBinaryVersion || '1.0.0';

  // ── 2. Resolve project conventions ──────────────────────────────────
  const projectRoot = project.root;
  const entryFile = resolve(projectRoot, opts.entryFile || 'lib/sankofa_patch.dart');
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

  let dynamicInterface: string | undefined;
  const conventional = join(projectRoot, 'sankofa', 'dynamic_interface.yaml');
  if (opts.dynamicInterface) {
    dynamicInterface = resolve(projectRoot, opts.dynamicInterface);
  } else if (existsSync(conventional)) {
    dynamicInterface = conventional;
    console.log(chalk.dim(`  · Using conventional dynamic interface ${conventional}`));
  }

  const buildDir = resolve(projectRoot, opts.outputDir || '.sankofa/build');
  const kbcPath = join(buildDir, 'patch.kbc');
  const envelopePath = join(buildDir, 'patch.skdp');
  mkdirSync(buildDir, { recursive: true });

  // ── 3. γ: compile Dart → KBC ────────────────────────────────────────
  console.log('');
  const buildSpinner = ora(`Building KBC patch from ${entryFile}…`).start();
  let buildResult;
  try {
    buildResult = buildKbcPatch({
      entryFile,
      outputPath: kbcPath,
      validateYaml: dynamicInterface,
    });
    buildSpinner.succeed(`Patch compiled (${buildResult.sizeBytes} B).`);
  } catch (err: any) {
    buildSpinner.fail(`Patch compile failed: ${err.message}`);
    process.exit(1);
  }

  // Wrap the compiled patch into a signed envelope.
  const wrapSpinner = ora('Packaging patch…').start();
  const meta: KbcEnvelopeMetadata = {
    label,
    description: opts.description || `Flutter iOS patch from ${entryFile}`,
    engineCommit: opts.engineCommit,
    dartVersion: opts.dartVersion,
    targetBinaryVersion,
    rollout: initialRollout,
    mandatory: !!opts.mandatory,
    createdAt: new Date().toISOString(),
  };
  // v2 envelope MVP: if a project signing key exists, sign the envelope
  // with Ed25519 so the SDK can refuse tampered patches. Absent key
  // means unsigned envelope (sig_alg=0) — backwards-compatible with
  // SDKs that don't enforce signing.
  const projectCfg = findProjectConfig();
  const signingKey = projectCfg?.projectId
    ? loadSigningKey(projectCfg.projectId)
    : null;
  let envelopeBytes: Buffer;
  try {
    envelopeBytes = wrapKbc({
      kbcPayload: readFileSync(kbcPath),
      metadata: meta,
      sigAlg: signingKey ? 1 : 0,
      signer: signingKey
        ? (bytes) => signEd25519(signingKey.privateKeyPem, bytes)
        : undefined,
    });
    writeFileSync(envelopePath, envelopeBytes);
    const signedNote = signingKey ? ' (signed)' : ' (unsigned)';
    wrapSpinner.succeed(
      `Patch packaged${signedNote} (${envelopeBytes.length} B).`,
    );
  } catch (err: any) {
    wrapSpinner.fail(`Packaging failed: ${err.message}`);
    process.exit(1);
  }

  // Upload to server.
  if (opts.dryRun) {
    console.log('');
    console.log(chalk.yellow.bold('  --dry-run set — skipping upload.'));
    console.log(chalk.dim(`     Patch file:      ${envelopePath}`));
    console.log(chalk.dim(`     Label:           ${label}`));
    console.log(chalk.dim(`     Engine:          ${engineVersion}`));
    console.log(chalk.dim(`     Rollout:         ${initialRollout}%`));
    return;
  }

  const uploadSpinner = ora(`Uploading patch to server…`).start();
  try {
    const release = await uploadRelease(envelopePath, {
      label,
      target_binary_version: targetBinaryVersion,
      platform: 'ios',
      description: meta.description,
      is_mandatory: !!opts.mandatory,
      rollout_percentage: initialRollout,
      environment,
      runtime: 'flutter-code',
      engine_version: engineVersion,
    });
    uploadSpinner.succeed('Patch uploaded.');
    console.log('');
    console.log(chalk.green.bold('  🚀 iOS patch published'));
    console.log(chalk.dim(`     ID:              ${release.id}`));
    console.log(chalk.dim(`     Label:           ${release.label}`));
    console.log(chalk.dim(`     Object key:      ${release.bundle_object_key}`));
    console.log(chalk.dim(`     Engine:          ${release.engine_version}`));
    console.log(chalk.dim(`     Target binary:   ${release.target_binary_version}`));
    console.log(chalk.dim(`     Rollout:         ${release.rollout_percentage}%`));
    console.log(chalk.dim(`     Mandatory:       ${release.is_mandatory ? 'Yes' : 'No'}`));
    console.log('');
    console.log(
      chalk.dim(
        'Devices in this rollout will fetch the patch on their next launch via\n' +
        '`SankofaUpdater.checkForUpdate()` and apply it transparently.',
      ),
    );
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${err.message}`);
    process.exit(1);
  }
}
