import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, posix } from 'path';

/**
 * Discover a Flutter app's PATCHABLE SURFACE — the set of its own libraries
 * that may safely be named in `sankofa_dynamic_interface.yaml`.
 *
 * Why this is an import-graph walk and not a `lib/**` glob
 * ────────────────────────────────────────────────────────
 * The compiler resolves every `library:` entry through
 * `LibraryIndex.all(component)` and throws
 * `"The library '<uri>' has not been indexed"` on a miss
 * (front_end/lib/src/kernel/dynamic_module_validator.dart → kernel/library_index.dart).
 * That index contains ONLY libraries present in the compiled component, so:
 *
 *   - a file under lib/ that nothing imports is NOT in the component → naming
 *     it is a hard build failure, even though the file plainly exists on disk;
 *   - a `part of` file is never its own library → same hard failure;
 *   - a conditional import compiles exactly one variant → the other is absent.
 *
 * So the rule this module follows is: **emit only what we can prove the build
 * will contain.** A missing entry costs patchability; a wrong entry costs the
 * whole build. We err toward omission every time.
 *
 * Flavored apps compile ONE entrypoint per build, so a library reachable only
 * from `main_dev.dart` is absent from a `prod` build. The scan therefore emits
 * the INTERSECTION across every discovered entrypoint — the set valid for any
 * flavor — and reports the per-entrypoint remainder separately so the caller
 * can surface it rather than silently dropping it.
 */

export interface LibraryScanResult {
  /** lib-relative paths of the entrypoints found (e.g. `main_prod.dart`). */
  entrypoints: string[];
  /** `package:` URIs reachable from EVERY entrypoint — safe for any flavor. */
  libraries: string[];
  /** Reachable from some but not all entrypoints → unsafe to emit unconditionally. */
  flavorSpecific: { uri: string; reachableFrom: string[] }[];
  /** `part of` files skipped (they are not libraries). */
  partFiles: number;
  /** Conditional-import URIs skipped — we cannot prove which variant compiles. */
  conditional: string[];
  /** Imports that resolved to a file that does not exist on disk. */
  missing: string[];
}

/** Strip comments so directive matching can't trip over commented-out imports. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Resolve a Dart import URI against the importing library's `package:` URI,
 * mirroring `Uri.resolve` (verified against the Dart VM for the shapes that
 * occur in real apps: `package:`, `dart:`, `foo/bar.dart`, `./sib.dart`,
 * `../up.dart`, and the root-relative `/app.dart` form).
 *
 * Returns null for anything outside the app's own package — external packages
 * and `dart:` libraries are not part of the app's patchable surface.
 */
export function resolveOwnPackageUri(
  selfUri: string,
  rawUri: string,
  packageName: string,
): string | null {
  const prefix = `package:${packageName}/`;
  if (rawUri.startsWith('dart:')) return null;
  if (rawUri.startsWith('package:')) {
    return rawUri.startsWith(prefix) ? rawUri : null;
  }
  if (!selfUri.startsWith(prefix)) return null;
  const selfPath = selfUri.slice(prefix.length);

  // Root-relative (`/app.dart`) replaces the path entirely, keeping the package.
  if (rawUri.startsWith('/')) return prefix + rawUri.slice(1);

  const dir = posix.dirname(selfPath);
  const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, rawUri));
  // A `../` that climbs above lib/ escapes the package — not addressable.
  if (joined.startsWith('..')) return null;
  return prefix + joined;
}

interface Directives {
  isPart: boolean;
  imports: { uri: string; conditional: boolean }[];
}

function parseDirectives(src: string): Directives {
  const clean = stripComments(src);
  const isPart = /^\s*part\s+of\b/m.test(clean);
  const imports: { uri: string; conditional: boolean }[] = [];

  // `import`/`export` pull in another library; `part` pulls in a file that is
  // NOT a library of its own but (with enhanced parts) may carry imports, so
  // we still traverse it — `isPart` keeps it out of the emitted list.
  const re = /^\s*(import|export|part)\s+(['"])([^'"]+)\2([^;]*);/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const [, kind, , uri, tail] = m;
    if (kind === 'part' && /^\s*of\b/.test(tail)) continue;
    imports.push({ uri, conditional: /\bif\s*\(/.test(tail) });
  }
  return { isPart, imports };
}

/** Every `.dart` file under lib/, lib-relative, posix-separated. */
function listDartFiles(libRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.dart')) out.push(relative(libRoot, full).split(/[\\/]/).join('/'));
    }
  };
  walk(libRoot);
  return out;
}

/**
 * Locate the app's entrypoints — files declaring a top-level `main()`.
 * Covers `lib/main.dart`, the per-flavor `lib/main_*.dart` convention, and any
 * other location, since neither is guaranteed.
 */
export function findEntrypoints(projectRoot: string): string[] {
  const libRoot = join(projectRoot, 'lib');
  if (!existsSync(libRoot)) return [];
  const found: string[] = [];
  for (const rel of listDartFiles(libRoot)) {
    let src: string;
    try {
      src = stripComments(readFileSync(join(libRoot, rel), 'utf-8'));
    } catch {
      continue;
    }
    // Top-level (column-0) `main(`, optionally typed / async. Anchoring at the
    // line start keeps class methods named `main` from counting.
    if (/^(?:(?:void|dynamic|Future<void>|Future)\s+)?main\s*\(/m.test(src)) {
      found.push(rel);
    }
  }
  // Deterministic, and puts the conventional entrypoint first.
  found.sort((a, b) => (a === 'main.dart' ? -1 : b === 'main.dart' ? 1 : a.localeCompare(b)));
  return found;
}

/** Transitive own-package closure from one entrypoint. */
function closureFrom(
  projectRoot: string,
  packageName: string,
  entryRel: string,
  acc: { partFiles: Set<string>; conditional: Set<string>; missing: Set<string> },
): Set<string> {
  const prefix = `package:${packageName}/`;
  const libRoot = join(projectRoot, 'lib');
  const seen = new Set<string>();
  const libraries = new Set<string>();
  const queue = [prefix + entryRel];

  while (queue.length > 0) {
    const uri = queue.shift()!;
    if (seen.has(uri)) continue;
    seen.add(uri);

    const rel = uri.slice(prefix.length);
    const file = join(libRoot, rel);
    if (!existsSync(file)) {
      acc.missing.add(uri);
      continue;
    }
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      acc.missing.add(uri);
      continue;
    }

    const { isPart, imports } = parseDirectives(src);
    if (isPart) acc.partFiles.add(uri);
    else libraries.add(uri);

    for (const imp of imports) {
      const resolved = resolveOwnPackageUri(uri, imp.uri, packageName);
      if (!resolved) continue; // dart: / external package — not our surface
      if (imp.conditional) {
        // Exactly one variant survives compilation and we cannot tell which
        // from source alone. Skipping costs patchability; guessing costs the build.
        acc.conditional.add(resolved);
        continue;
      }
      queue.push(resolved);
    }
  }
  return libraries;
}

/**
 * Scan a Flutter project for the libraries safe to declare as its patchable
 * surface. Returns empty `libraries` (never throws) when there is nothing to
 * scan, so callers can fall back to skipping the scaffold.
 */
export function scanPatchableLibraries(
  projectRoot: string,
  packageName: string,
): LibraryScanResult {
  const acc = {
    partFiles: new Set<string>(),
    conditional: new Set<string>(),
    missing: new Set<string>(),
  };
  const entrypoints = findEntrypoints(projectRoot);
  const empty: LibraryScanResult = {
    entrypoints,
    libraries: [],
    flavorSpecific: [],
    partFiles: 0,
    conditional: [],
    missing: [],
  };
  if (entrypoints.length === 0) return empty;

  const perEntry = new Map<string, Set<string>>();
  for (const entry of entrypoints) {
    perEntry.set(entry, closureFrom(projectRoot, packageName, entry, acc));
  }

  // Intersection = valid for EVERY flavor build. Anything reachable from only
  // some entrypoints is absent from the others' components, so emitting it
  // unconditionally would break exactly the builds it isn't part of.
  const all = new Set<string>();
  for (const set of perEntry.values()) for (const uri of set) all.add(uri);

  const common: string[] = [];
  const flavorSpecific: { uri: string; reachableFrom: string[] }[] = [];
  for (const uri of all) {
    const reachableFrom = entrypoints.filter((e) => perEntry.get(e)!.has(uri));
    if (reachableFrom.length === entrypoints.length) common.push(uri);
    else flavorSpecific.push({ uri, reachableFrom });
  }

  common.sort();
  flavorSpecific.sort((a, b) => a.uri.localeCompare(b.uri));
  return {
    entrypoints,
    libraries: common,
    flavorSpecific,
    partFiles: acc.partFiles.size,
    conditional: [...acc.conditional].sort(),
    missing: [...acc.missing].sort(),
  };
}

/** Render the scan as a ready-to-write `sankofa_dynamic_interface.yaml`. */
export function renderDynamicInterfaceYaml(scan: LibraryScanResult): string {
  const items = scan.libraries.map((l) => `  - library: '${l}'`).join('\n');
  const entryLines =
    scan.entrypoints.length > 0
      ? scan.entrypoints.map((e) => `#   lib/${e}\n`).join('')
      : '#   (none found)\n';

  let header =
    `# Sankofa Deploy — your app's PATCHABLE SURFACE.\n` +
    `#\n` +
    `# Passed to the compiler as --dynamic-interface. It keeps the code an OTA\n` +
    `# patch may call from being tree-shaken out of the release build, so a\n` +
    `# patch can resolve those references on device.\n` +
    `#\n` +
    `# GENERATED by \`sankofa init\` from your import graph, walking every\n` +
    `# entrypoint:\n` +
    entryLines +
    `#\n` +
    `# and keeping only the libraries reachable from ALL of them — a flavored\n` +
    `# build compiles ONE entrypoint, so a library reachable from only some\n` +
    `# would be missing from the other flavors' builds.\n` +
    `#\n` +
    `# A library listed here that is not in the compiled program FAILS the build\n` +
    `# ("The library '...' has not been indexed"). Regenerate after adding or\n` +
    `# removing files: delete this file and re-run \`sankofa init --deploy\`.\n` +
    `#\n` +
    `# Trim entries you never intend to patch — every listed library keeps its\n` +
    `# public members out of tree-shaking, which grows the binary.\n` +
    `#\n` +
    `#   callable:          may be CALLED from a patch\n` +
    `#   extendable:        may be SUBCLASSED by a patch\n` +
    `#   can-be-overridden: its methods may be OVERRIDDEN by a patch\n`;

  if (scan.flavorSpecific.length > 0) {
    header +=
      `#\n` +
      `# NOT included — reachable from only some entrypoints. Uncomment only if\n` +
      `# you build exclusively the flavor(s) noted, or the other builds will fail:\n`;
    for (const f of scan.flavorSpecific) {
      header += `#   ${f.uri}  (only via ${f.reachableFrom.map((e) => `lib/${e}`).join(', ')})\n`;
    }
  }
  if (scan.conditional.length > 0) {
    header +=
      `#\n` +
      `# NOT included — behind a conditional import, so which variant compiles\n` +
      `# depends on the target platform:\n`;
    for (const uri of scan.conditional) header += `#   ${uri}\n`;
  }

  return (
    `${header}\n` +
    `callable:\n${items}\n\n` +
    `extendable:\n${items}\n\n` +
    `can-be-overridden:\n${items}\n`
  );
}

/**
 * Check an EXISTING dynamic-interface file for own-package `library:` entries
 * that no longer resolve to a real, reachable library. These are the entries
 * that fail the build, and the reason a project scaffolded before this scan
 * existed (which hardcoded `main.dart`) breaks on the first release build.
 */
export function findStaleInterfaceEntries(
  yamlText: string,
  packageName: string,
  scan: LibraryScanResult,
): string[] {
  const prefix = `package:${packageName}/`;
  const reachable = new Set([
    ...scan.libraries,
    ...scan.flavorSpecific.map((f) => f.uri),
    ...scan.conditional,
  ]);
  const stale = new Set<string>();
  const re = /^\s*-?\s*library:\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yamlText)) !== null) {
    const uri = m[1];
    // Only judge the app's OWN libraries: `dart:` and third-party `package:`
    // entries are outside what this scan can see.
    if (!uri.startsWith(prefix)) continue;
    if (!reachable.has(uri)) stale.add(uri);
  }
  return [...stale].sort();
}
