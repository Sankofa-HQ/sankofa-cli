import { Command } from 'commander';
import { listReleases } from '../utils/api.js';
import { resolveEnvironmentPrompt } from '../utils/prompts.js';
import { normalizePlatform } from '../utils/validation.js';

export const statusCommand = new Command('status')
  .description('Show the status of all releases for this project')
  .option('--platform <platform>', 'Filter by platform (ios/android)')
  .option('--env <environment>', 'Target environment')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    let environment;
    let platform;
    try {
      environment = await resolveEnvironmentPrompt(opts.env);
      platform = opts.platform ? normalizePlatform(opts.platform) : undefined;
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    const spinner = ora('Fetching releases...').start();
    try {
      const releases = await listReleases(environment, platform);
      spinner.stop();

      if (releases.length === 0) {
        console.log(chalk.dim(`  No ${environment} releases found.`));
        return;
      }

      console.log('');
      console.log(chalk.bold(`  Releases (${environment}, ${releases.length})`));
      console.log(chalk.dim('  ' + '─'.repeat(80)));

      for (const r of releases) {
        const status = r.is_disabled
          ? chalk.red('DISABLED')
          : r.rollout_percentage < 100
            ? chalk.yellow(`ROLLING OUT ${r.rollout_percentage}%`)
            : r.is_mandatory
              ? chalk.blue('MANDATORY')
              : chalk.green('ACTIVE');

        const installs = r.total_installs ?? 0;
        const rollbacks = r.total_rollbacks ?? 0;

        console.log(
          `  ${chalk.bold(r.label.padEnd(24))} ${r.platform.padEnd(10)} ${r.target_binary_version.padEnd(10)} ${status.padEnd(30)} ${chalk.dim(`${installs} installs`)}${rollbacks > 0 ? chalk.red(` ${rollbacks} rollbacks`) : ''}`,
        );
      }
      console.log('');
    } catch (err: any) {
      spinner.fail(`Failed: ${err.message}`);
      process.exit(1);
    }
  });
