import { Command } from 'commander';
import { resolveJWT, jwtFetch } from '../utils/jwtAuth.js';
import { scanForStaleFlags } from '../utils/flagsScan.js';

/**
 * `sankofa flags` — manage Sankofa Switch feature flags.
 *
 * Every sub-command uses the dashboard JWT (browser login) not the
 * Deploy Token, because Switch's CRUD routes require full user auth
 * + project-role RBAC. CI use: set SANKOFA_JWT.
 */

interface SwitchFlagRow {
  id: string;
  key: string;
  kind: 'boolean' | 'variant';
  description?: string;
  default_value: boolean;
  default_variant?: string;
  is_archived: boolean;
  current_version: number;
  halted_at?: string | null;
  updated_at: string;
}

interface SwitchRuleRow {
  id?: string;
  rollout_percentage?: number;
  min_app_version?: string;
  max_app_version?: string;
  min_os_version?: string;
  max_os_version?: string;
  countries_allow?: string[];
  countries_block?: string[];
  cohorts_include?: string[];
  cohorts_exclude?: string[];
  user_ids_include?: string[];
}

// ─── Shared helpers ─────────────────────────────────────────────────────

async function runWithAuth(fn: (args: { auth: ReturnType<typeof resolveJWT>; chalk: any }) => Promise<void>): Promise<void> {
  const chalk = (await import('chalk')).default;
  let auth;
  try {
    auth = resolveJWT();
  } catch (err: any) {
    console.error(chalk.red(`  ${err.message}`));
    process.exit(1);
  }
  try {
    await fn({ auth, chalk });
  } catch (err: any) {
    console.error(chalk.red(`  ${err.message}`));
    process.exit(1);
  }
}

function resolveFlagIdByKey(flags: SwitchFlagRow[], keyOrId: string): SwitchFlagRow | null {
  return flags.find((f) => f.id === keyOrId || f.key === keyOrId) ?? null;
}

// ─── Commands ───────────────────────────────────────────────────────────

const listFlags = new Command('list')
  .description('List feature flags for the current project + environment')
  .option('--include-archived', 'Include archived flags in the output', false)
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const qs = new URLSearchParams({ environment: auth.environment });
      if (opts.includeArchived) qs.set('include_archived', 'true');
      const res = await jwtFetch<{ flags: SwitchFlagRow[] }>(auth, `/api/v1/switch/flags?${qs}`);
      if (!res.flags.length) {
        console.log(chalk.dim('  No flags yet. Create one with `sankofa flags create <key>`.'));
        return;
      }
      for (const f of res.flags) {
        const status = f.is_archived
          ? chalk.dim('archived')
          : f.halted_at
            ? chalk.red('halted')
            : chalk.green('active');
        const kind = chalk.dim(`[${f.kind}]`);
        const ver = chalk.dim(`v${f.current_version}`);
        console.log(`  ${chalk.bold(f.key)} ${kind} ${status} ${ver}  ${chalk.dim(f.description || '')}`);
      }
    });
  });

const getFlag = new Command('get')
  .argument('<key>', 'flag key or id')
  .description('Show the full configuration of one flag')
  .action(async (key) => {
    await runWithAuth(async ({ auth, chalk }) => {
      // The API is id-based; resolve key→id via list if the user passed a key.
      const list = await jwtFetch<{ flags: SwitchFlagRow[] }>(
        auth,
        `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
      );
      const flag = resolveFlagIdByKey(list.flags, key);
      if (!flag) {
        throw new Error(`flag not found: ${key}`);
      }
      const detail = await jwtFetch<{ flag: SwitchFlagRow; rule: SwitchRuleRow | null }>(
        auth,
        `/api/v1/switch/flags/${flag.id}`,
      );
      console.log(chalk.bold(detail.flag.key));
      console.log(chalk.dim(`  id=${detail.flag.id}`));
      console.log(`  kind           ${detail.flag.kind}`);
      console.log(`  default        ${detail.flag.kind === 'variant' ? (detail.flag.default_variant || '(none)') : String(detail.flag.default_value)}`);
      console.log(`  archived       ${detail.flag.is_archived}`);
      console.log(`  version        v${detail.flag.current_version}`);
      if (detail.flag.halted_at) {
        console.log(chalk.red(`  halted         yes (${detail.flag.halted_at})`));
      }
      if (detail.rule) {
        console.log(chalk.bold('\n  Rule'));
        console.log(`    rollout      ${detail.rule.rollout_percentage ?? 0}%`);
        if (detail.rule.min_app_version) console.log(`    min app ver  ${detail.rule.min_app_version}`);
        if (detail.rule.max_app_version) console.log(`    max app ver  ${detail.rule.max_app_version}`);
        if (detail.rule.min_os_version)  console.log(`    min OS ver   ${detail.rule.min_os_version}`);
        if (detail.rule.max_os_version)  console.log(`    max OS ver   ${detail.rule.max_os_version}`);
        if (detail.rule.countries_allow?.length) console.log(`    countries+   ${detail.rule.countries_allow.join(', ')}`);
        if (detail.rule.countries_block?.length) console.log(`    countries-   ${detail.rule.countries_block.join(', ')}`);
        if (detail.rule.cohorts_include?.length) console.log(`    cohorts+     ${detail.rule.cohorts_include.join(', ')}`);
        if (detail.rule.cohorts_exclude?.length) console.log(`    cohorts-     ${detail.rule.cohorts_exclude.join(', ')}`);
        if (detail.rule.user_ids_include?.length) console.log(`    users+       ${detail.rule.user_ids_include.length} user${detail.rule.user_ids_include.length === 1 ? '' : 's'}`);
      } else {
        console.log(chalk.dim('\n  No targeting rule — flag always returns the default.'));
      }
    });
  });

const createFlag = new Command('create')
  .argument('<key>', 'flag key (lowercase, [a-z0-9._-])')
  .option('-d, --description <text>', 'one-line description', '')
  .option('--default <value>', '"true" or "false" — the default boolean value', 'false')
  .description('Create a new boolean feature flag')
  .action(async (key, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const defaultVal = String(opts.default).toLowerCase() === 'true';
      const created = await jwtFetch<{ flag: SwitchFlagRow }>(
        auth,
        `/api/v1/switch/flags`,
        {
          method: 'POST',
          body: JSON.stringify({
            environment: auth.environment,
            key,
            description: opts.description || '',
            default_value: defaultVal,
          }),
        },
      );
      console.log(chalk.green(`  ✓ Created ${chalk.bold(created.flag.key)} (${created.flag.id})`));
      console.log(chalk.dim(`    Set a rollout with: sankofa flags toggle ${key} <0-100>`));
    });
  });

const toggleFlag = new Command('toggle')
  .argument('<key>', 'flag key or id')
  .argument('<rollout>', 'rollout percentage 0–100')
  .description('Upsert the flag\'s rule with just a rollout percentage (shortcut)')
  .action(async (key, rolloutArg) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const rollout = Number.parseInt(rolloutArg, 10);
      if (Number.isNaN(rollout) || rollout < 0 || rollout > 100) {
        throw new Error('rollout must be an integer 0–100');
      }
      const list = await jwtFetch<{ flags: SwitchFlagRow[] }>(
        auth,
        `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
      );
      const flag = resolveFlagIdByKey(list.flags, key);
      if (!flag) throw new Error(`flag not found: ${key}`);

      // Load the current rule so we don't stomp targeting when the caller
      // just wants to bump the %. Missing rule → fresh object.
      let currentRule: SwitchRuleRow = { rollout_percentage: 0 };
      try {
        const resp = await jwtFetch<{ rule: SwitchRuleRow | null }>(
          auth,
          `/api/v1/switch/flags/${flag.id}/rule`,
        );
        currentRule = resp.rule ?? currentRule;
      } catch {
        /* ignore — absent rule is fine */
      }
      currentRule.rollout_percentage = rollout;

      await jwtFetch(auth, `/api/v1/switch/flags/${flag.id}/rule`, {
        method: 'PUT',
        body: JSON.stringify(currentRule),
      });
      console.log(chalk.green(`  ✓ ${chalk.bold(flag.key)} rollout set to ${rollout}%`));
    });
  });

const archiveFlag = new Command('archive')
  .argument('<key>', 'flag key or id')
  .description('Archive a flag — SDK returns the default until un-archived')
  .action(async (key) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const list = await jwtFetch<{ flags: SwitchFlagRow[] }>(
        auth,
        `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
      );
      const flag = resolveFlagIdByKey(list.flags, key);
      if (!flag) throw new Error(`flag not found: ${key}`);
      await jwtFetch(auth, `/api/v1/switch/flags/${flag.id}/archive`, { method: 'POST' });
      console.log(chalk.green(`  ✓ Archived ${chalk.bold(flag.key)}`));
    });
  });

const haltFlag = new Command('halt')
  .argument('<key>', 'flag key')
  .option('-r, --reason <text>', 'short reason surfaced in the audit log', 'manual halt from CLI')
  .description('Halt a flag immediately via the webhook (same endpoint Catch will use)')
  .action(async (key, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      // The halt webhook is SDK-auth (x-api-key). CLI doesn't carry
      // that directly, so use the dashboard-auth resume path's sibling:
      // find the flag, then POST halt via the dashboard endpoint set.
      // Server exposes the halt webhook under /api/switch; CLI needs an
      // API key for it. Pull from loadGlobalConfig() as a fallback.
      const global = (await import('../utils/config.js')).loadGlobalConfig();
      const apiKey = process.env.SANKOFA_API_KEY || global.apiKey;
      if (!apiKey || !apiKey.startsWith('sk_')) {
        throw new Error(
          'halt uses the SDK webhook — set SANKOFA_API_KEY to your project\'s sk_live_ or sk_test_ key ' +
          'so the CLI can POST /api/switch/halt-webhook.',
        );
      }
      const url = `${auth.endpoint.replace(/\/$/, '')}/api/switch/halt-webhook`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          flag_key: key,
          environment: auth.environment,
          reason: opts.reason,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as any;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      console.log(chalk.yellow(`  ⚠ Halted ${chalk.bold(key)} — evaluator will return defaults.`));
      console.log(chalk.dim('    Un-halt with: sankofa flags resume ' + key));
    });
  });

const resumeFlag = new Command('resume')
  .argument('<key>', 'flag key or id')
  .option('-n, --note <text>', 'audit note', '')
  .description('Resume a halted flag (dashboard JWT auth)')
  .action(async (key, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const list = await jwtFetch<{ flags: SwitchFlagRow[] }>(
        auth,
        `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
      );
      const flag = resolveFlagIdByKey(list.flags, key);
      if (!flag) throw new Error(`flag not found: ${key}`);
      await jwtFetch(auth, `/api/v1/switch/flags/${flag.id}/resume`, {
        method: 'POST',
        body: JSON.stringify({ note: opts.note || '' }),
      });
      console.log(chalk.green(`  ✓ Resumed ${chalk.bold(flag.key)}`));
    });
  });

const scanFlags = new Command('scan')
  .description('Scan source for flag usages and cross-reference with the server')
  .option('--strict', 'exit 1 when any warning is found (for CI)', false)
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const list = await jwtFetch<{ flags: SwitchFlagRow[] }>(
        auth,
        `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
      );
      const result = await scanForStaleFlags({
        cwd: process.cwd(),
        serverFlags: list.flags,
      });
      if (result.warnings.length === 0) {
        console.log(chalk.green(`  ✓ ${result.uniqueKeys} flag key${result.uniqueKeys === 1 ? '' : 's'} in code, all live on the server.`));
        return;
      }
      for (const w of result.warnings) {
        const color = w.severity === 'error' ? chalk.red : chalk.yellow;
        console.log(color(`  ${w.severity === 'error' ? '✗' : '⚠'} ${w.key}`));
        console.log(chalk.dim(`    ${w.message}`));
        if (w.locations.length) {
          for (const loc of w.locations.slice(0, 3)) {
            console.log(chalk.dim(`    ${loc.file}:${loc.line}`));
          }
          if (w.locations.length > 3) {
            console.log(chalk.dim(`    …and ${w.locations.length - 3} more`));
          }
        }
      }
      if (opts.strict) {
        process.exit(1);
      }
    });
  });

export const flagsCommand = new Command('flags')
  .description('Manage Sankofa Switch feature flags')
  .addCommand(listFlags)
  .addCommand(getFlag)
  .addCommand(createFlag)
  .addCommand(toggleFlag)
  .addCommand(archiveFlag)
  .addCommand(haltFlag)
  .addCommand(resumeFlag)
  .addCommand(scanFlags);
