import { FetchMessageObject, ImapFlow, MailboxLockObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { htmlToText } from "html-to-text";
import { AccountProfile, AttachmentContent, AttachmentMetadata, MessageDetail, MessageSummary } from "../types.js";
import { providerForAccount } from "../credentials/index.js";
import { addressesToStrings } from "./address.js";

export interface SearchOptions {
  mailbox: string;
  query?: string;
  text?: string;
  subject?: string;
  body?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  header?: Record<string, string | boolean>;
  unseenOnly?: boolean;
  seen?: boolean;
  answered?: boolean;
  flagged?: boolean;
  draft?: boolean;
  deleted?: boolean;
  recent?: boolean;
  hasAttachments?: boolean;
  limit: number;
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
  sentOn?: string;
  uidRange?: string;
  sequenceRange?: string;
  largerThanBytes?: number;
  smallerThanBytes?: number;
  keyword?: string;
  unKeyword?: string;
  gmailRaw?: string;
}

export interface ReadMessagesOptions {
  mailbox: string;
  uids: number[];
}

export interface SearchAndReadOptions extends SearchOptions {
  includeText?: boolean;
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
  return withClient(account, async (client) => searchMessagesWithClient(client, options));
}

async function searchMessagesWithClient(client: ImapFlow, options: SearchOptions): Promise<MessageSummary[]> {
  return withMailbox(client, options.mailbox, async () => {
    const criteria = searchCriteria(options);

    const uids = await client.search(criteria, { uid: true });
    if (!uids) {
      return [];
    }

    const latest = uids.slice().reverse();
    const messages: MessageSummary[] = [];

    for (const batch of chunks(latest, Math.max(options.limit * 2, 25))) {
      const batchMessages: MessageSummary[] = [];
      for await (const message of client.fetch(batch, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true
      }, { uid: true })) {
        const summary = messageSummary(message);
        if (options.hasAttachments === undefined || summary.hasAttachments === options.hasAttachments) {
          batchMessages.push(summary);
        }
      }

      const byUid = new Map(batchMessages.map((message) => [message.uid, message]));
      for (const uid of batch) {
        const summary = byUid.get(uid);
        if (summary) {
          messages.push(summary);
        }

        if (messages.length >= options.limit) {
          return messages;
        }
      }
    }

    return messages.slice(0, options.limit);
  });
}

function searchCriteria(options: SearchOptions): SearchObject {
  const criteria: SearchObject = {};

  setString(criteria, "from", options.from);
  setString(criteria, "to", options.to);
  setString(criteria, "cc", options.cc);
  setString(criteria, "bcc", options.bcc);
  setString(criteria, "subject", options.subject);
  setString(criteria, "body", options.body);
  setString(criteria, "text", options.text);
  setString(criteria, "uid", options.uidRange);
  setString(criteria, "seq", options.sequenceRange);
  setString(criteria, "keyword", options.keyword);
  setString(criteria, "unKeyword", options.unKeyword);
  setString(criteria, "gmraw", options.gmailRaw);

  setDate(criteria, "since", options.since);
  setDate(criteria, "before", options.before);
  setDate(criteria, "on", options.on);
  setDate(criteria, "sentSince", options.sentSince);
  setDate(criteria, "sentBefore", options.sentBefore);
  setDate(criteria, "sentOn", options.sentOn);

  setBoolean(criteria, "answered", options.answered);
  setBoolean(criteria, "flagged", options.flagged);
  setBoolean(criteria, "draft", options.draft);
  setBoolean(criteria, "deleted", options.deleted);
  setBoolean(criteria, "recent", options.recent);

  if (options.unseenOnly) {
    criteria.seen = false;
  } else {
    setBoolean(criteria, "seen", options.seen);
  }

  if (options.largerThanBytes !== undefined) {
    criteria.larger = options.largerThanBytes;
  }

  if (options.smallerThanBytes !== undefined) {
    criteria.smaller = options.smallerThanBytes;
  }

  if (options.header && Object.keys(options.header).length) {
    criteria.header = options.header;
  }

  if (options.query) {
    criteria.or = [
      { subject: options.query },
      { body: options.query },
      { from: options.query },
      { to: options.query }
    ];
  }

  return Object.keys(criteria).length ? criteria : { all: true };
}

function setString<K extends keyof SearchObject>(criteria: SearchObject, key: K, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    (criteria as Record<string, unknown>)[key] = normalized;
  }
}

function setDate<K extends keyof SearchObject>(criteria: SearchObject, key: K, value: string | undefined): void {
  if (value) {
    (criteria as Record<string, unknown>)[key] = value;
  }
}

function setBoolean<K extends keyof SearchObject>(criteria: SearchObject, key: K, value: boolean | undefined): void {
  if (value !== undefined) {
    (criteria as Record<string, unknown>)[key] = value;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function messageSummary(message: FetchMessageObject): MessageSummary {
  const flags = Array.from(message.flags ?? []).map(String);
  return {
    uid: message.uid,
    subject: message.envelope?.subject ?? null,
    from: addressesToStrings(message.envelope?.from),
    to: addressesToStrings(message.envelope?.to),
    date: message.envelope?.date?.toISOString() ?? null,
    flags,
    seen: flags.includes("\\Seen"),
    answered: flags.includes("\\Answered"),
    hasAttachments: bodyStructureHasAttachment(message.bodyStructure)
  };
}

function bodyStructureHasAttachment(node: unknown): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }

  const candidate = node as {
    disposition?: string;
    parameters?: Record<string, unknown>;
    childNodes?: unknown[];
  };

  if (candidate.disposition?.toLowerCase() === "attachment" || typeof candidate.parameters?.name === "string") {
    return true;
  }

  return Boolean(candidate.childNodes?.some(bodyStructureHasAttachment));
}

async function parseFetchedMessage(
  message: Awaited<ReturnType<ImapFlow["fetchOne"]>>,
  mailbox: string,
  uid: number
): Promise<MessageDetail> {
  if (!message || !message.source) {
    throw new Error(`Message UID ${uid} was not found in "${mailbox}".`);
  }

  const parsed = await simpleParser(message.source);
  const flags = Array.from(message.flags ?? []).map(String);
  const attachments: AttachmentMetadata[] = parsed.attachments.map((attachment, index) => ({
    index,
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
}

async function fetchMessage(client: ImapFlow, mailbox: string, uid: number): Promise<MessageDetail> {
  const message = await client.fetchOne(uid, {
    uid: true,
    flags: true,
    source: true
  }, { uid: true });

  return parseFetchedMessage(message, mailbox, uid);
}

export async function readMessage(account: AccountProfile, mailbox: string, uid: number): Promise<MessageDetail> {
  return withClient(account, async (client) =>
    withMailbox(client, mailbox, async () => fetchMessage(client, mailbox, uid))
  );
}

export async function readAttachment(
  account: AccountProfile,
  mailbox: string,
  uid: number,
  attachmentIndex: number
): Promise<AttachmentContent> {
  return withClient(account, async (client) =>
    withMailbox(client, mailbox, async () => {
      const message = await client.fetchOne(uid, {
        source: true
      }, { uid: true });

      if (!message || !message.source) {
        throw new Error(`Message UID ${uid} was not found in "${mailbox}".`);
      }

      const parsed = await simpleParser(message.source);
      const attachment = parsed.attachments[attachmentIndex];
      if (!attachment) {
        throw new Error(`Attachment index ${attachmentIndex} was not found on message UID ${uid}.`);
      }

      return {
        index: attachmentIndex,
        filename: attachment.filename ?? null,
        contentType: attachment.contentType,
        size: attachment.size ?? attachment.content.length,
        contentId: attachment.contentId ?? null,
        contentBase64: attachment.content.toString("base64")
      };
    })
  );
}

export async function readMessages(account: AccountProfile, options: ReadMessagesOptions): Promise<MessageDetail[]> {
  return withClient(account, async (client) =>
    withMailbox(client, options.mailbox, async () => {
      const messages: MessageDetail[] = [];
      for (const uid of options.uids) {
        messages.push(await fetchMessage(client, options.mailbox, uid));
      }

      return messages;
    })
  );
}

export async function searchAndReadMessages(account: AccountProfile, options: SearchAndReadOptions): Promise<MessageDetail[]> {
  return withClient(account, async (client) => {
    const summaries = await searchMessagesWithClient(client, options);
    if (!summaries.length) {
      return [];
    }

    return withMailbox(client, options.mailbox, async () => {
      const messages: MessageDetail[] = [];
      for (const summary of summaries) {
        const message = await fetchMessage(client, options.mailbox, summary.uid);
        messages.push(options.includeText === false ? { ...message, text: "", html: undefined } : message);
      }

      return messages;
    });
  });
}
