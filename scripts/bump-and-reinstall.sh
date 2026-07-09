#!/usr/bin/env bash
# Bumps the extension version, packages a new .vsix, and reinstalls it in VS Code.
set -euo pipefail

BUMP_TYPE="${1:-patch}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$ROOT_DIR/package.json"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "error: package.json not found at $PKG_JSON" >&2
  exit 1
fi

case "$BUMP_TYPE" in
  major|minor|patch) ;;
  *)
    echo "error: bump type must be one of major|minor|patch (got '$BUMP_TYPE')" >&2
    exit 1
    ;;
esac

OLD_VERSION="$(node -p "require('$PKG_JSON').version")"

if [[ ! "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: unsupported version format '$OLD_VERSION' (expected major.minor.patch)" >&2
  exit 1
fi

NEW_VERSION="$(node -e "
const [major, minor, patch] = '$OLD_VERSION'.split('.').map(Number);
const type = '$BUMP_TYPE';
let next;
if (type === 'major') next = [major + 1, 0, 0];
else if (type === 'minor') next = [major, minor + 1, 0];
else next = [major, minor, patch + 1];
console.log(next.join('.'));
")"

node -e "
const fs = require('fs');
const path = '$PKG_JSON';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

PUBLISHER="$(node -p "require('$PKG_JSON').publisher")"
NAME="$(node -p "require('$PKG_JSON').name")"
EXTENSION_ID="$PUBLISHER.$NAME"
VSIX_FILE="$ROOT_DIR/$NAME-$NEW_VERSION.vsix"

echo "Bumping version: $OLD_VERSION -> $NEW_VERSION"

rm -f "$ROOT_DIR/$NAME"-*.vsix

echo "Packaging extension..."
(cd "$ROOT_DIR" && npx vsce package)

if [[ ! -f "$VSIX_FILE" ]]; then
  echo "error: expected package $VSIX_FILE was not created" >&2
  exit 1
fi

echo "Uninstalling existing extension ($EXTENSION_ID) if present..."
code --uninstall-extension "$EXTENSION_ID" || true

echo "Installing $VSIX_FILE..."
code --install-extension "$VSIX_FILE"

echo "Done: $EXTENSION_ID bumped $OLD_VERSION -> $NEW_VERSION and reinstalled."
