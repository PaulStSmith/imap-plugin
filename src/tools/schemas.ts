import { z } from "zod";

export const accountIdSchema = z.object({
  accountId: z.string().min(1).describe("Configured account id.")
});

export const addAccountSchema = z.object({
  accountId: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  username: z.string().min(1),
  credentialProvider: z.enum(["local-keychain", "1password", "env"]).default("local-keychain"),
  credentialRef: z.string().optional().describe("1Password op:// reference or environment variable name."),
  password: z.string().optional().describe("Password to store when using local-keychain.")
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

export const licenseInstallSchema = z.object({
  path: z.string().min(1).describe("Local path to the ByteForge .lic file.")
});
