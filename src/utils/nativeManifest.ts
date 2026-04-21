import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Generate a Sankofa Catch native symbol manifest from a Mach-O dSYM
 * or an ELF .so file.
 *
 * Why this exists
 * ───────────────
 * The Catch server symbolicator (server/engine/ee/catch/native_symbolicator.go)
 * expects a pre-computed JSON manifest rather than a raw dSYM/ELF,
 * because parsing Mach-O + DWARF / ELF + DWARF natively in Go is a
 * multi-thousand-line project we've deliberately deferred. The CLI
 * bridges that gap: it shells out to platform tools (`nm`, `dwarfdump`,
 * `llvm-symbolizer`) that already parse those formats, and emits the
 * compact V1 manifest the server consumes.
 *
 * Manifest shape (must match server/engine/ee/catch/native_symbolicator.go):
 *
 *   {
 *     "version": 1,
 *     "debug_id": "8402B21E25D93B10BC94046F15601D32",
 *     "arch": "arm64",
 *     "symbols": [
 *       [addr_start, size, "function", "file", line],
 *       ...
 *     ]
 *   }
 *
 * Resolution granularity
 * ──────────────────────
 * V1 emits function-level entries only (no per-line DWARF parsing).
 * That's the 80/20 win — customers see real function names in their
 * stacks instead of `_0x1045c8`. Per-line accuracy arrives in M5.4
 * when we add DWARF line-table parsing; the manifest format already
 * supports it (the `line` column is honoured by the resolver).
 */

export type NativeKind = 'macho' | 'elf';

export interface NativeManifest {
  version: 1;
  debug_id: string;
  arch?: string;
  image_vmaddr?: string;
  symbols: Array<[number, number, string, string, number]>;
}

export interface DSymManifestOptions {
  /** Path to a .dSYM bundle or the binary inside it. */
  dsymPath: string;
  /** Architecture slice (arm64 / x86_64). Default: first slice nm returns. */
  arch?: string;
  /**
   * Run a second pass that augments each symbol with file + line info
   * resolved via `atos` (macOS) or `llvm-symbolizer` (Linux). Adds a
   * few hundred ms per thousand symbols but turns
   *   "leaf" → "leaf (sym2.c:1)"
   * which is the actual Sentry-quality experience. Defaults to true
   * when a tool is available; false when none is.
   */
  withLineInfo?: boolean;
}

export interface NDKManifestOptions {
  /** Path to a .so file (stripped or unstripped). */
  soPath: string;
  /**
   * Optional build-id override. When absent we try `readelf -n` for
   * the GNU build-id note; when that fails we emit a synthetic id
   * derived from the file's SHA. The server's match-key column is
   * identifier-only, not a security boundary, so the synthetic form
   * still routes reliably as long as SDK + upload use the same
   * generator.
   */
  debugId?: string;
  /** Same as DSymManifestOptions.withLineInfo. */
  withLineInfo?: boolean;
}

/** Result of the line-info augmentation pass, exposed for the CLI to
 *  report "found line info for N/M symbols". */
export interface LineInfoStats {
  enabled: boolean;
  tool: string | null;
  covered: number;
  total: number;
}

/**
 * Produce a manifest from a Mach-O dSYM bundle or bare binary.
 *
 * Identity + symbols: uses `dwarfdump` / `nm` on macOS, falls back to
 * `llvm-dwarfdump` / `nm` on Linux. Cross-platform — works in CI.
 *
 * Line info: optional second pass via `atos` (Apple's native, macOS)
 * or `llvm-symbolizer` (cross-platform). Default-on when a tool is
 * available.
 */
export function buildDSymManifest(opts: DSymManifestOptions): NativeManifest & { _lineInfo?: LineInfoStats } {
  const binaryPath = resolveDSymBinary(opts.dsymPath);
  if (!binaryPath) {
    throw new Error(
      `no Mach-O binary found under ${opts.dsymPath} — expected ${opts.dsymPath}/Contents/Resources/DWARF/<name>`,
    );
  }

  const { uuid, arch } = readMachOIdentity(binaryPath, opts.arch);
  const symbols = runNMSymbols(binaryPath, arch);
  const wantLine = opts.withLineInfo !== false;
  const stats = wantLine
    ? augmentWithLineInfo(binaryPath, symbols, { machO: true, arch })
    : { enabled: false, tool: null, covered: 0, total: symbols.length };

  const manifest: NativeManifest & { _lineInfo?: LineInfoStats } = {
    version: 1,
    debug_id: normaliseDebugId(uuid),
    arch,
    symbols,
  };
  manifest._lineInfo = stats;
  return manifest;
}

/**
 * Produce a manifest from an ELF .so. Reads the GNU build-id via
 * `readelf -n` and the symbol table via `nm`. Falls back to a SHA256
 * of the file if no build-id is present (stripped `.so` without
 * `.note.gnu.build-id`).
 *
 * Line info: optional pass via `llvm-symbolizer`, same semantics as
 * the dSYM path.
 */
export function buildNDKManifest(opts: NDKManifestOptions): NativeManifest & { _lineInfo?: LineInfoStats } {
  if (!fs.existsSync(opts.soPath) || fs.statSync(opts.soPath).isDirectory()) {
    throw new Error(`expected a file, got: ${opts.soPath}`);
  }
  const debugId = opts.debugId ?? readELFBuildId(opts.soPath) ?? syntheticIdFromFile(opts.soPath);
  const arch = readELFMachine(opts.soPath);
  const symbols = runNMSymbols(opts.soPath, arch);
  const wantLine = opts.withLineInfo !== false;
  const stats = wantLine
    ? augmentWithLineInfo(opts.soPath, symbols, { machO: false, arch })
    : { enabled: false, tool: null, covered: 0, total: symbols.length };

  const manifest: NativeManifest & { _lineInfo?: LineInfoStats } = {
    version: 1,
    debug_id: normaliseDebugId(debugId),
    arch,
    symbols,
  };
  manifest._lineInfo = stats;
  return manifest;
}

// ─── Mach-O helpers ──────────────────────────────────────────────────

/** Resolve the raw Mach-O binary to hand to nm/dwarfdump. Accepts
 *  either a `.dSYM` bundle or an already-binary path. */
function resolveDSymBinary(input: string): string | null {
  const abs = path.resolve(input);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    return abs;
  }
  const candidate = path.join(abs, 'Contents', 'Resources', 'DWARF');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return null;
  }
  const entries = fs.readdirSync(candidate);
  // One file per arch is the typical layout; take the first.
  const binary = entries.find((e) => !e.startsWith('.'));
  return binary ? path.join(candidate, binary) : null;
}

/** Pull the LC_UUID (the debug_id the server will match against).
 *  Tries `dwarfdump` first (Xcode CLT), then `llvm-dwarfdump` so
 *  Linux CI boxes work unchanged. */
function readMachOIdentity(binaryPath: string, preferredArch?: string): {
  uuid: string;
  arch: string;
} {
  const uuidTool = findTool(['dwarfdump', 'llvm-dwarfdump']);
  if (!uuidTool) {
    throw new Error(
      'neither dwarfdump nor llvm-dwarfdump is on $PATH — install Xcode CLT (macOS) or `apt install llvm` (Linux)',
    );
  }
  // Both tools accept `-u` / `--uuid` with compatible output shape.
  const uuidFlag = uuidTool === 'dwarfdump' ? '-u' : '--uuid';
  const out = runTool(uuidTool, [uuidFlag, binaryPath]);
  // Lines look like: "UUID: 8402B21E-25D9-3B10-BC94-046F15601D32 (arm64) /path"
  const lines = out.split('\n').filter((l) => l.startsWith('UUID:'));
  if (lines.length === 0) {
    throw new Error(`dwarfdump found no UUID in ${binaryPath}`);
  }
  for (const line of lines) {
    const match = line.match(/UUID:\s+([0-9A-F-]+)\s+\(([^)]+)\)/);
    if (!match) continue;
    const [, uuid, arch] = match;
    if (preferredArch && arch !== preferredArch) continue;
    return { uuid, arch };
  }
  // Caller asked for a specific arch but it's not in the binary.
  if (preferredArch) {
    throw new Error(`arch ${preferredArch} not present in ${binaryPath}`);
  }
  // Fallback: first UUID we saw (no arch filter).
  const match = lines[0].match(/UUID:\s+([0-9A-F-]+)\s+\(([^)]+)\)/);
  if (!match) throw new Error('dwarfdump output shape unexpected');
  return { uuid: match[1], arch: match[2] };
}

// ─── ELF helpers ─────────────────────────────────────────────────────

/** `readelf -n` looks for the .note.gnu.build-id section. Returns the
 *  40-char hex id, or null on any failure. */
function readELFBuildId(soPath: string): string | null {
  const tool = findTool(['readelf', 'llvm-readelf']);
  if (!tool) return null;
  try {
    const out = runTool(tool, ['-n', soPath]);
    // Line shape: "Build ID: 1234abcd..."
    const m = out.match(/Build\s+ID:\s*([0-9a-fA-F]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function readELFMachine(soPath: string): string {
  const tool = findTool(['readelf', 'llvm-readelf']);
  if (!tool) return 'unknown';
  try {
    const out = runTool(tool, ['-h', soPath]);
    const m = out.match(/Machine:\s*(.+)/);
    if (!m) return 'unknown';
    // readelf prints things like "AArch64" / "Advanced Micro Devices X86-64".
    const raw = m[1].trim().toLowerCase();
    if (raw.includes('aarch64')) return 'arm64';
    if (raw.includes('x86-64') || raw.includes('x86_64') || raw.includes('amd64')) return 'x86_64';
    if (raw.includes('arm')) return 'armv7';
    if (raw.includes('386')) return 'i386';
    return raw.replace(/\s+/g, '-');
  } catch {
    return 'unknown';
  }
}

// ─── nm-based symbol extraction ──────────────────────────────────────

/** Parse `nm -a -n` output, keep `T`/`t` (text) entries, compute sizes
 *  from adjacent-pair deltas. Returns the tuple rows the manifest
 *  wire format expects. */
function runNMSymbols(binaryPath: string, arch?: string): NativeManifest['symbols'] {
  const args = ['-a', '-n'];
  // macOS nm supports `-arch`; GNU nm ignores it (single-arch ELF).
  if (arch && process.platform === 'darwin') {
    args.push('-arch', arch);
  }
  args.push(binaryPath);
  const out = runTool('nm', args);

  type Row = { addr: number; name: string };
  const text: Row[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // Lines look like: "0000000100000328 T _leaf"
    // or stabs junk we skip: "0000000100000340 - 01 0000   FUN _main"
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [addrStr, typeStr, ...rest] = parts;
    if (!/^[0-9a-fA-F]+$/.test(addrStr)) continue;
    // Text segment = executable code. Lowercase 't' is local (static);
    // uppercase 'T' is global. Both are real function entry points.
    if (typeStr !== 'T' && typeStr !== 't') continue;
    const name = rest.join(' ');
    if (!name) continue;
    const addr = parseInt(addrStr, 16);
    if (!Number.isFinite(addr)) continue;
    text.push({ addr, name });
  }
  // nm -n already sorts by address but be defensive; some linkers
  // emit duplicate symbols at the same addr (thumb/ARM mode marker).
  text.sort((a, b) => a.addr - b.addr);

  // Dedupe by addr — keep the first symbol per address.
  const rows: NativeManifest['symbols'] = [];
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && text[i].addr === text[i - 1].addr) continue;
    const next = text[i + 1]?.addr ?? text[i].addr + 0x1000;
    const size = Math.max(1, next - text[i].addr);
    rows.push([text[i].addr, size, demangle(text[i].name), '', 0]);
  }
  return rows;
}

/** Strip the Mach-O leading underscore. Anything fancier (C++
 *  demangling, Swift) is deferred — the CLI output still reads
 *  better than the obfuscated address, which is the bar. */
function demangle(name: string): string {
  if (name.startsWith('_')) return name.slice(1);
  return name;
}

// ─── Pass 2: DWARF line info via atos / llvm-symbolizer ─────────────
//
// We run this as a single batched invocation rather than one tool
// call per symbol — spawning 10,000 processes to symbolicate a real
// binary would take tens of seconds per build. Batched input/output
// lands under ~500ms even for large bundles.
//
// Both tools agree on a common trick: feed addresses via stdin, one
// per line. atos emits one output line per input; llvm-symbolizer
// emits a function line + a file:line line, separated by blanks.

function augmentWithLineInfo(
  binaryPath: string,
  symbols: NativeManifest['symbols'],
  opts: { machO: boolean; arch: string },
): LineInfoStats {
  if (symbols.length === 0) {
    return { enabled: false, tool: null, covered: 0, total: 0 };
  }

  // Pick a tool. On macOS atos is almost always present via Xcode
  // CLT and produces the cleanest output; llvm-symbolizer is our
  // cross-platform fallback. Either one is fine when both exist.
  const atosPath = opts.machO ? pathForAtos() : null;
  const llvmSymbolizer = findTool(['llvm-symbolizer']);
  const tool = atosPath ?? (llvmSymbolizer ? 'llvm-symbolizer' : null);
  if (!tool) {
    return { enabled: false, tool: null, covered: 0, total: symbols.length };
  }

  // Feed all addresses through stdin in one call.
  const addrs = symbols.map((s) => '0x' + s[0].toString(16));
  try {
    if (tool.endsWith('atos')) {
      return runAtosBatch(tool, binaryPath, addrs, symbols, opts.arch);
    }
    return runLlvmSymbolizerBatch(tool, binaryPath, addrs, symbols);
  } catch (err) {
    // Line info is best-effort. Surface the failure but don't fail
    // the whole manifest — function-only resolution is still useful.
    return {
      enabled: true,
      tool,
      covered: 0,
      total: symbols.length,
    };
  }
}

function pathForAtos(): string | null {
  // `atos` ships with Xcode CLT at a well-known xcrun path. Try that
  // first so we don't require users to `xcrun -f` themselves; fall
  // through to $PATH if xcrun fails.
  try {
    const p = execSync('xcrun -f atos', { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  return findTool(['atos']);
}

function runAtosBatch(
  atosBin: string,
  binaryPath: string,
  addrs: string[],
  symbols: NativeManifest['symbols'],
  arch: string,
): LineInfoStats {
  // atos wants the load address; for a dSYM we symbolicate against
  // the vmaddr the binary was linked at, which is the same as the
  // addresses we already have (manifests are stored as-linked, not
  // post-ASLR). `-l 0` tells atos to not apply a slide.
  const args = ['-o', binaryPath, '-l', '0'];
  if (arch) {
    args.push('-arch', arch);
  }

  // Pipe addresses via a tmpfile to dodge stdin-size limits and avoid
  // the shell quoting minefield.
  const tmp = path.join(os.tmpdir(), `sankofa-atos-${process.pid}.txt`);
  fs.writeFileSync(tmp, addrs.join('\n'), 'utf8');
  try {
    // We use shell redirect because atos insists on reading from stdin
    // when no addresses are on argv. spawnSync + options.input would
    // also work but `execSync` keeps the invocation one-liner-ish.
    const shellCmd = `${JSON.stringify(atosBin)} ${args
      .map((a) => JSON.stringify(a))
      .join(' ')} < ${JSON.stringify(tmp)}`;
    const out = execSync(shellCmd, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const lines = out.split('\n');
    let covered = 0;
    for (let i = 0; i < symbols.length && i < lines.length; i++) {
      const parsed = parseAtosLine(lines[i]);
      if (!parsed) continue;
      const sym = symbols[i];
      if (parsed.function) sym[2] = parsed.function;
      if (parsed.file) sym[3] = parsed.file;
      if (parsed.line > 0) sym[4] = parsed.line;
      covered++;
    }
    return { enabled: true, tool: 'atos', covered, total: symbols.length };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Parse one atos line:
 *   "leaf (in sym2) (sym2.c:1)"          ← with line info
 *   "leaf (in sym2) + 0"                 ← no line info (no DWARF)
 *   "0x0000000100000328 (in sym2)"       ← address-only, nothing resolved
 */
function parseAtosLine(line: string): { function?: string; file?: string; line: number } | null {
  const s = line.trim();
  if (!s) return null;
  // Extract the function name: everything before " (in "
  const inPos = s.indexOf(' (in ');
  if (inPos <= 0) return null;
  const fn = s.slice(0, inPos);
  // Look for the "(file:line)" trailer after the binary name.
  const m = s.match(/\(([^:()]+):(\d+)\)\s*$/);
  if (m) {
    return { function: fn, file: m[1], line: parseInt(m[2], 10) };
  }
  return { function: fn, file: undefined, line: 0 };
}

function runLlvmSymbolizerBatch(
  tool: string,
  binaryPath: string,
  addrs: string[],
  symbols: NativeManifest['symbols'],
): LineInfoStats {
  // llvm-symbolizer accepts "OBJECT ADDRESS" per line on stdin.
  const input = addrs.map((a) => `${binaryPath} ${a}`).join('\n') + '\n';
  const args = ['--demangle=true', '--functions=linkage', '--inlines=false'];
  const out = execSync(`${JSON.stringify(tool)} ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Output per address is two lines: function, then file:line[:col]
  // followed by a blank line delimiter.
  const records = out.split(/\n\s*\n/);
  let covered = 0;
  for (let i = 0; i < symbols.length && i < records.length; i++) {
    const lines = records[i].split('\n').filter(Boolean);
    if (lines.length < 1) continue;
    const fn = lines[0].trim();
    const locLine = lines[1]?.trim() ?? '';
    const sym = symbols[i];
    if (fn && fn !== '??') sym[2] = fn;
    // Location: "path/to/file:line:col" or "??:?"
    if (locLine && !locLine.startsWith('??')) {
      const idx = locLine.lastIndexOf(':');
      const prev = locLine.lastIndexOf(':', idx - 1);
      if (prev > 0) {
        const file = locLine.slice(0, prev);
        const ln = parseInt(locLine.slice(prev + 1, idx), 10);
        if (file && file !== '??') sym[3] = file;
        if (Number.isFinite(ln) && ln > 0) sym[4] = ln;
      }
    }
    covered++;
  }
  return { enabled: true, tool: 'llvm-symbolizer', covered, total: symbols.length };
}

function syntheticIdFromFile(filePath: string): string {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex').slice(0, 40);
}

function normaliseDebugId(raw: string): string {
  return raw.toLowerCase().replace(/-/g, '');
}

// ─── Tool runner ─────────────────────────────────────────────────────

function runTool(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 64 MB — symbol tables get big
    });
  } catch (err: any) {
    const stderr = err?.stderr ? `: ${err.stderr.toString().trim()}` : '';
    throw new Error(`${bin} ${args.join(' ')} failed${stderr}`);
  }
}

function findTool(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Convenience: write a manifest to disk as UTF-8 JSON. Strips the
 *  internal `_lineInfo` stats so the on-disk shape stays exactly the
 *  server's documented wire format. */
export function writeManifest(
  manifest: NativeManifest & { _lineInfo?: LineInfoStats },
  outputPath: string,
): void {
  const { _lineInfo, ...clean } = manifest;
  void _lineInfo;
  fs.writeFileSync(outputPath, JSON.stringify(clean), { encoding: 'utf8' });
}