import { Command } from 'commander';
import { requireAuth } from '../utils/config.js';
import { resolveProjectRoot, STACK_LABELS, type ProjectInfo } from '../utils/stack.js';
import { hasBaseline, readBaselineManifest } from '../utils/baseline.js';
import { detectFlutterAppVersion, resolveFlutterPlatform } from '../utils/flutterBundler.js';
import { flutterPatch } from './patch.js';
import { flutterRelease } from './release.js';

/**
 * `sankofa deploy` — smart router. One command, picks `release` or
 * `patch` based on the project's current state:
 *
 *  - First time on this app version → calls `release` (creates baseline)
 *  - Subsequent runs → calls `patch` (Diff Guard checks; only Dart changes ship)
 *
 * For Flutter, "baseline exists" is determined by `.sankofa/baseline/`
 * on disk. For React Native, baseline detection is server-side and
 * less reliable from a single CLI invocation, so `deploy` currently
 * directs RN users to use `release` / `patch` explicitly. RN smart
 * routing will land alongside server-side baseline state.
 */
export const deployCommand = new Command('deploy')
  .description('Smart deploy — auto-picks `release` (first time) or `patch` (subsequent times)')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted; Flutter today only supports android — iOS is Phase 6)')
  .option('--project <path>', 'Project root (defaults to auto-detect)')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--description <desc>', 'Release/patch description')
  .option('--mandatory', 'Mark this release/patch as mandatory')
  .option('--rollout <percent>', 'Rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--engine-version <version>', 'Flutter: override the detected engine version (rare)')
  .option('--apk', 'Flutter Android: produce an APK when releasing (default is --appbundle)')
  .option('--appbundle', 'Flutter Android: produce an AAB when releasing (default)')
  .option('--dry-run', 'Build + safety check locally; do NOT contact server or upload')
  .action(async (platformArg: string | undefined, opts: any) => {
    const chalk = (await import('chalk')).default;

    await requireAuth();

    let project: ProjectInfo;
    try {
      project = await resolveProjectRoot({
        explicit: opts.project,
        allowedStacks: ['react-native', 'flutter'],
      });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    if (project.root !== process.cwd()) {
      console.log(chalk.dim(`  → Working in ${project.root}`));
      process.chdir(project.root);
    }

    console.log('');
    console.log(chalk.bold(`  ${STACK_LABELS[project.stack]} project: ${project.name}`));

    if (project.stack === 'react-native') {
      console.log('');
      console.log(chalk.yellow('  ⚠ Smart routing is not yet implemented for React Native projects.'));
      console.log(chalk.dim('     Use the explicit commands for now:'));
      console.log(chalk.dim('       First time:        ') + chalk.cyan('sankofa release <ios|android>'));
      console.log(chalk.dim('       Subsequent times:  ') + chalk.cyan('sankofa patch <ios|android>'));
      process.exit(1);
    }

    // Validate the platform positional up-front so iOS is refused
    // immediately rather than after a build cycle. Mirrors release/patch.
    await resolveFlutterPlatform(platformArg);

    // Flutter: version-aware routing. Read pubspec.yaml's current version
    // and compare it against the baseline's targetBinaryVersion. This mirrors
    // what `sankofa release` does for RN — if the version has bumped since
    // the last baseline, you need a NEW release (with a new baseline);
    // if the version is the same, you're hot-patching that release.
    let currentVersion: string;
    try {
      currentVersion = detectFlutterAppVersion(project.root);
    } catch (err: any) {
      console.error(chalk.red(`  ✖ Could not read pubspec.yaml version: ${err.message}`));
      process.exit(1);
    }

    const baselineManifest = hasBaseline(project.root) ? readBaselineManifest(project.root) : null;
    const baselineVersion = baselineManifest?.targetBinaryVersion;

    console.log(chalk.dim(`  pubspec version:  ${currentVersion}`));
    if (baselineVersion) {
      console.log(chalk.dim(`  baseline version: ${baselineVersion} (captured ${baselineManifest?.capturedAt || '?'})`));
    } else {
      console.log(chalk.dim(`  baseline:         none on disk`));
    }
    console.log('');

    if (!baselineVersion) {
      console.log(chalk.cyan('  → Routing to `sankofa release` (first-time release; captures baseline)'));
      console.log('');
      return flutterRelease(project, platformArg, opts);
    }

    const cmp = compareVersions(currentVersion, baselineVersion);
    if (cmp === 0) {
      console.log(chalk.cyan(`  → Routing to \`sankofa patch\` (hot-patch ${currentVersion})`));
      console.log('');
      return flutterPatch(project, platformArg, opts);
    }
    if (cmp > 0) {
      console.log(chalk.cyan(`  → Routing to \`sankofa release\` (pubspec bumped ${baselineVersion} → ${currentVersion}; new baseline)`));
      console.log('');
      return flutterRelease(project, platformArg, opts);
    }
    // cmp < 0: pubspec version is older than baseline. Almost always a mistake.
    console.error(chalk.red(`  ✖ pubspec version ${currentVersion} is OLDER than the baseline ${baselineVersion}.`));
    console.error(chalk.dim('     This usually means you reverted pubspec.yaml or restored an old branch.'));
    console.error(chalk.dim(`     Bump pubspec to ≥ ${baselineVersion} (for a hot-patch) or > ${baselineVersion} (for a new release).`));
    process.exit(1);
  });

/**
 * Semantic-version-ish comparator. Splits each version on `.` and `-`,
 * compares segments numerically when possible, lexically otherwise. Good
 * enough for typical Flutter `version: 1.2.3` shapes; not a full semver.
 */
function compareVersions(a: string, b: string): number {
  const tokenize = (v: string) => v.split(/[.\-+]/).map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? s : n;
  });
  const ta = tokenize(a);
  const tb = tokenize(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i] ?? 0;
    const y = tb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
