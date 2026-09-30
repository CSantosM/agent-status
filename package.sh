#!/usr/bin/env bash
# Builds agent-status-<version>.vsix with no npm dependencies.
# Usage: ./package.sh            build the .vsix
#        ./package.sh --install  build it and install it into VS Code
set -euo pipefail
cd "$(dirname "$0")"

echo "Running tests..."
tests_log=$(mktemp)
node --test --test-reporter=tap 'test/*.test.js' > "$tests_log" 2>&1 || {
  cat "$tests_log"
  rm -f "$tests_log"
  echo "Tests failed; not packaging." >&2
  exit 1
}
grep -E '^# (pass|fail)' "$tests_log"
rm -f "$tests_log"

version=$(node -p "require('./package.json').version")
out="$PWD/agent-status-${version}.vsix"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

mkdir -p "$build/extension"
cp -r package.json extension.js README.md src media "$build/extension/"
# The README's images are not packaged; point them at the repository so the Extensions view shows them.
sed -i 's#src="docs/images/#src="https://raw.githubusercontent.com/CSantosM/agent-status/main/docs/images/#g' "$build/extension/README.md"

cat > "$build/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="agent-status" Version="${version}" Publisher="local" />
    <DisplayName>Agent Status</DisplayName>
    <Description xml:space="preserve">A status bar chip with one dot per running Claude Code session: working, waiting or idle.</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

cat > "$build/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".wav" ContentType="audio/wav" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
EOF

rm -f "$out"
(cd "$build" && zip -qrX "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "Built $out"

if [[ "${1:-}" == "--install" ]]; then
  code --install-extension "$out" --force
  echo "Installed. Run 'Developer: Reload Window' in each open VS Code window."
fi
