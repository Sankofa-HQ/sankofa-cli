import { Command } from 'commander';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { uploadRelease } from '../utils/api.js';
import { requireAuth } from '../utils/config.js';
import { formatBytes } from '../utils/bundler.js';
import { parseRollout } from '../utils/validation.js';

/**
 * Phase 8 — Flutter Code OTA push.
 *
 * Uploads a single libapp.so file (the Dart AOT-compiled application
 * code) as a flutter-code release. The customer's Flutter app — wired
 * up with the Sankofa Deploy SDK — will see this on the next handshake
 * and stage it for the next boot.
 *
 * Distinct from the React-Native `release` command because:
 *
 * - No JS bundling step (Flutter doesn't ship JS at runtime).
 * - No native-binary build step (Flutter Code OTA targets Dart only;
 *   the customer's APK + libflutter.so engine fork ship via the store).
 * - Payload is a single .so file, not a zip archive.
 * - Requires --engine-version so server-side gating can reject patches
 *   built against a different Sankofa engine fork.
 *
 * Example:
 *
 *   sankofa flutter-push \
 *     --libapp ./engine/src/out/android_release_arm64/libapp.so \
 *     --engine-version 3.41.9+sankofa-1 \
 *     --target-binary-version 1.2.0 \
 *     --label v1.2.3-hotfix \
 *     --platform android \
 *     --rollout 10
 */
export const flutterPushCommand = new Command('flutter-push')
  .description('Push a Flutter libapp.so OTA patch to Sankofa Deploy (runtime=flutter-code)')
  .requiredOption('--libapp <path>', 'Path to the compiled libapp.so on disk')
  .requiredOption('--engine-version <version>', 'Sankofa engine fork version this libapp.so was built against (e.g. "3.41.9+sankofa-1")')
  .requiredOption('--target-binary-version <version>', "Customer's native app binary version this patch applies to (e.g. \"1.2.0\")")
  .requiredOption('--label <label>', 'Human-readable release label (e.g. "v1.2.3-hotfix")')
  .requiredOption('--platform <platform>', 'Device platform: ios or android')
  .option('--rollout <percent>', 'Rollout percentage 0-100 (default 100)', '100')
  .option('--mandatory', 'Mark this release as mandatory (force-apply on download)', false)
  .option('--description <text>', 'Optional release notes')
  .option('--environment <env>', 'live or test (default: live)', 'live')
  .action(async (opts) => {
    requireAuth();

    const libappPath = resolve(opts.libapp);
    if (!existsSync(libappPath)) {
      console.error(chalk.red(`✗ libapp.so not found at ${libappPath}`));
      process.exit(1);
    }
    const stats = statSync(libappPath);
    if (!stats.isFile()) {
      console.error(chalk.red(`✗ --libapp must point at a file, got ${libappPath}`));
      process.exit(1);
    }
    if (!isElfArm64(libappPath)) {
      // Defense in depth: catch the common mistake of pushing a .zip
      // or a host-architecture .so before the server SHAs it and the
      // device discards the SHA mismatch on download.
      console.error(chalk.red(`✗ ${libappPath} does not look like an ELF arm64 / aarch64 shared library`));
      console.error(chalk.dim('  Flutter Code OTA expects the libapp.so produced by the Sankofa engine fork build pipeline for android-arm64.'));
      process.exit(1);
    }

    const platform = String(opts.platform).toLowerCase();
    if (platform !== 'android' && platform !== 'ios') {
      console.error(chalk.red(`✗ --platform must be "android" or "ios", got "${opts.platform}"`));
      process.exit(1);
    }
    if (platform === 'ios') {
      console.error(chalk.yellow('⚠  iOS Flutter Code OTA is Phase 6 — server will reject this release until iOS engine support ships.'));
      console.error(chalk.dim('   Pushing anyway because the server already supports the metadata; the client just cannot consume yet.'));
    }

    const rollout = parseRollout(opts.rollout);
    const environment = opts.environment === 'test' ? 'test' : 'live';

    console.log('');
    console.log(chalk.bold('Sankofa Deploy: Flutter Code'));
    console.log(chalk.dim('  libapp.so:           ') + chalk.cyan(libappPath));
    console.log(chalk.dim('  Size:                ') + formatBytes(stats.size));
    console.log(chalk.dim('  Engine version:      ') + opts.engineVersion);
    console.log(chalk.dim('  Target binary:       ') + opts.targetBinaryVersion);
    console.log(chalk.dim('  Label:               ') + opts.label);
    console.log(chalk.dim('  Platform:            ') + platform);
    console.log(chalk.dim('  Environment:         ') + environment);
    console.log(chalk.dim('  Rollout:             ') + `${rollout}%`);
    console.log('');

    const spinner = ora('Uploading libapp.so to Sankofa Deploy...').start();
    try {
      const release = await uploadRelease(libappPath, {
        label: opts.label,
        target_binary_version: opts.targetBinaryVersion,
        platform,
        description: opts.description || `Flutter Code release ${opts.label} for ${platform}`,
        is_mandatory: Boolean(opts.mandatory),
        rollout_percentage: rollout,
        environment,
        runtime: 'flutter-code',
        engine_version: opts.engineVersion,
      });
      spinner.succeed('libapp.so uploaded');

      console.log('');
      console.log(chalk.green.bold('  🚀 Flutter Code release published'));
      console.log(chalk.dim('     Release ID:      ') + release.id);
      console.log(chalk.dim('     Label:           ') + release.label);
      console.log(chalk.dim('     Runtime:         ') + release.runtime);
      console.log(chalk.dim('     Engine version:  ') + release.engine_version);
      console.log(chalk.dim('     Bundle SHA256:   ') + release.bundle_sha256);
      console.log(chalk.dim('     Bundle size:     ') + formatBytes(release.bundle_size_bytes ?? stats.size));
      console.log(chalk.dim('     Rollout:         ') + `${release.rollout_percentage}%`);
      console.log('');
      console.log(chalk.dim('  Apps running engine ') + chalk.cyan(opts.engineVersion) + chalk.dim(' and binary ') + chalk.cyan(opts.targetBinaryVersion));
      console.log(chalk.dim('  will pick this up on their next checkForUpdate() call.'));
    } catch (err: any) {
      spinner.fail(`Upload failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

/**
 * Quick ELF + ARM-aarch64 sniff. Reads the first 20 bytes of the file
 * and validates:
 *   - bytes 0..3:   "\x7fELF" magic
 *   - byte 4:       0x02 (ELFCLASS64)
 *   - byte 5:       0x01 (ELFDATA2LSB, little-endian)
 *   - bytes 18..19: 0xb7 0x00 (EM_AARCH64)
 *
 * Returns true only if all match. Doesn't validate the rest of the
 * header — that's the linker's job at load time.
 */
function isElfArm64(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(20);
    const read = readSync(fd, buf, 0, 20, 0);
    if (read < 20) return false;
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return false; // \x7fELF
    if (buf[4] !== 0x02) return false; // ELFCLASS64
    if (buf[5] !== 0x01) return false; // ELFDATA2LSB
    if (buf[18] !== 0xb7 || buf[19] !== 0x00) return false; // EM_AARCH64
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
  }
}
