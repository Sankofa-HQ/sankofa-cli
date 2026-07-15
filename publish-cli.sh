#!/usr/bin/env bash
#
# publish-cli.sh — publish the version currently in package.json to npm.
#
#   cd cli/sankofa-cli && ./publish-cli.sh
#
# Preflights (version is unpublished, build clean, artifact validates), then
# runs the one irreversible step. Requires `npm login` — publishing needs an
# interactive/browser auth this repo's tooling can't do for you.
#
# Replaces the version-locked publish-0.1.14.sh.
set -euo pipefail

cd "$(dirname "$0")"
VERSION="$(node -p "require('./package.json').version")"

echo "▸ Preflight — sankofa-cli@$VERSION"
if npm view "sankofa-cli@$VERSION" version >/dev/null 2>&1; then
  echo "  ✖ $VERSION is already published — bump package.json first."
  exit 1
fi
echo "  ✓ $VERSION is unpublished"

echo "▸ Build + dry-run"
npm run build >/dev/null
npm publish --dry-run >/dev/null 2>&1
echo "  ✓ artifact validates"

echo "▸ Publishing to npm (irreversible)"
npm publish

echo
echo "✓ sankofa-cli@$VERSION published."
echo
echo "Verify a stranger's machine still onboards — the ONLY harness that catches"
echo "keychain/warm-cache/pub-cache bugs (all three of which shipped before):"
echo "  flutter-deploy/scripts/ship/pristine-rehearsal.sh"
