import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadGlobalConfig } from '../utils/config.js';

type CheckResult = {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
};

export const doctorCommand = new Command('doctor')
  .description('Diagnose the local toolchain + Sankofa server reachability in one shot')
  .option('--project <path>', 'React Native app directory (defaults to cwd)')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;

    const results: CheckResult[] = [];
    const cwd = opts.project ? opts.project : process.cwd();

    results.push(check('Node.js', () => {
      const v = process.versions.node;
      const major = parseInt(v.split('.')[0], 10);
      if (major < 18) return { status: 'fail', detail: `${v} — need ≥18` };
      return { status: 'ok', detail: v };
    }));

    if (process.platform === 'darwin') {
      results.push(check('Xcode (xcodebuild)', () => {
        try {
          const v = execSync('xcodebuild -version', { encoding: 'utf-8' }).split('\n')[0];
          return { status: 'ok', detail: v };
        } catch {
          return { status: 'fail', detail: 'not found — install Xcode from the App Store' };
        }
      }));

      results.push(check('Xcode Command Line Tools', () => {
        try {
          const path = execSync('xcode-select -p', { encoding: 'utf-8' }).trim();
          return { status: 'ok', detail: path };
        } catch {
          return { status: 'fail', detail: 'run `xcode-select --install`' };
        }
      }));

      results.push(check('xcrun simctl', () => {
        try {
          const booted = execSync('xcrun simctl list devices booted', { encoding: 'utf-8' });
          const count = (booted.match(/\(Booted\)/g) || []).length;
          return count > 0
            ? { status: 'ok', detail: `${count} booted simulator(s)` }
            : { status: 'warn', detail: 'no booted simulator — open Simulator before running `sankofa preview`' };
        } catch {
          return { status: 'fail', detail: 'simctl not available' };
        }
      }));

      results.push(check('CocoaPods', () => {
        try {
          const v = execSync('pod --version', { encoding: 'utf-8' }).trim();
          return { status: 'ok', detail: v };
        } catch {
          return { status: 'fail', detail: 'install with `sudo gem install cocoapods` or via Homebrew' };
        }
      }));

      results.push(check('Bundler (optional)', () => {
        try {
          const v = execSync('bundle --version', { encoding: 'utf-8' }).trim();
          return { status: 'ok', detail: v };
        } catch {
          return { status: 'warn', detail: 'not installed — only needed if your project has a Gemfile' };
        }
      }));

      results.push(check('xcrun altool (for submit ios)', () => {
        try {
          execSync('xcrun altool --help', { stdio: 'ignore' });
          return { status: 'ok', detail: 'present' };
        } catch {
          return { status: 'warn', detail: 'not on PATH — `sankofa submit ios` will fail' };
        }
      }));
    } else {
      results.push({ name: 'Xcode / iOS toolchain', status: 'skip', detail: 'not macOS' });
    }

    results.push(check('Java', () => {
      try {
        const out = execSync('java -version 2>&1', { encoding: 'utf-8' });
        const m = out.match(/version "([^"]+)"/);
        if (!m) return { status: 'warn', detail: out.split('\n')[0] };
        const version = m[1];
        const major = parseInt(version.split('.')[0], 10);
        // Android Gradle Plugin officially supports Java 17 (LTS) and
        // Java 21. Java 24+ fails CMake configure tasks with native-access
        // restrictions — silent 20-minute build failures. Flag early.
        if (major < 17) {
          return { status: 'fail', detail: `${version} — Android requires Java 17+. Install with: brew install --cask temurin@17` };
        }
        if (major > 21) {
          return { status: 'fail', detail: `${version} — Android Gradle Plugin doesn't support Java ${major}. Install Java 17: brew install --cask temurin@17, then: export JAVA_HOME=$(/usr/libexec/java_home -v 17)` };
        }
        return { status: 'ok', detail: version };
      } catch {
        return { status: 'warn', detail: 'not found — needed for Android builds' };
      }
    }));

    results.push(check('Android SDK (ANDROID_HOME)', () => {
      const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
      if (!home) return { status: 'warn', detail: 'ANDROID_HOME/ANDROID_SDK_ROOT unset — needed for Android builds' };
      if (!existsSync(home)) return { status: 'fail', detail: `${home} does not exist` };
      return { status: 'ok', detail: home };
    }));

    results.push(check('adb', () => {
      try {
        const v = execSync('adb --version', { encoding: 'utf-8' }).split('\n')[0];
        return { status: 'ok', detail: v };
      } catch {
        return { status: 'warn', detail: 'not on PATH — needed for `sankofa preview android` + log streaming' };
      }
    }));

    const pkg = readPackageJson(cwd);
    results.push(check('React Native project', () => {
      if (!pkg) return { status: 'warn', detail: `no package.json at ${cwd}` };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.expo) return { status: 'ok', detail: `Expo ${deps.expo}` };
      if (deps['react-native']) return { status: 'ok', detail: `React Native ${deps['react-native']} (bare)` };
      return { status: 'fail', detail: 'neither expo nor react-native in dependencies' };
    }));

    results.push(check('sankofa-react-native SDK', () => {
      if (!pkg) return { status: 'skip', detail: 'no package.json' };
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      return deps['sankofa-react-native']
        ? { status: 'ok', detail: deps['sankofa-react-native'] }
        : { status: 'warn', detail: 'SDK not installed — runtime checkForUpdate will be a no-op' };
    }));

    results.push(check('ios/ prebuild', () => {
      const iosDir = join(cwd, 'ios');
      if (!existsSync(iosDir)) return { status: 'warn', detail: 'ios/ missing — run `npx expo prebuild --platform ios`' };
      return { status: 'ok', detail: iosDir };
    }));

    results.push(check('android/ prebuild', () => {
      const androidDir = join(cwd, 'android');
      if (!existsSync(androidDir)) return { status: 'warn', detail: 'android/ missing — run `npx expo prebuild --platform android`' };
      return { status: 'ok', detail: androidDir };
    }));

    const global = loadGlobalConfig();
    results.push(check('Sankofa credentials', () => {
      if (!global.token && !process.env.SANKOFA_DEPLOY_TOKEN) {
        return { status: 'warn', detail: 'not logged in — run `sankofa login`' };
      }
      if (!global.projectId && !process.env.SANKOFA_PROJECT_ID) {
        return { status: 'warn', detail: 'no project selected — run `sankofa login` or `sankofa switch`' };
      }
      return { status: 'ok', detail: `project ${global.projectId || process.env.SANKOFA_PROJECT_ID}` };
    }));

    const endpoint = process.env.SANKOFA_ENDPOINT || global.endpoint;
    results.push(await checkAsync('Sankofa server reachable', async () => {
      if (!endpoint) return { status: 'skip', detail: 'no endpoint configured' };
      try {
        const res = await fetch(`${endpoint}/api/admin/health`, { method: 'GET' });
        if (res.ok) return { status: 'ok', detail: `${endpoint} — ${res.status}` };
        return { status: 'warn', detail: `${endpoint} responded ${res.status}` };
      } catch (err: any) {
        return { status: 'fail', detail: `${endpoint} — ${err.message}` };
      }
    }));

    const pad = Math.max(...results.map((r) => r.name.length));
    console.log('');
    for (const r of results) {
      const icon =
        r.status === 'ok' ? chalk.green('✓') :
        r.status === 'warn' ? chalk.yellow('!') :
        r.status === 'skip' ? chalk.dim('-') :
        chalk.red('✖');
      const tone =
        r.status === 'ok' ? chalk.dim :
        r.status === 'warn' ? chalk.yellow :
        r.status === 'skip' ? chalk.dim :
        chalk.red;
      console.log(`  ${icon} ${r.name.padEnd(pad)}   ${tone(r.detail)}`);
    }

    const failed = results.filter((r) => r.status === 'fail').length;
    const warned = results.filter((r) => r.status === 'warn').length;
    console.log('');
    if (failed > 0) {
      console.log(chalk.red.bold(`  ${failed} check(s) failed, ${warned} warning(s).`));
      process.exit(1);
    } else if (warned > 0) {
      console.log(chalk.yellow.bold(`  ${warned} warning(s). Core toolchain OK.`));
    } else {
      console.log(chalk.green.bold('  All checks passed.'));
    }
    console.log('');
  });

function check(name: string, fn: () => { status: CheckResult['status']; detail: string }): CheckResult {
  try {
    const { status, detail } = fn();
    return { name, status, detail };
  } catch (err: any) {
    return { name, status: 'fail', detail: err?.message || String(err) };
  }
}

async function checkAsync(
  name: string,
  fn: () => Promise<{ status: CheckResult['status']; detail: string }>,
): Promise<CheckResult> {
  try {
    const { status, detail } = await fn();
    return { name, status, detail };
  } catch (err: any) {
    return { name, status: 'fail', detail: err?.message || String(err) };
  }
}

function readPackageJson(dir: string): any | null {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
