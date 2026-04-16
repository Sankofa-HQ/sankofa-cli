import { Command } from 'commander';
import {
  listReleases,
  updateRelease,
  getReleaseRule,
  putReleaseRule,
  deleteReleaseRule,
  getReleaseSchedule,
  putReleaseSchedule,
  scheduleAction,
  getProjectDefaults,
  putProjectDefaults,
} from '../utils/api.js';
import { requireAuth } from '../utils/config.js';
import { resolveEnvironmentPrompt } from '../utils/prompts.js';
import { normalizePlatform, parseRollout } from '../utils/validation.js';

type ManageKind = 'release' | 'patch';

function isPatch(label: string): boolean {
  return /-patch\.\d+$/.test(String(label));
}

function buildList(kind: ManageKind): Command {
  return new Command('list')
    .description(`List ${kind}s for the current project`)
    .option('--env <environment>', 'Target environment: live or test')
    .option('--platform <platform>', 'Filter by platform (ios/android)')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();

      const env = await resolveEnvironmentPrompt(opts.env);
      const platform = opts.platform ? normalizePlatform(opts.platform) : undefined;

      let releases: any[] = [];
      try {
        releases = await listReleases(env, platform);
      } catch (err: any) {
        console.error(chalk.red(`Failed to list ${kind}s: ${err.message}`));
        process.exit(1);
      }

      releases = releases.filter((r) => (kind === 'patch' ? isPatch(r.label) : !isPatch(r.label)));

      if (opts.json) {
        console.log(JSON.stringify(releases, null, 2));
        return;
      }

      if (releases.length === 0) {
        console.log(chalk.dim(`  No ${env} ${kind}s${platform ? ` for ${platform}` : ''}.`));
        return;
      }

      console.log('');
      console.log(chalk.bold(`  ${env} ${kind}s (${releases.length})`));
      console.log(chalk.dim('  ' + '─'.repeat(90)));
      for (const r of releases) {
        const status = r.is_disabled
          ? chalk.red('KILLED  ')
          : r.rollout_percentage < 100
            ? chalk.yellow(`ROLL ${String(r.rollout_percentage).padStart(3)}%`)
            : r.is_mandatory
              ? chalk.blue('MANDATORY')
              : chalk.green('ACTIVE   ');
        const installs = r.total_installs ?? 0;
        const rollbacks = r.total_rollbacks ?? 0;
        const suffix = rollbacks > 0 ? chalk.red(` ${rollbacks} rollbacks`) : '';
        console.log(
          `  ${chalk.bold(String(r.label).padEnd(26))} ${String(r.platform).padEnd(8)} ` +
            `v${String(r.target_binary_version).padEnd(8)} ${status}  ` +
            chalk.dim(`${installs} installs${suffix}   id:${r.id}`),
        );
      }
      console.log('');
    });
}

function buildUpdate(kind: ManageKind, field: 'rollout' | 'mandatory' | 'kill' | 'unkill'): Command {
  const metadata: Record<typeof field, { name: string; desc: string }> = {
    rollout: { name: 'rollout', desc: `Set the rollout percentage (0–100) for a ${kind}` },
    mandatory: { name: 'mandatory', desc: `Toggle the mandatory/force-update flag on a ${kind}` },
    kill: { name: 'kill', desc: `Kill-switch a ${kind} (pushes a mandatory rollback to every device on it)` },
    unkill: { name: 'unkill', desc: `Re-enable a previously kill-switched ${kind}` },
  };

  let cmd = new Command(metadata[field].name)
    .description(metadata[field].desc)
    .argument('<label-or-id>', `${kind} label (e.g. v1.2.0) or release id (drl_…)`)
    .option('--env <environment>', 'Target environment: live or test')
    .option('--platform <platform>', 'Filter by platform (ios/android)');

  if (field === 'rollout') {
    cmd = cmd.argument('<percent>', 'Rollout percentage (0–100)');
  } else if (field === 'mandatory') {
    cmd = cmd.option('--off', 'Clear the mandatory flag (default: set it)');
  }

  cmd.action(async (...args: any[]) => {
    const chalk = (await import('chalk')).default;
    await requireAuth();

    const labelOrId = args[0] as string;
    const opts = (field === 'rollout' ? args[2] : args[1]) as any;
    const env = await resolveEnvironmentPrompt(opts.env);
    const platform = opts.platform ? normalizePlatform(opts.platform) : undefined;

    const target = await resolveRelease(labelOrId, env, platform, kind);
    if (!target) {
      console.error(chalk.red(`  No matching ${kind} found for "${labelOrId}".`));
      process.exit(1);
    }

    const updates: Record<string, any> = {};
    let verb = '';
    if (field === 'rollout') {
      const pct = parseRollout(args[1] as string);
      updates.rollout_percentage = pct;
      verb = `rollout → ${pct}%`;
    } else if (field === 'mandatory') {
      updates.is_mandatory = !opts.off;
      verb = `mandatory → ${updates.is_mandatory}`;
    } else if (field === 'kill') {
      updates.is_disabled = true;
      verb = 'kill-switched';
    } else if (field === 'unkill') {
      updates.is_disabled = false;
      verb = 're-enabled';
    }

    try {
      await updateRelease(target.id, updates);
      console.log(chalk.green(`  ✓ ${target.label} ${verb}`));
      if (field === 'kill') {
        console.log(chalk.dim('     Devices on this release will be rolled back to the previous'));
        console.log(chalk.dim('     non-disabled release on their next update check.'));
      }
    } catch (err: any) {
      console.error(chalk.red(`  Update failed: ${err.message}`));
      process.exit(1);
    }
  });

  return cmd;
}

async function resolveRelease(
  labelOrId: string,
  env: string,
  platform: string | undefined,
  kind: ManageKind,
): Promise<any | null> {
  if (labelOrId.startsWith('drl_')) {
    try {
      const { getRelease } = await import('../utils/api.js');
      const r = await getRelease(labelOrId);
      if (!r) return null;
      const match = r.release || r;
      const envOk = !match.environment || match.environment === env;
      const platOk = !platform || match.platform === platform;
      const kindOk = kind === 'patch' ? isPatch(match.label) : !isPatch(match.label);
      return envOk && platOk && kindOk ? match : null;
    } catch {
      return null;
    }
  }

  try {
    const all = await listReleases(env, platform);
    const hits = all.filter((r: any) =>
      r.label === labelOrId &&
      (kind === 'patch' ? isPatch(r.label) : !isPatch(r.label)),
    );
    if (hits.length === 0) return null;
    if (hits.length === 1) return hits[0];
    // Multiple platforms match — prompt.
    const inquirer = (await import('inquirer')).default;
    const { choice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: `Multiple ${kind}s match "${labelOrId}". Pick one:`,
        choices: hits.map((r: any) => ({ name: `${r.label} (${r.platform}, ${r.id})`, value: r })),
      },
    ]);
    return choice;
  } catch {
    return null;
  }
}

function buildGroup(kind: ManageKind): Command {
  const name = kind === 'release' ? 'releases' : 'patches';
  const group = new Command(name).description(
    kind === 'release'
      ? 'Manage base releases (list, kill-switch, rollout, mandatory)'
      : 'Manage patches (list, kill-switch, rollout, mandatory)',
  );
  group.addCommand(buildList(kind));
  group.addCommand(buildUpdate(kind, 'rollout'));
  group.addCommand(buildUpdate(kind, 'mandatory'));
  group.addCommand(buildUpdate(kind, 'kill'));
  group.addCommand(buildUpdate(kind, 'unkill'));
  return group;
}

export const releasesCommand = buildGroup('release');
export const patchesCommand = buildGroup('patch');

// ─── Rules / Targeting ────────────────────────────────────────────────

function parseCSV(val: string | undefined): string[] | undefined {
  if (!val) return undefined;
  return val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseStages(val: string): { pct: number; dwell_hours: number }[] {
  // Accept "1:0h,10:6h,50:24h,100:72h" — pct:dwellHours pairs.
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((piece) => {
      const [pctStr, dwellStr] = piece.split(':');
      const pct = parseInt(pctStr, 10);
      const dwell = parseFloat(String(dwellStr || '0').replace(/[hH]$/, ''));
      if (Number.isNaN(pct) || Number.isNaN(dwell)) {
        throw new Error(`Invalid stage "${piece}" — use <pct>:<dwellHours>`);
      }
      return { pct, dwell_hours: dwell };
    });
}

function buildRulesCommand(): Command {
  const group = new Command('rules').description('Manage per-release targeting rules');

  group
    .command('get <releaseId>')
    .description('Print the current targeting rule for a release')
    .option('--json', 'Emit JSON')
    .action(async (releaseId, opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      const rule = await getReleaseRule(releaseId);
      if (opts.json) {
        console.log(JSON.stringify(rule, null, 2));
        return;
      }
      if (!rule) {
        console.log(chalk.dim('  No targeting rule — every device is eligible.'));
        return;
      }
      console.log(JSON.stringify(rule, null, 2));
    });

  group
    .command('set <releaseId>')
    .description('Upsert a targeting rule for a release')
    .option('--min-app-version <v>', 'Minimum app version (e.g. 1.2.0)')
    .option('--max-app-version <v>', 'Maximum app version')
    .option('--min-os-version <v>', 'Minimum OS version')
    .option('--max-os-version <v>', 'Maximum OS version')
    .option('--countries <list>', 'ISO-2 allow list (comma-separated)')
    .option('--block-countries <list>', 'ISO-2 block list (comma-separated)')
    .option('--cohort-include <list>', 'Cohort IDs to include (comma-separated)')
    .option('--cohort-exclude <list>', 'Cohort IDs to exclude')
    .option('--user-ids <list>', 'distinct_ids to always include')
    .action(async (releaseId, opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      const body = {
        min_app_version: opts.minAppVersion,
        max_app_version: opts.maxAppVersion,
        min_os_version: opts.minOsVersion,
        max_os_version: opts.maxOsVersion,
        countries_allow: parseCSV(opts.countries)?.map((c) => c.toUpperCase()),
        countries_block: parseCSV(opts.blockCountries)?.map((c) => c.toUpperCase()),
        cohorts_include: parseCSV(opts.cohortInclude),
        cohorts_exclude: parseCSV(opts.cohortExclude),
        user_ids_include: parseCSV(opts.userIds),
      };
      const res = await putReleaseRule(releaseId, body);
      console.log(chalk.green(`  ✓ Rule saved for ${releaseId}`));
      console.log(JSON.stringify(res.rule, null, 2));
    });

  group
    .command('clear <releaseId>')
    .description('Remove all targeting (100% eligible)')
    .action(async (releaseId) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      await deleteReleaseRule(releaseId);
      console.log(chalk.green(`  ✓ Targeting cleared for ${releaseId}`));
    });

  return group;
}

function buildScheduleCommand(): Command {
  const group = new Command('schedule').description('Manage staged rollout schedules');

  group
    .command('get <releaseId>')
    .description('Print the current rollout schedule')
    .option('--json', 'Emit JSON')
    .action(async (releaseId, opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      const sched = await getReleaseSchedule(releaseId);
      if (opts.json) {
        console.log(JSON.stringify(sched, null, 2));
        return;
      }
      if (!sched) {
        console.log(chalk.dim('  No schedule — release uses its static rollout %.'));
        return;
      }
      console.log(JSON.stringify(sched, null, 2));
    });

  group
    .command('set <releaseId>')
    .description('Create or replace a rollout schedule')
    .requiredOption('--stages <spec>', 'Stage list e.g. "1:0h,10:6h,50:24h,100:72h"')
    .option('--crash-pause <rate>', 'Crash-rate PAUSE threshold (e.g. 0.02)')
    .option('--crash-kill <rate>', 'Crash-rate KILL threshold (e.g. 0.05)')
    .option('--min-sample <n>', 'Minimum events before evaluating crash-rate', '100')
    .option('--no-start', "Don't start immediately — require manual resume")
    .action(async (releaseId, opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      const stages = parseStages(opts.stages);
      const body: any = {
        stages,
        start_immediately: opts.start !== false,
      };
      if (opts.crashPause !== undefined) body.crash_rate_pause_threshold = parseFloat(opts.crashPause);
      if (opts.crashKill !== undefined) body.crash_rate_kill_threshold = parseFloat(opts.crashKill);
      if (opts.minSample !== undefined) body.min_sample_size = parseInt(opts.minSample, 10);
      const res = await putReleaseSchedule(releaseId, body);
      console.log(chalk.green(`  ✓ Schedule saved for ${releaseId}`));
      console.log(JSON.stringify(res.schedule, null, 2));
    });

  for (const action of ['pause', 'resume', 'promote'] as const) {
    group
      .command(`${action} <releaseId>`)
      .description(`${action[0].toUpperCase() + action.slice(1)} the rollout schedule`)
      .action(async (releaseId) => {
        const chalk = (await import('chalk')).default;
        await requireAuth();
        const res = await scheduleAction(releaseId, action);
        console.log(chalk.green(`  ✓ Schedule ${action}d`));
        console.log(JSON.stringify(res.schedule, null, 2));
      });
  }

  return group;
}

function buildDefaultsCommand(): Command {
  const group = new Command('defaults').description('Manage project-wide deploy defaults');

  group
    .command('get')
    .description('Print current project defaults')
    .option('--env <environment>', 'Environment: live or test')
    .action(async (opts) => {
      await requireAuth();
      const env = await resolveEnvironmentPrompt(opts.env);
      const defaults = await getProjectDefaults(env);
      console.log(JSON.stringify(defaults, null, 2));
    });

  group
    .command('set')
    .description('Update project-wide defaults')
    .option('--env <environment>', 'Environment: live or test')
    .option('--pause-all', 'Freeze every rollout')
    .option('--resume-all', 'Unfreeze rollouts')
    .option('--crash-pause <rate>', 'Default crash-rate PAUSE threshold')
    .option('--crash-kill <rate>', 'Default crash-rate KILL threshold')
    .option('--min-floor <label>', 'Minimum bundle floor (never serve below this label)')
    .option('--default-stages <spec>', 'Default rollout curve e.g. "1:0h,10:6h,100:24h"')
    .action(async (opts) => {
      const chalk = (await import('chalk')).default;
      await requireAuth();
      const env = await resolveEnvironmentPrompt(opts.env);
      const body: any = {};
      if (opts.pauseAll) body.paused_globally = true;
      if (opts.resumeAll) body.paused_globally = false;
      if (opts.crashPause !== undefined) body.default_crash_pause_threshold = parseFloat(opts.crashPause);
      if (opts.crashKill !== undefined) body.default_crash_kill_threshold = parseFloat(opts.crashKill);
      if (opts.minFloor !== undefined) body.min_bundle_floor = opts.minFloor;
      if (opts.defaultStages) body.default_rollout_curve = parseStages(opts.defaultStages);
      const res = await putProjectDefaults(env, body);
      console.log(chalk.green('  ✓ Defaults saved'));
      console.log(JSON.stringify(res, null, 2));
    });

  return group;
}

export const rulesCommand = buildRulesCommand();
export const scheduleCommand = buildScheduleCommand();
export const defaultsCommand = buildDefaultsCommand();

// Silence unused-var lint: parseRollout and normalizePlatform come from
// the legacy manage surface and are still used by buildGroup/buildUpdate
// above.
void parseRollout;
void normalizePlatform;
