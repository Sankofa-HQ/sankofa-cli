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
import { getRelease, listReleases } from '../utils/api.js';
import { requireAuth } from '../utils/config.js';
import { resolveEnvironmentPrompt, resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveRNProjectRoot } from '../utils/project.js';
import { requireSupportedStack } from '../utils/stack.js';
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
  .option('--device <device>', 'iOS simulator UDID/name or Android device serial. Defaults to booted/default device')
  .option('--output-dir <dir>', 'Directory for downloaded release artifacts', './build')
  .option('--skip-install', 'Only download and verify the selected release bundle')
  .option('--no-logs', 'Do not stream runtime logs after launch (returns immediately)')
  .option('--project <path>', 'Path to the React Native app directory (defaults to auto-detect)')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const inquirer = (await import('inquirer')).default;

    await requireAuth();

    // Stack guard FIRST — before any prompts. preview is RN-only today.
    await requireSupportedStack({
      commandName: 'preview',
      supportedStacks: ['react-native'],
      explicit: opts.project,
      unsupportedHint: {
        flutter:
          'For Flutter: after `sankofa patch`, install the patched libapp.so on a device with ' +
          '`flutter install` or rerun `flutter run --release`. Native preview from a published patch is Phase 11.',
        web: 'For Web: preview is your existing dev server (vite/next/etc.). Sankofa does not stage a preview build for web today.',
        'native-ios': 'For native iOS: open the project in Xcode and run on Simulator.',
        'native-android': 'For native Android: open the project in Android Studio and run on an emulator.',
      },
    });

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
