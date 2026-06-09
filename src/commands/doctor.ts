import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadGlobalConfig } from '../utils/config.js';
import { resolveBuildEnv } from '../utils/buildEnv.js';
import {
  classifyProject,
  resolveProjectRoot,
  STACK_LABELS,
  type ProjectInfo,
  type Stack,
} from '../utils/stack.js';
import {
  PRODUCTS,
  availableProductsForStack,
  detectInstalledProducts,
  selectedProducts,
  ALL_PRODUCT_IDS,
  type ProductId,
} from '../utils/products.js';

type CheckResult = {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
};

// A module-level announcer the `check` / `checkAsync` helpers call
// before running a probe. Set by `sankofa doctor` to update its
// spinner with "Checking <name>…" so users see live progress even
// while a slow `execSync('flutter --version')` blocks. No-op by
// default so non-spinner callers (tests, programmatic use) aren't
// affected.
let announcer: ((label: string) => void) | null = null;
export function setSpinnerAnnouncer(fn: ((label: string) => void) | null): void {
  announcer = fn;
}

export const doctorCommand = new Command('doctor')
  .description('Diagnose the local toolchain + Sankofa integration across all installed products')
  .option('--project <path>', 'Project root (defaults to cwd)')
  .option('--deploy', 'Limit checks to Sankofa Deploy')
  .option('--flag', 'Limit checks to Sankofa Switch (feature flags)')
  .option('--config', 'Limit checks to Sankofa Config (remote configuration)')
  .option('--catch', 'Limit checks to Sankofa Catch (errors + analytics)')
  .option('--all', 'Run checks for every available product (default when no product flags)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    const results: CheckResult[] = [];

    // The previous implementation ran every check synchronously and
    // buffered results, printing them only at the end. The
    // `flutter --version` shell-out alone takes 3-8s on a cold Dart
    // cache, so users sat in front of a blank terminal and assumed
    // the CLI was hung. Wrap the whole sweep in one spinner that
    // narrates the in-flight check.
    const spinner = ora({ text: 'Running diagnostics…', spinner: 'dots' }).start();
    setSpinnerAnnouncer((label) => {
      spinner.text = label;
    });

    // 1. Universal toolchain checks (always run).
    results.push(check('Node.js', () => {
      const v = process.versions.node;
      const major = parseInt(v.split('.')[0], 10);
      if (major < 18) return { status: 'fail', detail: `${v} — need ≥18` };
      return { status: 'ok', detail: v };
    }));

    // 2. Resolve the project — explicit path, cwd, or scan + pick (mirrors init).
    //    Doctor can also run with no project in sight (e.g. checking auth);
    //    in that case the universal checks still run.
    let project: ProjectInfo | null = null;
    try {
      project = await resolveProjectRoot({ explicit: opts.project });
    } catch {
      project = null;
    }

    if (project) {
      if (project.root !== process.cwd()) {
        console.log(chalk.dim(`  → Working in ${project.root}`));
        process.chdir(project.root);
      }
      results.push({
        name: 'Project type',
        status: 'ok',
        detail: `${STACK_LABELS[project.stack]} — ${project.name}`,
      });
    } else {
      results.push({
        name: 'Project type',
        status: 'warn',
        detail: `No recognized project at ${process.cwd()} (skipping stack + product checks)`,
      });
    }

    const cwd = project ? project.root : process.cwd();

    // 3. Stack-specific toolchain checks.
    if (project) {
      results.push(...stackToolchainChecks(project.stack, cwd));
    }

    // 4. Per-product integration checks. Source of truth for "what did the
    //    user install" is the `products` array persisted in .sankofa.json by
    //    init. Without that, we can't tell Switch from Deploy on shared
    //    SDKs (e.g. sankofa_deploy is one package covering all products).
    //    Backwards-compat: pre-Phase-10 .sankofa.json files don't have the
    //    products field; we infer Deploy via file detection but conservatively
    //    leave Switch/Config/Catch out unless --all is passed.
    const installedProductIds = project ? resolveInstalledProducts(project) : [];
    if (project) {
      const productsToCheck = resolveProductsToCheck(opts, project.stack, installedProductIds);
      const installedReports = detectInstalledProducts(project, installedProductIds);
      const installedMap = new Map(installedReports.map((r) => [r.product, r]));

      for (const productId of productsToCheck) {
        const report = installedMap.get(productId);
        if (!report) {
          continue;
        }
        // For products the user explicitly installed via `init`, use the
        // per-product detector. For products not in the .sankofa.json
        // products list, show them only if --all is passed (handled by
        // resolveProductsToCheck).
        results.push({
          name: `${PRODUCTS[productId].name}`,
          status: report.installed ? 'ok' : 'warn',
          detail: report.detail,
        });
      }
    }

    // 5. Sankofa credentials + server reachability (universal).
    const global = loadGlobalConfig();
    results.push(check('Sankofa credentials', () => {
      if (!global.token && !process.env.SANKOFA_DEPLOY_TOKEN) {
        return { status: 'warn', detail: 'not logged in — run `sankofa login`' };
      }
      if (!global.projectId && !process.env.SANKOFA_PROJECT_ID) {
        return { status: 'warn', detail: 'no project selected — run `sankofa login` or `sankofa switch`' };
      }
      return { status: 'ok', detail: `project ${global.projectId || process.env.SANKOFA_PROJECT_ID}` };
    }));

    const endpoint = process.env.SANKOFA_ENDPOINT || global.endpoint;
    results.push(await checkAsync('Sankofa server reachable', async () => {
      if (!endpoint) return { status: 'skip', detail: 'no endpoint configured' };
      try {
        const res = await fetch(`${endpoint}/api/admin/health`, { method: 'GET' });
        if (res.ok) return { status: 'ok', detail: `${endpoint} — ${res.status}` };
        return { status: 'warn', detail: `${endpoint} responded ${res.status}` };
      } catch (err: any) {
        return { status: 'fail', detail: `${endpoint} — ${err.message}` };
      }
    }));

    // All checks are done — stop the spinner before printing the report.
    spinner.stop();
    setSpinnerAnnouncer(null);

    // 6. Print results.
    const pad = Math.max(...results.map((r) => r.name.length));
    console.log('');
    for (const r of results) {
      const icon =
        r.status === 'ok' ? chalk.green('✓') :
        r.status === 'warn' ? chalk.yellow('!') :
        r.status === 'skip' ? chalk.dim('-') :
        chalk.red('✖');
      const tone =
        r.status === 'ok' ? chalk.dim :
        r.status === 'warn' ? chalk.yellow :
        r.status === 'skip' ? chalk.dim :
        chalk.red;
      console.log(`  ${icon} ${r.name.padEnd(pad)}   ${tone(r.detail)}`);
    }

    // 7. Available-but-not-installed products hint. Driven by the
    //    user's `.sankofa.json` products list (what they explicitly
    //    installed), not by file-based detection. A product is "available
    //    but not installed" when it's supported on this stack AND not in
    //    the persisted products list.
    if (project) {
      const available = availableProductsForStack(project.stack);
      const installedSet = new Set<string>(installedProductIds);
      const missing = available.filter((p) => !installedSet.has(p.id));
      if (missing.length > 0) {
        console.log('');
        console.log(chalk.bold(`  Available for ${STACK_LABELS[project.stack]} (not yet installed)`));
        for (const p of missing) {
          console.log(
            chalk.dim(`    · ${p.name.padEnd(18)} `) +
              chalk.cyan(`sankofa init ${p.flag}`),
          );
        }
      }
    }

    const failed = results.filter((r) => r.status === 'fail').length;
    const warned = results.filter((r) => r.status === 'warn').length;
    console.log('');
    if (failed > 0) {
      console.log(chalk.red.bold(`  ${failed} check(s) failed, ${warned} warning(s).`));
      process.exit(1);
    } else if (warned > 0) {
      console.log(chalk.yellow.bold(`  ${warned} warning(s). Core toolchain OK.`));
    } else {
      console.log(chalk.green.bold('  All checks passed.'));
    }
    console.log('');
  });

function resolveProductsToCheck(
  opts: any,
  stack: Stack,
  installedFromConfig: ProductId[],
): ProductId[] {
  // Explicit product flag — verbatim respect.
  const requested = selectedProducts(opts);
  if (requested.length > 0) {
    return requested;
  }
  // --all: show every product available for this stack, installed or not.
  if (opts.all) {
    return availableProductsForStack(stack).map((p) => p.id);
  }
  // Default: only show products the user explicitly initialized. If
  // .sankofa.json has no products list (legacy / pre-Phase-10 init),
  // fall back to "show all available" so doctor remains useful.
  if (installedFromConfig.length > 0) {
    return installedFromConfig;
  }
  return availableProductsForStack(stack).map((p) => p.id);
}

function readInstalledProductIds(projectRoot: string): ProductId[] {
  const configPath = join(projectRoot, '.sankofa.json');
  if (!existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const products: unknown[] = Array.isArray(raw.products) ? raw.products : [];
    return products.filter((p): p is ProductId =>
      typeof p === 'string' && (ALL_PRODUCT_IDS as string[]).includes(p),
    );
  } catch {
    return [];
  }
}

function resolveInstalledProducts(project: ProjectInfo): ProductId[] {
  // 1. Trust .sankofa.json's products list if present (the post-Phase-10
  //    ground truth).
  const fromConfig = readInstalledProductIds(project.root);
  if (fromConfig.length > 0) return fromConfig;

  // 2. Pre-Phase-10 fallback: infer Deploy from file detection (we can
  //    reliably detect Deploy via native patching markers). Other products
  //    can't be inferred from files because they share the SDK package, so
  //    leave them out — accurate over generous.
  const reports = detectInstalledProducts(project, []);
  const deploy = reports.find((r) => r.product === 'deploy');
  if (deploy?.installed) return ['deploy'];
  return [];
}

function stackToolchainChecks(stack: Stack, cwd: string): CheckResult[] {
  switch (stack) {
    case 'react-native':
      return rnToolchainChecks(cwd);
    case 'flutter':
      return flutterToolchainChecks(cwd);
    case 'web':
      return webToolchainChecks(cwd);
    case 'native-ios':
      return nativeIosToolchainChecks(cwd);
    case 'native-android':
      return nativeAndroidToolchainChecks(cwd);
    default:
      return [];
  }
}

// ── React Native ──────────────────────────────────────────────────────────────

function rnToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(...iosToolchainChecks({ requirePods: true }));
  results.push(...androidToolchainChecks(cwd));

  const pkg = readPackageJson(cwd);
  results.push(check('React Native project', () => {
    if (!pkg) return { status: 'warn', detail: `no package.json at ${cwd}` };
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.expo) return { status: 'ok', detail: `Expo ${deps.expo}` };
    if (deps['react-native']) return { status: 'ok', detail: `React Native ${deps['react-native']} (bare)` };
    return { status: 'fail', detail: 'neither expo nor react-native in dependencies' };
  }));

  results.push(check('ios/ prebuild', () => {
    const iosDir = join(cwd, 'ios');
    if (!existsSync(iosDir)) return { status: 'warn', detail: 'ios/ missing — run `npx expo prebuild --platform ios`' };
    return { status: 'ok', detail: iosDir };
  }));

  results.push(check('android/ prebuild', () => {
    const androidDir = join(cwd, 'android');
    if (!existsSync(androidDir)) return { status: 'warn', detail: 'android/ missing — run `npx expo prebuild --platform android`' };
    return { status: 'ok', detail: androidDir };
  }));

  return results;
}

// ── Flutter ───────────────────────────────────────────────────────────────────

function flutterToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(check('Flutter SDK (PATH)', () => {
    try {
      const v = execSync('flutter --version', { encoding: 'utf-8' }).split('\n')[0];
      return { status: 'ok', detail: v };
    } catch {
      return { status: 'warn', detail: 'flutter not on PATH (Sankofa uses bundled flutter — this is OK)' };
    }
  }));

  results.push(check('Dart SDK', () => {
    try {
      const v = execSync('dart --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        .trim()
        .split('\n')[0];
      return { status: 'ok', detail: v };
    } catch {
      return { status: 'warn', detail: 'dart not on PATH — usually bundled with Flutter' };
    }
  }));

  results.push(...iosToolchainChecks({ requirePods: false }));
  results.push(...androidToolchainChecks(cwd));

  results.push(check('pubspec.yaml', () => {
    const path = join(cwd, 'pubspec.yaml');
    if (!existsSync(path)) return { status: 'fail', detail: 'missing' };
    return { status: 'ok', detail: path };
  }));

  results.push(...sankofaFlutterDeployChecks(cwd));

  return results;
}

/**
 * Sankofa-specific Flutter health checks that go beyond the bare
 * Flutter toolchain: bundled flutter presence, engine cache integrity,
 * sankofa.yaml + sankofa_flutter pubspec entry, native-config wiring.
 */
function sankofaFlutterDeployChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];

  // sankofa.yaml — Deploy's config-of-record.
  const yamlPath = join(cwd, 'sankofa.yaml');
  let engineVersion: string | undefined;
  let appId: string | undefined;
  results.push(check('sankofa.yaml', () => {
    if (!existsSync(yamlPath)) {
      return {
        status: 'warn',
        detail: 'not found — run `sankofa init` to add Sankofa Deploy',
      };
    }
    try {
      const text = readFileSync(yamlPath, 'utf-8');
      const mEngine = text.match(/^\s*engine_version:\s*['"]?([\w.+-]+)['"]?\s*$/m);
      const mAppId = text.match(/^\s*app_id:\s*['"]?([\w.+-]+)['"]?\s*$/m);
      const mApiKey = text.match(/^\s*api_key:\s*['"]?([\w._+-]+)['"]?\s*$/m);
      engineVersion = mEngine?.[1];
      appId = mAppId?.[1];
      const issues: string[] = [];
      if (!appId) issues.push('missing app_id');
      if (!mApiKey) issues.push('missing api_key');
      if (issues.length) return { status: 'fail', detail: issues.join(', ') };
      return { status: 'ok', detail: `app_id=${appId}${engineVersion ? `, engine=${engineVersion}` : ''}` };
    } catch (err: any) {
      return { status: 'fail', detail: `parse error: ${err.message}` };
    }
  }));

  // sankofa_flutter dep in pubspec.yaml.
  results.push(check('sankofa_flutter (pubspec)', () => {
    const pubspecPath = join(cwd, 'pubspec.yaml');
    if (!existsSync(pubspecPath)) return { status: 'skip', detail: 'no pubspec.yaml' };
    const text = readFileSync(pubspecPath, 'utf-8');
    if (text.includes('sankofa_flutter')) {
      return { status: 'ok', detail: 'present' };
    }
    return { status: 'warn', detail: 'not in pubspec.yaml — run `sankofa init`' };
  }));

  // Bundled flutter for the pinned engine version.
  results.push(check('Sankofa bundled Flutter', () => {
    if (!engineVersion) {
      return { status: 'skip', detail: 'no engine_version in sankofa.yaml' };
    }
    try {
      // Dynamic require to keep doctor portable when CLI is invoked from CI.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { bundledFlutterInfo } = require('../utils/flutterBundleCache.js');
      const info = bundledFlutterInfo(engineVersion);
      if (info.exists) {
        return { status: 'ok', detail: info.root };
      }
      return {
        status: 'fail',
        detail: `missing at ${info.root} — run \`sankofa engine install ${engineVersion}\``,
      };
    } catch (err: any) {
      return { status: 'warn', detail: `check skipped: ${err.message}` };
    }
  }));

  // Native config wiring — Phase 0.75 manifest meta-data (Android) +
  // Info.plist keys (iOS) — engine reads these so the host doesn't have
  // to call ConfigureSankofa() manually.
  if (existsSync(join(cwd, 'android'))) {
    results.push(check('Android: sankofa meta-data', () => {
      const manifestPath = join(cwd, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
      if (!existsSync(manifestPath)) return { status: 'skip', detail: 'no AndroidManifest.xml' };
      const text = readFileSync(manifestPath, 'utf-8');
      // Accept either the new short keys (`com.sankofa.appId` +
      // `com.sankofa.endpoint`) written by `sankofa init`, or the
      // legacy long key, so doctor doesn't false-flag projects from
      // either era.
      if (text.includes('com.sankofa.appId') || text.includes('com.sankofa.deploy.app_id')) {
        return { status: 'ok', detail: 'meta-data present' };
      }
      return {
        status: 'warn',
        detail: 'no <meta-data android:name="com.sankofa.appId" /> — engine will fall back to sankofa.yaml asset',
      };
    }));
  }
  if (existsSync(join(cwd, 'ios'))) {
    results.push(check('iOS: sankofa Info.plist keys', () => {
      const plistPath = join(cwd, 'ios', 'Runner', 'Info.plist');
      if (!existsSync(plistPath)) return { status: 'skip', detail: 'no ios/Runner/Info.plist' };
      const text = readFileSync(plistPath, 'utf-8');
      // Accept either the short keys (`com.sankofa.appId` +
      // `com.sankofa.endpoint`) or the legacy `SankofaDeploy*` form.
      if (text.includes('com.sankofa.appId') || text.includes('SankofaDeployAppId')) {
        return { status: 'ok', detail: 'Sankofa Info.plist keys present' };
      }
      return {
        status: 'warn',
        detail: 'no com.sankofa.appId in Info.plist — engine will fall back to sankofa.yaml asset',
      };
    }));
  }

  return results;
}

// ── Web ───────────────────────────────────────────────────────────────────────

function webToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];
  const pkg = readPackageJson(cwd);
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const framework =
      deps['next'] ? `Next.js ${deps['next']}` :
      deps['vite'] ? `Vite ${deps['vite']}` :
      deps['react-scripts'] ? `Create React App ${deps['react-scripts']}` :
      deps['vue'] ? `Vue ${deps['vue']}` :
      deps['nuxt'] ? `Nuxt ${deps['nuxt']}` :
      deps['svelte'] ? `Svelte ${deps['svelte']}` :
      deps['@angular/core'] ? `Angular ${deps['@angular/core']}` :
      deps['react'] ? `React ${deps['react']}` :
      'static / unknown';
    results.push({ name: 'Web framework', status: 'ok', detail: framework });
  } else if (existsSync(join(cwd, 'index.html'))) {
    results.push({ name: 'Web project', status: 'ok', detail: 'static (index.html)' });
  }
  return results;
}

// ── Native iOS ────────────────────────────────────────────────────────────────

function nativeIosToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(...iosToolchainChecks({ requirePods: false }));
  results.push(check('Package.swift', () => {
    const path = join(cwd, 'Package.swift');
    if (!existsSync(path)) return { status: 'fail', detail: 'missing' };
    return { status: 'ok', detail: path };
  }));
  return results;
}

// ── Native Android ────────────────────────────────────────────────────────────

function nativeAndroidToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(...androidToolchainChecks(cwd));
  results.push(check('Gradle wrapper', () => {
    const wrapper = join(cwd, 'gradlew');
    if (!existsSync(wrapper)) return { status: 'warn', detail: 'gradlew missing — run `gradle wrapper`' };
    return { status: 'ok', detail: wrapper };
  }));
  return results;
}

// ── Shared toolchain checks ───────────────────────────────────────────────────

function iosToolchainChecks(opts: { requirePods: boolean }): CheckResult[] {
  if (process.platform !== 'darwin') {
    return [{ name: 'Xcode / iOS toolchain', status: 'skip', detail: 'not macOS' }];
  }
  const results: CheckResult[] = [];

  results.push(check('Xcode (xcodebuild)', () => {
    try {
      const v = execSync('xcodebuild -version', { encoding: 'utf-8' }).split('\n')[0];
      return { status: 'ok', detail: v };
    } catch {
      return { status: 'fail', detail: 'not found — install Xcode from the App Store' };
    }
  }));

  results.push(check('Xcode Command Line Tools', () => {
    try {
      const path = execSync('xcode-select -p', { encoding: 'utf-8' }).trim();
      return { status: 'ok', detail: path };
    } catch {
      return { status: 'fail', detail: 'run `xcode-select --install`' };
    }
  }));

  results.push(check('xcrun simctl', () => {
    try {
      const booted = execSync('xcrun simctl list devices booted', { encoding: 'utf-8' });
      const count = (booted.match(/\(Booted\)/g) || []).length;
      return count > 0
        ? { status: 'ok', detail: `${count} booted simulator(s)` }
        : { status: 'warn', detail: 'no booted simulator — open Simulator before running `sankofa preview`' };
    } catch {
      return { status: 'fail', detail: 'simctl not available' };
    }
  }));

  if (opts.requirePods) {
    results.push(check('CocoaPods', () => {
      try {
        const v = execSync('pod --version', { encoding: 'utf-8' }).trim();
        return { status: 'ok', detail: v };
      } catch {
        return { status: 'fail', detail: 'install with `sudo gem install cocoapods` or via Homebrew' };
      }
    }));
  }

  return results;
}

function androidToolchainChecks(cwd: string): CheckResult[] {
  const results: CheckResult[] = [];
  const androidEnv = resolveBuildEnv('android');

  const javaHome = androidEnv.env.JAVA_HOME;
  if (javaHome && existsSync(javaHome)) {
    try {
      const out = execSync(`"${join(javaHome, 'bin', 'java')}" -version 2>&1`, { encoding: 'utf-8' });
      const m = out.match(/version "([^"]+)"/);
      const version = m ? m[1] : '?';
      results.push({ name: 'Java (17 or 21)', status: 'ok', detail: `${version} at ${javaHome}` });
    } catch {
      results.push({ name: 'Java (17 or 21)', status: 'warn', detail: javaHome });
    }
  } else {
    const miss = androidEnv.missing.find((m) => m.tool.includes('Java'));
    results.push({
      name: 'Java (17 or 21)',
      status: 'fail',
      detail: miss?.hint || 'No compatible Java (17 or 21) found on PATH',
    });
  }

  const sdk = androidEnv.env.ANDROID_HOME;
  if (sdk && existsSync(sdk)) {
    const wasAutoDetected = !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT;
    const suffix = wasAutoDetected ? ' (auto-detected)' : '';
    results.push({ name: 'Android SDK', status: 'ok', detail: `${sdk}${suffix}` });
  } else {
    const miss = androidEnv.missing.find((m) => m.tool.includes('Android SDK'));
    results.push({
      name: 'Android SDK',
      status: 'fail',
      detail: miss?.hint || 'not found in standard locations',
    });
  }

  results.push(check('adb', () => {
    try {
      const v = execSync('adb --version', { encoding: 'utf-8', env: androidEnv.env }).split('\n')[0];
      return { status: 'ok', detail: v };
    } catch {
      return { status: 'warn', detail: 'not available — install Android platform-tools' };
    }
  }));

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function check(name: string, fn: () => { status: CheckResult['status']; detail: string }): CheckResult {
  if (announcer) announcer(`Checking ${name}…`);
  try {
    const { status, detail } = fn();
    return { name, status, detail };
  } catch (err: any) {
    return { name, status: 'fail', detail: err?.message || String(err) };
  }
}

async function checkAsync(
  name: string,
  fn: () => Promise<{ status: CheckResult['status']; detail: string }>,
): Promise<CheckResult> {
  if (announcer) announcer(`Checking ${name}…`);
  try {
    const { status, detail } = await fn();
    return { name, status, detail };
  } catch (err: any) {
    return { name, status: 'fail', detail: err?.message || String(err) };
  }
}

function readPackageJson(dir: string): any | null {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
