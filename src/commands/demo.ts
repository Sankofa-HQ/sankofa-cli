import { Command } from 'commander';
import { resolveJWT, jwtFetch } from '../utils/jwtAuth.js';

/**
 * `sankofa demo seed` — provisions the canonical demo flags + config
 * items every Sankofa example ships with (web, react-native, html,
 * ios, android, flutter). Runs against the caller's current project +
 * environment (via dashboard JWT auth, same as `sankofa flags` and
 * `sankofa config`).
 *
 * Idempotent:
 *   - Existing flag keys are left alone unless --force is passed
 *   - Existing config keys are left alone unless --force is passed
 *     (forcing updates the default_value to match the manifest)
 *
 * Keys + defaults here MUST stay in lock-step with the six example
 * projects. A mismatch means dashboard edits on the seeded rows won't
 * repaint the examples — defeating the whole demo.
 */

// ── Canonical demo manifest ──────────────────────────────────────────

type VariantSpec = {
  key: string;
  weight: number;
  isControl?: boolean;
  payload?: unknown;
};

interface DemoFlagSpec {
  key: string;
  description: string;
  defaultValue: boolean;
  rolloutPercentage?: number;
  variants?: VariantSpec[];
  defaultVariant?: string;
}

const DEMO_FLAGS: DemoFlagSpec[] = [
  {
    key: 'new_home_layout',
    description: 'Swap hero between classic and v2 experimental layout.',
    defaultValue: false,
    rolloutPercentage: 50,
  },
  {
    key: 'checkout_cta_variant',
    description: 'A/B/C variant test — CTA copy + colour.',
    defaultValue: true,
    defaultVariant: 'control',
    variants: [
      { key: 'control', weight: 34, isControl: true },
      { key: 'blue',    weight: 33 },
      { key: 'red',     weight: 33 },
    ],
    rolloutPercentage: 100,
  },
  {
    key: 'onboarding_v2_rollout',
    description: 'Progressive rollout gate for the v2 onboarding flow.',
    defaultValue: false,
    rolloutPercentage: 25,
  },
  {
    key: 'ai_summary_kill_switch',
    description: 'Halt webhook flips this true when Catch detects errors.',
    defaultValue: false,
  },
  {
    key: 'ab_pricing_page',
    description: 'A/B test reordering the pricing card.',
    defaultValue: true,
    defaultVariant: 'A',
    variants: [
      { key: 'A', weight: 50, isControl: true },
      { key: 'B', weight: 50 },
    ],
    rolloutPercentage: 100,
  },
  {
    key: 'premium_badge_visible',
    description: 'Show / hide the sparkly premium badge in the header.',
    defaultValue: true,
    rolloutPercentage: 100,
  },
];

type ConfigType = 'string' | 'int' | 'float' | 'bool' | 'json';

interface DemoConfigSpec {
  key: string;
  type: ConfigType;
  defaultValue: string; // wire format — server parses per type
  description: string;
}

const DEMO_CONFIG: DemoConfigSpec[] = [
  {
    key: 'support_url',
    type: 'string',
    defaultValue: 'https://support.sankofa.dev',
    description: 'Support link shown in footer + lab panel.',
  },
  {
    key: 'max_uploads_per_day',
    type: 'int',
    defaultValue: '25',
    description: 'Daily upload ceiling shown to the user.',
  },
  {
    key: 'trial_discount_pct',
    type: 'float',
    defaultValue: '0.2',
    description: '0–1 discount multiplier applied across pricing.',
  },
  {
    key: 'maintenance_banner_enabled',
    type: 'bool',
    defaultValue: 'false',
    description: 'Shows the amber maintenance banner when true.',
  },
  {
    key: 'pricing_table',
    type: 'json',
    defaultValue: JSON.stringify([
      { name: 'Starter',    price: 0,   features: ['1 project',         '1k events/mo'] },
      { name: 'Pro',        price: 49,  features: ['Unlimited projects', '1M events/mo', 'Replay'] },
      { name: 'Enterprise', price: 199, features: ['SSO',                'Priority support', 'Audit log'] },
    ]),
    description: 'Array of pricing tiers rendered into the pricing grid.',
  },
  {
    key: 'theme_colors',
    type: 'json',
    defaultValue: JSON.stringify({ primary: '#e11d48', accent: '#6366f1' }),
    description: 'Primary + accent hex tokens.',
  },
];

// ── Wire-shape helpers ──────────────────────────────────────────────

interface SwitchFlagRow {
  id: string;
  key: string;
  kind: 'boolean' | 'variant';
  current_version: number;
}
interface SwitchRuleRow {
  rollout_percentage?: number;
}
interface ConfigItem {
  id: string;
  key: string;
  type: ConfigType;
  default_value: string;
  current_version: number;
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

// ── `demo seed` ──────────────────────────────────────────────────────

const seedDemo = new Command('seed')
  .description('Provision the canonical demo flags + config items into your project')
  .option('--force', 'overwrite existing values to match the manifest', false)
  .option('--skip-flags', 'only seed remote config items', false)
  .option('--skip-config', 'only seed feature flags', false)
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      console.log(
        chalk.bold('Sankofa demo seed — ') +
          chalk.dim(`project=${auth.projectId}  env=${auth.environment}`),
      );

      if (!opts.skipFlags) {
        await seedFlags(auth, chalk, Boolean(opts.force));
      }
      if (!opts.skipConfig) {
        await seedConfig(auth, chalk, Boolean(opts.force));
      }

      console.log('');
      console.log(chalk.green.bold('Done.'));
      console.log(
        chalk.dim(
          '  Open the dashboard → Switch / Config to see the seeded rows, tweak them,\n' +
            '  then reload any of the Sankofa example apps to watch them repaint.',
        ),
      );
    });
  });

async function seedFlags(auth: ReturnType<typeof resolveJWT>, chalk: any, force: boolean) {
  const existingResp = await jwtFetch<{ flags: SwitchFlagRow[] }>(
    auth,
    `/api/v1/switch/flags?environment=${auth.environment}&include_archived=true`,
  );
  const byKey = new Map(existingResp.flags.map((f) => [f.key, f]));

  console.log('');
  console.log(chalk.bold('Switch — feature flags'));

  for (const spec of DEMO_FLAGS) {
    const existing = byKey.get(spec.key);
    if (existing && !force) {
      console.log(chalk.dim(`  · ${spec.key}  ${chalk.yellow('skip')} (already exists)`));
      continue;
    }
    let flag: SwitchFlagRow;
    if (existing) {
      flag = existing;
      console.log(chalk.dim(`  · ${spec.key}  ${chalk.cyan('exists')} — updating rule/variants`));
    } else {
      const res = await jwtFetch<{ flag: SwitchFlagRow }>(auth, `/api/v1/switch/flags`, {
        method: 'POST',
        body: JSON.stringify({
          environment: auth.environment,
          key: spec.key,
          description: spec.description,
          default_value: spec.defaultValue,
        }),
      });
      flag = res.flag;
      console.log(chalk.green(`  ✓ ${spec.key}  created`));
    }

    // Variants — PUT replaces the whole set. Only fires for variant specs.
    if (spec.variants && spec.variants.length > 0) {
      await jwtFetch(auth, `/api/v1/switch/flags/${flag.id}/variants`, {
        method: 'PUT',
        body: JSON.stringify({
          default_variant: spec.defaultVariant ?? spec.variants[0].key,
          variants: spec.variants.map((v) => ({
            key: v.key,
            weight: v.weight,
            is_control: v.isControl ?? false,
            payload: v.payload,
          })),
        }),
      });
      console.log(chalk.dim(`      variants: ${spec.variants.map((v) => `${v.key}(${v.weight}%)`).join(', ')}`));
    }

    // Rule — target + rollout. Seeded rules are deliberately permissive
    // (no cohort filters) so the demo works out of the box on any
    // project; customers can edit them from the dashboard afterwards.
    const rollout =
      spec.rolloutPercentage ?? (spec.variants ? 100 : spec.defaultValue ? 100 : 0);
    const rule: SwitchRuleRow = { rollout_percentage: rollout };
    await jwtFetch(auth, `/api/v1/switch/flags/${flag.id}/rule`, {
      method: 'PUT',
      body: JSON.stringify(rule),
    });
    console.log(chalk.dim(`      rollout: ${rollout}%`));
  }
}

async function seedConfig(auth: ReturnType<typeof resolveJWT>, chalk: any, force: boolean) {
  const existingResp = await jwtFetch<{ items: ConfigItem[] }>(
    auth,
    `/api/v1/config/items?environment=${auth.environment}&include_archived=true`,
  );
  const byKey = new Map(existingResp.items.map((it) => [it.key, it]));

  console.log('');
  console.log(chalk.bold('Config — remote config items'));

  for (const spec of DEMO_CONFIG) {
    const existing = byKey.get(spec.key);
    if (existing) {
      if (existing.type !== spec.type) {
        console.log(
          chalk.red(
            `  · ${spec.key}  conflict — server has type=${existing.type} but manifest=${spec.type}. Skipping.`,
          ),
        );
        continue;
      }
      if (!force) {
        console.log(chalk.dim(`  · ${spec.key}  ${chalk.yellow('skip')} (already exists)`));
        continue;
      }
      await jwtFetch(auth, `/api/v1/config/items/${existing.id}`, {
        method: 'PATCH',
        headers: { 'If-Match': String(existing.current_version) },
        body: JSON.stringify({ default_value: spec.defaultValue }),
      });
      console.log(chalk.cyan(`  · ${spec.key}  updated default_value`));
      continue;
    }

    await jwtFetch(auth, `/api/v1/config/items`, {
      method: 'POST',
      body: JSON.stringify({
        environment: auth.environment,
        key: spec.key,
        type: spec.type,
        default_value: spec.defaultValue,
        description: spec.description,
      }),
    });
    console.log(chalk.green(`  ✓ ${spec.key}  (${spec.type}) = ${truncate(spec.defaultValue, 48)}`));
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const demoCommand = new Command('demo')
  .description('Demo fixtures — seed the canonical Sankofa example flags + config')
  .addCommand(seedDemo);
