import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const upgradeCommand = new Command('upgrade')
  .description('Check npm for a newer sankofa-cli and install it')
  .option('--check', 'Only report the latest version; do not install')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const current: string = pkg.version || '0.0.0';
    const name: string = pkg.name || 'sankofa-cli';

    const spinner = ora(`Checking ${name} on npm...`).start();
    let latest: string;
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
      const data = (await res.json()) as any;
      latest = data.version;
      spinner.succeed(`latest ${name}: ${chalk.bold(latest)} (installed: ${current})`);
    } catch (err: any) {
      spinner.fail(`Could not reach npm: ${err.message}`);
      process.exit(1);
    }

    if (compareSemver(latest, current) <= 0) {
      console.log(chalk.green('  You are on the latest version.'));
      return;
    }

    if (opts.check) {
      console.log(chalk.yellow(`  A newer version (${latest}) is available.`));
      console.log(chalk.dim(`  Install with: npm install -g ${name}@latest`));
      return;
    }

    console.log('');
    console.log(chalk.bold(`  Upgrading to ${latest}...`));
    try {
      execSync(`npm install -g ${name}@latest`, { stdio: 'inherit' });
      console.log('');
      console.log(chalk.green(`  ✓ Upgraded to ${latest}`));
    } catch (err: any) {
      console.error(chalk.red(`  Upgrade failed: ${err.message}`));
      console.error(chalk.dim('  You may need sudo, or a different global install location.'));
      process.exit(1);
    }
  });

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
