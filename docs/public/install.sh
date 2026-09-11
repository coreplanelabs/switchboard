#!/bin/sh
# Switchboard's installer front door: https://openswitchboard.dev/install.sh
#
#   curl -fsSL https://openswitchboard.dev/install.sh | sh -s -- --organization <org> --anthropic-key <key>
#
# Installs nothing itself. It checks that Node.js is present and new enough,
# says how to get it when it is not (never installs Node for you), and then
# runs the published installer — `npx @coreplane/switchboard init` — with every
# argument you gave it, in the directory you ran it from. Everything the
# installer does is described at https://openswitchboard.dev/tutorials/get-started
# and can be run by hand: `npx @coreplane/switchboard init --help`.
set -eu

# The Node major the repository pins in .nvmrc; a test holds the two equal.
REQUIRED_NODE_MAJOR=24
PACKAGE="@coreplane/switchboard"

fail() {
  echo "switchboard: $1" >&2
  echo "  Node.js $REQUIRED_NODE_MAJOR or newer is required: https://nodejs.org/en/download (or your version manager: nvm install $REQUIRED_NODE_MAJOR, fnm install $REQUIRED_NODE_MAJOR)." >&2
  echo "  Then run this again, or run the installer yourself: npx $PACKAGE init --help" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is not on your PATH."
command -v npx >/dev/null 2>&1 || fail "npx is not on your PATH (it ships with Node.js)."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge "$REQUIRED_NODE_MAJOR" ] 2>/dev/null || fail "Node.js $(node -v) is too old."

# The check above is the gate a person reads; npm's own is behind it: npx does not
# enforce a package's `engines` unless engine-strict is on, so it is turned on for
# this one call and an older Node is refused by npm too, never run.
npm_config_engine_strict=true exec npx --yes "$PACKAGE@latest" init "$@"
