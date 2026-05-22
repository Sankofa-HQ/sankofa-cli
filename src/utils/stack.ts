import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export type Stack =
  | 'react-native'
  | 'flutter'
  | 'web'
  | 'native-ios'
  | 'native-android'
  | 'unknown';

export const ALL_STACKS: Stack[] = [
  'react-native',
  'flutter',
  'web',
  'native-ios',
  'native-android',
];

export const STACK_LABELS: Record<Stack, string> = {
  'react-native': 'React Native',
  flutter: 'Flutter',
  web: 'Web / JavaScript',
  'native-ios': 'iOS (Swift)',
  'native-android': 'Android (Kotlin)',
  unknown: 'Unknown',
};

export interface ProjectInfo {
  root: string;
  stack: Stack;
  name: string;
  framework?: 'expo' | 'bare';
  flutterPackageName?: string;
  webFramework?: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  'out',
  'ios',
  'android',
  'Pods',
  '.expo',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '__tests__',
  '.dart_tool',
  '.fvm',
  '.gradle',
  'DerivedData',
]);

function readJSON(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readPubspecName(dir: string): string | null {
  const raw = readText(join(dir, 'pubspec.yaml'));
  if (!raw) return null;
  const m = raw.match(/^name:\s*([A-Za-z0-9_]+)/m);
  return m ? m[1] : null;
}

export function classifyProject(dir: string): ProjectInfo | null {
  const abs = resolve(dir);

  if (existsSync(join(abs, 'pubspec.yaml'))) {
    const flutterPackageName = readPubspecName(abs) || undefined;
    return {
      root: abs,
      stack: 'flutter',
      name: flutterPackageName || abs,
      flutterPackageName,
    };
  }

  const pkg = readJSON(join(abs, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasRN = !!deps['react-native'];
    const hasExpo = !!deps['expo'];
    if (hasRN || hasExpo) {
      return {
        root: abs,
        stack: 'react-native',
        name: pkg.name || abs,
        framework: hasExpo ? 'expo' : 'bare',
      };
    }
    const webHint =
      deps['next'] ? 'next' :
      deps['vite'] ? 'vite' :
      deps['react-scripts'] ? 'cra' :
      deps['vue'] ? 'vue' :
      deps['nuxt'] ? 'nuxt' :
      deps['svelte'] ? 'svelte' :
      deps['angular'] || deps['@angular/core'] ? 'angular' :
      deps['react'] ? 'react' :
      null;
    if (webHint || existsSync(join(abs, 'index.html'))) {
      return {
        root: abs,
        stack: 'web',
        name: pkg.name || abs,
        webFramework: webHint || 'static',
      };
    }
  }

  if (existsSync(join(abs, 'Package.swift'))) {
    return { root: abs, stack: 'native-ios', name: abs };
  }

  if (
    existsSync(join(abs, 'app', 'build.gradle.kts')) ||
    existsSync(join(abs, 'app', 'build.gradle'))
  ) {
    return { root: abs, stack: 'native-android', name: abs };
  }

  return null;
}

export function detectStack(dir: string): Stack {
  return classifyProject(dir)?.stack ?? 'unknown';
}

export function findProjectsBelow(
  dir: string,
  opts: { stacks?: Stack[]; depth?: number } = {},
): ProjectInfo[] {
  const depth = opts.depth ?? 3;
  const allow = opts.stacks ? new Set(opts.stacks) : null;
  const results: ProjectInfo[] = [];
  if (depth < 0 || !existsSync(dir)) return results;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const sub = join(dir, entry.name);
    const found = classifyProject(sub);
    if (found && (!allow || allow.has(found.stack))) {
      results.push(found);
      continue;
    }
    results.push(...findProjectsBelow(sub, { stacks: opts.stacks, depth: depth - 1 }));
  }
  return results;
}

/**
 * Guard for commands that are only implemented for some stacks today.
 * Resolves the project, detects the stack, and if it's not in
 * `supportedStacks` prints a clear message pointing at the right native
 * tool, then exits non-zero. Returns the resolved project if supported.
 *
 * Centralised so we have one place to update when Flutter / iOS / native
 * gain support for preview / dist / submit etc.
 */
export async function requireSupportedStack(opts: {
  commandName: string;
  supportedStacks: Stack[];
  explicit?: string;
  unsupportedHint?: Partial<Record<Stack, string>>;
}): Promise<ProjectInfo> {
  const chalk = (await import('chalk')).default;
  let project: ProjectInfo;
  try {
    project = await resolveProjectRoot({ explicit: opts.explicit });
  } catch (err: any) {
    console.error(chalk.red(`  ✖ ${err.message}`));
    process.exit(1);
  }
  if (project.root !== process.cwd()) {
    console.log(chalk.dim(`  → Working in ${project.root}`));
    process.chdir(project.root);
  }
  if (!opts.supportedStacks.includes(project.stack)) {
    console.log('');
    console.log(chalk.yellow(`  ⚠ \`sankofa ${opts.commandName}\` is not yet implemented for ${STACK_LABELS[project.stack]}.`));
    const hint = opts.unsupportedHint?.[project.stack];
    if (hint) {
      console.log(chalk.dim('     '+ hint));
    } else {
      console.log(chalk.dim(`     Supported today: ${opts.supportedStacks.map((s) => STACK_LABELS[s]).join(', ')}`));
    }
    process.exit(1);
  }
  return project;
}

export async function resolveProjectRoot(
  opts: { explicit?: string; allowedStacks?: Stack[] } = {},
): Promise<ProjectInfo> {
  const cwd = process.cwd();
  const start = opts.explicit ? resolve(cwd, opts.explicit) : cwd;

  const direct = classifyProject(start);
  if (direct && (!opts.allowedStacks || opts.allowedStacks.includes(direct.stack))) {
    return direct;
  }

  if (opts.explicit) {
    const want = opts.allowedStacks
      ? `${opts.allowedStacks.map((s) => STACK_LABELS[s]).join(' / ')} project`
      : 'recognized project';
    throw new Error(`Could not find a ${want} at ${start}.`);
  }

  const candidates = findProjectsBelow(start, { stacks: opts.allowedStacks });
  if (candidates.length === 0) {
    const want = opts.allowedStacks
      ? `${opts.allowedStacks.map((s) => STACK_LABELS[s]).join(' / ')} project`
      : 'recognized project';
    throw new Error(
      `Could not find a ${want} at ${start} or its subdirectories. ` +
        `cd into the project root, or pass --project <path>.`,
    );
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    const chalk = (await import('chalk')).default;
    console.log(
      chalk.dim(`  Detected ${STACK_LABELS[only.stack]} project "${only.name}" at ${only.root}`),
    );
    return only;
  }

  const inquirer = (await import('inquirer')).default;
  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Multiple projects found. Choose one:',
      choices: candidates.map((c) => ({
        name: `${c.name} — ${STACK_LABELS[c.stack]} — ${c.root}`,
        value: c,
      })),
    },
  ]);
  return selected as ProjectInfo;
}
