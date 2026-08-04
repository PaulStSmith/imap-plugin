# IMAP Mailboxes Beta

Connect Codex to generic IMAP mailboxes through an MCP server.

IMAP Mailboxes is a Codex-exclusive plugin. It is not a general ChatGPT GPT, hosted mailbox service, or non-Codex assistant integration.

This is a greenfield v1 focused on safe read-only access:

- Add mailbox account profiles.
- Store mailbox secrets through a pluggable credential provider.
- List IMAP folders.
- Search messages by text, address fields, headers, dates, flags, size, UID ranges, Gmail raw query, and attachment presence.
- Read message content.
- Inspect attachment metadata.
- Fetch attachment content as base64 when needed.

SMTP sending is intentionally not exposed yet. The credential and account model is designed so a paid "mail actions" layer can add draft, send, reply, forward, move, and mark-read tools later with explicit confirmation.

## Paid Feature Gate

Paid tools should call the subscription gate before performing mail actions. When a user does not have a live subscription, the plugin returns a structured `subscription_required` response with a payment link.

The no-server production path is a signed ByteForge `.lic` file. Install the license with:

```bash
imap-plugin license install path\to\license.lic
```

or from Codex:

```text
/imap-license-install
```

Check the installed license with:

```bash
imap-plugin license status
```

The plugin verifies the license signature locally and treats it as live until `validUntil`, plus any `graceUntil` period in the file.

Stripe can still be used as a direct entitlement check when a secret key is configured. Create a Stripe Product named `IMAP Mailboxes - Mail Actions`, add a recurring monthly Price, then create a Stripe Payment Link for that Price. Configure the plugin with:

```bash
set IMAP_PLUGIN_STRIPE_SECRET_KEY=sk_live_...
set IMAP_PLUGIN_STRIPE_PAYMENT_URL=https://buy.stripe.com/...
set IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_PRICE_ID=price_...
```

To check a user's entitlement against Stripe, provide either their Stripe customer ID or subscription ID:

```bash
set IMAP_PLUGIN_STRIPE_CUSTOMER_ID=cus_...
```

or:

```bash
set IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_SUBSCRIPTION_ID=sub_...
```

The feature is live when Stripe reports the matching subscription as `active` or `trialing`.

For local development without Stripe, simulate a live subscription with:

```bash
set IMAP_PLUGIN_SUBSCRIPTION_STATUS=active
```

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
- `dev-sql-vault`: stores development secrets in SQL Server to emulate Azure Key Vault locally.

The default provider is `local-keychain`.

## Account Store

By default, account profiles are stored in the local `accounts.json` config file. For public-MCP development, store account profile metadata in SQL Server instead:

```powershell
$env:IMAP_PLUGIN_ACCOUNT_STORE = "sql"
$env:IMAP_PLUGIN_SQL_CONNECTION_STRING = 'Data Source=127.0.0.1,14333;Initial Catalog=imap-mailboxes;User ID=codex;Password=<dev-password>;Pooling=False;Encrypt=False;TrustServerCertificate=False;Application Name="IMAP Plugin Dev";Command Timeout=30'
```

The SQL store creates `dbo.AccountProfiles` on first use. It stores account metadata and credential references only; mailbox passwords are still resolved through the configured credential provider.

To emulate Azure Key Vault locally, combine the SQL account store with the SQL-backed dev vault:

```powershell
$env:IMAP_PLUGIN_ACCOUNT_STORE = "sql"
$env:IMAP_PLUGIN_CREDENTIAL_PROVIDER = "dev-sql-vault"
$env:IMAP_PLUGIN_SQL_CONNECTION_STRING = 'Data Source=127.0.0.1,14333;Initial Catalog=imap-mailboxes;User ID=codex;Password=<dev-password>;Pooling=False;Encrypt=False;TrustServerCertificate=False;Application Name="IMAP Plugin Dev";Command Timeout=30'
```

The dev vault creates `dbo.DevVaultSecrets` on first use. Account rows store references like:

```text
dev-kv://imap-{user-guid}-{account-guid}
```

The secret value is stored separately as JSON in `dbo.DevVaultSecrets`, matching the future Azure Key Vault shape while keeping local development self-contained.

For local SQL Express, enable TCP only on loopback before using the SQL store:

```powershell
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp' -Name Enabled -Value 1
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp' -Name ListenOnAllIPs -Value 0
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IP16' -Name Enabled -Value 1
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IP16' -Name TcpDynamicPorts -Value ''
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IP16' -Name TcpPort -Value '14333'
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IPAll' -Name TcpDynamicPorts -Value ''
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IPAll' -Name TcpPort -Value ''
Restart-Service -Name 'MSSQL$SQLEXPRESS' -Force
```

## Development

```bash
npm install
npm run build
npm start
```

## Hosted MCP on Azure

Local Codex installs use stdio by default. For Azure App Service or another public host, run the same server in Streamable HTTP mode:

```bash
set IMAP_PLUGIN_TRANSPORT=http
set IMAP_PLUGIN_CREDENTIAL_PROVIDER=env
npm start
```

The HTTP server listens on `process.env.PORT`, exposes `GET /health`, and serves the MCP endpoint at `POST /mcp`. In Azure App Service, configure:

```bash
NODE_ENV=production
IMAP_PLUGIN_TRANSPORT=http
IMAP_PLUGIN_CREDENTIAL_PROVIDER=env
IMAP_PLUGIN_PUBLIC_BASE_URL=https://<app-name>.azurewebsites.net
```

Do not use `local-keychain` on a public App Service host. Use environment-backed demo credentials, Azure Key Vault, or a hosted per-user credential flow.

## Local IIS Development Host

For public MCP development on Windows, IIS can host the HTTP MCP server through HttpPlatformHandler. Install IIS, Node.js 20 or newer, and IIS HttpPlatformHandler first.

Build the server:

```powershell
npm install
npm run build
```

Then run PowerShell as Administrator and configure the local IIS site:

```powershell
.\scripts\setup-local-iis.ps1
```

The script copies the runtime files to `C:\inetpub\imap-plugin-mcp`, grants that IIS app pool access to the deployment folder, and points the IIS site there. This avoids granting IIS access to the whole repository under your user profile.

If `C:\inetpub` is locked down on your machine, choose a different deployment folder:

```powershell
.\scripts\setup-local-iis.ps1 -PhysicalPath "C:\Users\pauls\source\repos\IMAP Plugin\.iis-deploy"
```

The default local endpoints are:

```text
http://localhost:8088/health
http://localhost:8088/mcp
```

The checked-in `web.config` starts `node dist/server.js` with:

```text
IMAP_PLUGIN_TRANSPORT=http
IMAP_PLUGIN_ACCOUNT_STORE=sql
IMAP_PLUGIN_CREDENTIAL_PROVIDER=dev-sql-vault
```

Set `IMAP_PLUGIN_SQL_CONNECTION_STRING` in the machine, user, or IIS app-pool environment before using the setup page under IIS. For public-MCP work, do not use `local-keychain` under IIS. Use `dev-sql-vault` only for local development and move production credentials to Azure Key Vault.

## Setup Page

The MCP server starts a localhost setup page when it launches. Ask Codex to call `imap_configure`, then open the returned URL. `imap_open_setup` remains as a compatibility alias.

Users can also invoke the plugin command:

```text
/imap-configure
```

The page supports:

- Add or update account profiles.
- Test a connection before saving.
- Test saved accounts.
- Run paid SMTP round-trip tests that show the From/To addresses, send to the account's own mailbox address, verify delivery in that account's `INBOX`, and mark the test message read.
- Remove saved accounts and local keychain secrets.
- Store credentials in the local operating system keychain.

By default the setup page binds to `127.0.0.1:37891`. If that port is busy, it falls back to an available local port. You can override the preferred port with:

```bash
set IMAP_PLUGIN_SETUP_PORT=37900
```

## Uninstall Cleanup

When the plugin is uninstalled, Codex should ask the user whether to remove local IMAP Mailboxes configuration. If the user confirms, call `imap_cleanup_config` with `confirm: true`, or run:

```bash
imap-plugin cleanup --yes
```

Cleanup removes saved account profiles, plugin preferences, the installed license file, and local-keychain mailbox secrets. Environment variables and 1Password items cannot be removed safely by the plugin; cleanup reports any referenced names so the user can remove them from their shell, OS profile, or vault.

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
- `imap_cleanup_config`
- `imap_subscription_status`
- `imap_upgrade_subscription`
- `imap_license_status`
- `imap_install_license`
- `imap_test_account`
- `imap_list_folders`
- `imap_search_messages`
- `imap_read_message`
- `imap_read_attachment`
- `imap_read_messages`
- `imap_search_and_read_messages`

## Search Filters

The free tier includes the full read-only IMAP search suite through `imap_search_messages` and `imap_search_and_read_messages`:

- Text fields: `query`, `text`, `subject`, `body`.
- Address fields: `from`, `to`, `cc`, `bcc`.
- Headers: `header`.
- Flags: `seen`, `unseenOnly`, `answered`, `flagged`, `draft`, `deleted`, `recent`.
- Dates: `since`, `before`, `on`, `sentSince`, `sentBefore`, `sentOn`.
- Ranges and size: `uidRange`, `sequenceRange`, `largerThanBytes`, `smallerThanBytes`.
- Provider extensions: `gmailRaw`.
- Attachments: `hasAttachments`.

## Security Notes

- Prefer provider-specific app passwords over primary mailbox passwords.
- Do not log mailbox credentials.
- Do not expose SMTP send until there is an explicit confirmation path.
- Keep message bodies out of telemetry and crash reports.
