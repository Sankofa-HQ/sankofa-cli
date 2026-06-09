import { resolveAuth } from './config.js';
import { normalizeEnvironment, normalizePlatform } from './validation.js';

function isInteractive(): boolean {
  // inquirer reaches into stdin/stdout for raw mode. When either end
  // isn't a TTY (CI, pipes, IDE consoles, tests, the user piping
  // output for inspection), prompting throws ERR_USE_AFTER_CLOSE. Use
  // a sensible default instead so the command still runs.
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

export async function resolvePlatformPrompt(explicitPlatform?: string): Promise<'ios' | 'android'> {
  if (explicitPlatform) return normalizePlatform(explicitPlatform) as 'ios' | 'android';
  if (!isInteractive()) {
    throw new Error('Specify a platform with --platform <ios|android> (no TTY to prompt).');
  }

  const inquirer = (await import('inquirer')).default;
  const { platform } = await inquirer.prompt([
    {
      type: 'list',
      name: 'platform',
      message: 'Select target platform:',
      choices: [
        { name: 'iOS', value: 'ios' },
        { name: 'Android', value: 'android' },
      ],
    },
  ]);
  return platform;
}

export async function resolveEnvironmentPrompt(explicitEnv?: string): Promise<'live' | 'test'> {
  if (explicitEnv) return normalizeEnvironment(explicitEnv);

  let configured: 'live' | 'test' = 'live';
  try {
    configured = normalizeEnvironment(resolveAuth().environment);
  } catch {}

  // Non-interactive callers (status pipes, CI) just get the configured
  // environment. Interactive callers see the picker.
  if (!isInteractive()) return configured;

  const inquirer = (await import('inquirer')).default;
  const { environment } = await inquirer.prompt([
    {
      type: 'list',
      name: 'environment',
      message: 'Select deploy environment:',
      default: configured,
      choices: [
        { name: 'Test', value: 'test' },
        { name: 'Live', value: 'live' },
      ],
    },
  ]);

  return environment;
}
