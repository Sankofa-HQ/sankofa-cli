import { Command } from 'commander';
import { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { EOL } from 'os';
import { join, resolve } from 'path';
import { loadGlobalConfig } from '../utils/config.js';
import { execSync } from 'child_process';

/**
 * Sankofa-specific paths that must never be committed:
 *  - `.sankofa.json` — can contain a project-scoped Deploy Token after
 *    `sankofa login --project`. Leaks auth if committed.
 *  - `build/` — CLI output (OTA archive, native preview artifact, signed
 *    distribution binary, xcodebuild logs). Potentially large + tracks
 *    ephemeral SHA-suffixed filenames on every release.
 *  - `build/ota-stage/`, `build/distribution/` — explicit fallbacks in case
 *    the user already has a `build/` they want to track but still wants our
 *    outputs ignored.
 *  - `build/xcodebuild.log`, `build/xcodebuild-archive.log`,
 *    `build/xcodebuild-export.log` — noisy per-run logs.
 */
const GITIGNORE_ENTRIES: Array<{ pattern: string; comment?: string }> = [
  { pattern: '.sankofa.json', comment: 'Sankofa Deploy — CLI credentials (never commit)' },
  { pattern: 'build/', comment: 'Sankofa Deploy — build/ota output' },
  { pattern: 'build/ota-stage/' },
  { pattern: 'build/distribution/' },
  { pattern: 'build/xcodebuild.log' },
  { pattern: 'build/xcodebuild-archive.log' },
  { pattern: 'build/xcodebuild-export.log' },
  { pattern: 'build/*.ios.zip' },
  { pattern: 'build/*.ota.zip' },
  { pattern: 'build/*.app.zip' },
];

const SANKOFA_GITIGNORE_HEADER = '# ── Sankofa Deploy ─────────────────────────────────────────────';
const SANKOFA_GITIGNORE_FOOTER = '# ── /Sankofa Deploy ────────────────────────────────────────────';

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

  // Append — leave the user's existing structure untouched.
  const needsNewline = !existing.endsWith('\n');
  appendFileSync(path, (needsNewline ? EOL : '') + block);
  return { created: false, added: missing.map((m) => m.pattern), path };
}

export const initCommand = new Command('init')
  .description('Scaffold a .sankofa.json in the current project and print integration next steps')
  .option('--endpoint <url>', 'Override endpoint (defaults to your global login)')
  .option('--project-id <id>', 'Override project id (defaults to your global login)')
  .option('--env <environment>', 'Default environment: live or test', 'live')
  .option('--force', 'Overwrite an existing .sankofa.json')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    const cwd = process.cwd();
    const target = join(cwd, '.sankofa.json');

    // Idempotent: if .sankofa.json is already there we leave it alone but
    // still reconcile .gitignore and print the next-steps checklist. That
    // lets `sankofa init` act as "make sure this project is set up right"
    // on any subsequent run, not just the very first one.
    const global = loadGlobalConfig();
    const endpoint = opts.endpoint || global.endpoint || 'https://api.sankofa.dev';
    const projectId = opts.projectId || global.projectId || '';
    const environment = opts.env === 'test' ? 'test' : 'live';

    console.log('');
    if (existsSync(target) && !opts.force) {
      console.log(chalk.dim(`  · ${target} already exists — kept as-is (pass --force to overwrite)`));
    } else {
      const config = { endpoint, projectId, environment };
      writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.green(`  ✓ ${opts.force ? 'Overwrote' : 'Wrote'} ${target}`));
    }

    // Make sure the Sankofa-generated file (which may hold a token) and the
    // build outputs never end up in git.
    const gitignore = ensureSankofaGitignore(cwd);
    if (gitignore.added.length > 0) {
      console.log(
        chalk.green(
          `  ✓ ${gitignore.created ? 'Created' : 'Updated'} ${gitignore.path} (+${gitignore.added.length} entr${gitignore.added.length === 1 ? 'y' : 'ies'})`,
        ),
      );
      for (const pattern of gitignore.added) {
        console.log(chalk.dim(`      ${pattern}`));
      }
    } else {
      console.log(chalk.dim(`  · .gitignore already covers every Sankofa path`));
    }

    // ── Detect platform ──
    const pkg = readPackageJson(cwd);
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
    const hasPubspec = existsSync(join(cwd, 'pubspec.yaml'));
    const isFlutter = hasPubspec;
    const isReactNative = !isFlutter && !!(deps['react-native'] || deps['expo']);

    const appJsonPath = join(cwd, 'app.json');
    const hasExpoKey = existsSync(appJsonPath) && (() => {
      try { return !!JSON.parse(readFileSync(appJsonPath, 'utf-8'))?.expo; } catch { return false; }
    })();

    console.log('');
    console.log(chalk.dim(`  · Platform: ${isFlutter ? 'Flutter' : isReactNative ? (hasExpoKey ? 'React Native (Expo)' : 'React Native (bare)') : 'Unknown'}`));

    // ── Platform-specific setup ──
    if (isReactNative) {
      console.log('');
      console.log(chalk.bold('  Native bundle loading'));

      const failures: string[] = [];

      if (hasExpoKey) {
        try {
          const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
          const plugins: any[] = raw.expo.plugins || [];
          const alreadyHasPlugin = plugins.some((p: any) =>
            (typeof p === 'string' ? p : p?.[0]) === 'sankofa-react-native'
          );
          if (alreadyHasPlugin) {
            console.log(chalk.dim(`  · app.json already has sankofa-react-native plugin`));
          } else {
            raw.expo.plugins = [...plugins, 'sankofa-react-native'];
            writeFileSync(appJsonPath, JSON.stringify(raw, null, 2) + '\n');
            console.log(chalk.green(`  ✓ Added "sankofa-react-native" to app.json plugins`));
            console.log(chalk.dim(`    Run ${chalk.cyan('npx expo prebuild --clean')} to regenerate native projects`));
          }
        } catch (err: any) {
          console.log(chalk.yellow(`  ⚠ Could not patch app.json: ${err.message}`));
          failures.push('expo');
        }
      } else if (existsSync(join(cwd, 'android')) || existsSync(join(cwd, 'ios'))) {
        const result = patchNativeFiles(cwd, chalk);
        if (!result.android && existsSync(join(cwd, 'android'))) failures.push('android');
        if (!result.ios && existsSync(join(cwd, 'ios'))) failures.push('ios');
      }

      if (failures.length > 0) {
        console.log('');
        console.log(chalk.yellow('  ⚠ Some native files could not be patched automatically.'));
        console.log(chalk.yellow('    Add the following manually:'));
        console.log('');
        if (failures.includes('expo')) {
          console.log(chalk.dim('    app.json — add to the plugins array:'));
          console.log(chalk.cyan('    "plugins": ["sankofa-react-native"]'));
          console.log('');
        }
        if (failures.includes('android')) {
          console.log(chalk.dim('    Android — MainApplication.kt:'));
          console.log(chalk.cyan(`    import dev.sankofa.rn.SankofaDeployBundleProvider\n\n    override fun getJSBundleFile(): String? {\n      return SankofaDeployBundleProvider.getJSBundleFile(applicationContext)\n        ?: super.getJSBundleFile()\n    }`));
          console.log('');
        }
        if (failures.includes('ios')) {
          console.log(chalk.dim('    iOS — AppDelegate.swift:'));
          console.log(chalk.cyan(`    import SankofaReactNative\n\n    override func bundleURL() -> URL? {\n      if let url = SankofaDeployBundleProvider.bundleURL() { return url }\n      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")\n    }`));
          console.log('');
        }
      }

      // Next steps — React Native
      console.log('');
      console.log(chalk.bold('  Next steps'));
      console.log('');
      const hasSdk = !!deps['sankofa-react-native'];
      if (!hasSdk) {
        console.log(chalk.dim('  1. Install the runtime SDK:'));
        console.log(chalk.cyan(hasExpoKey ? '     npx expo install sankofa-react-native' : '     npm install sankofa-react-native'));
      } else {
        console.log(chalk.dim(`  1. SDK already installed: sankofa-react-native@${deps['sankofa-react-native']}`));
      }
      console.log('');
      console.log(chalk.dim('  2. Initialize in your root layout:'));
      console.log(chalk.cyan(`     import { Sankofa, SankofaDeploy } from 'sankofa-react-native';
     Sankofa.initialize(API_KEY, { endpoint: '${endpoint}' });
     const deploy = new SankofaDeploy({ checkOnResume: true });
     deploy.notifyAppReady();`));
      console.log('');
      console.log(chalk.dim('  3. Verify everything:'));
      console.log(chalk.cyan('     sankofa check'));
      console.log('');

    } else if (isFlutter) {
      // Next steps — Flutter
      const pubspecRaw = existsSync(join(cwd, 'pubspec.yaml')) ? readFileSync(join(cwd, 'pubspec.yaml'), 'utf-8') : '';
      const hasSdk = pubspecRaw.includes('sankofa_flutter');

      console.log('');
      console.log(chalk.bold('  Next steps'));
      console.log('');
      if (!hasSdk) {
        console.log(chalk.dim('  1. Install the runtime SDK:'));
        console.log(chalk.cyan('     flutter pub add sankofa_flutter'));
      } else {
        console.log(chalk.dim('  1. SDK already installed: sankofa_flutter'));
      }
      console.log('');
      console.log(chalk.dim('  2. Initialize in your main.dart:'));
      console.log(chalk.cyan(`     await Sankofa.instance.init(
       apiKey: 'YOUR_API_KEY',
       endpoint: '${endpoint}',
       enableSessionReplay: true,
     );`));
      console.log('');
      console.log(chalk.dim('  3. Add screen tracking:'));
      console.log(chalk.cyan(`     MaterialApp(
       navigatorObservers: [SankofaNavigatorObserver()],
     )`));
      console.log('');
      console.log(chalk.dim('  4. Verify everything:'));
      console.log(chalk.cyan('     sankofa check'));
      console.log('');

    } else {
      console.log('');
      console.log(chalk.yellow('  ⚠ Could not detect platform. Make sure you run this from your project root.'));
      console.log(chalk.dim('    Supported: React Native (Expo or bare), Flutter'));
      console.log('');
    }
  });

// ── Native Patching ───────────────────────────────────────────────────────────
// Replicates the Expo config plugin logic so bare RN projects get auto-patched.

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
  if (index === -1) return src; // Can't find anchor — skip

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
      // Try alternate pattern
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
  if (!bundleMethod.test(next)) return next; // Can't find method — skip

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

function patchNativeFiles(cwd: string, chalk: any): { android: boolean; ios: boolean } {
  // Returns true per platform if patched OR already patched.
  // Returns false only if the file couldn't be found or patching failed.
  const result = { android: false, ios: false };

  // Android: find MainApplication.kt
  const androidDir = join(cwd, 'android');
  const mainApp = findFile(androidDir, 'MainApplication.kt');
  if (mainApp) {
    try {
      const original = readFileSync(mainApp, 'utf-8');
      const patched = patchAndroidMainApplication(original);
      if (patched !== original) {
        writeFileSync(mainApp, patched);
        console.log(chalk.green(`  ✓ Patched ${mainApp}`));
      } else {
        console.log(chalk.dim(`  · Android already patched (MainApplication.kt)`));
      }
      result.android = true;
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to patch MainApplication.kt: ${err.message}`));
    }
  } else if (existsSync(androidDir)) {
    console.log(chalk.yellow(`  ⚠ Could not find MainApplication.kt in android/`));
  }

  // iOS: find AppDelegate.swift
  const iosDir = join(cwd, 'ios');
  const appDelegate = findFile(iosDir, 'AppDelegate.swift');
  if (appDelegate) {
    try {
      const original = readFileSync(appDelegate, 'utf-8');
      const patched = patchIosAppDelegate(original);
      if (patched !== original) {
        writeFileSync(appDelegate, patched);
        console.log(chalk.green(`  ✓ Patched ${appDelegate}`));
      } else {
        console.log(chalk.dim(`  · iOS already patched (AppDelegate.swift)`));
      }
      result.ios = true;
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Failed to patch AppDelegate.swift: ${err.message}`));
    }
  } else if (existsSync(iosDir)) {
    console.log(chalk.yellow(`  ⚠ Could not find AppDelegate.swift in ios/`));
  }

  return result;
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
