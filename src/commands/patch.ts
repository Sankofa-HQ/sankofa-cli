import { Command } from 'commander';
import { join } from 'path';
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
import { requireAuth } from '../utils/config.js';
import { resolveEnvironmentPrompt, resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveRNProjectRoot } from '../utils/project.js';
import { escapeRegExp, parseRollout } from '../utils/validation.js';

function isPatchRelease(release: any): boolean {
  return /-patch\.\d+$/.test(String(release.label || ''));
}

export const patchCommand = new Command('patch')
  .description('Push an OTA patch to an existing release (JavaScript only — no native changes)')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--entry-file <file>', 'JS entry file')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--description <desc>', 'Patch description')
  .option('--mandatory', 'Mark this patch as mandatory (force-update)')
  .option('--rollout <percent>', 'Initial rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--project <path>', 'Path to the React Native app directory (defaults to auto-detect)')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const inquirer = (await import('inquirer')).default;

    await requireAuth();

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

    try {
      const project = await resolveRNProjectRoot(opts.project);
      process.chdir(project.root);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    // Sync ios/ and android/ from app.json so the entry file, asset paths,
    // and native version reflect the current source before we bundle.
    const syncSpinner = ora('Syncing native project from app.json (expo prebuild)...').start();
    try {
      syncNativeFromAppJson(platform);
      syncSpinner.succeed('Native project synced');
    } catch (err: any) {
      syncSpinner.fail(err.message);
      process.exit(1);
    }

    const entryFile = detectEntryFile(opts.entryFile);

    // 1. Fetch existing releases
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

    // 2. Let user pick a release to patch
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

    // 3. Ask about native changes
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
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with JS-only patch?',
          default: true,
        },
      ]);
      if (!continueAnyway) {
        console.log(chalk.dim('Patch cancelled.'));
        return;
      }
    }

    // 4. Bundle JS
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

    // 5. SHA256 + size (of the archive bytes the client verifies)
    const sha256 = computeSHA256(archivePath);
    const size = getFileSize(archivePath);
    console.log(chalk.dim(`  SHA256: ${sha256}`));
    console.log(chalk.dim(`  Size:   ${formatBytes(size)}`));

    // 6. Generate patch label
    const baseLabel = selectedRelease.label;
    const patchPattern = new RegExp(`^${escapeRegExp(baseLabel)}-patch\\.(\\d+)$`);
    const maxPatchNumber = releases
      .filter((r: any) =>
        r.target_binary_version === selectedRelease.target_binary_version &&
        r.platform === platform &&
        (r.environment || environment) === environment
      )
      .reduce((max: number, r: any) => {
        const match = String(r.label).match(patchPattern);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0);
    const label = `${baseLabel}-patch.${maxPatchNumber + 1}`;

    // 7. Ask about mandatory
    let isMandatory = opts.mandatory || false;
    if (!opts.mandatory && !opts.publish) {
      const { mandatory } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'mandatory',
          message: 'Mark as mandatory (forces users to update)?',
          default: false,
        },
      ]);
      isMandatory = mandatory;
    }

    // 8. Rollout percentage
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

    // 9. Confirm
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

    // 10. Upload
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
  });
