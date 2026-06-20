/**
 * Sankofa Deploy — Flutter patch package format.
 *
 * Wraps a compiled patch payload in a self-describing, length-prefixed,
 * signature-capable container that can be safely transported, persisted
 * on-device, and validated by the on-device SDK before it is applied.
 *
 * Why a wrapper at all:
 *  - **Integrity**: payload SHA-256 + optional signature so a tampered
 *    or partial download is detected before the payload is touched.
 *  - **Metadata**: release id, project id, target binary version,
 *    rollout %, label, created-at — read by the SDK without parsing
 *    the payload body.
 *  - **Versioning**: the package format itself may evolve; the version
 *    is pinned in the header for compatibility checks.
 *  - **Provenance**: optional signature trailer so the SDK can refuse
 *    patches not signed by the project's release key.
 *
 * Format "SKDP" v1 (little-endian throughout):
 *
 *   offset  size  field
 *   ------  ----  -----
 *   0       4     magic         "SKDP" (0x534B4450)
 *   4       2     pkg_version   u16 = 1
 *   6       2     flags         u16 (reserved)
 *   8       4     payload_len   u32 — bytes of payload
 *   12      4     meta_length   u32 — bytes of metadata JSON
 *   16      4     reserved      u32 = 0
 *   20      32    payload_sha   sha-256 of payload (32 bytes)
 *   52      M     metadata      utf-8 JSON (meta_length bytes)
 *   52+M    N     payload       payload bytes (payload_len bytes)
 *
 *   Signature trailer (always present, alg=0 means unsigned in v1):
 *   X       1     sig_alg       u8 (0 = unsigned, 1 = signed)
 *   X+1     1     reserved      u8 = 0
 *   X+2     2     sig_length    u16 (0 if alg=0, 64 if alg=1)
 *   X+4     S     sig_bytes     signature over [0 .. X) — empty if alg=0
 *
 * Total file size = 52 + M + N + 4 + S.
 *
 * Header is fixed-size (52 bytes) so parsers can read it in one syscall
 * to learn everything they need to plan the rest of the read. The
 * signature is at the END so signing can do a single-pass hash without
 * the trailer present. The trailer is ALWAYS present (even unsigned) so
 * the parser shape stays constant when signing is required later.
 *
 * The on-device parser must stay byte-compatible with this producer.
 */

import { createHash } from 'crypto';

export const PACKAGE_MAGIC = Buffer.from([0x53, 0x4b, 0x44, 0x50]); // "SKDP"
export const PACKAGE_VERSION = 1;
export const HEADER_SIZE = 52;
export const TRAILER_FIXED_SIZE = 4; // sig_alg + reserved + sig_length

export type SigAlg = 0 | 1; // 0 = unsigned, 1 = signed

export type PatchMetadata = {
  /** Sankofa server release id this patch belongs to. */
  releaseId?: string;
  /** Project id (matches the Sankofa Deploy project). */
  projectId?: string;
  /** Engine build commit this patch was built against (must match host). */
  engineCommit?: string;
  /** Dart SDK version (e.g. "3.11.5"). */
  dartVersion?: string;
  /** Target app binary version (semver string). */
  targetBinaryVersion?: string;
  /** Rollout percentage [0, 100]. */
  rollout?: number;
  /** Mandatory force-update flag. */
  mandatory?: boolean;
  /** Free-form label set by the producer. */
  label?: string;
  /** Free-form description. */
  description?: string;
  /** Producer-set creation timestamp (ISO-8601). */
  createdAt?: string;
  /** Free-form key/value extension space (preserves unknown keys). */
  [extra: string]: unknown;
};

export type PackOptions = {
  /** The raw patch payload bytes. */
  payload: Uint8Array;
  /** Metadata that travels with the patch. */
  metadata: PatchMetadata;
  /**
   * Signature algorithm. 0 = unsigned, 1 = signed. When 1, `signer`
   * is required — it gets called with the bytes [0..trailer_offset)
   * and must return a 64-byte signature.
   */
  sigAlg?: SigAlg;
  /**
   * Signing callback. Called with all package bytes BEFORE the trailer
   * (header + metadata + payload). Must return a 64-byte signature.
   * Only consulted when `sigAlg === 1`.
   */
  signer?: (bytesToSign: Buffer) => Buffer;
};

export type ParsedPatchPackage = {
  packageVersion: number;
  flags: number;
  payloadLength: number;
  metaLength: number;
  payloadSha: Buffer;
  metadata: PatchMetadata;
  payload: Buffer;
  sigAlg: SigAlg;
  sigBytes: Buffer;
  /** True iff payloadSha matches a fresh sha-256 of payload. */
  payloadShaValid: boolean;
  /** Total bytes consumed (= file size). */
  totalSize: number;
};

/**
 * Pack a raw payload into an "SKDP" v1 package.
 *
 * Returns the full package bytes ready to write to disk / upload.
 *
 * The signature trailer is always present so the format stays
 * parser-compatible whether or not the package is signed.
 */
export function packPatch(opts: PackOptions): Buffer {
  const sigAlg: SigAlg = opts.sigAlg ?? 0;
  if (sigAlg !== 0 && sigAlg !== 1) {
    throw new Error(
      `Package sig_alg must be 0 (unsigned) or 1 (signed). Got: ${sigAlg}.`,
    );
  }
  if (sigAlg === 1 && !opts.signer) {
    throw new Error('Signed patch packaging requires a signer (key).');
  }

  const payload = Buffer.from(opts.payload);
  const metadataJson = Buffer.from(
    JSON.stringify(opts.metadata, null, 0),
    'utf-8',
  );

  const payloadSha = createHash('sha256').update(payload).digest();

  const bodySize = HEADER_SIZE + metadataJson.length + payload.length;
  const sigLength = sigAlg === 1 ? 64 : 0; // signatures are always 64 bytes
  const trailerSize = TRAILER_FIXED_SIZE + sigLength;
  const totalSize = bodySize + trailerSize;

  const buf = Buffer.alloc(totalSize);

  // Header.
  PACKAGE_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(PACKAGE_VERSION, 4);
  buf.writeUInt16LE(0, 6); // flags reserved
  buf.writeUInt32LE(payload.length, 8);
  buf.writeUInt32LE(metadataJson.length, 12);
  buf.writeUInt32LE(0, 16); // reserved
  payloadSha.copy(buf, 20);

  // Body.
  metadataJson.copy(buf, HEADER_SIZE);
  payload.copy(buf, HEADER_SIZE + metadataJson.length);

  // Trailer header (sig_alg + reserved + sig_length).
  const trailerOffset = bodySize;
  buf.writeUInt8(sigAlg, trailerOffset);
  buf.writeUInt8(0, trailerOffset + 1); // reserved
  buf.writeUInt16LE(sigLength, trailerOffset + 2);

  // Signature bytes (if signing). The signature covers bytes[0..trailerOffset)
  // — everything BEFORE the trailer. This commits the producer to the magic +
  // version, the metadata JSON, and the payload itself (via payload_sha + the
  // actual bytes). Any post-sign tamper invalidates the signature.
  if (sigAlg === 1) {
    const bytesToSign = buf.subarray(0, trailerOffset);
    const sig = opts.signer!(bytesToSign);
    if (sig.length !== 64) {
      throw new Error(`Signature must be 64 bytes, got ${sig.length}.`);
    }
    sig.copy(buf, trailerOffset + TRAILER_FIXED_SIZE);
  }

  return buf;
}

/**
 * Parse + validate an "SKDP" package.
 *
 * Throws on malformed input (wrong magic, version, truncated, etc.).
 * `payloadShaValid` is set to true iff the SHA matches; callers should
 * fail-closed if it's false. Does NOT verify the signature.
 */
export function parsePatchPackage(input: Uint8Array): ParsedPatchPackage {
  const buf = Buffer.from(input);

  if (buf.length < HEADER_SIZE + TRAILER_FIXED_SIZE) {
    throw new Error(
      `Patch file too short: ${buf.length} bytes < ${
        HEADER_SIZE + TRAILER_FIXED_SIZE
      } bytes (header+trailer).`,
    );
  }

  // Magic.
  if (
    buf[0] !== PACKAGE_MAGIC[0] ||
    buf[1] !== PACKAGE_MAGIC[1] ||
    buf[2] !== PACKAGE_MAGIC[2] ||
    buf[3] !== PACKAGE_MAGIC[3]
  ) {
    const got = buf.subarray(0, 4).toString('hex');
    throw new Error(
      `Patch file format mismatch: got 0x${got}, expected 0x534b4450 ("SKDP").`,
    );
  }

  const packageVersion = buf.readUInt16LE(4);
  if (packageVersion !== PACKAGE_VERSION) {
    throw new Error(
      `Patch file version ${packageVersion} not supported (this parser handles v${PACKAGE_VERSION}).`,
    );
  }

  const flags = buf.readUInt16LE(6);
  const payloadLength = buf.readUInt32LE(8);
  const metaLength = buf.readUInt32LE(12);
  // skip reserved at offset 16
  const payloadSha = Buffer.from(buf.subarray(20, 52));

  const expectedBodySize = HEADER_SIZE + metaLength + payloadLength;
  if (buf.length < expectedBodySize + TRAILER_FIXED_SIZE) {
    throw new Error(
      `Patch file truncated: declared body+trailer = ${
        expectedBodySize + TRAILER_FIXED_SIZE
      } bytes, file = ${buf.length} bytes.`,
    );
  }

  // Body.
  const metaBytes = buf.subarray(HEADER_SIZE, HEADER_SIZE + metaLength);
  const payload = Buffer.from(
    buf.subarray(HEADER_SIZE + metaLength, HEADER_SIZE + metaLength + payloadLength),
  );

  let metadata: PatchMetadata;
  try {
    metadata = JSON.parse(metaBytes.toString('utf-8'));
  } catch (err: any) {
    throw new Error(`Patch metadata is malformed: ${err.message}`);
  }

  // Trailer.
  const trailerOffset = expectedBodySize;
  const sigAlg = buf.readUInt8(trailerOffset) as SigAlg;
  // skip reserved at trailerOffset+1
  const sigLength = buf.readUInt16LE(trailerOffset + 2);
  const sigStart = trailerOffset + TRAILER_FIXED_SIZE;
  const sigEnd = sigStart + sigLength;

  if (buf.length < sigEnd) {
    throw new Error(
      `Patch file signature trailer truncated: declared ${sigLength} bytes, ` +
        `but only ${buf.length - sigStart} bytes remaining.`,
    );
  }

  const sigBytes = Buffer.from(buf.subarray(sigStart, sigEnd));

  // Validate payload SHA.
  const actualSha = createHash('sha256').update(payload).digest();
  const payloadShaValid = actualSha.equals(payloadSha);

  return {
    packageVersion,
    flags,
    payloadLength,
    metaLength,
    payloadSha,
    metadata,
    payload,
    sigAlg,
    sigBytes,
    payloadShaValid,
    totalSize: sigEnd,
  };
}
