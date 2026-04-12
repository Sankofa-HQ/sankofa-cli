import { Command } from 'commander';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  detectAppVersion,
  bundleJS,
  buildNative,
  computeSHA256,
  formatBytes,
  getFileSize,
  type Platform,
} from '../utils/bundler.js';
import { uploadRelease } from '../utils/api.js';

export const releaseCommand = new Command('release')
  .description('Create a new release (builds native binary + uploads JS bundle to Sankofa)')
  .argument('<platform>', 'Target platform: ios or android')
  .option('--entry-file <file>', 'JS entry file', 'index.js')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--output-format <format>', 'Android output format: aab (default) or apk')
  .option('--description <desc>', 'Release description')
  .option('--mandatory', 'Mark this release as mandatory (force-update)')
  .option('--rollout <percent>', 'Initial rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test', 'live')
  .action(async (platformArg: string, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const platform = platformArg.toLowerCase() as Platform;
    if (platform !== 'ios' && platform !== 'android') {
      console.error(chalk.red('Platform must be "ios" or "android"'));
      process.exit(1);
    }

    // 1. Detect app version
    const spinner = ora('Detecting app version...').start();
    const appVersion = detectAppVersion(platform);
    if (!appVersion) {
      spinner.fail('Could not detect app version. Check your app.json, Info.plist, or build.gradle.');
      process.exit(1);
    }
    spinner.succeed(`App version: ${chalk.bold(appVersion)}`);

    // 2. Check if this version already has a release on Sankofa
    const checkSpinner = ora('Checking for existing releases...').start();
    try {
      const { listReleases } = await import('../utils/api.js');
      const releases = await listReleases(opts.env, platform);
      const existing = releases.find(
        (r: any) => r.target_binary_version === appVersion && r.platform === platform,
      );
      if (existing) {
        checkSpinner.fail(
          `Version ${chalk.bold(appVersion)} already has a release (${chalk.dim(existing.label)}). Use ${chalk.cyan('sankofa patch ' + platform)} instead.`,
        );
        process.exit(1);
      }
      checkSpinner.succeed('No existing release for this version');
    } catch (err: any) {
      checkSpinner.warn(`Could not check existing releases: ${err.message}`);
    }

    // 3. Build native binary
    const outputDir = opts.outputDir;
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    console.log(chalk.dim(`\n  Building ${platform} native binary...`));
    try {
      const binaryPath = buildNative(platform, outputDir, opts.outputFormat);
      console.log(chalk.green(`  ✓ Binary saved to ${binaryPath}`));
      console.log(chalk.dim(`    Upload this to the ${platform === 'ios' ? 'App Store' : 'Play Store'} manually.\n`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Native build skipped or failed: ${err.message}`));
      console.log(chalk.dim(`    You can build the native binary separately.\n`));
    }

    // 4. Bundle JS
    const bundlePath = join(outputDir, `bundle.${platform}.jsbundle`);
    const bundleSpinner = ora('Bundling JavaScript...').start();
    try {
      bundleJS(platform, opts.entryFile, bundlePath);
      bundleSpinner.succeed('JavaScript bundled');
    } catch (err: any) {
      bundleSpinner.fail(`Bundling failed: ${err.message}`);
      process.exit(1);
    }

    // 5. Compute SHA256
    const sha256 = computeSHA256(bundlePath);
    const size = getFileSize(bundlePath);
    console.log(chalk.dim(`  SHA256: ${sha256}`));
    console.log(chalk.dim(`  Size:   ${formatBytes(size)}`));

    // 6. Generate label
    const label = `v${appVersion}`;

    // 7. Confirm publish
    let shouldPublish = opts.publish;
    if (!shouldPublish) {
      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Publish ${chalk.bold(label)} (${platform}) to Sankofa Deploy?`,
          default: true,
        },
      ]);
      shouldPublish = confirm;
    }

    if (!shouldPublish) {
      console.log(chalk.dim('Release cancelled.'));
      return;
    }

    // 8. Upload to Sankofa
    const uploadSpinner = ora('Uploading bundle to Sankofa...').start();
    try {
      const release = await uploadRelease(bundlePath, {
        label,
        target_binary_version: appVersion,
        platform,
        description: opts.description || `Release ${label} for ${platform}`,
        is_mandatory: opts.mandatory || false,
        rollout_percentage: parseInt(opts.rollout, 10),
        environment: opts.env,
      });

      uploadSpinner.succeed('Bundle uploaded!');
      console.log('');
      console.log(chalk.green.bold('  🚀 Release published'));
      console.log(chalk.dim(`     Label:    ${release.label}`));
      console.log(chalk.dim(`     Platform: ${release.platform}`));
      console.log(chalk.dim(`     Target:   ${release.target_binary_version}`));
      console.log(chalk.dim(`     Rollout:  ${release.rollout_percentage}%`));
      console.log(chalk.dim(`     ID:       ${release.id}`));
      console.log('');
    } catch (err: any) {
      uploadSpinner.fail(`Upload failed: ${err.message}`);
      process.exit(1);
    }
  });
