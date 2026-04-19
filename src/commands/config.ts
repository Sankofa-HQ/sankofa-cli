import { Command } from 'commander';
import { resolveJWT, jwtFetch } from '../utils/jwtAuth.js';

/**
 * `sankofa config` — manage Sankofa Config remote-config items.
 *
 * Same dashboard-JWT auth model as `sankofa flags`: routes live under
 * `/api/v1/config` and require a real session. Set SANKOFA_JWT for CI.
 */

type ConfigType = 'string' | 'int' | 'float' | 'bool' | 'json';

interface ConfigItem {
  id: string;
  key: string;
  type: ConfigType;
  default_value: string;
  description?: string;
  is_archived: boolean;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface ConfigVersion {
  id: string;
  item_id: string;
  version_number: number;
  action: string;
  value_snapshot: string;
  actor_email?: string;
  note?: string;
  created_at: string;
}

async function runWithAuth(
  fn: (args: { auth: ReturnType<typeof resolveJWT>; chalk: any }) => Promise<void>,
): Promise<void> {
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

async function resolveItemByKey(
  auth: ReturnType<typeof resolveJWT>,
  keyOrId: string,
): Promise<ConfigItem> {
  const list = await jwtFetch<{ items: ConfigItem[] }>(
    auth,
    `/api/v1/config/items?environment=${auth.environment}&include_archived=true`,
  );
  const hit = list.items.find((it) => it.id === keyOrId || it.key === keyOrId);
  if (!hit) throw new Error(`config item not found: ${keyOrId}`);
  return hit;
}

// ─── Commands ───────────────────────────────────────────────────────────

const listItems = new Command('list')
  .description('List config items for the current project + environment')
  .option('--include-archived', 'Include archived items', false)
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const qs = new URLSearchParams({ environment: auth.environment });
      if (opts.includeArchived) qs.set('include_archived', 'true');
      const res = await jwtFetch<{ items: ConfigItem[] }>(auth, `/api/v1/config/items?${qs}`);
      if (!res.items.length) {
        console.log(chalk.dim('  No config items yet. Create one with `sankofa config set <key> <type> <value>`.'));
        return;
      }
      for (const it of res.items) {
        const status = it.is_archived ? chalk.dim('archived') : chalk.green('active');
        const typ = chalk.dim(`[${it.type}]`);
        const truncated = it.default_value.length > 40 ? `${it.default_value.slice(0, 37)}…` : it.default_value;
        console.log(`  ${chalk.bold(it.key)} ${typ} ${status}  ${chalk.dim('=')} ${truncated}`);
      }
    });
  });

const getItem = new Command('get')
  .argument('<key>', 'config key or id')
  .description('Show a config item and its targeting rule')
  .action(async (key) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const it = await resolveItemByKey(auth, key);
      const detail = await jwtFetch<{ item: ConfigItem; rule: any }>(
        auth,
        `/api/v1/config/items/${it.id}`,
      );
      console.log(chalk.bold(detail.item.key));
      console.log(chalk.dim(`  id=${detail.item.id}`));
      console.log(`  type           ${detail.item.type}`);
      console.log(`  default_value  ${detail.item.default_value}`);
      if (detail.item.description) console.log(`  description    ${detail.item.description}`);
      console.log(`  version        v${detail.item.current_version}`);
      console.log(`  archived       ${detail.item.is_archived}`);
      if (detail.rule) {
        console.log(chalk.bold('\n  Rule'));
        console.log(`    rule value   ${detail.rule.value}`);
        console.log(`    rollout      ${detail.rule.rollout_percentage ?? 100}%`);
        if (detail.rule.cohorts_include?.length) console.log(`    cohorts+     ${detail.rule.cohorts_include.join(', ')}`);
        if (detail.rule.cohorts_exclude?.length) console.log(`    cohorts-     ${detail.rule.cohorts_exclude.join(', ')}`);
        if (detail.rule.countries_allow?.length) console.log(`    countries+   ${detail.rule.countries_allow.join(', ')}`);
        if (detail.rule.countries_block?.length) console.log(`    countries-   ${detail.rule.countries_block.join(', ')}`);
      } else {
        console.log(chalk.dim('\n  No targeting rule — item always returns the default.'));
      }
    });
  });

const setItem = new Command('set')
  .argument('<key>', 'config key — created if it doesn\'t exist')
  .argument('<type>', 'one of: string | int | float | bool | json')
  .argument('<value>', 'default value as text (must parse as the type)')
  .option('-d, --description <text>', 'one-line description (only applied on create)', '')
  .description('Create or update a config item\'s default value (not its rule)')
  .action(async (key, typeArg, value, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const validTypes: ConfigType[] = ['string', 'int', 'float', 'bool', 'json'];
      if (!validTypes.includes(typeArg as ConfigType)) {
        throw new Error(`type must be one of: ${validTypes.join(', ')}`);
      }
      // Peek existing item. If absent, create. If present, type must
      // match (server rejects mid-life type changes too, but we catch
      // it earlier for a nicer error).
      const list = await jwtFetch<{ items: ConfigItem[] }>(
        auth,
        `/api/v1/config/items?environment=${auth.environment}&include_archived=true`,
      );
      const existing = list.items.find((it) => it.key === key);
      if (existing) {
        if (existing.type !== typeArg) {
          throw new Error(
            `config item "${key}" exists as ${existing.type}; cannot change type to ${typeArg}. ` +
            `Archive it and create a new key instead.`,
          );
        }
        await jwtFetch(auth, `/api/v1/config/items/${existing.id}`, {
          method: 'PATCH',
          headers: { 'If-Match': String(existing.current_version) },
          body: JSON.stringify({ default_value: value }),
        });
        console.log(chalk.green(`  ✓ Updated ${chalk.bold(key)} (${typeArg}) = ${value}`));
        return;
      }
      const created = await jwtFetch<{ item: ConfigItem }>(
        auth,
        `/api/v1/config/items`,
        {
          method: 'POST',
          body: JSON.stringify({
            environment: auth.environment,
            key,
            type: typeArg,
            default_value: value,
            description: opts.description || '',
          }),
        },
      );
      console.log(chalk.green(`  ✓ Created ${chalk.bold(created.item.key)} (${created.item.type}) = ${created.item.default_value}`));
    });
  });

const historyItem = new Command('history')
  .argument('<key>', 'config key or id')
  .option('-n, --limit <count>', 'max versions to show', '20')
  .description('Show version history for a config item')
  .action(async (key, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const it = await resolveItemByKey(auth, key);
      const res = await jwtFetch<{ versions: ConfigVersion[] }>(
        auth,
        `/api/v1/config/items/${it.id}/versions`,
      );
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      console.log(chalk.bold(it.key));
      for (const v of res.versions.slice(0, limit)) {
        const who = v.actor_email ? ` by ${chalk.dim(v.actor_email)}` : '';
        const when = chalk.dim(new Date(v.created_at).toLocaleString());
        console.log(`  v${v.version_number}  ${chalk.yellow(v.action.padEnd(14))} ${chalk.dim('=')} ${v.value_snapshot}${who}  ${when}`);
        if (v.note) console.log(chalk.dim(`      ${v.note}`));
      }
      console.log(chalk.dim(`\n  Use: sankofa config rollback ${key} <version-number> to restore one.`));
    });
  });

const rollbackItem = new Command('rollback')
  .argument('<key>', 'config key or id')
  .argument('<version>', 'target version number (e.g. 3)')
  .option('-n, --note <text>', 'audit note', '')
  .description('Rollback a config item to an earlier version (appends a new version, history is never rewritten)')
  .action(async (key, versionArg, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const targetVersionNum = parseInt(versionArg, 10);
      if (Number.isNaN(targetVersionNum) || targetVersionNum < 1) {
        throw new Error('version must be a positive integer');
      }
      const it = await resolveItemByKey(auth, key);
      const versions = await jwtFetch<{ versions: ConfigVersion[] }>(
        auth,
        `/api/v1/config/items/${it.id}/versions`,
      );
      const target = versions.versions.find((v) => v.version_number === targetVersionNum);
      if (!target) throw new Error(`version ${targetVersionNum} not found for ${it.key}`);
      await jwtFetch(auth, `/api/v1/config/items/${it.id}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ version_id: target.id, note: opts.note || '' }),
      });
      console.log(chalk.green(`  ✓ ${chalk.bold(it.key)} rolled back to v${targetVersionNum}`));
      console.log(chalk.dim(`    A new version was appended — run 'sankofa config history ${key}' to confirm.`));
    });
  });

export const configCommand = new Command('config')
  .description('Manage Sankofa Config remote-config items')
  .addCommand(listItems)
  .addCommand(getItem)
  .addCommand(setItem)
  .addCommand(historyItem)
  .addCommand(rollbackItem);
