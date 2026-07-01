import { Command } from 'commander';
import chalk from 'chalk';
import { getMe, listOrganizations, listApps } from '../utils/api.js';
import { resolveAuth } from '../utils/config.js';

function ensureLoggedIn(): void {
  const { token } = resolveAuth();
  if (!token) {
    console.error(chalk.red('Not logged in. Run `sankofa login` (or set SANKOFA_DEPLOY_TOKEN).'));
    process.exit(1);
  }
}

/**
 * `sankofa account` — identity + org/app listing (Dart-fork parity for
 * `account whoami|apps|orgs`). Backed by the CLI-compat endpoints the server
 * already exposes: GET /api/v1/users/me, /api/v1/organizations, /api/v1/apps.
 */
export const accountCommand = new Command('account').description('Your Sankofa account — identity, organizations, apps.');

accountCommand
  .command('whoami')
  .description('Show the currently authenticated user.')
  .option('--json', 'Emit JSON')
  .action(async (opts: { json?: boolean }) => {
    ensureLoggedIn();
    let me: any;
    try {
      me = await getMe();
    } catch (err: any) {
      console.error(chalk.red(err?.message ?? String(err)));
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(me, null, 2));
      return;
    }
    const user = me.user ?? me;
    console.log(`${chalk.dim('user')}   ${chalk.bold(user.email ?? user.name ?? user.id ?? 'unknown')}`);
    if (user.name && user.email) console.log(`${chalk.dim('name')}   ${user.name}`);
    if (user.id) console.log(`${chalk.dim('id')}     ${user.id}`);
  });

accountCommand
  .command('orgs')
  .alias('organizations')
  .description('List organizations you belong to.')
  .option('--json', 'Emit JSON')
  .action(async (opts: { json?: boolean }) => {
    ensureLoggedIn();
    let orgs: any[];
    try {
      orgs = await listOrganizations();
    } catch (err: any) {
      console.error(chalk.red(err?.message ?? String(err)));
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(orgs, null, 2));
      return;
    }
    if (orgs.length === 0) {
      console.log(chalk.dim('No organizations.'));
      return;
    }
    for (const o of orgs) {
      const org = o.organization ?? o;
      const role = o.role ? chalk.dim(` (${o.role})`) : '';
      console.log(`  ${chalk.bold(org.name ?? org.id ?? o.organization_id)}${role}  ${chalk.dim(org.id ?? o.organization_id ?? '')}`);
    }
  });

accountCommand
  .command('apps')
  .description('List apps (projects) you have access to.')
  .option('--json', 'Emit JSON')
  .action(async (opts: { json?: boolean }) => {
    ensureLoggedIn();
    let apps: any[];
    try {
      apps = await listApps();
    } catch (err: any) {
      console.error(chalk.red(err?.message ?? String(err)));
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(apps, null, 2));
      return;
    }
    if (apps.length === 0) {
      console.log(chalk.dim('No apps. Create one with `sankofa create` or in the dashboard.'));
      return;
    }
    for (const a of apps) {
      const name = a.display_name ?? a.name ?? a.app_id ?? a.id;
      const id = a.app_id ?? a.id ?? '';
      const platforms = Array.isArray(a.platforms) ? chalk.dim(`  [${a.platforms.join(', ')}]`) : '';
      console.log(`  ${chalk.bold(String(name).padEnd(28))} ${chalk.dim(id)}${platforms}`);
    }
  });
