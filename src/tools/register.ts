import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { importLicenseFile, licenseStatus } from "../billing/license.js";
import { subscriptionRequired, subscriptionStatus } from "../billing/subscription.js";
import { getAccount, readAccounts, removeAccount, upsertAccount } from "../config/accounts.js";
import { publicAccount } from "../config/public-account.js";
import { startSetupServer } from "../config/setup-server.js";
import { createCredentialProvider } from "../credentials/index.js";
import { listFolders, readAttachment, readMessage, readMessages, searchAndReadMessages, searchMessages, testAccount } from "../mail/imap-client.js";
import { AccountProfile } from "../types.js";
import {
  accountIdSchema,
  addAccountSchema,
  mailboxSchema,
  paidFeatureSchema,
  licenseInstallSchema,
  readAttachmentSchema,
  readMessageSchema,
  readMessagesSchema,
  searchAndReadSchema,
  searchSchema
} from "./schemas.js";

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function setupPageResponse() {
  const setup = await startSetupServer();
  return jsonResponse({
    url: setup.url,
    host: setup.host,
    port: setup.port
  });
}

export function registerTools(server: McpServer): void {
  server.tool("imap_open_setup", "Get the local setup page URL for configuring and testing IMAP accounts.", {}, async () => {
    return setupPageResponse();
  });

  server.tool("imap_configure", "Open the local configuration page to add, test, edit, or reconfigure IMAP accounts.", {}, async () => {
    return setupPageResponse();
  });

  server.tool("imap_add_account", "Add or update an IMAP account profile.", addAccountSchema.shape, async (input) => {
    const account: AccountProfile = {
      id: input.accountId,
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      credentialProvider: input.credentialProvider,
      credentialRef: input.credentialRef
    };

    if (input.credentialProvider === "local-keychain") {
      if (!input.password) {
        throw new Error("A password is required when credentialProvider is local-keychain.");
      }

      await createCredentialProvider("local-keychain").set?.(account, input.password);
    }

    await upsertAccount(account);
    return jsonResponse({ account: publicAccount(account) });
  });

  server.tool("imap_list_accounts", "List configured IMAP account profiles without secrets.", {}, async () => {
    const accounts = await readAccounts();
    return jsonResponse({ accounts: accounts.map(publicAccount) });
  });

  server.tool("imap_subscription_status", "Check whether a paid IMAP Mailboxes feature has an active subscription.", paidFeatureSchema.shape, async (input) => {
    return jsonResponse({ subscription: await subscriptionStatus(input.feature) });
  });

  server.tool("imap_license_status", "Check the installed ByteForge license file for this IMAP Plugin.", {}, async () => {
    return jsonResponse({ license: await licenseStatus() });
  });

  server.tool("imap_install_license", "Install a local ByteForge .lic license file for this IMAP Plugin.", licenseInstallSchema.shape, async (input) => {
    return jsonResponse({ license: await importLicenseFile(input.path) });
  });

  server.tool("imap_upgrade_subscription", "Get the payment link for a paid IMAP Mailboxes feature.", paidFeatureSchema.shape, async (input) => {
    return jsonResponse(subscriptionRequired(input.feature, "Paid mail actions"));
  });

  server.tool("imap_remove_account", "Remove an IMAP account profile and its local keychain password if present.", accountIdSchema.shape, async (input) => {
    const account = await getAccount(input.accountId);
    await createCredentialProvider(account.credentialProvider).delete?.(account);
    const removed = await removeAccount(input.accountId);
    return jsonResponse({ removed });
  });

  server.tool("imap_test_account", "Test IMAP login for a configured account.", accountIdSchema.shape, async (input) => {
    return jsonResponse(await testAccount(await getAccount(input.accountId)));
  });

  server.tool("imap_list_folders", "List folders/mailboxes for a configured IMAP account.", accountIdSchema.shape, async (input) => {
    const folders = await listFolders(await getAccount(input.accountId));
    return jsonResponse({ folders });
  });

  server.tool("imap_search_messages", "Search messages in a configured IMAP mailbox.", searchSchema.shape, async (input) => {
    const messages = await searchMessages(await getAccount(input.accountId), input);
    return jsonResponse({ messages });
  });

  server.tool("imap_read_message", "Read one message by mailbox and IMAP UID.", readMessageSchema.shape, async (input) => {
    const message = await readMessage(await getAccount(input.accountId), input.mailbox, input.uid);
    return jsonResponse({ message });
  });

  server.tool("imap_read_attachment", "Read one attachment from a message as base64 content.", readAttachmentSchema.shape, async (input) => {
    const attachment = await readAttachment(await getAccount(input.accountId), input.mailbox, input.uid, input.attachmentIndex);
    return jsonResponse({ attachment });
  });

  server.tool("imap_read_messages", "Read multiple messages by mailbox and IMAP UIDs using one IMAP connection.", readMessagesSchema.shape, async (input) => {
    const messages = await readMessages(await getAccount(input.accountId), input);
    return jsonResponse({ messages });
  });

  server.tool("imap_search_and_read_messages", "Search messages and read the matches using one IMAP connection.", searchAndReadSchema.shape, async (input) => {
    const messages = await searchAndReadMessages(await getAccount(input.accountId), input);
    return jsonResponse({ messages });
  });

  server.tool("imap_get_folder_status", "Get message counts for a mailbox.", mailboxSchema.shape, async (input) => {
    const account = await getAccount(input.accountId);
    const folders = await listFolders(account);
    const folder = folders.find((entry) => entry.path === input.mailbox);
    return jsonResponse({ folder: folder ?? null });
  });
}
