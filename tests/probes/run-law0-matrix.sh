#!/usr/bin/env bash
# Runs the Law 0 identity probe under each candidate app identity and prints the results side by side.
#
# Electron takes `app.name` from the package.json in the directory it is pointed at, so each variant is
# a throwaway directory with its own package.json and the probe copied in. That is what makes this a
# real test of the rename rather than a simulation of it: `app.getPath('userData')` is derived by
# Electron itself, from the identity actually loaded.
#
# Usage: bash tests/probes/run-law0-matrix.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ELECTRON="$ROOT/node_modules/electron/dist/electron.exe"
WORK="$ROOT/.preview/law0"
PROBE="$ROOT/tests/probes/law0-identity-probe.cjs"

if [ ! -x "$ELECTRON" ]; then
  echo "electron binary not found at $ELECTRON" >&2
  exit 2
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# The variants that matter: what exists today, and the identities branding would introduce.
#   era                      -> the name in package.json today, and the userData dir on this machine
#   sam-ai (name only)       -> the rename Law 0 warns about
#   Sam AI (productName only)-> a productName-only change, which must not move userData
run_variant() {
  local label="$1" name="$2" productName="$3"
  local dir="$WORK/$label"
  mkdir -p "$dir"
  cp "$PROBE" "$dir/probe.cjs"

  node -e "
    const fs = require('fs')
    fs.writeFileSync(process.argv[1], JSON.stringify({
      name: process.argv[2],
      productName: process.argv[3],
      version: '1.0.0',
      main: 'probe.cjs',
    }, null, 2))
  " "$dir/package.json" "$name" "$productName"

  echo "================================================================"
  echo "VARIANT  $label   (name=$name, productName=$productName)"
  echo "================================================================"
  # A timeout guards against a probe that never exits; it is applied to the Electron launch itself
  # rather than to a test binary, and the output is captured so a failure is still readable.
  ELECTRON_DISABLE_SANDBOX=1 "$ELECTRON" --no-sandbox "$dir" 2>&1 | tr -d '\r' | grep -vE '^\[|DevTools|GPU|Vulkan|dbus|libva'
  echo "---- exit: ${PIPESTATUS[0]} ----"
  echo
}

run_variant "A-era" "era" "era"
run_variant "B-name-sam-ai" "sam-ai" "era"
run_variant "C-productName-sam-ai" "era" "Sam AI"
run_variant "D-both-sam-ai" "sam-ai" "Sam AI"

echo "matrix complete; scratch at $WORK"
