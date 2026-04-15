import { Command } from 'commander';
import { listReleases, updateRelease } from '../utils/api.js';
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
