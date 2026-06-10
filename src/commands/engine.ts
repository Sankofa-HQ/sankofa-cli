import { Command } from 'commander';
import {
  fetchKnownEngines,
  registerKnownEngine,
  resolveEndpointOnly,
  type KnownEngine,
  type RegisterEnginePayload,
} from '../utils/engineRegistry.js';
import {
  downloadEngineIntoCache,
  ensureEngineCached,
  engineCacheRoot,
  formatBytesHuman,
  listCachedEngines,
  sha256OfFile,
  tryEngineCacheHit,
} from '../utils/engineCache.js';
import { detectFlutterEngineInfo } from '../utils/flutterBundler.js';
import {
  installBundledFlutter,
  bundledFlutterInfo,
} from '../utils/flutterBundleCache.js';
import {
  DEFAULT_ENGINE_VERSION,
  resolveLatestEngineVersion,
} from '../utils/engineVersion.js';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve as pathResolve } from 'path';

/**
 * `sankofa engine` — manage the local cache of Sankofa-built Flutter
 * engine binaries (`libflutter.so` / `Flutter.framework`).
 *
 * Subcommands:
 *
 *   list        Show what's cached on this machine + what's available.
 *   download    Pull one or more engines into the cache.
 *   verify      Check that the cached binaries match the registry's SHAs.
 *   path        Print the cache directory (handy in shell scripts).
 *
 * The cache lives at `~/.sankofa/engines/` by default; override via the
 * `SANKOFA_HOME` env var (used by CI + tests to keep host caches clean).
 */
export const engineCommand = new Command('engine')
  .description('Manage cached Sankofa Flutter engine binaries (libflutter.so / Flutter.framework)');

// ── sankofa engine list ────────────────────────────────────────────
engineCommand
  .command('list')
  .description('Show cached engines + everything available in the registry')
  .option('--flutter-version <version>', 'Filter to one Flutter version')
  .option('--target <android|ios>', 'Filter to one target platform')
  .option('--modified-only', 'Only show Sankofa-modified engine builds')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    let known: KnownEngine[];
    try {
      known = await fetchKnownEngines({
        flutterVersion: opts.flutterVersion,
        target: opts.target,
        modifiedOnly: opts.modifiedOnly,
      });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    const cached = listCachedEngines();
    const cachedShas = new Set(cached.map((c) => c.engine.sha256));

    console.log('');
    console.log(chalk.bold('  Available engines'));
    console.log(chalk.dim(`  Cache root: ${engineCacheRoot()}`));
    console.log('');

    if (known.length === 0) {
      console.log(chalk.dim('    (registry returned no engines for that filter)'));
      console.log('');
      return;
    }

    const cols = ['', 'VERSION', 'TARGET', 'ABI', 'SIZE', 'MODIFIED', 'STATE'];
    console.log(
      chalk.dim(
        `    ${cols[0].padEnd(2)} ${cols[1].padEnd(20)} ${cols[2].padEnd(8)} ${cols[3].padEnd(14)} ${cols[4].padEnd(10)} ${cols[5].padEnd(10)} ${cols[6]}`,
      ),
    );
    for (const e of known) {
      const isCached = cachedShas.has(e.sha256);
      const mark = isCached ? chalk.green('●') : chalk.dim('○');
      const state = isCached ? chalk.green('cached') : chalk.dim('not cached');
      const modified = e.is_modified
        ? chalk.cyan('+sankofa')
        : chalk.dim('vanilla');
      console.log(
        `    ${mark}  ${chalk.bold(e.sankofa_engine_version.padEnd(20))} ${e.target.padEnd(8)} ${e.abi.padEnd(14)} ${formatBytesHuman(e.size_bytes).padEnd(10)} ${modified.padEnd(20)} ${state}`,
      );
    }
    console.log('');
    console.log(
      chalk.dim(
        `    ${chalk.green('●')} cached locally    ${chalk.dim('○')} downloadable via \`sankofa engine download\``,
      ),
    );
    console.log('');
  });

// ── sankofa engine download ────────────────────────────────────────
engineCommand
  .command('download')
  .description('Download Sankofa engine binaries into the local cache')
  .option('--flutter-version <version>', 'Flutter version (defaults to the active `flutter --version`)')
  .option('--target <android|ios>', 'Target platform (defaults to both)')
  .option('--abi <abi>', 'ABI to download (default: every ABI for the target)')
  .option('--force', 'Re-download even if a valid cache hit exists')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    let flutterVersion = opts.flutterVersion;
    if (!flutterVersion) {
      try {
        flutterVersion = detectFlutterEngineInfo().flutterVersion;
      } catch {
        console.error(
          chalk.red('  ✖ Could not detect Flutter version. Pass --flutter-version explicitly.'),
        );
        process.exit(1);
      }
    }

    let candidates: KnownEngine[];
    try {
      candidates = await fetchKnownEngines({ flutterVersion });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    if (opts.target) {
      candidates = candidates.filter((e) => e.target === opts.target);
    }
    if (opts.abi) {
      candidates = candidates.filter((e) => e.abi === opts.abi);
    }

    if (candidates.length === 0) {
      console.error(
        chalk.red(
          `  ✖ No engines match flutter_version=${flutterVersion}` +
            (opts.target ? ` target=${opts.target}` : '') +
            (opts.abi ? ` abi=${opts.abi}` : '') +
            `.`,
        ),
      );
      console.error(chalk.dim('     Run `sankofa engine list` to see what the registry has.'));
      process.exit(1);
    }

    console.log('');
    console.log(chalk.bold(`  Downloading ${candidates.length} engine${candidates.length === 1 ? '' : 's'} (Flutter ${flutterVersion})`));
    console.log('');

    for (const engine of candidates) {
      const label = `${engine.target} ${engine.abi} (${formatBytesHuman(engine.size_bytes)})`;
      const cached = !opts.force && tryEngineCacheHit(engine);
      if (cached) {
        console.log(`  ${chalk.green('✓')} ${label} — cached at ${chalk.dim(cached.path)}`);
        continue;
      }
      const spinner = ora(`  ${label} — starting…`).start();
      try {
        let lastPercent = -1;
        await downloadEngineIntoCache(engine, {
          onProgress: (received, total) => {
            const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
            // Tight throttling: redraw the spinner only on integer
            // percent changes so we don't choke the TTY on ~150 MB
            // streams.
            if (pct !== lastPercent) {
              lastPercent = pct;
              spinner.text = `  ${label} — ${pct}%  ${formatBytesHuman(received)}/${formatBytesHuman(total)}`;
            }
          },
        });
        spinner.succeed(`  ${label} — downloaded`);
      } catch (err: any) {
        spinner.fail(`  ${label} — ${err.message}`);
        process.exit(1);
      }
    }

    console.log('');
    console.log(chalk.dim(`  Cache root: ${engineCacheRoot()}`));
    console.log('');
  });

// ── sankofa engine install ─────────────────────────────────────────
//
// The "do everything for this engine version" command. Customers run this
// once per Sankofa engine version on a fresh machine. It:
//
//   1. Clones the Sankofa-HQ/sankofa-flutter fork into
//      ~/.sankofa/flutter/<version>/  (bundled SDK; customer's own
//      `flutter` on PATH is untouched).
//   2. Downloads every engine ABI artifact for that version into
//      ~/.sankofa/engines/<flutter-version>/ via `engine download`.
//
// After this, `sankofa release` / `sankofa patch` / `sankofa preview`
// all shell out to the bundled flutter at the version pinned by
// sankofa.yaml's `engine_version`. The customer never has to think
// about engine wiring again.
engineCommand
  .command('install [version]')
  .description('Install the Sankofa bundled Flutter SDK + engine binaries for a version')
  .option('--local-path <path>', 'Use a local sankofa-flutter checkout instead of cloning')
  .option('--ref <branch|tag|sha>', 'Specific git ref to install (default: branch tracking the version)')
  .option('--force', 'Re-clone / re-download even if already present')
  .option('--skip-engines', 'Only install the bundled flutter SDK; skip the per-ABI engine download')
  .action(async (version: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    // Resolve version: arg > env > latest published on the CDN.
    let resolved = version || process.env.SANKOFA_ENGINE_VERSION;
    if (!resolved) {
      const latest = await resolveLatestEngineVersion();
      resolved = latest.version;
      if (latest.source === 'fallback') {
        console.log(chalk.dim(`  (CDN unreachable — using built-in default ${resolved})`));
      }
    }

    console.log('');
    console.log(chalk.bold(`  Installing Sankofa engine ${resolved}`));
    console.log('');

    // Step 1: bundled flutter SDK.
    const present = bundledFlutterInfo(resolved);
    if (present.exists && !opts.force) {
      console.log(`  ${chalk.green('✓')} Bundled flutter already present at ${chalk.dim(present.root)}`);
    } else {
      const spinner = ora('  Installing bundled flutter SDK…').start();
      try {
        const info = installBundledFlutter(resolved, {
          reuseIfPresent: !opts.force,
          localPath: opts.localPath,
          ref: opts.ref,
          onProgress: (msg) => {
            spinner.text = `  ${msg}`;
          },
        });
        spinner.succeed(`  Bundled flutter ready at ${chalk.dim(info.root)}`);
      } catch (err: any) {
        spinner.fail(`  Bundled flutter install failed: ${err.message}`);
        process.exit(1);
      }
    }

    // Step 2: per-ABI engine binaries (Android libflutter.so / iOS framework).
    if (opts.skipEngines) {
      console.log('');
      console.log(chalk.dim('  (skipping engine binary download — --skip-engines)'));
      console.log('');
      return;
    }

    let knownEngines: KnownEngine[];
    try {
      knownEngines = await fetchKnownEngines({
        sankofaEngineVersion: resolved,
      });
    } catch (err: any) {
      console.error(chalk.yellow(`  ⚠ Could not reach the registry (${err.message}).`));
      console.error(chalk.dim('     The bundled SDK is installed; run `sankofa engine download` later to pull engine binaries.'));
      console.log('');
      return;
    }

    if (knownEngines.length === 0) {
      console.log(chalk.yellow(`  ⚠ Registry has no engines tagged ${resolved}.`));
      console.log(chalk.dim('     Run `sankofa engine list` to inspect available versions.'));
      console.log('');
      return;
    }

    console.log('');
    console.log(chalk.bold(`  Downloading ${knownEngines.length} engine binar${knownEngines.length === 1 ? 'y' : 'ies'}`));
    console.log('');

    for (const engine of knownEngines) {
      const label = `${engine.target} ${engine.abi} (${formatBytesHuman(engine.size_bytes)})`;
      const cached = !opts.force && tryEngineCacheHit(engine);
      if (cached) {
        console.log(`  ${chalk.green('✓')} ${label} — cached at ${chalk.dim(cached.path)}`);
        continue;
      }
      const spinner = ora(`  ${label} — starting…`).start();
      try {
        let lastPercent = -1;
        await downloadEngineIntoCache(engine, {
          onProgress: (received, total) => {
            const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
            if (pct !== lastPercent) {
              lastPercent = pct;
              spinner.text = `  ${label} — ${pct}%  ${formatBytesHuman(received)}/${formatBytesHuman(total)}`;
            }
          },
        });
        spinner.succeed(`  ${label} — downloaded`);
      } catch (err: any) {
        spinner.fail(`  ${label} — ${err.message}`);
        process.exit(1);
      }
    }

    console.log('');
    console.log(chalk.green(`  ✓ Sankofa engine ${resolved} ready.`));
    console.log(chalk.dim(`    Bundled flutter:  ~/.sankofa/flutter/${resolved}/`));
    console.log(chalk.dim(`    Engine cache:     ${engineCacheRoot()}`));
    console.log('');
  });

// ── sankofa engine upgrade ─────────────────────────────────────────
//
// THE one-command engine bump. Run inside a project:
//
//   sankofa engine upgrade
//
// 1. Asks the CDN for the newest published engine version (latest.json,
//    written by every engine release).
// 2. Installs its bundled Flutter SDK + engine binaries (skips anything
//    already cached).
// 3. Re-pins the project: `engine_version:` in sankofa.yaml and the
//    `.sankofa/flutter-version` file.
//
// Subsequent `sankofa release` / `sankofa patch` / `sankofa preview`
// pick up the new engine automatically. Outside a project, steps 1–2
// still run (machine-level upgrade); the re-pin is skipped.
engineCommand
  .command('upgrade')
  .description('Upgrade to the newest published Sankofa engine (installs + re-pins the project)')
  .option('--version <version>', 'Target a specific engine version instead of latest')
  .option('--check', 'Only report what would change; do not install or re-pin')
  .option('--force', 'Re-clone / re-download even if already present')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    console.log('');
    console.log(chalk.bold('  Sankofa engine upgrade'));
    console.log('');

    // 1) What's the target?
    let target: string = opts.version;
    if (!target) {
      const spinner = ora('  Resolving latest published engine…').start();
      const latest = await resolveLatestEngineVersion();
      target = latest.version;
      if (latest.source === 'cdn') {
        spinner.succeed(`  Latest published engine: ${chalk.bold(target)}`);
      } else {
        spinner.warn(`  CDN unreachable — falling back to built-in ${chalk.bold(target)}`);
      }
    }

    // 2) Where are we now? (project pin, if inside a project)
    const projectRoot = findProjectRootForPin(process.cwd());
    const currentPin = projectRoot ? readEnginePin(projectRoot) : undefined;
    if (projectRoot) {
      console.log(
        `  Project: ${chalk.dim(projectRoot)}` +
          (currentPin ? `  (pinned: ${currentPin})` : '  (no engine pin yet)'),
      );
    } else {
      console.log(chalk.dim('  Not inside a Sankofa project — machine-level upgrade only.'));
    }
    console.log('');

    const bundlePresent = bundledFlutterInfo(target).exists;
    if (currentPin === target && bundlePresent && !opts.force) {
      console.log(chalk.green(`  ✓ Already on ${target} — nothing to do.`));
      console.log('');
      return;
    }

    if (opts.check) {
      if (currentPin !== target && projectRoot) {
        console.log(chalk.yellow(`  Would re-pin ${currentPin ?? '(unset)'} → ${target}`));
      }
      if (!bundlePresent) {
        console.log(chalk.yellow(`  Would install bundled Flutter + engine binaries for ${target}`));
      }
      console.log('');
      console.log(chalk.dim('  Re-run without --check to apply.'));
      console.log('');
      return;
    }

    // 3) Install bundle + engines (delegates to the same machinery as
    //    `engine install`).
    const installSpinner = ora(`  Installing bundled Flutter SDK ${target}…`).start();
    try {
      const info = installBundledFlutter(target, {
        reuseIfPresent: !opts.force,
        onProgress: (msg) => {
          installSpinner.text = `  ${msg}`;
        },
      });
      installSpinner.succeed(`  Bundled flutter ready at ${chalk.dim(info.root)}`);
    } catch (err: any) {
      installSpinner.fail(`  Bundled flutter install failed: ${err.message}`);
      process.exit(1);
    }

    try {
      const knownEngines = await fetchKnownEngines({ sankofaEngineVersion: target });
      for (const engine of knownEngines) {
        const label = `${engine.target} ${engine.abi} (${formatBytesHuman(engine.size_bytes)})`;
        if (!opts.force && tryEngineCacheHit(engine)) {
          console.log(`  ${chalk.green('✓')} ${label} — cached`);
          continue;
        }
        const spinner = ora(`  ${label} — downloading…`).start();
        try {
          await downloadEngineIntoCache(engine, {
            onProgress: (received, total) => {
              const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
              spinner.text = `  ${label} — ${pct}%`;
            },
          });
          spinner.succeed(`  ${label} — downloaded`);
        } catch (err: any) {
          // Engine-binary cache misses don't block the upgrade: the
          // bundled SDK pulls the same engine through the build itself.
          spinner.warn(`  ${label} — ${err.message} (will be fetched at build time)`);
        }
      }
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Engine registry unreachable (${err.message}) — binaries will be fetched at build time.`));
    }

    // 4) Re-pin the project.
    if (projectRoot) {
      writeEnginePin(projectRoot, target);
      console.log('');
      console.log(`  ${chalk.green('✓')} Project re-pinned to ${chalk.bold(target)}`);
      console.log(chalk.dim(`    sankofa.yaml engine_version + .sankofa/flutter-version updated`));
    }

    console.log('');
    console.log(chalk.green(`  ✓ Engine upgrade to ${target} complete.`));
    if (projectRoot) {
      console.log(chalk.dim('    Next release/patch builds with the new engine automatically:'));
      console.log(chalk.cyan('      sankofa release android   # or: sankofa release ios'));
    }
    console.log('');
  });

/** Walk up from `start` to the nearest directory holding a sankofa.yaml. */
function findProjectRootForPin(start: string): string | null {
  let dir = pathResolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'sankofa.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Current engine pin: .sankofa/flutter-version beats sankofa.yaml. */
function readEnginePin(projectRoot: string): string | undefined {
  const pinFile = join(projectRoot, '.sankofa', 'flutter-version');
  if (existsSync(pinFile)) {
    try {
      const v = readFileSync(pinFile, 'utf-8').trim();
      if (v) return v;
    } catch { /* fall through */ }
  }
  const yamlPath = join(projectRoot, 'sankofa.yaml');
  if (existsSync(yamlPath)) {
    try {
      const m = readFileSync(yamlPath, 'utf-8').match(/^\s*engine_version:\s*['"]?([\w.+-]+)['"]?\s*$/m);
      if (m) return m[1];
    } catch { /* fall through */ }
  }
  return undefined;
}

/** Write the pin to BOTH places `resolveBundledFlutter` reads. */
function writeEnginePin(projectRoot: string, version: string): void {
  const yamlPath = join(projectRoot, 'sankofa.yaml');
  if (existsSync(yamlPath)) {
    const text = readFileSync(yamlPath, 'utf-8');
    const updated = /^\s*engine_version:/m.test(text)
      ? text.replace(/^(\s*engine_version:\s*).*$/m, `$1${version}`)
      : `${text.replace(/\n*$/, '\n')}engine_version: ${version}\n`;
    writeFileSync(yamlPath, updated);
  }
  const pinDir = join(projectRoot, '.sankofa');
  mkdirSync(pinDir, { recursive: true });
  writeFileSync(join(pinDir, 'flutter-version'), `${version}\n`);
}

// ── sankofa engine verify ──────────────────────────────────────────
engineCommand
  .command('verify')
  .description('Re-hash every cached engine and compare to the registry')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const cached = listCachedEngines();
    if (cached.length === 0) {
      console.log(chalk.dim('  No engines cached. Run `sankofa engine download` to populate the cache.'));
      return;
    }

    let known: KnownEngine[];
    try {
      known = await fetchKnownEngines();
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }
    const knownBySha = new Map(known.map((e) => [e.sha256, e]));

    let ok = 0;
    let bad = 0;
    for (const entry of cached) {
      const expected = knownBySha.get(entry.engine.sha256);
      if (!expected) {
        bad++;
        console.log(
          `  ${chalk.yellow('?')} ${entry.engine.sankofa_engine_version} ${entry.engine.target}/${entry.engine.abi} — SHA not in registry (engine was retired or your registry is stale)`,
        );
        continue;
      }
      // Re-lookup via locateEngineInCache to force an integrity SHA check
      // when applicable.
      const refreshed = tryEngineCacheHit(entry.engine);
      if (refreshed) {
        ok++;
        console.log(`  ${chalk.green('✓')} ${entry.engine.sankofa_engine_version} ${entry.engine.target}/${entry.engine.abi}`);
      } else {
        bad++;
        console.log(
          `  ${chalk.red('✗')} ${entry.engine.sankofa_engine_version} ${entry.engine.target}/${entry.engine.abi} — SHA mismatch. Re-download with \`sankofa engine download --force --target ${entry.engine.target} --abi ${entry.engine.abi}\`.`,
        );
      }
    }

    console.log('');
    console.log(`  ${ok} ok, ${bad} ${bad === 1 ? 'issue' : 'issues'}`);
    if (bad > 0) process.exit(2);
  });

// ── sankofa engine path ────────────────────────────────────────────
engineCommand
  .command('path')
  .description('Print the engine cache root (useful in shell scripts)')
  .action(() => {
    console.log(engineCacheRoot());
  });

// ── sankofa engine register ────────────────────────────────────────
//
// Sankofa-internal admin write. POSTs to /api/v1/admin/engines/ so the
// server adds the SHA to its known_engines trust list. Hidden from
// `--help` because Deploy is dedicated-hosted only: customers never
// touch a server, never hold the registry token, and never publish
// engines. This command exists for Sankofa ops:
//
//   - Recovery when CI's register-engine.sh call fails partway through
//     an engine release
//   - One-off internal builds (engineers iterating on the engine fork
//     locally before promoting via CI)
//   - Bootstrap of a freshly-provisioned dedicated host
//
// Auth is the engine registry token (separate from any customer token)
// sourced from --token or $SANKOFA_ENGINE_REGISTRY_TOKEN. Without it
// the server refuses the POST with 401.
//
// Two modes:
//   1. --file <path>  → SHA + size auto-computed from the local artifact
//   2. --sha256 + --size-bytes  → caller supplies values directly (e.g.
//      in CI after computing them upstream)
//
// In either mode the structural fields (--flutter-version, --target,
// --abi, --sankofa-engine-version, --object-key) are required because
// they can't be reliably inferred from a stripped libflutter.so.
engineCommand
  .command('register')
  .description('[Sankofa-internal] Register an engine SHA with the server. Requires $SANKOFA_ENGINE_REGISTRY_TOKEN.')
  .option('--file <path>', 'Compute sha256 + size_bytes from this local binary')
  .option('--sha256 <hex>', 'Engine SHA-256 (lowercase hex, 64 chars)')
  .option('--size-bytes <n>', 'Engine size in bytes')
  .option('--flutter-version <version>', 'Upstream Flutter version, e.g. 3.41.9')
  .option('--target <android|ios>', 'Target platform')
  .option('--abi <abi>', 'ABI (arm64-v8a / armeabi-v7a / x86_64 / device-arm64 / sim-arm64 / sim-x64)')
  .option('--sankofa-engine-version <id>', 'Engine identity, e.g. 3.41.9+sankofa-1')
  .option('--object-key <key>', 'B2 object key, e.g. engines/flutter/3.41.9/android-arm64-release/libflutter.stripped.so')
  .option('--runtime-mode <mode>', 'Runtime mode (default: release)', 'release')
  .option('--no-modified', 'Mark this as a VANILLA engine (default: modified)')
  .option('--source-commit <sha>', 'Optional source commit hash')
  .option('--built-at <iso>', 'RFC3339 build timestamp (default: now)')
  .option('--endpoint <url>', 'Override the server endpoint (default: from config / SANKOFA_ENDPOINT)')
  .option('--token <hex>', 'Engine registry token (default: $SANKOFA_ENGINE_REGISTRY_TOKEN)')
  .option('--dry-run', 'Print the payload and skip the POST')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    // Resolve sha + size — either from a file or from explicit flags.
    let sha256: string | undefined = opts.sha256?.toLowerCase();
    let sizeBytes: number | undefined = opts.sizeBytes ? Number(opts.sizeBytes) : undefined;
    if (opts.file) {
      const absolute = pathResolve(opts.file);
      try {
        sha256 = sha256OfFile(absolute);
        sizeBytes = statSync(absolute).size;
      } catch (err: any) {
        console.error(chalk.red(`  ✖ Could not hash ${absolute}: ${err?.message ?? err}`));
        process.exit(1);
      }
    }

    const required = {
      sha256,
      sizeBytes,
      flutter_version: opts.flutterVersion,
      target: opts.target,
      abi: opts.abi,
      sankofa_engine_version: opts.sankofaEngineVersion,
      object_key: opts.objectKey,
    };
    const missing = Object.entries(required)
      .filter(([, v]) => v === undefined || v === null || v === '')
      .map(([k]) => k);
    if (missing.length > 0) {
      console.error(chalk.red(`  ✖ Missing required field(s): ${missing.join(', ')}`));
      console.error(chalk.dim('     Use --file <path> to auto-derive sha256 + size_bytes,'));
      console.error(chalk.dim('     or pass --sha256 + --size-bytes explicitly.'));
      process.exit(1);
    }

    if (!/^[0-9a-f]{64}$/.test(sha256!)) {
      console.error(chalk.red(`  ✖ --sha256 must be 64 lowercase hex chars; got ${sha256!.length} chars`));
      process.exit(1);
    }
    if (!Number.isFinite(sizeBytes!) || sizeBytes! <= 0) {
      console.error(chalk.red(`  ✖ --size-bytes must be a positive integer; got ${opts.sizeBytes}`));
      process.exit(1);
    }

    const payload: RegisterEnginePayload = {
      flutter_version: opts.flutterVersion,
      target: opts.target,
      abi: opts.abi,
      runtime_mode: opts.runtimeMode,
      sankofa_engine_version: opts.sankofaEngineVersion,
      is_modified: opts.modified !== false, // commander stores --no-modified as `modified: false`
      sha256: sha256!,
      size_bytes: sizeBytes!,
      source_commit: opts.sourceCommit,
      object_key: opts.objectKey,
      built_at: opts.builtAt,
    };

    const endpoint = opts.endpoint || resolveEndpointOnly();

    console.log('');
    console.log(chalk.bold('  Engine registry write'));
    console.log(chalk.dim(`  Endpoint: ${endpoint}/api/v1/admin/engines/`));
    console.log('');
    console.log(`    flutter_version          ${payload.flutter_version}`);
    console.log(`    target / abi             ${payload.target} / ${payload.abi}`);
    console.log(`    runtime_mode             ${payload.runtime_mode}`);
    console.log(`    sankofa_engine_version   ${payload.sankofa_engine_version}`);
    console.log(`    is_modified              ${payload.is_modified ? chalk.cyan('+sankofa') : chalk.dim('vanilla')}`);
    console.log(`    sha256                   ${payload.sha256}`);
    console.log(`    size_bytes               ${payload.size_bytes} (${formatBytesHuman(payload.size_bytes)})`);
    console.log(`    object_key               ${payload.object_key}`);
    if (payload.source_commit) console.log(`    source_commit            ${payload.source_commit}`);
    if (payload.built_at) console.log(`    built_at                 ${payload.built_at}`);
    console.log('');

    if (opts.dryRun) {
      console.log(chalk.yellow('  ⚠ Dry-run — no POST sent.'));
      console.log('');
      return;
    }

    try {
      const saved = await registerKnownEngine(payload, {
        endpoint: opts.endpoint,
        token: opts.token,
      });
      console.log(chalk.green('  ✓ Registered.'));
      console.log(chalk.dim(`    Server confirms sha=${saved.sha256.slice(0, 12)}… for ${saved.target}/${saved.abi}`));
      console.log('');
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err?.message ?? err}`));
      process.exit(1);
    }
  });

// ── Programmatic helper used by `sankofa init` ─────────────────────
/**
 * Ensures every Android ABI for `flutterVersion` is in the cache. Used
 * by `sankofa init --deploy` on Flutter projects so the customer can
 * `flutter build` immediately without a "missing engine" hiccup.
 *
 * Returns the engines that ended up in the cache (cache hits + fresh
 * downloads). Throws on download failure.
 */
export async function ensureFlutterEnginesForVersion(
  flutterVersion: string,
  opts: { target?: 'android' | 'ios'; onProgress?: (msg: string) => void } = {},
): Promise<{ engine: KnownEngine; cached: boolean }[]> {
  const candidates = await fetchKnownEngines({
    flutterVersion,
    target: opts.target,
  });
  const results: { engine: KnownEngine; cached: boolean }[] = [];
  for (const engine of candidates) {
    const hit = tryEngineCacheHit(engine);
    if (hit) {
      results.push({ engine, cached: true });
      continue;
    }
    opts.onProgress?.(`Downloading ${engine.target} ${engine.abi} (${formatBytesHuman(engine.size_bytes)})…`);
    await ensureEngineCached(engine);
    results.push({ engine, cached: false });
  }
  return results;
}
