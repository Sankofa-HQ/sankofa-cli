import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cdnEngineDownloadURL,
  engineDownloadCandidates,
  engineSourceRev,
  type KnownEngine,
} from '../src/utils/engineRegistry.js';

// The rev the 3.44.1+sankofa-2 artifacts were actually published under.
const REV = '0b7370de61a8bfd15f92b21a0d66fdc8eb9bb4ff';
const MIRROR = 'https://download.sankofa.dev/flutter_infra_release/flutter';

/**
 * A registry row shaped like the ones production actually served.
 *
 * Defaults reproduce the Android outage: `source_commit` truncated to 12
 * chars, and a signed `download_url` whose object key is missing the
 * `flutter_infra_release/` segment the artifacts live under.
 */
function row(over: Partial<KnownEngine> = {}): KnownEngine {
  return {
    flutter_version: '3.44.1',
    target: 'android',
    abi: 'arm64-v8a',
    runtime_mode: 'release',
    sankofa_engine_version: '3.44.1+sankofa-2',
    is_modified: true,
    sha256: 'c034434ad9353b5d2e3f86ef692b754c1361ad20b17c295b2b883059ebfbe072',
    size_bytes: 13979864,
    source_commit: '0b7370de61a8',
    built_at: '2026-07-12T14:11:48Z',
    download_url:
      `https://s3.eu-central-003.backblazeb2.com/sankofa-data-vault/flutter/${REV}` +
      `/android-arm64-release/libflutter.so?X-Amz-Signature=deadbeef`,
    ...over,
  };
}

describe('engineSourceRev', () => {
  it('uses source_commit when it is a full rev', () => {
    assert.equal(engineSourceRev(row({ source_commit: REV })), REV);
  });

  it('recovers the full rev when source_commit is truncated', () => {
    // The regression. A 12-char rev used to make cdnEngineDownloadURL bail
    // to null, leaving only the mis-keyed signed URL.
    assert.equal(engineSourceRev(row()), REV);
  });

  it('recovers the rev from a canonical (prefixed) object key too', () => {
    assert.equal(
      engineSourceRev(row({ download_url: `${MIRROR}/${REV}/ios-release/Flutter.framework/Flutter` })),
      REV,
    );
  });

  it('recovers the rev when source_commit is absent entirely', () => {
    assert.equal(engineSourceRev(row({ source_commit: '' })), REV);
  });

  it('lowercases a recovered rev so URLs are stable', () => {
    const upper = REV.toUpperCase();
    assert.equal(
      engineSourceRev(row({ source_commit: '', download_url: `${MIRROR}/${upper}/x/y` })),
      REV,
    );
  });

  it('returns null when no full rev exists anywhere', () => {
    assert.equal(engineSourceRev(row({ source_commit: 'abc', download_url: '/engines/3.41.9/x' })), null);
  });
});

describe('cdnEngineDownloadURL', () => {
  it('builds a working Android URL from a row with a truncated rev', () => {
    // End-to-end shape of the fix: the broken row still yields the key the
    // artifacts are really published under.
    assert.equal(
      cdnEngineDownloadURL(row()),
      `${MIRROR}/${REV}/android-arm64-release/libflutter.so`,
    );
  });

  it('maps every Android ABI to its published directory slug', () => {
    const cases: [string, string][] = [
      ['arm64-v8a', 'android-arm64-release'],
      ['armeabi-v7a', 'android-arm-release'],
      ['x86_64', 'android-x64-release'],
    ];
    for (const [abi, dir] of cases) {
      assert.equal(cdnEngineDownloadURL(row({ abi })), `${MIRROR}/${REV}/${dir}/libflutter.so`);
    }
  });

  it('maps every iOS ABI to its published directory', () => {
    const cases: [string, string, string][] = [
      ['device-arm64', 'release', 'ios-release'],
      ['sim-arm64', 'debug', 'ios-debug-sim-arm64'],
      ['sim-x64', 'debug', 'ios-debug-sim-x64'],
    ];
    for (const [abi, mode, dir] of cases) {
      assert.equal(
        cdnEngineDownloadURL(row({ target: 'ios', abi, runtime_mode: mode })),
        `${MIRROR}/${REV}/${dir}/Flutter.framework/Flutter`,
      );
    }
  });

  it('always includes the flutter_infra_release prefix', () => {
    // Omitting this segment is precisely what made the signed URLs 404.
    assert.match(cdnEngineDownloadURL(row())!, /\/flutter_infra_release\/flutter\//);
  });

  it('returns null for an unrecognised target', () => {
    assert.equal(cdnEngineDownloadURL(row({ target: 'fuchsia' })), null);
  });

  it('returns null when no rev can be resolved', () => {
    assert.equal(cdnEngineDownloadURL(row({ source_commit: '', download_url: '' })), null);
  });
});

describe('engineDownloadCandidates', () => {
  it('offers the CDN first, then the registry URL', () => {
    const urls = engineDownloadCandidates(row());
    assert.equal(urls.length, 2);
    assert.equal(urls[0], `${MIRROR}/${REV}/android-arm64-release/libflutter.so`);
    assert.match(urls[1]!, /backblazeb2\.com/);
  });

  it('never returns the same URL twice', () => {
    const canonical = `${MIRROR}/${REV}/android-arm64-release/libflutter.so`;
    assert.deepEqual(engineDownloadCandidates(row({ download_url: canonical })), [canonical]);
  });

  it('still offers the CDN when the registry URL cannot be resolved', () => {
    // Relative download_url + no auth config: serverEngineDownloadURL may
    // throw, and that must not strand a perfectly good CDN candidate.
    const urls = engineDownloadCandidates(row({ download_url: '', source_commit: REV }));
    assert.ok(urls.length >= 1);
    assert.equal(urls[0], `${MIRROR}/${REV}/android-arm64-release/libflutter.so`);
  });
});
