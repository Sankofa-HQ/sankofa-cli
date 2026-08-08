// Sankofa Deploy — source-diff change detector + static-caller cascade + extractor.
//
// THE DREAM's detection + codegen. Given your edited source + a base snapshot:
//   1. AST-diff each file (normalized toSource) → the functions whose BODY
//      changed. Position-independent, so line shifts don't create false hits
//      (unlike the AOT hash diff, drowned in build non-determinism).
//   2. STATIC-CALLER CASCADE: on iOS the code is read-only (no JIT) — a static
//      call site can't be repatched, only the virtual dispatch table can. So a
//      changed TOP-LEVEL/static fn only goes live if its static callers are
//      transplanted too. We walk the reverse call graph from each changed fn,
//      adding static callers, stopping at the first virtually-dispatched METHOD
//      (the dispatch-funcreg reroute covers it and everything above).
//   3. Emit a minimal unit with the changed fns + their cascade + imports +
//      a self-describing manifest. dart2bytecode compiles it against
//      --import-dill(base_noaot) → a small dispatch-funcreg module.
//
// Input  (argv[0]): { "out": "<unit.dart>", "files": [ {"current":"…","base":"…"|null} ] }
// Output (stdout): the manifest string (comma-separated transplant targets).
import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/analysis/features.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';

void main(List<String> args) {
  if (args.isEmpty) {
    stderr.writeln('usage: sankofa_extract <spec.json>');
    exit(2);
  }
  final spec = jsonDecode(File(args[0]).readAsStringSync()) as Map<String, dynamic>;
  final out = spec['out'] as String;
  final files = (spec['files'] as List).cast<Map<String, dynamic>>();

  // Collect every current app declaration (top-level fns + methods), keyed by
  // qualified name, with its normalized source + the simple names it invokes.
  final decls = <String, _Decl>{}; // qname -> decl
  final importsByFile = <String, Set<String>>{};
  // Reverse call graph: simpleName -> set of caller qnames.
  final callers = <String, Set<String>>{};

  for (final f in files) {
    final currentPath = f['current'] as String;
    if (!File(currentPath).existsSync()) continue;
    final unit = parseFile(path: currentPath, featureSet: FeatureSet.latestLanguageVersion()).unit;
    // The source file's PACKAGE uri (e.g. package:app/main_prod.dart), used to
    // resolve the file's own relative imports (below) and to self-import.
    final selfUri = f['uri'] as String?;
    final imports = <String>{};
    for (final d in unit.directives) {
      if (d is! ImportDirective) continue;
      final rawUri = d.uri.stringValue;
      final isAbsolute =
          rawUri == null || rawUri.startsWith('dart:') || rawUri.startsWith('package:');
      if (isAbsolute || selfUri == null || selfUri.isEmpty) {
        imports.add(d.toSource());
      } else {
        // RELATIVE import (e.g. a flavored `main_prod.dart` doing
        // `import 'main.dart'`). Copied verbatim it can't resolve — the
        // generated unit lives in a temp dir, not next to the source. Rewrite
        // it against the file's package uri so it resolves through --import-dill,
        // keeping any `show`/`hide`/`as` combinators.
        final resolved = Uri.parse(selfUri).resolve(rawUri).toString();
        imports.add(d.toSource().replaceFirst(d.uri.toSource(), "'$resolved'"));
      }
    }
    // SELF-IMPORT: a lifted body still refers to the types/functions its own
    // library declares (`return Summary(...)`), which resolve implicitly in
    // the original file but not in the generated unit. Import the source
    // library by its PACKAGE uri — the same URI the base dill uses, so the CFE
    // resolves against --import-dill instead of loading a second copy of the
    // library under a file:// URI (that collision is what breaks the build).
    if (selfUri != null && selfUri.isNotEmpty) {
      imports.add("import '$selfUri';");
    }
    importsByFile[currentPath] = imports;
    final c = _DeclCollector(currentPath);
    unit.accept(c);
    for (final d in c.decls) {
      decls[d.qname] = d;
      for (final callee in d.invokes) {
        (callers[callee] ??= <String>{}).add(d.qname);
      }
    }
  }

  // Which functions' BODIES changed vs the base snapshot (the seeds).
  final changed = <String>{};
  for (final f in files) {
    final currentPath = f['current'] as String;
    final basePath = f['base'] as String?;
    if (!File(currentPath).existsSync()) continue;
    final base = (basePath != null && File(basePath).existsSync())
        ? _collectSources(basePath)
        : <String, String>{};
    for (final d in decls.values.where((d) => d.file == currentPath)) {
      final b = base[d.qname];
      if (b == null || b != d.source) changed.add(d.qname);
    }
  }

  // Static-caller cascade: BFS the reverse graph from the changed set. Add a
  // caller when it statically reaches the frontier; keep traversing its callers
  // only if IT is a top-level/static fn — a METHOD is a virtual boundary (its
  // dispatch slots get rerouted, covering its callers with no transplant).
  final transplant = <String>{...changed};
  final frontier = <String>[...changed];
  while (frontier.isNotEmpty) {
    final q = frontier.removeLast();
    final d = decls[q];
    if (d == null) continue;
    // A METHOD is a virtual boundary: its dispatch slots get rerouted, so its
    // callers are covered WITHOUT transplanting them. Only top-level/static
    // changed fns cascade to their callers. (Without this guard, changing e.g.
    // RiskyV1.nextCount dragged in its caller _HomePageState.build, which cannot
    // compile as an isolated "reopened shell" — it references _op, widget, etc.)
    if (d.className != null) continue;
    for (final callerQ in callers[d.simpleName] ?? const <String>{}) {
      if (callerQ == q) continue;
      final cd = decls[callerQ];
      if (cd == null || cd.simpleName == 'main') continue; // never transplant main
      if (transplant.add(callerQ)) {
        // Traverse further only through static (top-level) callers; methods are
        // virtual boundaries handled by the dispatch reroute.
        if (cd.className == null) frontier.add(callerQ);
      }
    }
  }

  // Emit the unit: changed + cascade decls, the imports their bodies actually
  // use, and the manifest. NOT the whole file's imports — a dynamic module's
  // constant pool must resolve every referenced library against the base image,
  // and carrying unused imports (flutter/material + every app library, for a
  // function that touches none) makes the loader abort in ReadConstantPool.
  final candidateImports = <String>{};
  final bodies = <String>[];
  final targets = <String>[];
  final bodyText = StringBuffer();
  for (final q in transplant) {
    final d = decls[q];
    if (d == null) continue;
    candidateImports.addAll(importsByFile[d.file] ?? const <String>{});
    bodyText.write(d.source);
    bodyText.write('\n');
    if (d.className == null) {
      bodies.add(_withEntryPoint(d.source));
      targets.add(d.simpleName);
    } else {
      // Emit the changed method's body as a TOP-LEVEL patch fn, mapped onto the
      // app's method via the manifest's "target=source" form. A "reopened shell"
      // class carries an implicit ctor whose bytecode references Object.() — which
      // the transplant CANNOT resolve against a slim AOT base, so the boot hook
      // SIGABRTs while loading the module (`Unable to find function Object.`). The
      // boot hook's own contract (dart_isolate.cc) is: SOURCE is a top-level fn
      // (no class → no ctor → references zero base-SDK callables). Works for the
      // reroutable seams (method bodies that use only params/constants, not
      // `this`); those are exactly the polymorphic-dispatch targets we patch.
      // PATCHABLE-SEAM GATE. The body is about to be lifted to a top-level
      // fn, where nothing of the enclosing class exists. Refuse the two
      // constructs we can detect precisely — `this` and receiver-less calls
      // to sibling methods — with an error naming the method, instead of
      // letting dart2bytecode fail on a generated temp file the customer
      // never wrote. (Instance-field reads still surface as CFE errors.)
      final siblings = decls.values
          .where((s) => s.className == d.className && s.simpleName != d.simpleName)
          .map((s) => s.simpleName)
          .toSet();
      final siblingCalls = d.unqualifiedInvokes.intersection(siblings);
      // Third construct that cannot cross the seam: a PRIVATE top-level or
      // static member of the source library. The unit is compiled as its own
      // library (`--prefix-library-uris sankofa/patch`), so Dart privacy hides
      // every `_name` in the library it came from, however the unit imports it.
      // Without this gate the failure lands in dart2bytecode as
      // `Method not found: '_foo'` against a generated temp file the customer
      // never wrote — and the CLI discarded that stderr, so the operator saw a
      // bare "Command failed" with no cause at all.
      final privateRefs = d.unqualifiedInvokes
          .where((n) => n.startsWith('_'))
          .where((n) => !siblings.contains(n))
          .toSet();
      if (d.usesThis || siblingCalls.isNotEmpty || privateRefs.isNotEmpty) {
        final reason = d.usesThis
            ? 'uses `this`'
            : siblingCalls.isNotEmpty
                ? 'calls sibling method(s): ${siblingCalls.join(', ')}'
                : 'references private member(s) of its library: ${privateRefs.join(', ')}';
        stderr.writeln(
          "sankofa patch: '${d.className}.${d.simpleName}' is outside the patchable seam — it $reason.\n"
          '  A patched method body is transplanted as a standalone function. It can use its\n'
          '  parameters, local variables, constants, top-level functions, and imported or\n'
          '  own-library declarations — but not `this`, sibling methods, or instance fields.\n'
          '  Fix: move the shared logic into a top-level function (patchable), or ship this\n'
          '  change as a store release instead.\n'
          '  For a private member, making it public is usually enough — the patch unit is a\n'
          '  separate library, so `_name` is invisible to it no matter how it is imported.',
        );
        exit(64);
      }
      final topName = '_sankofaPatch_${d.className}_${d.simpleName}';
      var src = d.source.replaceAll('@override', '');
      src = src.replaceFirst(
          RegExp(r'\b' + RegExp.escape(d.simpleName) + r'\s*\('), '$topName(');
      bodies.add('// method ${d.className}.${d.simpleName} -> top-level source fn\n'
          '${_withEntryPoint(src.trim())}');
      targets.add('${d.className}.${d.simpleName}=$topName');
    }
  }

  // Keep an import only if a bare identifier it could provide appears in the
  // transplant bodies. Conservative: on any doubt (show/hide combinators,
  // prefixes) keep it. The win is dropping the dozens of app/framework imports
  // a small patch never touches.
  final body = bodyText.toString();
  final imports = <String>{};
  for (final imp in candidateImports) {
    final m = RegExp(r"\bshow\s+([A-Za-z0-9_,\s]+)").firstMatch(imp);
    if (m != null) {
      final names = m.group(1)!.split(',').map((e) => e.trim());
      if (names.any((n) => n.isNotEmpty && RegExp('\\b' + RegExp.escape(n) + '\\b').hasMatch(body))) {
        imports.add(imp);
      }
      continue;
    }
    // Entry-point infrastructure — always keep.
    if (imp.contains('dynamic_modules') || imp.contains('sankofa_flutter')) {
      imports.add(imp); continue;
    }
    if (imp.contains(' as ')) {
      // Prefixed: keep only if the prefix is used in the body.
      final pm = RegExp(r"\bas\s+([A-Za-z0-9_]+)").firstMatch(imp);
      final pfx = pm?.group(1);
      if (pfx != null && RegExp('\\b' + RegExp.escape(pfx) + r'\.').hasMatch(body)) imports.add(imp);
      continue;
    }
    // Plain `import 'uri';` — keep only if some Capitalized identifier from the
    // body could plausibly come from it. We can't resolve its exports, so keep
    // it when the body references ANY capitalized identifier or lowercase call
    // that isn't obviously local. Aggressive: for a pure body (no external
    // refs) this drops all of them, matching the baseline module's shape.
    final hasExternalRef = RegExp(r'\b[A-Z][A-Za-z0-9_]*\b').hasMatch(
        body.replaceAll(RegExp(r'//[^\n]*'), ''));
    if (hasExternalRef) imports.add(imp);
  }

  final manifest = targets.join(',');
  if (targets.isEmpty) {
    File(out).writeAsStringSync('// no changes\n');
    stdout.write('');
    return;
  }
  final buf = StringBuffer()
    ..writeln('// GENERATED by sankofa_extract — do not edit. Changed functions')
    ..writeln('// from your real code + their static-caller cascade.')
    ..writeln(imports.join('\n'))
    ..writeln()
    ..writeln(bodies.join('\n\n'))
    ..writeln()
    ..writeln("@pragma('vm:entry-point')")
    ..writeln("String _sankofaManifest() => '${manifest.replaceAll(r'\', r'\\').replaceAll("'", r"\'")}';")
    ..writeln("@pragma('dyn-module:entry-point')")
    ..writeln("Object? _sankofaEntry() { _sankofaManifest(); Object? _r;${_topLevelInvocations(targets)} return _r ?? 'SANKOFA_ENTRY_RAN'; }");
  File(out).writeAsStringSync(buf.toString());
  stdout.write(manifest);
}

class _Decl {
  _Decl(this.simpleName, this.className, this.source, this.file, this.invokes,
      {this.usesThis = false, Set<String>? unqualifiedInvokes})
      : unqualifiedInvokes = unqualifiedInvokes ?? const {};
  final String simpleName;
  final String? className;
  final String source;
  final String file;
  final Set<String> invokes; // simple names this decl invokes
  /// True when the body mentions `this` (explicitly or via a closure).
  final bool usesThis;
  /// Receiver-less invocations only — the ones that would resolve against the
  /// enclosing class and therefore break when the body is lifted top-level.
  final Set<String> unqualifiedInvokes;
  String get qname => className == null ? simpleName : '$className.$simpleName';
}

/// Just the normalized sources (for the base snapshot diff), keyed by qname.
Map<String, String> _collectSources(String path) {
  final unit = parseFile(path: path, featureSet: FeatureSet.latestLanguageVersion()).unit;
  final c = _DeclCollector(path);
  unit.accept(c);
  return {for (final d in c.decls) d.qname: d.source};
}

class _DeclCollector extends RecursiveAstVisitor<void> {
  _DeclCollector(this.file);
  final String file;
  final List<_Decl> decls = [];
  final List<String> _classStack = [];

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final m = RegExp(r'\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)').firstMatch(node.toSource());
    _classStack.add(m?.group(1) ?? '?');
    super.visitClassDeclaration(node);
    _classStack.removeLast();
  }

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    if (node.parent is CompilationUnit && !node.isGetter && !node.isSetter) {
      decls.add(_Decl(node.name.lexeme, null, node.toSource(), file, _invokesIn(node)));
    }
    super.visitFunctionDeclaration(node);
  }

  @override
  void visitMethodDeclaration(MethodDeclaration node) {
    if (!node.isGetter && !node.isSetter && !node.isOperator && _classStack.isNotEmpty) {
      final v = _InvokeCollector();
      node.accept(v);
      decls.add(_Decl(node.name.lexeme, _classStack.last, node.toSource(), file, v.names,
          usesThis: v.usesThis, unqualifiedInvokes: v.unqualified));
    }
    super.visitMethodDeclaration(node);
  }
}

/// The simple names invoked inside a declaration (its callees, by name).
Set<String> _invokesIn(AstNode node) {
  final v = _InvokeCollector();
  node.accept(v);
  return v.names;
}

class _InvokeCollector extends RecursiveAstVisitor<void> {
  final Set<String> names = {};
  final Set<String> unqualified = {};
  bool usesThis = false;
  @override
  void visitMethodInvocation(MethodInvocation node) {
    names.add(node.methodName.name);
    if (node.realTarget == null) unqualified.add(node.methodName.name);
    super.visitMethodInvocation(node);
  }

  @override
  void visitThisExpression(ThisExpression node) {
    usesThis = true;
    super.visitThisExpression(node);
  }
}

String _withEntryPoint(String src) {
  if (src.contains('vm:entry-point')) return src;
  return "@pragma('vm:entry-point')\n$src";
}

/// Direct calls to the transplanted TOP-LEVEL functions, emitted into the
/// module entry point. The entry point runs at load (the dyn-module:entry-point
/// contract), so this makes a patched top-level function actually execute —
/// the manifest alone only registers it for dispatch reroute, which does not
/// fire for a function the app has already bound. Method targets ("Class.m=fn")
/// are left to the reroute; only bare top-level names are invoked here.
String _topLevelInvocations(List<String> targets) {
  final calls = <String>[];
  for (final t in targets) {
    if (t.contains('=')) continue; // method reroute, not a direct call
    if (t == 'main') continue;
    // Capture the return value so a pure patched function's result reaches the
    // host via applyKbcEnvelope's returnValue.
    calls.add('try { _r = $t(); } catch (_) {}');
  }
  return calls.isEmpty ? '' : ' ${calls.join(' ')}';
}
