import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveProjectRoot } from '../utils/stack.js';
import { STACK_LABELS } from '../utils/stack.js';
import { bundledFlutterInfo, installBundledFlutter } from '../utils/flutterBundleCache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `sankofa update` — stack-smart, one-command updater.
 *
 * Inspects the current project + machine state and brings every Sankofa
 * surface up to date:
 *
 *   1. The CLI itself (`sankofa-cli` on npm)
 *   2. The Sankofa bundled Flutter SDK (~/.sankofa/flutter/<version>/)
 *   3. Engine binaries (~/.sankofa/engines/...) — registry-driven
 *   4. The project's Sankofa SDK package (pubspec.yaml or package.json)
 *
 * Each step is gated by a `--check` flag that reports what's stale
 * without modifying anything — handy in CI to fail closed when drift
 * exceeds policy.
 *
 * Stack-smart: in an RN project, step 4 runs `npm install
 * sankofa-react-native@latest`; in a Flutter project, it bumps the
 * sankofa_flutter pubspec entry (or prints the instruction when the
 * dep is git-pinned). Outside of a project, steps 2–4 are skipped.
 */
export const updateCommand = new Command('update')
  .description('Update everything Sankofa knows about — CLI, bundled Flutter, engine cache, project SDK')
  .option('--check', 'Report what is stale; do not modify anything')
  .option('--only <surface>', 'Restrict to one surface: cli | flutter | engine | sdk')
  .option('--engine-version <version>', 'Target a specific engine version (default: project pin or latest)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    const only: string | undefined = opts.only?.toLowerCase();
    const dryRun = !!opts.check;
    const includeAll = !only;
    const wants = (key: string) => includeAll || only === key;

    console.log('');
    console.log(chalk.bold('  Sankofa update'));
    if (dryRun) console.log(chalk.yellow('  (dry-run — nothing will be modified)'));
    console.log('');

    let project: Awaited<ReturnType<typeof resolveProjectRoot>> | null = null;
    try {
      project = await resolveProjectRoot({});
    } catch {
      // Not inside a project — only CLI / engine / bundled-flutter updates apply.
    }

    // ── 1. CLI itself ────────────────────────────────────────────────
    if (wants('cli')) {
      await stepUpdateCli(dryRun, chalk);
    }

    // ── 2. Bundled Flutter SDK ───────────────────────────────────────
    if (wants('flutter')) {
      await stepUpdateBundledFlutter(project?.root, opts.engineVersion, dryRun, chalk);
    }

    // ── 3. Engine binaries ───────────────────────────────────────────
    if (wants('engine')) {
      await stepUpdateEngines(project?.root, opts.engineVersion, dryRun, chalk);
    }

    // ── 4. Project SDK package ───────────────────────────────────────
    if (wants('sdk') && project) {
      await stepUpdateProjectSdk(project, dryRun, chalk);
    }

    console.log('');
    if (dryRun) {
      console.log(chalk.dim('  Re-run without --check to apply the updates above.'));
    } else {
      console.log(chalk.green('  ✓ Update complete.'));
    }
    console.log('');
  });

// ── Step 1: CLI ─────────────────────────────────────────────────────

async function stepUpdateCli(dryRun: boolean, chalk: any): Promise<void> {
  const ora = (await import('ora')).default;
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const current: string = pkg.version || '0.0.0';
  const name: string = pkg.name || 'sankofa-cli';

  const spinner = ora(`  [1/4] CLI — checking npm for newer ${name}…`).start();
  let latest: string;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const data = (await res.json()) as any;
    latest = data.version;
  } catch (err: any) {
    spinner.warn(`  [1/4] CLI — could not reach npm: ${err.message}`);
    return;
  }

  if (compareSemver(latest, current) <= 0) {
    spinner.succeed(`  [1/4] CLI — already at latest (${current})`);
    return;
  }

  if (dryRun) {
    spinner.warn(`  [1/4] CLI — newer version ${latest} available (current ${current})`);
    return;
  }

  spinner.text = `  [1/4] CLI — installing ${name}@${latest}…`;
  try {
    execSync(`npm install -g ${name}@latest`, { stdio: 'ignore' });
    spinner.succeed(`  [1/4] CLI — upgraded ${current} → ${latest}`);
  } catch (err: any) {
    spinner.fail(`  [1/4] CLI — npm install -g failed: ${err.message}`);
    console.log(chalk.dim('       Try sudo, or fix the global npm prefix permissions.'));
  }
}

// ── Step 2: Bundled Flutter SDK ────────────────────────────────────

async function stepUpdateBundledFlutter(
  projectRoot: string | undefined,
  explicitVersion: string | undefined,
  dryRun: boolean,
  chalk: any,
): Promise<void> {
  const ora = (await import('ora')).default;
  const version = resolveTargetEngineVersion(projectRoot, explicitVersion);
  if (!version) {
    console.log(chalk.dim('  [2/4] Bundled Flutter — no project pin and no --engine-version; skip'));
    return;
  }

  const info = bundledFlutterInfo(version);
  if (info.exists) {
    // For now we don't auto-refresh an existing bundle; future work can
    // resolve the registry's preferred ref and `git pull`. The presence
    // alone is the contract for v1.
    console.log(chalk.green(`  [2/4] Bundled Flutter — ${version} present`));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow(`  [2/4] Bundled Flutter — ${version} MISSING (would clone Sankofa-HQ/sankofa-flutter)`));
    return;
  }

  const spinner = ora(`  [2/4] Bundled Flutter — cloning ${version}…`).start();
  try {
    installBundledFlutter(version, {
      onProgress: (msg) => {
        spinner.text = `  [2/4] Bundled Flutter — ${msg}`;
      },
    });
    spinner.succeed(`  [2/4] Bundled Flutter — ${version} ready`);
  } catch (err: any) {
    spinner.fail(`  [2/4] Bundled Flutter — clone failed: ${err.message}`);
  }
}

// ── Step 3: Engine binaries ────────────────────────────────────────

async function stepUpdateEngines(
  projectRoot: string | undefined,
  explicitVersion: string | undefined,
  dryRun: boolean,
  chalk: any,
): Promise<void> {
  const version = resolveTargetEngineVersion(projectRoot, explicitVersion);
  if (!version) {
    console.log(chalk.dim('  [3/4] Engine cache — no project pin and no --engine-version; skip'));
    return;
  }

  const { fetchKnownEngines } = await import('../utils/engineRegistry.js');
  const { tryEngineCacheHit, downloadEngineIntoCache, formatBytesHuman } = await import(
    '../utils/engineCache.js'
  );

  let knownEngines;
  try {
    knownEngines = await fetchKnownEngines({ sankofaEngineVersion: version });
  } catch (err: any) {
    console.log(chalk.yellow(`  [3/4] Engine cache — could not reach registry: ${err.message}`));
    return;
  }

  if (knownEngines.length === 0) {
    console.log(chalk.dim(`  [3/4] Engine cache — registry has no engines for ${version}`));
    return;
  }

  const missing = knownEngines.filter((e) => !tryEngineCacheHit(e));
  if (missing.length === 0) {
    console.log(chalk.green(`  [3/4] Engine cache — all ${knownEngines.length} ABIs present`));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow(`  [3/4] Engine cache — ${missing.length}/${knownEngines.length} ABIs MISSING:`));
    for (const e of missing) {
      console.log(chalk.dim(`            · ${e.target}/${e.abi} (${formatBytesHuman(e.size_bytes)})`));
    }
    return;
  }

  console.log(chalk.bold(`  [3/4] Engine cache — fetching ${missing.length} ABI${missing.length === 1 ? '' : 's'}`));
  for (const e of missing) {
    const label = `${e.target}/${e.abi}`;
    try {
      await downloadEngineIntoCache(e);
      console.log(`         ✓ ${label}`);
    } catch (err: any) {
      console.log(chalk.red(`         ✗ ${label} — ${err.message}`));
    }
  }
}

// ── Step 4: Project SDK package ────────────────────────────────────

async function stepUpdateProjectSdk(
  project: Awaited<ReturnType<typeof resolveProjectRoot>>,
  dryRun: boolean,
  chalk: any,
): Promise<void> {
  if (project.stack === 'react-native' || project.stack === 'web') {
    await stepUpdateNpmSdk(project.root, dryRun, chalk);
  } else if (project.stack === 'flutter') {
    await stepUpdateFlutterSdk(project.root, dryRun, chalk);
  } else {
    console.log(chalk.dim(`  [4/4] SDK package — ${STACK_LABELS[project.stack]} not yet supported`));
  }
}

async function stepUpdateNpmSdk(projectRoot: string, dryRun: boolean, chalk: any): Promise<void> {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log(chalk.dim('  [4/4] SDK — no package.json'));
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const sdkName = 'sankofa-react-native';
  const current = deps[sdkName];
  if (!current) {
    console.log(chalk.dim(`  [4/4] SDK — ${sdkName} not in package.json`));
    return;
  }

  let latest: string;
  try {
    const res = await fetch(`https://registry.npmjs.org/${sdkName}/latest`);
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const data = (await res.json()) as any;
    latest = data.version;
  } catch (err: any) {
    console.log(chalk.yellow(`  [4/4] SDK — could not reach npm: ${err.message}`));
    return;
  }

  // Trim caret/tilde for the comparison.
  const cleaned = current.replace(/^[^\d]*/, '');
  if (compareSemver(latest, cleaned) <= 0) {
    console.log(chalk.green(`  [4/4] SDK — ${sdkName}@${cleaned} is latest`));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow(`  [4/4] SDK — ${sdkName}: ${cleaned} → ${latest} available`));
    return;
  }

  try {
    execSync(`npm install ${sdkName}@latest`, { cwd: projectRoot, stdio: 'inherit' });
    console.log(chalk.green(`  [4/4] SDK — ${sdkName} upgraded to ${latest}`));
  } catch (err: any) {
    console.log(chalk.red(`  [4/4] SDK — npm install failed: ${err.message}`));
  }
}

async function stepUpdateFlutterSdk(projectRoot: string, dryRun: boolean, chalk: any): Promise<void> {
  const pubspecPath = join(projectRoot, 'pubspec.yaml');
  if (!existsSync(pubspecPath)) {
    console.log(chalk.dim('  [4/4] SDK — no pubspec.yaml'));
    return;
  }
  const text = readFileSync(pubspecPath, 'utf-8');
  if (!text.includes('sankofa_flutter')) {
    console.log(chalk.dim('  [4/4] SDK — sankofa_flutter not in pubspec.yaml'));
    return;
  }

  // For git-pinned dependencies the right "update" is `flutter pub upgrade
  // sankofa_flutter` — which the bundled flutter handles. For pub.dev
  // version constraints we'd bump the constraint. Until sankofa_flutter
  // is on pub.dev, all our integrations are git-pinned, so we shell out.
  if (dryRun) {
    console.log(chalk.yellow('  [4/4] SDK — would run `flutter pub upgrade sankofa_flutter`'));
    return;
  }

  try {
    // Use the bundled flutter when available (resolveFlutterBinary handles it).
    const { resolveFlutterBinary } = await import('../utils/flutterBundler.js');
    const flutterBin = resolveFlutterBinary(projectRoot);
    execSync(`${flutterBin} pub upgrade sankofa_flutter`, { cwd: projectRoot, stdio: 'inherit' });
    console.log(chalk.green('  [4/4] SDK — sankofa_flutter upgraded'));
  } catch (err: any) {
    console.log(chalk.red(`  [4/4] SDK — flutter pub upgrade failed: ${err.message}`));
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function resolveTargetEngineVersion(
  projectRoot: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (process.env.SANKOFA_ENGINE_VERSION) return process.env.SANKOFA_ENGINE_VERSION;
  if (projectRoot) {
    const yamlPath = join(projectRoot, 'sankofa.yaml');
    if (existsSync(yamlPath)) {
      try {
        const text = readFileSync(yamlPath, 'utf-8');
        const m = text.match(/^\s*engine_version:\s*['"]?([\w.+-]+)['"]?\s*$/m);
        if (m) return m[1];
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
