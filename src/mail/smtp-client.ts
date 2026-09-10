import { randomUUID } from "node:crypto";
import { Socket, connect as netConnect } from "node:net";
import { TLSSocket, connect as tlsConnect } from "node:tls";
import { AccountProfile } from "../types.js";
import { providerForAccount } from "../credentials/index.js";
import { readMessage } from "./imap-client.js";
import { attachmentPart, attachmentsSchema, OutgoingAttachment } from "./attachments.js";

export interface SendMessageOptions {
  attachments?: OutgoingAttachment[];
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  overridePassword?: string;
}

export interface TestSmtpOptions {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  overridePassword?: string;
}

export interface ReplyMessageOptions {
  attachments?: OutgoingAttachment[];
  mailbox: string;
  uid: number;
  replyAll: boolean;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text: string;
  html?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  overridePassword?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

class SmtpConnection {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private pending?: {
    resolve: (value: SmtpResponse) => void;
    reject: (reason?: unknown) => void;
  };

  private constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.onData(String(chunk)));
    this.socket.on("error", (error) => this.pending?.reject(error));
  }

  static connect(config: SmtpConfig): Promise<SmtpConnection> {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port });

    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once(config.secure ? "secureConnect" : "connect", () => {
        socket.off("error", reject);
        resolve(new SmtpConnection(socket));
      });
    });
  }

  async upgradeToTls(host: string): Promise<void> {
    this.socket = tlsConnect({ socket: this.socket, servername: host });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.onData(String(chunk)));
    this.socket.on("error", (error) => this.pending?.reject(error));
    await new Promise<void>((resolve, reject) => {
      this.socket.once("secureConnect", resolve);
      this.socket.once("error", reject);
    });
  }

  async read(): Promise<SmtpResponse> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.flushLines();
    });
  }

  async command(command: string): Promise<SmtpResponse> {
    this.socket.write(`${command}\r\n`);
    return this.read();
  }

  writeData(raw: string): void {
    this.socket.write(dotStuff(raw));
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.flushLines();
  }

  private flushLines(): void {
    if (!this.pending) {
      return;
    }

    const lines = this.buffer.split(/\r?\n/);
    if (!this.buffer.match(/\r?\n$/)) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    const complete: string[] = [];
    for (const line of lines.filter(Boolean)) {
      complete.push(line);
      if (/^\d{3} /.test(line)) {
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(parseResponse(complete));
        return;
      }
    }

    this.buffer = `${complete.join("\r\n")}\r\n${this.buffer}`;
  }
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

export async function sendMessage(account: AccountProfile, options: SendMessageOptions) {
  const config = await smtpConfig(account, options);
  const from = config.username;
  const envelopeTo = [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])];
  const raw = buildMessage({
    from,
    to: options.to,
    cc: options.cc,
    subject: options.subject,
    text: options.text,
    html: options.html,
    attachments: options.attachments
  });

  return sendRawMessage(config, from, envelopeTo, raw);
}

export async function testSmtpConnection(account: AccountProfile, options: TestSmtpOptions = {}) {
  const config = await smtpConfig(account, options);
  const connection = await SmtpConnection.connect(config);
  try {
    assertCode(await connection.read(), 220);
    assertCode(await connection.command(`EHLO ${clientName()}`), 250);

    if (!config.secure) {
      assertCode(await connection.command("STARTTLS"), 220);
      await connection.upgradeToTls(config.host);
      assertCode(await connection.command(`EHLO ${clientName()}`), 250);
    }

    const auth = Buffer.from(`\0${config.username}\0${config.password}`, "utf8").toString("base64");
    assertCode(await connection.command(`AUTH PLAIN ${auth}`), 235);
    await connection.command("QUIT").catch(() => undefined);

    return {
      ok: true,
      authenticatedAs: config.username,
      smtp: {
        host: config.host,
        port: config.port,
        secure: config.secure
      }
    };
  } finally {
    connection.close();
  }
}

export async function replyToMessage(account: AccountProfile, options: ReplyMessageOptions) {
  const original = await readMessage(account, options.mailbox, options.uid);
  const config = await smtpConfig(account, options);
  const originalFrom = original.from.map(extractEmail).filter(Boolean);
  const originalTo = original.to.map(extractEmail).filter(Boolean);
  const originalCc = original.cc.map(extractEmail).filter(Boolean);
  const to = options.to?.length
    ? options.to
    : options.replyAll
      ? uniqueAddresses([...originalFrom, ...originalTo].filter((address) => address.toLowerCase() !== config.username.toLowerCase()))
      : originalFrom;
  const cc = options.cc?.length ? options.cc : options.replyAll ? uniqueAddresses(originalCc) : undefined;
  const subject = options.subject ?? replySubject(original.subject ?? "");
  const references = uniqueReferences([...original.references, original.messageId].filter((value): value is string => Boolean(value)));
  const raw = buildMessage({
    from: config.username,
    to,
    cc,
    bcc: options.bcc,
    subject,
    text: options.text,
    html: options.html,
    attachments: options.attachments,
    inReplyTo: original.messageId ?? undefined,
    references
  });

  return sendRawMessage(config, config.username, [...to, ...(cc ?? []), ...(options.bcc ?? [])], raw);
}

async function smtpConfig(account: AccountProfile, options: Pick<SendMessageOptions, "smtpHost" | "smtpPort" | "smtpSecure" | "smtpUsername"> & { overridePassword?: string }): Promise<SmtpConfig> {
  const credential = options.overridePassword
    ? { username: account.username, password: options.overridePassword }
    : await providerForAccount(account).get(account);
  const secure = options.smtpSecure ?? account.smtpSecure ?? false;
  return {
    host: options.smtpHost || account.smtpHost || derivedSmtpHost(account.host),
    port: options.smtpPort || account.smtpPort || (secure ? 465 : 587),
    secure,
    username: options.smtpUsername || account.smtpUsername || credential.username || account.username,
    password: options.overridePassword || credential.password
  };
}

async function sendRawMessage(config: SmtpConfig, from: string, recipients: string[], raw: string) {
  if (!recipients.length) {
    throw new Error("At least one recipient is required.");
  }

  const connection = await SmtpConnection.connect(config);
  try {
    assertCode(await connection.read(), 220);
    assertCode(await connection.command(`EHLO ${clientName()}`), 250);

    if (!config.secure) {
      const startTls = await connection.command("STARTTLS");
      assertCode(startTls, 220);
      await connection.upgradeToTls(config.host);
      assertCode(await connection.command(`EHLO ${clientName()}`), 250);
    }

    const auth = Buffer.from(`\0${config.username}\0${config.password}`, "utf8").toString("base64");
    assertCode(await connection.command(`AUTH PLAIN ${auth}`), 235);
    assertCode(await connection.command(`MAIL FROM:<${extractEmail(from)}>`), 250);

    for (const recipient of recipients.map(extractEmail).filter(Boolean)) {
      assertCode(await connection.command(`RCPT TO:<${recipient}>`), 250, 251);
    }

    assertCode(await connection.command("DATA"), 354);
    connection.writeData(raw);
    assertCode(await connection.read(), 250);
    await connection.command("QUIT").catch(() => undefined);

    return {
      ok: true,
      smtp: {
        host: config.host,
        port: config.port,
        secure: config.secure
      },
      recipients: recipients.map(extractEmail).filter(Boolean)
    };
  } finally {
    connection.close();
  }
}

export function buildMessage(options: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
}): string {
  const attachments = attachmentsSchema.parse(options.attachments ?? []);
  const messageId = `<${randomUUID()}@imap-plugin.local>`;
  const boundary = `bf-${randomUUID()}`;
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to.join(", ")}`,
    options.cc?.length ? `Cc: ${options.cc.join(", ")}` : "",
    `Subject: ${headerValue(options.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : "",
    options.references?.length ? `References: ${options.references.join(" ")}` : "",
    "MIME-Version: 1.0"
  ].filter(Boolean);

  const body = options.html ? [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      options.text || htmlToPlainText(options.html),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      options.html,
      `--${boundary}--`,
      ""
    ].join("\r\n") : [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    options.text || "",
    ""
  ].join("\r\n");

  if (!attachments.length) {
    return [...headers, body].join("\r\n");
  }

  const mixedBoundary = `mixed-${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    body,
    ...attachments.flatMap((attachment) => [`--${mixedBoundary}`, attachmentPart(attachment)]),
    `--${mixedBoundary}--`,
    ""
  ].join("\r\n");
}

function parseResponse(lines: string[]): SmtpResponse {
  const last = lines[lines.length - 1] || "000";
  return {
    code: Number(last.slice(0, 3)),
    lines
  };
}

function assertCode(response: SmtpResponse, ...codes: number[]): void {
  if (!codes.includes(response.code)) {
    throw new Error(`SMTP command failed with ${response.code}: ${response.lines.join(" | ")}`);
  }
}

function dotStuff(raw: string): string {
  return `${raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.\r\n`;
}

function extractEmail(value: string): string {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? value.trim();
}

function uniqueAddresses(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function uniqueReferences(values: string[]): string[] {
  return values.filter((value, index, array) => value && array.indexOf(value) === index);
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function htmlToPlainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function clientName(): string {
  return "imap-plugin.local";
}

function derivedSmtpHost(imapHost: string): string {
  return imapHost.replace(/^imap\./i, "smtp.");
}
