import fs from 'node:fs';
import path from 'node:path';
import { resolveAuth } from './config.js';

/**
 * Small reusable Catch symbol-upload helper shared by
 * `sankofa catch symbols upload` and `sankofa release --upload-*`.
 *
 * Kept deliberately dependency-light — uses global fetch + FormData so
 * `sankofa release` doesn't pull extra weight for a feature most
 * teams will only exercise a few times per release cycle.
 */

export type SymbolKind =
  | 'js_sourcemap'
  | 'ios_dsym'
  | 'android_mapping'
  | 'android_ndk'
  | 'flutter_symbols';

export interface UploadedArtifact {
  id: string;
  kind: SymbolKind;
  original_name: string;
  size_bytes: number;
  release?: string;
  match_key: string;
  status: string;
}

const KIND_CONTENT_TYPE: Record<SymbolKind, string> = {
  js_sourcemap: 'application/json',
  ios_dsym: 'application/zip',
  android_mapping: 'text/plain',
  android_ndk: 'application/zip',
  flutter_symbols: 'application/zip',
};

export function inferKind(filePath: string): SymbolKind | null {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.map')) return 'js_sourcemap';
  if (base.endsWith('.dsym.zip') || base.endsWith('.dsym')) return 'ios_dsym';
  if (base === 'mapping.txt' || base.endsWith('.mapping.txt')) return 'android_mapping';
  if (base.endsWith('.so') || base.endsWith('.so.debug')) return 'android_ndk';
  if (base.endsWith('.symbols') || base.endsWith('.symbols.zip')) return 'flutter_symbols';
  return null;
}

/**
 * Upload a single symbol artifact. Returns the server's response
 * (artifact + fingerprint).
 *
 * Throws on HTTP error with the server message when available.
 */
export async function uploadCatchSymbol(params: {
  filePath: string;
  kind?: SymbolKind;
  environment?: 'live' | 'test';
  release?: string;
  matchKey?: string;
  commitSha?: string;
  /**
   * When true, gracefully no-op if the file doesn't exist. Useful for
   * `sankofa release --upload-sourcemaps` where a project might not
   * emit every artifact kind.
   */
  allowMissing?: boolean;
}): Promise<UploadedArtifact | null> {
  const abs = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(process.cwd(), params.filePath);
  if (!fs.existsSync(abs)) {
    if (params.allowMissing) return null;
    throw new Error(`file not found: ${abs}`);
  }
  const kind = params.kind ?? inferKind(abs);
  if (!kind) {
    throw new Error(
      `could not infer kind for ${path.basename(abs)} — pass explicit kind`,
    );
  }
  const stat = fs.statSync(abs);
  if (stat.size > 100 * 1024 * 1024) {
    throw new Error(`file too large (${stat.size} bytes; max 100 MB per upload)`);
  }

  const auth = resolveAuth();
  const buf = fs.readFileSync(abs);
  const fd = new FormData();
  fd.set('kind', kind);
  fd.set('environment', params.environment ?? auth.environment ?? 'live');
  if (params.release) fd.set('release', params.release);
  if (params.matchKey) fd.set('match_key', params.matchKey);
  if (params.commitSha) fd.set('commit_sha', params.commitSha);
  fd.set(
    'file',
    new Blob([new Uint8Array(buf)], { type: KIND_CONTENT_TYPE[kind] }),
    path.basename(abs),
  );

  // Symbol upload accepts either the dashboard JWT or a deploy token
  // — the server maps both to the right project on x-project-id.
  const url = `${auth.endpoint.replace(/\/$/, '')}/api/v1/catch/symbols`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'x-project-id': auth.projectId,
    },
    body: fd,
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(
      (body && (body.error || body.message)) || `HTTP ${res.status}`,
    );
  }
  return body?.artifact as UploadedArtifact;
}

/**
 * Walk a directory and upload every matching symbol file. Useful for
 * `--upload-dsym ./dSYMs/` where the directory may contain several
 * per-framework dSYM bundles.
 */
export async function uploadSymbolsDirectory(params: {
  dir: string;
  kind: SymbolKind;
  environment?: 'live' | 'test';
  release?: string;
  filePattern: RegExp;
  commitSha?: string;
}): Promise<{ uploaded: UploadedArtifact[]; skipped: string[] }> {
  const abs = path.isAbsolute(params.dir)
    ? params.dir
    : path.resolve(process.cwd(), params.dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`);
  }
  const uploaded: UploadedArtifact[] = [];
  const skipped: string[] = [];

  // Shallow walk — deep-nested symbols bundles are rare and the extra
  // recursion adds error surface without value for V1.
  for (const name of fs.readdirSync(abs)) {
    const full = path.join(abs, name);
    if (!fs.statSync(full).isFile()) {
      skipped.push(name);
      continue;
    }
    if (!params.filePattern.test(name)) {
      skipped.push(name);
      continue;
    }
    const art = await uploadCatchSymbol({
      filePath: full,
      kind: params.kind,
      environment: params.environment,
      release: params.release,
      commitSha: params.commitSha,
    });
    if (art) uploaded.push(art);
  }
  return { uploaded, skipped };
}