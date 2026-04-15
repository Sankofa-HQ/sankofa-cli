import { Command } from 'commander';
import { join } from 'path';
import {
  buildDistributionArtifact,
  computeSHA256,
  detectAppVersion,
  formatBytes,
  getFileSize,
  syncNativeFromAppJson,
} from '../utils/bundler.js';
import { resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveRNProjectRoot } from '../utils/project.js';

/**
 * Build the signed store binary WITHOUT publishing a new Sankofa release.
 *
 * Use cases:
 *   - A release for this version already exists (so `sankofa release` would
 *     refuse) but you need to rebuild the IPA/AAB — fresh signing certs,
 *     updated Info.plist, a crashed Xcode leaving a corrupt archive, etc.
 *   - OTA-only lanes in CI that ship OTA separately from the signed binary.
 *   - Chained with `sankofa submit` when you want a strict build → upload
 *     sequence with an explicit handoff point.
 *
 * The OTA archive is intentionally NOT produced here — this command is
 * purely a local build step, not a publish.
 */
export const distCommand = new Command('dist')
  .description('Build the signed store binary (.ipa / .aab / .apk) without publishing a Sankofa release')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--project <path>', 'Path to the React Native app directory (defaults to auto-detect)')
  .option('--ios-export-method <method>', 'iOS export method: app-store, ad-hoc, development, enterprise (default: app-store)')
  .option('--ios-team-id <id>', 'Apple Developer Team ID (auto-detected from archive when omitted)')
  .option('--ios-export-options <path>', 'Path to a custom ExportOptions.plist (overrides --ios-export-method / --ios-team-id)')
  .option('--android-format <fmt>', 'Android distribution format: aab (Play Store) or apk (sideload). Default: aab', 'aab')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const platform = await resolvePlatformPrompt(platformArg);

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

    const appVersion = detectAppVersion(platform) || 'unknown';

    const distSpinner = ora(`Building signed ${platform} distribution binary for ${chalk.bold(appVersion)}...`).start();
    try {
      const artifact = buildDistributionArtifact(platform, {
        outputDir: join(opts.outputDir, 'distribution'),
        iosExportMethod: opts.iosExportMethod,
        iosTeamId: opts.iosTeamId,
        iosExportOptionsPlist: opts.iosExportOptions,
        androidFormat: opts.androidFormat === 'apk' ? 'apk' : 'aab',
      });
      distSpinner.succeed('Signed distribution binary built');

      const sha = computeSHA256(artifact.path);
      const size = getFileSize(artifact.path);
      const label =
        artifact.kind === 'ios-ipa' ? 'iOS IPA — App Store / TestFlight' :
        artifact.kind === 'android-aab' ? 'Android AAB — Play Store' :
        'Android APK — sideload';

      console.log('');
      console.log(chalk.bold(`  🏬 Store binary — ${label}`));
      console.log(chalk.dim('     App version: ') + chalk.bold(appVersion));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(artifact.path));
      console.log(chalk.dim('     Size:   ') + formatBytes(size));
      console.log(chalk.dim('     SHA256: ') + chalk.yellow(sha));
      console.log('');
      if (artifact.kind === 'ios-ipa') {
        console.log(chalk.dim('     Upload with:'));
        console.log(chalk.dim(`       sankofa submit ios --binary ${artifact.path}`));
      } else if (artifact.kind === 'android-aab') {
        console.log(chalk.dim('     Upload with:'));
        console.log(chalk.dim(`       sankofa submit android --binary ${artifact.path}`));
      }
      console.log('');
    } catch (err: any) {
      distSpinner.fail(`Distribution build failed: ${err.message}`);
      process.exit(1);
    }
  });
