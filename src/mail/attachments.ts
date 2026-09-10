import { z } from "zod";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/).describe("Attachment filename, including its extension."),
  contentType: z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default("application/octet-stream"),
  contentBase64: z.string().max(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0, "Expected padded base64.")
    .refine((value) => Buffer.byteLength(value, "base64") <= MAX_ATTACHMENT_BYTES, "Attachment exceeds 5 MiB.")
    .describe("File bytes as standard padded base64, without a data URL prefix or whitespace. Empty files are allowed.")
});

export const attachmentsSchema = z.array(attachmentSchema).max(10)
  .refine((items) => items.reduce((total, item) => total + Buffer.byteLength(item.contentBase64, "base64"), 0) <= MAX_TOTAL_BYTES,
    "Combined attachments exceed 20 MiB.")
  .describe("Up to 10 attachments, 5 MiB each and 20 MiB combined (decoded bytes).");

export type OutgoingAttachment = z.input<typeof attachmentSchema>;

export function attachmentPart(attachment: z.output<typeof attachmentSchema>): string {
  // RFC 2231 continuation parameters keep Unicode filenames and header lines portable.
  const bytes = Buffer.from(attachment.filename, "utf8");
  const parameters: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const encoded = [...bytes.subarray(offset, offset + 16)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
    parameters.push(` filename*${parameters.length}*=${offset === 0 ? "utf-8''" : ""}${encoded}`);
  }
  const base64 = Buffer.from(attachment.contentBase64, "base64").toString("base64");
  return [
    `Content-Type: ${attachment.contentType}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment;\r\n${parameters.join(";\r\n")}`,
    "",
    base64.match(/.{1,76}/g)?.join("\r\n") ?? "",
    ""
  ].join("\r\n");
}
