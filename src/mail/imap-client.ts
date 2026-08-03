import { ImapFlow, MailboxLockObject } from "imapflow";
import { simpleParser } from "mailparser";
import { htmlToText } from "html-to-text";
import { AccountProfile, AttachmentMetadata, MessageDetail, MessageSummary } from "../types.js";
import { providerForAccount } from "../credentials/index.js";
import { addressesToStrings } from "./address.js";

export interface SearchOptions {
  mailbox: string;
  query?: string;
  unseenOnly?: boolean;
  limit: number;
  since?: string;
}

async function withClient<T>(
  account: AccountProfile,
  callback: (client: ImapFlow) => Promise<T>,
  overridePassword?: string
): Promise<T> {
  const credential = overridePassword
    ? { username: account.username, password: overridePassword }
    : await providerForAccount(account).get(account);
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: credential.username,
      pass: credential.password
    },
    logger: false
  });

  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function withMailbox<T>(
  client: ImapFlow,
  mailbox: string,
  callback: (lock: MailboxLockObject) => Promise<T>
): Promise<T> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await callback(lock);
  } finally {
    lock.release();
  }
}

export async function testAccount(
  account: AccountProfile,
  overridePassword?: string
): Promise<{ ok: true; authenticatedAs: string }> {
  return withClient(account, async () => ({
    ok: true,
    authenticatedAs: account.username
  }), overridePassword);
}

export async function listFolders(account: AccountProfile) {
  return withClient(account, async (client) => {
    const folders = [];
    for (const mailbox of await client.list()) {
      folders.push({
        path: mailbox.path,
        name: mailbox.name,
        delimiter: mailbox.delimiter,
        flags: mailbox.flags,
        listed: mailbox.listed,
        subscribed: mailbox.subscribed,
        specialUse: mailbox.specialUse
      });
    }

    return folders;
  });
}

export async function searchMessages(account: AccountProfile, options: SearchOptions): Promise<MessageSummary[]> {
  return withClient(account, async (client) =>
    withMailbox(client, options.mailbox, async () => {
      const criteria: Record<string, unknown> = {};
      if (options.unseenOnly) {
        criteria.seen = false;
      }

      if (options.since) {
        criteria.since = new Date(options.since);
      }

      if (options.query) {
        criteria.or = [
          { subject: options.query },
          { body: options.query }
        ];
      }

      const uids = await client.search(criteria, { uid: true });
      if (!uids) {
        return [];
      }

      const latest = uids.slice(-options.limit).reverse();
      const messages: MessageSummary[] = [];

      for await (const message of client.fetch(latest, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true
      }, { uid: true })) {
        const flags = Array.from(message.flags ?? []).map(String);
        messages.push({
          uid: message.uid,
          subject: message.envelope?.subject ?? null,
          from: addressesToStrings(message.envelope?.from),
          to: addressesToStrings(message.envelope?.to),
          date: message.envelope?.date?.toISOString() ?? null,
          flags,
          seen: flags.includes("\\Seen"),
          answered: flags.includes("\\Answered"),
          hasAttachments: Boolean(message.bodyStructure?.childNodes?.some((node) => node.disposition === "attachment"))
        });
      }

      return messages;
    })
  );
}

export async function readMessage(account: AccountProfile, mailbox: string, uid: number): Promise<MessageDetail> {
  return withClient(account, async (client) =>
    withMailbox(client, mailbox, async () => {
      const message = await client.fetchOne(uid, {
        uid: true,
        flags: true,
        source: true
      }, { uid: true });

      if (!message || !message.source) {
        throw new Error(`Message UID ${uid} was not found in "${mailbox}".`);
      }

      const parsed = await simpleParser(message.source);
      const flags = Array.from(message.flags ?? []).map(String);
      const attachments: AttachmentMetadata[] = parsed.attachments.map((attachment) => ({
        filename: attachment.filename ?? null,
        contentType: attachment.contentType,
        size: attachment.size ?? null,
        contentId: attachment.contentId ?? null
      }));

      const html = typeof parsed.html === "string" ? parsed.html : undefined;
      const text = parsed.text?.trim() || (html ? htmlToText(html).trim() : "");

      return {
        uid,
        subject: parsed.subject ?? null,
        from: addressesToStrings(parsed.from),
        to: addressesToStrings(parsed.to),
        cc: addressesToStrings(parsed.cc),
        bcc: addressesToStrings(parsed.bcc),
        date: parsed.date?.toISOString() ?? null,
        flags,
        seen: flags.includes("\\Seen"),
        answered: flags.includes("\\Answered"),
        hasAttachments: attachments.length > 0,
        text,
        html,
        attachments
      };
    })
  );
}
