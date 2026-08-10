import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadEngineIntoCache, tryEngineCacheHit } from '../src/utils/engineCache.js';
import type { KnownEngine } from '../src/utils/engineRegistry.js';

const REV = '0b7370de61a8bfd15f92b21a0d66fdc8eb9bb4ff';
const CDN = `https://download.sankofa.dev/flutter_infra_release/flutter/${REV}/android-arm64-release/libflutter.so`;
const SIGNED = `https://s3.eu-central-003.backblazeb2.com/sankofa-data-vault/flutter/${REV}/android-arm64-release/libflutter.so?X-Amz-Signature=deadbeef`;

const PAYLOAD = Buffer.from('pretend this is a libflutter.so');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

function row(over: Partial<KnownEngine> = {}): KnownEngine {
  return {
    flutter_version: '3.44.1',
    target: 'android',
    abi: 'arm64-v8a',
    runtime_mode: 'release',
    sankofa_engine_version: '3.44.1+sankofa-2',
    is_modified: true,
    sha256: PAYLOAD_SHA,
    size_bytes: PAYLOAD.length,
    source_commit: '0b7370de61a8', // truncated, as production served it
    built_at: '2026-07-12T14:11:48Z',
    download_url: SIGNED,
    ...over,
  };
}

let home: string;
let realFetch: typeof globalThis.fetch;
let requested: string[];

/** Stub fetch with a per-URL responder, recording every URL tried. */
function stubFetch(responder: (url: string) => Response) {
  requested = [];
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    requested.push(url);
    return responder(url);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sankofa-engine-cache-'));
  process.env.SANKOFA_HOME = home;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SANKOFA_HOME;
  rmSync(home, { recursive: true, force: true });
});

const cachedPath = () => join(home, 'engines', '3.44.1', 'android-arm64-release', 'libflutter.so');

describe('downloadEngineIntoCache', () => {
  it('falls back to the next source when the first URL fails', async () => {
    // The production failure exactly: the CDN key is fine but suppose it
    // 403s — the download must still complete via the other candidate
    // rather than reporting the engine as unavailable.
    stubFetch((url) =>
      url === CDN ? new Response('denied', { status: 403 }) : new Response(PAYLOAD),
    );

    const entry = await downloadEngineIntoCache(row());

    assert.equal(entry.valid, true);
    assert.deepEqual(requested, [CDN, SIGNED], 'should try the CDN first, then the signed URL');
    assert.deepEqual(readFileSync(cachedPath()), PAYLOAD);
  });

  it('reaches the artifacts even when the registry URL is the broken one', async () => {
    // The real-world orientation: the signed URL 404s because its object
    // key lost the flutter_infra_release/ prefix, and the CDN saves it.
    stubFetch((url) =>
      url === CDN ? new Response(PAYLOAD) : new Response('no such key', { status: 404 }),
    );

    const entry = await downloadEngineIntoCache(row());

    assert.equal(entry.valid, true);
    assert.deepEqual(requested, [CDN], 'a working first candidate should short-circuit');
  });

  it('tries every candidate before failing, and names each one', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));

    await assert.rejects(
      () => downloadEngineIntoCache(row()),
      (err: Error) => {
        assert.match(err.message, /all 2 source\(s\) failed/);
        assert.match(err.message, /HTTP 404/);
        assert.ok(err.message.includes(CDN), 'error should name the CDN URL');
        assert.ok(err.message.includes(SIGNED), 'error should name the signed URL');
        return true;
      },
    );
    assert.deepEqual(requested, [CDN, SIGNED]);
    assert.equal(existsSync(cachedPath()), false, 'nothing should be written on total failure');
  });

  it('refuses to cache bytes that do not match the registry SHA', async () => {
    stubFetch(() => new Response(Buffer.from('tampered')));

    await assert.rejects(() => downloadEngineIntoCache(row()), /SHA mismatch/);
    assert.equal(existsSync(cachedPath()), false);
    assert.equal(existsSync(`${cachedPath()}.partial`), false, 'partial file must be cleaned up');
  });

  it('writes provenance a later run can verify against', async () => {
    stubFetch(() => new Response(PAYLOAD));
    await downloadEngineIntoCache(row());

    const meta = JSON.parse(
      readFileSync(join(home, 'engines', '3.44.1', 'android-arm64-release', '.meta.json'), 'utf8'),
    );
    assert.equal(meta.sha256, PAYLOAD_SHA);
    assert.equal(meta.sankofa_engine_version, '3.44.1+sankofa-2');
  });
});

describe('tryEngineCacheHit', () => {
  it('misses on an empty cache', () => {
    assert.equal(tryEngineCacheHit(row()), null);
  });

  it('hits after a successful download', async () => {
    stubFetch(() => new Response(PAYLOAD));
    await downloadEngineIntoCache(row());

    const hit = tryEngineCacheHit(row());
    assert.ok(hit, 'expected a cache hit');
    assert.equal(hit.path, cachedPath());
  });

  it('misses when the cached bytes no longer match the registry SHA', async () => {
    stubFetch(() => new Response(PAYLOAD));
    await downloadEngineIntoCache(row());

    // Same cached file, but the registry now expects a different SHA —
    // a rebuilt engine. The stale bytes must not be served as a hit.
    assert.equal(tryEngineCacheHit(row({ sha256: 'ab'.repeat(32) })), null);
  });
});
