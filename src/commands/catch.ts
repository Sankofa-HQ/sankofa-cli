import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { resolveJWT, jwtFetch } from '../utils/jwtAuth.js';
import {
  buildDSymManifest,
  buildNDKManifest,
  writeManifest,
} from '../utils/nativeManifest.js';

/**
 * `sankofa catch` — triage Sankofa Catch issues from the terminal.
 *
 * Same dashboard-JWT auth model as `sankofa flags` and `sankofa
 * config`. CI use: set SANKOFA_JWT.
 */

interface IssueSummary {
  id: string;
  environment: string;
  fingerprint: string;
  platform: string;
  level: string;
  exception_type: string;
  exception_value: string;
  culprit_file: string;
  culprit_function: string;
  culprit_line: number;
  status: string;
  assignee_id?: string;
  first_seen_at: string;
  last_seen_at: string;
  event_count: number;
  users_affected: number;
  last_seen_release?: string;
  regression?: boolean;
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

// ── `catch issues list` ─────────────────────────────────────────────

const listIssues = new Command('list')
  .description('List Catch issues for the current project')
  .option('--env <env>', 'environment (live or test)')
  .option('--status <status>', 'filter by status (unresolved|resolved|ignored)')
  .option('--release <release>', 'filter by last seen release')
  .option('--level <level>', 'filter by level (fatal|error|warning|info|debug)')
  .option('--search <q>', 'search type/value/fingerprint')
  .option('--limit <n>', 'max rows', '50')
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const params = new URLSearchParams({
        environment: env,
        limit: String(Math.max(1, parseInt(opts.limit, 10) || 50)),
      });
      if (opts.status) params.set('status', opts.status);
      if (opts.release) params.set('release', opts.release);
      if (opts.level) params.set('level', opts.level);
      if (opts.search) params.set('search', opts.search);

      const res = await jwtFetch<{ issues: IssueSummary[]; next_cursor?: string }>(
        auth,
        `/api/v1/catch/issues?${params.toString()}`,
      );

      if (res.issues.length === 0) {
        console.log(chalk.dim('  No issues match the filter.'));
        return;
      }

      const header = [
        pad('STATUS', 10),
        pad('LEVEL', 8),
        pad('EVENTS', 8),
        pad('USERS', 7),
        pad('TYPE', 22),
        'CULPRIT',
      ].join('  ');
      console.log(chalk.dim(header));
      console.log(chalk.dim('─'.repeat(header.length + 20)));

      for (const issue of res.issues) {
        const status = statusColor(chalk, issue.status);
        const level = levelColor(chalk, issue.level);
        const culprit = issue.culprit_function
          ? `${issue.culprit_function}${
              issue.culprit_line ? `:${issue.culprit_line}` : ''
            }`
          : '';
        console.log(
          [
            status.padEnd(10 + 10),
            level.padEnd(8 + 10),
            pad(String(issue.event_count), 8),
            pad(String(issue.users_affected), 7),
            chalk.bold(pad(issue.exception_type, 22)),
            chalk.dim(culprit),
          ].join('  '),
        );
        const preview = issue.exception_value?.slice(0, 120) ?? '';
        if (preview) {
          console.log(chalk.dim(`    ${preview}`));
        }
        console.log(chalk.dim(`    id=${issue.id}  last=${fmtAgo(issue.last_seen_at)}`));
      }

      if (res.next_cursor) {
        console.log(
          chalk.dim(
            `\n  ${res.issues.length} issues shown. More available — re-run with --cursor=${res.next_cursor}`,
          ),
        );
      }
    });
  });

// ── `catch issues get <id>` ─────────────────────────────────────────

const getIssue = new Command('get')
  .argument('<id>', 'issue id (iss_*)')
  .description('Show full detail for a single issue')
  .action(async (id) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const resp = await jwtFetch<{ issue: IssueSummary; trend: unknown[] }>(
        auth,
        `/api/v1/catch/issues/${encodeURIComponent(id)}`,
      );
      const { issue } = resp;
      console.log(
        chalk.bold(`${issue.exception_type}`) +
          (issue.exception_value ? `  ${chalk.dim(issue.exception_value)}` : ''),
      );
      console.log(chalk.dim(`  fingerprint: ${issue.fingerprint}`));
      console.log(
        `  status: ${statusColor(chalk, issue.status)}  level: ${levelColor(
          chalk,
          issue.level,
        )}  platform: ${chalk.cyan(issue.platform)}`,
      );
      console.log(
        `  events: ${chalk.bold(issue.event_count)}  users: ${chalk.bold(
          issue.users_affected,
        )}  first: ${fmtAgo(issue.first_seen_at)}  last: ${fmtAgo(issue.last_seen_at)}`,
      );
      if (issue.last_seen_release) {
        console.log(chalk.dim(`  last_release: ${issue.last_seen_release}`));
      }
      if (issue.culprit_function) {
        console.log(
          chalk.dim(
            `  culprit: ${issue.culprit_function}${
              issue.culprit_line ? `:${issue.culprit_line}` : ''
            }${issue.culprit_file ? ` (${issue.culprit_file})` : ''}`,
          ),
        );
      }
      console.log(
        chalk.dim(
          `\n  View in dashboard: ${auth.endpoint.replace(/\/$/, '')}/dashboard/catch/${
            issue.id
          }`,
        ),
      );
    });
  });

// ── Triage actions ───────────────────────────────────────────────────

function triageCommand(
  name: 'resolve' | 'ignore' | 'reopen',
  description: string,
) {
  return new Command(name)
    .argument('<id>', 'issue id (iss_*)')
    .option('-n, --note <text>', 'optional triage note for the audit log')
    .option(
      '--until <iso>',
      '(ignore only) ignore until this ISO timestamp; auto-reopen after',
    )
    .description(description)
    .action(async (id, opts) => {
      await runWithAuth(async ({ auth, chalk }) => {
        const body: Record<string, unknown> = {};
        if (opts.note) body.note = opts.note;
        if (name === 'ignore' && opts.until) body.until = opts.until;

        const resp = await jwtFetch<{ issue: IssueSummary }>(
          auth,
          `/api/v1/catch/issues/${encodeURIComponent(id)}/${name}`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        );
        console.log(
          chalk.green(`  ✓ ${name}d ${chalk.bold(resp.issue.id)}`) +
            chalk.dim(`  status=${resp.issue.status}`),
        );
      });
    });
}

// ── `catch issues assign <id>` ──────────────────────────────────────

const assignIssue = new Command('assign')
  .argument('<id>', 'issue id (iss_*)')
  .argument('<assignee>', 'user id or team id to assign')
  .option('--kind <kind>', 'user or team', 'user')
  .description('Assign an issue to a user or team')
  .action(async (id, assignee, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const kind = opts.kind === 'team' ? 'team' : 'user';
      await jwtFetch(auth, `/api/v1/catch/issues/${encodeURIComponent(id)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignee_id: assignee, assignee_kind: kind }),
      });
      console.log(
        chalk.green(`  ✓ assigned ${chalk.bold(id)} to ${kind}:${assignee}`),
      );
    });
  });

// ── `catch symbols upload` ──────────────────────────────────────────

interface SymbolArtifact {
  id: string;
  kind: string;
  release?: string;
  match_key: string;
  size_bytes: number;
  status: string;
  original_name: string;
  uploaded_at: string;
}

const uploadSymbols = new Command('upload')
  .argument('<file>', 'path to the symbol file (source map, dSYM zip, mapping.txt, …)')
  .option('-k, --kind <kind>', 'js_sourcemap | ios_dsym | android_mapping | android_ndk | flutter_symbols')
  .option('-r, --release <release>', 'release tag this artifact belongs to')
  .option('-m, --match-key <key>', 'matching key the resolver uses (filename, UUID, build-id)')
  .option('-c, --commit <sha>', 'git commit SHA for dashboard attribution')
  .option('--env <env>', 'environment (live or test)')
  .description('Upload a symbol artifact for server-side stack-trace resolution')
  .action(async (file, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const abs = path.resolve(String(file));
      if (!fs.existsSync(abs)) {
        throw new Error(`file not found: ${abs}`);
      }

      const kind = resolveKind(opts.kind, abs);
      if (!kind) {
        throw new Error(
          'could not infer kind — pass --kind (js_sourcemap | ios_dsym | android_mapping | android_ndk | flutter_symbols)',
        );
      }
      const env = opts.env ?? auth.environment;

      const buf = fs.readFileSync(abs);
      // Guard against Node FormData + fetch rejecting large blobs —
      // we cap matching the server cap.
      if (buf.length > 100 * 1024 * 1024) {
        throw new Error(`file too large (${buf.length} bytes; max 100 MB per upload)`);
      }

      const fd = new FormData();
      fd.set('kind', kind);
      fd.set('environment', env);
      if (opts.release) fd.set('release', opts.release);
      if (opts.matchKey) fd.set('match_key', opts.matchKey);
      if (opts.commit) fd.set('commit_sha', opts.commit);
      fd.set(
        'file',
        new Blob([new Uint8Array(buf)], { type: defaultContentType(kind) }),
        path.basename(abs),
      );

      const url = `${auth.endpoint.replace(/\/$/, '')}/api/v1/catch/symbols`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.jwt}`,
          'x-project-id': auth.projectId,
        },
        body: fd,
      });
      const text = await res.text();
      let body: any;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!res.ok) {
        throw new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
      }
      const art: SymbolArtifact = body?.artifact;
      console.log(
        chalk.green(
          `  ✓ uploaded ${chalk.bold(path.basename(abs))}  ` +
            chalk.dim(`(${chalk.cyan(art.kind)} · ${bytes(art.size_bytes)} · ${art.id})`),
        ),
      );
      if (art.release) console.log(chalk.dim(`    release: ${art.release}`));
      console.log(chalk.dim(`    match_key: ${art.match_key}`));
      console.log(chalk.dim(`    status: ${art.status}`));
    });
  });

// ── `catch symbols list` ────────────────────────────────────────────

const listSymbols = new Command('list')
  .option('-k, --kind <kind>', 'filter by artifact kind')
  .option('-r, --release <release>', 'filter by release')
  .option('--env <env>', 'environment (live or test)')
  .option('--limit <n>', 'max rows', '50')
  .description('List uploaded symbol artifacts')
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const params = new URLSearchParams({ environment: env, limit: String(opts.limit ?? 50) });
      if (opts.kind) params.set('kind', opts.kind);
      if (opts.release) params.set('release', opts.release);
      const resp = await jwtFetch<{ artifacts: SymbolArtifact[] }>(
        auth,
        `/api/v1/catch/symbols?${params.toString()}`,
      );
      if (resp.artifacts.length === 0) {
        console.log(chalk.dim('  no artifacts match the filter.'));
        return;
      }
      const header = [
        pad('KIND', 16),
        pad('STATUS', 9),
        pad('SIZE', 9),
        pad('RELEASE', 14),
        pad('MATCH KEY', 28),
        'UPLOADED',
      ].join('  ');
      console.log(chalk.dim(header));
      console.log(chalk.dim('─'.repeat(header.length + 12)));
      for (const art of resp.artifacts) {
        console.log(
          [
            chalk.cyan(pad(art.kind, 16)),
            statusColorArtifact(chalk, art.status).padEnd(9 + 10),
            pad(bytes(art.size_bytes), 9),
            pad(art.release ?? '—', 14),
            pad(art.match_key, 28),
            chalk.dim(fmtAgo(art.uploaded_at)),
          ].join('  '),
        );
      }
    });
  });

// ── `catch symbols delete <id>` ─────────────────────────────────────

const deleteSymbol = new Command('delete')
  .argument('<id>', 'artifact id (sym_*)')
  .description('Delete a symbol artifact (purges the blob + index row)')
  .action(async (id) => {
    await runWithAuth(async ({ auth, chalk }) => {
      await jwtFetch(auth, `/api/v1/catch/symbols/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      console.log(chalk.green(`  ✓ deleted ${chalk.bold(id)}`));
    });
  });

const symbolsCommand = new Command('symbols')
  .description('Upload + manage symbol artifacts (source maps, dSYM, mapping.txt, …)')
  .addCommand(uploadSymbols)
  .addCommand(listSymbols)
  .addCommand(deleteSymbol);

// ── `catch events` ───────────────────────────────────────────────────

interface EventListRow {
  event_id: string;
  timestamp: string;
  level: string;
  type: string;
  platform: string;
  exception_type: string;
  message: string;
  fingerprint: string;
  issue_id: string;
  release: string;
  environment: string;
}

const listEvents = new Command('list')
  .description('Tail raw events for the current project')
  .option('--env <env>', 'environment (live or test)')
  .option('--since <window>', 'time window: 30m|1h|6h|12h|24h|2d|7d|30d', '1h')
  .option('--level <level>', 'filter by level')
  .option('--release <release>', 'filter by release')
  .option('--platform <platform>', 'filter by platform')
  .option('--limit <n>', 'max rows', '50')
  .option('--json', 'emit JSON instead of a table')
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const params = new URLSearchParams({
        environment: env,
        since: opts.since ?? '1h',
        limit: String(Math.max(1, parseInt(opts.limit, 10) || 50)),
      });
      if (opts.level) params.set('level', opts.level);
      if (opts.release) params.set('release', opts.release);
      if (opts.platform) params.set('platform', opts.platform);

      const res = await jwtFetch<{ events: EventListRow[] }>(
        auth,
        `/api/v1/catch/events?${params.toString()}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.events, null, 2));
        return;
      }
      if (res.events.length === 0) {
        console.log(chalk.dim('  No events in this window.'));
        return;
      }
      for (const e of res.events) {
        const title = e.exception_type || e.message || e.type;
        console.log(
          `${chalk.dim(pad(fmtAgo(e.timestamp), 10))}  ` +
            `${levelColor(chalk, e.level)} ` +
            `${chalk.dim(pad(e.platform, 10))} ` +
            `${chalk.cyan(e.event_id.slice(0, 10))}  ` +
            chalk.white(title),
        );
      }
      console.log(chalk.dim(`\n  ${res.events.length} events`));
    });
  });

const getEvent = new Command('get')
  .description('Print one event by ID (full stack + context)')
  .argument('<id>', 'event_id')
  .option('--env <env>', 'environment (live or test)')
  .option('--json', 'emit JSON')
  .action(async (id, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const res = await jwtFetch<{ event: any }>(
        auth,
        `/api/v1/catch/events/${encodeURIComponent(id)}?environment=${env}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.event, null, 2));
        return;
      }
      const ev = res.event;
      console.log();
      console.log(
        chalk.bold(
          ev.exception_type
            ? `${ev.exception_type}: ${ev.message || ''}`
            : ev.message || ev.type,
        ),
      );
      console.log(
        chalk.dim(
          `  ${ev.timestamp}  ${ev.level}  ${ev.platform}  ${ev.sdk?.name ?? ''}@${ev.sdk?.version ?? ''}`,
        ),
      );
      if (ev.release) console.log(chalk.dim(`  release: ${ev.release}`));
      if (ev.issue_id) console.log(chalk.dim(`  issue:   ${ev.issue_id}`));
      if (Array.isArray(ev.stack_frames) && ev.stack_frames.length > 0) {
        console.log();
        console.log(chalk.bold('  Stack (throw-site first):'));
        for (const f of ev.stack_frames.slice().reverse()) {
          const loc = f.lineno ? `:${f.lineno}` : '';
          const col = f.colno ? `:${f.colno}` : '';
          console.log(
            `    ${chalk.cyan(f.function || '<anonymous>')}  ` +
              chalk.dim(`${f.abs_path || f.filename || ''}${loc}${col}`),
          );
        }
      }
      console.log();
    });
  });

const eventsCommand = new Command('events')
  .description('Raw event tail + detail')
  .addCommand(listEvents)
  .addCommand(getEvent);

// ── `catch alerts` ───────────────────────────────────────────────────

interface AlertRuleRow {
  id: string;
  name: string;
  kind: string;
  environment: string;
  enabled: boolean;
  destinations?: Array<{ type: string; target?: string }>;
}

const listAlerts = new Command('list')
  .description('List alert rules for the project')
  .option('--env <env>', 'environment (live or test)')
  .option('--json', 'emit JSON')
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const res = await jwtFetch<{ rules: AlertRuleRow[] }>(
        auth,
        `/api/v1/catch/rules?environment=${env}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.rules, null, 2));
        return;
      }
      if (res.rules.length === 0) {
        console.log(chalk.dim('  No rules defined.'));
        return;
      }
      for (const r of res.rules) {
        const dests =
          (r.destinations ?? [])
            .map((d) => d.type)
            .join(',') || chalk.dim('none');
        console.log(
          `${r.enabled ? chalk.green('on ') : chalk.dim('off')}  ` +
            `${chalk.cyan(pad(r.id, 12))}  ` +
            `${chalk.dim(pad(r.kind, 18))}  ` +
            `${chalk.bold(pad(r.name, 32))}  ` +
            `→ ${dests}`,
        );
      }
    });
  });

const testAlert = new Command('test')
  .description('Fire a synthetic notification through a rule\'s destinations')
  .argument('<id>', 'rule id')
  .action(async (id) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const res = await jwtFetch<{ total: number; delivered: number; errors: string[] }>(
        auth,
        `/api/v1/catch/rules/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
      );
      if (res.total === 0) {
        console.error(chalk.yellow('  No destinations configured on this rule.'));
        process.exit(1);
      }
      if (res.delivered === res.total) {
        console.log(
          chalk.green(`  ✓ delivered to ${res.delivered}/${res.total} destinations`),
        );
      } else {
        console.error(
          chalk.yellow(`  ⚠ delivered to ${res.delivered}/${res.total} destinations`),
        );
        for (const err of res.errors) console.error(chalk.red(`    ${err}`));
        process.exit(1);
      }
    });
  });

const alertsCommand = new Command('alerts')
  .description('Inspect + test notification alert rules')
  .addCommand(listAlerts)
  .addCommand(testAlert);

// ── `catch stats` ────────────────────────────────────────────────────

const statsCommand = new Command('stats')
  .description('Event volume + triage status for the project')
  .option('--env <env>', 'environment (live or test)')
  .option('--json', 'emit JSON')
  .action(async (opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const env = opts.env ?? auth.environment;
      const res = await jwtFetch<any>(
        auth,
        `/api/v1/catch/stats?environment=${env}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`  ${res.project_id} · ${res.environment}`));
      console.log();
      console.log(chalk.bold('  Events'));
      console.log(`    last hour: ${chalk.cyan(res.events.last_hour)}`);
      console.log(`    last 24h:  ${chalk.cyan(res.events.last_24h)}`);
      console.log(`    last 7d:   ${chalk.cyan(res.events.last_7d)}`);
      console.log();
      console.log(chalk.bold('  Issues'));
      console.log(`    unresolved: ${chalk.red(res.issues.unresolved ?? 0)}`);
      console.log(`    resolved:   ${chalk.green(res.issues.resolved ?? 0)}`);
      console.log(`    ignored:    ${chalk.yellow(res.issues.ignored ?? 0)}`);
      console.log();
      console.log(chalk.bold('  Reliability (24h)'));
      console.log(
        `    crash-free sessions: ${chalk.cyan(
          (res.crash_free_pct_24h ?? 0).toFixed(2),
        )}%  (${res.crashes_last_24h}/${res.sessions_last_24h})`,
      );
      console.log();
      console.log(chalk.bold('  Performance (7d)'));
      console.log(`    transactions: ${chalk.cyan(res.transactions_last_7d)}`);
      console.log(`    profiles:     ${chalk.cyan(res.profiles_last_7d)}`);
      console.log();
    });
  });

// ── `catch symbolicate` ──────────────────────────────────────────────

interface FrameLike {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  abs_path?: string;
  in_app?: boolean;
}

const symbolicateCommand = new Command('symbolicate')
  .description('Reverse-lookup a minified/obfuscated stack against your uploaded symbols')
  .argument('<file>', 'path to a JSON file with {frames:[{filename,lineno,colno},...]} or a raw Catch event export')
  .option('--env <env>', 'environment (live or test)')
  .option('--release <release>', 'release identifier to scope the lookup')
  .option('--kind <kind>', 'artifact kind override (js_sourcemap, ios_dsym, ...)')
  .option('--json', 'emit JSON')
  .action(async (file, opts) => {
    await runWithAuth(async ({ auth, chalk }) => {
      const absPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
      if (!fs.existsSync(absPath)) {
        throw new Error(`file not found: ${absPath}`);
      }
      const raw = fs.readFileSync(absPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Accept either {frames:[]} or a full CatchEventV1 export.
      let frames: FrameLike[];
      if (Array.isArray(parsed?.frames)) {
        frames = parsed.frames;
      } else if (Array.isArray(parsed?.exception?.stacktrace?.frames)) {
        frames = parsed.exception.stacktrace.frames;
      } else if (Array.isArray(parsed?.stack_frames)) {
        frames = parsed.stack_frames;
      } else {
        throw new Error(
          'input must contain `frames: [...]` or `exception.stacktrace.frames` or `stack_frames`',
        );
      }
      const body = {
        environment: opts.env ?? auth.environment,
        release: opts.release,
        kind: opts.kind,
        frames,
      };
      const res = await jwtFetch<{ frames: FrameLike[] }>(
        auth,
        `/api/v1/catch/symbolicate`,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        },
      );
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold('  Symbolicated frames (throw-site first):'));
      for (const f of res.frames.slice().reverse()) {
        const loc =
          (f.filename || f.abs_path || '<anonymous>') +
          (f.lineno ? `:${f.lineno}` : '') +
          (f.colno ? `:${f.colno}` : '');
        const label = chalk.cyan(f.function || '<anonymous>');
        const dim = f.in_app === false ? chalk.dim : (s: string) => s;
        console.log(`    ${label}  ${dim(loc)}`);
      }
      console.log();
    });
  });

// ── `catch make-dsym-manifest` + `make-ndk-manifest` ────────────────

const makeDSymManifest = new Command('make-dsym-manifest')
  .description('Convert a macOS/iOS .dSYM bundle into a Sankofa Catch symbol manifest')
  .argument('<dsym>', 'path to a .dSYM bundle or the binary inside it')
  .option('-o, --output <file>', 'output manifest path (default: <dsym>.manifest.json)')
  .option('--arch <arch>', 'limit to one slice when a universal binary is present')
  .option('--with-line-info', 'augment with file:line info via atos / llvm-symbolizer (default on)')
  .option('--no-line-info', 'skip the line-info pass (function names only)')
  .action(async (dsym, opts) => {
    const chalk = (await import('chalk')).default;
    try {
      const manifest = buildDSymManifest({
        dsymPath: dsym,
        arch: opts.arch,
        withLineInfo: opts.lineInfo !== false,
      });
      const out = opts.output ?? defaultManifestOutput(dsym);
      writeManifest(manifest, out);
      console.log(chalk.green(`  ✓ wrote ${chalk.bold(out)}`));
      console.log(chalk.dim(`    debug_id: ${manifest.debug_id}`));
      console.log(chalk.dim(`    arch:     ${manifest.arch}`));
      console.log(chalk.dim(`    symbols:  ${manifest.symbols.length}`));
      printLineInfoStats(chalk, manifest._lineInfo);
    } catch (err: any) {
      console.error(chalk.red(`  ${err.message}`));
      process.exit(1);
    }
  });

const makeNDKManifest = new Command('make-ndk-manifest')
  .description('Convert an Android NDK .so into a Sankofa Catch symbol manifest')
  .argument('<so>', 'path to a shared object (.so) file')
  .option('-o, --output <file>', 'output manifest path (default: <so>.manifest.json)')
  .option('--debug-id <id>', 'override the GNU build-id lookup')
  .option('--with-line-info', 'augment with file:line info via llvm-symbolizer (default on)')
  .option('--no-line-info', 'skip the line-info pass (function names only)')
  .action(async (so, opts) => {
    const chalk = (await import('chalk')).default;
    try {
      const manifest = buildNDKManifest({
        soPath: so,
        debugId: opts.debugId,
        withLineInfo: opts.lineInfo !== false,
      });
      const out = opts.output ?? defaultManifestOutput(so);
      writeManifest(manifest, out);
      console.log(chalk.green(`  ✓ wrote ${chalk.bold(out)}`));
      console.log(chalk.dim(`    debug_id: ${manifest.debug_id}`));
      console.log(chalk.dim(`    arch:     ${manifest.arch}`));
      console.log(chalk.dim(`    symbols:  ${manifest.symbols.length}`));
      printLineInfoStats(chalk, manifest._lineInfo);
    } catch (err: any) {
      console.error(chalk.red(`  ${err.message}`));
      process.exit(1);
    }
  });

function printLineInfoStats(chalk: any, stats: { enabled: boolean; tool: string | null; covered: number; total: number } | undefined) {
  if (!stats) return;
  if (!stats.enabled) {
    console.log(chalk.dim('    line info: skipped (--no-line-info)'));
    return;
  }
  if (!stats.tool) {
    console.log(
      chalk.yellow(
        '    line info: tool not found (install Xcode CLT for atos, or llvm for llvm-symbolizer)',
      ),
    );
    return;
  }
  const pct = stats.total > 0 ? ((stats.covered / stats.total) * 100).toFixed(1) : '0.0';
  console.log(
    chalk.dim(
      `    line info: ${stats.covered}/${stats.total} symbols (${pct}%) via ${stats.tool}`,
    ),
  );
}

function defaultManifestOutput(input: string): string {
  const base = input.replace(/\/+$/, '');
  return `${base}.manifest.json`;
}

// ── Root ─────────────────────────────────────────────────────────────

const issuesCommand = new Command('issues')
  .description('Manage Catch issues')
  .addCommand(listIssues)
  .addCommand(getIssue)
  .addCommand(triageCommand('resolve', 'Mark an issue as resolved'))
  .addCommand(triageCommand('ignore', 'Ignore an issue (optionally with auto-reopen date)'))
  .addCommand(triageCommand('reopen', 'Reopen a resolved or ignored issue'))
  .addCommand(assignIssue);

export const catchCommand = new Command('catch')
  .description('Sankofa Catch — error tracking triage + alerts')
  .addCommand(issuesCommand)
  .addCommand(eventsCommand)
  .addCommand(alertsCommand)
  .addCommand(symbolsCommand)
  .addCommand(statsCommand)
  .addCommand(symbolicateCommand)
  .addCommand(makeDSymManifest)
  .addCommand(makeNDKManifest);

// ─── Symbol helpers ──────────────────────────────────────────────

function resolveKind(explicit: string | undefined, filePath: string): string | null {
  if (explicit) {
    const known = [
      'js_sourcemap',
      'ios_dsym',
      'android_mapping',
      'android_ndk',
      'flutter_symbols',
    ];
    return known.includes(explicit) ? explicit : null;
  }
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.map')) return 'js_sourcemap';
  if (base.endsWith('.dsym.zip') || base.endsWith('.dsym')) return 'ios_dsym';
  if (base === 'mapping.txt' || base.endsWith('.mapping.txt')) return 'android_mapping';
  if (base.endsWith('.so') || base.endsWith('.so.debug')) return 'android_ndk';
  if (base.endsWith('.symbols') || base.endsWith('.symbols.zip')) return 'flutter_symbols';
  return null;
}

function defaultContentType(kind: string): string {
  switch (kind) {
    case 'js_sourcemap': return 'application/json';
    case 'ios_dsym': return 'application/zip';
    case 'android_mapping': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

function statusColorArtifact(chalk: any, status: string): string {
  switch (status) {
    case 'ready': return chalk.green(status);
    case 'pending': return chalk.yellow(status);
    case 'failed': return chalk.red(status);
    default: return chalk.dim(status);
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Tiny helpers ───────────────────────────────────────────────────

function statusColor(chalk: any, status: string): string {
  switch (status) {
    case 'resolved':
      return chalk.green(status);
    case 'ignored':
      return chalk.yellow(status);
    case 'unresolved':
      return chalk.red(status);
    default:
      return chalk.dim(status);
  }
}

function levelColor(chalk: any, level: string): string {
  switch (level) {
    case 'fatal':
    case 'error':
      return chalk.red(level);
    case 'warning':
      return chalk.yellow(level);
    case 'info':
      return chalk.cyan(level);
    default:
      return chalk.dim(level);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

function fmtAgo(ts: string): string {
  const diffSec = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
