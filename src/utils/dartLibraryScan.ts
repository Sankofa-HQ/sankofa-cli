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
  /** Dependency libraries a patch may CALL (not redefine). callable-only. */
  externals: string[];
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

/**
 * Map `package:<name>/` → that package's lib/ directory on disk, from
 * `.dart_tool/package_config.json`.
 *
 * Dependencies are as provable as the app's own files: the file either exists
 * in the pub cache or it does not, and if an app library imports it, it IS in
 * the compiled component. So the "only emit what we can prove" rule holds for
 * them too — we just have to look somewhere other than `lib/`.
 *
 * Returns an empty map when the file is missing or malformed; callers then
 * degrade to own-package-only, which is the pre-existing behaviour.
 */
export function buildPackageLibMap(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const cfgPath = join(projectRoot, '.dart_tool', 'package_config.json');
  if (!existsSync(cfgPath)) return out;
  let cfg: { packages?: { name?: string; rootUri?: string; packageUri?: string }[] };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return out;
  }
  const base = join(projectRoot, '.dart_tool');
  for (const p of cfg.packages ?? []) {
    if (!p.name || !p.rootUri) continue;
    let root = p.rootUri;
    // rootUri is a file: URI, or a path relative to .dart_tool/.
    if (root.startsWith('file://')) {
      try {
        root = decodeURIComponent(new URL(root).pathname);
      } catch {
        continue;
      }
    } else {
      root = join(base, root);
    }
    out.set(p.name, join(root, (p.packageUri ?? 'lib/').replace(/\/$/, '')));
  }
  return out;
}

/**
 * Resolve an import/export URI to a `package:` URI, for ANY package.
 *
 * `resolveOwnPackageUri` deliberately drops dependencies, because they are not
 * part of the surface a patch may REDEFINE. But they are very much part of the
 * surface a patch may CALL: a patched function that constructs a `Dio` needs
 * `package:dio/src/dio.dart` resolvable on device, and without it the module
 * loader aborts the process (`Unable to find library …`, SIGABRT inside
 * `loadDynamicModule`). Those are two different questions and this answers the
 * second.
 */
export function resolveAnyPackageUri(
  selfUri: string,
  rawUri: string,
  ownPackage: string,
): string | null {
  if (rawUri.startsWith('dart:')) return null;
  if (rawUri.startsWith('package:')) return rawUri;
  // Relative — resolve against whichever package the importing library is in.
  const m = /^package:([^/]+)\/(.*)$/.exec(selfUri);
  if (!m) return null;
  const [, selfPkg, selfPath] = m;
  if (rawUri.startsWith('/')) return `package:${selfPkg}/${rawUri.slice(1)}`;
  const dir = posix.dirname(selfPath);
  const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, rawUri));
  if (joined.startsWith('..')) return null;
  return `package:${selfPkg}/${joined}`;
}

/** Absolute path for a `package:` URI, or null when the package is unknown. */
function packageUriToPath(
  uri: string,
  ownPackage: string,
  libRoot: string,
  pkgMap: Map<string, string>,
): string | null {
  const m = /^package:([^/]+)\/(.*)$/.exec(uri);
  if (!m) return null;
  const [, pkg, rel] = m;
  if (pkg === ownPackage) return join(libRoot, rel);
  const libDir = pkgMap.get(pkg);
  return libDir ? join(libDir, rel) : null;
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

/**
 * Export-only closure from a dependency library.
 *
 * A patch references the DEFINING library, not the facade: `Dio` is declared in
 * `package:dio/src/dio.dart` and merely re-exported by `package:dio/dio.dart`,
 * and it is the defining URI the module loader looks up. Following `export`
 * (not `import`) from each directly-imported dependency reaches those defining
 * libraries without dragging in the dependency's own transitive imports — which
 * would pull all of package:flutter in and gut tree-shaking.
 */
function exportClosure(
  seed: string,
  ownPackage: string,
  libRoot: string,
  pkgMap: Map<string, string>,
  acc: { partFiles: Set<string>; conditional: Set<string>; missing: Set<string> },
): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue = [seed];
  while (queue.length > 0) {
    const uri = queue.shift()!;
    if (seen.has(uri)) continue;
    seen.add(uri);
    const file = packageUriToPath(uri, ownPackage, libRoot, pkgMap);
    if (!file || !existsSync(file)) continue; // unresolvable → prove nothing, emit nothing
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const clean = stripComments(src);
    if (/^\s*part\s+of\b/m.test(clean)) continue;
    out.add(uri);
    const re = /^\s*export\s+(['"])([^'"]+)\1([^;]*);/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const [, , raw, tail] = m;
      if (/\bif\s*\(/.test(tail)) continue; // conditional → cannot prove the variant
      const next = resolveAnyPackageUri(uri, raw, ownPackage);
      if (next) queue.push(next);
    }
  }
  return out;
}

/** Transitive own-package closure from one entrypoint, plus the dependency
 *  libraries its code can reference. */
function closureFrom(
  projectRoot: string,
  packageName: string,
  entryRel: string,
  acc: { partFiles: Set<string>; conditional: Set<string>; missing: Set<string> },
  pkgMap: Map<string, string>,
  external: Set<string>,
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
      if (!resolved) {
        // Not ours to redefine — but a patched body may still CALL into it, so
        // the defining libraries must survive tree-shaking. Conditional imports
        // are skipped for the same reason as below: we can't prove the variant.
        if (!imp.conditional) {
          const dep = resolveAnyPackageUri(uri, imp.uri, packageName);
          if (dep && !dep.startsWith(prefix)) {
            for (const lib of exportClosure(dep, packageName, libRoot, pkgMap, acc)) {
              external.add(lib);
            }
          }
        }
        continue;
      }
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
    externals: [],
    flavorSpecific: [],
    partFiles: 0,
    conditional: [],
    missing: [],
  };
  if (entrypoints.length === 0) return empty;

  const pkgMap = buildPackageLibMap(projectRoot);
  const perEntry = new Map<string, Set<string>>();
  const perEntryExternal = new Map<string, Set<string>>();
  for (const entry of entrypoints) {
    const external = new Set<string>();
    perEntry.set(entry, closureFrom(projectRoot, packageName, entry, acc, pkgMap, external));
    perEntryExternal.set(entry, external);
  }

  // Same intersection rule as app libraries: a dependency reachable from only
  // one entrypoint is absent from the other flavors' components, and naming it
  // there is a hard build failure.
  const externals: string[] = [];
  if (perEntryExternal.size > 0) {
    const [first, ...rest] = [...perEntryExternal.values()];
    for (const uri of first) {
      if (rest.every((s) => s.has(uri))) externals.push(uri);
    }
    externals.sort();
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
    externals,
    flavorSpecific,
    partFiles: acc.partFiles.size,
    conditional: [...acc.conditional].sort(),
    missing: [...acc.missing].sort(),
  };
}

/** Render the scan as a ready-to-write `sankofa_dynamic_interface.yaml`. */
/**
 * Core libraries a patch will reach for whatever it does.
 *
 * Without these the module loader aborts on the most ordinary code:
 *
 *   bytecode_reader.cc:1172: error: Unable to find function add
 *   in Library:'dart:core' Class: List        → SIGABRT
 *
 * `--dynamic-interface` alone retains only Object.==, and the flag meant to
 * cover the rest (--dynamic-interface-annotate-privates) is rejected by the
 * bundled frontend_server. Declaring them explicitly is what actually works,
 * and the validator accepts `dart:` URIs — verified against a real build.
 *
 * Costs roughly 2 MB of tree-shaking on a mid-sized app. A patch that cannot
 * append to a list is not worth the saving.
 */
const CORE_CALLABLE_LIBRARIES = [
  'dart:async',
  'dart:collection',
  'dart:convert',
  'dart:core',
  'dart:io',
  'dart:math',
  'dart:typed_data',
  'dart:ui',
];

/**
 * Concrete PRIVATE implementations behind the core interfaces a patch calls.
 *
 * Declaring `dart:core` retains its public surface — `List.add` is listed — but
 * dispatch lands on `_GrowableList.add`, which is private and tree-shaken. The
 * patch then aborts the process:
 *
 *   bytecode_reader.cc:1172: error: Unable to find function add
 *   in Library:'dart:core' Class: List          → SIGABRT
 *
 * `--dynamic-interface-annotate-privates` exists to retain exactly these, but
 * the bundled frontend_server rejects the flag
 * ("Could not find an option named ..."), so they are named here instead. The
 * interface parser accepts class/member granularity, which is what makes this
 * possible without an engine rebuild.
 *
 * Members are DISAMBIGUATED names: plain for methods, `get:`/`set:` for
 * accessors. (--dump-detailed-dynamic-interface emits undisambiguated names and
 * therefore cannot be fed back in — that round-trip is broken upstream.)
 */
// Only _GrowableList: `_List` (the fixed-length backing) exposes no `[]`
// member under that name — declaring it fails the build with
// "A member with disambiguated name '[]' was not found in class '_List'".
// Entries here must be verified against a real build; the parser is exact.
const CORE_PRIVATE_CALLABLE: { library: string; className: string; member: string }[] = [
  // Integer operators (int +,-,* etc. dispatch to _IntegerImplementation).
  ...['+','-','*','~/','/','%','unary-','&','|','^','remainder']
      .map((m) => ({ library: 'dart:core', className: '_IntegerImplementation', member: m })),
  // String operators (concat, index, substring).
  ...['+','[]','substring','compareTo']
      .map((m) => ({ library: 'dart:core', className: '_StringBase', member: m })),
  // The concrete implementation dispatch lands on...
  ...['add', 'addAll', 'removeLast', 'removeAt', 'insert', 'clear', '[]', '[]=']
      .map((m) => ({ library: 'dart:core', className: '_GrowableList', member: m })),
  // ...AND the abstract interface member the patch's constant pool names.
  // Both are required: declaring `- library: 'dart:core'` retains the library's
  // public surface as the compiler models it, but the patch references
  // `List.add` as an interface method and the runtime lookup for it still
  // failed —
  //   bytecode_reader.cc:1172: Unable to find function add
  //   in Library:'dart:core' Class: List
  // — until the member was named explicitly at class/member granularity.
  ...['add', 'addAll', 'removeLast', 'removeAt', 'insert', 'clear', '[]', '[]=']
      .map((m) => ({ library: 'dart:core', className: 'List', member: m })),
  ...['add', 'remove', 'contains', 'clear']
      .map((m) => ({ library: 'dart:core', className: 'Set', member: m })),
  ...['[]', '[]=', 'putIfAbsent', 'remove', 'containsKey']
      .map((m) => ({ library: 'dart:core', className: 'Map', member: m })),
];

export function renderDynamicInterfaceYaml(scan: LibraryScanResult): string {
  const items = scan.libraries.map((l) => `  - library: '${l}'`).join('\n');
  // Dependencies are callable-only: a patch constructs a `Dio`, it does not
  // subclass one. Listing them under extendable/can-be-overridden would cost
  // far more tree-shaking for a case that essentially does not arise.
  const callable = [
    ...[...CORE_CALLABLE_LIBRARIES, ...scan.libraries, ...scan.externals]
      .sort()
      .map((l) => `  - library: '${l}'`),
    ...CORE_PRIVATE_CALLABLE.map(
      (e) => `  - library: '${e.library}'\n    class: '${e.className}'\n    member: '${e.member}'`,
    ),
  ].join('\n');
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
    `#                      (includes dependency libraries your code imports —\n` +
    `#                      a patch that constructs e.g. a Dio needs the\n` +
    `#                      DEFINING library resolvable on device, or the module\n` +
    `#                      loader aborts with "Unable to find library ...")\n` +
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
    `callable:\n${callable}\n\n` +
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
