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
  query: z.string().optional(),
  unseenOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
  since: z.string().optional().describe("Optional ISO date string.")
});

export const readMessageSchema = mailboxSchema.extend({
  uid: z.number().int().positive()
});
