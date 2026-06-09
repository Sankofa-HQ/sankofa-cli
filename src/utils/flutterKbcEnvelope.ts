/**
 * Sankofa Deploy: Flutter Code patch envelope (sub-phase β.4).
 *
 * Wraps a raw KBC payload (output of `dart2bytecode.dart.snapshot`)
 * in a self-describing, length-prefixed, signature-capable container
 * that can be safely transported, persisted on-device, and parsed by
 * the on-device SDK before being handed to `loadModuleFromBytes`.
 *
 * Why a wrapper at all (the raw KBC is loadable as-is):
 *  - **Integrity**: payload SHA-256 + (future) signature so a tampered
 *    or partial download is detected before the interpreter touches it.
 *  - **Metadata**: release id, project id, target binary version,
 *    rollout %, label, created-at — read by the SDK without parsing
 *    the KBC body.
 *  - **Versioning**: envelope format itself may evolve; KBC bytecode
 *    format may evolve. Both pinned in the header for compatibility
 *    checks.
 *  - **Provenance**: (forward-compat) Ed25519 trailer so the SDK can
 *    refuse patches not signed by the project's release key.
 *
 * Format SANKOFA_KBC_ENVELOPE v1 (little-endian throughout):
 *
 *   offset  size  field
 *   ------  ----  -----
 *   0       4     magic         "SKDP" (0x534B4450)
 *   4       2     env_version   u16 = 1
 *   6       2     flags         u16 (bit 0 reserved, future)
 *   8       4     kbc_length    u32 — bytes of KBC payload
 *   12      4     meta_length   u32 — bytes of metadata JSON
 *   16      4     reserved      u32 = 0
 *   20      32    payload_sha   sha-256 of KBC payload (32 bytes)
 *   52      M     metadata      utf-8 JSON (meta_length bytes)
 *   52+M    N     kbc_payload   raw KBC (kbc_length bytes)
 *
 *   Signature trailer (always present, alg=0 means unsigned in v1):
 *   X       1     sig_alg       u8 (0 = unsigned, 1 = Ed25519 [future])
 *   X+1     1     reserved      u8 = 0
 *   X+2     2     sig_length    u16 (0 if alg=0, 64 if alg=1)
 *   X+4     S     sig_bytes     signature over [0 .. X) — empty if alg=0
 *
 * Total file size = 52 + M + N + 4 + S.
 *
 * Header is fixed-size (52 bytes) so parsers can read it in one syscall
 * to learn everything they need to plan the rest of the read. The
 * signature is at the END so signing can do a single-pass hash without
 * the trailer present.
 *
 * Why ALWAYS include the sig trailer (even when unsigned): keeps the
 * parser shape constant. A future SDK update that requires signed
 * patches doesn't need a parser branch — it just checks `sig_alg == 1`.
 *
 * The Dart-side parser lives in
 * `sdks/sankofa_sdk_flutter/lib/src/deploy/kbc_envelope.dart`
 * (η work — not yet wired). The two parsers must stay byte-compatible.
 *
 * See sankofa-flutter-deploy/docs/build-log-interpreter-program.md
 * β.4 entry for the design rationale.
 */

import { createHash } from 'crypto';

export const ENVELOPE_MAGIC = Buffer.from([0x53, 0x4b, 0x44, 0x50]); // "SKDP"
export const ENVELOPE_VERSION = 1;
export const HEADER_SIZE = 52;
export const TRAILER_FIXED_SIZE = 4; // sig_alg + reserved + sig_length

export type SigAlg = 0 | 1; // 0 = unsigned, 1 = Ed25519 (future)

export type KbcEnvelopeMetadata = {
  /** Sankofa server release id this patch belongs to. */
  releaseId?: string;
  /** Project id (matches the Sankofa Deploy project). */
  projectId?: string;
  /** Sankofa engine fork commit this patch was built against (must match host). */
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

export type WrapOptions = {
  /** The raw KBC bytes (output of dart2bytecode). */
  kbcPayload: Uint8Array;
  /** Metadata that travels with the patch. */
  metadata: KbcEnvelopeMetadata;
  /**
   * Signature algorithm. 0 = unsigned, 1 = Ed25519. When 1, `signer`
   * is required — it gets called with the bytes [0..trailer_offset)
   * and must return a 64-byte Ed25519 signature.
   */
  sigAlg?: SigAlg;
  /**
   * Signing callback. Called with all envelope bytes BEFORE the trailer
   * (header + metadata + kbc payload). Must return a 64-byte Ed25519
   * signature. Only consulted when `sigAlg === 1`.
   */
  signer?: (bytesToSign: Buffer) => Buffer;
};

export type ParsedEnvelope = {
  envelopeVersion: number;
  flags: number;
  kbcLength: number;
  metaLength: number;
  payloadSha: Buffer;
  metadata: KbcEnvelopeMetadata;
  kbcPayload: Buffer;
  sigAlg: SigAlg;
  sigBytes: Buffer;
  /** True iff payloadSha matches a fresh sha-256 of kbcPayload. */
  payloadShaValid: boolean;
  /** Total bytes consumed (= file size). */
  totalSize: number;
};

/**
 * Wrap a raw KBC into a SANKOFA_KBC_ENVELOPE v1.
 *
 * Returns the full envelope bytes ready to write to disk / upload.
 *
 * v1 is always unsigned (sig_alg = 0). The signature trailer is
 * always present so the format stays parser-compatible when signing
 * lands.
 */
export function wrapKbc(opts: WrapOptions): Buffer {
  const sigAlg: SigAlg = opts.sigAlg ?? 0;
  if (sigAlg !== 0 && sigAlg !== 1) {
    throw new Error(
      `Envelope sig_alg must be 0 (unsigned) or 1 (Ed25519). Got: ${sigAlg}.`,
    );
  }
  if (sigAlg === 1 && !opts.signer) {
    throw new Error('Signed patch packaging requires a signer (key).');
  }

  const kbcPayload = Buffer.from(opts.kbcPayload);
  const metadataJson = Buffer.from(
    JSON.stringify(opts.metadata, null, 0),
    'utf-8',
  );

  const payloadSha = createHash('sha256').update(kbcPayload).digest();

  const bodySize =
    HEADER_SIZE + metadataJson.length + kbcPayload.length;
  const sigLength = sigAlg === 1 ? 64 : 0; // Ed25519 signatures are always 64 bytes
  const trailerSize = TRAILER_FIXED_SIZE + sigLength;
  const totalSize = bodySize + trailerSize;

  const buf = Buffer.alloc(totalSize);

  // Header.
  ENVELOPE_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(ENVELOPE_VERSION, 4);
  buf.writeUInt16LE(0, 6); // flags reserved
  buf.writeUInt32LE(kbcPayload.length, 8);
  buf.writeUInt32LE(metadataJson.length, 12);
  buf.writeUInt32LE(0, 16); // reserved
  payloadSha.copy(buf, 20);

  // Body.
  metadataJson.copy(buf, HEADER_SIZE);
  kbcPayload.copy(buf, HEADER_SIZE + metadataJson.length);

  // Trailer header (sig_alg + reserved + sig_length).
  const trailerOffset = bodySize;
  buf.writeUInt8(sigAlg, trailerOffset);
  buf.writeUInt8(0, trailerOffset + 1); // reserved
  buf.writeUInt16LE(sigLength, trailerOffset + 2);

  // Signature bytes (if signing). The signature covers
  // bytes[0..trailerOffset) — everything BEFORE the trailer. This
  // commits the producer to: (a) the magic + version, (b) the metadata
  // JSON, (c) the KBC payload itself (via payload_sha + the actual
  // bytes). Any post-sign tamper invalidates the signature.
  if (sigAlg === 1) {
    const bytesToSign = buf.subarray(0, trailerOffset);
    const sig = opts.signer!(bytesToSign);
    if (sig.length !== 64) {
      throw new Error(
        `Ed25519 signature must be 64 bytes, got ${sig.length}.`,
      );
    }
    sig.copy(buf, trailerOffset + TRAILER_FIXED_SIZE);
  }

  return buf;
}

/**
 * Parse + validate a SANKOFA_KBC_ENVELOPE.
 *
 * Throws on malformed input (wrong magic, version, truncated, etc.).
 * `payloadShaValid` is set to true iff the SHA matches; callers should
 * fail-closed if it's false.
 *
 * Does NOT verify the signature (Ed25519 verify lands when v2 ships).
 */
export function parseKbcEnvelope(input: Uint8Array): ParsedEnvelope {
  const buf = Buffer.from(input);

  if (buf.length < HEADER_SIZE + TRAILER_FIXED_SIZE) {
    throw new Error(
      `KBC envelope too short: ${buf.length} bytes < ${
        HEADER_SIZE + TRAILER_FIXED_SIZE
      } bytes (header+trailer).`,
    );
  }

  // Magic.
  if (
    buf[0] !== ENVELOPE_MAGIC[0] ||
    buf[1] !== ENVELOPE_MAGIC[1] ||
    buf[2] !== ENVELOPE_MAGIC[2] ||
    buf[3] !== ENVELOPE_MAGIC[3]
  ) {
    const got = buf.subarray(0, 4).toString('hex');
    throw new Error(
      `KBC envelope magic mismatch: got 0x${got}, expected 0x534b4450 ("SKDP").`,
    );
  }

  const envelopeVersion = buf.readUInt16LE(4);
  if (envelopeVersion !== ENVELOPE_VERSION) {
    throw new Error(
      `KBC envelope version ${envelopeVersion} not supported (this parser handles v${ENVELOPE_VERSION}).`,
    );
  }

  const flags = buf.readUInt16LE(6);
  const kbcLength = buf.readUInt32LE(8);
  const metaLength = buf.readUInt32LE(12);
  // skip reserved at offset 16
  const payloadSha = Buffer.from(buf.subarray(20, 52));

  const expectedBodySize = HEADER_SIZE + metaLength + kbcLength;
  if (buf.length < expectedBodySize + TRAILER_FIXED_SIZE) {
    throw new Error(
      `KBC envelope truncated: declared body+trailer = ${
        expectedBodySize + TRAILER_FIXED_SIZE
      } bytes, file = ${buf.length} bytes.`,
    );
  }

  // Body.
  const metaBytes = buf.subarray(HEADER_SIZE, HEADER_SIZE + metaLength);
  const kbcPayload = Buffer.from(
    buf.subarray(HEADER_SIZE + metaLength, HEADER_SIZE + metaLength + kbcLength),
  );

  let metadata: KbcEnvelopeMetadata;
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
      `KBC envelope signature trailer truncated: declared ${sigLength} bytes, ` +
        `but only ${buf.length - sigStart} bytes remaining.`,
    );
  }

  const sigBytes = Buffer.from(buf.subarray(sigStart, sigEnd));

  // Validate payload SHA.
  const actualSha = createHash('sha256').update(kbcPayload).digest();
  const payloadShaValid = actualSha.equals(payloadSha);

  return {
    envelopeVersion,
    flags,
    kbcLength,
    metaLength,
    payloadSha,
    metadata,
    kbcPayload,
    sigAlg,
    sigBytes,
    payloadShaValid,
    totalSize: sigEnd,
  };
}
