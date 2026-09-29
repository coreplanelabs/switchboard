# Connect to Switchboard over MCP
Production URL: `https://switchboard.coreplanelabs.dev/mcp`. Example subject: `matanya`.
## 1. Create your bearer
Run:
`openssl rand -hex 32`
Save the result in a personal 1Password item with a concealed `token` field.
In 1Password, edit `CI` → `Switchboard ingress tokens` → `SWITCHBOARD_INGRESS_TOKENS`. Add one JSON property; keep the existing entries:
`"<your bearer>": {"subject":"matanya","email":"<your Slack profile email>"}`
Replace `matanya` with your unique subject. Use your Slack profile email.
## 2. Grant MCP access
In [coreplanelabs/infrastructure](https://github.com/coreplanelabs/infrastructure), open a PR editing [switchboard/config.production.yaml](https://github.com/coreplanelabs/infrastructure/blob/main/switchboard/config.production.yaml). Add under `grants`:
`"mcp:matanya": { actions: [dispatch, runs:read, runs:write, status:read, help:read, repo:read, costs:read, config:read], channels: all }`
Use the same subject as step 1. Keep the other grants; merge the PR.
## 3. Link your GitHub account
From a Slack account granted `identity:write`, send Switchboard:
`config set user --user slack:<your Slack user ID> --github <your GitHub login>`
The email links MCP runs to Slack; this command links Slack to GitHub.
## 4. Publish the map and grant
After the PR merges, open [Sync MCP access](https://github.com/coreplanelabs/switchboard/actions/workflows/sync-mcp-access.yml) in GitHub Actions and click **Run workflow**. It uploads the map, pushes the grant, and restarts the bot. Wait for the run to pass.
## 5. Connect your MCP client
Set `SWITCHBOARD_MCP_TOKEN` to your personal bearer in the environment your MCP client inherits. Copy the bearer from your personal 1Password item, then run one of these commands:
- Client launched from zsh on macOS: `export SWITCHBOARD_MCP_TOKEN="$(pbpaste)"` — start the client in that shell.
- Codex or another macOS desktop app: `launchctl setenv SWITCHBOARD_MCP_TOKEN "$(pbpaste)"` — fully quit and reopen the app. Repeat after logging in to your Mac.
Connect to the production URL above over Streamable HTTP. Configure bearer authentication to read that variable, then call `runs_list` to check the connection.
