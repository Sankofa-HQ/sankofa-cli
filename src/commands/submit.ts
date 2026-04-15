import { Command } from 'commander';
import { execSync } from 'child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { requireAuth } from '../utils/config.js';
import { resolvePlatformPrompt } from '../utils/prompts.js';
import { formatBytes } from '../utils/bundler.js';

type SupportedPlatform = 'ios' | 'android';

export const submitCommand = new Command('submit')
  .description('Upload a signed store binary to App Store Connect (iOS) or Play Console (Android)')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--binary <path>', 'Path to the .ipa/.aab/.apk to upload (default: most recent build/distribution output)')
  // ── iOS / App Store Connect ──
  .option('--apple-api-key-id <id>', 'App Store Connect API Key ID (10-char alphanumeric)')
  .option('--apple-api-issuer <uuid>', 'App Store Connect Issuer ID (UUID)')
  .option(
    '--apple-api-key-path <path>',
    'Path to AuthKey_<ID>.p8 (default: ~/.appstoreconnect/private_keys/)',
  )
  // ── Android / Play Console ──
  .option('--google-service-account <path>', 'Path to Google Play service account JSON key')
  .option(
    '--google-track <track>',
    'Play Store track: internal, alpha, beta, production. Default: internal',
    'internal',
  )
  .option('--google-package <name>', 'Android package name (auto-detected from build.gradle when omitted)')
  .option('--project <path>', 'Path to the React Native app directory (defaults to auto-detect)')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    await requireAuth();

    const platform = (await resolvePlatformPrompt(platformArg)) as SupportedPlatform;

    const binaryPath = resolveBinary(platform, opts.binary);
    if (!existsSync(binaryPath)) {
      console.error(chalk.red(`  Binary not found: ${binaryPath}`));
      console.error(chalk.dim('  Run `sankofa release ' + platform + ' --distribution` first, or pass --binary <path>.'));
      process.exit(1);
    }

    const size = statSync(binaryPath).size;
    console.log('');
    console.log(chalk.bold(`  Submitting ${platform} build`));
    console.log(chalk.dim(`     Binary: ${binaryPath}`));
    console.log(chalk.dim(`     Size:   ${formatBytes(size)}`));
    console.log('');

    if (platform === 'ios') {
      await submitIOS(binaryPath, opts, chalk, ora);
      return;
    }
    await submitAndroid(binaryPath, opts, chalk, ora);
  });

function resolveBinary(platform: SupportedPlatform, explicit?: string): string {
  if (explicit) return explicit;
  const distDir = join(process.cwd(), 'build', 'distribution');
  const ipaDir = join(distDir, 'ipa-export');

  if (platform === 'ios') {
    if (existsSync(ipaDir)) {
      const ipa = findNewestMatching(ipaDir, (name) => name.endsWith('.ipa'));
      if (ipa) return ipa;
    }
    return join(distDir, 'app.ipa'); // fall-through so caller can fail with a clear error
  }

  // Android: prefer .aab over .apk when both exist.
  const aab = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
  if (existsSync(aab)) return aab;
  const apk = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (existsSync(apk)) return apk;
  return aab;
}

function findNewestMatching(dir: string, predicate: (name: string) => boolean): string | null {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter(predicate)
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches.length > 0 ? join(dir, matches[0].name) : null;
}

async function submitIOS(
  binaryPath: string,
  opts: any,
  chalk: any,
  ora: any,
): Promise<void> {
  if (!binaryPath.endsWith('.ipa')) {
    console.error(chalk.red(`  App Store Connect requires a .ipa; got ${binaryPath}`));
    process.exit(1);
  }

  const apiKeyId = opts.appleApiKeyId || process.env.APP_STORE_CONNECT_API_KEY_ID;
  const issuer = opts.appleApiIssuer || process.env.APP_STORE_CONNECT_API_ISSUER;
  if (!apiKeyId || !issuer) {
    console.error(chalk.red('  Missing App Store Connect credentials.'));
    console.error(chalk.dim('  Pass --apple-api-key-id <ID> --apple-api-issuer <UUID>'));
    console.error(chalk.dim('  (or set APP_STORE_CONNECT_API_KEY_ID / APP_STORE_CONNECT_API_ISSUER).'));
    console.error(chalk.dim('  Create a key at https://appstoreconnect.apple.com/access/api.'));
    process.exit(1);
  }

  // altool discovers the .p8 at ~/.appstoreconnect/private_keys/AuthKey_<ID>.p8
  // unless an explicit path is given via --apiKeyPath (altool 2.16+).
  const keyPath =
    opts.appleApiKeyPath ||
    join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${apiKeyId}.p8`);
  if (!existsSync(keyPath)) {
    console.error(chalk.red(`  App Store Connect private key not found at ${keyPath}`));
    console.error(chalk.dim(`  Download AuthKey_${apiKeyId}.p8 from App Store Connect and place it at:`));
    console.error(chalk.dim(`    ~/.appstoreconnect/private_keys/AuthKey_${apiKeyId}.p8`));
    console.error(chalk.dim(`  or pass --apple-api-key-path <path>.`));
    process.exit(1);
  }

  const validateSpinner = ora('Validating IPA with App Store Connect...').start();
  try {
    execSync(
      `xcrun altool --validate-app --type ios --file ${shellQuote(binaryPath)} --apiKey ${shellQuote(apiKeyId)} --apiIssuer ${shellQuote(issuer)}`,
      { stdio: 'inherit' },
    );
    validateSpinner.succeed('Validation passed');
  } catch (err: any) {
    validateSpinner.fail('Validation failed — fix the errors above before uploading.');
    process.exit(1);
  }

  const uploadSpinner = ora('Uploading to App Store Connect (this can take several minutes)...').start();
  try {
    execSync(
      `xcrun altool --upload-app --type ios --file ${shellQuote(binaryPath)} --apiKey ${shellQuote(apiKeyId)} --apiIssuer ${shellQuote(issuer)}`,
      { stdio: 'inherit' },
    );
    uploadSpinner.succeed('Uploaded to App Store Connect');
  } catch (err: any) {
    uploadSpinner.fail('Upload failed');
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold('  ✅ IPA submitted to App Store Connect'));
  console.log(chalk.dim('     Processing typically takes 5–30 minutes.'));
  console.log(chalk.dim('     Track status at https://appstoreconnect.apple.com/apps'));
  console.log('');
}

async function submitAndroid(
  binaryPath: string,
  opts: any,
  chalk: any,
  ora: any,
): Promise<void> {
  const serviceAccountPath =
    opts.googleServiceAccount || process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountPath) {
    console.error(chalk.red('  Missing Google Play service account JSON.'));
    console.error(chalk.dim('  Pass --google-service-account <path> or set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.'));
    console.error(chalk.dim('  Create one at https://console.cloud.google.com/iam-admin/serviceaccounts'));
    console.error(chalk.dim('  and grant it the Play Developer API role in Play Console → Users & permissions.'));
    process.exit(1);
  }
  if (!existsSync(serviceAccountPath)) {
    console.error(chalk.red(`  Service account JSON not found: ${serviceAccountPath}`));
    process.exit(1);
  }

  const packageName = opts.googlePackage || detectAndroidPackageName();
  if (!packageName) {
    console.error(chalk.red('  Could not detect Android package name.'));
    console.error(chalk.dim('  Pass --google-package <com.your.app>.'));
    process.exit(1);
  }

  const track = String(opts.googleTrack || 'internal').toLowerCase();
  if (!['internal', 'alpha', 'beta', 'production'].includes(track)) {
    console.error(chalk.red(`  Invalid --google-track "${track}". Must be internal, alpha, beta, or production.`));
    process.exit(1);
  }

  const isBundle = binaryPath.endsWith('.aab');
  if (!isBundle && !binaryPath.endsWith('.apk')) {
    console.error(chalk.red(`  Play Console requires .aab or .apk; got ${binaryPath}`));
    process.exit(1);
  }

  const authSpinner = ora('Authenticating with Google Play Developer API...').start();
  let play: any;
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountPath,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    play = google.androidpublisher({ version: 'v3', auth: (await auth.getClient()) as any });
    authSpinner.succeed('Authenticated');
  } catch (err: any) {
    authSpinner.fail(`Auth failed: ${err.message}`);
    process.exit(1);
  }

  const editSpinner = ora(`Creating edit for ${packageName}...`).start();
  let editId: string;
  try {
    const res = await play.edits.insert({ packageName });
    editId = res.data.id!;
    editSpinner.succeed(`Edit ${editId} created`);
  } catch (err: any) {
    editSpinner.fail(`Failed to open edit: ${extractGoogleError(err)}`);
    process.exit(1);
  }

  const uploadSpinner = ora(`Uploading ${isBundle ? 'AAB' : 'APK'}...`).start();
  let versionCode: number;
  try {
    const mediaBody = createReadStream(binaryPath);
    const mimeType = isBundle ? 'application/octet-stream' : 'application/vnd.android.package-archive';
    if (isBundle) {
      const res = await play.edits.bundles.upload({
        packageName,
        editId,
        media: { mimeType, body: mediaBody },
      });
      versionCode = res.data.versionCode!;
    } else {
      const res = await play.edits.apks.upload({
        packageName,
        editId,
        media: { mimeType, body: mediaBody },
      });
      versionCode = res.data.versionCode!;
    }
    uploadSpinner.succeed(`Uploaded versionCode ${versionCode}`);
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${extractGoogleError(err)}`);
    process.exit(1);
  }

  const trackSpinner = ora(`Assigning versionCode ${versionCode} to ${track} track...`).start();
  try {
    await play.edits.tracks.update({
      packageName,
      editId,
      track,
      requestBody: {
        track,
        releases: [
          {
            status: track === 'production' ? 'completed' : 'draft',
            versionCodes: [String(versionCode)],
          },
        ],
      },
    });
    trackSpinner.succeed(`Track ${track} updated`);
  } catch (err: any) {
    trackSpinner.fail(`Track update failed: ${extractGoogleError(err)}`);
    process.exit(1);
  }

  const commitSpinner = ora('Committing edit...').start();
  try {
    await play.edits.commit({ packageName, editId });
    commitSpinner.succeed('Edit committed');
  } catch (err: any) {
    commitSpinner.fail(`Commit failed: ${extractGoogleError(err)}`);
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold(`  ✅ ${isBundle ? 'AAB' : 'APK'} submitted to Play Console`));
  console.log(chalk.dim(`     Package:     ${packageName}`));
  console.log(chalk.dim(`     VersionCode: ${versionCode}`));
  console.log(chalk.dim(`     Track:       ${track}${track === 'production' ? ' (completed)' : ' (draft — promote in Play Console)'}`));
  console.log(chalk.dim('     Track status at https://play.google.com/console'));
  console.log('');
}

function detectAndroidPackageName(): string | null {
  const gradle = join(process.cwd(), 'android', 'app', 'build.gradle');
  if (!existsSync(gradle)) return null;
  try {
    const content = readFileSync(gradle, 'utf-8');
    const ns = content.match(/namespace\s+['"]([^'"]+)['"]/);
    if (ns) return ns[1];
    const appId = content.match(/applicationId\s+['"]([^'"]+)['"]/);
    if (appId) return appId[1];
  } catch {}
  return null;
}

function extractGoogleError(err: any): string {
  const apiErr = err?.errors?.[0]?.message || err?.response?.data?.error?.message;
  return apiErr || err?.message || String(err);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
