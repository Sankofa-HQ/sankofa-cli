import { Command } from 'commander';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

function shellQuoteLocal(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
import {
  detectAppVersion,
  detectAppId,
  formatBytes,
  getFileSize,
  installAndLaunchNativePreviewArtifact,
  syncNativeFromAppJson,
  type Platform,
} from '../utils/bundler.js';
import { detectFlutterAppId, resolveFlutterPlatform } from '../utils/flutterBundler.js';
import { getRelease, listReleases } from '../utils/api.js';
import { requireAuth } from '../utils/config.js';
import { resolveEnvironmentPrompt, resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveRNProjectRoot } from '../utils/project.js';
import { resolveProjectRoot, type ProjectInfo } from '../utils/stack.js';
import { normalizePlatform } from '../utils/validation.js';

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'release';
}

function isPatchRelease(release: any): boolean {
  return /-patch\.\d+$/.test(String(release.label || ''));
}

function releaseCreatedAtMs(release: any): number {
  const time = Date.parse(String(release.created_at || ''));
  return Number.isFinite(time) ? time : 0;
}

export const previewCommand = new Command('preview')
  .description('Download, install, and launch a published Sankofa Deploy preview release')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--version <version>', 'Target native app version. Prompts from deployed releases when omitted')
  .option('--label <label>', 'Deploy release label to preview')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--app-id <id>', 'Native app bundle identifier/package name')
  .option('-d, --device <device>', 'Device to launch on: iOS simulator/device UDID or Android serial. Defaults to booted/default device')
  .option('--output-dir <dir>', 'Directory for downloaded release artifacts', './build')
  .option('--skip-install', 'Only download and verify the selected release bundle')
  .option('--no-logs', 'Do not stream runtime logs after launch (returns immediately)')
  .option('--project <path>', 'Path to the app directory (defaults to auto-detect)')
  // ── Flutter preview (runs the app via the bundled Sankofa flutter fork) ──
  .option('--flavor <name>', 'Flutter: product flavor to run (e.g. staging, production)')
  .option('-t, --target <file>', 'Flutter: app entry-point file (e.g. lib/main_staging.dart)')
  .option('--release', 'Flutter: run in release mode (default)')
  .option('--profile', 'Flutter: run in profile mode')
  .option('--debug', 'Flutter: run in debug mode')
  .option('--from-server', 'Flutter: download a PUBLISHED release from the server and install it (Android device / iOS simulator) instead of running local source. Implied when --label/--version is given.')
  .option(
    '--dart-define <KEY=VALUE>',
    'Flutter: extra dart-define passed to flutter run (repeatable)',
    (val: string, acc: string[]) => { acc.push(val); return acc; },
    [] as string[],
  )
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const inquirer = (await import('inquirer')).default;

    await requireAuth();

    // Detect the stack and dispatch. Flutter previews run the app on a
    // device via the bundled Sankofa flutter fork (so the engine matches
    // what OTA patches load through); RN previews keep the published-
    // artifact download + install flow below.
    let stackProject: ProjectInfo;
    try {
      stackProject = await resolveProjectRoot({
        explicit: opts.project,
        allowedStacks: ['react-native', 'flutter'],
      });
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    if (stackProject.root !== process.cwd()) {
      console.log(chalk.dim(`  → Working in ${stackProject.root}`));
      process.chdir(stackProject.root);
    }
    if (stackProject.stack === 'flutter') {
      return flutterPreview(stackProject, platformArg, opts);
    }

    let platform: Platform;
    let environment;
    try {
      platform = (await resolvePlatformPrompt(platformArg)) as Platform;
      environment = await resolveEnvironmentPrompt(opts.env);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    try {
      const project = await resolveRNProjectRoot(opts.project);
      process.chdir(project.root);
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

    const listSpinner = ora(`Fetching ${environment} releases for ${platform}...`).start();
    let releases: any[];
    try {
      releases = await listReleases(environment, platform);
      releases = releases.filter((release: any) =>
        release.platform === platform &&
        !release.is_disabled
      );
      if (opts.label) {
        releases = releases.filter((release: any) => release.label === opts.label);
      }
      listSpinner.succeed(`Found ${releases.length} active release(s)`);
    } catch (err: any) {
      listSpinner.fail(`Failed to fetch releases: ${err.message}`);
      process.exit(1);
    }

    if (releases.length === 0) {
      console.log(chalk.yellow(`No active ${environment} ${platform} releases found.`));
      console.log(chalk.dim(`  Publish one with ${chalk.cyan(`sankofa release ${platform} --env ${environment}`)} first.`));
      process.exit(1);
    }

    let appVersion = opts.version;
    if (!appVersion) {
      const localVersion = detectAppVersion(platform);
      const versionCounts = new Map<string, number>();
      for (const release of releases) {
        const version = String(release.target_binary_version || '');
        if (!version) continue;
        versionCounts.set(version, (versionCounts.get(version) || 0) + 1);
      }
      const versionChoices = Array.from(versionCounts.entries())
        .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
        .map(([version, count]) => ({
          name: `${version}${localVersion === version ? ' (local app version)' : ''} - ${count} release${count === 1 ? '' : 's'}`,
          value: version,
        }));

      if (versionChoices.length === 0) {
        console.log(chalk.yellow(`No active ${environment} ${platform} releases include a target app version.`));
        process.exit(1);
      }

      const { versionChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'versionChoice',
          message: 'Select app version to preview:',
          default: localVersion && versionCounts.has(localVersion) ? localVersion : versionChoices[0].value,
          choices: versionChoices,
        },
      ]);
      appVersion = versionChoice;
    }

    releases = releases.filter((release: any) => release.target_binary_version === appVersion);
    releases.sort((a: any, b: any) => releaseCreatedAtMs(b) - releaseCreatedAtMs(a));
    if (releases.length === 0) {
      console.log(chalk.yellow(`No active ${environment} ${platform} releases target app version ${appVersion}.`));
      process.exit(1);
    }

    const appId = opts.appId || detectAppId(platform);
    if (!appId && !opts.skipInstall) {
      console.error(chalk.red(`Could not detect ${platform} app ID. Pass --app-id <bundle identifier/package>.`));
      process.exit(1);
    }

    let selectedRelease = releases[0];
    if (releases.length > 1) {
      const { releaseChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'releaseChoice',
          message: 'Select release or patch to preview:',
          choices: releases.map((release: any) => ({
            name: `${isPatchRelease(release) ? 'Patch' : 'Release'} ${release.label} (${release.rollout_percentage}% rollout, ${formatBytes(release.bundle_size_bytes || 0)}, ${release.id})`,
            value: release,
          })),
        },
      ]);
      selectedRelease = releaseChoice;
    }

    const detailSpinner = ora(`Preparing ${selectedRelease.label}...`).start();
    let detail: any;
    try {
      detail = await getRelease(selectedRelease.id);
      if (!detail.download_url) {
        throw new Error('release download URL is unavailable. Restart the Sankofa API server so /api/v1/deploy/releases/:id returns download_url, then try again.');
      }
      if (!opts.skipInstall && !detail.native_download_url) {
        throw new Error('this release has no native preview artifact. Patches inherit the base release native artifact, so republish the base release with the current CLI.');
      }
      detailSpinner.succeed('Release metadata loaded');
    } catch (err: any) {
      detailSpinner.fail(`Failed to prepare release: ${err.message}`);
      process.exit(1);
    }

    const outputDir = opts.outputDir;
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const archivePath = join(outputDir, `${safeFilePart(selectedRelease.label)}.${platform}.zip`);
    const extractedStageDir = join(outputDir, `${safeFilePart(selectedRelease.label)}.${platform}.ota`);
    const activeBundlePath = join(extractedStageDir, 'bundle.jsbundle');
    const downloadSpinner = ora('Downloading OTA archive...').start();
    try {
      const response = await fetch(detail.download_url);
      if (!response.ok) {
        throw new Error(`download failed (${response.status})`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(archivePath, bytes);

      const actualSHA = createHash('sha256').update(bytes).digest('hex');
      if (selectedRelease.bundle_sha256 && actualSHA !== selectedRelease.bundle_sha256) {
        throw new Error(`SHA256 mismatch: expected=${selectedRelease.bundle_sha256} actual=${actualSHA}`);
      }

      // Extract bundle + assets so we can seed them into the simulator's
      // data container later. Patch preview seeds the whole directory so
      // RN's asset resolver finds `assets/...` next to bundle.jsbundle.
      if (existsSync(extractedStageDir)) {
        rmSync(extractedStageDir, { recursive: true, force: true });
      }
      mkdirSync(extractedStageDir, { recursive: true });
      // Extract the OTA zip. Windows' bundled tar (bsdtar) reads zips and takes
      // `-C <dir>`; GNU tar on Linux can't read zips, so keep `unzip` off-win32.
      const extractCmd = process.platform === 'win32'
        ? `tar -xf ${shellQuoteLocal(archivePath)} -C ${shellQuoteLocal(extractedStageDir)}`
        : `unzip -o -q ${shellQuoteLocal(archivePath)} -d ${shellQuoteLocal(extractedStageDir)}`;
      execSync(extractCmd, { stdio: 'inherit' });
      if (!existsSync(activeBundlePath)) {
        throw new Error(`archive did not contain bundle.jsbundle`);
      }
      downloadSpinner.succeed(`Downloaded and verified ${formatBytes(getFileSize(archivePath))}`);
    } catch (err: any) {
      downloadSpinner.fail(`Failed to download OTA archive: ${err.message}`);
      process.exit(1);
    }

    let nativeArtifactPath = '';
    let nativeArtifactKind = detail.native_artifact_kind || detail.release?.native_artifact_kind || '';
    if (!opts.skipInstall) {
      const extension = nativeArtifactKind === 'ios-simulator-app-zip' ? 'app.zip' : 'apk';
      nativeArtifactPath = join(outputDir, `${safeFilePart(selectedRelease.label)}.${platform}.${extension}`);
      const nativeSpinner = ora('Downloading native preview artifact from Sankofa Deploy...').start();
      try {
        const response = await fetch(detail.native_download_url);
        if (!response.ok) {
          throw new Error(`download failed (${response.status})`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        writeFileSync(nativeArtifactPath, bytes);

        const expectedSHA = detail.native_artifact_sha256 || detail.release?.native_artifact_sha256;
        if (expectedSHA) {
          const actualSHA = createHash('sha256').update(readFileSync(nativeArtifactPath)).digest('hex');
          if (actualSHA !== expectedSHA) {
            throw new Error(`native artifact SHA256 mismatch: expected=${expectedSHA} actual=${actualSHA}`);
          }
        }
        nativeSpinner.succeed(`Downloaded native preview artifact ${formatBytes(getFileSize(nativeArtifactPath))}`);
      } catch (err: any) {
        nativeSpinner.fail(`Failed to download native preview artifact: ${err.message}`);
        process.exit(1);
      }
    }

    console.log('');
    console.log(chalk.bold('  Preview Release'));
    console.log(chalk.dim('  ' + '─'.repeat(50)));
    console.log(`  Label:       ${chalk.bold(selectedRelease.label)}`);
    console.log(`  Platform:    ${chalk.bold(platform)}`);
    console.log(`  App version: ${chalk.bold(appVersion)}`);
    console.log(`  Environment: ${chalk.bold(environment)}`);
    console.log(`  Bundle:      ${isPatchRelease(selectedRelease) ? chalk.dim(activeBundlePath) : chalk.dim('embedded native bundle, then normal update check')}`);
    if (nativeArtifactPath) {
      console.log(`  Native app:  ${chalk.dim(nativeArtifactPath)}`);
    }
    console.log('');

    if (opts.skipInstall) {
      console.log(chalk.dim('  Skipped native install.'));
      return;
    }

    const installSpinner = ora('Installing downloaded native preview artifact...').start();
    installSpinner.stop();
    try {
      installAndLaunchNativePreviewArtifact(platform, {
        appId,
        artifactPath: nativeArtifactPath,
        artifactKind: nativeArtifactKind,
        previewStageDir: isPatchRelease(selectedRelease) ? extractedStageDir : undefined,
        previewLabel: selectedRelease.label,
        clearDeployState: false,
        device: opts.device,
        // Commander sets opts.logs=false when --no-logs is passed; default to
        // true so `sankofa preview ios` streams logs by default.
        streamLogs: opts.logs !== false,
      });
      if (isPatchRelease(selectedRelease)) {
        console.log(chalk.green(`\n  Native preview app launched with ${selectedRelease.label} preloaded.\n`));
      } else {
        console.log(chalk.green(`\n  Native preview app launched as a fresh install for ${selectedRelease.label}. Available patches for this version can now download through the normal SDK update path.\n`));
      }
    } catch (err: any) {
      console.error(chalk.red(`\n  Native preview failed: ${err.message}`));
      console.log(chalk.dim('  Preview does not rebuild local source. Republish the release if the deployed native artifact is missing or invalid.'));
      process.exit(1);
    }
  });

// ── Flutter preview ───────────────────────────────────────────────────────────

/**
 * Flutter `preview` = run the app on a device through the BUNDLED Sankofa
 * flutter fork. Using the fork (not the customer's upstream flutter) is the
 * whole point: it bundles the Sankofa engine, so the running app can load OTA
 * patches exactly as a released build does. This is a thin, honest wrapper
 * over `flutter run` that threads `--flavor`, `--target`/`-t`, `--device`/`-d`,
 * the build mode, and `--dart-define` straight through — so a flavored app
 * (`main_staging.dart` + `staging` flavor) previews with one command.
 */
async function flutterPreview(project: ProjectInfo, platformArg: string | undefined, opts: any) {
  // Server mode: pull a PUBLISHED release's installable artifact and run it
  // (Android device / iOS simulator), like RN/Shorebird preview. Triggered by
  // --from-server, or implicitly when a specific release is named.
  if (opts.fromServer || opts.label || opts.version) {
    return flutterPreviewFromServer(project, platformArg, opts);
  }

  const chalk = (await import('chalk')).default;
  const { resolveFlutterBinary } = await import('../utils/flutterBundler.js');

  // Default to release: that's the mode OTA patches are exercised in (debug
  // uses the JIT path and won't represent the on-device patch loop).
  const mode = opts.debug ? 'debug' : opts.profile ? 'profile' : 'release';

  const flutterBin = resolveFlutterBinary(project.root);
  const quotedBin = /\s/.test(flutterBin) ? `"${flutterBin}"` : flutterBin;

  const args: string[] = ['run', `--${mode}`];
  if (opts.flavor) args.push('--flavor', opts.flavor);
  if (opts.target) args.push('--target', opts.target);
  if (opts.device) args.push('-d', opts.device);
  for (const d of (opts.dartDefine || [])) args.push(`--dart-define=${d}`);

  // Quote any arg containing whitespace (the target path may); flavor/device
  // are simple tokens. flutterBin is already quoted above.
  const cmdline = `${quotedBin} ${args
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(' ')}`;

  console.log('');
  console.log(chalk.bold('  Sankofa preview — flutter run (Sankofa engine fork)'));
  console.log(chalk.dim(`  ${'─'.repeat(52)}`));
  console.log(`  Mode:    ${chalk.bold(mode)}`);
  if (opts.flavor) console.log(`  Flavor:  ${chalk.bold(opts.flavor)}`);
  if (opts.target) console.log(`  Target:  ${chalk.bold(opts.target)}`);
  console.log(`  Device:  ${chalk.bold(opts.device || 'auto (flutter default)')}`);
  console.log('');
  console.log(chalk.dim(`  $ ${cmdline}`));
  console.log('');

  try {
    execSync(cmdline, { cwd: project.root, stdio: 'inherit' });
  } catch (err: any) {
    // `flutter run` exits non-zero when you press `q` to quit as well as on a
    // build error — both are surfaced verbatim, no synthetic stack trace.
    const code = typeof err.status === 'number' ? err.status : 1;
    if (code !== 0) {
      console.error(chalk.red(`\n  flutter run exited with code ${code}.`));
    }
    process.exit(code);
  }
}

/**
 * Flutter `preview --from-server` — download a PUBLISHED release's installable
 * preview artifact and run it, the RN/Shorebird way. Phase 1 scope:
 *   - Android: install the uploaded APK on a real device (or emulator) via adb.
 *   - iOS:     install the uploaded SIMULATOR app on a booted simulator.
 * (Real-device iOS needs a server-side device-artifact kind — separate phase.)
 *
 * The release must have been published with `sankofa release --preview-artifact`
 * so the server actually holds the installable binary. There's no JS-bundle
 * seeding (that's RN-only) — a Flutter base release is self-contained and pulls
 * KBC patches through the engine on launch.
 */
async function flutterPreviewFromServer(
  project: ProjectInfo,
  platformArg: string | undefined,
  opts: any,
) {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const inquirer = (await import('inquirer')).default;

  let platform: 'ios' | 'android';
  let environment: string;
  try {
    platform = await resolveFlutterPlatform(platformArg);
    environment = await resolveEnvironmentPrompt(opts.env);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  // 1. Fetch active releases for this platform.
  const listSpinner = ora(`Fetching ${environment} ${platform} releases…`).start();
  let releases: any[];
  try {
    releases = (await listReleases(environment, platform)).filter(
      (r: any) => r.platform === platform && !r.is_disabled,
    );
    if (opts.label) releases = releases.filter((r: any) => r.label === opts.label);
    listSpinner.succeed(`Found ${releases.length} active release(s)`);
  } catch (err: any) {
    listSpinner.fail(`Failed to fetch releases: ${err.message}`);
    process.exit(1);
  }
  if (releases.length === 0) {
    console.log(chalk.yellow(`No active ${environment} ${platform} releases${opts.label ? ` matching "${opts.label}"` : ''}.`));
    console.log(chalk.dim(`  Publish one with ${chalk.cyan(`sankofa release ${platform} --preview-artifact`)} first.`));
    process.exit(1);
  }

  // 2. Pick a version (unless --label/--version pinned it).
  let appVersion = opts.version;
  if (!appVersion && !opts.label) {
    const versions = Array.from(
      new Set(releases.map((r: any) => String(r.target_binary_version || '')).filter(Boolean)),
    ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length === 1) {
      appVersion = versions[0];
    } else {
      const { picked } = await inquirer.prompt([
        { type: 'list', name: 'picked', message: 'Select app version to preview:', choices: versions },
      ]);
      appVersion = picked;
    }
  }
  if (appVersion) releases = releases.filter((r: any) => r.target_binary_version === appVersion);
  releases.sort((a: any, b: any) => releaseCreatedAtMs(b) - releaseCreatedAtMs(a));

  // 3. Pick the release.
  let selectedRelease = releases[0];
  if (releases.length > 1) {
    const { picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'picked',
        message: 'Select release to preview:',
        choices: releases.map((r: any) => ({
          name: `${r.label} (${r.rollout_percentage}% rollout, ${r.id})`,
          value: r,
        })),
      },
    ]);
    selectedRelease = picked;
  }

  // 4. Resolve the native preview artifact URL.
  const detailSpinner = ora(`Preparing ${selectedRelease.label}…`).start();
  let detail: any;
  try {
    detail = await getRelease(selectedRelease.id);
    detailSpinner.succeed('Release metadata loaded');
  } catch (err: any) {
    detailSpinner.fail(`Failed to load release: ${err.message}`);
    process.exit(1);
  }
  const nativeUrl = detail.native_download_url || detail.release?.native_download_url;
  const artifactKind = detail.native_artifact_kind || detail.release?.native_artifact_kind || '';
  if (!nativeUrl) {
    console.log(chalk.red(`  ✖ Release ${selectedRelease.label} has no installable preview artifact.`));
    console.log(chalk.dim(`     Re-publish it with ${chalk.cyan(`sankofa release ${platform} --preview-artifact`)} so the server stores one.`));
    process.exit(1);
  }
  const expectedKind = platform === 'ios' ? 'ios-simulator-app-zip' : 'android-apk';
  if (artifactKind && artifactKind !== expectedKind) {
    console.log(chalk.red(`  ✖ Preview artifact kind ${artifactKind} doesn't match ${platform}.`));
    process.exit(1);
  }

  // 5. Download + verify.
  const outputDir = opts.outputDir || './build';
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const ext = platform === 'ios' ? 'app.zip' : 'apk';
  const artifactPath = join(outputDir, `${safeFilePart(selectedRelease.label)}.${platform}.${ext}`);
  const dlSpinner = ora('Downloading preview artifact…').start();
  try {
    const res = await fetch(nativeUrl);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(artifactPath, bytes);
    const expectedSHA = detail.native_artifact_sha256 || detail.release?.native_artifact_sha256;
    if (expectedSHA) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expectedSHA) throw new Error(`SHA256 mismatch: expected=${expectedSHA} actual=${actual}`);
    }
    dlSpinner.succeed(`Downloaded + verified ${formatBytes(getFileSize(artifactPath))}`);
  } catch (err: any) {
    dlSpinner.fail(`Download failed: ${err.message}`);
    process.exit(1);
  }

  // 6. Resolve the native app id (for launch) and install.
  const appId = opts.appId || detectFlutterAppId(project.root, platform);
  if (!appId) {
    console.error(chalk.red(`  ✖ Could not detect the ${platform} bundle id/package. Pass --app-id <id>.`));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold('  Preview from server'));
  console.log(`  Label:    ${chalk.bold(selectedRelease.label)}`);
  console.log(`  Platform: ${chalk.bold(platform)}${platform === 'ios' ? ' (simulator)' : ' (device/emulator)'}`);
  console.log(`  App id:   ${chalk.bold(appId)}`);
  console.log(`  Device:   ${chalk.bold(opts.device || (platform === 'ios' ? 'booted simulator' : 'default adb device'))}`);
  console.log('');

  try {
    installAndLaunchNativePreviewArtifact(platform as Platform, {
      appId,
      artifactPath,
      artifactKind: artifactKind || expectedKind,
      previewStageDir: undefined, // Flutter base release is self-contained — no JS seeding.
      previewLabel: selectedRelease.label,
      clearDeployState: false,
      device: opts.device,
      streamLogs: opts.logs !== false,
    });
    console.log(chalk.green(`\n  Launched ${selectedRelease.label} from the server. It will pull any KBC patches on the normal update check.\n`));
  } catch (err: any) {
    console.error(chalk.red(`\n  Preview install failed: ${err.message}`));
    if (platform === 'ios') {
      console.log(chalk.dim('  iOS preview-from-server runs on a SIMULATOR. Boot one (`xcrun simctl boot <udid>` or open Simulator.app) and retry.'));
    }
    process.exit(1);
  }
}
