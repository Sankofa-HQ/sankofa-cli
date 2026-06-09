/**
 * `sankofa kbc build` — Sankofa Deploy: Flutter Code KBC patch producer.
 *
 * Compiles a single Dart entry-point file into a `.kbc` bytecode patch
 * runnable by the Sankofa β.1 Flutter engine on iOS. The output is a
 * raw KBC file (β.4 envelope wrapping is separate) ready to drop into
 * `<App Documents>/sankofa-deploy/patches/active/patch.kbc` for manual
 * device testing, or to be uploaded via `sankofa patch ios` once that
 * pipeline lands.
 *
 * Defaults follow project convention:
 *   - Entry file: lib/sankofa_patch.dart (single file; multi-file
 *     bundles via imports are supported via dart2bytecode natively)
 *   - Dynamic interface: sankofa/dynamic_interface.yaml (if present;
 *     skipped otherwise)
 *   - Output: build/sankofa-deploy/patch.kbc
 *
 * Why a standalone command before integrating into `sankofa patch ios`:
 * γ v0 is a producer-only spike. Server upload + diff-guard come later
 * once we've stabilized the envelope format (β.4) and the host-side
 * apply API (η). Until then, founders run this manually + drop the
 * .kbc on-device to exercise the interpreter pipeline.
 *
 * See sankofa-flutter-deploy/docs/build-log-interpreter-program.md
 * (β.3 + ε spike entries) for the architectural rationale.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { buildKbcPatch } from '../utils/flutterKbcBundler.js';
import {
  ENVELOPE_VERSION,
  parseKbcEnvelope,
  wrapKbc,
  type KbcEnvelopeMetadata,
} from '../utils/flutterKbcEnvelope.js';

// Advanced patch tooling. Hidden from `sankofa --help` because 99%
// of customers should use `sankofa patch` instead — these are the
// low-level build/wrap/inspect steps `patch` orchestrates internally.
// Still callable as `sankofa kbc <subcommand>` for power users and
// CI scripts that need fine-grained control.
export const kbcCommand = new Command('kbc')
  .description('Advanced: low-level Flutter patch tooling (compile, package, inspect)')
  .addCommand(
    new Command('build')
      .description('Compile a Dart entry-point file into a Sankofa patch')
      .option(
        '-e, --entry-file <file>',
        'Dart entry-point file (single @pragma("dyn-module:entry-point") fn)',
        'lib/sankofa_patch.dart',
      )
      .option(
        '-o, --output <file>',
        'Output .kbc path',
        'build/sankofa-deploy/patch.kbc',
      )
      .option(
        '-i, --dynamic-interface <yaml>',
        'Optional dynamic_interface.yaml to --validate the patch against',
      )
      .option(
        '--project <path>',
        'Project root (defaults to current directory)',
      )
      .option(
        '--bytecode-options <csv>',
        'CSV of options passed through to dart2bytecode --bytecode-options',
      )
      .action(async (opts: any) => {
        const chalk = (await import('chalk')).default;
        const projectRoot = resolve(opts.project ?? process.cwd());
        const entryFile = resolve(projectRoot, opts.entryFile);
        const outputPath = resolve(projectRoot, opts.output);

        // Resolve default --dynamic-interface from project convention if
        // not provided explicitly.
        let dynamicInterface: string | undefined = opts.dynamicInterface
          ? resolve(projectRoot, opts.dynamicInterface)
          : undefined;
        if (!dynamicInterface) {
          const conventional = join(
            projectRoot,
            'sankofa',
            'dynamic_interface.yaml',
          );
          if (existsSync(conventional)) {
            dynamicInterface = conventional;
            console.log(
              chalk.dim(`  · Using conventional interface ${conventional}`),
            );
          }
        }

        if (!existsSync(entryFile)) {
          console.error(chalk.red(`  ✖ Patch entry file not found: ${entryFile}`));
          console.error(
            chalk.dim(
              `     Create it with a single @pragma('dyn-module:entry-point') function:\n` +
                `        @pragma('dyn-module:entry-point')\n` +
                `        Object? main() => 'sankofa patch v1';\n`,
            ),
          );
          process.exit(2);
        }

        // Ensure output dir exists.
        mkdirSync(dirname(outputPath), { recursive: true });

        const startedAt = Date.now();
        let result;
        try {
          result = buildKbcPatch({
            entryFile,
            outputPath,
            validateYaml: dynamicInterface,
            bytecodeOptions: opts.bytecodeOptions,
          });
        } catch (err: any) {
          console.error(chalk.red(`  ✖ Build failed:\n${err.message}`));
          process.exit(1);
        }
        const elapsedMs = Date.now() - startedAt;

        console.log('');
        console.log(chalk.bold('─── Patch compiled ───'));
        console.log(`  Entry file         ${entryFile}`);
        console.log(
          `  Dynamic interface  ${
            result.validatedAgainst ?? chalk.dim('(none — patch may only use language primitives)')
          }`,
        );
        console.log(`  Output             ${result.outputPath}`);
        console.log(`  Size               ${result.sizeBytes} bytes`);
        console.log(
          `  Format check       ${
            result.magicOk ? chalk.green('✓ ok') : chalk.red('✗ mismatch')
          }`,
        );
        console.log(`  Flutter SDK        ${result.flutterDartSdk}`);
        console.log(`  Build time         ${elapsedMs} ms`);
        console.log('');
        if (!result.magicOk) {
          console.error(
            chalk.red(
              '  ✖ Format check failed — produced file is not a valid Sankofa patch. Aborting.',
            ),
          );
          process.exit(1);
        }
        console.log(chalk.green('  ✅ Patch ready.'));
        console.log('');
        console.log(chalk.bold('Next steps:'));
        console.log(
          chalk.dim(
            `  • Package + ship in one command:\n` +
              `      sankofa patch ios\n` +
              `  • Or, to package manually for later upload:\n` +
              `      sankofa kbc wrap -i ${result.outputPath} -o patch.skdp \\\n` +
              `        --label 'my-patch-v1' --rollout 100`,
          ),
        );
      }),
  )
  .addCommand(
    new Command('wrap')
      .description('Package a compiled patch into a signed-capable upload artifact')
      .requiredOption('-i, --input <file>', 'Path to raw .kbc input')
      .requiredOption(
        '-o, --output <file>',
        'Path to write envelope (.skdp by convention)',
      )
      .option('--label <label>', 'Free-form patch label')
      .option('--description <desc>', 'Free-form patch description')
      .option('--release-id <id>', 'Sankofa server release id')
      .option('--project-id <id>', 'Sankofa project id')
      .option(
        '--engine-commit <sha>',
        'Sankofa engine fork commit this patch targets',
      )
      .option(
        '--dart-version <semver>',
        'Dart SDK version this patch was built with (e.g. 3.11.5)',
      )
      .option(
        '--target-binary-version <semver>',
        'Target app binary version',
      )
      .option('--rollout <percent>', 'Rollout percentage (0-100)')
      .option('--mandatory', 'Force-update flag')
      .option(
        '--metadata-extra <json>',
        'JSON object merged into metadata (advanced)',
      )
      .action(async (opts: any) => {
        const chalk = (await import('chalk')).default;
        const inputPath = resolve(opts.input);
        const outputPath = resolve(opts.output);

        if (!existsSync(inputPath)) {
          console.error(chalk.red(`  ✖ Input not found: ${inputPath}`));
          process.exit(2);
        }

        const kbcBytes = readFileSync(inputPath);
        // Quick sanity: magic check (don't accept an envelope-of-envelope).
        if (
          kbcBytes.length < 4 ||
          kbcBytes[0] !== 0x33 ||
          kbcBytes[1] !== 0x43 ||
          kbcBytes[2] !== 0x42 ||
          kbcBytes[3] !== 0x44
        ) {
          console.error(
            chalk.red(`  ✖ Input is not a Sankofa-compiled patch.`),
          );
          console.error(
            chalk.dim(
              `     If it's already a packaged patch, use \`sankofa kbc inspect\` instead.`,
            ),
          );
          process.exit(1);
        }

        const meta: KbcEnvelopeMetadata = {
          createdAt: new Date().toISOString(),
        };
        if (opts.label) meta.label = String(opts.label);
        if (opts.description) meta.description = String(opts.description);
        if (opts.releaseId) meta.releaseId = String(opts.releaseId);
        if (opts.projectId) meta.projectId = String(opts.projectId);
        if (opts.engineCommit) meta.engineCommit = String(opts.engineCommit);
        if (opts.dartVersion) meta.dartVersion = String(opts.dartVersion);
        if (opts.targetBinaryVersion) {
          meta.targetBinaryVersion = String(opts.targetBinaryVersion);
        }
        if (opts.rollout !== undefined) {
          const r = Number(opts.rollout);
          if (Number.isNaN(r) || r < 0 || r > 100) {
            console.error(chalk.red(`  ✖ --rollout must be 0-100, got "${opts.rollout}".`));
            process.exit(1);
          }
          meta.rollout = r;
        }
        if (opts.mandatory) meta.mandatory = true;
        if (opts.metadataExtra) {
          try {
            const extra = JSON.parse(opts.metadataExtra);
            if (typeof extra !== 'object' || extra === null) {
              throw new Error('must be a JSON object');
            }
            Object.assign(meta, extra);
          } catch (err: any) {
            console.error(
              chalk.red(`  ✖ --metadata-extra parse failed: ${err.message}`),
            );
            process.exit(1);
          }
        }

        const envelope = wrapKbc({ kbcPayload: kbcBytes, metadata: meta });
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, envelope);

        console.log('');
        console.log(chalk.bold('─── Patch packaged ───'));
        console.log(`  Source patch     ${inputPath} (${kbcBytes.length} B)`);
        console.log(`  Output           ${outputPath}`);
        console.log(`  Output size      ${envelope.length} B`);
        console.log(`  Format version   v${ENVELOPE_VERSION} (unsigned)`);
        console.log(`  Metadata         ${JSON.stringify(meta)}`);
        console.log('');
        console.log(
          chalk.green('  ✅ Packaged patch ready. ') +
            chalk.dim(
              `Inspect any time: ${chalk.cyan(`sankofa kbc inspect ${outputPath}`)}`,
            ),
        );
      }),
  )
  .addCommand(
    new Command('inspect')
      .description('Parse + print a packaged Sankofa patch for debugging')
      .argument('<file>', 'Path to packaged patch (.skdp)')
      .option('--show-sha', 'Print full payload sha256 hex (default: short prefix)')
      .action(async (file: string, opts: any) => {
        const chalk = (await import('chalk')).default;
        const inputPath = resolve(file);
        if (!existsSync(inputPath)) {
          console.error(chalk.red(`  ✖ File not found: ${inputPath}`));
          process.exit(2);
        }
        const fileSize = statSync(inputPath).size;
        const bytes = readFileSync(inputPath);
        let parsed;
        try {
          parsed = parseKbcEnvelope(bytes);
        } catch (err: any) {
          console.error(chalk.red(`  ✖ ${err.message}`));
          process.exit(1);
        }

        const shaHex = parsed.payloadSha.toString('hex');
        const shaShown = opts.showSha ? shaHex : `${shaHex.slice(0, 16)}…`;

        const sigAlgName =
          parsed.sigAlg === 0
            ? 'unsigned'
            : parsed.sigAlg === 1
              ? 'Ed25519'
              : `unknown (${parsed.sigAlg})`;

        console.log(chalk.bold(`─── ${inputPath} ───`));
        console.log(`  File size          ${fileSize} B`);
        console.log(`  Format version     v${parsed.envelopeVersion}`);
        console.log(`  Flags              0x${parsed.flags.toString(16).padStart(4, '0')}`);
        console.log(`  Patch payload      ${parsed.kbcLength} B`);
        console.log(
          `  Payload sha-256    ${shaShown} ${
            parsed.payloadShaValid
              ? chalk.green('✓')
              : chalk.red('✗ MISMATCH — tampered or corrupt')
          }`,
        );
        console.log(`  Metadata size      ${parsed.metaLength} B`);
        console.log(`  Signature          ${sigAlgName} (${parsed.sigBytes.length} B)`);
        console.log('');
        console.log(chalk.bold('  Metadata:'));
        for (const [k, v] of Object.entries(parsed.metadata)) {
          console.log(`    ${k.padEnd(22)} ${JSON.stringify(v)}`);
        }
        console.log('');
        if (!parsed.payloadShaValid) {
          console.log(
            chalk.red(
              '  ⚠ payload sha mismatch — DO NOT load this on a device.',
            ),
          );
          process.exit(1);
        }
        // Sanity-check the KBC payload's magic too — catches the case
        // where someone wrapped the wrong file.
        const kp = parsed.kbcPayload;
        const kbcMagicOk =
          kp.length >= 4 &&
          kp[0] === 0x33 &&
          kp[1] === 0x43 &&
          kp[2] === 0x42 &&
          kp[3] === 0x44;
        if (!kbcMagicOk) {
          console.log(
            chalk.red(
              '  ⚠ KBC payload magic mismatch — envelope wraps non-KBC data.',
            ),
          );
          process.exit(1);
        }
        console.log(chalk.green('  ✅ Patch verified — safe to load.'));
      }),
  );
