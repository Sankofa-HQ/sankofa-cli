import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadGlobalConfig, findProjectConfig } from '../utils/config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckResult = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
};

type Platform = 'react-native' | 'flutter' | 'web' | 'ios' | 'android' | 'unknown';

type ProjectContext = {
  cwd: string;
  platform: Platform;
  pkg: any | null;            // package.json
  pubspec: any | null;        // pubspec.yaml
  deps: Record<string, string>;
  global: ReturnType<typeof loadGlobalConfig>;
  endpoint: string;
  token: string;
  apiKey: string;
  projectId: string;
  chalk: any;
};

// ── Shared Utilities ──────────────────────────────────────────────────────────

function readPackageJson(dir: string): any | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function readPubspec(dir: string): any | null {
  const p = join(dir, 'pubspec.yaml');
  if (!existsSync(p)) return null;
  try {
    // Simple YAML key:value parser — enough for dependency checks
    const raw = readFileSync(p, 'utf-8');
    return { _raw: raw };
  } catch { return null; }
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

function findFileContaining(dir: string, ext: string, needle: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        const fullPath = join(entry.parentPath || entry.path || dir, entry.name);
        try {
          if (readFileSync(fullPath, 'utf-8').includes(needle)) return fullPath;
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* ignore */ }
  return null;
}

function detectPlatform(cwd: string): Platform {
  const pkg = readPackageJson(cwd);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  if (deps['react-native'] || deps['expo']) return 'react-native';
  if (existsSync(join(cwd, 'pubspec.yaml'))) return 'flutter';
  if (deps['next'] || deps['nuxt'] || deps['vite'] || deps['webpack'] || deps['react'] || deps['vue'] || deps['svelte'] || deps['angular']) return 'web';
  if (existsSync(join(cwd, 'Package.swift')) || existsSync(join(cwd, `${cwd.split('/').pop()}.xcodeproj`))) return 'ios';
  if (existsSync(join(cwd, 'app', 'build.gradle')) || existsSync(join(cwd, 'app', 'build.gradle.kts'))) return 'android';
  return 'unknown';
}

function buildContext(cwd: string, chalk: any): ProjectContext {
  const pkg = readPackageJson(cwd);
  const pubspec = readPubspec(cwd);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const global = loadGlobalConfig();
  const project = findProjectConfig();
  return {
    cwd,
    platform: detectPlatform(cwd),
    pkg,
    pubspec,
    deps,
    global,
    endpoint: process.env.SANKOFA_ENDPOINT || project?.endpoint || global.endpoint || '',
    token: global.token || process.env.SANKOFA_DEPLOY_TOKEN || '',
    apiKey: project?.apiKey || global.apiKey || '',
    projectId: project?.projectId || global.projectId || process.env.SANKOFA_PROJECT_ID || '',
    chalk,
  };
}

function printResults(results: CheckResult[], chalk: any, moduleName: string) {
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
    console.log(chalk.green.bold(`  ✓ ${moduleName} is fully configured and ready!`));
  } else if (failed.length === 0) {
    console.log(chalk.green.bold(`  ${passed.length} passed`) + chalk.yellow(`, ${warned.length} warning(s) — ${moduleName.toLowerCase()} will work but check the warnings above.`));
  } else {
    console.log(chalk.red.bold(`  ${failed.length} issue(s) must be fixed`) + chalk.dim(` before ${moduleName} will work. ${warned.length} warning(s).`));
    console.log('');
    console.log(chalk.dim('  Run ') + chalk.cyan('sankofa init') + chalk.dim(' to auto-fix most issues, or follow the → suggestions above.'));
  }
  console.log('');
}

// ── Shared Checks ─────────────────────────────────────────────────────────────

function checkCredentials(ctx: ProjectContext): CheckResult[] {
  const results: CheckResult[] = [];

  // .sankofa.json
  const sankofaJson = join(ctx.cwd, '.sankofa.json');
  if (existsSync(sankofaJson)) {
    try {
      const cfg = JSON.parse(readFileSync(sankofaJson, 'utf-8'));
      results.push(cfg.projectId
        ? { name: 'Project config', status: 'ok', detail: `project ${cfg.projectId}, env ${cfg.environment || 'live'}` }
        : { name: 'Project config', status: 'warn', detail: 'projectId is empty', fix: 'sankofa init --project-id <id>' });
    } catch {
      results.push({ name: 'Project config', status: 'fail', detail: '.sankofa.json is not valid JSON', fix: 'sankofa init --force' });
    }
  } else {
    results.push({ name: 'Project config', status: 'fail', detail: '.sankofa.json not found', fix: 'sankofa init' });
  }

  // CLI auth
  if (ctx.token && ctx.projectId) {
    results.push({ name: 'CLI credentials', status: 'ok', detail: `project ${ctx.projectId}` });
  } else if (ctx.token) {
    results.push({ name: 'CLI credentials', status: 'warn', detail: 'logged in but no project selected', fix: 'sankofa switch' });
  } else {
    results.push({ name: 'CLI credentials', status: 'fail', detail: 'not logged in', fix: 'sankofa login' });
  }

  return results;
}

async function checkServer(ctx: ProjectContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  if (!ctx.endpoint) {
    results.push({ name: 'Server reachable', status: 'warn', detail: 'no endpoint configured', fix: 'sankofa init --endpoint <url>' });
    return results;
  }

  try {
    const res = await fetch(`${ctx.endpoint}/api/deploy/check`, { method: 'GET', signal: AbortSignal.timeout(5000) });
    results.push(res.status < 500
      ? { name: 'Server reachable', status: 'ok', detail: `${ctx.endpoint} — responding` }
      : { name: 'Server reachable', status: 'warn', detail: `${ctx.endpoint} responded ${res.status}` });
  } catch (err: any) {
    results.push({ name: 'Server reachable', status: 'fail', detail: `${ctx.endpoint} — ${err.message}`, fix: 'Check your network connection or endpoint URL' });
  }

  return results;
}

// ── Analytics Checks ──────────────────────────────────────────────────────────

function checkAnalyticsReactNative(ctx: ProjectContext): CheckResult[] {
  const results: CheckResult[] = [];

  // SDK installed
  results.push(ctx.deps['sankofa-react-native']
    ? { name: 'SDK installed', status: 'ok', detail: `sankofa-react-native@${ctx.deps['sankofa-react-native']}` }
    : { name: 'SDK installed', status: 'fail', detail: 'sankofa-react-native not in dependencies', fix: 'npx expo install sankofa-react-native' });

  // Initialization
  const entryFiles = ['app/_layout.tsx', 'app/_layout.js', 'App.tsx', 'App.js', 'src/App.tsx', 'index.tsx', 'index.js'];
  let initFile = '';
  let src = '';
  for (const f of entryFiles) {
    const full = join(ctx.cwd, f);
    if (existsSync(full)) {
      const content = readFileSync(full, 'utf-8');
      if (content.includes('Sankofa.initialize') || content.includes('sankofa-react-native')) {
        initFile = f;
        src = content;
        break;
      }
    }
  }

  results.push(initFile
    ? { name: 'Sankofa.initialize()', status: 'ok', detail: initFile }
    : { name: 'Sankofa.initialize()', status: 'fail', detail: 'not found in any entry file', fix: "Add Sankofa.initialize('YOUR_API_KEY', { endpoint: '...' }) to your root layout" });

  // API key check
  if (src) {
    const hasApiKey = src.match(/initialize\(\s*['"][^'"]+['"]/);
    if (hasApiKey) {
      const key = hasApiKey[0].match(/['"]([^'"]+)['"]/)?.[1] || '';
      if (key.startsWith('sk_test_')) {
        results.push({ name: 'API key', status: 'warn', detail: `using test key (${key.slice(0, 16)}...)`, fix: 'Switch to a live key before shipping to production' });
      } else if (key.startsWith('sk_live_')) {
        results.push({ name: 'API key', status: 'ok', detail: 'live key configured' });
      } else if (key === 'YOUR_API_KEY') {
        results.push({ name: 'API key', status: 'fail', detail: 'placeholder API key — replace with your actual key', fix: 'Get your API key from the dashboard → Project Settings' });
      } else {
        results.push({ name: 'API key', status: 'ok', detail: `key configured (${key.slice(0, 12)}...)` });
      }
    }
  }

  // Session replay
  if (src) {
    results.push(src.includes('recordSessions')
      ? { name: 'Session Replay', status: 'ok', detail: 'recordSessions configured' }
      : { name: 'Session Replay', status: 'warn', detail: 'recordSessions not set — defaults to true', fix: 'Add recordSessions: true/false to your initialize config' });
  }

  // Screen tracking
  if (src || initFile) {
    const usesHook = findFileContaining(join(ctx.cwd, 'app'), '.tsx', 'useSankofaScreen')
      || findFileContaining(join(ctx.cwd, 'src'), '.tsx', 'useSankofaScreen');
    const usesScreen = findFileContaining(join(ctx.cwd, 'app'), '.tsx', 'Sankofa.screen')
      || findFileContaining(join(ctx.cwd, 'src'), '.tsx', 'Sankofa.screen');
    if (usesHook) {
      results.push({ name: 'Screen tracking', status: 'ok', detail: `useSankofaScreen() found in ${usesHook.replace(ctx.cwd + '/', '')}` });
    } else if (usesScreen) {
      results.push({ name: 'Screen tracking', status: 'ok', detail: `Sankofa.screen() found in ${usesScreen.replace(ctx.cwd + '/', '')}` });
    } else {
      results.push({ name: 'Screen tracking', status: 'warn', detail: 'no useSankofaScreen() or Sankofa.screen() calls found', fix: 'Add useSankofaScreen("ScreenName") to your screen components for heatmaps and funnels' });
    }
  }

  // Event tracking
  const usesTrack = findFileContaining(join(ctx.cwd, 'app'), '.tsx', 'Sankofa.track')
    || findFileContaining(join(ctx.cwd, 'src'), '.tsx', 'Sankofa.track')
    || findFileContaining(join(ctx.cwd, 'app'), '.ts', 'Sankofa.track');
  results.push(usesTrack
    ? { name: 'Event tracking', status: 'ok', detail: `Sankofa.track() found in ${usesTrack.replace(ctx.cwd + '/', '')}` }
    : { name: 'Event tracking', status: 'warn', detail: 'no Sankofa.track() calls found', fix: 'Add Sankofa.track("event_name") to track custom events' });

  return results;
}

function checkAnalyticsFlutter(ctx: ProjectContext): CheckResult[] {
  const results: CheckResult[] = [];
  const raw = ctx.pubspec?._raw || '';

  // SDK installed
  results.push(raw.includes('sankofa_flutter')
    ? { name: 'SDK installed', status: 'ok', detail: 'sankofa_flutter in pubspec.yaml' }
    : { name: 'SDK installed', status: 'fail', detail: 'sankofa_flutter not in pubspec.yaml', fix: 'flutter pub add sankofa_flutter' });

  // Initialization — search lib/ for Sankofa.instance.init
  const libDir = join(ctx.cwd, 'lib');
  const initFile = findFileContaining(libDir, '.dart', 'Sankofa.instance.init');
  results.push(initFile
    ? { name: 'Sankofa.instance.init()', status: 'ok', detail: initFile.replace(ctx.cwd + '/', '') }
    : { name: 'Sankofa.instance.init()', status: 'fail', detail: 'not found in lib/', fix: "Add Sankofa.instance.init(apiKey: 'YOUR_API_KEY', endpoint: '...') to your main.dart" });

  // API key
  if (initFile) {
    const src = readFileSync(initFile, 'utf-8');
    if (src.includes("apiKey: 'sk_test_") || src.includes('apiKey: "sk_test_')) {
      results.push({ name: 'API key', status: 'warn', detail: 'using test key', fix: 'Switch to a live key before shipping to production' });
    } else if (src.includes("apiKey: 'YOUR_API_KEY") || src.includes('apiKey: "YOUR_API_KEY')) {
      results.push({ name: 'API key', status: 'fail', detail: 'placeholder API key', fix: 'Get your API key from the dashboard → Project Settings' });
    } else {
      results.push({ name: 'API key', status: 'ok', detail: 'API key configured' });
    }

    // Session replay
    results.push(src.includes('enableSessionReplay')
      ? { name: 'Session Replay', status: 'ok', detail: 'enableSessionReplay configured' }
      : { name: 'Session Replay', status: 'warn', detail: 'enableSessionReplay not set — defaults to true' });
  }

  // Screen tracking
  const usesScreen = findFileContaining(libDir, '.dart', '.screen(');
  const usesObserver = findFileContaining(libDir, '.dart', 'SankofaNavigatorObserver');
  if (usesObserver) {
    results.push({ name: 'Screen tracking', status: 'ok', detail: `SankofaNavigatorObserver in ${usesObserver.replace(ctx.cwd + '/', '')}` });
  } else if (usesScreen) {
    results.push({ name: 'Screen tracking', status: 'ok', detail: `screen() found in ${usesScreen.replace(ctx.cwd + '/', '')}` });
  } else {
    results.push({ name: 'Screen tracking', status: 'warn', detail: 'no screen tracking found', fix: 'Add SankofaNavigatorObserver to your MaterialApp or call Sankofa.instance.screen() manually' });
  }

  // Event tracking
  const usesTrack = findFileContaining(libDir, '.dart', '.track(');
  results.push(usesTrack
    ? { name: 'Event tracking', status: 'ok', detail: `track() found in ${usesTrack.replace(ctx.cwd + '/', '')}` }
    : { name: 'Event tracking', status: 'warn', detail: 'no track() calls found', fix: "Add Sankofa.instance.track('event_name') to track custom events" });

  // User identification
  const usesIdentify = findFileContaining(libDir, '.dart', '.identify(');
  results.push(usesIdentify
    ? { name: 'User identification', status: 'ok', detail: `identify() found in ${usesIdentify.replace(ctx.cwd + '/', '')}` }
    : { name: 'User identification', status: 'warn', detail: 'no identify() calls found', fix: "Add Sankofa.instance.identify(userId) after login to link events to users" });

  return results;
}

function checkAnalyticsWeb(ctx: ProjectContext): CheckResult[] {
  const results: CheckResult[] = [];

  // Check for web SDK
  const webSdk = ctx.deps['sankofa-js'] || ctx.deps['@sankofa/web'] || ctx.deps['@sankofa/browser'];
  results.push(webSdk
    ? { name: 'SDK installed', status: 'ok', detail: `${Object.keys(ctx.deps).find(k => k.includes('sankofa'))}@${webSdk}` }
    : { name: 'SDK installed', status: 'fail', detail: 'no Sankofa web SDK found in dependencies', fix: 'npm install @sankofa/web' });

  // Check for script tag or import
  const srcDirs = ['src', 'app', 'pages', 'public', 'lib'];
  let found = false;
  for (const d of srcDirs) {
    const f = findFileContaining(join(ctx.cwd, d), '.ts', 'sankofa')
      || findFileContaining(join(ctx.cwd, d), '.js', 'sankofa')
      || findFileContaining(join(ctx.cwd, d), '.tsx', 'sankofa')
      || findFileContaining(join(ctx.cwd, d), '.html', 'sankofa');
    if (f) {
      results.push({ name: 'SDK initialization', status: 'ok', detail: f.replace(ctx.cwd + '/', '') });
      found = true;
      break;
    }
  }
  if (!found) {
    results.push({ name: 'SDK initialization', status: 'warn', detail: 'no Sankofa import/script found in source', fix: 'Initialize the Sankofa SDK in your app entry point' });
  }

  return results;
}

// ── Deploy Checks (React Native only) ─────────────────────────────────────────

function checkDeployReactNative(ctx: ProjectContext): CheckResult[] {
  const results: CheckResult[] = [];

  // SDK
  results.push(ctx.deps['sankofa-react-native']
    ? { name: 'SDK installed', status: 'ok', detail: `sankofa-react-native@${ctx.deps['sankofa-react-native']}` }
    : { name: 'SDK installed', status: 'fail', detail: 'sankofa-react-native not in dependencies', fix: 'npx expo install sankofa-react-native' });

  // Expo config plugin
  const appJsonPath = join(ctx.cwd, 'app.json');
  const hasExpoKey = existsSync(appJsonPath) && (() => {
    try { return !!JSON.parse(readFileSync(appJsonPath, 'utf-8'))?.expo; } catch { return false; }
  })();
  if (hasExpoKey) {
    try {
      const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
      const plugins: any[] = raw?.expo?.plugins || [];
      const hasPlugin = plugins.some((p: any) => (typeof p === 'string' ? p : p?.[0]) === 'sankofa-react-native');
      results.push(hasPlugin
        ? { name: 'Expo config plugin', status: 'ok', detail: 'sankofa-react-native in app.json plugins' }
        : { name: 'Expo config plugin', status: 'fail', detail: 'sankofa-react-native not in plugins', fix: 'sankofa init' });
    } catch {
      results.push({ name: 'Expo config plugin', status: 'fail', detail: 'could not parse app.json', fix: 'sankofa init' });
    }
  }

  // Android
  const androidDir = join(ctx.cwd, 'android');
  if (existsSync(androidDir)) {
    const mainApp = findFile(androidDir, 'MainApplication.kt');
    if (mainApp) {
      const src = readFileSync(mainApp, 'utf-8');
      results.push(src.includes('SankofaDeployBundleProvider')
        ? { name: 'Android bundle provider', status: 'ok', detail: 'wired in MainApplication.kt' }
        : { name: 'Android bundle provider', status: 'fail', detail: 'not found in MainApplication.kt', fix: 'sankofa init' });
    } else {
      results.push({ name: 'Android bundle provider', status: 'warn', detail: 'MainApplication.kt not found', fix: 'npx expo prebuild --platform android' });
    }
  } else {
    results.push({ name: 'Android setup', status: 'warn', detail: 'android/ not found', fix: 'npx expo prebuild --platform android' });
  }

  // iOS
  const iosDir = join(ctx.cwd, 'ios');
  if (existsSync(iosDir)) {
    const appDelegate = findFile(iosDir, 'AppDelegate.swift');
    if (appDelegate) {
      const src = readFileSync(appDelegate, 'utf-8');
      results.push((src.includes('sankofaDeployBundleURL') || src.includes('SankofaDeployBundleProvider'))
        ? { name: 'iOS bundle provider', status: 'ok', detail: 'wired in AppDelegate.swift' }
        : { name: 'iOS bundle provider', status: 'fail', detail: 'not found in AppDelegate.swift', fix: 'sankofa init' });
      results.push(src.includes('import SankofaReactNative')
        ? { name: 'iOS SDK import', status: 'ok', detail: 'import present' }
        : { name: 'iOS SDK import', status: 'fail', detail: 'missing import SankofaReactNative', fix: 'sankofa init' });
    } else {
      results.push({ name: 'iOS bundle provider', status: 'warn', detail: 'AppDelegate.swift not found', fix: 'npx expo prebuild --platform ios' });
    }
  } else {
    results.push({ name: 'iOS setup', status: 'warn', detail: 'ios/ not found', fix: 'npx expo prebuild --platform ios' });
  }

  // SDK initialization
  const entryFiles = ['app/_layout.tsx', 'app/_layout.js', 'App.tsx', 'App.js', 'src/App.tsx', 'index.tsx', 'index.js'];
  let initFile = '';
  let src = '';
  for (const f of entryFiles) {
    const full = join(ctx.cwd, f);
    if (existsSync(full)) {
      const content = readFileSync(full, 'utf-8');
      if (content.includes('SankofaDeploy') || content.includes('sankofa-react-native')) {
        initFile = f; src = content; break;
      }
    }
  }

  results.push(initFile
    ? { name: 'SDK initialization', status: 'ok', detail: initFile }
    : { name: 'SDK initialization', status: 'fail', detail: 'SankofaDeploy not found in entry files', fix: 'Add SankofaDeploy initialization — see Quick Start in dashboard' });

  if (initFile) {
    results.push(src.includes('notifyAppReady')
      ? { name: 'notifyAppReady()', status: 'ok', detail: 'health confirmation present' }
      : { name: 'notifyAppReady()', status: 'warn', detail: 'missing — may cause false auto-rollbacks', fix: 'Add deploy.notifyAppReady() early in your root component' });
    results.push(src.includes('checkForUpdate')
      ? { name: 'checkForUpdate()', status: 'ok', detail: 'update check present' }
      : { name: 'checkForUpdate()', status: 'warn', detail: 'updates will not be checked', fix: 'Add deploy.checkForUpdate() after initialization' });
  }

  // .gitignore
  const gitignorePath = join(ctx.cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    results.push(readFileSync(gitignorePath, 'utf-8').includes('.sankofa.json')
      ? { name: '.gitignore', status: 'ok', detail: '.sankofa.json is ignored' }
      : { name: '.gitignore', status: 'warn', detail: '.sankofa.json not in .gitignore', fix: 'sankofa init' });
  }

  return results;
}

// ── API Access Check ──────────────────────────────────────────────────────────

async function checkApiAccess(ctx: ProjectContext, module: string): Promise<CheckResult[]> {
  if (!ctx.endpoint) return [];
  const label = module === 'deploy' ? 'Deploy' : 'Analytics';

  if (module === 'deploy') {
    // Deploy uses Bearer token (deploy token or JWT)
    if (!ctx.token || !ctx.projectId) return [];
    try {
      const res = await fetch(`${ctx.endpoint}/api/v1/deploy/stats?projectId=${ctx.projectId}&environment=live`, {
        headers: { 'Authorization': `Bearer ${ctx.token}`, 'x-project-id': ctx.projectId },
        signal: AbortSignal.timeout(5000),
      });
      return [res.ok
        ? { name: `${label} API access`, status: 'ok', detail: 'authenticated and accessible' }
        : { name: `${label} API access`, status: 'fail', detail: `server returned ${res.status}`, fix: 'sankofa login' }];
    } catch (err: any) {
      return [{ name: `${label} API access`, status: 'warn', detail: `could not verify: ${err.message}` }];
    }
  }

  // Analytics uses the SDK API key (x-api-key header) — same as the SDK itself.
  // Try the project .sankofa.json apiKey, then scan source for the key.
  let apiKey = ctx.apiKey;
  if (!apiKey) {
    // Try to extract from source code — scan common entry points + Dart files
    const entryFiles = ['app/_layout.tsx', 'app/_layout.js', 'App.tsx', 'App.js', 'src/App.tsx', 'index.tsx', 'index.js'];
    for (const f of entryFiles) {
      const full = join(ctx.cwd, f);
      if (existsSync(full)) {
        const src = readFileSync(full, 'utf-8');
        const match = src.match(/['"]sk_(?:test|live)_[a-f0-9]+['"]/);
        if (match) { apiKey = match[0].replace(/['"]/g, ''); break; }
      }
    }
    // Flutter: scan lib/ for API keys
    if (!apiKey) {
      const libDir = join(ctx.cwd, 'lib');
      if (existsSync(libDir)) {
        const dartFile = findFileContaining(libDir, '.dart', 'sk_test_') || findFileContaining(libDir, '.dart', 'sk_live_');
        if (dartFile) {
          const src = readFileSync(dartFile, 'utf-8');
          const match = src.match(/['"]sk_(?:test|live)_[a-f0-9]+['"]/);
          if (match) apiKey = match[0].replace(/['"]/g, '');
        }
      }
    }
  }

  if (!apiKey) {
    return [{ name: `${label} API access`, status: 'warn', detail: 'no API key found to verify', fix: 'Add apiKey to .sankofa.json or check your source code' }];
  }

  try {
    const res = await fetch(`${ctx.endpoint}/api/v1/handshake/`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    return [res.ok
      ? { name: `${label} API access`, status: 'ok', detail: 'API key valid and accessible' }
      : { name: `${label} API access`, status: 'fail', detail: `server returned ${res.status}`, fix: res.status === 401 ? 'Check your API key in Project Settings' : 'sankofa login' }];
  } catch (err: any) {
    return [{ name: `${label} API access`, status: 'warn', detail: `could not verify: ${err.message}` }];
  }
}

// ── Platform Label ────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<Platform, string> = {
  'react-native': 'React Native',
  flutter: 'Flutter',
  web: 'Web / JavaScript',
  ios: 'iOS (Swift)',
  android: 'Android (Kotlin)',
  unknown: 'Unknown',
};

// ── Command Definition ────────────────────────────────────────────────────────

export const checkCommand = new Command('check')
  .description('Verify that a Sankofa module is fully configured and ready to use');

// ── sankofa check deploy ──

checkCommand
  .command('deploy')
  .description('Verify the full Deploy setup: SDK, native wiring, credentials, and server connectivity')
  .option('--project <path>', 'React Native app directory (defaults to cwd)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ctx = buildContext(opts.project || process.cwd(), chalk);

    console.log('');
    console.log(chalk.bold('  Sankofa Deploy — Configuration Check'));
    console.log(chalk.dim(`  Platform: ${PLATFORM_LABELS[ctx.platform]}`));
    console.log(chalk.dim('  ─────────────────────────────────────'));
    console.log('');

    if (ctx.platform !== 'react-native') {
      console.log(chalk.yellow('  Sankofa Deploy is currently available for React Native only.'));
      console.log(chalk.dim(`  Detected platform: ${PLATFORM_LABELS[ctx.platform]}`));
      console.log('');
      return;
    }

    const results: CheckResult[] = [
      ...checkCredentials(ctx),
      ...checkDeployReactNative(ctx),
      ...await checkServer(ctx),
      ...await checkApiAccess(ctx, 'deploy'),
    ];

    printResults(results, chalk, 'Deploy');
  });

// ── sankofa check analytics ──

checkCommand
  .command('analytics')
  .description('Verify the Analytics setup: SDK, initialization, tracking, and server connectivity')
  .option('--project <path>', 'Project directory (defaults to cwd)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ctx = buildContext(opts.project || process.cwd(), chalk);

    console.log('');
    console.log(chalk.bold('  Sankofa Analytics — Configuration Check'));
    console.log(chalk.dim(`  Platform: ${PLATFORM_LABELS[ctx.platform]}`));
    console.log(chalk.dim('  ────────────────────────────────────────'));
    console.log('');

    let moduleChecks: CheckResult[];
    switch (ctx.platform) {
      case 'react-native':
        moduleChecks = checkAnalyticsReactNative(ctx);
        break;
      case 'flutter':
        moduleChecks = checkAnalyticsFlutter(ctx);
        break;
      case 'web':
        moduleChecks = checkAnalyticsWeb(ctx);
        break;
      default:
        console.log(chalk.yellow(`  Could not detect a supported platform in this directory.`));
        console.log(chalk.dim(`  Supported: React Native, Flutter, Web/JS`));
        console.log(chalk.dim(`  Make sure you run this from your project root (where package.json or pubspec.yaml lives).`));
        console.log('');
        return;
    }

    const results: CheckResult[] = [
      ...checkCredentials(ctx),
      ...moduleChecks,
      ...await checkServer(ctx),
      ...await checkApiAccess(ctx, 'analytics'),
    ];

    printResults(results, chalk, 'Analytics');
  });

// ── sankofa check (run all) ──

checkCommand
  .action(async (_opts, cmd) => {
    // If no subcommand given, run all applicable modules
    if (cmd.args.length > 0) return; // subcommand will handle

    const chalk = (await import('chalk')).default;
    const ctx = buildContext(process.cwd(), chalk);

    console.log('');
    console.log(chalk.bold('  Sankofa — Full Configuration Check'));
    console.log(chalk.dim(`  Platform: ${PLATFORM_LABELS[ctx.platform]}`));
    console.log(chalk.dim('  ──────────────────────────────────'));
    console.log('');

    if (ctx.platform === 'unknown') {
      console.log(chalk.yellow('  Could not detect a supported platform in this directory.'));
      console.log(chalk.dim('  Run this from your project root (where package.json or pubspec.yaml lives).'));
      console.log('');
      return;
    }

    // Shared checks
    const sharedResults = [
      ...checkCredentials(ctx),
      ...await checkServer(ctx),
    ];

    // Analytics (all platforms)
    let analyticsChecks: CheckResult[] = [];
    switch (ctx.platform) {
      case 'react-native': analyticsChecks = checkAnalyticsReactNative(ctx); break;
      case 'flutter': analyticsChecks = checkAnalyticsFlutter(ctx); break;
      case 'web': analyticsChecks = checkAnalyticsWeb(ctx); break;
    }

    // Deploy (RN only)
    let deployChecks: CheckResult[] = [];
    if (ctx.platform === 'react-native') {
      deployChecks = checkDeployReactNative(ctx);
    }

    // Print shared
    console.log(chalk.bold.dim('  CREDENTIALS & SERVER'));
    printResults(sharedResults, chalk, 'Credentials');

    // Print analytics
    if (analyticsChecks.length > 0) {
      console.log(chalk.bold.dim('  ANALYTICS'));
      const analyticsApi = await checkApiAccess(ctx, 'analytics');
      printResults([...analyticsChecks, ...analyticsApi], chalk, 'Analytics');
    }

    // Print deploy
    if (deployChecks.length > 0) {
      console.log(chalk.bold.dim('  DEPLOY'));
      const deployApi = await checkApiAccess(ctx, 'deploy');
      printResults([...deployChecks, ...deployApi], chalk, 'Deploy');
    }
  });
