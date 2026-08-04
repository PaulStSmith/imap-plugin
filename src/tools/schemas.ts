import { z } from "zod";

export const accountIdSchema = z.object({
  accountId: z.string().min(1).describe("Configured account id.")
});

export const addAccountSchema = z.object({
  accountId: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().optional().describe("Mailbox email address. Used as the round-trip test recipient."),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  username: z.string().min(1),
  credentialProvider: z.enum(["local-keychain", "1password", "env", "dev-sql-vault"]).default("local-keychain"),
  credentialRef: z.string().optional().describe("1Password op:// reference, environment variable name, or dev SQL vault secret reference."),
  password: z.string().optional().describe("Password to store when using local-keychain or dev-sql-vault."),
  smtpHost: z.string().optional().describe("SMTP host for send/reply actions. Defaults from the IMAP host when omitted."),
  smtpPort: z.number().int().min(1).max(65535).optional().describe("SMTP port. Defaults to 587, or 465 when smtpSecure is true."),
  smtpSecure: z.boolean().optional().describe("Use implicit TLS for SMTP, usually port 465. When false, STARTTLS is attempted."),
  smtpUsername: z.string().optional().describe("SMTP username. Defaults to the IMAP username when omitted.")
});

export const mailboxSchema = accountIdSchema.extend({
  mailbox: z.string().min(1).default("INBOX")
});

export const searchSchema = mailboxSchema.extend({
  query: z.string().optional().describe("Broad search across subject, body, from, and to fields."),
  text: z.string().optional().describe("Search all message text supported by the IMAP server."),
  subject: z.string().optional(),
  body: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  header: z.record(z.union([z.string(), z.boolean()])).optional().describe("Header search map, for example {\"Message-ID\":\"abc\"} or {\"List-Unsubscribe\":true}."),
  unseenOnly: z.boolean().default(false),
  seen: z.boolean().optional(),
  answered: z.boolean().optional(),
  flagged: z.boolean().optional(),
  draft: z.boolean().optional(),
  deleted: z.boolean().optional(),
  recent: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(10),
  since: z.string().optional().describe("Received on or after this ISO date."),
  before: z.string().optional().describe("Received before this ISO date."),
  on: z.string().optional().describe("Received on this ISO date, ignoring time."),
  sentSince: z.string().optional().describe("Sent on or after this ISO date."),
  sentBefore: z.string().optional().describe("Sent before this ISO date."),
  sentOn: z.string().optional().describe("Sent on this ISO date, ignoring time."),
  uidRange: z.string().optional().describe("IMAP UID sequence range, for example 100:200 or 500:*."),
  sequenceRange: z.string().optional().describe("IMAP message sequence range, for example 1:50."),
  largerThanBytes: z.number().int().positive().optional(),
  smallerThanBytes: z.number().int().positive().optional(),
  keyword: z.string().optional().describe("Custom IMAP keyword/flag that must be present."),
  unKeyword: z.string().optional().describe("Custom IMAP keyword/flag that must not be present."),
  gmailRaw: z.string().optional().describe("Gmail raw search query. Only works on Gmail IMAP servers.")
});

export const readMessageSchema = mailboxSchema.extend({
  uid: z.number().int().positive()
});

export const readAttachmentSchema = readMessageSchema.extend({
  attachmentIndex: z.number().int().min(0).describe("Zero-based attachment index from imap_read_message attachments[].index.")
});

export const readMessagesSchema = mailboxSchema.extend({
  uids: z.array(z.number().int().positive()).min(1).max(50)
});

export const searchAndReadSchema = searchSchema.extend({
  includeText: z.boolean().default(true)
});

export const paidFeatureSchema = z.object({
  feature: z.enum(["mail_actions"]).default("mail_actions")
});

const uidActionSchema = mailboxSchema.extend({
  uids: z.array(z.number().int().positive()).min(1).max(100)
});

export const messageFlagSchema = uidActionSchema.extend({
  mode: z.enum(["add", "remove", "set"]).default("add"),
  flags: z.array(z.string().min(1)).min(1).max(20).describe("IMAP flags such as \\Seen, \\Flagged, \\Answered, \\Draft, or provider keywords.")
});

export const messageColorSchema = uidActionSchema.extend({
  color: z.enum(["red", "orange", "yellow", "green", "blue", "purple", "grey"])
});

export const moveMessagesSchema = uidActionSchema.extend({
  destination: z.string().min(1).describe("Destination mailbox/folder path.")
});

export const appendMessageSchema = mailboxSchema.extend({
  raw: z.string().min(1).describe("Raw RFC 822 message content to append."),
  flags: z.array(z.string().min(1)).max(20).default([]),
  internalDate: z.string().optional().describe("Optional internal date for the appended message.")
});

export const folderPathSchema = accountIdSchema.extend({
  path: z.string().min(1).describe("Mailbox/folder path.")
});

export const renameFolderSchema = folderPathSchema.extend({
  newPath: z.string().min(1).describe("New mailbox/folder path.")
});

const addressListSchema = z.array(z.string().email()).min(1).max(100);
const optionalAddressListSchema = z.array(z.string().email()).max(100).optional();
const smtpOverrideSchema = z.object({
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().optional()
});

export const sendMessageSchema = accountIdSchema.merge(smtpOverrideSchema).extend({
  to: addressListSchema,
  cc: optionalAddressListSchema,
  bcc: optionalAddressListSchema,
  subject: z.string().default(""),
  text: z.string().optional(),
  html: z.string().optional()
});

export const replyMessageSchema = readMessageSchema.merge(smtpOverrideSchema).extend({
  replyAll: z.boolean().default(false),
  to: optionalAddressListSchema,
  cc: optionalAddressListSchema,
  bcc: optionalAddressListSchema,
  subject: z.string().optional(),
  text: z.string().min(1),
  html: z.string().optional()
});

export const preferencesSchema = z.object({
  smtpActionsEnabled: z.boolean().describe("Allow entitled SMTP send, reply, and round-trip actions.")
});

export const cleanupConfigSchema = z.object({
  confirm: z.literal(true).describe("Must be true to remove local plugin config and local-keychain secrets.")
});
