import { Command } from 'commander';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GLOBAL_DIR = join(homedir(), '.sankofa');
const GLOBAL_CREDS = join(GLOBAL_DIR, 'credentials.json');
const PROJECT_FILE = '.sankofa.json';

function clearProjectFromGlobal(): { existed: boolean; hadProject: boolean } {
  if (!existsSync(GLOBAL_CREDS)) return { existed: false, hadProject: false };
  try {
    const raw = JSON.parse(readFileSync(GLOBAL_CREDS, 'utf-8')) as Record<string, unknown>;
    const hadProject = !!raw.projectId;
    if (!hadProject) return { existed: true, hadProject: false };
    delete raw.projectId;
    delete raw.environment;
    // The Deploy Token is project-scoped on the server. Keeping it without
    // a projectId would silently reuse the stale project on the next
    // command, so clear it too. We intentionally KEEP `sessionJwt` here so
    // `sankofa switch` can pick a new project without forcing a browser
    // round-trip. Full `sankofa logout` removes the file entirely, which
    // wipes the JWT along with everything else.
    delete raw.token;
    delete raw.apiKey;
    delete raw.authType;
    writeFileSync(GLOBAL_CREDS, JSON.stringify(raw, null, 2));
    return { existed: true, hadProject: true };
  } catch {
    return { existed: true, hadProject: false };
  }
}

export const logoutCommand = new Command('logout')
  .description('Remove stored Sankofa credentials')
  .option('--project', 'Only remove the project-scoped .sankofa.json in the current directory')
  .option('--global', 'Only remove the global ~/.sankofa/credentials.json')
  .option('--all', 'Remove both project-scoped and global credentials (default when no flag is passed)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    // If the user passes no flag, default to removing both scopes. An
    // explicit --project or --global narrows the action; --all is a no-op
    // alias for the default but is kept so `sankofa logout --all` reads
    // naturally in CI scripts.
    const only = opts.project ? 'project' : opts.global ? 'global' : 'both';
    const projectPath = join(process.cwd(), PROJECT_FILE);

    const projectExists = existsSync(projectPath);
    const globalExists = existsSync(GLOBAL_CREDS);
    let removedAny = false;

    if (only === 'project' || only === 'both') {
      if (projectExists) {
        try {
          rmSync(projectPath, { force: true });
          console.log(chalk.green(`  Removed ${chalk.dim(projectPath)}`));
          removedAny = true;
        } catch (err: any) {
          console.error(chalk.red(`  Failed to remove ${projectPath}: ${err.message}`));
          process.exit(1);
        }
      } else if (only === 'project') {
        console.log(chalk.dim(`  No .sankofa.json in ${process.cwd()}`));
      }

      // Also purge the active project from the global creds when the user
      // asks for a project-scope logout. Deploy Tokens are project-scoped
      // on the server, so keeping the token while clearing the id would
      // silently reuse the old project on the next command. Clearing both
      // forces a fresh `sankofa login` which lets the user pick a new
      // project (and mint a new token for it).
      if (only === 'project') {
        const res = clearProjectFromGlobal();
        if (res.hadProject) {
          console.log(chalk.green(`  Cleared active project from ${chalk.dim(GLOBAL_CREDS)}`));
          removedAny = true;
        }
      }
    }

    if (only === 'global' || only === 'both') {
      if (globalExists) {
        try {
          rmSync(GLOBAL_CREDS, { force: true });
          console.log(chalk.green(`  Removed ${chalk.dim(GLOBAL_CREDS)}`));
          removedAny = true;
        } catch (err: any) {
          console.error(chalk.red(`  Failed to remove ${GLOBAL_CREDS}: ${err.message}`));
          process.exit(1);
        }
      } else if (only === 'global') {
        console.log(chalk.dim(`  No credentials at ${GLOBAL_CREDS}`));
      }
    }

    if (!removedAny) {
      if (only === 'global' && projectExists) {
        console.log('');
        console.log(chalk.yellow(`  A project-scoped ${chalk.dim(PROJECT_FILE)} still exists in this directory.`));
        console.log(chalk.dim('  Run `sankofa logout --project` or plain `sankofa logout` to remove it.'));
      } else {
        console.log(chalk.dim('  Nothing to remove — you were not logged in.'));
      }
      return;
    }

    console.log('');
    if (only === 'project') {
      console.log(chalk.bold('  Run `sankofa login` to pick a different project.'));
    }
    console.log(chalk.dim('  Note: SANKOFA_DEPLOY_TOKEN / SANKOFA_API_KEY env vars'));
    console.log(chalk.dim('  (if set) still authenticate the CLI. Unset them in your'));
    console.log(chalk.dim('  shell to fully log out.'));
  });
