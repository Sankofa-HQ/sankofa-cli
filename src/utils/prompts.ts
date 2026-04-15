import { resolveAuth } from './config.js';
import { normalizeEnvironment, normalizePlatform } from './validation.js';

export async function resolvePlatformPrompt(explicitPlatform?: string): Promise<'ios' | 'android'> {
  if (explicitPlatform) return normalizePlatform(explicitPlatform) as 'ios' | 'android';

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
