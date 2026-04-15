import { Command } from 'commander';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { EOL } from 'os';
import { join } from 'path';
import { loadGlobalConfig } from '../utils/config.js';

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

    console.log('');
    console.log(chalk.bold('  Next steps'));
    console.log('');

    const pkg = readPackageJson(cwd);
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
    const hasSdk = !!deps['sankofa-react-native'];

    if (!hasSdk) {
      console.log(chalk.dim('  1. Install the runtime SDK:'));
      console.log(chalk.cyan('     npm install sankofa-react-native'));
      console.log('');
    } else {
      console.log(chalk.dim(`  1. SDK already installed: sankofa-react-native@${deps['sankofa-react-native']}`));
      console.log('');
    }

    console.log(chalk.dim('  2. Initialize the SDK in your app\'s root layout (once):'));
    console.log(chalk.cyan(`     import { Sankofa, SankofaDeploy } from 'sankofa-react-native';
     Sankofa.initialize(API_KEY, { endpoint: '${endpoint}' });
     const deploy = new SankofaDeploy({ checkOnResume: true });
     deploy.checkForUpdate().then(u => u.updateAvailable && (
       u.isMandatory ? deploy.downloadAndApply(u) : deploy.downloadInBackground(u)
     ));`));
    console.log('');

    console.log(chalk.dim('  3. On iOS, wire the bundle provider into AppDelegate.swift:'));
    console.log(chalk.cyan(`     override func bundleURL() -> URL? {
     #if DEBUG
       return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "…")
     #else
       return sankofaDeployBundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
     #endif
     }
     override func sourceURL(for bridge: RCTBridge) -> URL? { bundleURL() }`));
    console.log(chalk.dim('     (Always return bundleURL() from sourceURL — NOT bridge.bundleURL — so OTA reloads pick up the new bundle.)'));
    console.log('');

    console.log(chalk.dim('  4. Run the diagnostics:'));
    console.log(chalk.cyan('     sankofa doctor'));
    console.log('');
    console.log(chalk.dim('  5. Ship your first release:'));
    console.log(chalk.cyan('     sankofa release ios'));
    console.log('');
  });

function readPackageJson(dir: string): any | null {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
