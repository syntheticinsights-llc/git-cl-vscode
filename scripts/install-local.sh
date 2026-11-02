#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VSIX=git-cl-vscode.vsix
CLI_LINK=/opt/homebrew/bin/git-cl-ts
EDITOR_CLIS=(
	code
	cursor
	"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
)

npm run build:extension -- --minify
npm run build:cli
ln -sf "$PWD/dist/cli.js" "$CLI_LINK"
echo "linked: $CLI_LINK -> $PWD/dist/cli.js"
vsce package patch --no-git-tag-version --no-dependencies --out "$VSIX"

installed=0
failed=()
for cli in "${EDITOR_CLIS[@]}"; do
	if ! command -v "$cli" >/dev/null 2>&1; then
		echo "skip: $cli (not found)"
		continue
	fi
	echo "install: $cli"
	if "$cli" --install-extension "$VSIX" --force; then
		installed=$((installed + 1))
	else
		failed+=("$cli")
	fi
done

if [ "${#failed[@]}" -gt 0 ]; then
	printf 'failed: %s\n' "${failed[@]}" >&2
fi
if [ "$installed" -eq 0 ]; then
	echo "Not installed into any editor; $VSIX was packaged only." >&2
	exit 1
fi
echo "Installed into $installed editor(s). Run 'Developer: Reload Window' in each to load it."
