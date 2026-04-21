import { Command } from 'commander';
import fs from 'node:fs';
import { join } from 'path';
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
import { uploadRelease } from '../utils/api.js';
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
import { resolveRNProjectRoot } from '../utils/project.js';
import { parseRollout } from '../utils/validation.js';

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
  .option('--android-format <fmt>', 'Android distribution format: aab (Play Store) or apk (sideload). Default: aab', 'aab')
  // ── Sankofa Catch symbol uploads (M10). Each flag takes a path
  //    (file or directory). Non-existent paths are skipped with a
  //    warning so the release flow isn't blocked by a missing artifact.
  .option('--upload-sourcemaps <path>', 'Upload JS source map(s) for this release (file or directory)')
  .option('--upload-dsym <path>', 'Upload iOS dSYM(s) for this release (file or directory of .zip bundles)')
  .option('--upload-mapping <path>', 'Upload Android ProGuard/R8 mapping.txt for this release')
  .option('--upload-ndk <path>', 'Upload Android NDK symbols for this release (directory of .so files)')
  .option('--upload-dart-symbols <path>', 'Upload Flutter/Dart symbol bundle for this release')
  .action(async (platformArg: string | undefined, opts) => {
    const chalk = (await import('chalk')).default;
    const ora = (await import('ora')).default;

    await requireAuth();

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

    try {
      const project = await resolveRNProjectRoot(opts.project);
      process.chdir(project.root);
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
