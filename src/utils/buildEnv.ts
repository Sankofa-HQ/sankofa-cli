/**
 * Cross-platform build environment resolver.
 *
 * Given a target build (Android / iOS), finds the required tooling on
 * the user's machine and returns an enriched `env` object to pass to
 * `execSync` / `spawn`. This is the Tier-1 autoconfig: no shell rc
 * files are modified, no tools are installed — we just scan well-known
 * install paths and wire them up for the current subprocess.
 *
 * Supported platforms:
 *   - darwin (macOS)
 *   - linux
 *   - win32 (Windows)
 *
 * Detects:
 *   - Android SDK (ANDROID_HOME)
 *   - Java 17/21 (JAVA_HOME) — 24+ is incompatible with Android Gradle Plugin
 *   - adb (via ANDROID_HOME/platform-tools)
 *   - Xcode (macOS only) — via xcode-select
 *   - CocoaPods (macOS only) — Gem vs Homebrew
 *
 * Returns a structured result so callers can log what was auto-detected
 * (helpful for "why is this working?" questions) and surface hints
 * when a required tool is missing.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { delimiter, join, sep } from 'path';
import { homedir, platform as osPlatform } from 'os';

export type TargetPlatform = 'android' | 'ios';
export type OS = 'darwin' | 'linux' | 'win32';

export interface BuildEnvResult {
  /** Final environment object to spread into execSync options. */
  env: NodeJS.ProcessEnv;
  /** Human-readable notes about what was auto-detected, for verbose logging. */
  notes: string[];
  /** Missing required tools with actionable install hints. */
  missing: { tool: string; hint: string }[];
  /** Detected OS. */
  os: OS;
}

const OS: OS = osPlatform() === 'darwin' ? 'darwin' : osPlatform() === 'win32' ? 'win32' : 'linux';
const EXE = OS === 'win32' ? '.exe' : '';
const BAT = OS === 'win32' ? '.bat' : '';

/**
 * Public entry point. Resolves the build environment for the given
 * target platform without touching the user's shell configuration.
 */
export function resolveBuildEnv(
  target: TargetPlatform,
  options: { strict?: boolean } = {},
): BuildEnvResult {
  const notes: string[] = [];
  const missing: { tool: string; hint: string }[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (target === 'android') {
    resolveAndroid(env, notes, missing);
  } else if (target === 'ios') {
    resolveIos(env, notes, missing);
  }

  if (options.strict && missing.length > 0) {
    const lines = missing.map((m) => `  ✖ ${m.tool}\n    ${m.hint}`).join('\n\n');
    throw new Error(`Missing required build tooling:\n\n${lines}\n`);
  }

  return { env, notes, missing, os: OS };
}

// ── Android ──────────────────────────────────────────────────────────────────

function resolveAndroid(
  env: NodeJS.ProcessEnv,
  notes: string[],
  missing: { tool: string; hint: string }[],
): void {
  // 1. Android SDK
  let sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (sdk && !existsSync(sdk)) {
    notes.push(`ANDROID_HOME=${sdk} is set but doesn't exist — ignoring`);
    sdk = undefined;
  }
  if (!sdk) {
    sdk = findAndroidSdk();
    if (sdk) {
      env.ANDROID_HOME = sdk;
      env.ANDROID_SDK_ROOT = sdk; // legacy var some tools still read
      notes.push(`Auto-detected Android SDK at ${sdk}`);
    }
  } else {
    notes.push(`Using ANDROID_HOME=${sdk} from shell`);
  }

  if (!sdk) {
    missing.push({
      tool: 'Android SDK',
      hint: androidSdkInstallHint(),
    });
  } else {
    // Ensure platform-tools (adb) and emulator are on PATH for subprocesses.
    const platformTools = join(sdk, 'platform-tools');
    const emulator = join(sdk, 'emulator');
    prependToPath(env, [platformTools, emulator].filter(existsSync));
  }

  // 2. Java 17/21 (AGP supports both; 24+ breaks CMake configure)
  const javaHome = resolveCompatibleJava(env, notes);
  if (!javaHome) {
    missing.push({
      tool: 'Java 17 (or 21)',
      hint: javaInstallHint(),
    });
  } else {
    env.JAVA_HOME = javaHome;
    prependToPath(env, [join(javaHome, 'bin')]);
  }

  // 3. adb sanity check (if not on PATH after SDK injection, something's off)
  if (sdk && !commandExists('adb', env)) {
    missing.push({
      tool: 'adb',
      hint:
        `adb should be at ${join(sdk, 'platform-tools', 'adb' + EXE)} but isn't executable. ` +
        `Open Android Studio → SDK Manager → install "Android SDK Platform-Tools", or run:\n    sdkmanager "platform-tools"`,
    });
  }
}

function findAndroidSdk(): string | undefined {
  const candidates: string[] = [];
  const home = homedir();

  if (OS === 'darwin') {
    candidates.push(
      join(home, 'Library', 'Android', 'sdk'),
      join(home, 'Library', 'Android', 'Sdk'),
      '/opt/homebrew/share/android-commandlinetools',
      '/usr/local/share/android-commandlinetools',
    );
  } else if (OS === 'linux') {
    candidates.push(
      join(home, 'Android', 'Sdk'),
      join(home, 'android-sdk'),
      '/opt/android-sdk',
      '/usr/local/android-sdk',
      '/usr/lib/android-sdk',
    );
    // Homebrew on Linux
    if (process.env.HOMEBREW_PREFIX) {
      candidates.push(join(process.env.HOMEBREW_PREFIX, 'share', 'android-commandlinetools'));
    }
  } else if (OS === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;
    if (localAppData) candidates.push(join(localAppData, 'Android', 'Sdk'));
    if (appData) candidates.push(join(appData, 'Android', 'Sdk'));
    if (userProfile) {
      candidates.push(
        join(userProfile, 'AppData', 'Local', 'Android', 'Sdk'),
        join(userProfile, 'Android', 'Sdk'),
      );
    }
    candidates.push('C:\\Android\\Sdk', 'C:\\Android\\android-sdk');
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, 'platform-tools'))) {
      return candidate;
    }
  }
  return undefined;
}

function androidSdkInstallHint(): string {
  if (OS === 'darwin') {
    return (
      `Install Android Studio from https://developer.android.com/studio\n` +
      `Or just the command-line tools: brew install --cask android-commandlinetools`
    );
  }
  if (OS === 'linux') {
    return (
      `Install Android Studio from https://developer.android.com/studio\n` +
      `Or command-line tools via your package manager:\n` +
      `  Debian/Ubuntu: sudo apt install android-sdk\n` +
      `  Arch:          sudo pacman -S android-tools`
    );
  }
  return (
    `Install Android Studio from https://developer.android.com/studio\n` +
    `Or via winget: winget install Google.AndroidStudio`
  );
}

// ── Java ─────────────────────────────────────────────────────────────────────

/**
 * Finds a Java 17 or 21 install. Android Gradle Plugin supports both
 * officially. Java 24+ fails CMake configure with native-access
 * restrictions; Java < 17 is too old for modern AGP.
 *
 * Preference order:
 *   1. $JAVA_HOME if it's 17-21
 *   2. OS-specific discovery (java_home -v on macOS, /usr/lib/jvm on
 *      Linux, Program Files on Windows)
 *   3. Nothing — caller adds to `missing`.
 */
function resolveCompatibleJava(
  env: NodeJS.ProcessEnv,
  notes: string[],
): string | undefined {
  // Current JAVA_HOME
  if (env.JAVA_HOME && existsSync(env.JAVA_HOME)) {
    const version = probeJavaVersion(env.JAVA_HOME);
    if (version && version >= 17 && version <= 21) {
      notes.push(`Using JAVA_HOME=${env.JAVA_HOME} (Java ${version})`);
      return env.JAVA_HOME;
    }
    notes.push(
      `JAVA_HOME=${env.JAVA_HOME} is Java ${version ?? '?'} — looking for a 17/21 install`,
    );
  }

  const candidates = findJavaCandidates();
  for (const candidate of candidates) {
    const version = probeJavaVersion(candidate);
    if (version && version >= 17 && version <= 21) {
      notes.push(`Auto-detected Java ${version} at ${candidate}`);
      return candidate;
    }
  }
  return undefined;
}

function findJavaCandidates(): string[] {
  const home = homedir();
  const results: string[] = [];

  if (OS === 'darwin') {
    // Prefer `/usr/libexec/java_home -v X` — returns exact path if version installed.
    for (const v of ['17', '21']) {
      try {
        const out = execSync(`/usr/libexec/java_home -v ${v}`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (out && existsSync(out)) results.push(out);
      } catch {
        // Version not installed — silent skip
      }
    }
    // Fallback scan of VM directories
    for (const root of [
      '/Library/Java/JavaVirtualMachines',
      join(home, 'Library', 'Java', 'JavaVirtualMachines'),
    ]) {
      if (!existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root)) {
          const contentsHome = join(root, entry, 'Contents', 'Home');
          if (existsSync(contentsHome)) results.push(contentsHome);
        }
      } catch { /* ignore */ }
    }
    // Homebrew
    results.push('/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17');
    results.push('/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21');
  } else if (OS === 'linux') {
    const jvmDirs = ['/usr/lib/jvm', '/opt/java', join(home, '.sdkman', 'candidates', 'java')];
    for (const root of jvmDirs) {
      if (!existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root)) {
          const full = join(root, entry);
          if (existsSync(join(full, 'bin', 'java'))) results.push(full);
          // SDKMAN nests one more level
          if (entry !== 'current' && existsSync(join(full, 'bin', 'java'))) {
            results.push(full);
          }
        }
      } catch { /* ignore */ }
    }
  } else if (OS === 'win32') {
    const programFiles = process.env['ProgramFiles'];
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const roots = [programFiles, programFilesX86].filter(Boolean) as string[];
    const vendors = ['Eclipse Adoptium', 'Eclipse Foundation', 'Java', 'OpenJDK', 'Amazon Corretto', 'Microsoft', 'Zulu'];
    for (const root of roots) {
      for (const vendor of vendors) {
        const vendorPath = join(root, vendor);
        if (!existsSync(vendorPath)) continue;
        try {
          for (const entry of readdirSync(vendorPath)) {
            const full = join(vendorPath, entry);
            if (existsSync(join(full, 'bin', 'java.exe'))) results.push(full);
          }
        } catch { /* ignore */ }
      }
    }
  }

  return results;
}

/** Runs `<path>/bin/java -version` and extracts the major version. */
function probeJavaVersion(javaHome: string): number | undefined {
  const javaBin = join(javaHome, 'bin', 'java' + EXE);
  if (!existsSync(javaBin)) return undefined;
  try {
    const out = execSync(`"${javaBin}" -version 2>&1`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = out.match(/version "(\d+)(?:\.\d+)?/);
    if (!match) return undefined;
    return parseInt(match[1], 10);
  } catch {
    return undefined;
  }
}

function javaInstallHint(): string {
  if (OS === 'darwin') {
    return `brew install --cask temurin@17`;
  }
  if (OS === 'linux') {
    return (
      `Debian/Ubuntu: sudo apt install temurin-17-jdk  (add the Adoptium apt repo first)\n` +
      `Fedora/RHEL:   sudo dnf install temurin-17-jdk\n` +
      `Arch:          sudo pacman -S jdk17-openjdk\n` +
      `SDKMAN:        sdk install java 17.0.13-tem`
    );
  }
  return (
    `winget install EclipseAdoptium.Temurin.17.JDK\n` +
    `Or download manually: https://adoptium.net/`
  );
}

// ── iOS ──────────────────────────────────────────────────────────────────────

function resolveIos(
  env: NodeJS.ProcessEnv,
  notes: string[],
  missing: { tool: string; hint: string }[],
): void {
  if (OS !== 'darwin') {
    missing.push({
      tool: 'macOS + Xcode',
      hint:
        'iOS builds require macOS + Xcode. Use a Mac, a cloud Mac service (MacStadium, GitHub Actions macOS runners), or skip iOS builds.',
    });
    return;
  }

  // Xcode via xcode-select
  try {
    const xcodePath = execSync('xcode-select -p', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!xcodePath || !existsSync(xcodePath)) throw new Error('empty');
    notes.push(`Xcode developer dir: ${xcodePath}`);
    // Warn if they're on Command Line Tools only — can't build iOS apps.
    if (xcodePath.includes('CommandLineTools') && !xcodePath.includes('Xcode.app')) {
      missing.push({
        tool: 'Full Xcode (not just Command Line Tools)',
        hint:
          'xcode-select currently points to Command Line Tools. Install Xcode from the App Store, then:\n' +
          '  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      });
    }
  } catch {
    missing.push({
      tool: 'Xcode',
      hint: 'Install Xcode from the Mac App Store, then run: sudo xcode-select --install',
    });
  }

  // CocoaPods — can be installed via gem, brew, or Bundler
  if (!commandExists('pod', env)) {
    missing.push({
      tool: 'CocoaPods',
      hint:
        'Install with one of:\n' +
        '  brew install cocoapods\n' +
        '  sudo gem install cocoapods\n' +
        '  (Bundler) add "gem \'cocoapods\'" to your Gemfile, then bundle install',
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function prependToPath(env: NodeJS.ProcessEnv, dirs: string[]): void {
  const existing = env.PATH || env.Path || '';
  const parts = existing.split(delimiter).filter(Boolean);
  const deduped = dirs.filter((d) => !parts.includes(d));
  if (deduped.length === 0) return;
  const next = [...deduped, ...parts].join(delimiter);
  env.PATH = next;
  if (OS === 'win32') env.Path = next; // Windows uses both casings inconsistently
}

function commandExists(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH || env.Path || '';
  const exts = OS === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * Log auto-detection results to stderr so the user sees what we found.
 * Consumers typically call this right after `resolveBuildEnv`.
 */
export function logBuildEnv(result: BuildEnvResult, chalk: any): void {
  if (result.notes.length === 0 && result.missing.length === 0) return;

  for (const note of result.notes) {
    console.log(chalk.dim(`  · ${note}`));
  }

  if (result.missing.length > 0) {
    console.log('');
    for (const m of result.missing) {
      console.log(chalk.yellow(`  ⚠ Missing: ${m.tool}`));
      for (const line of m.hint.split('\n')) {
        console.log(chalk.dim(`    ${line}`));
      }
    }
    console.log('');
  }
}
