import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fetchKnownEngines } from '../utils/engineRegistry.js';
import { listCachedEngines } from '../utils/engineCache.js';
import { flutterVersionOf } from '../utils/engineVersion.js';

/**
 * `sankofa flutter` — parity alias over Sankofa's engine/version machinery, so a
 * Flutter dev coming from the Dart fork finds the familiar commands:
 *
 *   sankofa flutter versions   →  available + cached Sankofa Flutter engines
 *   sankofa flutter config     →  get/set this project's engine_version (sankofa.yaml)
 *
 * The underlying source of truth is the KnownEngine registry (download.sankofa.dev)
 * and each project's `sankofa.yaml::engine_version` — never a guess.
 */
export const flutterCommand = new Command('flutter').description(
  'Manage the Sankofa Flutter toolchain (versions + per-project engine selection).',
);

flutterCommand
  .command('versions')
  .alias('list')
  .description('List Sankofa Flutter engine versions (available in the registry + cached locally).')
  .action(async () => {
    let cached: string[] = [];
    try {
      cached = (listCachedEngines() || []).map((e: any) =>
        typeof e === 'string' ? e : e?.sankofa_engine_version ?? e?.version ?? String(e),
      );
    } catch {
      /* cache may be empty */
    }
    const cachedSet = new Set(cached);
    let engines: any[] = [];
    try {
      engines = (await fetchKnownEngines()) || [];
    } catch (err: any) {
      console.error(chalk.yellow(`Could not reach the engine registry: ${err?.message ?? err}`));
    }
    const versions = new Set<string>([...cachedSet]);
    for (const e of engines) if (e?.sankofa_engine_version) versions.add(e.sankofa_engine_version);
    if (versions.size === 0) {
      console.log(chalk.dim('No engine versions found (registry unreachable and cache empty).'));
      return;
    }
    console.log(chalk.bold('Sankofa Flutter engines:'));
    for (const v of [...versions].sort()) {
      const fv = flutterVersionOf(v);
      const flutterLabel = fv ? chalk.dim(` (Flutter ${fv})`) : '';
      const mark = cachedSet.has(v) ? chalk.green('● cached') : chalk.dim('○ available');
      console.log(`  ${mark}  ${v}${flutterLabel}`);
    }
  });

flutterCommand
  .command('config')
  .description("Show or set this project's Flutter engine version (sankofa.yaml engine_version).")
  .option('--version <version>', 'Set the engine_version (e.g. 3.44.1+sankofa-1)')
  .option('--project <path>', 'Project root (defaults to the current directory)')
  .action((opts: { version?: string; project?: string }) => {
    const root = opts.project ?? process.cwd();
    const yamlPath = join(root, 'sankofa.yaml');
    if (!existsSync(yamlPath)) {
      console.error(
        chalk.red(`No sankofa.yaml at ${root}. Run ${chalk.cyan('sankofa init')} first.`),
      );
      process.exitCode = 1;
      return;
    }
    const raw = readFileSync(yamlPath, 'utf8');
    const current = raw.match(/^engine_version:\s*(\S+)/m)?.[1];

    if (!opts.version) {
      if (current) {
        const fv = flutterVersionOf(current);
        console.log(`engine_version: ${chalk.cyan(current)}${fv ? chalk.dim(` (Flutter ${fv})`) : ''}`);
      } else {
        console.log(chalk.dim('engine_version is not set in sankofa.yaml (the CLI resolves the latest).'));
      }
      return;
    }

    const next = opts.version;
    let updated: string;
    if (current) {
      updated = raw.replace(/^engine_version:\s*\S+/m, `engine_version: ${next}`);
    } else {
      const nl = raw.endsWith('\n') || raw.length === 0 ? '' : '\n';
      updated = `${raw}${nl}engine_version: ${next}\n`;
    }
    writeFileSync(yamlPath, updated);
    const fv = flutterVersionOf(next);
    console.log(
      `${chalk.green('✓')} engine_version set to ${chalk.cyan(next)}${fv ? chalk.dim(` (Flutter ${fv})`) : ''}`,
    );
    console.log(chalk.dim('Run a release/patch to fetch this engine if it is not cached yet.'));
  });
