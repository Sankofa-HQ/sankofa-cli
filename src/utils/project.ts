import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export type ProjectFramework = 'expo' | 'bare';

export interface RNProject {
  root: string;
  framework: ProjectFramework;
  name: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  'ios',
  'android',
  'Pods',
  '.expo',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '__tests__',
]);

function readPackageJson(dir: string): any | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function classifyProject(dir: string): RNProject | null {
  const pkg = readPackageJson(dir);
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hasExpo = !!deps.expo;
  const hasRN = !!deps['react-native'];
  if (!hasExpo && !hasRN) return null;
  return {
    root: dir,
    framework: hasExpo ? 'expo' : 'bare',
    name: pkg.name || dir,
  };
}

function findRNProjectsBelow(dir: string, depth = 3): RNProject[] {
  const results: RNProject[] = [];
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
    if (found) {
      results.push(found);
      continue;
    }
    results.push(...findRNProjectsBelow(sub, depth - 1));
  }
  return results;
}

export async function resolveRNProjectRoot(explicit?: string): Promise<RNProject> {
  const cwd = process.cwd();
  const start = explicit ? resolve(cwd, explicit) : cwd;

  const direct = classifyProject(start);
  if (direct) return direct;

  if (explicit) {
    throw new Error(
      `No React Native or Expo project at ${start}. ` +
        `Expected package.json with "react-native" or "expo" as a dependency.`,
    );
  }

  const candidates = findRNProjectsBelow(start);
  if (candidates.length === 0) {
    throw new Error(
      `No React Native or Expo project found at ${start} or its subdirectories. ` +
        `Run this command from a React Native app directory, or pass --project <path>.`,
    );
  }

  const chalk = (await import('chalk')).default;
  if (candidates.length === 1) {
    const only = candidates[0];
    console.log(
      chalk.dim(`  Detected ${only.framework} project "${only.name}" at ${only.root}`),
    );
    return only;
  }

  const inquirer = (await import('inquirer')).default;
  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Multiple React Native projects found. Choose one:',
      choices: candidates.map((c) => ({
        name: `${c.name} (${c.framework}) — ${c.root}`,
        value: c,
      })),
    },
  ]);
  return selected as RNProject;
}
