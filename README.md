# IMAP Plugin

Connect Codex to generic IMAP mailboxes through an MCP server.

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

The default provider is `local-keychain`.

## Development

```bash
npm install
npm run build
npm start
```

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
