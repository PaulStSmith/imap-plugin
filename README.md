# IMAP Plugin

Connect Codex to generic IMAP mailboxes through an MCP server.

This is a greenfield v1 focused on safe read-only access:

- Add mailbox account profiles.
- Store mailbox secrets through a pluggable credential provider.
- List IMAP folders.
- Search messages.
- Read message content.
- Inspect attachment metadata.

SMTP sending is intentionally not exposed yet. The credential and account model is designed so a paid "mail actions" layer can add draft, send, reply, forward, move, and mark-read tools later with explicit confirmation.

## Architecture

```txt
.codex-plugin/plugin.json
.mcp.json
src/
  server.ts
  cli.ts
  config/
  credentials/
  mail/
  tools/
```

## Credential Providers

Set `IMAP_PLUGIN_CREDENTIAL_PROVIDER` to choose a provider:

- `local-keychain`: stores passwords in the OS credential store through `keytar`.
- `1password`: reads passwords from 1Password using `op read`.
- `env`: reads passwords from environment variables for development.

The default provider is `local-keychain`.

## Development

```bash
npm install
npm run build
npm start
```

## Setup Page

The MCP server starts a localhost setup page when it launches. Ask Codex to call `imap_configure`, then open the returned URL. `imap_open_setup` remains as a compatibility alias.

The page supports:

- Add or update account profiles.
- Test a connection before saving.
- Test saved accounts.
- Remove saved accounts and local keychain secrets.
- Store credentials in the local operating system keychain.

By default the setup page binds to `127.0.0.1:37891`. If that port is busy, it falls back to an available local port. You can override the preferred port with:

```bash
set IMAP_PLUGIN_SETUP_PORT=37900
```

## Account Setup

After building, add an account:

```bash
imap-plugin account add personal \
  --host imap.example.com \
  --port 993 \
  --secure true \
  --username me@example.com
```

For 1Password-backed accounts:

```bash
imap-plugin account add personal \
  --host imap.example.com \
  --port 993 \
  --secure true \
  --username me@example.com \
  --credential-provider 1password \
  --credential-ref "op://Private/Mailbox/password"
```

For env-backed accounts:

```bash
set IMAP_PLUGIN_PERSONAL_PASSWORD=app-password
imap-plugin account add personal \
  --host imap.example.com \
  --port 993 \
  --secure true \
  --username me@example.com \
  --credential-provider env \
  --credential-ref IMAP_PLUGIN_PERSONAL_PASSWORD
```

## MCP Tools

- `imap_configure`
- `imap_open_setup`
- `imap_add_account`
- `imap_list_accounts`
- `imap_remove_account`
- `imap_test_account`
- `imap_list_folders`
- `imap_search_messages`
- `imap_read_message`

## Security Notes

- Prefer provider-specific app passwords over primary mailbox passwords.
- Do not log mailbox credentials.
- Do not expose SMTP send until there is an explicit confirmation path.
- Keep message bodies out of telemetry and crash reports.
