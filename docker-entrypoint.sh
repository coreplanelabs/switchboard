#!/bin/sh
# The image's entrypoint (the Dockerfile installs it as `switchboard`).
#   no arguments        → the bot, `node dist/index.js` (docker compose, the Cloudflare container)
#   node|sh|bash …      → that command, as given (a shell into the image)
#   anything else       → the CLI: `init`, `ask "…"`, `<group> <verb> …`
# The CLI reads `.env` and `./config/config.yaml` from the working directory,
# so `-w /work -v "$PWD":/work` installs into the host's directory.
set -e
if [ "$#" -eq 0 ]; then
  exec node /app/dist/index.js
fi
case "$1" in
  node | sh | bash) exec "$@" ;;
esac
exec node /app/dist/cli.js "$@"
