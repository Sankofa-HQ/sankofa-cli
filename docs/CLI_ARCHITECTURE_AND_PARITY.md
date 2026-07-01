# Sankofa CLI — architecture, full Flutter parity, and engine-scale (the once-and-for-all blueprint)

**Mandate (founder, 2026-06-30):** one npm install (`sankofa`) is the single
front door for every product and platform. **In a Flutter project, every command
must behave exactly like the Shorebird-fork Dart CLI** — same names, same
flags, same outcome. Built for the long term: we will publish a Sankofa engine
for **almost every stable Flutter version**, so the CLI must resolve, fetch, and
drive the right engine per project, forever, without rework. Do it right once.

This doc is the authoritative contract. It is the source of truth for what the
CLI must do; implementation tracks it.

---

## 1. Principles (non-negotiable)

1. **Single front door.** `npm i -g sankofa-cli` → `sankofa`. No second installer,
   no separate Deploy tool, no user-installed Flutter/Dart. Node is the only host
   prerequisite (RN/web devs already have it); Xcode/Android SDK as the platforms
   require (Apple/Google, unavoidable).
2. **The CLI is glue; the engine binaries are the algorithms.** `dart2bytecode`,
   `gen_snapshot`, `analyze_snapshot`, `aot_tools` (all in the downloaded engine
   bundle) own the hard logic. The TS CLI assembles args, manages the cache,
   resolves versions, uploads, and reports. Single source of truth = the binaries.
   The Dart fork (`sankofa-codepush/packages/sankofa_cli`) is the algorithm
   incubator/reference; it is **not** shipped to users.
3. **Parity is behavioral, not just nominal.** Every Flutter command "acts the
   same": same flags, same defaults, same exit codes, same artifacts, same
   success/failure messages a Shorebird user expects — but Sankofa-branded and
   pointed at `api.sankofa.dev` / `download.sankofa.dev`.
4. **Engine-version correctness is the spine.** Every release/patch is keyed to a
   specific Sankofa engine (`engine_version` in `sankofa.yaml`). The CLL never
   guesses; it resolves the exact engine and refuses (clearly) if it can't.

---

## 2. Complete command surface (full Dart-fork parity for Flutter)

Legend: ✅ have · ⚠️ partial/rename · ❌ missing · ➕ Sankofa extra (beyond fork).

| Dart-fork command | npm CLI target | State | Notes |
|---|---|---|---|
| `login`, `login:ci`, `logout` | `login` (+`--deploy-token`), `logout` | ✅ | CI via `--deploy-token` |
| `doctor` | `doctor` | ✅ | extend with Flutter-engine health |
| `init` | `init` | ✅ | add to existing project |
| `create` | `create` | ❌ | scaffold a NEW Sankofa app (distinct from init) |
| `upgrade` | `upgrade` | ✅ | self-update |
| `preview` | `preview` | ✅ | run a released build |
| `release <platform>` | `release <platform>` | ⚠️ | ios/android ✅; aar/ios-framework/macos/windows/linux ❌ (§4) |
| `patch <platform>` | `patch <platform>` | ⚠️ | same platform coverage |
| `releases list` | `releases list` | ✅ | richer (rollback counts) |
| `releases info <id>` | `releases info <id>` | ❌ | add dedicated detail view |
| `releases get-apks <id>` | `releases get-apks <id>` | ❌ | export APKs (server endpoint) |
| `patches list` | `patches list` | ✅ | |
| `patches info <id>` | `patches info <id>` | ❌ | add detail view |
| `patches promote` | `patches promote` | ⚠️ | unify with track model |
| `patches set-track` | `patches set-track` | ⚠️ | staging→stable track |
| `account apps` | `account apps` | ❌ | list apps (server endpoint) |
| `account orgs` | `account orgs` | ❌ | list orgs (server endpoint) |
| `account whoami` | `account whoami` | ❌ | identity (server endpoint) |
| `cache clean` | `cache clean` | ❌ | clear `~/.sankofa` engine/flutter cache |
| `flutter versions [list]` | `flutter versions` → alias `engine list` | ⚠️ | name parity |
| `flutter config` | `flutter config` → alias `switch`/`engine` | ⚠️ | name parity |
| — | `kill`, `rollout`, targeting `rules`, `schedule` | ➕ | Sankofa exceeds the fork |
| — | `catch`, `flags`, `config`, `switch`, `keys`, `submit`, `dist`, `demo`, `check` | ➕ | unified multi-product |

**Parity definition of done:** for a Flutter project, `sankofa <cmd>` ≡ the Dart
fork's `<cmd>` for ALL rows above (behavior, flags, output), with ios+android
fully working and the 5 extra platforms tracked in §4.

---

## 3. Engine-version-at-scale (the long-term spine)

Goal: a Sankofa engine for (almost) every stable Flutter version, resolved
automatically per project. The CLI side:

- **Resolution.** `sankofa.yaml::engine_version` (e.g. `3.44.1+sankofa-1`) is the
  contract. The CLI resolves it against the **KnownEngine registry** (server →
  `download.sankofa.dev`) via `engineRegistry.ts`. Never infer; if the version
  isn't published, fail with: which version, where it should be, how to request a
  build. (Today: ~6 registry entries; design for thousands.)
- **Fetch + cache.** `engineCache.ts` downloads the engine bundle (Flutter fork +
  `gen_snapshot`/`analyze_snapshot`/`dart2bytecode`/`aot_tools`/runtime) to
  `~/.sankofa/flutter/<engine_version>/`, content-addressed, verified by hash.
  **Split cache (cheap-first):** a *patch-only* fetch pulls just
  `dartaotruntime` + `dart2bytecode.dart.snapshot` + `vm_platform.dill` (small);
  the full Flutter fork is fetched lazily only on `release`.
- **Multiple versions coexist.** Each `engine_version` is its own cache dir;
  switching projects never re-downloads or clobbers. GC/retention via
  `cache clean [--keep <versions>]`.
- **Build pipeline (Workstream B, server/CI side).** Every published engine is
  produced by the `sankofa-engine-build-*` CI from `Sankofa-HQ/sankofa-flutter`
  at the pinned `engine.version`, hosted under `engines/flutter/{rev}/...` on
  `download.sankofa.dev`, registered as a KnownEngine row. The CLI consumes that;
  it never builds engines. New stable Flutter → CI builds + registers → CLI can
  immediately resolve it. **This is how "every stable version" stays tractable:
  the CLI cost is O(1) per version (a registry lookup); the build is automated.**
- **Compatibility guardrail.** The engine bundle embeds its Dart snapshot-format
  version; the CLI records it in the release manifest so a patch is only ever
  applied by a device on the matching engine (mirrors the on-device version dance).

---

## 4. Platform abstraction (scales to all Flutter targets)

Today: `ios`, `android`. The fork adds `aar`, `ios-framework`, `macos`,
`windows`, `linux`. Each platform is a **Patcher/Releaser pair** behind a common
interface (mirroring the Dart fork's pattern), so adding one is additive, not a
rewrite:

```
interface Platform {
  release(project, opts): builds the signed baseline + registers it
  patch(project, opts):   builds the OTA artifact (KBC/diff) + uploads
  // both resolve the engine via §3; both report identically
}
```

- **Phase A (now):** iOS + Android — the mobile core; iOS rides the proven
  dispatch-funcreg KBC path (`../../flutter-deploy/.../research/fusion/`).
- **Phase B (add-to-app):** `aar` (Android lib) + `ios-framework` (iOS add-to-app)
  — for apps embedding Flutter. CLI plumbing + the embed build; same KBC patch.
- **Phase C (desktop):** `macos`/`windows`/`linux` — each needs engine + updater
  support for that OS. Tied to the engine-build pipeline (§3); real per-platform
  work, scheduled when desktop is a product target.

Every platform "acts the same" at the CLI surface: same flags
(`--release`, `--env`, `--flavor`, `--rollout`, `--mandatory`, `--description`,
`--dry-run`), same prompts, same output shape.

---

## 5. Server-API dependency map (what's CLI-local vs founder-deployed)

The founder deploys `api.sankofa.dev`; I write code + a script, never deploy.

| Gap | Needs server? | Path |
|---|---|---|
| `create`, `cache clean`, `flutter versions/config` aliases, `releases/patches info` (from existing list payload) | No — CLI-local | implement now |
| `account apps/orgs/whoami` | Yes — `codepush_compat_cli.go` is TBD | write Go handlers + CLI; founder deploys |
| `releases get-apks` | Yes — needs an export endpoint | write Go handler + CLI; founder deploys |

For server-dependent commands, the CLI must **degrade gracefully** when the
endpoint is absent (older server): clear message, never a stack trace.

---

## 6. Behavior contract — "acts the same" checklist (per Flutter command)

For each command, parity = all of:
- same **name + aliases** (incl. `flutter versions`, `flutter config`);
- same **arguments + flags + defaults** (document any Sankofa-only additions);
- same **interactive prompts** when args omitted, same **headless** behavior with
  `--release`/`--env`/`--flavor` for CI;
- same **artifacts** produced (release baseline, patch bundle) and **same upload
  contract** to `api.sankofa.dev`;
- same **exit codes** (0 success, non-zero per failure class) and **message
  shape** (spinner → success/fail line);
- **engine resolution** per §3 with a clear failure when unavailable.

A conformance test (`docs/e2e-customer-walkthrough.md` extended) runs each command
on a fixture Flutter app and asserts the contract.

---

## 7. Phased implementation plan

1. **Phase 1 — CLI-local parity (no server):** `create`, `cache clean`,
   `flutter versions`/`config` aliases, `releases info`/`patches info`. Bounded,
   verifiable, immediate.
2. **Phase 2 — server-backed parity:** `account apps/orgs/whoami`,
   `releases get-apks` — Go handlers in `codepush_compat_cli.go` + CLI commands +
   a founder deploy script. Graceful degradation when absent.
3. **Phase 3 — track/promote unification:** make `patches promote` /
   `set-track` match the fork's staging→stable semantics over Sankofa's richer
   rollout/schedule model.
4. **Phase 4 — platform Phase B:** `aar` + `ios-framework`.
5. **Phase 5 — engine-scale hardening:** split patch-only cache, multi-version
   coexistence, `cache clean --keep`, version-unavailable UX, conformance suite.
6. **Phase 6 — desktop (Phase C):** macos/windows/linux, gated on desktop being a
   product target + the engine-build pipeline covering them.

Each phase ends green on the §6 conformance checklist for the commands it touches.

---

## 8. The one architectural decision, recorded
**npm CLI drives the downloaded engine binaries directly; it does NOT wrap a
compiled Dart CLI binary.** Rationale: identical user experience, but no second
per-OS artifact to fetch/codesign/notarize, one language surface, one UX. The
Dart fork stays the algorithm reference. (Full reasoning in chat 2026-06-30.)
