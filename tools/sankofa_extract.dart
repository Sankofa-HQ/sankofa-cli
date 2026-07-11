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
    final imports = <String>{};
    for (final d in unit.directives) {
      if (d is ImportDirective) imports.add(d.toSource());
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

  // Emit the unit: changed + cascade decls, their files' imports, the manifest.
  final imports = <String>{};
  final bodies = <String>[];
  final targets = <String>[];
  for (final q in transplant) {
    final d = decls[q];
    if (d == null) continue;
    imports.addAll(importsByFile[d.file] ?? const <String>{});
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
      final topName = '_sankofaPatch_${d.className}_${d.simpleName}';
      var src = d.source.replaceAll('@override', '');
      src = src.replaceFirst(
          RegExp(r'\b' + RegExp.escape(d.simpleName) + r'\s*\('), '$topName(');
      bodies.add('// method ${d.className}.${d.simpleName} -> top-level source fn\n'
          '${_withEntryPoint(src.trim())}');
      targets.add('${d.className}.${d.simpleName}=$topName');
    }
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
    ..writeln("Object? _sankofaEntry() { _sankofaManifest(); return null; }");
  File(out).writeAsStringSync(buf.toString());
  stdout.write(manifest);
}

class _Decl {
  _Decl(this.simpleName, this.className, this.source, this.file, this.invokes);
  final String simpleName;
  final String? className;
  final String source;
  final String file;
  final Set<String> invokes; // simple names this decl invokes
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
      decls.add(_Decl(node.name.lexeme, _classStack.last, node.toSource(), file, _invokesIn(node)));
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
  @override
  void visitMethodInvocation(MethodInvocation node) {
    names.add(node.methodName.name);
    super.visitMethodInvocation(node);
  }
}

String _withEntryPoint(String src) {
  if (src.contains('vm:entry-point')) return src;
  return "@pragma('vm:entry-point')\n$src";
}
