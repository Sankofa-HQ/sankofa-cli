// Non-blocking update notices — CLI version + project engine pin.
//
// Mirrors the flutter/npm pattern: at most one network check per 24h
// (stamp file under ~/.sankofa), the check runs AFTER the user's command
// has produced its output, and every failure path is silent — an update
// hint must never break or slow a build.

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { SANKOFA_STORAGE_BASE_URL } from './engineVersion.js';

const STAMP_DIR = join(homedir(), '.sankofa');
const STAMP_FILE = join(STAMP_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateStamp {
  checkedAt: number;
  latestCli?: string;
  latestEngine?: string;
}

function readStamp(): UpdateStamp | null {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8')) as UpdateStamp;
  } catch {
    return null;
  }
}

function writeStamp(stamp: UpdateStamp): void {
  try {
    mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(STAMP_FILE, JSON.stringify(stamp));
  } catch {
    /* never fail the command over a stamp file */
  }
}

/** Numeric-aware compare of dotted versions ("0.1.10" > "0.1.9"). */
function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const b = current.replace(/^v/, '').split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Engine versions look like "3.44.2+sankofa-1" — compare flutter part then suffix. */
function isNewerEngine(latest: string, current: string): boolean {
  return latest !== current && isNewer(latest.replace('+sankofa-', '.'), current.replace('+sankofa-', '.'));
}

function fetchLatestVersions(): { cli?: string; engine?: string } {
  const out: { cli?: string; engine?: string } = {};
  try {
    const raw = execSync(
      `curl -fsSL --max-time 5 "${SANKOFA_STORAGE_BASE_URL}/engines/sankofa/latest.json?cb=${Date.now()}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const manifest = JSON.parse(raw) as { engine_version?: string; latest_cli?: string };
    out.engine = manifest.engine_version;
    // latest.json may carry the recommended CLI version; fall back to npm.
    out.cli = manifest.latest_cli;
  } catch {
    /* offline / CDN hiccup — silent */
  }
  if (!out.cli) {
    try {
      out.cli = execSync('npm view sankofa-cli version', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      /* npm offline — silent */
    }
  }
  return out;
}

/**
 * Print update notices for the CLI and (when inside a pinned Flutter
 * project) the engine. Throttled to one network round-trip per 24h;
 * between checks the cached result still produces the hint so users
 * keep seeing it until they upgrade.
 */
export function maybePrintUpdateNotices(currentCliVersion: string, projectRoot?: string): void {
  try {
    let stamp = readStamp();
    if (!stamp || Date.now() - stamp.checkedAt > CHECK_INTERVAL_MS) {
      const latest = fetchLatestVersions();
      stamp = { checkedAt: Date.now(), latestCli: latest.cli, latestEngine: latest.engine };
      writeStamp(stamp);
    }

    const notices: string[] = [];
    if (stamp.latestCli && isNewer(stamp.latestCli, currentCliVersion)) {
      notices.push(
        `sankofa-cli ${stamp.latestCli} is available (you have ${currentCliVersion}) — npm i -g sankofa-cli`,
      );
    }

    if (projectRoot && stamp.latestEngine) {
      const pinned = readProjectEnginePin(projectRoot);
      if (pinned && isNewerEngine(stamp.latestEngine, pinned)) {
        notices.push(
          `engine ${stamp.latestEngine} is available (project pinned to ${pinned}) — sankofa engine upgrade`,
        );
      }
    }

    if (notices.length) {
      const yellow = (s: string) => `[33m${s}[0m`;
      console.error('');
      for (const n of notices) console.error(yellow(`  ▲ ${n}`));
    }
  } catch {
    /* a hint must never break the command */
  }
}

function readProjectEnginePin(projectRoot: string): string | null {
  try {
    const yamlPath = join(projectRoot, 'sankofa.yaml');
    if (!existsSync(yamlPath)) return null;
    const m = readFileSync(yamlPath, 'utf8').match(/^engine_version:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
