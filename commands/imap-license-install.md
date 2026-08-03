# /imap-license-install

Install a ByteForge `.lic` license file for the IMAP plugin.

## Workflow

1. Ask the user for the local path to the `.lic` file if they did not provide it.
2. Call the `imap_install_license` MCP tool with that path.
3. Report whether the license is active, in grace, expired, invalid, or missing.

## Notes

- The license file is copied into the plugin's local config directory after signature verification.
- Do not ask the user to paste private signing keys or Stripe secrets in chat.
