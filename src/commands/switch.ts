import { Command } from 'commander';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createDeployToken } from '../utils/api.js';
import { loadGlobalConfig, saveGlobalConfig } from '../utils/config.js';

const PROJECT_FILE = '.sankofa.json';

/**
 * Switch to a different Sankofa project.
 *
 * Uses the session JWT stored by `sankofa login` to list projects and mint
 * a fresh Deploy Token for the chosen one — no browser round-trip required.
 * If the JWT is missing or expired, we fall back to the full browser login
 * flow so the user still ends up on the new project in one command.
 */
export const switchCommand = new Command('switch')
  .description('Switch to a different Sankofa project (reuses the stored session when possible)')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    const inquirer = (await import('inquirer')).default;

    // Always clear the stale project-scoped file first; the rest of the flow
    // will overwrite the global creds with the newly-selected project.
    const localPath = join(process.cwd(), PROJECT_FILE);
    if (existsSync(localPath)) {
      try {
        rmSync(localPath, { force: true });
        console.log(chalk.dim(`  Removed ${localPath}`));
      } catch (err: any) {
        console.error(chalk.red(`  Failed to remove ${localPath}: ${err.message}`));
        process.exit(1);
      }
    }

    const global = loadGlobalConfig();
    const endpoint = global.endpoint;
    const jwt = global.sessionJwt;

    if (!endpoint || !jwt) {
      console.log(chalk.dim('  No active session found. Starting browser login...'));
      console.log('');
      const { loginCommand } = await import('./login.js');
      await loginCommand.parseAsync([], { from: 'user' });
      return;
    }

    // 1. Validate JWT by calling /api/auth/me.
    const meSpinner = ora('Validating session...').start();
    let me: any;
    try {
      const res = await fetch(`${endpoint}/api/auth/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        meSpinner.warn('Stored session is no longer valid — re-authenticating');
        const { loginCommand } = await import('./login.js');
        await loginCommand.parseAsync([], { from: 'user' });
        return;
      }
      me = await res.json();
      meSpinner.succeed(`Logged in as ${chalk.bold(me.user?.email || 'user')}`);
    } catch (err: any) {
      meSpinner.fail(`Could not reach ${endpoint}: ${err.message}`);
      process.exit(1);
    }

    // 2. Pick org.
    const orgMemberships = me.org_memberships || [];
    if (orgMemberships.length === 0) {
      console.log(chalk.yellow('  No organizations found. Create one in the dashboard first.'));
      process.exit(1);
    }
    let selectedOrg = orgMemberships[0];
    if (orgMemberships.length > 1) {
      const { orgChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'orgChoice',
          message: 'Select organization:',
          choices: orgMemberships.map((m: any) => ({
            name: m.organization?.name || m.organization_id,
            value: m,
          })),
        },
      ]);
      selectedOrg = orgChoice;
    } else {
      console.log(chalk.dim(`  Organization: ${selectedOrg.organization?.name || selectedOrg.organization_id}`));
    }

    // 3. Pick project.
    const projSpinner = ora('Loading projects...').start();
    let projects: any[];
    try {
      const res = await fetch(`${endpoint}/api/projects?org_id=${selectedOrg.organization_id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      projects = res.ok ? ((await res.json()) as any[]) : [];
      projSpinner.succeed(`Found ${projects.length} project(s)`);
    } catch (err: any) {
      projSpinner.fail(`Failed to list projects: ${err.message}`);
      process.exit(1);
    }
    if (!projects || projects.length === 0) {
      console.log(chalk.yellow('  No projects in this organization.'));
      process.exit(1);
    }

    const currentProjectId = global.projectId;
    const { selectedProject } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedProject',
        message: 'Select project:',
        default: currentProjectId ? projects.find((p: any) => p.id === currentProjectId) : undefined,
        choices: projects.map((p: any) => ({
          name: `${p.name}${p.id === currentProjectId ? chalk.dim(' (current)') : ''} — ${chalk.dim(p.id)}`,
          value: p,
        })),
      },
    ]);

    if (selectedProject.id === currentProjectId && global.token) {
      console.log(chalk.dim('  Already on this project — nothing to do.'));
      return;
    }

    // 4. Mint a fresh Deploy Token for the new project.
    const tokenSpinner = ora('Minting Deploy Token for new project...').start();
    try {
      const { hostname, userInfo } = await import('os');
      const tokenName = `local ${userInfo().username}@${hostname()}`;
      const tokenResponse = await createDeployToken(endpoint, jwt, selectedProject.id, tokenName);
      tokenSpinner.succeed('Deploy Token minted');

      saveGlobalConfig({
        token: tokenResponse.token,
        authType: 'deploy_token',
        endpoint,
        projectId: selectedProject.id,
        environment: selectedProject.environment === 'test' ? 'test' : 'live',
        sessionJwt: jwt,
      });

      console.log('');
      console.log(chalk.green.bold(`  Switched to ${selectedProject.name}`));
      console.log(chalk.dim(`  Project ID: ${selectedProject.id}`));
      console.log(chalk.dim(`  Run ${chalk.cyan('sankofa status')} to verify.`));
      console.log('');
    } catch (err: any) {
      tokenSpinner.fail(`Failed to mint Deploy Token: ${err.message}`);
      process.exit(1);
    }
  });
