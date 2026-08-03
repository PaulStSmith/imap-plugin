# /imap-configure

Open the IMAP plugin setup page so the user can add, test, edit, or reconfigure mailbox accounts.

## Workflow

1. Call the `imap_configure` MCP tool.
2. Show the returned local setup URL to the user.
3. Tell the user to open that URL in their browser to manage IMAP accounts.

## Notes

- The setup URL is local to the user's machine and may use a fallback port.
- Do not ask for mailbox passwords in chat; the setup page stores them through the local operating system keychain.
