import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { resolveFlutterBinary } from '../utils/flutterBundler.js';
import { initCommand } from './init.js';

/**
 * `sankofa create <name>` — scaffold a NEW Flutter app and set up Sankofa in it.
 * Dart-fork parity for `create` (which scaffolds + wires code-push). Ours uses
 * the resolved Sankofa Flutter (managed at ~/.sankofa, or the system `flutter`)
 * to run `flutter create`, then runs the standard `sankofa init` flow in the new
 * project so Deploy/OTA (+ any other products) are wired from the start.
 */
export const createCommand = new Command('create')
  .description('Scaffold a new Flutter app and set up Sankofa in it.')
  .argument('<name>', 'App / directory name (e.g. my_app)')
  .option('--org <org>', 'Reverse-DNS org prefix for the bundle id', 'dev.sankofa')
  .option('--platforms <list>', 'Comma-separated platforms (e.g. ios,android)')
  .option('--template <template>', 'flutter create --template (app, plugin, package, module)')
  .option('--no-init', 'Only scaffold — skip the Sankofa init step')
  .option('--deploy', 'Preselect Sankofa Deploy (OTA) during init', true)
  .action(
    async (
      name: string,
      opts: {
        org?: string;
        platforms?: string;
        template?: string;
        init?: boolean;
        deploy?: boolean;
      },
    ) => {
      const dir = pathResolve(process.cwd(), name);
      if (existsSync(dir)) {
        console.error(chalk.red(`Directory already exists: ${dir}`));
        process.exit(1);
      }

      let flutter: string;
      try {
        flutter = resolveFlutterBinary();
      } catch (err: any) {
        console.error(chalk.red(`Could not resolve a Flutter toolchain: ${err?.message ?? err}`));
        console.error(chalk.dim('Install one with `sankofa engine install`, or ensure `flutter` is on PATH.'));
        process.exit(1);
        return;
      }

      const args = ['create'];
      if (opts.org) args.push('--org', opts.org);
      if (opts.platforms) args.push('--platforms', opts.platforms);
      if (opts.template) args.push('--template', opts.template);
      args.push(name);

      console.log(chalk.dim(`$ flutter ${args.join(' ')}`));
      try {
        execFileSync(flutter, args, { stdio: 'inherit' });
      } catch {
        console.error(chalk.red('`flutter create` failed.'));
        process.exit(1);
      }

      if (opts.init === false) {
        console.log(
          chalk.green(`\n✓ Created ${name}.`) +
            chalk.dim(` Next: ${chalk.cyan(`cd ${name} && sankofa init`)}`),
        );
        return;
      }

      // Run the standard init flow inside the new project (exact same behavior
      // as `sankofa init`, reused — not duplicated).
      process.chdir(dir);
      const initArgs: string[] = [];
      if (opts.deploy) initArgs.push('--deploy');
      await initCommand.parseAsync(initArgs, { from: 'user' });

      console.log(chalk.green(`\n✓ ${name} created and Sankofa initialized.`));
      console.log(chalk.dim(`  cd ${name}  →  sankofa release ios  /  sankofa patch ios`));
    },
  );
