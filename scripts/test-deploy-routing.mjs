// Synthetic test for `sankofa deploy` version-aware routing.
// Doesn't actually build — just exercises the routing decision tree
// by setting up baseline + pubspec states and checking which branch
// the router would pick.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { captureFlutterBaseline, readBaselineManifest, hasBaseline } from '/Users/saytoonz/Developer/Projects/Sankofa/cli/sankofa-cli/dist/utils/baseline.js';
import { detectFlutterAppVersion } from '/Users/saytoonz/Developer/Projects/Sankofa/cli/sankofa-cli/dist/utils/flutterBundler.js';

const ROOT = '/tmp/sankofa-deploy-routing-test';
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

function header(s) {
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + s);
  console.log('═'.repeat(70));
}

function compareVersions(a, b) {
  const tokenize = (v) => v.split(/[.\-+]/).map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? s : n;
  });
  const ta = tokenize(a);
  const tb = tokenize(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i] ?? 0;
    const y = tb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function setupProject(name, opts) {
  const root = join(ROOT, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'pubspec.yaml'),
    `name: ${name}\nversion: ${opts.pubspecVersion}\n`);
  if (opts.baselineVersion) {
    const apkContents = join(root, 'apk');
    mkdirSync(join(apkContents, 'assets', 'flutter_assets'), { recursive: true });
    writeFileSync(join(apkContents, 'AndroidManifest.xml'), '<manifest/>');
    captureFlutterBaseline({
      projectRoot: root,
      androidManifestPath: join(apkContents, 'AndroidManifest.xml'),
      flutterAssetsDir: join(apkContents, 'assets', 'flutter_assets'),
      manifest: {
        version: 1,
        stack: 'flutter',
        releaseLabel: `v${opts.baselineVersion}`,
        targetBinaryVersion: opts.baselineVersion,
        engineVersion: '3.41.9+sankofa-1',
        payloadSha256: 'fake',
        capturedAt: new Date().toISOString(),
      },
    });
  }
  return root;
}

function routeDecision(projectRoot) {
  const currentVersion = detectFlutterAppVersion(projectRoot);
  const baselineManifest = hasBaseline(projectRoot) ? readBaselineManifest(projectRoot) : null;
  const baselineVersion = baselineManifest?.targetBinaryVersion;

  if (!baselineVersion) {
    return { decision: 'release', reason: 'no baseline on disk (first-time release)' };
  }
  const cmp = compareVersions(currentVersion, baselineVersion);
  if (cmp === 0) {
    return { decision: 'patch', reason: `pubspec ${currentVersion} matches baseline (hot-patch)` };
  }
  if (cmp > 0) {
    return { decision: 'release', reason: `pubspec bumped ${baselineVersion} → ${currentVersion} (new baseline)` };
  }
  return { decision: 'ERROR', reason: `pubspec ${currentVersion} is OLDER than baseline ${baselineVersion}` };
}

// ── Scenarios ─────────────────────────────────────────────────────────────

const scenarios = [
  { name: 'no-baseline',      pubspecVersion: '1.0.0', baselineVersion: null,   expect: 'release' },
  { name: 'same-version',     pubspecVersion: '1.0.0', baselineVersion: '1.0.0', expect: 'patch' },
  { name: 'patch-bump',       pubspecVersion: '1.0.1', baselineVersion: '1.0.0', expect: 'release' },
  { name: 'minor-bump',       pubspecVersion: '1.1.0', baselineVersion: '1.0.0', expect: 'release' },
  { name: 'major-bump',       pubspecVersion: '2.0.0', baselineVersion: '1.0.0', expect: 'release' },
  { name: 'older-pubspec',    pubspecVersion: '0.9.0', baselineVersion: '1.0.0', expect: 'ERROR' },
  // Build-only bump: pubspec moves 1.0.0+1 → 1.0.0+2 but baseline stores
  // only the part before '+' (release.ts strips via detectFlutterAppVersion),
  // so both sides compare as "1.0.0" → patch.
  { name: 'build-only-bump',  pubspecVersion: '1.0.0+2', baselineVersion: '1.0.0', expect: 'patch' },
];

let pass = 0, fail = 0;
for (const s of scenarios) {
  const root = setupProject(s.name, s);
  const result = routeDecision(root);
  const ok = result.decision === s.expect;
  if (ok) pass++; else fail++;
  console.log(
    `  ${ok ? '✓' : '✖'} ${s.name.padEnd(20)} pubspec=${s.pubspecVersion.padEnd(8)} baseline=${(s.baselineVersion || '—').padEnd(8)} → ${result.decision.padEnd(8)} (expected ${s.expect})`,
  );
  if (!ok) console.log(`        reason: ${result.reason}`);
}

console.log('\n' + (fail === 0 ? '  ✓ All routing scenarios pass' : `  ✖ ${fail}/${scenarios.length} scenarios failed`));
