import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * `sankofa cache` — manage the CLI's on-disk cache (downloaded Sankofa engines
 * + Flutter toolchains under ~/.sankofa). Parity with the Dart fork's
 * `shorebird cache clean`, plus `path`/`list` for scripting + visibility.
 *
 * The login (`credentials.json`) and per-project config are never touched by
 * `clean` — only the re-downloadable engine/flutter artifacts.
 */
function sankofaHome(): string {
  return process.env.SANKOFA_HOME || join(homedir(), '.sankofa');
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    total += st.isDirectory() ? dirSizeBytes(p) : st.size;
  }
  return total;
}

function human(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const cacheCommand = new Command('cache').description(
  'Manage the Sankofa CLI cache (downloaded engines + Flutter toolchains).',
);

cacheCommand
  .command('path')
  .description('Print the cache directory (handy in scripts).')
  .action(() => {
    console.log(sankofaHome());
  });

cacheCommand
  .command('list')
  .description('Show what is cached and how much disk it uses.')
  .action(() => {
    const home = sankofaHome();
    const groups: Array<{ label: string; dir: string }> = [
      { label: 'engines', dir: join(home, 'engines') },
      { label: 'flutter', dir: join(home, 'flutter') },
    ];
    let grand = 0;
    let any = false;
    for (const g of groups) {
      if (!existsSync(g.dir)) continue;
      const entries = readdirSync(g.dir).filter((n) => !n.startsWith('.'));
      const size = dirSizeBytes(g.dir);
      grand += size;
      any = true;
      console.log(`${chalk.cyan(g.label)}  ${chalk.dim(g.dir)}  ${chalk.yellow(human(size))}`);
      for (const e of entries) {
        console.log(`  ${chalk.dim('•')} ${e}  ${chalk.dim(human(dirSizeBytes(join(g.dir, e))))}`);
      }
    }
    if (!any) {
      console.log(chalk.dim('Cache is empty.'));
      return;
    }
    console.log(chalk.bold(`\nTotal: ${human(grand)}`));
  });

cacheCommand
  .command('clean')
  .description('Delete cached engines + Flutter toolchains (your login is kept).')
  .option('--engines', 'Only clean cached engines')
  .option('--flutter', 'Only clean cached Flutter toolchains')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (opts: { engines?: boolean; flutter?: boolean; yes?: boolean }) => {
    const home = sankofaHome();
    const wantEngines = opts.engines || (!opts.engines && !opts.flutter);
    const wantFlutter = opts.flutter || (!opts.engines && !opts.flutter);
    const targets: string[] = [];
    if (wantEngines) targets.push(join(home, 'engines'));
    if (wantFlutter) targets.push(join(home, 'flutter'));
    const present = targets.filter((t) => existsSync(t));
    if (present.length === 0) {
      console.log(chalk.dim('Nothing to clean — cache is already empty.'));
      return;
    }
    const total = present.reduce((n, d) => n + dirSizeBytes(d), 0);
    if (!opts.yes) {
      const { ok } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'ok',
          message: `Delete ${human(total)} of cached artifacts? They will be re-downloaded on next use.`,
          default: false,
        },
      ]);
      if (!ok) {
        console.log(chalk.dim('Aborted.'));
        return;
      }
    }
    for (const d of present) {
      rmSync(d, { recursive: true, force: true });
      console.log(`${chalk.green('✓')} removed ${chalk.dim(d)}`);
    }
    console.log(chalk.bold(`Freed ${human(total)}. Login preserved.`));
  });
