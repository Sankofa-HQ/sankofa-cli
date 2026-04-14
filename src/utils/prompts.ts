import { resolveAuth } from './config.js';
import { normalizeEnvironment } from './validation.js';

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
