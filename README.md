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

SMTP sending and mailbox actions are gated by a stable IMAP Mailboxes installation ID and by an explicit local SMTP sending preference.

## Installation Entitlement

Mail action tools call the entitlement gate before performing sends or mailbox mutations. Each local install creates an `installation.json` file in the plugin config directory with a stable `installationId`. Read it with:

```text
imap_installation_status
```

Associate that installation ID with the paid Stripe customer in `dbo.InstallationEntitlements`. The table is created on first entitlement check when `IMAP_PLUGIN_SQL_CONNECTION_STRING` is configured. A live row looks like:

```sql
MERGE dbo.InstallationEntitlements AS target
USING (SELECT
  N'imap_00000000-0000-0000-0000-000000000000' AS InstallationId,
  N'mail_actions' AS Feature
) AS source
ON target.InstallationId = source.InstallationId
  AND target.Feature = source.Feature
WHEN MATCHED THEN
  UPDATE SET
    Status = N'active',
    StripeCustomerId = N'cus_...',
    StripeSubscriptionId = N'sub_...',
    ValidUntilUtc = NULL,
    UpdatedAtUtc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (InstallationId, Feature, Status, StripeCustomerId, StripeSubscriptionId, ValidUntilUtc)
  VALUES (source.InstallationId, source.Feature, N'active', N'cus_...', N'sub_...', NULL);
```

When the installation ID is not entitled, the plugin returns a structured `subscription_required` response telling the user to register this installation with a paid customer.

When a Codex instance tries to use a paid tool, the MCP server returns `subscription_required` with:

- `plansUrl`: `https://paulstsmith.github.io/imap-plugin/#plans`
- `paymentUrl`: the same plans URL, retained for clients that already look for a payment link
- activation guidance telling the user to subscribe, then give the Stripe subscription ID back to Codex

The plans page links to Stripe Checkout through a Payment Link. After checkout, the user gives their Stripe subscription ID to Codex. Codex calls:

```text
imap_activate_subscription({"subscriptionId":"sub_..."})
```

The MCP server validates the subscription with Stripe, reads the local installation ID, and writes the entitlement to `dbo.InstallationEntitlements`. Stripe customer and subscription references belong in `dbo.InstallationEntitlements`, not in `web.config` or per-install environment variables.

Automatic renewal and cancellation updates require a stable public MCP host URL. Do not register a Stripe webhook while the MCP host is still local, temporary, or unknown.

Once the MCP host is stable, configure Stripe to send subscription webhooks to:

```text
https://<public-mcp-host>/stripe/webhook
```

Store the webhook signing secret as `IMAP_PLUGIN_STRIPE_WEBHOOK_SECRET` in the MCP host environment. The webhook updates an existing installation entitlement by Stripe subscription ID; the initial installation binding still happens through `imap_activate_subscription`.

Until that public host exists, use `imap_activate_subscription` as the activation path and reconcile subscription changes manually in `dbo.InstallationEntitlements`.

To make the GitHub Pages pricing button live, create a Stripe Payment Link for the Mail Actions recurring price and paste its public `https://buy.stripe.com/...` URL into `docs/index.html`:

```html
data-checkout-url="https://buy.stripe.com/fZu28s1HK7lQ4xicIKcIE01"
```

For local development without a DB entitlement, simulate a live subscription with:

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
IMAP_PLUGIN_SETUP_TOKEN=<strong-random-setup-token>
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

The script copies the runtime files to `C:\inetpub\imap-plugin-mcp`, grants that IIS app pool access to the deployment folder, points the IIS site there, and writes the configured public base URL into the deployed `web.config`. This avoids granting IIS access to the whole repository under your user profile.

To use a different local binding or setup token:

```powershell
.\scripts\setup-local-iis.ps1 -Binding "http/*:8090:" -PublicBaseUrl "http://localhost:8090" -SetupToken "local-dev-setup-token"
```

If `C:\inetpub` is locked down on your machine, choose a different deployment folder:

```powershell
.\scripts\setup-local-iis.ps1 -PhysicalPath "C:\Users\pauls\source\repos\IMAP Plugin\.iis-deploy"
```

The default local endpoints are:

```text
http://localhost:8088/health
http://localhost:8088/setup
http://localhost:8088/mcp
```

The checked-in `web.config` starts `node dist/server.js` with:

```text
IMAP_PLUGIN_TRANSPORT=http
IMAP_PLUGIN_PUBLIC_BASE_URL=http://localhost:8088
IMAP_PLUGIN_ACCOUNT_STORE=sql
IMAP_PLUGIN_CREDENTIAL_PROVIDER=dev-sql-vault
```

The setup script writes `IMAP_PLUGIN_SETUP_TOKEN` into the deployed `web.config`. If no token is provided, it uses `local-dev-setup-token` for local IIS development only.

Set `IMAP_PLUGIN_SQL_CONNECTION_STRING` in the machine, user, or IIS app-pool environment before using the setup page under IIS. For public-MCP work, do not use `local-keychain` under IIS. Use `dev-sql-vault` only for local development and move production credentials to Azure Key Vault.

## Setup Page

In HTTP mode, the MCP server hosts the setup page at `/setup` next to `/mcp`. Ask Codex to call `imap_configure`, then open the returned URL. The URL includes the configured setup token. `imap_open_setup` remains as a compatibility alias.

In stdio mode, the MCP server still starts a temporary localhost setup page for local-only installs.

Users can also invoke the plugin command:

```text
/imap-configure
```

The page supports:

- Add or update account profiles.
- Test a connection before saving.
- Test saved accounts.
- Run SMTP round-trip tests that show the From/To addresses, send to the account's own mailbox address, verify delivery in that account's `INBOX`, and mark the test message read.
- Remove saved accounts and credential-provider secrets when supported.
- Store credentials through the configured provider, such as the local keychain for stdio installs or `dev-sql-vault` for local public-MCP development.

For stdio mode only, the setup page binds to `127.0.0.1:37891` by default. If that port is busy, it falls back to an available local port. You can override the preferred port with:

```bash
set IMAP_PLUGIN_SETUP_PORT=37900
```

## Uninstall Cleanup

When the plugin is uninstalled, Codex should ask the user whether to remove local IMAP Mailboxes configuration. If the user confirms, call `imap_cleanup_config` with `confirm: true`, or run:

```bash
imap-plugin cleanup --yes
```

Cleanup removes saved account profiles, plugin preferences, the local installation ID, and local-keychain mailbox secrets. Environment variables and 1Password items cannot be removed safely by the plugin; cleanup reports any referenced names so the user can remove them from their shell, OS profile, or vault.

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
- `imap_installation_status`
- `imap_upgrade_subscription`
- `imap_activate_subscription`
- `imap_subscription_status`
- `imap_test_account`
- `imap_list_folders`
- `imap_search_messages`
- `imap_read_message`
- `imap_read_attachment`
- `imap_read_messages`
- `imap_search_and_read_messages`

## Search Filters

Read-only IMAP search is available through `imap_search_messages` and `imap_search_and_read_messages`:

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
