import { Command } from 'commander';
import { saveGlobalConfig, saveProjectConfig } from '../utils/config.js';

export const loginCommand = new Command('login')
  .description('Authenticate with your Sankofa API key')
  .option('--api-key <key>', 'Your Sankofa project API key (sk_live_... or sk_test_...)')
  .option('--endpoint <url>', 'Sankofa API endpoint (default: https://api.sankofa.dev)')
  .option('--project', 'Save to .sankofa.json in the current project instead of global config')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    let apiKey = opts.apiKey;
    let endpoint = opts.endpoint || 'https://api.sankofa.dev';

    if (!apiKey) {
      const inquirer = (await import('inquirer')).default;
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: 'Enter your Sankofa API key:',
          mask: '*',
          validate: (v: string) =>
            v.startsWith('sk_') ? true : 'API key must start with sk_live_ or sk_test_',
        },
        {
          type: 'input',
          name: 'endpoint',
          message: 'API endpoint:',
          default: endpoint,
        },
      ]);
      apiKey = answers.apiKey;
      endpoint = answers.endpoint;
    }

    // Validate the key by calling the handshake
    const ora = (await import('ora')).default;
    const spinner = ora('Validating API key...').start();

    try {
      const res = await fetch(`${endpoint}/api/v1/handshake`, {
        headers: { 'x-api-key': apiKey },
      });
      if (!res.ok) {
        spinner.fail('Invalid API key');
        process.exit(1);
      }
      const data = await res.json() as any;
      spinner.succeed(`Authenticated! Project: ${data.project_id}`);

      if (opts.project) {
        saveProjectConfig({ apiKey, endpoint });
        console.log(chalk.dim('  Saved to .sankofa.json'));
      } else {
        saveGlobalConfig({ apiKey, endpoint });
        console.log(chalk.dim('  Saved to ~/.sankofa/credentials.json'));
      }
    } catch (err: any) {
      spinner.fail(`Connection failed: ${err.message}`);
      process.exit(1);
    }
  });
