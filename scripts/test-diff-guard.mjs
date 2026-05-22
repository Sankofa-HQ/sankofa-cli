// Synthetic Diff Guard test. Exercises the same code path that
// `sankofa patch` invokes, but with fixtures we control so we can
// demonstrate every refusal kind without needing a real `flutter build`.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { runFlutterDiffGuard } from '/Users/saytoonz/Developer/Projects/Sankofa/cli/sankofa-cli/dist/utils/diffGuard.js';
import { captureFlutterBaseline } from '/Users/saytoonz/Developer/Projects/Sankofa/cli/sankofa-cli/dist/utils/baseline.js';

const ROOT = '/tmp/sankofa-diff-guard-test';
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function header(s) {
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + s);
  console.log('═'.repeat(70));
}

function render(outcome) {
  if (outcome.refusals.length === 0 && outcome.warnings.length === 0) {
    console.log('  ✓ Diff Guard: PASS (no findings)');
    return;
  }
  for (const f of outcome.refusals) {
    console.log(`  ✖ REFUSE — ${f.label}`);
    for (const line of f.detail.split('\n')) console.log('        ' + line);
    console.log('     → ' + f.remedy);
  }
  for (const f of outcome.warnings) {
    console.log(`  ! WARN — ${f.label}`);
    for (const line of f.detail.split('\n')) console.log('        ' + line);
    console.log('     → ' + f.remedy);
  }
}

function makeBaseline(projectRoot, opts) {
  const apkContentsDir = join(projectRoot, 'apk-baseline');
  mkdirSync(join(apkContentsDir, 'assets', 'flutter_assets'), { recursive: true });
  writeFileSync(join(apkContentsDir, 'AndroidManifest.xml'), opts.manifest);
  for (const [name, content] of Object.entries(opts.assets || {})) {
    const full = join(apkContentsDir, 'assets', 'flutter_assets', name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  // Optional: pubspec.lock for the plugin-diff warning
  if (opts.pubspecLock) {
    writeFileSync(join(projectRoot, 'pubspec.lock'), opts.pubspecLock);
  }
  captureFlutterBaseline({
    projectRoot,
    androidManifestPath: join(apkContentsDir, 'AndroidManifest.xml'),
    flutterAssetsDir: join(apkContentsDir, 'assets', 'flutter_assets'),
    manifest: {
      version: 1,
      stack: 'flutter',
      releaseLabel: 'v1.0.0',
      targetBinaryVersion: '1.0.0',
      engineVersion: '3.41.9+sankofa-1',
      payloadSha256: 'baseline-fake-sha',
      capturedAt: new Date().toISOString(),
    },
  });
}

function makeCurrent(projectRoot, opts) {
  const apkContentsDir = join(projectRoot, 'apk-current');
  rmSync(apkContentsDir, { recursive: true, force: true });
  mkdirSync(join(apkContentsDir, 'assets', 'flutter_assets'), { recursive: true });
  writeFileSync(join(apkContentsDir, 'AndroidManifest.xml'), opts.manifest);
  for (const [name, content] of Object.entries(opts.assets || {})) {
    const full = join(apkContentsDir, 'assets', 'flutter_assets', name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  if (opts.pubspecLock !== undefined) {
    writeFileSync(join(projectRoot, 'pubspec.lock'), opts.pubspecLock);
  }
  return apkContentsDir;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MANIFEST_BASE = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:name="com.sankofa.deploy.SankofaDeployApplication">
        <activity android:name=".MainActivity"></activity>
    </application>
</manifest>
`;

const ASSETS_BASE = {
  'manifest.json': '{"version":"1.0.0"}',
  'fonts/Roboto-Regular.ttf': 'font-bytes-here',
  'images/logo.png': 'png-bytes-here',
};

const PUBSPEC_LOCK_BASE = `
packages:
  flutter:
    version: "0.0.0"
  http:
    version: "1.0.0"
`;

// ── Scenario 1: pristine build (no changes) ──────────────────────────────────

header('Scenario 1: pristine build — no changes since baseline');
const r1 = join(ROOT, 's1');
mkdirSync(r1, { recursive: true });
makeBaseline(r1, { manifest: MANIFEST_BASE, assets: ASSETS_BASE, pubspecLock: PUBSPEC_LOCK_BASE });
const apk1 = makeCurrent(r1, { manifest: MANIFEST_BASE, assets: ASSETS_BASE, pubspecLock: PUBSPEC_LOCK_BASE });
render(runFlutterDiffGuard({ projectRoot: r1, apkContentsDir: apk1 }));

// ── Scenario 2: AndroidManifest.xml changed (added permission) ───────────────

header('Scenario 2: dev added a new permission to AndroidManifest.xml');
const r2 = join(ROOT, 's2');
mkdirSync(r2, { recursive: true });
makeBaseline(r2, { manifest: MANIFEST_BASE, assets: ASSETS_BASE });
const apk2 = makeCurrent(r2, {
  manifest: MANIFEST_BASE.replace(
    '<application',
    '<uses-permission android:name="android.permission.CAMERA" />\n    <application',
  ),
  assets: ASSETS_BASE,
});
render(runFlutterDiffGuard({ projectRoot: r2, apkContentsDir: apk2 }));

// ── Scenario 3: new asset added ──────────────────────────────────────────────

header('Scenario 3: dev added a new image to flutter_assets/');
const r3 = join(ROOT, 's3');
mkdirSync(r3, { recursive: true });
makeBaseline(r3, { manifest: MANIFEST_BASE, assets: ASSETS_BASE });
const apk3 = makeCurrent(r3, {
  manifest: MANIFEST_BASE,
  assets: { ...ASSETS_BASE, 'images/hero.png': 'new-image-bytes' },
});
render(runFlutterDiffGuard({ projectRoot: r3, apkContentsDir: apk3 }));

// ── Scenario 4: existing asset changed ───────────────────────────────────────

header('Scenario 4: dev changed an existing asset (logo.png)');
const r4 = join(ROOT, 's4');
mkdirSync(r4, { recursive: true });
makeBaseline(r4, { manifest: MANIFEST_BASE, assets: ASSETS_BASE });
const apk4 = makeCurrent(r4, {
  manifest: MANIFEST_BASE,
  assets: { ...ASSETS_BASE, 'images/logo.png': 'logo-v2-bytes' },
});
render(runFlutterDiffGuard({ projectRoot: r4, apkContentsDir: apk4 }));

// ── Scenario 5: asset removed ────────────────────────────────────────────────

header('Scenario 5: dev removed an asset (logo.png)');
const r5 = join(ROOT, 's5');
mkdirSync(r5, { recursive: true });
makeBaseline(r5, { manifest: MANIFEST_BASE, assets: ASSETS_BASE });
const apk5BaseAssets = { ...ASSETS_BASE };
delete apk5BaseAssets['images/logo.png'];
const apk5 = makeCurrent(r5, { manifest: MANIFEST_BASE, assets: apk5BaseAssets });
render(runFlutterDiffGuard({ projectRoot: r5, apkContentsDir: apk5 }));

// ── Scenario 6: pubspec.lock changed (soft warning) ──────────────────────────

header('Scenario 6: dev added a new plugin (pubspec.lock differs)');
const r6 = join(ROOT, 's6');
mkdirSync(r6, { recursive: true });
makeBaseline(r6, { manifest: MANIFEST_BASE, assets: ASSETS_BASE, pubspecLock: PUBSPEC_LOCK_BASE });
const apk6 = makeCurrent(r6, {
  manifest: MANIFEST_BASE,
  assets: ASSETS_BASE,
  pubspecLock: PUBSPEC_LOCK_BASE + '  camera:\n    version: "0.10.0"\n',
});
render(runFlutterDiffGuard({ projectRoot: r6, apkContentsDir: apk6 }));

// ── Scenario 7: combined manifest + asset + pubspec.lock change ──────────────

header('Scenario 7: kitchen sink — manifest, assets, pubspec.lock all changed');
const r7 = join(ROOT, 's7');
mkdirSync(r7, { recursive: true });
makeBaseline(r7, { manifest: MANIFEST_BASE, assets: ASSETS_BASE, pubspecLock: PUBSPEC_LOCK_BASE });
const apk7 = makeCurrent(r7, {
  manifest: MANIFEST_BASE.replace(
    '<application',
    '<uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <application',
  ),
  assets: { ...ASSETS_BASE, 'audio/intro.mp3': 'audio-bytes' },
  pubspecLock: PUBSPEC_LOCK_BASE + '  audio_recorder:\n    version: "0.5.0"\n',
});
render(runFlutterDiffGuard({ projectRoot: r7, apkContentsDir: apk7 }));

// ── Scenario 8: no baseline on disk ──────────────────────────────────────────

header('Scenario 8: no .sankofa/baseline/ directory at all');
const r8 = join(ROOT, 's8');
mkdirSync(r8, { recursive: true });
const apk8 = makeCurrent(r8, { manifest: MANIFEST_BASE, assets: ASSETS_BASE });
render(runFlutterDiffGuard({ projectRoot: r8, apkContentsDir: apk8 }));

console.log('\n' + '═'.repeat(70));
console.log('  Diff Guard test complete.');
console.log('═'.repeat(70) + '\n');
