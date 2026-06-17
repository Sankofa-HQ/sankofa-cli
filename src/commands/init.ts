import { Command } from 'commander';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { EOL } from 'os';
import { join, relative } from 'path';
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
  const pubspecPath = join(project.root, 'pubspec.yaml');

  // 1. Auto-install bundled Flutter SDK + engine binaries when missing.
  await ensureBundledFlutterForInit(project, chalk);

  // 2. Pull per-ABI engine binaries (libflutter.so / Flutter.framework) so
  //    `sankofa release` later doesn't trip the "unknown engine" gate.
  await ensureFlutterEngineForInit(project, chalk);

  // 3. Vendor the dynamic_modules trampoline into <project>/.sankofa/
  //    so customer's pubspec doesn't carry a GitHub URL. Adds the
  //    dir to .gitignore so it isn't committed; team members re-run
  //    `sankofa init` on first checkout to populate locally.
  await ensureVendoredDynamicModules(project.root, chalk);

  // 4. Add sankofa_flutter to pubspec.yaml + a managed
  //    `dependency_overrides` stanza pointing at the vendored trampoline.
  //    Wires sankofa.yaml into flutter.assets too. Idempotent.
  await tryAddSankofaFlutterToPubspec(pubspecPath, chalk);

  // 5. Create sankofa.yaml with placeholder values if missing. We
  //    populate `app_id` from the .sankofa.json projectId so the
  //    customer only has to paste the api_key by hand.
  const projectId = readProjectId(project.root) ?? '';
  tryCreateSankofaYaml(project.root, projectId, '', endpoint, chalk);

  // 6. Inject the `registerLoader` + `preFlight` calls into lib/main.dart.
  tryWireFlutterMainDart(project.root, chalk);

  console.log('');
  console.log(chalk.green('     ✓ Sankofa Deploy wired into the project.'));
  console.log(chalk.dim('       Open `sankofa.yaml` and replace the placeholders with your'));
  console.log(chalk.dim('       project\'s api_key + app_id (see app.sankofa.dev → Settings → API Keys).'));
  console.log(chalk.dim('       Then run `flutter pub get && flutter run`.'));

  if (!result.androidPatched && existsSync(join(project.root, 'android'))) {
    console.log('');
    console.log(chalk.yellow('     ⚠ Could not auto-patch the Android side.'));
    console.log(chalk.dim('       MainActivity.kt should extend SankofaFlutterActivity.'));
    console.log(chalk.dim('       AndroidManifest.xml needs INTERNET + Sankofa meta-data, and MainActivity.kt should extend SankofaFlutterActivity.'));
  }
}

/**
 * Install the Sankofa-forked Flutter SDK into ~/.sankofa/flutter/<version>/
 * if not already present. Reads the engine version from the project's
 * sankofa.yaml (or defaults to 3.44.1+sankofa-1).
 *
 * Failures are non-fatal — `sankofa engine install` can be re-run later.
 */
async function ensureBundledFlutterForInit(project: ProjectInfo, chalk: any): Promise<string> {
  const ora = (await import('ora')).default;
  const { installBundledFlutter, bundledFlutterInfo } = await import('../utils/flutterBundleCache.js');

  // Resolve which engine version this project targets.
  let engineVersion = process.env.SANKOFA_ENGINE_VERSION;
  if (!engineVersion) {
    const yamlPath = join(project.root, 'sankofa.yaml');
    if (existsSync(yamlPath)) {
      const text = readFileSync(yamlPath, 'utf-8');
      const m = text.match(/^\s*engine_version:\s*['"]?([\w.+-]+)['"]?\s*$/m);
      if (m) engineVersion = m[1];
    }
  }
  if (!engineVersion) {
    const { resolveLatestEngineVersion } = await import('../utils/engineVersion.js');
    engineVersion = (await resolveLatestEngineVersion()).version;
  }

  const writePin = () => {
    try {
      const pinDir = join(project.root, '.sankofa');
      mkdirSync(pinDir, { recursive: true });
      writeFileSync(join(pinDir, 'flutter-version'), engineVersion + '\n');
    } catch {
      /* non-fatal — engine resolution falls back to sankofa.yaml */
    }
  };

  const present = bundledFlutterInfo(engineVersion);
  if (present.exists) {
    console.log(chalk.dim(`     ✓ Bundled Flutter SDK present (${engineVersion})`));
    writePin();
    return engineVersion;
  }

  const spinner = ora(`  Installing Sankofa bundled Flutter SDK (${engineVersion})…`).start();
  try {
    installBundledFlutter(engineVersion, {
      onProgress: (msg) => {
        spinner.text = `  ${msg}`;
      },
    });
    spinner.succeed(`  Bundled Flutter SDK ready (${engineVersion})`);
    writePin();
  } catch (err: any) {
    spinner.warn(`  Bundled Flutter install skipped: ${err.message}`);
    console.log(chalk.dim('       Re-run `sankofa engine install` later.'));
  }
  return engineVersion;
}

/**
 * Auto-add the Sankofa Flutter SDK + its transitive `dynamic_modules`
 * git dep to the project's pubspec.yaml, and ensure `sankofa.yaml` is
 * listed under `flutter.assets`. Idempotent — does nothing if the
 * stanzas are already present. Returns true on any write.
 *
 * The two-dep setup is forced by pub.dev policy: published packages
 * can't carry git/path deps, and `dynamic_modules` imports
 * `dart:_internal` which pub.dev refuses outright. So sankofa_flutter
 * ships hosted; the customer carries the VM binding alongside.
 */
/**
 * Clone the standalone `dynamic_modules` trampoline into
 * `<project>/.sankofa/dynamic_modules/`. Adds `.sankofa/` to the
 * project's `.gitignore`. Idempotent — re-running is a `git fetch +
 * reset` to keep the local copy current. Returns true on any change.
 *
 * Why vendor at all: pub.dev refuses dart:_internal imports + git
 * deps in published packages, so the binding can't ride inside
 * sankofa_flutter or be a hosted pub package. Vendoring lets the
 * customer's `pubspec.yaml` reference a local path via the standard
 * `dependency_overrides` mechanism — no GitHub URL exposed in the
 * file customer normally reads.
 */
async function ensureVendoredDynamicModules(projectRoot: string, chalk: any): Promise<boolean> {
  const { execSync } = await import('child_process');
  const ora = (await import('ora')).default;
  const target = join(projectRoot, '.sankofa', 'dynamic_modules');
  const repoUrl = 'https://github.com/Sankofa-HQ/sankofa-dart-sdk.git';
  const refSpec = 'main';
  const pathInRepo = 'standalone/dynamic_modules';

  let needFetch = true;
  if (existsSync(join(target, 'pubspec.yaml')) &&
      existsSync(join(target, 'lib', 'dynamic_modules.dart'))) {
    needFetch = false; // already vendored — leave alone
  }

  if (needFetch) {
    const spinner = ora('  Vendoring dynamic_modules into .sankofa/…').start();
    try {
      const tmpDir = join(projectRoot, '.sankofa', '_clone-tmp');
      // Clean any stale tmp. (rmSync force:true is a no-op when absent and is
      // cross-platform — no `rm -rf` shellout that breaks on Windows.)
      rmSync(tmpDir, { recursive: true, force: true });
      // Clone a shallow copy of just main into the tmp dir.
      execSync(
        `git clone --depth 1 --branch ${shellQuote(refSpec)} --filter=blob:none --sparse ${shellQuote(repoUrl)} ${shellQuote(tmpDir)}`,
        { stdio: 'ignore' },
      );
      // Sparse-checkout just the standalone subpath.
      execSync(`git -C ${shellQuote(tmpDir)} sparse-checkout set ${shellQuote(pathInRepo)}`, {
        stdio: 'ignore',
      });
      // Move the extracted subtree into place (cpSync recursive == `cp -R src/. dest/`).
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(join(tmpDir, pathInRepo), target, { recursive: true });
      rmSync(tmpDir, { recursive: true, force: true });
      spinner.succeed('  Vendored dynamic_modules → .sankofa/dynamic_modules/');
    } catch (err: any) {
      spinner.fail(`  Could not vendor dynamic_modules: ${err.message}`);
      console.log(chalk.dim('       Falling back to a git ref in pubspec — see README.'));
      return false;
    }
  } else {
    console.log(chalk.dim('     ✓ dynamic_modules already vendored at .sankofa/dynamic_modules/'));
  }

  // Append to .gitignore so the vendor dir doesn't get committed.
  const gitignorePath = join(projectRoot, '.gitignore');
  let gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  if (!gitignore.split('\n').some((l) => l.trim() === '.sankofa/' || l.trim() === '.sankofa')) {
    if (gitignore.length > 0 && !gitignore.endsWith('\n')) gitignore += '\n';
    gitignore += '\n# Sankofa CLI-managed (regenerated by `sankofa init`).\n.sankofa/\n';
    writeFileSync(gitignorePath, gitignore);
    console.log(chalk.green('     ✓ Added .sankofa/ to .gitignore'));
  }
  return true;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function tryAddSankofaFlutterToPubspec(pubspecPath: string, chalk: any): Promise<boolean> {
  try {
    let text = readFileSync(pubspecPath, 'utf-8');
    let touched = false;

    // ── 1. Add sankofa_flutter under `dependencies:` ──
    if (!text.includes('sankofa_flutter:')) {
      const depsMatch = text.match(/^(dependencies:[ \t]*\n)((?:[ \t]+.*\n|\n)+?)(?=^[^ \t\n]|\Z)/m);
      if (!depsMatch) {
        console.log(chalk.yellow('     ⚠ pubspec.yaml has no `dependencies:` block — skipping'));
      } else {
        const injected =
          depsMatch[1] +
          `  # Sankofa unified SDK (Analytics, Deploy, Catch, Switch, Config, Pulse, Replay).\n` +
          `  sankofa_flutter: ^0.2.1\n` +
          depsMatch[2];
        text = text.replace(depsMatch[0], injected);
        touched = true;
        console.log(chalk.green('     ✓ Added sankofa_flutter to pubspec.yaml'));
      }
    } else {
      console.log(chalk.dim('     ✓ sankofa_flutter already in pubspec.yaml'));
    }

    // ── 2. Point a `dependency_overrides` entry at the vendored package.
    //       CRITICAL: a project may ALREADY have a `dependency_overrides:`
    //       block. YAML forbids duplicate top-level keys, so we must MERGE
    //       our entry into the existing block — never append a second one
    //       (that produces `Duplicate mapping key` and breaks all Flutter
    //       tooling). Three cases: already-wired (skip), block exists
    //       (merge), no block (append).
    const overridesHeaderRe = /^dependency_overrides:[ \t]*\n/m;
    if (/^[ \t]+path:[ \t]*\.sankofa\/dynamic_modules\b/m.test(text)) {
      console.log(chalk.dim('     ✓ dependency_overrides already points at .sankofa/dynamic_modules'));
    } else if (overridesHeaderRe.test(text)) {
      // Merge: insert our entry as the first child of the existing block.
      text = text.replace(
        overridesHeaderRe,
        (header) =>
          header +
          `  # Sankofa-managed — do not edit by hand. Re-run \`sankofa init\` to regenerate.\n` +
          `  dynamic_modules:\n` +
          `    path: .sankofa/dynamic_modules\n`,
      );
      touched = true;
      console.log(chalk.green('     ✓ Merged dynamic_modules into existing dependency_overrides'));
    } else {
      // No existing block — append a fresh one at the end of the file.
      const block =
        `\n# Sankofa-managed — do not edit by hand. Re-run \`sankofa init\` if\n` +
        `# you need to regenerate the vendored package.\n` +
        `dependency_overrides:\n` +
        `  dynamic_modules:\n` +
        `    path: .sankofa/dynamic_modules\n`;
      if (!text.endsWith('\n')) text += '\n';
      text += block;
      touched = true;
      console.log(chalk.green('     ✓ Wired dependency_overrides → .sankofa/dynamic_modules'));
    }

    // ── 3. Ensure sankofa.yaml is in flutter.assets ──
    if (!text.includes('sankofa.yaml')) {
      const flutterMatch = text.match(/^(flutter:[ \t]*\n)((?:[ \t]+.*\n|\n)+?)(?=^[^ \t\n]|\Z)/m);
      if (flutterMatch) {
        const flutterBody = flutterMatch[2];
        const assetsMatch = flutterBody.match(/^(\s+assets:[ \t]*\n)((?:\s+-.*\n)*)/m);
        if (assetsMatch) {
          const newAssets = assetsMatch[1] + assetsMatch[2] + '    - sankofa.yaml\n';
          const newFlutterBody = flutterBody.replace(assetsMatch[0], newAssets);
          text = text.replace(flutterMatch[0], flutterMatch[1] + newFlutterBody);
        } else {
          const newFlutterBody =
            flutterBody +
            `  assets:\n` +
            `    - sankofa.yaml\n`;
          text = text.replace(flutterMatch[0], flutterMatch[1] + newFlutterBody);
        }
        touched = true;
        console.log(chalk.green('     ✓ Added sankofa.yaml to flutter.assets'));
      } else {
        console.log(chalk.yellow('     ⚠ pubspec.yaml has no `flutter:` block — skipping assets entry'));
      }
    }

    // ── 4. Resolve the flutter_lints version conflict ──
    //
    // sankofa_flutter → carrier_info ^3.0.3 (transitively pins
    // `flutter_lints: ^4.0.0` as a regular dep — a bug in carrier_info
    // upstream). Flutter 3.41.9's default `flutter create` template uses
    // `flutter_lints: ^6.0.0`, which makes the pub resolver refuse to
    // resolve. Downgrade the constraint to `^4.0.0` (it's dev-only —
    // strictly a code-style linter, no runtime impact). Idempotent:
    // anyone who has already moved off ^6 stays put.
    const lintsRegex = /^([ \t]*)flutter_lints:\s*\^?6(?:\.[\d.]+)?\s*$/m;
    if (lintsRegex.test(text)) {
      text = text.replace(lintsRegex, '$1flutter_lints: ^4.0.0');
      touched = true;
      console.log(chalk.dim('     · Pinned flutter_lints → ^4.0.0 (resolves carrier_info conflict)'));
    }

    if (touched) {
      writeFileSync(pubspecPath, text);
      console.log(chalk.dim('       Run `flutter pub get` to resolve.'));
    }
    return touched;
  } catch (err: any) {
    console.log(chalk.yellow(`     ⚠ Could not auto-edit pubspec.yaml: ${err.message}`));
    return false;
  }
}

/**
 * Write `sankofa.yaml` to the project root with the supplied apiKey +
 * endpoint. Does nothing if the file already exists (host-managed
 * file, never clobber). Returns true when written.
 */
/**
 * Given the index of an opening `{` in `src`, return the index of
 * its matching `}`. Ignores braces inside `// ...`, `/* ... *\/`,
 * and `'...'`/`"..."`/`r"""..."""` string/comment regions. Returns
 * -1 if no match.
 */
function findMatchingBrace(src: string, openIdx: number): number {
  if (src[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function readProjectId(projectRoot: string): string | undefined {
  try {
    const cfgPath = join(projectRoot, '.sankofa.json');
    if (!existsSync(cfgPath)) return undefined;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return typeof cfg.projectId === 'string' && cfg.projectId.length > 0
      ? cfg.projectId
      : undefined;
  } catch {
    return undefined;
  }
}

function tryCreateSankofaYaml(
  projectRoot: string,
  appId: string,
  apiKey: string,
  endpoint: string,
  chalk: any,
): boolean {
  const yamlPath = join(projectRoot, 'sankofa.yaml');
  if (existsSync(yamlPath)) {
    console.log(chalk.dim('     ✓ sankofa.yaml already exists — not overwriting'));
    return false;
  }
  try {
    const appIdLine = appId
      ? `app_id: ${appId}\n`
      : `app_id: <your-app-id; copy from app.sankofa.dev → Settings>\n`;
    const apiKeyLine = apiKey
      ? `api_key: ${apiKey}\n`
      : `api_key: <paste sk_live_* key from app.sankofa.dev → Settings → API Keys>\n`;
    const baseUrlLine =
      endpoint && endpoint !== 'https://api.sankofa.dev' ? `base_url: ${endpoint}\n` : ``;
    const content =
      `# Sankofa project config — read at runtime from the asset bundle.\n` +
      `# Add this file to flutter.assets in pubspec.yaml (\`sankofa init\` did\n` +
      `# that for you). The CLI writes engine_version + signing_pubkey here\n` +
      `# when you run \`sankofa engine install\` / \`sankofa keys generate\`.\n` +
      `# Customer code never edits this file by hand.\n` +
      `\n` +
      appIdLine +
      apiKeyLine +
      baseUrlLine;
    writeFileSync(yamlPath, content);
    console.log(chalk.green('     ✓ Created sankofa.yaml'));
    return true;
  } catch (err: any) {
    console.log(chalk.yellow(`     ⚠ Could not create sankofa.yaml: ${err.message}`));
    return false;
  }
}

/**
 * Inject `SankofaUpdater.registerLoader(loadModuleFromBytes)` +
 * `await SankofaUpdater.preFlight()` into the project's lib/main.dart.
 *
 * Strategy:
 *  1. Add the two `import` lines if missing.
 *  2. Find `void main(` and check if it's already async — if not,
 *     convert (`void main() {` → `Future<void> main() async {`).
 *  3. Find the first statement (typically `runApp(...)`) and inject
 *     our two lines before it, with `WidgetsFlutterBinding.ensureInitialized()`
 *     if it's not already there.
 *
 * If main.dart's shape is unusual (no recognisable `main`, multiple
 * declarations, etc.), print clear manual instructions instead of
 * risking a corrupted file.
 */
function tryWireFlutterMainDart(projectRoot: string, chalk: any): boolean {
  const mainPath = join(projectRoot, 'lib', 'main.dart');
  if (!existsSync(mainPath)) {
    // No standard lib/main.dart — common in flavored apps (main_common.dart +
    // main_<flavor>.dart). Auto-editing an arbitrary custom bootstrap is risky,
    // so DON'T silently skip: detect the real startup file and tell the user
    // exactly what to add. (This is REQUIRED — Deploy can't apply patches
    // without the wiring.)
    const entry = findFlutterStartupFile(projectRoot);
    printManualMainSnippet(chalk, entry ? relative(projectRoot, entry) : null);
    return false;
  }
  try {
    let src = readFileSync(mainPath, 'utf-8');

    // Already wired? Bail.
    if (src.includes('SankofaUpdater.preFlight')) {
      console.log(chalk.dim('     ✓ lib/main.dart already calls SankofaUpdater.preFlight'));
      return false;
    }

    // ── Add imports if missing ──
    //
    // `dynamic_modules` is referenced via `dependency_overrides:` only
    // (pub.dev rejects packages that import `dart:_internal`, so it
    // can't be a regular dep of `sankofa_flutter`). The
    // `depend_on_referenced_packages` lint fires on overrides-only
    // imports, so we suppress it on this single line.
    const importsToAdd: string[] = [];
    if (!/import\s+['"]package:dynamic_modules\/dynamic_modules\.dart['"]/.test(src)) {
      importsToAdd.push(
        `// ignore: depend_on_referenced_packages\n` +
          `import 'package:dynamic_modules/dynamic_modules.dart';`,
      );
    }
    if (!/import\s+['"]package:sankofa_flutter\/sankofa_flutter\.dart['"]/.test(src)) {
      importsToAdd.push(`import 'package:sankofa_flutter/sankofa_flutter.dart';`);
    }
    if (importsToAdd.length > 0) {
      // Find the last `import` line and append after it; else inject at top.
      const importLines = [...src.matchAll(/^import\s+['"][^'"]+['"];$/gm)];
      if (importLines.length > 0) {
        const last = importLines[importLines.length - 1];
        const insertAt = last.index! + last[0].length;
        src = src.slice(0, insertAt) + '\n' + importsToAdd.join('\n') + src.slice(insertAt);
      } else {
        src = importsToAdd.join('\n') + '\n\n' + src;
      }
    }

    // ── Locate main() and ensure it's async ──
    // Patterns we accept:
    //   void main() {...}
    //   void main() async {...}
    //   Future<void> main() async {...}
    //   void main(List<String> args) async {...}
    //   void main() => runApp(...);   ← arrow form, needs rewrite
    const mainSig = /^(\s*)((?:Future<void>|void)\s+main\s*\([^)]*\))\s*(async\s*)?({|=>)/m;
    const m = mainSig.exec(src);
    if (!m) {
      console.log(chalk.yellow('     ⚠ Could not find `main()` in lib/main.dart — wire it manually:'));
      printManualMainSnippet(chalk, 'lib/main.dart');
      writeFileSync(mainPath, src); // still save the import additions
      return importsToAdd.length > 0;
    }
    const indent = m[1] || '';
    const signature = m[2];
    const wasAsync = !!m[3];
    const opener = m[4];

    let injectedBody: string;
    if (opener === '=>') {
      // Arrow form — find the expression up to `;`
      const arrowMatch = src.slice(m.index).match(/^[^=>]*=>\s*([^;]+);/);
      if (!arrowMatch) {
        console.log(chalk.yellow('     ⚠ Unusual arrow `main()` — wire it manually:'));
        printManualMainSnippet(chalk, 'lib/main.dart');
        writeFileSync(mainPath, src);
        return importsToAdd.length > 0;
      }
      const expr = arrowMatch[1].trim();
      injectedBody =
        `${indent}Future<void> main() async {\n` +
        `${indent}  WidgetsFlutterBinding.ensureInitialized();\n` +
        `${indent}  SankofaUpdater.registerLoader(loadModuleFromBytes);\n` +
        `${indent}  await SankofaUpdater.preFlight();\n` +
        `${indent}  ${expr};\n` +
        `${indent}}`;
      src = src.slice(0, m.index) + injectedBody + src.slice(m.index + arrowMatch[0].length);
    } else {
      // Block form — inject before the FIRST statement inside { }.
      // Find the opening `{` index, then the first non-whitespace inside.
      const blockStart = m.index + m[0].length - 1; // index of `{`
      // Insert just after `{` and the following newline.
      let cursor = blockStart + 1;
      // Skip leading whitespace inside the block.
      while (cursor < src.length && /[ \t]/.test(src[cursor])) cursor++;
      // Find current first-line indent of the block body.
      const nextNewline = src.indexOf('\n', cursor);
      const firstStmtMatch = nextNewline >= 0
        ? src.slice(nextNewline + 1).match(/^([ \t]*)/)
        : null;
      const bodyIndent = firstStmtMatch ? firstStmtMatch[1] : indent + '  ';

      // Make signature async if it isn't already.
      if (!wasAsync) {
        // Mutate the function-signature region.
        const sigRegion = src.slice(m.index, blockStart);
        const newSig = sigRegion
          .replace(/^(\s*)void\s+main\s*\(/, '$1Future<void> main(')
          .replace(/\)\s*$/, ') async ');
        src = src.slice(0, m.index) + newSig + src.slice(blockStart);
      }

      // Recompute block-start after sig mutation.
      const m2 = mainSig.exec(src);
      const blockStart2 = m2!.index + m2![0].length - 1;
      const insertAt = blockStart2 + 1; // right after `{`

      // ensureInitialized() MUST be the very first statement inside
      // main(); preFlight() touches platform channels (shared_prefs,
      // path_provider, package_info) which would otherwise throw.
      // If someone (the old wiring, customer code) already put it
      // somewhere else inside the body, strip the stray copy first
      // so we don't end up with duplicates in random positions.
      const bodyEnd = findMatchingBrace(src, blockStart2);
      if (bodyEnd > blockStart2) {
        const bodyBefore = src.slice(insertAt, bodyEnd);
        const stripped = bodyBefore.replace(
          /^[ \t]*WidgetsFlutterBinding\.ensureInitialized\(\);\s*\n/gm,
          '',
        );
        if (stripped !== bodyBefore) {
          src = src.slice(0, insertAt) + stripped + src.slice(bodyEnd);
        }
      }

      const inject =
        `\n${bodyIndent}WidgetsFlutterBinding.ensureInitialized();\n` +
        `${bodyIndent}SankofaUpdater.registerLoader(loadModuleFromBytes);\n` +
        `${bodyIndent}await SankofaUpdater.preFlight();`;
      src = src.slice(0, insertAt) + inject + src.slice(insertAt);
    }

    writeFileSync(mainPath, src);
    console.log(chalk.green('     ✓ Wired SankofaUpdater into lib/main.dart'));
    return true;
  } catch (err: any) {
    console.log(chalk.yellow(`     ⚠ Could not auto-edit lib/main.dart: ${err.message}`));
    printManualMainSnippet(chalk, 'lib/main.dart');
    return false;
  }
}

function printManualMainSnippet(chalk: any, entryFile?: string | null): void {
  const where = entryFile
    ? `${entryFile} (your app's startup — it calls runApp)`
    : `your app's startup function (the one that calls runApp)`;
  console.log(chalk.yellow('     ⚠ ACTION REQUIRED — could not auto-wire your app startup.'));
  console.log(
    chalk.yellow(`       Sankofa Deploy patches will NOT apply until you add the wiring to ${where}.`),
  );
  console.log(
    chalk.dim('       Add the imports at the top of the file, then the two calls right after'),
  );
  console.log(chalk.dim('       WidgetsFlutterBinding.ensureInitialized() and before runApp():\n'));
  console.log(chalk.cyan(`         // ignore: depend_on_referenced_packages
         import 'package:dynamic_modules/dynamic_modules.dart';
         import 'package:sankofa_flutter/sankofa_flutter.dart';

         // inside your async startup function, before runApp():
         WidgetsFlutterBinding.ensureInitialized();
         SankofaUpdater.registerLoader(loadModuleFromBytes);
         await SankofaUpdater.preFlight();`));
}

/**
 * Locate the Flutter app's startup file when there's no standard
 * `lib/main.dart`. Flavored apps put the shared bootstrap in
 * `main_common.dart` (a `mainCommon()` that calls `runApp`), with thin
 * `main_<flavor>.dart` entrypoints. Returns the most likely bootstrap file
 * (one that calls `runApp` — preferring one that also bootstraps the
 * binding), or null if none is found.
 */
function findFlutterStartupFile(projectRoot: string): string | null {
  const libDir = join(projectRoot, 'lib');
  if (!existsSync(libDir)) return null;
  const dartFiles: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.dart')) dartFiles.push(p);
    }
  };
  try {
    walk(libDir, 0);
  } catch {
    /* permission / IO — fall through to whatever we collected */
  }
  let fallback: string | null = null;
  for (const p of dartFiles) {
    let src = '';
    try {
      src = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    if (!/runApp\s*\(/.test(src)) continue;
    if (/WidgetsFlutterBinding\.ensureInitialized\s*\(/.test(src)) return p; // best match
    fallback ??= p;
  }
  return fallback;
}

/**
 * Best-effort: download every Sankofa-built engine ABI for the
 * customer's Flutter version into `~/.sankofa/engines/`. Cache hits
 * are instant; cold cache means a one-time download (~150 MB per ABI
 * on Android). Failures are non-fatal — release time will surface a
 * clearer error if the engine ends up missing.
 */
async function ensureFlutterEngineForInit(project: ProjectInfo, chalk: any): Promise<void> {
  const ora = (await import('ora')).default;

  // Prefer the BUNDLED Sankofa Flutter version (e.g. `3.44.0+sankofa-1`)
  // because that's the SDK + engine the customer will actually build
  // against once `sankofa release` / `sankofa patch` runs. Falling back
  // to the host's `flutter --version` is wrong — those engines have
  // different SHAs and won't match the bundled runtime.
  let flutterVersion: string | undefined;
  try {
    const { resolveBundledFlutter } = await import('../utils/flutterBundleCache.js');
    flutterVersion = resolveBundledFlutter(project.root)?.sankofaEngineVersion;
  } catch {
    /* fall through */
  }
  if (!flutterVersion) {
    try {
      const { detectFlutterEngineInfo } = await import('../utils/flutterBundler.js');
      flutterVersion = detectFlutterEngineInfo(project.root).flutterVersion;
    } catch {
      console.log(chalk.dim('     · `flutter` not on PATH — skipping engine pre-fetch. Run `sankofa engine download` later.'));
      return;
    }
  }

  if (!flutterVersion || flutterVersion === 'unknown') {
    console.log(chalk.dim('     · Could not detect a Flutter version yet — skipping engine pre-fetch.'));
    return;
  }

  const { ensureFlutterEnginesForVersion } = await import('./engine.js');
  const { formatBytesHuman } = await import('../utils/engineCache.js');

  const spinner = ora(`     Resolving Sankofa engines for Flutter ${flutterVersion}…`).start();
  try {
    const results = await ensureFlutterEnginesForVersion(flutterVersion, {
      target: 'android',
      onProgress: (msg) => {
        spinner.text = `     ${msg}`;
      },
    });
    if (results.length === 0) {
      spinner.info(
        `     No engine published yet for ${flutterVersion} — \`sankofa release\` will fetch on demand.`,
      );
      return;
    }
    const hits = results.filter((r) => r.cached).length;
    const fresh = results.length - hits;
    spinner.succeed(
      `     Engine cache ready — ${results.length} ABI${results.length === 1 ? '' : 's'} for Flutter ${flutterVersion}` +
        (fresh > 0 ? ` (${fresh} freshly downloaded)` : ' (cache hits)'),
    );
    // Quick per-ABI line so the developer sees what was actually cached.
    for (const { engine, cached } of results) {
      const tag = cached ? chalk.dim('cached') : chalk.green('downloaded');
      console.log(
        chalk.dim(`       ${tag}  ${engine.target}/${engine.abi}  (${formatBytesHuman(engine.size_bytes)})`),
      );
    }
  } catch (err: any) {
    // Engine pre-fetch is a speed optimisation, not a correctness gate
    // — `sankofa release` re-resolves with current data. Soften the
    // tone so customers don't think the install itself failed.
    const msg = (err && err.message ? String(err.message) : String(err)).split('\n')[0];
    spinner.info(`     Skipped engine pre-fetch (${msg}). \`sankofa release\` will fetch on demand.`);
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
    let patched = match;

    // Probe OTA in DEBUG *too* — returns nil when no bundle is staged so
    // Metro keeps serving the JS as before, but the audit's
    // `bundle_loader_wired` flag fires on first launch, which keeps
    // `Sankofa.deploy.checkIntegration()` honest in DEBUG builds.
    const debugMetroReturn = /return RCTBundleURLProvider\.sharedSettings\(\)\.jsBundleURL\(forBundleRoot: "[^"]+"\)/;
    if (debugMetroReturn.test(patched) && !patched.includes('sankofaDeployBundleURL()')) {
      patched = patched.replace(
        debugMetroReturn,
        (metroReturn) =>
          `if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    ${metroReturn}`,
      );
    }

    const releaseReturn = 'return Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
    if (patched.includes(releaseReturn)) {
      if (!patched.includes('if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    return Bundle.main.url')) {
        patched = patched.replace(
          releaseReturn,
          `if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    ${releaseReturn}`,
        );
      }
      return patched;
    }

    // No canonical RELEASE return — inject before the final `return ...`.
    if (!patched.includes('sankofaDeployBundleURL()')) {
      patched = patched.replace(
        /\n\s*return ([^\n]+)\n\s*\}/,
        '\n    if let sankofaURL = sankofaDeployBundleURL() { return sankofaURL }\n    return $1\n  }',
      );
    }
    return patched;
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

  const iosRunner = join(cwd, 'ios', 'Runner');
  if (existsSync(iosRunner)) {
    try {
      patchFlutterIosAppDelegate(iosRunner, chalk);
      patchFlutterIosInfoPlist(iosRunner, endpoint, chalk);
      out.iosPatched = true;
    } catch (err: any) {
      console.log(chalk.yellow(`     ⚠ iOS patch failed: ${err.message}`));
    }
  }

  // Note: lib/main.dart wiring is handled later in installDeployFlutter
  // via tryWireFlutterMainDart (the canonical, SankofaUpdater-based path).
  // The legacy `patchFlutterMainDart` was injecting a duplicate
  // `Sankofa.instance.init(...)` ahead of `WidgetsFlutterBinding
  // .ensureInitialized()`, which crashed at runtime because preFlight
  // touches platform channels before binding init. That call is removed.

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

  // NOTE: we used to inject `android:name="com.sankofa.deploy
  // .SankofaDeployApplication"` here, but Flutter templates already
  // emit `android:name="${applicationName}"`, and adding a second
  // `android:name=` makes the Android manifest merger reject the
  // entire file (com.android.manifmerger.ManifestMerger2$MergeFailureException).
  // The SDK doesn't actually need a custom Application class for the
  // default Deploy + Analytics flow — `SankofaFlutterActivity` (wired
  // into MainActivity below) is the bootstrap point. Customers who
  // want native ANR/Application-level crash hooks can extend
  // `SankofaDeployApplication` manually; the cookbook documents that.

  // Inject Sankofa app_id + endpoint meta-data. We deliberately do
  // NOT write `com.sankofa.apiKey` here, because:
  //   (a) we don't have the customer's api_key yet at init time
  //       (they paste it into sankofa.yaml later), and
  //   (b) writing `${SANKOFA_API_KEY}` as a placeholder makes the
  //       Android manifest merger refuse the build when there's no
  //       matching `manifestPlaceholders` entry in build.gradle.
  // The SDK reads the api_key from `sankofa.yaml` at runtime; the
  // manifest meta-data is the fast-path for app_id + endpoint only.
  if (!xml.includes('com.sankofa.appId') && !xml.includes('com.sankofa.endpoint')) {
    const appId = readProjectId(join(androidApp, '..', '..')) ?? '';
    const appIdLine = appId
      ? `    <meta-data android:name="com.sankofa.appId" android:value="${appId}" />\n`
      : '';
    xml = xml.replace(
      /<\/application>/,
      `${appIdLine}    <meta-data android:name="com.sankofa.endpoint" android:value="${endpoint}" />\n    </application>`,
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

function patchFlutterIosAppDelegate(iosRunner: string, chalk: any) {
  const appDelegate = join(iosRunner, 'AppDelegate.swift');
  if (!existsSync(appDelegate)) {
    console.log(chalk.yellow(`     ⚠ AppDelegate.swift not found at ${appDelegate}`));
    return;
  }
  let src = readFileSync(appDelegate, 'utf-8');
  if (src.includes('SankofaFlutterAppDelegate')) {
    console.log(chalk.dim(`     · AppDelegate.swift already extends SankofaFlutterAppDelegate`));
    return;
  }

  // 1. Add the sankofa_flutter import alongside the existing Flutter import.
  if (!src.includes('import sankofa_flutter')) {
    src = src.replace(/import Flutter\n/, `import Flutter\nimport sankofa_flutter\n`);
  }

  // 2. Swap the AppDelegate's parent from FlutterAppDelegate to
  //    SankofaFlutterAppDelegate. Handles both the bare canonical
  //    shape (`class AppDelegate: FlutterAppDelegate {`) and the
  //    newer shape that mixes in FlutterImplicitEngineDelegate.
  src = src.replace(
    /class AppDelegate:\s*FlutterAppDelegate/,
    'class AppDelegate: SankofaFlutterAppDelegate',
  );

  writeFileSync(appDelegate, src);
  console.log(chalk.green(`     ✓ Patched ${appDelegate}`));
}

function patchFlutterIosInfoPlist(iosRunner: string, endpoint: string, chalk: any) {
  const plistPath = join(iosRunner, 'Info.plist');
  if (!existsSync(plistPath)) {
    console.log(chalk.yellow(`     ⚠ Info.plist not found at ${plistPath}`));
    return;
  }
  let xml = readFileSync(plistPath, 'utf-8');
  let changed = false;

  // Anchor inserts at the closing </dict>\n</plist> sequence of the
  // top-level dict. Keys are matched as literal CDATA so a `<string>`
  // that happens to contain the substring won't false-positive.
  const hasKey = (key: string) => xml.includes(`<key>${key}</key>`);
  const insertBefore = '</dict>\n</plist>';

  // Mirror the Android side: write `com.sankofa.appId` + `endpoint`
  // (known values), skip the api_key (lives in sankofa.yaml). The
  // SDK falls back to sankofa.yaml at runtime if either is missing.
  const projectRoot = join(iosRunner, '..', '..');
  const appId = readProjectId(projectRoot) ?? '';
  if (appId && !hasKey('com.sankofa.appId')) {
    xml = xml.replace(
      insertBefore,
      `\t<key>com.sankofa.appId</key>\n\t<string>${appId}</string>\n${insertBefore}`,
    );
    changed = true;
  }
  if (!hasKey('com.sankofa.endpoint')) {
    xml = xml.replace(
      insertBefore,
      `\t<key>com.sankofa.endpoint</key>\n\t<string>${endpoint}</string>\n${insertBefore}`,
    );
    changed = true;
  }

  if (changed) {
    writeFileSync(plistPath, xml);
    console.log(chalk.green(`     ✓ Patched ${plistPath}`));
  } else {
    console.log(chalk.dim(`     · Info.plist already has Sankofa keys`));
  }
}

// patchFlutterMainDart was the legacy SankofaDeploy-style wiring; it
// was retired because it injected `Sankofa.instance.init(...)` ahead of
// `WidgetsFlutterBinding.ensureInitialized()`, which crashes on any
// project that also runs the new SankofaUpdater path (the universal one
// in 0.2.x). The canonical wiring is `tryWireFlutterMainDart` above.
