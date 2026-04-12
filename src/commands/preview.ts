import { Command } from 'commander';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  detectAppVersion,
  bundleJS,
  computeSHA256,
  formatBytes,
  getFileSize,
  type Platform,
} from '../utils/bundler.js';

export const previewCommand = new Command('preview')
  .description('Preview a release or patch — bundles JS and shows what would be uploaded (dry run)')
  .argument('<platform>', 'Target platform: ios or android')
  .option('--entry-file <file>', 'JS entry file', 'index.js')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .action(async (platformArg: string, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const platform = platformArg.toLowerCase() as Platform;
    if (platform !== 'ios' && platform !== 'android') {
      console.error(chalk.red('Platform must be "ios" or "android"'));
      process.exit(1);
    }

    // 1. Detect version
    const versionSpinner = ora('Detecting app version...').start();
    const appVersion = detectAppVersion(platform);
    if (!appVersion) {
      versionSpinner.fail('Could not detect app version.');
      process.exit(1);
    }
    versionSpinner.succeed(`App version: ${chalk.bold(appVersion)}`);

    // 2. Bundle JS
    const outputDir = opts.outputDir;
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const bundlePath = join(outputDir, `preview.${platform}.jsbundle`);
    const bundleSpinner = ora('Bundling JavaScript (preview)...').start();
    try {
      bundleJS(platform, opts.entryFile, bundlePath);
      bundleSpinner.succeed('JavaScript bundled');
    } catch (err: any) {
      bundleSpinner.fail(`Bundling failed: ${err.message}`);
      process.exit(1);
    }

    // 3. Show preview info
    const sha256 = computeSHA256(bundlePath);
    const size = getFileSize(bundlePath);

    console.log('');
    console.log(chalk.bold('  📋 Preview (dry run — nothing uploaded)'));
    console.log(chalk.dim('  ' + '─'.repeat(50)));
    console.log(`  Platform:    ${chalk.bold(platform)}`);
    console.log(`  App version: ${chalk.bold(appVersion)}`);
    console.log(`  Label:       ${chalk.bold(`v${appVersion}`)}`);
    console.log(`  Bundle size: ${chalk.bold(formatBytes(size))}`);
    console.log(`  SHA256:      ${chalk.dim(sha256)}`);
    console.log(`  Bundle path: ${chalk.dim(bundlePath)}`);
    console.log('');
    console.log(chalk.dim(`  Run ${chalk.cyan('sankofa release ' + platform)} to publish.`));
    console.log('');
  });
