#!/usr/bin/env bash
# Builds agent-watch-status-<version>.vsix with the official packager, vsce. vsce runs the tests first (the
# "vscode:prepublish" script) and refuses to package if any fails.
# Usage: ./package.sh            build the .vsix
#        ./package.sh --install  build it and install it into VS Code
set -euo pipefail
cd "$(dirname "$0")"

version=$(node -p "require('./package.json').version")
out="$PWD/agent-watch-status-${version}.vsix"
npx --yes @vscode/vsce@4 package --out "$out"

if [[ "${1:-}" == "--install" ]]; then
  code --install-extension "$out" --force
  echo "Installed. Run 'Developer: Reload Window' in each open VS Code window."
fi
