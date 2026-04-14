import { Command } from 'commander';
import { createServer } from 'http';
import { hostname, userInfo } from 'os';
import { saveGlobalConfig, saveProjectConfig } from '../utils/config.js';
import { createDeployToken } from '../utils/api.js';

export const loginCommand = new Command('login')
  .description('Authenticate with your Sankofa account via browser')
  .option('--deploy-token <token>', 'Authenticate directly with a Deploy Token (for CI/CD)')
  .option('--project-id <id>', 'Project ID for Deploy Token auth')
  .option('--api-key <key>', 'Deprecated. SDK API keys cannot publish releases')
  .option('--endpoint <url>', 'Sankofa API endpoint (default: https://api.sankofa.dev)')
  .option('--project', 'Save to .sankofa.json in the current project instead of global config')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;
    let endpoint = opts.endpoint || 'https://api.sankofa.dev';

    // ── CI/CD mode: direct Deploy Token ──
    if (opts.deployToken) {
      if (!opts.deployToken.startsWith('sk_deploy_')) {
        console.error(chalk.red('Deploy Tokens must start with sk_deploy_.'));
        process.exit(1);
      }

      const projectId = opts.projectId || process.env.SANKOFA_PROJECT_ID;
      if (!projectId) {
        console.error(chalk.red('Project ID is required. Pass --project-id <id> or set SANKOFA_PROJECT_ID.'));
        process.exit(1);
      }

      const spinner = ora('Validating Deploy Token...').start();
      try {
        const headers = {
          'Authorization': `Bearer ${opts.deployToken}`,
          'x-project-id': projectId,
        };
        const tryValidate = async (environment: 'live' | 'test') => {
          const params = new URLSearchParams({ projectId, environment });
          return fetch(`${endpoint}/api/v1/deploy/releases?${params}`, { headers });
        };
        let validatedEnvironment: 'live' | 'test' = 'live';
        let res = await tryValidate('live');
        if (!res.ok) {
          res = await tryValidate('test');
          if (res.ok) validatedEnvironment = 'test';
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          spinner.fail(err.error || `Deploy Token validation failed (${res.status})`);
          process.exit(1);
        }

        const config = {
          token: opts.deployToken,
          authType: 'deploy_token' as const,
          endpoint,
          projectId,
          environment: validatedEnvironment,
        };
        if (opts.project) {
          saveProjectConfig(config);
          spinner.succeed('Deploy Token saved to .sankofa.json');
        } else {
          saveGlobalConfig(config);
          spinner.succeed('Deploy Token saved to ~/.sankofa/credentials.json');
        }
      } catch (err: any) {
        spinner.fail(`Connection failed: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    // ── Deprecated SDK API key flow ──
    if (opts.apiKey) {
      if (!opts.apiKey.startsWith('sk_live_') && !opts.apiKey.startsWith('sk_test_')) {
        console.error(chalk.red('--api-key is deprecated for publishing. Use --deploy-token <sk_deploy_...> instead.'));
        process.exit(1);
      }

      const spinner = ora('Validating SDK API key...').start();
      try {
        const res = await fetch(`${endpoint}/api/v1/handshake`, {
          headers: { 'x-api-key': opts.apiKey },
        });
        if (!res.ok) {
          spinner.fail('Invalid API key');
          process.exit(1);
        }
        await res.json() as any;
        spinner.fail('This is an app runtime SDK key. Publishing releases requires a Deploy Token (sk_deploy_...).');
        console.log(chalk.dim('  Create a Deploy Token in Deploy Settings or run browser login with an Editor account.'));
        process.exit(1);
      } catch (err: any) {
        spinner.fail(`Connection failed: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    // ── Interactive mode: browser-based login ──
    const inquirer = (await import('inquirer')).default;

    // Ask for endpoint first
    const { endpointAnswer } = await inquirer.prompt([{
      type: 'input',
      name: 'endpointAnswer',
      message: 'Sankofa API endpoint:',
      default: endpoint,
    }]);
    endpoint = endpointAnswer;

    // Start a temporary local server to receive the auth callback
    const port = 9876;
    let resolveToken: (token: string) => void;
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const token = url.searchParams.get('token');
      const apiKey = url.searchParams.get('api_key');

      if (token || apiKey) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0f; color: #fff;">
              <div style="text-align: center;">
                <h1 style="font-size: 24px; margin-bottom: 8px;">Authenticated!</h1>
                <p style="color: #888;">You can close this tab and return to your terminal.</p>
              </div>
            </body>
          </html>
        `);
        resolveToken(token || apiKey || '');
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing token');
      }
    });

    server.listen(port, () => {
      const loginUrl = `${endpoint}/cli-auth?callback=http://localhost:${port}/callback`;

      console.log('');
      console.log(chalk.bold('  Open this URL in your browser to log in:'));
      console.log('');
      console.log(chalk.cyan(`  ${loginUrl}`));
      console.log('');
      console.log(chalk.dim('  Waiting for authentication...'));
      console.log('');

      // Try to open the browser automatically
      import('child_process').then(({ exec }) => {
        const cmd = process.platform === 'darwin' ? 'open' :
                    process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} "${loginUrl}"`);
      }).catch(() => {});
    });

    // Wait for the callback (timeout after 5 minutes)
    const timeout = setTimeout(() => {
      console.log(chalk.red('\n  Login timed out. Please try again.'));
      server.close();
      process.exit(1);
    }, 5 * 60 * 1000);

    const receivedToken = await tokenPromise;
    clearTimeout(timeout);
    server.close();

    if (!receivedToken) {
      console.log(chalk.red('  No token received.'));
      process.exit(1);
    }

    // Validate and fetch user info + projects
    const spinner = ora('Validating...').start();
    try {
      const meRes = await fetch(`${endpoint}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${receivedToken}` },
      });
      if (!meRes.ok) {
        spinner.fail('Authentication failed');
        process.exit(1);
      }
      const meData = await meRes.json() as any;
      spinner.succeed(`Logged in as ${chalk.bold(meData.user?.email || 'user')}`);

      // Get the user's orgs and projects
      const orgMemberships = meData.org_memberships || [];
      if (orgMemberships.length === 0) {
        console.log(chalk.yellow('  No organizations found. Create one in the dashboard first.'));
        saveGlobalConfig({ apiKey: receivedToken, endpoint });
        return;
      }

      // Pick org (auto if only one)
      let selectedOrg = orgMemberships[0];
      if (orgMemberships.length > 1) {
        const { orgChoice } = await inquirer.prompt([{
          type: 'list',
          name: 'orgChoice',
          message: 'Select organization:',
          choices: orgMemberships.map((m: any) => ({
            name: m.organization?.name || m.organization_id,
            value: m,
          })),
        }]);
        selectedOrg = orgChoice;
      } else {
        console.log(chalk.dim(`  Organization: ${selectedOrg.organization?.name || selectedOrg.organization_id}`));
      }

      // Fetch projects for this org
      const projRes = await fetch(`${endpoint}/api/projects?org_id=${selectedOrg.organization_id}`, {
        headers: { 'Authorization': `Bearer ${receivedToken}` },
      });
      const projects = projRes.ok ? await projRes.json() as any[] : [];

      if (!projects || projects.length === 0) {
        console.log(chalk.yellow('  No projects found. Create one in the dashboard first.'));
        saveGlobalConfig({ apiKey: receivedToken, endpoint });
        return;
      }

      // Pick project (auto if only one)
      let selectedProject: any;
      if (projects.length === 1) {
        selectedProject = projects[0];
        console.log(chalk.dim(`  Project: ${selectedProject.name}`));
      } else {
        const { projChoice } = await inquirer.prompt([{
          type: 'list',
          name: 'projChoice',
          message: 'Select project:',
          choices: projects.map((p: any) => ({
            name: `${p.name} (${p.id})`,
            value: p,
          })),
        }]);
        selectedProject = projChoice;
      }

      const tokenSpinner = ora('Creating local Deploy Token...').start();
      const tokenName = `local ${userInfo().username}@${hostname()}`;
      const tokenResponse = await createDeployToken(endpoint, receivedToken, selectedProject.id, tokenName);
      tokenSpinner.succeed('Deploy Token created');

      // Save deploy credentials with project ID
      const config = {
        token: tokenResponse.token,
        authType: 'deploy_token' as const,
        endpoint,
        projectId: selectedProject.id,
        environment: selectedProject.environment === 'test' ? 'test' as const : 'live' as const,
      };

      if (opts.project) {
        saveProjectConfig(config);
        console.log(chalk.dim('  Saved to .sankofa.json'));
      } else {
        saveGlobalConfig(config);
        console.log(chalk.dim('  Saved to ~/.sankofa/credentials.json'));
      }

      console.log('');
      console.log(chalk.green.bold('  Ready to deploy!'));
      console.log(chalk.dim(`  Run ${chalk.cyan('sankofa status')} to check releases.`));
      console.log('');
    } catch (err: any) {
      spinner.fail(`Validation failed: ${err.message}`);
      process.exit(1);
    }
  });
