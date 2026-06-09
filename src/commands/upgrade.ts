import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const upgradeCommand = new Command('upgrade')
  .description('Check npm for a newer sankofa-cli and install it')
  .option('--check', 'Only report the latest version; do not install')
  .option('--sudo', 'Use sudo for the install (requires interactive password)')
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
      console.log(chalk.dim(`  Install with: sankofa upgrade  (or  sudo npm install -g ${name}@latest)`));
      return;
    }

    console.log('');
    console.log(chalk.bold(`  Upgrading to ${latest}...`));
    if (opts.sudo) {
      runInstallWithSudo(name, latest, chalk);
      return;
    }
    try {
      execSync(`npm install -g ${name}@latest`, { stdio: 'inherit' });
      console.log('');
      console.log(chalk.green(`  ✓ Upgraded to ${latest}`));
    } catch (err: any) {
      // The single most common reason `npm install -g` fails on macOS
      // is that the default global prefix (/usr/local/lib/node_modules)
      // is root-owned and the user has neither switched to a
      // user-writable prefix nor used sudo. Detect that case and offer
      // an automatic sudo retry instead of dumping the raw EACCES.
      const msg = String(err?.message ?? err);
      const isPermDenied =
        msg.includes('EACCES') ||
        msg.includes('permission denied') ||
        msg.includes('Permission denied');
      if (isPermDenied) {
        offerSudoRetry(name, latest, chalk);
      } else {
        console.error('');
        console.error(chalk.red(`  Upgrade failed: ${msg.split('\n')[0]}`));
        console.error(chalk.dim(`  Try: sudo npm install -g ${name}@latest`));
        process.exit(1);
      }
    }
  });

function offerSudoRetry(name: string, latest: string, chalk: any): void {
  console.log('');
  console.log(chalk.yellow('  ! Permission denied writing to the global npm prefix.'));
  console.log(chalk.dim('     This is the macOS default — /usr/local/lib/node_modules is root-owned.'));
  console.log('');

  if (!process.stdin.isTTY) {
    // Non-interactive (CI, piped). Print the exact remedy and exit.
    console.log(chalk.bold('  Run one of these to finish the upgrade:'));
    console.log('');
    console.log(chalk.cyan(`     sudo npm install -g ${name}@latest`));
    console.log(chalk.dim('       OR'));
    console.log(chalk.cyan(`     sankofa upgrade --sudo`));
    console.log('');
    process.exit(1);
  }

  // Interactive — retry once with sudo (will prompt for the password
  // on stdin). If the user cancels (Ctrl-C / wrong password), bail.
  try {
    console.log(chalk.dim('     Retrying with sudo (you may be prompted for your password)…'));
    console.log('');
    runInstallWithSudo(name, latest, chalk);
  } catch (err: any) {
    console.error('');
    console.error(chalk.red(`  Upgrade failed: ${err?.message ?? err}`));
    console.error(chalk.dim(`  Run manually: sudo npm install -g ${name}@latest`));
    process.exit(1);
  }
}

function runInstallWithSudo(name: string, latest: string, chalk: any): void {
  execSync(`sudo npm install -g ${name}@latest`, { stdio: 'inherit' });
  console.log('');
  console.log(chalk.green(`  ✓ Upgraded to ${latest}`));
}

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
