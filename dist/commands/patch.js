import { Command } from 'commander';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { bundleJS, computeSHA256, formatBytes, getFileSize, } from '../utils/bundler.js';
import { listReleases, uploadRelease } from '../utils/api.js';
export const patchCommand = new Command('patch')
    .description('Push an OTA patch to an existing release (JavaScript only — no native changes)')
    .argument('<platform>', 'Target platform: ios or android')
    .option('--entry-file <file>', 'JS entry file', 'index.js')
    .option('--output-dir <dir>', 'Directory for built artifacts', './build')
    .option('--description <desc>', 'Patch description')
    .option('--mandatory', 'Mark this patch as mandatory (force-update)')
    .option('--rollout <percent>', 'Initial rollout percentage (0-100)', '100')
    .option('--publish', 'Auto-publish without prompting')
    .option('--env <environment>', 'Target environment: live or test', 'live')
    .action(async (platformArg, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const inquirer = (await import('inquirer')).default;
    const platform = platformArg.toLowerCase();
    if (platform !== 'ios' && platform !== 'android') {
        console.error(chalk.red('Platform must be "ios" or "android"'));
        process.exit(1);
    }
    // 1. Fetch existing releases
    const spinner = ora('Fetching releases...').start();
    let releases;
    try {
        releases = await listReleases(opts.env, platform);
    }
    catch (err) {
        spinner.fail(`Failed to fetch releases: ${err.message}`);
        process.exit(1);
    }
    if (releases.length === 0) {
        spinner.fail(`No releases found for ${platform}. Run ${chalk.cyan('sankofa release ' + platform)} first.`);
        process.exit(1);
    }
    spinner.succeed(`Found ${releases.length} release(s)`);
    // 2. Let user pick a release to patch
    const { selectedRelease } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedRelease',
            message: 'Select a release to patch:',
            choices: releases.map((r) => ({
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
    if (!existsSync(outputDir))
        mkdirSync(outputDir, { recursive: true });
    const bundlePath = join(outputDir, `patch.${platform}.jsbundle`);
    const bundleSpinner = ora('Bundling JavaScript...').start();
    try {
        bundleJS(platform, opts.entryFile, bundlePath);
        bundleSpinner.succeed('JavaScript bundled');
    }
    catch (err) {
        bundleSpinner.fail(`Bundling failed: ${err.message}`);
        process.exit(1);
    }
    // 5. SHA256 + size
    const sha256 = computeSHA256(bundlePath);
    const size = getFileSize(bundlePath);
    console.log(chalk.dim(`  SHA256: ${sha256}`));
    console.log(chalk.dim(`  Size:   ${formatBytes(size)}`));
    // 6. Generate patch label
    const existingPatches = releases.filter((r) => r.target_binary_version === selectedRelease.target_binary_version);
    const patchNumber = existingPatches.length + 1;
    const label = `${selectedRelease.label}-patch.${patchNumber}`;
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
    let rollout = parseInt(opts.rollout, 10);
    if (!opts.publish && opts.rollout === '100') {
        const { rolloutAnswer } = await inquirer.prompt([
            {
                type: 'input',
                name: 'rolloutAnswer',
                message: 'Initial rollout percentage (0-100):',
                default: '100',
                validate: (v) => {
                    const n = parseInt(v, 10);
                    return n >= 0 && n <= 100 ? true : 'Must be between 0 and 100';
                },
            },
        ]);
        rollout = parseInt(rolloutAnswer, 10);
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
        const release = await uploadRelease(bundlePath, {
            label,
            target_binary_version: selectedRelease.target_binary_version,
            platform,
            description: opts.description || `Patch for ${selectedRelease.label}`,
            is_mandatory: isMandatory,
            rollout_percentage: rollout,
            environment: opts.env,
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
    }
    catch (err) {
        uploadSpinner.fail(`Upload failed: ${err.message}`);
        process.exit(1);
    }
});
//# sourceMappingURL=patch.js.map