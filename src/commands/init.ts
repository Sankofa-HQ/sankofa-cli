import { Command } from 'commander';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { EOL } from 'os';
import { join } from 'path';
import { loadGlobalConfig } from '../utils/config.js';
import {
  resolveProjectRoot,
  STACK_LABELS,
  type ProjectInfo,
} from '../utils/stack.js';
import {
  PRODUCTS,
  availableProductsForStack,
  selectedProducts,
  type ProductId,
} from '../utils/products.js';

/**
 * Sankofa-specific paths that must never be committed:
 *  - `.sankofa.json` — can contain a project-scoped Deploy Token after
 *    `sankofa login --project`. Leaks auth if committed.
 *  - `build/` — CLI output (OTA archive, native preview artifact, signed
 *    distribution binary, xcodebuild logs).
 */
const GITIGNORE_ENTRIES: Array<{ pattern: string; comment?: string }> = [
  { pattern: '.sankofa.json', comment: 'Sankofa — CLI credentials (never commit)' },
  { pattern: 'build/', comment: 'Sankofa — build/ota output' },
  { pattern: 'build/ota-stage/' },
  { pattern: 'build/distribution/' },
  { pattern: 'build/xcodebuild.log' },
  { pattern: 'build/xcodebuild-archive.log' },
  { pattern: 'build/xcodebuild-export.log' },
  { pattern: 'build/*.ios.zip' },
  { pattern: 'build/*.ota.zip' },
  { pattern: 'build/*.app.zip' },
];

const SANKOFA_GITIGNORE_HEADER = '# ── Sankofa ───────────────────────────────────────────────────';
const SANKOFA_GITIGNORE_FOOTER = '# ── /Sankofa ──────────────────────────────────────────────────';

function ensureSankofaGitignore(cwd: string): { created: boolean; added: string[]; path: string } {
  const path = join(cwd, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*/, '').replace(/\s*#.*$/, '').trim())
      .filter(Boolean),
  );

  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e.pattern));
  if (missing.length === 0) {
    return { created: false, added: [], path };
  }

  const blockLines: string[] = ['', SANKOFA_GITIGNORE_HEADER];
  for (const entry of missing) {
    if (entry.comment) blockLines.push(`# ${entry.comment}`);
    blockLines.push(entry.pattern);
  }
  blockLines.push(SANKOFA_GITIGNORE_FOOTER, '');
  const block = blockLines.join(EOL);

  if (!existsSync(path)) {
    writeFileSync(path, block.trimStart() + EOL);
    return { created: true, added: missing.map((m) => m.pattern), path };
  }

  const needsNewline = !existing.endsWith('\n');
  appendFileSync(path, (needsNewline ? EOL : '') + block);
  return { created: false, added: missing.map((m) => m.pattern), path };
}

export const initCommand = new Command('init')
  .description('Set up Sankofa in a project — pick one or more products, auto-detect the stack, edit native files where needed')
  .option('--endpoint <url>', 'Override endpoint (defaults to your global login)')
  .option('--project-id <id>', 'Override project id (defaults to your global login)')
  .option('--env <environment>', 'Default environment: live or test', 'live')
  .option('--force', 'Overwrite an existing .sankofa.json')
  .option('--project <path>', 'Project root (defaults to cwd; scans subdirectories if cwd is not a project)')
  .option('--scan', 'Force interactive project picker even if cwd looks like a project')
  .option('--deploy', 'Install Sankofa Deploy (OTA updates)')
  .option('--flag', 'Install Sankofa Switch (feature flags)')
  .option('--config', 'Install Sankofa Config (remote configuration)')
  .option('--catch', 'Install Sankofa Catch (errors + analytics)')
  .option('--all', 'Install all Sankofa products available for this stack')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    // 1. Resolve the project — explicit path, cwd, or scan + pick.
    let project: ProjectInfo;
    try {
      if (opts.scan) {
        project = await resolveProjectRoot({ explicit: undefined });
      } else {
        project = await resolveProjectRoot({ explicit: opts.project });
      }
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      console.error(chalk.dim(`     Supported stacks: React Native, Flutter, Web, iOS (Swift), Android (Kotlin)`));
      process.exit(1);
    }

    if (project.root !== process.cwd()) {
      console.log(chalk.dim(`  → Working in ${project.root}`));
      process.chdir(project.root);
    }

    console.log('');
    console.log(chalk.bold(`  ${STACK_LABELS[project.stack]} project: ${project.name}`));

    // 2. Resolve which products to install.
    const available = availableProductsForStack(project.stack);
    const availableIds = available.map((p) => p.id);
    const requested = selectedProducts(opts);

    let products: ProductId[];
    if (requested.length > 0) {
      products = requested.filter((p) => availableIds.includes(p));
      const skipped = requested.filter((p) => !availableIds.includes(p));
      if (skipped.length > 0) {
        console.log(
          chalk.yellow(
            `  ⚠ Not available for ${STACK_LABELS[project.stack]}: ${skipped.map((p) => PRODUCTS[p].name).join(', ')}`,
          ),
        );
      }
    } else {
      const inquirer = (await import('inquirer')).default;
      const { picked } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'picked',
          message: `Which Sankofa products do you want to install?`,
          choices: available.map((p) => ({
            name: `${p.name} — ${p.description}`,
            value: p.id,
            checked: p.id === 'deploy',
          })),
        },
      ]);
      products = picked as ProductId[];
    }

    if (products.length === 0) {
      console.log(chalk.dim('  Nothing selected. Re-run with --all or one of: --deploy, --flag, --config, --catch.'));
      return;
    }

    // 3. Always-on setup: .sankofa.json + .gitignore.
    const global = loadGlobalConfig();
    const endpoint = opts.endpoint || global.endpoint || 'https://api.sankofa.dev';
    const projectId = opts.projectId || global.projectId || '';
    const environment = opts.env === 'test' ? 'test' : 'live';

    console.log('');
    const target = join(project.root, '.sankofa.json');
    const existing = existsSync(target) && !opts.force
      ? (() => {
          try { return JSON.parse(readFileSync(target, 'utf-8')); } catch { return null; }
        })()
      : null;

    // Always merge the chosen products into the persisted set so doctor
    // sees the full picture across multiple init runs. --force still
    // overwrites credentials but preserves the additive product semantic.
    const priorProducts: string[] = Array.isArray(existing?.products) ? existing.products : [];
    const mergedProducts = Array.from(new Set([...priorProducts, ...products]));

    if (existing && !opts.force) {
      // File exists, keep it but update products list if it changed.
      if (priorProducts.length !== mergedProducts.length) {
        const updated = { ...existing, products: mergedProducts };
        writeFileSync(target, JSON.stringify(updated, null, 2) + '\n');
        console.log(chalk.green(`  ✓ Updated ${target} with newly-chosen product(s)`));
      } else {
        console.log(chalk.dim(`  · ${target} already covers the requested products`));
      }
    } else {
      const config = { endpoint, projectId, environment, products: mergedProducts };
      writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.green(`  ✓ ${opts.force ? 'Overwrote' : 'Wrote'} ${target}`));
    }

    const gitignore = ensureSankofaGitignore(project.root);
    if (gitignore.added.length > 0) {
      console.log(
        chalk.green(
          `  ✓ ${gitignore.created ? 'Created' : 'Updated'} ${gitignore.path} (+${gitignore.added.length} entr${gitignore.added.length === 1 ? 'y' : 'ies'})`,
        ),
      );
    } else {
      console.log(chalk.dim(`  · .gitignore already covers every Sankofa path`));
    }

    // 4. Per-product installation.
    console.log('');
    console.log(chalk.bold(`  Installing ${products.length} product${products.length === 1 ? '' : 's'}: ${products.map((p) => PRODUCTS[p].name).join(', ')}`));

    for (const productId of products) {
      console.log('');
      console.log(chalk.cyan(`  ▸ ${PRODUCTS[productId].name}`));
      await installProduct(productId, project, endpoint, chalk);
    }

    // 5. Final verify hint.
    console.log('');
    console.log(chalk.dim('  Verify with:'));
    console.log(chalk.cyan('     sankofa doctor'));
    console.log('');
  });

async function installProduct(
  productId: ProductId,
  project: ProjectInfo,
  endpoint: string,
  chalk: any,
): Promise<void> {
  switch (productId) {
    case 'deploy':
      return installDeploy(project, endpoint, chalk);
    case 'switch':
      return installSwitch(project, endpoint, chalk);
    case 'config':
      return installConfig(project, endpoint, chalk);
    case 'catch':
      return installCatch(project, endpoint, chalk);
  }
}

// ── Deploy ────────────────────────────────────────────────────────────────────

async function installDeploy(project: ProjectInfo, endpoint: string, chalk: any) {
  if (project.stack === 'react-native') {
    await installDeployRN(project, endpoint, chalk);
  } else if (project.stack === 'flutter') {
    await installDeployFlutter(project, endpoint, chalk);
  } else {
    console.log(chalk.yellow(`  ⚠ Deploy is not yet available for ${STACK_LABELS[project.stack]}`));
  }
}

async function installDeployRN(project: ProjectInfo, endpoint: string, chalk: any) {
  const pkgPath = join(project.root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const isExpo = !!deps['expo'];

  const appJsonPath = join(project.root, 'app.json');
  const hasExpoKey = existsSync(appJsonPath) && (() => {
    try { return !!JSON.parse(readFileSync(appJsonPath, 'utf-8'))?.expo; } catch { return false; }
  })();

  const failures: string[] = [];

  if (hasExpoKey) {
    try {
      const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
      const plugins: any[] = raw.expo.plugins || [];
      const alreadyHasPlugin = plugins.some((p: any) =>
        (typeof p === 'string' ? p : p?.[0]) === 'sankofa-react-native',
      );
      if (alreadyHasPlugin) {
        console.log(chalk.dim(`     · app.json already has sankofa-react-native plugin`));
      } else {
        raw.expo.plugins = [...plugins, 'sankofa-react-native'];
        writeFileSync(appJsonPath, JSON.stringify(raw, null, 2) + '\n');
        console.log(chalk.green(`     ✓ Added "sankofa-react-native" to app.json plugins`));
        console.log(chalk.dim(`       Run ${chalk.cyan('npx expo prebuild --clean')} to regenerate native projects`));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`     ⚠ Could not patch app.json: ${err.message}`));
      failures.push('expo');
    }
  } else if (existsSync(join(project.root, 'android')) || existsSync(join(project.root, 'ios'))) {
    const result = patchRNNativeFiles(project.root, chalk);
    if (!result.android && existsSync(join(project.root, 'android'))) failures.push('android');
    if (!result.ios && existsSync(join(project.root, 'ios'))) failures.push('ios');
  }

  if (failures.length > 0) {
    console.log(chalk.yellow(`     ⚠ Some native files could not be patched. Manual snippets in docs.`));
  }

  console.log('');
  const hasSdk = !!deps['sankofa-react-native'];
  if (!hasSdk) {
    console.log(chalk.dim('     Install the runtime SDK:'));
    console.log(chalk.cyan(isExpo ? '       npx expo install sankofa-react-native' : '       npm install sankofa-react-native'));
  } else {
    console.log(chalk.dim(`     SDK already installed: sankofa-react-native@${deps['sankofa-react-native']}`));
  }
  console.log(chalk.dim('     Initialize in your root layout:'));
  console.log(chalk.cyan(`       import { Sankofa, SankofaDeploy } from 'sankofa-react-native';
       Sankofa.initialize(API_KEY, { endpoint: '${endpoint}' });
       const deploy = new SankofaDeploy({ checkOnResume: true });
       deploy.notifyAppReady();`));
}

async function installDeployFlutter(project: ProjectInfo, endpoint: string, chalk: any) {
  const result = patchFlutterNativeFiles(project.root, endpoint, chalk);
  const pubspecRaw = readFileSync(join(project.root, 'pubspec.yaml'), 'utf-8');
  // Match either the unified package (current) or the legacy Phase 7
  // package (for projects mid-migration).
  const hasSdk = pubspecRaw.includes('sankofa_flutter') || pubspecRaw.includes('sankofa_deploy');

  console.log('');
  if (!hasSdk) {
    console.log(chalk.dim('     Install the unified runtime SDK:'));
    console.log(chalk.cyan('       flutter pub add sankofa_flutter'));
  } else {
    console.log(chalk.dim('     SDK already in pubspec.yaml'));
  }
  console.log(chalk.dim('     Initialize in your main.dart:'));
  console.log(chalk.cyan(`       await Sankofa.instance.init(
         apiKey: 'YOUR_API_KEY',
         endpoint: '${endpoint}',
         enableDeploy: true,
       );
       await Sankofa.instance.deploy?.notifyAppReady();`));

  if (!result.androidPatched && existsSync(join(project.root, 'android'))) {
    console.log('');
    console.log(chalk.yellow('     ⚠ Could not auto-patch the Android side.'));
    console.log(chalk.dim('       MainActivity.kt should extend SankofaFlutterActivity.'));
    console.log(chalk.dim('       AndroidManifest.xml needs com.sankofa.deploy.SankofaDeployApplication + INTERNET + meta-data.'));
  }
}

// ── Switch ────────────────────────────────────────────────────────────────────

async function installSwitch(project: ProjectInfo, endpoint: string, chalk: any) {
  console.log(chalk.dim('     Feature flag SDK init:'));
  switch (project.stack) {
    case 'react-native':
      console.log(chalk.cyan(`       import { Sankofa } from 'sankofa-react-native';
       Sankofa.initialize(API_KEY, { endpoint: '${endpoint}' });
       const enabled = await Sankofa.flags.isEnabled('my-flag');`));
      break;
    case 'flutter':
      console.log(chalk.cyan(`       final enabled = await Sankofa.flags.isEnabled('my-flag');`));
      break;
    case 'web':
      console.log(chalk.cyan(`       import { Sankofa } from '@sankofa/browser';
       await Sankofa.init({ apiKey: 'YOUR_API_KEY', endpoint: '${endpoint}' });
       const enabled = await Sankofa.flags.isEnabled('my-flag');`));
      break;
    case 'native-ios':
      console.log(chalk.cyan(`       let enabled = Sankofa.shared.flags.isEnabled("my-flag")`));
      break;
    case 'native-android':
      console.log(chalk.cyan(`       val enabled = Sankofa.flags.isEnabled("my-flag")`));
      break;
  }
  console.log(chalk.dim('     Manage flag definitions:'));
  console.log(chalk.cyan('       sankofa flags list'));
}

// ── Config ────────────────────────────────────────────────────────────────────

async function installConfig(project: ProjectInfo, endpoint: string, chalk: any) {
  console.log(chalk.dim('     Remote config SDK init:'));
  switch (project.stack) {
    case 'react-native':
    case 'web':
      console.log(chalk.cyan(`       const max = await Sankofa.config.getNumber('max_retries', 3);`));
      break;
    case 'flutter':
      console.log(chalk.cyan(`       final max = await Sankofa.config.getNumber('max_retries', 3);`));
      break;
    case 'native-ios':
      console.log(chalk.cyan(`       let max = Sankofa.shared.config.getNumber("max_retries", default: 3)`));
      break;
    case 'native-android':
      console.log(chalk.cyan(`       val max = Sankofa.config.getNumber("max_retries", 3)`));
      break;
  }
  console.log(chalk.dim('     Manage config values:'));
  console.log(chalk.cyan('       sankofa config list'));
}

// ── Catch ─────────────────────────────────────────────────────────────────────

async function installCatch(project: ProjectInfo, endpoint: string, chalk: any) {
  console.log(chalk.dim('     Error tracking + analytics SDK init:'));
  switch (project.stack) {
    case 'react-native':
    case 'web':
      console.log(chalk.cyan(`       Sankofa.track('button_clicked', { label: 'Sign Up' });
       Sankofa.identify('user_123');
       Sankofa.captureException(error);`));
      break;
    case 'flutter':
      console.log(chalk.cyan(`       Sankofa.instance.track('button_clicked', {'label': 'Sign Up'});
       Sankofa.instance.identify('user_123');
       Sankofa.instance.captureException(error);`));
      break;
    case 'native-ios':
      console.log(chalk.cyan(`       Sankofa.shared.track("button_tapped", properties: ["label": "Sign Up"])
       Sankofa.shared.identify(userId: "user_123")
       Sankofa.shared.captureException(error)`));
      break;
    case 'native-android':
      console.log(chalk.cyan(`       Sankofa.track("button_clicked", mapOf("label" to "Sign Up"))
       Sankofa.identify("user_123")
       Sankofa.captureException(error)`));
      break;
  }
}

// ── RN native patching (existing behavior, preserved) ─────────────────────────

function ensureImport(src: string, importLine: string): string {
  if (src.includes(importLine)) return src;
  const lines = src.split('\n');
  const lastImport = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('import '))
    .pop();
  if (!lastImport) return `${importLine}\n${src}`;
  lines.splice(lastImport.index + 1, 0, importLine);
  return lines.join('\n');
}

function patchAndroidMainApplication(src: string): string {
  if (src.includes('SankofaDeployBundleProvider.getJSBundleFile')) return src;

  let next = ensureImport(src, 'import dev.sankofa.rn.SankofaDeployBundleProvider');
  const existingOverride = /override fun getJSBundleFile\(\): String\?\s*\{([\s\S]*?)\n\s*\}/m;
  if (existingOverride.test(next)) {
    return next.replace(existingOverride, (match) => {
      if (!match.includes('return ')) return match;
      return match.replace('return ', 'return SankofaDeployBundleProvider.getJSBundleFile(applicationContext) ?: ');
    });
  }

  const anchor = 'override fun getUseDeveloperSupport()';
  const index = next.indexOf(anchor);
  if (index === -1) return src;

  const method = [
    '    override fun getJSBundleFile(): String? {',
    '      return SankofaDeployBundleProvider.getJSBundleFile(applicationContext) ?: super.getJSBundleFile()',
    '    }',
    '',
  ].join('\n');
  return `${next.slice(0, index)}${method}${next.slice(index)}`;
}

function patchIosAppDelegate(src: string): string {
  if (src.includes('sankofaDeployBundleURL()') && src.includes('SankofaReactNative')) return src;

  let next = ensureImport(src, 'import SankofaReactNative');

  if (!next.includes('private func sankofaDeployBundleURL() -> URL?')) {
    const helper = [
      'private func sankofaDeployBundleURL() -> URL? {',
      '  let selector = NSSelectorFromString("bundleURL")',
      '  for className in ["SankofaDeployBundleProvider", "SankofaReactNative.SankofaDeployBundleProvider"] {',
      '    guard let provider = NSClassFromString(className) as? NSObject.Type,',
      '          provider.responds(to: selector),',
      '          let value = provider.perform(selector)?.takeUnretainedValue() as? URL else {',
      '      continue',
      '    }',
      '    return value',
      '  }',
      '  return nil',
      '}',
      '',
    ].join('\n');
    const delegateIndex = next.indexOf('class ReactNativeDelegate');
    if (delegateIndex === -1) {
      const altIndex = next.indexOf('class AppDelegate');
      if (altIndex !== -1) {
        next = `${next.slice(0, altIndex)}${helper}${next.slice(altIndex)}`;
      }
    } else {
      next = `${next.slice(0, delegateIndex)}${helper}${next.slice(delegateIndex)}`;
    }
  }

  if (next.includes('sankofaDeployBundleURL()')) return next;

  const bundleMethod = /override func bundleURL\(\) -> URL\? \{([\s\S]*?)\n\s*\}/m;
  if (!bundleMethod.test(next)) return next;

  return next.replace(bundleMethod, (match) => {
    const releaseReturn = 'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
    if (match.includes(releaseReturn)) {
      return match.replace(
        releaseReturn,
        'if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    ' + releaseReturn,
      );
    }
    return match.replace(
      /\n\s*return ([^\n]+)\n\s*\}/,
      '\n    if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    return $1\n  }',
    );
  });
}

function findFileRecursive(dir: string, name: string): string | null {
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

function patchRNNativeFiles(cwd: string, chalk: any): { android: boolean; ios: boolean } {
  const result = { android: false, ios: false };

  const androidDir = join(cwd, 'android');
  const mainApp = findFileRecursive(androidDir, 'MainApplication.kt');
  if (mainApp) {
    try {
      const original = readFileSync(mainApp, 'utf-8');
      const patched = patchAndroidMainApplication(original);
      if (patched !== original) {
        writeFileSync(mainApp, patched);
        console.log(chalk.green(`     ✓ Patched ${mainApp}`));
      } else {
        console.log(chalk.dim(`     · Android already patched (MainApplication.kt)`));
      }
      result.android = true;
    } catch (err: any) {
      console.log(chalk.yellow(`     ⚠ Failed to patch MainApplication.kt: ${err.message}`));
    }
  } else if (existsSync(androidDir)) {
    console.log(chalk.yellow(`     ⚠ Could not find MainApplication.kt in android/`));
  }

  const iosDir = join(cwd, 'ios');
  const appDelegate = findFileRecursive(iosDir, 'AppDelegate.swift');
  if (appDelegate) {
    try {
      const original = readFileSync(appDelegate, 'utf-8');
      const patched = patchIosAppDelegate(original);
      if (patched !== original) {
        writeFileSync(appDelegate, patched);
        console.log(chalk.green(`     ✓ Patched ${appDelegate}`));
      } else {
        console.log(chalk.dim(`     · iOS already patched (AppDelegate.swift)`));
      }
      result.ios = true;
    } catch (err: any) {
      console.log(chalk.yellow(`     ⚠ Failed to patch AppDelegate.swift: ${err.message}`));
    }
  } else if (existsSync(iosDir)) {
    console.log(chalk.yellow(`     ⚠ Could not find AppDelegate.swift in ios/`));
  }

  return result;
}

// ── Flutter native patching (NEW) ─────────────────────────────────────────────

function patchFlutterNativeFiles(
  cwd: string,
  endpoint: string,
  chalk: any,
): { androidPatched: boolean; iosPatched: boolean } {
  const out = { androidPatched: false, iosPatched: false };

  const androidApp = join(cwd, 'android', 'app');
  if (existsSync(androidApp)) {
    try {
      patchFlutterAndroidManifest(androidApp, endpoint, chalk);
      patchFlutterMainActivity(androidApp, chalk);
      out.androidPatched = true;
    } catch (err: any) {
      console.log(chalk.yellow(`     ⚠ Android patch failed: ${err.message}`));
    }
  }

  patchFlutterMainDart(cwd, chalk);

  return out;
}

function patchFlutterAndroidManifest(androidApp: string, endpoint: string, chalk: any) {
  const manifestPath = join(androidApp, 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) {
    console.log(chalk.yellow(`     ⚠ AndroidManifest.xml not found at ${manifestPath}`));
    return;
  }
  let xml = readFileSync(manifestPath, 'utf-8');
  let changed = false;

  if (!xml.includes('android.permission.INTERNET')) {
    xml = xml.replace(
      /<manifest([^>]*)>/,
      `<manifest$1>\n    <uses-permission android:name="android.permission.INTERNET" />`,
    );
    changed = true;
  }

  if (!xml.includes('com.sankofa.deploy.SankofaDeployApplication')) {
    xml = xml.replace(
      /<application(\s)/,
      `<application\n        android:name="com.sankofa.deploy.SankofaDeployApplication"$1`,
    );
    changed = true;
  }

  if (!xml.includes('com.sankofa.apiKey')) {
    xml = xml.replace(
      /<\/application>/,
      `    <meta-data android:name="com.sankofa.apiKey" android:value="\${SANKOFA_API_KEY}" />\n    <meta-data android:name="com.sankofa.endpoint" android:value="${endpoint}" />\n    </application>`,
    );
    changed = true;
  }

  if (changed) {
    writeFileSync(manifestPath, xml);
    console.log(chalk.green(`     ✓ Patched ${manifestPath}`));
  } else {
    console.log(chalk.dim(`     · AndroidManifest.xml already wired up`));
  }
}

function patchFlutterMainActivity(androidApp: string, chalk: any) {
  const kotlinRoot = join(androidApp, 'src', 'main', 'kotlin');
  const mainActivity = findFileRecursive(kotlinRoot, 'MainActivity.kt');
  if (!mainActivity) {
    console.log(chalk.yellow(`     ⚠ MainActivity.kt not found under ${kotlinRoot}`));
    return;
  }
  let src = readFileSync(mainActivity, 'utf-8');
  if (src.includes('SankofaFlutterActivity')) {
    console.log(chalk.dim(`     · MainActivity.kt already extends SankofaFlutterActivity`));
    return;
  }
  src = src.replace(
    /import io\.flutter\.embedding\.android\.FlutterActivity/,
    'import com.sankofa.deploy.SankofaFlutterActivity',
  );
  src = src.replace(
    /class MainActivity\s*:\s*FlutterActivity\(\)/,
    'class MainActivity : SankofaFlutterActivity()',
  );
  writeFileSync(mainActivity, src);
  console.log(chalk.green(`     ✓ Patched ${mainActivity}`));
}

function patchFlutterMainDart(cwd: string, chalk: any) {
  const mainDart = join(cwd, 'lib', 'main.dart');
  if (!existsSync(mainDart)) {
    console.log(chalk.dim(`     · No lib/main.dart found — skipping Dart wiring`));
    return;
  }
  let src = readFileSync(mainDart, 'utf-8');
  // Migration-friendly detection: match either the legacy Phase 7
  // `SankofaDeploy.init(...)` call OR the unified `Sankofa.instance.init(`
  // call so re-running `init` on a project that's already on the new
  // SDK doesn't re-patch.
  if (src.includes('SankofaDeploy.init') || src.includes('Sankofa.instance.init(')) {
    console.log(chalk.dim(`     · lib/main.dart already wires up the Sankofa SDK`));
    return;
  }
  const importLine = "import 'package:sankofa_flutter/sankofa_flutter.dart';";
  if (!src.includes(importLine)) {
    src = importLine + '\n' + src;
  }
  // Unified SDK init: single Sankofa.instance.init call with module
  // enable flags. Matches the React-Native SDK's
  // `Sankofa.initialize(apiKey, { enableDeploy: true })` shape.
  src = src.replace(
    /void main\(\)\s*(async\s*)?\{/,
    `Future<void> main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await Sankofa.instance.init(\n    apiKey: const String.fromEnvironment('SANKOFA_API_KEY'),\n    enableDeploy: true,\n  );`,
  );
  // Add notifyAppReady right after runApp(...). The new namespaced
  // accessor returns null when Deploy isn't enabled, so the `?.` guard
  // protects hosts that flip enableDeploy off later.
  src = src.replace(
    /(runApp\([^;]+;)/,
    `$1\n  await Sankofa.instance.deploy?.notifyAppReady();`,
  );
  writeFileSync(mainDart, src);
  console.log(chalk.green(`     ✓ Patched ${mainDart}`));
}
