import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { importLicenseFile, licenseStatus } from "../billing/license.js";
import { requireSubscription, subscriptionRequired, subscriptionStatus } from "../billing/subscription.js";
import { cleanupConfig } from "../config/cleanup.js";
import { getAccount, readAccounts, removeAccount, upsertAccount } from "../config/accounts.js";
import { readPreferences, updatePreferences } from "../config/preferences.js";
import { publicAccount } from "../config/public-account.js";
import { startSetupServer } from "../config/setup-server.js";
import { createCredentialProvider } from "../credentials/index.js";
import {
  appendMessage,
  copyMessages,
  createFolder,
  deleteFolder,
  deleteMessages,
  getQuota,
  listFolders,
  moveMessages,
  readAttachment,
  readMessage,
  readMessages,
  renameFolder,
  searchAndReadMessages,
  searchMessages,
  setMessageColor,
  subscribeFolder,
  testAccount,
  unsubscribeFolder,
  updateMessageFlags
} from "../mail/imap-client.js";
import { replyToMessage, sendMessage } from "../mail/smtp-client.js";
import { AccountProfile } from "../types.js";
import {
  accountIdSchema,
  addAccountSchema,
  mailboxSchema,
  paidFeatureSchema,
  licenseInstallSchema,
  appendMessageSchema,
  folderPathSchema,
  messageColorSchema,
  messageFlagSchema,
  moveMessagesSchema,
  readAttachmentSchema,
  readMessageSchema,
  readMessagesSchema,
  renameFolderSchema,
  replyMessageSchema,
  searchAndReadSchema,
  searchSchema,
  sendMessageSchema,
  preferencesSchema,
  cleanupConfigSchema
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

async function paidAction(action: string) {
  return requireSubscription("mail_actions", action);
}

async function requireSmtpSendingEnabled() {
  if (!(await readPreferences()).smtpActionsEnabled) {
    return {
      ok: false,
      code: "smtp_sending_disabled",
      requiresSubscription: false,
      action: "SMTP sending",
      message: "SMTP sending is disabled in plugin settings. Open imap_configure and enable SMTP sending first."
    };
  }

  return undefined;
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

  server.tool("imap_preferences", "Read local IMAP Plugin preferences, including subscriber-only action switches.", {}, async () => {
    return jsonResponse({
      subscription: await subscriptionStatus("mail_actions"),
      preferences: await readPreferences()
    });
  });

  server.tool("imap_update_preferences", "Update local IMAP Plugin preferences. SMTP sending can only be enabled by paid subscribers.", preferencesSchema.shape, async (input) => {
    if (input.smtpActionsEnabled) {
      const required = await paidAction("Enable SMTP sending");
      if (required) return jsonResponse(required);
    }

    return jsonResponse({
      preferences: await updatePreferences({
        smtpActionsEnabled: input.smtpActionsEnabled
      })
    });
  });

  server.tool("imap_remove_account", "Remove an IMAP account profile and its local keychain password if present.", accountIdSchema.shape, async (input) => {
    const account = await getAccount(input.accountId);
    await createCredentialProvider(account.credentialProvider).delete?.(account);
    const removed = await removeAccount(input.accountId);
    return jsonResponse({ removed });
  });

  server.tool("imap_cleanup_config", "Remove all local IMAP Plugin config files and local-keychain mailbox secrets after explicit user confirmation, such as during uninstall.", cleanupConfigSchema.shape, async () => {
    return jsonResponse(await cleanupConfig());
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

  server.tool("imap_send_message", "Send an email through the account SMTP server. Requires a paid license.", sendMessageSchema.shape, async (input) => {
    const required = await paidAction("Send email");
    if (required) return jsonResponse(required);
    const disabled = await requireSmtpSendingEnabled();
    if (disabled) return jsonResponse(disabled);
    return jsonResponse({ sent: await sendMessage(await getAccount(input.accountId), input) });
  });

  server.tool("imap_reply_message", "Reply to an IMAP message through SMTP. Requires a paid license.", replyMessageSchema.shape, async (input) => {
    const required = await paidAction("Reply to email");
    if (required) return jsonResponse(required);
    const disabled = await requireSmtpSendingEnabled();
    if (disabled) return jsonResponse(disabled);
    return jsonResponse({ sent: await replyToMessage(await getAccount(input.accountId), input) });
  });

  server.tool("imap_update_message_flags", "Add, remove, or set IMAP flags on messages. Requires a paid license.", messageFlagSchema.shape, async (input) => {
    const required = await paidAction("Update message flags");
    if (required) return jsonResponse(required);
    return jsonResponse(await updateMessageFlags(await getAccount(input.accountId), input));
  });

  server.tool("imap_set_message_color", "Set a provider-supported color flag on messages. Requires a paid license.", messageColorSchema.shape, async (input) => {
    const required = await paidAction("Set message color");
    if (required) return jsonResponse(required);
    return jsonResponse(await setMessageColor(await getAccount(input.accountId), input));
  });

  server.tool("imap_copy_messages", "Copy messages to another mailbox. Requires a paid license.", moveMessagesSchema.shape, async (input) => {
    const required = await paidAction("Copy messages");
    if (required) return jsonResponse(required);
    return jsonResponse(await copyMessages(await getAccount(input.accountId), input));
  });

  server.tool("imap_move_messages", "Move messages to another mailbox. Requires a paid license.", moveMessagesSchema.shape, async (input) => {
    const required = await paidAction("Move messages");
    if (required) return jsonResponse(required);
    return jsonResponse(await moveMessages(await getAccount(input.accountId), input));
  });

  server.tool("imap_delete_messages", "Permanently delete messages from a mailbox. Requires a paid license.", readMessagesSchema.shape, async (input) => {
    const required = await paidAction("Delete messages");
    if (required) return jsonResponse(required);
    return jsonResponse(await deleteMessages(await getAccount(input.accountId), input));
  });

  server.tool("imap_append_message", "Append a raw RFC 822 message to a mailbox. Requires a paid license.", appendMessageSchema.shape, async (input) => {
    const required = await paidAction("Append message");
    if (required) return jsonResponse(required);
    return jsonResponse(await appendMessage(await getAccount(input.accountId), input));
  });

  server.tool("imap_create_folder", "Create an IMAP mailbox/folder. Requires a paid license.", folderPathSchema.shape, async (input) => {
    const required = await paidAction("Create folder");
    if (required) return jsonResponse(required);
    return jsonResponse(await createFolder(await getAccount(input.accountId), input.path));
  });

  server.tool("imap_rename_folder", "Rename an IMAP mailbox/folder. Requires a paid license.", renameFolderSchema.shape, async (input) => {
    const required = await paidAction("Rename folder");
    if (required) return jsonResponse(required);
    return jsonResponse(await renameFolder(await getAccount(input.accountId), input.path, input.newPath));
  });

  server.tool("imap_delete_folder", "Delete an IMAP mailbox/folder. Requires a paid license.", folderPathSchema.shape, async (input) => {
    const required = await paidAction("Delete folder");
    if (required) return jsonResponse(required);
    return jsonResponse(await deleteFolder(await getAccount(input.accountId), input.path));
  });

  server.tool("imap_subscribe_folder", "Subscribe to an IMAP mailbox/folder. Requires a paid license.", folderPathSchema.shape, async (input) => {
    const required = await paidAction("Subscribe folder");
    if (required) return jsonResponse(required);
    return jsonResponse(await subscribeFolder(await getAccount(input.accountId), input.path));
  });

  server.tool("imap_unsubscribe_folder", "Unsubscribe from an IMAP mailbox/folder. Requires a paid license.", folderPathSchema.shape, async (input) => {
    const required = await paidAction("Unsubscribe folder");
    if (required) return jsonResponse(required);
    return jsonResponse(await unsubscribeFolder(await getAccount(input.accountId), input.path));
  });

  server.tool("imap_get_quota", "Get IMAP quota information for an account or mailbox.", folderPathSchema.partial({ path: true }).shape, async (input) => {
    return jsonResponse(await getQuota(await getAccount(input.accountId), input.path));
  });
}
