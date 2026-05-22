import { Command } from 'commander';
import fs from 'node:fs';
import { join } from 'path';
import { statSync } from 'fs';
import {
  buildDistributionArtifact,
  buildNativePreviewArtifact,
  bundleJS,
  clearBuildArtifacts,
  computeSHA256,
  createOTAArchive,
  detectAppVersion,
  detectEntryFile,
  extractEmbeddedOTA,
  formatBytes,
  getFileSize,
  syncNativeFromAppJson,
  type DistributionArtifact,
  type NativePreviewArtifact,
} from '../utils/bundler.js';
import os from 'node:os';
import path from 'node:path';
import { listReleases, uploadRelease } from '../utils/api.js';
import { requireAuth } from '../utils/config.js';
import {
  uploadCatchSymbol,
  uploadSymbolsDirectory,
  type UploadedArtifact,
} from '../utils/catchSymbols.js';
import {
  buildDSymManifest,
  buildNDKManifest,
  writeManifest,
} from '../utils/nativeManifest.js';
import { resolveEnvironmentPrompt, resolvePlatformPrompt } from '../utils/prompts.js';
import { resolveProjectRoot, type ProjectInfo } from '../utils/stack.js';
import { parseRollout } from '../utils/validation.js';
import { buildFlutterAOT, resolveFlutterPlatform } from '../utils/flutterBundler.js';
import { captureFlutterBaseline, type BaselineManifest } from '../utils/baseline.js';

export const releaseCommand = new Command('release')
  .description('Create a Sankofa Deploy release by bundling JavaScript and uploading a preview-installable native artifact')
  .argument('[platform]', 'Target platform: ios or android (prompts if omitted)')
  .option('--entry-file <file>', 'JS entry file')
  .option('--output-dir <dir>', 'Directory for built artifacts', './build')
  .option('--no-native-artifact', 'Skip building/uploading the native preview artifact')
  .option('--description <desc>', 'Release description')
  .option('--mandatory', 'Mark this release as mandatory (force-update)')
  .option('--rollout <percent>', 'Initial rollout percentage (0-100)', '100')
  .option('--publish', 'Auto-publish without prompting')
  .option('--env <environment>', 'Target environment: live or test')
  .option('--project <path>', 'Path to the React Native app directory (defaults to auto-detect)')
  .option('--skip-distribution', 'Skip building the signed store binary (OTA-only release). Default: build distribution.')
  .option('--ios-export-method <method>', 'iOS export method: app-store, ad-hoc, development, enterprise (default: app-store)')
  .option('--ios-team-id <id>', 'Apple Developer Team ID for iOS code signing (auto-detected from archive when omitted)')
  .option('--ios-export-options <path>', 'Path to a custom ExportOptions.plist (overrides --ios-export-method / --ios-team-id)')
  .option('--android-format <fmt>', '[RN, deprecated alias for --apk/--appbundle] Android format: aab or apk. Default: aab', 'aab')
  // ── Sankofa Catch symbol uploads (M10). Each flag takes a path
  //    (file or directory). Non-existent paths are skipped with a
  //    warning so the release flow isn't blocked by a missing artifact.
  .option('--upload-sourcemaps <path>', 'Upload JS source map(s) for this release (file or directory)')
  .option('--upload-dsym <path>', 'Upload iOS dSYM(s) for this release (file or directory of .zip bundles)')
  .option('--upload-mapping <path>', 'Upload Android ProGuard/R8 mapping.txt for this release')
  .option('--upload-ndk <path>', 'Upload Android NDK symbols for this release (directory of .so files)')
  .option('--upload-dart-symbols <path>', 'Upload Flutter/Dart symbol bundle for this release')
  .option('--dry-run', 'Build + capture Diff Guard baseline locally, but do NOT contact the server or upload')
  .option('--apk', 'Android: produce an APK (sideload-installable). Default is --appbundle. (RN + Flutter)')
  .option('--appbundle', 'Android: produce an AAB (Play Store). This is the default. (RN + Flutter)')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;

    await requireAuth();

    // Resolve project + dispatch by stack. Flutter releases follow a much
    // shorter path (no native artifact build step, no symbol uploads —
    // those don't apply to Dart AOT today). RN releases keep the existing
    // pipeline unchanged.
    let project: ProjectInfo;
    try {
      project = await resolveProjectRoot({
        explicit: opts.project,
        allowedStacks: ['react-native', 'flutter'],
      });
    } catch (err: any) {
      console.error(chalk.red(`  ✖ ${err.message}`));
      process.exit(1);
    }

    if (project.root !== process.cwd()) {
      console.log(chalk.dim(`  → Working in ${project.root}`));
      process.chdir(project.root);
    }

    if (project.stack === 'flutter') {
      return flutterRelease(project, platformArg, opts);
    }

    // ── React Native (existing flow, unchanged below) ──
    const ora = (await import('ora')).default;

    // Honor the new --apk / --appbundle flags here too. They take
    // precedence over the legacy --android-format if both are passed,
    // because the new flags express user intent more clearly.
    if (opts.apk && opts.appbundle) {
      console.error(chalk.red('  ✖ --apk and --appbundle are mutually exclusive.'));
      process.exit(1);
    }
    if (opts.apk) opts.androidFormat = 'apk';
    else if (opts.appbundle) opts.androidFormat = 'aab';

    let platform;
    let environment;
    let rollout;
    try {
      platform = await resolvePlatformPrompt(platformArg);
      environment = await resolveEnvironmentPrompt(opts.env);
      rollout = parseRollout(opts.rollout);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    // Sync ios/ and android/ from app.json so native version/config reflects
    // the latest source before we detect the version or build anything.
    const syncSpinner = ora('Syncing native project from app.json (expo prebuild)...').start();
    try {
      syncNativeFromAppJson(platform);
      syncSpinner.succeed('Native project synced');
    } catch (err: any) {
      syncSpinner.fail(err.message);
      process.exit(1);
    }

    const entryFile = detectEntryFile(opts.entryFile);

    // 1. Detect app version
    const spinner = ora('Detecting app version...').start();
    const appVersion = detectAppVersion(platform);
    if (!appVersion) {
      spinner.fail('Could not detect app version. Check your app.json, Info.plist, or build.gradle.');
      process.exit(1);
    }
    spinner.succeed(`App version: ${chalk.bold(appVersion)}`);

    // 2. Check if this version already has a release on Sankofa
    const checkSpinner = ora('Checking for existing releases...').start();
    try {
      const { listReleases } = await import('../utils/api.js');
      const releases = await listReleases(environment, platform);
      const existing = releases.find(
        (r: any) => r.target_binary_version === appVersion && r.platform === platform,
      );
      if (existing) {
        checkSpinner.fail(
          `Version ${chalk.bold(appVersion)} already has a release (${chalk.dim(existing.label)}).`,
        );
        console.log('');
        console.log(chalk.dim('  Options:'));
        console.log(chalk.dim(`    • JS/asset update:          ${chalk.cyan('sankofa patch ' + platform)}`));
        console.log(chalk.dim(`    • Rebuild signed binary:    ${chalk.cyan('sankofa dist ' + platform)}`));
        console.log(chalk.dim(`    • Upload existing binary:   ${chalk.cyan('sankofa submit ' + platform)}`));
        process.exit(1);
      }
      checkSpinner.succeed('No existing release for this version');
    } catch (err: any) {
      checkSpinner.fail(`Could not check existing releases: ${err.message}`);
      process.exit(1);
    }

    // 3. Build the native preview artifact. This does not install, launch, or
    // start Metro; it only creates the deployed artifact used by `preview`.
    const outputDir = opts.outputDir;
    const cleanSpinner = ora('Clearing build caches...').start();
    try {
      clearBuildArtifacts(outputDir);
      cleanSpinner.succeed('Build caches cleared');
    } catch (err: any) {
      cleanSpinner.fail(`Failed to clear build caches: ${err.message}`);
      process.exit(1);
    }

    let nativeArtifact: NativePreviewArtifact | null = null;
    if (opts.nativeArtifact !== false) {
      console.log(chalk.dim(`\n  Building ${platform} native preview artifact...`));
      try {
        nativeArtifact = buildNativePreviewArtifact(platform, outputDir);
        console.log(chalk.green(`  ✓ Preview artifact saved to ${nativeArtifact.path}\n`));
      } catch (err: any) {
        console.log(chalk.red(`  ✖ Native preview artifact build failed: ${err.message}`));
        console.log(chalk.dim(`    Release cancelled because preview needs the deployed native artifact.`));
        console.log(chalk.dim(`    Use ${chalk.cyan('--no-native-artifact')} only when you intentionally do not need sankofa preview.\n`));
        process.exit(1);
      }
    }

    // 4. Stage the OTA payload (bundle + assets) and package it as a zip
    //    archive. Prefer extracting from the freshly-built native artifact so
    //    the OTA's asset IDs are byte-identical to what the `.app` embeds —
    //    that's what keeps `useFonts` / `require('./image.png')` / any asset
    //    lookup working after the patch loads. Falling back to a fresh Metro
    //    bundle only if the native artifact is unavailable.
    const stageDir = join(outputDir, 'ota-stage');
    const archivePath = join(outputDir, `ota.${platform}.zip`);
    const bundleSpinner = ora('Staging OTA payload from native artifact...').start();
    try {
      const reused = nativeArtifact
        ? extractEmbeddedOTA(platform, nativeArtifact.path, stageDir)
        : false;
      if (!reused) {
        bundleSpinner.text = 'Bundling JavaScript + assets (no native artifact)...';
        bundleJS(platform, entryFile, stageDir);
      }
      createOTAArchive(stageDir, archivePath);
      bundleSpinner.succeed(reused ? 'OTA archive built from native artifact' : 'OTA archive built from source');
    } catch (err: any) {
      bundleSpinner.fail(`Bundling failed: ${err.message}`);
      process.exit(1);
    }

    // 5. Compute SHA256 of the archive (bytes the client will verify)
    const sha256 = computeSHA256(archivePath);
    const size = getFileSize(archivePath);
    console.log(chalk.dim(`  SHA256: ${sha256}`));
    console.log(chalk.dim(`  Size:   ${formatBytes(size)}`));

    // 6. Generate label
    const label = `v${appVersion}`;

    // 7. Confirm publish
    let shouldPublish = opts.publish;
    if (!shouldPublish) {
      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Publish ${chalk.bold(label)} (${platform}) to Sankofa Deploy?`,
          default: true,
        },
      ]);
      shouldPublish = confirm;
    }

    if (!shouldPublish) {
      console.log(chalk.dim('Release cancelled.'));
      return;
    }

    // 8. Upload to Sankofa
    const uploadSpinner = ora('Uploading bundle to Sankofa...').start();
    try {
      const release = await uploadRelease(archivePath, {
        label,
        target_binary_version: appVersion,
        platform,
        description: opts.description || `Release ${label} for ${platform}`,
        is_mandatory: opts.mandatory || false,
        rollout_percentage: rollout,
        environment,
        native_artifact_path: nativeArtifact?.path,
        native_artifact_kind: nativeArtifact?.kind,
      });

      uploadSpinner.succeed('Bundle uploaded!');

      // Always build the signed store binary alongside the OTA release —
      // a release without a submittable binary isn't a release. Opt out only
      // with --skip-distribution (e.g. for OTA-only CI lanes that ship the
      // binary via a separate flow).
      let distArtifact: DistributionArtifact | null = null;
      if (!opts.skipDistribution) {
        const distSpinner = ora(`Building signed ${platform} distribution binary (this takes a few minutes)...`).start();
        try {
          distArtifact = buildDistributionArtifact(platform, {
            outputDir: join(outputDir, 'distribution'),
            iosExportMethod: opts.iosExportMethod,
            iosTeamId: opts.iosTeamId,
            iosExportOptionsPlist: opts.iosExportOptions,
            androidFormat: opts.androidFormat === 'apk' ? 'apk' : 'aab',
          });
          distSpinner.succeed('Signed distribution binary built');
        } catch (err: any) {
          distSpinner.fail(`Distribution build failed: ${err.message}`);
          console.log(chalk.dim('  The OTA release was still published successfully.'));
          console.log(chalk.dim('  Run `sankofa dist ' + platform + '` to retry the signed-binary build once signing is fixed.'));
        }
      }
      console.log('');
      console.log(chalk.green.bold('  🚀 Release published'));
      console.log(chalk.dim(`     Label:          ${release.label}`));
      console.log(chalk.dim(`     Platform:       ${release.platform}`));
      console.log(chalk.dim(`     Target version: ${release.target_binary_version}`));
      console.log(chalk.dim(`     Rollout:        ${release.rollout_percentage}%`));
      console.log(chalk.dim(`     Release ID:     ${release.id}`));
      console.log('');
      console.log(chalk.bold('  📦 OTA Archive'));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(archivePath));
      console.log(chalk.dim('     Size:   ') + formatBytes(size));
      console.log(chalk.dim('     SHA256: ') + chalk.yellow(sha256));
      if (nativeArtifact) {
        const nativeSHA = computeSHA256(nativeArtifact.path);
        const nativeSize = getFileSize(nativeArtifact.path);
        const nativeLabel =
          nativeArtifact.kind === 'ios-simulator-app-zip' ? 'iOS Simulator App (.app.zip)' :
          nativeArtifact.kind === 'android-apk' ? 'Android APK' :
          nativeArtifact.kind;
        console.log('');
        console.log(chalk.bold(`  📱 Native binary — ${nativeLabel}`));
        console.log(chalk.dim('     Path:   ') + chalk.cyan(nativeArtifact.path));
        console.log(chalk.dim('     Size:   ') + formatBytes(nativeSize));
        console.log(chalk.dim('     SHA256: ') + chalk.yellow(nativeSHA));
        console.log('');
        console.log(chalk.dim('     ↑ Simulator/debug preview binary. NOT submittable to App Store'));
        console.log(chalk.dim('       or Play Store. Used only by `sankofa preview` for QA on a'));
        console.log(chalk.dim('       simulator/emulator. Pass --distribution to also build the'));
        console.log(chalk.dim('       signed store binary.'));
      }

      if (distArtifact) {
        const distSHA = computeSHA256(distArtifact.path);
        const distSize = getFileSize(distArtifact.path);
        const distLabel =
          distArtifact.kind === 'ios-ipa' ? 'iOS IPA — App Store / TestFlight' :
          distArtifact.kind === 'android-aab' ? 'Android AAB — Play Store' :
          'Android APK — sideload';
        console.log('');
        console.log(chalk.bold(`  🏬 Store binary — ${distLabel}`));
        console.log(chalk.dim('     Path:   ') + chalk.cyan(distArtifact.path));
        console.log(chalk.dim('     Size:   ') + formatBytes(distSize));
        console.log(chalk.dim('     SHA256: ') + chalk.yellow(distSHA));
        console.log('');
        if (distArtifact.kind === 'ios-ipa') {
          console.log(chalk.dim('     Upload with:'));
          console.log(chalk.dim(`       xcrun altool --upload-app -f ${distArtifact.path} -t ios \\`));
          console.log(chalk.dim(`         --apiKey <KEY> --apiIssuer <ISSUER>`));
          console.log(chalk.dim('     or via Transporter.app / Xcode Organizer.'));
        } else if (distArtifact.kind === 'android-aab') {
          console.log(chalk.dim('     Upload via Play Console → Production/Testing track, or:'));
          console.log(chalk.dim(`       bundletool validate --bundle=${distArtifact.path}`));
        }
      } else if (opts.skipDistribution) {
        console.log('');
        console.log(chalk.yellow('  ⚠️  Distribution build was skipped (--skip-distribution).'));
        console.log(chalk.dim('     Run `sankofa dist ' + platform + '` when you need the signed store binary.'));
      }

      // ── Sankofa Catch — symbol artifact uploads (M10) ──
      // Tied to this release's label so the symbolicator worker can
      // pick the right artifact when resolving events for it. Any
      // upload flag that maps to a missing path is skipped with a
      // warning rather than failing the whole release.
      const anyUpload = opts.uploadSourcemaps || opts.uploadDsym ||
        opts.uploadMapping || opts.uploadNdk || opts.uploadDartSymbols;
      if (anyUpload) {
        console.log('');
        console.log(chalk.bold('  🦋 Catch symbol uploads'));
        const symSpinner = ora('Uploading symbols…').start();
        try {
          const uploaded: UploadedArtifact[] = [];
          const warnings: string[] = [];
          const releaseLabel = release.label;

          // Native symbol manifests — the server's iOS dSYM + NDK
          // resolver expects a pre-computed JSON manifest, not a raw
          // Mach-O / ELF. `sankofa catch make-*-manifest` produces
          // one; here we run the same conversion inline so customers
          // can drop a raw .dSYM bundle / .so into --upload-dsym /
          // --upload-ndk and get readable stacks with zero extra
          // steps. The manifest is written to a tmp file and that
          // path is what gets uploaded.
          const convertDSymIfNeeded = (p: string): string => {
            // Already a manifest? Leave it alone.
            if (p.endsWith('.manifest.json')) return p;
            // Bundle or raw Mach-O — convert.
            const manifest = buildDSymManifest({ dsymPath: p });
            const out = path.join(
              os.tmpdir(),
              `sankofa-dsym-${manifest.debug_id}.manifest.json`,
            );
            writeManifest(manifest, out);
            return out;
          };
          const convertNDKIfNeeded = (p: string): string => {
            if (p.endsWith('.manifest.json')) return p;
            const manifest = buildNDKManifest({ soPath: p });
            const out = path.join(
              os.tmpdir(),
              `sankofa-ndk-${manifest.debug_id}.manifest.json`,
            );
            writeManifest(manifest, out);
            return out;
          };

          const uploadOne = async (kindLabel: string, filePath: string, kind: Parameters<typeof uploadCatchSymbol>[0]['kind']) => {
            try {
              // If the path is a directory, fan out via the dir helper;
              // the single-file path also works for files directly.
              const isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();

              // Native kinds auto-convert raw binaries → manifest
              // before upload. For dSYM we also accept the .dSYM
              // bundle (a directory), which resolveDSymBinary
              // handles. For NDK the caller should pass a single
              // .so OR a directory (the dir walker will iterate).
              if (!isDir && kind === 'ios_dsym') {
                filePath = convertDSymIfNeeded(filePath);
              } else if (isDir && kind === 'ios_dsym') {
                // A .dSYM bundle is technically a directory — detect
                // that shape and convert rather than treat it as a
                // "directory of dSYMs".
                const looksLikeBundle = fs.existsSync(
                  path.join(filePath, 'Contents', 'Resources', 'DWARF'),
                );
                if (looksLikeBundle) {
                  filePath = convertDSymIfNeeded(filePath);
                  const single = await uploadCatchSymbol({
                    filePath,
                    kind,
                    environment,
                    release: releaseLabel,
                  });
                  if (single) uploaded.push(single);
                  return;
                }
              }
              if (!isDir && kind === 'android_ndk') {
                // Raw .so? Convert; anything else (already a manifest)
                // goes through untouched.
                if (filePath.endsWith('.so') || filePath.endsWith('.so.debug')) {
                  filePath = convertNDKIfNeeded(filePath);
                }
              }
              if (isDir) {
                // Heuristic per kind — narrow the file pattern to cut
                // through the junk directories bundlers drop beside
                // source maps (asset manifests, stats files, etc.).
                const pattern =
                  kind === 'js_sourcemap' ? /\.map$/ :
                  kind === 'ios_dsym' ? /\.dSYM(\.zip)?$/i :
                  kind === 'android_mapping' ? /mapping\.txt$/i :
                  kind === 'android_ndk' ? /\.(so|so\.debug)$/ :
                  kind === 'flutter_symbols' ? /\.symbols(\.zip)?$/i :
                  /.*/;
                const { uploaded: found, skipped } = await uploadSymbolsDirectory({
                  dir: filePath,
                  kind: kind!,
                  environment,
                  release: releaseLabel,
                  filePattern: pattern,
                });
                uploaded.push(...found);
                if (found.length === 0) {
                  warnings.push(
                    `${kindLabel}: no files matched in ${filePath} (skipped: ${skipped.length})`,
                  );
                }
              } else {
                const art = await uploadCatchSymbol({
                  filePath,
                  kind,
                  environment,
                  release: releaseLabel,
                  allowMissing: true,
                });
                if (art) uploaded.push(art);
                else warnings.push(`${kindLabel}: ${filePath} not found — skipped`);
              }
            } catch (e: any) {
              warnings.push(`${kindLabel}: ${e.message}`);
            }
          };

          if (opts.uploadSourcemaps) await uploadOne('sourcemaps', opts.uploadSourcemaps, 'js_sourcemap');
          if (opts.uploadDsym) await uploadOne('dSYM', opts.uploadDsym, 'ios_dsym');
          if (opts.uploadMapping) await uploadOne('mapping', opts.uploadMapping, 'android_mapping');
          if (opts.uploadNdk) await uploadOne('NDK', opts.uploadNdk, 'android_ndk');
          if (opts.uploadDartSymbols) await uploadOne('Dart symbols', opts.uploadDartSymbols, 'flutter_symbols');

          symSpinner.succeed(`Uploaded ${uploaded.length} symbol artifact${uploaded.length === 1 ? '' : 's'}`);
          for (const art of uploaded) {
            console.log(chalk.dim(`     • ${art.kind.padEnd(16)} ${art.original_name}  (${art.id.slice(0, 12)})`));
          }
          for (const w of warnings) {
            console.log(chalk.yellow(`     ⚠ ${w}`));
          }
        } catch (e: any) {
          symSpinner.fail(`Symbol upload failed: ${e.message}`);
          // Don't fail the release — symbols are a nice-to-have
          // side-effect; the binary/OTA is what's already landed.
        }
      }

      console.log('');
    } catch (err: any) {
      uploadSpinner.fail(`Upload failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── Flutter release ───────────────────────────────────────────────────────────

export async function flutterRelease(
  project: ProjectInfo,
  platformArg: string | undefined,
  opts: any,
) {
  const chalk = (await import('chalk')).default;
  const ora = (await import('ora')).default;
  const inquirer = (await import('inquirer')).default;

  // Platform — explicit positional required for parity with RN. iOS is
  // Phase 6 and refused up-front so users don't waste a build cycle.
  const platform = await resolveFlutterPlatform(platformArg);

  let environment;
  let rollout;
  try {
    environment = await resolveEnvironmentPrompt(opts.env);
    rollout = parseRollout(opts.rollout);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  if (opts.apk && opts.appbundle) {
    console.error(chalk.red('  ✖ --apk and --appbundle are mutually exclusive.'));
    process.exit(1);
  }

  // 1. Build the AAB (Play Store deployable) + APK (for libapp.so extraction)
  //    + extract libapp.so + AndroidManifest + flutter_assets.
  const format: 'aab' | 'apk' = opts.apk ? 'apk' : 'aab';
  const buildSpinner = ora(
    `Building Flutter ${format.toUpperCase()} + APK (release, arm64-v8a)...`,
  ).start();
  let built;
  try {
    built = buildFlutterAOT(project.root, {
      outputDir: opts.outputDir || './build',
      keepApk: true,
      verbose: false,
      format,
    });
    buildSpinner.succeed(
      `Built ${format.toUpperCase()}${format === 'aab' ? ' + APK' : ''} + extracted libapp.so (${formatBytes(statSync(built.libappPath).size)})`,
    );
  } catch (err: any) {
    buildSpinner.fail(`Flutter build failed: ${err.message}`);
    process.exit(1);
  }

  // Engine trust check — verify the libflutter.so inside the APK was
  // built by Sankofa CI. Refuses the release with an actionable error
  // if the SHA isn't in the server's known-engines registry. Skipped
  // on --dry-run since the registry lives on the server.
  let engineVersion = built.engine.sankofaEngineVersion;
  if (!opts.dryRun) {
    const trustSpinner = ora(
      `Verifying engine identity (libflutter.so SHA ${built.libflutterSha256.slice(0, 12)}…)…`,
    ).start();
    try {
      const { findEngineBySha } = await import('../utils/engineRegistry.js');
      const known = await findEngineBySha(built.libflutterSha256);
      if (!known) {
        trustSpinner.fail(
          `libflutter.so is not a known Sankofa engine — refusing to publish.`,
        );
        console.log('');
        console.log(chalk.red('  ✖ The libflutter.so embedded in your APK was NOT built by Sankofa CI.'));
        console.log('');
        console.log(chalk.dim('     SHA256:'));
        console.log(chalk.dim(`       ${built.libflutterSha256}`));
        console.log(chalk.dim(`     Size:`));
        console.log(chalk.dim(`       ${formatBytes(built.libflutterSizeBytes)}`));
        console.log('');
        console.log(chalk.dim('     Publishing this release would crash every customer device on patch'));
        console.log(chalk.dim('     download — Flutter Code patches require the Sankofa engine fork.'));
        console.log('');
        console.log(chalk.bold('  Fix:'));
        console.log(chalk.dim(`     1. Install the Sankofa engine for your Flutter version:`));
        console.log(chalk.cyan(`        sankofa engine download`));
        console.log(chalk.dim(`     2. Re-run \`flutter build\` so the new engine is bundled.`));
        console.log(chalk.dim(`     3. Re-run \`sankofa release ${platformArg || 'android'}\`.`));
        console.log('');
        process.exit(1);
      }
      if (!known.is_modified) {
        trustSpinner.warn(
          `libflutter.so is a Sankofa baseline (vanilla ${known.flutter_version}) — Flutter Code patches won't load on devices running it.`,
        );
        console.log(chalk.yellow(
          `     ⚠ This engine is a vanilla Flutter baseline (no \`+sankofa-N\` modifications).`,
        ));
        console.log(chalk.yellow(
          `       Devices running it cannot load OTA patches; only modified engines support libapp.so swap.`,
        ));
        console.log(chalk.dim(`       Continuing — but the release will be tagged as \`${known.sankofa_engine_version}\` and devices that install it won't accept patches.`));
      } else {
        trustSpinner.succeed(
          `Engine verified — ${chalk.bold(known.sankofa_engine_version)} (${known.target} ${known.abi})`,
        );
      }
      // Use the registry-confirmed version so the release row matches
      // the actual engine bytes, not the local `flutter --version`
      // heuristic.
      engineVersion = known.sankofa_engine_version;
    } catch (err: any) {
      trustSpinner.fail(`Engine verification failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log(chalk.dim('  · Skipping engine verification (--dry-run)'));
  }

  const appVersion = built.appVersion;
  const label = `v${appVersion}`;

  // 2. Refuse if a flutter-code release already exists for this version +
  //    engine combination. Direct user to `sankofa patch` instead. Skipped
  //    on --dry-run (we never want to touch the server in that mode).
  if (!opts.dryRun) {
    const checkSpinner = ora('Checking for existing baseline release...').start();
    try {
      const releases = await listReleases(environment, platform);
      const conflict = releases.find((r: any) =>
        (r.runtime === 'flutter-code' || r.runtime === 'flutter_code') &&
        r.target_binary_version === appVersion &&
        r.engine_version === engineVersion,
      );
      if (conflict) {
        checkSpinner.fail(
          `A baseline release already exists for ${chalk.bold(appVersion)} + ${chalk.bold(engineVersion)}: ${chalk.dim(conflict.label)}.`,
        );
        console.log('');
        console.log(chalk.dim('  Use one of:'));
        console.log(chalk.dim(`    • Hot-patch:               ${chalk.cyan('sankofa patch')}`));
        console.log(chalk.dim(`    • Bump pubspec version and rerun  ${chalk.cyan('sankofa release')}`));
        process.exit(1);
      }
      checkSpinner.succeed('No existing baseline — safe to create');
    } catch (err: any) {
      checkSpinner.fail(`Could not check existing releases: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log(chalk.dim('  · Skipping server check (--dry-run)'));
  }

  // 3. Capture the Diff Guard baseline snapshot. Done BEFORE the upload
  //    so we never have a published release without a corresponding
  //    on-disk baseline.
  const baselineSpinner = ora('Capturing Diff Guard baseline...').start();
  const libappSha = computeSHA256(built.libappPath);
  const baselineManifest: BaselineManifest = {
    version: 1,
    stack: 'flutter',
    releaseLabel: label,
    targetBinaryVersion: appVersion,
    engineVersion,
    payloadSha256: libappSha,
    capturedAt: new Date().toISOString(),
  };
  try {
    captureFlutterBaseline({
      projectRoot: project.root,
      androidManifestPath: built.apkContentsDir
        ? join(built.apkContentsDir, 'AndroidManifest.xml')
        : '',
      flutterAssetsDir: built.apkContentsDir
        ? join(built.apkContentsDir, 'assets', 'flutter_assets')
        : '',
      manifest: baselineManifest,
    });
    baselineSpinner.succeed('Baseline captured at .sankofa/baseline/');
  } catch (err: any) {
    baselineSpinner.fail(`Baseline capture failed: ${err.message}`);
    process.exit(1);
  }

  const libappSize = getFileSize(built.libappPath);
  console.log(chalk.dim(`  Label:            ${label}`));
  console.log(chalk.dim(`  Engine version:   ${engineVersion}`));
  console.log(chalk.dim(`  Target binary:    ${appVersion}`));
  console.log(chalk.dim(`  libapp.so SHA256: ${libappSha}`));
  console.log(chalk.dim(`  libapp.so size:   ${formatBytes(libappSize)}`));

  // 4. --dry-run: stop here, baseline is captured, nothing to upload.
  if (opts.dryRun) {
    console.log('');
    console.log(chalk.green.bold('  ✓ Dry-run complete'));
    if (built.aabPath) {
      console.log('');
      console.log(chalk.bold('  🏬 Store binary — Android AAB (Play Store)'));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(built.aabPath));
      console.log(chalk.dim('     Size:   ') + formatBytes(statSync(built.aabPath).size));
      console.log(chalk.dim('     Contains: Sankofa updater (libsankofa_updater_ffi.so) + OTA wiring'));
      console.log(chalk.dim('     Upload via Play Console → Production/Testing track'));
    } else if (built.apkPath) {
      console.log('');
      console.log(chalk.bold('  📦 Store binary — Android APK (sideload)'));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(built.apkPath));
      console.log(chalk.dim('     Size:   ') + formatBytes(statSync(built.apkPath).size));
    }
    console.log('');
    console.log(chalk.dim('     Baseline saved to .sankofa/baseline/'));
    console.log(chalk.dim('     Future `sankofa patch` runs will Diff-Guard against this snapshot.'));
    console.log(chalk.dim('     Re-run without --dry-run to publish the release to Sankofa.'));
    console.log('');
    return;
  }

  // 5. Confirm publish.
  let shouldPublish = opts.publish;
  if (!shouldPublish) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Publish ${chalk.bold(label)} as the Flutter Code baseline for ${chalk.bold(appVersion)}?`,
        default: true,
      },
    ]);
    shouldPublish = confirm;
  }

  if (!shouldPublish) {
    console.log(chalk.dim('Release cancelled. Baseline snapshot kept on disk for next attempt.'));
    return;
  }

  // 5. Upload as runtime=flutter-code, no base release — this IS the base.
  const uploadSpinner = ora('Uploading libapp.so to Sankofa...').start();
  try {
    const release = await uploadRelease(built.libappPath, {
      label,
      target_binary_version: appVersion,
      platform,
      description: opts.description || `Flutter Code baseline ${label}`,
      is_mandatory: opts.mandatory || false,
      rollout_percentage: rollout,
      environment,
      runtime: 'flutter-code',
      engine_version: engineVersion,
    });
    uploadSpinner.succeed('libapp.so uploaded');

    console.log('');
    console.log(chalk.green.bold('  🚀 Flutter Code baseline released'));
    console.log(chalk.dim(`     Label:           ${release.label}`));
    console.log(chalk.dim(`     Runtime:         ${release.runtime}`));
    console.log(chalk.dim(`     Engine:          ${release.engine_version}`));
    console.log(chalk.dim(`     Target binary:   ${release.target_binary_version}`));
    console.log(chalk.dim(`     Rollout:         ${release.rollout_percentage}%`));
    console.log(chalk.dim(`     Release ID:      ${release.id}`));

    // The deployable store artifact: AAB for Play Store, APK as fallback.
    // This is the ONE artifact the customer should submit. Built fresh
    // by `sankofa release` so we can guarantee it has the Sankofa engine
    // fork's libflutter.so + the OTA wiring. Raw `flutter build` would
    // also include them (via the sankofa_deploy plugin's jniLibs), but
    // without `sankofa release` there's no server-side baseline = no
    // OTA can reach the published app. So this command is the source of
    // truth for production releases.
    if (built.aabPath) {
      console.log('');
      console.log(chalk.bold('  🏬 Store binary — Android AAB (Play Store)'));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(built.aabPath));
      console.log(chalk.dim('     Size:   ') + formatBytes(statSync(built.aabPath).size));
      console.log(chalk.dim('     Contains: Sankofa updater (libsankofa_updater_ffi.so) + OTA wiring'));
      console.log('');
      console.log(chalk.dim('     ↑ This is your deployable. Upload to Play Console → Production/Testing track.'));
      console.log(chalk.dim('       Do not submit anything from raw `flutter build` — only this AAB is registered for OTA.'));
    } else if (built.apkPath) {
      console.log('');
      console.log(chalk.bold('  📦 Store binary — Android APK (sideload)'));
      console.log(chalk.dim('     Path:   ') + chalk.cyan(built.apkPath));
      console.log(chalk.dim('     Size:   ') + formatBytes(statSync(built.apkPath).size));
      console.log(chalk.dim('     For Play Store, rerun with default `--format aab`.'));
    }

    console.log('');
    console.log(chalk.dim('  Future hot-patches: ') + chalk.cyan('sankofa patch'));
    console.log(chalk.dim('  Diff Guard will refuse patches that change AndroidManifest, flutter_assets, or add new native bindings.'));
    console.log('');
  } catch (err: any) {
    uploadSpinner.fail(`Upload failed: ${err.message}`);
    process.exit(1);
  }
}
