/**
 * `sankofa keys ...` — manage signing keys for Sankofa Deploy patches.
 *
 * v2 envelope MVP (client-side end-to-end signing):
 *
 *   - `sankofa keys generate` creates an Ed25519 keypair, persists the
 *     private key under ~/.config/sankofa/keys/<projectId>.ed25519
 *     (0600 perms), and prints the base64 public key + the snippet to
 *     paste into Sankofa.initialize(deploySigningPubkey: '...').
 *
 *   - `sankofa keys show` prints the public key for the current project
 *     so re-pasting into a fresh app initialization is easy.
 *
 *   - `sankofa keys path` prints the on-disk path of the private key,
 *     useful for backing up to a secrets manager.
 *
 * Without a signing key on disk, `sankofa patch` continues to produce
 * unsigned envelopes (sig_alg=0) — fully backwards-compatible. Once a
 * key exists, every subsequent `sankofa patch` automatically signs.
 *
 * SECURITY: the private key is stored in plaintext at 0600 perms.
 * Future iterations should:
 *   - encrypt with a per-user passphrase
 *   - support macOS Keychain / Linux libsecret integration
 *   - allow CI/CD passphrase-only mode via SANKOFA_SIGNING_KEY env var
 *
 * The server treats the public key as a per-project trust root in v2.1
 * (handshake-distributed). For MVP, the public key is embedded in the
 * host app's Sankofa.initialize() call — the SDK verifies against it
 * before applying any patch.
 */

import { Command } from 'commander';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from 'crypto';
import { findProjectConfig, resolveAuth, requireAuth } from '../utils/config.js';

const SANKOFA_KEYS_DIR = join(homedir(), '.config', 'sankofa', 'keys');

/**
 * Resolves the on-disk paths for a project's signing keypair.
 *
 * The (private, public) split lets users diff the public file against
 * source control if they want to commit the public key alongside the
 * project (recommended). Private keys MUST stay out of source control.
 */
export function signingKeyPaths(projectId: string): {
  privatePath: string;
  publicPath: string;
} {
  return {
    privatePath: join(SANKOFA_KEYS_DIR, `${projectId}.ed25519`),
    publicPath: join(SANKOFA_KEYS_DIR, `${projectId}.ed25519.pub`),
  };
}

/**
 * Load the project's private key, if one exists. Returns null when no
 * key has been generated yet — callers (e.g. `sankofa patch`) fall back
 * to unsigned envelopes in that case.
 */
export function loadSigningKey(projectId: string): {
  privateKeyPem: string;
  publicKeyB64: string;
} | null {
  const { privatePath, publicPath } = signingKeyPaths(projectId);
  if (!existsSync(privatePath)) return null;
  const privateKeyPem = readFileSync(privatePath, 'utf-8');
  // Re-derive public key from private if .pub file is missing (e.g.
  // user backed up only the private key half).
  let publicKeyB64: string;
  if (existsSync(publicPath)) {
    publicKeyB64 = readFileSync(publicPath, 'utf-8').trim();
  } else {
    publicKeyB64 = exportEd25519PublicKeyB64(privateKeyPem);
  }
  return { privateKeyPem, publicKeyB64 };
}

/**
 * Sign 64 bytes of Ed25519 over `bytesToSign`. Used by the envelope
 * wrap pipeline at `sankofa patch` build time. Throws if the private
 * key is malformed.
 */
export function signEd25519(
  privateKeyPem: string,
  bytesToSign: Buffer,
): Buffer {
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  // Ed25519 in Node's crypto API uses algorithm=null. The signature is
  // always exactly 64 bytes; sign() returns a Buffer.
  const { sign } = require('crypto');
  const sig = sign(null, bytesToSign, key);
  return sig;
}

function exportEd25519PublicKeyB64(privateKeyPem: string): string {
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const pub = createPublicKey(key);
  // JWK export gives us the raw 32-byte Ed25519 public point in base64url.
  // Re-encode to standard base64 so the format matches what the SDK side
  // expects (Dart's base64.decode rejects base64url padding differences).
  const jwk = pub.export({ format: 'jwk' });
  const rawB64Url = (jwk as any).x as string;
  const raw = Buffer.from(rawB64Url, 'base64url');
  if (raw.length !== 32) {
    throw new Error(
      `Ed25519 public key must be 32 bytes, got ${raw.length} — keypair is malformed.`,
    );
  }
  return raw.toString('base64');
}

async function resolveProjectId(opts: any): Promise<string> {
  if (opts.project) return opts.project;
  // Walk up looking for .sankofa.json (handles being run from a subdir).
  const cfg = findProjectConfig();
  if (!cfg?.projectId) {
    throw new Error(
      `No project ID found. Pass --project <projectId> or run from a directory with .sankofa.json containing "projectId".`,
    );
  }
  return cfg.projectId;
}

export const keysCommand = new Command('keys')
  .description('Manage Sankofa Deploy signing keys (Ed25519)');

keysCommand
  .command('generate')
  .description('Generate an Ed25519 keypair for signing patches in this project')
  .option('--project <projectId>', 'Project ID (defaults to .sankofa.json)')
  .option('--force', 'Overwrite an existing key (DANGER: invalidates already-shipped patches)')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;

    let projectId: string;
    try {
      projectId = await resolveProjectId(opts);
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    const { privatePath, publicPath } = signingKeyPaths(projectId);
    if (existsSync(privatePath) && !opts.force) {
      console.log(chalk.yellow(`  ⚠  Key already exists at ${privatePath}`));
      console.log(chalk.dim('     Pass --force to overwrite (invalidates already-shipped patches).'));
      process.exit(1);
    }

    mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pemPrivate = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const jwkPub = publicKey.export({ format: 'jwk' });
    const rawPubB64 = Buffer.from((jwkPub as any).x, 'base64url').toString('base64');

    writeFileSync(privatePath, pemPrivate, { mode: 0o600 });
    chmodSync(privatePath, 0o600);
    writeFileSync(publicPath, rawPubB64 + '\n', { mode: 0o644 });

    console.log('');
    console.log(chalk.green('  ✔ Ed25519 keypair generated'));
    console.log(`     Private:    ${chalk.dim(privatePath)}`);
    console.log(`     Public:     ${chalk.dim(publicPath)}`);
    console.log(`     Algorithm:  ed25519`);
    console.log(`     Project:    ${projectId}`);
    console.log('');
    console.log(chalk.bold('  Public key (base64):'));
    console.log(`     ${chalk.cyan(rawPubB64)}`);
    console.log('');
    console.log(chalk.bold('  Paste into your app initialization:'));
    console.log(chalk.dim(`     // sdks/sankofa_sdk_flutter`));
    console.log(`     ${chalk.cyan(`Sankofa.initialize(`)}`);
    console.log(`       ${chalk.cyan(`apiKey: '...',`)}`);
    console.log(`       ${chalk.cyan(`endpoint: '...',`)}`);
    console.log(`       ${chalk.cyan(`deploySigningPubkey: '${rawPubB64}',`)}`);
    console.log(`     ${chalk.cyan(`);`)}`);
    console.log('');
    console.log(chalk.dim('  Subsequent `sankofa patch` runs will sign every envelope.'));
    console.log(chalk.dim('  The SDK rejects any patch whose signature doesn\'t verify against this pubkey.'));
    console.log('');
    console.log(chalk.yellow('  ⚠  Back up the private key file before changing machines.'));
    console.log(chalk.yellow('     Losing it means you can\'t push patches until you generate a new one'));
    console.log(chalk.yellow('     AND ship a host-app rebuild with the new pubkey.'));
  });

keysCommand
  .command('show')
  .description('Print the project\'s public key (base64) for embedding in host app init')
  .option('--project <projectId>', 'Project ID (defaults to .sankofa.json)')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;

    let projectId: string;
    try {
      projectId = await resolveProjectId(opts);
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    const key = loadSigningKey(projectId);
    if (!key) {
      console.error(chalk.red(`  ✖ No signing key for project ${projectId}.`));
      console.error(chalk.dim('     Run `sankofa keys generate` to create one.'));
      process.exit(1);
    }

    console.log(key.publicKeyB64);
  });

keysCommand
  .command('path')
  .description('Print the on-disk path of the project\'s private key (for backup)')
  .option('--project <projectId>', 'Project ID (defaults to .sankofa.json)')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;

    let projectId: string;
    try {
      projectId = await resolveProjectId(opts);
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    const { privatePath } = signingKeyPaths(projectId);
    if (!existsSync(privatePath)) {
      console.error(chalk.red(`  ✖ No signing key for project ${projectId} at ${privatePath}`));
      process.exit(1);
    }
    console.log(privatePath);
  });

// v2.1 — enroll the local pubkey with the server so the upload handler
// can verify signatures at the gate (defense in depth on top of the SDK's
// on-device check). Without this, the server accepts ed25519 envelopes
// but doesn't verify them — only the host app's embedded pubkey gates.
keysCommand
  .command('register')
  .description('Register the local pubkey with the server so it verifies envelope signatures at upload time')
  .option('--project <projectId>', 'Project ID (defaults to .sankofa.json)')
  .option('--env <environment>', 'Environment to enroll the key for (default: live)', 'live')
  .option('--description <desc>', 'Human label so dashboards / audits can identify this key')
  .action(async (opts: any) => {
    const chalk = (await import('chalk')).default;

    await requireAuth();
    let projectId: string;
    try {
      projectId = await resolveProjectId(opts);
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }
    const key = loadSigningKey(projectId);
    if (!key) {
      console.error(chalk.red(`  ✖ No local signing key for project ${projectId}.`));
      console.error(chalk.dim('     Run `sankofa keys generate` first.'));
      process.exit(1);
    }

    const auth = resolveAuth();
    if (!auth.endpoint) {
      console.error(chalk.red('  ✖ No server endpoint configured. Run `sankofa login` first.'));
      process.exit(1);
    }
    if (auth.token.startsWith('sk_live_') || auth.token.startsWith('sk_test_')) {
      console.error(chalk.red('  ✖ `sankofa keys register` needs a dashboard JWT (admin role), not an SDK key.'));
      console.error(chalk.dim('     Run `sankofa login` (interactive flow) to get a session JWT.'));
      process.exit(1);
    }

    const url = `${auth.endpoint.replace(/\/$/, '')}/api/v1/deploy/signing-keys`;
    const body = {
      environment: opts.env || 'live',
      pubkey_b64: key.publicKeyB64,
      description: opts.description || `Registered via sankofa-cli on ${new Date().toISOString()}`,
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'x-project-id': projectId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ POST ${url} failed: ${err.message}`));
      process.exit(1);
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(chalk.red(`  ✖ Server rejected (HTTP ${res.status}): ${text}`));
      process.exit(1);
    }
    const out = (await res.json()) as any;
    console.log('');
    console.log(chalk.green('  ✔ Pubkey registered with server'));
    console.log(`     Key ID:      ${chalk.cyan(out.signing_key?.id)}`);
    console.log(`     Project:     ${projectId}`);
    console.log(`     Environment: ${opts.env || 'live'}`);
    console.log(`     Algorithm:   ${out.signing_key?.algorithm}`);
    console.log('');
    console.log(chalk.dim('  Server will now verify every uploaded envelope against this key.'));
    console.log(chalk.dim('  Unsigned uploads + uploads signed by a non-enrolled key are rejected at the gate.'));
  });
