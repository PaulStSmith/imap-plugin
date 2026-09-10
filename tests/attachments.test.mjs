import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { buildMessage } from "../dist/mail/smtp-client.js";
import { sendMessageSchema, replyMessageSchema } from "../dist/tools/schemas.js";

const message = { from: "sender@example.com", to: ["recipient@example.com"], subject: "Files", text: "Attached files." };
const file = (bytes, filename = "sample.bin") => ({ filename, contentBase64: bytes.toString("base64") });

test("binary, empty, and Unicode-named attachments survive MIME parsing", async () => {
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  const filename = 'Relatório "final" \\ 日本語.pdf';
  const raw = buildMessage({ ...message, attachments: [file(bytes, filename), file(Buffer.alloc(0), "empty.txt")] });
  const parsed = await simpleParser(raw);
  assert.equal(parsed.text.trim(), message.text);
  assert.equal(parsed.attachments.length, 2);
  assert.equal(parsed.attachments[0].filename, filename);
  assert.match(raw, /Content-Type: application\/octet-stream\r\n/);
  assert.deepEqual(parsed.attachments[0].content, bytes);
  assert.equal(parsed.attachments[1].content.length, 0);
  assert.ok(raw.split("\r\n").every((line) => line.length < 998));
});

test("HTML alternatives, reply threading, and BCC privacy survive attachments", async () => {
  const parsed = await simpleParser(buildMessage({
    ...message, html: "<p>Attached files.</p>", bcc: ["hidden@example.com"],
    inReplyTo: "<original@example.com>", references: ["<original@example.com>"],
    attachments: [{ ...file(Buffer.from("Hello"), "hello.txt"), contentType: "text/plain" }]
  }));
  assert.equal(parsed.text.trim(), message.text);
  assert.equal(parsed.html.trim(), "<p>Attached files.</p>");
  assert.equal(parsed.inReplyTo, "<original@example.com>");
  assert.equal(parsed.references, "<original@example.com>");
  assert.equal(parsed.bcc, undefined);
  assert.equal(parsed.attachments[0].content.toString(), "Hello");
  assert.equal(parsed.attachments[0].contentType, "text/plain");
});

test("messages without attachments retain text and HTML behavior", async () => {
  for (const html of [undefined, "<p>Hello</p>"]) {
    const parsed = await simpleParser(buildMessage({ ...message, html, attachments: [] }));
    assert.equal(parsed.text.trim(), message.text);
    assert.equal(parsed.attachments.length, 0);
    if (html) assert.equal(parsed.html.trim(), html);
  }
});

test("both tool schemas accept attachments and reject malformed input", () => {
  for (const [schema, input] of [
    [sendMessageSchema, { accountId: "test", to: message.to }],
    [replyMessageSchema, { accountId: "test", uid: 1, text: "Reply" }]
  ]) {
    const attachment = file(Buffer.from("Hello"));
    assert.equal(schema.parse({ ...input, attachments: [attachment] }).attachments.length, 1);
    for (const invalid of [
      { ...attachment, filename: "bad\r\nX-Injected: yes" },
      { ...attachment, contentType: "text/plain\r\nX-Injected: yes" },
      { ...attachment, contentBase64: "data:text/plain;base64,SGVsbG8=" },
      { ...attachment, contentBase64: "SGVsbG8" },
      { ...attachment, contentBase64: "!!!!" }
    ]) assert.equal(schema.safeParse({ ...input, attachments: [invalid] }).success, false);
    assert.equal(schema.safeParse({ ...input, attachments: Array(11).fill(attachment) }).success, false);
  }
});

test("size limits allow 5 MiB files and reject oversized files or totals", () => {
  const attachment = file(Buffer.alloc(5 * 1024 * 1024));
  const input = { accountId: "test", to: message.to };
  assert.equal(sendMessageSchema.safeParse({ ...input, attachments: [attachment] }).success, true);
  assert.equal(sendMessageSchema.safeParse({ ...input, attachments: Array(5).fill(attachment) }).success, false);
  assert.equal(sendMessageSchema.safeParse({ ...input, attachments: [file(Buffer.alloc(5 * 1024 * 1024 + 1))] }).success, false);
  assert.throws(() => buildMessage({ ...message, attachments: [{ ...attachment, contentType: "bad\r\nheader" }] }));
});
