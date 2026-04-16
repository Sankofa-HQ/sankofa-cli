import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadGlobalConfig } from '../utils/config.js';

type CheckResult = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
};

function readPackageJson(dir: string): any | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name === name) {
        return join(entry.parentPath || entry.path || dir, entry.name);
      }
    }
  } catch { /* ignore */ }
  return null;
}

export const checkCommand = new Command('check')
  .description('Verify that a Sankofa module is fully configured and ready to use');

checkCommand
  .command('deploy')
  .description('Verify the full Deploy setup: SDK, native wiring, credentials, and server connectivity')
  .option('--project <path>', 'React Native app directory (defaults to cwd)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const cwd = opts.project || process.cwd();
    const results: CheckResult[] = [];
    const global = loadGlobalConfig();

    console.log('');
    console.log(chalk.bold('  Sankofa Deploy — Configuration Check'));
    console.log(chalk.dim('  ─────────────────────────────────────'));
    console.log('');

    // ── 1. SDK installed ──
    const pkg = readPackageJson(cwd);
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
    results.push(
      deps['sankofa-react-native']
        ? { name: 'SDK installed', status: 'ok', detail: `sankofa-react-native@${deps['sankofa-react-native']}` }
        : { name: 'SDK installed', status: 'fail', detail: 'sankofa-react-native not found in dependencies', fix: 'npx expo install sankofa-react-native' },
    );

    // ── 2. .sankofa.json exists ──
    const sankofaJson = join(cwd, '.sankofa.json');
    if (existsSync(sankofaJson)) {
      try {
        const cfg = JSON.parse(readFileSync(sankofaJson, 'utf-8'));
        if (cfg.projectId) {
          results.push({ name: 'Project config (.sankofa.json)', status: 'ok', detail: `project ${cfg.projectId}, env ${cfg.environment || 'live'}` });
        } else {
          results.push({ name: 'Project config (.sankofa.json)', status: 'warn', detail: 'projectId is empty', fix: 'sankofa init --project-id <id>' });
        }
      } catch {
        results.push({ name: 'Project config (.sankofa.json)', status: 'fail', detail: 'file exists but is not valid JSON', fix: 'sankofa init --force' });
      }
    } else {
      results.push({ name: 'Project config (.sankofa.json)', status: 'fail', detail: 'not found', fix: 'sankofa init' });
    }

    // ── 3. Credentials ──
    const token = global.token || process.env.SANKOFA_DEPLOY_TOKEN;
    const projectId = global.projectId || process.env.SANKOFA_PROJECT_ID;
    if (token && projectId) {
      results.push({ name: 'CLI credentials', status: 'ok', detail: `project ${projectId}` });
    } else if (token && !projectId) {
      results.push({ name: 'CLI credentials', status: 'warn', detail: 'logged in but no project selected', fix: 'sankofa switch' });
    } else {
      results.push({ name: 'CLI credentials', status: 'fail', detail: 'not logged in', fix: 'sankofa login' });
    }

    // ── 4. Expo config plugin OR native patching ──
    const appJsonPath = join(cwd, 'app.json');
    const hasExpoKey = existsSync(appJsonPath) && (() => {
      try { return !!JSON.parse(readFileSync(appJsonPath, 'utf-8'))?.expo; } catch { return false; }
    })();

    if (hasExpoKey) {
      // Check Expo plugin
      try {
        const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
        const plugins: any[] = raw?.expo?.plugins || [];
        const hasPlugin = plugins.some((p: any) => (typeof p === 'string' ? p : p?.[0]) === 'sankofa-react-native');
        results.push(
          hasPlugin
            ? { name: 'Expo config plugin', status: 'ok', detail: 'sankofa-react-native in app.json plugins' }
            : { name: 'Expo config plugin', status: 'fail', detail: 'sankofa-react-native not in app.json plugins', fix: 'sankofa init' },
        );
      } catch {
        results.push({ name: 'Expo config plugin', status: 'fail', detail: 'could not parse app.json', fix: 'Add "sankofa-react-native" to expo.plugins in app.json' });
      }
    }

    // ── 5. Android native wiring ──
    const androidDir = join(cwd, 'android');
    if (existsSync(androidDir)) {
      const mainApp = findFile(androidDir, 'MainApplication.kt');
      if (mainApp) {
        const src = readFileSync(mainApp, 'utf-8');
        if (src.includes('SankofaDeployBundleProvider')) {
          results.push({ name: 'Android bundle provider', status: 'ok', detail: 'SankofaDeployBundleProvider wired in MainApplication.kt' });
        } else {
          results.push({
            name: 'Android bundle provider',
            status: 'fail',
            detail: 'SankofaDeployBundleProvider not found in MainApplication.kt',
            fix: 'sankofa init',
          });
        }
      } else {
        results.push({ name: 'Android bundle provider', status: 'warn', detail: 'MainApplication.kt not found', fix: 'Run npx expo prebuild --platform android' });
      }

      // Check native module is linked (look for sankofa in settings.gradle or build.gradle)
      const settingsGradle = join(androidDir, 'settings.gradle');
      const settingsGradleKts = join(androidDir, 'settings.gradle.kts');
      const settingsFile = existsSync(settingsGradleKts) ? settingsGradleKts : existsSync(settingsGradle) ? settingsGradle : null;
      if (settingsFile) {
        const content = readFileSync(settingsFile, 'utf-8');
        if (content.includes('sankofa') || content.includes('autolinking')) {
          results.push({ name: 'Android native module', status: 'ok', detail: 'linked via autolinking' });
        } else {
          results.push({ name: 'Android native module', status: 'warn', detail: 'sankofa not found in settings.gradle — may still work via autolinking' });
        }
      }
    } else {
      results.push({ name: 'Android setup', status: 'warn', detail: 'android/ directory not found', fix: 'npx expo prebuild --platform android' });
    }

    // ── 6. iOS native wiring ──
    const iosDir = join(cwd, 'ios');
    if (existsSync(iosDir)) {
      const appDelegate = findFile(iosDir, 'AppDelegate.swift');
      if (appDelegate) {
        const src = readFileSync(appDelegate, 'utf-8');
        if (src.includes('sankofaDeployBundleURL') || src.includes('SankofaDeployBundleProvider')) {
          results.push({ name: 'iOS bundle provider', status: 'ok', detail: 'Deploy bundle provider wired in AppDelegate.swift' });
        } else {
          results.push({
            name: 'iOS bundle provider',
            status: 'fail',
            detail: 'Deploy bundle provider not found in AppDelegate.swift',
            fix: 'sankofa init',
          });
        }

        if (src.includes('import SankofaReactNative')) {
          results.push({ name: 'iOS SankofaReactNative import', status: 'ok', detail: 'import present in AppDelegate.swift' });
        } else {
          results.push({ name: 'iOS SankofaReactNative import', status: 'fail', detail: 'missing import SankofaReactNative', fix: 'sankofa init' });
        }
      } else {
        results.push({ name: 'iOS bundle provider', status: 'warn', detail: 'AppDelegate.swift not found', fix: 'npx expo prebuild --platform ios' });
      }

      // Check Podfile has sankofa
      const podfile = join(iosDir, 'Podfile');
      if (existsSync(podfile)) {
        const content = readFileSync(podfile, 'utf-8');
        results.push(
          content.includes('sankofa') || content.includes('use_expo_modules')
            ? { name: 'iOS CocoaPods', status: 'ok', detail: 'Sankofa referenced in Podfile' }
            : { name: 'iOS CocoaPods', status: 'warn', detail: 'sankofa not found in Podfile — may still link via autolinking' },
        );
      }
    } else {
      results.push({ name: 'iOS setup', status: 'warn', detail: 'ios/ directory not found', fix: 'npx expo prebuild --platform ios' });
    }

    // ── 7. SDK initialization in source code ──
    const entryFiles = [
      join(cwd, 'app', '_layout.tsx'),
      join(cwd, 'app', '_layout.js'),
      join(cwd, 'App.tsx'),
      join(cwd, 'App.js'),
      join(cwd, 'src', 'App.tsx'),
      join(cwd, 'src', 'App.js'),
      join(cwd, 'index.tsx'),
      join(cwd, 'index.js'),
    ];
    let foundInit = false;
    let foundNotifyReady = false;
    let foundCheckUpdate = false;
    let entryFile = '';
    for (const f of entryFiles) {
      if (existsSync(f)) {
        const src = readFileSync(f, 'utf-8');
        if (src.includes('SankofaDeploy') || src.includes('sankofa-react-native')) {
          entryFile = f;
          foundInit = true;
          foundNotifyReady = src.includes('notifyAppReady');
          foundCheckUpdate = src.includes('checkForUpdate');
          break;
        }
      }
    }

    if (foundInit) {
      results.push({ name: 'SDK initialization', status: 'ok', detail: entryFile.replace(cwd + '/', '') });
    } else {
      results.push({
        name: 'SDK initialization',
        status: 'fail',
        detail: 'SankofaDeploy not found in any entry file',
        fix: 'Add SankofaDeploy initialization to your root layout — see Quick Start in the dashboard',
      });
    }

    if (foundInit && !foundNotifyReady) {
      results.push({
        name: 'notifyAppReady()',
        status: 'warn',
        detail: 'deploy.notifyAppReady() not found — without it, the SDK may false-rollback on slow boots',
        fix: 'Add deploy.notifyAppReady() early in your root component',
      });
    } else if (foundNotifyReady) {
      results.push({ name: 'notifyAppReady()', status: 'ok', detail: 'health confirmation present' });
    }

    if (foundInit && !foundCheckUpdate) {
      results.push({
        name: 'checkForUpdate()',
        status: 'warn',
        detail: 'deploy.checkForUpdate() not found — updates will not be checked automatically',
        fix: 'Add deploy.checkForUpdate() after initialization',
      });
    } else if (foundCheckUpdate) {
      results.push({ name: 'checkForUpdate()', status: 'ok', detail: 'update check present' });
    }

    // ── 8. .gitignore coverage ──
    const gitignorePath = join(cwd, '.gitignore');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (content.includes('.sankofa.json')) {
        results.push({ name: '.gitignore', status: 'ok', detail: '.sankofa.json is ignored' });
      } else {
        results.push({ name: '.gitignore', status: 'warn', detail: '.sankofa.json not in .gitignore — credentials may be committed', fix: 'sankofa init' });
      }
    } else {
      results.push({ name: '.gitignore', status: 'warn', detail: 'no .gitignore found', fix: 'sankofa init' });
    }

    // ── 9. Server reachability ──
    const endpoint = process.env.SANKOFA_ENDPOINT || global.endpoint;
    if (endpoint) {
      try {
        // Use the deploy check endpoint (no auth required, returns 400 for missing params — that's fine, it proves the server is alive)
        const res = await fetch(`${endpoint}/api/deploy/check`, { method: 'GET', signal: AbortSignal.timeout(5000) });
        results.push(
          res.status < 500
            ? { name: 'Server reachable', status: 'ok', detail: `${endpoint} — responding` }
            : { name: 'Server reachable', status: 'warn', detail: `${endpoint} responded ${res.status}` },
        );
      } catch (err: any) {
        results.push({ name: 'Server reachable', status: 'fail', detail: `${endpoint} — ${err.message}`, fix: 'Check your network connection or endpoint URL' });
      }
    } else {
      results.push({ name: 'Server reachable', status: 'warn', detail: 'no endpoint configured', fix: 'sankofa init --endpoint <url>' });
    }

    // ── 10. Deploy token validity (if we have one, try a test call) ──
    if (token && projectId && endpoint) {
      try {
        const res = await fetch(`${endpoint}/api/v1/deploy/stats?projectId=${projectId}&environment=live`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'x-project-id': projectId,
          },
          signal: AbortSignal.timeout(5000),
        });
        results.push(
          res.ok
            ? { name: 'Deploy API access', status: 'ok', detail: 'authenticated and project accessible' }
            : { name: 'Deploy API access', status: 'fail', detail: `server returned ${res.status}`, fix: 'sankofa login' },
        );
      } catch (err: any) {
        results.push({ name: 'Deploy API access', status: 'warn', detail: `could not verify: ${err.message}` });
      }
    }

    // ── Print results ──
    const pad = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
      const icon = r.status === 'ok' ? chalk.green('✓') : r.status === 'warn' ? chalk.yellow('!') : chalk.red('✖');
      const tone = r.status === 'ok' ? chalk.dim : r.status === 'warn' ? chalk.yellow : chalk.red;
      console.log(`  ${icon} ${r.name.padEnd(pad)}   ${tone(r.detail)}`);
      if (r.fix && r.status !== 'ok') {
        console.log(`  ${' '.repeat(pad + 4)}${chalk.cyan(`→ ${r.fix}`)}`);
      }
    }

    const failed = results.filter((r) => r.status === 'fail');
    const warned = results.filter((r) => r.status === 'warn');
    const passed = results.filter((r) => r.status === 'ok');
    console.log('');

    if (failed.length === 0 && warned.length === 0) {
      console.log(chalk.green.bold('  ✓ Deploy is fully configured and ready to ship!'));
    } else if (failed.length === 0) {
      console.log(chalk.green.bold(`  ${passed.length} passed`) + chalk.yellow(`, ${warned.length} warning(s) — deploy will work but check the warnings above.`));
    } else {
      console.log(chalk.red.bold(`  ${failed.length} issue(s) must be fixed`) + chalk.dim(` before Deploy will work. ${warned.length} warning(s).`));
      console.log('');
      console.log(chalk.dim('  Run ') + chalk.cyan('sankofa init') + chalk.dim(' to auto-fix most issues, or follow the → suggestions above.'));
    }
    console.log('');
  });
