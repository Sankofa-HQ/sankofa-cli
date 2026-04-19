import { readdirSync, readFileSync, statSync, type Dirent } from 'fs';
import { join, relative } from 'path';

/**
 * Stale-flag scanner. Regex-based rather than AST to keep the
 * dependency tree flat and to support five different language
 * surfaces (JS/TS, Dart, Swift, Kotlin) with one code path. False
 * positives are possible — a comment containing `getFlag("foo")` will
 * match — but those are rare enough in practice to tolerate.
 *
 * Languages covered (by file extension):
 *   .js / .jsx / .ts / .tsx / .mjs / .cjs  → JavaScript regex
 *   .dart                                  → Dart regex (same shape)
 *   .swift                                 → Swift regex
 *   .kt / .kts                             → Kotlin regex
 *
 * Directories skipped: node_modules, build, dist, .git, ios/Pods,
 * android/build, .dart_tool, .next, .expo, .turbo. These are all
 * either generated or vendored — scanning them produces noise and
 * slows the CLI.
 */

export interface StaleFlagWarning {
  key: string;
  severity: 'warning' | 'error';
  message: string;
  locations: Array<{ file: string; line: number }>;
}

export interface ScanResult {
  uniqueKeys: number;
  warnings: StaleFlagWarning[];
}

interface ServerFlag {
  key: string;
  is_archived: boolean;
  current_version: number;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  '.next',
  '.expo',
  '.turbo',
  '.dart_tool',
  'Pods',
]);

// Combined regex that matches any of the canonical flag-lookup
// shapes. Both the Web SDK (`Sankofa.switch.getFlag`) and the RN SDK
// (instance-style `switches.getFlag`) resolve to "identifier.getFlag
// or .getVariant, open paren, string literal" — we capture the key
// directly.
const FLAG_KEY_REGEX = /\.(?:getFlag|getVariant)\s*\(\s*['"]([a-z0-9][a-z0-9._-]{0,127})['"]/g;

const SCANNABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.dart',
  '.swift',
  '.kt', '.kts',
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function* walk(dir: string): Generator<string> {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SCANNABLE_EXTENSIONS.has(extOf(name))) {
        yield full;
      }
    }
  }
}

export interface ScanOptions {
  cwd: string;
  serverFlags: ServerFlag[];
  /**
   * How many days a flag must sit at 100% rollout before the scanner
   * flags it as "delete this dead code." Defaults to 30.
   */
  staleDays?: number;
}

/**
 * Walks the project and emits warnings for common feature-flag drift:
 *   - code references a flag the server doesn't know about (typo / not yet created)
 *   - server has a flag that's nowhere in the code (dead flag)
 *   - server has a flag archived but code still branches on it
 *
 * V1 does NOT yet wire the "100% rollout for 30 days → stale" check —
 * that signal lives in the M6 daily worker (switch_stale_report) which
 * this CLI will consume once it ships. The hook is documented in the
 * plan file; plumbing it here is a future PR.
 */
export async function scanForStaleFlags(opts: ScanOptions): Promise<ScanResult> {
  const root = opts.cwd;
  const byKey = new Map<string, Array<{ file: string; line: number }>>();

  for (const file of walk(root)) {
    let text: string;
    try {
      const stat = statSync(file);
      // Skip files > 2 MB — likely generated bundles, not source.
      if (stat.size > 2 * 1024 * 1024) continue;
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // Fast precheck — skip files that don't reference the API at all
    // so the expensive regex doesn't run on every .ts file.
    if (!text.includes('getFlag') && !text.includes('getVariant')) continue;

    FLAG_KEY_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FLAG_KEY_REGEX.exec(text)) !== null) {
      const key = match[1];
      // Line number = count of newlines up to match index + 1.
      const lineNum = text.slice(0, match.index).split('\n').length;
      const list = byKey.get(key) ?? [];
      list.push({ file: relative(root, file), line: lineNum });
      byKey.set(key, list);
    }
  }

  const serverByKey = new Map(opts.serverFlags.map((f) => [f.key, f]));
  const warnings: StaleFlagWarning[] = [];

  // (a) Keys in code that the server doesn't have — likely typos or
  //     flags that were renamed on the server but not in the app.
  for (const [key, locations] of byKey) {
    if (!serverByKey.has(key)) {
      warnings.push({
        key,
        severity: 'warning',
        message: 'referenced in code but not defined on the server',
        locations,
      });
    } else {
      const srv = serverByKey.get(key)!;
      if (srv.is_archived) {
        warnings.push({
          key,
          severity: 'error',
          message: 'archived on the server but still branched in code — delete the branch',
          locations,
        });
      }
    }
  }

  // (b) Keys on the server that no code references — likely dead
  //     flags ready for archival.
  for (const [key, srv] of serverByKey) {
    if (!byKey.has(key) && !srv.is_archived) {
      warnings.push({
        key,
        severity: 'warning',
        message: 'defined on the server but not referenced anywhere in the codebase',
        locations: [],
      });
    }
  }

  // Stable sort so CI runs produce the same line order every time.
  warnings.sort((a, b) => a.key.localeCompare(b.key));

  return {
    uniqueKeys: byKey.size,
    warnings,
  };
}
